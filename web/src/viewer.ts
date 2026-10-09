import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Box3, Toolpath } from '../../shared/toolpath';
import type { HeightMap } from '../../shared/protocol';

/**
 * Preset camera directions. X is always to the right and Y up the screen in the
 * top and default views, so the picture matches the machine, not a skewed 45 degree
 * turntable view. 'default' is that same view tilted slightly down from the front.
 */
export type ViewPreset = 'default' | 'top' | 'front' | 'right' | 'iso';

export interface ViewerColors {
  bg: string; grid: string; cut: string; done: string; rapid: string; tool: string; box: string; map: string;
}

export interface ViewerVisibility { rapids: boolean; map: boolean; tool: boolean; box: boolean }

const DEFAULT_TILT_DEG = 32;
const AXIS = { x: 0xe5484d, y: 0x46a758, z: 0x3e63dd };

const DIRECTIONS: Record<ViewPreset, [number, number, number]> = {
  default: [0, -Math.sin((DEFAULT_TILT_DEG * Math.PI) / 180), Math.cos((DEFAULT_TILT_DEG * Math.PI) / 180)],
  top: [0, -1e-4, 1], // not exactly vertical: keeps "up" well defined so Y stays up the screen
  front: [0, -1, 0],
  right: [1, 0, 0],
  iso: [0.6, -0.6, 0.55],
};

const NICE_STEPS = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];

export class Viewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
  private controls: OrbitControls;
  private ro: ResizeObserver;
  private raf = 0;

  /** Everything in work coordinates lives here, so Z exaggeration is one scale. */
  private world = new THREE.Group();
  private decor = new THREE.Group(); // grid, axes, extents box (rebuilt when the program changes)
  private cutDone = new THREE.LineSegments();
  private cutRest = new THREE.LineSegments();
  private rapid = new THREE.LineSegments();
  private mapLines = new THREE.LineSegments();
  private tool = new THREE.Mesh();

  /** Called whenever the camera moves, so the UI can react (e.g. tool off screen). */
  onViewChange?: () => void;
  private colors!: ViewerColors;
  private fit: Box3 = { minX: 0, maxX: 100, minY: 0, maxY: 100, minZ: -1, maxZ: 1 };
  private zScale = 1;
  private cutLine: Uint32Array = new Uint32Array(0);
  private hasPath = false;
  private toolSize = 5;
  private toolPos?: { x: number; y: number; z: number };
  private box?: Box3;
  private vis: ViewerVisibility = { rapids: true, map: true, tool: true, box: true };

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    // fill the container exactly; the panel decides the size, the canvas never pushes it
    this.renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
    container.appendChild(this.renderer.domElement);

    this.camera.up.set(0, 0, 1);
    this.scene.add(this.world, this.decor);
    this.world.add(this.cutDone, this.cutRest, this.rapid, this.mapLines);
    this.scene.add(this.tool);
    this.tool.visible = false;

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener('change', () => { this.publishCamera(); this.invalidate(); });
    this.controls.screenSpacePanning = true;
    // Same as VCarve and Fusion: wheel zooms, middle-drag pans (right-drag pans too), left-drag rotates
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    // stop the browser's middle-click autoscroll / paste taking over the drag
    const dom = this.renderer.domElement;
    dom.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
    dom.addEventListener('auxclick', (e) => e.preventDefault());

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
  }

  // ---------- public API ----------
  setColors(c: ViewerColors) {
    this.colors = c;
    this.renderer.setClearColor(new THREE.Color(c.bg));
    const mat = (m: THREE.LineSegments, color: string, opacity = 1, overlay = false) => {
      (m.material as THREE.Material)?.dispose?.();
      // overlay lines ignore depth and draw in a fixed order: passes that overlap on the same X/Y
      // (a program cut at several depths) would otherwise fight for the pixels, and the part still
      // to be cut must always be the one you see
      m.material = new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, depthTest: !overlay, depthWrite: !overlay });
    };
    mat(this.cutRest, c.cut, 1, true); mat(this.cutDone, c.done, 1, true); mat(this.rapid, c.rapid, 0.55); mat(this.mapLines, c.map, 0.9);
    this.cutDone.renderOrder = 1; this.cutRest.renderOrder = 2;
    (this.tool.material as THREE.Material)?.dispose?.();
    this.tool.material = new THREE.MeshBasicMaterial({ color: c.tool });
    this.buildDecor();
    this.invalidate();
  }

  setVisible(v: ViewerVisibility) {
    this.vis = v;
    this.rapid.visible = v.rapids;
    this.mapLines.visible = v.map;
    this.tool.visible = v.tool && !!this.toolPos;
    const box = this.decor.getObjectByName('box');
    if (box) box.visible = v.box;
    this.invalidate();
  }

  setToolpath(tp: Toolpath | null) {
    for (const m of [this.cutDone, this.cutRest, this.rapid]) { m.geometry.dispose(); m.geometry = new THREE.BufferGeometry(); }
    this.hasPath = !!tp && (tp.cut.length > 0 || tp.rapid.length > 0);
    this.cutLine = tp?.cutLine ?? new Uint32Array(0);
    if (tp && this.hasPath) {
      const cutAttr = new THREE.BufferAttribute(tp.cut, 3);
      // two views of the same vertices: the done part and the part still to cut
      this.cutDone.geometry.setAttribute('position', cutAttr);
      this.cutRest.geometry.setAttribute('position', cutAttr);
      this.rapid.geometry.setAttribute('position', new THREE.BufferAttribute(tp.rapid, 3));
      this.fit = tp.extents.cut ?? tp.extents.all ?? this.fit;
      this.box = tp.extents.cut ?? tp.extents.all;
    } else {
      this.box = undefined;
      this.fit = { minX: 0, maxX: 100, minY: 0, maxY: 100, minZ: -1, maxZ: 1 };
    }
    this.setProgress(0);
    this.buildDecor();
    this.invalidate();
  }

  /** Lines of the program already acknowledged by the controller. */
  setProgress(doneLines: number) {
    let lo = 0, hi = this.cutLine.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.cutLine[mid] < doneLines) lo = mid + 1; else hi = mid; }
    const total = this.cutLine.length * 2;
    this.cutDone.geometry.setDrawRange(0, lo * 2);
    this.cutRest.geometry.setDrawRange(lo * 2, Math.max(0, total - lo * 2));
    this.invalidate();
  }

  setTool(p: { x: number; y: number; z: number } | null) {
    this.toolPos = p ?? undefined;
    this.tool.visible = this.vis.tool && !!p;
    if (p) this.tool.position.set(p.x, p.y, p.z * this.zScale);
    this.invalidate();
  }

  setHeightMap(hm: HeightMap | null) {
    this.mapLines.geometry.dispose();
    const g = new THREE.BufferGeometry();
    if (hm) {
      const pts: number[] = [];
      const X = (i: number) => hm.minX + ((hm.maxX - hm.minX) * i) / (hm.cols - 1);
      const Y = (j: number) => hm.minY + ((hm.maxY - hm.minY) * j) / (hm.rows - 1);
      for (let j = 0; j < hm.rows; j++) for (let i = 0; i < hm.cols; i++) {
        if (i + 1 < hm.cols) pts.push(X(i), Y(j), hm.z[j][i], X(i + 1), Y(j), hm.z[j][i + 1]);
        if (j + 1 < hm.rows) pts.push(X(i), Y(j), hm.z[j][i], X(i), Y(j + 1), hm.z[j + 1][i]);
      }
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    }
    this.mapLines.geometry = g;
    this.invalidate();
  }

  /** Stretch Z only, so a 0.3 mm surface variation on a 50 mm board can be seen. */
  setZScale(k: number) {
    this.zScale = Math.max(1, k);
    this.world.scale.z = this.zScale;
    if (this.toolPos) this.tool.position.z = this.toolPos.z * this.zScale;
    this.buildDecor();
    this.invalidate();
  }

  setView(preset: ViewPreset, frame: Box3 = this.fit) {
    const b = frame, k = this.zScale;
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2, cz = ((b.minZ + b.maxZ) / 2) * k;
    const radius = Math.max(5, 0.5 * Math.hypot(b.maxX - b.minX, b.maxY - b.minY, (b.maxZ - b.minZ) * k));
    const vfov = (this.camera.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const dist = (radius / Math.sin(Math.min(vfov, hfov) / 2)) * 1.08;
    const d = new THREE.Vector3(...DIRECTIONS[preset]).normalize();
    this.controls.target.set(cx, cy, cz);
    this.camera.position.set(cx + d.x * dist, cy + d.y * dist, cz + d.z * dist);
    this.camera.near = dist / 200; this.camera.far = dist * 50;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.publishCamera();
    this.invalidate();
  }

  /** Frame the program and the tool together, wherever the tool is. */
  fitAll(preset: ViewPreset) {
    const b = this.fit, p = this.toolPos;
    this.setView(preset, p ? {
      minX: Math.min(b.minX, p.x), maxX: Math.max(b.maxX, p.x),
      minY: Math.min(b.minY, p.y), maxY: Math.max(b.maxY, p.y),
      minZ: Math.min(b.minZ, p.z), maxZ: Math.max(b.maxZ, p.z),
    } : b);
  }

  /** Is the tool marker inside the picture right now? null when there is no tool to show. */
  toolInView(): boolean | null {
    if (!this.toolPos || !this.tool.visible) return null;
    const v = this.tool.position.clone().project(this.camera);
    return Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 && v.z >= -1 && v.z <= 1;
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.controls.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((x) => x.dispose());
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ---------- internals ----------
  private resize() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  /** Camera target and position as data attributes, so the view can be checked without a screenshot. */
  private publishCamera() {
    const t = this.controls.target, c = this.camera.position;
    const r = (n: number) => n.toFixed(3);
    this.container.dataset.target = `${r(t.x)},${r(t.y)},${r(t.z)}`;
    this.container.dataset.camera = `${r(c.x)},${r(c.y)},${r(c.z)}`;
    this.onViewChange?.();
  }

  private invalidate() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      // keep the tool marker a constant size on screen, so it can always be found
      // whether the view shows a 50 mm board or the whole machine
      const d = this.camera.position.distanceTo(this.tool.position);
      this.tool.scale.setScalar(Math.max(0.2, (d * 0.045) / this.toolSize));
      this.renderer.render(this.scene, this.camera);
    });
  }

  /** Grid, origin axes, extents box and tool marker, sized to the program. */
  private buildDecor() {
    if (!this.colors) return;
    for (const o of [...this.decor.children]) {
      this.decor.remove(o);
      (o as THREE.LineSegments).geometry?.dispose?.();
      ((o as THREE.LineSegments).material as THREE.Material)?.dispose?.();
    }
    const b = this.fit, k = this.zScale;
    // the grid covers the work origin as well as the program
    const x0 = Math.min(0, b.minX), x1 = Math.max(0, b.maxX), y0 = Math.min(0, b.minY), y1 = Math.max(0, b.maxY);
    const span = Math.max(x1 - x0, y1 - y0, 10);
    const step = NICE_STEPS.find((s) => span / s <= 30) ?? 1000;
    const gx0 = Math.floor(x0 / step - 1) * step, gx1 = Math.ceil(x1 / step + 1) * step;
    const gy0 = Math.floor(y0 / step - 1) * step, gy1 = Math.ceil(y1 / step + 1) * step;
    const g: number[] = [];
    for (let x = gx0; x <= gx1 + 1e-9; x += step) g.push(x, gy0, 0, x, gy1, 0);
    for (let y = gy0; y <= gy1 + 1e-9; y += step) g.push(gx0, y, 0, gx1, y, 0);
    this.decor.add(this.lines(g, this.colors.grid, 0.6));

    const L = Math.max(5, span * 0.1);
    this.decor.add(this.lines([0, 0, 0, L, 0, 0], '#' + AXIS.x.toString(16), 1));
    this.decor.add(this.lines([0, 0, 0, 0, L, 0], '#' + AXIS.y.toString(16), 1));
    this.decor.add(this.lines([0, 0, 0, 0, 0, L * 0.6 * k], '#' + AXIS.z.toString(16), 1));

    if (this.box) {
      const { minX: a, maxX: A, minY: c, maxY: C, minZ: e, maxZ: E } = this.box;
      const [z0, z1] = [e * k, E * k];
      const v = [[a, c, z0], [A, c, z0], [A, C, z0], [a, C, z0], [a, c, z1], [A, c, z1], [A, C, z1], [a, C, z1]];
      const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
      const pts: number[] = [];
      for (const [i, j] of edges) pts.push(...v[i], ...v[j]);
      const box = this.lines(pts, this.colors.box, 0.7);
      box.name = 'box';
      box.visible = this.vis.box;
      this.decor.add(box);
    }

    // tool marker: a cone with its tip at the tool position
    this.toolSize = Math.min(25, Math.max(2, span * 0.05));
    this.tool.geometry.dispose();
    const cone = new THREE.ConeGeometry(this.toolSize * 0.25, this.toolSize, 16);
    cone.translate(0, -this.toolSize / 2, 0);
    cone.rotateX(-Math.PI / 2); // tip at the origin, body above it (+Z)
    this.tool.geometry = cone;
  }

  private lines(points: number[], color: string, opacity: number) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
  }
}
