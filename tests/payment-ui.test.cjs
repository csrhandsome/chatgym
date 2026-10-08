const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { loadApp } = require('./helpers/load-app.cjs');

const packages = [
  { id: 'pack-10', title: '10 次体验包', credits: 10, amountFen: 100, currency: 'CNY' },
];
const pendingOrder = {
  id: 'pending-1', packageId: 'pack-10', credits: 10, amountFen: 100, currency: 'CNY',
  status: 'pending', createdAt: '2026-10-08T00:00:00.000Z',
};
const paidOrder = { ...pendingOrder, status: 'paid' };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const sameDeps = (a, b) => a?.length === b?.length && a.every((value, index) => Object.is(value, b[index]));

function textContent(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  return textContent(node.props?.children);
}

function paymentHarness({ auth: initialAuth = {}, env = {}, platform = 'android', mode = 'disabled', clients: providedClients = {}, storage } = {}) {
  const auth = { isHydrating: false, token: 'token-a', userId: 'user-a', ...initialAuth };
  const states = [], refs = [], memos = [], effects = [];
  const queuedEffects = [];
  let stateCursor = 0, refCursor = 0, memoCursor = 0, effectCursor = 0;
  const calls = [];
  const clientByMode = {};
  const makeClient = (mode) => {
    if (mode === 'disabled' && providedClients.base) return providedClients.base;
    if (providedClients[mode]) return providedClients[mode];
    const client = {
      mode,
      api: {
        listPackages: async (token, signal) => { calls.push({ kind: 'listPackages', token, signal }); return packages; },
        getBalance: async (token, signal) => { calls.push({ kind: 'getBalance', token, signal }); return { remaining: 0 }; },
      },
      async purchase(token, packageId, options) {
        calls.push({ kind: 'purchase', token, packageId, options });
        return { outcome: 'paid', order: paidOrder };
      },
      async confirm(token, orderId, signal) {
        calls.push({ kind: 'confirm', token, orderId, signal });
        return { outcome: 'paid', order: paidOrder };
      },
      async resume(token, orderId, options) {
        calls.push({ kind: 'resume', token, orderId, options });
        return { outcome: 'paid', order: paidOrder };
      },
      setMockScenario(scenario) { calls.push({ kind: 'scenario', scenario }); },
    };
    return client;
  };
  const services = {
    getPaymentMode: () => mode,
    isPaymentDevelopment: () => (env.NODE_ENV ?? 'development') !== 'production',
    createPaymentClient(mode = 'disabled') {
      calls.push({ kind: 'createClient', mode });
      if (!clientByMode[mode]) clientByMode[mode] = makeClient(mode);
      return clientByMode[mode];
    },
  };
  const listeners = new Set();
  const native = {
    Platform: { OS: platform, select: (options) => options[platform] ?? options.default },
    AppState: { addEventListener: (_event, listener) => {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    } },
    StyleSheet: { create: (styles) => styles },
    ...Object.fromEntries(['ActivityIndicator', 'Pressable', 'Text', 'View'].map((name) => [name, name])),
  };
  function useState(initial) {
    const index = stateCursor++;
    if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
    return [states[index], (next) => { states[index] = typeof next === 'function' ? next(states[index]) : next; }];
  }
  function useMemo(factory, deps) {
    const index = memoCursor++;
    const cached = memos[index];
    if (!cached || !sameDeps(deps, cached.deps)) memos[index] = { deps, value: factory() };
    return memos[index].value;
  }
  function useEffect(callback, deps) {
    const index = effectCursor++;
    const previous = effects[index];
    if (!previous || !sameDeps(deps, previous.deps)) {
      queuedEffects.push(() => {
        previous?.cleanup?.();
        effects[index] = { deps, cleanup: callback() };
      });
    }
  }
  const callbacks = [];
  let callbackCursor = 0;
  const app = loadApp({
    react: { ...React, useState, useRef(initial) {
      const index = refCursor++;
      return refs[index] ??= { current: initial };
    }, useMemo, useCallback(callback, deps) {
      const index = callbackCursor++;
      const cached = callbacks[index];
      if (!cached || !sameDeps(deps, cached.deps)) callbacks[index] = { deps, value: callback };
      return callbacks[index].value;
    }, useEffect },
    '@/hooks/use-auth': { useAuth: () => auth },
    '@/services/payment-client': services,
    'react-native': native,
    ...(storage ? { '@react-native-async-storage/async-storage': storage } : {}),
  }, env);
  const PaymentPanel = app.load('components/payment/payment-panel.tsx').PaymentPanel;
  let tree;
  function render(nextAuth = {}) {
    Object.assign(auth, nextAuth);
    stateCursor = 0; refCursor = 0; memoCursor = 0; effectCursor = 0; callbackCursor = 0; queuedEffects.length = 0;
    tree = PaymentPanel();
    for (const run of queuedEffects.splice(0)) run();
    return tree;
  }
  function findAll(node, predicate) {
    if (!node || typeof node !== 'object') return [];
    return [...(predicate(node) ? [node] : []),
      ...React.Children.toArray(node.props?.children).flatMap((child) => findAll(child, predicate))];
  }
  const nodes = (type) => findAll(tree, (node) => node.type === type);
  const button = (label) => nodes('Pressable').find((node) => textContent(node.props.children).includes(label));
  const text = () => nodes('Text').map((node) => textContent(node.props.children)).join(' ');
  const settle = async (count = 4) => {
    for (let index = 0; index < count; index++) {
      await new Promise(setImmediate);
      render();
    }
    return tree;
  };
  const unmount = () => effects.forEach((effect) => effect.cleanup?.());
  const activateApp = (state = 'active') => listeners.forEach((listener) => listener(state));
  return { app, auth, calls, states, render, settle, nodes, button, text, unmount, activateApp, clientByMode };
}

test('payment panel: development shows a clickable mock flow while live purchases are disabled', async () => {
  const h = paymentHarness();
  h.render();
  await h.settle();
  assert.match(h.text(), /次数购买尚未开放/);
  assert.ok(h.button('体验模拟购买'));
  assert.equal(h.button('微信支付'), undefined);

  h.button('体验模拟购买').props.onPress();
  h.render();
  await h.settle();
  assert.ok(h.button('模拟购买'));
  assert.match(h.text(), /不会扣款，也不会增加真实 AI 次数/);
  h.unmount();
});

test('payment panel: production hides all mock purchase controls', async () => {
  const h = paymentHarness({ env: { NODE_ENV: 'production' } });
  h.render();
  await h.settle();
  assert.match(h.text(), /次数购买尚未开放/);
  assert.equal(h.button('体验模拟购买'), undefined);
  assert.equal(h.button('模拟购买'), undefined);
  h.unmount();
});

test('payment panel: double taps submit one purchase and a pending order can be confirmed later', async () => {
  const started = deferred(), purchase = deferred();
  let purchaseCalls = 0;
  const mockClient = {
    mode: 'mock',
    api: {
      listPackages: async () => packages,
      getBalance: async () => ({ remaining: 0 }),
    },
    purchase: async (...args) => { purchaseCalls++; started.resolve(args); return purchase.promise; },
    confirm: async (_token, orderId) => ({ outcome: 'paid', order: { ...paidOrder, id: orderId } }),
    setMockScenario() {},
  };
  const h = paymentHarness({ mode: 'mock', clients: { mock: mockClient } });
  h.render();
  await h.settle();
  h.button('体验模拟购买').props.onPress();
  h.render();
  await h.settle();
  const buy = h.button('模拟购买');
  buy.props.onPress();
  buy.props.onPress();
  const [token, packageId, options] = await started.promise;
  assert.equal(token, 'token-a');
  assert.equal(packageId, 'pack-10');
  assert.equal(options.signal.aborted, false);

  purchase.resolve({ outcome: 'pending', order: pendingOrder });
  await h.settle();
  assert.ok(h.button('查询结果'));
  assert.equal(purchaseCalls, 1);

  h.button('查询结果').props.onPress();
  await h.settle();
  assert.equal(h.button('查询结果'), undefined);
  assert.match(h.text(), /模拟支付成功/);
  h.unmount();
});

test('payment panel: changing accounts clears visible A balance and packages before B loads', async () => {
  const bPackages = deferred(), bBalance = deferred();
  let bCalls = 0;
  const baseClient = {
    mode: 'mock',
    api: {
      listPackages: async (token) => { if (token === 'token-b') bCalls++; return token === 'token-a' ? [{ ...packages[0], title: 'A_PRIVATE_PACKAGE' }] : bPackages.promise; },
      getBalance: async (token) => { if (token === 'token-b') bCalls++; return token === 'token-a' ? { remaining: 71 } : bBalance.promise; },
    },
    purchase: async () => { throw new Error('disabled'); },
    confirm: async () => { throw new Error('disabled'); },
  };
  const h = paymentHarness({ mode: 'mock', clients: { mock: baseClient } });
  h.render();
  await h.settle();
  assert.match(h.text(), /A_PRIVATE_PACKAGE/);
  assert.match(h.text(), /71/);

  h.render({ token: 'token-b', userId: 'user-b' });
  h.render();
  assert.doesNotMatch(h.text(), /A_PRIVATE_PACKAGE/);
  assert.doesNotMatch(h.text(), /71/);
  assert.equal(bCalls, 2);
  bPackages.resolve([{ ...packages[0], title: 'B_PACKAGE' }]);
  bBalance.resolve({ remaining: 3 });
  await h.settle();
  assert.match(h.text(), /B_PACKAGE/);
  assert.match(h.text(), /3/);
  h.unmount();
});

test('payment panel: late request completion after unmount cannot populate an old panel', async () => {
  const latePackages = deferred(), lateBalance = deferred();
  const baseClient = {
    mode: 'mock',
    api: { listPackages: async () => latePackages.promise, getBalance: async () => lateBalance.promise },
    purchase: async () => { throw new Error('disabled'); },
    confirm: async () => { throw new Error('disabled'); },
  };
  const h = paymentHarness({ mode: 'mock', clients: { mock: baseClient } });
  h.render();
  h.unmount();
  latePackages.resolve([{ ...packages[0], title: 'STALE_PACKAGE' }]);
  lateBalance.resolve({ remaining: 99 });
  await new Promise(setImmediate);
  assert.deepEqual(h.states[3], []);
  assert.equal(h.states[4], null);
});

test('payment panel: returning to the app requests a fresh pending-order status', async () => {
  let calls = 0;
  const mockClient = {
    mode: 'mock', api: { listPackages: async () => packages, getBalance: async () => ({ remaining: 0 }) },
    purchase: async () => ({ outcome: 'pending', order: pendingOrder }),
    confirm: async (_token, orderId) => {
      calls++;
      return calls === 1
        ? { outcome: 'pending', order: pendingOrder }
        : { outcome: 'paid', order: { ...paidOrder, id: orderId } };
    },
    setMockScenario() {},
  };
  const h = paymentHarness({ mode: 'mock', clients: { mock: mockClient } });
  h.render(); await h.settle();
  h.button('体验模拟购买').props.onPress(); h.render(); await h.settle();
  h.button('模拟购买').props.onPress(); await h.settle();
  assert.ok(h.button('查询结果'));
  h.activateApp('background');
  assert.equal(calls, 0);
  h.activateApp('active');
  await h.settle();
  assert.equal(calls, 1);
  assert.ok(h.button('查询结果'));
  h.activateApp('active');
  await h.settle();
  assert.equal(calls, 2);
  assert.equal(h.button('查询结果'), undefined);
  h.unmount();
});

test('payment panel: a restored pending order belongs only to the matching account', async () => {
  const stored = new Map([['chatgym.payment.pending.v1:user-a', JSON.stringify({ mode: 'wechat', order: pendingOrder })]]);
  const storage = {
    getItem: async (key) => stored.get(key) ?? null,
    setItem: async (key, value) => { stored.set(key, value); },
    removeItem: async (key) => { stored.delete(key); },
  };
  const wechatClient = {
    mode: 'wechat', api: { listPackages: async () => packages, getBalance: async () => ({ remaining: 4 }) },
    purchase: async () => ({ outcome: 'pending', order: pendingOrder }),
    confirm: async () => ({ outcome: 'pending', order: pendingOrder }),
    resume: async () => ({ outcome: 'pending', order: pendingOrder }),
  };
  const h = paymentHarness({ mode: 'wechat', clients: { wechat: wechatClient }, storage });
  h.render(); await h.settle();
  assert.match(h.text(), /pending-1/);
  assert.ok(h.button('继续支付'));

  h.render({ token: 'token-b', userId: 'user-b' });
  h.render(); await h.settle();
  assert.doesNotMatch(h.text(), /pending-1/);
  assert.equal(h.button('继续支付'), undefined);
  h.unmount();
});

test('payment panel: storage failure while saving an order stops before native payment launch', async () => {
  let preparations = 0, launches = 0;
  const app = loadApp({ 'react-native': { Platform: { OS: 'android' } } });
  const client = app.load('services/payment-client.ts').createPaymentFlow({
    listPackages: async () => packages,
    getBalance: async () => ({ remaining: 0 }),
    createOrder: async () => pendingOrder,
    prepareWechat: async (_token, orderId) => { preparations++; return {
      orderId, params: { appId: 'wxabc123', partnerId: 'partner', prepayId: orderId,
        nonceStr: 'nonce', timeStamp: 1, sign: 'signature', package: 'Sign=WXPay' },
    }; },
    getOrder: async (_token, orderId) => ({ ...pendingOrder, id: orderId }),
  }, {
    checkAvailability: async () => {},
    launch: async () => { launches++; return 'sent'; },
  }, 'wechat', 0);
  const h = paymentHarness({ mode: 'wechat', clients: { wechat: client }, storage: {
    getItem: async () => null,
    setItem: async () => { throw new Error('device storage unavailable'); },
    removeItem: async () => {},
  } });
  h.render(); await h.settle();
  h.button('微信支付').props.onPress();
  await h.settle();
  assert.equal(preparations, 0);
  assert.equal(launches, 0);
  assert.match(h.text(), /订单状态无法安全保存/);
  assert.match(h.text(), /device storage unavailable/);
  h.unmount();
});

test('payment panel: continuing a pending order calls resume once without another purchase', async () => {
  let purchases = 0, resumes = 0;
  const wechatClient = {
    mode: 'wechat', api: { listPackages: async () => packages, getBalance: async () => ({ remaining: 10 }) },
    purchase: async () => { purchases++; return { outcome: 'pending', order: pendingOrder }; },
    confirm: async () => ({ outcome: 'pending', order: pendingOrder }),
    resume: async (_token, orderId) => {
      resumes++;
      assert.equal(orderId, pendingOrder.id);
      return { outcome: 'paid', order: { ...paidOrder, id: orderId } };
    },
  };
  const h = paymentHarness({ mode: 'wechat', clients: { wechat: wechatClient } });
  h.render(); await h.settle();
  h.button('微信支付').props.onPress(); await h.settle();
  assert.equal(purchases, 1);
  assert.ok(h.button('继续支付'));
  h.button('继续支付').props.onPress(); await h.settle();
  assert.equal(resumes, 1);
  assert.equal(purchases, 1);
  assert.equal(h.button('继续支付'), undefined);
  h.unmount();
});
