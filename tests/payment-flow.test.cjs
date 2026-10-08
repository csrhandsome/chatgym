const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/load-app.cjs');

const order = (id = 'order-1', status = 'pending', packageId = 'pack-10') => ({
  id, packageId, credits: 10, amountFen: 100, currency: 'CNY', status,
  createdAt: '2026-10-08T00:00:00.000Z',
});
const preparation = (orderId = 'order-1') => ({ orderId, params: {
  appId: 'wxabc123', partnerId: 'partner', prepayId: orderId,
  nonceStr: 'nonce', timeStamp: 1, sign: 'signature', package: 'Sign=WXPay',
} });

function flowApi(overrides = {}) {
  return {
    listPackages: async () => [{ id: 'pack-10', title: '10 次', credits: 10, amountFen: 100, currency: 'CNY' }],
    getBalance: async () => ({ remaining: 0 }),
    createOrder: async () => order(),
    prepareWechat: async (_token, id) => preparation(id),
    getOrder: async (_token, id) => order(id),
    ...overrides,
  };
}

function loadPaymentClient(env = {}, platform = 'web') {
  return loadApp({ 'react-native': { Platform: { OS: platform, select: (items) => items[platform] ?? items.default } } }, env)
    .load('services/payment-client.ts');
}

test('payment mock: successful purchase credits once, including repeated confirmations', async () => {
  const client = loadPaymentClient({ EXPO_PUBLIC_PAYMENT_MODE: 'mock' }).createPaymentClient();
  assert.equal(client.mode, 'mock');

  const result = await client.purchase('token-a', 'demo-10');
  assert.equal(result.outcome, 'paid');
  assert.equal((await client.api.getBalance('token-a')).remaining, 10);
  assert.equal((await client.confirm('token-a', result.order.id)).outcome, 'paid');
  assert.equal((await client.api.getBalance('token-a')).remaining, 10);
});

for (const scenario of ['cancelled', 'failed']) {
  test(`payment mock: ${scenario} does not credit any AI uses`, async () => {
    const client = loadPaymentClient({ EXPO_PUBLIC_PAYMENT_MODE: 'mock' }).createPaymentClient();
    client.setMockScenario(scenario);
    const result = await client.purchase('token-a', 'demo-10');
    assert.equal(result.outcome, scenario);
    assert.equal(result.order.status, scenario === 'cancelled' ? 'closed' : 'failed');
    assert.equal((await client.api.getBalance('token-a')).remaining, 0);
  });
}

test('payment mock: pending order is credited on a later confirmation only once', async () => {
  const client = loadPaymentClient({ EXPO_PUBLIC_PAYMENT_MODE: 'mock' }).createPaymentClient();
  client.setMockScenario('pending');
  const first = await client.purchase('token-a', 'demo-10');
  assert.equal(first.outcome, 'pending');
  assert.equal((await client.api.getBalance('token-a')).remaining, 0);

  const confirmed = await client.confirm('token-a', first.order.id);
  assert.equal(confirmed.outcome, 'paid');
  assert.equal((await client.api.getBalance('token-a')).remaining, 10);
  await client.confirm('token-a', first.order.id);
  assert.equal((await client.api.getBalance('token-a')).remaining, 10);
});

test('payment mock: orders and balances are isolated by bearer token', async () => {
  const client = loadPaymentClient({ EXPO_PUBLIC_PAYMENT_MODE: 'mock' }).createPaymentClient();
  const result = await client.purchase('token-a', 'demo-10');
  await assert.rejects(client.confirm('token-b', result.order.id), /未找到当前账户的订单/);
  assert.equal((await client.api.getBalance('token-a')).remaining, 10);
  assert.equal((await client.api.getBalance('token-b')).remaining, 0);
});

test('payment mode: mock is unavailable in production and live WeChat is unavailable on iOS', async () => {
  const production = loadPaymentClient({ NODE_ENV: 'production', EXPO_PUBLIC_PAYMENT_MODE: 'mock' });
  assert.equal(production.isPaymentDevelopment(), false);
  assert.equal(production.getPaymentMode(), 'disabled');
  assert.equal(production.createPaymentClient('mock').mode, 'disabled');
  await assert.rejects(production.createPaymentClient('mock').purchase('token-a', 'demo-10'), /尚未开放/);

  const ios = loadPaymentClient({ EXPO_PUBLIC_PAYMENT_MODE: 'wechat' }, 'ios');
  assert.equal(ios.getPaymentMode(), 'disabled');
  assert.equal(ios.createPaymentClient('wechat').mode, 'disabled');
  await assert.rejects(ios.createPaymentClient('wechat').purchase('token-a', 'pack-10'), /尚未开放/);
});

test('payment flow: concurrent purchase taps create only one order', async () => {
  let releaseAvailability;
  let startedAvailability;
  const availabilityStarted = new Promise((resolve) => { startedAvailability = resolve; });
  const api = flowApi({ createOrder: async () => order('created', 'paid') });
  let createCalls = 0;
  api.createOrder = async (...args) => { createCalls++; return order('created', 'paid'); };
  const provider = {
    checkAvailability: async () => { startedAvailability(); await new Promise((resolve) => { releaseAvailability = resolve; }); },
    launch: async () => 'sent',
  };
  const client = loadApp().load('services/payment-client.ts').createPaymentFlow(api, provider, 'wechat', 0);
  const first = client.purchase('token-a', 'pack-10');
  await availabilityStarted;
  await assert.rejects(client.purchase('token-a', 'pack-10'), /请勿重复点击/);
  releaseAvailability();
  assert.equal((await first).outcome, 'paid');
  assert.equal(createCalls, 1);
});

test('payment flow: native SDK sent result stays pending until backend confirms paid', async () => {
  let queries = 0;
  const api = flowApi({ getOrder: async (_token, id) => { queries++; return order(id); } });
  const provider = { checkAvailability: async () => {}, launch: async () => 'sent' };
  const client = loadApp().load('services/payment-client.ts').createPaymentFlow(api, provider, 'wechat', 0);
  const result = await client.purchase('token-a', 'pack-10');
  assert.equal(result.outcome, 'pending');
  assert.equal(result.order.status, 'pending');
  assert.equal(queries, 2);
});

for (const sdkOutcome of ['cancelled', 'failed']) {
  test(`payment flow: backend paid status wins over SDK ${sdkOutcome} event`, async () => {
    let queries = 0;
    const api = flowApi({ getOrder: async (_token, id) => { queries++; return order(id, 'paid'); } });
    const provider = { checkAvailability: async () => {}, launch: async () => sdkOutcome };
    const client = loadApp().load('services/payment-client.ts').createPaymentFlow(api, provider, 'wechat', 0);
    const result = await client.purchase('token-a', 'pack-10');
    assert.equal(result.outcome, 'paid');
    assert.equal(result.order.status, 'paid');
    assert.equal(queries, 1);
  });
}

test('payment flow: native SDK availability is checked before creating an order', async () => {
  const calls = [];
  const api = flowApi({ createOrder: async () => { calls.push('createOrder'); return order(); } });
  const provider = {
    checkAvailability: async () => { calls.push('checkAvailability'); throw new Error('微信未安装'); },
    launch: async () => 'sent',
  };
  const client = loadApp().load('services/payment-client.ts').createPaymentFlow(api, provider, 'wechat', 0);
  await assert.rejects(client.purchase('token-a', 'pack-10'), /微信未安装/);
  assert.deepEqual(calls, ['checkAvailability']);
});

test('payment flow: network failure retries with the same idempotency key', async () => {
  const keys = [];
  let attempts = 0;
  const api = flowApi({ createOrder: async (_token, input) => {
    keys.push({ ...input });
    if (++attempts === 1) throw new Error('network disconnected');
    return order('already-created', 'paid');
  } });
  const provider = { checkAvailability: async () => {}, launch: async () => 'sent' };
  const client = loadApp().load('services/payment-client.ts').createPaymentFlow(api, provider, 'wechat', 0);
  await assert.rejects(client.purchase('token-a', 'pack-10'), /network disconnected/);
  assert.equal((await client.purchase('token-a', 'pack-10')).outcome, 'paid');
  assert.equal(keys.length, 2);
  assert.equal(keys[0].idempotencyKey, keys[1].idempotencyKey);
  assert.equal(keys[0].packageId, 'pack-10');
});

test('payment flow: abort before order creation stops the flow', async () => {
  let releaseAvailability;
  let start;
  const started = new Promise((resolve) => { start = resolve; });
  let orderCalls = 0;
  const api = flowApi({ createOrder: async () => { orderCalls++; return order(); } });
  const provider = {
    checkAvailability: async () => { start(); await new Promise((resolve) => { releaseAvailability = resolve; }); },
    launch: async () => 'sent',
  };
  const client = loadApp().load('services/payment-client.ts').createPaymentFlow(api, provider, 'wechat', 0);
  const controller = new AbortController();
  const pending = client.purchase('token-a', 'pack-10', { signal: controller.signal });
  await started;
  controller.abort();
  releaseAvailability();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(orderCalls, 0);
});

test('payment flow: package and order ID mismatches are rejected', async () => {
  const provider = { checkAvailability: async () => {}, launch: async () => 'sent' };
  const wrongPackage = loadApp().load('services/payment-client.ts').createPaymentFlow(
    flowApi({ createOrder: async () => order('order-1', 'pending', 'other-package') }), provider, 'wechat', 0,
  );
  await assert.rejects(wrongPackage.purchase('token-a', 'pack-10'), /与所选次数包不匹配/);

  const wrongOrder = loadApp().load('services/payment-client.ts').createPaymentFlow(
    flowApi({ getOrder: async () => order('different-order', 'paid') }), provider, 'wechat', 0,
  );
  await assert.rejects(wrongOrder.confirm('token-a', 'order-1'), /与当前订单不匹配/);

  const wrongPreparation = loadApp().load('services/payment-client.ts').createPaymentFlow(
    flowApi({ prepareWechat: async () => preparation('different-order') }), provider, 'wechat', 0,
  );
  await assert.rejects(wrongPreparation.purchase('token-a', 'pack-10'), /与当前订单不匹配/);
});

test('payment flow: resuming a pending order checks and launches that order without creating another', async () => {
  let creates = 0;
  const queried = [], prepared = [], notified = [];
  let launches = 0;
  const api = flowApi({
    createOrder: async () => { creates++; return order(); },
    getOrder: async (_token, id) => {
      queried.push(id);
      return order(id, queried.length === 1 ? 'pending' : 'paid');
    },
    prepareWechat: async (_token, id) => { prepared.push(id); return preparation(id); },
  });
  const provider = {
    checkAvailability: async () => {},
    launch: async (params) => { launches++; assert.equal(params.orderId, 'order-existing'); return 'sent'; },
  };
  const client = loadApp().load('services/payment-client.ts').createPaymentFlow(api, provider, 'wechat', 0);
  const result = await client.resume('token-a', 'order-existing', { onOrder: async (next) => notified.push(next.id) });
  assert.equal(result.outcome, 'paid');
  assert.equal(result.order.id, 'order-existing');
  assert.equal(creates, 0);
  assert.deepEqual(queried, ['order-existing', 'order-existing']);
  assert.deepEqual(prepared, ['order-existing']);
  assert.equal(launches, 1);
  assert.deepEqual(notified, ['order-existing', 'order-existing']);
});

test('payment order storage: pending orders restore only for their owning user', async () => {
  const app = loadApp();
  const storage = app.load('services/payment-order-storage.ts');
  await storage.savePendingPaymentOrder('user/a', 'wechat', order('user-a-order'));

  assert.deepEqual(await storage.loadPendingPaymentOrder('user/a'), {
    mode: 'wechat', order: order('user-a-order'),
  });
  assert.equal(await storage.loadPendingPaymentOrder('user-b'), null);
  await storage.clearPendingPaymentOrder('user/a', 'different-order');
  assert.equal((await storage.loadPendingPaymentOrder('user/a')).order.id, 'user-a-order');
  await storage.clearPendingPaymentOrder('user/a', 'user-a-order');
  assert.equal(await storage.loadPendingPaymentOrder('user/a'), null);
});

test('payment order storage: malformed records are retained as errors and completed orders are not restored', async () => {
  const app = loadApp();
  const storage = app.load('services/payment-order-storage.ts');
  const key = 'chatgym.payment.pending.v1:user-a';
  app.storage.set(key, '{broken');
  await assert.rejects(storage.loadPendingPaymentOrder('user-a'), /本地待支付订单记录异常/);

  app.storage.set(key, JSON.stringify({ mode: 'wechat', order: order('paid-order', 'paid') }));
  assert.equal(await storage.loadPendingPaymentOrder('user-a'), null);
  assert.equal(app.storage.has(key), false);
});

test('payment order storage: storage errors propagate and mock mode is never persisted', async () => {
  const app = loadApp({ '@react-native-async-storage/async-storage': {
    getItem: async () => { throw new Error('read failed'); },
    setItem: async () => { throw new Error('write failed'); },
    removeItem: async () => {},
  } });
  const storage = app.load('services/payment-order-storage.ts');
  await assert.rejects(storage.loadPendingPaymentOrder('user-a'), /read failed/);
  await assert.rejects(storage.savePendingPaymentOrder('user-a', 'wechat', order()), /write failed/);
  await storage.savePendingPaymentOrder('user-a', 'mock', order());
});

test('native WeChat adapter: pay returning true alone is not payment confirmation', async () => {
  const listeners = new Set();
  let payCalls = 0;
  let subscriptionRemovals = 0;
  const sdk = {
    registerApp: async () => true,
    isWXAppInstalled: async () => true,
    addListener: (_event, callback) => {
      listeners.add(callback);
      return { remove() { subscriptionRemovals++; listeners.delete(callback); } };
    },
    pay: async () => { payCalls++; return true; },
  };
  const app = loadApp({
    'react-native': { Platform: { OS: 'android' } },
    'expo-constants': { executionEnvironment: 'standalone' },
  }, { EXPO_PUBLIC_WECHAT_APP_ID: 'wxabc123' });
  const { createWechatPaymentProvider } = app.load('services/payment-wechat.ts');
  const provider = createWechatPaymentProvider(() => sdk);
  await provider.checkAvailability();
  const controller = new AbortController();
  let finished = false;
  const launched = provider.launch(preparation(), controller.signal).then((value) => { finished = true; return value; });
  await new Promise(setImmediate);
  assert.equal(payCalls, 1);
  assert.equal(finished, false, 'native pay() acceptance alone must wait for the payment-result event');
  assert.equal(listeners.size, 1);
  for (const listener of listeners) listener({ prepayId: 'order-1', errorCode: -1 });
  assert.equal(await launched, 'failed');
  assert.equal(subscriptionRemovals, 1);
  assert.equal(listeners.size, 0);
});

test('native WeChat adapter: cancel event unsubscribes and releases the native payment lock', async () => {
  const listeners = new Set();
  const removals = [];
  const sdk = {
    registerApp: async () => true,
    isWXAppInstalled: async () => true,
    addListener: (_event, callback) => {
      listeners.add(callback);
      const subscription = { remove() { removals.push('removed'); listeners.delete(callback); } };
      return subscription;
    },
    pay: async () => true,
  };
  const app = loadApp({
    'react-native': { Platform: { OS: 'android' } },
    'expo-constants': { executionEnvironment: 'standalone' },
  }, { EXPO_PUBLIC_WECHAT_APP_ID: 'wxabc123' });
  const provider = app.load('services/payment-wechat.ts').createWechatPaymentProvider(() => sdk);
  await provider.checkAvailability();
  const first = provider.launch(preparation(), new AbortController().signal);
  await new Promise(setImmediate);
  for (const listener of listeners) listener({ prepayId: 'wrong-prepay', errorCode: 0 });
  assert.equal(listeners.size, 1, 'an unrelated order event is ignored');
  for (const listener of listeners) listener({ prepayId: 'order-1', errorCode: -2 });
  assert.equal(await first, 'cancelled');
  assert.deepEqual(removals, ['removed']);
  assert.equal(listeners.size, 0);

  const second = provider.launch(preparation('order-2'), new AbortController().signal);
  await new Promise(setImmediate);
  const activeListener = [...listeners][0];
  activeListener({ prepayId: 'order-2', errorCode: 0 });
  assert.equal(await second, 'sent');
  assert.deepEqual(removals, ['removed', 'removed']);
  assert.equal(listeners.size, 0);
});

test('native WeChat adapter: abort cancels the pending native listener and unlocks later payments', async () => {
  const listeners = new Set();
  let removals = 0;
  const sdk = {
    registerApp: async () => true,
    isWXAppInstalled: async () => true,
    addListener: (_event, callback) => {
      listeners.add(callback);
      return { remove() { removals++; listeners.delete(callback); } };
    },
    pay: async () => true,
  };
  const app = loadApp({
    'react-native': { Platform: { OS: 'android' } },
    'expo-constants': { executionEnvironment: 'standalone' },
  }, { EXPO_PUBLIC_WECHAT_APP_ID: 'wxabc123' });
  const provider = app.load('services/payment-wechat.ts').createWechatPaymentProvider(() => sdk);
  await provider.checkAvailability();
  const controller = new AbortController();
  const pending = provider.launch(preparation(), controller.signal);
  await new Promise(setImmediate);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(removals, 1);
  assert.equal(listeners.size, 0);
  const next = provider.launch(preparation('order-2'), new AbortController().signal);
  await new Promise(setImmediate);
  [...listeners][0]({ prepayId: 'order-2', errorCode: 0 });
  assert.equal(await next, 'sent');
});
