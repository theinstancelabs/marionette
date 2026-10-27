import React from 'react';
import { CALIBRATION_STEPS, CALIBRATION_STEP_TEXT, CHECK_EXPECTED_AXIS, CHECK_MOVE_TEXT, MIN_CALIBRATION_STEP_M, describeCheckResult, dominantAxis, metersToMillimeters, type ConfigMessage, type UiControl, type Vector3 } from '@marionette/protocol';
import { inputText, knownStep, valueText } from './events';
import { AXIS_WORD, TRACKING_WORDS, axisText, recentMotion, signed, stepProgressMm, tiltDegrees } from './motion';
import { stopOn, type Phone } from './phones';
import type { PhoneLive } from './store';
import { PhoneDot, ago, clock } from './ui';

export type Section = 'pose' | 'calibration' | 'controls' | 'inputs';
const AXES = [{ axis: 'x', name: 'forward' }, { axis: 'y', name: 'left' }, { axis: 'z', name: 'up' }] as const;
const STEP_NAME = { flat: 'Flat', forward: 'Forward', right: 'Right', up: 'Up' } as const;
const MIN_STEP_MM = MIN_CALIBRATION_STEP_M * 1000;
const SHOWN_INPUTS = 8;
const isCalibration = (control: UiControl) => control.action.startsWith('calibration.');

function Head({ title, note, selected }: { title: string; note?: React.ReactNode; selected: boolean }) {
  return <h4><span className={selected ? 'hl' : undefined}>{title}</span>{note && <small>{note}</small>}</h4>;
}

function PhoneTabs({ phones, selected, onSelect }: { phones: Phone[]; selected?: string; onSelect: (id: string) => void }) {
  const move = (event: React.KeyboardEvent, index: number) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0; if (!step) return;
    event.preventDefault(); const next = phones[(index + step + phones.length) % phones.length];
    onSelect(next.id); (event.currentTarget.parentElement?.querySelector(`[data-phone="${next.id}"]`) as HTMLElement | null)?.focus();
  };
  return <div className="ptabs" role="tablist" aria-label="Phones">
    {phones.map((phone, index) => {
      const on = phone.id === selected; const stop = stopOn(phone.config);
      return <button key={phone.id} type="button" role="tab" data-phone={phone.id} aria-selected={on} tabIndex={on ? 0 : -1} className={`${on ? 'on' : ''} ${phone.connected ? '' : 'off'}`}
        title={phone.connected ? undefined : `${phone.name} is disconnected`} onClick={() => onSelect(phone.id)} onKeyDown={event => move(event, index)}>
        <PhoneDot color={phone.color} muted={!phone.connected} /><span className="tab-name">{phone.name}</span>{stop && <i className="tab-stop" role="img" aria-label="Stop on" title="Stop on" />}
      </button>;
    })}
  </div>;
}

function PoseSection({ phone, live, selected }: { phone: Phone; live?: PhoneLive; selected: boolean }) {
  const pose = live?.pose; const present = !!live?.presence.present && phone.connected;
  const mm = pose ? metersToMillimeters(pose.position) : undefined;
  const motion = live ? recentMotion(live.trail, performance.now()) : { state: 'unknown' as const };
  const tracking = !phone.connected ? 'Disconnected' : present && pose ? TRACKING_WORDS[pose.trackingState] : 'No pose';
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
  const shownInstruction = capturing ? CALIBRATION_STEP_TEXT[step].instruction : validating && c.check?.step ? CHECK_MOVE_TEXT[c.check.step].instruction : undefined;
  // Refusals stay in view for a while; other replies only while a step is in progress, and only when they add to the instruction.
  const recent = live?.reply && Date.now() - live.reply.at < 30_000 ? live.reply : undefined;
  const reply = recent && (recent.tone === 'fail' || ((capturing || validating) && recent.message !== shownInstruction)) ? recent : undefined;

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

/** A control's current value for this phone, in words, and how to color it. */
function controlState(control: UiControl, live: PhoneLive | undefined, now: number): { text: string; tone?: string } {
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
          return <div key={control.id}><dt>{control.label}</dt><dd className={state.tone}>{state.text}</dd></div>;
        })}</dl>}
  </section>;
}

function InputsSection({ config, live, selected }: { config?: ConfigMessage; live?: PhoneLive; selected: boolean }) {
  const records = (live?.inputs ?? []).slice(-SHOWN_INPUTS).reverse();
  return <section id="inspector-inputs" className="section">
    <Head title="Recent inputs" note="repeats of a hold left out" selected={selected} />
    {!records.length ? <p className="empty">No inputs yet.</p>
      : <ol className="inputs">{records.map(({ at, input }) => {
          const control = config?.controls.find(candidate => candidate.id === input.controlId);
          return <li key={`${at}-${input.controlId}-${String(input.value)}`} className={input.source === 'gateway' ? 'inferred' : undefined}>
            <time className="num" dateTime={new Date(at).toISOString()}>{clock(at)}</time>
            <span className="what"><b>{control?.label ?? input.action}</b> {inputText(input, control)}</span>
          </li>;
        })}</ol>}
  </section>;
}

export function Inspector({ phones, selected, onSelect, live, section, simulated }: { phones: Phone[]; selected?: Phone; onSelect: (id: string) => void; live: (id: string) => PhoneLive | undefined; section?: Section; simulated: boolean }) {
  const now = Date.now();
  if (!selected) return <aside className="inspector" aria-label="Inspector">
    <p className="empty inspector-empty">No phones yet. Each phone's pose, calibration and controls show here once it connects to the gateway.</p>
  </aside>;
  const phoneLive = live(selected.id);
  return <aside className="inspector" aria-label={`Inspector, ${selected.name}`}>
    <PhoneTabs phones={phones} selected={selected.id} onSelect={onSelect} />
    <div role="tabpanel" aria-label={selected.name}>
      {!selected.connected && <p className="gone-note">{selected.name} is disconnected. Showing what it last sent.</p>}
      <PoseSection phone={selected} live={phoneLive} selected={section === 'pose'} />
      <CalibrationSection config={selected.config} live={phoneLive} selected={section === 'calibration'} simulated={simulated} />
      <ControlsSection config={selected.config} live={phoneLive} selected={section === 'controls'} now={now} />
      <InputsSection config={selected.config} live={phoneLive} selected={section === 'inputs'} />
    </div>
  </aside>;
}
