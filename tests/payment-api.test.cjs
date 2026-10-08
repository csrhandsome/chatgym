const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/load-app.cjs');

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});
const validPackage = { id: 'pack-10', title: '10 次', credits: 10, amountFen: 100, currency: 'CNY' };
const validOrder = { id: 'order-1', packageId: 'pack-10', credits: 10, amountFen: 100,
  currency: 'CNY', status: 'pending', createdAt: '2026-10-08T00:00:00.000Z' };
const validPreparation = { orderId: 'order-1', params: { appId: 'wxabc123', partnerId: 'partner',
  prepayId: 'prepay-1', nonceStr: 'nonce', timeStamp: 1, sign: 'signature', package: 'Sign=WXPay' } };

function api() {
  return loadApp({}, { EXPO_PUBLIC_API_BASE_URL: 'https://payments.example.test/' })
    .load('services/payment-api.ts').createPaymentApi();
}

test('payment API: authenticated requests use the configured URL and narrow order payload', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith('/packages')) return json({ packages: [validPackage] });
    if (url.endsWith('/orders')) return json(validOrder, 201);
    if (url.endsWith('/balance')) return json({ remaining: 12 });
    return json(validOrder);
  });
  const payments = api();

  assert.deepEqual(await payments.listPackages('account-token'), [validPackage]);
  assert.deepEqual(await payments.getBalance('account-token'), { remaining: 12 });
  const created = await payments.createOrder('account-token', {
    packageId: 'pack-10', idempotencyKey: 'request-key', amountFen: 1, token: 'must-not-leak',
  });
  assert.equal(created.id, validOrder.id);

  const packagesRequest = requests[0];
  assert.equal(packagesRequest.url, 'https://payments.example.test/api/payments/packages');
  assert.equal(packagesRequest.init.method, undefined);
  for (const { init } of requests) {
    assert.equal(init.headers.Authorization, 'Bearer account-token');
    assert.equal(init.headers.Accept, 'application/json');
  }
  const createRequest = requests.find(({ url }) => url.endsWith('/orders'));
  assert.equal(createRequest.init.method, 'POST');
  assert.deepEqual(JSON.parse(createRequest.init.body), {
    packageId: 'pack-10', idempotencyKey: 'request-key',
  });
});

test('payment API: prepares an encoded order endpoint and validates WeChat params', async (t) => {
  let request;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    request = { url, init };
    return json({ ...validPreparation, orderId: 'order/one' });
  });
  const result = await api().prepareWechat('account-token', 'order/one');
  assert.equal(request.url, 'https://payments.example.test/api/payments/orders/order%2Fone/wechat-app');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers.Authorization, 'Bearer account-token');
  assert.equal(result.orderId, 'order/one');
  assert.deepEqual(result.params, validPreparation.params);
});

test('payment API: rejects malformed packages, balances, orders and preparation data', async (t) => {
  const cases = [
    ['packages missing list', '/packages', {}],
    ['package invalid currency', '/packages', { packages: [{ ...validPackage, currency: 'USD' }] }],
    ['balance negative', '/balance', { remaining: -1 }],
    ['balance fractional', '/balance', { remaining: 1.5 }],
    ['order invalid status', '/orders', { ...validOrder, status: 'created' }],
    ['order invalid date', '/orders', { ...validOrder, createdAt: 'not-a-date' }],
    ['prepare wrong order id', '/orders/order-1/wechat-app', { ...validPreparation, orderId: 'another' }],
    ['prepare missing signature', '/orders/order-1/wechat-app', { ...validPreparation, params: { ...validPreparation.params, sign: '' } }],
    ['prepare invalid timestamp', '/orders/order-1/wechat-app', { ...validPreparation, params: { ...validPreparation.params, timeStamp: 0 } }],
  ];
  for (const [name, path, body] of cases) {
    t.mock.method(globalThis, 'fetch', async () => json(body));
    const payments = api();
    const action = path === '/packages' ? payments.listPackages('token')
      : path === '/balance' ? payments.getBalance('token')
        : path === '/orders' ? payments.createOrder('token', { packageId: 'pack-10', idempotencyKey: 'key' })
          : payments.prepareWechat('token', 'order-1');
    await assert.rejects(action, (error) => {
      assert.equal(error.status, 502, name);
      assert.match(error.message, /数据不完整/);
      return true;
    }, name);
    t.mock.restoreAll();
  }
});

test('payment API: rejects empty order identifiers before sending requests', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return json(validOrder); });
  const payments = api();
  await assert.rejects(payments.createOrder('token', { packageId: ' ', idempotencyKey: 'key' }), /数据不完整/);
  await assert.rejects(payments.createOrder('token', { packageId: 'pack-10', idempotencyKey: '  ' }), /数据不完整/);
  assert.equal(requests, 0);
});

test('payment API: 401 and 404 errors retain actionable status and messages', async (t) => {
  const payments = api();
  t.mock.method(globalThis, 'fetch', async () => json({ message: 'unauthorized' }, 401));
  await assert.rejects(payments.getBalance('bad-token'), (error) => {
    assert.equal(error.status, 401);
    assert.match(error.message, /登录状态已失效/);
    return true;
  });
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => json({ message: 'not found' }, 404));
  await assert.rejects(payments.listPackages('token'), (error) => {
    assert.equal(error.status, 404);
    assert.match(error.message, /尚未开放/);
    return true;
  });
});

test('payment API: malformed JSON becomes a structured 502 service error', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{broken', { status: 200 }));
  await assert.rejects(api().listPackages('token'), (error) => {
    assert.equal(error.status, 502);
    assert.match(error.message, /数据不完整/);
    return true;
  });
});

test('payment API: abort before and during fetch stops the request', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests++;
    return await new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => {
      reject(new DOMException('aborted', 'AbortError'));
    }, { once: true }));
  });
  const payments = api();
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(payments.listPackages('token', alreadyAborted.signal), { name: 'AbortError' });
  assert.equal(requests, 0);

  const controller = new AbortController();
  const pending = payments.getBalance('token', controller.signal);
  await new Promise(setImmediate);
  assert.equal(requests, 1);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('payment API: order lookup rejects an ID different from the requested order', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({ ...validOrder, id: 'someone-elses-order' }));
  await assert.rejects(api().getOrder('token', validOrder.id), (error) => {
    assert.equal(error.status, 502);
    assert.match(error.message, /数据不完整/);
    return true;
  });
});
