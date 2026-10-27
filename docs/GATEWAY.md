# Running the gateway

The gateway (`apps/backend`) is a small Express and WebSocket service. Phones, consoles and robots connect to it; it names each phone, converts its poses into its operator frame, relays every pose and input to consumers, serves the phone screen, runs each phone's calibration, routes camera streams, and asks for a pairing code. It decides nothing about motion.

## Start it

```sh
npm install
npm run dev:backend                              # restarts when the source changes
npm --workspace @marionette/backend run start    # or without watching
```

It listens on `0.0.0.0:8787` and prints its pairing code, a pairing link and a QR code of the link. Phones need the code; clients on the same computer that connect to `localhost` don't (see [Pairing](PROTOCOL.md#pairing)). An address for the gateway can be an IP, `host:port`, a full `ws://` URL or a pairing link; the port defaults to 8787.

There is no TLS, so keep the gateway on the local network or a private tailnet. Browsers may connect (WebSocket) and read the REST API only from loopback pages or pages served from the gateway's own host name; add other origins with `MARIONETTE_ALLOWED_ORIGINS`.

## The gateway as one file

```sh
npm --workspace @marionette/backend run bundle      # writes apps/backend/dist/marionette-gateway.mjs
node apps/backend/dist/marionette-gateway.mjs       # Node 20 or later, from any directory
```

The bundle carries every dependency, the default screen and the screen kit, so a robot can run the gateway without this repository (copy the one file). It reads the same environment as `npm run dev:backend`: `PORT` (`0` picks a free port, and the start line says which), the variables under [Configuration](#configuration), and `MARIONETTE_LOG_DIR` for the diagnostics log, which otherwise goes to `./logs`. `dist/` is not committed; build it again after changing the gateway or the kit.

## Configuration

Everything is set through environment variables.

| Variable | Default | |
|---|---|---|
| `PORT` | `8787` | The port. `0` picks a free one, and the start line says which. |
| `MARIONETTE_AUTH` | `on` | `on`: everyone needs the code but clients on this computer that ask for it by name (see [Pairing](PROTOCOL.md#pairing)). `strict`: everyone does (use it behind a reverse proxy on the same computer, which makes every client look local). `off`: nobody does. |
| `MARIONETTE_TOKEN` | the saved code | Fixes the code (4 to 64 characters). |
| `MARIONETTE_NAME` | the host name | The name in the link, in Bonjour and in `config.serverName`. |
| `MARIONETTE_HOME` | `~/.marionette` | Where `gateway.json` is kept. |
| `MARIONETTE_ADDRESSES` | this computer's addresses | Comma-separated hosts for the link instead. |
| `MARIONETTE_MDNS` | on | `off` stops the Bonjour advertisement. |
| `MARIONETTE_ALLOWED_ORIGINS` | none | Comma-separated browser origins that may connect and read the REST API, for example `http://host:5173`. Pages from loopback or from the gateway's own host name always may. |
| `MARIONETTE_HTML_FILE` | the default screen | A screen file to show, relative to the directory you start the gateway in. Saving it pushes it to every phone. See [SCREENS.md](SCREENS.md). |
| `MARIONETTE_HTML` | | A screen as a fixed string, instead of a file. |
| `MARIONETTE_KIT_DIR` | `packages/kit` (the bundle carries its own) | Where the screen kit is read from. Saving a kit file pushes the screen again. |
| `MARIONETTE_LOG_DIR` | `logs` | Where the diagnostics log goes, relative to the directory you start the gateway in. |
| `MARIONETTE_POSE_LOG_HZ` | `10` | Pose records per second per phone in the diagnostics log; `0` leaves poses out. |
| `MARIONETTE_WATCHDOG_MS` | `1500` | A phone's pose stream counts as stopped after this long without a pose. |
| `MARIONETTE_HOLD_TIMEOUT_MS` | `600` | A hold ends when its repeats stop for this long. |
| `MARIONETTE_STREAM_TIMEOUT_MS` | `400` | A drag ends when its samples stop for this long. |

## Diagnostics log

`npm run dev:backend` (or `npm --workspace @marionette/backend run start`) writes a JSONL log to `logs/gateway-<time>.jsonl` (override the directory with `MARIONETTE_LOG_DIR`) and prints its path. It records each phone's poses at 10 Hz (`MARIONETTE_POSE_LOG_HZ`, `0` disables), each with the raw ARKit position and quaternion, the published operator position and quaternion, and where the phone's top edge, left edge and screen point in both frames. Every record names its phone. It also records every calibration capture or rejection (with the ARKit-world move from the flat reference), the frame each calibration builds (its forward, left and up axes in ARKit world and its heading from the uncalibrated forward), each validation move, every phone, session, tracking and hold change, robots joining and leaving (and a refused second connection), every screen change and refusal, pairing refusals, and WebRTC publishers. Non-pose events are echoed to the console. For example, to list calibration events: `grep '"calibration"' logs/gateway-*.jsonl`.
