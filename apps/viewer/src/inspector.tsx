import React, { memo, useCallback, useState } from 'react';
import { CALIBRATION_STEPS, CALIBRATION_STEP_TEXT, CHECK_EXPECTED_AXIS, CHECK_MOVE_TEXT, MIN_CALIBRATION_STEP_M, describeCheckResult, dominantAxis, isLiveControl, isStickValue, metersToMillimeters, staleAfterMs, type ConfigMessage, type JsonValue, type RobotInfo, type StickValue, type UiControl, type Vector3 } from '@marionette/protocol';
import { inputText, knownStep, valueText } from './events';
import { AXIS_WORD, axisText, recentMotion, signed, stepProgressMm, tiltDegrees, trackingValue } from './motion';
import { stopOn, type Phone } from './phones';
import { branchSummary, freshness, inlineArray, isBranch, leafKind, leafText, openByDefault, stateKey, streamList, type RobotStateEntry } from './robots';
import type { PhoneLive, ViewerStore } from './store';
import { PhoneDot, RobotDot, ago, clock } from './ui';

export type Section = 'pose' | 'calibration' | 'controls' | 'inputs';
/** What the inspector shows: a phone, or a robot's state. */
export type Focus = { kind: 'phone' | 'robot'; id: string };
const AXES = [{ axis: 'x', name: 'forward' }, { axis: 'y', name: 'left' }, { axis: 'z', name: 'up' }] as const;
const STEP_NAME = { flat: 'Flat', forward: 'Forward', right: 'Right', up: 'Up' } as const;
const MIN_STEP_MM = MIN_CALIBRATION_STEP_M * 1000;
const SHOWN_INPUTS = 8;
const isCalibration = (control: UiControl) => control.action.startsWith('calibration.');

function Head({ title, note, selected }: { title: string; note?: React.ReactNode; selected: boolean }) {
  return <h4><span className={selected ? 'hl' : undefined}>{title}</span>{note && <small>{note}</small>}</h4>;
}

/** One tab per phone, then one per robot. */
function Tabs({ phones, robots, focus, onSelect }: { phones: Phone[]; robots: RobotInfo[]; focus: Focus; onSelect: (focus: Focus) => void }) {
  const all: Focus[] = [...phones.map(phone => ({ kind: 'phone' as const, id: phone.id })), ...robots.map(robot => ({ kind: 'robot' as const, id: robot.id }))];
  const tabId = (f: Focus) => `${f.kind}:${f.id}`;
  const move = (event: React.KeyboardEvent, index: number) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0; if (!step) return;
    event.preventDefault(); const next = all[(index + step + all.length) % all.length];
    onSelect(next); (event.currentTarget.parentElement?.querySelector(`[data-tab="${CSS.escape(tabId(next))}"]`) as HTMLElement | null)?.focus();
  };
  const tab = (f: Focus, index: number, body: React.ReactNode, connected: boolean, title: string) => {
    const on = f.kind === focus.kind && f.id === focus.id;
    return <button key={tabId(f)} type="button" role="tab" data-tab={tabId(f)} aria-selected={on} aria-controls="inspector-panel" tabIndex={on ? 0 : -1} className={`${on ? 'on' : ''} ${connected ? '' : 'off'}`}
      title={title} onClick={() => onSelect(f)} onKeyDown={event => move(event, index)}>{body}</button>;
  };
  return <div className="ptabs" role="tablist" aria-label={robots.length ? 'Phones and robots' : 'Phones'}>
    {phones.map((phone, index) => {
      const stop = stopOn(phone.config);
      return tab(all[index], index, <><PhoneDot color={phone.color} muted={!phone.connected} /><span className="tab-name">{phone.name}</span>{stop && <i className="tab-stop" role="img" aria-label="Stop on" title="Stop on" />}</>,
        phone.connected, [phone.name, !phone.connected && 'disconnected', stop && 'Stop on'].filter(Boolean).join(', '));
    })}
    {robots.map((robot, index) => tab(all[phones.length + index], phones.length + index, <><RobotDot muted={!robot.connected} /><span className="tab-name">{robot.name}</span></>,
      robot.connected, [robot.name, robot.connected ? 'robot' : 'robot, offline'].join(', ')))}
  </div>;
}

/** The link latency readout: the median of the gateway's stamps over the last second. */
function latencyText(latency: { ms: number } | undefined): string {
  if (!latency) return '—';
  return latency.ms < 1 ? 'under 1 ms' : `${Math.round(latency.ms)} ms`;
}

function PoseSection({ phone, live, selected, latency }: { phone: Phone; live?: PhoneLive; selected: boolean; latency?: { ms: number; count: number } }) {
  const pose = live?.pose; const present = !!live?.presence.present && phone.connected;
  const mm = pose ? metersToMillimeters(pose.position) : undefined;
  const motion = live ? recentMotion(live.trail, performance.now()) : { state: 'unknown' as const };
  const tracking = !phone.connected ? 'Disconnected' : present && pose ? trackingValue(pose.trackingState, pose.source) : 'No pose';
  return <section id="inspector-pose" className={`section ${present ? '' : 'stale'}`}>
    <Head title="Pose" note="operator frame, mm" selected={selected} />
    <div className="big3">
      {AXES.map(({ axis, name }) => {
        const value = mm?.[axis] ?? 0; const fraction = Math.max(-1, Math.min(1, value / 200));
        return <div key={axis} className={`axis-${axis}`}>
          <small>{name}</small>
          <b className="num">{mm ? signed(value, 1) : '—'}</b>
          <span className="zero-bar" aria-hidden="true"><i style={{ left: `${50 + Math.min(0, fraction) * 50}%`, width: `${Math.abs(fraction) * 50}%` }} /></span>
        </div>;
      })}
    </div>
    <dl className="kv">
      <div><dt>Tracking</dt><dd className={present && pose?.trackingState !== 'normal' ? 'warn' : !present ? 'muted' : undefined}>{tracking}</dd></div>
      <div><dt>Moving</dt><dd>{present && motion.state === 'moving' ? <>{motion.words} <span className="muted num">{Math.round(motion.mm)} mm in 0.5 s</span></> : present && motion.state === 'still' ? 'still' : '—'}</dd></div>
      <div><dt>Latency</dt><dd className={latency && present ? undefined : 'muted'} title="Phone to gateway, the gateway's estimate from its clock pings: the median over the last second of poses and inputs">
        {present ? latencyText(latency) : '—'} {present && <span className="muted">{latency ? 'phone → gateway, last 1 s' : 'not stamped yet'}</span>}
      </dd></div>
      <div><dt>Session</dt><dd className="mono" title={pose?.sessionId}>{pose?.sessionId ?? '—'}</dd></div>
    </dl>
  </section>;
}

function MoveMeter({ mm }: { mm: number }) {
  const scale = Math.max(100, Math.ceil(mm / 50) * 50); const ready = mm >= MIN_STEP_MM;
  return <div className="meter">
    <div className="meter-top"><span>Moved</span><span><b className="num">{signed(mm).replace('+', '')}</b> mm</span></div>
    <div className="meter-bar" role="meter" aria-label="Moved for this step" aria-valuemin={0} aria-valuemax={scale} aria-valuenow={Math.round(Math.max(0, mm))}>
      <i className={ready ? 'ready' : ''} style={{ width: `${Math.max(0, Math.min(1, mm / scale)) * 100}%` }} />
      <s style={{ left: `${MIN_STEP_MM / scale * 100}%` }} />
    </div>
    <p className="hand-note">{ready ? 'enough to capture' : `${MIN_STEP_MM} mm is enough to capture`}</p>
  </div>;
}

function CheckMeters({ position, expected }: { position: Vector3; expected: ReturnType<typeof dominantAxis> }) {
  const mm = metersToMillimeters(position); const dominant = dominantAxis(position);
  const size = Math.hypot(mm.x, mm.y, mm.z); const scale = Math.max(150, Math.ceil(Math.max(Math.abs(mm.x), Math.abs(mm.y), Math.abs(mm.z)) / 50) * 50);
  return <div className="check-meters">
    {AXES.map(({ axis, name }) => {
      const isDominant = dominant.endsWith(axis.toUpperCase()); const fraction = Math.max(-1, Math.min(1, mm[axis] / scale));
      return <div key={axis} className={`check-row axis-${axis} ${isDominant ? 'dominant' : ''}`}>
        <span>{name} <small>{axis.toUpperCase()}</small></span>
        <span className="zero-bar" aria-hidden="true"><i style={{ left: `${50 + Math.min(0, fraction) * 50}%`, width: `${Math.abs(fraction) * 50}%` }} /></span>
        <b className="num">{signed(mm[axis])}</b>
      </div>;
    })}
    <p className={`check-verdict ${size < MIN_STEP_MM ? '' : dominant === expected ? 'pass' : 'fail'}`}>
      {size < MIN_STEP_MM ? `Not yet ${MIN_STEP_MM} mm from the flat spot` : `Moving mostly ${AXIS_WORD[dominant]} (${axisText(dominant)})${dominant === expected ? ', as expected' : `, expected ${axisText(expected)}`}`}
    </p>
  </div>;
}

/** Calibration runs from the phone; the viewer only follows along. */
function CalibrationSection({ config, live, selected, simulated }: { config?: ConfigMessage; live?: PhoneLive; selected: boolean; simulated: boolean }) {
  const c = config?.calibration ?? { status: 'uncalibrated' as const, epoch: 0 }; const pose = live?.pose;
  const capturing = c.status === 'capturing'; const step = knownStep(c.step) ?? 'flat';
  const validating = c.status === 'captured' && !!c.check?.step;
  const guidedDone = c.status === 'captured' && c.reference?.mode === 'guided';
  const current = capturing ? CALIBRATION_STEPS.indexOf(step) : guidedDone ? CALIBRATION_STEPS.length : -1;
  const results = c.check?.results ?? [];
  const failed = results.filter(result => !result.passed);
  // A refusal stays in view until the gateway's next reply. Accepted replies only restate the instruction
  // and the results shown here (the event log keeps them).
  const reply = live?.reply && live.reply.tone === 'fail' && Date.now() - live.reply.at < 30_000 ? live.reply : undefined;

  let body: React.ReactNode;
  if (capturing) {
    const progress = pose ? stepProgressMm(step, pose.position, c.anchor) : undefined;
    const tilt = pose ? tiltDegrees(pose.rotation) : undefined;
    body = <>
      <p className="instruction"><b>Step {current + 1} of 4.</b> {CALIBRATION_STEP_TEXT[step].instruction}</p>
      {step === 'flat'
        ? <dl className="kv"><div><dt>Tilt from flat</dt><dd className={tilt === undefined ? '' : tilt < 30 ? 'pass' : 'fail'}>{tilt === undefined ? '—' : `${Math.round(tilt)}°, ${tilt < 30 ? 'flat enough' : 'not flat enough'}`}</dd></div></dl>
        : progress !== undefined ? <MoveMeter mm={progress} /> : null}
    </>;
  } else if (validating && c.check?.step) {
    const move = c.check.step;
    body = <>
      <p className="instruction"><b>Check {results.length + 1} of 3.</b> {CHECK_MOVE_TEXT[move].instruction}</p>
      {pose && <CheckMeters position={pose.position} expected={CHECK_EXPECTED_AXIS[move]} />}
    </>;
  } else {
    const frame = c.status !== 'captured' ? 'Uncalibrated' : `${c.reference?.mode === 'quick' ? 'Quick origin' : 'Guided frame'}, epoch ${c.epoch}`;
    const validation = c.status !== 'captured' ? <dd className="muted">Not validated</dd>
      : c.check?.passed === true ? <dd className="pass">Validated: forward +X, right −Y, up +Z</dd>
      : c.check?.passed === false ? <dd className="fail">{failed.map(result => `${result.move} went ${axisText(result.dominant)}, expected ${axisText(result.expected)}`).join('; ')}</dd>
      : <dd className="muted">Not validated</dd>;
    body = <dl className="kv"><div><dt>Frame</dt><dd>{frame}</dd></div><div className="stack"><dt>Validation</dt>{validation}</div></dl>;
  }

  return <section id="inspector-calibration" className="section">
    <Head title="Calibration" note={simulated ? 'not simulated' : 'run from the phone'} selected={selected} />
    <ol className="steps" aria-label="Guided calibration steps">
      {CALIBRATION_STEPS.map((name, index) => <li key={name} className={index < current ? 'done' : index === current ? 'cur' : ''} aria-current={index === current ? 'step' : undefined}><span>{STEP_NAME[name]}</span></li>)}
    </ol>
    {body}
    {results.length > 0 && (validating || c.check?.passed === false) && <ul className="results">{results.map(result => <li key={result.move} className={result.passed ? 'pass' : 'fail'}>{describeCheckResult(result)}</li>)}</ul>}
    {reply && <p className={`reply ${reply.tone}`}>{reply.message}</p>}
  </section>;
}

/** Where a stick is pushed, seen from above: up the glyph is forward, left is left. */
function StickGlyph({ value, live }: { value: StickValue; live: boolean }) {
  return <svg className={`stick-glyph ${live ? 'live' : ''}`} viewBox="-12 -12 24 24" aria-hidden="true">
    <circle r="10.5" className="rim" /><path d="M0 -10.5V10.5M-10.5 0H10.5" className="cross" />
    {(value.x || value.y) ? <line x2={-value.y * 7.5} y2={-value.x * 7.5} className="vec" /> : null}
    <circle cx={-value.y * 7.5} cy={-value.x * 7.5} r="3" className="knob" />
  </svg>;
}

/** A control's current value for this phone, in words, and how to color it. While a slider or stick is dragged, its newest live sample. */
function controlState(control: UiControl, live: PhoneLive | undefined, now: number): { text: string; tone?: string } {
  if (isLiveControl(control)) {
    const dragged = control.live ? live?.dragging.get(control.id) : undefined;
    const current = { ...control, value: dragged ?? control.value } as UiControl;
    return { text: valueText(current) ?? '', tone: control.live ? 'live' : undefined };
  }
  if (control.type === 'button') {
    if (control.hold) return control.held ? { text: 'held', tone: 'live' } : { text: 'not held', tone: 'muted' };
    const last = [...live?.inputs ?? []].reverse().find(record => record.input.controlId === control.id);
    return last ? { text: `pressed ${ago(last.at, now)}` } : { text: '—', tone: 'muted' };
  }
  if (control.type === 'toggle') {
    if (control.action === 'safety.estop') return control.value ? { text: 'On', tone: 'stop' } : { text: 'Off', tone: 'muted' };
    return { text: control.value ? 'On' : 'Off' };
  }
  return { text: valueText(control) ?? '' };
}

function ControlsSection({ config, live, selected, now }: { config?: ConfigMessage; live?: PhoneLive; selected: boolean; now: number }) {
  const controls = config?.controls.filter(control => !isCalibration(control)) ?? [];
  const note = live?.lastInputAt ? <span title={clock(live.lastInputAt)}>last input {ago(live.lastInputAt, now)}</span> : 'no input yet';
  return <section id="inspector-controls" className="section">
    <Head title="Controls" note={note} selected={selected} />
    {!config ? <p className="empty">Waiting for this phone's controls.</p>
      : !controls.length ? <p className="empty">This phone's screen declares no controls.</p>
      : <dl className="kv controls">{controls.map(control => {
          const state = controlState(control, live, now);
          const stick = control.type === 'joystick' ? (control.live ? live?.dragging.get(control.id) : undefined) ?? control.value : undefined;
          return <div key={control.id}><dt>{control.label}</dt><dd className={state.tone}>{isStickValue(stick) && <StickGlyph value={stick} live={isLiveControl(control) && !!control.live} />}{state.text}</dd></div>;
        })}</dl>}
  </section>;
}

function InputsSection({ config, live, selected }: { config?: ConfigMessage; live?: PhoneLive; selected: boolean }) {
  const records = (live?.inputs ?? []).slice(-SHOWN_INPUTS).reverse();
  return <section id="inspector-inputs" className="section">
    <Head title="Recent inputs" note="repeats left out, a drag shown once" selected={selected} />
    {!records.length ? <p className="empty">No inputs yet.</p>
      : <ol className="inputs">{records.map(({ id, at, input }) => {
          const control = config?.controls.find(candidate => candidate.id === input.controlId);
          return <li key={id} className={input.source === 'gateway' ? 'inferred' : undefined}>
            <time className="num" dateTime={new Date(at).toISOString()}>{clock(at)}</time>
            <span className="what"><b>{control?.label ?? input.action}</b> {inputText(input, control)}</span>
          </li>;
        })}</ol>}
  </section>;
}

function Caret({ open }: { open: boolean }) {
  return <svg className={`caret ${open ? 'open' : ''}`} viewBox="0 0 8 8" aria-hidden="true"><path d="M2.5 1.2 5.8 4 2.5 6.8" /></svg>;
}

type Branch = JsonValue[] | { [key: string]: JsonValue };
/** One key of a JSON tree: a value on its row, or a branch that opens. `flipped` holds the paths opened or closed by hand. */
function JsonNode({ name, value, path, depth, flipped, onFlip }: { name: string; value: JsonValue; path: string; depth: number; flipped: Set<string>; onFlip: (path: string) => void }) {
  const inline = inlineArray(value);
  if (!isBranch(value) || inline !== undefined || !(Array.isArray(value) ? value.length : Object.keys(value).length)) {
    const text = inline ?? (isBranch(value) ? branchSummary(value) : leafText(value));
    return <div className="jrow"><span className="jk">{name}</span><span className={`jv ${isBranch(value) ? 'empty-branch' : leafKind(value)}`} title={text.length > 24 ? text : undefined}>{text}</span></div>;
  }
  const branch: Branch = value; const open = openByDefault(branch, depth) !== flipped.has(path);
  const entries: [string, JsonValue][] = Array.isArray(branch) ? branch.map((item, index) => [String(index), item]) : Object.entries(branch);
  return <div className="jbranch">
    <button type="button" className="jrow jtoggle" aria-expanded={open} onClick={() => onFlip(path)}>
      <span className="jk"><Caret open={open} />{name}</span>{!open && <span className="jsum">{branchSummary(branch)}</span>}
    </button>
    {open && <div className={`jkids ${Array.isArray(branch) ? 'list' : ''}`}>{entries.map(([key, item]) => <JsonNode key={key} name={key} value={item} path={`${path}\u0000${key}`} depth={depth + 1} flipped={flipped} onFlip={onFlip} />)}</div>}
  </div>;
}

/**
 * Robot state as a tree: keys on the left, values in monospace on the right, objects and lists folding open. The
 * top two levels start open (long ones closed); what is opened or closed by hand stays so as the state updates.
 */
const JsonTree = memo(function JsonTree({ state, label }: { state: { [key: string]: JsonValue }; label: string }) {
  const [flipped, setFlipped] = useState<Set<string>>(() => new Set());
  const flip = useCallback((path: string) => setFlipped(old => { const next = new Set(old); if (!next.delete(path)) next.add(path); return next; }), []);
  const entries = Object.entries(state);
  return <div className="jtree" role="group" aria-label={label}>
    {entries.length ? entries.map(([key, value]) => <JsonNode key={key} name={key} value={value} path={key} depth={0} flipped={flipped} onFlip={flip} />)
      : <p className="empty">An empty state.</p>}
  </div>;
});

/** One retained robot state: for every phone, or for one phone, with how old it is and whether it went stale. */
function StateSection({ entry, robot, store, title, phone }: { entry: RobotStateEntry; robot: RobotInfo; store: ViewerStore; title: string; phone?: { name: string; color: string } }) {
  const age = store.stateAge(entry); const fresh = freshness(entry, robot.connected, age);
  const every = entry.message.everyMs;
  const when = ago(Date.now() - age, Date.now());
  const note = fresh === 'stale' ? <span className="fresh-note stale" title={`Nothing new for longer than ${staleAfterMs(every) / 1000} s${every ? `; the robot said it sends every ${every} ms` : ''}`}>stale, updated {when}</span>
    : fresh === 'offline' ? <span className="fresh-note">offline, updated {when}</span>
    : <span className="fresh-note">updated {when}</span>;
  return <section className={`section robot-state ${fresh === 'fresh' ? '' : 'stale'}`} aria-label={`${robot.name}: ${title}`}>
    <h4><span className="state-title">{phone && <PhoneDot color={phone.color} />}{title}</span><small>{note}</small></h4>
    <JsonTree state={entry.message.state} label={`${robot.name}, ${title}`} />
  </section>;
}

/** A robot: whether it is online, whose screen the phones show, the video it publishes, and its latest state for every phone and for each phone. */
function RobotPanel({ robot, store, phones }: { robot: RobotInfo; store: ViewerStore; phones: Phone[] }) {
  const { all, phones: perPhone } = store.robotStates(robot.id);
  const every = all?.message.everyMs ?? perPhone[0]?.message.everyMs;
  const named = (id: string) => phones.find(phone => phone.id === id) ?? store.seen.get(id);
  return <>
    {!robot.connected && <p className="gone-note">{robot.name} is offline. Showing what it last sent.</p>}
    <section className="section">
      <h4><span>Robot</span><small className="mono">{robot.id}</small></h4>
      <dl className="kv">
        <div><dt>Connection</dt><dd className={robot.connected ? undefined : 'muted'}>{robot.connected ? 'Online' : 'Offline'}</dd></div>
        <div><dt>Phone screen</dt><dd className={robot.screen ? undefined : 'muted'}>{robot.screen ? 'Its screen is showing' : 'Not its screen'}</dd></div>
        <div><dt>Video</dt><dd className={robot.streams?.length ? 'mono' : 'muted'} title={streamList(robot.streams)}>{robot.streams?.length ? `${streamList(robot.streams)}` : 'None over WebRTC'}</dd></div>
        <div><dt>Sends state</dt><dd className={every ? 'num' : 'muted'}>{every ? `every ${every} ms` : '—'}</dd></div>
      </dl>
    </section>
    {all && <StateSection key={stateKey(robot.id)} entry={all} robot={robot} store={store} title="State for every phone" />}
    {perPhone.map(entry => {
      const id = entry.message.phoneId!; const phone = named(id);
      return <StateSection key={stateKey(robot.id, id)} entry={entry} robot={robot} store={store} title={`For ${phone?.name ?? id}`} phone={phone} />;
    })}
    {!all && !perPhone.length && <p className="empty">No state from {robot.name} yet. A robot sends <span className="mono">robot_state</span> to show it here.</p>}
  </>;
}

export function Inspector({ phones, robots, focus, onSelect, store, section, simulated }: { phones: Phone[]; robots: RobotInfo[]; focus?: Focus; onSelect: (focus: Focus) => void; store: ViewerStore; section?: Section; simulated: boolean }) {
  const now = Date.now();
  const robot = focus?.kind === 'robot' ? robots.find(candidate => candidate.id === focus.id) : undefined;
  const selected = focus?.kind === 'phone' ? phones.find(phone => phone.id === focus.id) : undefined;
  if (!focus || (!robot && !selected)) return <aside className="inspector" aria-label="Inspector">
    <p className="empty inspector-empty">No phones yet. Each phone's pose, calibration and controls show here once it connects to the gateway.</p>
  </aside>;
  const tabs = <Tabs phones={phones} robots={robots} focus={focus} onSelect={onSelect} />;
  if (robot) return <aside className="inspector" aria-label={`Inspector, ${robot.name}`}>
    {tabs}
    <div id="inspector-panel" role="tabpanel" aria-label={robot.name}><RobotPanel robot={robot} store={store} phones={phones} /></div>
  </aside>;
  const phone = selected!; const phoneLive = store.live.phones.get(phone.id);
  return <aside className="inspector" aria-label={`Inspector, ${phone.name}`}>
    {tabs}
    <div id="inspector-panel" role="tabpanel" aria-label={phone.name}>
      {stopOn(phone.config) && <p className="stop-note"><b>Stop is on</b> for {phone.name}. What it stops is up to the consumer.</p>}
      {!phone.connected && <p className="gone-note">{phone.name} is disconnected. Showing what it last sent.</p>}
      <PoseSection phone={phone} live={phoneLive} selected={section === 'pose'} latency={store.latency(phone.id)} />
      <CalibrationSection config={phone.config} live={phoneLive} selected={section === 'calibration'} simulated={simulated} />
      <ControlsSection config={phone.config} live={phoneLive} selected={section === 'controls'} now={now} />
      <InputsSection config={phone.config} live={phoneLive} selected={section === 'inputs'} />
    </div>
  </aside>;
}
