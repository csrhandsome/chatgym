const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');

module.exports = function withAndroidBuildConfig(config) {
  return withAndroidManifest(config, (mod) => {
    const apiBaseUrl = process.env.EXPO_PUBLIC_API_BASE_URL;
    if (apiBaseUrl && new URL(apiBaseUrl).protocol === 'http:') {
      const application = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
      application.$['android:usesCleartextTraffic'] = 'true';
    }
    return mod;
  });
};
