const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/load-app.cjs');
const service = () => loadApp().load('services/planning-context.ts');

test('daily planning: October 8 is Thursday in the device calendar', () => {
  const context = service().createPlanningContext('我想练胸', new Date(2026, 9, 8, 12));
  assert.equal(context.planningScope, 'day');
  assert.equal(context.interactionMode, 'plan');
  assert.equal(context.calendar.localDate, '2026-10-08');
  assert.equal(context.calendar.dayIndex, 4);
  assert.equal(context.calendar.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.deepEqual(context.schedule.preferredDays, ['周四']);
  assert.equal(context.schedule.availableDaysPerWeek, 1);
  assert.deepEqual(context.targetAreas, ['胸']);
});

test('daily planning: device midnight advances both the date and weekday', () => {
  const api = service();
  const before = api.createPlanningContext('练胸', new Date(2026, 9, 8, 23, 59));
  const after = api.createPlanningContext('练胸', new Date(2026, 9, 9, 0, 1));
  assert.equal(before.calendar.localDate, '2026-10-08');
  assert.equal(after.calendar.localDate, '2026-10-09');
  assert.equal(after.calendar.dayIndex, 5);
  assert.deepEqual(after.schedule.preferredDays, ['周五']);
});

test('daily planning: follow-ups keep the user focus and current targets override history', () => {
  const api = service(), now = new Date(2026, 9, 8, 12);
  assert.deepEqual(api.createPlanningContext('少一个动作', now, ['我想练胸']).targetAreas, ['胸']);
  assert.deepEqual(api.createPlanningContext('今天改练背', now, ['我想练胸']).targetAreas, ['背']);
  assert.deepEqual(api.createPlanningContext('不练胸，练背', now, ['我想练胸']).targetAreas, ['背']);
  assert.equal(api.createPlanningContext('以前一周练三次，今天怎么安排？', now).schedule.availableDaysPerWeek, 1);
});

test('daily planning: actual outbound chat payload carries today and chest scope', async (t) => {
  let request;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    request = JSON.parse(init.body);
    return new Response(JSON.stringify({ text: '测试回复' }), { headers: { 'content-type': 'application/json' } });
  });
  await loadApp().load('services/agent-api.ts').sendAgentMessage('token', {
    message: '今天练胸，只有40分钟',
    history: [{ role: 'assistant', text: '今天是周三，给你一周的全身训练。' }],
  });
  const expected = service().createPlanningContext('今天练胸，只有40分钟');
  assert.deepEqual(request.calendar, expected.calendar);
  assert.equal(request.planningScope, 'day');
  assert.equal(request.interactionMode, 'plan');
  assert.deepEqual(request.goal.targetAreas, ['胸']);
  assert.equal(request.schedule.availableDaysPerWeek, 1);
  assert.equal(request.schedule.sessionDurationMinutes, 40);
  assert.match(request.currentState.notes, /不得从历史对话推断/);
});
