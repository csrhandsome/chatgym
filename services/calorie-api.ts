import { Platform } from 'react-native';
import type { CameraCapturedPicture } from 'expo-camera';

import { analyzeFitnessImages, type AgentConsoleEvent } from '@/services/agent-api';
import { BackendApiError, getStoredUserToken } from '@/services/backend-api';

const DEFAULT_ANALYSIS_PROMPT =
  '请分析这张图片，优先判断是否为食物，并给出尽可能稳妥的热量估算与简要结论。';

export type CalorieAnalysisResult = {
  agentEvents?: AgentConsoleEvent[];
  calories: number | null;
  raw: unknown;
  summary: string | null;
  title: string | null;
};

type MealPhotoSession = {
  token: string;
  isCurrent: () => boolean;
  signal?: AbortSignal;
};

const ANALYSIS_TIMEOUT_MS = 60_000;

export async function analyzeMealPhoto(
  picture: CameraCapturedPicture,
  session?: MealPhotoSession
): Promise<CalorieAnalysisResult> {
  const token = session?.token ?? await getStoredUserToken();
  if (!token) {
    throw new BackendApiError('请先登录，再识别食物热量。', 401);
  }
  assertCurrentSession(session);
  return await withCameraRequest(session?.signal, async (signal) => {
    const imageDataUrl = await toDataUrl(picture.uri, signal);
    assertCurrentSession(session);
    const result = await analyzeFitnessImages(token, {
      images: [
        {
          detail: 'low',
          image: imageDataUrl,
          purpose: 'food calorie estimate',
        },
      ],
      preferredTask: 'food_calorie_estimate',
      prompt: DEFAULT_ANALYSIS_PROMPT,
    }, { signal });
    assertCurrentSession(session);

    const payload = isRecord(result.payload) ? result.payload : null;
    if (!payload || (!Array.isArray(payload.results) && !coerceText(payload.summary))) {
      throw new Error('识别响应为空或格式异常，请重新上传，照片已保留。');
    }
    const firstInsight =
      payload && Array.isArray(payload.results) && isRecord(payload.results[0]) ? payload.results[0] : null;
    const foodAnalysis = firstInsight && isRecord(firstInsight.foodAnalysis) ? firstInsight.foodAnalysis : null;
    const firstFoodItem =
      foodAnalysis && Array.isArray(foodAnalysis.items) && isRecord(foodAnalysis.items[0])
        ? foodAnalysis.items[0]
        : null;

    const lowCalories = coerceNumber(foodAnalysis?.totalCaloriesLow ?? firstFoodItem?.caloriesLow);
    const highCalories = coerceNumber(foodAnalysis?.totalCaloriesHigh ?? firstFoodItem?.caloriesHigh);

    return {
      agentEvents: result.events,
      calories: averageCalories(lowCalories, highCalories),
      raw: result.payload,
      summary: coerceText(payload?.summary) ?? null,
      title: coerceText(firstFoodItem?.name) ?? null,
    };
  });
}

// Keep cancellation local to the camera: shared chat/plan transports have their own lifecycle.
async function withCameraRequest<T>(parent: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  parent?.addEventListener('abort', cancel, { once: true });
  if (parent?.aborted) cancel();
  const timer = setTimeout(() => { timedOut = true; cancel(); }, ANALYSIS_TIMEOUT_MS);
  let rejectAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(new Error(timedOut
      ? '识别超时，请重新上传，照片已保留。'
      : '识别已取消，照片已保留。'));
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
    if (controller.signal.aborted) rejectAbort();
  });
  try {
    return await Promise.race([aborted, Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new Error('识别已取消。');
      return run(controller.signal);
    })]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', rejectAbort);
  }
}

function assertCurrentSession(session: MealPhotoSession | undefined) {
  if (session && !session.isCurrent()) {
    throw new BackendApiError('登录状态已改变，请登录后重试。', 401);
  }
}

async function toDataUrl(uri: string, signal: AbortSignal): Promise<string> {
  if (uri.startsWith('data:')) {
    if (!/^data:image\/(?:jpeg|png|webp);base64,[a-z\d+/]+={0,2}$/i.test(uri)) {
      throw new Error('照片格式无效，请重新拍摄。');
    }
    return uri;
  }

  const response = await fetch(uri, { signal });
  if (!response.ok) throw new Error('图片读取失败，请重新拍摄。');
  const blob = await response.blob();
  if (!blob.size || (blob.type && !/^image\/(jpeg|png|webp)$/i.test(blob.type))) {
    throw new Error('照片为空或格式无效，请重新拍摄。');
  }

  return await blobToDataUrl(blob, signal);
}

async function blobToDataUrl(blob: Blob, signal: AbortSignal): Promise<string> {
  if (Platform.OS !== 'web' && typeof FileReader === 'undefined') {
    const arrayBuffer = await blob.arrayBuffer();
    return `data:${blob.type || 'image/jpeg'};base64,${arrayBufferToBase64(arrayBuffer)}`;
  }

  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => reader.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { signal.removeEventListener('abort', abort); reject(new Error('图片读取已取消。')); return; }

    reader.onabort = () => reject(new Error('图片读取已取消。'));
    reader.onerror = () => { signal.removeEventListener('abort', abort); reject(new Error('图片读取失败，暂时无法上传到视觉分析接口。')); };
    reader.onloadend = () => {
      signal.removeEventListener('abort', abort);
      if (typeof reader.result === 'string') {
        resolve(reader.result);
        return;
      }

      reject(new Error('图片编码失败，暂时无法上传到视觉分析接口。'));
    };

    reader.readAsDataURL(blob);
  });
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function averageCalories(low: number | null, high: number | null): number | null {
  if (low == null && high == null) {
    return null;
  }

  if (low != null && high != null) {
    return Math.round((low + high) / 2);
  }

  return low ?? high;
}

function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  return null;
}

function coerceText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
