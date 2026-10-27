import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createServer, type GatewayOptions } from './server.js';
import { PROTOCOL_VERSION, matrixToQuaternion, type ActionMessage, type ControlValue, type PosePacket } from '@marionette/protocol';

/** Real gateways on ephemeral ports, real sockets. Tests never touch the real `~/.marionette`. */
export const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'marionette-home-'));
process.env.MARIONETTE_HOME = testHome;
process.once('exit', () => fs.rmSync(testHome, { recursive: true, force: true }));

export let gateway: ReturnType<typeof createServer> | undefined; export let port: number;
export async function stopGateway() { if (gateway) await gateway.close(); gateway = undefined; }
export async function waitFor(predicate: () => boolean, timeoutMs = 1000) { const started = Date.now(); while (!predicate()) { if (Date.now() - started >= timeoutMs) throw new Error('Timed out waiting for gateway messages'); await new Promise(resolve => setTimeout(resolve, 10)); } }
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function waitUntil(check: () => Promise<boolean>, timeoutMs = 1500) { const started = Date.now(); while (!(await check())) { if (Date.now() - started >= timeoutMs) throw new Error('Timed out waiting for the gateway'); await sleep(20); } }
/** Pairing and Bonjour are off unless a test turns them on. */
export async function start(options: GatewayOptions = {}) { const created=createServer(0, { auth:'off', mdns:false, home:testHome, ...options }); gateway=created; await new Promise<void>(r=>created.server.listen(0,r)); port=(created.server.address() as any).port; return created; }
export type Client = { ws: WebSocket; messages: any[]; id?: string; session: string; statuses: (controlId?: string) => any[]; of: (type: string, phoneId?: string) => any[]; configOf: (phoneId?: string) => any; closed: Promise<{ code: number; reason: string }> };
export async function open(headers: Record<string, string> = {}, query = '', host = '127.0.0.1'): Promise<Client> {
  const ws=new WebSocket(`ws://${host}:${port}/ws${query}`, { headers }); const messages:any[]=[]; ws.on('message',d=>messages.push(JSON.parse(d.toString())));
  const closed=new Promise<{ code: number; reason: string }>(resolve=>ws.once('close',(code,reason)=>resolve({ code, reason: reason.toString() })));
  await new Promise((resolve, reject)=>{ ws.once('open',resolve); ws.once('error',reject); }); ws.on('error',()=>{ /* a terminated socket may report ECONNRESET before close */ });
  const of = (type: string, phoneId?: string) => messages.filter(m=>m.type===type&&(phoneId===undefined||m.phoneId===phoneId));
  return { ws, messages, session: '', of, closed, statuses: controlId => of('status').filter(m=>!controlId||m.controlId===controlId), configOf: phoneId => messages.filter(m=>m.type==='config'&&(phoneId ? m.phone?.id===phoneId : !m.phone)).at(-1) };
}
export const hello = (client: Client, fields: object) => client.ws.send(JSON.stringify({ type:'hello', version:PROTOCOL_VERSION, ...fields }));
/** A console (viewer or consumer): says hello and gets the gateway view plus every phone's. */
export async function connect(headers: Record<string, string> = {}) { const client=await open(headers); hello(client,{ role:'console' }); await waitFor(()=>!!client.configOf()); return client; }
/** A phone: says hello with its device id (and anything in `extra`), learns its phone id, and streams one pose. */
export async function phone(deviceId = 'a', session = `iphone-${deviceId}`, extra: object = {}) { const client=await open(); client.session=session; hello(client,{ role:'phone', deviceId, ...extra }); await waitFor(()=>client.messages.some(m=>m.type==='config'&&m.phone)); client.id=client.messages.find(m=>m.type==='config'&&m.phone).phone.id; sendPose(client,pose(session,0)); await sleep(15); return client; }
/** A desktop /screen mirror following one phone ('' for the first connected one). */
export async function mirrorOf(follow: string) { const mirror=await open(); hello(mirror,{ role:'console', follow }); await waitFor(()=>mirror.messages.some(m=>m.type==='config')); return mirror; }
/** A robot: a console that also talks back. */
export async function robot(robotId = 'axol', extra: object = {}) { const client=await open(); hello(client,{ role:'robot', robotId, ...extra }); await waitFor(()=>!!client.configOf()); return client; }
/** Answers the gateway's pings like the app, with a clock `offsetMs` ahead of this one. */
export const answerPings = (client: Client, offsetMs = 0) => client.ws.on('message', d => { const m=JSON.parse(d.toString()); if (m.type==='ping') client.ws.send(JSON.stringify({ type:'pong', version:PROTOCOL_VERSION, id:m.id, sentAt:m.sentAt, at:Date.now()+offsetMs })); });
export const getState = async () => await fetch(`http://127.0.0.1:${port}/api/state`).then(r=>r.json()) as any;
export const phoneState = async (id: string) => (await getState()).phones.find((p: any)=>p.id===id);
export const value = (config: any, id: string) => config?.controls.find((c: any)=>c.id===id)?.value;
export const held = (config: any, id: string) => config?.controls.find((c: any)=>c.id===id)?.held;
export const live = (config: any, id: string) => config?.controls.find((c: any)=>c.id===id)?.live;
// A flat phone, screen up, top edge toward ARKit -Z (camera +X = bottom edge, +Y = right edge, +Z = screen).
export const FLAT = matrixToQuaternion([0,0,1,0, 1,0,0,0, 0,1,0,0, 0,0,0,1]);
export const NOMINAL = [.0025,.0025,.0025,.01,.01,.01];
export const pose = (sessionId: string, seq: number, overrides: Partial<PosePacket> = {}): PosePacket => ({ type:'pose', version:1, sessionId, seq, monotonicTs:seq+1, position:{x:0,y:0,z:0}, rotation:FLAT, covariance:NOMINAL, source:'arkit', trackingState:'normal', calibrationVersion:'arkit-v1', heartbeat:true, ...overrides });
export const sendPose = (client: Client, p: PosePacket) => client.ws.send(JSON.stringify(p));
export const act = (client: Client, controlId: string, action: string, value?: string | number | boolean, renew?: true, sentAt = Date.now()) => client.ws.send(JSON.stringify({type:'action',version:PROTOCOL_VERSION,sessionId:client.session||'console',controlId,action,value,renew,sentAt} satisfies ActionMessage));
/** One sample of a value being dragged; `final` is the value when the operator lets go. */
export const drag = (client: Client, controlId: string, action: string, value: ControlValue, how: { renew?: true; final?: true } = {}) => client.ws.send(JSON.stringify({type:'action',version:PROTOCOL_VERSION,sessionId:client.session||'console',controlId,action,value,renew:how.renew,live:how.final?undefined:true,sentAt:Date.now()} satisfies ActionMessage));
export const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'marionette-'));
