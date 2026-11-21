const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');

let server;
let baseUrl;
let app;

before(async () => {
  app = createApp({ databasePath: ':memory:', nodeEnv: 'test' });
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
  app.locals.closeDatabase();
});

async function postJson(path, body, cookie) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
}

test('registers email account, hashes password, and restores session', async () => {
  const response = await postJson('/api/auth/register', {
    name: 'Sania',
    identifier: 'Sania@Example.com',
    password: 'rahasia-aman-123',
    education: 'SMA'
  });
  assert.equal(response.status, 201);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const result = await response.json();
  assert.equal(result.user.email, 'sania@example.com');
  assert.equal(Object.prototype.hasOwnProperty.call(result.user, 'password'), false);

  const meResponse = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } });
  assert.equal(meResponse.status, 200);
  assert.equal((await meResponse.json()).user.name, 'Sania');
});

test('normalizes Indonesian phone numbers and rejects incorrect passwords', async () => {
  const registration = await postJson('/api/auth/register', {
    name: 'Rani',
    identifier: '0812-3456-7890',
    password: 'rahasia-aman-456'
  });
  assert.equal(registration.status, 201);
  const user = (await registration.json()).user;
  assert.equal(user.phone, '+6281234567890');

  const wrongPassword = await postJson('/api/auth/login', {
    identifier: '+6281234567890',
    password: 'password-salah'
  });
  assert.equal(wrongPassword.status, 401);

  const login = await postJson('/api/auth/login', {
    identifier: '081234567890',
    password: 'rahasia-aman-456'
  });
  assert.equal(login.status, 200);
});

test('rejects duplicate accounts and invalid registration passwords', async () => {
  const duplicate = await postJson('/api/auth/register', {
    name: 'Sania lain',
    identifier: 'sania@example.com',
    password: 'rahasia-aman-789'
  });
  assert.equal(duplicate.status, 409);

  const shortPassword = await postJson('/api/auth/register', {
    name: 'Dewi',
    identifier: 'dewi@example.com',
    password: '1234567'
  });
  assert.equal(shortPassword.status, 400);
});

test('persists onboarding choices and invalidates a logged-out session', async () => {
  const registration = await postJson('/api/auth/register', {
    name: 'Dewi',
    identifier: 'dewi@example.com',
    password: 'rahasia-aman-789'
  });
  assert.equal(registration.status, 201);
  const cookie = registration.headers.get('set-cookie').split(';')[0];

  const profileResponse = await fetch(`${baseUrl}/api/auth/profile`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      privacyAgreed: true,
      micPermission: true,
      level: 'Menengah',
      onboardingComplete: true
    })
  });
  assert.equal(profileResponse.status, 200);

  const meResponse = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } });
  const user = (await meResponse.json()).user;
  assert.equal(user.privacyAgreed, true);
  assert.equal(user.level, 'Menengah');
  assert.equal(user.onboardingComplete, true);

  const logoutResponse = await postJson('/api/auth/logout', {}, cookie);
  assert.equal(logoutResponse.status, 200);
  const expiredSessionResponse = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } });
  assert.equal(expiredSessionResponse.status, 401);
});
