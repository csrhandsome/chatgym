import { createApiConnectionError, getApiBaseUrl } from '@/services/api-config';
import { BackendApiError } from '@/services/backend-api';
import { extractFitnessPlan, type FitnessPlan } from '@/services/fitness-plan';
const PLAN_API_PATH = normalizeApiPath(process.env.EXPO_PUBLIC_PLAN_API_PATH) ?? '/api/agent/plan/stream';
const VLM_API_PATH =
  normalizeApiPath(process.env.EXPO_PUBLIC_VLM_API_PATH) ?? '/api/agent/vlm/analyze';

export const AGENT_PLAN_API_PATH_LABEL = PLAN_API_PATH;
export const AGENT_VLM_API_PATH_LABEL = VLM_API_PATH;
export const MAX_CHAT_MESSAGE_LENGTH = 2000;

export type ChatMessageKind = 'answer' | 'thought' | 'tool';

export type ChatHistoryItem = {
  kind?: ChatMessageKind | 'user';
  role: 'assistant' | 'user';
  text: string;
  title?: string;
};

export type ChatResponseChunk = {
  eventId?: string;
  fitnessPlan?: FitnessPlan;
  id: string;
  kind: ChatMessageKind;
  text: string;
  title?: string;
  toolCallId?: string;
  status?: 'running' | 'completed' | 'failed';
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
  toolCallId?: string;
  success?: boolean;
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
  signal?: AbortSignal;
  token?: string | null;
};

type SendAgentMessageOptions = {
  onChunk?: ChatChunkListener;
  signal?: AbortSignal;
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
  let eventNumber = 0;

  const result = await requestAgentPayload(PLAN_API_PATH, createAgentPlanPayload(input), {
    onEvent(event) {
      if (!options.onChunk) {
        return;
      }

      const nextChunks = buildChatChunksFromPayload(event, `${event.id ?? 'event'}-${Date.now()}-${eventNumber++}`);
      const uniqueChunks = getUniqueChunks(nextChunks, streamedChunkKeys);

      if (uniqueChunks.length === 0) {
        return;
      }

      streamedChunks.push(...uniqueChunks);

      for (const chunk of uniqueChunks) {
        options.onChunk(chunk);
      }
    },
    signal: options.signal,
    token,
  });

  const normalizedChunks = buildChatChunksFromPayload(result.payload, `chat-${Date.now()}`);
  const chunks = normalizedChunks.length > 0 ? normalizedChunks : streamedChunks;

  // JSON responses can carry the same execution errors as SSE. Keep their
  // process cards visible, but never let an error response persist a plan.
  const failure = result.events.find((event) => event.type === 'error');
  if (failure) {
    for (const chunk of chunks) options.onChunk?.(chunk);
    throw new Error(failure.summary || 'Agent 执行失败，请稍后再试。');
  }
  const finalEvent = [...result.events].reverse().find((event) => event.type === 'final');
  if (finalEvent?.finishReason && ['error', 'length', 'content-filter', 'content_filter'].includes(finalEvent.finishReason)) {
    if (result.delivery === 'json') for (const chunk of chunks) options.onChunk?.(chunk);
    throw new Error(`Agent 尚未正常完成（${finalEvent.finishReason}），请重试。`);
  }
  const completedPayload = isRecord(result.payload) && Object.hasOwn(result.payload, 'plan')
    ? result.payload : isRecord(finalEvent?.output) ? finalEvent.output : undefined;
  const invalidPlan = completedPayload && Object.hasOwn(completedPayload, 'plan') &&
    !extractFitnessPlan(completedPayload.plan);
  const failedReview = isRecord(completedPayload?.review) && completedPayload.review.status === 'needs-repair';
  if (invalidPlan || failedReview) {
    if (result.delivery === 'json') for (const chunk of chunks) options.onChunk?.(chunk);
    throw new Error(invalidPlan
      ? 'Agent 返回的训练计划没有有效动作，未同步到 Fitness 页，请重试。'
      : '训练计划未通过审核，未同步到 Fitness 页，请重新生成。');
  }

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
    signal: options.signal,
    token,
  });
}

async function requestAgentPayload(
  path: string,
  body: Record<string, unknown>,
  options: RequestAgentPayloadOptions = {}
): Promise<AgentPayloadResult> {
  let response: Response;

  try {
    throwIfAborted(options.signal);
    response = await fetch(`${getApiBaseUrl()}${path}`, {
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
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw createAbortError();
    throw createApiConnectionError(path, error);
  }
  throwIfAborted(options.signal);

  if (!response.ok) {
    const payload = await parseResponseBody(response);
    const message = response.status === 401
      ? '登录状态已失效，请重新登录。'
      : response.status === 403
        ? '当前账号暂时无法执行这个操作。'
        : extractMessage(payload) ?? `请求失败 (${response.status})`;
    throw new BackendApiError(message, response.status);
  }

  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.includes('text/event-stream')) {
    const streamed = await parseAgentSseResponse(response, options.onEvent, options.signal);

    return {
      delivery: 'stream',
      events: streamed.events,
      payload: streamed.payload,
    };
  }

  const payload = await parseResponseBody(response);
  throwIfAborted(options.signal);

  return {
    delivery: 'json',
    events: extractResponseEvents(payload),
    payload,
  };
}

async function parseAgentSseResponse(
  response: Response,
  onEvent?: (event: AgentConsoleEvent) => void,
  signal?: AbortSignal,
): Promise<{ events: AgentConsoleEvent[]; payload: unknown }> {
  const events: AgentConsoleEvent[] = [];
  let finalPayload: unknown = null;
  let completed = false;

  const handleEvent = (event: AgentConsoleEvent) => {
    throwIfAborted(signal);
    events.push(event);
    onEvent?.(event);

    if (event.type === 'error') {
      throw new Error(event.summary || 'Agent 执行失败，请稍后再试。');
    }

    if (event.type === 'final') {
      if (event.finishReason && ['error', 'length', 'content-filter', 'content_filter'].includes(event.finishReason)) {
        throw new Error(`Agent 尚未正常完成（${event.finishReason}），请重试。`);
      }
      completed = true;
      if (event.output !== undefined) {
        finalPayload = event.output;
      }
    }
  };

  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const abort = () => { void reader.cancel().catch(() => undefined); };
    signal?.addEventListener('abort', abort, { once: true });

    try {
      throwIfAborted(signal);
      while (true) {
        const { done, value } = await reader.read();
        throwIfAborted(signal);

        if (done) {
          buffer += decoder.decode();
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        buffer = drainSseBuffer(buffer, handleEvent);
      }

      drainSseBuffer(`${buffer}\n\n`, handleEvent);
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      reader.releaseLock();
    }
  } else {
    const text = await response.text();
    throwIfAborted(signal);
    drainSseBuffer(`${text}\n\n`, handleEvent);
  }

  // Both our backend's final event and SDK finish/[DONE] explicitly end a response.
  // Closing the transport alone must never turn a partial plan into success.
  if (!completed) {
    throw new Error('Agent 响应中断，尚未完成，请重试。');
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

  if (rawPayload.trim() === '[DONE]') {
    return { type: 'final', summary: '' };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawPayload) as unknown;
  } catch {
    if (/^[\[{]/.test(rawPayload.trim())) {
      throw new Error('Agent 返回的数据格式无效，请重试。');
    }
    return normalizeAgentEvent(
      {
        summary: rawPayload.trim(),
        text: rawPayload.trim(),
        type: eventType ?? 'text',
      },
      eventType
    );
  }
  return normalizeAgentEvent(payload, eventType);
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
          eventId: event.id,
          kind: 'thought',
          text: event.text?.trim() || event.summary.trim(),
          title: buildEventTitle('Agent 思考', event, prefix),
        },
      ];
    case 'tool_call':
      return [
        {
          eventId: event.id,
          kind: 'tool',
          status: 'running',
          toolCallId: event.toolCallId,
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
          eventId: event.id,
          fitnessPlan: event.success === false ? undefined :
            extractFitnessPlan(event.output, {
              fallbackTitle: event.toolName,
              sourceTitle: event.toolName,
            }) ?? undefined,
          kind: 'tool',
          status: event.success === false ? 'failed' : 'completed',
          toolCallId: event.toolCallId,
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
          eventId: event.id,
          kind: 'answer',
          text: event.text?.trim() || event.summary.trim(),
          title: buildEventTitle('模型输出', event, prefix),
        },
      ];
    case 'error':
      return [
        {
          eventId: event.id,
          kind: 'tool',
          status: 'failed',
          toolCallId: event.toolCallId,
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
        status: 'running',
        toolCallId: coerceText(toolCall.toolCallId) ?? undefined,
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
        fitnessPlan: toolResult.success === false ? undefined : extractFitnessPlan(toolResult.output ?? toolResult.summary, {
          fallbackTitle: coerceText(toolResult.name) ?? undefined,
          sourceTitle: coerceText(toolResult.name) ?? undefined,
        }) ?? undefined,
        kind: 'tool',
        status: toolResult.success === false ? 'failed' : 'completed',
        toolCallId: coerceText(toolResult.toolCallId) ?? undefined,
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
    status: 'completed',
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
    const key = chatChunkKey(chunk);

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
    const key = chatChunkKey(chunk);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    uniqueChunks.push(chunk);
  }

  return uniqueChunks;
}

function chatChunkKey(chunk: Omit<ChatResponseChunk, 'id'>): string {
  // The backend repeats the full dialog answer in final.output.answer after
  // its text event. Display that answer once per request, not once per wrapper.
  if (chunk.kind === 'answer') return `answer:${chunk.text.trim()}`;
  const identity = chunk.toolCallId ?? chunk.eventId ?? '';
  // Two plans may have identical summaries but different prescribed exercises.
  // Ignore generated IDs when comparing their actual contents.
  const planContent = chunk.fitnessPlan ? JSON.stringify({
    title: chunk.fitnessPlan.title,
    notes: chunk.fitnessPlan.notes,
    exercises: chunk.fitnessPlan.exercises.map((exercise) => ({
      name: exercise.name, description: exercise.description,
      sets: exercise.sets.map((set) => ({ kg: set.kg, reps: set.reps })),
    })),
  }) : '';
  return `${identity}:${chunk.kind}:${chunk.status ?? ''}:${chunk.title ?? ''}:${chunk.text.trim()}:${planContent}`;
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

function extractResponseEvents(payload: unknown): AgentConsoleEvent[] {
  if (Array.isArray(payload)) return payload.flatMap(extractResponseEvents);
  if (!isRecord(payload)) return [];
  const direct = normalizeAgentEvent(payload);
  if (direct) return [direct];
  if (Array.isArray(payload.agentEvents)) return extractAgentEvents(payload);
  if (Array.isArray(payload.agentSteps)) {
    return payload.agentSteps.flatMap((step) => isRecord(step)
      ? extractResponseEvents(step.events ?? step) : []);
  }
  return [];
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
    coerceText(value.errorText) ??
    (type === 'final' ? '' : `Agent ${type ?? 'event'}`);

  if (!type) {
    return null;
  }

  return {
    finishReason: coerceText(value.finishReason) ?? undefined,
    id: coerceText(value.id) ?? undefined,
    input: normalizeToolInput(value.input ?? value.arguments),
    output: value.output ?? value.result,
    requestId: coerceText(value.requestId) ?? undefined,
    stage: coerceText(value.stage) ?? undefined,
    stepNumber:
      typeof value.stepNumber === 'number' && Number.isFinite(value.stepNumber)
        ? value.stepNumber
        : undefined,
    summary,
    text: coerceText(value.text) ?? undefined,
    timestamp: coerceText(value.timestamp) ?? undefined,
    toolName: coerceText(value.toolName) ?? coerceText(value.name) ?? undefined,
    toolCallId: coerceText(value.toolCallId) ?? coerceText(value.call_id) ?? undefined,
    success: typeof value.success === 'boolean' ? value.success : undefined,
    type,
  };
}

function normalizeToolInput(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return { arguments: value };
    }
  }
  return isRecord(value) ? value : undefined;
}

function normalizeEventType(value: unknown): AgentEventType | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');

  if (normalized === 'function_call' || normalized === 'tool_input_available') {
    return 'tool_call';
  }
  if (normalized === 'function_call_output' || normalized === 'tool_output_available') {
    return 'tool_result';
  }
  if (normalized === 'tool_output_error') {
    return 'error';
  }
  if (normalized === 'finish' || normalized === 'done') {
    return 'final';
  }

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
  if (typeof input.message !== 'string' || !input.message.trim()) {
    throw new Error('请输入聊天内容。');
  }
  const requestNote = input.message.trim();
  if (requestNote.length > MAX_CHAT_MESSAGE_LENGTH) {
    throw new Error(`聊天输入最多 ${MAX_CHAT_MESSAGE_LENGTH} 字，请缩短后发送。`);
  }
  const chatHistory = (input.history ?? [])
    .filter((item) => item.kind !== 'tool' && item.kind !== 'thought')
    .slice(-14)
    .map((item) => ({ role: item.role, text: item.text.trim().slice(0, 2000) }))
    .filter((item) => item.text);

  return {
    chatHistory,
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

function looksLikePlanRecord(value: Record<string, unknown>): boolean {
  return Array.isArray(value.weeklySchedule) || Array.isArray(value.progressionRules);
}

function extractFallbackText(payload: Record<string, unknown>): string | null {
  return extractFirstText([
    payload.answer,
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

function createAbortError(): Error {
  const error = new Error('已取消生成。');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError();
}
