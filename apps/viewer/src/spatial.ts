import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { MIN_CALIBRATION_STEP_M, type ConfigMessage } from '@marionette/protocol';
import { knownStep } from './events';
import type { PhoneLive } from './store';

export type View = 'chase' | 'top' | 'side';
export type GatewayLayer = 'frame' | 'grid' | 'calibration';
export type PhoneLayer = 'pose' | 'trail' | 'axes';
/** One connected phone to draw, from its station: `offset` is the station's +Y (left) offset in metres. */
export type SpatialPhone = { id: string; color: string; label: string; offset: number; config?: ConfigMessage; shown: Record<PhoneLayer, boolean> };
export type SpatialSources = { phones: () => SpatialPhone[]; live: (id: string) => PhoneLive | undefined; shown: (layer: GatewayLayer) => boolean };

const INK = 0x2e3033, INK2 = 0x6b6f73, RED = 0xcf3f35, GREEN = 0x3f7d4e, BLUE = 0x2f53b5, GRID = 0xd5dce6, SCREEN = 0xe6ebf0;
const FOV = 35;
/** Length of the operator frame axes, metres: about half the 25 cm station offset, so their labels stay apart. */
const AXIS_M = 0.12;
/** Station labels sit this far behind their origin mark, away from the frame axes. */
const STATION_LABEL_BACK_M = 0.05;
/** The grid reaches this far past the outermost station, metres. */
const GRID_MARGIN_M = 0.35;
// Camera directions in scene coordinates. Top puts forward at screen-up; side puts forward at screen-right and up at screen-up.
const VIEW_DIRECTIONS: Record<View, THREE.Vector3> = {
  chase: new THREE.Vector3(1.7, 1.25, 2.15).normalize(),
  top: new THREE.Vector3(0, 3.2, 0.001).normalize(),
  side: new THREE.Vector3(3, 0.35, 0).normalize(),
};
// Phone body, metres: X top edge, Y left edge, Z out of the screen (a slightly enlarged iPhone).
const PHONE = { length: 0.16, width: 0.078, thickness: 0.012, radius: 0.012 };

function roundedRect(length: number, width: number, radius: number): THREE.Shape {
  const x = length / 2, y = width / 2, r = radius; const shape = new THREE.Shape();
  shape.moveTo(-x + r, -y); shape.lineTo(x - r, -y); shape.quadraticCurveTo(x, -y, x, -y + r); shape.lineTo(x, y - r); shape.quadraticCurveTo(x, y, x - r, y);
  shape.lineTo(-x + r, y); shape.quadraticCurveTo(-x, y, -x, y - r); shape.lineTo(-x, -y + r); shape.quadraticCurveTo(-x, -y, -x + r, -y);
  return shape;
}
const tint = (color: string, amount: number) => new THREE.Color(0xffffff).lerp(new THREE.Color(color), amount);

type Box = { left: number; right: number; top: number; bottom: number };
/** A station label hangs this many label heights below its anchor, and each further row one more. */
const LABEL_DROP = 1.15, LABEL_ROW = 0.95;
/**
 * The first row, from 0 down to `maxRow`, where a label at screen point (`x`, `y`) clears every label in
 * `placed`; adds its box there. `cx` is the fraction of its `width` to the left of the anchor. Only the
 * middle 70% of a label's height holds glyphs, so neighbouring rows do not count as touching.
 */
export function placeLabel(placed: Box[], label: { x: number; y: number; cx: number; width: number; height: number }, maxRow: number): number {
  const { x, y, cx, width, height } = label; let row = 0; let box: Box;
  for (;; row++) {
    const top = y + (LABEL_DROP - 1 + row * LABEL_ROW) * height;
    box = { left: x - cx * width - 4, right: x + (1 - cx) * width + 4, top: top + 0.15 * height, bottom: top + 0.85 * height };
    if (row >= maxRow || !placed.some(other => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)) break;
  }
  placed.push(box); return row;
}

/** Handwritten label drawn into a canvas, kept a constant size on screen. A `dot` draws a phone's color before the text. */
class Label {
  readonly sprite: THREE.Sprite; readonly direction = new THREE.Vector3();
  private readonly canvas = document.createElement('canvas'); private readonly texture: THREE.CanvasTexture; private aspect = 3; private viewportHeight = 1;
  constructor(private text: string, private readonly color: string, private readonly px = 19, private readonly dot?: string) {
    this.texture = new THREE.CanvasTexture(this.canvas); this.texture.colorSpace = THREE.SRGBColorSpace;
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.texture, depthTest: false, transparent: true, sizeAttenuation: false }));
    this.sprite.center.set(0, 0.5); this.sprite.renderOrder = 10; this.draw();
  }
  setText(text: string) { if (text === this.text) return; this.text = text; this.draw(); }
  /** On-screen size in CSS pixels; the glyphs fill about the middle 70% of the height. */
  pixelSize(): { width: number; height: number } { const height = this.px * 108 / 72; return { width: height * this.aspect, height }; }
  draw() {
    const font = '400 72px Kalam, Noteworthy, "Bradley Hand", cursive'; const ctx = this.canvas.getContext('2d')!;
    const indent = this.dot ? 52 : 0;
    ctx.font = font; const width = Math.ceil(ctx.measureText(this.text).width) + 24 + indent;
    // The GPU copy keeps the size it was first uploaded at; a resized canvas needs a fresh one.
    if (this.canvas.width !== width) this.texture.dispose();
    this.canvas.width = width; this.canvas.height = 108; this.aspect = width / 108;
    if (this.dot) { ctx.fillStyle = this.dot; ctx.beginPath(); ctx.arc(12 + 18, 56, 15, 0, Math.PI * 2); ctx.fill(); }
    ctx.font = font; ctx.fillStyle = this.color; ctx.textBaseline = 'middle'; ctx.fillText(this.text, 12 + indent, 58);
    this.texture.needsUpdate = true; this.resize(this.viewportHeight);
  }
  resize(viewportHeight: number) {
    this.viewportHeight = viewportHeight;
    const height = (this.px * 108 / 72) * 2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2)) / Math.max(1, viewportHeight);
    this.sprite.scale.set(height * this.aspect, height, 1);
  }
  dispose() { this.texture.dispose(); this.sprite.material.dispose(); }
}

/** Everything drawn for one phone: its station mark and label, the phone body, its trail and its calibration aids. */
type Rig = {
  color: string; station: THREE.Group; label: Label; body: THREE.Group; bodyAxes: THREE.Group; fading: THREE.Material[];
  trail?: Line2; trailMaterial: LineMaterial; trailStamp: number; frameKey?: string;
  aids: THREE.Group; ring: THREE.LineLoop; rise: THREE.LineSegments; reach: THREE.Line;
  dispose: () => void;
};

/**
 * The live 3D view of every connected phone, each from its own station. Reads
 * telemetry from `sources` every animation frame, so poses never go through React.
 */
export class SpatialView {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.005, 40);
  private readonly orbit: OrbitControls;
  private readonly scene = new THREE.Scene();
  private readonly operator = new THREE.Group();
  private readonly materials = new Set<LineMaterial>();
  private readonly labels = new Set<Label>();
  private readonly disposables: { dispose(): void }[] = [];
  private readonly frameAxes = new THREE.Group();
  private readonly frameLabels: Label[] = [];
  private grid?: THREE.LineSegments; private gridHalfWidth = 0;
  private readonly gridMaterial = new THREE.LineBasicMaterial({ color: GRID });
  private readonly rigs = new Map<string, Rig>();
  // Shared by every phone.
  private readonly bodyGeometry: THREE.ExtrudeGeometry;
  private readonly edgeGeometry: LineSegmentsGeometry;
  private readonly screenGeometry: THREE.ShapeGeometry;
  private readonly arrowGeometry: LineSegmentsGeometry;
  private readonly markGeometry: { disc: THREE.CircleGeometry; ring: LineGeometry; cross: LineSegmentsGeometry };
  private readonly axisLines: { geometry: LineGeometry; material: LineMaterial }[] = [];
  private readonly aidGeometry: { ring: THREE.BufferGeometry; rise: THREE.BufferGeometry };
  private readonly aidMaterial = new THREE.LineDashedMaterial({ color: INK2, dashSize: 0.004, gapSize: 0.004 });
  private readonly riseMaterial = new THREE.LineBasicMaterial({ color: INK2 });
  private readonly reachMaterial = new THREE.LineDashedMaterial({ color: INK, dashSize: 0.005, gapSize: 0.004 });
  private readonly discMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.92 });
  private readonly viewDirection = new THREE.Vector3();
  private readonly projected = { origin: new THREE.Vector3(), station: new THREE.Vector3() };
  private layoutKey?: string;
  private userMoved = false;
  private view: View = 'chase';
  private raf = 0;
  private readonly resizeObserver: ResizeObserver;

  constructor(private readonly host: HTMLElement, private readonly sources: SpatialSources) {
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setClearColor(0x000000, 0); this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.domElement.setAttribute('aria-label', 'Spatial view of every phone pose in the operator frame');
    host.appendChild(this.renderer.domElement);
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    Object.assign(this.orbit, { enableDamping: !reducedMotion, screenSpacePanning: true, minDistance: 0.12, maxDistance: 8 });
    this.orbit.addEventListener('start', () => { this.userMoved = true; });
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xc4c9cf, 2.6));
    this.disposables.push(this.gridMaterial, this.aidMaterial, this.riseMaterial, this.reachMaterial, this.discMaterial);

    // Poses arrive in the operator frame (ROS REP-103: +X forward, +Y left, +Z up). Three.js is Y-up, so one
    // fixed rotation draws operator forward into the screen (scene -Z), left as scene -X, and up as scene +Y.
    this.operator.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0)));
    this.scene.add(this.operator);
    this.setGrid(0.5);

    // Operator frame axes at the centre with handwritten labels, colored by axis (RGB = XYZ).
    const axes: [THREE.Vector3, number, string, string][] = [[new THREE.Vector3(1, 0, 0), RED, 'forward', '#cf3f35'], [new THREE.Vector3(0, 1, 0), GREEN, 'left', '#3f7d4e'], [new THREE.Vector3(0, 0, 1), BLUE, 'up', '#2f53b5']];
    for (const [direction, color, text, css] of axes) {
      const tip = direction.clone().multiplyScalar(AXIS_M);
      this.frameAxes.add(this.line([0, 0, 0, tip.x, tip.y, tip.z], this.material(color, 2)));
      const back = direction.clone().multiplyScalar(-AXIS_M);
      this.frameAxes.add(this.line([0, 0, 0, back.x, back.y, back.z], this.material(color, 1, { opacity: 0.45, dashed: true, dash: 0.008, gap: 0.008 })));
      const label = this.label(text, css); label.sprite.position.copy(direction.clone().multiplyScalar(AXIS_M + 0.012)); label.direction.copy(direction).applyQuaternion(this.operator.quaternion);
      this.frameLabels.push(label); this.frameAxes.add(label.sprite);
    }
    this.operator.add(this.frameAxes);
    document.fonts?.load('400 72px Kalam').then(() => this.labels.forEach(label => label.draw())).catch(() => undefined);

    // Phone mesh in the body frame (X top edge, Y left edge, Z out of the screen): identity is flat, screen up, top edge forward.
    this.bodyGeometry = new THREE.ExtrudeGeometry(roundedRect(PHONE.length, PHONE.width, PHONE.radius), { depth: PHONE.thickness, bevelEnabled: false, curveSegments: 6 }); this.bodyGeometry.translate(0, 0, -PHONE.thickness / 2);
    this.edgeGeometry = new LineSegmentsGeometry().fromEdgesGeometry(new THREE.EdgesGeometry(this.bodyGeometry, 25));
    this.screenGeometry = new THREE.ShapeGeometry(roundedRect(PHONE.length * 0.86, PHONE.width * 0.8, PHONE.radius * 0.6)); this.screenGeometry.translate(0, 0, PHONE.thickness / 2 + 0.0005);
    const tipX = PHONE.length / 2, z = PHONE.thickness / 2;
    this.arrowGeometry = new LineSegmentsGeometry(); this.arrowGeometry.setPositions([tipX, 0, z, tipX + 0.045, 0, z, tipX + 0.045, 0, z, tipX + 0.033, 0.009, z, tipX + 0.045, 0, z, tipX + 0.033, -0.009, z]);
    for (const [end, color] of [[[0.125, 0, 0], RED], [[0, 0.075, 0], GREEN], [[0, 0, 0.065], BLUE]] as const) {
      const geometry = new LineGeometry(); geometry.setPositions([0, 0, 0, ...end]);
      const material = this.material(color, 1.5); material.depthTest = false; this.axisLines.push({ geometry, material });
    }
    // Station mark: a small paper disc with a ring and a cross on the floor.
    const ringPoints: number[] = []; for (let i = 0; i <= 40; i++) { const a = i / 40 * Math.PI * 2; ringPoints.push(Math.cos(a) * 0.012, Math.sin(a) * 0.012, 0.0006); }
    const ring = new LineGeometry(); ring.setPositions(ringPoints);
    const cross = new LineSegmentsGeometry(); cross.setPositions([-0.032, 0, 0.0006, -0.012, 0, 0.0006, 0.012, 0, 0.0006, 0.032, 0, 0.0006, 0, -0.032, 0.0006, 0, -0.012, 0.0006, 0, 0.012, 0.0006, 0, 0.032, 0.0006]);
    const disc = new THREE.CircleGeometry(0.012, 24); disc.translate(0, 0, 0.0004);
    this.markGeometry = { disc, ring, cross };
    // Calibration aids: the 30 mm ring around the flat spot and the 30 mm rise for the up step.
    const aidRing: number[] = []; for (let i = 0; i < 64; i++) { const a = i / 64 * Math.PI * 2; aidRing.push(Math.cos(a) * MIN_CALIBRATION_STEP_M, Math.sin(a) * MIN_CALIBRATION_STEP_M, 0); }
    const aidRingGeometry = new THREE.BufferGeometry(); aidRingGeometry.setAttribute('position', new THREE.Float32BufferAttribute(aidRing, 3));
    const riseGeometry = new THREE.BufferGeometry(); riseGeometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, MIN_CALIBRATION_STEP_M, -0.012, 0, MIN_CALIBRATION_STEP_M, 0.012, 0, MIN_CALIBRATION_STEP_M], 3)); riseGeometry.setIndex([0, 1, 2, 3]);
    this.aidGeometry = { ring: aidRingGeometry, rise: riseGeometry };
    this.disposables.push(this.bodyGeometry, this.edgeGeometry, this.screenGeometry, this.arrowGeometry, disc, ring, cross, aidRingGeometry, riseGeometry, ...this.axisLines.map(axis => axis.geometry));

    this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(host); this.resize();
    this.setView('chase');
    const tick = () => { this.update(); this.orbit.update(); this.renderer.render(this.scene, this.camera); this.raf = requestAnimationFrame(tick); };
    this.raf = requestAnimationFrame(tick);
  }

  private material(color: THREE.ColorRepresentation, width: number, options: { opacity?: number; dashed?: boolean; dash?: number; gap?: number } = {}): LineMaterial {
    const material = new LineMaterial({ color: new THREE.Color(color).getHex(), linewidth: width, transparent: true, opacity: options.opacity ?? 1, dashed: !!options.dashed, dashSize: options.dash ?? 0.01, gapSize: options.gap ?? 0.01, worldUnits: false });
    material.resolution.set(Math.max(1, this.host.clientWidth), Math.max(1, this.host.clientHeight));
    this.materials.add(material); return material;
  }
  private line(points: number[], material: LineMaterial, segments = false): Line2 | LineSegments2 {
    const geometry = segments ? new LineSegmentsGeometry() : new LineGeometry(); geometry.setPositions(points); this.disposables.push(geometry);
    const line = segments ? new LineSegments2(geometry, material) : new Line2(geometry as LineGeometry, material);
    if (material.dashed) line.computeLineDistances();
    return line;
  }
  private label(text: string, color: string, px?: number, dot?: string): Label {
    const label = new Label(text, color, px, dot); label.resize(Math.max(1, this.host.clientHeight)); this.labels.add(label); return label;
  }

  /** Ground grid in the operator XY plane, 10 cm squares, wide enough for every station. */
  private setGrid(halfWidth: number) {
    if (halfWidth === this.gridHalfWidth) return;
    const visible = this.grid?.visible ?? true;
    if (this.grid) { this.operator.remove(this.grid); this.grid.geometry.dispose(); }
    const points: number[] = []; const steps = Math.round(halfWidth * 10);
    for (let i = -5; i <= 5; i++) { const x = i / 10; points.push(x, -halfWidth, 0, x, halfWidth, 0); }
    for (let i = -steps; i <= steps; i++) { const y = i / 10; points.push(-0.5, y, 0, 0.5, y, 0); }
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    this.grid = new THREE.LineSegments(geometry, this.gridMaterial); this.grid.visible = visible; this.operator.add(this.grid); this.gridHalfWidth = halfWidth;
  }

  private createRig(phone: SpatialPhone): Rig {
    const own: { dispose(): void }[] = []; const ownMaterials: LineMaterial[] = []; const ownLabels: Label[] = [];
    const lineMaterial = (width: number, opacity = 1) => { const material = this.material(phone.color, width, { opacity }); ownMaterials.push(material); return material; };
    const station = new THREE.Group();
    // Station mark and label.
    const markMaterial = lineMaterial(1.4);
    station.add(new THREE.Mesh(this.markGeometry.disc, this.discMaterial), new Line2(this.markGeometry.ring, markMaterial), new LineSegments2(this.markGeometry.cross, markMaterial));
    const label = this.label(phone.label, '#2e3033', 16, phone.color); label.sprite.center.set(0.5, 1.15); label.sprite.position.set(-STATION_LABEL_BACK_M, 0, 0); ownLabels.push(label); station.add(label.sprite);
    // The phone body in its color.
    const bodyMaterial = new THREE.MeshLambertMaterial({ color: tint(phone.color, 0.22), transparent: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    const screenMaterial = new THREE.MeshBasicMaterial({ color: SCREEN, transparent: true });
    const edgeMaterial = lineMaterial(1.6);
    own.push(bodyMaterial, screenMaterial);
    const body = new THREE.Group();
    body.add(new THREE.Mesh(this.bodyGeometry, bodyMaterial), new LineSegments2(this.edgeGeometry, edgeMaterial), new THREE.Mesh(this.screenGeometry, screenMaterial), new LineSegments2(this.arrowGeometry, edgeMaterial));
    const bodyAxes = new THREE.Group();
    for (const { geometry, material } of this.axisLines) { const axis = new Line2(geometry, material); axis.renderOrder = 5; bodyAxes.add(axis); }
    body.add(bodyAxes); station.add(body);
    // Calibration aids, at the station.
    const aids = new THREE.Group();
    const ring = new THREE.LineLoop(this.aidGeometry.ring, this.aidMaterial); ring.computeLineDistances();
    const rise = new THREE.LineSegments(this.aidGeometry.rise, this.riseMaterial);
    const reachGeometry = new THREE.BufferGeometry(); reachGeometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3)); own.push(reachGeometry);
    const reach = new THREE.Line(reachGeometry, this.reachMaterial);
    aids.add(ring, rise, reach); station.add(aids);
    const trailMaterial = lineMaterial(2, 0.85);
    this.operator.add(station);
    const rig: Rig = { color: phone.color, station, label, body, bodyAxes, fading: [bodyMaterial, screenMaterial, edgeMaterial], trailMaterial, trailStamp: NaN, aids, ring, rise, reach,
      dispose: () => {
        this.operator.remove(station); rig.trail?.geometry.dispose();
        for (const item of own) item.dispose();
        for (const material of ownMaterials) { material.dispose(); this.materials.delete(material); }
        for (const item of ownLabels) { item.dispose(); this.labels.delete(item); }
      } };
    return rig;
  }

  private resize() {
    const width = Math.max(1, this.host.clientWidth), height = Math.max(1, this.host.clientHeight);
    this.camera.aspect = width / height; this.camera.updateProjectionMatrix(); this.renderer.setSize(width, height, false);
    for (const material of this.materials) material.resolution.set(width, height);
    for (const label of this.labels) label.resize(height);
  }

  /** Picks a preset direction and frames the labelled origin axes, every station and every phone. */
  setView(view: View) { this.view = view; this.userMoved = false; this.fit(); }

  private fit() {
    // The axis labels sit just past each axis tip, so they count as part of what must stay in view.
    const tip = AXIS_M + 0.05;
    const points = [new THREE.Vector3(), new THREE.Vector3(tip, 0, 0), new THREE.Vector3(0, tip, 0), new THREE.Vector3(0, 0, tip)];
    for (const phone of this.sources.phones()) {
      // Room for the station label under the mark.
      points.push(new THREE.Vector3(-STATION_LABEL_BACK_M - 0.06, phone.offset, 0));
      const p = this.sources.live(phone.id)?.pose?.position;
      if (p) points.push(new THREE.Vector3(p.x, phone.offset + p.y, p.z));
    }
    const box = new THREE.Box3().setFromPoints(points);
    const center = box.getCenter(new THREE.Vector3());
    const extent = Math.max(0.3, box.getSize(new THREE.Vector3()).length() / 2 + 0.1);
    center.applyQuaternion(this.operator.quaternion);
    const distance = extent / Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * 1.1;
    this.camera.position.copy(center).addScaledVector(VIEW_DIRECTIONS[this.view], distance);
    this.orbit.target.copy(center); this.orbit.update();
  }

  private update() {
    const shown = this.sources.shown; const phones = this.sources.phones();
    if (this.grid) this.grid.visible = shown('grid');
    this.frameAxes.visible = shown('frame');
    // An axis pointing straight at or away from the camera has its label on top of the origin; fade it.
    this.camera.getWorldDirection(this.viewDirection);
    for (const label of this.frameLabels) label.sprite.material.opacity = Math.abs(label.direction.dot(this.viewDirection)) > 0.9 ? 0.2 : 1;

    // Phones that went away lose their rigs; a phone whose color changed gets a new one.
    const ids = new Set(phones.map(phone => phone.id));
    for (const [id, rig] of this.rigs) if (!ids.has(id) || phones.find(phone => phone.id === id)!.color !== rig.color) { rig.dispose(); this.rigs.delete(id); }
    // Each station label grows away from the centre, clear of the frame axis labels (or straight down in
    // the Side view and wherever a station sits at the centre), then drops a row at a time until it clears
    // the labels placed before it. Overlay stacks them; neighbours in the Top view take turns.
    const width = Math.max(1, this.host.clientWidth), height = Math.max(1, this.host.clientHeight);
    const origin = this.projected.origin.set(0, 0, 0).applyMatrix4(this.operator.matrixWorld).project(this.camera);
    const placed: Box[] = [];
    let refit = false;
    phones.forEach(phone => {
      let rig = this.rigs.get(phone.id); if (!rig) { rig = this.createRig(phone); this.rigs.set(phone.id, rig); }
      const live = this.sources.live(phone.id); const pose = live?.pose; const present = !!live?.presence.present;
      rig.station.position.set(0, phone.offset, 0);
      rig.label.setText(phone.label);
      const dx = (this.projected.station.set(0, phone.offset, 0).applyMatrix4(this.operator.matrixWorld).project(this.camera).x - origin.x) * width / 2;
      const cx = this.view === 'side' || Math.abs(dx) < 4 ? 0.5 : dx > 0 ? 0.1 : 0.9;
      const anchor = this.projected.station.set(-STATION_LABEL_BACK_M, phone.offset, 0).applyMatrix4(this.operator.matrixWorld).project(this.camera);
      const row = placeLabel(placed, { x: (anchor.x + 1) / 2 * width, y: (1 - anchor.y) / 2 * height, cx, ...rig.label.pixelSize() }, phones.length);
      rig.label.sprite.center.set(cx, LABEL_DROP + row * LABEL_ROW);
      rig.body.visible = !!pose && phone.shown.pose;
      rig.bodyAxes.visible = phone.shown.axes;
      if (pose) {
        rig.body.position.set(pose.position.x, pose.position.y, pose.position.z);
        rig.body.quaternion.set(pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w);
        const opacity = present ? 1 : 0.35; for (const material of rig.fading) material.opacity = opacity;
      }
      // A new phone session or calibration is a new frame: re-frame the camera unless the operator has moved it.
      const trail = live?.trail ?? []; const last = trail.at(-1);
      if (last?.key && last.key !== rig.frameKey) { rig.frameKey = last.key; refit = true; }
      if (last?.t !== rig.trailStamp) {
        rig.trailStamp = last?.t ?? NaN;
        if (rig.trail) { rig.station.remove(rig.trail); rig.trail.geometry.dispose(); rig.trail = undefined; }
        const points: number[] = [];
        if (last) for (const sample of trail) if (sample.key === last.key) points.push(sample.p.x, sample.p.y, sample.p.z);
        if (points.length >= 6) { const geometry = new LineGeometry(); geometry.setPositions(points); rig.trail = new Line2(geometry, rig.trailMaterial); rig.station.add(rig.trail); }
      }
      if (rig.trail) rig.trail.visible = phone.shown.trail && present;
      this.updateAids(rig, phone.config, pose?.position, shown('calibration'));
    });

    const layout = phones.map(phone => `${phone.id}:${phone.offset}`).join('|');
    if (layout !== this.layoutKey) { this.layoutKey = layout; refit = true; this.setGrid(Math.max(0.5, Math.ceil((Math.max(0, ...phones.map(phone => Math.abs(phone.offset))) + GRID_MARGIN_M) * 10) / 10)); }
    if (refit && !this.userMoved) this.fit();
  }

  /** The 30 mm ring (or rise) a calibrating phone has to clear, and a line from it to the phone. */
  private updateAids(rig: Rig, config: ConfigMessage | undefined, position: { x: number; y: number; z: number } | undefined, shown: boolean) {
    const calibration = config?.calibration;
    const step = knownStep(calibration?.step);
    const capturing = calibration?.status === 'capturing' && !!step && step !== 'flat' && !!calibration.anchor;
    const validating = calibration?.status === 'captured' && !!calibration.check?.step;
    rig.aids.visible = shown && (capturing || validating) && !!position;
    if (!rig.aids.visible || !position || !calibration) return;
    const from = capturing ? calibration.anchor! : { x: 0, y: 0, z: 0 };
    rig.ring.position.set(from.x, from.y, from.z); rig.rise.position.set(from.x, from.y, from.z);
    rig.ring.visible = !(capturing && step === 'up'); rig.rise.visible = capturing && step === 'up';
    const positions = rig.reach.geometry.getAttribute('position') as THREE.BufferAttribute;
    positions.setXYZ(0, from.x, from.y, from.z); positions.setXYZ(1, position.x, position.y, position.z); positions.needsUpdate = true;
    rig.reach.computeLineDistances(); rig.reach.geometry.computeBoundingSphere();
  }

  dispose() {
    cancelAnimationFrame(this.raf); this.resizeObserver.disconnect(); this.orbit.dispose();
    for (const rig of this.rigs.values()) rig.dispose(); this.rigs.clear();
    this.grid?.geometry.dispose();
    for (const item of [...this.disposables, ...this.materials, ...this.labels]) item.dispose();
    // Without this the context lives until garbage collection, and a few reconnects hit the browser's limit.
    this.renderer.forceContextLoss(); this.renderer.dispose(); this.renderer.domElement.remove();
  }
}
