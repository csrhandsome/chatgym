export type PaymentMode = 'disabled' | 'mock' | 'wechat';
export type PaymentPackage = {
  id: string;
  title: string;
  credits: number;
  amountFen: number;
  currency: 'CNY';
};
export type PaymentOrder = Omit<PaymentPackage, 'title'> & {
  packageId: string;
  status: 'pending' | 'paid' | 'closed' | 'failed';
  createdAt: string;
};
export type WechatPayParams = {
  appId: string;
  partnerId: string;
  prepayId: string;
  nonceStr: string;
  timeStamp: number;
  sign: string;
  package: string;
};
export type PaymentPreparation = { orderId: string; params: WechatPayParams };
export type PaymentResult = {
  outcome: 'paid' | 'pending' | 'cancelled' | 'failed';
  order: PaymentOrder;
};
export interface PaymentApi {
  listPackages(token: string, signal?: AbortSignal): Promise<PaymentPackage[]>;
  getBalance(token: string, signal?: AbortSignal): Promise<{ remaining: number }>;
  createOrder(token: string, input: { packageId: string; idempotencyKey: string }, signal?: AbortSignal): Promise<PaymentOrder>;
  prepareWechat(token: string, orderId: string, signal?: AbortSignal): Promise<PaymentPreparation>;
  getOrder(token: string, orderId: string, signal?: AbortSignal): Promise<PaymentOrder>;
}
export interface PaymentProvider {
  checkAvailability(signal?: AbortSignal): Promise<void>;
  launch(preparation: PaymentPreparation, signal?: AbortSignal): Promise<'sent' | 'cancelled' | 'failed'>;
}
export type MockPaymentScenario = 'success' | 'cancelled' | 'failed' | 'pending';

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('支付操作已停止。', 'AbortError');
}

export function assertToken(token: string): void {
  if (!token.trim()) throw new Error('请先登录后再购买次数。');
}
