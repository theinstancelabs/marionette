import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { CALIBRATION_STEPS, CHECK_MOVES, CHECK_MOVE_TEXT, CLOSE_CODES, STREAM_RENEW_MS, buildGuidedReference, buildQuickReference, checkCalibrationMove, defaultConfig, describeCheckResult, guidedCaptureError, isLiveControl, isStickInRange, normalizePairingCode, operatorPose, phoneColor, sameValue, sanitizePose, streamEndValue, validateAction, validateCameraFrame, validateHello, validatePing, validatePong, validatePose, validateRobotState, validateRtc, validateScreen, validateStatus, type ActionMessage, type CalibrationCheck, type CalibrationState, type CameraFrameMessage, type CameraStream, type CheckMove, type ConfigMessage, type ControlValue, type GuidedSamples, type GuidedStep, type HelloMessage, type HtmlConfigMessage, type InputMessage, type JsonValue, type LiveControl, type MarionetteMessage, type PhoneInfo, type PosePacket, type PoseReference, type RobotInfo, type RobotStateMessage, type RtcMessage, type ScreenMessage, type StatusMessage, type UiControl, PROTOCOL_VERSION } from '@marionette/protocol';
import { deltaMm, frameSummary, mm, noDiagnostics, rawAxes, type DiagnosticsLog } from './diagnostics.js';
import { describeLink, latency, newLink, ping, pong, stamp, type Link } from './clock.js';
import { advertise, advertisedAddresses, authMode, createLimiter, isLoopback, isOwnHost, loadIdentity, pairing, qrSvg, sameCode, type AuthMode } from './pairing.js';
import { buildScreen, defaultScreen, loadKit, type Layout, type Screen } from './screens.js';
import { screenPreview } from './preview.js';
import { createSignaling } from './rtc.js';

/**
 * The gateway is a relay. Each phone streams its pose and its button presses; the
 * gateway publishes both, tagged with the phone, to every console (the viewer, a ROS 2
 * bridge, a robot controller). It keeps each phone's control values and calibration,
 * runs the calibration flow, and otherwise decides nothing: stopping, scaling and
 * arbitrating between phones belong to the consumer. A robot is a console that talks
 * back (its screen, its state, notices, video signaling); the gateway routes, retains
 * and time-stamps what it says, and never acts on it.
 */
/** A hold button, or a slider or stick being dragged: who is touching it, and when each last said so. */
type Touch = { action: string; holders: Map<WebSocket, number> };
export type Phone = {
  info: PhoneInfo; deviceId?: string; socket?: WebSocket;
  raw?: PosePacket; pose?: PosePacket; lastPoseAt?: number; stale: boolean; poseCount: number;
  values: Map<string, ControlValue>; holds: Map<string, Touch>; streams: Map<string, Touch>;
  // Clients whose stream on a control the gateway ended for silence; their samples count again once they let go.
  dropped: Map<string, Set<WebSocket>>;
  calibration: CalibrationState; reference?: PoseReference; samples: GuidedSamples;
  // The calibration live when guided capture started, and the validation result from before a run, restored on cancel.
  beforeCalibration?: CalibrationState; beforeCheck?: CalibrationCheck;
  // The pose session it was in when it disconnected: coming back in it keeps the calibration.
  resume?: string;
};
/** A robot in the roster: its own stable id, its socket while connected, and the camera streams it publishes over WebRTC. */
type Robot = { info: { id: string; name: string; connected: boolean }; socket?: WebSocket; clientId?: string; streams: Set<string> };
/** A client is a console until it says otherwise; `ready` once it has introduced itself (or stayed quiet for the grace period). */
type Client = { id: string; role: 'console' | 'phone' | 'mirror' | 'robot'; hello: boolean; ready: boolean; phoneId?: string; robotId?: string; follow?: string; shown?: boolean; cameras?: boolean; link: Link };

export type GatewayOptions = {
  watchdogMs?: number; holdTimeoutMs?: number; streamTimeoutMs?: number; heartbeatMs?: number; diagnostics?: DiagnosticsLog;
  /** How often phones and robots are pinged. */
  pingMs?: number;
  /** Pairing; by default from `MARIONETTE_AUTH`, `MARIONETTE_TOKEN`, `MARIONETTE_HOME`, `MARIONETTE_NAME`, `MARIONETTE_MDNS` and `MARIONETTE_ADDRESSES`. */
  auth?: AuthMode; token?: string; home?: string; name?: string; mdns?: boolean; addresses?: string[];
  /** How long a socket that needs the pairing code may stay silent before it is closed with 4401. */
  pairingTimeoutMs?: number;
  /** Where the screen kit is read from (`MARIONETTE_KIT_DIR`). */
  kitDir?: string;
};

// Camera frames are at most 2 MB of data URL; anything larger is rejected before parsing.
const MAX_PAYLOAD_BYTES = 3 * 1024 * 1024, MAX_BUFFERED_BYTES = 1024 * 1024;
// A client that sends no hello within this long is a console (a consumer that only listens).
const CONSOLE_GRACE_MS = 250;
const NEXT_STEP: Record<GuidedStep, GuidedStep | undefined> = { flat: 'forward', forward: 'right', right: 'up', up: undefined };
const NEXT_CHECK: Record<CheckMove, CheckMove | undefined> = { forward: 'right', right: 'up', up: undefined };
const NEXT_STEP_MESSAGE: Partial<Record<GuidedStep, string>> = { forward: 'Flat reference captured. Move the phone straight forward, then press Capture forward', right: 'Forward captured. Return to the flat reference, move straight right, then press Capture right', up: 'Right captured. Return to the flat reference, lift the phone straight up, then press Capture up' };
// Calibration is the one thing the gateway does itself; these actions work whatever control id a screen uses.
const CALIBRATION_ACTIONS = new Set(['calibration.start', 'calibration.capture', 'calibration.cancel', 'calibration.check', 'calibration.captureOrigin', 'calibration.reset']);

function crc32(data: Buffer): number { let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function pngChunk(type: string, data: Buffer): Buffer { const tag = Buffer.from(type, 'ascii'); const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); tag.copy(out, 4); data.copy(out, 8); out.writeUInt32BE(crc32(Buffer.concat([tag, data])), 8 + data.length); return out; }
/**
 * A moving synthetic scene per simulated stream, so it is obvious which is which: the
 * head camera looks out over a floor with both grippers at the bottom corners; an arm
 * camera looks down between its own gripper's jaws (mirrored for the right arm).
 */
function virtualCamera(cameraId: string, kind: string, sessionId: string): CameraFrameMessage {
  const width = 320, height = 180, pixels = Buffer.alloc(height * (width * 3 + 1)); const t = Date.now() / 1000;
  // The two arm cameras are mirror images: each gripper sits off to its own side, reaching for a target on the other.
  const arm = kind === 'arm-left' || kind === 'arm-right'; const side = kind === 'arm-right' ? 1 : -1;
  const glowX = arm ? 160 - side * 62 + 14 * Math.sin(t * 0.7) : 40 + 240 * ((t / 4) % 1), glowY = arm ? 66 + 10 * Math.sin(t * 1.3) : 64;
  const jawX = 160 + side * 52 + 10 * Math.sin(t * 0.5), open = 34 + 8 * Math.sin(t * 0.9), jawTop = 100 + 8 * Math.sin(t * 0.9);
  for (let y = 0; y < height; y++) { const row = y * (width * 3 + 1); pixels[row] = 0; for (let x = 0; x < width; x++) {
    const i = row + 1 + x * 3; const glow = Math.max(0, 1 - Math.hypot(x - glowX, y - glowY) / (arm ? 38 : 55));
    let r = 12 + 22 * y / height + 110 * glow, g = 35 + 65 * y / height + 190 * glow, b = 48 + 65 * y / height + 155 * glow;
    if (arm) {
      // A pale table, and two jaws rising from the bottom edge.
      if (y > 120) { r = 54 + 30 * y / height; g = 62 + 30 * y / height; b = 70 + 30 * y / height; }
      if (y > jawTop && Math.abs(Math.abs(x - jawX) - open) < 12 + (y - jawTop) * 0.22) { r = 22; g = 24; b = 28; }
    } else {
      // A horizon, floor lines converging on it, and both grippers in the bottom corners.
      if (y > 112) { const line = (y - 112) % 14 < 1.2 || Math.abs(((x - 160) / (y - 100)) % 1.6) < 0.06; r = line ? 40 : 18; g = line ? 70 : 34; b = line ? 84 : 44; }
      if (y > 140 && (x < 40 + (y - 140) * 0.8 || x > 280 - (y - 140) * 0.8)) { r = 22; g = 24; b = 28; }
    }
    pixels[i] = Math.min(255, Math.round(r)); pixels[i + 1] = Math.min(255, Math.round(g)); pixels[i + 2] = Math.min(255, Math.round(b)); } }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))]);
  return { type:'camera_frame', version: PROTOCOL_VERSION, sessionId, cameraId, dataUrl:`data:image/png;base64,${png.toString('base64')}`, capturedAt: Date.now() };
}
const monotonicMilliseconds = () => globalThis.performance?.now?.() ?? Date.now();
/** Whether a value suits a declared control, so the gateway can keep it as that phone's value. */
function validValue(control: UiControl, value: unknown): boolean {
  if (control.type === 'toggle') return typeof value === 'boolean';
  if (control.type === 'select') return typeof value === 'string' && control.options.some(option => option.value === value);
  if (control.type === 'slider') return typeof value === 'number' && Number.isFinite(value) && value >= control.min && value <= control.max && Math.abs((value - control.min) / control.step - Math.round((value - control.min) / control.step)) < 1e-6;
  if (control.type === 'joystick') return isStickInRange(value);
  return control.hold ? typeof value === 'boolean' : true;
}
function validCalibrationValue(action: ActionMessage): boolean {
  if (action.action === 'calibration.capture') return CALIBRATION_STEPS.includes(action.value as GuidedStep);
  // No value starts (or restarts) validation; a move name checks that move.
  if (action.action === 'calibration.check') return action.value === undefined || action.value === 'cancel' || CHECK_MOVES.includes(action.value as CheckMove);
  return action.value === undefined;
}
/**
 * Calibration only roughly aligns the axes, so it accepts limited tracking as well: a
 * phone held flat over a desk often blinds its camera while gravity and short moves
 * stay good enough. Synthetic motion and a stale stream never calibrate.
 */
const calibratable = (phone: Phone) => !phone.stale && !!phone.raw && phone.raw.source === 'arkit' && phone.raw.heartbeat && (phone.raw.trackingState === 'normal' || phone.raw.trackingState === 'limited');
/** Browsers always send Origin; refuse pages from other hosts so a web page cannot drive the gateway. */
function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  const allowed = (process.env.MARIONETTE_ALLOWED_ORIGINS ?? '').split(',').map(entry => entry.trim()).filter(Boolean);
  if (allowed.includes(origin)) return true;
  try { const { hostname } = new URL(origin); return ['localhost', '127.0.0.1', '[::1]'].includes(hostname) || (!!host && hostname === new URL(`http://${host}`).hostname); } catch { return false; }
}

export function createServer(port = Number(process.env.PORT) || 8787, options: GatewayOptions = {}) {
  const watchdogMs = options.watchdogMs ?? (Number(process.env.MARIONETTE_WATCHDOG_MS) || 1500);
  // The phone repeats a held press every 200 ms; after three missed repeats the button is no longer known to be held.
  const holdTimeoutMs = options.holdTimeoutMs ?? (Number(process.env.MARIONETTE_HOLD_TIMEOUT_MS) || 600);
  // A value being dragged is repeated every 50 ms while the finger rests; after 400 ms of silence the stream is over.
  const streamTimeoutMs = options.streamTimeoutMs ?? (Number(process.env.MARIONETTE_STREAM_TIMEOUT_MS) || 400);
  const heartbeatMs = options.heartbeatMs ?? 5000; const pingMs = options.pingMs ?? 1000; const pairingTimeoutMs = options.pairingTimeoutMs ?? 3000;
  const diagnostics = options.diagnostics ?? noDiagnostics; const log = diagnostics.write;
  const warn = (msg: string) => log({ kind: 'gateway', msg });
  const sessionId = `marionette-${Math.random().toString(36).slice(2, 9)}`;
  // npm workspace scripts run inside apps/backend, so relative paths resolve from where the command was typed.
  const cwd = process.env.INIT_CWD ?? process.cwd();
  const fromEnv = (value: string | undefined) => value ? path.resolve(cwd, value) : undefined;

  /* ---------- The screen: the default, a file or string the gateway was started with, or a robot's ---------- */
  const kitFiles = loadKit(options.kitDir ?? fromEnv(process.env.MARIONETTE_KIT_DIR), warn); const kit = kitFiles.kit;
  const htmlFile = fromEnv(process.env.MARIONETTE_HTML_FILE);
  // A fixed string wins over a file, and only a file is watched.
  const watchedHtml = process.env.MARIONETTE_HTML === undefined ? htmlFile : undefined;
  const initial: Screen = process.env.MARIONETTE_HTML !== undefined ? { raw: process.env.MARIONETTE_HTML, source: { kind: 'file' } }
    : htmlFile ? { raw: fs.readFileSync(htmlFile, 'utf8'), source: { kind: 'file' } } : { raw: defaultScreen(), source: { kind: 'default' } };
  let first: ReturnType<typeof buildScreen>;
  try { first = buildScreen(initial, kit, sessionId); } catch (error) { throw new Error(`${initial.source.kind === 'default' ? 'The default screen' : 'MARIONETTE_HTML_FILE/HTML'} can't be used: ${(error as Error).message}`); }
  for (const warning of first.warnings) log({ kind: 'html', msg: `marionette-config: ${warning}` });
  const state = { sessionId, screen: initial, htmlConfig: first.config, layout: first.layout, phones: new Map<string, Phone>(), robots: new Map<string, Robot>(), connectedClients: 0 };

  /* ---------- Pairing ---------- */
  const mode = options.auth ?? authMode(process.env.MARIONETTE_AUTH);
  const saved = loadIdentity(options.home ?? fromEnv(process.env.MARIONETTE_HOME) ?? path.join(os.homedir(), '.marionette'), warn);
  const fixedToken = options.token ?? process.env.MARIONETTE_TOKEN;
  const identity = fixedToken === undefined ? saved : { id: saved.id, token: normalizePairingCode(fixedToken) };
  if (identity.token.length < 4 || identity.token.length > 64) throw new Error('MARIONETTE_TOKEN must be 4 to 64 characters (dashes and spaces don\'t count)');
  const name = (options.name ?? process.env.MARIONETTE_NAME ?? os.hostname().replace(/\.local$/i, '')).trim().slice(0, 64) || 'Marionette';
  const mdns = options.mdns ?? process.env.MARIONETTE_MDNS?.trim().toLowerCase() !== 'off';
  const limiter = createLimiter();
  /** The client's address, IPv4 without its IPv6 wrapping. */
  const addressOf = (req: http.IncomingMessage) => (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  const advertised = () => options.addresses ?? advertisedAddresses();
  // Loopback clients that asked for another host, each logged once (up to 64), so a local client refused for it is explained.
  const foreignHosts = new Set<string>();
  /**
   * A client on this computer, which `on` lets in without the code: it comes from loopback and asks for this computer
   * by one of its names. A web page whose DNS was rebound to 127.0.0.1 comes from loopback too, but its Host (and
   * Origin) is still the name the page was loaded from, so it needs the code like any remote client.
   */
  const onThisComputer = (req: http.IncomingMessage) => {
    const address = addressOf(req); if (!isLoopback(address)) return false;
    if (isOwnHost(req.headers.host, advertised())) return true;
    const host = String(req.headers.host ?? '(none)').slice(0, 128);
    if (!foreignHosts.has(host) && foreignHosts.size < 64) { foreignHosts.add(host); log({ kind: 'pairing', address, host, msg: `${address} asked for host ${host}, which is not this computer, so it needs the pairing code (connect to localhost or 127.0.0.1 to go without)` }); }
    return false;
  };
  /**
   * Whether a client may come in: `true`, `false` (it still may, with a hello carrying the code), or why not. A
   * wrong code counts against the address; five in a minute shut it out for a minute.
   */
  const admit = (req: http.IncomingMessage, given: string | undefined): true | false | string => {
    if (mode === 'off' || (mode === 'on' && onThisComputer(req))) return true;
    const address = addressOf(req);
    if (limiter.blocked(address)) { log({ kind: 'pairing', address, msg: `refused ${address}: shut out after too many wrong pairing codes` }); return 'Too many wrong pairing codes; try again in a minute'; }
    if (given === undefined) return false;
    if (sameCode(given, identity.token)) return true;
    const shut = limiter.miss(address);
    log({ kind: 'pairing', address, msg: `refused ${address}: wrong pairing code${shut ? '; shut out for a minute after five in a minute' : ''}` });
    return 'Wrong pairing code';
  };

  const phones = state.phones; const robots = state.robots;
  const clients = new Map<WebSocket, Client>(); const sockets = new Map<string, WebSocket>();
  const alive = new Set<WebSocket>();
  // The latest robot state per robot and phone ('' for every phone), kept for whoever connects later.
  const retained = new Map<string, RobotStateMessage>();
  let clientCount = 0;
  type Reply = { message: string; accepted: boolean };
  const accept = (message: string): Reply => ({ message, accepted: true });
  const refuse = (message: string): Reply => ({ message, accepted: false });

  /* ---------- Views and routing ---------- */
  const roster = (): PhoneInfo[] => [...phones.values()].map(phone => ({ ...phone.info }));
  const declared = (stream: string) => state.layout.cameraStreams.some(candidate => candidate.id === stream);
  /** The connected robot that publishes a declared stream over WebRTC. */
  const publisherOf = (stream: string) => declared(stream) ? [...robots.values()].find(robot => robot.socket && robot.streams.has(stream)) : undefined;
  const cameraStreams = (): CameraStream[] => state.layout.cameraStreams.map(stream => { const robot = publisherOf(stream.id); return robot ? { ...stream, transport: 'webrtc', publisher: robot.info.id } : { ...stream }; });
  const robotRoster = (): RobotInfo[] => [...robots.values()].map(robot => ({ ...robot.info, screen: state.htmlConfig.source?.kind === 'robot' && state.htmlConfig.source.robotId === robot.info.id, streams: [...robot.streams].filter(declared) }));
  const gatewayConfig = (): ConfigMessage => ({ ...defaultConfig(), sessionId, serverName: name, gatewayId: identity.id, auth: mode !== 'off', controls: structuredClone(state.layout.controls), cameraStreams: cameraStreams(), cameraViews: structuredClone(state.layout.cameraViews), phones: roster(), robots: robotRoster() });
  const phoneControls = (phone: Phone): UiControl[] => state.layout.controls.map(control => {
    if (control.type === 'button') return control.hold ? { ...control, held: phone.holds.has(control.id) } : { ...control };
    const value = phone.values.get(control.id);
    const own = (value === undefined ? structuredClone(control) : { ...structuredClone(control), value: structuredClone(value) }) as UiControl;
    return isLiveControl(own) ? { ...own, live: phone.streams.has(control.id) } : own;
  });
  const phoneConfig = (phone: Phone): ConfigMessage => ({ ...gatewayConfig(), phone: { ...phone.info }, calibration: structuredClone(phone.calibration), controls: phoneControls(phone) });
  // Runs for every frame and client, so it reads the phone's value directly instead of building its config.
  const cameraStreamsFor = (phone: Phone) => {
    const pick = state.layout.controls.find(control => control.action === 'camera.view');
    const value = pick?.type === 'select' ? phone.values.get(pick.id) ?? pick.value : undefined;
    return (state.layout.cameraViews.find(view => view.id === value) ?? state.layout.cameraViews[0])?.streams ?? [];
  };
  const followed = (client: Client) => client.role === 'mirror' && client.phoneId ? phones.get(client.phoneId) : undefined;
  const raw = (socket: WebSocket, data: string, droppable = false) => { if (socket.readyState === WebSocket.OPEN && !(droppable && socket.bufferedAmount > MAX_BUFFERED_BYTES)) socket.send(data); };
  const send = (socket: WebSocket, message: MarionetteMessage) => raw(socket, JSON.stringify(message));
  /** Sends to every client `who` accepts. Pose and camera traffic is droppable: a client whose buffer is backing up skips frames. */
  const deliver = (message: MarionetteMessage, who: (client: Client, socket: WebSocket) => boolean, droppable = false) => { const data = JSON.stringify(message); for (const [socket, client] of clients) if (who(client, socket)) raw(socket, data, droppable); };
  /** Consoles and robots (a robot is a console that also talks back). */
  const consoles = (client: Client) => (client.role === 'console' || client.role === 'robot') && client.ready;
  /** The phone itself, consoles, and any mirror of that phone. */
  const audienceOf = (phone: Phone) => (client: Client, socket: WebSocket) => consoles(client) || socket === phone.socket || (client.role === 'mirror' && client.phoneId === phone.info.id);
  /** Retained robot state for a client that just got its config: all of it for a console, the global state and its phone's for a phone or mirror. */
  const replay = (socket: WebSocket, scope: { all?: boolean; phoneId?: string; except?: string }) => { for (const message of retained.values()) if (message.robotId !== scope.except && (scope.all || !message.phoneId || message.phoneId === scope.phoneId)) send(socket, message); };
  /** A console gets the gateway view and every phone's view once, then every change, and the robot state so far. */
  const becomeConsole = (socket: WebSocket, client: Client) => { if (client.ready) return; client.ready = true; send(socket, gatewayConfig()); for (const phone of phones.values()) send(socket, phoneConfig(phone)); replay(socket, { all: true, except: client.robotId }); };
  const publishPhone = (phone: Phone) => deliver(phoneConfig(phone), audienceOf(phone));
  const status = (message: string, phone?: Phone, controlId?: string, values: Record<string, JsonValue> = {}): StatusMessage => ({ type: 'status', version: PROTOCOL_VERSION, sessionId, controlId, message, values, ...(phone ? { phoneId: phone.info.id } : {}) });
  const reply = (phone: Phone, controlId: string, result: Reply) => deliver(status(result.message, phone, controlId, { accepted: result.accepted }), audienceOf(phone));
  const input = (phone: Phone, fields: Omit<InputMessage, 'type' | 'version' | 'phoneId' | 'receivedAt'> & { receivedAt?: number }) => deliver({ type: 'input', version: PROTOCOL_VERSION, phoneId: phone.info.id, receivedAt: stamp(), ...fields }, consoles);
  const sendPing = (socket: WebSocket, client: Client) => send(socket, ping(client.link));

  /* ---------- Holds: the gateway only tracks whether a button is still known to be held ---------- */
  const endHold = (phone: Phone, controlId: string, reason?: string) => {
    const hold = phone.holds.get(controlId); if (!hold) return;
    phone.holds.delete(controlId);
    if (reason) input(phone, { controlId, action: hold.action, value: false, source: 'gateway', reason, sessionId: phone.info.sessionId });
    log({ kind: 'hold', phone: phone.info.id, control: controlId, held: false, reason, msg: `${phone.info.name}: ${controlId} released${reason ? ` (${reason})` : ''}` });
    publishPhone(phone);
  };
  const dropHolder = (phone: Phone, socket: WebSocket, reason: string) => { for (const [controlId, hold] of phone.holds) if (hold.holders.delete(socket) && !hold.holders.size) endHold(phone, controlId, reason); };
  const dropSocketHolds = (socket: WebSocket, reason: string) => { for (const phone of phones.values()) { dropHolder(phone, socket, reason); dropStreamHolder(phone, socket, reason); } };
  const handleHold = (phone: Phone, socket: WebSocket, control: UiControl, action: ActionMessage) => {
    const hold = phone.holds.get(control.id);
    if (action.value === false) { if (hold?.holders.delete(socket) && !hold.holders.size) endHold(phone, control.id); return; }
    // A repeat only ever extends a hold this client already has; it never starts one.
    if (action.renew) { if (hold?.holders.has(socket)) hold.holders.set(socket, monotonicMilliseconds()); return; }
    if (hold) { hold.holders.set(socket, monotonicMilliseconds()); return; }
    phone.holds.set(control.id, { action: control.action, holders: new Map([[socket, monotonicMilliseconds()]]) });
    log({ kind: 'hold', phone: phone.info.id, control: control.id, held: true, msg: `${phone.info.name}: ${control.id} held` });
    publishPhone(phone);
  };

  /* ---------- Streams: a slider or stick being dragged; the gateway only tracks whether its samples keep coming ---------- */
  /** A stream that ends without its final sample settles on the stick's rest (a slider keeps its last value), and consumers are told why. */
  const endStream = (phone: Phone, controlId: string, reason?: string) => {
    const stream = phone.streams.get(controlId); if (!stream) return;
    phone.streams.delete(controlId);
    if (reason) {
      const control = state.layout.controls.find(candidate => candidate.id === controlId);
      const value = streamEndValue(control, phone.values.get(controlId));
      if (value !== undefined) phone.values.set(controlId, value);
      input(phone, { controlId, action: stream.action, value, source: 'gateway', reason, sessionId: phone.info.sessionId });
    }
    log({ kind: 'stream', phone: phone.info.id, control: controlId, live: false, reason, msg: `${phone.info.name}: ${controlId} let go${reason ? ` (${reason})` : ''}` });
    publishPhone(phone);
  };
  const dropStreamHolder = (phone: Phone, socket: WebSocket, reason: string) => {
    for (const [controlId, stream] of phone.streams) if (stream.holders.delete(socket) && !stream.holders.size) endStream(phone, controlId, reason);
    for (const [controlId, sockets] of phone.dropped) if (sockets.delete(socket) && !sockets.size) phone.dropped.delete(controlId);
  };
  /**
   * Live samples start or extend a stream; the final sample (no `live`) ends it. Only the start and
   * the end republish the phone's config: consumers follow the samples themselves in the input stream.
   */
  const handleStream = (phone: Phone, socket: WebSocket, control: LiveControl, action: ActionMessage) => {
    const stream = phone.streams.get(control.id); const dropped = phone.dropped.get(control.id);
    const value = action.value as ControlValue;
    if (!action.live) {
      // Letting go: the final value stands, and a touch the gateway had dropped counts again from the next one.
      if (dropped?.delete(socket) && !dropped.size) phone.dropped.delete(control.id);
      const changed = !sameValue(phone.values.get(control.id) ?? control.value, value);
      phone.values.set(control.id, value);
      if (stream?.holders.delete(socket) && !stream.holders.size) endStream(phone, control.id);
      else if (changed) publishPhone(phone);
      return;
    }
    // A repeat never starts a stream, and a touch the gateway dropped stays dropped until the operator lets go.
    if (dropped?.has(socket) || (action.renew && !stream?.holders.has(socket))) return;
    phone.values.set(control.id, value);
    if (stream) { stream.holders.set(socket, monotonicMilliseconds()); return; }
    phone.streams.set(control.id, { action: control.action, holders: new Map([[socket, monotonicMilliseconds()]]) });
    log({ kind: 'stream', phone: phone.info.id, control: control.id, live: true, msg: `${phone.info.name}: ${control.id} live` });
    publishPhone(phone);
  };

  /* ---------- Phones ---------- */
  /** Mirrors follow the phone they asked for, or the first connected phone; re-resolved whenever the roster changes. */
  const resolveMirrors = () => {
    for (const [socket, client] of clients) {
      if (client.role !== 'mirror') continue;
      const current = client.phoneId ? phones.get(client.phoneId) : undefined;
      const next = client.follow ? phones.get(client.follow) : current?.info.connected ? current : [...phones.values()].find(phone => phone.info.connected);
      if (next?.info.id === client.phoneId && client.shown) continue;
      if (current && current !== next) { dropHolder(current, socket, 'mirror moved to another phone'); dropStreamHolder(current, socket, 'mirror moved to another phone'); }
      // Until its phone appears, a mirror shows the gateway's layout.
      client.phoneId = next?.info.id; client.shown = true;
      send(socket, next ? phoneConfig(next) : gatewayConfig()); replay(socket, { phoneId: client.phoneId });
    }
  };
  // Every phone's config carries the roster, so a roster change republishes all of them, to consoles too (and the
  // gateway view to mirrors still waiting for a phone).
  const rosterChanged = () => {
    deliver(gatewayConfig(), client => consoles(client) || (client.role === 'mirror' && !!client.shown && !client.phoneId));
    for (const phone of phones.values()) publishPhone(phone);
    resolveMirrors();
  };
  /** The lowest free number names the phone and picks its color, so a returning setup gets the same colors. */
  const addPhone = (deviceId?: string): Phone => {
    let n = 1; while (phones.has(`phone-${n}`)) n++;
    const phone: Phone = { info: { id: `phone-${n}`, name: `Phone ${n}`, color: phoneColor(n - 1), connected: true }, deviceId, stale: true, poseCount: 0, values: new Map(), holds: new Map(), streams: new Map(), dropped: new Map(), calibration: { status: 'uncalibrated', epoch: 0 }, samples: {} };
    phones.set(phone.info.id, phone); log({ kind: 'phone', phone: phone.info.id, device: deviceId, msg: `${phone.info.name} joined${deviceId ? '' : ' (no hello: an older app)'}` });
    return phone;
  };
  /**
   * A phone's connection, new or taking over. Coming back inside the ARKit session it was in (the hello's
   * `sessionId`) keeps its calibration: the world is the same. Anything else is a new world, so it starts uncalibrated.
   */
  const attach = (phone: Phone, socket: WebSocket, client: Client, resume?: string) => {
    const previous = phone.socket;
    if (previous && previous !== socket) {
      const old = clients.get(previous); if (old) forget(previous, old);
      dropSocketHolds(previous, 'replaced by a newer connection'); previous.close(CLOSE_CODES.replaced, 'Replaced by a newer connection from this phone');
      publishUnavailablePose(phone, 'replaced by a newer connection');
    }
    if (previous !== socket) {
      const session = previous ? phone.info.sessionId : phone.resume;
      if (resume && resume === session) { phone.info.sessionId = resume; log({ kind: 'session', phone: phone.info.id, session: resume, msg: `${phone.info.name}: back in session ${resume}; calibration kept` }); }
      else { clearCalibration(phone, previous ? 'replaced by a newer connection' : 'reconnected in a new session'); phone.info.sessionId = undefined; }
      phone.raw = undefined; phone.stale = true; phone.lastPoseAt = undefined; phone.resume = undefined;
    }
    phone.socket = socket; phone.info.connected = true; Object.assign(client, { role: 'phone', hello: true, ready: true, phoneId: phone.info.id });
    rosterChanged(); replay(socket, { phoneId: phone.info.id }); sendPing(socket, client);
  };
  const publishUnavailablePose = (phone: Phone, reason: string) => {
    if (!phone.pose || !phone.pose.heartbeat) return;
    phone.pose = { ...phone.pose, trackingState: 'unavailable', heartbeat: false, calibrationVersion: phone.pose.calibrationVersion.endsWith('-stale') ? phone.pose.calibrationVersion : `${phone.pose.calibrationVersion}-stale` };
    deliver(phone.pose, (client, socket) => socket !== phone.socket && audienceOf(phone)(client, socket));
    log({ kind: 'pose-lost', phone: phone.info.id, reason, msg: `${phone.info.name}: pose unavailable (${reason})` });
  };
  const clearCalibration = (phone: Phone, reason: string) => {
    const frameChanged = !!phone.reference;
    if (frameChanged || phone.calibration.status !== 'uncalibrated') log({ kind: 'calibration', phone: phone.info.id, event: 'reset', reason, msg: `${phone.info.name}: calibration cleared (${reason})` });
    phone.reference = undefined; phone.samples = {}; phone.beforeCalibration = undefined; phone.beforeCheck = undefined;
    phone.calibration = { status: 'uncalibrated', epoch: phone.calibration.epoch + (frameChanged ? 1 : 0) };
  };
  /** Holds and drags end; the calibration stays until the phone comes back, in case it comes back in the same session. */
  const disconnectPhone = (phone: Phone, reason: string) => {
    publishUnavailablePose(phone, reason);
    for (const controlId of [...phone.holds.keys()]) endHold(phone, controlId, reason);
    for (const controlId of [...phone.streams.keys()]) endStream(phone, controlId, reason);
    phone.resume = phone.info.sessionId;
    phone.socket = undefined; phone.info.connected = false; phone.info.sessionId = undefined; phone.raw = undefined; phone.stale = true; phone.lastPoseAt = undefined;
    // An older app without a hello can never be recognised again, so it leaves the roster instead of lingering.
    if (!phone.deviceId) {
      phones.delete(phone.info.id); for (const [key, message] of retained) if (message.phoneId === phone.info.id) retained.delete(key);
      log({ kind: 'phone', phone: phone.info.id, msg: `${phone.info.name} left` });
    } else log({ kind: 'phone', phone: phone.info.id, msg: `${phone.info.name} disconnected (${reason})` });
    rosterChanged();
  };

  /* ---------- Robots ---------- */
  /** A robot keeps its place in the roster for the gateway's lifetime. One connection per robot id: a second is refused, not swapped in. */
  const joinRobot = (socket: WebSocket, client: Client, hello: HelloMessage) => {
    const id = hello.robotId!; const known = robots.get(id);
    if (known?.socket) { log({ kind: 'robot', robot: id, msg: `refused a second connection as robot ${id} (4409): it is already connected` }); socket.close(CLOSE_CODES.robotIdInUse, `A robot with id ${id} is already connected`); return; }
    const robot: Robot = known ?? { info: { id, name: id, connected: false }, streams: new Set() };
    robot.info = { id, name: hello.name?.trim() || known?.info.name || id, connected: true }; robot.socket = socket; robot.clientId = client.id; robots.set(id, robot);
    client.role = 'robot'; client.robotId = id; client.cameras = hello.cameras === true;
    log({ kind: 'robot', robot: id, msg: `Robot ${robot.info.name} (${id}) ${known ? 'reconnected' : 'joined'}` });
    rosterChanged(); becomeConsole(socket, client); sendPing(socket, client);
  };
  const leaveRobot = (robot: Robot) => {
    const streams = [...robot.streams]; robot.socket = undefined; robot.clientId = undefined; robot.info.connected = false; robot.streams.clear();
    log({ kind: 'robot', robot: robot.info.id, msg: `Robot ${robot.info.name} (${robot.info.id}) disconnected${streams.length ? `; ${streams.join(', ')} no longer published` : ''}` });
    rosterChanged();
  };
  const robotsOnly = (socket: WebSocket, what: string) => send(socket, status(`Only a robot sends ${what}: say hello with role "robot" and a robotId`, undefined, what, { accepted: false }));
  /**
   * Robot state goes to the phone it names (with that phone's mirrors and the consoles), or to every phone, mirror
   * and console; never back to its robot. The latest of each is kept, also after the robot leaves.
   */
  const handleRobotState = (socket: WebSocket, client: Client, message: RobotStateMessage) => {
    if (client.role !== 'robot') { robotsOnly(socket, 'robot_state'); return; }
    const phone = message.phoneId ? phones.get(message.phoneId) : undefined; if (message.phoneId && !phone) return;
    const robotId = client.robotId!;
    const relayed: RobotStateMessage = { type: 'robot_state', version: PROTOCOL_VERSION, robotId, ...(phone ? { phoneId: phone.info.id } : {}), state: message.state,
      ...(message.everyMs !== undefined ? { everyMs: message.everyMs } : {}), ...(message.sentAt !== undefined ? { sentAt: message.sentAt } : {}), receivedAt: stamp() };
    retained.set(`${robotId} ${relayed.phoneId ?? ''}`, relayed);
    deliver(relayed, (other, otherSocket) => otherSocket !== socket && (phone ? audienceOf(phone)(other, otherSocket) : other.role === 'phone' || other.role === 'mirror' || consoles(other)));
  };

  /* ---------- Screens: the newest wins, a robot's push or a save of the screen file ---------- */
  const describe = (source: Screen['source']) => source.kind === 'robot' ? `robot ${source.robotId}` : source.kind === 'file' ? watchedHtml ?? 'MARIONETTE_HTML' : 'the default screen';
  /** After a layout change: a value the control no longer accepts goes back to the default, and a hold whose button is gone ends. */
  const fitLayout = (phone: Phone) => {
    for (const [id, value] of phone.values) { const control = state.layout.controls.find(candidate => candidate.id === id); if (control && !validValue(control, value)) phone.values.delete(id); }
    for (const [id, hold] of [...phone.holds]) if (!state.layout.controls.some(control => control.type === 'button' && control.hold && control.id === id && control.action === hold.action)) endHold(phone, id, 'screen changed');
    for (const [id, stream] of [...phone.streams]) if (!state.layout.controls.some(control => isLiveControl(control) && control.id === id && control.action === stream.action)) endStream(phone, id, 'screen changed');
    phone.dropped.clear();
  };
  /** Shows a screen on every client unless it is the one showing. A screen that can't be used is refused and the previous one stays. */
  const showScreen = (next: Screen): Reply & { warnings: string[] } => {
    let built: ReturnType<typeof buildScreen>;
    try { built = buildScreen(next, kit, sessionId); }
    catch (error) {
      const reason = (error as Error).message;
      log({ kind: 'html', source: next.source.kind, robot: next.source.robotId, msg: `screen from ${describe(next.source)} refused, keeping the previous one: ${reason}` });
      return { ...refuse(`Screen refused: ${reason}. The previous screen stays`), warnings: [] };
    }
    const current = state.htmlConfig;
    if (built.config.html === current.html && built.config.title === current.title && built.config.source?.kind === current.source?.kind && built.config.source?.robotId === current.source?.robotId) return { ...accept('This screen is already showing'), warnings: built.warnings };
    const replaced = describe(state.screen.source); const from = describe(next.source);
    state.screen = next; state.htmlConfig = built.config; state.layout = built.layout;
    deliver(state.htmlConfig, () => true);
    for (const phone of phones.values()) fitLayout(phone);
    rosterChanged();
    log({ kind: 'html', source: next.source.kind, robot: next.source.robotId, file: next.source.kind === 'file' ? watchedHtml : undefined, msg: from === replaced ? `screen reloaded from ${from}` : `screen from ${from} replaces ${replaced}` });
    for (const warning of built.warnings) log({ kind: 'html', msg: `marionette-config: ${warning}` });
    const showing = [...phones.values()].filter(phone => phone.info.connected).length;
    return { ...accept(`Showing your screen (${showing} phone${showing === 1 ? '' : 's'} connected)`), warnings: built.warnings };
  };
  const handleScreen = (socket: WebSocket, client: Client, message: ScreenMessage) => {
    if (client.role !== 'robot') { robotsOnly(socket, 'screen'); return; }
    const result = showScreen({ raw: message.html, ...(message.title ? { title: message.title } : {}), source: { kind: 'robot', robotId: client.robotId! } });
    send(socket, status(result.message, undefined, 'screen', { accepted: result.accepted, ...(result.warnings.length ? { warnings: result.warnings } : {}) }));
  };
  // A custom screen file is pushed to every client whenever it is saved, so it can be edited live; so is a change to the kit.
  const reloadHtml = () => {
    let raw: string;
    try { raw = fs.readFileSync(watchedHtml!, 'utf8'); } catch (error) { log({ kind: 'html', file: watchedHtml, msg: `screen not reloaded, keeping the previous one: ${(error as Error).message}` }); return; }
    showScreen({ raw, source: { kind: 'file' } });
  };
  const reloadKit = () => { if (!kitFiles.reload()) return; log({ kind: 'html', msg: 'the screen kit changed' }); showScreen(state.screen); };

  /* ---------- WebRTC signaling: the gateway introduces viewers to publishers; the video goes between them ---------- */
  const signaling = createSignaling({ send: (clientId, message) => { const socket = sockets.get(clientId); if (socket) send(socket, message); }, publisherOf: stream => publisherOf(stream)?.clientId });
  const rtcError = (socket: WebSocket, about: RtcMessage, message: string) => send(socket, { type: 'rtc', version: PROTOCOL_VERSION, kind: 'error', ...(about.stream ? { stream: about.stream } : {}), ...(about.peer ? { peer: about.peer } : {}), message });
  /** A robot publishes declared streams (a stream has one publisher: the latest), or stops publishing them (all, without `streams`). */
  const handlePublish = (socket: WebSocket, client: Client, message: RtcMessage) => {
    const robot = client.role === 'robot' ? robots.get(client.robotId!) : undefined;
    if (!robot) { rtcError(socket, message, 'Only a robot publishes streams: say hello with role "robot" and a robotId'); return; }
    if (message.kind === 'unpublish') {
      const gone = (message.streams ?? [...robot.streams]).filter(stream => robot.streams.delete(stream)); if (!gone.length) return;
      signaling.unpublished(client.id, gone); log({ kind: 'rtc', robot: robot.info.id, streams: gone, msg: `${robot.info.name} stopped publishing ${gone.join(', ')}` }); rosterChanged(); return;
    }
    const streams = message.streams ?? []; const unknown = streams.filter(stream => !declared(stream));
    if (!streams.length) rtcError(socket, message, 'publish needs streams');
    else if (unknown.length) rtcError(socket, message, `Not declared by the screen: ${unknown.join(', ')}. Declare a stream in the marionette-config block before publishing it`);
    const added = streams.filter(stream => declared(stream) && !robot.streams.has(stream)); if (!added.length) return;
    for (const stream of added) { for (const other of robots.values()) if (other !== robot && other.streams.delete(stream) && other.clientId) signaling.unpublished(other.clientId, [stream]); robot.streams.add(stream); }
    log({ kind: 'rtc', robot: robot.info.id, streams: added, msg: `${robot.info.name} publishes ${added.join(', ')} over WebRTC` }); rosterChanged();
  };
  const handleRtc = (socket: WebSocket, client: Client, message: RtcMessage) => {
    if (client.role === 'console') becomeConsole(socket, client);
    if (message.kind === 'publish' || message.kind === 'unpublish') handlePublish(socket, client, message);
    else if (message.kind === 'request') signaling.request(client.id, message);
    else signaling.relay(client.id, message);
  };

  /* ---------- Calibration, per phone ---------- */
  const captureStep = (phone: Phone, value: GuidedStep): Reply => {
    const { status: calibrationStatus, step } = phone.calibration;
    if (calibrationStatus !== 'capturing' || !step) return refuse('Press Start guided calibration first');
    if (value !== step) return refuse(`Complete the ${step} step first`);
    if (!calibratable(phone)) return refuse('Wait for ARKit tracking before capturing this step');
    const raw = phone.raw!;
    const sample = { position: raw.position, rotation: raw.rotation, seq: raw.seq, sessionId: raw.sessionId };
    const error = guidedCaptureError(step, sample, phone.samples);
    const fromFlat = phone.samples.flat ? deltaMm(raw.position, phone.samples.flat.position) : undefined;
    log({ kind: 'calibration', phone: phone.info.id, event: error ? 'reject' : 'capture', step, reason: error, seq: raw.seq, rawMm: mm(raw.position), fromFlatMm: fromFlat, axes: rawAxes(raw),
      msg: `${phone.info.name}: ${step} ${error ? `rejected: ${error}` : 'captured'}${fromFlat ? ` (ARKit world move from flat: ${fromFlat.join(', ')} mm)` : ''}` });
    if (error) return refuse(error);
    phone.samples = { ...phone.samples, [step]: sample };
    const nextStep = NEXT_STEP[step];
    if (nextStep) {
      // Poses keep the old frame until `up`, so the flat spot in that frame tells clients how far each step has moved.
      const anchor = step === 'flat' ? operatorPose(raw, phone.reference).position : phone.calibration.anchor;
      phone.calibration = { ...phone.calibration, step: nextStep, anchor }; return accept(NEXT_STEP_MESSAGE[nextStep]!);
    }
    const epoch = phone.calibration.epoch + 1;
    const reference = buildGuidedReference(phone.samples, epoch);
    const originSeq = phone.samples.flat?.seq;
    phone.samples = {};
    if (!reference) { log({ kind: 'calibration', phone: phone.info.id, event: 'inconsistent', msg: `${phone.info.name}: guided samples inconsistent; back to the flat step` }); phone.calibration = { ...phone.calibration, step: 'flat', anchor: undefined }; return refuse('Calibration samples were inconsistent. Capture the flat reference again'); }
    phone.reference = reference; phone.beforeCalibration = undefined;
    phone.calibration = { status: 'captured', epoch, originSeq, reference };
    const frame = frameSummary(reference);
    log({ kind: 'calibration', phone: phone.info.id, event: 'frame', ...frame, msg: `${phone.info.name}: guided frame epoch ${epoch} in ARKit world: forward [${frame.forward.join(', ')}] left [${frame.left.join(', ')}] up [${frame.up.join(', ')}], heading ${frame.headingDeg}° from uncalibrated forward` });
    return accept('Calibrated: X forward, Y left, Z up. Validate it if you want to double-check');
  };
  /** Optional validation: each move is the calibrated position, i.e. the move from the flat spot in the new frame. */
  const validateStep = (phone: Phone, value: CheckMove | 'cancel' | undefined): Reply => {
    const calibration = phone.calibration; const { reference, check } = calibration;
    if (value === 'cancel') { if (!check?.step) return refuse('Validation is not running'); phone.calibration = { ...calibration, check: phone.beforeCheck }; log({ kind: 'calibration', phone: phone.info.id, event: 'check-cancel', msg: `${phone.info.name}: validation cancelled` }); return accept(phone.beforeCheck?.passed === undefined ? 'Validation cancelled' : 'Validation cancelled; the previous result still stands'); }
    if (calibration.status !== 'captured' || !reference) return refuse('Calibrate first, then validate');
    if (value === undefined) { if (!check?.step) phone.beforeCheck = check; phone.calibration = { ...calibration, check: { step: 'forward', results: [] } }; log({ kind: 'calibration', phone: phone.info.id, event: 'check-start', msg: `${phone.info.name}: validation started` }); return accept(CHECK_MOVE_TEXT.forward.instruction); }
    if (!check?.step) return refuse('Press Validate calibration first');
    if (value !== check.step) return refuse(`Check ${check.step} first`);
    if (!calibratable(phone)) return refuse('Wait for ARKit tracking before checking');
    const raw = phone.raw!;
    const result = checkCalibrationMove(value, operatorPose(raw, reference).position);
    if (typeof result === 'string') { log({ kind: 'calibration', phone: phone.info.id, event: 'check-reject', move: value, reason: result, msg: `${phone.info.name}: check ${value} rejected: ${result}` }); return refuse(result); }
    const results = [...check.results, result];
    log({ kind: 'calibration', phone: phone.info.id, event: 'check', move: value, expected: result.expected, dominant: result.dominant, passed: result.passed, displacementMm: mm(result.displacement), rawMm: mm(raw.position), axes: rawAxes(raw), msg: `${phone.info.name}: check ${describeCheckResult(result)}` });
    const next = NEXT_CHECK[value];
    if (next) { phone.calibration = { ...calibration, check: { step: next, results } }; return accept(`${describeCheckResult(result)}. ${CHECK_MOVE_TEXT[next].instruction}`); }
    const passed = results.every(entry => entry.passed);
    phone.calibration = { ...calibration, check: { results, passed } }; phone.beforeCheck = undefined;
    log({ kind: 'calibration', phone: phone.info.id, event: 'check-summary', passed, results: results.map(describeCheckResult), msg: `${phone.info.name}: validation ${passed ? 'PASSED' : 'FAILED'}: ${results.map(describeCheckResult).join('; ')}` });
    return accept(passed ? 'Validated: forward +X, right −Y, up +Z' : `Validation failed: ${results.filter(entry => !entry.passed).map(describeCheckResult).join('; ')}. Calibrate again`);
  };
  const calibrate = (phone: Phone, action: ActionMessage): Reply => {
    switch (action.action) {
      case 'calibration.start': {
        log({ kind: 'calibration', phone: phone.info.id, event: 'start', msg: `${phone.info.name}: guided calibration started` });
        // Starting again keeps the frame in use until the new one completes.
        if (phone.calibration.status === 'captured') phone.beforeCalibration = { ...phone.calibration, check: phone.calibration.check?.step ? phone.beforeCheck : phone.calibration.check };
        phone.samples = {}; phone.calibration = { status: 'capturing', step: 'flat', epoch: phone.calibration.epoch, reference: phone.reference };
        return accept('Hold the phone roughly flat, screen up, top edge forward, then press Capture flat reference');
      }
      case 'calibration.capture': return captureStep(phone, action.value as GuidedStep);
      case 'calibration.cancel': {
        if (phone.calibration.status !== 'capturing') return refuse('Calibration is not running');
        phone.samples = {}; phone.calibration = phone.beforeCalibration && phone.reference ? phone.beforeCalibration : { status: 'uncalibrated', epoch: phone.calibration.epoch }; phone.beforeCalibration = undefined;
        log({ kind: 'calibration', phone: phone.info.id, event: 'cancel', msg: `${phone.info.name}: guided calibration cancelled; ${phone.calibration.status === 'captured' ? 'previous frame kept' : 'uncalibrated'}` });
        return accept(phone.calibration.status === 'captured' ? 'Calibration cancelled; the previous calibration is still in use' : 'Calibration cancelled');
      }
      case 'calibration.check': return validateStep(phone, action.value as CheckMove | 'cancel' | undefined);
      case 'calibration.captureOrigin': {
        if (!calibratable(phone)) return refuse('Wait for ARKit tracking before capturing origin');
        const raw = phone.raw!; const epoch = phone.calibration.epoch + 1;
        phone.reference = buildQuickReference({ position: raw.position, rotation: raw.rotation, seq: raw.seq, sessionId: raw.sessionId }, epoch);
        phone.samples = {}; phone.beforeCalibration = undefined; phone.calibration = { status: 'captured', epoch, originSeq: raw.seq, reference: phone.reference };
        const frame = frameSummary(phone.reference);
        log({ kind: 'calibration', phone: phone.info.id, event: 'frame', ...frame, msg: `${phone.info.name}: quick frame epoch ${epoch} in ARKit world: forward [${frame.forward.join(', ')}], heading ${frame.headingDeg}° from uncalibrated forward` });
        return accept(`Quick origin captured at sequence ${raw.seq}; up is gravity and forward is the phone heading`);
      }
      default: clearCalibration(phone, 'reset by operator'); return accept('Calibration reset; poses use the gravity-aligned ARKit frame');
    }
  };

  /* ---------- Messages ---------- */
  const handleHello = (socket: WebSocket, client: Client, hello: HelloMessage) => {
    if (client.hello || client.role === 'phone') return;
    client.hello = true;
    if (hello.role === 'phone') {
      const known = hello.deviceId ? [...phones.values()].find(phone => phone.deviceId === hello.deviceId) : undefined;
      if (known) log({ kind: 'phone', phone: known.info.id, msg: `${known.info.name} reconnected` });
      attach(known ?? addPhone(hello.deviceId), socket, client, hello.sessionId); return;
    }
    if (hello.role === 'robot') { joinRobot(socket, client, hello); return; }
    if (hello.follow !== undefined) { client.role = 'mirror'; client.ready = true; client.follow = hello.follow || undefined; resolveMirrors(); return; }
    if (hello.cameras === false) client.cameras = false;
    becomeConsole(socket, client);
  };
  const handleAction = (socket: WebSocket, client: Client, action: ActionMessage, receivedAt: number) => {
    if (client.role === 'console') becomeConsole(socket, client);
    const phone = client.role === 'phone' ? phones.get(client.phoneId!) : followed(client);
    if (!phone) { send(socket, status(client.role === 'mirror' ? 'No phone to act as yet; connect a phone first' : 'Consoles only watch; send controls from a phone or a mirror of one (/screen)', undefined, action.controlId, { accepted: false })); return; }
    // Every action is relayed exactly as received, before anything else, whatever the gateway makes of it.
    const latencyMs = client.role === 'phone' ? latency(client.link, action.sentAt, receivedAt) : undefined;
    input(phone, { controlId: action.controlId, action: action.action, value: action.value, renew: action.renew, live: action.live, source: client.role === 'phone' ? 'phone' : 'mirror', sessionId: action.sessionId, sentAt: action.sentAt, receivedAt, ...(latencyMs !== undefined ? { latencyMs } : {}) });
    if (CALIBRATION_ACTIONS.has(action.action)) {
      if (!validCalibrationValue(action)) { reply(phone, action.controlId, refuse('Action rejected by gateway validation')); return; }
      reply(phone, action.controlId, calibrate(phone, action)); publishPhone(phone); return;
    }
    const control = state.layout.controls.find(candidate => candidate.id === action.controlId && candidate.action === action.action);
    if (!control) return;
    // A refused live sample is not answered: the drag would bury the operator in replies. Its final value is.
    if (!validValue(control, action.value)) { if (!action.renew && !action.live) reply(phone, action.controlId, refuse('Action rejected by gateway validation')); return; }
    if (control.type === 'button' && control.hold) { handleHold(phone, socket, control, action); return; }
    if (isLiveControl(control)) { handleStream(phone, socket, control, action); return; }
    if (control.type === 'button' || sameValue(phone.values.get(control.id), action.value)) return;
    phone.values.set(control.id, action.value!); publishPhone(phone);
  };
  const handlePose = (socket: WebSocket, client: Client, message: PosePacket, receivedAt: number) => {
    // A socket that streams without a hello is an older app; a console that said hello never streams.
    if (client.role !== 'phone') { if (client.hello) return; attach(addPhone(), socket, client); }
    const phone = phones.get(client.phoneId!); if (!phone) return;
    const sessionChanged = phone.info.sessionId !== message.sessionId;
    if (!sessionChanged && phone.raw && (message.seq <= phone.raw.seq || message.monotonicTs <= phone.raw.monotonicTs)) return;
    if (sessionChanged) {
      // A new ARKit session is a new world: nothing calibrated in the old one is valid.
      log({ kind: 'session', phone: phone.info.id, from: phone.info.sessionId, to: message.sessionId, msg: `${phone.info.name}: session ${phone.info.sessionId ?? 'none'} → ${message.sessionId}` });
      if (phone.calibration.status !== 'uncalibrated') clearCalibration(phone, 'phone session changed');
      phone.info.sessionId = message.sessionId; phone.raw = undefined; rosterChanged();
    }
    const previous = phone.raw; const raw = sanitizePose(message); phone.raw = raw;
    if (sessionChanged || previous?.trackingState !== raw.trackingState || previous?.source !== raw.source) log({ kind: 'tracking', phone: phone.info.id, session: raw.sessionId, tracking: raw.trackingState, source: raw.source, msg: `${phone.info.name}: tracking ${raw.trackingState} (${raw.source})` });
    const latencyMs = latency(client.link, raw.sentAt, receivedAt);
    const output: PosePacket = { ...operatorPose(raw, phone.reference), phoneId: phone.info.id, receivedAt, ...(latencyMs !== undefined ? { latencyMs } : {}) };
    diagnostics.pose(raw, output, phone.info.id); phone.pose = output; phone.poseCount++; phone.lastPoseAt = monotonicMilliseconds(); phone.stale = false;
    deliver(output, (other, otherSocket) => otherSocket !== socket && audienceOf(phone)(other, otherSocket), true);
  };
  /** Consoles get every stream (a robot only if it asked); a phone (and its mirrors) only the streams in the view that phone picked. */
  const wants = (client: Client, socket: WebSocket, cameraId: string) => {
    if (client.role === 'console') return client.ready && client.cameras !== false;
    if (client.role === 'robot') return client.ready && client.cameras === true;
    const phone = client.role === 'phone' ? phones.get(client.phoneId!) : followed(client);
    return !!phone && (client.role === 'mirror' || socket === phone.socket) && cameraStreamsFor(phone).includes(cameraId);
  };
  const routeFrame = (frame: CameraFrameMessage) => deliver(frame, (client, socket) => wants(client, socket, frame.cameraId), true);
  /**
   * Feedback from a consumer or a robot to the phone screens (a notice, robot state as values). It goes to the phone
   * it names and any mirror of that phone, or to every phone and mirror without `phoneId`; never to consoles. The
   * gateway only routes it: what it says is between the consumer and the screen. Phones and mirrors only listen.
   */
  const handleStatus = (socket: WebSocket, client: Client, message: StatusMessage) => {
    if (client.role !== 'console' && client.role !== 'robot') return;
    becomeConsole(socket, client);
    const phone = message.phoneId ? phones.get(message.phoneId) : undefined; if (message.phoneId && !phone) return;
    // Rebuilt from its known fields, like poses and frames, so nothing else a console adds is passed on.
    const relayed: StatusMessage = { type: 'status', version: PROTOCOL_VERSION, sessionId: typeof message.sessionId === 'string' && message.sessionId ? message.sessionId.slice(0, 128) : sessionId, message: message.message,
      ...(message.controlId !== undefined ? { controlId: message.controlId } : {}), ...(message.values ? { values: structuredClone(message.values) } : {}), ...(phone ? { phoneId: phone.info.id } : {}) };
    deliver(relayed, (other, otherSocket) => phone ? otherSocket === phone.socket || (other.role === 'mirror' && other.phoneId === phone.info.id) : other.role === 'phone' || other.role === 'mirror');
  };
  // Any client can produce frames for a declared stream (a camera process on the robot, say).
  const handleCameraFrame = (frame: CameraFrameMessage) => { if (declared(frame.cameraId)) routeFrame({ type: 'camera_frame', version: PROTOCOL_VERSION, sessionId: frame.sessionId, cameraId: frame.cameraId, dataUrl: frame.dataUrl, capturedAt: frame.capturedAt }); };
  const dispatch = (socket: WebSocket, client: Client, message: unknown, receivedAt: number) => {
    const type = message && typeof message === 'object' ? (message as { type?: unknown }).type : undefined;
    if (type === 'pose') { if (validatePose(message)) handlePose(socket, client, message, receivedAt); }
    else if (type === 'action') { if (validateAction(message)) handleAction(socket, client, message, receivedAt); }
    else if (type === 'hello') { if (validateHello(message)) handleHello(socket, client, message); else send(socket, status('hello ignored: role must be phone, console or robot; only a robot has a robotId, of lower-case letters, digits and dashes', undefined, 'hello', { accepted: false })); }
    else if (type === 'camera_frame') { if (validateCameraFrame(message)) handleCameraFrame(message); }
    else if (type === 'status') { if (validateStatus(message)) handleStatus(socket, client, message); }
    else if (type === 'ping') { if (validatePing(message)) send(socket, { type: 'pong', version: PROTOCOL_VERSION, id: message.id, sentAt: message.sentAt, at: stamp() }); }
    else if (type === 'pong') { if (validatePong(message)) pong(client.link, message); }
    else if (type === 'robot_state') { if (validateRobotState(message)) handleRobotState(socket, client, message); else send(socket, status('robot_state refused: state must be a JSON object of at most 64 KB, everyMs 10 to 60000', undefined, 'robot_state', { accepted: false })); }
    else if (type === 'screen') { if (validateScreen(message)) handleScreen(socket, client, message); else send(socket, status('Screen refused: it needs html (at most 512 KB) and a title of at most 128 characters. The previous screen stays', undefined, 'screen', { accepted: false })); }
    else if (type === 'rtc') { if (validateRtc(message)) handleRtc(socket, client, message); else rtcError(socket, {} as RtcMessage, 'Malformed rtc message ignored'); }
    else send(socket, status('Malformed message ignored'));
  };

  /* ---------- HTTP ---------- */
  // Browsers may read the REST API only from the pages allowed to open the WebSocket.
  const app = express(); app.use(cors((req, callback) => callback(null, { origin: originAllowed(req.headers.origin, req.headers.host) }))); app.use(express.json());
  /** `/api/*` and `/screen` need the pairing code (`?token=` or `Authorization: Bearer`) unless pairing lets the client in without one. */
  const requireCode: express.RequestHandler = (req, res, next) => {
    const bearer = /^Bearer\s+(\S+)/i.exec(req.headers.authorization ?? '')?.[1];
    const verdict = admit(req, typeof req.query.token === 'string' ? req.query.token : bearer);
    if (verdict === true) { next(); return; }
    res.status(401).type('text').send(verdict || 'This gateway needs its pairing code: add ?token=CODE to the address, or send Authorization: Bearer CODE');
  };
  const listeningPort = () => { const address = server.address(); return address && typeof address === 'object' ? address.port : port; };
  const currentPairing = () => pairing(identity, name, mode, advertised(), listeningPort());
  const linkOf = (socket?: WebSocket) => describeLink(socket ? clients.get(socket)?.link : undefined);
  app.get('/health', (_req,res)=>res.json({ ok:true, service:'marionette-gateway', sessionId, gatewayId: identity.id, name, clients: clients.size, phones: [...phones.values()].filter(phone => phone.info.connected).length, robots: [...robots.values()].filter(robot => robot.info.connected).length, poseCount: [...phones.values()].reduce((sum, phone) => sum + phone.poseCount, 0) }));
  app.get('/marionette-kit.js', (_req,res)=>res.type('application/javascript').set('Cache-Control', 'no-cache').send(kit.js));
  app.get('/marionette-kit.css', (_req,res)=>res.type('text/css').set('Cache-Control', 'no-cache').send(kit.css));
  app.use('/api', requireCode);
  app.get('/api/state', (_req,res)=>res.json({ sessionId, gatewayId: identity.id, connectedClients: clients.size, config: gatewayConfig(),
    phones: [...phones.values()].map(phone => ({ ...phone.info, config: phoneConfig(phone), pose: phone.pose, rawPose: phone.raw, stale: phone.stale, poseCount: phone.poseCount, link: linkOf(phone.socket) })),
    robots: robotRoster().map(info => ({ ...info, link: linkOf(robots.get(info.id)?.socket) })), robotStates: [...retained.values()] }));
  app.get('/api/config', (_req,res)=>res.json(gatewayConfig()));
  app.get('/api/html-config', (_req,res)=>res.json(state.htmlConfig));
  app.get('/api/pairing', (_req,res,next)=>{ const info = currentPairing(); qrSvg(info.url).then(svg => res.json({ ...info, qrSvg: svg }), next); });
  app.get('/screen', requireCode, (req,res)=>res.type('html').send(screenPreview(state.htmlConfig.html, typeof req.query.phone === 'string' && /^[\w-]{1,64}$/.test(req.query.phone) ? req.query.phone : '')));

  /* ---------- WebSocket ---------- */
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path:'/ws', maxPayload: MAX_PAYLOAD_BYTES, verifyClient: ({ origin, req }: { origin: string; req: http.IncomingMessage }) => originAllowed(origin, req.headers.host) });
  wss.on('error', error => console.error('Marionette WebSocket server error', error));
  /** Forgets a client: it gets nothing more, and the other end of each of its WebRTC connections is told. */
  const forget = (socket: WebSocket, client: Client) => { clients.delete(socket); sockets.delete(client.id); alive.delete(socket); state.connectedClients = clients.size; signaling.drop(client.id); };
  wss.on('connection', (socket, req) => {
    const client: Client = { id: `c${++clientCount}`, role: 'console', hello: false, ready: false, link: newLink() };
    const address = addressOf(req); let grace: NodeJS.Timeout | undefined; let silence: NodeJS.Timeout | undefined; let refused = false;
    // Invalid UTF-8 or an oversized frame surfaces here; drop that client instead of crashing the gateway.
    socket.on('error', () => socket.terminate());
    socket.on('pong', () => alive.add(socket));
    /** A client that may not in gets nothing but this close. */
    const unpaired = (reason: string) => { if (refused) return; refused = true; clearTimeout(silence); log({ kind: 'pairing', address, msg: `closed ${address} (4401): ${reason}` }); socket.close(CLOSE_CODES.pairingRequired, reason); };
    const welcome = () => {
      clients.set(socket, client); sockets.set(client.id, socket); alive.add(socket); state.connectedClients = clients.size;
      send(socket, state.htmlConfig); send(socket, status('Connected to Marionette gateway', undefined, undefined, { connectedClients: clients.size }));
      grace = setTimeout(() => { if (client.role === 'console' && !client.hello) becomeConsole(socket, client); }, CONSOLE_GRACE_MS); grace.unref();
    };
    // The code may come in the address; without it, the only thing an unpaired socket may send is a hello carrying it.
    const verdict = admit(req, new URL(req.url ?? '/', 'http://gateway').searchParams.get('token') ?? undefined);
    if (verdict === true) welcome();
    else if (verdict) { unpaired(verdict); return; }
    else { silence = setTimeout(() => unpaired('Pairing code required'), pairingTimeoutMs); silence.unref(); }
    socket.on('message', (data) => {
      const receivedAt = stamp(); if (refused) return;
      let message: unknown; try { message = JSON.parse(data.toString()); } catch { if (clients.has(socket)) send(socket, status('Malformed message ignored')); else unpaired('Pairing code required'); return; }
      if (!clients.has(socket)) {
        // The code decides; a hello that carries it but is otherwise malformed is let in and answered like any other.
        const hello = message && typeof message === 'object' && (message as { type?: unknown }).type === 'hello' ? message as { token?: unknown } : undefined;
        const admitted = typeof hello?.token === 'string' && hello.token.length <= 64 ? admit(req, hello.token) : false;
        if (admitted !== true) { unpaired(admitted || 'Pairing code required'); return; }
        clearTimeout(silence); welcome();
      }
      try { dispatch(socket, client, message, receivedAt); }
      catch (error) { console.error('Marionette message handler failed', error); send(socket, status('Message ignored after a gateway error')); } });
    socket.on('close', () => {
      clearTimeout(grace); clearTimeout(silence);
      if (!clients.has(socket)) return;
      forget(socket, client);
      dropSocketHolds(socket, client.role === 'mirror' ? 'mirror disconnected' : 'phone disconnected');
      const phone = client.role === 'phone' ? phones.get(client.phoneId!) : undefined;
      if (phone && phone.socket === socket) disconnectPhone(phone, 'phone disconnected');
      const robot = client.role === 'robot' ? robots.get(client.robotId!) : undefined;
      if (robot && robot.socket === socket) leaveRobot(robot);
    });
  });

  /* ---------- Timers ---------- */
  // Simulated streams run only while someone is watching them and no robot publishes them over WebRTC.
  const cameraTimer = setInterval(() => {
    for (const stream of state.layout.cameraStreams.filter(candidate => candidate.url.startsWith('sim://') && !publisherOf(candidate.id)))
      if ([...clients].some(([socket, client]) => wants(client, socket, stream.id))) routeFrame(virtualCamera(stream.id, stream.url.slice('sim://'.length), sessionId));
  }, 250); cameraTimer.unref();
  if (watchedHtml) fs.watchFile(watchedHtml, { interval: 500 }, reloadHtml);
  for (const file of kitFiles.files) fs.watchFile(file, { interval: 500 }, reloadKit);
  // A phone that drops off Wi-Fi leaves a half-open socket; terminate clients that stop answering pings.
  const heartbeatTimer = setInterval(() => { for (const socket of clients.keys()) { if (!alive.has(socket)) { socket.terminate(); continue; } alive.delete(socket); socket.ping(); } }, heartbeatMs); heartbeatTimer.unref();
  // Pings measure each phone's and robot's round trip and clock, for the link indicator and the latency stamps.
  const pingTimer = setInterval(() => { for (const [socket, client] of clients) if (client.role === 'phone' || client.role === 'robot') sendPing(socket, client); }, pingMs); pingTimer.unref();
  const watchdogTimer = setInterval(() => {
    const now = monotonicMilliseconds();
    for (const phone of phones.values()) {
      for (const [controlId, hold] of phone.holds) { for (const [holder, renewedAt] of hold.holders) if (now - renewedAt > holdTimeoutMs) hold.holders.delete(holder); if (!hold.holders.size) endHold(phone, controlId, 'renewals stopped'); }
      for (const [controlId, stream] of phone.streams) {
        for (const [holder, renewedAt] of stream.holders) if (now - renewedAt > streamTimeoutMs) { stream.holders.delete(holder); const dropped = phone.dropped.get(controlId) ?? new Set(); dropped.add(holder); phone.dropped.set(controlId, dropped); }
        if (!stream.holders.size) endStream(phone, controlId, 'samples stopped');
      }
      if (phone.lastPoseAt !== undefined && !phone.stale && now - phone.lastPoseAt > watchdogMs) { phone.stale = true; publishUnavailablePose(phone, 'pose watchdog'); }
    }
  }, Math.max(20, Math.min(100, Math.floor(Math.min(watchdogMs, holdTimeoutMs, streamTimeoutMs) / 3)))); watchdogTimer.unref();
  // Advertised on the local network (Bonjour) once listening, so the app can list it under Nearby.
  let stopAdvertising = async () => {};
  server.on('listening', () => { if (mdns) stopAdvertising = advertise({ name, port: listeningPort(), gatewayId: identity.id, auth: mode !== 'off' }, warn); });
  return { app, server, wss, state, pairing: currentPairing, close: () => {
    const advertised = stopAdvertising(); if (watchedHtml) fs.unwatchFile(watchedHtml, reloadHtml); for (const file of kitFiles.files) fs.unwatchFile(file, reloadKit);
    for (const timer of [cameraTimer, heartbeatTimer, pingTimer, watchdogTimer]) clearInterval(timer);
    for (const socket of wss.clients) socket.terminate(); server.closeAllConnections?.();
    return Promise.all([advertised, new Promise<void>(resolve => server.close(() => resolve()))]).then(() => {}); } };
}
