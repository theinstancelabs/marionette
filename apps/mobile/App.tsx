import { StatusBar } from 'expo-status-bar';
import { requireNativeModule } from 'expo';
import { File, Paths } from 'expo-file-system';
import WebView, { type WebViewMessageEvent } from 'react-native-webview';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, KeyboardAvoidingView, Linking, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { gatewayLabel, gatewayUrl, htmlBridgeScript, isHtmlBridgeDisconnect, nominalCovariance, normalizeQuaternion, operatorPose, poseFromTransform, sanitizeConfig, selectedCameraView, streamEndValue, validateCameraFrame, validateHtmlBridgeAction, validateHtmlConfig, validateStatus, PROTOCOL_VERSION, STREAM_RENEW_MS, type ConfigMessage, type ControlValue, type ConnectionEvent, type HtmlBridgeEvent, type HtmlConfigMessage, type MarionetteMessage, type PosePacket, type StatusMessage, type TrackingEvent, type TrackingState } from '@marionette/protocol';

type ArkitEvent = { generation?: number; transform?: number[]; trackingState?: string; state?: string; reason?: string; timestamp?: number; code?: string; message?: string };
type ArkitBridge = { isSupported(): boolean; start(generation: number): Promise<void>; stop(): Promise<void>; addListener(name: 'onPose' | 'onTracking' | 'onError' | 'onWorldReset', listener: (event: ArkitEvent) => void): { remove(): void } };
const arkit = (()=>{ try { return requireNativeModule<ArkitBridge>('MarionetteArKit'); } catch { return null; } })();
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
const MAX_RECENT = 5;
const bridgeScript = htmlBridgeScript('function(m){if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify(m));}');

// Recent gateway addresses (most recent first) and this phone's device id, kept in the app's documents folder.
// The gateway uses the device id to give a reconnecting phone the same name and color.
const settingsFile = new File(Paths.document, 'marionette.json');
type Settings = { recent: string[]; deviceId: string };
function loadSettings(): Settings {
  let parsed: { recent?: unknown; deviceId?: unknown } = {};
  try { if (settingsFile.exists) parsed = JSON.parse(settingsFile.textSync()) as typeof parsed; } catch { /* A damaged file only loses the list. */ }
  const recent = Array.isArray(parsed.recent) ? parsed.recent.filter((item): item is string => typeof item === 'string').slice(0, MAX_RECENT) : [];
  const deviceId = typeof parsed.deviceId === 'string' && /^[a-z0-9-]{8,64}$/.test(parsed.deviceId) ? parsed.deviceId : `iphone-${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;
  if (deviceId !== parsed.deviceId) saveSettings({ recent, deviceId });
  return { recent, deviceId };
}
function saveSettings(settings: Settings) { settingsFile.write(JSON.stringify(settings)).catch(() => { /* Remembering addresses is a convenience; a failed write only loses the list. */ }); }
const settings = loadSettings();

type Screen = 'connect' | 'connecting' | 'live';

export default function App() {
  const [recent, setRecent] = useState<string[]>(settings.recent); const [address, setAddress] = useState(() => recent[0] ?? '');
  const [screen, setScreen] = useState<Screen>('connect'); const [error, setError] = useState<string>(); const [gateway, setGateway] = useState('');
  const [htmlConfig, setHtmlConfig] = useState<HtmlConfigMessage>(); const [htmlKey, setHtmlKey] = useState(0); const [htmlLoaded, setHtmlLoaded] = useState(false);
  const socket=useRef<WebSocket | undefined>(undefined); const seq=useRef(0); const session=useRef(newSessionId()); const syntheticTimer=useRef<ReturnType<typeof setInterval> | undefined>(undefined); const connectTimer=useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const configRef=useRef<ConfigMessage | undefined>(undefined); const lastUiAt=useRef(0); const gatewayRef=useRef('');
  // The last value of every bridge event, so a freshly loaded document starts from the current state.
  const latest=useRef(new Map<HtmlBridgeEvent, unknown>());
  // ARKit events carry the generation passed to start(); anything else is a frame queued from an earlier run.
  const generation=useRef(0); const arkitActive=useRef(false);
  const held=useRef(new Map<string, string>());
  // Sliders and sticks being dragged: their latest sample is repeated while the finger rests.
  const dragging=useRef(new Map<string, { action: string; value?: ControlValue; at: number }>());
  const htmlRef = useRef<React.ComponentRef<typeof WebView>>(null);
  const send=(payload: MarionetteMessage)=>{ if(socket.current?.readyState!==WebSocket.OPEN)return false; socket.current.send(JSON.stringify(payload)); return true; };
  const sendAction=(controlId:string,actionName:string,value?:ControlValue,flags:{renew?:true;live?:true}={})=>send({type:'action',version:PROTOCOL_VERSION,sessionId:session.current,controlId,action:actionName,value,...flags,sentAt:Date.now()});
  const inject=(type:HtmlBridgeEvent,payload:unknown)=>htmlRef.current?.injectJavaScript(`window.Marionette&&window.Marionette._receive(${JSON.stringify({type,payload})});true;`);
  const toHtml=(type:HtmlBridgeEvent,payload:unknown)=>{ latest.current.set(type,payload); inject(type,payload); };
  const localStatus=(message:string)=>toHtml('status',{type:'status',version:PROTOCOL_VERSION,sessionId:session.current,message} satisfies StatusMessage);
  const setTracking=(tracking:TrackingEvent)=>{ const previous=latest.current.get('tracking') as TrackingEvent|undefined; if(previous&&previous.state===tracking.state&&previous.source===tracking.source&&previous.reason===tracking.reason&&previous.message===tracking.message)return; toHtml('tracking',tracking); };
  const emitPose=(raw:PosePacket)=>{ send(raw); const now=Date.now(); if(now-lastUiAt.current<UI_INTERVAL_MS)return; lastUiAt.current=now; toHtml('pose',operatorPose(raw,configRef.current?.calibration.reference)); };
  const pressHold=(controlId:string,actionName:string)=>{ held.current.set(controlId,actionName); if(!sendAction(controlId,actionName,true))localStatus('Not connected; the hold was not sent'); };
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
  // Native events and app state are subscribed once; every handler reads refs, so nothing goes stale.
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
  useEffect(()=>{ const renew=setInterval(()=>{ for(const [controlId,actionName] of held.current)sendAction(controlId,actionName,true,{renew:true}); },HOLD_RENEW_MS);
    const repeat=setInterval(()=>{ const now=Date.now(); for(const [controlId,drag] of dragging.current)if(now-drag.at>=STREAM_RENEW_MS){ drag.at=now; sendAction(controlId,drag.action,drag.value,{live:true,renew:true}); } },STREAM_RENEW_MS/2);
    const appState=AppState.addEventListener('change',next=>{ if(next!=='active')releaseAll(); }); return()=>{ clearInterval(renew); clearInterval(repeat); appState.remove(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  /** Leaves the gateway and returns to the connect page, with a reason unless the operator chose to leave. */
  const disconnect=(reason?:string)=>{ clearTimeout(connectTimer.current); releaseAll(); const previous=socket.current; socket.current=undefined; previous?.close(); stopTracking(); configRef.current=undefined; latest.current.clear(); setHtmlConfig(undefined); setHtmlLoaded(false); setError(reason); setScreen('connect'); };
  const connect=(input=address)=>{ const url=gatewayUrl(input); if(!url){ setError('That doesn’t look like an address. Type the IP the gateway printed, like 192.168.1.20.'); return; }
    disconnect(); const label=gatewayLabel(url); gatewayRef.current=label; setGateway(label); setAddress(label); setError(undefined); setScreen('connecting'); startPoseSession();
    let ws:WebSocket; try { ws=new WebSocket(url); } catch { setScreen('connect'); setError('That address can’t be opened.'); return; }
    socket.current=ws; let opened=false;
    const unreachable=`Couldn’t reach ${label}. Check the gateway is running and this phone is on the same network, and allowed Local Network access in Settings.`;
    connectTimer.current=setTimeout(()=>{ if(socket.current===ws&&!opened)disconnect(unreachable); },CONNECT_TIMEOUT_MS);
    ws.onopen=()=>{ if(socket.current!==ws)return; opened=true; clearTimeout(connectTimer.current); send({type:'hello',version:PROTOCOL_VERSION,role:'phone',deviceId:settings.deviceId}); setScreen('live'); toHtml('connection',{state:'connected',gateway:label} satisfies ConnectionEvent);
      setRecent(old=>{ const next=[label,...old.filter(item=>item!==label)].slice(0,MAX_RECENT); settings.recent=next; saveSettings(settings); return next; }); void startTracking(); };
    ws.onmessage=e=>{ if(socket.current!==ws)return; let m:unknown; try{ m=JSON.parse(String(e.data)); }catch{ return; } const type=m&&typeof m==='object'?(m as {type?:unknown}).type:undefined;
      // After the hello the gateway only sends this phone its own config. A hello slower than the gateway's 250 ms
      // console grace first gets console traffic (the gateway view and other phones' configs), so the latest config
      // that names a phone wins instead of the first, and a config without a phone never replaces one that has it.
      if(type==='config'){ const next=sanitizeConfig(m); if(!next||(configRef.current?.phone&&!next.phone))return; configRef.current=next; toHtml('config',next); }
      else if(type==='html_config'){ if(validateHtmlConfig(m)){ releaseAll(); setHtmlConfig(m); setHtmlLoaded(false); setHtmlKey(key=>key+1); } }
      else if(type==='status'){ if(validateStatus(m)&&(!m.phoneId||m.phoneId===configRef.current?.phone?.id))toHtml('status',m); }
      else if(type==='camera_frame'){ const config=configRef.current; if(validateCameraFrame(m)&&config&&selectedCameraView(config)?.streams.includes(m.cameraId))toHtml('camera_frame',m); } };
    ws.onclose=()=>{ if(socket.current!==ws)return; disconnect(opened?`Lost the connection to ${label}.`:unreachable); };
    ws.onerror=()=>{ /* onclose follows with the reason. */ }; };
  // Bridge messages only count from the document the gateway sent. The page cannot navigate away: top-frame
  // http(s) links open in Safari and everything else is refused; frames inside the page may load.
  const onHtmlMessage=(event:WebViewMessageEvent)=>{ const url=event.nativeEvent.url??''; if(url&&!url.startsWith('about:'))return; try { const message=JSON.parse(event.nativeEvent.data);
    if(isHtmlBridgeDisconnect(message)){ disconnect(); return; }
    if(!validateHtmlBridgeAction(message))return;
    // A live sample of a value being dragged; the final sample (no `live`) closes the drag. A dropped sample is not worth a notice.
    if(message.live){ dragging.current.set(message.controlId,{action:message.action,value:message.value,at:Date.now()}); sendAction(message.controlId,message.action,message.value,{live:true}); return; }
    dragging.current.delete(message.controlId);
    if(message.value===false&&held.current.has(message.controlId)){ releaseHold(message.controlId); return; }
    const control=configRef.current?.controls.find(c=>c.id===message.controlId&&c.action===message.action);
    if(control?.type==='button'&&control.hold&&typeof message.value==='boolean'){ if(message.value)pressHold(control.id,control.action); else releaseHold(control.id); return; }
    if(!sendAction(message.controlId,message.action,message.value))localStatus('Not connected; action not sent'); } catch { /* Ignore messages outside the documented bridge. */ } };
  const replayToHtml=()=>{ setHtmlLoaded(true); for(const [type,payload] of latest.current)inject(type,payload); };

  if(screen==='live'&&htmlConfig)return <View style={styles.live}><StatusBar style="dark"/>
    <WebView key={htmlKey} ref={htmlRef} originWhitelist={['*']} source={{html:htmlConfig.html,baseUrl:'about:blank'}} injectedJavaScriptBeforeContentLoaded={bridgeScript} injectedJavaScript={bridgeScript} onMessage={onHtmlMessage}
      onShouldStartLoadWithRequest={request=>{ if(request.url.startsWith('about:')||!request.isTopFrame)return true; if(/^https?:/i.test(request.url))Linking.openURL(request.url).catch(()=>{}); return false; }}
      onLoadStart={releaseAll} onLoad={replayToHtml} onContentProcessDidTerminate={()=>{ releaseAll(); setHtmlLoaded(false); setHtmlKey(key=>key+1); }}
      javaScriptEnabled domStorageEnabled bounces={false} contentInsetAdjustmentBehavior="never" automaticallyAdjustContentInsets={false} dataDetectorTypes="none" allowsLinkPreview={false} style={styles.webview}/>
    {!htmlLoaded&&<View style={styles.loading} pointerEvents="none"><ActivityIndicator color={INK2}/></View>}
  </View>;
  if(screen!=='connect')return <SafeAreaView style={styles.page}><StatusBar style="dark"/><Paper/><View style={styles.waiting}>
    <ActivityIndicator color={BLUE}/><Text style={styles.waitingText}>{screen==='connecting'?`Connecting to ${gateway}…`:`Loading ${gateway}’s screen…`}</Text>
    <Pressable style={styles.secondary} onPress={()=>disconnect()}><Text style={styles.secondaryText}>Cancel</Text></Pressable></View></SafeAreaView>;
  return <SafeAreaView style={styles.page}><StatusBar style="dark"/><Paper/>
    <KeyboardAvoidingView behavior="padding" style={styles.flex}><ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.markRow}><Mark/><Text style={styles.markText}>Marionette</Text></View>
      <Text style={styles.title}>Connect to your robot’s gateway</Text>
      <Text style={styles.body}>Use the address the gateway prints when it starts. Same Wi-Fi or Tailscale.</Text>
      <TextInput value={address} onChangeText={text=>{ setAddress(text); setError(undefined); }} onSubmitEditing={event=>connect(event.nativeEvent.text)} placeholder="192.168.1.20" placeholderTextColor="#9aa1a6" autoCapitalize="none" autoCorrect={false} keyboardType="url" returnKeyType="go" textContentType="URL" style={styles.input} accessibilityLabel="Gateway address"/>
      <Text style={styles.note}>port 8787 unless you type one</Text>
      {error&&<Text style={styles.error} accessibilityRole="alert">{error}</Text>}
      <Pressable style={({pressed})=>[styles.button,pressed&&styles.pressed]} onPress={()=>connect()} accessibilityRole="button"><Text style={styles.buttonText}>Connect</Text></Pressable>
      {recent.length>0&&<View style={styles.recent}><Text style={styles.recentTitle}>Recent</Text>{recent.map(item=><Pressable key={item} style={({pressed})=>[styles.recentRow,pressed&&styles.pressed]} onPress={()=>connect(item)} accessibilityRole="button" accessibilityLabel={`Connect to ${item}`}><Text style={styles.recentText}>{item}</Text><Text style={styles.recentGo}>Connect</Text></Pressable>)}</View>}
    </ScrollView></KeyboardAvoidingView></SafeAreaView>;
}

const PAPER='#fafaf6', GRID='#e6ebf2', INK='#2e3033', INK2='#6b6f73', RULE='#cfd3d6', BLUE='#2f53b5', RED='#cf3f35';
/** The faint 24 pt graph-paper grid behind native pages, matching the gateway's screen. */
function Paper(){ const {width,height}=useWindowDimensions(); return <View style={StyleSheet.absoluteFill} pointerEvents="none">{Array.from({length:Math.ceil(height/24)},(_,i)=><View key={`h${i}`} style={[styles.gridH,{top:i*24}]}/>)}{Array.from({length:Math.ceil(width/24)},(_,i)=><View key={`v${i}`} style={[styles.gridV,{left:i*24}]}/>)}</View>; }
/** The Marionette mark, as on the app icon (assets/icon.svg): a control bar whose strings end in beads, the middle one holding a blue ring. */
function Mark(){ return <View style={styles.mark}><View style={[styles.markString,{left:3.2,height:13.8}]}/><View style={[styles.markString,{left:12.4,height:8}]}/><View style={[styles.markString,{left:21.5,height:16}]}/><View style={[styles.markBead,{left:2.6,top:19.8}]}/><View style={[styles.markBead,{left:20.8,top:22.1}]}/><View style={styles.markHandle}/><View style={styles.markBar}/><View style={styles.markRing}/></View>; }

const styles=StyleSheet.create({
  flex:{flex:1}, live:{flex:1,backgroundColor:PAPER}, webview:{flex:1,backgroundColor:PAPER}, loading:{position:'absolute',top:0,left:0,right:0,bottom:0,alignItems:'center',justifyContent:'center',backgroundColor:PAPER},
  page:{flex:1,backgroundColor:PAPER}, content:{paddingHorizontal:22,paddingBottom:40},
  gridH:{position:'absolute',left:0,right:0,height:StyleSheet.hairlineWidth,backgroundColor:GRID}, gridV:{position:'absolute',top:0,bottom:0,width:StyleSheet.hairlineWidth,backgroundColor:GRID},
  markRow:{flexDirection:'row',alignItems:'center',gap:10,marginTop:40}, markText:{color:INK,fontSize:18,fontWeight:'600'},
  mark:{width:26,height:26}, markBar:{position:'absolute',left:2.5,right:2.5,top:5.8,height:2.9,borderRadius:1.45,backgroundColor:INK}, markHandle:{position:'absolute',left:11.9,top:1.6,width:2.2,height:5.6,borderRadius:1.1,backgroundColor:INK},
  markString:{position:'absolute',top:7.2,width:1.2,borderRadius:0.6,backgroundColor:INK}, markBead:{position:'absolute',width:2.4,height:2.4,borderRadius:1.2,backgroundColor:INK}, markRing:{position:'absolute',left:8.7,top:14.4,width:8.6,height:8.6,borderRadius:4.3,borderWidth:1.8,borderColor:BLUE},
  title:{color:INK,fontSize:30,lineHeight:35,fontWeight:'600',letterSpacing:-0.3,marginTop:56,marginBottom:10,maxWidth:320},
  body:{color:INK2,fontSize:16,lineHeight:23,marginBottom:28,maxWidth:300},
  input:{backgroundColor:'#fff',borderColor:INK,borderWidth:1.5,borderRadius:12,paddingHorizontal:16,paddingVertical:15,fontFamily:'Menlo',fontSize:20,color:INK},
  note:{fontFamily:'Noteworthy',color:BLUE,fontSize:17,marginTop:8,marginLeft:4,transform:[{rotate:'-1deg'}]},
  error:{color:RED,fontSize:16,lineHeight:22,marginTop:14},
  button:{height:56,borderRadius:12,backgroundColor:BLUE,alignItems:'center',justifyContent:'center',marginTop:22}, buttonText:{color:'#fff',fontSize:17,fontWeight:'600'}, pressed:{opacity:0.75},
  recent:{marginTop:34}, recentTitle:{color:INK2,fontSize:14,marginBottom:4}, recentRow:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',minHeight:48,borderTopWidth:1,borderTopColor:RULE}, recentText:{fontFamily:'Menlo',fontSize:15,color:INK}, recentGo:{color:BLUE,fontSize:15},
  waiting:{flex:1,alignItems:'center',justifyContent:'center',gap:16,paddingHorizontal:30}, waitingText:{color:INK,fontSize:17,textAlign:'center'},
  secondary:{minHeight:44,paddingHorizontal:20,borderRadius:10,borderWidth:1.5,borderColor:INK,backgroundColor:'#fff',alignItems:'center',justifyContent:'center'}, secondaryText:{color:INK,fontSize:16,fontWeight:'500'},
});
