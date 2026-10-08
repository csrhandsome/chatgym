const requestId = '10000000-0000-4000-8000-000000000000';
let sequence = 0;
function event(type, extra = {}) {
  sequence += 1;
  return {
    id: `20000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    requestId,
    timestamp: '2026-10-05T06:00:00.000Z',
    type,
    summary: `Agent ${type}`,
    ...extra,
  };
}

const plan = {
  title: '测试训练计划',
  summary: '每周三次训练',
  weeklySchedule: [{
    dayIndex: new Date().getDay() || 7,
    dayLabel: `周${'日一二三四五六'[new Date().getDay()]}`,
    mainBlocks: [{
      title: '力量训练',
      exercises: [{ name: '杠铃深蹲', sets: 3, reps: 10 }],
    }],
  }],
  progressionRules: ['逐步增加重量'],
};

function toolPair(callId = 'call-1') {
  return [
    event('tool_call', {
      toolCallId: callId,
      toolName: 'recommendExercises',
      summary: '正在调用工具：动作推荐。',
      input: { target: '腿部' },
    }),
    event('tool_result', {
      toolCallId: callId,
      toolName: 'recommendExercises',
      summary: '已收到工具结果：动作推荐。',
      output: { exercises: ['杠铃深蹲'] },
    }),
  ];
}

function sse(events, options = {}) {
  const newline = options.crlf ? '\r\n' : '\n';
  const body = ': connected\n\n' + events.map((item) =>
    `event: ${item.type}${newline}data: ${JSON.stringify(item)}${newline}${newline}`
  ).join('');
  const bytes = new TextEncoder().encode(body);
  const size = options.packetSize ?? bytes.length;
  return new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += size) {
        controller.enqueue(bytes.slice(offset, offset + size));
      }
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}

module.exports = { event, plan, toolPair, sse };
