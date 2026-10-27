// Type-checked (npm run typecheck), never run: the kit's declarations stay in step with the protocol, and a screen
// written against them compiles.
/// <reference path="../marionette-kit.d.ts" />
import type { CameraStream, ConfigMessage, ConnectionEvent, LinkEvent, PosePacket, RobotStateMessage, RobotView, RtcMessage, StatusMessage, TrackingEvent, UiControl } from '@marionette/protocol';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const sameTypes: [
  Same<Marionette.Control, UiControl>, Same<Marionette.Config, ConfigMessage>, Same<Marionette.Pose, PosePacket>, Same<Marionette.Status, StatusMessage>,
  Same<Marionette.CameraStream, CameraStream>, Same<Marionette.TrackingEvent, TrackingEvent>, Same<Marionette.ConnectionEvent, ConnectionEvent>,
  Same<Marionette.LinkEvent, LinkEvent>, Same<Marionette.RobotView, RobotView>, Same<Marionette.RobotState, RobotStateMessage>, Same<Marionette.RtcMessage, RtcMessage>,
] = [true, true, true, true, true, true, true, true, true, true, true];

// A small robot screen.
const K = window.MarionetteKit;
const { h } = K;
K.strip(h('header'));
const stop = K.stop({ banner: h('div') });
const pad = K.hold(h('button', { class: 'pad' }, 'Hold to move'), { action: K.ACTIONS.deadman, onState: (state: MarionetteKit.HoldState) => { pad.el.title = state; } });
const scale = K.slider(null, { controlId: 'scale', out: h('output') });
const drive = K.stick(null, { action: 'base.drive', edges: ['Forward', 'Back', 'Left', 'Right'], onMove: v => { void (v.x + v.y); } });
const cams = K.cameras(h('figure'), { empty: (id, label, state) => (state === 'unavailable' ? `No ${label}` : `Waiting for ${id}`) });
const calibration = K.calibration({ copy: { introTitle: 'Face the robot' } });
const more = K.sheet();
more.show([K.sheetTop('Close', 'More', '', () => more.hide()), calibration.row()]);
const off = K.robot(robot => { if (robot && !robot.stale && !robot.offline) void robot.values.battery; });
K.on('status', status => { if (!calibration.handles(status) && status.message) K.toast(status.message); });
K.on('touch', () => { void (K.holdState('deadman') === 'held' && K.liveState(K.control('base.drive')) === 'live'); });
K.ready(bridge => { if (bridge.features?.includes('rtc')) bridge.rtc({ kind: 'request', stream: 'head', peer: 'head-1' }); });
const grip = K.drag({ action: 'gripper.set' }); grip.update(0.4); grip.end();
const frames = K.segments(h('div'), { action: 'teleop.frame', disabled: value => value !== 'axol' }); frames.render();
const group = K.group(); K.letGoOnLeave(group); group.add(scale); K.letGoOnLeave(quiet => { void quiet; });
export const parts = [stop, pad, scale, drive, cams, off, K.controlRow({ id: 'horn', type: 'button', label: 'Horn', action: 'horn.honk' }, { group })];
