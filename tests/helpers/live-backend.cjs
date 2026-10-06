const { spawn } = require('node:child_process');
const path = require('node:path');

// Real sibling Bun routes with disposable stores and an isolated dynamic port.
// This never changes backend source or starts model requests.
async function startLiveBackend(env = {}) {
  const serverRoot = path.resolve(__dirname, '../../../chatgym_server/src');
  const modulePath = (relative) => JSON.stringify(path.join(serverRoot, relative));
  const source = `
    import { createApp } from ${modulePath('app.ts')};
    import { UserStore } from ${modulePath('services/user-store.ts')};
    import { TextStore } from ${modulePath('services/text-store.ts')};
    import { TextStreamHub } from ${modulePath('services/text-stream-hub.ts')};
    import { WorkoutMemoryStore } from ${modulePath('agent/shared/workout-memory-store.ts')};
    import { FakeMem0Adapter } from ${modulePath('../tests/helpers/fake-mem0-adapter.ts')};
    const app = createApp({ serviceName: 'frontend-login-test', startedAt: new Date(),
      userStore: new UserStore(), textStore: new TextStore(), textStreamHub: new TextStreamHub(),
      workoutMemoryStore: new WorkoutMemoryStore(new FakeMem0Adapter()) });
    app.listen({ hostname: '127.0.0.1', port: 0 });
    console.log('LOGIN_TEST_URL=' + app.server.url.href);
  `;
  const child = spawn('bun', ['--eval', source], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env },
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGTERM'); });
    }
  };
  try {
    const baseUrl = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Test backend startup timed out')), 15000);
      const cleanup = () => {
        clearTimeout(timer); child.off('error', onError); child.off('exit', onExit); child.stdout.off('data', onData);
      };
      const onError = (error) => { cleanup(); reject(error); };
      const onExit = (code) => { cleanup(); reject(new Error(`Test backend exited ${code}`)); };
      const onData = (data) => {
        output += data.toString();
        const match = output.match(/LOGIN_TEST_URL=(http:\/\/[^\s]+)/);
        if (match) { cleanup(); resolve(match[1].replace(/\/$/, '')); }
      };
      // Drain logs without exposing environment configuration or tokens.
      child.stderr.resume();
      child.once('error', onError); child.once('exit', onExit); child.stdout.on('data', onData);
    });
    return { baseUrl, stop };
  } catch (error) {
    await stop(); throw error;
  }
}

module.exports = { startLiveBackend };
