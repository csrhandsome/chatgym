import { Platform } from 'react-native';
import type { CameraCapturedPicture } from 'expo-camera';

import { analyzeFitnessImages, type AgentConsoleEvent } from '@/services/agent-api';

const DEFAULT_ANALYSIS_PROMPT =
  '请分析这张图片，优先判断是否为食物，并给出尽可能稳妥的热量估算与简要结论。';

export type CalorieAnalysisResult = {
  agentEvents?: AgentConsoleEvent[];
  calories: number | null;
  raw: unknown;
  summary: string | null;
  title: string | null;
};

export async function analyzeMealPhoto(
  picture: CameraCapturedPicture
): Promise<CalorieAnalysisResult> {
  const imageDataUrl = await toDataUrl(picture.uri);
  const result = await analyzeFitnessImages(null, {
    images: [
      {
        detail: 'low',
        image: imageDataUrl,
        purpose: 'food calorie estimate',
      },
    ],
    preferredTask: 'food_calorie_estimate',
    prompt: DEFAULT_ANALYSIS_PROMPT,
  });

  const payload = isRecord(result.payload) ? result.payload : null;
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
    title: coerceText(firstFoodItem?.name) ?? coerceText(payload?.task) ?? null,
  };
}

async function toDataUrl(uri: string): Promise<string> {
  if (uri.startsWith('data:')) {
    return uri;
  }

  const response = await fetch(uri);
  const blob = await response.blob();

  return await blobToDataUrl(blob);
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  if (Platform.OS !== 'web' && typeof FileReader === 'undefined') {
    const arrayBuffer = await blob.arrayBuffer();
    return `data:${blob.type || 'image/jpeg'};base64,${arrayBufferToBase64(arrayBuffer)}`;
  }

  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => reject(new Error('图片读取失败，暂时无法上传到视觉分析接口。'));
    reader.onloadend = () => {
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
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
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
