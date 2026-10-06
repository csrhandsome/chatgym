const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/load-app.cjs');
const { event, plan, toolPair, sse } = require('./fixtures/agent-events.cjs');
const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status, headers: { 'content-type': 'application/json' },
});
const fromText = (body) => new Response(body, { headers: { 'content-type': 'text/event-stream' } });
const api = () => loadApp().load('services/agent-api.ts');

for (const size of [1, 2, 3, 7, 64]) {
  test(`chat protocol: UTF-8/CRLF stream preserves exact answers at ${size}-byte boundaries`, async (t) => {
    const answer = '你好🏋️，热身后开始\n第二段答案';
    const chunks = [];
    t.mock.method(globalThis, 'fetch', async () => sse([
      event('thinking', { text: '整理目标' }), ...toolPair(),
      event('text', { text: answer }), event('final', { output: { plan } }),
    ], { crlf: true, packetSize: size }));
    const result = await api().sendAgentMessage('token', { message: '训练' }, { onChunk: (c) => chunks.push(c) });
    assert.equal(chunks.find((c) => c.text === answer)?.kind, 'answer');
    assert.ok(result.chunks.some((c) => c.fitnessPlan?.exercises.length));
    assert.equal(new Set(chunks.map((c) => c.id)).size, chunks.length);
  });
}

test('chat protocol: multiline data, heartbeat, trailing final without separator are parsed', async (t) => {
  const answer = { type: 'text', text: '完整答案' };
  const body = ': heartbeat\r\n\r\nevent: text\r\ndata: {"type":"text",\r\ndata: "text":"完整答案"}\r\n\r\ndata: [DONE]';
  t.mock.method(globalThis, 'fetch', async () => fromText(body));
  const result = await api().sendAgentMessage('token', { message: '测试' });
  assert.equal(result.chunks[0].text, answer.text);
});

test('chat protocol: malformed structured final is rejected and never validates a partial plan', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => fromText(
    `data: ${JSON.stringify(event('tool_result', { output: plan }))}\n\nevent: final\ndata: {"output":BROKEN}\n\n`,
  ));
  await assert.rejects(api().sendAgentMessage('token', { message: '测试' }), /格式无效/);
});

for (const reason of ['length', 'error', 'content-filter']) {
  test(`chat protocol: finish reason ${reason} is not accepted as success`, async (t) => {
    t.mock.method(globalThis, 'fetch', async () => sse([
      event('text', { text: '尚未完成' }), event('final', { finishReason: reason, output: { plan } }),
    ]));
    await assert.rejects(api().sendAgentMessage('token', { message: '测试' }), /未正常完成/);
  });
}

test('chat protocol: reader exceptions cancel the reader and preserve already streamed cards', async (t) => {
  let reads = 0, cancelled = 0, released = 0;
  const received = [];
  const reader = {
    read: async () => {
      if (reads++) throw new Error('socket interrupted');
      return { done: false, value: new TextEncoder().encode(`data: ${JSON.stringify(toolPair()[0])}\n\n`) };
    },
    cancel: async () => { cancelled++; }, releaseLock: () => { released++; },
  };
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: { getReader: () => reader },
  }));
  await assert.rejects(api().sendAgentMessage('token', { message: '测试' }, { onChunk: (c) => received.push(c) }), /socket interrupted/);
  assert.equal(received[0].kind, 'tool'); assert.equal(cancelled, 1); assert.equal(released, 1);
});

test('chat protocol: cancellation interrupts a stalled SSE reader, cancels source and rejects as AbortError', async (t) => {
  let cancelled = 0;
  const controller = new AbortController();
  const chunks = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.signal, controller.signal);
    return new Response(new ReadableStream({ start(source) {
      source.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(toolPair()[0])}\n\n`));
    }, cancel() { cancelled++; } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const pending = api().sendAgentMessage('token', { message: '测试' }, {
    signal: controller.signal, onChunk: (c) => chunks.push(c),
  });
  await new Promise(setImmediate); controller.abort();
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  assert.equal(chunks.length, 1); assert.equal(cancelled, 1);
});

test('chat protocol: pre-aborted request makes no network call', async (t) => {
  let count = 0;
  t.mock.method(globalThis, 'fetch', async () => { count++; return json({ text: 'bad' }); });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(api().sendAgentMessage('token', { message: '测试' }, { signal: controller.signal }),
    (error) => error.name === 'AbortError');
  assert.equal(count, 0);
});

test('chat protocol: independent concurrent requests keep listeners and plans isolated', async (t) => {
  const finish = [];
  t.mock.method(globalThis, 'fetch', (_url, init) => new Promise((resolve) => finish.push({ resolve, init })));
  const service = api(), a = [], b = [];
  const pendingA = service.sendAgentMessage('A', { message: 'A目标' }, { onChunk: (c) => a.push(c) });
  const pendingB = service.sendAgentMessage('B', { message: 'B目标' }, { onChunk: (c) => b.push(c) });
  finish[1].resolve(sse([event('text', { text: 'B答案' }), event('final', { output: { plan: { ...plan, title: 'B计划' } } })]));
  finish[0].resolve(sse([event('text', { text: 'A答案' }), event('final', { output: { plan: { ...plan, title: 'A计划' } } })]));
  const [ra, rb] = await Promise.all([pendingA, pendingB]);
  assert.ok(ra.chunks.some((c) => c.fitnessPlan?.title === 'A计划'));
  assert.ok(rb.chunks.some((c) => c.fitnessPlan?.title === 'B计划'));
  assert.ok(!JSON.stringify(a).includes('B答案') && !JSON.stringify(b).includes('A答案'));
  assert.equal(finish[0].init.headers.Authorization, 'Bearer A');
  assert.equal(finish[1].init.headers.Authorization, 'Bearer B');
});

for (const status of [400, 401, 403, 422, 500, 503]) {
  test(`chat protocol: HTTP ${status} remains an error with its status`, async (t) => {
    t.mock.method(globalThis, 'fetch', async () => json({ message: `server-${status}` }, status));
    await assert.rejects(api().sendAgentMessage('token', { message: '测试' }), (error) => error.status === status);
  });
}

test('chat protocol: 2000-character message is preserved exactly and history is bounded', async (t) => {
  let body;
  t.mock.method(globalThis, 'fetch', async (_url, init) => { body = JSON.parse(init.body); return json({ text: '完成' }); });
  await api().sendAgentMessage('token', { message: '长'.repeat(2000),
    history: Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `history-${i}` })),
  });
  assert.equal(body.goal.requestNote.length, 2000);
  assert.equal(body.chatHistory.length, 14); assert.equal(body.chatHistory[0].text, 'history-6');
});

for (const delivery of ['json', 'stream']) {
  test(`chat protocol: ${delivery} final repeats the full dialog answer only once`, async (t) => {
    const events = [event('text', { text: '保持肩胛稳定' }),
      event('final', { summary: '对话完成', output: { answer: '保持肩胛稳定' } })];
    const received = [];
    t.mock.method(globalThis, 'fetch', async () => delivery === 'json' ? json({ agentEvents: events }) : sse(events));
    const result = await api().sendAgentMessage('token', { message: '测试' }, { onChunk: (c) => received.push(c) });
    assert.equal(result.chunks.filter((c) => c.kind === 'answer' && c.text === '保持肩胛稳定').length, 1);
    if (delivery === 'stream') assert.equal(received.filter((c) => c.text === '保持肩胛稳定').length, 1);
    assert.ok(result.chunks.some((c) => c.title === '最终完成'));
  });
}

for (const wrap of [(error) => error, (error) => ({ agentSteps: [{ events: [error] }] })]) {
  test('chat protocol: JSON direct/legacy execution errors reject instead of succeeding', async (t) => {
    const chunks = [];
    t.mock.method(globalThis, 'fetch', async () => json(wrap(event('error', { summary: '执行出错' }))));
    await assert.rejects(api().sendAgentMessage('token', { message: '测试' }, { onChunk: (c) => chunks.push(c) }), /执行出错/);
    assert.ok(chunks.some((c) => c.status === 'failed'));
  });
}

test('chat protocol: JSON abnormal final reason is rejected like SSE', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({ agentEvents: [event('final', { finishReason: 'length', output: { plan } })] }));
  await assert.rejects(api().sendAgentMessage('token', { message: '测试' }), /未正常完成/);
});
