// engine.js — the sketching engine: infinite-canvas rendering, pen input
// (pressure-sensitive strokes, flip-to-erase), pinch/rotate/pan gestures,
// undo/redo. No Electron/Node APIs used here — pure DOM/Canvas so it is
// easy to reason about and test in isolation.

class SketchEngine {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true });

    // Document state
    this.strokes = [];       // committed strokes: {id, color, baseWidth, points:[{x,y,pressure}]}
    this.currentStroke = null;
    this.history = [];       // undo stack: {type:'add'|'erase', stroke}
    this.redoStack = [];

    // View transform (world <-> screen)
    this.view = { centerX: 0, centerY: 0, scale: 1, rotation: 0 };

    // Settings
    this.dotGridEnabled = false;
    this.baseWidth = 4;
    this.minWidth = 1;
    this.maxWidth = 24;
    this.currentColor = '#1a1a1a';
    // 0 = pressure ignored (constant baseWidth), 1 = normal pressure range,
    // >1 = exaggerated pressure response.
    this.pressureSensitivity = 1;
    // How many interpolated points to insert between each pair of raw
    // pointer samples when rendering, to smooth out visible faceting.
    // Raw samples are already dense (pointermove reads getCoalescedEvents,
    // i.e. full hardware sample rate), so this only needs to fair out
    // minor jitter, not compensate for sparse input — keep it small, since
    // it directly multiplies the per-frame outline point count and cost.
    // Cached per committed stroke (see _smoothCache).
    this.curveSamples = 2;
    this._smoothCache = new Map(); // strokeId -> resampled {x,y,pressure}[]

    // Gesture tracking
    this.activePointers = new Map(); // pointerId -> {x,y,type}
    this.gestureStart = null;        // snapshot of view + pointer geometry at gesture start
    this.isPanningWithMouse = false;
    this.spaceHeld = false;

    // Eraser hit radius in world units at scale 1
    this.eraserRadius = 14;

    this.onChange = null;      // callback(): fired when doc content changes (for autosave)
    this.onScreenshotRequested = null; // callback(): pen barrel-button trigger
    this.onViewChange = null;  // callback(scalePercent)

    this._resizeObserver = new ResizeObserver(() => this._resizeCanvas());
    this._resizeObserver.observe(canvas);
    this._resizeCanvas();
    this._bindEvents();
    this._raf = null;
    this.requestRender();
  }

  // ---------- Canvas sizing ----------

  _resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.cssWidth = rect.width;
    this.cssHeight = rect.height;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.dpr = dpr;
    this.requestRender();
  }

  // ---------- Coordinate transforms ----------

  screenToWorld(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return this._localToWorld(clientX - rect.left, clientY - rect.top);
  }

  // Same as screenToWorld but takes coordinates already relative to the
  // canvas's own top-left (no getBoundingClientRect involved) — used by
  // _drawDotGrid, which works in canvas-local space and previously passed
  // raw 0..cssWidth values into screenToWorld, which then subtracted
  // rect.left again (the sidebar's width) on top, shifting the computed
  // visible bounds and cutting the grid off along the left edge.
  _localToWorld(localX, localY) {
    const sx = localX - this.cssWidth / 2;
    const sy = localY - this.cssHeight / 2;
    const { scale, rotation, centerX, centerY } = this.view;
    const cos = Math.cos(-rotation);
    const sin = Math.sin(-rotation);
    const dx = sx / scale;
    const dy = sy / scale;
    const wx = dx * cos - dy * sin;
    const wy = dx * sin + dy * cos;
    return { x: centerX + wx, y: centerY + wy };
  }

  // ---------- Event binding ----------

  _bindEvents() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    c.addEventListener('pointermove', (e) => this._onPointerMove(e));
    c.addEventListener('pointerup', (e) => this._onPointerUp(e));
    c.addEventListener('pointercancel', (e) => this._onPointerUp(e));
    c.addEventListener('pointerleave', (e) => {
      if (this.activePointers.size <= 1) this._onPointerUp(e);
    });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') this.spaceHeld = true;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        this.undo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault();
        this.redo();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') this.spaceHeld = false;
    });
  }

  static isEraserContact(e) {
    // Surface Pen "flip to erase": the eraser end reports pointerType 'pen'
    // with the eraser bit set in `buttons` (0x20), and on some drivers
    // `button === 5` on the initial pointerdown.
    return e.pointerType === 'pen' && ((e.buttons & 0x20) !== 0 || e.button === 5);
  }

  static isPenBarrelButton(e) {
    // Surface Pen side (barrel) button — reported as the secondary button.
    // Distinct from the eraser tip and from the pen's OS-reserved top
    // button (which the OS intercepts before it ever reaches this app).
    return e.pointerType === 'pen' && (e.button === 2 || (e.buttons & 0x02) !== 0);
  }

  _onPointerDown(e) {
    this.canvas.setPointerCapture(e.pointerId);
    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });

    // Two (or more) simultaneous touch points => gesture (pinch/rotate/pan).
    if (this.activePointers.size >= 2 && [...this.activePointers.values()].every(p => p.type === 'touch')) {
      this.currentStroke = null;
      this._beginGesture();
      return;
    }

    if (e.pointerType === 'pen' && SketchEngine.isPenBarrelButton(e)) {
      e.preventDefault();
      if (this.onScreenshotRequested) this.onScreenshotRequested();
      return;
    }

    // Single-finger touch or space+drag => pan, not draw.
    const wantsPan = (e.pointerType === 'touch' && this.activePointers.size === 1) ||
      (this.spaceHeld) ||
      (e.pointerType === 'mouse' && e.button === 1);
    if (wantsPan) {
      this.isPanningWithMouse = true;
      this._panLast = { x: e.clientX, y: e.clientY };
      return;
    }

    if (e.pointerType === 'mouse' && e.button !== 0) return; // only left mouse draws

    const world = this.screenToWorld(e.clientX, e.clientY);
    const pressure = e.pressure > 0 ? e.pressure : 0.5;
    const erasing = SketchEngine.isEraserContact(e);

    if (erasing) {
      this._eraseAt(world);
      this._erasingActive = true;
    } else {
      this.currentStroke = {
        id: `s${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        color: this.currentColor,
        baseWidth: this.baseWidth,
        points: [{ x: world.x, y: world.y, pressure }],
      };
    }
    this.requestRender();
  }

  _onPointerMove(e) {
    if (this.activePointers.has(e.pointerId)) {
      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    }

    if (this.gestureStart) {
      this._updateGesture();
      return;
    }

    if (this.isPanningWithMouse) {
      const dx = e.clientX - this._panLast.x;
      const dy = e.clientY - this._panLast.y;
      this._panLast = { x: e.clientX, y: e.clientY };
      const cos = Math.cos(-this.view.rotation);
      const sin = Math.sin(-this.view.rotation);
      const wdx = (dx * cos - dy * sin) / this.view.scale;
      const wdy = (dx * sin + dy * cos) / this.view.scale;
      this.view.centerX -= wdx;
      this.view.centerY -= wdy;
      this.requestRender();
      return;
    }

    if (this._erasingActive) {
      const world = this.screenToWorld(e.clientX, e.clientY);
      this._eraseAt(world);
      this.requestRender();
      return;
    }

    if (!this.currentStroke) return;
    // Chromium coalesces multiple hardware pen samples into a single
    // pointermove dispatched per animation frame. Reading only e.clientX/Y
    // drops those in-between samples, so fast strokes get too few raw
    // points and render as visible straight-line facets even after
    // Catmull-Rom smoothing. getCoalescedEvents() recovers the full-rate
    // samples so the captured path actually follows the pen.
    const events = (typeof e.getCoalescedEvents === 'function' && e.getCoalescedEvents().length)
      ? e.getCoalescedEvents()
      : [e];
    for (const ev of events) {
      const world = this.screenToWorld(ev.clientX, ev.clientY);
      const pressure = ev.pressure > 0 ? ev.pressure : 0.5;
      this.currentStroke.points.push({ x: world.x, y: world.y, pressure });
    }
    this.requestRender();
  }

  _onPointerUp(e) {
    this.activePointers.delete(e.pointerId);

    if (this.gestureStart && this.activePointers.size < 2) {
      this.gestureStart = null;
    }

    if (this.isPanningWithMouse && (e.pointerType !== 'touch' || this.activePointers.size === 0)) {
      this.isPanningWithMouse = false;
    }

    if (this._erasingActive) {
      this._erasingActive = false;
    }

    if (this.currentStroke) {
      if (this.currentStroke.points.length > 1) {
        this.strokes.push(this.currentStroke);
        this.history.push({ type: 'add', stroke: this.currentStroke });
        this.redoStack = [];
        if (this.onChange) this.onChange();
      }
      this.currentStroke = null;
    }
    this.requestRender();
  }

  // ---------- Eraser (object erase: removes whole stroke under contact) ----------

  _eraseAt(world) {
    const r = this.eraserRadius;
    const remaining = [];
    let erasedAny = false;
    for (const stroke of this.strokes) {
      const hit = stroke.points.some(p => {
        const dx = p.x - world.x, dy = p.y - world.y;
        return dx * dx + dy * dy <= r * r;
      });
      if (hit) {
        this.history.push({ type: 'erase', stroke });
        erasedAny = true;
      } else {
        remaining.push(stroke);
      }
    }
    if (erasedAny) {
      this.strokes = remaining;
      this.redoStack = [];
      if (this.onChange) this.onChange();
    }
  }

  // ---------- Stroke smoothing (Catmull-Rom resampling) ----------
  //
  // Raw pointer samples connected with straight lines produce visible
  // faceting on fast or tightly-curved strokes. We interpolate extra points
  // along a Catmull-Rom spline through the raw samples (and interpolate
  // pressure alongside position) so rendering — and SVG export — follows a
  // smooth curve instead of the raw polyline. Committed strokes' results
  // are cached since the raw points never change once a stroke is done.

  static _catmullRom(p0, p1, p2, p3, t) {
    const t2 = t * t;
    const t3 = t2 * t;
    return 0.5 * (
      (2 * p1) +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3
    );
  }

  static resampleSmooth(points, samplesPerSegment) {
    const n = points.length;
    if (n < 3 || samplesPerSegment <= 1) return points;
    const result = [];
    for (let i = 0; i < n - 1; i++) {
      const p0 = points[Math.max(0, i - 1)];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[Math.min(n - 1, i + 2)];
      for (let s = 0; s < samplesPerSegment; s++) {
        const t = s / samplesPerSegment;
        const x = SketchEngine._catmullRom(p0.x, p1.x, p2.x, p3.x, t);
        const y = SketchEngine._catmullRom(p0.y, p1.y, p2.y, p3.y, t);
        const pressure = SketchEngine._catmullRom(p0.pressure, p1.pressure, p2.pressure, p3.pressure, t);
        result.push({ x, y, pressure: Math.max(0.02, Math.min(1, pressure)) });
      }
    }
    result.push(points[n - 1]);
    return result;
  }

  getSmoothedPoints(stroke) {
    if (stroke === this.currentStroke) {
      // Still growing — resample fresh each call rather than caching.
      return SketchEngine.resampleSmooth(stroke.points, this.curveSamples);
    }
    let cached = this._smoothCache.get(stroke.id);
    if (!cached) {
      cached = SketchEngine.resampleSmooth(stroke.points, this.curveSamples);
      this._smoothCache.set(stroke.id, cached);
    }
    return cached;
  }

  // ---------- Pressure -> stroke width ----------

  widthForPressure(pressure) {
    const raw = this.minWidth + (this.maxWidth - this.minWidth) * pressure;
    const width = this.baseWidth + (raw - this.baseWidth) * this.pressureSensitivity;
    return Math.max(0.5, width);
  }

  // ---------- Undo / redo ----------

  undo() {
    const entry = this.history.pop();
    if (!entry) return;
    if (entry.type === 'add') {
      const idx = this.strokes.findIndex(s => s.id === entry.stroke.id);
      if (idx !== -1) this.strokes.splice(idx, 1);
    } else if (entry.type === 'erase') {
      this.strokes.push(entry.stroke);
    }
    this.redoStack.push(entry);
    if (this.onChange) this.onChange();
    this.requestRender();
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return;
    if (entry.type === 'add') {
      this.strokes.push(entry.stroke);
    } else if (entry.type === 'erase') {
      const idx = this.strokes.findIndex(s => s.id === entry.stroke.id);
      if (idx !== -1) this.strokes.splice(idx, 1);
    }
    this.history.push(entry);
    if (this.onChange) this.onChange();
    this.requestRender();
  }

  // ---------- Gestures (pinch zoom / two-finger rotate & pan) ----------

  _beginGesture() {
    const pts = [...this.activePointers.values()];
    const [a, b] = pts;
    this.gestureStart = {
      dist: Math.hypot(b.x - a.x, b.y - a.y),
      angle: Math.atan2(b.y - a.y, b.x - a.x),
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
      view: { ...this.view },
    };
  }

  _updateGesture() {
    const pts = [...this.activePointers.values()];
    if (pts.length < 2) return;
    const [a, b] = pts;
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const gs = this.gestureStart;
    if (!gs || gs.dist === 0) return;

    const scaleFactor = dist / gs.dist;
    const rotationDelta = angle - gs.angle;

    const newScale = Math.min(8, Math.max(0.1, gs.view.scale * scaleFactor));
    const newRotation = gs.view.rotation + rotationDelta;

    // Keep the gesture midpoint anchored: recompute center so the world
    // point under the midpoint at gesture start stays under the current
    // midpoint.
    const rect = this.canvas.getBoundingClientRect();
    const startScreenX = gs.midX - rect.left - this.cssWidth / 2;
    const startScreenY = gs.midY - rect.top - this.cssHeight / 2;
    const cosStart = Math.cos(-gs.view.rotation);
    const sinStart = Math.sin(-gs.view.rotation);
    const worldAnchorX = gs.view.centerX + (startScreenX * cosStart - startScreenY * sinStart) / gs.view.scale;
    const worldAnchorY = gs.view.centerY + (startScreenX * sinStart + startScreenY * cosStart) / gs.view.scale;

    const nowScreenX = midX - rect.left - this.cssWidth / 2;
    const nowScreenY = midY - rect.top - this.cssHeight / 2;
    const cosNow = Math.cos(-newRotation);
    const sinNow = Math.sin(-newRotation);
    const newCenterX = worldAnchorX - (nowScreenX * cosNow - nowScreenY * sinNow) / newScale;
    const newCenterY = worldAnchorY - (nowScreenX * sinNow + nowScreenY * cosNow) / newScale;

    this.view = { centerX: newCenterX, centerY: newCenterY, scale: newScale, rotation: newRotation };
    this.requestRender();
  }

  _onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey) {
      // Pinch-to-zoom on trackpads is reported as ctrl+wheel by Chromium.
      const factor = Math.exp(-e.deltaY * 0.01);
      this._zoomAt(e.clientX, e.clientY, factor);
    } else {
      // Plain wheel = pan.
      const cos = Math.cos(-this.view.rotation);
      const sin = Math.sin(-this.view.rotation);
      const wdx = (e.deltaX * cos - e.deltaY * sin) / this.view.scale;
      const wdy = (e.deltaX * sin + e.deltaY * cos) / this.view.scale;
      this.view.centerX += wdx;
      this.view.centerY += wdy;
      this.requestRender();
    }
  }

  _zoomAt(clientX, clientY, factor) {
    const before = this.screenToWorld(clientX, clientY);
    this.view.scale = Math.min(8, Math.max(0.1, this.view.scale * factor));
    const after = this.screenToWorld(clientX, clientY);
    this.view.centerX += before.x - after.x;
    this.view.centerY += before.y - after.y;
    this.requestRender();
  }

  resetView() {
    this.view = { centerX: 0, centerY: 0, scale: 1, rotation: 0 };
    this.requestRender();
  }

  // ---------- Rendering ----------

  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this._render();
    });
    if (this.onViewChange) this.onViewChange(Math.round(this.view.scale * 100));
  }

  _applyWorldTransform() {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.translate(this.cssWidth / 2, this.cssHeight / 2);
    ctx.rotate(this.view.rotation);
    ctx.scale(this.view.scale, this.view.scale);
    ctx.translate(-this.view.centerX, -this.view.centerY);
  }

  _drawDotGrid() {
    const ctx = this.ctx;
    const rect = { w: this.cssWidth, h: this.cssHeight };

    // Adaptive spacing: pick a world-unit spacing (a power of two multiple
    // of a base spacing) so the on-screen gap between dots stays within a
    // comfortable pixel range no matter how far zoomed in/out we are. This
    // keeps the grid visually consistent AND keeps the dot count bounded —
    // without this, zooming far out would try to draw millions of dots
    // across the visible world-space extent, which is what created the
    // appearance of the grid "stopping"/being boundary-limited (rendering
    // would stall before covering the whole viewport). With adaptive
    // spacing the grid tiles the same way at any zoom level, i.e. it's
    // truly infinite.
    const baseSpacing = 32;
    const idealScreenPx = 28;
    let spacing = baseSpacing;
    while (spacing * this.view.scale > idealScreenPx * 2) spacing /= 2;
    while (spacing * this.view.scale < idealScreenPx / 2) spacing *= 2;

    // Determine visible world bounds by inverse-transforming the four corners.
    const corners = [
      this._localToWorld(0, 0),
      this._localToWorld(rect.w, 0),
      this._localToWorld(0, rect.h),
      this._localToWorld(rect.w, rect.h),
    ];
    const minX = Math.min(...corners.map(c => c.x));
    const maxX = Math.max(...corners.map(c => c.x));
    const minY = Math.min(...corners.map(c => c.y));
    const maxY = Math.max(...corners.map(c => c.y));

    const startX = Math.floor(minX / spacing) * spacing;
    const startY = Math.floor(minY / spacing) * spacing;

    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    const dotRadius = Math.max(0.6, 1.1 / this.view.scale);
    for (let x = startX; x <= maxX; x += spacing) {
      for (let y = startY; y <= maxY; y += spacing) {
        ctx.beginPath();
        ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // Builds a variable-width ribbon outline (left/right offset point lists)
  // for a stroke, shared by canvas rendering and SVG export so the two
  // stay visually identical. Drawing this as a single filled polygon
  // (instead of many separate stroked line segments with round caps) is
  // both far fewer draw calls and avoids the grainy look of overlapping
  // alpha-blended round caps at high point density.
  getStrokeOutline(stroke) {
    const pts = this.getSmoothedPoints(stroke);
    if (pts.length < 2) return null;
    const left = [];
    const right = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const w = this.widthForPressure(p.pressure);
      let dx, dy;
      if (i === 0) {
        dx = pts[1].x - p.x; dy = pts[1].y - p.y;
      } else if (i === pts.length - 1) {
        dx = p.x - pts[i - 1].x; dy = p.y - pts[i - 1].y;
      } else {
        dx = pts[i + 1].x - pts[i - 1].x; dy = pts[i + 1].y - pts[i - 1].y;
      }
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      left.push({ x: p.x + (nx * w) / 2, y: p.y + (ny * w) / 2 });
      right.push({ x: p.x - (nx * w) / 2, y: p.y - (ny * w) / 2 });
    }
    return { left, right };
  }

  _drawStroke(stroke, ctx = this.ctx) {
    const outline = this.getStrokeOutline(stroke);
    if (!outline) return;
    const { left, right } = outline;
    ctx.fillStyle = stroke.color;
    ctx.beginPath();
    ctx.moveTo(left[0].x, left[0].y);
    for (let i = 1; i < left.length; i++) ctx.lineTo(left[i].x, left[i].y);
    for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i].x, right[i].y);
    ctx.closePath();
    ctx.fill();
  }

  _render() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    this._applyWorldTransform();
    if (this.dotGridEnabled) this._drawDotGrid();
    for (const stroke of this.strokes) this._drawStroke(stroke);
    if (this.currentStroke) this._drawStroke(this.currentStroke);
  }

  // ---------- Serialization ----------

  toDoc() {
    return {
      version: 1,
      strokes: this.strokes,
      view: this.view,
    };
  }

  loadDoc(doc) {
    this.strokes = (doc && doc.strokes) || [];
    this.history = [];
    this.redoStack = [];
    this.currentStroke = null;
    this._smoothCache.clear();
    if (doc && doc.view) this.view = doc.view;
    else this.resetView();
    this.requestRender();
  }

  // ---------- Content bounds (for export bounding-box + margin) ----------

  getContentBounds() {
    if (this.strokes.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const stroke of this.strokes) {
      const halfW = this.maxWidth / 2;
      for (const p of stroke.points) {
        minX = Math.min(minX, p.x - halfW);
        maxX = Math.max(maxX, p.x + halfW);
        minY = Math.min(minY, p.y - halfW);
        maxY = Math.max(maxY, p.y + halfW);
      }
    }
    return { minX, minY, maxX, maxY };
  }
}

window.SketchEngine = SketchEngine;
