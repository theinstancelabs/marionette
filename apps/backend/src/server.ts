import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { defaultConfig, validateAction, validateHtmlConfig, validatePose, type ConfigMessage, type HtmlConfigMessage, type MarionetteMessage, type PosePacket, type ActionMessage, PROTOCOL_VERSION, HTML_BRIDGE_VERSION, HTML_CONFIG_VERSION, type StatusMessage, type CameraFrameMessage } from '@marionette/protocol';

export type GatewayState = { latestPose?: PosePacket; poseCount: number; lastAction?: ActionMessage; config: ConfigMessage; htmlConfig: HtmlConfigMessage; connectedClients: number; trackingState: string; lastPoseAt?: number; };
const sampleHtml = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px -apple-system,sans-serif;background:#0b181e;color:#e6f3f0;padding:20px}button,select,input{font:inherit;margin:5px 0;padding:10px;border-radius:8px;border:1px solid #29434a;background:#10232a;color:inherit}button{background:#79e3bb;color:#07201b;font-weight:700}label{display:block;margin-top:14px}.status{color:#79e3bb}.camera{width:100%;max-height:220px;object-fit:cover;border-radius:8px;background:#102b34}pre{white-space:pre-wrap;color:#8ba1a8;font-size:12px}</style></head><body><h1>Marionette HTML controls</h1><p class="status" id="status">Connecting bridge…</p><button id="enable">Enable teleop</button> <button id="hold" title="Press and hold">Hold to enable</button> <button id="stop">E-stop</button><label>Arm <select id="arm"><option value="left">Left arm</option><option value="right">Right arm</option></select></label><label>Translation scale <input id="scale" type="range" min="0.1" max="4" step="0.1" value="1"></label><button id="capture">Capture phone origin</button><h2>Pose</h2><pre id="pose">Waiting for pose…</pre><img id="camera" class="camera" alt="Camera surface"><script>const M=window.Marionette;const action=(id,name,value)=>M.sendAction(id,name,value);enable.onclick=()=>action('deadman','teleop.toggle',true);hold.onpointerdown=()=>action('hold','teleop.toggle',true);hold.onpointerup=()=>action('hold','teleop.toggle',false);hold.onpointercancel=()=>action('hold','teleop.toggle',false);stop.onclick=()=>action('estop','safety.estop');arm.onchange=()=>action('arm','arm.select',arm.value);scale.oninput=()=>action('scale','teleop.translationScale',Number(scale.value));capture.onclick=()=>action('capture','calibration.captureOrigin');M.on('status',m=>status.textContent=m.message);M.on('pose',m=>pose.textContent=JSON.stringify({trackingState:m.trackingState,position:m.position,rotation:m.rotation,seq:m.seq},null,2));M.on('camera_frame',m=>camera.src=m.dataUrl);M.on('config',m=>status.textContent='Config received from '+m.serverName);</script></body></html>`;
function makeHtmlConfig(session: string, html = sampleHtml): HtmlConfigMessage { return { type: 'html_config', version: PROTOCOL_VERSION, sessionId: session, htmlVersion: HTML_CONFIG_VERSION, bridgeVersion: HTML_BRIDGE_VERSION, title: 'Marionette HTML controls', html }; }
function loadHtmlConfig(session: string): HtmlConfigMessage { const file = process.env.MARIONETTE_HTML_FILE; const html = process.env.MARIONETTE_HTML ?? (file ? fs.readFileSync(path.resolve(file), 'utf8') : sampleHtml); const candidate = makeHtmlConfig(session, html); if (!validateHtmlConfig(candidate)) throw new Error('MARIONETTE_HTML_FILE/HTML is not a valid HTML config or exceeds 512 KB'); return candidate; }
export const state: GatewayState = { poseCount: 0, config: defaultConfig(), htmlConfig: makeHtmlConfig(''), connectedClients: 0, trackingState: 'unavailable' };
const clients = new Set<WebSocket>();
const sessionId = `marionette-${Math.random().toString(36).slice(2, 9)}`;
state.config.sessionId = sessionId;
state.htmlConfig = loadHtmlConfig(sessionId);

function broadcast(message: MarionetteMessage) { const data = JSON.stringify(message); for (const client of clients) if (client.readyState === WebSocket.OPEN) client.send(data); }
function virtualCamera(): CameraFrameMessage { const stamp = new Date().toISOString(); const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#10273a"/><stop offset="1" stop-color="#1d5b5e"/></linearGradient></defs><rect width="640" height="360" fill="url(#g)"/><path d="M0 270 Q130 180 240 250 T470 210 T700 245 V360 H0Z" fill="#0a151f" opacity=".8"/><circle cx="480" cy="100" r="42" fill="#a4f4cf" opacity=".7"/><text x="24" y="42" font-family="monospace" font-size="18" fill="#d6ffef">MARIONETTE / VIRTUAL CAMERA</text><text x="24" y="328" font-family="monospace" font-size="14" fill="#b8c9d8">${stamp}</text></svg>`;
  return { type:'camera_frame', version: PROTOCOL_VERSION, sessionId, cameraId:'sim', dataUrl:`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, capturedAt: Date.now() };
}
function applyAction(action: ActionMessage): StatusMessage { state.lastAction = action; let message = `Received ${action.action}`; const value = action.value;
  if (action.action === 'teleop.toggle' && typeof value === 'boolean') { state.config.teleop.enabled = value; const c = state.config.controls.find(c=>c.id==='deadman'); if (c?.type==='toggle') c.value=value; message = value ? 'Teleop enabled (diagnostic mode)' : 'Teleop disabled'; }
  if (action.action === 'arm.select' && typeof value === 'string') { state.config.teleop.activeArm=value; const c=state.config.controls.find(c=>c.id==='arm'); if(c?.type==='select') c.value=value; message=`Active arm: ${value}`; }
  if (action.action === 'lift.toggle' && typeof value === 'boolean') { state.config.teleop.includeLift=value; const c=state.config.controls.find(c=>c.id==='lift'); if(c?.type==='toggle') c.value=value; message=value?'Lift included':'Lift excluded'; }
  if (action.action === 'teleop.translationScale' && typeof value === 'number') { state.config.teleop.translationScale=value; const c=state.config.controls.find(c=>c.id==='sensitivity'); if(c?.type==='slider') c.value=value; message=`Translation scale: ${value.toFixed(1)}×`; }
  if (action.action === 'calibration.captureOrigin') { if (state.latestPose) { state.config.calibration = { status: 'captured', originSeq: state.latestPose.seq }; message = `Origin captured at sequence ${state.latestPose.seq}`; } else message = 'Move the phone first; no pose available'; }
  if (action.action === 'calibration.reset') { state.config.calibration = { status: 'uncalibrated' }; message = 'Calibration reset'; }
  if (action.action === 'camera.select') { state.config.activeCameraId = state.config.cameraStreams[0]?.id; message = state.config.activeCameraId ? `Camera selected: ${state.config.activeCameraId}` : 'No camera stream configured'; }
  if (action.action === 'safety.estop') { state.config.teleop.enabled=false; const c=state.config.controls.find(c=>c.id==='deadman'); if(c?.type==='toggle') c.value=false; message='E-stop latched; teleop disabled'; }
  broadcast(state.config); return { type:'status', version:PROTOCOL_VERSION, sessionId, controlId: action.controlId, message, values: { teleopEnabled: state.config.teleop.enabled, activeArm: state.config.teleop.activeArm, includeLift: state.config.teleop.includeLift, translationScale: state.config.teleop.translationScale, calibration: state.config.calibration.status } };
}

export function createServer(port = Number(process.env.PORT) || 8787) {
  const app = express(); app.use(cors()); app.use(express.json());
  app.get('/health', (_req,res)=>res.json({ ok:true, service:'marionette-gateway', sessionId, clients: clients.size, poseCount: state.poseCount }));
  app.get('/api/state', (_req,res)=>res.json({ ...state, sessionId }));
  app.get('/api/config', (_req,res)=>res.json(state.config));
  app.get('/api/html-config', (_req,res)=>res.json(state.htmlConfig));
  const server = http.createServer(app); const wss = new WebSocketServer({ server, path:'/ws' });
  wss.on('connection', (socket) => { clients.add(socket); state.connectedClients=clients.size; socket.send(JSON.stringify(state.config)); socket.send(JSON.stringify(state.htmlConfig)); socket.send(JSON.stringify({type:'status',version:PROTOCOL_VERSION,sessionId,message:'Connected to Marionette gateway',values:{connectedClients:clients.size}} satisfies StatusMessage)); socket.send(JSON.stringify(virtualCamera()));
    socket.on('message',(raw)=>{ try { const message = JSON.parse(raw.toString()) as MarionetteMessage; if (message.type==='pose') { if (!validatePose(message) || (state.latestPose && message.seq <= state.latestPose.seq)) return; state.latestPose=message; state.poseCount++; state.trackingState=message.trackingState; state.lastPoseAt=Date.now(); broadcast(message); }
      else if(message.type==='action' && validateAction(message)) socket.send(JSON.stringify(applyAction(message))); else if(message.type==='camera_frame') broadcast(message); } catch { socket.send(JSON.stringify({type:'status',version:PROTOCOL_VERSION,sessionId,message:'Malformed message ignored'})); } });
    socket.on('close',()=>{ clients.delete(socket); state.connectedClients=clients.size; }); });
  const timer = setInterval(()=>{ if (clients.size) broadcast(virtualCamera()); }, 1000); timer.unref();
  return { app, server, wss, close: () => { clearInterval(timer); for(const c of clients)c.close(); return new Promise<void>(resolve=>server.close(()=>resolve())); } };
}
if (process.env.NODE_ENV !== 'test') { const gateway=createServer(); gateway.server.listen(Number(process.env.PORT)||8787,()=>console.log(`Marionette gateway listening on http://0.0.0.0:${Number(process.env.PORT)||8787}`)); }
