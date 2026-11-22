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

test('handles forgot password flow', async () => {
  const forgotResponse = await postJson('/api/auth/forgot-password', {
    identifier: 'sania@example.com'
  });
  assert.equal(forgotResponse.status, 200);
});

test('rejects Google login without a verified credential', async () => {
  const noCredential = await postJson('/api/auth/google', {
    name: 'Penyusup',
    email: 'sania.google@example.com'
  });
  assert.equal(noCredential.status, 401);
});

test('verifies Google credential before creating, deduplicating, or linking accounts', async () => {
  const googleApp = createApp({
    databasePath: ':memory:',
    nodeEnv: 'test',
    verifyGoogleToken: async credential => {
      if (credential === 'good-token') {
        return { sub: 'sub-123', email: 'sania.google@example.com', name: 'Sania Google', emailVerified: true };
      }
      if (credential === 'link-token') {
        return { sub: 'sub-456', email: 'dewi@example.com', name: 'Dewi Google', emailVerified: true };
      }
      throw new Error('Token Google tidak valid.');
    }
  });
  const googleServer = googleApp.listen(0);
  await new Promise(resolve => googleServer.once('listening', resolve));
  const googleUrl = `http://127.0.0.1:${googleServer.address().port}`;

  async function postGoogle(body) {
    return fetch(`${googleUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  try {
    const invalidToken = await postGoogle({ credential: 'bad-token' });
    assert.equal(invalidToken.status, 401);

    const googleRegister = await postGoogle({ credential: 'good-token', education: 'SMK' });
    assert.equal(googleRegister.status, 201);
    const firstResult = await googleRegister.json();
    assert.equal(firstResult.isNewUser, true);
    assert.equal(firstResult.user.education, 'SMK');
    assert.equal(firstResult.user.googleLinked, true);
    assert.equal(firstResult.user.provider, 'google');
    const googleUserId = firstResult.user.id;

    const googleLogin = await postGoogle({ credential: 'good-token', education: 'SMA' });
    assert.equal(googleLogin.status, 200);
    const secondResult = await googleLogin.json();
    assert.equal(secondResult.isNewUser, false);
    assert.equal(secondResult.user.id, googleUserId);
    assert.equal(secondResult.user.education, 'SMK');

    const linkRegistration = await fetch(`${googleUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Dewi',
        identifier: 'dewi@example.com',
        password: 'rahasia-aman-dewi'
      })
    });
    assert.equal(linkRegistration.status, 201);
    const existingUser = (await linkRegistration.json()).user;

    const linkResponse = await postGoogle({ credential: 'link-token' });
    assert.equal(linkResponse.status, 200);
    const linkResult = await linkResponse.json();
    assert.equal(linkResult.isNewUser, false);
    assert.equal(linkResult.user.id, existingUser.id);
    assert.equal(linkResult.user.googleLinked, true);
    assert.equal(linkResult.user.email, 'dewi@example.com');
  } finally {
    await new Promise((resolve, reject) => {
      googleServer.close(error => error ? reject(error) : resolve());
    });
    googleApp.locals.closeDatabase();
  }
});
