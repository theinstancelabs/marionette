/**
 * Types for Marionette phone screens: the page bridge (`window.Marionette`, bridge version 1) and the screen kit
 * (`window.MarionetteKit`). Self-contained, so a screen author can point an editor at this one file:
 *   /// <reference path="marionette-kit.d.ts" />
 * The shapes mirror `@marionette/protocol`; docs/SCREEN-KIT.md and the README ("The phone screen is HTML") describe them.
 */
export {};

declare global {
  namespace Marionette {
    type Vector3 = { x: number; y: number; z: number };
    type Quaternion = { x: number; y: number; z: number; w: number };
    type TrackingState = 'initializing' | 'normal' | 'limited' | 'relocalizing' | 'unavailable';
    type PoseSource = 'arkit' | 'device-motion' | 'synthetic';
    /** Where a stick is pushed: x up the pad (forward), y to the left, each -1..1 and at most 1 together. */
    type StickValue = { x: number; y: number };
    type ControlValue = string | number | boolean | StickValue;
    type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

    type Control =
      | { id: string; type: 'button'; label: string; action: string; tone?: 'default' | 'danger' | 'accent'; hold?: boolean; held?: boolean }
      | { id: string; type: 'toggle'; label: string; action: string; value: boolean }
      | { id: string; type: 'select'; label: string; action: string; value: string; options: { label: string; value: string }[] }
      | { id: string; type: 'slider'; label: string; action: string; value: number; min: number; max: number; step: number; unit?: string; live?: boolean }
      | { id: string; type: 'joystick'; label: string; action: string; value: StickValue; live?: boolean };
    type CameraStream = { id: string; label: string; url: string; status: 'live' | 'offline'; transport?: 'jpeg' | 'webrtc'; publisher?: string };
    type CameraView = { id: string; label: string; streams: string[] };
    type PhoneInfo = { id: string; name: string; color: string; connected: boolean; sessionId?: string };
    type RobotInfo = { id: string; name: string; connected: boolean; screen?: boolean; streams?: string[] };
    type AxisLabel = '+X' | '-X' | '+Y' | '-Y' | '+Z' | '-Z';
    type CheckMove = 'forward' | 'right' | 'up';
    type CalibrationStep = 'flat' | 'forward' | 'right' | 'up';
    type CalibrationCheckResult = { move: CheckMove; expected: AxisLabel; dominant: AxisLabel; displacement: Vector3; passed: boolean };
    type PoseReference = { mode: 'quick' | 'guided'; sessionId: string; epoch: number; position: Vector3; rotation: Quaternion; frame: Quaternion };
    type CalibrationState = {
      status: 'uncalibrated' | 'capturing' | 'captured'; epoch: number; step?: CalibrationStep; originSeq?: number; reference?: PoseReference; anchor?: Vector3;
      check?: { step?: CheckMove; results: CalibrationCheckResult[]; passed?: boolean };
    };
    /** This phone's view of the gateway: its control values, holds and drags, calibration, the phones and robots. */
    type Config = {
      type: 'config'; version: 1; sessionId: string; serverName: string;
      controls: Control[]; cameraStreams: CameraStream[]; cameraViews: CameraView[]; calibration: CalibrationState;
      phone?: PhoneInfo; phones: PhoneInfo[]; robots?: RobotInfo[]; gatewayId?: string; auth?: boolean;
    };
    type Pose = {
      type: 'pose'; version: 1; sessionId: string; seq: number; monotonicTs: number; position: Vector3; rotation: Quaternion;
      covariance: number[]; source: PoseSource; trackingState: TrackingState; calibrationVersion: string; heartbeat: boolean;
      phoneId?: string; sentAt?: number; receivedAt?: number; latencyMs?: number;
    };
    type Status = { type: 'status'; version: 1; sessionId: string; controlId?: string; message: string; values?: Record<string, JsonValue>; phoneId?: string };
    type CameraFrame = { type: 'camera_frame'; version: 1; sessionId: string; cameraId: string; dataUrl: string; capturedAt: number };
    type TrackingEvent = { state: TrackingState; source: PoseSource; reason?: string; message?: string };
    type ConnectionEvent = { state: 'connected' | 'disconnected' | 'reconnecting'; gateway: string; reason?: string };
    type LinkEvent = { rttMs?: number; quality: 'good' | 'fair' | 'poor' | 'unknown' };
    type RobotState = { type: 'robot_state'; version: 1; robotId?: string; phoneId?: string; state: { [key: string]: JsonValue }; everyMs?: number; sentAt?: number; receivedAt?: number };
    /** One robot as the bridge's `robots` event has it. `receivedAt` is the page's Date.now() when its state last arrived. */
    type RobotView = { id: string; name: string; connected: boolean; state?: { [key: string]: JsonValue }; phoneState?: { [key: string]: JsonValue }; everyMs?: number; receivedAt?: number };
    type RtcKind = 'publish' | 'unpublish' | 'request' | 'offer' | 'answer' | 'candidate' | 'close' | 'error';
    type RtcCandidate = { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null };
    type RtcMessage = { type: 'rtc'; version: 1; kind: RtcKind; streams?: string[]; stream?: string; peer?: string; to?: string; from?: string; sdp?: string; candidate?: RtcCandidate; message?: string };
    type Feature = 'live' | 'robot_state' | 'link' | 'rtc' | 'reconnect' | 'orientation';

    type Events = {
      config: Config; pose: Pose; status: Status; camera_frame: CameraFrame; tracking: TrackingEvent; connection: ConnectionEvent;
      robot_state: RobotState; robots: { [robotId: string]: RobotView }; link: LinkEvent; rtc: RtcMessage;
    };
    type Stream = { update(value: ControlValue): void; end(value?: ControlValue): void; isOpen(): boolean };

    /** The page bridge the app (or the gateway's /screen mirror) installs. */
    interface Bridge {
      readonly version: 1;
      /** What this host supports. Older hosts have none. */
      readonly features?: Feature[];
      sendAction(controlId: string, action: string, value?: ControlValue, options?: { live?: true }): void;
      /** A value being dragged: update() at most once a frame, end() sends the final value. */
      stream(controlId: string, action: string): Stream;
      /** Calls `callback` with every event of a type, and at once with the last one. Returns an unsubscribe function. */
      on<T extends keyof Events>(type: T, callback: (payload: Events[T]) => void): () => void;
      latest<T extends keyof Events>(type: T): Events[T] | undefined;
      /** WebRTC signaling through the host (hosts that list `rtc`). */
      rtc(message: { kind: RtcKind; streams?: string[]; stream?: string; peer?: string; to?: string; sdp?: string; candidate?: RtcCandidate; message?: string }): void;
      disconnect(): void;
    }
  }

  namespace MarionetteKit {
    type HoldState = 'idle' | 'pending' | 'held' | 'dropped';
    type LiveState = 'idle' | 'pending' | 'live' | 'dropped';
    /** A control by id, or the first with an action. */
    type Target = { controlId?: string; action?: string };
    type PartOptions = {
      /** Join a group, to let go of or dispose of parts together. */
      group?: Group;
      /** Let go when the page loses focus or is hidden, a sheet opens or Stop turns on (default true). */
      letGoOnLeave?: boolean;
    };
    interface Part { el?: Element; dispose(): void }
    interface Group { add<P extends Part>(part: P): P; letGo(quiet?: boolean): void; dispose(): void }

    interface HoldPart extends Part { el: HTMLElement; state(): HoldState; release(quiet?: boolean): void; letGo(quiet?: boolean): void }
    type HoldOptions = Target & PartOptions & {
      /** Called with true on press and false on release. */
      onChange?(pressed: boolean): void;
      /** Called whenever the state changes, and once at the start. */
      onState?(state: HoldState, control: Marionette.Control | undefined): void;
    };
    interface DragPart extends Part {
      /**
       * Streams a value, marked live, at most once a frame; the first one starts the drag. Ignored while the drag is cut
       * (the kit let go of it, the gateway went or this page's phone changed), until end().
       */
      update(value: Marionette.ControlValue): void;
      /**
       * The gesture is over: sends the final value (the last one if left out) and ends the drag. `quiet` sends nothing. A
       * cut drag sends only the final value its host waits for: the value the gateway ended it at, if any sample went out.
       */
      end(value?: Marionette.ControlValue, quiet?: boolean): void;
      isOpen(): boolean; state(): LiveState; letGo(quiet?: boolean): void;
    }
    type DragOptions = Target & PartOptions & {
      /** Called when the drag is cut while open (the kit let go, the gateway went or the phone changed), to show it let go. Call end() when the finger lifts anyway. */
      onLetGo?(): void;
    };
    interface SegmentsPart extends Part { el: HTMLElement; render(): void }
    type SegmentsOptions = Target & PartOptions & {
      /** Turns an option off (the selected one always stays on). Call render() when what it depends on changes. */
      disabled?(value: string, control: Marionette.Control): boolean;
    };
    interface SliderPart extends Part { el: HTMLInputElement; out?: Element; state(): LiveState; finish(quiet?: boolean): void; letGo(quiet?: boolean): void }
    type SliderOptions = Target & PartOptions & {
      /** Shows the value, formatted, with `data-state` like the slider. */
      out?: Element;
      format?(control: Marionette.Control | undefined, value: number): string;
    };
    interface StickPart extends Part { el: HTMLElement; state(): LiveState; letGo(quiet?: boolean): void }
    type StickOptions = Target & PartOptions & {
      label?: string;
      /** Words at the forward, back, left and right edges. */
      edges?: [string?, string?, string?, string?] | string[];
      onMove?(value: Marionette.StickValue): void;
    };
    interface StopPart extends Part { button: HTMLButtonElement; banner?: HTMLElement; isOn(): boolean; press(): void }
    type StopOptions = {
      action?: string;
      /** Defaults to a floating Stop button added to the page. A sheet never covers it, wherever it is. */
      button?: HTMLButtonElement;
      /** An element for the banner: filled with the default banner if empty; a `[data-stop-reset]` button inside resets. */
      banner?: HTMLElement;
      reset?: HTMLElement;
      /** Let go of everything when Stop turns on (default true). */
      letGo?: boolean;
      onChange?(on: boolean): void;
    };
    interface StripPart extends Part { el: HTMLElement; me: HTMLElement; tracking: HTMLElement; link: HTMLElement; rule?: HTMLElement; render(): void }
    /** A robot as the kit sees it: the bridge's view plus `stale`, `offline` and `values` (its state with this phone's over it). */
    type Robot = Marionette.RobotView & {
      screen: boolean; offline: boolean; stale: boolean; staleAfterMs: number; ageMs?: number;
      values: { [key: string]: Marionette.JsonValue };
    };
    interface CamerasPart extends Part { el: HTMLElement; render(): void }
    type CamerasOptions = PartOptions & {
      /**
       * The select that picks the view (default camera.view). The gateway sends a phone the JPEG frames of the view
       * camera.view picks, so with another select only WebRTC panes get pictures for other views (the kit warns).
       */
      action?: string;
      /** Text for a pane without a picture. */
      empty?(streamId: string, label: string, state: 'waiting' | 'unavailable'): string;
      /** ICE servers for WebRTC; none by default (LAN and Tailscale host candidates). */
      iceServers?: RTCIceServer[];
    };
    interface Sheet { readonly el: HTMLElement; readonly open: boolean; show(children?: Node | (Node | null | false)[]): Sheet; hide(): void }
    /** `covers`: what the sheet makes inert (default: the whole body). Stop buttons and sheets inside are never covered. */
    type SheetOptions = { el?: HTMLElement; covers?: Element | Element[]; onHide?(): void };
    type CalibrationMode = 'intro' | 'capture' | 'captured' | 'validate' | 'validated';
    interface Calibration {
      open(mode?: CalibrationMode): void;
      close(): void;
      render(force?: boolean): void;
      /** ['Guided, validated ✓', 'ok'], ['Not calibrated', ''], … */
      summary(): [string, '' | 'ok' | 'bad'];
      /** Whether a status is a calibration reply (the sheet shows it, or a toast while the sheet is closed). */
      handles(status: Marionette.Status | { controlId?: string }): boolean;
      /** A "Calibration ›" row with the summary; a tap opens the sheet. */
      row(options?: PartOptions): HTMLButtonElement;
      /** Whether the layout has calibration controls. */
      available(): boolean;
      readonly sheet: Sheet;
      readonly mode: CalibrationMode | undefined;
    }
    type CalibrationOptions = {
      sheet?: HTMLElement; covers?: Element | Element[];
      /** Show start/origin/reset replies as toasts while the sheet is closed (default true). */
      toast?: boolean;
      /** Your own words, merged over the defaults (see CALIBRATION_COPY in marionette-kit.js). */
      copy?: Record<string, unknown>;
      actions?: Partial<Kit['ACTIONS']>;
    };
    type KitEvents = Marionette.Events & { touch: undefined };

    interface Kit {
      readonly version: 1;
      readonly ACTIONS: { deadman: string; estop: string; view: string; start: string; capture: string; cancel: string; check: string; origin: string; clear: string };
      readonly TRACKING_WORDS: Record<Marionette.TrackingState, string>;
      readonly AXIS_WORDS: Record<Marionette.AxisLabel, string>;
      ready(fn: (bridge: Marionette.Bridge) => void): void;
      /** Like Marionette.on, after the kit has taken the event in. `touch`: a hold or drag here started, ended or changed. */
      on<T extends keyof KitEvents>(type: T, fn: (payload: KitEvents[T]) => void): () => void;
      latest<T extends keyof Marionette.Events>(type: T): Marionette.Events[T] | undefined;
      features(): Marionette.Feature[];
      has(feature: Marionette.Feature): boolean;
      config(): Marionette.Config | undefined;
      control(action: string): Marionette.Control | undefined;
      byId(id: string): Marionette.Control | undefined;
      send(control: Marionette.Control | undefined, value?: Marionette.ControlValue): void;
      holdState(control: Marionette.Control | string | undefined): HoldState;
      liveState(control: Marionette.Control | string | undefined): LiveState;
      /** Whether anything is pressed or dragged on this page. */
      busy(): boolean;
      group(): Group;
      letGo(quiet?: boolean): void;
      letGoOnLeave(target: Group | Part | ((quiet: boolean) => void)): () => void;

      hold(button: HTMLElement, options: HoldOptions): HoldPart;
      drag(options: DragOptions): DragPart;
      segments(el: HTMLElement | null, options: SegmentsOptions): SegmentsPart;
      slider(input: HTMLInputElement | null, options: SliderOptions): SliderPart;
      stick(pad: HTMLElement | null, options: StickOptions): StickPart;
      /** Two decimals toward zero, never longer than 1. */
      stickLimit(x: number, y: number): Marionette.StickValue;
      stop(options?: StopOptions): StopPart;
      strip(el: HTMLElement, options?: { rule?: boolean }): StripPart;
      toast(text: string, options?: { above?: Element; ms?: number }): HTMLElement | undefined;
      robots(fn: (robots: { [id: string]: Robot }) => void): () => void;
      robot(fn: (robot: Robot | undefined) => void): () => void;
      robot(id: string | undefined, fn: (robot: Robot | undefined) => void): () => void;
      cameras(el: HTMLElement, options?: CamerasOptions): CamerasPart;
      sheet(options?: SheetOptions): Sheet;
      sheetTop(left: string, title: string, count: string, onLeft: () => void): HTMLElement;
      calibration(options?: CalibrationOptions): Calibration;
      controlRow(control: Marionette.Control, options?: PartOptions): HTMLElement;

      h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Record<string, unknown> | null, ...children: unknown[]): HTMLElementTagNameMap[K];
      setText(node: Node | null | undefined, text: string): void;
      svg(markup: string): Element;
      clamp(value: number, lo: number, hi: number): number;
      mm(metres: number): number;
      signed(n: number): string;
      signed2(n: number): string;
      format(control: Marionette.Control | undefined, value: number): string;
      staleAfterMs(everyMs?: number): number;
      linkQuality(rttMs?: number): Marionette.LinkEvent['quality'];
    }
  }

  interface Window {
    Marionette?: Marionette.Bridge;
    MarionetteKit: MarionetteKit.Kit;
  }
  interface WindowEventMap { 'marionette-ready': Event }
}
