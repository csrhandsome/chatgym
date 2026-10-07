const { withInfoPlist, withPodfile, withPodfileProperties } = require('expo/config-plugins');
const withSceneLifecycle = require('./with-scene-lifecycle');

const minimumVersion = '15.1';
const marker = '# ChatGym: keep all Pods compatible with the current Xcode SDK';

module.exports = function withIosBuildConfig(config) {
  config = withSceneLifecycle(config);
  config = withInfoPlist(config, (mod) => {
    const apiBaseUrl = process.env.EXPO_PUBLIC_API_BASE_URL;
    if (!apiBaseUrl) return mod;
    const apiUrl = new URL(apiBaseUrl);
    if (apiUrl.protocol !== 'http:') return mod;

    const transportSecurity = mod.modResults.NSAppTransportSecurity ?? {};
    const exceptions = transportSecurity.NSExceptionDomains ?? {};
    mod.modResults.NSAppTransportSecurity = {
      ...transportSecurity,
      NSExceptionDomains: {
        ...exceptions,
        [apiUrl.hostname]: {
          ...exceptions[apiUrl.hostname],
          NSExceptionAllowsInsecureHTTPLoads: true,
        },
      },
    };
    return mod;
  });

  config = withPodfileProperties(config, (mod) => {
    mod.modResults['ios.deploymentTarget'] = minimumVersion;
    return mod;
  });

  return withPodfile(config, (mod) => {
    if (mod.modResults.contents.includes(marker)) return mod;
    const hook = 'post_install do |installer|';
    if (!mod.modResults.contents.includes(hook)) {
      throw new Error('Cannot configure the minimum iOS version: Podfile post_install hook is missing.');
    }
    mod.modResults.contents = mod.modResults.contents.replace(hook, `${hook}
    ${marker}
    minimum_ios_version = Gem::Version.new('${minimumVersion}')
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |build_config|
        current_version = build_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
        if current_version.nil? || Gem::Version.new(current_version) < minimum_ios_version
          build_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${minimumVersion}'
        end
      end
    end
`);
    return mod;
  });
};
