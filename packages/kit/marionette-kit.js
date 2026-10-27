/*
 * Marionette screen kit (window.MarionetteKit), version 1.
 *
 * Parts for a Marionette phone screen, taken from the default screen so they behave the way they already do on
 * the phone: hold buttons, live sliders and sticks, Stop, the status strip, toasts, robot state, cameras (JPEG or
 * WebRTC), guided calibration, sheets and generic control rows. It is a set of parts, not a framework: use any of
 * them on their own, in your own layout. docs/SCREEN-KIT.md describes each one.
 *
 * A classic script with no dependencies and no build. A screen opts in with a stylesheet link to
 * marionette-kit.css and a script tag with src="marionette-kit.js" (docs/SCREEN-KIT.md has the exact tags), and the
 * gateway puts both inline before sending the screen. Being inlined, this file never contains a closing script tag.
 * The kit talks to the app through
 * window.Marionette (the page bridge) and waits for `marionette-ready` if the bridge isn't there yet.
 */
(() => {
  'use strict';
  if (window.MarionetteKit) return;

  /* ---------- The bridge, and what the kit remembers of it ---------- */
  // Actions the kit's own parts look for. Every part takes its own action (or control id) too.
  const ACTIONS = Object.freeze({
    deadman: 'teleop.deadman', estop: 'safety.estop', view: 'camera.view',
    start: 'calibration.start', capture: 'calibration.capture', cancel: 'calibration.cancel',
    check: 'calibration.check', origin: 'calibration.captureOrigin', clear: 'calibration.reset',
  });
  const BRIDGE_EVENTS = ['config', 'connection', 'tracking', 'pose', 'status', 'camera_frame', 'robot_state', 'robots', 'link', 'rtc'];
  // State is replayed to a late subscriber, like Marionette.on does; one-off events are not.
  const REPLAYED = new Set(['config', 'connection', 'tracking', 'pose', 'robots', 'link']);
  const last = {};
  const listeners = {};
  const report = error => { if (window.console && console.error) console.error('[marionette-kit]', error); };
  const safely = (fn, ...args) => { try { return fn(...args); } catch (error) { report(error); return undefined; } };
  function emit(type, payload) { for (const fn of (listeners[type] || []).slice()) safely(fn, payload); }
  /** Like Marionette.on, but runs after the kit has taken the event in, so the kit's state is current. */
  function on(type, fn) {
    if (typeof fn !== 'function') return () => {};
    (listeners[type] || (listeners[type] = [])).push(fn);
    if (REPLAYED.has(type) && Object.prototype.hasOwnProperty.call(last, type)) safely(fn, last[type]);
    return () => { listeners[type] = (listeners[type] || []).filter(x => x !== fn); };
  }
  const latest = type => last[type];
  const features = () => { const M = window.Marionette; return M && Array.isArray(M.features) ? M.features.slice() : []; };
  const has = feature => features().indexOf(feature) >= 0;

  let booted = false;
  const waiting = [];
  function boot() {
    const M = window.Marionette; if (!M || booted) return; booted = true;
    for (const type of BRIDGE_EVENTS) M.on(type, payload => take(type, payload));
    for (const fn of waiting.splice(0)) safely(fn, M);
  }
  /** Runs `fn(Marionette)` once the bridge is there (at once if it already is). */
  function ready(fn) { if (booted) safely(fn, window.Marionette); else waiting.push(fn); }

  /* ---------- Holds and drags: what this page is touching, and what the gateway says about it ---------- */
  // Hold buttons pressed here, and sliders, sticks and drags dragged here: control id → false (not yet reported by the
  // gateway), true (reported held or live during this touch) or CUT. A cut touch is over for the gateway: the
  // connection dropped or this page's phone changed during it, it began while the gateway was away, or the kit let go
  // of it. No sample, repeat or press goes out for it (only, when the finger lifts, the release or final value its host
  // waits for), and it reads as dropped, whatever the gateway says, until the operator lets go.
  const CUT = 'cut';
  const pressed = new Map();
  const touching = new Map();
  const config = () => last.config;
  const control = action => { const c = last.config; return c ? c.controls.find(x => x.action === action) : undefined; };
  const byId = id => { const c = last.config; return c ? c.controls.find(x => x.id === id) : undefined; };
  const resolve = c => (typeof c === 'string' ? byId(c) : c);
  const linkDown = () => { const c = last.connection; return !!c && c.state !== 'connected'; };
  const phoneOf = c => (c && c.phone ? c.phone.id : undefined);
  // idle; pending (pressed, not yet reported by the gateway); held; or dropped (the gateway let go, e.g. its repeats
  // stopped arriving, while it is still pressed here; a repeat never restarts a hold, so the operator presses again).
  // Without a gateway connection nothing is held, whatever the last config said.
  function holdState(c) {
    c = resolve(c); if (!c || !pressed.has(c.id)) return 'idle';
    const was = pressed.get(c.id);
    if (was === CUT || linkDown()) return 'dropped';
    return c.held ? 'held' : was ? 'dropped' : 'pending';
  }
  // idle; pending (dragged, not yet reported live); live; or dropped (the gateway stopped hearing it while it is still
  // dragged here; like a hold, it only counts again once the operator lets go).
  function liveState(c) {
    c = resolve(c); if (!c || !touching.has(c.id)) return 'idle';
    const was = touching.get(c.id);
    if (was === CUT || linkDown()) return 'dropped';
    return c.live ? 'live' : was ? 'dropped' : 'pending';
  }
  const busy = () => pressed.size > 0 || touching.size > 0;
  function send(c, value) { const M = window.Marionette; if (c && M) M.sendAction(c.id, c.action, value); }
  // The host ends every hold and drag when the gateway goes or its phone changes. Whatever is still touched here is
  // cut: it sends no new sample or repeat (either would start it again) until the operator lets go.
  // `why` is 'connection' or 'phone'.
  function cutAll(why) { let any = false; for (const part of [...parts]) if (part.cut && safely(part.cut, why)) any = true; return any; }

  function take(type, payload) {
    if (type === 'config') {
      if (!payload || !Array.isArray(payload.controls)) return;
      const before = last.config; last.config = payload;
      // A config for another phone (a mirror that moved on): what is touched here was meant for the old one.
      const cut = !!before && phoneOf(before) !== phoneOf(payload) && cutAll('phone');
      for (const [id, was] of pressed) { const c = byId(id); if (was === false && c && c.held) pressed.set(id, true); }
      for (const [id, was] of touching) { const c = byId(id); if (was === false && c && c.live) touching.set(id, true); }
      for (const part of [...parts]) if (part.sync) safely(part.sync, payload);
      if (cut) touched(); else renderParts();
    } else if (type === 'connection') {
      last.connection = payload;
      if (payload && payload.state !== 'connected' && cutAll('connection')) touched(); else renderParts();
    } else last[type] = payload;
    emit(type, payload);
  }

  /* ---------- Parts, groups and letting go ---------- */
  // Every part the kit made: render() shows what the gateway knows, sync(config) follows control values,
  // letGo(quiet) lets go of what it holds, dispose() lets go and unhooks it.
  const parts = new Set();
  // What lets go when the page is left, a sheet opens or Stop turns on: kit parts by default, plus letGoOnLeave().
  const leavers = new Set();
  function renderParts() { for (const part of [...parts]) if (part.render) safely(part.render); }
  function touched() { watch(); renderParts(); emit('touch'); }
  function listen(part, node, type, fn, options) { node.addEventListener(type, fn, options); (part.off || (part.off = [])).push(() => node.removeEventListener(type, fn, options)); }
  function adopt(part, o) {
    o = o || {};
    parts.add(part);
    if (part.letGo && o.letGoOnLeave !== false) leavers.add(part.letGo);
    if (o.group) o.group.add(part);
    const dispose = part.dispose;
    part.dispose = () => {
      if (!parts.has(part)) return;
      if (dispose) safely(dispose); else if (part.letGo) safely(part.letGo);
      parts.delete(part); if (part.letGo) leavers.delete(part.letGo);
      for (const off of part.off || []) off();
    };
    if (part.sync && last.config) safely(part.sync, last.config);
    if (part.render) safely(part.render);
    return part;
  }
  /** A set of parts that are let go of, or disposed of, together (a dock that is rebuilt, say). */
  function group() {
    const members = new Set();
    return {
      add(part) { members.add(part); return part; },
      letGo(quiet) { for (const part of [...members]) if (part.letGo) safely(part.letGo, quiet === true); },
      dispose() { const list = [...members]; members.clear(); for (const part of list) part.dispose(); },
    };
  }
  /** Lets go of everything that lets go on leave. `quiet` lets go here without telling the gateway. */
  function letGo(quiet) { for (const fn of [...leavers]) safely(fn, quiet === true); }
  /** Lets `target` (a group, a part or a function) go when the page loses focus or is hidden, a sheet opens or Stop turns on. */
  function letGoOnLeave(target) {
    const fn = typeof target === 'function' ? target : target && typeof target.letGo === 'function' ? quiet => target.letGo(quiet) : undefined;
    if (!fn) return () => {};
    leavers.add(fn); return () => { leavers.delete(fn); };
  }
  // Leaving the page (another app, a hidden tab) lets go, so nothing stays pressed or pushed.
  window.addEventListener('blur', () => letGo());
  document.addEventListener('visibilitychange', () => { if (document.hidden) letGo(); });

  // Fingers (and pressed mouse buttons) on the page, seen by the window before anything else, so a part hears its
  // finger lift even when its element was removed or made inert in the meantime: pointer id → pointer type.
  // part.ended(event) hears every pointerup, pointercancel and lostpointercapture; part.lifted() hears the last finger lift.
  const fingers = new Map();
  const tell = (name, e) => { for (const part of [...parts]) if (part[name]) safely(part[name], e); };
  const lifted = () => { if (!fingers.size) tell('lifted'); };
  window.addEventListener('pointerdown', e => { fingers.set(e.pointerId, e.pointerType); }, true);
  for (const name of ['pointerup', 'pointercancel']) window.addEventListener(name, e => { fingers.delete(e.pointerId); tell('ended', e); lifted(); }, true);
  window.addEventListener('lostpointercapture', e => tell('ended', e), true);
  // No touch left on the screen, whatever the pointer events said.
  for (const name of ['touchend', 'touchcancel']) window.addEventListener(name, e => { if (e.touches && e.touches.length) return; for (const [id, kind] of fingers) if (kind === 'touch') fingers.delete(id); lifted(); }, true);
  // While anything is touched, a screen re-rendering it away (replaceChildren without dispose()) lets go of it at once,
  // whichever way the browser then sends that finger's events: part.orphaned() lets go if its element left the page.
  const orphans = typeof MutationObserver === 'function' ? new MutationObserver(() => tell('orphaned')) : undefined;
  let watching = false;
  function watch() { const want = busy(); if (!orphans || want === watching) return; watching = want; if (want) orphans.observe(document, { childList: true, subtree: true }); else orphans.disconnect(); }

  /* ---------- DOM helpers ---------- */
  /** h('button', { class: 'x', onclick: fn, 'aria-label': 'y' }, 'text', child, [more]) */
  const h = (tag, props, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v; else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v); else node.setAttribute(k, v === true ? '' : v);
    }
    for (const child of children.flat(Infinity)) if (child != null && child !== false) node.append(child);
    return node;
  };
  const setText = (node, text) => { if (node && node.textContent !== text) node.textContent = text; };
  const svg = markup => { const box = document.createElement('div'); box.innerHTML = markup; return box.firstElementChild; };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const mm = v => Math.round(v * 1000);
  const signed = n => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n);
  const signed2 = n => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(2);
  const cap = word => (word ? word[0].toUpperCase() + word.slice(1) : '');
  /** A slider value with as many decimals as its step, and its unit. */
  function format(c, value) { const step = String(c && c.step !== undefined ? c.step : 1); const digits = step.includes('.') ? step.split('.')[1].length : 0; return Number(value).toFixed(digits) + ((c && c.unit) || ''); }
  const prevent = e => e.preventDefault();
  const finder = o => () => (o.controlId ? byId(o.controlId) : o.action ? control(o.action) : undefined);
  const staleAfterMs = everyMs => Math.max(1500, 3 * (Number(everyMs) > 0 ? Number(everyMs) : 0));
  const linkQuality = rttMs => (typeof rttMs !== 'number' || !isFinite(rttMs) ? 'unknown' : rttMs < 60 ? 'good' : rttMs < 150 ? 'fair' : 'poor');

  /* ---------- hold: true on press, false on release ---------- */
  // The app repeats the press while it is held, and the gateway drops a hold whose renewals stop. The release goes to
  // the control that was pressed, even if the config changed in between, and dispose() releases first, so a rebuilt
  // dock can never leave a hold behind. A button taken off the page mid-press (a screen re-rendering without dispose())
  // lets go at once, and the press's finger is followed on the window, so its lift is heard wherever it lands.
  function hold(button, o) {
    o = o || {}; const get = finder(o);
    let held, pointer, sent, shown;
    const current = () => (held ? byId(held.id) || held : get());
    const part = { el: button };
    part.release = quiet => {
      if (!held) return; const c = held; held = undefined; pointer = undefined; pressed.delete(c.id);
      if (quiet !== true && sent) send(c, false);
      touched(); if (o.onChange) safely(o.onChange, false);
    };
    part.letGo = part.release;
    // A press cut by a phone change is released quietly: its release would go to the new phone.
    part.cut = why => { if (!held) return false; if (why === 'phone') sent = false; if (pressed.get(held.id) === CUT) return false; pressed.set(held.id, CUT); return true; };
    part.ended = e => { if (held && e.pointerId === pointer) part.release(); };
    part.orphaned = () => { if (!held || button.isConnected) return false; part.release(); return true; };
    part.state = () => holdState(current());
    part.render = () => {
      if (part.orphaned()) return;
      const c = current(); const state = holdState(c);
      button.setAttribute('data-state', state); button.setAttribute('aria-pressed', String(state !== 'idle'));
      if (state !== shown) { shown = state; if (o.onState) safely(o.onState, state, c); }
    };
    listen(part, button, 'pointerdown', e => {
      e.preventDefault(); if (held || !button.isConnected || button.disabled || button.getAttribute('aria-disabled') === 'true') return;
      const c = get(); if (!c) return;
      held = c; pointer = e.pointerId;
      try { button.setPointerCapture(e.pointerId); } catch (x) { /* capture is a nicety; the press still counts */ }
      // Pressed while the gateway is away: the press never goes out (a host could deliver it once the gateway is back),
      // so it can't turn into a hold without a fresh press.
      sent = !linkDown(); pressed.set(c.id, sent ? false : CUT); if (sent) send(c, true);
      touched(); if (o.onChange) safely(o.onChange, true);
    });
    listen(part, button, 'contextmenu', prevent);
    return adopt(part, o);
  }

  /* ---------- Live values: sliders and sticks stream while they are dragged ---------- */
  // The newest value goes out at most once a frame, marked live, and the host repeats the latest sample while the drag
  // is open; end() sends the final value, which ends it. The kit streams the values itself, the way the bridge's
  // stream() does, so that cutting a drag also drops a sample still waiting for its frame. A cut drag sends no more
  // samples and ignores update() until end() says the gesture is over; `onCut` hears it being cut.
  //
  // A host that cuts a drag (the app, the desktop mirror) drops every sample for that control until a final value
  // (one without `live`) says the gesture is over; it swallows that final value too. So a cut drag whose samples went
  // out still sends one final value when the gesture ends, or the host would swallow the next drag whole. It is the
  // value the gateway ended the drag at (rest for a stick, the last value sent otherwise), so even a host that passed it
  // on would tell the gateway nothing new.
  const sameValue = (a, b) => a === b || (!!a && !!b && typeof a === 'object' && typeof b === 'object' && a.x === b.x && a.y === b.y);
  const sendable = v => (typeof v === 'number' ? isFinite(v) : typeof v === 'string' || typeof v === 'boolean' || (!!v && typeof v === 'object' && typeof v.x === 'number' && typeof v.y === 'number'));
  function dragger(get, onCut) {
    let c, state = 'idle', pending, sent, owed = false, frame = 0;   // state: idle, open or CUT; owed: the host waits for a final value
    const stopFrame = () => { if (frame) cancelAnimationFrame(frame); frame = 0; pending = undefined; };
    const flush = () => { frame = 0; if (state !== 'open' || pending === undefined) return; sent = pending; pending = undefined; post(sent, true); };
    const final = value => { const v = value !== undefined ? value : pending !== undefined ? pending : sent; stopFrame(); post(v); };
    const post = (value, live) => { const M = window.Marionette; if (M) M.sendAction(c.id, c.action, value, live ? { live: true } : undefined); };
    const cutHere = () => { stopFrame(); state = CUT; touching.set(c.id, CUT); if (onCut) safely(onCut); };
    return {
      update(value) {
        if (state === CUT || !sendable(value)) return;
        if (state === 'idle') {
          const x = get(); const M = window.Marionette; if (!x || !M || typeof M.stream !== 'function') return;
          c = x; sent = undefined; owed = false;
          // Begun while the gateway is away: nothing goes out (a host could deliver it once the gateway is back).
          if (linkDown()) { cutHere(); touched(); return; }
          state = 'open'; touching.set(c.id, false); touched();
        }
        if (sameValue(value, pending !== undefined ? pending : sent)) return;
        pending = value; if (!frame) frame = requestAnimationFrame(flush);
      },
      // The gesture is over: the final value goes out (the last one if left out) unless quiet. A cut drag sends only
      // what it owes its host: the value the gateway ended it at, so the host stops dropping this control's samples.
      end(value, quiet) {
        if (state === 'idle') return;
        if (state === 'open' && quiet !== true) final(value);
        else { stopFrame(); if (owed) post(c.type === 'joystick' ? { x: 0, y: 0 } : sent); }
        state = 'idle'; owed = false; touching.delete(c.id); touched();
      },
      // The kit let go mid-gesture: the final value goes out unless quiet, then nothing until end().
      letGo(value, quiet) { if (state !== 'open') return false; if (quiet !== true) final(value); cutHere(); touched(); return true; },
      // The host already ended it (the gateway went, or the phone changed): nothing goes out until the gesture ends, and
      // then only the final value the host waits for, if any sample went out.
      cut() { if (state !== 'open') return false; owed = sent !== undefined; cutHere(); return true; },
      isOpen: () => state === 'open',
      isCut: () => state === CUT,
      id: () => (state === 'idle' ? undefined : c.id),
    };
  }
  /** A live value fed by your own touch handling (a thumb sliding on a pad, say): update() streams, end() sends the final value. */
  function drag(o) {
    // Once cut (the kit let go, sending the last value again without live; the gateway went; the phone changed),
    // update() does nothing until end(), and onLetGo tells your touch handling to show it let go.
    o = o || {}; const get = finder(o); const d = dragger(get, o.onLetGo);
    const part = { update: d.update, end: (value, quiet) => d.end(value, quiet), isOpen: d.isOpen };
    part.state = () => liveState(d.id() ? byId(d.id()) : get());
    part.letGo = quiet => { d.letGo(undefined, quiet); };
    part.cut = () => d.cut();
    part.dispose = () => d.end();
    return adopt(part, o);
  }
  /** A slider that streams while dragged; letting go (or a key press) sends the final value. */
  function slider(input, o) {
    o = o || {}; const get = finder(o); const c0 = get();
    if (!input) input = h('input', { type: 'range', class: 'mk-range' });
    // The range comes from the control, now or once the config arrives.
    const shape = c => { for (const key of ['min', 'max', 'step']) if (input.getAttribute(key) !== String(c[key])) input.setAttribute(key, c[key]); if (!input.getAttribute('aria-label')) input.setAttribute('aria-label', c.label); };
    if (c0 && c0.type === 'slider') { shape(c0); input.value = c0.value; }
    const drag = dragger(get); const fmt = o.format || format; let pointer, settled = false;
    const current = () => (drag.id() ? byId(drag.id()) : get()) || c0;
    const show = value => { if (o.out) setText(o.out, fmt(current(), value)); };
    // Back to the gateway's value: after a cut drag the thumb shows nothing that wasn't sent. Where the gateway ended the
    // drag may only come later (after a reconnect), so a settled slider follows the config even with focus, until the
    // operator touches it again.
    const settle = () => { settled = true; const c = get(); if (c && c.type === 'slider') { input.value = c.value; show(c.value); } };
    const part = { el: input, out: o.out };
    // The finger lifted (or a key press committed the value): the final value goes out, or after a cut only what the host waits for.
    part.finish = quiet => { pointer = undefined; const cut = drag.isCut(); drag.end(Number(input.value), quiet); if (cut) settle(); };
    // The kit let go mid-drag: the value so far is the final one, and the rest of the drag is ignored until the finger lifts.
    part.letGo = quiet => { drag.letGo(Number(input.value), quiet); };
    part.cut = () => drag.cut();
    part.ended = e => { if (e.pointerId === pointer && e.type !== 'lostpointercapture') part.finish(); };
    part.lifted = () => { if (drag.id() !== undefined) part.finish(); };
    part.orphaned = () => { if (drag.id() === undefined || input.isConnected) return false; part.finish(); return true; };
    part.dispose = () => part.finish();
    part.state = () => liveState(current());
    part.render = () => {
      if (part.orphaned()) return;
      const state = liveState(current()); input.setAttribute('data-state', state); if (o.out) o.out.setAttribute('data-state', state);
    };
    // Values change with every config; follow them unless this slider is being dragged or has focus.
    part.sync = () => { const c = get(); if (!c || c.type !== 'slider' || touching.has(c.id)) return; shape(c); if (document.activeElement === input && !settled) return; input.value = c.value; show(c.value); };
    listen(part, input, 'pointerdown', e => { pointer = e.pointerId; settled = false; });
    listen(part, input, 'input', () => { if (drag.isCut()) return; settled = false; const value = Number(input.value); drag.update(value); if (!drag.isCut()) show(value); });
    for (const name of ['change', 'pointerup', 'pointercancel', 'touchend', 'touchcancel']) listen(part, input, name, () => part.finish());
    // Focus taken away mid-drag is the page letting go, not the finger.
    listen(part, input, 'blur', () => part.letGo());
    show(input.value);
    return adopt(part, o);
  }

  // A stick's value is where it is pushed, in operator axes: x up the pad (forward), y to the left, each -1..1 and
  // at most 1 together. The knob is 30% of the pad and travels 35% of it, so a full push moves it 35/30 of its size.
  const KNOB_TRAVEL = 35 / 30 * 100;
  const ARROWS = { ArrowUp: [1, 0], ArrowDown: [-1, 0], ArrowLeft: [0, 1], ArrowRight: [0, -1] };
  // Two decimals, rounded toward zero, so a full diagonal push never comes out longer than 1.
  const toward0 = n => (Math.trunc(n * 100) / 100) || 0;
  function stickLimit(x, y) { const n = Math.hypot(x, y); return n > 1 ? { x: toward0(x / n), y: toward0(y / n) } : { x: toward0(x), y: toward0(y) }; }
  const STICK_FACE = '<svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="35" fill="none" stroke="#cfd3d6" stroke-dasharray="2 3" vector-effect="non-scaling-stroke"/><path d="M50 3V97M3 50H97" stroke="#e6ebf2" vector-effect="non-scaling-stroke"/><line class="mk-vec" x1="50" y1="50" x2="50" y2="50" stroke-width="2.5" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>';
  /** A spring-return stick: a touch anywhere on the pad pushes it that far from the centre, and it follows the finger until let go. */
  function stick(pad, o) {
    o = o || {}; const get = finder(o); const c0 = get();
    pad = pad || h('div');
    const label = o.label || (c0 && c0.label) || 'Stick';
    pad.classList.add('mk-stick');
    for (const [k, v] of [['tabindex', '0'], ['role', 'group'], ['aria-roledescription', 'stick'], ['aria-label', label + '. Drag to push it, or hold the arrow keys. Let go to stop.']]) if (!pad.hasAttribute(k)) pad.setAttribute(k, v);
    const face = svg(STICK_FACE); const vec = face.querySelector('.mk-vec'); const knob = h('span', { class: 'mk-knob' });
    pad.append(face, ...(o.edges || []).map((word, i) => h('span', { class: 'mk-edge mk-' + 'nswe'[i] }, word)), knob);
    let rect, pointer, pushed = false; const keys = new Set();
    // A cut stick (the kit let go, or the gateway went) springs back and ignores the finger until it lifts.
    const drag = dragger(get, () => rest());
    const current = () => (drag.id() ? byId(drag.id()) : get()) || c0;
    const off = () => pad.getAttribute('aria-disabled') === 'true';
    const show = v => {
      knob.style.transform = v.x || v.y ? 'translate(' + (-v.y * KNOB_TRAVEL).toFixed(1) + '%,' + (-v.x * KNOB_TRAVEL).toFixed(1) + '%)' : '';
      vec.setAttribute('x2', (50 - v.y * 35).toFixed(1)); vec.setAttribute('y2', (50 - v.x * 35).toFixed(1));
      if (o.onMove) safely(o.onMove, v);
    };
    function rest() { pad.classList.remove('mk-dragging'); if (pushed) { pushed = false; show({ x: 0, y: 0 }); } }
    const push = v => { if (drag.isCut()) return; drag.update(v); if (drag.isCut()) return; pushed = true; pad.classList.add('mk-dragging'); show(v); };
    const part = { el: pad };
    // The finger lifted (or the last arrow key came up): back to rest, which goes out unless the drag was cut.
    const release = quiet => { pointer = undefined; keys.clear(); rest(); drag.end({ x: 0, y: 0 }, quiet); };
    part.letGo = quiet => { drag.letGo({ x: 0, y: 0 }, quiet); };
    part.cut = () => drag.cut();
    // The finger is followed on the window, so a stick taken off the page mid-drag still lets go.
    part.ended = e => { if (pointer !== undefined && e.pointerId === pointer) release(); };
    part.lifted = () => { if (pointer !== undefined) release(); };
    part.orphaned = () => { if ((pointer === undefined && !keys.size) || pad.isConnected) return false; release(); return true; };
    part.dispose = () => release();
    part.state = () => liveState(current());
    part.render = () => {
      if (part.orphaned()) return;
      pad.setAttribute('data-state', liveState(current()));
    };
    const at = e => {
      if (!rect || !rect.width || !rect.height) return { x: 0, y: 0 };
      return stickLimit((rect.top + rect.height / 2 - e.clientY) / (rect.height * 0.35), (rect.left + rect.width / 2 - e.clientX) / (rect.width * 0.35));
    };
    listen(part, pad, 'pointerdown', e => {
      e.preventDefault(); if (pointer !== undefined || !pad.isConnected || off()) return;
      pointer = e.pointerId; rect = pad.getBoundingClientRect(); keys.clear();
      try { pad.setPointerCapture(e.pointerId); } catch (x) { /* capture is a nicety; the drag still counts */ }
      push(at(e));
    });
    listen(part, pad, 'pointermove', e => { if (e.pointerId === pointer) push(at(e)); });
    const fromKeys = () => { let x = 0, y = 0; for (const key of keys) { x += ARROWS[key][0]; y += ARROWS[key][1]; } return stickLimit(x, y); };
    listen(part, pad, 'keydown', e => { if (!ARROWS[e.key] || pointer !== undefined || off()) return; e.preventDefault(); if (e.repeat || keys.has(e.key)) return; keys.add(e.key); push(fromKeys()); });
    listen(part, pad, 'keyup', e => { if (!keys.delete(e.key)) return; if (keys.size) push(fromKeys()); else release(); });
    listen(part, pad, 'blur', () => { if (keys.size) release(); });
    listen(part, pad, 'contextmenu', prevent);
    return adopt(part, o);
  }

  /* ---------- Stop: this phone's own signal, a toggle the consumer reads ---------- */
  // Marionette itself stops nothing. A toggle Stop turns on; a plain Stop button (on a custom layout) sends a press.
  const STOP_WARNING = '[marionette-kit] stop(): an open sheet covers the Stop button you passed, so the kit shows its own floating Stop as well while a sheet is open. Give your Stop position: fixed and a z-index above the sheet\'s (.mk-sheet is 10), or put it in the sheet, or use the kit\'s floating Stop (stop() without a button).';
  function stop(o) {
    o = o || {}; const action = o.action || ACTIONS.estop; const get = () => control(action);
    const button = o.button || document.body.appendChild(h('button', { class: 'mk-stop', type: 'button', 'aria-label': 'Stop', hidden: true }, 'Stop'));
    // A sheet never makes Stop inert, wherever it sits on the page. The kit's Stop floats above every sheet, but an open
    // sheet still draws over a screen's own Stop in the page's flow: see part.sheeted.
    kept.add(button);
    const banner = o.banner;
    if (banner) {
      banner.classList.add('mk-banner'); if (!banner.hasAttribute('role')) banner.setAttribute('role', 'alert');
      if (!banner.childElementCount) banner.append(h('div', {}, h('b', {}, 'Stop is on'), h('span', {}, 'It stays on for this phone until you reset it.')), h('button', { type: 'button', 'data-stop-reset': '' }, 'Reset'));
    }
    const reset = o.reset || (banner && banner.querySelector('[data-stop-reset]'));
    const isOn = () => { const c = get(); return !!c && c.value === true; };
    const press = () => { const c = get(); if (!c) return; if (c.type !== 'toggle') send(c); else if (c.value !== true) send(c, true); };
    // spare: the kit's floating Stop, shown beside the screen's own while an open sheet covers that one.
    let was, spare, spareShown = false, warned = false;
    const part = { button, banner, isOn, press };
    const wire = node => {
      listen(part, node, 'pointerdown', e => { e.preventDefault(); press(); });
      listen(part, node, 'click', e => { if (e.detail === 0) press(); });
    };
    part.render = () => {
      const c = get(); const latched = isOn();
      button.hidden = !c; button.setAttribute('aria-pressed', String(latched)); if (banner) banner.hidden = !latched;
      if (spare) { spare.hidden = !c || !spareShown; spare.setAttribute('aria-pressed', String(latched)); }
      if (latched === was) return;
      // Turning Stop on lets go of everything, so resetting it never starts anything again by itself. Letting go renders
      // every part, this one too, so the change is noted first and told once.
      const before = was; was = latched;
      if (latched && before === false && o.letGo !== false) letGo();
      if (o.onChange) safely(o.onChange, latched);
    };
    // Whether a tap in the middle of the screen's Stop reaches it. Without hit testing (no layout) it is taken to.
    const reachable = () => {
      if (typeof document.elementFromPoint !== 'function') return true;
      const r = button.getBoundingClientRect(); const at = r.width && r.height ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
      return !!at && (at === button || button.contains(at));
    };
    // A sheet opened, finished sliding in, or closed. A screen's own Stop that an open sheet covers (or that isn't on
    // the page) gets the kit's floating Stop beside it until every sheet is closed, so Stop is always one tap away.
    part.sheeted = () => {
      if (!o.button) return;
      if (![...sheets].some(x => x.open)) spareShown = false;
      else if (!spareShown && get() && !reachable()) {
        spareShown = true;
        if (!spare) { spare = document.body.appendChild(h('button', { class: 'mk-stop mk-spare', type: 'button', 'aria-label': 'Stop' }, 'Stop')); kept.add(spare); wire(spare); }
        if (!warned) { warned = true; if (window.console && console.warn) console.warn(STOP_WARNING); }
      }
      part.render();
    };
    part.dispose = () => { kept.delete(button); if (spare) { kept.delete(spare); spare.remove(); } };
    wire(button);
    if (reset) listen(part, reset, 'click', () => send(get(), false));
    return adopt(part);
  }

  /* ---------- Status strip: which phone this is, its tracking, the link and the connection ---------- */
  const TRACKING_WORDS = Object.freeze({ normal: 'Tracking good', limited: 'Tracking limited', initializing: 'Starting tracking', relocalizing: 'Finding its place', unavailable: 'No tracking' });
  const LINK_WORDS = Object.freeze({ good: 'Link good', fair: 'Link slow', poor: 'Link poor' });
  function strip(el, o) {
    o = o || {};
    el.classList.add('mk-strip');
    const meDot = h('i', { class: 'mk-dot' }), meText = h('span', {}, 'Connecting…');
    const me = h('span', { class: 'mk-chip mk-me' }, meDot, meText);
    const trackDot = h('i', { class: 'mk-dot' }), trackText = h('span', {}, 'Starting tracking');
    const tracking = h('span', { class: 'mk-chip mk-tracking' }, trackDot, trackText);
    const linkDot = h('i', { class: 'mk-dot' }), linkText = h('span');
    const link = h('span', { class: 'mk-chip mk-link', hidden: true }, linkDot, linkText);
    el.prepend(me, tracking, link);
    // A line across the top in this phone's color, the color the viewer draws it in.
    const rule = o.rule === false ? undefined : document.body.appendChild(h('div', { class: 'mk-rule', hidden: true }));
    const render = () => {
      const conn = last.connection, t = last.tracking, c = last.config, mine = c && c.phone; const live = !!conn && conn.state === 'connected';
      // A desktop mirror can follow a phone that is not connected; say so beside its name.
      const name = mine ? mine.name : conn && conn.gateway ? conn.gateway : '';
      setText(meText, conn && conn.state === 'reconnecting' ? (name ? name + ' · reconnecting' : 'Reconnecting…') : mine ? mine.name + (mine.connected === false ? ' · offline' : '') : live ? conn.gateway : 'Connecting…');
      me.classList.toggle('mk-off', !(live && (!mine || mine.connected !== false)));
      meDot.className = 'mk-dot' + (mine ? '' : live ? ' mk-good' : ' mk-bad'); meDot.style.background = mine ? mine.color : '';
      if (rule) { rule.hidden = !mine; rule.style.background = mine ? mine.color : ''; }
      const offline = !!mine && mine.connected === false; const state = offline ? 'unavailable' : t ? t.state : 'initializing';
      setText(trackText, offline ? 'No pose' : t && t.source === 'synthetic' ? 'Simulated motion' : TRACKING_WORDS[state] || state);
      trackDot.className = 'mk-dot ' + (state === 'normal' && (!t || t.source !== 'synthetic') ? 'mk-good' : state === 'unavailable' ? 'mk-bad' : 'mk-warn');
      // The round trip to the gateway, once the host measures it. Phones show it only when it is slow.
      const l = last.link; const quality = l ? l.quality || linkQuality(l.rttMs) : 'unknown';
      link.hidden = !live || !LINK_WORDS[quality]; link.setAttribute('data-quality', quality);
      if (!link.hidden) { setText(linkText, LINK_WORDS[quality] + (typeof l.rttMs === 'number' ? ' · ' + Math.round(l.rttMs) + ' ms' : '')); linkDot.className = 'mk-dot ' + { good: 'mk-good', fair: 'mk-warn', poor: 'mk-bad' }[quality]; }
    };
    const part = { el, me, tracking, link, rule, render, off: [] };
    for (const type of ['tracking', 'link']) part.off.push(on(type, render));
    return adopt(part);
  }

  /* ---------- Toasts, for replies and notices with no other home ---------- */
  let toastNode, toastTimer;
  function toast(text, o) {
    if (!text) return;
    o = o || {};
    if (!toastNode || !toastNode.isConnected) toastNode = document.body.appendChild(h('div', { class: 'mk-toast', role: 'status', hidden: true }));
    setText(toastNode, String(text));
    // Just above an element (the controls), so it never covers a thumb; otherwise where the stylesheet puts it.
    toastNode.style.bottom = o.above ? Math.max(24, window.innerHeight - o.above.getBoundingClientRect().top + 8) + 'px' : '';
    toastNode.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastNode.hidden = true; }, o.ms || 2600);
    return toastNode;
  }

  /* ---------- Robots: who is connected, what they last said, and whether they still answer ---------- */
  // A robot is stale when it has sent nothing for staleAfterMs(everyMs): since its last state, or since the page saw it
  // connect. Offline robots stay listed (connected: false) with their last state.
  const robotSince = {};
  function robotViews() {
    const now = Date.now(); const out = {};
    const info = (last.config && Array.isArray(last.config.robots)) ? last.config.robots : [];
    for (const r of info) if (r && typeof r.id === 'string') out[r.id] = { id: r.id, name: r.name || r.id, connected: !!r.connected, screen: !!r.screen };
    const map = last.robots && typeof last.robots === 'object' ? last.robots : {};
    for (const id of Object.keys(map)) {
      const r = map[id]; if (!r) continue;
      const view = out[id] || (out[id] = { id, name: r.name || id, connected: !!r.connected, screen: false });
      view.state = r.state; view.phoneState = r.phoneState; view.everyMs = r.everyMs; view.receivedAt = r.receivedAt;
    }
    for (const id of Object.keys(out)) {
      const v = out[id];
      if (v.connected) { if (!robotSince[id]) robotSince[id] = now; } else delete robotSince[id];
      v.offline = !v.connected;
      v.values = Object.assign({}, v.state || {}, v.phoneState || {});
      v.ageMs = typeof v.receivedAt === 'number' ? Math.max(0, now - v.receivedAt) : undefined;
      v.staleAfterMs = staleAfterMs(v.everyMs);
      v.stale = v.connected && now - Math.max(v.receivedAt || 0, robotSince[id] || 0) > v.staleAfterMs;
    }
    return out;
  }
  const robotSubs = new Set();
  let robotTimer, robotKey = '';
  function deliverRobots(force) {
    const views = robotViews();
    const key = JSON.stringify(Object.keys(views).map(id => { const v = views[id]; return [id, v.name, v.connected, v.screen, v.stale, v.receivedAt]; }));
    if (!force && key === robotKey) return;
    robotKey = key;
    for (const fn of [...robotSubs]) safely(fn, views);
  }
  on('robots', () => deliverRobots()); on('config', () => deliverRobots());
  /** Calls `fn(robots)` with every robot's view now and whenever one changes, answers, goes stale or goes offline. */
  function robots(fn) {
    robotSubs.add(fn);
    if (!robotTimer) robotTimer = setInterval(() => { if (robotSubs.size) deliverRobots(); }, 250);
    safely(fn, robotViews());
    return () => { robotSubs.delete(fn); if (!robotSubs.size && robotTimer) { clearInterval(robotTimer); robotTimer = undefined; } };
  }
  // The robot whose screen this is, else the first connected one, else the first.
  const pickRobot = (views, id) => { if (id) return views[id]; const list = Object.keys(views).map(k => views[k]); return list.find(r => r.screen) || list.find(r => r.connected) || list[0]; };
  /** Calls `fn(robot)` with one robot (by id, or the screen's own) or undefined while there is none. */
  function robot(id, fn) {
    if (typeof id === 'function') { fn = id; id = undefined; }
    let shown;
    return robots(views => { const r = pickRobot(views, id); const key = r ? JSON.stringify([r.id, r.name, r.connected, r.stale, r.receivedAt]) : ''; if (key === shown) return; shown = key; fn(r); });
  }

  /* ---------- Cameras: the panes of the view this phone picked, JPEG or WebRTC per stream ---------- */
  // Panes sit side by side, never cropped; with several, a tap (or Enter) stacks them full width. A stream goes over
  // WebRTC when the host lists `rtc` and the gateway marks the stream `transport: 'webrtc'`; otherwise it shows the
  // `camera_frame` JPEGs, as before. The robot offers; the page answers once its ICE candidates are gathered.
  // A picture is live only while new frames keep coming: a JPEG or a video frame in the last 2 s, so a frozen picture
  // never looks live.
  const RTC_RETRY_MS = 2000, RTC_RETRY_MAX_MS = 10000, RTC_ICE_WAIT_MS = 2000, RTC_OFFER_WAIT_MS = 10000, FRAME_FRESH_MS = 2000;
  const randomId = () => Math.random().toString(36).slice(2, 10);
  // How many frames a video has decoded, where the browser counts them.
  function framesDecoded(video) {
    try { const q = typeof video.getVideoPlaybackQuality === 'function' && video.getVideoPlaybackQuality(); if (q && q.totalVideoFrames > 0) return q.totalVideoFrames; } catch (x) { /* not counted here */ }
    return video.webkitDecodedFrameCount > 0 ? video.webkitDecodedFrameCount : undefined;
  }
  function cameras(el, o) {
    o = o || {}; const action = o.action || ACTIONS.view;
    el.classList.add('mk-cams');
    let key = '', warned = false;
    const panes = new Map();   // stream id → pane
    const peers = new Map();   // peer name → pane, for signaling
    const abandoned = [];      // peers given up before their offer arrived; a late offer gets a close
    const frameAt = {};
    const view = () => {
      const c = last.config; if (!c) return undefined;
      const pick = c.controls.find(x => x.action === action); const views = c.cameraViews || [];
      return views.find(v => pick && v.id === pick.value) || views[0];
    };
    const info = id => { const c = last.config; return c && (c.cameraStreams || []).find(x => x.id === id); };
    // The gateway sends this phone the JPEG frames of the view its camera.view control picks, whatever `action` picks.
    const warnJpeg = p => {
      const c = last.config; if (warned || action === ACTIONS.view || !c) return;
      const pick = c.controls.find(x => x.action === ACTIONS.view); const views = c.cameraViews || [];
      const sent = views.find(v => pick && v.id === pick.value) || views[0];
      if (sent && sent.streams.indexOf(p.id) >= 0) return;
      warned = true;
      if (window.console && console.warn) console.warn('[marionette-kit] cameras(): the ' + p.label + ' pane gets no JPEG frames. The gateway sends a phone the JPEG frames of the view its ' + ACTIONS.view + ' control picks, not the view `' + action + '` picks; only WebRTC panes follow `action`.');
    };
    const rtcWanted = p => { const s = info(p.id); return !!s && s.transport === 'webrtc' && has('rtc') && typeof window.RTCPeerConnection === 'function' && !document.hidden && !linkDown(); };
    const signal = message => { const M = window.Marionette; if (M && typeof M.rtc === 'function') M.rtc(message); };
    const emptyText = (p, state) => (o.empty ? o.empty(p.id, p.label, state) : state === 'unavailable' ? p.label + ' unavailable, retrying' : 'Waiting for ' + p.label.toLowerCase());

    function rebuild(v) {
      for (const p of panes.values()) stopRtc(p, true, true);
      panes.clear();
      const many = v.streams.length > 1;
      el.style.setProperty('--panes', v.streams.length); el.setAttribute('data-panes', String(v.streams.length));
      for (const [name, value] of [['role', 'button'], ['tabindex', '0'], ['aria-label', 'Cameras, tap to show them larger or smaller']]) { if (many) el.setAttribute(name, value); else el.removeAttribute(name); }
      if (many) el.setAttribute('aria-expanded', el.getAttribute('aria-expanded') === 'true' ? 'true' : 'false'); else el.removeAttribute('aria-expanded');
      el.replaceChildren(...v.streams.map(id => {
        const s = info(id); const label = s ? s.label : id;
        const p = { id, label, backoff: RTC_RETRY_MS, img: h('img', { alt: label + ' camera', hidden: true }), empty: h('div', { class: 'mk-empty' }), caption: h('figcaption', { hidden: true }, label) };
        p.el = h('div', { class: 'mk-pane', 'data-stream': id }, p.img, p.empty, p.caption);
        panes.set(id, p); return p.el;
      }));
    }
    function render() {
      const v = view(); el.hidden = !v;
      if (!v) { if (key) { for (const p of panes.values()) stopRtc(p, true, true); panes.clear(); el.replaceChildren(); key = ''; } return; }
      const k = v.id + ':' + v.streams.join(',');
      // A pane rebuilt for a view switched back to has no picture yet, even if its stream was live a moment ago.
      if (k !== key) { key = k; rebuild(v); }
      const now = Date.now();
      for (const p of panes.values()) {
        const s = info(p.id); const wanted = rtcWanted(p); const publisher = s && s.publisher;
        // Without the gateway there is no one to tell; it closes the robot's end itself.
        if (p.rtc && (!wanted || p.rtc.publisher !== publisher)) stopRtc(p, !linkDown());
        if (wanted && !p.rtc && !p.retry) startRtc(p, publisher);
        if (!wanted) { p.backoff = RTC_RETRY_MS; if (p.retry) { clearTimeout(p.retry); p.retry = undefined; } p.failed = false; warnJpeg(p); }
        const r = p.rtc;
        // Besides requestVideoFrameCallback, the decoded frame count (checked at least once a second) says whether frames
        // still come. Without either, how far the video has played, which a frozen live stream can keep advancing.
        if (r && r.live && p.video) {
          const count = framesDecoded(p.video); const mark = count !== undefined ? count : r.watched ? undefined : p.video.currentTime;
          if (mark !== undefined && mark !== r.shown) { r.shown = mark; r.frameAt = now; }
        }
        // Playing, connected (ICE `disconnected` is not), and a frame in the last 2 s.
        const video = !!r && r.live && !r.down && now - r.frameAt < FRAME_FRESH_MS;
        const jpeg = !video && !!p.img.getAttribute('src') && now - (frameAt[p.id] || 0) < FRAME_FRESH_MS;
        const state = video || jpeg ? 'live' : p.failed ? 'unavailable' : 'waiting';
        // A video that stalls stays on the page under the opaque empty pane, so the browser keeps telling when its
        // frames come back; it never shows while the pane is not live.
        p.img.hidden = !jpeg; if (p.video) p.video.hidden = !(r && r.live) || jpeg;
        p.empty.hidden = state === 'live'; p.caption.hidden = state !== 'live';
        setText(p.empty, emptyText(p, state));
        p.el.setAttribute('data-transport', p.rtc || wanted ? 'webrtc' : 'jpeg'); p.el.setAttribute('data-state', state);
      }
    }

    function startRtc(p, publisher) {
      const r = { peer: (p.id.replace(/[^\w.-]/g, '').slice(0, 40) || 'cam') + '-' + randomId(), publisher, live: false, down: false, frameAt: 0, candidates: [] };
      p.rtc = r; peers.set(r.peer, p);
      signal({ kind: 'request', stream: p.id, peer: r.peer });
      r.offerTimer = setTimeout(() => { if (p.rtc === r) failRtc(p, 'no offer'); }, RTC_OFFER_WAIT_MS);
    }
    // Ends a pane's connection: tells the robot (unless it is the one that closed), and forgets the peer.
    function stopRtc(p, tell, keepBackoff) {
      const r = p.rtc; if (!r) return;
      p.rtc = undefined; peers.delete(r.peer); clearTimeout(r.offerTimer);
      if (tell && r.to) signal({ kind: 'close', to: r.to, peer: r.peer });
      else if (!r.to) { abandoned.push(r.peer); if (abandoned.length > 32) abandoned.shift(); }
      if (r.pc) { r.closed = true; try { r.pc.close(); } catch (x) { /* already closed */ } }
      if (p.video) { p.video.hidden = true; try { p.video.srcObject = null; } catch (x) { /* nothing to clear */ } }
      if (!keepBackoff) p.backoff = RTC_RETRY_MS;
    }
    // The connection failed, was refused or was closed: show the pane as unavailable and try again later, while the
    // stream stays in view and on WebRTC (2 s, doubling to 10 s).
    function failRtc(p, why, closedByPeer) {
      if (!p.rtc) return;
      stopRtc(p, !closedByPeer, true);
      p.failed = true; p.why = why;
      if (p.retry) clearTimeout(p.retry);
      const delay = p.backoff; p.backoff = Math.min(p.backoff * 2, RTC_RETRY_MAX_MS);
      p.retry = setTimeout(() => { p.retry = undefined; if (panes.get(p.id) === p) render(); }, delay);
      render();
    }
    function iceGathered(pc) {
      return new Promise(done => {
        if (pc.iceGatheringState === 'complete') { done(); return; }
        const finish = () => { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', check); done(); };
        const check = () => { if (pc.iceGatheringState === 'complete') finish(); };
        const timer = setTimeout(finish, RTC_ICE_WAIT_MS);
        pc.addEventListener('icegatheringstatechange', check);
      });
    }
    async function answer(p, m) {
      const r = p.rtc; if (!r || r.pc) return;
      clearTimeout(r.offerTimer); r.to = m.from;
      const pc = r.pc = new window.RTCPeerConnection({ iceServers: o.iceServers || [] });
      pc.addEventListener('track', e => {
        if (p.rtc !== r) return;
        if (!p.video) { p.video = h('video', { autoplay: true, playsinline: true, muted: true, 'webkit-playsinline': true, hidden: true }); p.video.muted = true; p.el.insertBefore(p.video, p.empty); }
        const video = p.video; const media = (e.streams && e.streams[0]) || (typeof window.MediaStream === 'function' ? new window.MediaStream([e.track]) : undefined);
        if (media && video.srcObject !== media) video.srcObject = media;
        video.onplaying = () => { if (p.rtc === r) { r.live = true; r.frameAt = Date.now(); p.failed = false; p.backoff = RTC_RETRY_MS; render(); } };
        // Every new frame keeps the pane live; one that comes after a stall brings it back at once.
        if (typeof video.requestVideoFrameCallback === 'function' && !r.watched) {
          r.watched = true;
          const frame = () => { if (p.rtc !== r) return; const stale = Date.now() - r.frameAt >= FRAME_FRESH_MS; r.frameAt = Date.now(); if (stale && r.live) render(); video.requestVideoFrameCallback(frame); };
          video.requestVideoFrameCallback(frame);
        }
        const playing = video.play && video.play(); if (playing && playing.catch) playing.catch(() => {});
      });
      // ICE `disconnected` (often a network blip that comes back) is not live; `failed` and `closed` end the connection.
      const ice = () => {
        if (p.rtc !== r || r.closed) return;
        const down = pc.connectionState === 'disconnected' || pc.iceConnectionState === 'disconnected';
        if (down !== r.down) { r.down = down; render(); }
      };
      pc.addEventListener('connectionstatechange', () => {
        if (p.rtc !== r || r.closed) return;
        if (pc.connectionState === 'connected') p.backoff = RTC_RETRY_MS;
        else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') { failRtc(p, pc.connectionState); return; }
        ice();
      });
      pc.addEventListener('iceconnectionstatechange', ice);
      try {
        await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
        for (const candidate of r.candidates.splice(0)) pc.addIceCandidate(candidate).catch(() => {});
        await pc.setLocalDescription(await pc.createAnswer());
        // Non-trickle: answer once the candidates are in the SDP, or after 2 s with what there is.
        await iceGathered(pc);
        if (p.rtc !== r) return;
        signal({ kind: 'answer', to: r.to, peer: r.peer, sdp: pc.localDescription ? pc.localDescription.sdp : '' });
      } catch (error) { if (p.rtc === r) failRtc(p, String(error && error.message || error)); }
    }
    const offRtc = on('rtc', m => {
      if (!m || typeof m.peer !== 'string') return;
      const p = peers.get(m.peer);
      if (!p) { if (m.kind === 'offer' && m.from && abandoned.indexOf(m.peer) >= 0) signal({ kind: 'close', to: m.from, peer: m.peer }); return; }
      const r = p.rtc;
      if (m.kind === 'offer' && typeof m.sdp === 'string') answer(p, m);
      else if (m.kind === 'candidate' && m.candidate) { if (r.pc && r.pc.remoteDescription) r.pc.addIceCandidate(m.candidate).catch(() => {}); else r.candidates.push(m.candidate); }
      else if (m.kind === 'error' || m.kind === 'close') failRtc(p, m.message || m.kind, m.kind === 'close');
    });
    const offFrame = on('camera_frame', m => {
      if (!m || !panes.has(m.cameraId)) return;
      const p = panes.get(m.cameraId); p.img.src = m.dataUrl;
      const fresh = Date.now() - (frameAt[m.cameraId] || 0) >= FRAME_FRESH_MS; frameAt[m.cameraId] = Date.now(); if (fresh) render();
    });
    const toggle = () => { if (el.getAttribute('role') !== 'button') return; el.setAttribute('aria-expanded', String(el.getAttribute('aria-expanded') !== 'true')); };
    const part = { el, render, panes };
    listen(part, el, 'click', toggle);
    listen(part, el, 'keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    // Hidden page: close every connection; visible again: ask again. A lost gateway takes the signaling with it,
    // so connections are dropped quietly and asked for again once it is back.
    listen(part, document, 'visibilitychange', () => { if (document.hidden) for (const p of panes.values()) stopRtc(p, true); render(); });
    const offConnection = on('connection', c => { if (c && c.state !== 'connected') for (const p of panes.values()) { stopRtc(p, false); if (p.retry) { clearTimeout(p.retry); p.retry = undefined; } } render(); });
    const offConfig = on('config', render);
    const timer = setInterval(render, 1000);
    part.dispose = () => { for (const p of panes.values()) { stopRtc(p, true); if (p.retry) clearTimeout(p.retry); } offRtc(); offFrame(); offConnection(); offConfig(); clearInterval(timer); };
    return adopt(part, o);
  }

  /* ---------- Sheets: full-screen panels (calibration, a More sheet); one at a time ---------- */
  const sheets = new Set();
  // Elements a sheet never makes inert, wherever they are: every Stop button and every sheet, plus the kit's overlays.
  const kept = new Set();
  const OVERLAYS = '.mk-stop,.mk-sheet,.mk-toast,.mk-rule';
  const spared = n => kept.has(n) || n.matches(OVERLAYS + ',script,style,link,template');
  const holdsSpared = n => !!n.querySelector(OVERLAYS) || [...kept].some(k => k !== n && n.contains(k));
  // What a sheet covers: everything on the page (or what the screen names) but the kept elements. An element with a
  // kept one inside stays as it is and its other children are covered instead, down to the kept one.
  function cover(list) {
    const covered = [];
    const visit = n => {
      if (!n || n.nodeType !== 1 || spared(n)) return;
      if (holdsSpared(n)) { for (const child of Array.from(n.children)) visit(child); return; }
      if (!n.hasAttribute('inert')) { n.setAttribute('inert', ''); covered.push(n); }
    };
    for (const n of list ? [].concat(list) : Array.from(document.body.children)) visit(n);
    return covered;
  }
  function sheet(o) {
    o = o || {};
    const el = o.el || document.body.appendChild(h('section', { class: 'mk-sheet', role: 'dialog', 'aria-modal': 'true', hidden: true }));
    el.classList.add('mk-sheet'); kept.add(el);
    let open = false, covered = [];
    const api = {
      el,
      get open() { return open; },
      /** Opens the sheet (closing any other) with `children`, or replaces what it shows. Opening lets go of everything. */
      show(children) {
        const opening = !open;
        if (opening) {
          for (const other of [...sheets]) if (other !== api && other.open) other.hide();
          open = true; letGo(); covered = cover(o.covers); el.hidden = false;
        }
        if (children !== undefined) el.replaceChildren(...[].concat(children).flat(Infinity).filter(x => x != null && x !== false));
        // Stop checks whether the sheet covers it once the sheet is laid out, and again once it has slid in.
        if (opening) tell('sheeted');
        return api;
      },
      hide() {
        if (!open) return; open = false; el.hidden = true; el.replaceChildren();
        for (const n of covered) n.removeAttribute('inert'); covered = [];
        tell('sheeted');
        if (o.onHide) safely(o.onHide);
      },
    };
    for (const name of ['animationend', 'transitionend']) el.addEventListener(name, e => { if (open && e.target === el) tell('sheeted'); });
    sheets.add(api);
    return api;
  }
  /** A sheet's top bar: a button on the left, a title (with a count under it), and room on the right for Stop. */
  const sheetTop = (left, title, count, onLeft) => h('div', { class: 'mk-sheet-top' }, h('button', { type: 'button', class: 'mk-left', onclick: onLeft }, left), h('b', {}, title, count ? h('small', {}, count) : null), h('span'));

  /* ---------- Calibration: guided calibration, quick origin and the optional validation, in a sheet ---------- */
  const STEPS = ['flat', 'forward', 'right', 'up'];
  const MOVES = ['forward', 'right', 'up'];
  // FLAT_DEG matches the gateway's FLAT_TOLERANCE_DEGREES.
  const MIN_MM = 30, TARGET_MM = 100, FLAT_DEG = 30;
  // Like the gateway: calibration is a rough axis alignment, so limited tracking is fine.
  const canCalibrate = (tracking, source) => source !== 'synthetic' && (tracking === 'normal' || tracking === 'limited');
  // Operator frame (ROS REP-103): +X forward, +Y left, +Z up. Validation expects these signs.
  const EXPECTED = { forward: ['x', 1], right: ['y', -1], up: ['z', 1] };
  const AXIS_WORDS = Object.freeze({ '+X': 'forward', '-X': 'back', '+Y': 'left', '-Y': 'right', '+Z': 'up', '-Z': 'down' });
  const CALIBRATION_COPY = {
    row: 'Calibration',
    introTitle: 'Teach it which way is forward', introDone: 'Calibrated',
    introBody: 'Four short moves with the phone in your hand: flat, forward, right, up. It takes about a minute and sets which way is forward for this phone’s pose.',
    nowUsing: 'Now using', startPosition: 'the phone’s start position',
    start: 'Start calibration', again: 'Calibrate again', validate: 'Validate', origin: 'Set origin here', reset: 'Reset',
    steps: {
      flat: { title: 'Hold it flat', body: 'In your hand is fine. Roughly flat, screen up, top edge pointing the way you want forward.', cta: 'Capture flat' },
      forward: { title: 'Move it forward', body: 'Keep it roughly flat and move it straight ahead, about a hand’s length.', cta: 'Capture forward' },
      right: { title: 'Back, then move right', body: 'Return to the flat spot, then move straight to your right.', cta: 'Capture right' },
      up: { title: 'Back, then lift it', body: 'Return to the flat spot, then lift it straight up.', cta: 'Capture up' },
    },
    capturedTitle: 'Calibrated', capturedBody: 'Forward, left and up now follow how you held the phone.', done: 'Done', validateOptional: 'Validate (optional)',
    moves: {
      forward: { title: 'Move it forward', body: 'Bring it back to the flat spot, then move it straight ahead about 10 cm.' },
      right: { title: 'Move it right', body: 'Back at the flat spot, then move it straight to your right about 10 cm.' },
      up: { title: 'Lift it up', body: 'Back at the flat spot, then lift it straight up about 10 cm.' },
    },
    validatedTitle: 'Validated ✓', failedTitle: 'That didn’t line up', validatedBody: 'Forward, right and up each moved along the axis they should.',
    failedBody: ' Calibrate again and keep each move straight.', notNow: 'Not now',
    notes: {
      flatReady: 'flat enough, capture when ready', flatter: 'hold it flatter, screen up', backFirst: 'go back to the flat spot first',
      enough: 'that’s enough, capture when steady', minimum: MIN_MM + ' mm is enough to capture', waiting: 'waiting for tracking',
      limited: 'tracking is limited, hold the phone up so the camera sees the room', startFlat: 'start from the flat spot',
      moving: (direction, travel) => 'moving ' + direction + ', ' + travel + ' mm',
      wrongWay: (direction, travel) => travel + ' mm ' + direction + ' of the flat spot, go back to it first',
    },
  };
  const isPlain = x => !!x && typeof x === 'object' && !Array.isArray(x);
  function merge(base, extra) { const out = Object.assign({}, base); for (const k of Object.keys(extra || {})) out[k] = isPlain(base[k]) && isPlain(extra[k]) ? merge(base[k], extra[k]) : extra[k]; return out; }
  const rotate = (q, v) => { const { x, y, z, w } = q; const ix = w * v.x + y * v.z - z * v.y, iy = w * v.y + z * v.x - x * v.z, iz = w * v.z + x * v.y - y * v.x, iw = -x * v.x - y * v.y - z * v.z; return { x: ix * w + iw * -x + iy * -z - iz * -y, y: iy * w + iw * -y + iz * -x - ix * -z, z: iz * w + iw * -z + ix * -y - iy * -x }; };
  const conjugate = q => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
  const dominant = v => { const [axis, value] = [['X', v.x], ['Y', v.y], ['Z', v.z]].reduce((a, b) => (Math.abs(b[1]) > Math.abs(a[1]) ? b : a)); return (value < 0 ? '-' : '+') + axis; };
  // A drawn table seen from the operator's side: f is forward (into the page), r is right, u is up; 1 unit ≈ 1.4 mm.
  const P = (f, r, u) => [160 + r + 0.55 * f, 160 - 0.42 * f - u];
  const pt = (f, r, u) => P(f, r, u).map(n => n.toFixed(1)).join(' ');
  const poly = corners => 'M' + corners.map(c => pt(...c)).join(' L') + ' Z';
  const phoneShape = (f, r, u) => poly([[f + 40, r - 20, u], [f + 40, r + 20, u], [f - 40, r + 20, u], [f - 40, r - 20, u]]);
  const screenShape = (f, r, u) => poly([[f + 31, r - 15, u], [f + 31, r + 15, u], [f - 33, r + 15, u], [f - 33, r - 15, u]]);
  // A short speaker slot marks the top edge, the one that should point forward.
  const slotShape = (f, r, u) => 'M' + pt(f + 36, r - 6, u) + ' L' + pt(f + 36, r + 6, u);
  function arrow(from, to, color, label, labelAt) {
    const [x1, y1] = P(...from), [x2, y2] = P(...to); const a = Math.atan2(y2 - y1, x2 - x1); const head = 10;
    const wing = d => [x2 - head * Math.cos(a + d), y2 - head * Math.sin(a + d)].map(n => n.toFixed(1)).join(' ');
    const [lx, ly] = labelAt ? P(...labelAt) : [x2 + 6, y2 - 4];
    return `<path class="mk-line" stroke="${color}" stroke-width="2.4" d="M${x1.toFixed(1)} ${y1.toFixed(1)} L${x2.toFixed(1)} ${y2.toFixed(1)} M${wing(0.45)} L${x2.toFixed(1)} ${y2.toFixed(1)} L${wing(-0.45)}"/>` + (label ? `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" fill="${color}">${label}</text>` : '');
  }
  const TARGET = { forward: [70, 0, 0], right: [0, 70, 0], up: [0, 0, 70] };
  function scene(kind) {
    const table = `<path class="mk-line" stroke="#9aa1a6" stroke-width="1.4" d="${poly([[-70, -110, 0], [-70, 110, 0], [115, 110, 0], [115, -110, 0]])}"/>`;
    let marks = '';
    if (kind === 'flat') marks = arrow([40, 0, 0], [100, 0, 0], 'var(--red)', 'forward', [104, -6, 0]) + arrow([0, -20, 0], [0, -84, 0], 'var(--green)', 'left', [0, -124, 6]) + arrow([0, 0, 0], [0, 0, 84], 'var(--blue)', 'up', [0, 8, 86]);
    else {
      const target = TARGET[kind];
      marks = `<path class="mk-line" stroke="#6b6f73" stroke-width="1.4" stroke-dasharray="4 5" d="${phoneShape(...target)}"/>`;
      if (kind === 'up') marks = `<path class="mk-line" stroke="#cfd3d6" stroke-width="1.2" stroke-dasharray="2 4" d="${phoneShape(0, 0, 0)}"/>` + marks;
      marks += arrow([0, 0, 0], kind === 'up' ? [0, 0, 56] : kind === 'right' ? [0, 52, 0] : [52, 0, 0], 'var(--blue)', kind, kind === 'up' ? [0, -54, 60] : kind === 'right' ? [-14, 76, 0] : [60, 26, 0]);
    }
    const note = kind === 'flat' ? 'top edge points forward, screen up' : '';
    return `<svg class="mk-ill" viewBox="0 0 340 230" role="img" aria-label="${kind}">
      <defs><filter id="mk-pencil"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="1" seed="3"/><feDisplacementMap in="SourceGraphic" scale="1.6"/></filter></defs>
      <g filter="url(#mk-pencil)">${table}</g>
      <g class="mk-live-phone"><path class="mk-line mk-live-body" stroke="#2e3033" stroke-width="2" fill="#fff" d="${phoneShape(0, 0, 0)}"/><path class="mk-live-screen" fill="#e9edf2" d="${screenShape(0, 0, 0)}"/><path class="mk-line mk-live-slot" stroke="#2e3033" stroke-width="2" d="${slotShape(0, 0, 0)}"/></g>
      <g filter="url(#mk-pencil)">${marks}</g>
      ${note ? `<text x="20" y="220" fill="#6b6f73" style="font-size:15px">${note}</text>` : ''}
    </svg>`;
  }
  const CALIBRATION_KEYS = ['start', 'capture', 'cancel', 'check', 'origin', 'clear'];

  function calibration(o) {
    o = o || {};
    const copy = merge(CALIBRATION_COPY, o.copy);
    const A = merge(ACTIONS, o.actions);
    // The actions whose replies are calibration's, with any the screen renamed.
    const mine = new Set(CALIBRATION_KEYS.map(name => A[name]));
    const cal = () => (last.config ? last.config.calibration : { status: 'uncalibrated', epoch: 0 });
    const ctl = name => control(A[name]);
    // shown: the sheet on screen (intro, capture, captured, validate, validated); reply: the gateway's last answer.
    let shown, reply, key = '', ui = {}, before, forwardAt, posePending = false;
    const sh = sheet({ el: o.sheet, covers: o.covers, onHide: () => { shown = undefined; reply = undefined; key = ''; ui = {}; } });

    function summary() {
      const c = cal(); const check = c.check;
      if (c.status === 'capturing') return ['Calibrating', ''];
      if (c.status !== 'captured') return ['Not calibrated', ''];
      const kind = c.reference && c.reference.mode === 'quick' ? 'Quick origin' : 'Guided';
      if (check && check.step) return [kind + ', validating', ''];
      if (check && check.passed === true) return [kind + ', validated ✓', 'ok'];
      if (check && check.passed === false) return [kind + ', validation failed', 'bad'];
      return [kind, ''];
    }
    const runMode = () => { const c = cal(); return c.status === 'capturing' ? 'capture' : c.check && c.check.step ? 'validate' : undefined; };
    function open(mode) { shown = mode || 'intro'; reply = undefined; render(true); }
    function close() { shown = undefined; reply = undefined; render(true); }
    function render(force) {
      const run = runMode();
      // The gateway drives capture and validation, so a run started from the desktop opens the sheet here too, once
      // the operator has let go of everything (it would cover what they are holding).
      if (run && shown !== run) { if (busy() && !shown) { sh.hide(); return; } shown = run; }
      const mode = run || shown;
      if (!mode) { sh.hide(); return; }
      const c = cal();
      const k = JSON.stringify([mode, c.status, c.step, c.check, c.reference && c.reference.epoch, reply, !!ctl('check'), !!ctl('origin'), !!ctl('clear')]);
      if (!force && k === key && sh.open) { live(); return; }
      ui = {};
      sh.show(VIEWS[mode]()); key = k; shown = mode;
      live();
    }
    const replyNode = () => (reply ? h('p', { class: 'mk-reply' + (reply.bad ? ' mk-bad' : ''), role: 'status' }, reply.text) : null);
    const ask = name => () => { reply = undefined; send(ctl(name)); };
    function drawing(kind) { const node = svg(scene(kind)); ui.body = node.querySelector('.mk-live-body'); ui.screen = node.querySelector('.mk-live-screen'); ui.slot = node.querySelector('.mk-live-slot'); return node; }
    function placePhone(f, r, u) { if (!ui.body) return; ui.body.setAttribute('d', phoneShape(f, r, u)); ui.screen.setAttribute('d', screenShape(f, r, u)); ui.slot.setAttribute('d', slotShape(f, r, u)); }
    function stepTrack(list, current, done) {
      return h('div', { class: 'mk-track' }, list.map(name => { const state = done(name); return h('span', { class: name === current ? 'mk-cur' : state ? 'mk-' + state : '' }, name === current ? h('em', {}, cap(name)) : cap(name) + (state === 'pass' ? ' ✓' : state === 'fail' ? ' ✗' : '')); }));
    }
    const resultState = move => { const r = (cal().check || { results: [] }).results.find(x => x.move === move); return r ? (r.passed ? 'pass' : 'fail') : ''; };
    const VIEWS = {
      intro() {
        const c = cal(); const [text, tone] = summary(); const calibrated = c.status === 'captured';
        return [
          sheetTop('Close', 'Calibration', '', close),
          drawing('flat'),
          h('div', { class: 'mk-sheet-body' },
            h('h2', { class: 'mk-title' }, calibrated ? copy.introDone : copy.introTitle),
            h('p', { class: 'mk-body' }, copy.introBody),
            h('div', { class: 'mk-frame-status' }, h('span', {}, copy.nowUsing), h('b', { class: tone ? 'mk-' + tone : '' }, text === 'Not calibrated' ? copy.startPosition : text)),
            replyNode()),
          h('div', { class: 'mk-sheet-foot' },
            ctl('start') && h('button', { type: 'button', class: 'mk-cta', onclick: ask('start') }, calibrated ? copy.again : copy.start),
            calibrated && ctl('check') && h('button', { type: 'button', class: 'mk-cta mk-quiet', onclick: ask('check') }, copy.validate),
            h('div', { class: 'mk-links' },
              ctl('origin') && h('button', { type: 'button', onclick: () => send(ctl('origin')) }, copy.origin),
              calibrated && ctl('clear') && h('button', { type: 'button', class: 'mk-danger', onclick: () => send(ctl('clear')) }, copy.reset))),
        ];
      },
      capture() {
        const step = cal().step || 'flat'; const index = STEPS.indexOf(step); const text = copy.steps[step] || {};
        ui.label = h('span'); ui.value = h('b'); ui.unit = h('span'); ui.fill = h('i'); ui.tick = h('s'); ui.note = h('p', { class: 'mk-note' });
        ui.meter = h('div', { class: 'mk-meter' }, h('div', { class: 'mk-meter-top' }, ui.label, h('span', {}, ui.value, ui.unit)), h('div', { class: 'mk-meter-bar' }, ui.fill, ui.tick), ui.note);
        ui.cta = h('button', { type: 'button', class: 'mk-cta', onclick: () => send(ctl('capture'), step) }, text.cta);
        return [
          sheetTop('Cancel', 'Calibrate', (index + 1) + ' of 4', () => { send(ctl('cancel')); close(); }),
          stepTrack(STEPS, step, name => (STEPS.indexOf(name) < index ? 'done' : '')),
          drawing(step),
          h('div', { class: 'mk-sheet-body' }, h('h2', { class: 'mk-title' }, text.title), h('p', { class: 'mk-body' }, text.body), ui.meter, replyNode()),
          h('div', { class: 'mk-sheet-foot' }, ui.cta),
        ];
      },
      captured() {
        return [
          sheetTop('Close', 'Calibrate', '', close),
          drawing('flat'),
          h('div', { class: 'mk-sheet-body' }, h('h2', { class: 'mk-title' }, copy.capturedTitle), h('p', { class: 'mk-body' }, copy.capturedBody), replyNode()),
          h('div', { class: 'mk-sheet-foot' },
            h('button', { type: 'button', class: 'mk-cta', onclick: close }, copy.done),
            ctl('check') && h('button', { type: 'button', class: 'mk-cta mk-quiet', onclick: ask('check') }, copy.validateOptional)),
        ];
      },
      validate() {
        const move = cal().check.step; const index = MOVES.indexOf(move); const text = copy.moves[move] || {};
        ui.axes = {};
        const axes = h('div', { class: 'mk-axes' }, [['x', 'forward', 'var(--red)'], ['y', 'left', 'var(--green)'], ['z', 'up', 'var(--blue)']].map(([axis, word, color]) => {
          const bar = h('i', { style: 'background:' + color }); const value = h('b'); const row = h('div', { class: 'mk-axis' }, h('span', {}, word), h('span', { class: 'mk-bar' }, bar), value);
          ui.axes[axis] = { row, bar, value }; return row;
        }));
        ui.axesNote = h('p', { class: 'mk-note' });
        ui.cta = h('button', { type: 'button', class: 'mk-cta', onclick: () => send(ctl('check'), move) }, 'Check ' + move);
        return [
          sheetTop('Cancel', 'Validate', (index + 1) + ' of 3', () => { send(ctl('check'), 'cancel'); close(); }),
          stepTrack(MOVES, move, resultState),
          drawing(move),
          h('div', { class: 'mk-sheet-body' }, h('h2', { class: 'mk-title' }, text.title), h('p', { class: 'mk-body' }, text.body), axes, ui.axesNote, replyNode()),
          h('div', { class: 'mk-sheet-foot' }, ui.cta),
        ];
      },
      validated() {
        const check = cal().check || { results: [] }; const passed = check.passed; const failed = check.results.filter(r => !r.passed);
        return [
          sheetTop('Close', 'Validate', '', close),
          stepTrack(MOVES, undefined, resultState),
          h('div', { class: 'mk-sheet-body' },
            h('h2', { class: 'mk-title' + (passed ? ' mk-ok' : ' mk-bad') }, passed ? copy.validatedTitle : copy.failedTitle),
            h('p', { class: 'mk-body' }, passed ? copy.validatedBody : failed.map(r => cap(r.move) + ' went ' + AXIS_WORDS[r.dominant] + '.').join(' ') + copy.failedBody),
            h('ul', { class: 'mk-results' }, check.results.map(r => { const d = r.displacement; const along = Math.round(Math.hypot(d.x, d.y, d.z) * 1000); return h('li', {}, h('span', {}, cap(r.move)), h('span', { class: r.passed ? 'mk-ok' : 'mk-bad' }, AXIS_WORDS[r.dominant] + ' (' + r.dominant.replace('-', '−') + '), ' + along + ' mm ' + (r.passed ? '✓' : '✗'))); }))),
          h('div', { class: 'mk-sheet-foot' },
            h('button', { type: 'button', class: 'mk-cta', onclick: passed ? close : ask('start') }, passed ? copy.done : copy.again),
            !passed && h('button', { type: 'button', class: 'mk-cta mk-quiet', onclick: close }, copy.notNow)),
        ];
      },
    };
    // Where the screen faces, in operator axes (Z is up). A calibrated pose's rotation is measured from the
    // calibration's flat capture, so put that capture's own orientation back before comparing with gravity.
    function screenDirection(p) {
      const ref = cal().reference; let v = { x: 0, y: 0, z: 1 };
      if (ref && p.calibrationVersion === ref.mode + '-v2:' + ref.epoch) v = rotate(conjugate(ref.frame), rotate(ref.rotation, v));
      return rotate(p.rotation, v);
    }
    // The live parts of the sheet, updated with every pose.
    function live() {
      if (!sh.open) return;
      const mode = runMode() || shown; const p = last.pose; const c = cal(); const t = last.tracking; const notes = copy.notes;
      const tracking = t ? t.state : p ? p.trackingState : 'initializing';
      const usable = canCalibrate(tracking, t ? t.source : p && p.source);
      if (ui.cta) ui.cta.disabled = !usable;
      if (mode === 'capture' && p && ui.meter) {
        const step = c.step || 'flat'; const a = c.anchor; const v = p.position;
        let label = 'Moved', value = 0, unit = ' mm of ' + TARGET_MM, ready = false, note = '', progress = 0;
        if (step === 'flat') {
          const screenUp = screenDirection(p); const tilt = Math.round(Math.acos(clamp(screenUp.z, -1, 1)) * 180 / Math.PI);
          label = 'Tilt'; value = tilt; unit = '°'; ready = tilt <= FLAT_DEG; progress = 1 - clamp(tilt / 90, 0, 1);
          note = ready ? notes.flatReady : notes.flatter;
          placePhone(0, 0, 0);
        } else if (a) {
          const d = { x: v.x - a.x, y: v.y - a.y, z: v.z - a.z };
          if (step === 'up') { value = mm(d.z); placePhone(0, 0, clamp(value * 0.7, 0, 110)); }
          else if (step === 'right' && forwardAt) {
            // Right is measured across the forward direction just captured, so leftover forward travel does not count.
            const f = { x: forwardAt.x - a.x, y: forwardAt.y - a.y }; const len = Math.hypot(f.x, f.y) || 1; const fx = f.x / len, fy = f.y / len;
            value = mm(d.x * fy - d.y * fx); const along = mm(d.x * fx + d.y * fy);
            if (Math.abs(along) > 40) note = notes.backFirst;
            placePhone(clamp(along * 0.7, -60, 110), clamp(value * 0.7, -90, 110), 0);
          } else { value = mm(Math.hypot(d.x, d.y)); placePhone(step === 'forward' ? clamp(value * 0.7, 0, 110) : 0, step === 'right' ? clamp(value * 0.7, 0, 110) : 0, 0); }
          ready = value >= MIN_MM; progress = clamp(value / TARGET_MM, 0, 1);
          if (!note) note = ready ? notes.enough : notes.minimum;
        }
        if (!usable) note = notes.waiting;
        // A blind camera barely registers the move, so say why the meter is stuck.
        else if (tracking === 'limited' && step !== 'flat' && !ready) note = notes.limited;
        setText(ui.label, label); setText(ui.value, String(value)); setText(ui.unit, unit);
        ui.fill.style.width = (progress * 100).toFixed(1) + '%';
        ui.tick.hidden = step === 'flat'; ui.tick.style.left = (MIN_MM / TARGET_MM * 100) + '%';
        ui.meter.className = 'mk-meter' + (ready ? ' mk-ready' : ''); setText(ui.note, note);
      }
      if (mode === 'validate' && p && ui.axes && c.check && c.check.step) {
        const move = c.check.step; const v = p.position; const lead = dominant(v); const [expectAxis, expectSign] = EXPECTED[move];
        for (const axis of ['x', 'y', 'z']) {
          const n = mm(v[axis]); const fraction = clamp(n / 150, -1, 1) * 50; const row = ui.axes[axis];
          row.bar.style.left = (fraction < 0 ? 50 + fraction : 50) + '%'; row.bar.style.width = Math.abs(fraction) + '%';
          setText(row.value, signed(n)); row.row.className = 'mk-axis' + (lead[1].toLowerCase() === axis ? ' mk-lead' : '');
        }
        const travel = Math.round(Math.hypot(v.x, v.y, v.z) * 1000);
        const good = lead === (expectSign > 0 ? '+' : '-') + expectAxis.toUpperCase();
        setText(ui.axesNote, !usable ? notes.waiting : travel < MIN_MM ? notes.startFlat : good ? notes.moving(AXIS_WORDS[lead], travel) : notes.wrongWay(AXIS_WORDS[lead], travel));
        // The drawn phone follows the calibrated position, so a wrong frame shows up as the phone sliding the wrong way.
        placePhone(clamp(v.x * 700, -60, 110), clamp(-v.y * 700, -100, 110), clamp(v.z * 700, -10, 110));
      }
    }
    on('config', c => {
      const now = c.calibration || { status: 'uncalibrated' };
      // Remember where the phone was when forward was captured, to measure the right step across it.
      if (before && before.step === 'forward' && now.step === 'right' && last.pose) forwardAt = last.pose.position;
      if (now.status !== 'capturing') forwardAt = undefined;
      if (before && before.status === 'capturing' && now.status === 'captured' && shown === 'capture' && now.reference && (!before.reference || before.reference.epoch !== now.reference.epoch)) shown = 'captured';
      else if (before && before.status === 'capturing' && now.status !== 'capturing' && shown === 'capture') shown = undefined;
      if (before && before.check && before.check.step && now.check && now.check.passed !== undefined) shown = 'validated';
      else if (before && before.check && before.check.step && !(now.check && now.check.step) && shown === 'validate') shown = undefined;
      if (before && (before.step !== now.step || (before.check && before.check.step) !== (now.check && now.check.step))) reply = undefined;
      before = now;
      render();
    });
    on('pose', () => { if (!sh.open || posePending) return; posePending = true; requestAnimationFrame(() => { posePending = false; live(); }); });
    on('tracking', () => live());
    // A run started elsewhere waits for the operator to let go.
    on('touch', () => { if (!sh.open && runMode()) render(); });
    /** Whether a status message is a reply to calibration (the sheet shows it, or a toast when no sheet is open). */
    const handles = m => { const from = m && m.controlId && byId(m.controlId); return !!from && mine.has(from.action); };
    on('status', m => {
      const from = m && m.controlId && byId(m.controlId); if (!from || !mine.has(from.action)) return;
      // Every gateway reply says whether it did what was asked; a refusal is shown where the operator is looking.
      const refused = !!(m.values && m.values.accepted === false);
      if (from.action === A.capture || from.action === A.check) { reply = refused ? { text: m.message, bad: true } : undefined; render(); return; }
      if (shown === 'intro') { reply = { text: m.message, bad: refused }; render(); } else if (!shown && o.toast !== false) toast(m.message);
    });
    /** The Calibration row: its summary, and a tap opens the sheet. */
    function row(options) {
      const val = h('span', { class: 'mk-val' });
      const node = h('button', { type: 'button', class: 'mk-row mk-link', onclick: () => open('intro') }, h('span', {}, copy.row), val);
      adopt({ el: node, render: () => { const [text, tone] = summary(); setText(val, text); val.className = 'mk-val' + (tone ? ' mk-' + tone : ''); } }, options);
      return node;
    }
    const available = () => !!ctl('start') || !!ctl('origin');
    return { open, close, render, summary, handles, row, available, sheet: sh, get mode() { return runMode() || shown; } };
  }

  /* ---------- segments: a select control as a row of buttons, one per option ---------- */
  // The buttons follow the options and the value in every config. `disabled(value, control)` turns options off
  // (ones the robot can't do, say); the selected option always stays on, so the screen shows what is set.
  function segments(el, o) {
    o = o || {}; const get = finder(o);
    el = el || h('div');
    el.classList.add('mk-seg'); if (!el.hasAttribute('role')) el.setAttribute('role', 'group');
    let key;
    const part = { el };
    part.render = () => {
      const c = get(); el.hidden = !c || c.type !== 'select'; if (el.hidden) return;
      const k = JSON.stringify(c.options);
      if (k !== key) {
        key = k; if (!el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby')) el.setAttribute('aria-label', c.label);
        el.replaceChildren(...c.options.map(x => h('button', { type: 'button', 'data-value': x.value, onclick: () => send(get(), x.value) }, x.label)));
      }
      for (const b of el.children) { const value = b.getAttribute('data-value'); b.setAttribute('aria-pressed', String(value === c.value)); b.disabled = value !== c.value && !!(o.disabled && o.disabled(value, c)); }
    };
    return adopt(part, o);
  }

  /* ---------- controlRow: the generic row for a control a screen doesn't place ---------- */
  // A switch, a choice (segments up to three options, a picker beyond), a live slider, a stick, or a button (a hold
  // button if the control is one). Values follow the config in place, so a drag in progress is not reset.
  function controlRow(c, o) {
    o = o || {}; const opts = { controlId: c.id, group: o.group, letGoOnLeave: o.letGoOnLeave };
    const latestOf = () => byId(c.id) || c;
    if (c.type === 'toggle') {
      const sw = h('button', { class: 'mk-switch', role: 'switch', type: 'button', 'aria-checked': String(c.value), 'aria-label': c.label, 'data-id': c.id, onclick: () => send(latestOf(), sw.getAttribute('aria-checked') !== 'true') });
      const node = h('div', { class: 'mk-row' }, h('span', {}, c.label), sw);
      adopt({ el: node, sync: () => { const x = byId(c.id); if (x && x.type === 'toggle') sw.setAttribute('aria-checked', String(x.value)); } }, o);
      return node;
    }
    if (c.type === 'select') {
      let field;
      if (c.options.length <= 3) field = segments(h('div', { 'data-id': c.id }), { controlId: c.id, group: o.group }).el;
      else {
        field = h('select', { class: 'mk-select', 'data-id': c.id, 'aria-label': c.label, onchange: e => send(latestOf(), e.target.value) }, c.options.map(x => h('option', { value: x.value }, x.label)));
        field.value = c.value;
        adopt({ el: field, sync: () => { const x = byId(c.id); if (x && x.type === 'select' && document.activeElement !== field) field.value = x.value; } }, o);
      }
      return h('div', { class: 'mk-row mk-stack' }, h('div', { class: 'mk-row-head' }, h('span', {}, c.label)), field);
    }
    if (c.type === 'slider') {
      // Every value goes out live while the thumb is dragged; letting go (or a key press) sends the final one.
      const out = h('span', { class: 'mk-val' }, format(c, c.value));
      const part = slider(null, Object.assign({ out }, opts));
      part.el.setAttribute('data-id', c.id);
      return h('div', { class: 'mk-row mk-stack' }, h('div', { class: 'mk-row-head' }, h('span', {}, c.label), out), part.el);
    }
    if (c.type === 'joystick') {
      const out = h('span', { class: 'mk-val' }, 'at rest');
      const part = stick(null, Object.assign({ label: c.label, onMove: v => setText(out, v.x || v.y ? 'up ' + signed2(v.x) + ', left ' + signed2(v.y) : 'at rest') }, opts));
      adopt({ el: out, render: () => out.setAttribute('data-state', part.state()) }, o);
      return h('div', { class: 'mk-row mk-stack' }, h('div', { class: 'mk-row-head' }, h('span', {}, c.label), out), h('div', { class: 'mk-stick-row' }, part.el));
    }
    const btn = h('button', { type: 'button', class: 'mk-btn mk-wide' + (c.tone === 'danger' ? ' mk-danger' : '') }, c.label, c.hold ? h('small', {}, ' (hold)') : null);
    if (c.hold) hold(btn, opts); else btn.addEventListener('click', () => send(latestOf()));
    return h('div', { class: 'mk-row' }, btn);
  }

  const kit = {
    version: 1, ACTIONS, TRACKING_WORDS, AXIS_WORDS,
    ready, on, latest, features, has, config, control, byId, send, holdState, liveState, busy,
    group, letGo, letGoOnLeave,
    hold, drag, slider, stick, stickLimit, segments, stop, strip, toast, robots, robot, cameras, sheet, sheetTop, calibration, controlRow,
    h, setText, svg, clamp, mm, signed, signed2, format, staleAfterMs, linkQuality,
  };
  window.MarionetteKit = Object.freeze(kit);
  if (window.Marionette) boot(); else window.addEventListener('marionette-ready', boot);
})();
