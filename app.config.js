// app.json remains the shared app configuration. Only public WeChat identifiers
// belong here; merchant keys and APIv3 secrets must stay on the backend.
module.exports = ({ config }) => {
  const appId = process.env.EXPO_PUBLIC_WECHAT_APP_ID?.trim();
  const universalLink = process.env.EXPO_PUBLIC_WECHAT_UNIVERSAL_LINK?.trim();
  const schemes = typeof config.scheme === 'string' ? [config.scheme] : [...(config.scheme ?? [])];
  if (appId && /^wx[\da-z]+$/i.test(appId)) schemes.push(appId);

  let associatedDomains = config.ios?.associatedDomains ?? [];
  if (universalLink) {
    const url = new URL(universalLink);
    if (url.protocol !== 'https:') throw new Error('WeChat Universal Link must use HTTPS.');
    associatedDomains = [...new Set([...associatedDomains, `applinks:${url.hostname}`])];
  }

  return {
    ...config,
    scheme: [...new Set(schemes)],
    ios: { ...config.ios, associatedDomains },
    plugins: [...(config.plugins ?? []), ['expo-wechat', { enablePay: true }], './build/payment/config-plugin'],
  };
};
