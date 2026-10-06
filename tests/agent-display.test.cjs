const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { loadApp } = require('./helpers/load-app.cjs');
const { event, plan, toolPair, sse } = require('./fixtures/agent-events.cjs');

function api(env) {
  return loadApp({}, env).load('services/agent-api.ts');
}

async function request(t, response, options = {}, env) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, ...init });
    return response;
  });
  const result = await api(env).sendAgentMessage('test-token', { message: '测试' }, options);
  return { result, requests };
}

const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'content-type': 'application/json' },
});

test('baseline: JSON shows thinking, tool input/output, text and final plan', async (t) => {
  const agentEvents = [event('thinking'), ...toolPair(),
    event('text', { text: '建议先热身' }), event('final', { output: { plan } })];
  const { result, requests } = await request(t, json({ agentEvents, plan }));
  assert.equal(result.delivery, 'json');
  assert.ok(result.chunks.some((chunk) => chunk.kind === 'thought'));
  assert.ok(result.chunks.some((chunk) => chunk.text.includes('腿部')));
  assert.ok(result.chunks.some((chunk) => chunk.text.includes('杠铃深蹲')));
  assert.ok(result.chunks.some((chunk) => chunk.text === '建议先热身'));
  assert.ok(result.chunks.some((chunk) => chunk.fitnessPlan?.exercises.length));
  assert.equal(requests[0].headers.Authorization, 'Bearer test-token');
});

test('baseline: SSE survives one-byte packets, Chinese UTF-8 and CRLF', async (t) => {
  const received = [];
  const { result } = await request(t, sse([
    ...toolPair(), event('final', { summary: '完成', output: { plan } }),
  ], { packetSize: 1, crlf: true }), { onChunk: (chunk) => received.push(chunk) });
  assert.equal(result.delivery, 'stream');
  assert.ok(received.some((chunk) => chunk.text.includes('腿部')));
  assert.ok(received.some((chunk) => chunk.fitnessPlan));
  assert.ok(result.chunks.some((chunk) => chunk.fitnessPlan));
});

test('baseline: SSE callback runs before the response stream closes', { timeout: 2000 }, async (t) => {
  let finish;
  let signal;
  const arrived = new Promise((resolve) => { signal = resolve; });
  const response = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(
      `event: tool_call\ndata: ${JSON.stringify(toolPair()[0])}\n\n`
    ));
    finish = () => {
      controller.enqueue(new TextEncoder().encode(
        `event: final\ndata: ${JSON.stringify(event('final', { summary: '完成' }))}\n\n`
      ));
      controller.close();
    };
  } }), { headers: { 'content-type': 'text/event-stream' } });
  t.mock.method(globalThis, 'fetch', async () => response);
  const pending = api().sendAgentMessage(null, { message: '测试' }, { onChunk: signal });
  try {
    const chunk = await arrived;
    assert.equal(chunk.kind, 'tool');
  } finally {
    finish();
    await pending;
  }
});

test('baseline: SSE works with buffered native fetch fallback', async (t) => {
  const response = sse([...toolPair(), event('final', { output: { plan } })]);
  const text = await response.text();
  const received = [];
  const { result } = await request(t, {
    ok: true, body: null, headers: response.headers, text: async () => text,
  }, { onChunk: (chunk) => received.push(chunk) });
  assert.ok(received.some((chunk) => chunk.fitnessPlan));
  assert.equal(result.delivery, 'stream');
});

test('baseline: empty response is rejected', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({}));
  await assert.rejects(api().sendAgentMessage(null, { message: '测试' }), /没有解析出/);
});

test('acceptance: HTTP 401 is rejected with Chinese feedback and its status', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({ message: 'authorization token required' }, 401));
  await assert.rejects(api().sendAgentMessage(null, { message: '测试' }), (error) => {
    assert.equal(error.status, 401);
    assert.match(error.message, /登录状态已失效/);
    return true;
  });
});

test('baseline: network rejection is surfaced', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('network failed'); });
  await assert.rejects(api().sendAgentMessage(null, { message: '测试' }), /无法连接到/);
});

test('baseline: agentSteps with nested events retains tool outputs', async (t) => {
  const { result } = await request(t, json({ agentSteps: [{ events: toolPair() }] }));
  assert.equal(result.chunks.filter((chunk) => chunk.kind === 'tool').length, 2);
});

test('baseline: repeated delivery of the same event is deduplicated', async (t) => {
  const call = toolPair()[0];
  const received = [];
  await request(t, sse([call, call, event('final')]), { onChunk: (chunk) => received.push(chunk) });
  assert.equal(received.filter((chunk) => chunk.kind === 'tool').length, 1);
});

test('acceptance: default chat endpoint selects the backend SSE route', async (t) => {
  const { requests } = await request(t, json({ text: '完成' }));
  assert.ok(requests[0].url.endsWith('/api/agent/plan/stream'), requests[0].url);
});

test('acceptance: distinct identical tool calls remain visible in JSON', async (t) => {
  const { result } = await request(t, json({ agentEvents: [...toolPair('call-a'), ...toolPair('call-b')] }));
  assert.equal(result.chunks.filter((chunk) => chunk.text.includes('正在调用')).length, 2);
});

test('acceptance: distinct identical tool calls remain visible in SSE', async (t) => {
  const received = [];
  await request(t, sse([...toolPair('call-a'), ...toolPair('call-b'), event('final')]), {
    onChunk: (chunk) => received.push(chunk),
  });
  assert.equal(received.filter((chunk) => chunk.text.includes('正在调用')).length, 2);
});

test('acceptance: normalized events preserve backend toolCallId', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({ agentEvents: toolPair('call-a') }));
  const result = await api().analyzeFitnessImages('test-token', { images: [] });
  assert.equal(result.events[0].toolCallId, 'call-a');
  assert.equal(result.events[1].toolCallId, 'call-a');
});

test('acceptance: SSE error must fail the request instead of returning success', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => sse([
    event('thinking'), event('error', { summary: '模型调用失败' }),
  ]));
  await assert.rejects(api().sendAgentMessage(null, { message: '测试' }), /模型调用失败/);
});

test('acceptance: stream ending before final must be reported as incomplete', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => sse([toolPair()[0]]));
  await assert.rejects(api().sendAgentMessage(null, { message: '测试' }), /中断|未完成|不完整/);
});

test('compatibility: legacy agentSteps result summary can still supply a fitness plan', async (t) => {
  const { result } = await request(t, json({ agentSteps: [{ toolResults: [{
    name: 'createPlan', success: true, summary: JSON.stringify(plan),
  }] }] }));
  assert.ok(result.chunks.some((chunk) => chunk.fitnessPlan));
});

// Optional interoperability checks: the sibling backend does NOT emit these formats.
test('compatibility: function_call name/arguments is normalized as a tool', async (t) => {
  const { result } = await request(t, json({
    type: 'function_call', name: 'recommendExercises', arguments: '{"target":"腿部"}',
  }));
  assert.ok(result.chunks.some((chunk) => chunk.kind === 'tool' && chunk.text.includes('腿部')));
});

test('compatibility: SDK tool-input-available SSE event preserves input', async (t) => {
  const { result } = await request(t, sse([{ type: 'tool-input-available',
    toolCallId: 'call-1', toolName: 'recommendExercises', input: { target: '腿部' },
  }, { type: 'finish' }]));
  const tool = result.chunks.find((chunk) => chunk.kind === 'tool');
  assert.ok(tool.text.includes('腿部'));
  assert.equal(tool.toolCallId, 'call-1');
});

test('compatibility: SDK tool events without finish are still incomplete', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => sse([{ type: 'tool-input-available',
    toolCallId: 'call-1', toolName: 'recommendExercises', input: { target: '腿部' },
  }]));
  await assert.rejects(api().sendAgentMessage('test-token', { message: '测试' }), /中断/);
});

test('compatibility: SDK DONE sentinel completes the stream', async (t) => {
  const call = toolPair()[0];
  const body = `data: ${JSON.stringify(call)}\n\ndata: [DONE]\n\n`;
  const { result } = await request(t, new Response(body, {
    headers: { 'content-type': 'text/event-stream' },
  }));
  assert.equal(result.delivery, 'stream');
  assert.ok(result.chunks.some((chunk) => chunk.text.includes('腿部')));
});

test('compatibility: SDK tool errors report their original error text', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => sse([{ type: 'tool-output-error',
    toolCallId: 'call-1', errorText: '动作推荐失败',
  }, { type: 'finish' }]));
  await assert.rejects(api().sendAgentMessage('test-token', { message: '测试' }), /动作推荐失败/);
});

function cardText(message) {
  const { ChatMessageCard } = loadApp().load('components/chat/chat-message-card.tsx');
  return renderToStaticMarkup(React.createElement(ChatMessageCard, {
    message: { createdAt: new Date(), ...message },
  }));
}

test('baseline: actual card renders tool title, input and output text', () => {
  const html = cardText({ kind: 'tool', title: '动作推荐', text: '输入\n腿部\n输出\n杠铃深蹲' });
  assert.ok(html.includes('动作推荐') && html.includes('腿部') && html.includes('杠铃深蹲'));
});

test('acceptance: finished tool card has an explicit completed label', async (t) => {
  const { result } = await request(t, json({ agentEvents: [toolPair()[1]] }));
  const html = cardText(result.chunks[0]);
  assert.match(html, /已完成|执行完成/);
  assert.ok(!html.includes('处理中'));
});

test('acceptance: error card has an explicit failed label', async (t) => {
  const received = [];
  t.mock.method(globalThis, 'fetch', async () => json({ agentEvents: [event('error', { summary: '执行出错' })] }));
  await assert.rejects(api().sendAgentMessage('test-token', { message: '测试' }, {
    onChunk: (chunk) => received.push(chunk),
  }), /执行出错/);
  assert.match(cardText(received[0]), /执行失败|调用失败/);
});

// Exercise ChatScreen's real send handler using a minimal hook and list adapter.
// These are orchestration tests, not native rendering or GiftedChat integration tests.
function screenHarness(auth = {}, overrides = {}) {
  const states = [], refs = [], effects = [];
  let cursor = 0, refCursor = 0, effectCursor = 0, version = 0, tree, chat;
  let currentAuth = { token: 'test-token', userId: 'test-user', ...auth };
  let pendingEffects = [];
  const GiftedChat = () => null;
  GiftedChat.append = (current = [], next = []) => next.concat(current);
  function effect(fn, deps) {
    const index = effectCursor++;
    const previous = effects[index];
    if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
      pendingEffects.push(() => {
        previous?.cleanup?.();
        effects[index] = { deps, cleanup: fn() };
      });
    }
  }
  const app = loadApp({
    react: { ...React, startTransition: (fn) => fn(), useEffect: effect, useLayoutEffect: effect,
      useRef(initial) {
        const index = refCursor++;
        return refs[index] ??= { current: initial };
      },
      useState(initial) {
        const index = cursor++;
        if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
        return [states[index], (next) => {
          const value = typeof next === 'function' ? next(states[index]) : next;
          if (!Object.is(value, states[index])) { states[index] = value; version++; }
        }];
      },
    },
    '@/hooks/use-auth': { useAuth: () => currentAuth },
    'react-native-gifted-chat': { GiftedChat },
    ...overrides,
  });
  const Screen = app.load('app/(tabs)/chat.tsx').default;
  function find(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.type === GiftedChat) return node;
    for (const child of React.Children.toArray(node.props?.children)) {
      const found = find(child);
      if (found) return found;
    }
    return null;
  }
  function render(nextAuth) {
    if (nextAuth) currentAuth = { ...currentAuth, ...nextAuth };
    for (let attempt = 0; attempt < 5; attempt++) {
      const before = version;
      cursor = 0; refCursor = 0; effectCursor = 0; pendingEffects = [];
      tree = Screen(); chat = find(tree);
      for (const run of pendingEffects) run();
      if (version === before) break;
    }
    assert.ok(chat);
    return chat;
  }
  render();
  function send(text = '测试') {
    chat.props.onSend([{ _id: `user-${Date.now()}`, text, createdAt: new Date(), user: { _id: 'u' } }]);
  }
  async function settle() {
    for (let attempt = 0; states[3] && attempt < 100; attempt++) await new Promise(setImmediate);
    assert.equal(states[3], false, 'send handler did not finish');
    return states[0].filter((message) => message.kind !== 'user');
  }
  return { states, storage: app.storage, send, settle, render, load: app.load,
    get tree() { return tree; }, get chat() { return chat; },
    unmount: () => effects.forEach((item) => item.cleanup?.()),
  };
}

test('baseline: chat SSE path persists the final plan for Fitness', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => sse([
    ...toolPair(), event('final', { output: { plan } }),
  ]));
  const screen = screenHarness();
  screen.send();
  const messages = await screen.settle();
  assert.ok(screen.storage.has('fitnessPlan:test-user'));
  assert.ok(messages.some((message) => message.title === plan.title));
});

test('acceptance: JSON messages keep chronological order in the inverted list', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({ agentEvents: toolPair() }));
  const screen = screenHarness();
  screen.send();
  const messages = await screen.settle();
  // Latest first is GiftedChat's default inverted list contract.
  assert.ok(messages[0].text.includes('已收到工具结果'), messages.map((item) => item.text).join('\n'));
});

test('acceptance: anonymous chat explains login and makes no API request', async (t) => {
  let requestCount = 0;
  t.mock.method(globalThis, 'fetch', async () => { requestCount++; return json({ text: '完成' }); });
  const screen = screenHarness({ token: null });
  screen.send();
  const messages = await screen.settle();
  assert.equal(requestCount, 0);
  assert.equal(messages.length, 0);
  assert.match(screen.states[2], /请先.*登录/);
  const text = renderToStaticMarkup(screen.tree);
  assert.match(text, /请先到 Profile 页登录/);
  assert.ok(!text.includes('未登录也可以'));
});

test('acceptance: unauthorized chat clears the session and keeps a failed card', async (t) => {
  let signOutCount = 0;
  t.mock.method(globalThis, 'fetch', async () => json({ message: 'invalid token' }, 401));
  const screen = screenHarness({ token: 'expired', signOut: async () => { signOutCount++; } });
  screen.send();
  const messages = await screen.settle();
  assert.equal(signOutCount, 1);
  assert.match(screen.states[2], /登录状态已失效/);
  assert.equal(messages[0].status, 'failed');
});

test('acceptance: temporary chat errors and forbidden access preserve the session', async (t) => {
  let signOutCount = 0;
  const responses = [() => json({ message: 'forbidden' }, 403), () => { throw new Error('offline'); }];
  t.mock.method(globalThis, 'fetch', async () => responses.shift()());
  for (let attempt = 0; attempt < 2; attempt++) {
    const screen = screenHarness({ token: 'valid', signOut: async () => { signOutCount++; } });
    screen.send();
    const messages = await screen.settle();
    assert.equal(messages[0].status, 'failed');
  }
  assert.equal(signOutCount, 0);
});

test('acceptance: streamed failure keeps process cards without saving an unfinished plan', async (t) => {
  const pair = toolPair();
  t.mock.method(globalThis, 'fetch', async () => sse([
    pair[0], event('tool_result', { toolCallId: 'call-1', toolName: 'createPlan', output: plan }),
    event('error', { summary: '最终计划生成失败' }),
  ]));
  const screen = screenHarness();
  screen.storage.set('fitnessPlan:test-user', 'previous-plan');
  screen.send();
  const messages = await screen.settle();
  assert.ok(messages.some((message) => message.text.includes('正在调用')));
  assert.ok(messages.some((message) => message.text.includes('最终计划生成失败') && message.status === 'failed'));
  assert.equal(screen.storage.get('fitnessPlan:test-user'), 'previous-plan');
  assert.match(screen.states[2], /最终计划生成失败/);
});

test('acceptance: interrupted tool stays visible and is labelled failed', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => sse([toolPair()[0]]));
  const screen = screenHarness();
  screen.send();
  const messages = await screen.settle();
  const tool = messages.find((message) => message.text.includes('正在调用'));
  assert.equal(tool.status, 'failed');
  assert.match(cardText(tool), /执行失败/);
  assert.ok(!screen.storage.has('fitnessPlan:test-user'));
});

for (const delivery of ['json', 'stream']) {
  test(`acceptance: ${delivery} tool completion metadata reaches the rendered card`, async (t) => {
    const pair = toolPair('ui-call');
    t.mock.method(globalThis, 'fetch', async () => delivery === 'json'
      ? json({ agentEvents: pair }) : sse([...pair, event('final')]));
    const screen = screenHarness();
    screen.send();
    const messages = await screen.settle();
    const call = messages.find((message) => message.text.includes('正在调用'));
    assert.equal(call.status, 'completed');
    const card = screen.chat.props.renderMessage({ currentMessage: call });
    assert.equal(card.props.message.toolCallId, 'ui-call');
    assert.equal(card.props.message.status, 'completed');
    const html = renderToStaticMarkup(card);
    assert.match(html, /已完成/);
    assert.ok(!html.includes('处理中'));
  });
}

test('acceptance: rapid repeated sends produce one chat request', async (t) => {
  let requestCount = 0;
  t.mock.method(globalThis, 'fetch', async () => { requestCount++; return json({ text: '完成' }); });
  const screen = screenHarness();
  screen.send();
  screen.send();
  await screen.settle();
  assert.equal(requestCount, 1);
  assert.equal(screen.states[0].filter((message) => message.kind === 'user').length, 1);
});

for (const service of ['services/agent-api.ts', 'services/backend-api.ts']) {
  test(`identity: ${service} keeps current input separate from history and tool output`, async (t) => {
    let body;
    t.mock.method(globalThis, 'fetch', async (_url, init) => { body = JSON.parse(init.body); return json({ text: '完成' }); });
    const module = loadApp().load(service);
    const send = module.sendAgentMessage ?? module.sendChatMessage;
    await send('test-token', { message: '  当前用户输入\n保留换行  ', history: [
      { role: 'user', kind: 'user', text: '往期用户输入' },
      { role: 'assistant', kind: 'answer', text: '助手建议不能成为用户事实' },
      { role: 'assistant', kind: 'thought', text: 'PRIVATE_THOUGHT' },
      { role: 'assistant', kind: 'tool', text: 'PRIVATE_TOOL_OUTPUT' },
    ] });
    assert.equal(body.goal.requestNote, '当前用户输入\n保留换行');
    assert.deepEqual(body.chatHistory, [
      { role: 'user', text: '往期用户输入' },
      { role: 'assistant', text: '助手建议不能成为用户事实' },
    ]);
    assert.ok(!JSON.stringify(body).includes('PRIVATE_THOUGHT'));
    assert.ok(!JSON.stringify(body).includes('PRIVATE_TOOL_OUTPUT'));
  });
}

test('identity: switching A to B clears messages, draft and feedback before B sends', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests.push(JSON.parse(init.body));
    if (requests.length === 2) throw new Error('offline');
    return json({ text: requests.length === 1 ? 'A_PRIVATE_ANSWER' : 'B_PUBLIC_ANSWER' });
  });
  const screen = screenHarness({ token: 'token-a', userId: 'user-a' });
  screen.send('A_PRIVATE_INPUT'); await screen.settle(); screen.render();
  screen.send('A_PRIVATE_RETRY'); await screen.settle(); screen.render();
  screen.chat.props.textInputProps.onChangeText('A_PRIVATE_DRAFT');
  assert.ok(screen.states[0].length > 0 && screen.states[2]);
  screen.render({ token: 'token-b', userId: 'user-b' });
  assert.deepEqual(screen.chat.props.messages, []);
  assert.equal(screen.chat.props.text, '');
  assert.equal(screen.states[2], null);
  screen.send('B_CURRENT_INPUT'); await screen.settle();
  assert.deepEqual(requests[2].chatHistory, []);
  assert.equal(requests[2].goal.requestNote, 'B_CURRENT_INPUT');
  assert.ok(!JSON.stringify(screen.states[0]).includes('A_PRIVATE'));
});

test('identity: late A completion cannot append a plan or clear B pending state', async (t) => {
  const replies = [];
  t.mock.method(globalThis, 'fetch', () => new Promise((resolve) => replies.push(resolve)));
  const screen = screenHarness({ token: 'token-a', userId: 'user-a' });
  screen.send('A_INPUT');
  screen.render({ token: 'token-b', userId: 'user-b' }); screen.send('B_INPUT');
  replies[0](json({ plan: { ...plan, title: 'A_PRIVATE_PLAN' } }));
  await new Promise(setImmediate);
  assert.equal(screen.states[3], true);
  assert.ok(!JSON.stringify(screen.states[0]).includes('A_PRIVATE'));
  assert.equal(screen.storage.size, 0);
  replies[1](json({ plan: { ...plan, title: 'B_PLAN' } }));
  await screen.settle();
  assert.ok(screen.storage.has('fitnessPlan:user-b'));
  assert.ok(!screen.storage.has('fitnessPlan:user-a'));
  assert.ok(!screen.storage.has('fitnessPlan'));
});

test('identity: late A 401 cannot sign out B or replace B feedback', async (t) => {
  let finish, signOuts = 0;
  t.mock.method(globalThis, 'fetch', () => new Promise((resolve) => { finish = resolve; }));
  const screen = screenHarness({ token: 'token-a', userId: 'user-a', signOut: async () => { signOuts++; } });
  screen.send('A_INPUT');
  screen.render({ token: 'token-b', userId: 'user-b' });
  finish(json({ message: 'invalid A token' }, 401));
  await new Promise(setImmediate);
  assert.equal(signOuts, 0);
  assert.deepEqual(screen.states[0], []);
  assert.equal(screen.states[2], null);
  assert.equal(screen.states[3], false);
});

test('identity: late A SSE events are discarded after switching accounts', async (t) => {
  let controller;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(value) { controller = value; } }), {
    headers: { 'content-type': 'text/event-stream' },
  }));
  const screen = screenHarness({ token: 'token-a', userId: 'user-a' });
  screen.send('A_INPUT'); await new Promise(setImmediate);
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(toolPair()[0])}\n\n`));
  await new Promise(setImmediate);
  assert.ok(screen.states[0].some((item) => item.kind === 'tool'));
  screen.render({ token: 'token-b', userId: 'user-b' });
  // Switching accounts actively closes the reader, so the old producer cannot
  // enqueue a final event. Late fetch completions are covered separately.
  assert.throws(() => controller.enqueue(new TextEncoder().encode('late')), /closed/);
  await new Promise(setImmediate);
  assert.deepEqual(screen.states[0], []);
  assert.equal(screen.storage.size, 0);
});

test('identity: signing back into A does not revive an earlier A request', async (t) => {
  let finish;
  t.mock.method(globalThis, 'fetch', () => new Promise((resolve) => { finish = resolve; }));
  const screen = screenHarness({ token: 'token-a', userId: 'user-a' });
  screen.send('OLD_A_INPUT');
  screen.render({ token: null, userId: null });
  screen.render({ token: 'token-a', userId: 'user-a' });
  finish(json({ plan })); await new Promise(setImmediate);
  assert.deepEqual(screen.states[0], []);
  assert.equal(screen.storage.size, 0);
});

test('identity: same-session retry preserves its previous conversation', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests.push(JSON.parse(init.body));
    if (requests.length === 2) throw new Error('offline');
    return json({ text: 'SAME_ACCOUNT_ANSWER' });
  });
  const screen = screenHarness();
  screen.send('FIRST_INPUT'); await screen.settle(); screen.render();
  screen.send('SECOND_INPUT'); await screen.settle(); screen.render();
  assert.ok(screen.states[0].some((item) => item.text === 'FIRST_INPUT'));
  assert.ok(screen.states[0].some((item) => item.text === 'SAME_ACCOUNT_ANSWER'));
  assert.ok(requests[1].chatHistory.some((item) => item.text === 'FIRST_INPUT'));
  assert.ok(!requests[1].chatHistory.some((item) => item.text === 'SECOND_INPUT'));
});

test('identity: A storage already in flight stays in A namespace and cannot affect B', async (t) => {
  const stored = new Map();
  let releaseA, startedA;
  const began = new Promise((resolve) => { startedA = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url, init) => json({ plan: {
    ...plan, title: init.headers.Authorization === 'Bearer token-a' ? 'A_PRIVATE_PLAN' : 'B_PLAN',
  } }));
  const screen = screenHarness({ token: 'token-a', userId: 'user-a' }, {
    '@react-native-async-storage/async-storage': {
      getItem: async (key) => stored.get(key) ?? null,
      removeItem: async (key) => { stored.delete(key); },
      setItem: async (key, value) => {
        if (key === 'fitnessPlan:user-a') { startedA(); await new Promise((resolve) => { releaseA = resolve; }); }
        stored.set(key, value);
      },
    },
  });
  screen.send('A_INPUT'); await began;
  screen.render({ token: 'token-b', userId: 'user-b' }); screen.send('B_INPUT'); await screen.settle();
  assert.equal(JSON.parse(stored.get('fitnessPlan:user-b')).title, 'B_PLAN');
  releaseA(); await new Promise(setImmediate);
  assert.equal(JSON.parse(stored.get('fitnessPlan:user-a')).title, 'A_PRIVATE_PLAN');
  assert.equal(JSON.parse(stored.get('fitnessPlan:user-b')).title, 'B_PLAN');
  assert.ok(!JSON.stringify(screen.states[0]).includes('A_PRIVATE_PLAN'));
});

test('acceptance: camera analysis sends the available signed-in token', async (t) => {
  const requests = [];
  const app = loadApp();
  await app.load('services/backend-api.ts').storeUserToken('test-token');
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, ...init });
    return json({ results: [] });
  });
  await app.load('services/calorie-api.ts').analyzeMealPhoto({ uri: 'data:image/jpeg;base64,AA==' });
  assert.equal(requests[0].headers.Authorization, 'Bearer test-token');
});

// Regression audit for chat features 5–8. Fixed clocks expose ordering bugs
// without relying on network or render timing.
test('chat regression: same-millisecond multi-turn history keeps user before assistant', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests.push(JSON.parse(init.body)); return json({ text: `reply-${requests.length}` });
  });
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const screen = screenHarness();
  screen.send('first'); await screen.settle(); screen.render();
  screen.send('second'); await screen.settle();
  assert.deepEqual(requests[1].chatHistory, [
    { role: 'user', text: 'first' }, { role: 'assistant', text: 'reply-1' },
  ]);
});

for (const delivery of ['json', 'stream']) {
  test(`chat regression: ${delivery} final dialog answer field is displayed`, async (t) => {
    const agentEvents = [event('final', { summary: '对话完成', output: { mode: 'dialog', answer: '保持肩胛稳定' } })];
    const { result } = await request(t, delivery === 'json'
      ? json({ agentEvents, answer: '保持肩胛稳定' }) : sse(agentEvents));
    assert.ok(result.chunks.some((chunk) => chunk.kind === 'answer' && chunk.text === '保持肩胛稳定'));
  });
  test(`chat regression: ${delivery} failed tool output cannot overwrite the saved plan`, async (t) => {
    const agentEvents = [event('tool_result', { toolCallId: 'bad-plan', success: false, output: plan }), event('final')];
    t.mock.method(globalThis, 'fetch', async () => delivery === 'json' ? json({ agentEvents }) : sse(agentEvents));
    const screen = screenHarness(); screen.storage.set('fitnessPlan:test-user', 'previous-plan');
    screen.send(); await screen.settle();
    assert.equal(screen.storage.get('fitnessPlan:test-user'), 'previous-plan');
  });
  test(`chat regression: ${delivery} out-of-order tool result reconciles call status`, async (t) => {
    const pair = toolPair();
    t.mock.method(globalThis, 'fetch', async () => delivery === 'json'
      ? json({ agentEvents: pair.toReversed() }) : sse([...pair.toReversed(), event('final')]));
    const screen = screenHarness(); screen.send();
    const messages = await screen.settle();
    assert.equal(messages.find((item) => item.text.includes('正在调用')).status, 'completed');
  });
}

test('chat regression: JSON execution error cannot save a plan and preserves process cards', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({ agentEvents: [
    ...toolPair(), event('error', { summary: '审核失败' }),
  ], plan }));
  const screen = screenHarness(); screen.storage.set('fitnessPlan:test-user', 'previous-plan');
  screen.send(); const messages = await screen.settle();
  assert.equal(screen.storage.get('fitnessPlan:test-user'), 'previous-plan');
  assert.match(screen.states[2], /审核失败/);
  assert.ok(messages.some((item) => item.text.includes('正在调用')));
});

test('chat regression: latest final plan replaces an earlier same-summary draft', async (t) => {
  const finalPlan = { ...plan, weeklySchedule: [{ mainBlocks: [{ exercises: [{ name: '卧推', sets: 4, reps: 8 }] }] }] };
  t.mock.method(globalThis, 'fetch', async () => json({ agentEvents: [
    event('tool_result', { toolCallId: 'draft', output: plan }),
    event('final', { output: { plan } }),
  ], plan: finalPlan }));
  const screen = screenHarness(); screen.send(); await screen.settle();
  assert.equal(JSON.parse(screen.storage.get('fitnessPlan:test-user')).exercises[0].name, '卧推');
});

test('chat regression: switching accounts aborts the previous request transport', async (t) => {
  let signal, finish;
  t.mock.method(globalThis, 'fetch', (_url, init) => {
    signal = init.signal; return new Promise((resolve) => { finish = resolve; });
  });
  const screen = screenHarness(); screen.send();
  screen.render({ token: 'other-token', userId: 'other-user' });
  assert.equal(signal?.aborted, true);
  finish(json({ text: 'late' })); await new Promise(setImmediate);
  assert.deepEqual(screen.states[0], []);
});

test('chat regression: unmount aborts the previous request transport', async (t) => {
  let signal, finish;
  t.mock.method(globalThis, 'fetch', (_url, init) => {
    signal = init.signal; return new Promise((resolve) => { finish = resolve; });
  });
  const screen = screenHarness(); screen.send(); screen.unmount();
  assert.equal(signal?.aborted, true);
  finish(json({ plan })); await new Promise(setImmediate);
  assert.equal(screen.storage.size, 0);
});

test('chat regression: invalid input is rejected before fetch without silent truncation', async (t) => {
  let count = 0;
  t.mock.method(globalThis, 'fetch', async () => { count++; return json({ text: 'answer' }); });
  for (const message of ['', ' \n\t ', '长'.repeat(2001), null, 42]) {
    await assert.rejects(api().sendAgentMessage('token', { message }), /输入|2000/);
  }
  assert.equal(count, 0);
});

function findByLabel(node, label) {
  if (!node || typeof node !== 'object') return null;
  if (node.props?.accessibilityLabel === label) return node;
  for (const child of React.Children.toArray(node.props?.children)) {
    const found = findByLabel(child, label); if (found) return found;
  }
  return null;
}

test('chat cancellation: visible stop cancels pending SSE and permits a fresh retry', async (t) => {
  let calls = 0, cancelled = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (calls++) return json({ text: '重试成功' });
    return new Response(new ReadableStream({ start(source) {
      source.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(toolPair()[0])}\n\n`));
    }, cancel() { cancelled++; } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const screen = screenHarness(); screen.send(); await new Promise(setImmediate); screen.render();
  const stop = findByLabel(screen.tree, '取消生成');
  assert.equal(stop?.props.accessibilityRole, 'button'); stop.props.onPress();
  const partial = await screen.settle();
  assert.equal(cancelled, 1); assert.match(screen.states[2], /已取消/);
  assert.ok(partial.every((item) => item.status === 'failed'));
  assert.equal(screen.storage.size, 0);
  screen.render(); screen.send('重新生成'); await screen.settle();
  assert.ok(screen.states[0].some((item) => item.text === '重试成功')); assert.equal(calls, 2);
});

test('chat history: interrupted partial answers are visible but excluded from retry context', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return requests.length === 1 ? sse([event('text', { text: '不完整建议' })]) : json({ text: '完整回复' });
  });
  const screen = screenHarness(); screen.send('第一个问题'); await screen.settle(); screen.render();
  const partial = screen.states[0].find((message) => message.text === '不完整建议');
  assert.equal(partial.status, 'failed'); assert.match(cardText(partial), /回复未完成/);
  screen.send('重试问题'); await screen.settle();
  assert.deepEqual(requests[1].chatHistory, [{ role: 'user', text: '第一个问题' }]);
});

test('chat history: ten turns keep the latest fourteen user/answer items in chronological order', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests.push(JSON.parse(init.body)); return json({ text: `answer-${requests.length}` });
  });
  const screen = screenHarness();
  for (let i = 1; i <= 10; i++) { screen.send(`user-${i}`); await screen.settle(); screen.render(); }
  const expected = Array.from({ length: 7 }, (_, i) => [
    { role: 'user', text: `user-${i + 3}` }, { role: 'assistant', text: `answer-${i + 3}` },
  ]).flat();
  assert.deepEqual(requests[9].chatHistory, expected);
  assert.equal(screen.states[0].length, 20); // UI still retains this mounted conversation.
});

for (const delivery of ['json', 'stream']) {
  for (const invalid of [null, { title: '空计划', weeklySchedule: [] }, { weeklySchedule: [{ mainBlocks: [{ exercises: [null, {}] }] }] }]) {
    test(`chat sync: ${delivery} invalid final plan ${JSON.stringify(invalid)} keeps previous Fitness data`, async (t) => {
      t.mock.method(globalThis, 'fetch', async () => delivery === 'json' ? json({ plan: invalid })
        : sse([event('final', { output: { plan: invalid } })]));
      const screen = screenHarness(); screen.storage.set('fitnessPlan:test-user', 'previous-plan');
      screen.send(); await screen.settle();
      assert.equal(screen.storage.get('fitnessPlan:test-user'), 'previous-plan');
      assert.match(screen.states[2], /有效动作|没有解析出/);
    });
  }
  test(`chat sync: ${delivery} plan still failing review is not synchronized`, async (t) => {
    const output = { plan, review: { status: 'needs-repair' } };
    t.mock.method(globalThis, 'fetch', async () => delivery === 'json' ? json(output) : sse([event('final', { output })]));
    const screen = screenHarness(); screen.storage.set('fitnessPlan:test-user', 'previous-plan');
    screen.send(); await screen.settle();
    assert.equal(screen.storage.get('fitnessPlan:test-user'), 'previous-plan');
    assert.match(screen.states[2], /未通过审核/);
  });
  test(`chat completion: ${delivery} tool without a result no longer stays running`, async (t) => {
    const events = [toolPair()[0], event('final')];
    t.mock.method(globalThis, 'fetch', async () => delivery === 'json' ? json({ agentEvents: events }) : sse(events));
    const screen = screenHarness(); screen.send(); const messages = await screen.settle();
    assert.equal(messages.find((item) => item.text.includes('正在调用')).status, 'failed');
  });
}

test('chat sync: successful plan notifies Fitness subscriber only for the signed-in owner', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({ plan }));
  const screen = screenHarness(), service = screen.load('services/fitness-plan.ts');
  const own = [], other = [];
  const unsub = service.subscribeToFitnessPlan('test-user', (value) => own.push(value));
  const unsubOther = service.subscribeToFitnessPlan('other-user', (value) => other.push(value));
  screen.send(); await screen.settle();
  assert.equal(own.length, 1); assert.equal(own[0].title, plan.title); assert.deepEqual(other, []);
  unsub(); unsubOther();
});

test('chat sync: storage failure retains generated cards and offers explicit sync feedback', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({ plan }));
  const screen = screenHarness({}, { '@react-native-async-storage/async-storage': {
    getItem: async () => null, setItem: async () => { throw new Error('disk full'); },
  } });
  screen.send(); const messages = await screen.settle();
  assert.ok(messages.some((message) => message.title === plan.title));
  assert.match(screen.states[2], /同步到 Fitness 页失败/); assert.equal(screen.states[3], false);
});

test('chat input: blank, non-string, long and missing-account inputs make no request and keep draft', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return json({ text: '完成' }); });
  const screen = screenHarness();
  screen.chat.props.textInputProps.onChangeText('保留草稿');
  for (const input of [' \n ', null, 42, '长'.repeat(2001)]) screen.send(input);
  assert.equal(screen.states[1], '保留草稿'); assert.equal(screen.states[0].length, 0);
  assert.match(screen.states[2], /2000/);
  const unidentified = screenHarness({ userId: null }); unidentified.send();
  assert.match(unidentified.states[2], /账号身份/); assert.equal(calls, 0);
});
