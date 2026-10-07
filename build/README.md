# 平台构建

平台专属脚本、Expo config plugin 和环境说明统一放在此目录；各平台的产物与日志放在自己的 `output/` 中，Git 只忽略产物。

```text
build/
├── ios/
│   ├── build.sh
│   ├── config-plugin.js
│   ├── with-scene-lifecycle.js
│   ├── scene-delegate.swift
│   ├── README.md
│   └── output/           # simulator/、device/，不提交
└── android/
    ├── build.sh
    ├── config-plugin.js
    ├── README.md
    └── output/           # APK、日志，不提交
```

先在项目根目录执行 `pnpm install --frozen-lockfile`，将 `.env.example` 复制为 `.env`。当前 API 根地址是 `http://8.135.57.75:3000`，不要加 `/api/health`。Expo 从项目根目录读取 `.env`；修改 API 地址后要重新构建 Release App。

| 平台 | 构建命令 | 环境说明 |
| --- | --- | --- |
| iOS 模拟器 | `pnpm ios:build` | [iOS](ios/README.md) |
| iOS 真机（未签名） | `pnpm ios:build:device` | [iOS](ios/README.md) |
| Android APK | `pnpm android:build` | [Android](android/README.md) |

Expo 生成的原生工程仍位于项目根目录 `ios/`、`android/`，这是 Expo CLI 的目录约定，两者都不提交。构建脚本从任意工作目录启动都能定位项目根目录。iOS plugin 只注册 iOS 配置修改，Android prebuild 不会执行 Pods 或要求 Xcode。
