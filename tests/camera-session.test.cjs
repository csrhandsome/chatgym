const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { loadApp } = require('./helpers/load-app.cjs');

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const result = (title, calories) => ({ title, calories, summary: title, raw: {} });
const settle = () => new Promise(setImmediate);

// Execute both the real page and the real camera hook. Only the physical
// camera, authentication context, and analysis transport are replaced.
function cameraSessionHarness(options = {}) {
  const states = [];
  const refs = [];
  const analyses = [];
  const signOuts = [];
  let active = true;
  const lifetime = new AbortController();
  let captures = 0;
  let stateCursor = 0;
  let refCursor = 0;
  const auth = {
    isAuthenticated: true, isHydrating: false, token: 'token-a', userId: 'user-a',
    signOut: async (expectedToken) => {
      signOuts.push(expectedToken);
      if (expectedToken && expectedToken !== auth.token) return;
      Object.assign(auth, { isAuthenticated: false, token: null, userId: null });
    },
  };
  const camera = {
    takePictureAsync: async () => {
      const number = ++captures;
      return options.capture
        ? await options.capture(number)
        : { uri: `data:image/jpeg;base64,photo${number}`, width: 640, height: 480 };
    },
  };
  const app = loadApp({
    react: { ...React,
      useState(initial) {
        const index = stateCursor++;
        if (!(index in states)) states[index] = initial;
        return [states[index], (value) => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
      },
      useRef(initial) {
        const index = refCursor++;
        if (!(index in refs)) refs[index] = { current: initial };
        return refs[index];
      },
    },
    '@/hooks/use-auth': { useAuth: () => auth },
    '@/services/calorie-api': { analyzeMealPhoto: async (photo, session) => {
      analyses.push({ photo, session });
      return options.analyze
        ? await options.analyze(analyses.length, app)
        : result('当前账户识别结果', 210);
    } },
    'expo-router': { useRouter: () => ({ navigate: () => {} }) },
    'expo-camera': { CameraView: 'CameraView', useCameraPermissions: () => [{ granted: true }, async () => ({ granted: true })] },
    'expo-image': { Image: 'Image' },
    'react-native': {
      Platform: { OS: 'web', select: (value) => value.web ?? value.default },
      StyleSheet: { create: (value) => value, absoluteFillObject: {} },
      ...Object.fromEntries(['ActivityIndicator', 'Pressable', 'ScrollView', 'Text', 'View'].map((name) => [name, name])),
    },
  });
  const Page = app.load('components/camera/calorie-camera-page.tsx').CalorieCameraPage;
  function render() { stateCursor = 0; refCursor = 0; return Page({ active, signal: lifetime.signal }); }
  function findAll(node, type) {
    if (!node || typeof node !== 'object') return [];
    return [...(node.type === type ? [node] : []),
      ...React.Children.toArray(node.props?.children).flatMap((child) => findAll(child, type))];
  }
  const elements = (type) => findAll(render(), type);
  const button = (name) => elements('Pressable').find((node) => node.props.accessibilityLabel === name ||
    findAll(node, 'Text').some((text) => text.props.children === name));
  const view = elements('CameraView')[0];
  view.props.ref.current = camera;
  view.props.onCameraReady();
  render();
  return {
    app, auth, analyses, signOuts, states, button, elements,
    setActive(value) { active = value; render(); render(); },
    unmount: () => lifetime.abort(),
    ready() {
      const view = elements('CameraView')[0];
      if (view) { view.props.ref.current = camera; view.props.onCameraReady(); render(); }
    },
    captures: () => captures,
    capture: () => button('拍照并识别食物热量').props.onPress(),
    switchAccount(token, userId) {
      Object.assign(auth, { token, userId, isAuthenticated: Boolean(token) });
      render();
      render();
      const view = elements('CameraView')[0];
      if (view) { view.props.ref.current = camera; view.props.onCameraReady(); render(); }
    },
    text: () => elements('Text').map((node) => node.props.children).flat().join(' '),
    photos: () => elements('Image'),
  };
}

test('camera session: account B cannot see account A photo or result', async () => {
  const h = cameraSessionHarness({ analyze: async () => result('账户 A 专属照片结果', 345) });
  await h.capture();
  assert.equal(h.photos().length, 1);
  assert.match(h.text(), /账户 A 专属照片结果/);
  h.switchAccount('token-b', 'user-b');
  assert.equal(h.photos().length, 0);
  assert.doesNotMatch(h.text(), /账户 A 专属照片结果|345/);
  assert.match(h.text(), /--/);
});

test('camera session: old A success and finally cannot overwrite or unlock B analysis', async () => {
  const oldRequest = deferred();
  const newRequest = deferred();
  const h = cameraSessionHarness({ analyze: (number) => number === 1 ? oldRequest.promise : newRequest.promise });
  const captureA = h.capture();
  await settle();
  assert.equal(h.analyses[0].session.token, 'token-a');
  h.switchAccount('token-b', 'user-b');
  assert.equal(h.photos().length, 0);
  const shutterB = h.button('拍照并识别食物热量');
  const captureB = shutterB.props.onPress();
  await settle();
  oldRequest.resolve(result('旧账户 A 结果不应出现', 345));
  await captureA;
  assert.equal(h.analyses[0].session.isCurrent(), false);
  assert.equal(h.analyses[1].session.isCurrent(), true);
  assert.match(h.text(), /正在计算食物的热量/);
  assert.doesNotMatch(h.text(), /旧账户 A/);
  h.button('重新拍摄').props.onPress();
  await shutterB.props.onPress();
  assert.equal(h.photos().length, 1);
  assert.equal(h.captures(), 2, 'A finally must not unlock B for another capture');
  newRequest.resolve(result('账户 B 结果', 220));
  await captureB;
  assert.match(h.text(), /账户 B 结果/);
  assert.match(h.text(), /220/);
});

test('camera session: delayed A 401 cannot sign out B or replace its screen', async () => {
  const pending = deferred();
  const h = cameraSessionHarness({ analyze: () => pending.promise });
  const capture = h.capture();
  await settle();
  h.switchAccount('token-b', 'user-b');
  pending.reject(new (h.app.load('services/backend-api.ts').BackendApiError)('expired old token', 401));
  await capture;
  assert.equal(h.auth.token, 'token-b');
  assert.deepEqual(h.signOuts, []);
  assert.equal(h.photos().length, 0);
  assert.doesNotMatch(h.text(), /登录状态已失效/);
});

for (const [token, userId, description] of [[null, null, 'logout'], ['token-b', 'user-b', 'account B login']]) {
  test(`camera session: ${description} during physical capture discards A photo and prevents upload`, async () => {
    const pending = deferred();
    const h = cameraSessionHarness({ capture: () => pending.promise });
    const capture = h.capture();
    await settle();
    h.switchAccount(token, userId);
    pending.resolve({ uri: 'data:image/jpeg;base64,AA==', width: 640, height: 480 });
    await capture;
    assert.equal(h.photos().length, 0);
    assert.equal(h.analyses.length, 0);
    assert.equal(h.states[2], false, 'Physical camera busy state must finish');
  });
}

test('camera session: original user can re-login after 401 and retry the preserved photo', async () => {
  const h = cameraSessionHarness({ analyze: async (number, app) => {
    if (number === 1) throw new (app.load('services/backend-api.ts').BackendApiError)('expired token', 401);
    return result('重新登录后识别', 230);
  } });
  await h.capture();
  assert.deepEqual(h.signOuts, ['token-a']);
  h.switchAccount(null, null);
  assert.equal(h.photos().length, 1);
  h.switchAccount('fresh-token-a', 'user-a');
  await h.button('重新上传').props.onPress();
  assert.equal(h.captures(), 1);
  assert.equal(h.analyses[1].session.token, 'fresh-token-a');
  assert.match(h.text(), /重新登录后识别/);
});

test('camera session: a stale A shutter handler is ignored after B login', async () => {
  const h = cameraSessionHarness();
  const staleShutter = h.button('拍照并识别食物热量');
  h.switchAccount('token-b', 'user-b');
  await staleShutter.props.onPress();
  assert.equal(h.captures(), 0);
  assert.equal(h.analyses.length, 0);
});

test('camera API: captured credentials remain immutable instead of reading a new account token', async (t) => {
  const app = loadApp();
  app.storage.set('userToken', 'token-b');
  let requested = false;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requested = true;
    assert.equal(init.headers.Authorization, 'Bearer token-a');
    return new Response(JSON.stringify({ results: [] }), { headers: { 'Content-Type': 'application/json' } });
  });
  await app.load('services/calorie-api.ts').analyzeMealPhoto({ uri: 'data:image/jpeg;base64,AA==' }, {
    token: 'token-a', isCurrent: () => true,
  });
  assert.equal(requested, true);
  assert.equal(app.storage.get('userToken'), 'token-b');
});

test('camera API: session change while encoding stops the request before any image upload', async (t) => {
  let requests = 0;
  let current = true;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return new Response('{}'); });
  const api = loadApp().load('services/calorie-api.ts');
  const pending = api.analyzeMealPhoto({ uri: 'data:image/jpeg;base64,AA==' }, {
    token: 'token-a', isCurrent: () => current,
  });
  current = false;
  await assert.rejects(pending, /登录状态已改变/);
  assert.equal(requests, 0);
});

test('camera regression: rapid double shutter takes and uploads only one picture', async () => {
  const pending = deferred();
  const h = cameraSessionHarness({ capture: () => pending.promise });
  const button = h.button('拍照并识别食物热量');
  const first = button.props.onPress();
  await button.props.onPress();
  assert.equal(h.captures(), 1);
  pending.resolve({ uri: 'data:image/jpeg;base64,AA==', width: 640, height: 480 });
  await first;
  assert.equal(h.analyses.length, 1);
});

test('camera regression: lens change is blocked while a physical capture is pending', async () => {
  const pending = deferred();
  const h = cameraSessionHarness({ capture: () => pending.promise });
  const flip = h.button('切换镜头');
  const first = h.capture();
  flip.props.onPress();
  assert.equal(h.elements('CameraView')[0].props.facing, 'back');
  pending.resolve({ uri: 'data:image/jpeg;base64,AA==' });
  await first;
});

test('camera regression: lens remount waits for ready; retake waits for fresh preview', async () => {
  const h = cameraSessionHarness();
  h.button('切换镜头').props.onPress();
  const view = h.elements('CameraView')[0];
  assert.match(view.key, /front$/);
  assert.equal(view.props.mirror, true);
  assert.equal(h.button('拍照并识别食物热量').props.disabled, true);
  h.ready();
  await h.capture();
  h.button('重新拍摄').props.onPress();
  assert.equal(h.photos().length, 0);
  assert.equal(h.button('拍照并识别食物热量').props.disabled, true);
  await h.capture();
  assert.equal(h.captures(), 1, 'No capture until newly mounted preview is ready');
  h.ready();
  await h.capture();
  assert.equal(h.captures(), 2);
});

test('camera regression: missing device mount error is shown and shutter stays disabled', () => {
  const h = cameraSessionHarness();
  h.elements('CameraView')[0].props.onMountError({ message: '' });
  assert.match(h.text(), /无法打开相机.*设备存在/);
  assert.equal(h.button('拍照并识别食物热量').props.disabled, true);
  h.elements('CameraView')[0].props.onCameraReady();
  assert.equal(h.button('拍照并识别食物热量').props.disabled, true, 'An SDK ready callback after mount failure must not enable capture');
});

test('camera regression: leaving during physical capture removes preview and prevents upload', async () => {
  const pending = deferred();
  const h = cameraSessionHarness({ capture: () => pending.promise });
  const first = h.capture();
  h.setActive(false);
  assert.equal(h.elements('CameraView').length, 0);
  pending.resolve({ uri: 'data:image/jpeg;base64,AA==' });
  await first;
  assert.equal(h.analyses.length, 0);
  assert.equal(h.photos().length, 0);
});

test('camera regression: leaving cancels analysis, retains photo and allows retry on return', async () => {
  const pending = deferred();
  const h = cameraSessionHarness({ analyze: (number) => number === 1 ? pending.promise : result('返回后识别', 240) });
  const first = h.capture();
  await settle();
  h.setActive(false);
  assert.equal(h.analyses[0].session.signal.aborted, true);
  assert.equal(h.analyses[0].session.isCurrent(), false);
  assert.equal(h.photos().length, 1);
  pending.resolve(result('离开后的迟到结果', 999));
  await first;
  assert.doesNotMatch(h.text(), /迟到结果|999/);
  h.setActive(true);
  await h.button('重新上传').props.onPress();
  assert.equal(h.captures(), 1);
  assert.match(h.text(), /返回后识别/);
});

test('camera regression: route disposal aborts transport and late 401 cannot sign out', async () => {
  const pending = deferred();
  const h = cameraSessionHarness({ analyze: () => pending.promise });
  const first = h.capture();
  await settle();
  h.unmount();
  assert.equal(h.analyses[0].session.signal.aborted, true);
  pending.reject(new (h.app.load('services/backend-api.ts').BackendApiError)('expired', 401));
  await first;
  assert.deepEqual(h.signOuts, []);
});

test('camera regression: repeated retry presses share one analysis', async () => {
  const pending = deferred();
  const h = cameraSessionHarness({ analyze: (number) => {
    if (number === 1) throw new Error('识别失败');
    return pending.promise;
  } });
  await h.capture();
  const retry = h.button('重新上传');
  const first = retry.props.onPress();
  await retry.props.onPress();
  assert.equal(h.analyses.length, 2);
  pending.resolve(result('重试成功', 230));
  await first;
  assert.equal(h.captures(), 1);
});

test('camera regression: a rejected permission API is handled without an unhandled rejection', async () => {
  const states = [];
  const app = loadApp({
    react: { ...React, useRef: () => ({ current: null }), useState: (initial) => {
      const index = states.push(initial) - 1;
      return [initial, (next) => { states[index] = next; }];
    } },
    'expo-camera': { useCameraPermissions: () => [{ granted: false }, async () => { throw new Error('permission unavailable'); }] },
  });
  assert.equal(await app.load('hooks/use-camera.ts').useCamera().requestPermission(), false);
  assert.ok(states.some(value => typeof value === 'string' && /无法申请相机权限/.test(value)));
});
