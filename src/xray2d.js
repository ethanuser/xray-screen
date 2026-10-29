// Subject scan: X-ray the people in front of the screen with a skeleton drawn straight onto the
// tracked 2D landmarks. Simple and sturdy: every bone sits exactly on the joints it connects, so
// nothing can come loose. Fingers come from the hand tracker when it sees a hand, otherwise from
// the body's wrist/index/pinky points.

const BONE_FILL = 'rgba(235, 235, 235, 0.5)';
const BONE_EDGE = 'rgba(255, 255, 255, 0.95)';
const BONE_FAINT = 'rgba(220, 220, 220, 0.28)';

const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const add = (a, v, s = 1) => ({ x: a.x + v.x * s, y: a.y + v.y * s });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const len = (v) => Math.hypot(v.x, v.y);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const perp = (v) => ({ x: -v.y, y: v.x });
const norm = (v) => { const l = len(v) || 1; return { x: v.x / l, y: v.y / l }; };
// Bones fade in between these visibility scores instead of popping.
const fadeFor = (...ps) => Math.max(0, Math.min(1, (Math.min(...ps.map((p) => p.v)) - 0.3) / 0.3));

// Hand tracker chains (MediaPipe 21-point order): [from, to, width factor].
const HAND_BONES = [
  [1, 2, 1.3], [2, 3, 1.1], [3, 4, 1.0],
  [5, 6, 1.1], [6, 7, 1.0], [7, 8, 0.9],
  [9, 10, 1.1], [10, 11, 1.0], [11, 12, 0.9],
  [13, 14, 1.1], [14, 15, 1.0], [15, 16, 0.9],
  [17, 18, 1.0], [18, 19, 0.9], [19, 20, 0.8],
];

export class XRay2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.bones = document.createElement('canvas');
    this.bctx = this.bones.getContext('2d');
    this.vw = 1280;
    this.vh = 720;
    this.mirror = true;
    this.people = [];
    this.hands = [];
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.dpr = dpr;
    this.W = window.innerWidth;
    this.H = window.innerHeight;
    for (const c of [this.canvas, this.bones]) {
      c.width = Math.round(this.W * dpr);
      c.height = Math.round(this.H * dpr);
    }
  }

  setVideoSize(vw, vh) { this.vw = vw; this.vh = vh; }

  // Cover-fit the video frame to the screen, optionally mirrored.
  toScreen(p) {
    const s = Math.max(this.W / this.vw, this.H / this.vh);
    const x = (this.W - this.vw * s) / 2 + p.x * this.vw * s;
    return { x: this.mirror ? this.W - x : x, y: (this.H - this.vh * s) / 2 + p.y * this.vh * s, v: p.v ?? 1 };
  }

  update(people, hands) {
    this.people = people;
    this.hands = hands;
  }

  render() {
    const { ctx, bctx, dpr } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.clearRect(0, 0, this.bones.width, this.bones.height);
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bctx.lineCap = 'round';
    bctx.lineJoin = 'round';
    for (const person of this.people) {
      if (person.alpha < 0.02) continue;
      const tracked = new Set(this.hands.filter((h) => h.bodyId === person.id).map((h) => h.side));
      drawSkeleton(bctx, person.lm.map((p) => this.toScreen(p)), person.alpha, tracked);
    }
    for (const hand of this.hands) {
      if (hand.alpha < 0.02) continue;
      bctx.globalAlpha = hand.alpha;
      drawHand(bctx, hand.lm.map((p) => this.toScreen({ x: p.x, y: p.y, v: 1 })));
    }
    bctx.globalAlpha = 1;

    // Bones go on additively with a glow so overlaps get brighter, like real film.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.shadowColor = 'rgba(255, 255, 255, 0.6)';
    ctx.shadowBlur = 12 * dpr;
    ctx.drawImage(this.bones, 0, 0);
    ctx.restore();
  }
}

// ---------- skeleton ----------

function drawSkeleton(c, P, alpha, trackedHands) {
  const shL = P[11], shR = P[12], hipL = P[23], hipR = P[24];
  const torsoFade = fadeFor(shL, shR);
  if (torsoFade <= 0) return;
  const withFade = (f, draw) => {
    if (f <= 0) return;
    c.globalAlpha = alpha * f;
    draw();
  };

  const midSh = lerp(shL, shR, 0.5);
  const hipFade = fadeFor(hipL, hipR);
  const shoulderW = dist(shL, shR);
  // Estimate the torso when hips are off screen.
  const down = hipFade > 0 ? sub(lerp(hipL, hipR, 0.5), midSh) : { x: 0, y: shoulderW * 1.25 };
  const torsoLen = len(down);
  const S = Math.max(shoulderW, torsoLen * 0.78);
  const midHip = add(midSh, down);
  const across = { x: (shR.x - shL.x) / 2, y: (shR.y - shL.y) / 2 };

  // Legs first so the pelvis sits over the femur heads.
  for (const [hip, knee, ankle, heel, toe] of [[23, 25, 27, 29, 31], [24, 26, 28, 30, 32]]) {
    withFade(Math.min(hipFade, fadeFor(P[knee])), () => {
      ball(c, P[hip], S * 0.085);
      longBone(c, P[hip], P[knee], S * 0.15);
      ball(c, lerp(P[hip], P[knee], 0.94), S * 0.06, BONE_FAINT); // patella
    });
    withFade(Math.min(hipFade, fadeFor(P[knee], P[ankle])), () => {
      const side = norm(perp(sub(P[ankle], P[knee])));
      longBone(c, P[knee], P[ankle], S * 0.12);
      longBone(c, add(P[knee], side, S * 0.07), add(P[ankle], side, S * 0.05), S * 0.045);
    });
    withFade(Math.min(hipFade, fadeFor(P[ankle], P[heel], P[toe])), () => foot(c, P[ankle], P[heel], P[toe], S));
  }
  withFade(Math.min(torsoFade, hipFade), () => pelvis(c, hipL, hipR, down, S));

  withFade(torsoFade, () => {
    spine(c, P, midSh, midHip, down, S);
    ribcage(c, midSh, down, across, S);
    for (const sh of [shL, shR]) {
      const from = add(lerp(midSh, sh, 0.1), down, -0.02);
      longBone(c, from, lerp(midSh, sh, 0.93), S * 0.05);
    }
  });

  // Arms.
  for (const [sh, el, wr, pinky, index, thumb, side] of [[11, 13, 15, 17, 19, 21, 'L'], [12, 14, 16, 18, 20, 22, 'R']]) {
    withFade(torsoFade, () => ball(c, P[sh], S * 0.08));
    withFade(fadeFor(P[sh], P[el]), () => longBone(c, P[sh], P[el], S * 0.11));
    withFade(fadeFor(P[el], P[wr]), () => {
      const side2 = norm(perp(sub(P[wr], P[el])));
      longBone(c, add(P[el], side2, S * 0.03), add(P[wr], side2, S * 0.035), S * 0.055);
      longBone(c, add(P[el], side2, -S * 0.03), add(P[wr], side2, -S * 0.02), S * 0.05);
    });
    // The hand tracker draws this hand in full when it has it.
    if (!trackedHands.has(side)) {
      withFade(fadeFor(P[wr], P[pinky], P[index]), () => coarseHand(c, P[wr], P[pinky], P[index], P[thumb].v > 0.5 ? P[thumb] : null, S));
    }
  }

  withFade(fadeFor(P[0]), () => skull(c, P, S, midSh));
  c.globalAlpha = 1;
}

function longBone(c, a, b, w) {
  const v = sub(b, a);
  const L = len(v);
  if (L < 2) return;
  const k = w * 0.62; // knob radius
  const r = w * 0.32; // shaft half-width at the middle
  c.save();
  c.translate(a.x, a.y);
  c.rotate(Math.atan2(v.y, v.x));
  c.beginPath();
  c.moveTo(k * 0.5, -k * 0.75);
  c.quadraticCurveTo(L * 0.5, -r * 0.6, L - k * 0.5, -k * 0.75);
  c.arc(L - k * 0.25, -k * 0.38, k * 0.5, -Math.PI * 0.8, Math.PI * 0.35);
  c.arc(L - k * 0.25, k * 0.38, k * 0.5, -Math.PI * 0.35, Math.PI * 0.8);
  c.quadraticCurveTo(L * 0.5, r * 0.6, k * 0.5, k * 0.75);
  c.arc(k * 0.25, k * 0.38, k * 0.5, Math.PI * 0.2, Math.PI * 1.35);
  c.arc(k * 0.25, -k * 0.38, k * 0.5, Math.PI * 0.65, Math.PI * 1.8);
  c.closePath();
  c.fillStyle = BONE_FILL;
  c.fill();
  c.lineWidth = Math.max(1, w * 0.13);
  c.strokeStyle = BONE_EDGE;
  c.stroke();
  // Marrow channel: a slightly darker core down the shaft.
  c.beginPath();
  c.moveTo(k * 1.1, 0);
  c.lineTo(L - k * 1.1, 0);
  c.lineWidth = Math.max(1, r * 0.55);
  c.strokeStyle = 'rgba(0, 0, 0, 0.35)';
  c.stroke();
  c.restore();
}

function ball(c, p, r, fill = BONE_FILL) {
  c.beginPath();
  c.arc(p.x, p.y, r, 0, Math.PI * 2);
  c.fillStyle = fill;
  c.fill();
  c.lineWidth = Math.max(1, r * 0.2);
  c.strokeStyle = BONE_EDGE;
  c.stroke();
}

function stroke(c, w, style, path) {
  c.beginPath();
  path();
  c.lineWidth = Math.max(1, w);
  c.strokeStyle = style;
  c.stroke();
}

function spine(c, P, midSh, midHip, down, S) {
  const dir = norm(down);
  const angle = Math.atan2(dir.y, dir.x) - Math.PI / 2;
  const vertebra = (p, w, h) => {
    c.save();
    c.translate(p.x, p.y);
    c.rotate(angle);
    c.fillStyle = BONE_FILL;
    c.strokeStyle = BONE_EDGE;
    c.lineWidth = Math.max(1, h * 0.18);
    c.beginPath();
    c.rect(-w / 2, -h / 2, w, h);
    c.fill();
    c.stroke();
    c.fillStyle = BONE_FAINT;
    c.fillRect(-w * 1.05, -h * 0.15, w * 2.1, h * 0.3); // transverse processes
    c.restore();
  };

  // Neck: from the base of the skull down to the shoulders.
  const ears = [P[7], P[8]].filter((p) => p.v > 0.5);
  const top = ears.length ? lerp(ears.length === 2 ? lerp(ears[0], ears[1], 0.5) : ears[0], midSh, 0.15) : lerp(P[0], midSh, 0.45);
  for (let i = 0; i < 7; i++) vertebra(lerp(top, midSh, (i + 0.5) / 7), S * 0.085, dist(top, midSh) / 9);
  // Thoracic and lumbar: 17 vertebrae that get bigger going down.
  const n = 17;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    vertebra(lerp(midSh, midHip, t * 0.97), S * 0.085 * (0.75 + 0.55 * t), (len(down) / n) * 0.72);
  }
}

function ribcage(c, top, down, across, S) {
  const W = len(across);
  const ax = norm(across);
  const pt = (t, u) => add(add(top, down, t), ax, u * W);
  const ribW = S * 0.032;
  for (let i = 0; i < 10; i++) {
    const t = 0.05 + i * 0.056;
    const spread = 0.48 + 0.42 * Math.sin((Math.PI / 2) * Math.min(1, (i + 1.5) / 7));
    for (const s of [-1, 1]) {
      // Back of the rib: arcs out from the spine and drops toward the side.
      stroke(c, ribW, BONE_EDGE, () => {
        const a = pt(t, s * 0.05);
        const b1 = pt(t - 0.035, s * spread * 0.55);
        const b2 = pt(t - 0.01, s * spread * 1.02);
        const e = pt(t + 0.11, s * spread * 0.98);
        c.moveTo(a.x, a.y);
        c.bezierCurveTo(b1.x, b1.y, b2.x, b2.y, e.x, e.y);
      });
      // Front of the rib, fainter, sweeping down toward the sternum.
      if (i < 9) {
        stroke(c, ribW * 0.8, BONE_FAINT, () => {
          const e = pt(t + 0.11, s * spread * 0.98);
          const m = pt(t + 0.2, s * spread * 0.7);
          const f = pt(Math.min(0.46, 0.12 + i * 0.045), s * 0.09);
          c.moveTo(e.x, e.y);
          c.quadraticCurveTo(m.x, m.y, f.x, f.y);
        });
      }
    }
  }
  // Sternum.
  stroke(c, S * 0.07, BONE_FAINT, () => {
    const a = pt(0.06, 0);
    const b = pt(0.44, 0);
    c.moveTo(a.x, a.y);
    c.lineTo(b.x, b.y);
  });
}

function pelvis(c, hipL, hipR, down, S) {
  const mid = lerp(hipL, hipR, 0.5);
  const half = { x: (hipR.x - hipL.x) / 2, y: (hipR.y - hipL.y) / 2 };
  const B = len(half);
  const ax = norm(half);
  const dn = norm(down);
  const angle = Math.atan2(ax.y, ax.x);
  const at = (u, v) => add(add(mid, ax, u * B), dn, v * S);
  c.fillStyle = BONE_FILL;
  c.strokeStyle = BONE_EDGE;
  c.lineWidth = Math.max(1, S * 0.025);
  // Iliac wings.
  for (const s of [-1, 1]) {
    const p = at(s * 1.05, -0.13);
    c.beginPath();
    c.ellipse(p.x, p.y, B * 0.78, S * 0.15, angle + s * 0.35, 0, Math.PI * 2);
    c.fill();
    c.stroke();
  }
  // Sacrum.
  c.beginPath();
  const s1 = at(-0.42, -0.2), s2 = at(0.42, -0.2), s3 = at(0, 0.08);
  c.moveTo(s1.x, s1.y);
  c.lineTo(s2.x, s2.y);
  c.lineTo(s3.x, s3.y);
  c.closePath();
  c.fill();
  c.stroke();
  // Pubic ring with the two obturator holes.
  for (const s of [-1, 1]) {
    const p = at(s * 0.5, 0.11);
    c.beginPath();
    c.ellipse(p.x, p.y, B * 0.38, S * 0.075, angle, 0, Math.PI * 2);
    c.lineWidth = Math.max(1, S * 0.035);
    c.stroke();
  }
}

// Fully articulated hand from the hand tracker's 21 points.
function drawHand(c, H) {
  const w = dist(H[0], H[9]) * 0.085;
  c.lineCap = 'round';
  // Carpals: a cluster between the wrist and the knuckles.
  for (let i = 0; i < 8; i++) {
    const p = lerp(H[0], lerp(H[5], H[17], (i % 4) / 3), 0.12 + 0.13 * Math.floor(i / 4));
    ball(c, p, w * 0.65, BONE_FAINT);
  }
  // Metacarpals run from the carpals to each knuckle.
  for (const k of [5, 9, 13, 17]) longBone(c, lerp(H[0], H[k], 0.28), H[k], w * 1.3);
  for (const [a, b, f] of HAND_BONES) longBone(c, H[a], H[b], w * f);
}

// Rough hand from the body's wrist, pinky and index points.
function coarseHand(c, wrist, pinky, index, thumb, S) {
  const w = S * 0.022;
  for (let i = 0; i < 6; i++) {
    const p = lerp(wrist, lerp(index, pinky, (i % 3) / 2), 0.12 + 0.12 * Math.floor(i / 3));
    ball(c, p, w * 0.8, BONE_FAINT);
  }
  for (let f = 0; f < 4; f++) {
    const knuckle = lerp(index, pinky, f / 3);
    const dir = sub(knuckle, wrist);
    longBone(c, add(wrist, dir, 0.25), knuckle, w * 1.4);
    let p = knuckle;
    for (const l of [0.5, 0.32, 0.24].map((x) => x * (f === 3 ? 0.8 : 1))) {
      const q = add(p, dir, l);
      longBone(c, p, q, w * 1.1);
      p = q;
    }
  }
  if (thumb) {
    const dir = sub(thumb, wrist);
    longBone(c, add(wrist, dir, 0.2), thumb, w * 1.4);
    const q = add(thumb, dir, 0.45);
    longBone(c, thumb, q, w * 1.2);
    longBone(c, q, add(q, dir, 0.3), w * 1.1);
  }
}

function foot(c, ankle, heel, toe, S) {
  ball(c, lerp(ankle, heel, 0.6), S * 0.06);
  const side = norm(perp(sub(toe, heel)));
  for (let i = -2; i <= 2; i++) {
    longBone(c, add(lerp(ankle, toe, 0.25), side, i * S * 0.02), add(toe, side, i * S * 0.03), S * 0.03);
  }
}

function skull(c, P, S, neck) {
  const ok = (...ids) => ids.every((i) => P[i].v > 0.5);
  const eyeL = P[2], eyeR = P[5], nose = P[0];
  const haveEyes = ok(2, 5);
  const earsMid = ok(7, 8) ? lerp(P[7], P[8], 0.5) : null;
  const eyeMid = haveEyes ? lerp(eyeL, eyeR, 0.5) : nose;
  const across = ok(7, 8) ? sub(P[8], P[7]) : haveEyes ? sub(eyeR, eyeL) : { x: S * 0.3, y: 0 };
  const angle = Math.atan2(across.y, across.x);
  // Bounded by body size, so bad head points (a hand over the face) can't balloon the skull.
  const headW = Math.min(S * 0.5, Math.max(ok(7, 8) ? dist(P[7], P[8]) * 1.15 : 0, haveEyes ? dist(eyeL, eyeR) * 2.5 : 0, S * 0.36));
  const up = norm(perp(across));
  // perp() points "down" in screen space when across points right; flip to point up the head.
  const upv = up.y > 0 ? { x: -up.x, y: -up.y } : up;
  let center = add(earsMid ? lerp(earsMid, eyeMid, 0.5) : eyeMid, upv, headW * 0.22);
  // And the head stays within reach of the neck.
  const reach = dist(center, neck);
  if (reach > S * 0.9) center = lerp(neck, center, (S * 0.9) / reach);

  c.save();
  // Cranium.
  c.beginPath();
  c.ellipse(center.x, center.y, headW * 0.5, headW * 0.6, angle, 0, Math.PI * 2);
  c.fillStyle = BONE_FILL;
  c.fill();
  c.lineWidth = Math.max(1.5, headW * 0.05);
  c.strokeStyle = BONE_EDGE;
  c.stroke();

  // Jaw: from below each ear down to the chin.
  // Mouth points only count if they are plausibly on this skull.
  const mouthOk = ok(9, 10) && dist(P[9], P[10]) < headW * 0.5 && dist(lerp(P[9], P[10], 0.5), center) < headW * 0.8;
  const mouth = mouthOk ? lerp(P[9], P[10], 0.5) : add(center, upv, -headW * 0.45);
  const chin = add(mouth, upv, -headW * 0.25);
  const ax = norm(across);
  const jawL = add(add(center, ax, -headW * 0.42), upv, -headW * 0.3);
  const jawR = add(add(center, ax, headW * 0.42), upv, -headW * 0.3);
  c.beginPath();
  c.moveTo(jawL.x, jawL.y);
  const cl = add(chin, ax, -headW * 0.3);
  const cr = add(chin, ax, headW * 0.3);
  c.quadraticCurveTo(cl.x, cl.y, chin.x, chin.y);
  c.quadraticCurveTo(cr.x, cr.y, jawR.x, jawR.y);
  c.fill();
  c.stroke();

  // Teeth along the mouth line.
  const mw = mouthOk ? dist(P[9], P[10]) * 1.1 : headW * 0.35;
  const toothW = mw / 8;
  for (const row of [0.4, -0.6]) {
    for (let i = 0; i < 8; i++) {
      const p = add(add(mouth, ax, (i - 3.5) * toothW), upv, row * toothW);
      c.save();
      c.translate(p.x, p.y);
      c.rotate(angle);
      c.fillStyle = BONE_EDGE;
      c.fillRect(-toothW * 0.4, -toothW * 0.55, toothW * 0.8, toothW * 1.1);
      c.restore();
    }
  }

  // Carve the eye sockets and nasal opening out of the bone layer.
  c.globalCompositeOperation = 'destination-out';
  c.fillStyle = 'rgba(0,0,0,0.85)';
  const eyeR0 = haveEyes ? dist(eyeL, eyeR) * 0.36 : headW * 0.12;
  const onSkull = (p) => dist(p, center) < headW * 0.6;
  for (const e of haveEyes ? [eyeL, eyeR].filter(onSkull) : []) {
    c.beginPath();
    c.ellipse(e.x, e.y, eyeR0, eyeR0 * 0.85, angle, 0, Math.PI * 2);
    c.fill();
  }
  if (!onSkull(nose)) { c.restore(); return; }
  const n1 = add(nose, upv, headW * 0.08);
  const n2 = add(add(nose, upv, -headW * 0.08), ax, -headW * 0.06);
  const n3 = add(add(nose, upv, -headW * 0.08), ax, headW * 0.06);
  c.beginPath();
  c.moveTo(n1.x, n1.y);
  c.lineTo(n2.x, n2.y);
  c.lineTo(n3.x, n3.y);
  c.closePath();
  c.fill();
  c.restore();
}
