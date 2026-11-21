require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { DatabaseSync } = require('node:sqlite');

const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = 'speakup_session';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EDUCATION_LEVELS = new Set(['SMA', 'SMK', 'SMP', 'Umum']);
const LEARNING_LEVELS = new Set(['Pemula', 'Menengah', 'Lanjut']);

function openDatabase(databasePath) {
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
  return db;
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

function findUserByIdentifier(db, identity) {
  if (identity.email) {
    return db.prepare('SELECT * FROM users WHERE email = ?').get(identity.email);
  }
  return db.prepare('SELECT * FROM users WHERE phone = ?').get(identity.phone);
}

function toPublicUser(row) {
  return {
    id: String(row.id),
    name: row.name,
    email: row.email,
    phone: row.phone,
    education: row.education,
    level: row.level,
    streak: 3,
    newWords: 4,
    weeklyProgress: 65,
    reminderTime: row.reminder_time,
    micPermission: Boolean(row.mic_permission),
    privacyAgreed: Boolean(row.privacy_agreed),
    parentalAgreed: Boolean(row.parental_agreed),
    onboardingComplete: Boolean(row.onboarding_complete),
    phoneVerified: false
  };
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derivedKey = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt.toString('hex')}$${derivedKey.toString('hex')}`;
}

async function verifyPassword(password, storedHash) {
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
  const configuredDatabasePath = options.databasePath || process.env.DATABASE_PATH || './data/speakup.sqlite';
  const databasePath = configuredDatabasePath === ':memory:'
    ? configuredDatabasePath
    : path.resolve(__dirname, configuredDatabasePath);
  const db = openDatabase(databasePath);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  app.use('/api', (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || !req.headers.origin) {
      return next();
    }
    const expectedOrigin = process.env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`;
    if (req.headers.origin !== expectedOrigin) {
      return res.status(403).json({ error: 'Permintaan lintas situs tidak diizinkan.' });
    }
    next();
  });

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Terlalu banyak percobaan masuk. Coba lagi beberapa saat.' }
  });
  const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Terlalu banyak pendaftaran. Coba lagi nanti.' }
  });

  function requireSession(req, res, next) {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) {
      clearSessionCookie(res, isProduction);
      return res.status(401).json({ error: 'Sesi tidak ditemukan. Silakan masuk kembali.' });
    }

    const sessionHash = crypto.createHash('sha256').update(token).digest('hex');
    const row = db.prepare(`
      SELECT users.*, sessions.session_hash
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.session_hash = ? AND sessions.expires_at > ?
    `).get(sessionHash, Date.now());
    if (!row) {
      db.prepare('DELETE FROM sessions WHERE session_hash = ?').run(sessionHash);
      clearSessionCookie(res, isProduction);
      return res.status(401).json({ error: 'Sesi sudah berakhir. Silakan masuk kembali.' });
    }

    req.authUser = row;
    req.sessionHash = sessionHash;
    next();
  }

  function startSession(userId, res) {
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    const token = crypto.randomBytes(32).toString('hex');
    const sessionHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
    db.prepare('INSERT INTO sessions (session_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(sessionHash, userId, expiresAt);
    setSessionCookie(res, token, isProduction);
  }

  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
  });

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
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
    if (findUserByIdentifier(db, identity)) {
      return res.status(409).json({ error: 'Email atau nomor HP sudah terdaftar.' });
    }

    const passwordHash = await hashPassword(password);
    let result;
    try {
      result = db.prepare(`
        INSERT INTO users (name, email, phone, password_hash, education, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(name, identity.email, identity.phone, passwordHash, education, Date.now());
    } catch (error) {
      if (error.code === 'ERR_SQLITE_CONSTRAINT_UNIQUE') {
        return res.status(409).json({ error: 'Email atau nomor HP sudah terdaftar.' });
      }
      throw error;
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
    startSession(user.id, res);
    res.status(201).json({ user: toPublicUser(user) });
  });

  app.post('/api/auth/login', loginLimiter, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const identity = normalizeIdentifier(body.identifier);
    if (!identity || typeof body.password !== 'string' || Buffer.byteLength(body.password, 'utf8') > 256) {
      return res.status(400).json({ error: 'Email/nomor HP dan kata sandi wajib diisi.' });
    }

    const user = findUserByIdentifier(db, identity);
    const passwordIsValid = user && await verifyPassword(body.password, user.password_hash);
    if (!passwordIsValid) {
      return res.status(401).json({ error: 'Email/nomor HP atau kata sandi salah.' });
    }

    startSession(user.id, res);
    res.json({ user: toPublicUser(user) });
  });

  app.get('/api/auth/me', requireSession, (req, res) => {
    res.json({ user: toPublicUser(req.authUser) });
  });

  app.put('/api/auth/profile', requireSession, (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const updates = {};
    const booleanFields = {
      micPermission: 'mic_permission',
      privacyAgreed: 'privacy_agreed',
      parentalAgreed: 'parental_agreed',
      onboardingComplete: 'onboarding_complete'
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
      if (typeof body.reminderTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.reminderTime)) {
        return res.status(400).json({ error: 'Format waktu pengingat tidak valid.' });
      }
      updates.reminder_time = body.reminderTime;
    }
    for (const [field, column] of Object.entries(booleanFields)) {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        if (typeof body[field] !== 'boolean') {
          return res.status(400).json({ error: 'Data profil tidak valid.' });
        }
        updates[column] = Number(body[field]);
      }
    }

    const columns = Object.keys(updates);
    if (columns.length === 0) {
      return res.status(400).json({ error: 'Tidak ada perubahan profil yang dikirim.' });
    }
    const assignments = columns.map(column => `${column} = ?`).join(', ');
    db.prepare(`UPDATE users SET ${assignments} WHERE id = ?`)
      .run(...columns.map(column => updates[column]), req.authUser.id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.authUser.id);
    res.json({ user: toPublicUser(user) });
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token && /^[a-f0-9]{64}$/.test(token)) {
      const sessionHash = crypto.createHash('sha256').update(token).digest('hex');
      db.prepare('DELETE FROM sessions WHERE session_hash = ?').run(sessionHash);
    }
    clearSessionCookie(res, isProduction);
    res.json({ success: true });
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

  app.locals.closeDatabase = () => db.close();
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
  });
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = { createApp, normalizeIdentifier, startServer };
