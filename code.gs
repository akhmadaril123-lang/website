/**
 * ============================================================================
 * SPEAK UP VOICE NOTE COACH - GOOGLE APPS SCRIPT DATABASE (Code.gs)
 * ============================================================================
 * Cara pasang:
 * 1. Buka Google Spreadsheet yang ingin dijadikan database.
 * 2. Klik menu Extensions (Ekstensi) -> Apps Script.
 * 3. Hapus semua kode bawaan, lalu tempel (paste) seluruh isi file Code.gs ini.
 * 4. Jalankan fungsi `setupSheets` sekali dari toolbar Apps Script untuk membuat
 *    tab `users`, `sessions`, dan `password_resets` beserta header kolomnya.
 * 5. Klik tombol "Deploy" -> "New deployment" (Deployment baru):
 *    - Select type: Web app
 *    - Execute as: Me (Saya)
 *    - Who has access: Anyone (Siapa saja)
 * 6. Salin URL Web App (`https://script.google.com/macros/s/.../exec`)
 *    dan masukkan ke environment variable `GOOGLE_APPS_SCRIPT_URL`.
 *
 * Catatan: header kolom baru akan ditambahkan otomatis ke sheet lama saat
 * Web App menerima request pertama, tanpa menghapus data yang sudah ada.
 * ============================================================================
 */

const USER_COLUMNS = [
  'id',
  'name',
  'email',
  'phone',
  'password_hash',
  'education',
  'level',
  'reminder_time',
  'mic_permission',
  'privacy_agreed',
  'parental_agreed',
  'onboarding_complete',
  'created_at',
  'streak',
  'new_words',
  'weekly_progress',
  'google_linked',
  'google_email',
  'google_sub'
];

const SESSION_COLUMNS = [
  'session_hash',
  'user_id',
  'expires_at'
];

const RESET_COLUMNS = [
  'token_hash',
  'user_id',
  'expires_at',
  'used_at',
  'created_at'
];

/**
 * Jalankan fungsi ini sekali dari editor Apps Script untuk menyiapkan tab & header,
 * atau biarkan otomatis dipanggil saat Web App menerima request pertama.
 */
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheetWithHeader_(ss, 'users', USER_COLUMNS);
  ensureSheetWithHeader_(ss, 'sessions', SESSION_COLUMNS);
  ensureSheetWithHeader_(ss, 'password_resets', RESET_COLUMNS);
  return { status: 'ok', message: 'Tab users, sessions, dan password_resets siap digunakan.' };
}

function doGet(e) {
  try {
    setupSheets();
    return jsonResponse_({
      ok: true,
      service: 'SpeakUp Google Apps Script Database',
      tabs: ['users', 'sessions', 'password_resets']
    });
  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function doPost(e) {
  var lock = null;
  try {
    lock = LockService.getScriptLock();
    lock.waitLock(15000);

    const rawBody = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
    const body = JSON.parse(rawBody);

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const usersSheet = ensureSheetWithHeader_(ss, 'users', USER_COLUMNS);
    const sessionsSheet = ensureSheetWithHeader_(ss, 'sessions', SESSION_COLUMNS);
    const resetsSheet = ensureSheetWithHeader_(ss, 'password_resets', RESET_COLUMNS);

    const action = body.action;
    const now = Number(body.now) || Date.now();
    let data = null;

    switch (action) {
      case 'setup':
        data = setupSheets();
        break;
      case 'findUserByIdentifier':
        data = findUserByIdentifier_(usersSheet, body.identity || {});
        break;
      case 'findUserById':
        data = findUserById_(usersSheet, body.id);
        break;
      case 'findUserByGoogleSub':
        data = findUserByGoogleSub_(usersSheet, body.googleSub);
        break;
      case 'createUser':
        data = createUser_(usersSheet, body.user || {});
        break;
      case 'updateUser':
        data = updateUser_(usersSheet, body.id, body.updates || {});
        break;
      case 'createSession':
        data = createSession_(sessionsSheet, body.session || {}, now);
        break;
      case 'findSessionUser':
        data = findSessionUser_(usersSheet, sessionsSheet, body.sessionHash, now);
        break;
      case 'deleteSession':
        data = deleteSession_(sessionsSheet, body.sessionHash);
        break;
      case 'deleteUserSessions':
        data = deleteUserSessions_(sessionsSheet, body.userId);
        break;
      case 'createPasswordReset':
        data = createPasswordReset_(resetsSheet, body.reset || {}, now);
        break;
      case 'findPasswordReset':
        data = findPasswordReset_(resetsSheet, body.tokenHash, now);
        break;
      case 'consumePasswordReset':
        data = consumePasswordReset_(resetsSheet, body.tokenHash, now);
        break;
      default:
        return jsonResponse_({ ok: false, error: 'Action tidak dikenal: ' + action });
    }

    return jsonResponse_({ ok: true, data: data });
  } catch (err) {
    return jsonResponse_({
      ok: false,
      error: String(err && err.message ? err.message : err)
    });
  } finally {
    if (lock) {
      try {
        lock.releaseLock();
      } catch (releaseError) {
        // Abaikan: lock mungkin sudah dilepas otomatis.
      }
    }
  }
}

function ensureSheetWithHeader_(ss, sheetName, columns) {
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
  }

  const lastRow = sheet.getLastRow();
  if (lastRow === 0) {
    sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
    sheet.setFrozenRows(1);
    return sheet;
  }

  const header = getHeader_(sheet);
  const isHeaderEmpty = header.every(function (cell) { return cell === ''; });
  if (isHeaderEmpty) {
    sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
    sheet.setFrozenRows(1);
    return sheet;
  }

  const missing = columns.filter(function (column) {
    return header.indexOf(column) === -1;
  });
  if (missing.length > 0) {
    sheet.getRange(1, header.length + 1, 1, missing.length).setValues([missing]);
  }
  if (sheet.getFrozenRows() === 0) {
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getHeader_(sheet) {
  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  return sheet.getRange(1, 1, 1, lastColumn).getValues()[0]
    .map(function (cell) { return String(cell || '').trim(); });
}

function readRecords_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const header = getHeader_(sheet);
  const lastColumn = Math.max(header.length, 1);
  const values = sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues();
  const rows = [];
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const obj = {};
    for (let c = 0; c < header.length; c++) {
      if (!header[c]) continue;
      obj[header[c]] = row[c] !== undefined && row[c] !== null ? row[c] : '';
    }
    rows.push({
      rowNumber: i + 2,
      values: obj
    });
  }
  return rows;
}

function recordToRow_(sheet, record, fallbackColumns) {
  const header = getHeader_(sheet);
  const columns = header.length > 0 ? header : fallbackColumns;
  return columns.map(function (column) {
    const value = record[column];
    return value === undefined || value === null ? '' : value;
  });
}

function normalizeUser_(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    name: String(row.name || ''),
    email: row.email ? String(row.email).toLowerCase() : null,
    phone: row.phone ? String(row.phone) : null,
    password_hash: String(row.password_hash || ''),
    education: String(row.education || 'SMA'),
    level: String(row.level || 'Pemula'),
    reminder_time: String(row.reminder_time || '19:00'),
    mic_permission: Number(row.mic_permission) || 0,
    privacy_agreed: Number(row.privacy_agreed) || 0,
    parental_agreed: Number(row.parental_agreed) || 0,
    onboarding_complete: Number(row.onboarding_complete) || 0,
    created_at: Number(row.created_at) || 0,
    streak: row.streak === '' || row.streak === undefined ? 3 : Number(row.streak),
    new_words: row.new_words === '' || row.new_words === undefined ? 4 : Number(row.new_words),
    weekly_progress: row.weekly_progress === '' || row.weekly_progress === undefined ? 65 : Number(row.weekly_progress),
    google_linked: Number(row.google_linked) || 0,
    google_email: row.google_email ? String(row.google_email).toLowerCase() : null,
    google_sub: row.google_sub ? String(row.google_sub) : null
  };
}

function normalizeReset_(row) {
  if (!row) return null;
  return {
    token_hash: String(row.token_hash || ''),
    user_id: String(row.user_id || ''),
    expires_at: Number(row.expires_at) || 0,
    used_at: row.used_at === '' || row.used_at === undefined || row.used_at === null ? null : Number(row.used_at),
    created_at: Number(row.created_at) || 0
  };
}

function findUserByIdentifier_(usersSheet, identity) {
  const records = readRecords_(usersSheet);
  const targetEmail = identity.email ? String(identity.email).toLowerCase() : '';
  const targetPhone = identity.phone ? String(identity.phone) : '';

  for (let i = 0; i < records.length; i++) {
    const v = records[i].values;
    if (targetEmail && String(v.email || '').toLowerCase() === targetEmail) {
      return normalizeUser_(v);
    }
    if (targetPhone && String(v.phone || '') === targetPhone) {
      return normalizeUser_(v);
    }
  }
  return null;
}

function findUserById_(usersSheet, id) {
  const records = readRecords_(usersSheet);
  const targetId = String(id);
  for (let i = 0; i < records.length; i++) {
    if (String(records[i].values.id) === targetId) {
      return normalizeUser_(records[i].values);
    }
  }
  return null;
}

function findUserByGoogleSub_(usersSheet, googleSub) {
  if (!googleSub) return null;
  const records = readRecords_(usersSheet);
  const target = String(googleSub);
  for (let i = 0; i < records.length; i++) {
    if (String(records[i].values.google_sub || '') === target) {
      return normalizeUser_(records[i].values);
    }
  }
  return null;
}

function createUser_(usersSheet, user) {
  const existing = findUserByIdentifier_(usersSheet, {
    email: user.email || null,
    phone: user.phone || null
  });
  if (existing) {
    throw new Error('DUPLICATE_USER');
  }

  const newUser = normalizeUser_({
    id: user.id || Utilities.getUuid(),
    name: user.name,
    email: user.email || '',
    phone: user.phone || '',
    password_hash: user.password_hash,
    education: user.education || 'SMA',
    level: user.level || 'Pemula',
    reminder_time: user.reminder_time || '19:00',
    mic_permission: user.mic_permission || 0,
    privacy_agreed: user.privacy_agreed || 0,
    parental_agreed: user.parental_agreed || 0,
    onboarding_complete: user.onboarding_complete || 0,
    created_at: user.created_at || Date.now(),
    streak: user.streak === undefined ? 3 : user.streak,
    new_words: user.new_words === undefined ? 4 : user.new_words,
    weekly_progress: user.weekly_progress === undefined ? 65 : user.weekly_progress,
    google_linked: user.google_linked || 0,
    google_email: user.google_email || '',
    google_sub: user.google_sub || ''
  });

  usersSheet.appendRow(recordToRow_(usersSheet, newUser, USER_COLUMNS));
  return newUser;
}

function updateUser_(usersSheet, id, updates) {
  const records = readRecords_(usersSheet);
  const targetId = String(id);
  for (let i = 0; i < records.length; i++) {
    if (String(records[i].values.id) === targetId) {
      const merged = {};
      const current = records[i].values;
      const keys = Object.keys(current);
      for (let c = 0; c < keys.length; c++) {
        merged[keys[c]] = current[keys[c]];
      }
      const updateKeys = Object.keys(updates);
      for (let u = 0; u < updateKeys.length; u++) {
        merged[updateKeys[u]] = updates[updateKeys[u]];
      }
      const normalized = normalizeUser_(merged);
      usersSheet.getRange(records[i].rowNumber, 1, 1, getHeader_(usersSheet).length)
        .setValues([recordToRow_(usersSheet, normalized, USER_COLUMNS)]);
      return normalized;
    }
  }
  return null;
}

function createSession_(sessionsSheet, session, now) {
  const records = readRecords_(sessionsSheet);
  for (let i = records.length - 1; i >= 0; i--) {
    if (Number(records[i].values.expires_at) <= now) {
      sessionsSheet.deleteRow(records[i].rowNumber);
    }
  }
  sessionsSheet.appendRow(recordToRow_(sessionsSheet, session, SESSION_COLUMNS));
  return { success: true };
}

function findSessionUser_(usersSheet, sessionsSheet, sessionHash, now) {
  const records = readRecords_(sessionsSheet);
  let matchedSession = null;

  for (let i = 0; i < records.length; i++) {
    if (String(records[i].values.session_hash) === String(sessionHash)) {
      matchedSession = records[i];
      break;
    }
  }

  if (!matchedSession) return null;

  if (Number(matchedSession.values.expires_at) <= now) {
    sessionsSheet.deleteRow(matchedSession.rowNumber);
    return null;
  }

  const user = findUserById_(usersSheet, matchedSession.values.user_id);
  if (!user) return null;
  user.session_hash = String(sessionHash);
  return user;
}

function deleteSession_(sessionsSheet, sessionHash) {
  const records = readRecords_(sessionsSheet);
  for (let i = records.length - 1; i >= 0; i--) {
    if (String(records[i].values.session_hash) === String(sessionHash)) {
      sessionsSheet.deleteRow(records[i].rowNumber);
    }
  }
  return { success: true };
}

function deleteUserSessions_(sessionsSheet, userId) {
  const records = readRecords_(sessionsSheet);
  const target = String(userId);
  let deleted = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    if (String(records[i].values.user_id) === target) {
      sessionsSheet.deleteRow(records[i].rowNumber);
      deleted += 1;
    }
  }
  return { success: true, deleted: deleted };
}

function createPasswordReset_(resetsSheet, reset, now) {
  const records = readRecords_(resetsSheet);
  for (let i = records.length - 1; i >= 0; i--) {
    const expiresAt = Number(records[i].values.expires_at) || 0;
    const usedAt = records[i].values.used_at;
    if (expiresAt <= now || (usedAt !== '' && usedAt !== null && usedAt !== undefined)) {
      resetsSheet.deleteRow(records[i].rowNumber);
    }
  }
  const row = {
    token_hash: reset.token_hash,
    user_id: reset.user_id,
    expires_at: reset.expires_at,
    used_at: '',
    created_at: reset.created_at || now
  };
  resetsSheet.appendRow(recordToRow_(resetsSheet, row, RESET_COLUMNS));
  return { success: true };
}

function findPasswordReset_(resetsSheet, tokenHash, now) {
  const records = readRecords_(resetsSheet);
  const target = String(tokenHash || '');
  for (let i = 0; i < records.length; i++) {
    const reset = normalizeReset_(records[i].values);
    if (!reset || reset.token_hash !== target) continue;
    if (reset.used_at !== null) continue;
    if (reset.expires_at <= now) continue;
    return reset;
  }
  return null;
}

function consumePasswordReset_(resetsSheet, tokenHash, now) {
  const records = readRecords_(resetsSheet);
  const target = String(tokenHash || '');
  for (let i = 0; i < records.length; i++) {
    const reset = normalizeReset_(records[i].values);
    if (!reset || reset.token_hash !== target) continue;
    if (reset.used_at !== null || reset.expires_at <= now) return { success: false };
    const updated = {
      token_hash: reset.token_hash,
      user_id: reset.user_id,
      expires_at: reset.expires_at,
      used_at: now,
      created_at: reset.created_at
    };
    resetsSheet.getRange(records[i].rowNumber, 1, 1, getHeader_(resetsSheet).length)
      .setValues([recordToRow_(resetsSheet, updated, RESET_COLUMNS)]);
    return { success: true };
  }
  return { success: false };
}

function jsonResponse_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
