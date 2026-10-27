import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { CALIBRATION_STEPS, CHECK_MOVES, CHECK_MOVE_TEXT, STREAM_RENEW_MS, buildGuidedReference, buildQuickReference, checkCalibrationMove, defaultConfig, describeCheckResult, guidedCaptureError, htmlBridgeScript, isLiveControl, isStickInRange, operatorPose, phoneColor, sameValue, sanitizeConfig, sanitizePose, streamEndValue, validateAction, validateCameraFrame, validateHello, validateHtmlConfig, validatePose, validateStatus, type ActionMessage, type CalibrationCheck, type CalibrationState, type CameraFrameMessage, type CameraStream, type CheckMove, type ConfigMessage, type ControlValue, type GuidedSamples, type GuidedStep, type HelloMessage, type HtmlConfigMessage, type InputMessage, type LiveControl, type MarionetteMessage, type PhoneInfo, type PosePacket, type PoseReference, type StatusMessage, type UiControl, PROTOCOL_VERSION, HTML_BRIDGE_VERSION, HTML_CONFIG_VERSION } from '@marionette/protocol';
import { createDiagnosticsLog, deltaMm, frameSummary, mm, noDiagnostics, rawAxes, type DiagnosticsLog } from './diagnostics.js';

/**
 * The gateway is a relay. Each phone streams its pose and its button presses; the
 * gateway publishes both, tagged with the phone, to every console (the viewer, a ROS 2
 * bridge, a robot controller). It keeps each phone's control values and calibration,
 * runs the calibration flow, and otherwise decides nothing: stopping, scaling and
 * arbitrating between phones belong to the consumer.
 */
type Layout = Pick<ConfigMessage, 'controls' | 'cameraStreams' | 'cameraViews'>;
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
};
/** A client is a console until it says otherwise; `ready` once it has introduced itself (or stayed quiet for the grace period). */
type Client = { role: 'console' | 'phone' | 'mirror'; hello: boolean; ready: boolean; phoneId?: string; follow?: string; shown?: boolean; cameras?: boolean };

const sampleHtml = fs.readFileSync(new URL('./sample-controls.html', import.meta.url), 'utf8');
function makeHtmlConfig(session: string, html = sampleHtml): HtmlConfigMessage { return { type: 'html_config', version: PROTOCOL_VERSION, sessionId: session, htmlVersion: HTML_CONFIG_VERSION, bridgeVersion: HTML_BRIDGE_VERSION, title: 'Marionette HTML controls', html }; }
// npm workspace scripts run inside apps/backend, so resolve a relative file from where the command was typed.
const htmlFile = () => process.env.MARIONETTE_HTML_FILE ? path.resolve(process.env.INIT_CWD ?? process.cwd(), process.env.MARIONETTE_HTML_FILE) : undefined;
function loadHtmlConfig(session: string): HtmlConfigMessage { const file = htmlFile(); const html = process.env.MARIONETTE_HTML ?? (file ? fs.readFileSync(file, 'utf8') : sampleHtml); const candidate = makeHtmlConfig(session, html); if (!validateHtmlConfig(candidate)) throw new Error('MARIONETTE_HTML_FILE/HTML is not a valid HTML config or exceeds 512 KB'); return candidate; }
/**
 * A screen can declare its own controls and cameras in
 * `<script type="application/json" id="marionette-config">{"controls": [...], "cameraStreams": [...], "cameraViews": [...]}</script>`.
 * Anything it leaves out keeps the default, except that streams declared without views get
 * one view each. Entries the gateway cannot use are dropped and reported in `warnings`.
 */
function parseLayout(html: string): { layout: Layout; warnings: string[] } {
  const fallback = defaultConfig();
  const match = /<script[^>]*id=["']marionette-config["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!match) return { layout: { controls: fallback.controls, cameraStreams: fallback.cameraStreams, cameraViews: fallback.cameraViews }, warnings: [] };
  let declared: Partial<Layout>;
  try { declared = JSON.parse(match[1]) as Partial<Layout>; } catch { throw new Error('the marionette-config block is not valid JSON'); }
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) throw new Error('the marionette-config block is not a JSON object');
  const checked = sanitizeConfig({ ...fallback, sessionId: 'layout', ...declared });
  if (!checked) throw new Error('the marionette-config block is not a valid layout');
  const warnings: string[] = [];
  const pick = <T,>(key: keyof Layout, kept: T[], defaults: T[]): T[] => {
    const list = declared[key]; if (!Array.isArray(list)) return defaults;
    if (kept.length < list.length) warnings.push(`ignored ${list.length - kept.length} of ${list.length} ${key} (each needs the fields in the README)`);
    return kept;
  };
  const controls = pick('controls', checked.controls, fallback.controls);
  const cameraStreams = pick('cameraStreams', checked.cameraStreams, fallback.cameraStreams);
  const cameraViews = Array.isArray(declared.cameraViews) ? pick('cameraViews', checked.cameraViews, fallback.cameraViews)
    : Array.isArray(declared.cameraStreams) ? cameraStreams.map(stream => ({ id: stream.id, label: stream.label, streams: [stream.id] })) : fallback.cameraViews;
  const known = new Set(cameraStreams.map(stream => stream.id));
  for (const view of cameraViews) for (const id of view.streams) if (!known.has(id)) warnings.push(`camera view "${view.id}" names a stream that is not declared: "${id}"`);
  return { layout: { controls, cameraStreams, cameraViews }, warnings };
}
const layoutFor = (html: string): Layout => parseLayout(html).layout;
/**
 * The phone screen for a desktop browser: the same document with the same
 * `window.Marionette` bridge, carried over this gateway's WebSocket instead of the
 * app. It mirrors one phone (`?phone=phone-2`, or the first connected phone) and
 * acts as that phone; its presses reach consumers marked `source: 'mirror'`.
 */
// `follow` is a phone id; `<` is escaped too, so nothing in it can close the inline script.
const previewBridge = (follow: string) => `(function(){var ws,config,held={},dragging={},seenHtml=false,tracking='',stopped=false,follow=${JSON.stringify(follow).replace(/</g, '\\u003c')};
function receive(type,payload){window.Marionette._receive({type:type,payload:payload});}
function streams(){if(!config)return[];var c=config.controls.find(function(x){return x.action==='camera.view';});var views=config.cameraViews||[];var v=views.find(function(x){return c&&x.id===c.value;})||views[0];return v?v.streams:[];}
function post(m){if(m.type==='disconnect'){stopped=true;if(ws)ws.close();return;}
if(!config||!ws||ws.readyState!==1){if(!m.renew&&!m.live)receive('status',{type:'status',version:1,sessionId:'preview',message:'Not connected to the gateway; that was not sent'});return;}
var c=config.controls.find(function(x){return x.id===m.controlId&&x.action===m.action;});if(c&&c.hold&&typeof m.value==='boolean'&&!m.renew){if(m.value)held[m.controlId]=m.action;else delete held[m.controlId];}
if(!m.renew){if(m.live)dragging[m.controlId]={action:m.action,value:m.value,at:Date.now()};else delete dragging[m.controlId];}else if(dragging[m.controlId])dragging[m.controlId].at=Date.now();
m.version=1;m.sessionId=config.sessionId;ws.send(JSON.stringify(m));}
${htmlBridgeScript('function(m){post(m);}')}
setInterval(function(){for(var id in held)post({type:'action',controlId:id,action:held[id],value:true,renew:true,sentAt:Date.now()});},200);
setInterval(function(){var now=Date.now();for(var id in dragging){var s=dragging[id];if(now-s.at>=${STREAM_RENEW_MS})post({type:'action',controlId:id,action:s.action,value:s.value,live:true,renew:true,sentAt:now});}},${Math.round(STREAM_RENEW_MS / 2)});
function open(){ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws');
ws.onopen=function(){ws.send(JSON.stringify({type:'hello',version:1,role:'console',follow:follow}));receive('connection',{state:'connected',gateway:location.host});};
ws.onmessage=function(e){var m;try{m=JSON.parse(e.data);}catch(x){return;}if(m.type==='html_config'){if(seenHtml)location.reload();seenHtml=true;return;}
if(m.type==='config'){if(config&&config.phone&&(!m.phone||m.phone.id!==config.phone.id)){held={};dragging={};tracking='';}config=m;}
if(m.type==='pose'&&tracking!==m.trackingState+m.source){tracking=m.trackingState+m.source;receive('tracking',{state:m.trackingState,source:m.source});}
if(m.type==='camera_frame'&&streams().indexOf(m.cameraId)<0)return;var mine=config&&config.phone&&config.phone.id;if((m.type==='pose'||m.type==='status')&&m.phoneId&&m.phoneId!==mine)return;if(m.type!=='input')receive(m.type,m);};
ws.onclose=function(){held={};dragging={};tracking='';receive('connection',{state:'disconnected',gateway:location.host,reason:stopped?'disconnected; reload the page to connect again':'lost the gateway, retrying'});if(!stopped)setTimeout(open,1000);};}
open();})();`;
function screenPreview(html: string, follow: string): string { const script = `<script>${previewBridge(follow)}</script>`; return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, tag => tag + script) : script + html; }

export const state = { sessionId: `marionette-${Math.random().toString(36).slice(2, 9)}`, layout: layoutFor(sampleHtml), htmlConfig: makeHtmlConfig(''), phones: new Map<string, Phone>(), connectedClients: 0 };

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
function virtualCamera(cameraId: string, kind: string): CameraFrameMessage {
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
  return { type:'camera_frame', version: PROTOCOL_VERSION, sessionId: state.sessionId, cameraId, dataUrl:`data:image/png;base64,${png.toString('base64')}`, capturedAt: Date.now() };
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

export function createServer(port = Number(process.env.PORT) || 8787, options: { watchdogMs?: number; holdTimeoutMs?: number; streamTimeoutMs?: number; heartbeatMs?: number; diagnostics?: DiagnosticsLog } = {}) {
  const watchdogMs = options.watchdogMs ?? (Number(process.env.MARIONETTE_WATCHDOG_MS) || 1500);
  // The phone repeats a held press every 200 ms; after three missed repeats the button is no longer known to be held.
  const holdTimeoutMs = options.holdTimeoutMs ?? (Number(process.env.MARIONETTE_HOLD_TIMEOUT_MS) || 600);
  // A value being dragged is repeated every 50 ms while the finger rests; after 400 ms of silence the stream is over.
  const streamTimeoutMs = options.streamTimeoutMs ?? (Number(process.env.MARIONETTE_STREAM_TIMEOUT_MS) || 400);
  const heartbeatMs = options.heartbeatMs ?? 5000;
  const diagnostics = options.diagnostics ?? noDiagnostics; const log = diagnostics.write;
  const sessionId = state.sessionId;
  state.phones = new Map(); state.htmlConfig = loadHtmlConfig(sessionId); state.connectedClients = 0;
  const initial = parseLayout(state.htmlConfig.html); state.layout = initial.layout;
  for (const warning of initial.warnings) log({ kind: 'html', msg: `marionette-config: ${warning}` });
  const phones = state.phones;
  const clients = new Map<WebSocket, Client>();
  const alive = new Set<WebSocket>();
  type Reply = { message: string; accepted: boolean };
  const accept = (message: string): Reply => ({ message, accepted: true });
  const refuse = (message: string): Reply => ({ message, accepted: false });

  /* ---------- Views and routing ---------- */
  const roster = (): PhoneInfo[] => [...phones.values()].map(phone => ({ ...phone.info }));
  const gatewayConfig = (): ConfigMessage => ({ ...defaultConfig(), sessionId, controls: structuredClone(state.layout.controls), cameraStreams: structuredClone(state.layout.cameraStreams), cameraViews: structuredClone(state.layout.cameraViews), phones: roster() });
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
  const consoles = (client: Client) => client.role === 'console' && client.ready;
  /** The phone itself, consoles, and any mirror of that phone. */
  const audienceOf = (phone: Phone) => (client: Client, socket: WebSocket) => consoles(client) || socket === phone.socket || (client.role === 'mirror' && client.phoneId === phone.info.id);
  /** A console gets the gateway view and every phone's view once, then every change. */
  const becomeConsole = (socket: WebSocket, client: Client) => { if (client.ready) return; client.ready = true; send(socket, gatewayConfig()); for (const phone of phones.values()) send(socket, phoneConfig(phone)); };
  const publishPhone = (phone: Phone) => deliver(phoneConfig(phone), audienceOf(phone));
  const status = (message: string, phone?: Phone, controlId?: string, values: Record<string, string | number | boolean> = {}): StatusMessage => ({ type: 'status', version: PROTOCOL_VERSION, sessionId, controlId, message, values, ...(phone ? { phoneId: phone.info.id } : {}) });
  const reply = (phone: Phone, controlId: string, result: Reply) => deliver(status(result.message, phone, controlId, { accepted: result.accepted }), audienceOf(phone));
  const input = (phone: Phone, fields: Omit<InputMessage, 'type' | 'version' | 'phoneId' | 'receivedAt'>) => deliver({ type: 'input', version: PROTOCOL_VERSION, phoneId: phone.info.id, receivedAt: Date.now(), ...fields }, consoles);

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
      send(socket, next ? phoneConfig(next) : gatewayConfig());
    }
  };
  // Every phone's config carries the roster, so a roster change republishes all of them, to consoles too.
  const rosterChanged = () => {
    deliver(gatewayConfig(), consoles);
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
  const attach = (phone: Phone, socket: WebSocket) => {
    const previous = phone.socket;
    if (previous && previous !== socket) { clients.delete(previous); dropSocketHolds(previous, 'replaced by a newer connection'); previous.close(4001, 'Replaced by a newer connection from this phone'); }
    // A new connection is a new ARKit session: the old stream has ended and its calibration no longer applies. The first pose sets the session.
    if (previous !== socket) {
      if (previous) { publishUnavailablePose(phone, 'replaced by a newer connection'); clearCalibration(phone, 'replaced by a newer connection'); }
      phone.info.sessionId = undefined; phone.raw = undefined; phone.stale = true; phone.lastPoseAt = undefined;
    }
    phone.socket = socket; phone.info.connected = true; clients.set(socket, { role: 'phone', hello: true, ready: true, phoneId: phone.info.id });
    rosterChanged();
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
  const disconnectPhone = (phone: Phone, reason: string) => {
    publishUnavailablePose(phone, reason); clearCalibration(phone, reason);
    for (const controlId of [...phone.holds.keys()]) endHold(phone, controlId, reason);
    for (const controlId of [...phone.streams.keys()]) endStream(phone, controlId, reason);
    phone.socket = undefined; phone.info.connected = false; phone.info.sessionId = undefined; phone.raw = undefined; phone.stale = true; phone.lastPoseAt = undefined;
    // An older app without a hello can never be recognised again, so it leaves the roster instead of lingering.
    if (!phone.deviceId) { phones.delete(phone.info.id); log({ kind: 'phone', phone: phone.info.id, msg: `${phone.info.name} left` }); }
    else log({ kind: 'phone', phone: phone.info.id, msg: `${phone.info.name} disconnected (${reason})` });
    rosterChanged();
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
      attach(known ?? addPhone(hello.deviceId), socket); return;
    }
    if (hello.follow !== undefined) { client.role = 'mirror'; client.ready = true; client.follow = hello.follow || undefined; resolveMirrors(); return; }
    if (hello.cameras === false) client.cameras = false;
    becomeConsole(socket, client);
  };
  const handleAction = (socket: WebSocket, client: Client, action: ActionMessage) => {
    if (client.role === 'console') becomeConsole(socket, client);
    const phone = client.role === 'phone' ? phones.get(client.phoneId!) : followed(client);
    if (!phone) { send(socket, status(client.role === 'mirror' ? 'No phone to act as yet; connect a phone first' : 'Consoles only watch; send controls from a phone or a mirror of one (/screen)', undefined, action.controlId, { accepted: false })); return; }
    // Every action is relayed exactly as received, before anything else, whatever the gateway makes of it.
    input(phone, { controlId: action.controlId, action: action.action, value: action.value, renew: action.renew, live: action.live, source: client.role === 'phone' ? 'phone' : 'mirror', sessionId: action.sessionId, sentAt: action.sentAt });
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
  const handlePose = (socket: WebSocket, client: Client, message: PosePacket) => {
    // A socket that streams without a hello is an older app; a console that said hello never streams.
    if (client.role !== 'phone') { if (client.hello) return; attach(addPhone(), socket); }
    const phone = phones.get(clients.get(socket)!.phoneId!); if (!phone) return;
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
    const output: PosePacket = { ...operatorPose(raw, phone.reference), phoneId: phone.info.id };
    diagnostics.pose(raw, output, phone.info.id); phone.pose = output; phone.poseCount++; phone.lastPoseAt = monotonicMilliseconds(); phone.stale = false;
    deliver(output, (other, otherSocket) => otherSocket !== socket && audienceOf(phone)(other, otherSocket), true);
  };
  /** Consoles get every stream; a phone (and its mirrors) only the streams in the view that phone picked. */
  const wants = (client: Client, socket: WebSocket, cameraId: string) => {
    if (client.role === 'console') return client.ready && client.cameras !== false;
    const phone = client.role === 'phone' ? phones.get(client.phoneId!) : followed(client);
    return !!phone && (client.role === 'mirror' || socket === phone.socket) && cameraStreamsFor(phone).includes(cameraId);
  };
  const routeFrame = (frame: CameraFrameMessage) => deliver(frame, (client, socket) => wants(client, socket, frame.cameraId), true);
  /**
   * Feedback from a consumer to the phone screens (robot state, a notice). It goes to the phone it names and
   * any mirror of that phone, or to every phone and mirror without `phoneId`; never to other consoles. The
   * gateway only routes it: what it says is between the consumer and the screen. Phones and mirrors only listen.
   */
  const handleStatus = (socket: WebSocket, client: Client, message: StatusMessage) => {
    if (client.role !== 'console') return;
    becomeConsole(socket, client);
    const phone = message.phoneId ? phones.get(message.phoneId) : undefined; if (message.phoneId && !phone) return;
    // Rebuilt from its known fields, like poses and frames, so nothing else a console adds is passed on.
    const relayed: StatusMessage = { type: 'status', version: PROTOCOL_VERSION, sessionId: typeof message.sessionId === 'string' && message.sessionId ? message.sessionId.slice(0, 128) : sessionId, message: message.message,
      ...(message.controlId !== undefined ? { controlId: message.controlId } : {}), ...(message.values ? { values: { ...message.values } } : {}), ...(phone ? { phoneId: phone.info.id } : {}) };
    deliver(relayed, (other, otherSocket) => phone ? otherSocket === phone.socket || (other.role === 'mirror' && other.phoneId === phone.info.id) : other.role === 'phone' || other.role === 'mirror');
  };
  // Any client can produce frames for a declared stream (a camera process on the robot, say).
  const handleCameraFrame = (frame: CameraFrameMessage) => { if (state.layout.cameraStreams.some(stream => stream.id === frame.cameraId)) routeFrame({ type: 'camera_frame', version: PROTOCOL_VERSION, sessionId: frame.sessionId, cameraId: frame.cameraId, dataUrl: frame.dataUrl, capturedAt: frame.capturedAt }); };

  // Browsers may read the REST API only from the pages allowed to open the WebSocket.
  const app = express(); app.use(cors((req, callback) => callback(null, { origin: originAllowed(req.headers.origin, req.headers.host) }))); app.use(express.json());
  app.get('/health', (_req,res)=>res.json({ ok:true, service:'marionette-gateway', sessionId, clients: clients.size, phones: [...phones.values()].filter(phone => phone.info.connected).length, poseCount: [...phones.values()].reduce((sum, phone) => sum + phone.poseCount, 0) }));
  app.get('/api/state', (_req,res)=>res.json({ sessionId, connectedClients: clients.size, config: gatewayConfig(), phones: [...phones.values()].map(phone => ({ ...phone.info, config: phoneConfig(phone), pose: phone.pose, rawPose: phone.raw, stale: phone.stale, poseCount: phone.poseCount })) }));
  app.get('/api/config', (_req,res)=>res.json(gatewayConfig()));
  app.get('/api/html-config', (_req,res)=>res.json(state.htmlConfig));
  app.get('/screen', (req,res)=>res.type('html').send(screenPreview(state.htmlConfig.html, typeof req.query.phone === 'string' && /^[\w-]{1,64}$/.test(req.query.phone) ? req.query.phone : '')));
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path:'/ws', maxPayload: MAX_PAYLOAD_BYTES, verifyClient: ({ origin, req }: { origin: string; req: http.IncomingMessage }) => originAllowed(origin, req.headers.host) });
  wss.on('error', error => console.error('Marionette WebSocket server error', error));
  wss.on('connection', (socket) => {
    clients.set(socket, { role: 'console', hello: false, ready: false }); alive.add(socket); state.connectedClients = clients.size;
    // Invalid UTF-8 or an oversized frame surfaces here; drop that client instead of crashing the gateway.
    socket.on('error', () => socket.terminate());
    socket.on('pong', () => alive.add(socket));
    send(socket, state.htmlConfig); send(socket, status('Connected to Marionette gateway', undefined, undefined, { connectedClients: clients.size }));
    const grace = setTimeout(() => { const client = clients.get(socket); if (client?.role === 'console' && !client.hello) becomeConsole(socket, client); }, CONSOLE_GRACE_MS); grace.unref();
    socket.on('message', (data) => { let message: unknown; try { message = JSON.parse(data.toString()); } catch { send(socket, status('Malformed message ignored')); return; }
      const client = clients.get(socket); if (!client) return;
      try {
        const type = message && typeof message === 'object' ? (message as { type?: unknown }).type : undefined;
        if (type === 'pose') { if (validatePose(message)) handlePose(socket, client, message); }
        else if (type === 'action') { if (validateAction(message)) handleAction(socket, client, message); }
        else if (type === 'hello') { if (validateHello(message)) handleHello(socket, client, message); }
        else if (type === 'camera_frame') { if (validateCameraFrame(message)) handleCameraFrame(message); }
        else if (type === 'status') { if (validateStatus(message)) handleStatus(socket, client, message); }
        else send(socket, status('Malformed message ignored'));
      } catch (error) { console.error('Marionette message handler failed', error); send(socket, status('Message ignored after a gateway error')); } });
    socket.on('close', () => {
      clearTimeout(grace);
      const closing = clients.get(socket); clients.delete(socket); alive.delete(socket); state.connectedClients = clients.size;
      dropSocketHolds(socket, closing?.role === 'mirror' ? 'mirror disconnected' : 'phone disconnected');
      const phone = closing?.role === 'phone' ? phones.get(closing.phoneId!) : undefined;
      if (phone && phone.socket === socket) disconnectPhone(phone, 'phone disconnected');
    });
  });
  // Simulated streams run only while someone is watching them.
  const cameraTimer = setInterval(() => {
    for (const stream of state.layout.cameraStreams.filter((candidate: CameraStream) => candidate.url.startsWith('sim://')))
      if ([...clients].some(([socket, client]) => wants(client, socket, stream.id))) routeFrame(virtualCamera(stream.id, stream.url.slice('sim://'.length)));
  }, 250); cameraTimer.unref();
  // A custom screen file is pushed to every client whenever it is saved, so it can be edited live.
  const watchedHtml = process.env.MARIONETTE_HTML ? undefined : htmlFile();
  /** After a layout change: a value the control no longer accepts goes back to the default, and a hold whose button is gone ends. */
  const fitLayout = (phone: Phone) => {
    for (const [id, value] of phone.values) { const control = state.layout.controls.find(candidate => candidate.id === id); if (control && !validValue(control, value)) phone.values.delete(id); }
    for (const [id, hold] of [...phone.holds]) if (!state.layout.controls.some(control => control.type === 'button' && control.hold && control.id === id && control.action === hold.action)) endHold(phone, id, 'screen changed');
    for (const [id, stream] of [...phone.streams]) if (!state.layout.controls.some(control => isLiveControl(control) && control.id === id && control.action === stream.action)) endStream(phone, id, 'screen changed');
    phone.dropped.clear();
  };
  const reloadHtml = () => {
    try {
      const next = loadHtmlConfig(sessionId); if (next.html === state.htmlConfig.html) return;
      const { layout, warnings } = parseLayout(next.html); state.htmlConfig = next; state.layout = layout;
      deliver(state.htmlConfig, () => true);
      for (const phone of phones.values()) fitLayout(phone);
      rosterChanged();
      log({ kind: 'html', file: watchedHtml, msg: `screen reloaded from ${watchedHtml}` });
      for (const warning of warnings) log({ kind: 'html', file: watchedHtml, msg: `marionette-config: ${warning}` });
    } catch (error) { log({ kind: 'html', file: watchedHtml, msg: `screen not reloaded, keeping the previous one: ${(error as Error).message}` }); }
  };
  if (watchedHtml) fs.watchFile(watchedHtml, { interval: 500 }, reloadHtml);
  // A phone that drops off Wi-Fi leaves a half-open socket; terminate clients that stop answering pings.
  const heartbeatTimer = setInterval(() => { for (const socket of clients.keys()) { if (!alive.has(socket)) { socket.terminate(); continue; } alive.delete(socket); socket.ping(); } }, heartbeatMs); heartbeatTimer.unref();
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
  return { app, server, wss, close: () => { if (watchedHtml) fs.unwatchFile(watchedHtml, reloadHtml); clearInterval(cameraTimer); clearInterval(heartbeatTimer); clearInterval(watchdogTimer); for (const socket of clients.keys()) socket.terminate(); return new Promise<void>(resolve => server.close(() => resolve())); } };
}
if (process.env.NODE_ENV !== 'test') {
  const port = Number(process.env.PORT) || 8787;
  const diagnostics = createDiagnosticsLog({ dir: path.resolve(process.env.INIT_CWD ?? process.cwd(), process.env.MARIONETTE_LOG_DIR ?? 'logs'), poseHz: Number(process.env.MARIONETTE_POSE_LOG_HZ ?? 10) });
  const gateway = createServer(port, { diagnostics });
  gateway.server.listen(port, () => console.log(`Marionette gateway listening on http://0.0.0.0:${port}\nPhone screen preview: http://localhost:${port}/screen (add ?phone=phone-2 to mirror a particular phone)${htmlFile() ? `\nScreen: live from ${htmlFile()}` : ''}\nDiagnostics log: ${diagnostics.file}`));
}
