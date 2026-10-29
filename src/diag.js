// Diagnostic view (?diag=1): shows what the tracker actually sees, so problems can be pinned on
// tracking (MediaPipe) or on the rig (this app).
//   red dots     raw MediaPipe body landmarks this frame (hollow = low confidence)
//   white dots   the smoothed, gated landmarks the skeleton is built from
//   orange dots  raw hand landmarks; yellow = tracked hand landmarks
// plus a panel of numbers over the last ~3 s for the first person in view.

const BONES = { 'arm L': [11, 13], 'arm R': [12, 14], 'forearm L': [13, 15], 'forearm R': [14, 16], 'thigh L': [23, 25], 'thigh R': [24, 26], 'shin L': [25, 27], 'shin R': [26, 28] };
const HISTORY = 90;

export class Diagnostics {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.lengths = Object.fromEntries(Object.keys(BONES).map((k) => [k, []]));
    this.lag = [];
    this.jumps = [];
    this.prevCenter = null;
  }

  draw({ frame, people, hands, mirror, videoW, videoH, now }) {
    const c = this.canvas, ctx = this.ctx;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = window.innerWidth, H = window.innerHeight;
    if (c.width !== Math.round(W * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const s = Math.max(W / videoW, H / videoH);
    const toScreen = (p) => {
      const x = (W - videoW * s) / 2 + p.x * videoW * s;
      return { x: mirror ? W - x : x, y: (H - videoH * s) / 2 + p.y * videoH * s };
    };
    const dot = (p, r, color, filled = true) => {
      const q = toScreen(p);
      ctx.beginPath();
      ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
      if (filled) { ctx.fillStyle = color; ctx.fill(); } else { ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke(); }
    };

    for (const body of frame?.pose || []) for (const [x, y, , v] of body.image) dot({ x, y }, 4, '#ff3b30', v > 0.5);
    for (const hand of frame?.hands || []) for (const [x, y] of hand.image) dot({ x, y }, 3, '#ff9500');
    for (const p of people) for (const l of p.lm) if (l.v > 0.3) dot(l, 2.5, '#ffffff');
    for (const h of hands) for (const l of h.lm) dot(l, 2, '#ffd60a');

    // Stability numbers for the first tracked person.
    const lines = [`raw bodies ${frame?.pose.length ?? 0} · tracked ${people.length}   raw hands ${frame?.hands.length ?? 0} · tracked ${hands.length}   faces ${frame?.faces.length ?? 0}`];
    const p = people[0];
    if (p) {
      const w = p.world;
      for (const [name, [a, b]] of Object.entries(BONES)) {
        const hist = this.lengths[name];
        if (p.lm[a].v > 0.5 && p.lm[b].v > 0.5) hist.push(Math.hypot(w[a].x - w[b].x, w[a].y - w[b].y, w[a].z - w[b].z));
        if (hist.length > HISTORY) hist.shift();
      }
      // Bone lengths should never change; how much they wobble shows depth noise and mis-tracking.
      const wobble = Object.entries(this.lengths).map(([name, h]) => {
        if (h.length < 10) return `${name} -`;
        const mean = h.reduce((x, y) => x + y, 0) / h.length;
        const sd = Math.sqrt(h.reduce((x, y) => x + (y - mean) ** 2, 0) / h.length);
        return `${name} ${(100 * sd / mean).toFixed(0)}%`;
      });
      lines.push(`bone length wobble: ${wobble.slice(0, 4).join('  ')}`);
      lines.push(`                    ${wobble.slice(4).join('  ')}`);

      // How far the drawn skeleton trails the raw landmarks (smoothing and holding cost).
      const raw = (frame?.pose || []).map((b) => b.image).sort((A, B) => Math.hypot(A[11][0] - p.lm[11].x, A[11][1] - p.lm[11].y) - Math.hypot(B[11][0] - p.lm[11].x, B[11][1] - p.lm[11].y))[0];
      if (raw) {
        let sum = 0, n = 0, held = 0;
        raw.forEach(([x, y, , v], i) => {
          if (v < 0.5) { held++; return; }
          const a = toScreen({ x, y }), b = toScreen(p.lm[i]);
          sum += Math.hypot(a.x - b.x, a.y - b.y);
          n++;
        });
        this.lag.push(n ? sum / n : 0);
        if (this.lag.length > HISTORY) this.lag.shift();
        lines.push(`skeleton trails raw by ${(this.lag.reduce((x, y) => x + y, 0) / this.lag.length).toFixed(1)} px avg   low-confidence landmarks ${held}/33`);
      }

      // Sudden jumps of the whole torso between frames.
      const cx = (p.lm[11].x + p.lm[12].x + p.lm[23].x + p.lm[24].x) / 4, cy = (p.lm[11].y + p.lm[12].y + p.lm[23].y + p.lm[24].y) / 4;
      if (this.prevCenter && Math.hypot(cx - this.prevCenter.x, cy - this.prevCenter.y) > 0.04) this.jumps.push(now);
      this.prevCenter = { x: cx, y: cy };
      this.jumps = this.jumps.filter((t) => now - t < 3000);
      lines.push(`torso jumps (>4% of frame) in last 3 s: ${this.jumps.length}`);
    }
    const widest = (frame?.faces || []).reduce((m, f) => Math.max(m, f.width), 0);
    lines.push(`widest face ${(widest * 100).toFixed(0)}% of frame (jumpscare at 45%)`);

    ctx.font = '12px ui-monospace, Menlo, monospace';
    const top = 44;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(12, top - 14, Math.min(W - 24, 640), lines.length * 16 + 10);
    ctx.fillStyle = '#ffffff';
    lines.forEach((l, i) => ctx.fillText(l, 20, top + i * 16));
  }
}
