#!/usr/bin/env bash
# Builds a signed App Store build of the app for TestFlight, and with --upload sends it to App Store Connect.
# Usage (from apps/mobile): npm run testflight                 writes dist/testflight/Marionette.ipa
#                           npm run testflight -- --upload     builds and uploads it
# Needs Xcode signed in (Settings › Accounts) to the team in app.json; Xcode registers the App ID and makes the
# distribution certificate and profile on first use. Uploading also needs the app's record in App Store Connect.
# The native project is regenerated from app.json first. The build number is the UTC date and time, so each build is new;
# the version (CFBundleShortVersionString) is "version" in app.json.
set -euo pipefail
cd "$(dirname "$0")/.."
destination=export
[[ "${1:-}" == --upload ]] && destination=upload
out=dist/testflight
build=$(date -u +%Y%m%d.%H%M)
team=$(node -p "require('./app.json').expo.ios.appleTeamId")

npx expo prebuild --platform ios --clean
plutil -replace CFBundleVersion -string "$build" ios/Marionette/Info.plist
rm -rf "$out" && mkdir -p "$out"
cat > "$out/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$destination</string>
  <key>teamID</key><string>$team</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLIST

echo "Archiving build $build (log: $out/archive.log)"
xcodebuild -workspace ios/Marionette.xcworkspace -scheme Marionette -configuration Release -destination generic/platform=iOS \
  -archivePath "$out/Marionette.xcarchive" -allowProvisioningUpdates archive > "$out/archive.log" 2>&1 \
  || { tail -n 40 "$out/archive.log"; exit 1; }
echo "Exporting for App Store Connect ($destination)"
xcodebuild -exportArchive -archivePath "$out/Marionette.xcarchive" -exportPath "$out" \
  -exportOptionsPlist "$out/ExportOptions.plist" -allowProvisioningUpdates > "$out/export.log" 2>&1 \
  || { tail -n 40 "$out/export.log"; exit 1; }
if [[ $destination == upload ]]; then echo "Uploaded build $build; it shows in TestFlight once Apple finishes processing it."
else echo "Built $out/Marionette.ipa (build $build). Run with --upload to send it to App Store Connect."; fi
