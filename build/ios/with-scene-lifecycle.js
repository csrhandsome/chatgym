const fs = require('node:fs');
const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');

const marker = '// ChatGym: scene lifecycle for Expo SDK 54 and the iOS 27 SDK.';

module.exports = function withSceneLifecycle(config) {
  config = withInfoPlist(config, (mod) => {
    mod.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [{
          UISceneConfigurationName: 'Default Configuration',
          UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).ChatGymSceneDelegate',
        }],
      },
    };
    return mod;
  });

  return withAppDelegate(config, (mod) => {
    if (mod.modResults.language !== 'swift') {
      throw new Error('ChatGym scene lifecycle requires a Swift AppDelegate.');
    }
    const source = mod.modResults.contents;
    const sceneDelegate = fs.readFileSync(require.resolve('./scene-delegate.swift'), 'utf8');
    if (source.includes(marker)) {
      mod.modResults.contents = source.slice(0, source.indexOf(marker)) + sceneDelegate;
      return mod;
    }
    const startup = /#if os\(iOS\) \|\| os\(tvOS\)\s+window = UIWindow\(frame: UIScreen\.main\.bounds\)\s+factory\.startReactNative\([\s\S]*?launchOptions: launchOptions\)\s+#endif/;
    const property = 'var reactNativeFactory: RCTReactNativeFactory?';
    if (!startup.test(source) || !source.includes(property)) {
      throw new Error('Cannot migrate the AppDelegate: expected Expo SDK 54 startup block is missing.');
    }
    mod.modResults.contents = source
      .replace(property, `${property}\n  var reactNativeLaunchOptions: [UIApplication.LaunchOptionsKey: Any]?`)
      .replace(startup, '    reactNativeLaunchOptions = launchOptions')
      + '\n' + sceneDelegate;
    return mod;
  });
};
