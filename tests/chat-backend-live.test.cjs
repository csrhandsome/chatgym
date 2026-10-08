// Optional integration: run against tests/fixtures/chat-backend.mjs only.
// Actual routes, auth/JWT, SDK, tools, review and SSE; provider HTTP/Mem0 mocked.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/load-app.cjs');
const base = process.env.CHAT_TEST_BASE_URL;
let account;
before(async () => {
  if (!base) return;
  const response = await fetch(`${base}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: `chat_${Date.now()}`, password: 'Chat-Audit-Only-42' }),
  });
  assert.equal(response.status, 201); account = await response.json();
});
const api = (delivery) => loadApp({}, {
  EXPO_PUBLIC_API_BASE_URL: base,
  EXPO_PUBLIC_PLAN_API_PATH: `/api/agent/plan${delivery === 'stream' ? '/stream' : ''}`,
}).load('services/agent-api.ts');
for (const delivery of ['json', 'stream']) {
  test(`chat actual backend: ${delivery} follow-up generates today's plan`, { skip: !base }, async () => {
    const result = await api(delivery).sendAgentMessage(account.token, { message: '卧推动作怎么做？' });
    assert.equal(result.delivery, delivery);
    assert.ok(result.chunks.some((c) => c.fitnessPlan && c.text.includes('保持肩胛稳定')));
  });
  test(`chat actual backend: ${delivery} today's chest plan has three exercises and correct date`, { skip: !base }, async () => {
    const received = [];
    const result = await api(delivery).sendAgentMessage(account.token, {
      message: '今天练胸', history: [{ role: 'user', text: '我想增肌' }, { role: 'assistant', text: '今天是周三，每周训练三次。' }],
    }, { onChunk: (c) => received.push(c) });
    const saved = result.chunks.find((c) => c.fitnessPlan);
    assert.deepEqual(saved?.fitnessPlan.exercises.map((e) => e.name), ['卧推', '蝴蝶飞鸟', '龙门架夹胸']);
    const context = loadApp().load('services/planning-context.ts').createPlanningContext('今天练胸');
    assert.ok(saved.fitnessPlan.title.includes(context.calendar.localDate));
    assert.ok(saved.fitnessPlan.title.includes(context.schedule.preferredDays[0]));
    assert.ok(result.chunks.some((c) => c.kind === 'tool' && c.status === 'completed' && c.toolCallId));
    assert.ok(result.chunks.some((c) => c.kind === 'thought'));
    if (delivery === 'stream') assert.ok(received.some((c) => c.fitnessPlan));
  });
  test(`chat actual backend: ${delivery} real provider error never returns a successful plan`, { skip: !base }, async () => {
    await assert.rejects(api(delivery).sendAgentMessage(account.token, { message: '模拟失败' }), /失败|failure|400/);
  });
  test(`chat actual backend: ${delivery} invalid JWT propagates HTTP 401`, { skip: !base }, async () => {
    await assert.rejects(api(delivery).sendAgentMessage('invalid-audit-token', { message: '训练' }), (e) => e.status === 401);
  });
}
