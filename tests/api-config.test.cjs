const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/load-app.cjs');

function config(os = 'web', constants = {}, env = {}) {
  return loadApp({
    'react-native': { Platform: { OS: os } },
    'expo-constants': constants,
  }, env).load('services/api-config.ts');
}

test('API configuration: Web and iOS reach the default Bun port', () => {
  for (const os of ['web', 'ios']) {
    assert.equal(config(os).getApiBaseUrl(), 'http://127.0.0.1:3000');
  }
});

test('API configuration: Android emulator reaches the host default Bun port', () => {
  assert.equal(config('android').getApiBaseUrl(), 'http://10.0.2.2:3000');
});

test('API configuration: Expo LAN host uses API port instead of Metro port', () => {
  assert.equal(config('android', { expoConfig: { hostUri: '192.168.1.42:8081' } }).getApiBaseUrl(),
    'http://192.168.1.42:3000');
  assert.equal(config('web', { expoGoConfig: { debuggerHost: 'http://192.168.1.43:8081/path' } }).getApiBaseUrl(),
    'http://192.168.1.43:3000');
});

test('API configuration: localhost Expo host keeps platform fallback', () => {
  assert.equal(config('android', { expoConfig: { hostUri: 'localhost:8081' } }).getApiBaseUrl(),
    'http://10.0.2.2:3000');
});

test('API configuration: explicit API URL overrides inferred host and default port', () => {
  assert.equal(config('android', { expoConfig: { hostUri: '192.168.1.42:8081' } }, {
    EXPO_PUBLIC_API_BASE_URL: ' https://api.example.test:9443/ ',
  }).getApiBaseUrl(), 'https://api.example.test:9443');
});

test('API configuration: blank override falls back and connection errors identify the default endpoint', () => {
  const api = config('web', {}, { EXPO_PUBLIC_API_BASE_URL: '  ' });
  assert.equal(api.getApiBaseUrl(), 'http://127.0.0.1:3000');
  assert.match(api.createApiConnectionError('/api/auth/login').message,
    /http:\/\/127\.0\.0\.1:3000\/api\/auth\/login/);
});
