const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac, randomUUID } = require('node:crypto');
const { Buffer } = require('node:buffer');
const { startLiveBackend } = require('./helpers/live-backend.cjs');
const { loadApp } = require('./helpers/load-app.cjs');

// Starts the sibling backend's real routes with disposable memory stores.
// No workflow, provider, JWT or password-hashing mock is used.
let backend;
const testSigningSecret = randomUUID();
let registeredUser;
let baseUrl;
let app;
let api;
let registeredToken;
let loginToken;
const credentials = { username: 'frontend_login_live', password: 'Only-Test-Password-2026' };

before(async () => {
  backend = await startLiveBackend({ JWT_SECRET: testSigningSecret });
  baseUrl = backend.baseUrl;
  app = loadApp({}, { EXPO_PUBLIC_API_BASE_URL: baseUrl });
  api = app.load('services/backend-api.ts');
});

after(async () => { await backend?.stop(); });

test('live frontend: register against the real backend and receive a JWT', async () => {
  const response = await api.register(credentials);
  assert.equal(response.status, 'registered');
  assert.equal(response.user.username, credentials.username);
  assert.equal(response.token.split('.').length, 3);
  registeredToken = response.token;
  registeredUser = response.user;
});

test('live frontend: token persistence matches the actual login result', async () => {
  await api.storeUserToken(registeredToken, registeredUser.id);
  assert.equal(await api.getStoredUserToken(), registeredToken);
});

test('live frontend: an incorrect password is refused without changing stored login', async () => {
  await assert.rejects(api.login({ ...credentials, password: 'incorrect-password' }), /账号或密码不正确/);
  assert.equal(await api.getStoredUserToken(), registeredToken);
});

test('live frontend: correct credentials log in and issue a usable token', async () => {
  const response = await api.login(credentials);
  assert.equal(response.status, 'authenticated');
  assert.ok(response.user.id);
  assert.equal(response.user.username, credentials.username);
  loginToken = response.token;
});

test('live frontend: authenticated me returns the user without password data', async () => {
  const response = await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${loginToken}` } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.user.username, credentials.username);
  assert.equal(Object.hasOwn(body.user, 'password'), false);
  assert.equal(Object.hasOwn(body.user, 'passwordHash'), false);
  const frontendResponse = await api.getCurrentUser(loginToken);
  assert.equal(frontendResponse.user.username, credentials.username);
});

test('live frontend: duplicate registration is refused by the real API', async () => {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).message, 'username already exists');
  await assert.rejects(api.register(credentials), /账号已存在/);
});

test('live frontend: missing or invalid token cannot access the account', async () => {
  for (const headers of [{}, { Authorization: 'Bearer invalid-test-token' }]) {
    assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers })).status, 401);
  }
  await assert.rejects(api.getCurrentUser('invalid-test-token'), (error) => {
    assert.equal(error.status, 401);
    assert.match(error.message, /登录状态已失效/);
    return true;
  });
});

test('live frontend: browser CORS preflight permits JSON and Authorization', async () => {
  const response = await fetch(`${baseUrl}/api/auth/login`, { method: 'OPTIONS', headers: {
    Origin: 'http://localhost:18082', 'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type,authorization',
  } });
  assert.equal(response.status, 204);
  assert.ok(response.headers.get('access-control-allow-headers').includes('authorization'));
  assert.ok(response.headers.get('access-control-allow-methods').includes('POST'));
});

test('live frontend: a genuinely expired signed token is rejected by me', async () => {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    sub: registeredUser.id, username: credentials.username, exp: Math.floor(Date.now() / 1000) - 60,
  })}`;
  const signature = createHmac('sha256', testSigningSecret).update(unsigned).digest('base64url');
  await assert.rejects(api.getCurrentUser(`${unsigned}.${signature}`), (error) => error.status === 401);
});

test('live frontend: accounts get distinct identities and isolated persisted plans', async () => {
  const responseB = await api.register({ ...credentials, username: 'frontend_account_b' });
  assert.notEqual(responseB.user.id, registeredUser.id);
  assert.equal((await api.getCurrentUser(loginToken)).user.id, registeredUser.id);
  assert.equal((await api.getCurrentUser(responseB.token)).user.id, responseB.user.id);
  const plans = app.load('services/fitness-plan.ts');
  const planA = plans.extractFitnessPlan({ title: 'A private', exercises: [{ name: 'Squat', sets: 3, reps: 10 }] });
  await plans.storeFitnessPlan(planA, registeredUser.id);
  await api.storeUserToken(responseB.token, responseB.user.id);
  assert.equal(await api.getStoredUserId(responseB.token), responseB.user.id);
  assert.equal(await plans.getStoredFitnessPlan(responseB.user.id), null);
  await api.storeUserToken(loginToken, registeredUser.id);
  assert.equal((await plans.getStoredFitnessPlan(registeredUser.id)).title, 'A private');
});

test('live frontend: logout removes the persisted token', async () => {
  await api.clearStoredUserToken();
  assert.equal(await api.getStoredUserToken(), null);
  assert.equal(await api.getStoredUserId(loginToken), null);
});
