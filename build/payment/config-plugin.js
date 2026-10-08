const { withDangerousMod } = require('expo/config-plugins');
const fs = require('node:fs');
const path = require('node:path');

const marker = '# ChatGym WeChat SDK';
const rules = `${marker}\n-keep class com.tencent.mm.opensdk.** { *; }\n-keep class com.tencent.wxop.** { *; }\n-keep class com.tencent.mm.sdk.** { *; }\n`;

module.exports = function withPaymentBuildConfig(config) {
  return withDangerousMod(config, ['android', async (mod) => {
    const file = path.join(mod.modRequest.platformProjectRoot, 'app', 'proguard-rules.pro');
    const existing = fs.readFileSync(file, 'utf8');
    if (!existing.includes(marker)) fs.writeFileSync(file, `${existing}\n${rules}`);
    return mod;
  }]);
};
