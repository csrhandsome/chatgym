import { extractFitnessPlan, type FitnessPlan } from '@/services/fitness-plan';

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL?.replace(/\/$/, '');
const PLAN_API_PATH = normalizeApiPath(process.env.EXPO_PUBLIC_PLAN_API_PATH) ?? '/api/agent/plan';
const VLM_API_PATH =
  normalizeApiPath(process.env.EXPO_PUBLIC_VLM_API_PATH) ?? '/api/agent/vlm/analyze';

export const AGENT_PLAN_API_PATH_LABEL = PLAN_API_PATH;
export const AGENT_VLM_API_PATH_LABEL = VLM_API_PATH;

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

export type AgentEventType = 'thinking' | 'tool_call' | 'tool_result' | 'text' | 'final' | 'error';

export type AgentConsoleEvent = {
  finishReason?: string;
  id?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  requestId?: string;
  stage?: string;
  stepNumber?: number;
  summary: string;
  text?: string;
  timestamp?: string;
  toolName?: string;
  type: AgentEventType;
};

export type ChatDeliveryMode = 'json' | 'stream';

export type SendAgentMessageResult = {
  chunks: ChatResponseChunk[];
  delivery: ChatDeliveryMode;
};

export type VisionImageInput = {
  detail?: 'auto' | 'high' | 'low';
  image: string;
  purpose?: string;
};

export type VisionAnalyzeRequest = {
  images: VisionImageInput[];
  preferredTask?:
    | 'equipment_question'
    | 'food_calorie_estimate'
    | 'general_fitness_qa'
    | 'movement_form_feedback'
    | 'training_plan_context'
    | 'unknown';
  prompt?: string;
  userId?: string;
};

export type AgentPayloadResult = {
  delivery: ChatDeliveryMode;
  events: AgentConsoleEvent[];
  payload: unknown;
};

type ChatChunkListener = (chunk: ChatResponseChunk) => void;

type RequestAgentPayloadOptions = {
  onEvent?: (event: AgentConsoleEvent) => void;
  token?: string | null;
};

type SendAgentMessageOptions = {
  onChunk?: ChatChunkListener;
};

export async function sendAgentMessage(
  token: string | null,
  input: {
    history?: ChatHistoryItem[];
    message: string;
  },
  options: SendAgentMessageOptions = {}
): Promise<SendAgentMessageResult> {
  const streamedChunks: ChatResponseChunk[] = [];
  const streamedChunkKeys = new Set<string>();

  const result = await requestAgentPayload(PLAN_API_PATH, createAgentPlanPayload(input), {
    onEvent(event) {
      if (!options.onChunk) {
        return;
      }

      const nextChunks = buildChatChunksFromPayload(event, event.id ?? `event-${Date.now()}`);
      const uniqueChunks = getUniqueChunks(nextChunks, streamedChunkKeys);

      if (uniqueChunks.length === 0) {
        return;
      }

      streamedChunks.push(...uniqueChunks);

      for (const chunk of uniqueChunks) {
        options.onChunk(chunk);
      }
    },
    token,
  });

  const normalizedChunks = buildChatChunksFromPayload(result.payload, `chat-${Date.now()}`);
  const chunks = normalizedChunks.length > 0 ? normalizedChunks : streamedChunks;

  if (chunks.length === 0) {
    throw new Error('Agent 已返回响应，但没有解析出可展示的步骤。');
  }

  return {
    chunks,
    delivery: result.delivery,
  };
}

export async function analyzeFitnessImages(
  token: string | null,
  request: VisionAnalyzeRequest,
  options: RequestAgentPayloadOptions = {}
): Promise<AgentPayloadResult> {
  return await requestAgentPayload(VLM_API_PATH, request, {
    onEvent: options.onEvent,
    token,
  });
}

async function requestAgentPayload(
  path: string,
  body: Record<string, unknown>,
  options: RequestAgentPayloadOptions = {}
): Promise<AgentPayloadResult> {
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    body: JSON.stringify(body),
    headers: {
      Accept: 'text/event-stream, application/json',
      ...(options.token
        ? {
            Authorization: `Bearer ${options.token}`,
          }
        : null),
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });

  if (!response.ok) {
    const payload = await parseResponseBody(response);
    throw new Error(extractMessage(payload) ?? `请求失败 (${response.status})`);
  }

  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.includes('text/event-stream')) {
    const streamed = await parseAgentSseResponse(response, options.onEvent);

    return {
      delivery: 'stream',
      events: streamed.events,
      payload: streamed.payload,
    };
  }

  const payload = await parseResponseBody(response);

  return {
    delivery: 'json',
    events: extractAgentEvents(payload),
    payload,
  };
}

async function parseAgentSseResponse(
  response: Response,
  onEvent?: (event: AgentConsoleEvent) => void
): Promise<{ events: AgentConsoleEvent[]; payload: unknown }> {
  const events: AgentConsoleEvent[] = [];
  let finalPayload: unknown = null;

  const handleEvent = (event: AgentConsoleEvent) => {
    events.push(event);
    onEvent?.(event);

    if (event.type === 'final' && event.output !== undefined) {
      finalPayload = event.output;
    }
  };

  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        buffer += decoder.decode();
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      buffer = drainSseBuffer(buffer, handleEvent);
    }

    drainSseBuffer(`${buffer}\n\n`, handleEvent);
  } else {
    const text = await response.text();
    drainSseBuffer(`${text}\n\n`, handleEvent);
  }

  return {
    events,
    payload: mergeFinalPayload(finalPayload, events),
  };
}

function drainSseBuffer(
  buffer: string,
  onEvent: (event: AgentConsoleEvent) => void
): string {
  let remainder = buffer;

  while (true) {
    const separatorIndex = remainder.search(/\r?\n\r?\n/);

    if (separatorIndex === -1) {
      return remainder;
    }

    const block = remainder.slice(0, separatorIndex);
    const separatorMatch = remainder.slice(separatorIndex).match(/^\r?\n\r?\n/);
    const separatorLength = separatorMatch?.[0].length ?? 2;
    remainder = remainder.slice(separatorIndex + separatorLength);

    const parsed = parseSseBlock(block);

    if (parsed) {
      onEvent(parsed);
    }
  }
}

function parseSseBlock(block: string): AgentConsoleEvent | null {
  const lines = block.split(/\r?\n/);
  const dataLines: string[] = [];
  let eventType: string | undefined;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (!line || line.startsWith(':')) {
      continue;
    }

    if (line.startsWith('event:')) {
      eventType = line.slice('event:'.length).trim();
      continue;
    }

    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  const rawPayload = dataLines.join('\n');

  try {
    return normalizeAgentEvent(JSON.parse(rawPayload) as unknown, eventType);
  } catch {
    return normalizeAgentEvent(
      {
        summary: rawPayload.trim(),
        text: rawPayload.trim(),
        type: eventType ?? 'text',
      },
      eventType
    );
  }
}

function buildChatChunksFromPayload(payload: unknown, prefix: string): ChatResponseChunk[] {
  const deduped = dedupeChatChunks(collectChatChunks(payload, prefix));
  return deduped.map((chunk, index) => ({
    ...chunk,
    id: `${prefix}-${index}`,
  }));
}

function collectChatChunks(
  payload: unknown,
  prefix: string
): Array<Omit<ChatResponseChunk, 'id'>> {
  if (typeof payload === 'string') {
    const text = payload.trim();
    return text ? [{ kind: 'answer', text }] : [];
  }

  if (Array.isArray(payload)) {
    return payload.flatMap((item, index) => collectChatChunks(item, `${prefix}-${index}`));
  }

  if (!isRecord(payload)) {
    return [];
  }

  const event = normalizeAgentEvent(payload);

  if (event) {
    return collectChatChunksFromAgentEvent(event, prefix);
  }

  const events = extractAgentEvents(payload);

  if (events.length > 0) {
    const planChunk = isRecord(payload.plan) ? createPlanChunk(payload.plan) : null;

    return [
      ...events.flatMap((item, index) =>
        collectChatChunksFromAgentEvent(item, `${prefix}-event-${index}`)
      ),
      ...(planChunk ? [planChunk] : []),
    ];
  }

  if (Array.isArray(payload.agentSteps)) {
    const chunks = payload.agentSteps.flatMap((step, index) =>
      collectChatChunksFromAgentStep(step, `${prefix}-step-${index}`)
    );

    if (chunks.length > 0) {
      const planChunk = isRecord(payload.plan) ? createPlanChunk(payload.plan) : null;
      return [...chunks, ...(planChunk ? [planChunk] : [])];
    }
  }

  if (isRecord(payload.plan)) {
    const planChunk = createPlanChunk(payload.plan);

    if (planChunk) {
      return [planChunk];
    }
  }

  const directPlanChunk = createPlanChunk(payload);

  if (directPlanChunk) {
    return [directPlanChunk];
  }

  const fallbackText = extractFallbackText(payload);

  if (!fallbackText) {
    return [];
  }

  return [
    {
      kind: 'answer',
      text: fallbackText,
      title: extractFallbackTitle(payload) ?? undefined,
    },
  ];
}

function collectChatChunksFromAgentEvent(
  event: AgentConsoleEvent,
  prefix: string
): Array<Omit<ChatResponseChunk, 'id'>> {
  switch (event.type) {
    case 'thinking':
      return [
        {
          kind: 'thought',
          text: event.text?.trim() || event.summary.trim(),
          title: buildEventTitle('Agent 思考', event, prefix),
        },
      ];
    case 'tool_call':
      return [
        {
          kind: 'tool',
          text: formatEventSections([
            ['说明', event.summary],
            ['输入', event.input],
          ]),
          title: event.toolName?.trim() || 'Tool 调用',
        },
      ];
    case 'tool_result':
      return [
        {
          fitnessPlan:
            extractFitnessPlan(event.output, {
              fallbackTitle: event.toolName,
              sourceTitle: event.toolName,
            }) ?? undefined,
          kind: 'tool',
          text: formatEventSections([
            ['说明', event.summary],
            ['输出', event.output],
          ]),
          title: event.toolName?.trim() || 'Tool 结果',
        },
      ];
    case 'text':
      return [
        {
          kind: 'answer',
          text: event.text?.trim() || event.summary.trim(),
          title: buildEventTitle('模型输出', event, prefix),
        },
      ];
    case 'error':
      return [
        {
          kind: 'tool',
          text: formatEventSections([
            ['错误', event.summary],
            ['详情', event.output],
          ]),
          title: 'Agent Error',
        },
      ];
    case 'final': {
      const outputChunks =
        event.output !== undefined ? collectChatChunks(event.output, `${prefix}-final`) : [];
      const summaryText = event.summary.trim();

      if (!summaryText) {
        return outputChunks;
      }

      return [
        ...outputChunks,
        {
          kind: 'answer',
          text: summaryText,
          title: '最终完成',
        },
      ];
    }
  }
}

function collectChatChunksFromAgentStep(
  value: unknown,
  prefix: string
): Array<Omit<ChatResponseChunk, 'id'>> {
  if (!isRecord(value)) {
    return [];
  }

  if (Array.isArray(value.events) && value.events.length > 0) {
    return value.events.flatMap((event, index) =>
      collectChatChunks(event, `${prefix}-event-${index}`)
    );
  }

  const chunks: Array<Omit<ChatResponseChunk, 'id'>> = [];

  if (typeof value.summary === 'string' && value.summary.trim()) {
    chunks.push({
      kind: value.type === 'tool_call' || value.type === 'tool_result' ? 'tool' : 'thought',
      text: value.summary.trim(),
      title:
        typeof value.stepNumber === 'number' ? `Step ${value.stepNumber + 1}` : 'Agent Step',
    });
  }

  if (typeof value.text === 'string' && value.text.trim()) {
    chunks.push({
      kind: value.type === 'text' || value.type === 'final' ? 'answer' : 'thought',
      text: value.text.trim(),
      title:
        typeof value.stepNumber === 'number' ? `Step ${value.stepNumber + 1}` : 'Agent Step',
    });
  }

  if (Array.isArray(value.toolCalls)) {
    for (const toolCall of value.toolCalls) {
      if (!isRecord(toolCall)) {
        continue;
      }

      chunks.push({
        kind: 'tool',
        text: formatEventSections([
          ['说明', `调用工具 ${coerceText(toolCall.name) || 'unknown'}`],
          ['输入', toolCall.input],
        ]),
        title: coerceText(toolCall.name) || 'Tool 调用',
      });
    }
  }

  if (Array.isArray(value.toolResults)) {
    for (const toolResult of value.toolResults) {
      if (!isRecord(toolResult)) {
        continue;
      }

      chunks.push({
        kind: 'tool',
        text: formatEventSections([
          ['说明', coerceText(toolResult.summary) || '工具执行完成'],
          ['输出', toolResult.output ?? toolResult.summary],
        ]),
        title: coerceText(toolResult.name) || 'Tool 结果',
      });
    }
  }

  return chunks;
}

function createPlanChunk(planRecord: Record<string, unknown>): Omit<ChatResponseChunk, 'id'> | null {
  if (!looksLikePlanRecord(planRecord)) {
    return null;
  }

  const plan = extractFitnessPlan(planRecord, {
    fallbackTitle: extractFallbackTitle(planRecord) ?? 'AI 训练计划',
    sourceTitle: extractFallbackTitle(planRecord) ?? 'AI 训练计划',
  });

  if (!plan) {
    return null;
  }

  const summary = formatPlanSummary(planRecord, plan);

  if (!summary) {
    return null;
  }

  return {
    fitnessPlan: plan,
    kind: 'tool',
    text: summary,
    title: plan.title,
  };
}

function formatPlanSummary(planRecord: Record<string, unknown>, plan: FitnessPlan): string {
  const sections = [
    extractFirstText([
      planRecord.summary,
      planRecord.objective,
      planRecord.goal,
      planRecord.description,
      plan.summary,
    ]),
    formatStringList('进阶规则', planRecord.progressionRules),
    formatStringList('恢复提醒', planRecord.recoveryGuidance),
    formatStringList('追踪指标', planRecord.metricsToTrack),
    formatStringList('风险提醒', planRecord.warnings),
  ].filter(Boolean);

  return sections.join('\n\n');
}

function formatStringList(label: string, value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const items = value.map((item) => coerceText(item)).filter(Boolean);

  if (items.length === 0) {
    return null;
  }

  return `${label}\n${items.map((item) => `- ${item}`).join('\n')}`;
}

function formatEventSections(sections: Array<[string, unknown]>): string {
  return sections
    .map(([label, value]) => {
      const text = coerceText(value);
      return text ? `${label}\n${text}` : null;
    })
    .filter((item): item is string => Boolean(item))
    .join('\n\n');
}

function dedupeChatChunks(
  chunks: Array<Omit<ChatResponseChunk, 'id'>>
): Array<Omit<ChatResponseChunk, 'id'>> {
  const seen = new Set<string>();
  const deduped: Array<Omit<ChatResponseChunk, 'id'>> = [];

  for (const chunk of chunks) {
    const key = `${chunk.kind}:${chunk.title ?? ''}:${chunk.text.trim()}`;

    if (!chunk.text.trim() || seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push({
      ...chunk,
      text: chunk.text.trim(),
    });
  }

  return deduped;
}

function getUniqueChunks(chunks: ChatResponseChunk[], seen: Set<string>): ChatResponseChunk[] {
  const uniqueChunks: ChatResponseChunk[] = [];

  for (const chunk of chunks) {
    const key = `${chunk.kind}:${chunk.title ?? ''}:${chunk.text.trim()}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    uniqueChunks.push(chunk);
  }

  return uniqueChunks;
}

function buildEventTitle(
  fallback: string,
  event: AgentConsoleEvent,
  prefix: string
): string {
  if (typeof event.stepNumber === 'number') {
    return `Step ${event.stepNumber + 1}`;
  }

  if (event.stage?.trim()) {
    return event.stage.trim();
  }

  return fallback || prefix;
}

function extractAgentEvents(payload: unknown): AgentConsoleEvent[] {
  if (!isRecord(payload) || !Array.isArray(payload.agentEvents)) {
    return [];
  }

  return payload.agentEvents
    .map((item) => normalizeAgentEvent(item))
    .filter((item): item is AgentConsoleEvent => Boolean(item));
}

function normalizeAgentEvent(value: unknown, fallbackType?: string): AgentConsoleEvent | null {
  if (!isRecord(value)) {
    return null;
  }

  const type = normalizeEventType(value.type ?? fallbackType);
  const summary =
    coerceText(value.summary) ??
    coerceText(value.text) ??
    coerceText(value.message) ??
    `Agent ${type ?? 'event'}`;

  if (!type || !summary) {
    return null;
  }

  return {
    finishReason: coerceText(value.finishReason) ?? undefined,
    id: coerceText(value.id) ?? undefined,
    input:
      isRecord(value.input) && Object.keys(value.input).length > 0
        ? value.input
        : undefined,
    output: value.output,
    requestId: coerceText(value.requestId) ?? undefined,
    stage: coerceText(value.stage) ?? undefined,
    stepNumber:
      typeof value.stepNumber === 'number' && Number.isFinite(value.stepNumber)
        ? value.stepNumber
        : undefined,
    summary,
    text: coerceText(value.text) ?? undefined,
    timestamp: coerceText(value.timestamp) ?? undefined,
    toolName: coerceText(value.toolName) ?? undefined,
    type,
  };
}

function normalizeEventType(value: unknown): AgentEventType | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');

  if (
    normalized === 'thinking' ||
    normalized === 'tool_call' ||
    normalized === 'tool_result' ||
    normalized === 'text' ||
    normalized === 'final' ||
    normalized === 'error'
  ) {
    return normalized;
  }

  return null;
}

function mergeFinalPayload(finalPayload: unknown, events: AgentConsoleEvent[]): unknown {
  if (isRecord(finalPayload)) {
    return {
      ...finalPayload,
      agentEvents: events,
      generatedAt: coerceText(finalPayload.generatedAt) ?? events.at(-1)?.timestamp ?? new Date().toISOString(),
      requestId: coerceText(finalPayload.requestId) ?? events.at(-1)?.requestId ?? undefined,
    };
  }

  return {
    agentEvents: events,
  };
}

function createAgentPlanPayload(input: {
  history?: ChatHistoryItem[];
  message: string;
}): Record<string, unknown> {
  const requestNote = compactText(
    [input.message.trim(), formatChatHistoryForPlan(input.history ?? [])]
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

function looksLikePlanRecord(value: Record<string, unknown>): boolean {
  return Array.isArray(value.weeklySchedule) || Array.isArray(value.progressionRules);
}

function extractFallbackText(payload: Record<string, unknown>): string | null {
  return extractFirstText([
    payload.text,
    payload.summary,
    payload.message,
    payload.content,
    payload.description,
  ]);
}

function extractFallbackTitle(payload: Record<string, unknown>): string | null {
  return extractFirstText([payload.title, payload.name, payload.label, payload.stage]);
}

function extractFirstText(values: unknown[]): string | null {
  for (const value of values) {
    const text = coerceText(value);

    if (text) {
      return text;
    }
  }

  return null;
}

function coerceText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    const text = value
      .map((item) => coerceText(item))
      .filter((item): item is string => Boolean(item))
      .join('\n')
      .trim();

    return text || null;
  }

  if (!isRecord(value)) {
    return null;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

function normalizeApiPath(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? (trimmed.startsWith('/') ? trimmed : `/${trimmed}`) : null;
}

function getApiBaseUrl(): string {
  if (!API_BASE_URL) {
    throw new Error('缺少 EXPO_PUBLIC_API_BASE_URL，暂时无法连接 agent 服务。');
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

function extractMessage(payload: unknown): string | null {
  if (typeof payload === 'string' && payload.trim()) {
    return payload;
  }

  if (!isRecord(payload)) {
    return null;
  }

  return (
    extractFirstText([payload.message, payload.error, payload.detail, payload.summary]) ?? null
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
