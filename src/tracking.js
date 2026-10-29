// Landmark tracking that favours stability over responsiveness.
//
// Raw MediaPipe output flickers: confidence dips for a frame, occluded joints get guessed wildly,
// and occlusion can conjure phantom extra bodies. So each tracked body or hand:
//   - must be seen for a few frames before it appears, and can't overlap one already tracked;
//   - only updates a landmark while it is confidently seen, and otherwise holds its last good value;
//   - rejects sudden jumps unless they persist, and freezes on implausible frames until the new
//     reading has persisted long enough to be believed;
//   - is drawn from eased positions, updated every render frame, so motion glides rather than steps;
//   - keeps existing, frozen, for a while after it stops being detected, then fades out.

class LowPass {
  constructor() { this.y = null; }
  filter(x, a) {
    this.y = this.y === null ? x : a * x + (1 - a) * this.y;
    return this.y;
  }
}

const alpha = (cutoff, dt) => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

// One Euro: heavy smoothing when still, light smoothing when moving fast.
export class OneEuro {
  constructor(minCutoff = 1.0, beta = 6, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = new LowPass();
    this.dx = new LowPass();
    this.prev = null;
  }
  filter(value, dt) {
    if (this.prev === null || dt <= 0) {
      this.prev = value;
      this.x.y = value;
      this.dx.y = 0;
      return value;
    }
    const d = this.dx.filter((value - this.prev) / dt, alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(d);
    this.prev = value;
    return this.x.filter(value, alpha(cutoff, dt));
  }
}

// Each detection is { image: [{x,y,visibility}], world: [{x,y,z}], extra }.
export class Tracker {
  constructor({
    count,
    centerIds, // landmarks whose mean identifies the same body/hand from frame to frame
    coreIds = centerIds, // landmarks that must be seen for a frame to count at all
    minCore = 1,
    useVisibility = true, // hand landmarks carry no visibility, so hands turn this off
    maxJump = 0.25, // furthest (normalised) a body/hand can move between frames and still match
    minSeparation = 0, // a new detection this close to a tracked one is a duplicate
    confirmFrames = 1, // frames a new body/hand must be seen before it is shown
    maxStep = 0.12, // a landmark moving further than this in one frame is held as an outlier
    holdMs = 1000, // how long a lost body/hand stays, frozen, before fading out
    fadeMs = 300,
    easeMs = 70, // time constant of the display easing
    validate = null, // (det, item) => false to freeze on implausible frames
  }) {
    Object.assign(this, { count, centerIds, coreIds, minCore, useVisibility, maxJump, minSeparation, confirmFrames, maxStep, holdMs, fadeMs, easeMs, validate });
    this.items = [];
    this.nextId = 1;
    this.lastTick = null;
  }

  vis(r) { return this.useVisibility ? r.visibility ?? 1 : 1; }

  center(lm) {
    let x = 0, y = 0;
    for (const i of this.centerIds) { x += lm[i].x; y += lm[i].y; }
    return { x: x / this.centerIds.length, y: y / this.centerIds.length };
  }

  create(c, t) {
    const N = this.count;
    const item = {
      id: this.nextId++,
      fImage: Array.from({ length: N }, () => [new OneEuro(1.0, 4), new OneEuro(1.0, 4)]),
      // Depth is the noisiest axis, so world landmarks get heavier smoothing.
      fWorld: Array.from({ length: N }, () => [new OneEuro(0.6, 3), new OneEuro(0.6, 3), new OneEuro(0.4, 2)]),
      // Targets from the filters, and the eased copies everything else reads.
      tImage: Array.from({ length: N }, () => ({ x: 0, y: 0 })),
      tWorld: Array.from({ length: N }, () => ({ x: 0, y: 0, z: 0 })),
      lm: Array.from({ length: N }, () => ({ x: 0, y: 0, v: 0 })),
      world: Array.from({ length: N }, () => ({ x: 0, y: 0, z: 0 })),
      lastUpdate: new Float64Array(N).fill(t),
      rejects: new Uint8Array(N),
      badFrames: 0,
      frames: 0,
      alpha: 0,
      fresh: true,
      center: c,
      goodT: t, // last frame it was detected reliably
      extra: null,
    };
    this.items.push(item);
    return item;
  }

  update(detections, t) {
    const unmatched = new Set(this.items);
    for (const det of detections) {
      const c = this.center(det.image);
      let item = null, bestD = this.maxJump;
      for (const p of unmatched) {
        const d = Math.hypot(p.center.x - c.x, p.center.y - c.y);
        if (d < bestD) { item = p; bestD = d; }
      }
      const core = this.coreIds.filter((i) => this.vis(det.image[i]) > 0.5).length;
      if (!item) {
        if (core < this.minCore) continue; // don't start tracking from a bad frame
        if (this.items.some((p) => Math.hypot(p.center.x - c.x, p.center.y - c.y) < this.minSeparation)) continue;
        item = this.create(c, t);
      } else {
        unmatched.delete(item);
      }
      item.extra = det.extra;
      // Freeze on unreliable frames rather than following garbage, but if the "implausible"
      // reading keeps coming for ~0.3 s it is probably real (someone stepped closer): accept it.
      const implausible = !item.fresh && this.validate && !this.validate(det, item);
      if (!item.fresh && (core < this.minCore || (implausible && ++item.badFrames < 10))) continue;
      item.badFrames = 0;
      this.apply(item, det, t);
      item.center = c;
      item.goodT = t;
      item.frames++;
      item.fresh = false;
    }
    this.items = this.items.filter((p) => t - p.goodT < this.holdMs + this.fadeMs && (p.frames >= this.confirmFrames || t - p.goodT < 200));
    return this.items.filter((p) => p.frames >= this.confirmFrames);
  }

  apply(item, det, t) {
    const snap = item.fresh;
    for (let i = 0; i < this.count; i++) {
      const r = det.image[i];
      const vis = this.vis(r);
      const L = item.lm[i];
      const T = item.tImage[i];
      const jump = Math.hypot(r.x - T.x, r.y - T.y);
      const outlier = !snap && jump > this.maxStep && item.rejects[i] < 6;
      // Visibility moves slowly, so bones fade rather than blink.
      L.v += (vis - L.v) * (snap ? 1 : vis > L.v ? 0.25 : 0.08);
      if (!snap && (vis < 0.5 || outlier)) {
        if (outlier) item.rejects[i]++;
        continue; // hold the last good value
      }
      item.rejects[i] = 0;
      const dt = Math.min(0.1, (t - item.lastUpdate[i]) / 1000);
      item.lastUpdate[i] = t;
      T.x = item.fImage[i][0].filter(r.x, dt);
      T.y = item.fImage[i][1].filter(r.y, dt);
      const w = det.world[i];
      const W = item.tWorld[i];
      W.x = item.fWorld[i][0].filter(w.x, dt);
      W.y = item.fWorld[i][1].filter(w.y, dt);
      W.z = item.fWorld[i][2].filter(w.z, dt);
      if (snap) {
        Object.assign(L, { x: T.x, y: T.y });
        Object.assign(item.world[i], W);
      }
    }
  }

  // Called every render frame: ease displayed landmarks toward their targets and update fades.
  tick(t) {
    const dt = this.lastTick === null ? 0 : Math.min(0.1, (t - this.lastTick) / 1000);
    this.lastTick = t;
    const k = 1 - Math.exp(-(dt * 1000) / this.easeMs);
    const shown = [];
    for (const p of this.items) {
      if (p.frames < this.confirmFrames) continue;
      for (let i = 0; i < this.count; i++) {
        const L = p.lm[i], T = p.tImage[i], W = p.world[i], TW = p.tWorld[i];
        L.x += (T.x - L.x) * k;
        L.y += (T.y - L.y) * k;
        W.x += (TW.x - W.x) * k;
        W.y += (TW.y - W.y) * k;
        W.z += (TW.z - W.z) * k;
      }
      const lost = t - p.goodT;
      const target = lost < this.holdMs ? 1 : Math.max(0, 1 - (lost - this.holdMs) / this.fadeMs);
      p.alpha = target >= p.alpha ? Math.min(target, p.alpha + dt * 4) : target;
      shown.push(p);
    }
    return shown;
  }
}
