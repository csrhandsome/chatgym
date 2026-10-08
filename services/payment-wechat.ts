import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { throwIfAborted, type PaymentProvider } from '@/services/payment-types';

type WechatSdk = typeof import('expo-wechat')['default'];
let nativePaymentActive = false;

export function createWechatPaymentProvider(loadSdk: () => WechatSdk = () => {
  // Lazy loading lets mock/disabled flows and Expo Go run without native WeChat.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('expo-wechat').default;
}): PaymentProvider {
  const appId = process.env.EXPO_PUBLIC_WECHAT_APP_ID?.trim();
  let sdk: WechatSdk | undefined;
  return {
    async checkAvailability(signal) {
      throwIfAborted(signal);
      if (Platform.OS !== 'android') throw new Error('当前平台暂未开放微信购买次数。');
      if (Constants.executionEnvironment === 'storeClient') {
        throw new Error('请使用已集成微信支付的应用安装包。');
      }
      if (!appId || !/^wx[\da-z]+$/i.test(appId)) throw new Error('微信支付尚未配置完成。');
      try { sdk = loadSdk(); } catch { throw new Error('当前安装包未集成微信支付，请重新安装。'); }
      if (!await sdk.registerApp(appId, process.env.EXPO_PUBLIC_WECHAT_UNIVERSAL_LINK?.trim() ?? '')) {
        throw new Error('微信支付初始化失败，请稍后重试。');
      }
      throwIfAborted(signal);
      if (!await sdk.isWXAppInstalled()) throw new Error('请先安装微信后再支付。');
      throwIfAborted(signal);
    },
    async launch(preparation, signal) {
      throwIfAborted(signal);
      if (!sdk || preparation.params.appId !== appId) throw new Error('微信支付参数与当前应用不匹配。');
      if (nativePaymentActive) throw new Error('已有微信支付正在处理中，请先确认订单。');
      nativePaymentActive = true;
      const native = sdk;
      return await new Promise((resolve, reject) => {
        let settled = false;
        let subscription: { remove(): void } | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (result?: 'sent' | 'cancelled' | 'failed', error?: unknown) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          subscription?.remove();
          signal?.removeEventListener('abort', abort);
          nativePaymentActive = false;
          if (error) reject(error); else resolve(result ?? 'sent');
        };
        const abort = () => finish(undefined, new DOMException('支付操作已停止。', 'AbortError'));
        try {
          subscription = native.addListener('onPayResult', (event) => {
            if (event.prepayId && event.prepayId !== preparation.params.prepayId) return;
            finish(event.errorCode === 0 ? 'sent' : event.errorCode === -2 ? 'cancelled' : 'failed');
          });
          signal?.addEventListener('abort', abort, { once: true });
          // Missing/late callback is an uncertain result: query the server.
          timer = setTimeout(() => finish('sent'), 60000);
          const params = preparation.params;
          void native.pay({ partnerId: params.partnerId, prepayId: params.prepayId,
            nonceStr: params.nonceStr, timeStamp: params.timeStamp, sign: params.sign,
            package: params.package, extraData: preparation.orderId }).then((sent) => {
            if (!sent) finish('failed');
          }, () => finish('failed'));
        } catch {
          finish(undefined, new Error('无法发起微信支付，请查询订单状态后再试。'));
        }
      });
    },
  };
}
