# Android 构建

在另一台机器上构建时，需要 Node.js 20.19.4 或更新版本、pnpm 10.33.0、JDK 17、Android Studio 与 Android SDK。配置 `JAVA_HOME` 和 `ANDROID_HOME`，确保 SDK 平台和 Build Tools 已安装。脚本使用 Bash，可在 macOS、Linux 或 Windows Git Bash 中运行。

在项目根目录执行：

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm android:build
```

`build.sh` 先清理 Metro 缓存并验证 JS 打包，再生成 Android 原生工程，执行 `:app:assembleRelease`，将 APK 复制为 `build/android/output/chatgym.apk`，Gradle 日志保存到同目录的 `build.log`。JS bundle 包含在 Release APK 中，无需 Metro。显式清缓存可避免 CI 模式下复用旧的 `.env` 配置。

当前脚本沿用 Expo 生成工程的签名配置；正式分发时需单独配置自己的 release keystore，签名材料不提交到 Git。开发调试使用 `pnpm android`。

`config-plugin.js` 在 `.env` 使用 HTTP API 时允许 Android 访问明文 HTTP，避免 Release App 无法连接当前服务器。应用 ID 为 `com.chatgym.app`，共享的 Expo 应用配置仍由根目录 `app.json` 管理。

此环境没有配置 Android SDK，Android 脚本尚未实际构建验证。
