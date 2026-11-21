const { google } = require('googleapis');

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
  'created_at'
];
const SESSION_COLUMNS = ['session_hash', 'user_id', 'expires_at'];

function rowToObject(columns, row) {
  return Object.fromEntries(columns.map((column, index) => [column, row[index] ?? '']));
}

function userToRow(user) {
  return USER_COLUMNS.map(column => user[column] ?? '');
}

function sessionToRow(session) {
  return SESSION_COLUMNS.map(column => session[column] ?? '');
}

function normalizeUser(row) {
  return {
    ...row,
    id: String(row.id),
    email: row.email || null,
    phone: row.phone || null,
    mic_permission: Number(row.mic_permission) || 0,
    privacy_agreed: Number(row.privacy_agreed) || 0,
    parental_agreed: Number(row.parental_agreed) || 0,
    onboarding_complete: Number(row.onboarding_complete) || 0,
    created_at: Number(row.created_at) || 0
  };
}

function createGoogleSheetsStore({ spreadsheetId, serviceAccountEmail, privateKey, sheetsClient }) {
  if (!spreadsheetId || (!sheetsClient && (!serviceAccountEmail || !privateKey))) {
    throw new Error('Google Sheets memerlukan GOOGLE_SHEETS_SPREADSHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, dan GOOGLE_PRIVATE_KEY.');
  }

  const sheets = sheetsClient || google.sheets({
    version: 'v4',
    auth: new google.auth.GoogleAuth({
      credentials: {
        client_email: serviceAccountEmail,
        private_key: privateKey.replace(/\\n/g, '\n')
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    })
  });
  let headersValidated;

  async function getRows(sheetName, columns) {
    if (!headersValidated) {
      headersValidated = validateHeaders();
    }
    await headersValidated;
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A2:${String.fromCharCode(64 + columns.length)}`
    });
    return (response.data.values || []).map((row, index) => ({
      rowNumber: index + 2,
      values: rowToObject(columns, row)
    }));
  }

  async function validateHeaders() {
    const response = await sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: ['users!A1:M1', 'sessions!A1:C1']
    });
    const ranges = response.data.valueRanges || [];
    const actualUsers = ranges[0] && ranges[0].values && ranges[0].values[0];
    const actualSessions = ranges[1] && ranges[1].values && ranges[1].values[0];
    if (!actualUsers || actualUsers.join('|') !== USER_COLUMNS.join('|')) {
      throw new Error(`Baris pertama tab users harus berisi header: ${USER_COLUMNS.join(', ')}`);
    }
    if (!actualSessions || actualSessions.join('|') !== SESSION_COLUMNS.join('|')) {
      throw new Error(`Baris pertama tab sessions harus berisi header: ${SESSION_COLUMNS.join(', ')}`);
    }
  }

  async function appendRow(sheetName, values) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [values] }
    });
  }

  async function deleteRows(sheetName, rowNumbers) {
    if (rowNumbers.length === 0) return;
    const metadata = await sheets.spreadsheets.get({ spreadsheetId });
    const sheet = metadata.data.sheets.find(item => item.properties.title === sheetName);
    if (!sheet) throw new Error(`Tab Google Sheets "${sheetName}" tidak ditemukan.`);
    const sheetId = sheet.properties.sheetId;
    const requests = rowNumbers
      .sort((a, b) => b - a)
      .map(rowNumber => ({
        deleteDimension: {
          range: { sheetId, dimension: 'ROWS', startIndex: rowNumber - 1, endIndex: rowNumber }
        }
      }));
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  }

  return {
    async findUserByIdentifier(identity) {
      const users = await getRows('users', USER_COLUMNS);
      const user = users.find(({ values }) => identity.email
        ? String(values.email).toLowerCase() === identity.email
        : values.phone === identity.phone);
      return user ? normalizeUser(user.values) : undefined;
    },

    async findUserById(id) {
      const users = await getRows('users', USER_COLUMNS);
      const user = users.find(({ values }) => String(values.id) === String(id));
      return user ? normalizeUser(user.values) : undefined;
    },

    async createUser(user) {
      const id = require('node:crypto').randomUUID();
      const row = { ...user, id };
      await appendRow('users', userToRow(row));
      return normalizeUser(row);
    },

    async updateUser(id, updates) {
      const users = await getRows('users', USER_COLUMNS);
      const existing = users.find(({ values }) => String(values.id) === String(id));
      if (!existing) return undefined;
      const updated = normalizeUser({ ...existing.values, ...updates });
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `users!A${existing.rowNumber}:M${existing.rowNumber}`,
        valueInputOption: 'RAW',
        requestBody: { values: [userToRow(updated)] }
      });
      return updated;
    },

    async createSession(session, now) {
      const sessions = await getRows('sessions', SESSION_COLUMNS);
      const expiredRows = sessions
        .filter(({ values }) => Number(values.expires_at) <= now)
        .map(({ rowNumber }) => rowNumber);
      await deleteRows('sessions', expiredRows);
      await appendRow('sessions', sessionToRow(session));
    },

    async findSessionUser(sessionHash, now) {
      const sessions = await getRows('sessions', SESSION_COLUMNS);
      const session = sessions.find(({ values }) => values.session_hash === sessionHash);
      if (!session || Number(session.values.expires_at) <= now) {
        if (session) await deleteRows('sessions', [session.rowNumber]);
        return undefined;
      }
      const user = await this.findUserById(session.values.user_id);
      return user ? { ...user, session_hash: sessionHash } : undefined;
    },

    async deleteSession(sessionHash) {
      const sessions = await getRows('sessions', SESSION_COLUMNS);
      const session = sessions.find(({ values }) => values.session_hash === sessionHash);
      if (session) await deleteRows('sessions', [session.rowNumber]);
    },

    close() {}
  };
}

module.exports = { createGoogleSheetsStore };
