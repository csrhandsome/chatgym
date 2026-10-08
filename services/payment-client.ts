import { Platform } from 'react-native';
import { BackendApiError } from '@/services/backend-api';
import { createPaymentApi } from '@/services/payment-api';
import { createMockPayment } from '@/services/payment-mock';
import { createWechatPaymentProvider } from '@/services/payment-wechat';
import {
  assertToken, throwIfAborted, type MockPaymentScenario, type PaymentApi, type PaymentMode,
  type PaymentOrder, type PaymentProvider, type PaymentResult,
} from '@/services/payment-types';

export type { MockPaymentScenario, PaymentMode, PaymentOrder, PaymentPackage, PaymentResult } from '@/services/payment-types';
export type PurchaseOptions = {
  signal?: AbortSignal;
  onOrder?: (order: PaymentOrder) => void | Promise<void>;
  onPhase?: (phase: 'creating' | 'launching' | 'confirming') => void;
};
export type PaymentClient = {
  mode: PaymentMode;
  api: PaymentApi;
  purchase(token: string, packageId: string, options?: PurchaseOptions): Promise<PaymentResult>;
  resume(token: string, orderId: string, options?: PurchaseOptions): Promise<PaymentResult>;
  confirm(token: string, orderId: string, signal?: AbortSignal): Promise<PaymentResult>;
  setMockScenario?: (scenario: MockPaymentScenario) => void;
};

export function isPaymentDevelopment() {
  return typeof __DEV__ !== 'undefined' && __DEV__;
}

export function getPaymentMode(development = isPaymentDevelopment()): PaymentMode {
  const mode = process.env.EXPO_PUBLIC_PAYMENT_MODE?.trim();
  if (mode === 'mock' && development) return 'mock';
  if (mode === 'wechat' && Platform.OS === 'android') return 'wechat';
  return 'disabled';
}

export function createPaymentClient(mode: PaymentMode = getPaymentMode()): PaymentClient {
  if (mode === 'mock' && isPaymentDevelopment()) {
    const mock = createMockPayment();
    return { ...createPaymentFlow(mock.api, mock.provider, mode, 0), setMockScenario: mock.setMockScenario };
  }
  if (mode === 'wechat' && Platform.OS === 'android') {
    return createPaymentFlow(createPaymentApi(), createWechatPaymentProvider(), mode);
  }
  const unavailable = async (): Promise<never> => { throw new Error('次数购买尚未开放。'); };
  return { mode: 'disabled', api: {
    listPackages: unavailable, getBalance: unavailable, createOrder: unavailable,
    prepareWechat: unavailable, getOrder: unavailable,
  }, purchase: unavailable, resume: unavailable, confirm: unavailable };
}

// Injection keeps SDK events, HTTP and order reconciliation independently testable.
export function createPaymentFlow(
  api: PaymentApi, provider: PaymentProvider, mode: PaymentMode = 'wechat', pollDelayMs = 800,
): PaymentClient {
  let purchasing = false;
  const drafts = new Map<string, { packageId: string; idempotencyKey: string }>();
  async function finishOrder(token: string, initialOrder: PaymentOrder, options: PurchaseOptions): Promise<PaymentResult> {
    let order = initialOrder;
    await options.onOrder?.(order);
    throwIfAborted(options.signal);
    if (order.status !== 'pending') return resultFor(order);
    const preparation = await api.prepareWechat(token, order.id, options.signal);
    throwIfAborted(options.signal);
    if (preparation.orderId !== order.id) throw new Error('支付参数与当前订单不匹配。');
    options.onPhase?.('launching');
    const launched = await provider.launch(preparation, options.signal);
    throwIfAborted(options.signal);
    options.onPhase?.('confirming');
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await client.confirm(token, order.id, options.signal);
      await options.onOrder?.(result.order);
      throwIfAborted(options.signal);
      order = result.order;
      if (result.order.status !== 'pending') return result;
      if (launched !== 'sent') return { outcome: launched, order: result.order };
      if (attempt === 0) await pause(pollDelayMs, options.signal);
    }
    return { outcome: 'pending', order };
  }
  const client: PaymentClient = {
    mode, api,
    async confirm(token, orderId, signal) {
      assertToken(token); throwIfAborted(signal);
      const order = await api.getOrder(token, orderId, signal);
      throwIfAborted(signal);
      if (order.id !== orderId) throw new Error('查询结果与当前订单不匹配。');
      return resultFor(order);
    },
    async resume(token, orderId, options = {}) {
      assertToken(token); throwIfAborted(options.signal);
      if (purchasing) throw new Error('订单正在处理中，请勿重复点击。');
      purchasing = true;
      try {
        options.onPhase?.('confirming');
        const current = await client.confirm(token, orderId, options.signal);
        if (current.order.status !== 'pending') {
          await options.onOrder?.(current.order);
          return current;
        }
        await provider.checkAvailability(options.signal);
        return await finishOrder(token, current.order, options);
      } finally { purchasing = false; }
    },
    async purchase(token, packageId, options = {}) {
      assertToken(token); throwIfAborted(options.signal);
      if (purchasing) throw new Error('订单正在处理中，请勿重复点击。');
      if (!packageId.trim()) throw new Error('请选择次数包。');
      purchasing = true;
      try {
        await provider.checkAvailability(options.signal);
        throwIfAborted(options.signal);
        options.onPhase?.('creating');
        const existing = drafts.get(token);
        if (existing && existing.packageId !== packageId) {
          throw new Error('上一次下单结果尚未确认，请先重试原次数包。');
        }
        const draft = existing ?? { packageId, idempotencyKey: createRequestKey() };
        drafts.set(token, draft);
        let order: PaymentOrder;
        try {
          order = await api.createOrder(token, draft, options.signal);
        } catch (error) {
          // Keep the key on timeout/network failure: the server may have created the order.
          if (error instanceof BackendApiError && [400, 401, 403, 404, 422, 501].includes(error.status)) {
            drafts.delete(token);
          }
          throw error;
        }
        if (order.packageId !== packageId) throw new Error('下单结果与所选次数包不匹配。');
        drafts.delete(token);
        return await finishOrder(token, order, options);
      } finally { purchasing = false; }
    },
  };
  return client;
}

function resultFor(order: PaymentOrder): PaymentResult {
  return { order, outcome: order.status === 'paid' ? 'paid' : order.status === 'closed' ? 'cancelled'
    : order.status === 'failed' ? 'failed' : 'pending' };
}
function createRequestKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `payment-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
async function pause(ms: number, signal?: AbortSignal) {
  throwIfAborted(signal);
  if (ms === 0) return;
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('支付操作已停止。', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
