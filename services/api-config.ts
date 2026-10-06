import Constants from 'expo-constants';
import { Platform } from 'react-native';

const API_PORT = '3000';
const LOCALHOST_BASE_URL = `http://127.0.0.1:${API_PORT}`;
const ANDROID_EMULATOR_BASE_URL = `http://10.0.2.2:${API_PORT}`;

export function getApiBaseUrl(): string {
  const normalizedEnvValue = normalizeApiBaseUrl(process.env.EXPO_PUBLIC_API_BASE_URL);

  if (normalizedEnvValue) {
    return normalizedEnvValue;
  }

  return inferExpoDevHostBaseUrl() ?? getPlatformFallbackBaseUrl();
}

export function createApiConnectionError(path: string, cause?: unknown): Error {
  const requestUrl = `${getApiBaseUrl()}${path}`;
  const causeMessage = cause instanceof Error ? cause.message.trim() : '';
  const details = causeMessage ? ` 原始错误：${causeMessage}` : '';

  return new Error(`无法连接到 ${requestUrl}。${details}`.trim());
}

function normalizeApiBaseUrl(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim().replace(/\/$/, '');
  return trimmed || null;
}

function inferExpoDevHostBaseUrl(): string | null {
  const hostUri = getExpoHostUri();

  if (!hostUri) {
    return null;
  }

  const hostname = extractHostname(hostUri);

  if (!hostname || hostname === '127.0.0.1' || hostname === 'localhost') {
    return null;
  }

  return `http://${hostname}:${API_PORT}`;
}

function getExpoHostUri(): string | null {
  const expoGoConfig = isRecord(Constants.expoGoConfig) ? Constants.expoGoConfig : null;

  const candidates = [
    Constants.expoConfig?.hostUri,
    Constants.platform?.hostUri,
    getOptionalString(expoGoConfig?.debuggerHost),
  ];

  for (const candidate of candidates) {
    const normalizedCandidate = getOptionalString(candidate);

    if (normalizedCandidate) {
      return normalizedCandidate;
    }
  }

  return null;
}

function extractHostname(value: string): string | null {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  const withoutScheme = trimmed.replace(/^[a-z]+:\/\//i, '');
  const host = withoutScheme.split('/')[0]?.split(':')[0]?.trim();

  return host || null;
}

function getPlatformFallbackBaseUrl(): string {
  return Platform.OS === 'android' ? ANDROID_EMULATOR_BASE_URL : LOCALHOST_BASE_URL;
}

function getOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
