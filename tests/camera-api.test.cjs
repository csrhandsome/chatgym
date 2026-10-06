const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const { loadApp } = require('./helpers/load-app.cjs');
const React = require('react');
const settle = () => new Promise(setImmediate);
const photo = { uri: 'data:image/jpeg;base64,AA==' };
const session = (extra = {}) => ({ token: 'camera-token', isCurrent: () => true, ...extra });
const payload = (low = 180, high = 240) => ({ summary: '餐食估算', results: [{ foodAnalysis: {
  totalCaloriesLow: low, totalCaloriesHigh: high, items: [{ name: '米饭' }],
} }] });
const response = (body) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

test('camera API regression: 60s deadline aborts actual upload and a fresh retry succeeds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  let signal;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    if (++calls > 1) return response(payload());
    signal = init.signal;
    return await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  const api = loadApp().load('services/calorie-api.ts');
  const pending = api.analyzeMealPhoto(photo, session());
  const assertion = assert.rejects(pending, /识别超时.*重新上传/);
  await settle();
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(60_000);
  await assertion;
  assert.equal(signal.aborted, true);
  assert.equal((await api.analyzeMealPhoto(photo, session())).calories, 210);
  assert.equal(calls, 2);
});

test('camera API regression: screen cancellation aborts an in-flight fetch', async (t) => {
  const lifetime = new AbortController();
  let signal;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    signal = init.signal;
    return await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  const pending = loadApp().load('services/calorie-api.ts').analyzeMealPhoto(photo, session({ signal: lifetime.signal }));
  const assertion = assert.rejects(pending, /识别已取消/);
  await settle();
  lifetime.abort();
  await assertion;
  assert.equal(signal.aborted, true);
});

test('camera API regression: an already disposed screen never reads or uploads the picture', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response(payload()); });
  const lifetime = new AbortController();
  lifetime.abort();
  await assert.rejects(loadApp().load('services/calorie-api.ts').analyzeMealPhoto(
    { uri: 'file:///private-camera.jpg' }, session({ signal: lifetime.signal })
  ), /取消/);
  assert.equal(calls, 0);
});

test('camera API regression: native photo bytes are encoded without losing MIME or credentials', async (t) => {
  const jpeg = Uint8Array.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 255, 217]);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (++calls === 1) {
      assert.equal(url, 'file:///meal.jpg');
      assert.ok(init.signal instanceof AbortSignal);
      return new Response(jpeg, { headers: { 'Content-Type': 'image/jpeg' } });
    }
    assert.equal(init.headers.Authorization, 'Bearer camera-token');
    const body = JSON.parse(init.body);
    assert.equal(body.images[0].image, `data:image/jpeg;base64,${Buffer.from(jpeg).toString('base64')}`);
    assert.equal(body.preferredTask, 'food_calorie_estimate');
    return response(payload());
  });
  const api = loadApp({ 'react-native': { Platform: { OS: 'android' } } }).load('services/calorie-api.ts');
  assert.equal((await api.analyzeMealPhoto({ uri: 'file:///meal.jpg' }, session())).calories, 210);
  assert.equal(calls, 2);
});

test('camera API regression: a failed local image read prevents the POST upload', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('missing', { status: 404 }); });
  await assert.rejects(loadApp().load('services/calorie-api.ts').analyzeMealPhoto({ uri: 'blob:missing' }, session()), /图片读取失败/);
  assert.equal(calls, 1);
});

test('camera API regression: invalid inline image is never submitted', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response(payload()); });
  for (const uri of ['data:text/html;base64,AA==', 'data:image/jpeg;base64,', 'data:image/jpeg;base64,!!!']) {
    await assert.rejects(loadApp().load('services/calorie-api.ts').analyzeMealPhoto({ uri }, session()), /照片格式无效/);
  }
  assert.equal(calls, 0);
});

test('camera API regression: empty or non-image blobs are never uploaded', async (t) => {
  for (const image of [new Blob([], { type: 'image/jpeg' }), new Blob(['html'], { type: 'text/html' })]) {
    let calls = 0;
    const stub = t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(image); });
    await assert.rejects(loadApp().load('services/calorie-api.ts').analyzeMealPhoto({ uri: 'blob:bad' }, session()), /照片为空或格式无效/);
    assert.equal(calls, 1);
    stub.mock.restore();
  }
});

test('camera API regression: blank, negative and invalid calorie fields never become invented zeroes', async (t) => {
  for (const [low, high] of [[' ', ''], [-20, -10], ['invalid', null]]) {
    const stub = t.mock.method(globalThis, 'fetch', async () => response(payload(low, high)));
    const result = await loadApp().load('services/calorie-api.ts').analyzeMealPhoto(photo, session());
    assert.equal(result.calories, null);
    stub.mock.restore();
  }
});

test('camera API regression: zero and a single valid estimate remain valid', async (t) => {
  for (const [low, high, expected] of [[0, 0, 0], [null, '240', 240], ['180', null, 180]]) {
    const stub = t.mock.method(globalThis, 'fetch', async () => response(payload(low, high)));
    assert.equal((await loadApp().load('services/calorie-api.ts').analyzeMealPhoto(photo, session())).calories, expected);
    stub.mock.restore();
  }
});

test('camera API regression: non-food response omits technical task label and calorie result', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => response({ task: 'movement_form_feedback', summary: '这不是食物', results: [] }));
  const result = await loadApp().load('services/calorie-api.ts').analyzeMealPhoto(photo, session());
  assert.equal(result.calories, null);
  assert.equal(result.title, null);
  assert.equal(result.summary, '这不是食物');
});

test('camera API regression: malformed successful responses show a retryable failure', async (t) => {
  for (const body of ['<html>gateway</html>', 'null', '{}', '[]']) {
    const stub = t.mock.method(globalThis, 'fetch', async () => new Response(body));
    await assert.rejects(loadApp().load('services/calorie-api.ts').analyzeMealPhoto(photo, session()), /识别响应.*格式异常/);
    stub.mock.restore();
  }
});

test('camera API regression: streaming UTF-8 final payload is parsed across single-byte chunks', async (t) => {
  const bytes = new TextEncoder().encode(`event: final\r\ndata: ${JSON.stringify({ type: 'final', output: payload() })}\r\n\r\n`);
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } }));
  const result = await loadApp().load('services/calorie-api.ts').analyzeMealPhoto(photo, session());
  assert.equal(result.calories, 210);
  assert.equal(result.title, '米饭');
});

test('camera API regression: partial SSE without final output is rejected', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('event: thinking\ndata: {"type":"thinking","summary":"分析中"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
  await assert.rejects(loadApp().load('services/calorie-api.ts').analyzeMealPhoto(photo, session()), /响应中断/);
});

test('camera API regression: timeout cancels a stalled SSE body reader', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } }));
  const pending = loadApp().load('services/calorie-api.ts').analyzeMealPhoto(photo, session());
  const assertion = assert.rejects(pending, /识别超时/);
  await settle();
  t.mock.timers.tick(60_000);
  await assertion;
  await settle();
  assert.equal(cancelled, true);
});

test('camera route regression: focus lifetime is replaced on return and aborted on blur', () => {
  let signal;
  let focus;
  let focused = true;
  const app = loadApp({
    react: { ...React, useCallback: callback => callback,
      useState: () => [signal, value => { signal = value; }] },
    '@react-navigation/native': { useIsFocused: () => focused },
    'expo-router': { useFocusEffect: callback => { focus = callback; } },
    '@/components/camera/calorie-camera-page': { CalorieCameraPage: 'CameraPage' },
  });
  const Screen = app.load('app/(tabs)/camera.tsx').default;
  assert.equal(Screen().props.active, false);
  const cleanup = focus();
  assert.equal(Screen().props.active, true);
  const first = signal;
  cleanup();
  focused = false;
  assert.equal(first.aborted, true);
  assert.equal(Screen().props.active, false);
  focused = true;
  focus();
  assert.notEqual(signal, first);
  assert.equal(Screen().props.active, true);
});
