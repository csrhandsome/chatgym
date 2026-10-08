import {
  assertToken, throwIfAborted, type MockPaymentScenario, type PaymentApi,
  type PaymentOrder, type PaymentProvider,
} from '@/services/payment-types';

// Deliberately memory-only: demo balances never enter real auth/chat storage.
export function createMockPayment() {
  let scenario: MockPaymentScenario = 'success';
  let sequence = 0;
  const packages = [
    { id: 'demo-10', title: '体验次数包', credits: 10, amountFen: 100, currency: 'CNY' as const },
    { id: 'demo-100', title: '练习次数包', credits: 100, amountFen: 900, currency: 'CNY' as const },
  ];
  const orders = new Map<string, {
    token: string; order: PaymentOrder; scenario: MockPaymentScenario;
    launched: boolean; checks: number; credited: boolean;
  }>();
  const balances = new Map<string, number>();
  const keys = new Map<string, string>();
  const get = (token: string, id: string, signal?: AbortSignal) => {
    assertToken(token); throwIfAborted(signal);
    const entry = orders.get(id);
    if (!entry || entry.token !== token) throw new Error('未找到当前账户的订单。');
    return entry;
  };
  const api: PaymentApi = {
    async listPackages(token, signal) {
      assertToken(token); throwIfAborted(signal);
      return packages.map((item) => ({ ...item }));
    },
    async getBalance(token, signal) {
      assertToken(token); throwIfAborted(signal);
      return { remaining: balances.get(token) ?? 0 };
    },
    async createOrder(token, input, signal) {
      assertToken(token); throwIfAborted(signal);
      const key = JSON.stringify([token, input.idempotencyKey]);
      const existingId = keys.get(key);
      if (existingId) {
        const existing = get(token, existingId);
        if (existing.order.packageId !== input.packageId) throw new Error('订单请求已存在，请先查询订单。');
        return { ...existing.order };
      }
      const item = packages.find((item) => item.id === input.packageId);
      if (!item || !input.idempotencyKey.trim()) throw new Error('请选择有效的次数包。');
      const order: PaymentOrder = {
        id: `demo-order-${++sequence}`, packageId: item.id, credits: item.credits,
        amountFen: item.amountFen, currency: 'CNY', status: 'pending', createdAt: new Date().toISOString(),
      };
      orders.set(order.id, { token, order, scenario, launched: false, checks: 0, credited: false });
      keys.set(key, order.id);
      return { ...order };
    },
    async prepareWechat(token, orderId, signal) {
      get(token, orderId, signal);
      return { orderId, params: { appId: 'demo', partnerId: 'demo', prepayId: orderId,
        nonceStr: 'demo', timeStamp: 1, sign: 'demo', package: 'Sign=WXPay' } };
    },
    async getOrder(token, orderId, signal) {
      const entry = get(token, orderId, signal);
      if (entry.launched && entry.order.status === 'pending') {
        entry.checks++;
        if (entry.scenario === 'success' || (entry.scenario === 'pending' && entry.checks > 2)) {
          entry.order.status = 'paid';
        } else if (entry.scenario === 'cancelled') entry.order.status = 'closed';
        else if (entry.scenario === 'failed') entry.order.status = 'failed';
      }
      if (entry.order.status === 'paid' && !entry.credited) {
        balances.set(token, (balances.get(token) ?? 0) + entry.order.credits);
        entry.credited = true;
      }
      return { ...entry.order };
    },
  };
  const provider: PaymentProvider = {
    async checkAvailability(signal) { throwIfAborted(signal); },
    async launch(preparation, signal) {
      throwIfAborted(signal);
      const entry = orders.get(preparation.orderId);
      if (!entry) throw new Error('模拟订单不存在。');
      entry.launched = true;
      return entry.scenario === 'cancelled' ? 'cancelled' : entry.scenario === 'failed' ? 'failed' : 'sent';
    },
  };
  return { api, provider, setMockScenario(next: MockPaymentScenario) { scenario = next; } };
}
