const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { loadApp } = require('./helpers/load-app.cjs');
const { plan } = require('./fixtures/agent-events.cjs');

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

test('auth: login uses the configured API and JSON credentials', async (t) => {
  let request;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    request = { url, ...init };
    return json({ token: 'login-token', user: { id: 'test-user', username: 'tester' } });
  });
  const api = loadApp({}, { EXPO_PUBLIC_API_BASE_URL: 'http://localhost:4000/' }).load('services/backend-api.ts');
  const result = await api.login({ username: 'tester', password: 'password123' });
  assert.equal(request.url, 'http://localhost:4000/api/auth/login');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(request.body), { username: 'tester', password: 'password123' });
  assert.equal(result.token, 'login-token');
});

test('auth: registration uses its own endpoint', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.ok(url.endsWith('/api/auth/register'));
    return json({ token: 'registered-token', user: { id: 'test-user', username: 'tester' } }, 201);
  });
  assert.equal((await loadApp().load('services/backend-api.ts').register({ username: 'tester', password: 'password123' })).token, 'registered-token');
});

test('auth: wrong password is translated into actionable feedback', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({ message: 'invalid username or password' }, 401));
  await assert.rejects(loadApp().load('services/backend-api.ts').login({ username: 'tester', password: 'wrongpass' }), /账号或密码不正确/);
});

test('auth acceptance: duplicate registration explains that the account already exists', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({ message: 'username already exists' }, 409));
  await assert.rejects(loadApp().load('services/backend-api.ts').register({ username: 'tester', password: 'password123' }), /已存在|已注册|已被使用/);
});

test('auth: success without a token is rejected', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({ status: 'authenticated' }));
  await assert.rejects(loadApp().load('services/backend-api.ts').login({ username: 'tester', password: 'password123' }), /状态保存失败/);
});

test('auth: network failure identifies the unreachable login endpoint', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Failed to fetch'); });
  await assert.rejects(loadApp().load('services/backend-api.ts').login({ username: 'tester', password: 'password123' }), /无法连接到.*\/api\/auth\/login/);
});

// Execute the actual provider with a small hook adapter. This tests state and
// storage orchestration; browser testing separately covers rendered controls.
function authHarness(overrides = {}) {
  const states = [];
  const effects = [], refs = [];
  let cursor = 0, refCursor = 0;
  const app = loadApp({ react: { ...React,
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = initial;
      return [states[index], (next) => { states[index] = typeof next === 'function' ? next(states[index]) : next; }];
    },
    useRef(initial) { const index = refCursor++; return refs[index] ??= { current: initial }; },
    useEffect(fn) { effects.push(fn); },
  }, ...overrides });
  const { AuthProvider } = app.load('providers/auth-provider.tsx');
  const render = () => { cursor = 0; refCursor = 0; return AuthProvider({ children: null }).props.value; };
  render();
  return { app, states, render, hydrate: async () => { effects[0](); await new Promise(setImmediate); } };
}

test('auth provider: stored login survives hydration after validation by me', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.ok(url.endsWith('/api/auth/me'));
    assert.equal(init.headers.Authorization, 'Bearer stored-token');
    return json({ user: { id: 'test-user', username: 'tester' } });
  });
  const h = authHarness();
  h.app.storage.set('userToken', 'stored-token');
  await h.hydrate();
  assert.equal(h.render().isAuthenticated, true);
  assert.equal(h.render().isHydrating, false);
  assert.equal(h.render().token, 'stored-token');
  assert.equal(h.render().userId, 'test-user');
});

test('auth provider: first launch finishes hydration without logging in', async () => {
  const h = authHarness();
  await h.hydrate();
  assert.equal(h.render().isAuthenticated, false);
  assert.equal(h.render().isHydrating, false);
});

test('auth acceptance: a rejected stored token must not restore an authenticated session', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({ message: 'authorization token required' }, 401));
  const h = authHarness();
  h.app.storage.set('userToken', 'invalid-test-token');
  await h.hydrate();
  assert.equal(h.render().isAuthenticated, false, 'The UI must agree with the authenticated API');
  assert.equal(h.app.storage.has('userToken'), false);
  assert.match(h.render().sessionError, /已失效/);
});

test('auth provider: transient connectivity failure preserves saved session', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Failed to fetch'); });
  const h = authHarness();
  h.app.storage.set('userToken', 'stored-token');
  await h.hydrate();
  assert.equal(h.render().token, 'stored-token');
  assert.equal(h.app.storage.get('userToken'), 'stored-token');
  assert.equal(h.render().isHydrating, false);
  assert.match(h.render().sessionError, /暂时无法验证/);
});

test('auth provider: server failure mentioning token is not treated as a rejected session', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({ message: 'token service unavailable' }, 503));
  const h = authHarness();
  h.app.storage.set('userToken', 'stored-token');
  await h.hydrate();
  assert.equal(h.render().isAuthenticated, true);
  assert.equal(h.app.storage.get('userToken'), 'stored-token');
  assert.match(h.render().sessionError, /暂时无法验证/);
});

test('auth provider: refreshing revalidates and removes a rejected token', async (t) => {
  let isValid = true;
  t.mock.method(globalThis, 'fetch', async () => isValid
    ? json({ user: { id: 'test-user', username: 'tester' } })
    : json({ message: 'authorization token required' }, 401));
  const h = authHarness();
  h.app.storage.set('userToken', 'stored-token');
  await h.hydrate();
  assert.equal(h.render().isAuthenticated, true);
  isValid = false;
  await h.render().refreshToken();
  assert.equal(h.render().isAuthenticated, false);
  assert.equal(h.app.storage.has('userToken'), false);
});

for (const action of ['signIn', 'signUp']) {
  test(`auth provider: ${action} persists token and updates state`, async (t) => {
    t.mock.method(globalThis, 'fetch', async () => json({ token: 'new-token', user: { id: 'test-user', username: 'tester' } }));
    const h = authHarness();
    await h.render()[action]({ username: 'tester', password: 'password123' });
    assert.equal(h.app.storage.get('userToken'), 'new-token');
    assert.equal(h.render().isAuthenticated, true);
    assert.equal(h.render().userId, 'test-user');
  });
}

test('auth provider: failed login does not create a session', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({ message: 'invalid username or password' }, 401));
  const h = authHarness();
  await assert.rejects(h.render().signIn({ username: 'tester', password: 'wrongpass' }));
  assert.equal(h.app.storage.has('userToken'), false);
  assert.equal(h.render().isAuthenticated, false);
});

test('auth provider: logout clears both persisted token and UI state', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({ user: { id: 'test-user', username: 'tester' } }));
  const h = authHarness();
  h.app.storage.set('userToken', 'stored-token');
  await h.hydrate();
  await h.render().signOut();
  assert.equal(h.app.storage.has('userToken'), false);
  assert.equal(h.render().isAuthenticated, false);
  assert.equal(h.render().userId, null);
});

test('identity: authentication without a stable user ID is rejected', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({ token: 'test-token', user: { username: 'tester' } }));
  await assert.rejects(loadApp().load('services/backend-api.ts').login({ username: 'tester', password: 'password123' }), /状态保存失败/);
});

test('identity: temporary offline restoration keeps only the identity paired with the saved token', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  for (const cachedToken of ['stored-token', 'another-token']) {
    const h = authHarness();
    h.app.storage.set('userToken', 'stored-token');
    h.app.storage.set('userIdentity', JSON.stringify({ token: cachedToken, userId: 'user-a' }));
    await h.hydrate();
    assert.equal(h.render().token, 'stored-token');
    assert.equal(h.render().userId, cachedToken === 'stored-token' ? 'user-a' : null);
  }
});

test('identity: a delayed A login cannot replace B current session or persisted identity', async (t) => {
  let finishA;
  t.mock.method(globalThis, 'fetch', async (_url, init) => JSON.parse(init.body).username === 'account_a'
    ? await new Promise((resolve) => { finishA = resolve; })
    : json({ token: 'token-b', user: { id: 'user-b', username: 'account_b' } }));
  const h = authHarness();
  const pendingA = h.render().signIn({ username: 'account_a', password: 'password123' });
  await h.render().signIn({ username: 'account_b', password: 'password123' });
  finishA(json({ token: 'token-a', user: { id: 'user-a', username: 'account_a' } })); await pendingA;
  assert.equal(h.render().token, 'token-b');
  assert.equal(h.render().userId, 'user-b');
  assert.equal(h.app.storage.get('userToken'), 'token-b');
  assert.deepEqual(JSON.parse(h.app.storage.get('userIdentity')), { token: 'token-b', userId: 'user-b' });
  await h.render().signOut('token-a');
  assert.equal(h.render().token, 'token-b');
});

test('identity: an old A refresh rejection cannot clear B after account switching', async (t) => {
  let finishRefresh;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url.endsWith('/me')) return await new Promise((resolve) => { finishRefresh = resolve; });
    const name = JSON.parse(init.body).username;
    return json({ token: `token-${name}`, user: { id: `user-${name}`, username: name } });
  });
  const h = authHarness();
  await h.render().signIn({ username: 'a', password: 'password123' });
  const refresh = h.render().refreshToken(); await new Promise(setImmediate);
  await h.render().signIn({ username: 'b', password: 'password123' });
  finishRefresh(json({ message: 'invalid old token' }, 401)); await refresh;
  assert.equal(h.render().token, 'token-b');
  assert.equal(h.render().userId, 'user-b');
  assert.equal(h.app.storage.get('userToken'), 'token-b');
  assert.equal(h.render().sessionError, null);
});

test('identity: delayed A logout storage cannot remove a later B login', async (t) => {
  const stored = new Map();
  let releaseLogout, signalLogout;
  const began = new Promise((resolve) => { signalLogout = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const name = JSON.parse(init.body).username;
    return json({ token: `token-${name}`, user: { id: `user-${name}`, username: name } });
  });
  const h = authHarness({ '@react-native-async-storage/async-storage': {
    getItem: async (key) => stored.get(key) ?? null,
    setItem: async (key, value) => { stored.set(key, value); },
    removeItem: async (key) => {
      if (key === 'userToken') { signalLogout(); await new Promise((resolve) => { releaseLogout = resolve; }); }
      stored.delete(key);
    },
  } });
  await h.render().signIn({ username: 'a', password: 'password123' });
  const logout = h.render().signOut('token-a'); await began;
  const loginB = h.render().signIn({ username: 'b', password: 'password123' });
  releaseLogout(); await Promise.all([logout, loginB]);
  assert.equal(h.render().token, 'token-b');
  assert.equal(h.render().userId, 'user-b');
  assert.equal(stored.get('userToken'), 'token-b');
});

function profileHarness(authOverrides = {}) {
  const states = [];
  const calls = [];
  let cursor = 0;
  const auth = {
    isAuthenticated: false, isHydrating: false, sessionError: null,
    signIn: async (input) => { calls.push({ action: 'login', input }); },
    signUp: async (input) => { calls.push({ action: 'register', input }); },
    signOut: async () => { calls.push({ action: 'logout' }); },
    ...authOverrides,
  };
  const app = loadApp({
    react: { ...React, useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = initial;
      return [states[index], (next) => { states[index] = typeof next === 'function' ? next(states[index]) : next; }];
    } },
    '@/hooks/use-auth': { useAuth: () => auth },
    'react-native': {
      Platform: { OS: 'web', select: (options) => options.web ?? options.default },
      StyleSheet: { create: (styles) => styles },
      ...Object.fromEntries(['ActivityIndicator', 'Pressable', 'ScrollView', 'Text', 'TextInput', 'View'].map((name) => [name, name])),
    },
  });
  const Screen = app.load('app/(tabs)/profile.tsx').default;
  const render = () => { cursor = 0; return Screen(); };
  function findAll(node, type) {
    if (!node || typeof node !== 'object') return [];
    return [...(node.type === type ? [node] : []),
      ...React.Children.toArray(node.props?.children).flatMap((child) => findAll(child, type))];
  }
  return {
    auth, calls, states,
    inputs: () => findAll(render(), 'TextInput'),
    buttons: () => findAll(render(), 'Pressable'),
    text: () => findAll(render(), 'Text').map((element) => element.props.children).join(' '),
  };
}

test('profile: invalid credential boundaries are rejected before contacting the server', async () => {
  for (const [username, password, expected] of [
    ['', '', /请输入账号和密码/],
    ['ab', 'password123', /3–32/],
    ['a'.repeat(33), 'password123', /3–32/],
    ['用户名称', 'password123', /英文字母/],
    ['user name', 'password123', /英文字母/],
    ['tester', '1234567', /至少需要 8/],
    ['tester', 'a'.repeat(73), /最多支持 72/],
  ]) {
    for (const buttonIndex of [0, 1]) {
      const h = profileHarness();
      h.inputs()[0].props.onChangeText(username);
      h.inputs()[1].props.onChangeText(password);
      await h.buttons()[buttonIndex].props.onPress();
      assert.equal(h.calls.length, 0);
      assert.match(h.states[2], expected);
    }
  }
});

test('profile: valid edge credentials submit a trimmed username and preserve the password', async () => {
  for (const [username, password, buttonIndex] of [
    ['  A_-  ', '12345678', 0],
    ['a'.repeat(32), 'x'.repeat(72), 1],
  ]) {
    const h = profileHarness();
    h.inputs()[0].props.onChangeText(username);
    h.inputs()[1].props.onChangeText(password);
    await h.buttons()[buttonIndex].props.onPress();
    assert.deepEqual(h.calls, [{ action: buttonIndex === 0 ? 'login' : 'register', input: { username: username.trim(), password } }]);
    assert.equal(h.inputs()[1].props.value, '');
    assert.equal(h.states[3], null);
  }
});

test('profile: hydration disables account actions and session errors are visible', () => {
  const h = profileHarness({ isHydrating: true, sessionError: '登录状态已失效，请重新登录。' });
  assert.ok(h.buttons().every((button) => button.props.disabled));
  assert.ok(h.inputs().every((input) => !input.props.editable));
  assert.match(h.text(), /登录状态已失效/);
});

test('profile: API failure leaves the form ready to correct and retry', async () => {
  const h = profileHarness({ signIn: async () => { throw new Error('账号或密码不正确，请检查后重试。'); } });
  h.inputs()[0].props.onChangeText('tester');
  h.inputs()[1].props.onChangeText('password123');
  await h.buttons()[0].props.onPress();
  assert.match(h.text(), /账号或密码不正确/);
  assert.equal(h.inputs()[1].props.value, 'password123');
  assert.ok(h.buttons().every((button) => !button.props.disabled));
});

test('training: backend plan is normalized into executable sets', () => {
  const api = loadApp().load('services/fitness-plan.ts');
  const extracted = api.extractFitnessPlan({ output: { plan } });
  assert.equal(extracted.title, plan.title);
  assert.equal(extracted.exercises[0].name, '杠铃深蹲');
  assert.equal(extracted.exercises[0].sets.length, 3);
  assert.equal(extracted.exercises[0].sets[0].reps, '10');
});

test('training: edited weight, reps and completion survive storage reload', async () => {
  const api = loadApp().load('services/fitness-plan.ts');
  const extracted = api.extractFitnessPlan(plan);
  Object.assign(extracted.exercises[0].sets[0], { kg: '25', reps: '12', completed: true });
  await api.storeFitnessPlan(extracted, 'test-user');
  const restored = await api.getStoredFitnessPlan('test-user');
  assert.deepEqual(restored.exercises[0].sets[0], extracted.exercises[0].sets[0]);
});

test('training: missing and corrupt storage yield the empty state', async () => {
  const app = loadApp();
  const api = app.load('services/fitness-plan.ts');
  assert.equal(await api.getStoredFitnessPlan('test-user'), null);
  app.storage.set('fitnessPlan:test-user', '{broken');
  assert.equal(await api.getStoredFitnessPlan('test-user'), null);
});

test('training: plan notifications stop after unsubscribe', async () => {
  const api = loadApp().load('services/fitness-plan.ts');
  const received = [];
  const unsubscribe = api.subscribeToFitnessPlan('test-user', (value) => received.push(value));
  const extracted = api.extractFitnessPlan(plan);
  await api.storeFitnessPlan(extracted, 'test-user');
  unsubscribe();
  await api.storeFitnessPlan(extracted, 'test-user');
  assert.equal(received.length, 1);
  assert.equal(received[0].title, plan.title);
});

test('identity: unscoped legacy plans are retained without being assigned to any account', async () => {
  const app = loadApp();
  const api = app.load('services/fitness-plan.ts');
  const legacy = JSON.stringify(api.extractFitnessPlan(plan));
  app.storage.set('fitnessPlan', legacy);
  assert.equal(await api.getStoredFitnessPlan(null), null);
  assert.equal(await api.getStoredFitnessPlan('user-a'), null);
  assert.equal(app.storage.get('fitnessPlan'), legacy);
  await assert.rejects(api.storeFitnessPlan(api.extractFitnessPlan(plan), ''), /登录用户身份/);
});

test('identity: each account restores its own plan and receives only its own notifications', async () => {
  const app = loadApp();
  const api = app.load('services/fitness-plan.ts');
  const eventsA = [], eventsB = [];
  const unsubscribeA = api.subscribeToFitnessPlan('user-a', (value) => eventsA.push(value));
  const unsubscribeB = api.subscribeToFitnessPlan('user-b', (value) => eventsB.push(value));
  await api.storeFitnessPlan(api.extractFitnessPlan({ ...plan, title: 'A_PRIVATE_PLAN' }), 'user-a');
  assert.equal(eventsA.length, 1); assert.equal(eventsB.length, 0);
  await api.storeFitnessPlan(api.extractFitnessPlan({ ...plan, title: 'B_PLAN' }), 'user-b');
  assert.equal((await api.getStoredFitnessPlan('user-a')).title, 'A_PRIVATE_PLAN');
  assert.equal((await api.getStoredFitnessPlan('user-b')).title, 'B_PLAN');
  assert.equal(eventsA.length, 1); assert.equal(eventsB.length, 1);
  unsubscribeA(); unsubscribeB();
});

test('identity: slow training writes preserve snapshots and latest edits in their account namespace', async () => {
  const stored = new Map();
  let release, signal;
  const began = new Promise((resolve) => { signal = resolve; });
  let writes = 0;
  const app = loadApp({ '@react-native-async-storage/async-storage': {
    getItem: async (key) => stored.get(key) ?? null,
    setItem: async (key, value) => {
      if (++writes === 1) { signal(); await new Promise((resolve) => { release = resolve; }); }
      stored.set(key, value);
    },
    removeItem: async (key) => { stored.delete(key); },
  } });
  const api = app.load('services/fitness-plan.ts');
  const received = [];
  api.subscribeToFitnessPlan('user-a', (value) => received.push(value));
  const firstPlan = api.extractFitnessPlan(plan);
  const first = api.storeFitnessPlan(firstPlan, 'user-a'); await began;
  firstPlan.title = 'Latest A edit';
  const second = api.storeFitnessPlan(firstPlan, 'user-a');
  firstPlan.title = 'Not submitted';
  await api.storeFitnessPlan(api.extractFitnessPlan({ ...plan, title: 'B_PLAN' }), 'user-b');
  const reading = api.getStoredFitnessPlan('user-a');
  release(); await Promise.all([first, second]);
  assert.equal((await reading).title, 'Latest A edit');
  assert.deepEqual(received.map((value) => value.title), ['Latest A edit']);
  assert.equal((await api.getStoredFitnessPlan('user-b')).title, 'B_PLAN');
});

function fitnessHarness(auth = { userId: 'user-a' }, storageOverride) {
  const states = [], refs = [], effects = [], callbacks = [];
  let cursor = 0, refCursor = 0, effectCursor = 0, callbackCursor = 0, queued = [], tree;
  const same = (left, right) => left?.length === right?.length && left.every((value, index) => Object.is(value, right[index]));
  function effect(fn, deps) {
    const index = effectCursor++;
    const previous = effects[index];
    if (!previous || !same(deps, previous.deps)) queued.push(() => {
      previous?.cleanup?.(); effects[index] = { deps, cleanup: fn() };
    });
  }
  const app = loadApp({
    react: { ...React, useEffect: effect, useLayoutEffect: effect,
      useState(initial) {
        const index = cursor++;
        if (!(index in states)) states[index] = initial;
        return [states[index], (next) => { states[index] = typeof next === 'function' ? next(states[index]) : next; }];
      },
      useRef(initial) { const index = refCursor++; return refs[index] ??= { current: initial }; },
      useCallback(fn, deps) {
        const index = callbackCursor++;
        if (!callbacks[index] || !same(deps, callbacks[index].deps)) callbacks[index] = { fn, deps };
        return callbacks[index].fn;
      },
    },
    '@/hooks/use-auth': { useAuth: () => auth },
    '@react-navigation/native': { useFocusEffect: (fn) => effect(fn, [fn]) },
    '@/components/fitness-exercise-card': { FitnessExerciseCard: 'ExerciseCard' },
    ...(storageOverride ? { '@react-native-async-storage/async-storage': storageOverride } : {}),
  });
  const Screen = app.load('app/(tabs)/fitness.tsx').default;
  function render(ownerId = auth.userId) {
    auth.userId = ownerId; cursor = 0; refCursor = 0; effectCursor = 0; callbackCursor = 0; queued = [];
    tree = Screen(); for (const run of queued) run(); return tree;
  }
  function findAll(node, type) {
    if (!node || typeof node !== 'object') return [];
    return [...(node.type === type ? [node] : []),
      ...React.Children.toArray(node.props?.children).flatMap((child) => findAll(child, type))];
  }
  async function settle() {
    for (let attempt = 0; states[2] && attempt < 50; attempt++) await new Promise(setImmediate);
    render(); assert.equal(states[2], false); return states[0];
  }
  return { app, states, render, settle, tree: () => tree, cards: () => findAll(tree, 'ExerciseCard'),
    unmount: () => effects.forEach((item) => item.cleanup?.()),
  };
}

test('identity: Fitness immediately hides A after switching to B and restores each owner independently', async () => {
  const h = fitnessHarness();
  const api = h.app.load('services/fitness-plan.ts');
  await api.storeFitnessPlan(api.extractFitnessPlan({ ...plan, title: 'A_PRIVATE_PLAN' }), 'user-a');
  await api.storeFitnessPlan(api.extractFitnessPlan({ ...plan, title: 'B_PLAN' }), 'user-b');
  h.render(); assert.equal((await h.settle()).title, 'A_PRIVATE_PLAN');
  h.render('user-b'); assert.equal(h.cards().length, 0);
  assert.equal((await h.settle()).title, 'B_PLAN');
  h.render(null); assert.equal(h.cards().length, 0); assert.equal(await h.settle(), null);
  h.render('user-a'); assert.equal((await h.settle()).title, 'A_PRIVATE_PLAN');
  h.unmount();
});

test('identity: delayed Fitness read from A cannot replace B plan or loading state', async () => {
  const stored = new Map();
  let releaseA, startedA;
  const began = new Promise((resolve) => { startedA = resolve; });
  const h = fitnessHarness({ userId: 'user-a' }, {
    getItem: async (key) => {
      if (key === 'fitnessPlan:user-a') { startedA(); await new Promise((resolve) => { releaseA = resolve; }); }
      return stored.get(key) ?? null;
    },
    setItem: async (key, value) => { stored.set(key, value); }, removeItem: async (key) => { stored.delete(key); },
  });
  const api = h.app.load('services/fitness-plan.ts');
  await api.storeFitnessPlan(api.extractFitnessPlan({ ...plan, title: 'A_PRIVATE_PLAN' }), 'user-a');
  await api.storeFitnessPlan(api.extractFitnessPlan({ ...plan, title: 'B_PLAN' }), 'user-b');
  h.render(); await began; h.render('user-b'); assert.equal((await h.settle()).title, 'B_PLAN');
  releaseA(); await new Promise(setImmediate);
  assert.equal(h.states[0].title, 'B_PLAN'); assert.equal(h.states[2], false);
  h.unmount();
});

test('identity: stale A training controls cannot edit B and B edits persist only for B', async () => {
  const h = fitnessHarness();
  const api = h.app.load('services/fitness-plan.ts');
  await api.storeFitnessPlan(api.extractFitnessPlan({ ...plan, title: 'A_PRIVATE_PLAN' }), 'user-a');
  await api.storeFitnessPlan(api.extractFitnessPlan({ ...plan, title: 'B_PLAN' }), 'user-b');
  h.render(); await h.settle(); const oldCard = h.cards()[0];
  h.render('user-b'); await h.settle();
  oldCard.props.onAddSet(); await new Promise(setImmediate);
  assert.equal((await api.getStoredFitnessPlan('user-b')).exercises[0].sets.length, 3);
  const card = h.cards()[0]; const setId = card.props.exercise.sets[0].id;
  card.props.onUpdateSet(setId, 'kg', '25');
  card.props.onUpdateSet(setId, 'reps', '12');
  await new Promise(setImmediate);
  const restoredB = await api.getStoredFitnessPlan('user-b');
  assert.equal(restoredB.exercises[0].sets[0].kg, '25');
  assert.equal(restoredB.exercises[0].sets[0].reps, '12');
  const restoredA = await api.getStoredFitnessPlan('user-a');
  assert.equal(restoredA.exercises[0].sets[0].kg, '');
  h.unmount();
});

test('calories: sends the image and computes the midpoint of an estimate', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.ok(url.endsWith('/api/agent/vlm/analyze'));
    const input = JSON.parse(init.body);
    assert.equal(input.preferredTask, 'food_calorie_estimate');
    assert.equal(input.images[0].image, 'data:image/jpeg;base64,AA==');
    return json({ summary: '米饭热量估算', results: [{ foodAnalysis: {
      totalCaloriesLow: 180, totalCaloriesHigh: 240, items: [{ name: '米饭' }],
    } }] });
  });
  const app = loadApp();
  app.storage.set('userToken', 'camera-test-token');
  const result = await app.load('services/calorie-api.ts').analyzeMealPhoto({ uri: 'data:image/jpeg;base64,AA==' });
  assert.equal(result.calories, 210);
  assert.equal(result.title, '米饭');
  assert.equal(result.summary, '米饭热量估算');
});

test('calories: non-food response does not invent a calorie value', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({ summary: '不是食物', results: [] }));
  const app = loadApp();
  app.storage.set('userToken', 'camera-test-token');
  const result = await app.load('services/calorie-api.ts').analyzeMealPhoto({ uri: 'data:image/jpeg;base64,AA==' });
  assert.equal(result.calories, null);
  assert.equal(result.summary, '不是食物');
});

test('calories: authentication rejection propagates to the retry UI', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({ message: 'authorization token required' }, 401));
  const app = loadApp();
  app.storage.set('userToken', 'camera-test-token');
  await assert.rejects(app.load('services/calorie-api.ts').analyzeMealPhoto({ uri: 'data:image/jpeg;base64,AA==' }), (error) => {
    assert.equal(error.status, 401);
    assert.match(error.message, /登录状态已失效/);
    return true;
  });
});

test('calories: losing the stored session prevents any anonymous image request', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return json({ results: [] }); });
  await assert.rejects(loadApp().load('services/calorie-api.ts').analyzeMealPhoto({ uri: 'file:///private-meal.jpg' }), (error) => {
    assert.equal(error.status, 401);
    assert.match(error.message, /请先登录/);
    return true;
  });
  assert.equal(requests, 0);
});

test('camera: denied permission prevents capture and gives feedback', async () => {
  const states = [];
  let cursor = 0;
  let captured = false;
  const app = loadApp({
    react: { ...React, useRef: () => ({ current: { takePictureAsync: async () => { captured = true; } } }),
      useState(initial) { const index = cursor++; states[index] = initial; return [initial, (value) => { states[index] = value; }]; } },
    'expo-camera': { useCameraPermissions: () => [{ granted: false }, async () => ({ granted: false, canAskAgain: false })] },
  });
  const camera = app.load('hooks/use-camera.ts').useCamera();
  assert.equal(await camera.takePhoto(), null);
  assert.equal(captured, false);
  assert.match(states[4], /系统设置/);
});

test('camera: an unready preview prevents capture', async () => {
  const states = [];
  let cursor = 0;
  const app = loadApp({
    react: { ...React, useRef: () => ({ current: {} }),
      useState(initial) { const index = cursor++; states[index] = initial; return [initial, (value) => { states[index] = value; }]; } },
    'expo-camera': { useCameraPermissions: () => [{ granted: true }, async () => ({ granted: true })] },
  });
  assert.equal(await app.load('hooks/use-camera.ts').useCamera().takePhoto(), null);
  assert.match(states[4], /预览尚未就绪/);
});

function cameraHarness(takePictureAsync) {
  const states = [];
  let cursor = 0;
  const ref = { current: { takePictureAsync } };
  const app = loadApp({
    react: { ...React, useRef: () => ref,
      useState(initial) {
        const index = cursor++;
        if (!(index in states)) states[index] = initial;
        return [states[index], (next) => { states[index] = typeof next === 'function' ? next(states[index]) : next; }];
      } },
    'expo-camera': { useCameraPermissions: () => [{ granted: true }, async () => ({ granted: true })] },
  });
  const { useCamera } = app.load('hooks/use-camera.ts');
  const useRender = () => { cursor = 0; return useCamera(); };
  return { render: useRender };
}

test('camera: ready capture stores the picture and retake clears it', async () => {
  const picture = { uri: 'file:///test-only.jpg', width: 100, height: 100 };
  const h = cameraHarness(async (options) => {
    assert.equal(options.quality, 0.7);
    return picture;
  });
  h.render().markCameraReady();
  assert.equal(await h.render().takePhoto(), picture);
  assert.equal(h.render().lastPhoto, picture);
  assert.equal(h.render().isCapturing, false);
  h.render().clearPhoto();
  assert.equal(h.render().lastPhoto, null);
});

test('camera: capture failure resets busy state so the user can retry', async () => {
  let attempts = 0;
  const h = cameraHarness(async () => {
    if (++attempts === 1) throw new Error('camera test failure');
    return { uri: 'file:///retry-only.jpg' };
  });
  h.render().markCameraReady();
  assert.equal(await h.render().takePhoto(), null);
  assert.equal(h.render().isCapturing, false);
  assert.match(h.render().errorMessage, /camera test failure/);
  assert.equal((await h.render().takePhoto()).uri, 'file:///retry-only.jpg');
  assert.equal(h.render().errorMessage, null);
});

test('camera: switching lenses invalidates preview readiness', () => {
  const h = cameraHarness(async () => null);
  h.render().markCameraReady();
  h.render().toggleFacing();
  assert.equal(h.render().facing, 'front');
  assert.equal(h.render().isCameraReady, false);
  h.render().toggleFacing();
  assert.equal(h.render().facing, 'back');
});

function cameraPageHarness(options = {}) {
  const states = [];
  const refs = [];
  const calls = { captures: 0, analyses: [], signOuts: 0, routes: [] };
  let cursor = 0;
  let refCursor = 0;
  const picture = { uri: 'data:image/jpeg;base64,AA==', width: 100, height: 100 };
  const auth = {
    isAuthenticated: true, isHydrating: false, token: 'camera-test-token',
    signOut: async () => {
      calls.signOuts++;
      auth.isAuthenticated = false;
      auth.token = null;
      app.storage.delete('userToken');
      if (options.logoutFailure) throw new Error('storage failure');
    },
    ...options.auth,
  };
  const camera = {
    hasPermission: true, canAskPermissionAgain: true, isPermissionLoading: false,
    cameraRef: { current: null }, facing: 'back', isCameraReady: true, isCapturing: false,
    lastPhoto: null, errorMessage: null,
    requestPermission: async () => true,
    toggleFacing: () => {}, markCameraReady: () => {}, setCameraError: () => {},
    clearPhoto: () => { camera.lastPhoto = null; },
    takePhoto: async () => {
      calls.captures++;
      camera.lastPhoto = options.captureFailure ? null : picture;
      return camera.lastPhoto;
    },
  };
  const app = loadApp({
    react: { ...React,
      useState(initial) {
        const index = cursor++;
        if (!(index in states)) states[index] = initial;
        return [states[index], (next) => { states[index] = typeof next === 'function' ? next(states[index]) : next; }];
      },
      useRef(initial) {
        const index = refCursor++;
        if (!(index in refs)) refs[index] = { current: initial };
        return refs[index];
      },
    },
    '@/hooks/use-auth': { useAuth: () => auth },
    '@/hooks/use-camera': { useCamera: () => camera },
    '@/services/calorie-api': { analyzeMealPhoto: async (photo) => {
      calls.analyses.push(photo);
      if (options.analyze) return await options.analyze(photo, calls.analyses.length, app);
      return { calories: 210, title: '米饭', summary: '米饭热量估算', raw: {} };
    } },
    'expo-router': { useRouter: () => ({ navigate: (route) => { calls.routes.push(route); } }) },
    'expo-camera': { CameraView: 'CameraView' },
    'expo-image': { Image: 'Image' },
    'react-native': {
      Platform: { OS: 'web', select: (value) => value.web ?? value.default },
      StyleSheet: { create: (value) => value, absoluteFillObject: {} },
      ...Object.fromEntries(['ActivityIndicator', 'Pressable', 'ScrollView', 'Text', 'View'].map((name) => [name, name])),
    },
  });
  if (auth.token) app.storage.set('userToken', auth.token);
  const Screen = app.load('components/camera/calorie-camera-page.tsx').CalorieCameraPage;
  const render = () => { cursor = 0; refCursor = 0; return Screen(); };
  function findAll(node, type) {
    if (!node || typeof node !== 'object') return [];
    return [...(node.type === type ? [node] : []),
      ...React.Children.toArray(node.props?.children).flatMap((child) => findAll(child, type))];
  }
  const elements = (type) => findAll(render(), type);
  const button = (label) => elements('Pressable').find((element) =>
    element.props.accessibilityLabel === label || findAll(element, 'Text').some((text) => text.props.children === label));
  return {
    app, auth, camera, calls, states, picture, button,
    capture: () => button('拍照并识别食物热量').props.onPress(),
    press: (label) => {
      const found = button(label);
      assert.ok(found, `Missing button: ${label}`);
      return found.props.onPress();
    },
    images: () => elements('Image'),
    text: () => elements('Text').map((element) => element.props.children).flat().join(' '),
  };
}

test('camera page: anonymous capture is blocked and the login action opens the account tab', async () => {
  const h = cameraPageHarness({ auth: { isAuthenticated: false, token: null } });
  assert.equal(h.button('拍照并识别食物热量').props.disabled, true);
  assert.match(h.text(), /请先登录/);
  await h.capture(); // Also exercise the handler guard, beyond the disabled button.
  assert.equal(h.calls.captures, 0);
  assert.equal(h.calls.analyses.length, 0);
  h.press('前往登录');
  assert.deepEqual(h.calls.routes, ['/(tabs)/profile']);
});

test('camera page: hydration blocks capture until the session is restored', async () => {
  const h = cameraPageHarness({ auth: { isHydrating: true } });
  assert.equal(h.button('拍照并识别食物热量').props.disabled, true);
  await h.capture();
  assert.equal(h.calls.captures, 0);
  assert.equal(h.calls.analyses.length, 0);
});

test('camera page: capture automatically analyzes the photo and presents calories', async () => {
  const h = cameraPageHarness();
  await h.capture();
  assert.equal(h.calls.captures, 1);
  assert.deepEqual(h.calls.analyses, [h.picture]);
  assert.equal(h.states[0], 'success');
  assert.match(h.text(), /210/);
  assert.match(h.text(), /米饭热量估算/);
  assert.equal(h.images()[0].props.source.uri, h.picture.uri);
});

test('camera page: failed capture does not start an upload', async () => {
  const h = cameraPageHarness({ captureFailure: true });
  await h.capture();
  assert.equal(h.calls.analyses.length, 0);
  assert.equal(h.states[0], 'idle');
});

test('camera page: upload failure preserves the photo and retry reuses it without recapture', async () => {
  const h = cameraPageHarness({ analyze: async (photo, attempt) => {
    if (attempt === 1) throw new Error('网络连接异常，请稍后再试。');
    return { calories: 220, title: '米饭', summary: '重试识别完成', raw: {} };
  } });
  await h.capture();
  assert.equal(h.states[0], 'error');
  assert.match(h.text(), /网络连接异常/);
  assert.equal(h.images()[0].props.source.uri, h.picture.uri);
  await h.press('重新上传');
  assert.equal(h.calls.captures, 1);
  assert.deepEqual(h.calls.analyses, [h.picture, h.picture]);
  assert.equal(h.states[0], 'success');
  assert.match(h.text(), /220/);
  assert.equal(h.calls.signOuts, 0);
});

test('camera page: retaking clears the photo, analysis and error', async () => {
  const h = cameraPageHarness();
  await h.capture();
  h.press('重新拍摄');
  assert.equal(h.camera.lastPhoto, null);
  assert.deepEqual(h.states, ['idle', null, null]);
  assert.equal(h.images().length, 0);
  assert.equal(h.button('拍照并识别食物热量').props.disabled, false);
  assert.match(h.text(), /--/);
});

test('camera page: 401 clears the session, retains the photo and allows retry after login', async () => {
  const h = cameraPageHarness({ analyze: async (photo, attempt, app) => {
    if (attempt === 1) throw new (app.load('services/backend-api.ts').BackendApiError)('authorization token required', 401);
    return { calories: 215, title: '米饭', summary: '登录后识别完成', raw: {} };
  } });
  await h.capture();
  assert.equal(h.calls.signOuts, 1);
  assert.equal(h.auth.token, null);
  assert.equal(h.app.storage.has('userToken'), false);
  assert.equal(h.images()[0].props.source.uri, h.picture.uri);
  assert.match(h.text(), /登录状态已失效.*照片已保留/);
  h.press('登录后重试');
  assert.deepEqual(h.calls.routes, ['/(tabs)/profile']);
  assert.equal(h.calls.analyses.length, 1);
  Object.assign(h.auth, { isAuthenticated: true, token: 'new-camera-token' });
  h.app.storage.set('userToken', 'new-camera-token');
  await h.press('重新上传');
  assert.equal(h.states[0], 'success');
  assert.equal(h.calls.captures, 1);
  assert.match(h.text(), /215/);
});

test('camera page: failed local logout cleanup still completes the 401 feedback', async () => {
  const h = cameraPageHarness({ logoutFailure: true, analyze: async (photo, attempt, app) => {
    throw new (app.load('services/backend-api.ts').BackendApiError)('authorization token required', 401);
  } });
  await h.capture();
  assert.equal(h.states[0], 'error');
  assert.equal(h.auth.token, null);
  assert.match(h.text(), /登录状态已失效/);
  assert.equal(h.images().length, 1);
});

test('camera page: 403 and server failures preserve the authenticated session', async () => {
  for (const status of [403, 503]) {
    const h = cameraPageHarness({ analyze: async (photo, attempt, app) => {
      throw new (app.load('services/backend-api.ts').BackendApiError)('服务暂时不可用，请稍后再试。', status);
    } });
    await h.capture();
    assert.equal(h.calls.signOuts, 0);
    assert.equal(h.auth.token, 'camera-test-token');
    assert.equal(h.app.storage.get('userToken'), 'camera-test-token');
    assert.equal(h.states[0], 'error');
    assert.equal(h.images().length, 1);
    if (status >= 500) assert.match(h.text(), /识别服务暂时不可用.*照片已保留/);
  }
});

test('camera page: a pending analysis prevents duplicate submissions and retakes', async () => {
  let finish;
  const h = cameraPageHarness({ analyze: () => new Promise((resolve) => { finish = resolve; }) });
  const shutter = h.button('拍照并识别食物热量');
  const capture = shutter.props.onPress();
  await shutter.props.onPress();
  assert.equal(h.calls.captures, 1);
  await new Promise(setImmediate);
  assert.equal(h.states[0], 'analyzing');
  const staleRetake = h.button('重新拍摄');
  assert.equal(staleRetake.props.disabled, true);
  staleRetake.props.onPress();
  assert.equal(h.camera.lastPhoto, h.picture);
  assert.equal(h.calls.analyses.length, 1);
  finish({ calories: 210, title: '米饭', summary: '已识别', raw: {} });
  await capture;
  assert.equal(h.states[0], 'success');
});

test('auth provider: logout clears the in-memory session even when storage deletion fails', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({ token: 'new-token', user: { id: 'test-user', username: 'tester' } }));
  const h = authHarness({ '@react-native-async-storage/async-storage': {
    getItem: async () => null, setItem: async () => {},
    removeItem: async () => { throw new Error('storage failure'); },
  } });
  await h.render().signIn({ username: 'tester', password: 'password123' });
  assert.equal(h.render().isAuthenticated, true);
  await assert.rejects(h.render().signOut(), /storage failure/);
  assert.equal(h.render().token, null);
  assert.equal(h.render().isAuthenticated, false);
});

function treeText(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node || typeof node !== 'object') return '';
  return React.Children.toArray(node.props?.children).map(treeText).join(' ');
}

function treeNodes(node, predicate) {
  if (!node || typeof node !== 'object') return [];
  return [...(predicate(node) ? [node] : []),
    ...React.Children.toArray(node.props?.children).flatMap((child) => treeNodes(child, predicate))];
}

test('training controls: edits, completion, new groups and overview persist together', async () => {
  const h = fitnessHarness();
  const api = h.app.load('services/fitness-plan.ts');
  await api.storeFitnessPlan(api.extractFitnessPlan(plan), 'user-a');
  h.render(); await h.settle();
  const card = h.cards()[0];
  const setId = card.props.exercise.sets[2].id;
  card.props.onUpdateSet(setId, 'kg', '32.5');
  card.props.onUpdateSet(setId, 'reps', '12');
  card.props.onToggleSet(setId);
  card.props.onAddSet();
  const restored = await api.getStoredFitnessPlan('user-a');
  assert.equal(restored.exercises[0].sets.length, 4);
  assert.deepEqual(restored.exercises[0].sets[3], {
    ...restored.exercises[0].sets[3], kg: '32.5', reps: '12', completed: false, setNumber: 4,
  });
  assert.equal(restored.exercises[0].sets[2].completed, true);
  assert.equal(new Set(restored.exercises[0].sets.map((set) => set.id)).size, 4);
  h.render();
  assert.match(treeText(h.tree()), /1 动作数 4 总组数 1 已完成/);
  h.cards()[0].props.onToggleSet(setId);
  assert.equal((await api.getStoredFitnessPlan('user-a')).exercises[0].sets[2].completed, false);
  h.unmount();
});

test('training controls: invalid numeric edits leave the last valid persisted value and explain why', async () => {
  const h = fitnessHarness();
  const api = h.app.load('services/fitness-plan.ts');
  await api.storeFitnessPlan(api.extractFitnessPlan(plan), 'user-a');
  h.render(); await h.settle();
  const card = h.cards()[0]; const setId = card.props.exercise.sets[0].id;
  for (const [field, valid, invalidValues] of [
    ['kg', '0', ['-1', 'NaN', 'Infinity', 'abc', '1e309']],
    ['reps', '10', ['-1', '0', '1.5', 'abc', '9007199254740992']],
  ]) {
    card.props.onUpdateSet(setId, field, valid);
    await api.getStoredFitnessPlan('user-a');
    for (const invalid of invalidValues) {
      card.props.onUpdateSet(setId, field, invalid);
      h.render();
      assert.match(treeText(h.tree()), field === 'kg' ? /重量/ : /次数/);
      assert.equal((await api.getStoredFitnessPlan('user-a')).exercises[0].sets[0][field], valid);
    }
    card.props.onUpdateSet(setId, field, '');
    assert.equal((await api.getStoredFitnessPlan('user-a')).exercises[0].sets[0][field], '');
  }
  h.unmount();
});

test('training storage: queued older snapshots must not reset the visible newer edit', async () => {
  const stored = new Map(); let release, began;
  let delay = false;
  const started = new Promise((resolve) => { began = resolve; });
  const h = fitnessHarness({ userId: 'user-a' }, {
    getItem: async (key) => stored.get(key) ?? null,
    setItem: async (key, value) => {
      if (delay) { delay = false; began(); await new Promise((resolve) => { release = resolve; }); }
      stored.set(key, value);
    }, removeItem: async (key) => { stored.delete(key); },
  });
  const api = h.app.load('services/fitness-plan.ts');
  await api.storeFitnessPlan(api.extractFitnessPlan(plan), 'user-a');
  h.render(); await h.settle(); delay = true;
  const card = h.cards()[0], setId = card.props.exercise.sets[0].id;
  card.props.onUpdateSet(setId, 'kg', '20'); await started;
  card.props.onUpdateSet(setId, 'kg', '30');
  const observed = [];
  const unsubscribe = api.subscribeToFitnessPlan('user-a', (next) => observed.push(next.exercises[0].sets[0].kg));
  release(); await api.getStoredFitnessPlan('user-a');
  assert.deepEqual(observed, ['30']);
  h.render(); assert.equal(h.cards()[0].props.exercise.sets[0].kg, '30');
  unsubscribe(); h.unmount();
});

test('training storage: malformed completion, set numbering and dates cannot corrupt overview', async () => {
  const app = loadApp(), api = app.load('services/fitness-plan.ts');
  const saved = api.extractFitnessPlan(plan);
  saved.exercises[0].sets[0].completed = 'false';
  saved.exercises[0].sets[0].setNumber = -3;
  saved.updatedAt = 1e30;
  app.storage.set('fitnessPlan:user-a', JSON.stringify(saved));
  const restored = await api.getStoredFitnessPlan('user-a');
  assert.equal(restored.exercises[0].sets[0].completed, false);
  assert.equal(restored.exercises[0].sets[0].setNumber, 1);
  assert.ok(Number.isFinite(new Date(restored.updatedAt).getTime()));
});

test('training parsing: invalid or oversized group counts use a safe editable default', () => {
  const api = loadApp().load('services/fitness-plan.ts');
  for (const sets of [-1, 0, 2.5, NaN, Infinity, 1000000]) {
    const result = api.extractFitnessPlan({ exercises: [{ name: 'Squat', sets }] });
    assert.equal(result.exercises[0].sets.length, 1);
  }
});

test('training empty state: signed-in and anonymous pages give the appropriate next step', async () => {
  const h = fitnessHarness();
  h.render(); await h.settle();
  assert.match(treeText(h.tree()), /先去聊天页生成训练计划/);
  assert.equal(h.cards().length, 0);
  h.render(null); await h.settle();
  assert.match(treeText(h.tree()), /请先登录查看你的训练计划/);
  assert.equal(h.cards().length, 0);
  h.unmount();
});

test('training card: expand, edit, complete, append and collapse invoke the real controls', () => {
  let expanded = false;
  const app = loadApp({
    react: { ...React, useState: () => [expanded, (next) => { expanded = next(expanded); }] },
    'react-native': { Platform: { OS: 'web', select: (options) => options.web ?? options.default },
      StyleSheet: { create: (styles) => styles },
      ...Object.fromEntries(['Image', 'Pressable', 'Text', 'TextInput', 'View'].map((name) => [name, name])),
    },
  });
  const Card = app.load('components/fitness-exercise-card.tsx').FitnessExerciseCard;
  const exercise = app.load('services/fitness-plan.ts').extractFitnessPlan(plan).exercises[0];
  const calls = [];
  const render = () => Card({ exercise,
    onAddSet: () => calls.push(['add']), onToggleSet: (id) => calls.push(['toggle', id]),
    onUpdateSet: (...args) => calls.push(['edit', ...args]),
  });
  assert.equal(treeNodes(render(), (n) => n.type === 'TextInput').length, 0);
  treeNodes(render(), (n) => n.type === 'Pressable')[0].props.onPress();
  assert.match(treeText(render()), /收起详情/);
  const inputs = treeNodes(render(), (n) => n.type === 'TextInput');
  assert.equal(inputs.length, 6);
  inputs[0].props.onChangeText('22.5'); inputs[1].props.onChangeText('8');
  const checkbox = treeNodes(render(), (n) => n.props.accessibilityRole === 'checkbox')[0];
  assert.equal(checkbox.props.accessibilityState.checked, false); checkbox.props.onPress();
  treeNodes(render(), (n) => n.type === 'Pressable').at(-1).props.onPress();
  assert.deepEqual(calls, [['edit', exercise.sets[0].id, 'kg', '22.5'],
    ['edit', exercise.sets[0].id, 'reps', '8'], ['toggle', exercise.sets[0].id], ['add']]);
  treeNodes(render(), (n) => n.type === 'Pressable')[0].props.onPress();
  assert.equal(treeNodes(render(), (n) => n.type === 'TextInput').length, 0);
});

test('navigation: four visible tabs honor focus, prevented presses and long presses', () => {
  const Native = (props) => React.createElement('div', props);
  const app = loadApp({
    'react-native-reanimated': { default: { View: Native, Text: Native },
      useAnimatedStyle: (fn) => fn(), withTiming: (value) => value, withSpring: (value) => value },
  });
  const Tab = app.load('components/CustomBottomTab.tsx').default;
  const calls = []; let prevent = false;
  const routes = ['camera', 'chat', 'fitness', 'profile', 'workout'].map((name) => ({ name, key: name }));
  const tree = Tab({ state: { routes, index: 0 }, descriptors: {}, insets: { bottom: 0 }, navigation: {
    emit: (event) => { calls.push(event); return { defaultPrevented: prevent }; },
    navigate: (name) => { calls.push({ navigate: name }); },
  } });
  const buttons = treeNodes(tree, (node) => typeof node.type === 'function' && node.props.label);
  assert.deepEqual(buttons.map((button) => button.props.label), ['拍照', '聊天', '训练', '我的']);
  buttons[0].props.onPress(); assert.equal(calls.length, 1);
  buttons[2].props.onPress(); assert.deepEqual(calls.at(-1), { navigate: 'fitness' });
  prevent = true; const count = calls.length;
  buttons[3].props.onPress(); assert.equal(calls.length, count + 1);
  buttons[1].props.onLongPress();
  assert.deepEqual(calls.at(-1), { type: 'tabLongPress', target: 'chat' });
  const rendered = buttons[0].type(buttons[0].props);
  assert.equal(rendered.props.accessibilityLabel, '拍照');
  assert.deepEqual(rendered.props.accessibilityState, { selected: true });
});

test('navigation: root auth wraps tabs, landing opens camera and legacy workout redirects to fitness', () => {
  const Tabs = 'Tabs';
  const app = loadApp({
    'expo-router': { Redirect: 'Redirect', Tabs: Object.assign(() => null, { Screen: 'TabScreen' }),
      Stack: Object.assign(() => null, { Screen: 'StackScreen' }) },
    'expo-status-bar': { StatusBar: 'StatusBar' }, 'react-native-reanimated': {},
    '@/components/CustomBottomTab': { default: Tabs },
    '@/providers/auth-provider': { AuthProvider: 'AuthProvider' },
  });
  const root = app.load('app/_layout.tsx').default();
  assert.equal(root.type, 'AuthProvider');
  const layout = app.load('app/(tabs)/_layout.tsx').default();
  const screens = React.Children.toArray(layout.props.children);
  assert.deepEqual(screens.filter((screen) => screen.props.options.href !== null).map((screen) => screen.props.name),
    ['camera', 'chat', 'fitness', 'profile']);
  assert.equal(screens.find((screen) => screen.props.name === 'workout').props.options.href, null);
  assert.equal(app.load('app/index.tsx').default().props.href, '/(tabs)/camera');
  assert.equal(app.load('app/(tabs)/workout.tsx').default().props.href, '/(tabs)/fitness');
});

test('auth cancellation: logout invalidates a pending login before it can persist or display its result', async (t) => {
  let finish;
  t.mock.method(globalThis, 'fetch', () => new Promise((resolve) => { finish = resolve; }));
  const h = authHarness(); await h.hydrate();
  const pending = h.render().signIn({ username: 'tester', password: 'password123' });
  await h.render().signOut();
  finish(json({ token: 'late-token', user: { id: 'late-user', username: 'tester' } }));
  await pending;
  assert.equal(h.render().isAuthenticated, false);
  assert.equal(h.app.storage.has('userToken'), false);
  assert.equal(h.app.storage.has('userIdentity'), false);
});

test('auth restoration failure: unreadable storage exits hydration and shows actionable feedback', async () => {
  const h = authHarness({ '@react-native-async-storage/async-storage': {
    getItem: async () => { throw new Error('storage unavailable'); },
  } });
  await h.hydrate();
  assert.equal(h.render().isHydrating, false);
  assert.equal(h.render().isAuthenticated, false);
  assert.match(h.render().sessionError, /无法读取.*重新登录/);
});

test('training storage failure: failed edit reports feedback and the last saved plan survives reload', async () => {
  const stored = new Map(); let fail = false;
  const h = fitnessHarness({ userId: 'user-a' }, {
    getItem: async (key) => stored.get(key) ?? null,
    setItem: async (key, value) => { if (fail) throw new Error('训练保存失败'); stored.set(key, value); },
    removeItem: async (key) => { stored.delete(key); },
  });
  const api = h.app.load('services/fitness-plan.ts');
  await api.storeFitnessPlan(api.extractFitnessPlan(plan), 'user-a');
  h.render(); await h.settle(); fail = true;
  const card = h.cards()[0]; card.props.onUpdateSet(card.props.exercise.sets[0].id, 'kg', '35');
  await new Promise(setImmediate); h.render();
  assert.match(treeText(h.tree()), /训练保存失败/);
  assert.equal((await api.getStoredFitnessPlan('user-a')).exercises[0].sets[0].kg, '');
  fail = false; card.props.onUpdateSet(card.props.exercise.sets[0].id, 'kg', '40');
  assert.equal((await api.getStoredFitnessPlan('user-a')).exercises[0].sets[0].kg, '40');
  h.unmount();
});
