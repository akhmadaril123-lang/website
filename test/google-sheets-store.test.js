const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createGoogleAppsScriptStore } = require('../google-sheets-store');

test('stores users and sessions via Google Apps Script Web App store', async () => {
  const db = { users: [], sessions: [] };
  const fakeFetch = async (url, options) => {
    const body = JSON.parse(options.body);
    let data = null;
    if (body.action === 'createUser') {
      db.users.push(body.user);
      data = body.user;
    } else if (body.action === 'findUserByIdentifier') {
      data = db.users.find(u => u.email === body.identity.email) || null;
    } else if (body.action === 'updateUser') {
      const idx = db.users.findIndex(u => String(u.id) === String(body.id));
      db.users[idx] = { ...db.users[idx], ...body.updates };
      data = db.users[idx];
    } else if (body.action === 'createSession') {
      db.sessions.push(body.session);
      data = { success: true };
    } else if (body.action === 'findSessionUser') {
      const sess = db.sessions.find(s => s.session_hash === body.sessionHash && s.expires_at > body.now);
      const user = sess ? db.users.find(u => String(u.id) === String(sess.user_id)) : null;
      data = user || null;
    } else if (body.action === 'deleteSession') {
      db.sessions = db.sessions.filter(s => s.session_hash !== body.sessionHash);
      data = { success: true };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, data };
      }
    };
  };

  const store = createGoogleAppsScriptStore({
    scriptUrl: 'https://script.google.com/macros/s/test/exec',
    fetchImpl: fakeFetch
  });

  const user = await store.createUser({
    name: 'Sania',
    email: 'sania@example.com',
    phone: null,
    password_hash: 'scrypt-hash',
    education: 'SMA',
    created_at: 100
  });

  assert.equal(user.name, 'Sania');
  assert.equal(user.level, 'Pemula');
  assert.equal((await store.findUserByIdentifier({ email: 'sania@example.com' })).id, user.id);
  assert.equal((await store.updateUser(user.id, { level: 'Lanjut' })).level, 'Lanjut');

  await store.createSession({ session_hash: 'hash-1', user_id: user.id, expires_at: 500 }, 100);
  assert.equal((await store.findSessionUser('hash-1', 200)).id, user.id);
  await store.deleteSession('hash-1');
  assert.equal(await store.findSessionUser('hash-1', 200), undefined);
});
