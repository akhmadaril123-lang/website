require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { createGoogleAppsScriptStore, normalizeReminderTime } = require('./google-sheets-store');

const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = 'speakup_session';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const RESET_TTL_MS = 30 * 60 * 1000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESET_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const EDUCATION_LEVELS = new Set(['SMA', 'SMK', 'SMP', 'Umum']);
const LEARNING_LEVELS = new Set(['Pemula', 'Menengah', 'Lanjut']);
const DEFAULT_STATS = Object.freeze({ streak: 3, newWords: 4, weeklyProgress: 65 });
const DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash';
// OAuth Client ID memang publik; keamanan berasal dari verifikasi token server-side.
const DEFAULT_GOOGLE_CLIENT_ID = '778021422214-3rchusoh5qaht0ufpn0qrqs81nk75h0t.apps.googleusercontent.com';
const DEFAULT_APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzzcJ_hXuDdv7Sy6necYQFLrsK9pmYXiEPjCert_l-h_18psTG_3122_qzsdNvBYieP/exec';
const TRANSLATE_MAX_LENGTH = 300;

function openDatabase(databasePath) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    throw new Error(
      'Modul node:sqlite tidak tersedia. Jalankan Node.js 22.13 atau lebih baru, ' +
      'atau atur GOOGLE_APPS_SCRIPT_URL untuk memakai penyimpanan Google Sheets.'
    );
  }

  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }

  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      phone TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      education TEXT NOT NULL DEFAULT 'SMA',
      level TEXT NOT NULL DEFAULT 'Pemula',
      reminder_time TEXT NOT NULL DEFAULT '19:00',
      mic_permission INTEGER NOT NULL DEFAULT 0,
      privacy_agreed INTEGER NOT NULL DEFAULT 0,
      parental_agreed INTEGER NOT NULL DEFAULT 0,
      onboarding_complete INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      CHECK (email IS NOT NULL OR phone IS NOT NULL)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      session_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);
  `);

  // Migrasi ringan untuk database yang sudah dibuat sebelum kolom berikut ada.
  ensureColumn(db, 'users', 'streak', 'INTEGER NOT NULL DEFAULT 3');
  ensureColumn(db, 'users', 'new_words', 'INTEGER NOT NULL DEFAULT 4');
  ensureColumn(db, 'users', 'weekly_progress', 'INTEGER NOT NULL DEFAULT 65');
  ensureColumn(db, 'users', 'google_linked', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'users', 'google_email', 'TEXT');
  ensureColumn(db, 'users', 'google_sub', 'TEXT');

  db.exec(`
    CREATE TABLE IF NOT EXISTS password_resets (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS password_resets_expires_at_idx ON password_resets(expires_at);
  `);

  return db;
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some(item => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function toInt(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  const integer = Math.trunc(number);
  if (integer < min) return min;
  if (integer > max) return max;
  return integer;
}

function normalizeIdentifier(value) {
  if (typeof value !== 'string') return null;
  const identifier = value.trim();
  if (!identifier || identifier.length > 254) return null;

  if (identifier.includes('@')) {
    if (!EMAIL_PATTERN.test(identifier)) return null;
    return { email: identifier.toLowerCase(), phone: null };
  }

  const phoneInput = identifier.replace(/[\s().-]/g, '');
  let phone = phoneInput;
  if (/^08\d{8,11}$/.test(phoneInput)) {
    phone = `+62${phoneInput.slice(1)}`;
  } else if (/^62\d{8,13}$/.test(phoneInput)) {
    phone = `+${phoneInput}`;
  } else if (/^0[1-9]\d{7,13}$/.test(phoneInput)) {
    phone = `+62${phoneInput.slice(1)}`;
  }

  if (!/^\+[1-9]\d{7,14}$/.test(phone)) return null;
  return { email: null, phone };
}

function toPublicUser(row) {
  const googleLinked = Boolean(Number(row.google_linked));
  return {
    id: String(row.id),
    name: row.name,
    email: row.email || null,
    phone: row.phone || null,
    education: row.education,
    level: row.level,
    streak: toInt(row.streak, DEFAULT_STATS.streak, 0, 100000),
    newWords: toInt(row.new_words, DEFAULT_STATS.newWords, 0, 1000000),
    weeklyProgress: toInt(row.weekly_progress, DEFAULT_STATS.weeklyProgress, 0, 100),
    provider: googleLinked ? 'google' : 'email',
    googleLinked,
    googleEmail: row.google_email || null,
    reminderTime: normalizeReminderTime(row.reminder_time),
    micPermission: Boolean(row.mic_permission),
    privacyAgreed: Boolean(row.privacy_agreed),
    parentalAgreed: Boolean(row.parental_agreed),
    onboardingComplete: Boolean(row.onboarding_complete),
    phoneVerified: false
  };
}

function isUniqueConstraintError(error) {
  if (!error) return false;
  if (error.code === 'ERR_SQLITE_CONSTRAINT_UNIQUE') return true;
  if (error.errcode === 2067) return true;
  return /UNIQUE constraint failed/i.test(String(error.message || ''));
}

function createSqliteStore(databasePath) {
  const db = openDatabase(databasePath);
  return {
    async findUserByIdentifier(identity) {
      if (identity.email) {
        return db.prepare('SELECT * FROM users WHERE email = ?').get(identity.email);
      }
      return db.prepare('SELECT * FROM users WHERE phone = ?').get(identity.phone);
    },
    async findUserById(id) {
      return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    },
    async findUserByGoogleSub(googleSub) {
      if (!googleSub) return undefined;
      return db.prepare('SELECT * FROM users WHERE google_sub = ?').get(String(googleSub));
    },
    async createUser(user) {
      const result = db.prepare(`
        INSERT INTO users (
          name, email, phone, password_hash, education,
          streak, new_words, weekly_progress,
          google_linked, google_email, google_sub, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        user.name,
        user.email,
        user.phone,
        user.password_hash,
        user.education,
        toInt(user.streak, DEFAULT_STATS.streak, 0, 100000),
        toInt(user.new_words, DEFAULT_STATS.newWords, 0, 1000000),
        toInt(user.weekly_progress, DEFAULT_STATS.weeklyProgress, 0, 100),
        user.google_linked ? 1 : 0,
        user.google_email || null,
        user.google_sub || null,
        user.created_at
      );
      return db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
    },
    async updateUser(id, updates) {
      const columns = Object.keys(updates);
      const assignments = columns.map(column => `${column} = ?`).join(', ');
      db.prepare(`UPDATE users SET ${assignments} WHERE id = ?`)
        .run(...columns.map(column => updates[column]), id);
      return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    },
    async createSession(session, now) {
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
      db.prepare('INSERT INTO sessions (session_hash, user_id, expires_at) VALUES (?, ?, ?)')
        .run(session.session_hash, session.user_id, session.expires_at);
    },
    async findSessionUser(sessionHash, now) {
      const row = db.prepare(`
        SELECT users.*, sessions.session_hash
        FROM sessions
        JOIN users ON users.id = sessions.user_id
        WHERE sessions.session_hash = ? AND sessions.expires_at > ?
      `).get(sessionHash, now);
      if (!row) db.prepare('DELETE FROM sessions WHERE session_hash = ?').run(sessionHash);
      return row;
    },
    async deleteSession(sessionHash) {
      db.prepare('DELETE FROM sessions WHERE session_hash = ?').run(sessionHash);
    },
    async deleteUserSessions(userId) {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    },
    async createPasswordReset(reset, now) {
      db.prepare('DELETE FROM password_resets WHERE expires_at <= ? OR used_at IS NOT NULL').run(now);
      db.prepare(`
        INSERT INTO password_resets (token_hash, user_id, expires_at, used_at, created_at)
        VALUES (?, ?, ?, NULL, ?)
      `).run(reset.token_hash, reset.user_id, reset.expires_at, reset.created_at);
    },
    async findPasswordReset(tokenHash, now) {
      return db.prepare(`
        SELECT * FROM password_resets
        WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
      `).get(tokenHash, now);
    },
    async consumePasswordReset(tokenHash, now) {
      const result = db.prepare(`
        UPDATE password_resets SET used_at = ?
        WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
      `).run(now, tokenHash, now);
      return Number(result.changes) > 0;
    },
    close() {
      db.close();
    }
  };
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derivedKey = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt.toString('hex')}$${derivedKey.toString('hex')}`;
}

async function verifyPassword(password, storedHash) {
  if (typeof storedHash !== 'string') return false;
  if (storedHash.startsWith('sha256$')) {
    const expectedHex = storedHash.slice(7);
    const actualHex = crypto.createHash('sha256').update(password).digest('hex');
    if (expectedHex.length !== actualHex.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expectedHex, 'utf8'), Buffer.from(actualHex, 'utf8'));
  }
  const [algorithm, saltHex, keyHex] = storedHash.split('$');
  if (algorithm !== 'scrypt' || !/^[a-f0-9]{32}$/.test(saltHex) || !/^[a-f0-9]{128}$/.test(keyHex)) {
    return false;
  }
  const expectedKey = Buffer.from(keyHex, 'hex');
  const actualKey = await scrypt(password, Buffer.from(saltHex, 'hex'), expectedKey.length, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  });
  return crypto.timingSafeEqual(expectedKey, actualKey);
}

function hashResetToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function verifyGoogleIdToken(credential, clientId) {
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID belum dikonfigurasi.');
  const response = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`,
    { signal: AbortSignal.timeout(8000) }
  );
  if (!response.ok) throw new Error('Token Google tidak valid.');

  const payload = await response.json();
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audience.includes(clientId)) throw new Error('Audience token Google tidak cocok.');
  if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') {
    throw new Error('Issuer token Google tidak valid.');
  }
  const emailVerified = payload.email_verified === true || payload.email_verified === 'true';
  if (!emailVerified) throw new Error('Email Google belum terverifikasi.');
  if (!payload.sub || !payload.email) throw new Error('Identitas Google tidak lengkap.');
  if (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) * 1000 <= Date.now()) {
    throw new Error('Token Google sudah kedaluwarsa.');
  }

  return {
    sub: String(payload.sub),
    email: String(payload.email).toLowerCase(),
    name: String(payload.name || payload.email),
    emailVerified: true
  };
}

async function translateWithGemini(phrase, { apiKey, model = DEFAULT_GEMINI_MODEL }) {
  const prompt = [
    'Analisis kalimat bahasa Inggris berikut untuk pelajar SMA/SMK di Indonesia:',
    JSON.stringify(phrase),
    '',
    'Kembalikan JSON dengan kunci:',
    '- meaning: terjemahan bahasa Indonesia yang alami',
    '- phonetic: cara baca fonetik sederhana dengan ejaan Indonesia (contoh: "ai stadi at skul")',
    '- explanation: penjelasan tata bahasa singkat, maksimal 2 kalimat bahasa Indonesia'
  ].join('\n');

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              meaning: { type: 'STRING' },
              phonetic: { type: 'STRING' },
              explanation: { type: 'STRING' }
            },
            required: ['meaning', 'phonetic', 'explanation']
          }
        }
      })
    }
  );

  if (!response.ok) throw new Error(`Gemini mengembalikan HTTP ${response.status}.`);
  const data = await response.json();
  const rawText = data && data.candidates && data.candidates[0] &&
    data.candidates[0].content && data.candidates[0].content.parts &&
    data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
  if (!rawText) throw new Error('Respons Gemini kosong.');

  const parsed = JSON.parse(rawText);
  if (!parsed || typeof parsed.meaning !== 'string' || !parsed.meaning.trim()) {
    throw new Error('Hasil terjemahan tidak lengkap.');
  }
  return {
    meaning: parsed.meaning.trim(),
    phonetic: typeof parsed.phonetic === 'string' ? parsed.phonetic.trim() : '',
    explanation: typeof parsed.explanation === 'string' ? parsed.explanation.trim() : ''
  };
}

async function sendResetEmail({ to, resetUrl }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!apiKey || !from) return false;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify({
      from,
      to: [to],
      subject: 'Atur ulang kata sandi SpeakUp',
      html: `
        <p>Halo,</p>
        <p>Kami menerima permintaan untuk mengatur ulang kata sandi akun SpeakUp Anda.</p>
        <p><a href="${resetUrl}">Atur ulang kata sandi</a></p>
        <p>Tautan ini berlaku selama 30 menit. Jika Anda tidak meminta perubahan ini, abaikan email ini.</p>
      `
    })
  });
  return response.ok;
}

function readCookie(req, cookieName) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === cookieName) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

function setSessionCookie(res, token, isProduction) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SECONDS}`
  ];
  if (isProduction) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res, isProduction) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isProduction) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function createApp(options = {}) {
  const isProduction = (options.nodeEnv || process.env.NODE_ENV) === 'production';
  const isTest = (options.nodeEnv || process.env.NODE_ENV) === 'test';
  const appsScriptUrl = options.appsScriptUrl || (!options.databasePath && (process.env.GOOGLE_APPS_SCRIPT_URL || DEFAULT_APPS_SCRIPT_URL));
  const hasAppsScriptConfig = Boolean(appsScriptUrl);
  if (!options.store && process.env.VERCEL && !hasAppsScriptConfig) {
    throw new Error('Konfigurasi GOOGLE_APPS_SCRIPT_URL belum diatur pada Environment Variables Vercel.');
  }
  const store = options.store || (hasAppsScriptConfig
    ? createGoogleAppsScriptStore({ scriptUrl: appsScriptUrl })
    : (() => {
      const configuredDatabasePath = options.databasePath || './data/speakup.sqlite';
      const databasePath = configuredDatabasePath === ':memory:'
        ? configuredDatabasePath
        : path.resolve(__dirname, configuredDatabasePath);
      return createSqliteStore(databasePath);
    })());

  const googleClientId = options.googleClientId !== undefined
    ? options.googleClientId
    : (process.env.GOOGLE_CLIENT_ID || DEFAULT_GOOGLE_CLIENT_ID);
  const verifyGoogleToken = options.verifyGoogleToken || null;
  const geminiApiKey = options.geminiApiKey !== undefined
    ? options.geminiApiKey
    : (process.env.GEMINI_API_KEY || null);
  const geminiModel = options.geminiModel || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const translatePhrase = options.translatePhrase || null;
  const appOrigin = (options.appOrigin || process.env.APP_ORIGIN || '').replace(/\/$/, '');
  const exposeResetLink = options.exposeResetLink !== undefined
    ? Boolean(options.exposeResetLink)
    : !isProduction;

  const app = express();
  if (process.env.VERCEL) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
    if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.use('/api', (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || !req.headers.origin) {
      return next();
    }
    const allowedOrigins = new Set([`${req.protocol}://${req.get('host')}`]);
    if (appOrigin) allowedOrigins.add(appOrigin);
    if (!allowedOrigins.has(req.headers.origin)) {
      return res.status(403).json({ error: 'Permintaan lintas situs tidak diizinkan.' });
    }
    next();
  });

  const skipRateLimit = () => isTest;
  // Batas per IP sengaja dibuat longgar karena banyak pelajar sering berbagi
  // satu IP publik (WiFi sekolah); brute force tetap terkendali.
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: skipRateLimit,
    message: { error: 'Terlalu banyak percobaan masuk. Coba lagi beberapa saat.' }
  });
  const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 60,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: skipRateLimit,
    message: { error: 'Terlalu banyak pendaftaran. Coba lagi nanti.' }
  });
  const translateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 40,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: skipRateLimit,
    message: { error: 'Terlalu banyak permintaan terjemahan. Coba lagi beberapa saat.' }
  });

  async function requireSession(req, res, next) {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) {
      clearSessionCookie(res, isProduction);
      return res.status(401).json({ error: 'Sesi tidak ditemukan. Silakan masuk kembali.' });
    }

    const sessionHash = crypto.createHash('sha256').update(token).digest('hex');
    const row = await store.findSessionUser(sessionHash, Date.now());
    if (!row) {
      clearSessionCookie(res, isProduction);
      return res.status(401).json({ error: 'Sesi sudah berakhir. Silakan masuk kembali.' });
    }

    req.authUser = row;
    req.sessionHash = sessionHash;
    next();
  }

  async function startSession(userId, res) {
    const token = crypto.randomBytes(32).toString('hex');
    const sessionHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
    await store.createSession({
      session_hash: sessionHash,
      user_id: userId,
      expires_at: expiresAt
    }, Date.now());
    setSessionCookie(res, token, isProduction);
  }

  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
  });

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/api/config', (req, res) => {
    res.json({
      googleClientId: googleClientId || null,
      googleEnabled: Boolean(googleClientId),
      googleClientIdIsDefault: googleClientId === DEFAULT_GOOGLE_CLIENT_ID,
      translateEnabled: Boolean(translatePhrase || geminiApiKey),
      appsScriptUrl: hasAppsScriptConfig ? appsScriptUrl : null
    });
  });

  app.post('/api/auth/register', registerLimiter, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const identity = normalizeIdentifier(body.identifier);
    const password = body.password;
    const education = body.education || 'SMA';

    if (!name || name.length > 80) {
      return res.status(400).json({ error: 'Nama wajib diisi dan maksimal 80 karakter.' });
    }
    if (!identity) {
      return res.status(400).json({ error: 'Masukkan email yang valid atau nomor HP yang valid.' });
    }
    if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > 256 || password.length < 8) {
      return res.status(400).json({ error: 'Kata sandi harus terdiri dari minimal 8 karakter.' });
    }
    if (!EDUCATION_LEVELS.has(education)) {
      return res.status(400).json({ error: 'Pilihan jenjang tidak valid.' });
    }
    if (await store.findUserByIdentifier(identity)) {
      return res.status(409).json({ error: 'Email atau nomor HP sudah terdaftar.' });
    }

    const passwordHash = await hashPassword(password);
    let user;
    try {
      user = await store.createUser({
        name,
        email: identity.email,
        phone: identity.phone,
        password_hash: passwordHash,
        education,
        created_at: Date.now()
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return res.status(409).json({ error: 'Email atau nomor HP sudah terdaftar.' });
      }
      throw error;
    }

    await startSession(user.id, res);
    res.status(201).json({ user: toPublicUser(user) });
  });

  app.post('/api/auth/login', loginLimiter, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const identity = normalizeIdentifier(body.identifier);
    if (!identity || typeof body.password !== 'string' || Buffer.byteLength(body.password, 'utf8') > 256) {
      return res.status(400).json({ error: 'Email/nomor HP dan kata sandi wajib diisi.' });
    }

    const user = await store.findUserByIdentifier(identity);
    const passwordIsValid = user && await verifyPassword(body.password, user.password_hash);
    if (!passwordIsValid) {
      return res.status(401).json({ error: 'Email/nomor HP atau kata sandi salah.' });
    }

    await startSession(user.id, res);
    res.json({ user: toPublicUser(user) });
  });

  app.get('/api/auth/me', requireSession, (req, res) => {
    res.json({ user: toPublicUser(req.authUser) });
  });

  app.put('/api/auth/profile', requireSession, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const updates = {};
    const booleanFields = {
      micPermission: 'mic_permission',
      privacyAgreed: 'privacy_agreed',
      parentalAgreed: 'parental_agreed',
      onboardingComplete: 'onboarding_complete'
    };
    const integerFields = {
      streak: { column: 'streak', min: 0, max: 100000 },
      newWords: { column: 'new_words', min: 0, max: 1000000 },
      weeklyProgress: { column: 'weekly_progress', min: 0, max: 100 }
    };

    if (Object.prototype.hasOwnProperty.call(body, 'education')) {
      if (!EDUCATION_LEVELS.has(body.education)) {
        return res.status(400).json({ error: 'Pilihan jenjang tidak valid.' });
      }
      updates.education = body.education;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'level')) {
      if (!LEARNING_LEVELS.has(body.level)) {
        return res.status(400).json({ error: 'Pilihan level tidak valid.' });
      }
      updates.level = body.level;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'reminderTime')) {
      if (typeof body.reminderTime !== 'string') {
        return res.status(400).json({ error: 'Format waktu pengingat tidak valid.' });
      }
      const trimmedTime = body.reminderTime.trim();
      const isValidDirect = /^([01]\d|2[0-3]):[0-5]\d$/.test(trimmedTime);
      const isSheetDateStr = /^\w{3}\s+\w{3}\s+\d{1,2}\s+\d{4}\s+\d{2}:\d{2}:\d{2}/.test(trimmedTime) || /^\d{4}-\d{2}-\d{2}T/.test(trimmedTime);
      if (!isValidDirect && !isSheetDateStr) {
        return res.status(400).json({ error: 'Format waktu pengingat tidak valid.' });
      }
      updates.reminder_time = normalizeReminderTime(trimmedTime);
    }
    for (const [field, column] of Object.entries(booleanFields)) {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        if (typeof body[field] !== 'boolean') {
          return res.status(400).json({ error: 'Data profil tidak valid.' });
        }
        updates[column] = Number(body[field]);
      }
    }
    for (const [field, rule] of Object.entries(integerFields)) {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        const value = body[field];
        if (!Number.isInteger(value) || value < rule.min || value > rule.max) {
          return res.status(400).json({ error: 'Data progres belajar tidak valid.' });
        }
        updates[rule.column] = value;
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Tidak ada perubahan profil yang dikirim.' });
    }
    const user = await store.updateUser(req.authUser.id, updates);
    res.json({ user: toPublicUser(user) });
  });

  app.post('/api/auth/logout', async (req, res) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token && /^[a-f0-9]{64}$/.test(token)) {
      const sessionHash = crypto.createHash('sha256').update(token).digest('hex');
      await store.deleteSession(sessionHash);
    }
    clearSessionCookie(res, isProduction);
    res.json({ success: true });
  });

  app.post('/api/auth/forgot-password', loginLimiter, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const identity = normalizeIdentifier(body.identifier);
    if (!identity) {
      return res.status(400).json({ error: 'Masukkan email atau nomor HP yang valid.' });
    }

    const user = await store.findUserByIdentifier(identity);
    let resetUrl = null;

    if (user && user.email) {
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashResetToken(token);
      const now = Date.now();
      await store.createPasswordReset({
        token_hash: tokenHash,
        user_id: user.id,
        expires_at: now + RESET_TTL_MS,
        created_at: now
      }, now);

      const origin = appOrigin || `${req.protocol}://${req.get('host')}`;
      resetUrl = `${origin}/?reset=${token}`;
      try {
        await sendResetEmail({ to: user.email, resetUrl });
      } catch (error) {
        console.error('Email atur ulang gagal dikirim:', error.message);
      }
    }

    const payload = {
      success: true,
      message: 'Jika kontak terdaftar, tautan atur ulang kata sandi telah dikirim.'
    };
    if (resetUrl && exposeResetLink) payload.resetUrl = resetUrl;
    res.json(payload);
  });

  app.post('/api/auth/reset-password', loginLimiter, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const password = body.password;

    if (!RESET_TOKEN_PATTERN.test(token)) {
      return res.status(400).json({ error: 'Tautan atur ulang tidak valid atau sudah kedaluwarsa.' });
    }
    if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > 256 || password.length < 8) {
      return res.status(400).json({ error: 'Kata sandi harus terdiri dari minimal 8 karakter.' });
    }

    const now = Date.now();
    const tokenHash = hashResetToken(token);
    const reset = await store.findPasswordReset(tokenHash, now);
    if (!reset) {
      return res.status(400).json({ error: 'Tautan atur ulang tidak valid atau sudah kedaluwarsa.' });
    }

    const passwordHash = await hashPassword(password);
    const user = await store.updateUser(reset.user_id, { password_hash: passwordHash });
    if (!user) {
      return res.status(400).json({ error: 'Akun untuk tautan ini tidak ditemukan.' });
    }

    await store.consumePasswordReset(tokenHash, now);
    await store.deleteUserSessions(reset.user_id);
    res.json({ success: true, message: 'Kata sandi berhasil diperbarui. Silakan masuk dengan kata sandi baru.' });
  });

  app.post('/api/auth/google', loginLimiter, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const credential = typeof body.credential === 'string' ? body.credential.trim() : '';

    // Keamanan: identitas Google HANYA boleh berasal dari kredensial (ID token)
    // yang diverifikasi server. Email/nama yang dikirim tanpa kredensial tidak
    // pernah dipercaya, agar tidak ada yang bisa masuk memakai email orang lain.
    if (!verifyGoogleToken && !googleClientId) {
      return res.status(503).json({ error: 'Login Google belum dikonfigurasi di server.' });
    }
    if (!credential) {
      return res.status(401).json({
        error: 'Kredensial Google wajib disertakan. Silakan masuk melalui tombol "Masuk dengan Google".'
      });
    }

    let verified = null;
    try {
      verified = verifyGoogleToken
        ? await verifyGoogleToken(credential)
        : await verifyGoogleIdToken(credential, googleClientId);
    } catch (error) {
      console.error('Verifikasi token Google gagal:', error.message);
      return res.status(401).json({ error: 'Token Google tidak valid atau sudah kedaluwarsa.' });
    }
    if (!verified || !verified.email) {
      return res.status(401).json({ error: 'Identitas Google tidak lengkap.' });
    }

    const name = String(verified.name || verified.email).trim();
    const identity = normalizeIdentifier(verified.email);
    const googleSub = verified.sub ? String(verified.sub) : '';
    const education = EDUCATION_LEVELS.has(body.education) ? body.education : 'SMA';

    if (!name || name.length > 80 || !identity || !identity.email) {
      return res.status(400).json({ error: 'Data akun Google tidak valid.' });
    }

    let user = null;
    if (googleSub && typeof store.findUserByGoogleSub === 'function') {
      user = await store.findUserByGoogleSub(googleSub);
    }
    if (!user) user = await store.findUserByIdentifier(identity);

    const isNewUser = !user;
    const linkSub = googleSub || `google-${identity.email}`;
    let warning = null;
    if (!user) {
      const randomPassword = crypto.randomBytes(24).toString('hex');
      const passwordHash = await hashPassword(randomPassword);
      const baseUser = {
        name,
        email: identity.email,
        phone: null,
        password_hash: passwordHash,
        education,
        created_at: Date.now()
      };
      try {
        user = await store.createUser({
          ...baseUser,
          google_linked: true,
          google_email: identity.email,
          google_sub: linkSub
        });
      } catch (error) {
        // Bisa terjadi jika dua permintaan login berjalan bersamaan.
        if (isUniqueConstraintError(error)) {
          user = await store.findUserByIdentifier(identity);
        }
        if (!user) {
          // Backend Google Sheets lama (code.gs belum diperbarui) bisa menolak
          // kolom Google. Login tetap dilanjutkan tanpa tautan Google.
          console.error('Gagal membuat akun Google dengan kolom Google:', error.message);
          try {
            user = await store.createUser(baseUser);
            warning = 'Akun berhasil dibuat, tetapi tautan Google belum tersimpan. Deploy ulang code.gs agar kolom Google tersedia.';
          } catch (retryError) {
            console.error('Gagal membuat akun Google:', retryError.message);
            throw retryError;
          }
        }
      }
    } else {
      const updates = {};
      if (!Number(user.google_linked)) updates.google_linked = 1;
      if (user.google_email !== identity.email) updates.google_email = identity.email;
      if (linkSub && user.google_sub !== linkSub) updates.google_sub = linkSub;
      if (Object.keys(updates).length > 0) {
        try {
          user = await store.updateUser(user.id, updates);
        } catch (error) {
          // Jangan gagalkan login hanya karena penautan Google tidak tersimpan.
          console.error('Gagal menautkan akun Google ke pengguna lama:', error.message);
          warning = 'Berhasil masuk, tetapi tautan Google belum tersimpan. Deploy ulang code.gs agar kolom Google tersedia.';
          try {
            user = await store.updateUser(user.id, { google_email: identity.email });
          } catch {
            user = (await store.findUserById(user.id)) || user;
          }
        }
      }
    }

    if (!user) {
      return res.status(500).json({ error: 'Akun Google tidak dapat dibuat di database.' });
    }

    await startSession(user.id, res);
    console.log(`[Google Login] ${identity.email} - ${isNewUser ? 'akun baru' : 'akun lama'}`);
    res.status(isNewUser ? 201 : 200).json({ user: toPublicUser(user), isNewUser, warning });
  });

  app.post('/api/auth/google/unlink', requireSession, async (req, res) => {
    if (!Number(req.authUser.google_linked)) {
      return res.status(400).json({ error: 'Akun Google belum tertaut ke akun ini.' });
    }
    const user = await store.updateUser(req.authUser.id, {
      google_linked: 0,
      google_email: null,
      google_sub: null
    });
    res.json({ user: toPublicUser(user) });
  });

  app.post('/api/translate', translateLimiter, requireSession, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const phrase = typeof body.phrase === 'string' ? body.phrase.trim() : '';
    if (!phrase || phrase.length > TRANSLATE_MAX_LENGTH) {
      return res.status(400).json({ error: `Frasa harus diisi dan maksimal ${TRANSLATE_MAX_LENGTH} karakter.` });
    }

    if (!translatePhrase && !geminiApiKey) {
      return res.status(503).json({
        error: 'Layanan terjemahan AI belum dikonfigurasi. Kamus offline akan digunakan.',
        code: 'TRANSLATE_UNAVAILABLE'
      });
    }

    try {
      const result = translatePhrase
        ? await translatePhrase(phrase)
        : await translateWithGemini(phrase, { apiKey: geminiApiKey, model: geminiModel });
      if (!result || typeof result.meaning !== 'string' || !result.meaning.trim()) {
        throw new Error('Hasil terjemahan kosong.');
      }
      res.json({
        meaning: result.meaning.trim(),
        phonetic: typeof result.phonetic === 'string' ? result.phonetic.trim() : '',
        explanation: typeof result.explanation === 'string' ? result.explanation.trim() : ''
      });
    } catch (error) {
      console.error('Terjemahan gagal:', error.message);
      res.status(502).json({
        error: 'Layanan terjemahan sedang tidak tersedia. Kamus offline akan digunakan.',
        code: 'TRANSLATE_FAILED'
      });
    }
  });

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Endpoint tidak ditemukan.' });
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Format JSON tidak valid.' });
    }
    if (error.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Ukuran permintaan terlalu besar.' });
    }
    console.error('Request gagal:', error.message);
    res.status(500).json({ error: 'Terjadi kesalahan pada server.' });
  });

  app.locals.closeDatabase = () => store.close();
  app.locals.store = store;
  return app;
}

function startServer() {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT harus berupa angka antara 1 dan 65535.');
  }
  const app = createApp();
  const server = app.listen(port, () => {
    console.log(`SpeakUp berjalan di http://localhost:${port}`);
    const clientId = process.env.GOOGLE_CLIENT_ID || DEFAULT_GOOGLE_CLIENT_ID;
    if (clientId === DEFAULT_GOOGLE_CLIENT_ID) {
      console.warn(
        '[Google Login] Memakai Client ID demo milik proyek lain ("Potato App"). ' +
        `Daftarkan http://localhost:${port} dan http://127.0.0.1:${port} pada ` +
        'Authorized JavaScript origins di Google Cloud Console, atau buat OAuth Client ID ' +
        'milik Anda lalu isi GOOGLE_CLIENT_ID di .env. Lihat GOOGLE_LOGIN_SETUP.md.'
      );
    }
  });
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createApp,
  normalizeIdentifier,
  openDatabase,
  startServer,
  toPublicUser,
  verifyGoogleIdToken
};
