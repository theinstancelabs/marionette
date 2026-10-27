import { StatusBar } from 'expo-status-bar';
import { requireNativeModule } from 'expo';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { File, Paths } from 'expo-file-system';
import * as ScreenOrientation from 'expo-screen-orientation';
import WebView, { type WebViewMessageEvent } from 'react-native-webview';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, KeyboardAvoidingView, Linking, Modal, Pressable, SafeAreaView, ScrollView, Settings as UserDefaults, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { CLOSE_CODES, formatPairingCode, gatewayLabel, gatewayUrl, htmlBridgeScript, isHtmlBridgeDisconnect, linkQuality, nominalCovariance, normalizePairingCode, normalizeQuaternion, operatorPose, parsePairingLink, poseFromTransform, sanitizeConfig, selectedCameraView, streamEndValue, validateCameraFrame, validateHtmlBridgeAction, validateHtmlBridgeRtc, validateHtmlConfig, validatePing, validateRobotState, validateRtc, validateStatus, PROTOCOL_VERSION, STREAM_RENEW_MS, type ConfigMessage, type ControlValue, type ConnectionEvent, type HtmlBridgeEvent, type HtmlBridgeFeature, type HtmlConfigMessage, type LinkEvent, type MarionetteMessage, type PairingLink, type PosePacket, type RobotStateMessage, type RtcMessage, type StatusMessage, type TrackingEvent, type TrackingState } from '@marionette/protocol';

type ArkitEvent = { generation?: number; transform?: number[]; trackingState?: string; state?: string; reason?: string; timestamp?: number; code?: string; message?: string };
type ArkitBridge = { isSupported(): boolean; start(generation: number): Promise<void>; stop(): Promise<void>; addListener(name: 'onPose' | 'onTracking' | 'onError' | 'onWorldReset', listener: (event: ArkitEvent) => void): { remove(): void } };
const arkit = (()=>{ try { return requireNativeModule<ArkitBridge>('MarionetteArKit'); } catch { return null; } })();
/** A gateway advertising itself over Bonjour (`modules/discovery`), resolved to an IPv4 address; one per id and address. */
type NearbyGateway = { id: string; name: string; host: string; port: number; auth: boolean };
type NearbyStatus = 'browsing' | 'denied' | 'unavailable';
type DiscoveryBridge = { start(): void; stop(): void; addListener(name: 'onChange', listener: (event: { status?: string; gateways?: unknown[] }) => void): { remove(): void } };
const discovery = (()=>{ try { return requireNativeModule<DiscoveryBridge>('MarionetteDiscovery'); } catch { return null; } })();
const isNearby = (value: unknown): value is NearbyGateway => { const g = value as Partial<NearbyGateway> | null; return !!g && typeof g.id === 'string' && typeof g.name === 'string' && typeof g.host === 'string' && typeof g.port === 'number' && typeof g.auth === 'boolean'; };
const newSessionId = () => `iphone-${Math.random().toString(36).slice(2, 10)}`;
const monotonicSeconds = () => (typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() / 1000 : Date.now() / 1000);
const TRACKING_STATES: TrackingState[] = ['initializing', 'normal', 'limited', 'relocalizing', 'unavailable'];
const toTrackingState = (value: unknown): TrackingState => TRACKING_STATES.includes(value as TrackingState) ? value as TrackingState : 'unavailable';
const CAMERA_DENIED = 'Camera access is off. Turn it on in Settings › Privacy & Security › Camera, then reconnect.';
// Poses go to the gateway at the ARKit frame rate; the HTML screen only needs ~15 Hz.
const UI_INTERVAL_MS = 66;
// Held buttons are repeated so the gateway can drop a hold whose release was lost.
const HOLD_RENEW_MS = 200;
// iOS can take a long time to give up on an unreachable host; say so sooner.
const CONNECT_TIMEOUT_MS = 8000;
// Once a connection has opened, a drop retries in place, 0.5 s doubling to 5 s, until it connects or the operator
// leaves. Each retry gives up sooner than a first connection would, since the next one follows anyway.
const RETRY_FIRST_MS = 500; const RETRY_MAX_MS = 5000; const RETRY_TIMEOUT_MS = 4000;
// A gateway that pings (every second) and then goes quiet this long is gone, even while iOS still thinks the socket is open.
const SILENCE_MS = 3500;
const MAX_RECENT = 5; const MAX_CODES = 32; const MAX_HOSTS = 8; const MAX_EARLY = 32;
const FEATURES: HtmlBridgeFeature[] = ['live', 'robot_state', 'link', 'rtc', 'reconnect', 'orientation'];
const bridgeScript = htmlBridgeScript('function(m){if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify(m));}', FEATURES);

// Recent gateway addresses (most recent first), this phone's device id and the pairing codes gateways accepted, kept in
// the app's documents folder. The gateway uses the device id to give a reconnecting phone the same name and color.
// Codes are kept per address (all a typed address tells) and per gateway id, with the addresses where that gateway
// accepted the code, oldest first so the oldest go when there are too many. A gateway's id is public (Bonjour, /health),
// so a saved code is only ever sent to an address where it was accepted, never to any host that claims the id.
const settingsFile = new File(Paths.document, 'marionette.json');
type Codes = Record<string, string>;
type GatewayCode = { code: string; hosts: string[] };
type Settings = { recent: string[]; deviceId: string; codes: { gateways: Record<string, GatewayCode>; addresses: Codes } };
const isCode = (code: unknown): code is string => typeof code === 'string' && code.length > 0 && code.length <= 64;
const isKey = (key: unknown): key is string => typeof key === 'string' && key.length > 0 && key.length <= 128;
const entries = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value).slice(-MAX_CODES) : []);
const readCodes = (value: unknown): Codes => { const codes: Codes = {}; for (const [key, code] of entries(value)) if (isKey(key) && isCode(code)) codes[key] = code; return codes; };
// Id-keyed codes from before the addresses were kept are dropped; the copy kept for the address still works there.
const readGateways = (value: unknown): Record<string, GatewayCode> => { const gateways: Record<string, GatewayCode> = {};
  for (const [id, entry] of entries(value)) { const { code, hosts } = (entry ?? {}) as Partial<GatewayCode>;
    if (isKey(id) && isCode(code) && Array.isArray(hosts)) { const known = hosts.filter(isKey).slice(-MAX_HOSTS); if (known.length) gateways[id] = { code, hosts: known }; } }
  return gateways; };
function loadSettings(): Settings {
  let parsed: { recent?: unknown; deviceId?: unknown; codes?: unknown } = {};
  try { if (settingsFile.exists) parsed = JSON.parse(settingsFile.textSync()) as typeof parsed; } catch { /* A damaged file only loses the list. */ }
  const recent = Array.isArray(parsed.recent) ? parsed.recent.filter((item): item is string => typeof item === 'string').slice(0, MAX_RECENT) : [];
  const deviceId = typeof parsed.deviceId === 'string' && /^[a-z0-9-]{8,64}$/.test(parsed.deviceId) ? parsed.deviceId : `iphone-${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;
  // Files from 1.0 have no codes.
  const saved = parsed.codes && typeof parsed.codes === 'object' ? parsed.codes as { gateways?: unknown; addresses?: unknown } : {};
  const codes = { gateways: readGateways(saved.gateways), addresses: readCodes(saved.addresses) };
  if (deviceId !== parsed.deviceId) saveSettings({ recent, deviceId, codes });
  return { recent, deviceId, codes };
}
function saveSettings(settings: Settings) { settingsFile.write(JSON.stringify(settings)).catch(() => { /* Remembering addresses and codes is a convenience; a failed write only loses them. */ }); }
const settings = loadSettings();
/**
 * The code this phone may send unasked to the gateway at an address: the one the gateway `gatewayId` accepted there,
 * else the one accepted at exactly that address. A gateway seen at a new address has to be given its code again.
 */
const savedCode = (label: string, gatewayId?: string): string | undefined => { const known = gatewayId ? settings.codes.gateways[gatewayId] : undefined;
  return known?.hosts.includes(label) ? known.code : settings.codes.addresses[label]; };
/** A gateway accepted `code` at `label`; `gatewayId` is the id its config gave, if any. */
function rememberCode(label: string, gatewayId: string | undefined, code: string) {
  const { gateways, addresses } = settings.codes; const known = gatewayId ? gateways[gatewayId] : undefined;
  if (addresses[label] === code && (!gatewayId || (known?.code === code && known.hosts.includes(label)))) return;
  const put = <T,>(codes: Record<string, T>, key: string, value: T) => { delete codes[key]; codes[key] = value; for (const old of Object.keys(codes).slice(0, -MAX_CODES)) delete codes[old]; };
  put(addresses, label, code);
  if (gatewayId) {
    // An address belongs to the gateway that last accepted a code there. A changed code starts the gateway's list over.
    for (const [id, other] of Object.entries(gateways)) if (id !== gatewayId && other.hosts.includes(label)) { other.hosts = other.hosts.filter(host => host !== label); if (!other.hosts.length) delete gateways[id]; }
    put(gateways, gatewayId, { code, hosts: [...(known?.code === code ? known.hosts.filter(host => host !== label) : []), label].slice(-MAX_HOSTS) });
  }
  saveSettings(settings);
}
/** The gateway at `label` said `code` is wrong, so it is no longer sent there. (Elsewhere it fails, and goes, once.) */
function forgetCode(label: string, code: string) {
  const { gateways, addresses } = settings.codes; if (addresses[label] === code) delete addresses[label];
  for (const [id, known] of Object.entries(gateways)) if (known.code === code && known.hosts.includes(label)) { known.hosts = known.hosts.filter(host => host !== label); if (!known.hosts.length) delete gateways[id]; }
  saveSettings(settings);
}

/**
 * What the app connects to: one address (typed, recent or nearby), or every host of a pairing link, where the
 * first to answer wins. `label` becomes the address that answered.
 * - `code` is one the operator typed or the link carried, sent to whichever address answers. Without it, the hello
 *   carries the code saved for the address that answered, if any (`sent` is what the current connection's hello carried).
 * - `gatewayId` is the id a link or Nearby advert claims, until a config gives the gateway's own.
 * - `pinned` is the id of the gateway that first accepted the phone ('' if it has none). Every later config must
 *   carry the same id, or the app leaves: a different gateway answered.
 */
type Target = { label: string; urls: string[]; name?: string; code?: string; gatewayId?: string; sent?: string; pinned?: string };
type Screen = 'connect' | 'connecting' | 'live';
type Timer = ReturnType<typeof setTimeout>;

export default function App() {
  const [recent, setRecent] = useState<string[]>(settings.recent); const [address, setAddress] = useState(() => recent[0] ?? '');
  const [screen, setScreen] = useState<Screen>('connect'); const [error, setError] = useState<string>(); const [gateway, setGateway] = useState('');
  // The pairing-code field: shown on request or when a gateway asks, with a line saying which gateway wants it.
  const [code, setCode] = useState(''); const [codeShown, setCodeShown] = useState(false); const [codeNote, setCodeNote] = useState<string>();
  const [scanning, setScanning] = useState(false); const [nearby, setNearby] = useState<NearbyGateway[]>([]); const [nearbyStatus, setNearbyStatus] = useState<NearbyStatus>('browsing');
  // Why the connection dropped, while it is being retried in place.
  const [reconnecting, setReconnecting] = useState<string>();
  const [htmlConfig, setHtmlConfig] = useState<HtmlConfigMessage>(); const [htmlKey, setHtmlKey] = useState(0); const [htmlLoaded, setHtmlLoaded] = useState(false);
  const socket=useRef<WebSocket | undefined>(undefined); const seq=useRef(0); const session=useRef(newSessionId()); const syntheticTimer=useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const configRef=useRef<ConfigMessage | undefined>(undefined); const htmlConfigRef=useRef<HtmlConfigMessage | undefined>(undefined); const lastUiAt=useRef(0);
  // The connection: its target, the sockets of the attempt in flight, and a counter that retires every callback of an
  // earlier attempt. Socket handlers also check `socket.current===ws`, so a stale socket can never act.
  const target=useRef<Target | undefined>(undefined); const attempt=useRef(0); const racing=useRef(new Set<WebSocket>());
  const attemptTimer=useRef<Timer | undefined>(undefined); const retryTimer=useRef<Timer | undefined>(undefined); const retryMs=useRef(RETRY_FIRST_MS);
  // Set once a connection to the target has opened: from then on a drop reconnects in place instead of leaving.
  const established=useRef(false);
  // When the gateway last sent anything on this connection, and whether it pings at all (older gateways don't).
  const heardAt=useRef(0); const pinged=useRef(false);
  // Whether the gateway has accepted this connection (sent this phone its config), and with it any pairing code. Until
  // then the page hears nothing from it (`early` keeps it): on a reconnect it may turn out to be a different gateway.
  const accepted=useRef(false); const early=useRef<unknown[]>([]);
  // The last value of every bridge event, so a freshly loaded document starts from the current state.
  const latest=useRef(new Map<HtmlBridgeEvent, unknown>());
  // Robot state is kept per robot and phone (or all phones) and all of it is replayed; `rtc` is never kept.
  const robotStates=useRef(new Map<string, RobotStateMessage>()); const gatewaySession=useRef<string | undefined>(undefined);
  // ARKit events carry the generation passed to start(); anything else is a frame queued from an earlier run.
  const generation=useRef(0); const arkitActive=useRef(false);
  // Held buttons whose press reached the gateway; they are repeated while held.
  const held=useRef(new Map<string, string>());
  // Sliders and sticks being dragged: their latest sample is repeated while the finger rests.
  const dragging=useRef(new Map<string, { action: string; value?: ControlValue; at: number }>());
  // Drags the connection dropped under, or touched while there was no connection. The page lives on, so their later
  // samples are swallowed until the finger lifts: nothing touched without a gateway acts once it is back.
  const cutDrags=useRef(new Set<string>());
  const htmlRef = useRef<React.ComponentRef<typeof WebView>>(null);
  const send=(payload: MarionetteMessage)=>{ if(socket.current?.readyState!==WebSocket.OPEN)return false; socket.current.send(JSON.stringify(payload)); return true; };
  /** Whether the page's actions can go out: the socket is open and the gateway has accepted the phone on it. */
  const linked=()=>accepted.current&&socket.current?.readyState===WebSocket.OPEN;
  const sendAction=(controlId:string,actionName:string,value?:ControlValue,flags:{renew?:true;live?:true}={})=>send({type:'action',version:PROTOCOL_VERSION,sessionId:session.current,controlId,action:actionName,value,...flags,sentAt:Date.now()});
  const inject=(type:HtmlBridgeEvent,payload:unknown)=>htmlRef.current?.injectJavaScript(`window.Marionette&&window.Marionette._receive(${JSON.stringify({type,payload})});true;`);
  const toHtml=(type:HtmlBridgeEvent,payload:unknown)=>{ latest.current.set(type,payload); inject(type,payload); };
  const localStatus=(message:string)=>toHtml('status',{type:'status',version:PROTOCOL_VERSION,sessionId:session.current,message} satisfies StatusMessage);
  const setTracking=(tracking:TrackingEvent)=>{ const previous=latest.current.get('tracking') as TrackingEvent|undefined; if(previous&&previous.state===tracking.state&&previous.source===tracking.source&&previous.reason===tracking.reason&&previous.message===tracking.message)return; toHtml('tracking',tracking); };
  const emitPose=(raw:PosePacket)=>{ raw.sentAt=Date.now(); send(raw); const now=Date.now(); if(now-lastUiAt.current<UI_INTERVAL_MS)return; lastUiAt.current=now; toHtml('pose',operatorPose(raw,configRef.current?.calibration.reference)); };
  // A press that didn't go out is not held, so its repeats never start it once the gateway is back.
  const pressHold=(controlId:string,actionName:string)=>{ if(linked()&&sendAction(controlId,actionName,true))held.current.set(controlId,actionName); else localStatus('Not connected; the hold was not sent'); };
  const releaseHold=(controlId:string)=>{ const actionName=held.current.get(controlId); if(actionName===undefined)return; held.current.delete(controlId); sendAction(controlId,actionName,false); };
  // A drag the screen can no longer finish (the app leaves, the screen reloads) ends where the control rests: a stick at zero.
  const endDrag=(controlId:string)=>{ const drag=dragging.current.get(controlId); if(!drag)return; dragging.current.delete(controlId); const control=configRef.current?.controls.find(c=>c.id===controlId&&c.action===drag.action); sendAction(controlId,drag.action,streamEndValue(control,drag.value)); };
  /** Lets go of every held button and dragged control. */
  const releaseAll=()=>{ for(const controlId of [...held.current.keys()])releaseHold(controlId); for(const controlId of [...dragging.current.keys()])endDrag(controlId); };
  // A new pose session tells the gateway the ARKit world changed, which clears calibration there.
  const startPoseSession=()=>{ session.current=newSessionId(); seq.current=0; };
  const stopSyntheticMotion=()=>{if(syntheticTimer.current)clearInterval(syntheticTimer.current);syntheticTimer.current=undefined;};
  const startSyntheticMotion=()=>{ stopSyntheticMotion(); let t=0; syntheticTimer.current=setInterval(()=>{t+=0.05; emitPose({type:'pose',version:PROTOCOL_VERSION,sessionId:session.current,seq:seq.current++,monotonicTs:monotonicSeconds(),position:{x:Math.sin(t)*0.03,y:0,z:Math.cos(t)*0.03},rotation:normalizeQuaternion({x:0,y:Math.sin(t*0.7)*0.25,z:Math.sin(t*0.4)*0.12,w:0.96}),covariance:nominalCovariance('limited'),source:'synthetic',trackingState:'limited',calibrationVersion:'synthetic-v1',heartbeat:true});},50); setTracking({state:'limited',source:'synthetic',reason:'synthetic'}); };
  const stopTracking=()=>{ generation.current++; arkitActive.current=false; stopSyntheticMotion(); if(arkit)arkit.stop().catch(()=>{}); };
  const startTracking=async()=>{ stopTracking(); const run=generation.current;
    // Only a missing native module or an unsupported device (the simulator) falls back to synthetic motion; a real ARKit failure is reported instead.
    if(!arkit||!arkit.isSupported()){ startSyntheticMotion(); return; }
    arkitActive.current=true; setTracking({state:'initializing',source:'arkit',reason:'initializing'});
    try { await arkit.start(run); }
    catch(failure){ if(generation.current!==run)return; arkitActive.current=false; const e=failure as {code?:string;message?:string}; setTracking({state:'unavailable',source:'arkit',message:e.code==='CameraDenied'?CAMERA_DENIED:`ARKit could not start: ${e.message??'unknown error'}`}); } };
  // Native events are subscribed once; every handler reads refs, so nothing goes stale.
  useEffect(()=>{ if(!arkit)return; const current=(event:ArkitEvent)=>arkitActive.current&&event.generation===generation.current;
    const subs=[
      arkit.addListener('onPose',event=>{ if(!current(event)||!Array.isArray(event.transform))return; try { const p=poseFromTransform(event.transform,session.current,seq.current++,event.timestamp??monotonicSeconds(),toTrackingState(event.trackingState)); emitPose(p); } catch { /* A malformed transform is dropped; the gateway watchdog covers gaps. */ } }),
      arkit.addListener('onTracking',event=>{ if(current(event))setTracking({state:toTrackingState(event.state),source:'arkit',reason:event.reason||undefined}); }),
      arkit.addListener('onError',event=>{ if(!current(event))return; arkitActive.current=false; setTracking({state:'unavailable',source:'arkit',message:event.code==='CameraDenied'?CAMERA_DENIED:`ARKit stopped: ${event.message??'session failed'}`}); }),
      arkit.addListener('onWorldReset',event=>{ if(!current(event))return; startPoseSession(); localStatus('Tracking restarted after an interruption; calibrate again'); }),
    ];
    return()=>{ subs.forEach(sub=>sub.remove()); stopTracking(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  /** Closes every socket and timer of the connection. */
  const closeConnection=()=>{ attempt.current++; clearTimeout(attemptTimer.current); clearTimeout(retryTimer.current); for(const ws of racing.current)ws.close(); racing.current.clear(); const previous=socket.current; socket.current=undefined; previous?.close(); accepted.current=false; early.current=[]; };
  /** Leaves the gateway and returns to the connect page, with a reason unless the operator chose to leave. */
  const disconnect=(reason?:string)=>{ releaseAll(); closeConnection(); stopTracking(); target.current=undefined; established.current=false; cutDrags.current.clear();
    configRef.current=undefined; htmlConfigRef.current=undefined; latest.current.clear(); robotStates.current.clear(); gatewaySession.current=undefined;
    setHtmlConfig(undefined); setHtmlLoaded(false); setReconnecting(undefined); setError(reason); setScreen('connect'); };
  /** A fresh connection: a new pose session, and back to the connect page if it never opens. */
  const start=(next:Target)=>{ disconnect(); target.current=next; setGateway(next.name??next.label); setError(undefined); setScreen('connecting'); startPoseSession(); retryMs.current=RETRY_FIRST_MS; open(); };
  /** One attempt: every candidate address at once. The first socket to open is kept and the others are closed. */
  const open=()=>{ const current=target.current; if(!current)return; const id=++attempt.current; clearTimeout(attemptTimer.current); clearTimeout(retryTimer.current);
    for(const ws of racing.current)ws.close(); racing.current.clear();
    let settled=false; let failures=0; const sockets:WebSocket[]=[];
    const fail=()=>{ if(settled)return; settled=true; clearTimeout(attemptTimer.current); for(const ws of sockets){ racing.current.delete(ws); ws.close(); } attemptFailed(); };
    for(const url of current.urls){ let ws:WebSocket; try { ws=new WebSocket(url); } catch { continue; } sockets.push(ws); racing.current.add(ws);
      ws.onopen=()=>{ racing.current.delete(ws); if(settled||attempt.current!==id){ ws.close(); return; } settled=true; clearTimeout(attemptTimer.current);
        for(const other of sockets)if(other!==ws){ racing.current.delete(other); other.close(); } opened(ws,url); };
      ws.onmessage=e=>{ if(socket.current===ws)received(e.data); };
      // Only an application close (4000–4999) carries the gateway's own words; for the rest the reason is the socket library's,
      // like SocketRocket's “Stream end encountered” (1001) when the gateway's process dies.
      ws.onclose=e=>{ racing.current.delete(ws); if(socket.current===ws){ dropped(ws,e.code,e.code>=4000&&e.code<5000&&e.reason?e.reason:undefined); return; } if(!settled&&attempt.current===id&&++failures>=sockets.length)fail(); };
      ws.onerror=()=>{ /* onclose follows with the reason. */ }; }
    if(!sockets.length){ settled=true; if(established.current)scheduleRetry(); else disconnect('That address can’t be opened.'); return; }
    attemptTimer.current=setTimeout(()=>{ if(attempt.current===id)fail(); },established.current?RETRY_TIMEOUT_MS:CONNECT_TIMEOUT_MS); };
  const scheduleRetry=()=>{ clearTimeout(retryTimer.current); const delay=retryMs.current; retryMs.current=Math.min(delay*2,RETRY_MAX_MS); retryTimer.current=setTimeout(open,delay); };
  const attemptFailed=()=>{ const current=target.current; if(!current)return; if(established.current){ scheduleRetry(); return; }
    disconnect(`Couldn’t reach ${current.name??current.label}. Check the gateway is running and this phone is on the same network, and allowed Local Network access in Settings.`); };
  const opened=(ws:WebSocket,url:string)=>{ const current=target.current!; const label=gatewayLabel(url); const again=established.current;
    socket.current=ws; established.current=true; heardAt.current=Date.now(); pinged.current=false; accepted.current=false; early.current=[]; current.label=label;
    // The session lets a reconnect inside the same ARKit world keep its calibration; the token is the pairing code:
    // the one given for this target, else one saved for the address that answered (never for a claimed id alone).
    current.sent=current.code??savedCode(label,current.gatewayId);
    send({type:'hello',version:PROTOCOL_VERSION,role:'phone',deviceId:settings.deviceId,sessionId:session.current,...(current.sent?{token:current.sent}:{})});
    // Still reconnecting until the gateway accepts the phone (its first config): an open socket alone may be refused or dropped at once.
    setGateway(label); setAddress(label); if(again)return;
    setScreen('live'); setRecent(old=>{ const next=[label,...old.filter(item=>item!==label)].slice(0,MAX_RECENT); settings.recent=next; saveSettings(settings); return next; }); void startTracking(); };
  /** The open connection is gone. A refused pairing code leaves; anything else keeps the screen and ARKit running and retries in place. */
  const dropped=(ws:WebSocket,closeCode?:number,why?:string)=>{ if(socket.current!==ws)return; socket.current=undefined; ws.close(); const current=target.current; if(!current)return;
    if(closeCode===CLOSE_CODES.pairingRequired){ pairingRefused(current,why); return; }
    if(closeCode===CLOSE_CODES.replaced){ disconnect(`Another connection from this phone took over ${current.label}.`); return; }
    for(const controlId of dragging.current.keys())cutDrags.current.add(controlId); releaseAll();
    const reason=why??'The connection dropped'; setReconnecting(reason); const previous=latest.current.get('connection') as ConnectionEvent|undefined;
    if(previous?.state!=='reconnecting'||previous.reason!==reason)toHtml('connection',{state:'reconnecting',gateway:current.label,reason} satisfies ConnectionEvent);
    toHtml('link',{quality:'unknown'} satisfies LinkEvent); scheduleRetry(); };
  /**
   * 4401: the gateway wants a pairing code, or a different one, or has shut this address out for a while. Back to the
   * connect page with the code field and the gateway's reason. Only a wrong code is forgotten: an address shut out after
   * too many wrong codes (from any device behind it) turns the right code away too.
   */
  const pairingRefused=(current:Target,why?:string)=>{ const name=current.name??current.label; const sent=current.sent; const wrong=/^wrong pairing code/i.test(why??'');
    if(sent&&wrong&&savedCode(current.label,current.gatewayId)===sent)forgetCode(current.label,sent);
    disconnect(wrong?`${name} didn’t accept that pairing code.`:why&&!/^pairing code required/i.test(why)?`${name} refused the connection: ${why.replace(/\.$/,'')}.`:undefined);
    setAddress(current.label); setCode(sent?formatPairingCode(sent):''); setCodeNote(`${name} needs its pairing code`); setCodeShown(true); };
  const receivedConfig=(m:unknown)=>{ const next=sanitizeConfig(m); const current=target.current; if(!next||!current)return;
    // Once a gateway has accepted the phone, only that gateway may take over its screen again. A different one at the
    // address (a restart elsewhere moved it, or a host copied the id) makes the app leave rather than drive on with it.
    if(current.pinned!==undefined&&(next.gatewayId??'')!==current.pinned){ disconnect(`A different gateway answered at ${current.label}. Check it’s the one you want, then connect again.`); return; }
    // After the hello the gateway only sends this phone its own config. A hello slower than the gateway's 250 ms
    // console grace first gets console traffic (the gateway view and other phones' configs), so the latest config
    // that names a phone wins instead of the first, and a config without a phone never replaces one that has it.
    if(configRef.current?.phone&&!next.phone)return;
    // A restarted gateway keeps no robot state from before, so neither does the replay.
    if(gatewaySession.current&&gatewaySession.current!==next.sessionId)robotStates.current.clear(); gatewaySession.current=next.sessionId;
    configRef.current=next; toHtml('config',next);
    if(!next.phone||accepted.current)return;
    // The first phone config means the gateway accepted the phone, and with it the code: the page hears it's connected,
    // the code is kept and the form cleared. Only then does the backoff start over, so a gateway that accepts sockets and
    // drops them doesn't get a retry every 0.5 s.
    accepted.current=true; retryMs.current=RETRY_FIRST_MS; current.gatewayId=next.gatewayId; if(current.pinned===undefined)current.pinned=next.gatewayId??'';
    setReconnecting(undefined); toHtml('connection',{state:'connected',gateway:current.label} satisfies ConnectionEvent);
    if(current.sent)rememberCode(current.label,next.gatewayId,current.sent); setCode(''); setCodeShown(false); setCodeNote(undefined);
    for(const message of early.current.splice(0))relay(message); };
  const relay=(m:unknown)=>{ const type=m&&typeof m==='object'?(m as {type?:unknown}).type:undefined;
    // The gateway sends its screen on every connection: the same document again must not reload the page.
    if(type==='html_config'){ if(validateHtmlConfig(m)){ const same=htmlConfigRef.current?.html===m.html; htmlConfigRef.current=m; if(same)return; releaseAll(); cutDrags.current.clear(); setHtmlConfig(m); setHtmlLoaded(false); setHtmlKey(key=>key+1); } }
    else if(type==='status'){ if(validateStatus(m)&&(!m.phoneId||m.phoneId===configRef.current?.phone?.id))toHtml('status',m); }
    else if(type==='camera_frame'){ const config=configRef.current; if(validateCameraFrame(m)&&config&&selectedCameraView(config)?.streams.includes(m.cameraId))toHtml('camera_frame',m); }
    else if(type==='ping'){ if(!validatePing(m))return; pinged.current=true; send({type:'pong',version:PROTOCOL_VERSION,id:m.id,sentAt:m.sentAt,at:Date.now()}); toHtml('link',{rttMs:m.rttMs,quality:linkQuality(m.rttMs)} satisfies LinkEvent); }
    else if(type==='robot_state'){ if(!validateRobotState(m)||!m.robotId||(m.phoneId!==undefined&&m.phoneId!==configRef.current?.phone?.id))return; robotStates.current.set(`${m.robotId}\n${m.phoneId??''}`,m); inject('robot_state',m); }
    else if(type==='rtc'){ if(validateRtc(m))inject('rtc',m); } };
  const received=(data:unknown)=>{ heardAt.current=Date.now(); let m:unknown; try{ m=JSON.parse(String(data)); }catch{ return; }
    if(m&&typeof m==='object'&&(m as {type?:unknown}).type==='config'){ receivedConfig(m); return; }
    // Until the gateway accepts the phone, what it sends (its screen first) waits for the config that says who it is.
    if(!accepted.current){ if(early.current.length<MAX_EARLY)early.current.push(m); return; }
    relay(m); };
  /** Connects to what the operator typed or picked: an address (with the code typed, or the one saved for it), or a pasted pairing link. */
  const connect=(input=address)=>{ const link=parsePairingLink(input); if(link){ connectLink(link); return; }
    const url=gatewayUrl(input); if(!url){ setError('That doesn’t look like an address. Type the IP the gateway printed, like 192.168.1.20.'); return; }
    const label=gatewayLabel(url); const typed=codeShown&&input===address?normalizePairingCode(code):''; start({label,urls:[url],code:typed||undefined}); };
  /**
   * A pairing link (scanned, opened from the Camera app, or pasted) brings every address of the gateway, its code and
   * its id. Without a code, each address that answers gets only a code saved for it.
   */
  const connectLink=(link:PairingLink)=>{ const urls=link.hosts.map(host=>gatewayUrl(`${host}:${link.port}`)).filter((url):url is string=>!!url);
    if(!urls.length){ setError('That pairing link has no address this phone can use.'); return; } const label=gatewayLabel(urls[0]);
    start({label,urls,name:link.name,gatewayId:link.gatewayId,code:link.code}); };
  /**
   * A nearby gateway connects with the code saved for its address. One that needs a code the phone hasn't used at that
   * address asks for it first, even when another entry (or an earlier address) has the same name and id: anyone can
   * advertise those.
   */
  const connectNearby=(g:NearbyGateway)=>{ const url=gatewayUrl(`${g.host}:${g.port}`); if(!url)return; const label=gatewayLabel(url);
    const typed=codeShown&&address===label?normalizePairingCode(code):'';
    if(g.auth&&!typed&&!savedCode(label,g.id)){ setAddress(label); setCode(''); setError(undefined); setCodeNote(`${g.name} at ${label} needs its pairing code`); setCodeShown(true); return; }
    start({label,urls:[url],name:g.name,gatewayId:g.id,code:typed||undefined}); };
  // Bridge messages only count from the document the gateway sent. The page cannot navigate away: top-frame
  // http(s) links open in Safari and everything else is refused; frames inside the page may load.
  const onHtmlMessage=(event:WebViewMessageEvent)=>{ const url=event.nativeEvent.url??''; if(url&&!url.startsWith('about:'))return; try { const message=JSON.parse(event.nativeEvent.data);
    if(isHtmlBridgeDisconnect(message)){ disconnect(); return; }
    // WebRTC signaling for the page's video: passed to the gateway as is. A request that can't go out fails at once so the page can retry.
    if(validateHtmlBridgeRtc(message)){ const {kind,streams,stream,peer,to,sdp,candidate}=message;
      if(!send({type:'rtc',version:PROTOCOL_VERSION,kind,streams,stream,peer,to,sdp,candidate,message:message.message})&&kind==='request')inject('rtc',{type:'rtc',version:PROTOCOL_VERSION,kind:'error',stream,peer,message:'Not connected to the gateway'} satisfies RtcMessage); return; }
    if(!validateHtmlBridgeAction(message))return;
    // A live sample of a value being dragged; the final sample (no `live`) closes the drag. A dropped sample is not worth a notice.
    // A drag that starts with no gateway to hear it is cut at once, so it can't start streaming when the gateway is back.
    if(message.live){ if(cutDrags.current.has(message.controlId))return; if(!linked()){ cutDrags.current.add(message.controlId); return; }
      dragging.current.set(message.controlId,{action:message.action,value:message.value,at:Date.now()}); sendAction(message.controlId,message.action,message.value,{live:true}); return; }
    if(cutDrags.current.delete(message.controlId))return;
    dragging.current.delete(message.controlId);
    if(message.value===false&&held.current.has(message.controlId)){ releaseHold(message.controlId); return; }
    const control=configRef.current?.controls.find(c=>c.id===message.controlId&&c.action===message.action);
    if(control?.type==='button'&&control.hold&&typeof message.value==='boolean'){ if(message.value)pressHold(control.id,control.action); else releaseHold(control.id); return; }
    if(linked()&&sendAction(message.controlId,message.action,message.value))return;
    localStatus('Not connected; action not sent'); } catch { /* Ignore messages outside the documented bridge. */ } };
  const replayToHtml=()=>{ setHtmlLoaded(true); for(const [type,payload] of latest.current)inject(type,payload); for(const state of robotStates.current.values())inject('robot_state',state); };
  // Timers, app state and links are subscribed once too, for the same reason.
  useEffect(()=>{ const renew=setInterval(()=>{ for(const [controlId,actionName] of held.current)sendAction(controlId,actionName,true,{renew:true}); },HOLD_RENEW_MS);
    const repeat=setInterval(()=>{ const now=Date.now(); for(const [controlId,drag] of dragging.current)if(now-drag.at>=STREAM_RENEW_MS){ drag.at=now; sendAction(controlId,drag.action,drag.value,{live:true,renew:true}); } },STREAM_RENEW_MS/2);
    const silence=setInterval(()=>{ const ws=socket.current; if(ws&&pinged.current&&Date.now()-heardAt.current>SILENCE_MS)dropped(ws,undefined,'The gateway stopped answering'); },500);
    // Back in the foreground while reconnecting, try at once instead of waiting out the backoff.
    const appState=AppState.addEventListener('change',next=>{ if(next!=='active'){ releaseAll(); return; } if(established.current&&!socket.current&&target.current){ retryMs.current=RETRY_FIRST_MS; open(); } });
    // A pairing link opens the app (the iOS Camera app reads the gateway's QR code) or arrives while it runs. iOS asks
    // before opening a link that comes from outside an app, `simctl openurl` included, so a headless simulator run passes
    // it as a launch argument instead: `xcrun simctl launch <device> com.instancelabs.marionette -pairingLink 'marionette://pair?…'`.
    const opened=(url?:string|null)=>{ const link=url?parsePairingLink(url):undefined; if(link){ setScanning(false); connectLink(link); } };
    const launchLink=UserDefaults.get('pairingLink'); Linking.getInitialURL().then(url=>opened(url??(typeof launchLink==='string'?launchLink:undefined))).catch(()=>{}); const links=Linking.addEventListener('url',({url})=>opened(url));
    return()=>{ clearInterval(renew); clearInterval(repeat); clearInterval(silence); appState.remove(); links.remove(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  // Nearby gateways are looked for only while the connect page shows.
  const browsing=screen==='connect';
  useEffect(()=>{ if(!discovery||!browsing)return;
    const sub=discovery.addListener('onChange',event=>{ setNearby(Array.isArray(event.gateways)?event.gateways.filter(isNearby):[]); setNearbyStatus(event.status==='denied'||event.status==='unavailable'?event.status:'browsing'); });
    discovery.start(); return()=>{ sub.remove(); discovery.stop(); setNearby([]); setNearbyStatus('browsing'); };
  },[browsing]);
  // A screen may ask for an orientation; the connect page (and a screen that doesn't ask) turns freely.
  const orientation=screen==='live'?htmlConfig?.orientation:undefined;
  useEffect(()=>{ const lock=orientation==='portrait'?ScreenOrientation.OrientationLock.PORTRAIT_UP:orientation==='landscape'?ScreenOrientation.OrientationLock.LANDSCAPE:undefined;
    (lock===undefined?ScreenOrientation.unlockAsync():ScreenOrientation.lockAsync(lock)).catch(()=>{ /* iOS may refuse a lock (a resizable window); the screen still works unrotated. */ });
  },[orientation]);

  const {width,height}=useWindowDimensions(); const wide=width>=720; const short=height<560;
  if(screen==='live'&&htmlConfig)return <View style={styles.live}><StatusBar style="dark"/>
    <WebView key={htmlKey} ref={htmlRef} originWhitelist={['*']} source={{html:htmlConfig.html,baseUrl:'about:blank'}} injectedJavaScriptBeforeContentLoaded={bridgeScript} injectedJavaScript={bridgeScript} onMessage={onHtmlMessage}
      onShouldStartLoadWithRequest={request=>{ if(request.url.startsWith('about:')||!request.isTopFrame)return true; if(/^https?:/i.test(request.url))Linking.openURL(request.url).catch(()=>{}); return false; }}
      onLoadStart={()=>{ releaseAll(); cutDrags.current.clear(); }} onLoad={replayToHtml} onContentProcessDidTerminate={()=>{ releaseAll(); cutDrags.current.clear(); setHtmlLoaded(false); setHtmlKey(key=>key+1); }}
      /* Receive-only WebRTC video plays inline and unmuted without a tap (and needs no camera permission). */
      allowsInlineMediaPlayback mediaPlaybackRequiresUserAction={false}
      javaScriptEnabled domStorageEnabled bounces={false} contentInsetAdjustmentBehavior="never" automaticallyAdjustContentInsets={false} dataDetectorTypes="none" allowsLinkPreview={false} style={styles.webview}/>
    {!htmlLoaded&&<View style={styles.loading} pointerEvents="none"><ActivityIndicator color={INK2}/></View>}
    {reconnecting!==undefined&&<ReconnectBanner gateway={gateway} reason={reconnecting} onLeave={()=>disconnect()}/>}
  </View>;
  if(screen!=='connect')return <SafeAreaView style={styles.page}><StatusBar style="dark"/><Paper/><View style={styles.waiting}>
    <ActivityIndicator color={BLUE}/><Text style={styles.waitingText}>{screen==='connecting'?`Connecting to ${gateway}…`:reconnecting!==undefined?`Reconnecting to ${gateway}…`:`Loading ${gateway}’s screen…`}</Text>
    {reconnecting!==undefined&&<Text style={styles.waitingNote}>{reconnecting}</Text>}
    <Pressable style={styles.secondary} onPress={()=>disconnect()}><Text style={styles.secondaryText}>{reconnecting!==undefined?'Leave':'Cancel'}</Text></Pressable></View></SafeAreaView>;
  const savedFor=(g:NearbyGateway)=>{ const url=gatewayUrl(`${g.host}:${g.port}`); return !!url&&!!savedCode(gatewayLabel(url),g.id); };
  return <SafeAreaView style={styles.page}><StatusBar style="dark"/><Paper/>
    <KeyboardAvoidingView behavior="padding" style={styles.flex}><ScrollView contentContainerStyle={[styles.content,wide&&styles.contentWide]} keyboardShouldPersistTaps="handled">
      <View style={[styles.column,wide&&styles.columnWide]}>
        <View style={[styles.markRow,short&&styles.markRowShort]}><Mark/><Text style={styles.markText}>Marionette</Text></View>
        <Text style={[styles.title,short&&styles.titleShort]}>Connect to your robot’s gateway</Text>
        <Text style={styles.body}>Scan the QR code it shows, pick it from Nearby, or type the address it prints. Same Wi-Fi or Tailscale.</Text>
        <TextInput value={address} onChangeText={text=>{ setAddress(text); setError(undefined); }} onSubmitEditing={event=>connect(event.nativeEvent.text)} placeholder="192.168.1.20" placeholderTextColor="#9aa1a6" autoCapitalize="none" autoCorrect={false} keyboardType="url" returnKeyType="go" textContentType="URL" style={styles.input} accessibilityLabel="Gateway address"/>
        <View style={styles.noteRow}><Text style={styles.note}>port 8787 unless you type one</Text>
          {!codeShown&&<Pressable onPress={()=>{ setCodeNote(undefined); setCodeShown(true); }} hitSlop={10} accessibilityRole="button"><Text style={styles.textButton}>Pairing code?</Text></Pressable>}</View>
        {codeShown&&<View style={styles.codeBlock}>
          <Text style={styles.label}>{codeNote??'Pairing code'}</Text>
          <TextInput value={code} onChangeText={text=>{ setCode(text.toUpperCase()); setError(undefined); }} onEndEditing={()=>setCode(old=>old&&formatPairingCode(old))} onSubmitEditing={()=>connect()} placeholder="K7Q2-M9XD" placeholderTextColor="#9aa1a6" autoFocus autoCapitalize="characters" autoCorrect={false} autoComplete="off" spellCheck={false} returnKeyType="go" style={styles.input} accessibilityLabel="Pairing code"/>
          <Text style={styles.hint}>The gateway prints its code when it starts, and the desktop viewer’s <Text style={styles.hintStrong}>Pair</Text> button shows it.</Text>
        </View>}
        {error&&<Text style={styles.error} accessibilityRole="alert">{error}</Text>}
        <Pressable style={({pressed})=>[styles.button,pressed&&styles.pressed]} onPress={()=>connect()} accessibilityRole="button"><Text style={styles.buttonText}>Connect</Text></Pressable>
      </View>
      <View style={[styles.column,wide&&styles.columnWide,wide&&{paddingTop:short?48:108}]}>
        <Pressable style={({pressed})=>[styles.scan,pressed&&styles.pressed]} onPress={()=>{ setError(undefined); setScanning(true); }} accessibilityRole="button"><QrGlyph/><Text style={styles.secondaryText}>Scan QR code</Text></Pressable>
        {discovery&&<View style={styles.section}><View style={styles.sectionHead}><Text style={styles.sectionTitle}>Nearby</Text>{nearbyStatus==='browsing'&&!nearby.length&&<ActivityIndicator size="small" color={INK2}/>}</View>
          {nearby.map(g=><NearbyRow key={`${g.id}@${g.host}:${g.port}`} gateway={g} needsCode={g.auth&&!savedFor(g)} onConnect={connectNearby}/>)}
          {!nearby.length&&<Text style={styles.sectionNote}>{nearbyStatus==='denied'?'Turn on Local Network for Marionette in Settings to see gateways on this network.':nearbyStatus==='unavailable'?'Can’t look for gateways on this network right now.':'Looking for gateways on this network…'}</Text>}
          {nearbyStatus==='denied'&&<Pressable onPress={()=>Linking.openSettings().catch(()=>{})} hitSlop={10} accessibilityRole="button"><Text style={[styles.textButton,styles.settingsLink]}>Open Settings</Text></Pressable>}
        </View>}
        {recent.length>0&&<View style={styles.section}><Text style={styles.sectionTitle}>Recent</Text>{recent.map(item=><Pressable key={item} style={({pressed})=>[styles.row,pressed&&styles.pressed]} onPress={()=>connect(item)} accessibilityRole="button" accessibilityLabel={`Connect to ${item}`}><Text style={styles.recentText}>{item}</Text><Text style={styles.rowGo}>Connect</Text></Pressable>)}</View>}
      </View>
    </ScrollView></KeyboardAvoidingView>
    {scanning&&<Scanner onLink={link=>{ setScanning(false); connectLink(link); }} onCancel={()=>setScanning(false)}/>}
  </SafeAreaView>;
}

function NearbyRow({gateway,needsCode,onConnect}:{gateway:NearbyGateway;needsCode:boolean;onConnect:(gateway:NearbyGateway)=>void}){
  return <Pressable style={({pressed})=>[styles.row,pressed&&styles.pressed]} onPress={()=>onConnect(gateway)} accessibilityRole="button" accessibilityLabel={`Connect to ${gateway.name}`}>
    <View style={styles.rowMain}><Text style={styles.rowName} numberOfLines={1}>{gateway.name}</Text><Text style={styles.rowAddress} numberOfLines={1}>{gateway.host}:{gateway.port}</Text></View>
    <Text style={styles.rowGo}>{needsCode?'Pair':'Connect'}</Text></Pressable>;
}

/** Shown over the screen while the app reconnects in place; the page underneath keeps running. */
function ReconnectBanner({gateway,reason,onLeave}:{gateway:string;reason:string;onLeave:()=>void}){
  return <SafeAreaView style={styles.bannerWrap} pointerEvents="box-none"><View style={styles.banner} accessibilityRole="alert">
    <ActivityIndicator color={RED}/>
    <View style={styles.bannerText}><Text style={styles.bannerTitle} numberOfLines={2}>Reconnecting to <Text style={styles.mono}>{gateway}</Text>…</Text><Text style={styles.bannerReason} numberOfLines={1}>{reason}</Text></View>
    <Pressable style={({pressed})=>[styles.secondary,styles.bannerLeave,pressed&&styles.pressed]} onPress={onLeave} accessibilityRole="button"><Text style={styles.secondaryText}>Leave</Text></Pressable>
  </View></SafeAreaView>;
}

/** Full-screen QR scanner for a gateway's pairing link. ARKit isn't running on the connect page, so the camera is free. */
function Scanner({onLink,onCancel}:{onLink:(link:PairingLink)=>void;onCancel:()=>void}){
  const [permission,requestPermission]=useCameraPermissions(); const [notice,setNotice]=useState<string>(); const done=useRef(false); const rejected=useRef('');
  const {width,height}=useWindowDimensions(); const frame=Math.min(260,width-80,height*0.42);
  const askable=!!permission&&!permission.granted&&permission.canAskAgain; const denied=!!permission&&!permission.granted&&!permission.canAskAgain;
  useEffect(()=>{ if(askable)requestPermission().catch(()=>{}); },[askable,requestPermission]);
  const scanned=({data}:BarcodeScanningResult)=>{ if(done.current)return; const link=parsePairingLink(data); if(link){ done.current=true; onLink(link); return; }
    if(rejected.current!==data){ rejected.current=data; setNotice('That isn’t a Marionette pairing code. Scan the one the gateway shows.'); } };
  return <Modal visible animationType="slide" presentationStyle="fullScreen" supportedOrientations={['portrait','landscape']} onRequestClose={onCancel}>
    <View style={styles.scanner}><StatusBar style="light"/>
      {permission?.granted&&<CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{barcodeTypes:['qr']}} onBarcodeScanned={scanned}/>}
      <SafeAreaView style={styles.flex}><View style={styles.scannerChrome}>
        <View style={styles.scannerCard}>
          <Text style={styles.scannerTitle}>Scan the gateway’s QR code</Text>
          <Text style={styles.scannerBody}>{denied?'Camera access is off for Marionette. Turn it on in Settings to scan a pairing code, or type the gateway’s address instead.':'The gateway shows it in its terminal when it starts, and the desktop viewer’s Pair button shows it too.'}</Text>
          {denied&&<Pressable onPress={()=>Linking.openSettings().catch(()=>{})} hitSlop={10} accessibilityRole="button"><Text style={[styles.textButton,styles.settingsLink]}>Open Settings</Text></Pressable>}
        </View>
        {permission?.granted?<View style={[styles.viewfinder,{width:frame,height:frame}]}/>:<View/>}
        <View style={styles.scannerFoot}>
          {notice&&<Text style={styles.scannerNotice}>{notice}</Text>}
          <Pressable style={({pressed})=>[styles.secondary,pressed&&styles.pressed]} onPress={onCancel} accessibilityRole="button"><Text style={styles.secondaryText}>Cancel</Text></Pressable>
        </View>
      </View></SafeAreaView>
    </View>
  </Modal>;
}

const PAPER='#fafaf6', GRID='#e6ebf2', INK='#2e3033', INK2='#6b6f73', RULE='#cfd3d6', BLUE='#2f53b5', RED='#cf3f35';
/** The faint 24 pt graph-paper grid behind native pages, matching the gateway's screen. */
function Paper(){ const {width,height}=useWindowDimensions(); return <View style={StyleSheet.absoluteFill} pointerEvents="none">{Array.from({length:Math.ceil(height/24)},(_,i)=><View key={`h${i}`} style={[styles.gridH,{top:i*24}]}/>)}{Array.from({length:Math.ceil(width/24)},(_,i)=><View key={`v${i}`} style={[styles.gridV,{left:i*24}]}/>)}</View>; }
/** The Marionette mark, as on the app icon (assets/icon.svg): a control bar whose strings end in beads, the middle one holding a blue ring. */
function Mark(){ return <View style={styles.mark}><View style={[styles.markString,{left:3.2,height:13.8}]}/><View style={[styles.markString,{left:12.4,height:8}]}/><View style={[styles.markString,{left:21.5,height:16}]}/><View style={[styles.markBead,{left:2.6,top:19.8}]}/><View style={[styles.markBead,{left:20.8,top:22.1}]}/><View style={styles.markHandle}/><View style={styles.markBar}/><View style={styles.markRing}/></View>; }
/** A small QR code drawn in ink: three finder squares and a few modules. */
function QrGlyph(){ return <View style={styles.qr}>{[{left:0,top:0},{left:11,top:0},{left:0,top:11}].map((at,i)=><View key={i} style={[styles.qrFinder,at]}/>)}{[[12,12],[16,12],[12,16],[16,16],[14,14]].map(([left,top],i)=><View key={`m${i}`} style={[styles.qrModule,{left,top}]}/>)}</View>; }

const styles=StyleSheet.create({
  flex:{flex:1}, live:{flex:1,backgroundColor:PAPER}, webview:{flex:1,backgroundColor:PAPER}, loading:{position:'absolute',top:0,left:0,right:0,bottom:0,alignItems:'center',justifyContent:'center',backgroundColor:PAPER},
  page:{flex:1,backgroundColor:PAPER}, content:{paddingHorizontal:22,paddingBottom:40,width:'100%',maxWidth:520,alignSelf:'center'}, contentWide:{flexDirection:'row',gap:48,maxWidth:980},
  column:{alignSelf:'stretch'}, columnWide:{flex:1},
  gridH:{position:'absolute',left:0,right:0,height:StyleSheet.hairlineWidth,backgroundColor:GRID}, gridV:{position:'absolute',top:0,bottom:0,width:StyleSheet.hairlineWidth,backgroundColor:GRID},
  markRow:{flexDirection:'row',alignItems:'center',gap:10,marginTop:40}, markRowShort:{marginTop:16}, markText:{color:INK,fontSize:18,fontWeight:'600'},
  mark:{width:26,height:26}, markBar:{position:'absolute',left:2.5,right:2.5,top:5.8,height:2.9,borderRadius:1.45,backgroundColor:INK}, markHandle:{position:'absolute',left:11.9,top:1.6,width:2.2,height:5.6,borderRadius:1.1,backgroundColor:INK},
  markString:{position:'absolute',top:7.2,width:1.2,borderRadius:0.6,backgroundColor:INK}, markBead:{position:'absolute',width:2.4,height:2.4,borderRadius:1.2,backgroundColor:INK}, markRing:{position:'absolute',left:8.7,top:14.4,width:8.6,height:8.6,borderRadius:4.3,borderWidth:1.8,borderColor:BLUE},
  title:{color:INK,fontSize:30,lineHeight:35,fontWeight:'600',letterSpacing:-0.3,marginTop:56,marginBottom:10,maxWidth:320}, titleShort:{marginTop:20},
  body:{color:INK2,fontSize:16,lineHeight:23,marginBottom:28,maxWidth:330},
  input:{backgroundColor:'#fff',borderColor:INK,borderWidth:1.5,borderRadius:12,paddingHorizontal:16,paddingVertical:15,fontFamily:'Menlo',fontSize:20,color:INK},
  noteRow:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',gap:12,marginTop:8},
  note:{fontFamily:'Noteworthy',color:BLUE,fontSize:17,marginLeft:4,transform:[{rotate:'-1deg'}]},
  textButton:{color:BLUE,fontSize:15,fontWeight:'500'}, settingsLink:{marginTop:8},
  codeBlock:{marginTop:18}, label:{color:INK,fontSize:15,fontWeight:'600',marginBottom:8}, hint:{color:INK2,fontSize:14,lineHeight:20,marginTop:8}, hintStrong:{color:INK,fontWeight:'600'},
  error:{color:RED,fontSize:16,lineHeight:22,marginTop:14},
  button:{height:56,borderRadius:12,backgroundColor:BLUE,alignItems:'center',justifyContent:'center',marginTop:22}, buttonText:{color:'#fff',fontSize:17,fontWeight:'600'}, pressed:{opacity:0.75},
  scan:{height:52,borderRadius:12,borderWidth:1.5,borderColor:INK,backgroundColor:'#fff',flexDirection:'row',alignItems:'center',justifyContent:'center',gap:10,marginTop:14},
  qr:{width:20,height:20}, qrFinder:{position:'absolute',width:9,height:9,borderWidth:2,borderColor:INK,borderRadius:1.5}, qrModule:{position:'absolute',width:3,height:3,backgroundColor:INK},
  section:{marginTop:30}, sectionHead:{flexDirection:'row',alignItems:'center',gap:8,marginBottom:4}, sectionTitle:{color:INK2,fontSize:14,marginBottom:4}, sectionNote:{color:INK2,fontSize:14,lineHeight:20,paddingTop:10,borderTopWidth:1,borderTopColor:RULE},
  row:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',gap:12,minHeight:48,paddingVertical:6,borderTopWidth:1,borderTopColor:RULE}, rowMain:{flex:1}, rowName:{color:INK,fontSize:16,fontWeight:'500'}, rowAddress:{fontFamily:'Menlo',fontSize:13,color:INK2,marginTop:2}, rowGo:{color:BLUE,fontSize:15},
  recentText:{fontFamily:'Menlo',fontSize:15,color:INK},
  waiting:{flex:1,alignItems:'center',justifyContent:'center',gap:16,paddingHorizontal:30}, waitingText:{color:INK,fontSize:17,textAlign:'center'}, waitingNote:{color:INK2,fontSize:15,textAlign:'center',marginTop:-8},
  secondary:{minHeight:44,paddingHorizontal:20,borderRadius:10,borderWidth:1.5,borderColor:INK,backgroundColor:'#fff',alignItems:'center',justifyContent:'center'}, secondaryText:{color:INK,fontSize:16,fontWeight:'500'},
  bannerWrap:{position:'absolute',top:0,left:0,right:0}, banner:{flexDirection:'row',alignItems:'center',gap:12,marginHorizontal:12,marginTop:8,paddingVertical:10,paddingLeft:14,paddingRight:10,borderRadius:14,borderWidth:1.5,borderColor:RED,backgroundColor:PAPER,shadowColor:INK,shadowOpacity:0.18,shadowRadius:10,shadowOffset:{width:0,height:3}},
  bannerText:{flex:1}, bannerTitle:{color:INK,fontSize:15,fontWeight:'600'}, bannerReason:{color:INK2,fontSize:13,marginTop:2}, bannerLeave:{minHeight:38,paddingHorizontal:14}, mono:{fontFamily:'Menlo',fontWeight:'400'},
  scanner:{flex:1,backgroundColor:'#111214'}, scannerChrome:{flex:1,alignItems:'center',justifyContent:'space-between',padding:20},
  scannerCard:{maxWidth:480,width:'100%',backgroundColor:PAPER,borderRadius:14,borderWidth:1.5,borderColor:INK,padding:16}, scannerTitle:{color:INK,fontSize:18,fontWeight:'600'}, scannerBody:{color:INK2,fontSize:14,lineHeight:20,marginTop:4},
  viewfinder:{borderWidth:2.5,borderColor:'#fff',borderRadius:22}, scannerFoot:{alignItems:'center',gap:12}, scannerNotice:{color:'#fff',fontSize:15,lineHeight:21,textAlign:'center',maxWidth:340,backgroundColor:'rgba(17,18,20,0.7)',paddingHorizontal:12,paddingVertical:6,borderRadius:8,overflow:'hidden'},
});
