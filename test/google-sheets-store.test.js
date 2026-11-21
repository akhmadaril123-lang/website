const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createGoogleSheetsStore } = require('../google-sheets-store');

const userHeaders = [
  'id', 'name', 'email', 'phone', 'password_hash', 'education', 'level',
  'reminder_time', 'mic_permission', 'privacy_agreed', 'parental_agreed',
  'onboarding_complete', 'created_at'
];
const sessionHeaders = ['session_hash', 'user_id', 'expires_at'];

function createSheetsClient() {
  const tabs = {
    users: [userHeaders],
    sessions: [sessionHeaders]
  };
  const sheetIds = { users: 1, sessions: 2 };
  return {
    tabs,
    spreadsheets: {
      values: {
        async batchGet() {
          return {
            data: {
              valueRanges: [
                { values: [tabs.users[0]] },
                { values: [tabs.sessions[0]] }
              ]
            }
          };
        },
        async get({ range }) {
          const [sheetName, columns] = range.split('!');
          const endColumn = columns.split(':')[1];
          const count = endColumn.charCodeAt(0) - 64;
          return { data: { values: tabs[sheetName].slice(1).map(row => row.slice(0, count)) } };
        },
        async append({ range, requestBody }) {
          const sheetName = range.split('!')[0];
          tabs[sheetName].push(requestBody.values[0]);
          return { data: {} };
        },
        async update({ range, requestBody }) {
          const match = range.match(/^(\w+)!A(\d+):[A-Z]\d+$/);
          tabs[match[1]][Number(match[2]) - 1] = requestBody.values[0];
          return { data: {} };
        }
      },
      async get() {
        return {
          data: {
            sheets: Object.entries(sheetIds).map(([title, sheetId]) => ({
              properties: { title, sheetId }
            }))
          }
        };
      },
      async batchUpdate({ requestBody }) {
        for (const request of requestBody.requests) {
          const { sheetId, startIndex, endIndex } = request.deleteDimension.range;
          const sheetName = Object.keys(sheetIds).find(name => sheetIds[name] === sheetId);
          tabs[sheetName].splice(startIndex, endIndex - startIndex);
        }
        return { data: {} };
      }
    }
  };
}

test('stores users and sessions in Google Sheets', async () => {
  const sheetsClient = createSheetsClient();
  const store = createGoogleSheetsStore({ spreadsheetId: 'test-sheet', sheetsClient });
  const user = await store.createUser({
    name: 'Sania',
    email: 'sania@example.com',
    phone: null,
    password_hash: 'scrypt-hash',
    education: 'SMA',
    created_at: 100
  });

  assert.equal(user.name, 'Sania');
  assert.equal((await store.findUserByIdentifier({ email: 'sania@example.com' })).id, user.id);
  assert.equal((await store.updateUser(user.id, { level: 'Menengah' })).level, 'Menengah');

  await store.createSession({ session_hash: 'session-hash', user_id: user.id, expires_at: 500 }, 100);
  assert.equal((await store.findSessionUser('session-hash', 200)).id, user.id);
  await store.deleteSession('session-hash');
  assert.equal(await store.findSessionUser('session-hash', 200), undefined);
});

test('rejects sheets with missing headers', async () => {
  const sheetsClient = createSheetsClient();
  sheetsClient.tabs.users[0][0] = 'wrong-header';
  const store = createGoogleSheetsStore({ spreadsheetId: 'test-sheet', sheetsClient });
  await assert.rejects(
    store.findUserById('123'),
    /tab users harus berisi header/
  );
});
