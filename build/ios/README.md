# iOS 构建

需要 macOS、完整 Xcode（包含 iOS SDK）、Node.js 20.19.4 或更新版本、pnpm 10.33.0 和 CocoaPods。首次使用 Xcode 时先打开它完成组件安装。

在项目根目录执行：

```bash
brew install cocoapods
pnpm install --frozen-lockfile
cp .env.example .env
pnpm ios:build
```

`build.sh` 先清理 Metro 缓存并验证 JS 打包，再生成原生工程、安装 Pods 并构建 Release App，包含 JS bundle，启动无需 Metro。显式清缓存可避免 CI 模式下复用旧的 `.env` 配置。模拟器使用本地 ad-hoc 签名，无需 Apple 开发者账号。

| 目标 | 命令 | App 路径 |
| --- | --- | --- |
| 模拟器 | `pnpm ios:build` | `build/ios/output/simulator/Build/Products/Release-iphonesimulator/fitnesswithllm.app` |
| 真机，未签名 | `pnpm ios:build:device` | `build/ios/output/device/Build/Products/Release-iphoneos/fitnesswithllm.app` |

每个目标的 `build.log` 在对应的 `output/simulator/` 或 `output/device/` 下。真机 App 安装到 iPhone 或导出 IPA 需要在 Xcode 中配置 Team 与签名。

`config-plugin.js` 将 App 和所有 Pods 的最低 iOS 版本统一为 15.1，兼容 Xcode 27 对旧 deployment target 的检查。插件根据 `.env` 中的 HTTP API 主机写入对应的 ATS 例外，开发构建和 Release 构建均生效。

`with-scene-lifecycle.js` 将 `scene-delegate.swift` 注入生成的 AppDelegate，并写入 scene manifest。窗口和 React Native 在场景连接时创建，URL、通用链接和前后台事件仍转发给 Expo AppDelegate，避免使用 iOS 27 SDK 构建的 App 因缺少 UIScene 生命周期而启动崩溃。

开发时执行 `pnpm ios`；Xcode 调试打开 `ios/fitnesswithllm.xcworkspace`。运行模拟器需要 iOS Simulator Runtime，可在 Xcode Settings → Components 安装，或在 Apple Silicon 上执行：

```bash
xcodebuild -downloadPlatform iOS -architectureVariant arm64
```
