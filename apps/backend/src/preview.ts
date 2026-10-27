import { STREAM_RENEW_MS, htmlBridgeScript, type HtmlBridgeFeature } from '@marionette/protocol';
import { startTags } from './screens.js';

/** FNV-1a over UTF-16 code units; the bridge computes the same in the page to tell whether a screen changed. */
export function screenHash(text: string): number { let hash = 0x811c9dc5; for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; } return hash; }
export const MIRROR_FEATURES: readonly HtmlBridgeFeature[] = ['live', 'robot_state', 'link', 'rtc', 'reconnect'];

/**
 * The phone screen for a desktop browser: the same document with the same
 * `window.Marionette` bridge, carried over this gateway's WebSocket instead of the
 * app. It mirrors one phone (`?phone=phone-2`, or the first connected phone) and
 * acts as that phone; its presses reach consumers marked `source: 'mirror'`. It
 * passes the page's `?token=` to the gateway, relays robot state and WebRTC
 * signaling both ways, pings the gateway each second for the `link` event, and
 * reconnects in place (reloading only when the screen itself changed). It is
 * connected once the gateway has sent it its config, not when the socket opens.
 *
 * A drag the connection or a switch to another phone cuts stays cut until the
 * finger lifts: the page's stream is still open, but its samples are dropped and
 * its final value only ends it here, so it never starts streaming again by itself.
 * The phone changes for the page's kit and for this bridge alike, so the two cut the
 * same drags: another phone, no phone any more, or a phone after none. A sample or a
 * press that couldn't be sent is never repeated later either. Every action names the
 * phone it was meant for (`phoneId`), so the gateway can drop one still in flight
 * when it moves the mirror to another phone.
 */
// `follow` is a phone id; `<` is escaped too, so nothing in it can close the inline script.
const previewBridge = (follow: string, shown: number) => `(function(){var ws=null,config,ready=false,held={},dragging={},cut={},tracking='',stopped=false,pingId=0,awaiting=null,shown=${shown},follow=${JSON.stringify(follow).replace(/</g, '\\u003c')};
var token=(function(){try{return new URLSearchParams(location.search).get('token')||'';}catch(e){return '';}})();
function receive(type,payload){window.Marionette._receive({type:type,payload:payload});}
function phoneOf(c){return c&&c.phone?c.phone.id:undefined;}
function hash(s){var h=0x811c9dc5;for(var i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,0x01000193)>>>0;}return h;}
function streams(){if(!config)return[];var c=config.controls.find(function(x){return x.action==='camera.view';});var views=config.cameraViews||[];var v=views.find(function(x){return c&&x.id===c.value;})||views[0];return v?v.streams:[];}
function post(m){if(m.type==='disconnect'){stopped=true;if(ws)ws.close();return;}
var open=ready&&!!ws&&ws.readyState===1;
if(m.type==='rtc'){if(open)ws.send(JSON.stringify(m));else receive('rtc',{type:'rtc',version:1,kind:'error',peer:m.peer,stream:m.stream,message:'Not connected to the gateway'});return;}
if(cut[m.controlId]){if(!m.live)delete cut[m.controlId];return;}
if(!open){if(m.live)cut[m.controlId]=1;else if(!m.renew)receive('status',{type:'status',version:1,sessionId:'preview',message:'Not connected to the gateway; that was not sent'});delete dragging[m.controlId];return;}
var c=config.controls.find(function(x){return x.id===m.controlId&&x.action===m.action;});if(c&&c.hold&&typeof m.value==='boolean'&&!m.renew){if(m.value)held[m.controlId]=m.action;else delete held[m.controlId];}
if(!m.renew){if(m.live)dragging[m.controlId]={action:m.action,value:m.value,at:Date.now()};else delete dragging[m.controlId];}else if(dragging[m.controlId])dragging[m.controlId].at=Date.now();
m.version=1;m.sessionId=config.sessionId;m.phoneId=phoneOf(config);ws.send(JSON.stringify(m));}
${htmlBridgeScript('function(m){post(m);}', MIRROR_FEATURES)}
setInterval(function(){for(var id in held)post({type:'action',controlId:id,action:held[id],value:true,renew:true,sentAt:Date.now()});},200);
setInterval(function(){var now=Date.now();for(var id in dragging){var s=dragging[id];if(now-s.at>=${STREAM_RENEW_MS})post({type:'action',controlId:id,action:s.action,value:s.value,live:true,renew:true,sentAt:now});}},${Math.round(STREAM_RENEW_MS / 2)});
/* One ping in flight at a time; one unanswered for 3.5 s means the connection is gone even if the socket has not noticed. */
setInterval(function(){if(!ws||ws.readyState!==1)return;if(awaiting){if(performance.now()-awaiting.at>3500)drop();return;}awaiting={id:++pingId,at:performance.now()};ws.send(JSON.stringify({type:'ping',version:1,id:pingId,sentAt:Date.now()}));},1000);
/* Holds end with the connection or the phone (the gateway ends them too); drags still under a finger are cut. */
function cutAll(){for(var id in dragging)cut[id]=1;dragging={};held={};}
function lost(why){cutAll();ready=false;tracking='';awaiting=null;receive('link',{quality:'unknown'});
if(stopped){receive('connection',{state:'disconnected',gateway:location.host,reason:why||'disconnected; reload the page to connect again'});return;}
receive('connection',{state:'reconnecting',gateway:location.host,reason:'lost the gateway, retrying'});setTimeout(open,1000);}
function drop(){var old=ws;ws=null;if(old){old.onclose=null;old.onmessage=null;try{old.close();}catch(e){}}lost();}
function open(){var socket=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws'+(token?'?token='+encodeURIComponent(token):''));ws=socket;
socket.onopen=function(){socket.send(JSON.stringify({type:'hello',version:1,role:'console',follow:follow}));};
socket.onmessage=function(e){var m;try{m=JSON.parse(e.data);}catch(x){return;}
if(m.type==='pong'){if(awaiting&&m.id===awaiting.id){var rtt=Math.round((performance.now()-awaiting.at)*10)/10;awaiting=null;receive('link',{rttMs:rtt,quality:rtt<60?'good':rtt<150?'fair':'poor'});}return;}
if(m.type==='ping'){socket.send(JSON.stringify({type:'pong',version:1,id:m.id,sentAt:m.sentAt,at:Date.now()}));return;}
if(m.type==='html_config'){if(hash(m.html)!==shown)location.reload();return;}
if(m.type==='config'){if(config&&phoneOf(config)!==phoneOf(m)){cutAll();tracking='';}config=m;receive('config',m);
/* The gateway's config for this connection: the page has the fresh one (holds, live drags, phone) before it hears it's connected. */
if(!ready){ready=true;receive('connection',{state:'connected',gateway:location.host});}return;}
if(m.type==='pose'&&tracking!==m.trackingState+m.source){tracking=m.trackingState+m.source;receive('tracking',{state:m.trackingState,source:m.source});}
if(m.type==='camera_frame'&&streams().indexOf(m.cameraId)<0)return;var mine=phoneOf(config);if((m.type==='pose'||m.type==='status')&&m.phoneId&&m.phoneId!==mine)return;if(m.type!=='input')receive(m.type,m);};
socket.onclose=function(e){if(ws!==socket)return;ws=null;
if(e.code===4401)stopped=true;lost(e.code===4401?'the gateway needs its pairing code: add ?token=CODE to this address':undefined);};}
open();})();`;
/** The screen with the bridge right after its first `<head…>`, or in front of it without one. */
export function screenPreview(html: string, follow: string): string {
  const script = `<script>${previewBridge(follow, screenHash(html))}</script>`; const [head] = startTags(html, /<head/gi);
  return head ? html.slice(0, head.end) + script + html.slice(head.end) : script + html;
}
