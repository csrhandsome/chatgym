import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { sketchTheme } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import {
  createPaymentClient,
  getPaymentMode,
  isPaymentDevelopment,
  type PaymentClient,
} from '@/services/payment-client';
import type { PaymentMode, PaymentOrder, PaymentPackage } from '@/services/payment-types';
import {
  clearPendingPaymentOrder,
  loadPendingPaymentOrder,
  savePendingPaymentOrder,
} from '@/services/payment-order-storage';

type MockScenario = 'success' | 'cancelled' | 'failed' | 'pending';
type Action = 'purchase' | 'resume' | 'confirm' | 'refresh' | null;
type PurchaseOutcome = 'paid' | 'pending' | 'cancelled' | 'failed';

const MOCK_SCENARIOS: { id: MockScenario; label: string }[] = [
  { id: 'success', label: '成功' },
  { id: 'cancelled', label: '取消' },
  { id: 'failed', label: '失败' },
  { id: 'pending', label: '延迟到账' },
];

export function PaymentPanel() {
  const { isHydrating, token, userId } = useAuth();
  const [baseMode] = useState<PaymentMode>(() => getPaymentMode());
  const isDevelopment = isPaymentDevelopment();
  const [isMockMode, setIsMockMode] = useState(false);
  const [mockClient, setMockClient] = useState<PaymentClient | null>(null);
  const baseClient = useMemo(() => createPaymentClient(baseMode), [baseMode]);
  const client = isMockMode && mockClient ? mockClient : baseClient;
  const sessionKey = token && userId ? `${userId}:${token}` : '';

  const [packages, setPackages] = useState<PaymentPackage[]>([]);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [loadedDataScope, setLoadedDataScope] = useState<{ sessionKey: string; client: PaymentClient } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshingBalance, setIsRefreshingBalance] = useState(false);
  const [isRestoringPending, setIsRestoringPending] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [packageError, setPackageError] = useState<string | null>(null);
  const [pendingOrder, setPendingOrder] = useState<PaymentOrder | null>(null);
  const [busyAction, setBusyAction] = useState<Action>(null);
  const [phase, setPhase] = useState<'creating' | 'launching' | 'confirming' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pendingStorageError, setPendingStorageError] = useState<string | null>(null);
  const [mockScenario, setMockScenario] = useState<MockScenario>('success');

  const mountedRef = useRef(false);
  const sessionKeyRef = useRef(sessionKey);
  const previousSessionKeyRef = useRef(sessionKey);
  const clientRef = useRef(client);
  const busyRef = useRef(false);
  const controllersRef = useRef(new Set<AbortController>());
  const pendingOrderRef = useRef<PaymentOrder | null>(null);
  const pendingClientRef = useRef<PaymentClient | null>(null);
  const isRestoringPendingRef = useRef(false);
  const pendingStorageErrorRef = useRef<string | null>(null);
  const confirmPendingRef = useRef<(() => Promise<void>) | null>(null);
  sessionKeyRef.current = sessionKey;

  const makeController = useCallback(() => {
    const controller = new AbortController();
    controllersRef.current.add(controller);
    return controller;
  }, []);

  const releaseController = useCallback((controller: AbortController) => {
    controllersRef.current.delete(controller);
  }, []);

  const isCurrentSession = useCallback((expectedSessionKey: string) => {
    return mountedRef.current && sessionKeyRef.current === expectedSessionKey;
  }, []);

  function beginAction(action: Exclude<Action, null>) {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusyAction(action);
    setErrorMessage(null);
    return true;
  }

  function endAction() {
    busyRef.current = false;
    setBusyAction(null);
    setPhase(null);
  }

  const showPendingStorageError = useCallback((message: string | null) => {
    pendingStorageErrorRef.current = message;
    setPendingStorageError(message);
  }, []);

  const setRestoringPending = useCallback((isRestoring: boolean) => {
    isRestoringPendingRef.current = isRestoring;
    setIsRestoringPending(isRestoring);
  }, []);

  async function rememberOrder(
    order: PaymentOrder,
    orderClient: PaymentClient,
    expectedSessionKey: string
  ) {
    if (!isCurrentSession(expectedSessionKey)) return;
    if (order.status === 'pending') {
      if (orderClient.mode === 'wechat') {
        try {
          if (!userId) throw new Error('无法保存支付订单：账户标识缺失。');
          await savePendingPaymentOrder(userId, orderClient.mode, order);
          if (!isCurrentSession(expectedSessionKey)) return;
          showPendingStorageError(null);
        } catch (error) {
          if (isCurrentSession(expectedSessionKey)) {
            pendingOrderRef.current = order;
            pendingClientRef.current = orderClient;
            setPendingOrder(order);
            showPendingStorageError(getErrorMessage(error));
          }
          throw error;
        }
      }
      pendingOrderRef.current = order;
      pendingClientRef.current = orderClient;
      setPendingOrder(order);
      return;
    }

    if (pendingOrderRef.current?.id === order.id) {
      if (orderClient.mode === 'wechat' && userId) {
        try {
          await clearPendingPaymentOrder(userId, order.id);
          if (!isCurrentSession(expectedSessionKey)) return;
          showPendingStorageError(null);
        } catch (error) {
          if (isCurrentSession(expectedSessionKey)) showPendingStorageError(getErrorMessage(error));
          throw error;
        }
      }
      pendingOrderRef.current = null;
      pendingClientRef.current = null;
      setPendingOrder(null);
    }
  }

  async function updateBalance(
    balanceClient: PaymentClient,
    expectedSessionKey: string,
    signal: AbortSignal
  ) {
    if (!token) return false;
    try {
      const result = await balanceClient.api.getBalance(token, signal);
      if (!isCurrentSession(expectedSessionKey) || signal.aborted) return false;
      setRemaining(result.remaining);
      setBalanceError(null);
      return true;
    } catch (error) {
      if (!isCurrentSession(expectedSessionKey) || signal.aborted) return false;
      setBalanceError(getErrorMessage(error));
      return false;
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    const controllers = controllersRef.current;
    return () => {
      mountedRef.current = false;
      for (const controller of controllers) controller.abort();
      controllers.clear();
    };
  }, []);

  useEffect(() => {
    if (previousSessionKeyRef.current === sessionKey) return;
    previousSessionKeyRef.current = sessionKey;
    for (const controller of controllersRef.current) controller.abort();
    controllersRef.current.clear();
    busyRef.current = false;
    pendingOrderRef.current = null;
    pendingClientRef.current = null;
    setBusyAction(null);
    setPhase(null);
    setPendingOrder(null);
    setPackages([]);
    setRemaining(null);
    setLoadedDataScope(null);
    setIsLoading(false);
    setIsRefreshingBalance(false);
    setRestoringPending(false);
    setBalanceError(null);
    setPackageError(null);
    pendingStorageErrorRef.current = null;
    setPendingStorageError(null);
    setNotice(null);
    setErrorMessage(null);
  }, [sessionKey, setRestoringPending]);

  useEffect(() => {
    if (clientRef.current === client) return;
    clientRef.current = client;
    for (const controller of controllersRef.current) controller.abort();
    controllersRef.current.clear();
    busyRef.current = false;
    setBusyAction(null);
    setPhase(null);
    setPackages([]);
    setRemaining(null);
    setLoadedDataScope(null);
    setIsLoading(false);
    setIsRefreshingBalance(false);
    setBalanceError(null);
    setPackageError(null);
    setNotice(null);
    setErrorMessage(null);
    if (!pendingOrderRef.current) {
      pendingClientRef.current = null;
      setPendingOrder(null);
    }
  }, [client]);

  useEffect(() => {
    if (!token || !userId || isHydrating) {
      setRestoringPending(false);
      pendingOrderRef.current = null;
      pendingClientRef.current = null;
      setPendingOrder(null);
      showPendingStorageError(null);
      return;
    }

    let active = true;
    const expectedSessionKey = sessionKey;
    setRestoringPending(true);
    showPendingStorageError(null);
    void loadPendingPaymentOrder(userId).then((stored) => {
      if (!active || !isCurrentSession(expectedSessionKey)) return;
      if (stored) {
        const restoredClient = createPaymentClient(stored.mode);
        pendingOrderRef.current = stored.order;
        pendingClientRef.current = restoredClient;
        setPendingOrder(stored.order);
      }
    }).catch((error) => {
      if (!active || !isCurrentSession(expectedSessionKey)) return;
      showPendingStorageError(getErrorMessage(error));
    }).finally(() => {
      if (active && isCurrentSession(expectedSessionKey)) setRestoringPending(false);
    });

    return () => { active = false; };
  }, [isCurrentSession, isHydrating, sessionKey, setRestoringPending, showPendingStorageError, token, userId]);

  useEffect(() => {
    if (!token || !userId || isHydrating) {
      setPackages([]);
      setRemaining(null);
      setLoadedDataScope(null);
      setPackageError(null);
      setBalanceError(null);
      setIsLoading(false);
      return;
    }

    if (client.mode === 'disabled') {
      setPackages([]);
      setRemaining(null);
      setLoadedDataScope({ sessionKey, client });
      setPackageError(null);
      setBalanceError(null);
      setIsLoading(false);
      return;
    }

    const expectedSessionKey = sessionKey;
    const controller = makeController();
    setLoadedDataScope({ sessionKey: expectedSessionKey, client });
    setPackages([]);
    setRemaining(null);
    setIsLoading(true);
    setPackageError(null);
    setBalanceError(null);

    void Promise.allSettled([
      client.api.listPackages(token, controller.signal),
      client.api.getBalance(token, controller.signal),
    ]).then(([packageResult, balanceResult]) => {
      if (!isCurrentSession(expectedSessionKey) || controller.signal.aborted) return;

      if (packageResult.status === 'fulfilled') {
        setPackages(packageResult.value);
      } else {
        setPackageError(getErrorMessage(packageResult.reason));
      }

      if (balanceResult.status === 'fulfilled') {
        setRemaining(balanceResult.value.remaining);
      } else {
        setBalanceError(getErrorMessage(balanceResult.reason));
      }
    }).finally(() => {
      releaseController(controller);
      if (isCurrentSession(expectedSessionKey) && !controller.signal.aborted) setIsLoading(false);
    });

    return () => {
      controller.abort();
      releaseController(controller);
    };
  }, [client, isCurrentSession, isHydrating, makeController, releaseController, sessionKey, token, userId]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void confirmPendingRef.current?.();
    });
    return () => subscription.remove();
  }, []);

  function chooseMockScenario(scenario: MockScenario) {
    setMockScenario(scenario);
    const activeMockClient = mockClient ?? createPaymentClient('mock');
    activeMockClient.setMockScenario?.(scenario);
    setMockClient(activeMockClient);
    setIsMockMode(true);
  }

  function enterMockMode() {
    const nextMockClient = createPaymentClient('mock');
    nextMockClient.setMockScenario?.(mockScenario);
    setMockClient(nextMockClient);
    setIsMockMode(true);
    setNotice('已切换到模拟支付。不会扣款，也不会增加真实 AI 次数。');
    setErrorMessage(null);
  }

  async function handleRefreshBalance() {
    if (!token || !sessionKey || !beginAction('refresh')) return;
    const expectedSessionKey = sessionKey;
    const controller = makeController();
    setIsRefreshingBalance(true);
    setNotice(null);
    try {
      const refreshed = await updateBalance(client, expectedSessionKey, controller.signal);
      if (isCurrentSession(expectedSessionKey) && refreshed) setNotice('次数余额已更新。');
    } finally {
      releaseController(controller);
      if (isCurrentSession(expectedSessionKey)) {
        setIsRefreshingBalance(false);
        endAction();
      }
    }
  }

  async function handlePurchase(packageId: string, purchaseClient = client) {
    if (!token || !sessionKey || busyRef.current) return;
    if (isRestoringPendingRef.current) {
      setNotice('正在恢复未完成订单，请稍后再购买。');
      return;
    }
    if (pendingStorageErrorRef.current) {
      setErrorMessage(`待支付订单恢复失败，为避免重复支付已暂停购买：${pendingStorageErrorRef.current}`);
      return;
    }
    if (pendingOrderRef.current) {
      setNotice('请先查询未完成订单的支付结果，再购买新的次数包。');
      return;
    }
    if (purchaseClient.mode === 'wechat' && Platform.OS !== 'android') {
      setErrorMessage('微信支付目前仅支持 Android 客户端。');
      return;
    }
    if (!beginAction('purchase')) return;

    const expectedSessionKey = sessionKey;
    const controller = makeController();
    setNotice(null);
    setPhase('creating');
    try {
      const result = await purchaseClient.purchase(token, packageId, {
        signal: controller.signal,
        onOrder: async (order) => {
          if (isCurrentSession(expectedSessionKey)) {
            await rememberOrder(order, purchaseClient, expectedSessionKey);
          }
        },
        onPhase: (nextPhase) => {
          if (isCurrentSession(expectedSessionKey)) setPhase(nextPhase);
        },
      });
      if (!isCurrentSession(expectedSessionKey) || controller.signal.aborted) return;
      await rememberOrder(result.order, purchaseClient, expectedSessionKey);
      await handleOutcome(result.outcome, result.order, purchaseClient, expectedSessionKey, controller.signal);
    } catch (error) {
      if (!isCurrentSession(expectedSessionKey) || controller.signal.aborted) return;
      if (pendingStorageErrorRef.current) {
        setNotice('订单状态无法安全保存。请先查询这笔订单，确认结果前不要重复购买。');
        setErrorMessage(getErrorMessage(error));
      } else if (pendingOrderRef.current) {
        setNotice('支付流程已中断，但未完成订单已保留。请查询订单结果后再继续购买。');
        setErrorMessage(getErrorMessage(error));
      } else {
        setErrorMessage(getErrorMessage(error));
      }
    } finally {
      releaseController(controller);
      if (isCurrentSession(expectedSessionKey)) endAction();
    }
  }

  async function handleConfirmPending() {
    const order = pendingOrderRef.current;
    if (!order || order.status !== 'pending' || !token || !sessionKey || isRestoringPendingRef.current ||
      busyRef.current) return;

    const expectedSessionKey = sessionKey;
    const orderClient = pendingClientRef.current ?? client;
    if (orderClient.mode === 'disabled') {
      setErrorMessage('这笔微信订单需要在 Android 客户端继续查询。');
      return;
    }
    if (!beginAction('confirm')) return;
    const controller = makeController();
    setNotice(null);
    setPhase('confirming');
    try {
      const result = await orderClient.confirm(token, order.id, controller.signal);
      if (!isCurrentSession(expectedSessionKey) || controller.signal.aborted) return;
      await rememberOrder(result.order, orderClient, expectedSessionKey);
      await handleOutcome(result.outcome, result.order, orderClient, expectedSessionKey, controller.signal);
    } catch (error) {
      if (!isCurrentSession(expectedSessionKey) || controller.signal.aborted) return;
      // A failed lookup says nothing about whether WeChat collected the payment.
      // Keep the order visible and retryable so the user cannot accidentally buy twice.
      pendingOrderRef.current = order;
      pendingClientRef.current = orderClient;
      setPendingOrder(order);
      setErrorMessage(`查询支付结果失败，订单仍保留：${getErrorMessage(error)}`);
    } finally {
      releaseController(controller);
      if (isCurrentSession(expectedSessionKey)) endAction();
    }
  }

  async function handleResumePending() {
    const order = pendingOrderRef.current;
    if (!order || order.status !== 'pending' || !token || !sessionKey || isRestoringPendingRef.current ||
      pendingStorageErrorRef.current || busyRef.current) return;

    const expectedSessionKey = sessionKey;
    const orderClient = pendingClientRef.current ?? client;
    if (orderClient.mode === 'disabled') {
      setErrorMessage('这笔微信订单需要在 Android 客户端继续支付。');
      return;
    }
    if (!beginAction('resume')) return;
    const controller = makeController();
    setNotice(null);
    setPhase('creating');
    try {
      const result = await orderClient.resume(token, order.id, {
        signal: controller.signal,
        onOrder: async (nextOrder) => {
          if (isCurrentSession(expectedSessionKey)) {
            await rememberOrder(nextOrder, orderClient, expectedSessionKey);
          }
        },
        onPhase: (nextPhase) => {
          if (isCurrentSession(expectedSessionKey)) setPhase(nextPhase);
        },
      });
      if (!isCurrentSession(expectedSessionKey) || controller.signal.aborted) return;
      await rememberOrder(result.order, orderClient, expectedSessionKey);
      await handleOutcome(result.outcome, result.order, orderClient, expectedSessionKey, controller.signal);
    } catch (error) {
      if (!isCurrentSession(expectedSessionKey) || controller.signal.aborted) return;
      pendingOrderRef.current = order;
      pendingClientRef.current = orderClient;
      setPendingOrder(order);
      setErrorMessage(`继续支付未完成，订单仍保留：${getErrorMessage(error)}`);
    } finally {
      releaseController(controller);
      if (isCurrentSession(expectedSessionKey)) endAction();
    }
  }

  async function handleOutcome(
    outcome: PurchaseOutcome,
    order: PaymentOrder,
    outcomeClient: PaymentClient,
    expectedSessionKey: string,
    signal: AbortSignal
  ) {
    if (!isCurrentSession(expectedSessionKey) || signal.aborted) return;
    if (outcome === 'paid') {
      await rememberOrder({ ...order, status: 'paid' }, outcomeClient, expectedSessionKey);
      setErrorMessage(null);
      setNotice(outcomeClient.mode === 'mock'
        ? '模拟支付成功。不会扣款，也不会增加真实 AI 次数。'
        : '支付成功，正在更新 AI 次数余额。');
      const refreshed = await updateBalance(outcomeClient, expectedSessionKey, signal);
      if (!isCurrentSession(expectedSessionKey) || signal.aborted) return;
      if (outcomeClient.mode === 'mock') {
        setNotice(refreshed
          ? '模拟支付成功。模拟次数余额已更新，不会增加真实 AI 次数。'
          : '模拟支付成功；模拟余额暂时无法刷新，不会增加真实 AI 次数。');
      } else {
        setNotice(refreshed ? '支付成功，AI 次数余额已更新。' : '支付已确认，余额暂时无法刷新，请稍后手动刷新。');
      }
      return;
    }

    if (outcome === 'pending' || order.status === 'pending') {
      await rememberOrder({ ...order, status: 'pending' }, outcomeClient, expectedSessionKey);
      setNotice(outcome === 'cancelled'
        ? '支付页面已关闭，订单仍在处理中。请查询结果后再购买。'
        : '支付仍在处理中。你可以查询结果；返回应用时也会自动查询。');
      return;
    }

    await rememberOrder(order, outcomeClient, expectedSessionKey);
    if (outcome === 'cancelled') {
      setNotice('本次支付已取消，可以重新选择次数包。');
    } else {
      setErrorMessage('支付未完成，可以稍后重试。');
    }
  }

  confirmPendingRef.current = handleConfirmPending;

  const isAuthenticated = Boolean(token && userId);
  const canUseWechat = client.mode === 'wechat' && Platform.OS === 'android';
  const canMock = isDevelopment;
  const hasPendingOrder = pendingOrder?.status === 'pending';
  const hasCurrentData = loadedDataScope?.sessionKey === sessionKey && loadedDataScope.client === client;
  const visiblePackages = hasCurrentData ? packages : [];
  const visibleRemaining = hasCurrentData ? remaining : null;
  const visibleBalanceError = hasCurrentData ? balanceError : null;
  const visiblePackageError = hasCurrentData ? packageError : null;
  const visibleIsLoading = hasCurrentData && isLoading;

  return (
    <View style={[styles.card, styles.panel]}>
      <View style={styles.headingRow}>
        <View style={styles.headingCopy}>
          <Text style={styles.eyebrow}>AI 使用次数</Text>
          <Text style={styles.title}>次数账户</Text>
        </View>
        <View style={styles.balanceBadge}>
          <Text style={styles.balanceLabel}>{client.mode === 'mock' ? '模拟剩余' : '剩余'}</Text>
          <Text style={styles.balanceValue}>{visibleRemaining === null ? '—' : visibleRemaining}</Text>
        </View>
      </View>

      <Text style={styles.description}>购买次数后可继续使用 ChatGym 的 AI 训练与饮食建议。</Text>

      {canMock ? (
        <View style={styles.mockArea}>
          {isMockMode ? (
            <>
              <Text style={styles.mockTitle}>模拟支付体验</Text>
              <Text style={styles.mockNote}>模拟流程不会扣款，也不会增加真实 AI 次数。</Text>
              <View accessibilityRole="radiogroup" style={styles.scenarioRow}>
                {MOCK_SCENARIOS.map((scenario) => (
                  <Pressable
                    key={scenario.id}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: mockScenario === scenario.id, disabled: Boolean(hasPendingOrder) }}
                    disabled={Boolean(hasPendingOrder) || busyAction !== null}
                    onPress={() => chooseMockScenario(scenario.id)}
                    style={({ pressed }) => [
                      styles.scenarioButton,
                      mockScenario === scenario.id && styles.scenarioButtonSelected,
                      pressed && styles.buttonPressed,
                      (Boolean(hasPendingOrder) || busyAction !== null) && styles.buttonDisabled,
                    ]}>
                    <Text style={[styles.scenarioText, mockScenario === scenario.id && styles.scenarioTextSelected]}>
                      {scenario.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
              {mockScenario === 'pending' ? (
                <Text style={styles.mockHint}>延迟到账会先返回处理中；前两次查询仍处理中，之后模拟到账。</Text>
              ) : null}
              {baseMode !== 'mock' ? (
                <Pressable
                  accessibilityRole="button"
                  disabled={Boolean(hasPendingOrder) || busyAction !== null}
                  onPress={() => setIsMockMode(false)}
                  style={({ pressed }) => [styles.textButton, pressed && styles.buttonPressed,
                    (Boolean(hasPendingOrder) || busyAction !== null) && styles.buttonDisabled]}>
                  <Text style={styles.textButtonLabel}>退出模拟模式</Text>
                </Pressable>
              ) : null}
            </>
          ) : (
            <Pressable
              accessibilityRole="button"
              disabled={Boolean(hasPendingOrder) || busyAction !== null}
              onPress={enterMockMode}
              style={({ pressed }) => [styles.mockButton, pressed && styles.buttonPressed,
                (Boolean(hasPendingOrder) || busyAction !== null) && styles.buttonDisabled]}>
              <Text style={styles.mockButtonText}>体验模拟购买</Text>
            </Pressable>
          )}
        </View>
      ) : null}

      {client.mode === 'disabled' ? (
        <Text style={styles.availabilityNote}>次数购买尚未开放。</Text>
      ) : null}
      {client.mode === 'mock' && !isDevelopment ? (
        <Text style={styles.availabilityNote}>次数购买尚未开放。</Text>
      ) : null}

      {isHydrating ? (
        <View style={styles.inlineStatus}>
          <ActivityIndicator color={sketchTheme.colors.penBlue} />
          <Text style={styles.metaText}>正在恢复登录状态…</Text>
        </View>
      ) : !isAuthenticated ? (
        <Text style={styles.availabilityNote}>登录后可以查看余额并购买 AI 使用次数。</Text>
      ) : (
        <>
          {client.mode !== 'disabled' ? (
            <View style={styles.balanceActions}>
              {visibleRemaining === null && visibleIsLoading ? (
              <View style={styles.inlineStatus}>
                <ActivityIndicator color={sketchTheme.colors.penBlue} />
                <Text style={styles.metaText}>正在加载余额…</Text>
              </View>
            ) : (
              <Pressable
                accessibilityRole="button"
                disabled={busyAction !== null}
                onPress={handleRefreshBalance}
                style={({ pressed }) => [styles.textButton, pressed && styles.buttonPressed,
                  busyAction !== null && styles.buttonDisabled]}>
                {isRefreshingBalance ? <ActivityIndicator color={sketchTheme.colors.ink} /> :
                  <Text style={styles.textButtonLabel}>刷新余额</Text>}
              </Pressable>
              )}
              {visibleIsLoading ? <ActivityIndicator color={sketchTheme.colors.penBlue} /> : null}
            </View>
          ) : null}

          {pendingStorageError ? (
            <Text style={styles.inlineError}>待支付订单存储异常，已暂停新支付：{pendingStorageError}</Text>
          ) : null}
          {isRestoringPending ? (
            <View style={styles.inlineStatus}>
              <ActivityIndicator color={sketchTheme.colors.penBlue} />
              <Text style={styles.metaText}>正在恢复未完成订单…</Text>
            </View>
          ) : null}

          {visibleBalanceError ? <Text style={styles.inlineError}>余额暂不可用：{visibleBalanceError}</Text> : null}
          {visiblePackageError ? (
            <Text style={styles.inlineError}>次数包加载失败：{visiblePackageError}</Text>
          ) : null}

          {visibleIsLoading && visiblePackages.length === 0 ? (
            <View style={styles.inlineStatus}>
              <ActivityIndicator color={sketchTheme.colors.penBlue} />
              <Text style={styles.metaText}>正在加载次数包…</Text>
            </View>
          ) : visiblePackages.length > 0 ? (
            <View style={styles.packageList}>
              {visiblePackages.map((item) => (
                <View key={item.id} style={styles.packageCard}>
                  <View style={styles.packageCopy}>
                    <Text style={styles.packageTitle}>{item.title}</Text>
                    <Text style={styles.packageCredits}>{item.credits} 次 AI 使用</Text>
                  </View>
                  <View style={styles.packageAction}>
                    <Text style={styles.price}>{formatPrice(item.amountFen)}</Text>
                    {canUseWechat ? (
                      <Pressable
                        accessibilityRole="button"
                        disabled={busyAction !== null || Boolean(hasPendingOrder) || isRestoringPending || Boolean(pendingStorageError)}
                        onPress={() => void handlePurchase(item.id)}
                        style={({ pressed }) => [styles.buyButton, pressed && styles.buttonPressed,
                          (busyAction !== null || Boolean(hasPendingOrder) || isRestoringPending || Boolean(pendingStorageError)) && styles.buttonDisabled]}>
                        {busyAction === 'purchase' ? <ActivityIndicator color={sketchTheme.colors.white} /> :
                          <Text style={styles.buyButtonText}>微信支付</Text>}
                      </Pressable>
                    ) : null}
                    {isMockMode && isDevelopment ? (
                      <Pressable
                        accessibilityRole="button"
                        disabled={busyAction !== null || Boolean(hasPendingOrder) || isRestoringPending || Boolean(pendingStorageError)}
                        onPress={() => void handlePurchase(item.id, client)}
                        style={({ pressed }) => [styles.buyButton, styles.mockPurchaseButton,
                          pressed && styles.buttonPressed,
                          (busyAction !== null || Boolean(hasPendingOrder) || isRestoringPending || Boolean(pendingStorageError)) && styles.buttonDisabled]}>
                        {busyAction === 'purchase' ? <ActivityIndicator color={sketchTheme.colors.ink} /> :
                          <Text style={styles.mockPurchaseText}>模拟购买</Text>}
                      </Pressable>
                    ) : null}
                  </View>
                </View>
              ))}
            </View>
          ) : !visibleIsLoading && !visiblePackageError ? (
            <Text style={styles.availabilityNote}>暂无可购买的次数包。</Text>
          ) : null}
        </>
      )}

      {busyAction && phase ? (
        <View style={styles.inlineStatus}>
          <ActivityIndicator color={sketchTheme.colors.penBlue} />
          <Text style={styles.metaText}>{phaseLabel(phase)}</Text>
        </View>
      ) : null}

      {pendingOrder ? (
        <View style={styles.pendingCard}>
          <Text style={styles.pendingTitle}>有一笔支付待确认</Text>
          <Text style={styles.pendingText}>{pendingOrder.credits} 次 · {formatPrice(pendingOrder.amountFen)}</Text>
          <Text style={styles.pendingMeta}>订单号：{pendingOrder.id}</Text>
          {pendingClientRef.current?.mode === 'disabled' ? (
            <Text style={styles.pendingMeta}>请在 Android 客户端继续查询这笔微信订单。</Text>
          ) : null}
          <View style={styles.pendingActionsRow}>
            <Pressable
              accessibilityRole="button"
              disabled={busyAction !== null || isRestoringPending || pendingClientRef.current?.mode === 'disabled'}
              onPress={() => void handleConfirmPending()}
              style={({ pressed }) => [styles.confirmButton, pressed && styles.buttonPressed,
                (busyAction !== null || isRestoringPending || pendingClientRef.current?.mode === 'disabled') && styles.buttonDisabled]}>
              {busyAction === 'confirm' ? <ActivityIndicator color={sketchTheme.colors.white} /> :
                <Text style={styles.buyButtonText}>查询结果</Text>}
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busyAction !== null || isRestoringPending || Boolean(pendingStorageError) || pendingClientRef.current?.mode === 'disabled'}
              onPress={() => void handleResumePending()}
              style={({ pressed }) => [styles.resumeButton, pressed && styles.buttonPressed,
                (busyAction !== null || isRestoringPending || Boolean(pendingStorageError) || pendingClientRef.current?.mode === 'disabled') && styles.buttonDisabled]}>
              {busyAction === 'resume' ? <ActivityIndicator color={sketchTheme.colors.ink} /> :
                <Text style={styles.resumeButtonText}>继续支付</Text>}
            </Pressable>
          </View>
        </View>
      ) : null}

      {notice ? <Text accessibilityRole="text" style={styles.notice}>{notice}</Text> : null}
      {errorMessage ? <Text accessibilityRole="alert" style={styles.inlineError}>{errorMessage}</Text> : null}
    </View>
  );
}

function formatPrice(amountFen: number) {
  return `¥${(amountFen / 100).toFixed(2)}`;
}

function phaseLabel(phase: 'creating' | 'launching' | 'confirming') {
  if (phase === 'creating') return '正在创建支付订单…';
  if (phase === 'launching') return '正在打开微信…';
  return '正在查询支付结果…';
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : '发生未知错误，请稍后再试。';
}

const styles = StyleSheet.create({
  card: {
    borderColor: sketchTheme.colors.ink,
    borderWidth: sketchTheme.border.strong,
    ...sketchTheme.radius.card,
  },
  panel: {
    backgroundColor: sketchTheme.colors.white,
    gap: 12,
    padding: 18,
  },
  headingRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  headingCopy: { gap: 3 },
  eyebrow: {
    color: sketchTheme.colors.penBlue,
    fontSize: 13,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  title: {
    color: sketchTheme.colors.ink,
    fontSize: 25,
    ...(sketchTheme.fonts.heading ? { fontFamily: sketchTheme.fonts.heading } : null),
  },
  balanceBadge: {
    alignItems: 'center',
    backgroundColor: sketchTheme.colors.noteYellow,
    borderColor: sketchTheme.colors.ink,
    borderWidth: sketchTheme.border.regular,
    minWidth: 74,
    paddingHorizontal: 12,
    paddingVertical: 7,
    ...sketchTheme.radius.note,
  },
  balanceLabel: { color: sketchTheme.colors.ink, fontSize: 12 },
  balanceValue: {
    color: sketchTheme.colors.ink,
    fontSize: 23,
    ...(sketchTheme.fonts.heading ? { fontFamily: sketchTheme.fonts.heading } : null),
  },
  description: { color: sketchTheme.colors.ink, fontSize: 15, lineHeight: 22 },
  mockArea: {
    backgroundColor: '#F2F6FF',
    borderColor: sketchTheme.colors.penBlue,
    borderStyle: 'dashed',
    borderWidth: sketchTheme.border.regular,
    gap: 8,
    padding: 12,
    ...sketchTheme.radius.note,
  },
  mockTitle: {
    color: sketchTheme.colors.penBlue,
    fontSize: 16,
    ...(sketchTheme.fonts.heading ? { fontFamily: sketchTheme.fonts.heading } : null),
  },
  mockNote: { color: sketchTheme.colors.ink, fontSize: 13, lineHeight: 19 },
  mockHint: { color: sketchTheme.colors.ink, fontSize: 12, lineHeight: 18 },
  scenarioRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  scenarioButton: {
    alignItems: 'center',
    backgroundColor: sketchTheme.colors.white,
    borderColor: sketchTheme.colors.ink,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 34,
    paddingHorizontal: 10,
    ...sketchTheme.radius.pill,
  },
  scenarioButtonSelected: {
    backgroundColor: sketchTheme.colors.penBlue,
  },
  scenarioText: { color: sketchTheme.colors.ink, fontSize: 13 },
  scenarioTextSelected: { color: sketchTheme.colors.white },
  mockButton: {
    alignItems: 'center',
    backgroundColor: sketchTheme.colors.penBlue,
    borderColor: sketchTheme.colors.ink,
    borderWidth: sketchTheme.border.regular,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 14,
    ...sketchTheme.radius.pill,
  },
  mockButtonText: { color: sketchTheme.colors.white, fontSize: 15 },
  mockPurchaseButton: { backgroundColor: sketchTheme.colors.noteYellow },
  mockPurchaseText: { color: sketchTheme.colors.ink, fontSize: 13 },
  textButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 34,
    paddingHorizontal: 8,
  },
  textButtonLabel: { color: sketchTheme.colors.penBlue, fontSize: 13, textDecorationLine: 'underline' },
  availabilityNote: {
    backgroundColor: sketchTheme.colors.overlay,
    color: sketchTheme.colors.ink,
    fontSize: 14,
    lineHeight: 21,
    padding: 11,
    ...sketchTheme.radius.note,
  },
  balanceActions: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  pendingActionsRow: { flexDirection: 'row', gap: 8 },
  packageList: { gap: 10 },
  packageCard: {
    alignItems: 'center',
    backgroundColor: sketchTheme.colors.paper,
    borderColor: sketchTheme.colors.ink,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 12,
    ...sketchTheme.radius.note,
  },
  packageCopy: { flex: 1, gap: 4, paddingRight: 8 },
  packageTitle: {
    color: sketchTheme.colors.ink,
    fontSize: 16,
    ...(sketchTheme.fonts.heading ? { fontFamily: sketchTheme.fonts.heading } : null),
  },
  packageCredits: { color: '#5A5A5A', fontSize: 13 },
  packageAction: { alignItems: 'flex-end', gap: 6 },
  price: { color: sketchTheme.colors.ink, fontSize: 17 },
  buyButton: {
    alignItems: 'center',
    backgroundColor: sketchTheme.colors.accent,
    borderColor: sketchTheme.colors.ink,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 36,
    minWidth: 90,
    paddingHorizontal: 10,
    ...sketchTheme.radius.pill,
  },
  buyButtonText: { color: sketchTheme.colors.white, fontSize: 13 },
  confirmButton: {
    alignItems: 'center',
    backgroundColor: sketchTheme.colors.penBlue,
    borderColor: sketchTheme.colors.ink,
    borderWidth: 1,
    flex: 1,
    justifyContent: 'center',
    minHeight: 42,
    paddingHorizontal: 14,
    ...sketchTheme.radius.pill,
  },
  resumeButton: {
    alignItems: 'center',
    backgroundColor: sketchTheme.colors.white,
    borderColor: sketchTheme.colors.ink,
    borderWidth: 1,
    flex: 1,
    justifyContent: 'center',
    minHeight: 42,
    paddingHorizontal: 14,
    ...sketchTheme.radius.pill,
  },
  resumeButtonText: { color: sketchTheme.colors.ink, fontSize: 13 },
  pendingCard: {
    backgroundColor: '#FFF6D2',
    borderColor: sketchTheme.colors.ink,
    borderWidth: sketchTheme.border.regular,
    gap: 7,
    padding: 13,
    ...sketchTheme.radius.note,
  },
  pendingTitle: {
    color: sketchTheme.colors.ink,
    fontSize: 16,
    ...(sketchTheme.fonts.heading ? { fontFamily: sketchTheme.fonts.heading } : null),
  },
  pendingText: { color: sketchTheme.colors.ink, fontSize: 14 },
  pendingMeta: { color: '#5A5A5A', fontSize: 12, lineHeight: 17 },
  inlineStatus: { alignItems: 'center', flexDirection: 'row', gap: 8, minHeight: 28 },
  metaText: { color: '#5A5A5A', fontSize: 13 },
  inlineError: { color: '#9E2020', fontSize: 13, lineHeight: 19 },
  notice: {
    backgroundColor: 'rgba(255,255,255,0.72)',
    color: sketchTheme.colors.ink,
    fontSize: 13,
    lineHeight: 19,
    padding: 10,
    ...sketchTheme.radius.note,
  },
  buttonPressed: { opacity: 0.84, transform: [{ translateY: 1 }] },
  buttonDisabled: { opacity: 0.55 },
});
