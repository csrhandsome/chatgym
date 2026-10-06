// Optional read-only contract audit: run with Bun when ../chatgym_server exists.
// Imports the actual backend routes, uses an isolated in-memory runtime, and
// intercepts workflow generation so no model provider or existing DB is used.
import { mock } from 'bun:test';

const server = new URL('../../chatgym_server/src/', import.meta.url);
const readModule = (relative) => import(new URL(relative, server).href);
let modelCalls = 0;
const payload = { text: 'audit-only' };
const fakeGenerate = async ({ onEvent }) => {
  modelCalls += 1;
  onEvent?.({
    id: crypto.randomUUID(), requestId: crypto.randomUUID(),
    timestamp: new Date().toISOString(), type: 'final', summary: 'audit-only', output: payload,
  });
  return payload;
};
mock.module(new URL('agent/planning/workflows/generate-training-plan.ts', server).pathname, () => ({
  generatePlanningResponse: fakeGenerate,
  generateTrainingPlan: fakeGenerate,
}));
mock.module(new URL('agent/vlm/workflows/analyze-fitness-images.ts', server).pathname, () => ({
  analyzeFitnessImages: fakeGenerate,
}));

const [{ createApp }, { UserStore }, { TextStore }, { TextStreamHub }, { WorkoutMemoryStore }] =
  await Promise.all([
    readModule('app.ts'), readModule('services/user-store.ts'), readModule('services/text-store.ts'),
    readModule('services/text-stream-hub.ts'), readModule('agent/shared/workout-memory-store.ts'),
  ]);
const { FakeMem0Adapter } = await import(
  new URL('../../chatgym_server/tests/helpers/fake-mem0-adapter.ts', import.meta.url).href
);
const app = createApp({
  serviceName: 'chatgym-audit', startedAt: new Date(), userStore: new UserStore(),
  textStore: new TextStore(), textStreamHub: new TextStreamHub(),
  workoutMemoryStore: new WorkoutMemoryStore(new FakeMem0Adapter()),
}).compile();

const rows = [];
for (const path of ['/api/agent/plan', '/api/agent/plan/stream', '/api/agent/vlm/analyze', '/api/agent/vlm/analyze/stream']) {
  for (const token of [null, 'invalid-audit-token']) {
    const response = await app.handle(new Request(`http://localhost${path}`, {
      method: 'POST', body: '{}', headers: {
        'Content-Type': 'application/json', Accept: 'text/event-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }));
    rows.push({ path, auth: token ? 'invalid-token' : 'anonymous', status: response.status, body: await response.json() });
    if (response.status !== 401) throw new Error(`Expected 401 for ${path}`);
  }
}

// Create a disposable user only in this runtime, then verify that Accept does
// not select the stream route. A real schema-valid frontend request is used.
const registration = await app.handle(new Request('http://localhost/api/auth/register', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'audit_user', password: 'audit-password-123' }),
}));
if (!registration.ok) throw new Error(`Disposable registration failed: ${registration.status}`);
const { token } = await registration.json();
const planRequest = {
  currentState: { soreness: [] }, goal: { primary: 'general_fitness', requestNote: '测试', secondary: [], targetAreas: [] },
  preferences: { avoidExercises: [], equipment: [], preferredExercises: [], workoutLocation: 'gym' },
  rememberedWorkouts: [], schedule: { availableDaysPerWeek: 3, preferredDays: [], sessionDurationMinutes: 60 },
  user: { id: 'chatgym-user', injuries: [], limitations: [], trainingExperience: 'intermediate' },
};
for (const path of ['/api/agent/plan', '/api/agent/plan/stream']) {
  const response = await app.handle(new Request(`http://localhost${path}`, {
    method: 'POST', headers: {
      'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${token}`,
    }, body: JSON.stringify(planRequest),
  }));
  const contentType = response.headers.get('content-type') ?? '';
  const body = await response.text();
  const streams = path.endsWith('/stream');
  if (response.status !== 200 || contentType.includes('text/event-stream') !== streams) {
    throw new Error(`Unexpected response for ${path}: ${response.status} ${contentType}`);
  }
  rows.push({ path, auth: 'disposable-user', status: response.status, contentType, body });
}
console.log(JSON.stringify({ rows, workflowMocksCalled: modelCalls, externalModelCalls: 0 }, null, 2));
