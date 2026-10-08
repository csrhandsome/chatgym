import AsyncStorage from '@react-native-async-storage/async-storage';

import type { PaymentMode, PaymentOrder } from '@/services/payment-types';

const STORAGE_PREFIX = 'chatgym.payment.pending.v1:';
const operations = new Map<string, Promise<unknown>>();

export type StoredPendingPaymentOrder = {
  mode: 'wechat';
  order: PaymentOrder;
};

export function loadPendingPaymentOrder(userId: string): Promise<StoredPendingPaymentOrder | null> {
  const key = storageKey(userId);
  return serialize(key, async () => {
    const stored = await AsyncStorage.getItem(key);
    if (stored === null) return null;

    const record = parseStoredOrder(stored);
    if (record.order.status !== 'pending') {
      await AsyncStorage.removeItem(key);
      return null;
    }
    return record;
  });
}

export function savePendingPaymentOrder(
  userId: string,
  mode: PaymentMode,
  order: PaymentOrder
): Promise<void> {
  if (mode === 'mock') return Promise.resolve();
  if (mode !== 'wechat') return Promise.reject(new Error('当前支付方式不能创建待支付订单。'));

  const key = storageKey(userId);
  return serialize(key, async () => {
    validateOrder(order);
    if (order.status !== 'pending') {
      await removeIfMatches(key, order.id);
      return;
    }
    const record: StoredPendingPaymentOrder = { mode, order };
    await AsyncStorage.setItem(key, JSON.stringify(record));
  });
}

export function clearPendingPaymentOrder(userId: string, orderId: string): Promise<void> {
  const key = storageKey(userId);
  return serialize(key, async () => {
    await removeIfMatches(key, orderId);
  });
}

function storageKey(userId: string) {
  if (!userId.trim()) throw new Error('无法保存支付订单：账户标识缺失。');
  return `${STORAGE_PREFIX}${encodeURIComponent(userId)}`;
}

function serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = operations.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  operations.set(key, current);
  const cleanup = () => {
    if (operations.get(key) === current) operations.delete(key);
  };
  void current.then(cleanup, cleanup);
  return current;
}

async function removeIfMatches(key: string, orderId: string) {
  const stored = await AsyncStorage.getItem(key);
  if (stored === null) return;
  const record = parseStoredOrder(stored);
  if (record.order.id === orderId) await AsyncStorage.removeItem(key);
}

function parseStoredOrder(value: string): StoredPendingPaymentOrder {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalidStoredOrder();
  }
  if (!isRecord(parsed) || parsed.mode !== 'wechat') throw invalidStoredOrder();
  validateOrder(parsed.order);
  return { mode: 'wechat', order: parsed.order };
}

function validateOrder(value: unknown): asserts value is PaymentOrder {
  if (!isRecord(value) || !isNonEmptyString(value.id) || !isNonEmptyString(value.packageId) ||
    !Number.isSafeInteger(value.credits) || Number(value.credits) < 1 ||
    !Number.isSafeInteger(value.amountFen) || Number(value.amountFen) < 1 ||
    value.currency !== 'CNY' ||
    !['pending', 'paid', 'closed', 'failed'].includes(String(value.status)) ||
    !isNonEmptyString(value.createdAt) || !Number.isFinite(Date.parse(value.createdAt))) {
    throw invalidStoredOrder();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function invalidStoredOrder() {
  return new Error('本地待支付订单记录异常。为避免重复支付，请先恢复或核对原订单。');
}
