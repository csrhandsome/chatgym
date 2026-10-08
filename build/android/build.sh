#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
export NODE_ENV=production
output_dir="$PWD/build/android/output"
mkdir -p "$output_dir"

pnpm exec expo export --platform android --clear --output-dir "$output_dir/bundle"
pnpm exec expo prebuild --platform android --no-install
(
  cd android
  ./gradlew :app:assembleRelease
) 2>&1 | tee "$output_dir/build.log"
cp android/app/build/outputs/apk/release/app-release.apk "$output_dir/chatgym.apk"
