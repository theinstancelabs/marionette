# The iPhone app

`apps/mobile` is the Expo + React Native + TypeScript iPhone app. It opens on a connect page (scan the gateway's QR code, pick it from the gateways nearby, or type its IP; recent addresses and pairing codes are remembered) and then shows the gateway's HTML screen full screen: every control, calibration, the camera return and Stop live in that page. The native `@marionette/arkit` Expo module (`modules/arkit`) streams ARKit world transforms at the camera frame rate, and `@marionette/discovery` (`modules/discovery`) finds gateways over Bonjour. On the simulator (or a build without the native module) it emits a `synthetic`, `limited` bring-up stream so the transport and controls can still be exercised; it is marked `synthetic` and never calibrates. A real ARKit failure, such as denied camera access, is reported instead of falling back.

## Build and install

The ARKit bridge is a native module, so Expo Go is not enough. Build a development client on macOS with Xcode:

```sh
npm install                  # at the repository root
cd apps/mobile
npx expo prebuild --platform ios
npx expo run:ios --device
```

Before the last command, connect and unlock the iPhone over USB, tap **Trust** on the phone, and enable **Developer Mode** under Settings → Privacy & Security → Developer Mode. The first build may open Xcode for signing; select your Apple ID team under the Marionette target's **Signing & Capabilities**. A free Apple team gives a short-lived development install; a paid team gives the normal longer-lived device provisioning.

## Connect to a gateway

Start the gateway on the Mac in another terminal:

```sh
npm run dev:backend          # at the repository root
ipconfig getifaddr en0       # LAN address of this Mac
tailscale ip -4              # use this instead when both devices are on Tailscale
```

Then connect the phone in whichever way is handiest. The Mac and iPhone must be on the same Wi-Fi, or both must be signed into the same Tailscale network.

- **Scan QR code.** The gateway prints a QR code when it starts, and the desktop viewer's **Pair a phone** button shows one. Tap **Scan QR code** on the connect page, or point the iPhone's Camera app at it. The code is a `marionette://pair?…` link with every address of the gateway, its port and its pairing code; the app tries all the addresses at once and keeps the first that answers.
- **Nearby.** Gateways on the same Wi-Fi advertise themselves over Bonjour (`_marionette._tcp`) and are listed under **Nearby**; tap one. Bonjour doesn't reach across Tailscale, so use the QR code or the address there.
- **Type the address.** Type the Mac's IP (for example `192.168.1.20`) and tap **Connect**. Do not use `localhost`: on the phone, `localhost` points back to the phone.

With pairing on (the gateway's default), a phone also needs the gateway's pairing code, eight characters like `K7Q2-M9XD`. The QR code carries it. Otherwise the app asks for it when the gateway turns the phone away (or tap **Pairing code?** to type it first): the gateway prints it when it starts, and the viewer's **Pair a phone** button shows it. Case, dashes and spaces don't matter. The app remembers each code that worked and the addresses where it worked, and sends a saved code only to those addresses: a gateway's id and name are public, so the app asks for the code again when a gateway turns up at a new address, and never sends it to another Nearby entry or link just because it carries the same name or id. If the gateway turns the code away, the app says why; it forgets the code only when the gateway calls it wrong, not when the address is shut out for a minute after too many wrong codes.

If macOS asks whether Node may accept incoming connections, allow it, and allow Local Network access when iOS asks (Nearby and every connection need it). If the gateway can't be reached within a few seconds, the app stays on the connect page and says why.

## Reconnecting

Once connected, a dropped connection doesn't end the session. The screen and ARKit keep running under a **Reconnecting to …** banner with **Leave** at the foot of the screen (clear of the screen's Stop), and the app retries (0.5 s, doubling up to 5 s) until the gateway is back or you leave. It reconnects inside the same ARKit session, so the gateway keeps the phone's calibration. Held buttons and dragged controls are let go when the connection drops and need a fresh press. Nothing pressed or dragged while the gateway is away acts when it comes back: let go and touch it again. The exception is Stop: pressed while reconnecting, it is sent as soon as the gateway accepts the phone again, and the screen says so. A gateway that pings the phone and then says nothing for 3.5 s counts as dropped, even while iOS still thinks the socket is open. The gateway sends its screen on every connection, and the page only reloads when the screen changed. If a different gateway answers at the address, the app leaves and says so instead of carrying on with it. If the gateway no longer accepts the phone's code, the app goes back to the connect page and asks for the new one.

## Orientation and iPad

The connect page turns with the phone. A screen can ask for an orientation with `<meta name="marionette-orientation" content="portrait|landscape|any">`, and the app holds it while that screen shows. The app also runs on iPad, full screen, since iPadOS only honours orientation locks for full-screen apps (and from iOS 27 may treat them as a preference).

## Permissions, native modules and the simulator

The iOS permission strings, the `marionette://` scheme and the Bonjour service are set by `app.json` and `app.plugin.js` (the camera is for ARKit and the QR scanner; the microphone string is there only because the scanner's library links a recording API, and the app never asks for it). The native modules are `modules/arkit` and `modules/discovery`. Use a physical iPhone for ARKit world tracking; the simulator only exercises the limited fallback and cannot validate real tracking or calibration geometry.

In the simulator, `xcrun simctl openurl` stops at an "Open in Marionette?" prompt, so a headless run passes the pairing link at launch instead: `xcrun simctl launch <device> com.instancelabs.marionette -pairingLink 'marionette://pair?v=1&host=127.0.0.1&port=8787'`.

## Signing

`app.json` sets the bundle ID (`com.instancelabs.marionette`) and the signing team (`ios.appleTeamId`); change both to build under another Apple team.

## Ship to TestFlight

The app icon and launch screen are drawn from SVGs in `apps/mobile/assets/`: `icon.svg`, plus `icon-dark.svg` and `icon-tinted.svg` for the iOS dark and tinted home screens, and `splash-icon.svg`. The mark is the same one the connect page shows. After editing one, run `npm run icons` in `apps/mobile` to render the PNGs (it uses headless Google Chrome).

```sh
cd apps/mobile
npm run testflight              # writes dist/testflight/Marionette.ipa
npm run testflight -- --upload  # builds and uploads it to App Store Connect
```

The script regenerates `ios/` from `app.json` (`expo prebuild --clean`), stamps the build number with the UTC date and time (for example `20261027.0930`, so every build is new), archives a Release build and exports it signed for App Store Connect. Xcode must be signed in to the team (Xcode › Settings › Accounts); on first use it registers the App ID and creates the distribution certificate and profile. `app.json` declares no non-exempt encryption, so TestFlight doesn't ask the export-compliance question. For a new version, raise `version` in `app.json`.

Before the first upload, create the app once in App Store Connect: Apps › + › New App, platform iOS, the bundle ID from `app.json`, any SKU (for example `marionette-ios`). The App Store name has to be unique across the store; the home-screen name stays "Marionette" either way. When an upload has finished processing, add internal testers under TestFlight. External testers also need the Test Information page (what to test, a feedback email) and a short beta review.
