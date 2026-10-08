#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
export NODE_ENV=production

# Release includes the JavaScript bundle and runs without a Metro server.
# iphoneos builds are unsigned; installing on a real device requires signing.
sdk="${IOS_BUILD_SDK:-iphonesimulator}"
case "$sdk" in
  iphonesimulator)
    destination='generic/platform=iOS Simulator'
    signing=(CODE_SIGN_IDENTITY=-)
    target=simulator
    ;;
  iphoneos)
    destination='generic/platform=iOS'
    signing=(CODE_SIGNING_ALLOWED=NO)
    target=device
    ;;
  *) echo "IOS_BUILD_SDK must be iphonesimulator or iphoneos" >&2; exit 1 ;;
esac

output_dir="build/ios/output/$target"
command -v pod >/dev/null || { echo 'Install CocoaPods first: brew install cocoapods' >&2; exit 1; }
mkdir -p "$output_dir"
# Expo export:embed skips --reset-cache in CI; clear transforms explicitly so
# changes to EXPO_PUBLIC_* in .env are included in the native Release bundle.
pnpm exec expo export --platform ios --clear --output-dir "$output_dir/bundle"
pnpm exec expo prebuild --platform ios --no-install
pod install --project-directory=ios
xcodebuild \
  -workspace ios/fitnesswithllm.xcworkspace \
  -scheme fitnesswithllm \
  -configuration Release \
  -sdk "$sdk" \
  -destination "$destination" \
  -derivedDataPath "$output_dir" \
  "${signing[@]}" \
  build 2>&1 | tee "$output_dir/build.log"
