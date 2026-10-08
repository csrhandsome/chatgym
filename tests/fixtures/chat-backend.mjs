// Isolated real backend/router/workflows/SDK, with provider HTTP and Mem0 mocked.
// Never uses the default backend port, persistent users database, or external model.
import { createHarness, validPlan, recommendToolReply, withModelReplies } from '../../../chatgym_server/tests/api/fixtures.ts';
const h = createHarness();
const app = h.app.compile();
const rows = [];
let queue = Promise.resolve();
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/__chat-audit/metrics') return Response.json({ rows });
    if (!path.startsWith('/api/agent/plan')) return app.handle(request);
    let input;
    try { input = await request.clone().json(); } catch { return app.handle(request); }
    const note = input.goal?.requestNote ?? '';
    let release;
    const before = queue;
    queue = new Promise((resolve) => { release = resolve; });
    await before;
    try {
      if (note.includes('取消')) await new Promise((resolve) => setTimeout(resolve, 3500));
      const dailyPlan = validPlan(1);
      const session = dailyPlan.weeklySchedule[0];
      session.dayIndex = input.calendar.dayIndex;
      session.dayLabel = `周${'一二三四五六日'[session.dayIndex - 1]}`;
      dailyPlan.title = `${input.calendar.localDate} ${session.dayLabel}胸部训练`;
      dailyPlan.summary = '保持肩胛稳定，控制下放。';
      const exercise = session.mainBlocks[0].exercises[0];
      session.mainBlocks[0].exercises = ['卧推', '蝴蝶飞鸟', '龙门架夹胸'].map((name) => ({ ...exercise, name, sets: 3 }));
      const replies = note.includes('失败') ? [{ httpError: 400, message: 'chat audit provider failure' }]
        : [recommendToolReply, JSON.stringify(dailyPlan)];
      const { value, calls } = await withModelReplies(replies, async () => {
        const response = await app.handle(request);
        // Wait until the real SSE workflow finishes before restoring provider
        // mocks; then deliver the unchanged protocol body to the client.
        return { status: response.status, headers: response.headers, text: await response.text() };
      });
      rows.push({ path, message: note, historyLength: input.chatHistory?.length ?? 0,
        status: value.status, modelCalls: calls.length, externalModelCalls: 0,
        toolEvents: (value.text.match(/"type":"tool_result"/g) ?? []).length,
        finalEvents: (value.text.match(/"type":"final"/g) ?? []).length });
      return new Response(value.text, { status: value.status, headers: value.headers });
    } finally { release(); }
  },
});
await Bun.write('/tmp/gym-chat-audit/backend-port', String(server.port));
console.log(`gym-chat isolated backend ready port=${server.port}; external models disabled`);
