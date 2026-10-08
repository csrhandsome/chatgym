import { createApiConnectionError, getApiBaseUrl } from '@/services/api-config';
import { BackendApiError } from '@/services/backend-api';
import {
  assertToken, throwIfAborted, type PaymentApi, type PaymentOrder,
  type PaymentPackage, type PaymentPreparation,
} from '@/services/payment-types';

const root = '/api/payments';

export function createPaymentApi(): PaymentApi {
  return {
    async listPackages(token, signal) {
      const data = await request('/packages', token, { signal });
      if (!record(data) || !Array.isArray(data.packages)) invalid();
      return data.packages.map(parsePackage);
    },
    async getBalance(token, signal) {
      const data = await request('/balance', token, { signal });
      if (!record(data) || !integer(data.remaining, 0)) invalid();
      return { remaining: data.remaining as number };
    },
    async createOrder(token, input, signal) {
      if (!input.packageId.trim() || !input.idempotencyKey.trim()) invalid();
      return parseOrder(await request('/orders', token, {
        method: 'POST', body: JSON.stringify({ packageId: input.packageId, idempotencyKey: input.idempotencyKey }), signal,
      }));
    },
    async prepareWechat(token, orderId, signal) {
      const data = await request(`/orders/${encodeURIComponent(orderId)}/wechat-app`, token, {
        method: 'POST', signal,
      });
      if (!record(data) || data.orderId !== orderId || !record(data.params)) invalid();
      const params = data.params;
      for (const field of ['appId', 'partnerId', 'prepayId', 'nonceStr', 'sign', 'package']) {
        if (!text(params[field])) invalid();
      }
      if (!integer(params.timeStamp, 1)) invalid();
      return data as PaymentPreparation;
    },
    async getOrder(token, orderId, signal) {
      const order = parseOrder(await request(`/orders/${encodeURIComponent(orderId)}`, token, { signal }));
      if (order.id !== orderId) invalid();
      return order;
    },
  };
}

async function request(path: string, token: string, init: RequestInit): Promise<unknown> {
  assertToken(token);
  throwIfAborted(init.signal ?? undefined);
  const controller = new AbortController();
  const abort = () => controller.abort();
  init.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 15000);
  try {
    const response = await fetch(`${getApiBaseUrl()}${root}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json', 'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
    throwIfAborted(init.signal ?? undefined);
    if (!response.ok) {
      throw new BackendApiError(response.status === 401
        ? '登录状态已失效，请重新登录。'
        : response.status === 404 || response.status === 501
          ? '次数购买尚未开放，请稍后再试。'
          : '支付服务暂时不可用，请稍后重试。', response.status);
    }
    return await response.json();
  } catch (error) {
    throwIfAborted(init.signal ?? undefined);
    if (error instanceof BackendApiError) throw error;
    if (controller.signal.aborted) throw new Error('支付服务响应超时，请查询订单状态后再试。');
    if (error instanceof SyntaxError) invalid();
    throw createApiConnectionError(`${root}${path}`, error);
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', abort);
  }
}

export function parsePackage(value: unknown): PaymentPackage {
  if (!record(value) || !text(value.id) || !text(value.title) ||
    !integer(value.credits, 1) || !integer(value.amountFen, 1) || value.currency !== 'CNY') invalid();
  return { id: value.id as string, title: value.title as string, credits: value.credits as number,
    amountFen: value.amountFen as number, currency: 'CNY' };
}

export function parseOrder(value: unknown): PaymentOrder {
  if (!record(value) || !text(value.id) || !text(value.packageId) ||
    !integer(value.credits, 1) || !integer(value.amountFen, 1) || value.currency !== 'CNY' ||
    !['pending', 'paid', 'closed', 'failed'].includes(String(value.status)) ||
    !text(value.createdAt) || !Number.isFinite(Date.parse(value.createdAt as string))) invalid();
  return { id: value.id as string, packageId: value.packageId as string,
    credits: value.credits as number, amountFen: value.amountFen as number, currency: 'CNY',
    status: value.status as PaymentOrder['status'], createdAt: value.createdAt as string };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string { return typeof value === 'string' && Boolean(value.trim()); }
function integer(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}
function invalid(): never { throw new BackendApiError('支付服务返回的数据不完整，请稍后重试。', 502); }
