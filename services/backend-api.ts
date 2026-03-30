import AsyncStorage from '@react-native-async-storage/async-storage';

import { extractFitnessPlan, type FitnessPlan } from '@/services/fitness-plan';

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL?.replace(/\/$/, '');
const AUTH_LOGIN_API_PATH = '/api/auth/login';
const AUTH_REGISTER_API_PATH = '/api/auth/register';
const PLAN_API_PATH = normalizeApiPath(process.env.EXPO_PUBLIC_PLAN_API_PATH) ?? '/api/agent/plan';
const CHAT_API_PATH = normalizeApiPath(process.env.EXPO_PUBLIC_CHAT_API_PATH) ?? PLAN_API_PATH;

export const AUTH_TOKEN_STORAGE_KEY = 'userToken';

export type LoginCredentials = {
  password: string;
  username: string;
};

export type LoginResponse = Record<string, unknown> & {
  token: string;
};

export type ChatMessageKind = 'answer' | 'thought' | 'tool';

export type ChatHistoryItem = {
  kind?: ChatMessageKind | 'user';
  role: 'assistant' | 'user';
  text: string;
  title?: string;
};

export type ChatResponseChunk = {
  fitnessPlan?: FitnessPlan;
  id: string;
  kind: ChatMessageKind;
  text: string;
  title?: string;
};

type JsonRequestInit = Omit<RequestInit, 'headers'> & {
  headers?: Record<string, string>;
};

export async function register(credentials: LoginCredentials): Promise<LoginResponse> {
  return await authenticate(AUTH_REGISTER_API_PATH, credentials);
}

export async function login(credentials: LoginCredentials): Promise<LoginResponse> {
  return await authenticate(AUTH_LOGIN_API_PATH, credentials);
}

export async function generatePlan(
  token: string,
  input: Record<string, unknown> = {}
): Promise<unknown> {
  return await requestJson(PLAN_API_PATH, {
    body: JSON.stringify(input),
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });
}

export async function sendChatMessage(
  token: string,
  input: {
    history?: ChatHistoryItem[];
    message: string;
  }
): Promise<ChatResponseChunk[]> {
  const payload = await requestJson(CHAT_API_PATH, {
    body: JSON.stringify(
      usesAgentPlanEndpoint(CHAT_API_PATH)
        ? createAgentPlanPayload(input)
        : {
            history: input.history ?? [],
            message: input.message,
          }
    ),
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });

  const chunks = normalizeChatPayload(payload);

  if (chunks.length === 0) {
    throw new Error('已收到回复，但暂时无法整理成可展示的内容。');
  }

  return chunks;
}

export async function getStoredUserToken(): Promise<string | null> {
  return await AsyncStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
}

export async function storeUserToken(token: string): Promise<void> {
  await AsyncStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
}

export async function clearStoredUserToken(): Promise<void> {
  await AsyncStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
}

async function requestJson(path: string, init: JsonRequestInit = {}): Promise<unknown> {
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...init.headers,
    },
  });

  const payload = await parseResponseBody(response);

  if (!response.ok) {
    throw new Error(
      toUserFacingServiceMessage(
        extractMessage(payload),
        response.status === 401
          ? '登录状态已失效，请重新登录。'
          : response.status === 403
            ? '当前账号暂时无法执行这个操作。'
            : '服务暂时不可用，请稍后再试。'
      )
    );
  }

  return payload;
}

type ChatChunkDraft = Omit<ChatResponseChunk, 'id'>;

function normalizeApiPath(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function normalizeChatPayload(payload: unknown): ChatResponseChunk[] {
  const draftChunks = dedupeChatChunks(collectChatChunks(payload));
  const baseTimestamp = Date.now();

  return draftChunks.map((chunk, index) => ({
    ...chunk,
    id: `chat-${baseTimestamp}-${index}`,
  }));
}

function collectChatChunks(payload: unknown): ChatChunkDraft[] {
  if (typeof payload === 'string') {
    const text = payload.trim();
    return text ? [{ kind: 'answer', text }] : [];
  }

  if (Array.isArray(payload)) {
    return payload.flatMap((item) => collectChatChunks(item));
  }

  if (!isRecord(payload)) {
    return [];
  }

  const nestedCandidates = [
    payload.events,
    payload.messages,
    payload.items,
    payload.steps,
    payload.agentSteps,
    payload.chunks,
    payload.trace,
    payload.results,
    payload.outputs,
    payload.plan,
    payload.memory,
    payload.review,
    payload.imageContext,
    payload.data,
  ];

  const nestedChunks = nestedCandidates.flatMap((candidate) => collectChatChunks(candidate));

  if (nestedChunks.length > 0) {
    return [...nestedChunks, ...collectChatChunksFromRecord(payload)];
  }

  return collectChatChunksFromRecord(payload);
}

function collectChatChunksFromRecord(payload: Record<string, unknown>): ChatChunkDraft[] {
  const agentStepChunks = collectAgentStepChunks(payload);
  const planChunk = createPlanChunk(payload);

  if (agentStepChunks.length > 0 || planChunk) {
    const textChunk = collectTextChunkFromRecord(payload);

    return [
      ...agentStepChunks,
      ...(planChunk ? [planChunk] : []),
      ...(textChunk ? [textChunk] : []),
    ];
  }

  const explicitKind = inferChatChunkKind(payload);

  if (explicitKind === 'user') {
    return [];
  }

  if (explicitKind) {
    const text = extractTextForKind(payload, explicitKind);

    if (text) {
      return [
        {
          fitnessPlan:
            explicitKind === 'tool'
              ? extractFitnessPlan(payload, {
                  fallbackTitle: extractChatChunkTitle(payload, explicitKind),
                  sourceTitle: extractChatChunkTitle(payload, explicitKind),
                }) ?? undefined
              : undefined,
          kind: explicitKind,
          text,
          title: extractChatChunkTitle(payload, explicitKind),
        },
      ];
    }
  }

  const chunks: ChatChunkDraft[] = [];

  pushChatChunk(
    chunks,
    'thought',
    extractFirstText([
      payload.thought,
      payload.thinking,
      payload.reasoning,
      payload.analysis,
      payload.agentThought,
      payload.agent_thought,
      payload.deliberation,
    ]),
    extractChatChunkTitle(payload, 'thought')
  );

  const toolValue =
    payload.tool ??
    payload.toolCall ??
    payload.tool_call ??
    payload.toolOutput ??
    payload.tool_output ??
    payload.toolResult ??
    payload.tool_result ??
    payload.observation;

  pushChatChunk(
    chunks,
    'tool',
    isRecord(toolValue) ? formatToolText(toolValue) : coerceChatText(toolValue),
    extractChatChunkTitle(isRecord(toolValue) ? toolValue : payload, 'tool'),
    extractFitnessPlan(toolValue ?? payload, {
      fallbackTitle: extractChatChunkTitle(isRecord(toolValue) ? toolValue : payload, 'tool'),
      sourceTitle: extractChatChunkTitle(isRecord(toolValue) ? toolValue : payload, 'tool'),
    }) ?? undefined
  );

  pushChatChunk(
    chunks,
    'answer',
    extractFirstText([
      payload.answer,
      payload.finalAnswer,
      payload.final_answer,
      payload.response,
      payload.output,
      payload.result,
      payload.content,
      payload.text,
      payload.message,
    ]),
    extractChatChunkTitle(payload, 'answer')
  );

  return chunks;
}

function collectAgentStepChunks(payload: Record<string, unknown>): ChatChunkDraft[] {
  const hasAgentStepShape =
    Array.isArray(payload.toolCalls) ||
    Array.isArray(payload.toolResults) ||
    typeof payload.stepNumber === 'number' ||
    typeof payload.finishReason === 'string';

  if (!hasAgentStepShape) {
    return [];
  }

  const chunks: ChatChunkDraft[] = [];
  const stepLabel =
    typeof payload.stepNumber === 'number' ? `第 ${payload.stepNumber + 1} 步` : '思路整理';

  if (typeof payload.summary === 'string' && payload.summary.trim()) {
    chunks.push({
      kind: 'thought',
      text: payload.summary.trim(),
      title: stepLabel,
    });
  }

  if (Array.isArray(payload.toolCalls)) {
    for (const toolCall of payload.toolCalls) {
      if (!isRecord(toolCall)) {
        continue;
      }

      const text = formatAgentToolCall(toolCall);
      const toolTitle =
        normalizeChunkTitle(
          extractFirstText([toolCall.name, toolCall.toolName, toolCall.title, toolCall.label]) ??
            '信息整理',
          'tool'
        ) ?? '信息整理';

      if (!text) {
        continue;
      }

      chunks.push({
        fitnessPlan: extractFitnessPlanFromToolEnvelope(toolCall, toolTitle),
        kind: 'tool',
        text,
        title: toolTitle,
      });
    }
  }

  if (Array.isArray(payload.toolResults)) {
    for (const toolResult of payload.toolResults) {
      if (!isRecord(toolResult)) {
        continue;
      }

      const text = formatAgentToolResult(toolResult);
      const toolTitle =
        normalizeChunkTitle(
          extractFirstText([
            toolResult.name,
            toolResult.toolName,
            toolResult.title,
            toolResult.label,
          ]) ?? '处理结果',
          'tool'
        ) ?? '处理结果';

      if (!text) {
        continue;
      }

      chunks.push({
        fitnessPlan: extractFitnessPlanFromToolEnvelope(toolResult, toolTitle),
        kind: 'tool',
        text,
        title: toolTitle,
      });
    }
  }

  return chunks;
}

function createPlanChunk(payload: Record<string, unknown>): ChatChunkDraft | null {
  const plan = extractFitnessPlan(payload, {
    fallbackTitle: '训练计划',
    sourceTitle: extractFirstText([payload.title, payload.name, payload.label]) ?? '训练计划',
  });

  if (!plan || !looksLikePlanRecord(payload)) {
    return null;
  }

  const text = formatPlanSummaryText(payload, plan);

  if (!text) {
    return null;
  }

  return {
    fitnessPlan: plan,
    kind: 'tool',
    text,
    title: plan.title,
  };
}

function collectTextChunkFromRecord(payload: Record<string, unknown>): ChatChunkDraft | null {
  const explicitKind = inferChatChunkKind(payload);

  if (explicitKind === 'user') {
    return null;
  }

  const kind = explicitKind ?? 'answer';
  const text =
    kind === 'answer'
      ? extractTextForKind(payload, 'answer')
      : kind === 'tool'
        ? extractTextForKind(payload, 'tool')
        : extractTextForKind(payload, 'thought');

  if (!text) {
    return null;
  }

  return {
    fitnessPlan:
      kind === 'tool'
        ? extractFitnessPlan(payload, {
            fallbackTitle: extractChatChunkTitle(payload, kind),
            sourceTitle: extractChatChunkTitle(payload, kind),
          }) ?? undefined
        : undefined,
    kind,
    text,
    title: extractChatChunkTitle(payload, kind),
  };
}

function pushChatChunk(
  chunks: ChatChunkDraft[],
  kind: ChatMessageKind,
  text: string | null,
  title?: string,
  fitnessPlan?: FitnessPlan
) {
  if (!text) {
    return;
  }

  chunks.push({
    fitnessPlan,
    kind,
    text,
    title,
  });
}

function inferChatChunkKind(
  payload: Record<string, unknown>
): ChatMessageKind | 'user' | null {
  const keyword = extractFirstKeyword([
    payload.kind,
    payload.type,
    payload.role,
    payload.messageType,
    payload.message_type,
    payload.event,
  ]);

  if (!keyword) {
    return null;
  }

  if (keyword === 'user' || keyword === 'human') {
    return 'user';
  }

  if (
    keyword.includes('tool') ||
    keyword === 'observation' ||
    keyword === 'function_call'
  ) {
    return 'tool';
  }

  if (
    keyword.includes('thought') ||
    keyword.includes('reason') ||
    keyword === 'thinking' ||
    keyword === 'analysis' ||
    keyword === 'reflection'
  ) {
    return 'thought';
  }

  if (
    keyword === 'assistant' ||
    keyword === 'answer' ||
    keyword === 'final' ||
    keyword === 'response' ||
    keyword === 'message' ||
    keyword === 'output'
  ) {
    return 'answer';
  }

  return null;
}

function extractFirstKeyword(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }

    const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');

    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function extractTextForKind(
  payload: Record<string, unknown>,
  kind: ChatMessageKind
): string | null {
  switch (kind) {
    case 'thought':
      return extractFirstText([
        payload.thought,
        payload.thinking,
        payload.reasoning,
        payload.analysis,
        payload.agentThought,
        payload.agent_thought,
        payload.deliberation,
        payload.content,
        payload.text,
        payload.message,
      ]);
    case 'tool':
      return formatToolText(payload);
    case 'answer':
      return extractFirstText([
        payload.answer,
        payload.finalAnswer,
        payload.final_answer,
        payload.response,
        payload.output,
        payload.result,
        payload.content,
        payload.text,
        payload.message,
      ]);
  }
}

function extractChatChunkTitle(
  payload: Record<string, unknown>,
  kind: ChatMessageKind
): string | undefined {
  const title =
    kind === 'tool'
      ? extractFirstText([
          payload.toolName,
          payload.tool_name,
          payload.name,
          payload.title,
          payload.label,
        ])
      : extractFirstText([payload.title, payload.label, payload.name]);

  return normalizeChunkTitle(title, kind);
}

function formatToolText(payload: Record<string, unknown>): string | null {
  const sections = [
    createToolSection('处理说明', payload.description ?? payload.summary ?? payload.message),
    createToolSection(
      '参考信息',
      payload.input ?? payload.arguments ?? payload.args ?? payload.parameters ?? payload.params
    ),
    createToolSection(
      '整理结果',
      payload.output ?? payload.result ?? payload.response ?? payload.content ?? payload.text
    ),
  ].filter(Boolean);

  if (sections.length > 0) {
    return sections.join('\n\n');
  }

  return extractFirstText([payload.content, payload.text, payload.message]);
}

function formatAgentToolCall(payload: Record<string, unknown>): string | null {
  const sections = [
    createToolSection('处理说明', payload.description ?? payload.summary ?? '正在整理相关信息'),
    createToolSection(
      '参考信息',
      payload.input ?? payload.arguments ?? payload.args ?? payload.parameters
    ),
  ].filter(Boolean);

  return sections.length > 0 ? sections.join('\n\n') : null;
}

function formatAgentToolResult(payload: Record<string, unknown>): string | null {
  const sections = [
    createToolSection('处理状态', formatAgentToolStatus(payload.success)),
    createToolSection(
      '整理结果',
      payload.summary ?? payload.result ?? payload.output ?? payload.message
    ),
  ].filter(Boolean);

  return sections.length > 0 ? sections.join('\n\n') : null;
}

function formatAgentToolStatus(value: unknown): string {
  if (value === true) {
    return '已完成';
  }

  if (value === false) {
    return '未完成';
  }

  return '';
}

function extractFitnessPlanFromToolEnvelope(
  payload: Record<string, unknown>,
  title?: string
): FitnessPlan | undefined {
  const candidates = [
    payload,
    payload.input,
    payload.arguments,
    payload.args,
    payload.parameters,
    payload.params,
    payload.output,
    payload.result,
    payload.response,
    payload.content,
    payload.text,
    payload.data,
  ];

  for (const candidate of candidates) {
    const plan = extractFitnessPlan(candidate, {
      fallbackTitle: title,
      sourceTitle: title,
    });

    if (plan) {
      return plan;
    }
  }

  return undefined;
}

function formatPlanSummaryText(
  payload: Record<string, unknown>,
  plan: FitnessPlan
): string | null {
  const summary =
    extractFirstText([payload.summary, payload.objective, payload.goal, payload.description]) ??
    plan.summary;
  const progression = formatStringList('进阶规则', payload.progressionRules);
  const recovery = formatStringList('恢复提醒', payload.recoveryGuidance);
  const metrics = formatStringList('追踪指标', payload.metricsToTrack);

  return [summary, progression, recovery, metrics].filter(Boolean).join('\n\n') || null;
}

function formatStringList(label: string, value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const items = value
    .map((item) => coerceChatText(item))
    .filter((item): item is string => Boolean(item));

  if (items.length === 0) {
    return null;
  }

  return `${label}\n${items.map((item) => `- ${item}`).join('\n')}`;
}

function createToolSection(label: string, value: unknown): string | null {
  const text = coerceChatText(value);

  if (!text) {
    return null;
  }

  return `${label}\n${text}`;
}

function extractFirstText(values: unknown[]): string | null {
  for (const value of values) {
    const text = coerceChatText(value);

    if (text) {
      return text;
    }
  }

  return null;
}

function coerceChatText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    const text = value
      .map((item) => coerceChatText(item))
      .filter((item): item is string => Boolean(item))
      .join('\n\n')
      .trim();

    return text || null;
  }

  if (!isRecord(value)) {
    return null;
  }

  const directText = extractFirstText([
    value.text,
    value.content,
    value.markdown,
    value.message,
    value.summary,
    value.description,
    value.output,
    value.result,
  ]);

  if (directText) {
    return directText;
  }

  return summarizeRecordForDisplay(value);
}

function dedupeChatChunks(chunks: ChatChunkDraft[]): ChatChunkDraft[] {
  const seen = new Set<string>();
  const deduped: ChatChunkDraft[] = [];

  for (const chunk of chunks) {
    const text = chunk.text.trim();

    if (!text) {
      continue;
    }

    const key = `${chunk.kind}:${chunk.title ?? ''}:${text}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push({
      ...chunk,
      text,
    });
  }

  return deduped;
}

async function authenticate(
  path: string,
  credentials: LoginCredentials
): Promise<LoginResponse> {
  const payload = await requestJson(path, {
    body: JSON.stringify(credentials),
    headers: {
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });

  const token = extractToken(payload);

  if (!token) {
    throw new Error('登录已完成，但状态保存失败，请稍后重试。');
  }

  return {
    ...(isRecord(payload) ? payload : {}),
    token,
  };
}

function usesAgentPlanEndpoint(path: string): boolean {
  return path === PLAN_API_PATH;
}

function createAgentPlanPayload(input: {
  history?: ChatHistoryItem[];
  message: string;
}): Record<string, unknown> {
  const requestNote = compactText(
    [
      input.message.trim(),
      formatChatHistoryForPlan(input.history ?? []),
    ]
      .filter(Boolean)
      .join('\n\n'),
    1800
  );

  return {
    currentState: {
      soreness: [],
    },
    goal: {
      primary: 'general_fitness',
      requestNote,
      secondary: [],
      targetAreas: [],
    },
    preferences: {
      avoidExercises: [],
      equipment: [],
      preferredExercises: [],
      workoutLocation: 'gym',
    },
    rememberedWorkouts: [],
    schedule: {
      availableDaysPerWeek: 3,
      preferredDays: [],
      sessionDurationMinutes: 60,
    },
    user: {
      id: 'chatgym-user',
      injuries: [],
      limitations: [],
      name: 'ChatGym User',
      trainingExperience: 'intermediate',
    },
  };
}

function formatChatHistoryForPlan(history: ChatHistoryItem[]): string {
  const lines = history
    .slice(-6)
    .map((item) => {
      const speaker = item.role === 'user' ? '用户' : '助手';
      const body = compactText(item.text, 220);

      return body ? `${speaker}: ${body}` : null;
    })
    .filter((item): item is string => Boolean(item));

  if (lines.length === 0) {
    return '';
  }

  return `最近对话上下文：\n${lines.join('\n')}`;
}

function compactText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function looksLikePlanRecord(payload: Record<string, unknown>): boolean {
  return Array.isArray(payload.weeklySchedule) || Array.isArray(payload.progressionRules);
}

function getApiBaseUrl(): string {
  if (!API_BASE_URL) {
    throw new Error('服务连接尚未配置完成，请稍后再试。');
  }

  return API_BASE_URL;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function extractToken(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }

  const directToken = payload.token;

  if (typeof directToken === 'string' && directToken.trim()) {
    return directToken;
  }

  const nestedData = payload.data;

  if (isRecord(nestedData) && typeof nestedData.token === 'string' && nestedData.token.trim()) {
    return nestedData.token;
  }

  return null;
}

function extractMessage(payload: unknown): string | null {
  if (typeof payload === 'string' && payload.trim()) {
    return payload;
  }

  if (!isRecord(payload)) {
    return null;
  }

  const candidates = [payload.message, payload.error, payload.detail];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate;
    }
  }

  return null;
}

function normalizeChunkTitle(
  title: string | null,
  kind: ChatMessageKind
): string | undefined {
  const trimmed = title?.trim();

  if (!trimmed) {
    return undefined;
  }

  if (!looksTechnicalTitle(trimmed)) {
    return trimmed;
  }

  if (kind === 'thought') {
    return '思路整理';
  }

  if (kind === 'tool') {
    return inferFriendlyToolTitle(trimmed);
  }

  return '教练回复';
}

function looksTechnicalTitle(value: string): boolean {
  return (
    /[_/]/.test(value) ||
    /[a-z][A-Z]/.test(value) ||
    /^[a-z0-9 .:-]+$/i.test(value) ||
    /\b(api|agent|tool|planner|loader|context|step|call|result|fetch|query)\b/i.test(value)
  );
}

function inferFriendlyToolTitle(value: string): string {
  const lower = value.toLowerCase();

  if (/plan|schedule|workout|program/.test(lower) || /计划/.test(value)) {
    return '训练计划';
  }

  if (/profile|account|user/.test(lower) || /个人|用户/.test(value)) {
    return '个人信息';
  }

  if (/meal|food|calorie|nutrition/.test(lower) || /饮食|热量/.test(value)) {
    return '饮食信息';
  }

  if (/exercise|movement/.test(lower) || /动作/.test(value)) {
    return '动作资料';
  }

  if (/history|memory|context/.test(lower) || /背景|历史/.test(value)) {
    return '背景整理';
  }

  return '信息整理';
}

function summarizeRecordForDisplay(value: Record<string, unknown>): string | null {
  const lines = Object.entries(value)
    .map(([key, item]) => {
      const label = humanizeFieldLabel(key);
      const text = coerceBriefValue(item);

      if (!label || !text) {
        return null;
      }

      return `${label}：${text}`;
    })
    .filter((item): item is string => Boolean(item))
    .slice(0, 6);

  return lines.length > 0 ? lines.join('\n') : null;
}

function humanizeFieldLabel(key: string): string | null {
  if (/^[\u4e00-\u9fa5]{1,8}$/.test(key)) {
    return key;
  }

  const normalized = key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();

  if (TECHNICAL_FIELD_KEYS.has(normalized)) {
    return null;
  }

  return DISPLAY_FIELD_LABELS[normalized] ?? null;
}

function coerceBriefValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }

  if (typeof value === 'number') {
    return String(value);
  }

  if (typeof value === 'boolean') {
    return value ? '是' : '否';
  }

  if (Array.isArray(value)) {
    const items = value
      .map((item) => coerceBriefValue(item))
      .filter((item): item is string => Boolean(item))
      .slice(0, 4);

    return items.length > 0 ? items.join('、') : null;
  }

  if (!isRecord(value)) {
    return null;
  }

  const candidates = [
    value.title,
    value.name,
    value.label,
    value.summary,
    value.description,
    value.message,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function toUserFacingServiceMessage(
  message: string | null,
  fallback: string
): string {
  if (!message) {
    return fallback;
  }

  const trimmed = message.trim();

  if (!trimmed) {
    return fallback;
  }

  if (/token|bearer/i.test(trimmed)) {
    return '登录状态已失效，请重新登录。';
  }

  if (/username|password/i.test(trimmed)) {
    return '账号或密码不正确，请检查后重试。';
  }

  if (/network|failed to fetch|timeout|econn|enotfound/i.test(trimmed)) {
    return '网络连接异常，请稍后再试。';
  }

  if (/EXPO_PUBLIC_|\/api\/|AsyncStorage|tool|agent|endpoint/i.test(trimmed)) {
    return fallback;
  }

  return trimmed;
}

const DISPLAY_FIELD_LABELS: Record<string, string> = {
  advice: '建议',
  calories: '热量',
  description: '说明',
  duration: '时长',
  equipment: '器械',
  exercises: '动作',
  focus: '重点',
  food: '食物',
  frequency: '频率',
  goal: '目标',
  kcal: '热量',
  label: '名称',
  meal: '餐食',
  movements: '动作',
  name: '名称',
  notes: '提示',
  objective: '目标',
  reps: '次数',
  result: '结果',
  schedule: '安排',
  sets: '组数',
  summary: '摘要',
  title: '标题',
  weight: '重量',
};

const TECHNICAL_FIELD_KEYS = new Set([
  'agent',
  'agent_step',
  'agent_steps',
  'api',
  'args',
  'arguments',
  'authorization',
  'content',
  'context',
  'data',
  'endpoint',
  'headers',
  'id',
  'input',
  'message_type',
  'method',
  'output',
  'params',
  'payload',
  'response',
  'role',
  'step_number',
  'text',
  'tool',
  'tool_name',
  'tool_output',
  'tool_result',
  'token',
  'type',
  'url',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
