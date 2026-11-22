const crypto = require('node:crypto');

const DEFAULT_STATS = Object.freeze({ streak: 3, newWords: 4, weeklyProgress: 65 });

function toNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const integer = Math.trunc(number);
  if (integer < min) return min;
  if (integer > max) return max;
  return integer;
}

function normalizeReminderTime(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(trimmed)) return trimmed;
    const hmMatch = trimmed.match(/^(\d{1,2})[:.](\d{2})(?::\d{2})?$/);
    if (hmMatch) {
      const h = Number(hmMatch[1]);
      const m = Number(hmMatch[2]);
      if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      }
    }
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return `${String(parsed.getHours()).padStart(2, '0')}:${String(parsed.getMinutes()).padStart(2, '0')}`;
    }
  }
  return '19:00';
}

function normalizeUser(row) {
  return {
    ...row,
    id: String(row.id),
    email: row.email || null,
    phone: row.phone || null,
    education: row.education || 'SMA',
    level: row.level || 'Pemula',
    reminder_time: normalizeReminderTime(row.reminder_time || row.reminderTime),
    mic_permission: Number(row.mic_permission ?? row.micPermission) || 0,
    privacy_agreed: Number(row.privacy_agreed ?? row.privacyAgreed) || 0,
    parental_agreed: Number(row.parental_agreed ?? row.parentalAgreed) || 0,
    onboarding_complete: Number(row.onboarding_complete ?? row.onboardingComplete) || 0,
    streak: toNumber(row.streak, DEFAULT_STATS.streak, 0, 100000),
    new_words: toNumber(row.new_words ?? row.newWords, DEFAULT_STATS.newWords, 0, 1000000),
    weekly_progress: toNumber(row.weekly_progress ?? row.weeklyProgress, DEFAULT_STATS.weeklyProgress, 0, 100),
    google_linked: Number(row.google_linked ?? row.googleLinked) || 0,
    google_email: row.google_email || row.googleEmail || null,
    google_sub: row.google_sub || row.googleSub || null,
    created_at: Number(row.created_at) || 0
  };
}

function createGoogleAppsScriptStore({ scriptUrl, fetchImpl = fetch }) {
  if (!scriptUrl) {
    throw new Error('Google Apps Script memerlukan GOOGLE_APPS_SCRIPT_URL.');
  }

  async function callAppsScript(action, payload = {}) {
    let response;
    try {
      response = await fetchImpl(scriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        redirect: 'follow',
        // Cold start Apps Script sering lebih dari 10 detik; 30 detik mencegah
        // login gagal acak saat banyak orang mengakses bersamaan.
        signal: AbortSignal.timeout(30000),
        body: JSON.stringify({ action, ...payload })
      });
    } catch (error) {
      if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
        throw new Error('Google Apps Script tidak merespons dalam 30 detik. Coba lagi beberapa saat.');
      }
      throw error;
    }

    const rawText = typeof response.text === 'function'
      ? await response.text()
      : JSON.stringify(await response.json());

    let result;
    try {
      result = rawText ? JSON.parse(rawText) : null;
    } catch {
      throw new Error('Respons Google Apps Script bukan JSON yang valid. Pastikan Web App di-deploy dengan akses "Anyone".');
    }

    if (!response.ok || !result || result.ok !== true) {
      const errMessage = (result && result.error) || `Permintaan ke Google Apps Script gagal (HTTP ${response.status}).`;
      const error = new Error(errMessage);
      if (errMessage.includes('DUPLICATE_USER')) {
        error.code = 'ERR_SQLITE_CONSTRAINT_UNIQUE';
      }
      throw error;
    }

    return result.data;
  }

  return {
    async findUserByIdentifier(identity) {
      const user = await callAppsScript('findUserByIdentifier', { identity });
      return user ? normalizeUser(user) : undefined;
    },

    async findUserById(id) {
      const user = await callAppsScript('findUserById', { id: String(id) });
      return user ? normalizeUser(user) : undefined;
    },

    async findUserByGoogleSub(googleSub) {
      if (!googleSub) return undefined;
      try {
        const user = await callAppsScript('findUserByGoogleSub', { googleSub: String(googleSub) });
        return user ? normalizeUser(user) : undefined;
      } catch (error) {
        if (error && /Action tidak dikenal/i.test(error.message)) {
          return undefined;
        }
        throw error;
      }
    },

    async createUser(user) {
      const row = {
        id: crypto.randomUUID(),
        education: 'SMA',
        level: 'Pemula',
        reminder_time: '19:00',
        mic_permission: 0,
        privacy_agreed: 0,
        parental_agreed: 0,
        onboarding_complete: 0,
        streak: DEFAULT_STATS.streak,
        new_words: DEFAULT_STATS.newWords,
        weekly_progress: DEFAULT_STATS.weeklyProgress,
        google_linked: 0,
        google_email: '',
        google_sub: '',
        ...user
      };
      const created = await callAppsScript('createUser', { user: row });
      if (created) return normalizeUser(created);
      // Web App lama kadang tidak mengembalikan baris yang dibuat. Ambil ulang
      // dari sheet agar ID sesi selalu cocok dengan ID pengguna sebenarnya.
      try {
        const existing = await callAppsScript('findUserByIdentifier', {
          identity: { email: row.email || null, phone: row.phone || null }
        });
        if (existing) return normalizeUser(existing);
      } catch {
        // Abaikan; baris lokal tetap dipakai sebagai fallback.
      }
      return normalizeUser(row);
    },

    async updateUser(id, updates) {
      const updated = await callAppsScript('updateUser', { id: String(id), updates });
      return updated ? normalizeUser(updated) : undefined;
    },

    async createSession(session, now) {
      await callAppsScript('createSession', { session, now });
    },

    async findSessionUser(sessionHash, now) {
      const user = await callAppsScript('findSessionUser', { sessionHash, now });
      return user ? { ...normalizeUser(user), session_hash: sessionHash } : undefined;
    },

    async deleteSession(sessionHash) {
      await callAppsScript('deleteSession', { sessionHash });
    },

    async deleteUserSessions(userId) {
      try {
        await callAppsScript('deleteUserSessions', { userId: String(userId) });
      } catch (error) {
        if (!error || !/Action tidak dikenal/i.test(error.message)) throw error;
      }
    },

    async createPasswordReset(reset, now) {
      try {
        await callAppsScript('createPasswordReset', { reset, now });
      } catch (error) {
        if (!error || !/Action tidak dikenal/i.test(error.message)) throw error;
      }
    },

    async findPasswordReset(tokenHash, now) {
      try {
        return await callAppsScript('findPasswordReset', { tokenHash, now });
      } catch (error) {
        if (error && /Action tidak dikenal/i.test(error.message)) return null;
        throw error;
      }
    },

    async consumePasswordReset(tokenHash, now) {
      try {
        const result = await callAppsScript('consumePasswordReset', { tokenHash, now });
        return Boolean(result && result.success);
      } catch (error) {
        if (error && /Action tidak dikenal/i.test(error.message)) return false;
        throw error;
      }
    },

    close() {}
  };
}

module.exports = { createGoogleAppsScriptStore, normalizeUser, normalizeReminderTime };
