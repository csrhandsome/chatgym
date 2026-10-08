# Android 构建

在另一台机器上构建时，需要 Node.js 20.19.4 或更新版本、pnpm 10.33.0、JDK 17 或 21、Android Studio 与 Android SDK。配置 `JAVA_HOME` 和 `ANDROID_HOME`，安装 Android SDK Platform 36、Build Tools 36.0.0、NDK 27.1.12297006 和 CMake 3.22.1。Gradle Wrapper 使用 8.14.3，首次构建需下载依赖。脚本使用 Bash，可在 macOS、Linux 或 Windows Git Bash 中运行。

在项目根目录执行：

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm android:build
```

`build.sh` 先清理 Metro 缓存并验证 JS 打包，再生成 Android 原生工程，执行 `:app:assembleRelease`，将 APK 复制为 `build/android/output/chatgym.apk`，Gradle 日志保存到同目录的 `build.log`。JS bundle 包含在 Release APK 中，无需 Metro。显式清缓存可避免 CI 模式下复用旧的 `.env` 配置。

当前脚本沿用 Expo 生成工程的签名配置；正式分发时需单独配置自己的 release keystore，签名材料不提交到 Git。开发调试使用 `pnpm android`。

`config-plugin.js` 在 `.env` 使用 HTTP API 时允许 Android 访问明文 HTTP，避免 Release App 无法连接当前服务器。应用 ID 为 `com.chatgym.app`，共享的 Expo 应用配置仍由根目录 `app.json` 管理。

2026-10-07 已在 Linux、Node.js 24.14.0、pnpm 10.33.0、OpenJDK 21 环境完成实际 Release 构建，APK 签名校验通过。产物包含 `arm64-v8a`、`armeabi-v7a`、`x86`、`x86_64` 四种架构，最低 Android 7.0（API 24），目标 API 36。APK 内含 Hermes JS bundle，使用 `.env` 中的后端地址。Android 36 模拟器安装、无需 Metro 的冷启动及拍照/聊天/训练/我的四个页面切换通过，崩溃日志为空；未覆盖真机、登录后的业务或真实相机识别。截图与界面检查记录保存在 `output/`。

若 Google Maven 或 Android SDK 下载直连失败，Gradle 需要通过 `GRADLE_OPTS` 显式设置 Java 的 `http.proxyHost`、`http.proxyPort`、`https.proxyHost` 和 `https.proxyPort`；仅设置 `HTTP_PROXY` / `HTTPS_PROXY` 不会自动配置 Gradle。代理地址按构建机器实际环境填写。
