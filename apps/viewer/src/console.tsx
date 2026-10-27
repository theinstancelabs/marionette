import { memo, type CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { gatewayLabel, selectedCameraView, type CameraStream, type CameraView, type ConfigMessage, type RobotInfo } from '@marionette/protocol';
import type { ConsoleEvent, EventKind, PhoneState } from './events';
import type { Gateway } from './gateway';
import { Inspector, type Focus, type Section } from './inspector';
import { PairDialog } from './pair';
import { armOf, phoneDetail, stationName, stationOffsets, type Layout, type Phone } from './phones';
import { PAD, PlotGroup, PlotStrip, SERIES, TIME_TICKS, type SeriesId } from './plot';
import type { RtcViewer, VideoState } from './rtc';
import { SpatialView, type GatewayLayer, type SpatialPhone, type View } from './spatial';
import type { CameraFrame, ViewerStore } from './store';
import { Mark, PhoneDot, RobotDot, clock } from './ui';

type PhoneRowId = 'pose' | 'trail' | 'axes' | 'position';
type GatewayRowId = GatewayLayer | 'camera' | 'events';
type Toggle = PhoneRowId | GatewayLayer | 'camera' | SeriesId;
/** Hidden streams: per phone (keyed by phone id) and gateway-wide. */
type Hidden = { phones: Record<string, Toggle[]>; gateway: Toggle[] };
type Row = { id: PhoneRowId | GatewayRowId; label: string; swatch: string; line?: boolean; toggle: boolean; section?: Section };
/** The highlighted tree row: a phone's or the gateway's (`id` a row id), or a robot's (`id` is `state` or `stream:<id>`). */
type Selection = { phoneId?: string; robotId?: string; id: string };

const VISIBILITY_KEY = 'marionette.viewer.visibility';
const LAYOUT_KEY = 'marionette.viewer.layout';
const CAMERA_VIEW_KEY = 'marionette.viewer.cameraView';
const PHONE_TOGGLES: Toggle[] = ['pose', 'trail', 'axes', 'position'];
const GATEWAY_TOGGLES: Toggle[] = ['frame', 'grid', 'calibration', 'camera', 'forward', 'left', 'up'];
const KIND_COLOR: Record<EventKind, string> = { session: '#6b6f73', tracking: '#9aa0a6', calibration: '#2f53b5', validation: '#3f7d4e', input: '#c8a43a', safety: '#cf3f35', camera: '#7d8c95', settings: '#b4b9be', robot: '#2e3033' };
const AXIS_SWATCH = 'linear-gradient(90deg, #cf3f35 0 33%, #3f7d4e 33% 66%, #2f53b5 66%)';
const NO_PRESENCE: PhoneState = { present: false };

const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* private mode */ } };
function loadHidden(): Hidden {
  try {
    const value = JSON.parse(read(VISIBILITY_KEY) ?? '{}') as Partial<Hidden>;
    const phones: Hidden['phones'] = {};
    if (value.phones && typeof value.phones === 'object') for (const [id, list] of Object.entries(value.phones)) if (Array.isArray(list)) phones[id] = list.filter(item => PHONE_TOGGLES.includes(item));
    return { phones, gateway: Array.isArray(value.gateway) ? value.gateway.filter(item => GATEWAY_TOGGLES.includes(item)) : [] };
  } catch { return { phones: {}, gateway: [] }; }
}
const isShown = (hidden: Hidden, phoneId: string | undefined, id: Toggle) => !(phoneId ? hidden.phones[phoneId] ?? [] : hidden.gateway).includes(id);

const phoneRows = (phone: Phone): Row[] => [
  { id: 'pose', label: 'pose', swatch: phone.color, toggle: true, section: 'pose' },
  { id: 'trail', label: 'trail', swatch: phone.color, line: true, toggle: true, section: 'pose' },
  { id: 'axes', label: 'body axes', swatch: 'var(--ink2)', toggle: true, section: 'pose' },
  { id: 'position', label: 'position', swatch: AXIS_SWATCH, line: true, toggle: true, section: 'pose' },
];
const GATEWAY_ROWS: Row[] = [
  { id: 'frame', label: 'frame axes', swatch: 'var(--ink)', toggle: true },
  { id: 'grid', label: 'grid', swatch: 'var(--grid-strong)', toggle: true },
  { id: 'calibration', label: 'calibration aids', swatch: 'var(--rule)', toggle: true, section: 'calibration' },
  { id: 'camera', label: 'camera', swatch: '#7d8c95', toggle: true },
  { id: 'events', label: 'events', swatch: 'var(--rule)', toggle: false },
];

function PhonePill({ phone, presence, onSelect }: { phone: Phone; presence: PhoneState; onSelect: (id: string) => void }) {
  const d = phoneDetail(phone, presence); const detail = [d.arm, d.state].filter(Boolean).join(', ');
  return <button type="button" className={`pill phone-pill ${phone.connected ? '' : 'off'} ${d.warn ? 'warn' : ''} ${d.stop ? 'stop-on' : ''}`}
    onClick={() => onSelect(phone.id)} title={`Inspect ${phone.name}`}>
    <PhoneDot color={phone.color} muted={!phone.connected} /><span className="pill-name">{phone.name}</span>
    {detail && <span className="sub">{detail}</span>}
    {d.stop && <span className="stop-flag">Stop on</span>}
  </button>;
}

function TopBar({ gw, presence, onSelect, onPair }: { gw: Gateway; presence: (id: string) => PhoneState; onSelect: (id: string) => void; onPair: () => void }) {
  const sim = gw.phase === 'sim'; const { phones } = gw;
  return <header className="topbar">
    <div className="brand"><Mark size={22} />Marionette</div>
    {sim ? <span className="pill sim">Simulated phones, not connected to a gateway</span> : <span className="addr mono" title={gw.config.serverName || gw.url}>{gw.url ? gatewayLabel(gw.url) : ''}</span>}
    <div className="phone-pills" role="group" aria-label="Phones" style={{ '--pills': Math.max(1, phones.length) } as CSSProperties}>
      {phones.length ? phones.map(phone => <PhonePill key={phone.id} phone={phone} presence={presence(phone.id)} onSelect={onSelect} />)
        : <span className="pill"><i className="dot" />No phones connected</span>}
    </div>
    {!sim && <button type="button" className="btn" onClick={onPair} title="The QR code, pairing code and addresses a phone needs">Pair a phone</button>}
    <button type="button" className="btn ghost" onClick={gw.disconnect}>{sim ? 'Exit simulation' : 'Disconnect'}</button>
  </header>;
}


const Streams = memo(function Streams({ phones, robots, hidden, selected, eventCount, onToggle, onSelect, onSelectRobot }: { phones: Phone[]; robots: RobotInfo[]; hidden: Hidden; selected?: Selection; eventCount: number; onToggle: (phoneId: string | undefined, id: Toggle) => void; onSelect: (row: Row, phoneId?: string) => void; onSelectRobot: (robotId: string, row: string) => void }) {
  const row = (item: Row, phoneId?: string, name?: string) => {
    const shown = !item.toggle || isShown(hidden, phoneId, item.id as Toggle); const on = selected?.id === item.id && selected.phoneId === phoneId && !selected.robotId;
    const label = name ? `${name} ${item.label}` : item.label;
    return <div key={item.id} className={`tree-row ${on ? 'sel' : ''} ${shown ? '' : 'off'}`}>
      <button type="button" className="tree-name" aria-current={on ? 'true' : undefined} onClick={() => onSelect(item, phoneId)}>
        <span className={item.line ? 'sw line' : 'sw'} style={{ background: item.swatch }} /><span className="name">{item.label}</span>
      </button>
      {item.toggle
        ? <button type="button" className="eye" aria-pressed={shown} aria-label={`${shown ? 'Hide' : 'Show'} ${label}`} onClick={() => onToggle(phoneId, item.id as Toggle)}>{shown ? 'shown' : 'hidden'}</button>
        : <span className="eye value">{eventCount}</span>}
    </div>;
  };
  return <nav className="streams" aria-label="Streams">
    <h4>Streams</h4>
    {!phones.length && <p className="empty tree-empty">No phones yet.</p>}
    {phones.map(phone => {
      const arm = armOf(phone.config)?.label;
      return <div key={phone.id} className={`tree-group ${phone.connected ? '' : 'gone'}`} role="group" aria-label={phone.name}>
        <div className="tree-head phone"><PhoneDot color={phone.color} muted={!phone.connected} /><span className="who">{phone.name}</span><span className="sub">{phone.connected ? arm ?? '' : 'disconnected'}</span></div>
        {phoneRows(phone).map(item => row(item, phone.id, phone.name))}
      </div>;
    })}
    {robots.map(robot => {
      const robotRow = (id: string, label: string, swatch: string, value?: string) => {
        const on = selected?.robotId === robot.id && selected.id === id;
        return <div key={id} className={`tree-row ${on ? 'sel' : ''}`}>
          <button type="button" className="tree-name" aria-current={on ? 'true' : undefined} onClick={() => onSelectRobot(robot.id, id)}>
            <span className="sw" style={{ background: swatch }} /><span className="name">{label}</span>
          </button>
          {value && <span className="eye value">{value}</span>}
        </div>;
      };
      // What the robot provides: its state, the phones' screen when it is its own, and the streams it serves over WebRTC.
      return <div key={robot.id} className={`tree-group ${robot.connected ? '' : 'gone'}`} role="group" aria-label={`${robot.name}, robot${robot.connected ? '' : ', offline'}`}>
        <div className="tree-head phone" title={`${robot.name}, robot ${robot.id}`}><RobotDot muted={!robot.connected} /><span className="who">{robot.name}</span><span className="sub">{robot.connected ? '' : 'offline'}</span></div>
        {robotRow('state', 'state', 'var(--ink)')}
        {robot.screen && robotRow('screen', 'screen', 'var(--ink2)', 'on phones')}
        {(robot.streams ?? []).map(stream => robotRow(`stream:${stream}`, stream, '#7d8c95', 'WebRTC'))}
      </div>;
    })}
    <div className="tree-group" role="group" aria-label="gateway">
      <div className="tree-head">gateway</div>
      {GATEWAY_ROWS.map(item => row(item))}
    </div>
  </nav>;
});

const VIEWS: [View, string][] = [['chase', '3D'], ['top', 'Top'], ['side', 'Side']];
const LAYOUTS: [Layout, string][] = [['side', 'Side by side'], ['overlay', 'Overlay']];
function SpatialPanel({ store, phones, hidden, layout, onLayout }: { store: ViewerStore; phones: Phone[]; hidden: Hidden; layout: Layout; onLayout: (layout: Layout) => void }) {
  const host = useRef<HTMLDivElement>(null); const scene = useRef<SpatialView>();
  const [view, setView] = useState<View>('chase');
  // A disconnected phone is not drawn; every connected one is, from its own station.
  const connected = phones.filter(phone => phone.connected);
  const offsets = stationOffsets(connected.map(phone => ({ id: phone.id, arm: armOf(phone.config)?.value })), layout);
  const drawn = useRef<SpatialPhone[]>([]);
  drawn.current = connected.map(phone => ({ id: phone.id, color: phone.color, label: stationName(phone), offset: offsets.get(phone.id) ?? 0, config: phone.config,
    shown: { pose: isShown(hidden, phone.id, 'pose'), trail: isShown(hidden, phone.id, 'trail'), axes: isShown(hidden, phone.id, 'axes') } }));
  const hiddenRef = useRef(hidden); hiddenRef.current = hidden;
  useEffect(() => {
    scene.current = new SpatialView(host.current!, { phones: () => drawn.current, live: id => store.live.phones.get(id), shown: layer => isShown(hiddenRef.current, undefined, layer) });
    return () => { scene.current?.dispose(); scene.current = undefined; };
  }, [store]);
  const choose = (next: View) => { setView(next); scene.current?.setView(next); };
  const hint = view === 'top' ? 'forward is up the screen' : view === 'side' ? 'forward is to the right, up is up' : 'drag to orbit, right-drag to pan, scroll to zoom';
  const where = layout === 'overlay' ? 'every phone from the same origin' : 'each phone from its own origin, left arm on the left';
  return <section className="space" aria-label="Spatial view">
    <div ref={host} className="space-canvas" />
    <div className="tabs">
      <div role="group" aria-label="Camera view">
        {VIEWS.map(([id, label]) => <button key={id} type="button" aria-pressed={view === id} className={view === id ? 'on' : ''} onClick={() => choose(id)} title={view === id ? 'Re-center this view' : undefined}>{label}</button>)}
      </div>
      <div role="group" aria-label="Phone origins">
        {LAYOUTS.map(([id, label]) => <button key={id} type="button" aria-pressed={layout === id} className={layout === id ? 'on' : ''} onClick={() => onLayout(id)}>{label}</button>)}
      </div>
    </div>
    <div className="space-title">operator frame, 10 cm grid</div>
    {!connected.length && <div className="space-empty"><b>No phones connected</b><span>Phones appear here as they connect to the gateway.</span></div>}
    <div className="space-hint">{connected.length > 1 ? `${where}; ${hint}` : hint}</div>
  </section>;
}

function Strip({ group, phone, store }: { group: PlotGroup; phone: Phone; store: ViewerStore }) {
  const host = useRef<HTMLDivElement>(null); const tip = useRef<HTMLDivElement>(null);
  const name = useRef(''); name.current = phone.name;
  useEffect(() => {
    const strip = new PlotStrip(host.current!, tip.current!, () => store.live.phones.get(phone.id)?.history ?? [], () => name.current);
    group.add(strip); return () => { group.remove(strip); strip.dispose(); };
  }, [group, phone.id, store]);
  const arm = armOf(phone.config)?.label;
  return <div className="strip">
    <div className="who"><PhoneDot color={phone.color} /><div><span>{phone.name}</span>{arm && <small>{arm}</small>}</div></div>
    <div ref={host} className="strip-canvas" tabIndex={0} aria-label={`${stationName(phone)}: forward, left and up in millimetres over the last 20 seconds. Use the arrow keys to read values.`}>
      <div ref={tip} className="plot-tip" hidden />
    </div>
  </div>;
}

function PlotPanel({ store, phones, hidden, onToggle }: { store: ViewerStore; phones: Phone[]; hidden: Hidden; onToggle: (id: SeriesId) => void }) {
  const hiddenRef = useRef(hidden); hiddenRef.current = hidden;
  const [group] = useState(() => new PlotGroup(series => isShown(hiddenRef.current, undefined, series)));
  useEffect(() => () => group.dispose(), [group]);
  const strips = phones.filter(phone => phone.connected && isShown(hidden, phone.id, 'position'));
  const anyConnected = phones.some(phone => phone.connected);
  return <section className="plot" aria-label="Position over time">
    <header className="panel-head">
      <h4>Position over time</h4>
      <div className="legend" role="group" aria-label="Position series">
        {SERIES.map(series => { const on = isShown(hidden, undefined, series.id); return <button key={series.id} type="button" aria-pressed={on} className={on ? '' : 'off'} onClick={() => onToggle(series.id)} title={`${on ? 'Hide' : 'Show'} ${series.id} in every strip`}><i style={{ background: series.color }} />{series.id}</button>; })}
        <span className="muted">last 20 s, mm</span>
      </div>
    </header>
    <div className="strips" style={{ gridTemplateRows: `repeat(${Math.max(1, strips.length)}, minmax(44px, 1fr))` }}>
      {strips.map(phone => <Strip key={phone.id} group={group} phone={phone} store={store} />)}
      {!strips.length && <p className="empty">{anyConnected ? 'Every phone’s position strip is hidden.' : 'No phones connected.'}</p>}
    </div>
    {strips.length > 0 && <div className="time-axis" aria-hidden="true" style={{ paddingLeft: `calc(var(--who) + ${PAD.left}px)`, paddingRight: PAD.right }}>
      <div>{TIME_TICKS.map(tick => <span key={tick} className={tick === 20 ? 'first' : tick === 0 ? 'last' : undefined} style={{ left: `${(20 - tick) / 20 * 100}%` }}>{tick === 0 ? 'now' : tick === 20 ? '20 s ago' : `${tick} s`}</span>)}</div>
    </div>}
  </section>;
}

/** Camera views the gateway offers; without any, one view per stream. */
function cameraViews(config: ConfigMessage): CameraView[] {
  return config.cameraViews.length ? config.cameraViews : config.cameraStreams.map(stream => ({ id: stream.id, label: stream.label, streams: [stream.id] }));
}
const cameraLabel = (label: string) => label.replace(/\s*\(virtual\)$/i, '');

/**
 * One camera stream. A stream a robot publishes over WebRTC plays as video, asked for while the pane is on screen and
 * closed when it goes; until the video plays (or when it fails and is retried), the stream's JPEG frames show if
 * there are any. Other streams show their latest JPEG frame.
 */
function CameraPane({ id, stream, frame, rtc, now }: { id: string; stream?: CameraStream; frame?: CameraFrame; rtc: RtcViewer; now: number }) {
  const label = cameraLabel(stream?.label ?? id);
  const publisher = stream?.transport === 'webrtc' && rtc.supported ? stream.publisher : undefined;
  const [video, setVideo] = useState<VideoState>();
  const [playing, setPlaying] = useState(false);
  const element = useRef<HTMLVideoElement>(null);
  useEffect(() => { setVideo(undefined); if (publisher) return rtc.watch(id, publisher, setVideo); }, [rtc, id, publisher]);
  const media = video?.status === 'video' ? video.media : undefined;
  useEffect(() => {
    const el = element.current; setPlaying(false); if (!el) return;
    el.muted = true; el.srcObject = media ?? null;
    if (media) el.play().catch(() => { /* autoplay refused; `playing` never fires and the JPEG frame stays */ });
  }, [media]);
  const showVideo = !!media && playing;
  const age = frame ? (now - frame.at) / 1000 : undefined;
  const waiting = publisher ? (video?.status === 'failed' ? 'Video unavailable, retrying' : 'Connecting to the video…') : stream?.status === 'offline' ? 'Offline' : 'No frames yet';
  return <figure className="camera-frame" data-transport={publisher ? 'webrtc' : 'jpeg'}>
    {publisher && <video ref={element} className={showVideo ? undefined : 'waiting'} autoPlay playsInline muted onPlaying={() => setPlaying(true)} aria-label={`Live video from the ${label} camera`} />}
    {!showVideo && (frame ? <img src={frame.dataUrl} alt={`Latest frame from the ${label} camera`} /> : <p className="empty" title={video?.status === 'failed' ? video.why : undefined}>{waiting}</p>)}
    <figcaption>{label}</figcaption>
    {showVideo ? <span className="stale">WebRTC</span> : age !== undefined && age > 2 && <span className="stale">{Math.round(age)} s old</span>}
  </figure>;
}

function CameraPanel({ config, cameras, rtc, simulated, viewId, onView }: { config: ConfigMessage; cameras: Map<string, CameraFrame>; rtc: RtcViewer; simulated: boolean; viewId?: string; onView: (id: string) => void }) {
  const views = simulated ? [] : cameraViews(config);
  const view = views.find(candidate => candidate.id === viewId) ?? (config.cameraViews.length ? selectedCameraView(config) : undefined) ?? views[0];
  const now = Date.now();
  return <section className="camera" aria-label="Cameras">
    <header className="panel-head">
      <h4>Cameras</h4>
      {views.length > 1 && <div className="seg" role="group" aria-label="Camera view, this viewer only">
        {views.map(candidate => <button key={candidate.id} type="button" aria-pressed={candidate.id === view?.id} className={candidate.id === view?.id ? 'on' : ''} onClick={() => onView(candidate.id)}>{candidate.label}</button>)}
      </div>}
    </header>
    {!view ? <div className="camera-frame"><p className="empty">{simulated ? 'No camera in simulation' : 'This gateway has no camera streams'}</p></div>
      : <div className={`camera-grid n${Math.min(view.streams.length, 2)}`}>
          {view.streams.slice(0, 2).map(id => <CameraPane key={id} id={id} stream={config.cameraStreams.find(candidate => candidate.id === id)} frame={cameras.get(id)} rtc={rtc} now={now} />)}
        </div>}
    {views.length > 1 && <p className="camera-note">This view only. Each phone picks its own.</p>}
  </section>;
}

type Named = Map<string, { name: string; color: string }>;
const EventLog = memo(function EventLog({ events, phones, flash }: { events: ConsoleEvent[]; phones: Named; flash?: number }) {
  const box = useRef<HTMLDivElement>(null); const stick = useRef(true);
  useLayoutEffect(() => { const el = box.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [events]);
  useEffect(() => { if (flash === undefined) return; box.current?.querySelector(`[data-id="${flash}"]`)?.scrollIntoView({ block: 'nearest' }); }, [flash]);
  return <div ref={box} className="log" role="log" aria-label="Event log" onScroll={event => { const el = event.currentTarget; stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8; }}>
    {events.length === 0 && <p className="empty">Nothing yet. Phones connecting, tracking, calibration, Stop, and presses of holds show up here.</p>}
    {events.map(event => {
      const phone = event.phoneId ? phones.get(event.phoneId) : undefined;
      return <div key={event.id} data-id={event.id} className={`log-row ${event.tone} ${flash === event.id ? 'flash' : ''}`}>
        <time className="num" dateTime={new Date(event.at).toISOString()}>{clock(event.at)}</time>
        <span className="kind"><i style={{ background: KIND_COLOR[event.kind] }} />{event.kind}</span>
        <span className="who-tag">{event.phoneId && <><PhoneDot color={phone?.color ?? 'var(--ink2)'} /><span className="who-name">{phone?.name ?? event.phoneId}</span></>}</span>
        <span className="msg">{event.message}</span>
      </div>;
    })}
  </div>;
});

function TimePanel({ events, phones, startedAt, focusEvents }: { events: ConsoleEvent[]; phones: Named; startedAt: number; focusEvents: number }) {
  const [flash, setFlash] = useState<number>();
  const now = Date.now(); const span = Math.min(15 * 60_000, Math.max(60_000, now - startedAt)); const from = now - span;
  useEffect(() => { if (focusEvents) setFlash(events.at(-1)?.id); }, [focusEvents]);
  // The highlight marks where the log jumped to, then lets go.
  useEffect(() => { if (flash === undefined) return; const id = window.setTimeout(() => setFlash(undefined), 2500); return () => window.clearTimeout(id); }, [flash]);
  return <footer className="time">
    <div className="timeline" aria-hidden="true">
      <span className="from num">{clock(from)}</span>
      <div className="track">
        <div className="axis" />
        {events.filter(event => event.at >= from).map(event => {
          const who = event.phoneId ? `${phones.get(event.phoneId)?.name ?? event.phoneId}, ` : '';
          return <b key={event.id} className={event.tone === 'fail' ? 'fail' : undefined} style={{ left: `${(event.at - from) / span * 100}%`, background: KIND_COLOR[event.kind] }} title={`${clock(event.at)}, ${who}${event.kind}: ${event.message}`} onClick={() => setFlash(event.id)} />;
        })}
        <i className="now-mark" />
      </div>
      <span className="now">now</span>
    </div>
    <EventLog events={events} phones={phones} flash={flash} />
  </footer>;
}

export function Console({ gw }: { gw: Gateway }) {
  const { store, phones } = gw;
  const [hidden, setHidden] = useState(loadHidden);
  const [selected, setSelected] = useState<Selection>();
  const [section, setSection] = useState<Section | undefined>('pose');
  const [focus, setFocus] = useState<Focus>();
  const [pairing, setPairing] = useState(false);
  const [layout, setLayoutState] = useState<Layout>(() => read(LAYOUT_KEY) === 'overlay' ? 'overlay' : 'side');
  const [cameraView, setCameraViewState] = useState<string | undefined>(() => read(CAMERA_VIEW_KEY) ?? undefined);
  const [focusEvents, setFocusEvents] = useState(0);
  // The store learns names with the configs that change `phones`, so this stays current.
  const phoneMap = useMemo<Named>(() => new Map([...store.seen, ...phones.map(phone => [phone.id, phone] as const)]), [phones, store]);
  // Robots come with the gateway config (and, from an older roster, with their first state).
  const robots = useMemo(() => store.robots(), [gw.config.robots, store.live.robotStates.size, store]);
  const current = phones.find(phone => focus?.kind === 'phone' && phone.id === focus.id) ?? phones.find(phone => phone.connected) ?? phones[0];
  const robot = focus?.kind === 'robot' ? robots.find(candidate => candidate.id === focus.id) : undefined;
  // The inspector shows the chosen robot, else the chosen (or first connected) phone, else the first robot.
  const shown: Focus | undefined = robot ? focus : current ? { kind: 'phone', id: current.id } : robots[0] ? { kind: 'robot', id: robots[0].id } : undefined;

  const toggle = useCallback((owner: string | undefined, id: Toggle) => setHidden(old => {
    const list = owner ? old.phones[owner] ?? [] : old.gateway;
    const nextList = list.includes(id) ? list.filter(item => item !== id) : [...list, id];
    const next: Hidden = owner ? { ...old, phones: { ...old.phones, [owner]: nextList } } : { ...old, gateway: nextList };
    write(VISIBILITY_KEY, JSON.stringify(next));
    return next;
  }), []);
  const toggleSeries = useCallback((id: SeriesId) => toggle(undefined, id), [toggle]);
  const reveal = (target?: Section) => { if (target) requestAnimationFrame(() => document.getElementById(`inspector-${target}`)?.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })); };
  const selectRow = useCallback((row: Row, owner?: string) => {
    setSelected({ id: row.id, phoneId: owner }); setSection(row.section);
    // A phone's row, or a gateway row about the phones (calibration aids), brings a phone back into the inspector.
    if (owner) setFocus({ kind: 'phone', id: owner }); else if (row.section) setFocus(old => old?.kind === 'robot' ? undefined : old);
    reveal(row.section);
    if (row.id === 'events') setFocusEvents(n => n + 1);
  }, []);
  const selectPhone = useCallback((id: string) => { setFocus({ kind: 'phone', id }); setSelected({ id: 'pose', phoneId: id }); setSection('pose'); }, []);
  const selectRobot = useCallback((id: string, row = 'state') => { setFocus({ kind: 'robot', id }); setSelected({ robotId: id, id: row }); setSection(undefined); }, []);
  const selectTab = useCallback((next: Focus) => { if (next.kind === 'phone') selectPhone(next.id); else selectRobot(next.id); }, [selectPhone, selectRobot]);
  const setLayout = (next: Layout) => { setLayoutState(next); write(LAYOUT_KEY, next); };
  const setCameraView = (id: string) => { setCameraViewState(id); write(CAMERA_VIEW_KEY, id); };
  const presence = (id: string) => store.live.phones.get(id)?.presence ?? NO_PRESENCE;
  const treeSelection = useMemo<Selection | undefined>(() => selected ?? (shown?.kind === 'phone' ? { id: 'pose', phoneId: shown.id } : shown ? { id: 'state', robotId: shown.id } : undefined), [selected, shown?.kind, shown?.id]);
  const cameraShown = isShown(hidden, undefined, 'camera');

  return <div className={`console ${gw.phase === 'sim' ? 'simulated' : ''}`}>
    <TopBar gw={gw} presence={presence} onSelect={selectPhone} onPair={() => setPairing(true)} />
    <div className="workspace">
      <Streams phones={phones} robots={robots} hidden={hidden} selected={treeSelection} eventCount={gw.events.length} onToggle={toggle} onSelect={selectRow} onSelectRobot={selectRobot} />
      <main className="center">
        <SpatialPanel store={store} phones={phones} hidden={hidden} layout={layout} onLayout={setLayout} />
        <div className={`lower ${cameraShown ? '' : 'no-camera'}`}>
          <PlotPanel store={store} phones={phones} hidden={hidden} onToggle={toggleSeries} />
          {cameraShown && <CameraPanel config={gw.config} cameras={store.live.cameras} rtc={gw.rtc} simulated={gw.phase === 'sim'} viewId={cameraView} onView={setCameraView} />}
        </div>
      </main>
      <Inspector phones={phones} robots={robots} focus={shown} onSelect={selectTab} store={store} section={section} simulated={gw.phase === 'sim'} />
    </div>
    <TimePanel events={gw.events} phones={phoneMap} startedAt={store.live.startedAt} focusEvents={focusEvents} />
    {gw.phase === 'live' && <PairDialog open={pairing} onClose={() => setPairing(false)} url={gw.api('/api/pairing')} />}
  </div>;
}
