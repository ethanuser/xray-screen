// Pose matching game: five rounds, three poses and two moves (see moves.js). Each round shows a target stick figure and
// announces it; players copy it like a mirror. Matching is by limb direction on screen (so it works
// at any distance or size), scored against whoever in view matches best. Hold a match for half a
// second to score; faster earns a bonus. Every match is photographed (photo, X-ray and the target
// pose side by side), and at the end a gallery lets players keep or discard each one.

// Limb directions in degrees on screen, as the player sees the mirrored display:
// 0 = pointing right, 90 = down, -90 = up, 180 = left. "L" is the arm/leg on screen-left.
// Legs (legL/legR, same format) are only scored when visible; none of these poses use them,
// because legs are usually out of frame up close.
import { MOVES, bodyFrame } from './moves.js';

export const POSES = [
  { name: 'Touchdown', armL: [-90, -90], armR: [-90, -90] },
  { name: 'Y for YMCA', armL: [-125, -125], armR: [-55, -55] },
  { name: 'T-pose to assert dominance', armL: [180, 180], armR: [0, 0] },
  { name: 'Muscles', armL: [180, -90], armR: [0, -90] },
  { name: 'Walk like an Egyptian', armL: [180, -90], armR: [0, 90] },
  { name: "I'm a little teapot", armL: [135, 45], armR: [-25, -45] },
  // Face tucked into the bent arm: that hand or elbow right at the face, above the shoulders.
  { name: 'Dab', armL: [-60, -15], armR: [-35, -35],
    score: (b) => straightPlus(b, -35, (bent) => (Math.min(bent.wr.y, bent.el.y) < bent.sh.y ? near(Math.min(dist(bent.wr, b.head), dist(bent.el, b.head)), 0.6, 1.1, b.sw) : 0)) },
  { name: 'Hands on head', armL: [-150, -30], armR: [-30, -150] },
  { name: 'Superhero', armL: [135, 45], armR: [45, 135] },
  { name: 'Point at the sky', armL: [90, 90], armR: [-60, -60] },
  { name: 'Robot', armL: [90, 0], armR: [90, 180] },
  { name: 'Shrug', armL: [120, 180], armR: [60, 0] },
  { name: 'The thinker', armL: [80, 20], armR: [105, -115] },
  // Fist pulled back to the chest (not down at the hip, which would be the teapot), elbow out.
  { name: 'Lightning Bolt', armL: [165, -10], armR: [-40, -40],
    score: (b) => straightPlus(b, -40, (bent) => (bent.wr.y < bent.sh.y + 0.7 * b.sw ? near(dist(bent.wr, { x: b.cx, y: (b.L.sh.y + b.R.sh.y) / 2 + 0.25 * b.sw }), 0.8, 1.3, b.sw) : 0) * (Math.abs(bent.el.x - b.cx) > 0.9 * b.sw ? 1 : 0.75)) },
];
// Poses with a bent arm across the face or chest (Dab, Lightning Bolt) can't be scored by angles:
// that arm points at the camera, so its 2D angles are unreliable and differ from person to person.
// They are scored by what defines them instead: one straight arm pointing up diagonally (to either
// side) plus where the other hand is. `deg` is the straight arm's angle when it is on screen-right.
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const angleOf = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
const aligned = (rad1, deg) => Math.max(0, Math.min(1, (Math.cos(rad1 - rad(deg)) - Math.cos(rad(55))) / (1 - Math.cos(rad(55)))));
// 1 when d is within `full` shoulder-widths, falling to 0 at `zero`.
const near = (d, full, zero, sw) => Math.max(0, Math.min(1, (zero - d / sw) / (zero - full)));
function straightPlus(b, deg, other) {
  let best = 0;
  for (const [straight, bent, target] of [[b.R, b.L, deg], [b.L, b.R, 180 - deg]]) {
    const arm = (aligned(angleOf(straight.sh, straight.el), target) + aligned(angleOf(straight.el, straight.wr), target)) / 2;
    best = Math.max(best, arm * (0.4 + 0.6 * other(bent)));
  }
  return best;
}

// Landmark pairs per limb segment for the body's own left (odd) and right (even) side. Which of
// them is on screen-left is decided per frame from where the shoulders appear.
const LEFT = { arm: [[11, 13], [13, 15]], leg: [[23, 25], [25, 27]] };
const RIGHT = { arm: [[12, 14], [14, 16]], leg: [[24, 26], [26, 28]] };
const ROUNDS = 5;
const ROUND_MS = 7000;
const MOVE_ROUND_MS = 12000;
const POSE_ROUNDS = 3; // the other rounds are moves
const HOLD_MS = 500;
const MATCH_AT = 0.8;
const RANKS = [
  [900, 'Bone-afide legend'],
  [650, 'Skele-ton of talent'],
  [400, 'Humerus attempt'],
  [150, 'A little rattled'],
  [0, 'Needs more calcium'],
];

const rad = (d) => (d * Math.PI) / 180;

export class PoseGame {
  // capture() returns { plain, xray } canvases of the current instant (see capturePhotos in main).
  constructor({ audio, sounds, capture }) {
    this.audio = audio;
    this.sounds = sounds;
    this.capture = capture;
    this.gallery = new Gallery();
    this.el = document.getElementById('game');
    this.fig = document.getElementById('gameFigure');
    this.state = null;
  }

  get active() { return this.state !== null; }

  start(now) {
    const shuffle = (a) => [...a].sort(() => Math.random() - 0.5);
    const order = shuffle([
      ...shuffle(POSES).slice(0, POSE_ROUNDS).map((p) => ({ ...p, kind: 'pose' })),
      ...shuffle(MOVES).slice(0, ROUNDS - POSE_ROUNDS).map((m) => ({ ...m, kind: 'move' })),
    ]);
    this.state = { order, round: -1, score: 0, phase: 'intro', phaseStart: now, match: 0, heldSince: null, shots: [] };
    document.body.classList.add('gaming');
    this.el.hidden = false;
    this.show({ title: 'Pose game', sub: 'Copy the skeleton. Hold the poses, do the moves.', figure: null, meter: null, timer: null });
    this.sounds?.play('gamestart') || this.tones([523, 659, 784], 0.12);
    this.say('Pose game! Copy the skeleton.');
  }

  stop() {
    this.state = null;
    this.el.hidden = true;
    document.body.classList.remove('gaming');
  }

  // people: tracked bodies; toScreen maps a normalised landmark to mirrored display pixels.
  update(people, now, toScreen) {
    const s = this.state;
    if (!s) return;
    const t = now - s.phaseStart;

    if (s.phase === 'intro' && t > 2200) this.nextRound(now);
    else if (s.phase === 'pose' && s.order[s.round].kind === 'move') {
      const move = s.order[s.round];
      // Moves follow whoever is closest (widest shoulders).
      const frames = people.filter((p) => p.alpha > 0.5).map((p) => bodyFrame(p, toScreen, now));
      const b = frames.sort((x, y) => y.sw - x.sw)[0];
      if (b) s.count = Math.max(s.count, s.detector(b));
      const left = Math.max(0, MOVE_ROUND_MS - t);
      const figure = move.demo(t / 1000);
      const sec = Math.ceil(left / 1000);
      if (sec <= 3 && sec !== s.lastTick && sec > 0) { s.lastTick = sec; this.tones([1200], 0.04, 0.05); }
      if (s.count !== s.lastCount) { s.lastCount = s.count; if (s.count > 0 && s.count < move.required) this.tones([660 + s.count * 60], 0.05); }
      if (s.count >= move.required) {
        const points = 100 + Math.round((left / MOVE_ROUND_MS) * 100);
        s.score += points;
        s.phase = 'result';
        s.phaseStart = now;
        this.show({ title: 'Nailed it!', sub: `+${points}`, figure, meter: 1, timer: null, good: true });
        this.sounds?.play('match') || this.tones([784, 1047], 0.12);
        this.snap({ name: move.name, ...move.demo(0.3) }, points, s.round);
      } else if (left === 0) {
        s.phase = 'result';
        s.phaseStart = now;
        this.show({ title: 'Too slow!', sub: `${s.count} of ${move.required}`, figure, meter: s.count / move.required, timer: null });
        this.sounds?.play('fail') || this.tones([220, 165], 0.18, 0.12, 'sawtooth');
      } else {
        this.show({ title: move.name, sub: `${s.count} / ${move.required} · Round ${s.round + 1} of ${ROUNDS} · ${s.score} pts`, figure, meter: s.count / move.required, timer: left / MOVE_ROUND_MS });
      }
    } else if (s.phase === 'pose') {
      const pose = s.order[s.round];
      const best = Math.max(0, ...people.filter((p) => p.alpha > 0.5).map((p) => match(pose, p.lm, toScreen)));
      s.match += (best - s.match) * 0.3;
      const left = Math.max(0, ROUND_MS - t);
      if (s.match >= MATCH_AT) s.heldSince ??= now;
      else s.heldSince = null;
      // Last three seconds tick.
      const sec = Math.ceil(left / 1000);
      if (sec <= 3 && sec !== s.lastTick && sec > 0) { s.lastTick = sec; this.tones([1200], 0.04, 0.05); }
      if (s.heldSince !== null && now - s.heldSince >= HOLD_MS) {
        const points = 100 + Math.round((left / ROUND_MS) * 100);
        s.score += points;
        s.phase = 'result';
        s.phaseStart = now;
        this.show({ title: 'Match!', sub: `+${points}`, figure: pose, meter: 1, timer: null, good: true });
        this.sounds?.play('match') || this.tones([784, 1047], 0.12);
        this.snap(pose, points, s.round);
      } else if (left === 0) {
        s.phase = 'result';
        s.phaseStart = now;
        this.show({ title: 'Too slow!', sub: `${Math.round(s.match * 100)}% match`, figure: pose, meter: s.match, timer: null });
        this.sounds?.play('fail') || this.tones([220, 165], 0.18, 0.12, 'sawtooth');
      } else {
        this.show({ title: pose.name, sub: `Round ${s.round + 1} of ${ROUNDS} · ${s.score} pts`, figure: pose, meter: s.match, timer: left / ROUND_MS });
      }
    } else if (s.phase === 'result' && t > 1400) {
      if (s.round + 1 < ROUNDS) this.nextRound(now);
      else {
        s.phase = 'end';
        s.phaseStart = now;
        const rank = RANKS.find(([min]) => s.score >= min)[1];
        this.show({ title: `${s.score} points`, sub: rank, figure: null, meter: null, timer: null, good: true });
        this.say(`${s.score} points. ${rank}!`);
        this.tones([523, 659, 784, 1047], 0.15);
      }
    } else if (s.phase === 'end' && t > 3500) {
      const shots = s.shots;
      this.stop();
      Promise.all(shots).then((items) => this.gallery.open(items));
    }
  }

  // Photograph the match: the camera shot, the X-ray and the pose they were copying, in one image.
  snap(pose, points, round) {
    if (!this.capture) return;
    const shot = this.capture();
    const flash = document.getElementById('flash');
    flash.classList.add('on');
    requestAnimationFrame(() => requestAnimationFrame(() => flash.classList.remove('on')));
    this.state.shots.push(compose(shot, pose, points).then((blob) => ({ blob, url: URL.createObjectURL(blob), pose: pose.name, round, kept: true })));
  }

  nextRound(now) {
    const s = this.state;
    s.round++;
    s.phase = 'pose';
    s.phaseStart = now;
    s.match = 0;
    s.heldSince = null;
    s.lastTick = null;
    const c = s.order[s.round];
    if (c.kind === 'move') {
      s.detector = c.make();
      s.count = 0;
      s.lastCount = 0;
      this.say(`${c.name}! ${c.tip}`);
    } else this.say(c.name);
  }

  // Arm angles the target figure is showing right now (the test figure copies them).
  demoArms(now) {
    const s = this.state;
    if (s?.phase !== 'pose') return null;
    const c = s.order[s.round];
    return c.kind === 'move' ? c.demo((now - s.phaseStart) / 1000) : c;
  }

  show({ title, sub, figure, meter, timer, good = false }) {
    this.el.querySelector('.title').textContent = title;
    this.el.querySelector('.sub').textContent = sub;
    this.el.classList.toggle('good', good);
    const m = this.el.querySelector('.meter');
    m.hidden = meter === null;
    if (meter !== null) m.firstElementChild.style.transform = `scaleX(${Math.max(0, Math.min(1, meter))})`;
    const tm = this.el.querySelector('.timer');
    tm.hidden = timer === null;
    if (timer !== null) tm.firstElementChild.style.transform = `scaleX(${timer})`;
    this.fig.hidden = !figure;
    if (figure) drawFigure(this.fig, figure);
  }

  say(text) {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    speechSynthesis.speak(Object.assign(new SpeechSynthesisUtterance(text), { rate: 1.05, pitch: 0.8 }));
  }

  tones(freqs, len, gap = 0.02, type = 'triangle') {
    const ctx = this.audio;
    if (!ctx) return;
    freqs.forEach((f, i) => {
      const t0 = ctx.currentTime + i * (len + gap);
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
      o.connect(g).connect(ctx.destination);
      o.start(t0);
      o.stop(t0 + len + 0.02);
    });
  }
}

// 0..1: how closely a body's limbs point the way the pose's do. Each segment scores 1 when aligned,
// falling to 0 at 55 degrees off. Legs count only if visible; arms always count.
export function match(pose, lm, toScreen) {
  if (pose.score) return pose.score(bodyFrame({ lm }, toScreen, 0));
  const leftOnLeft = toScreen(lm[11]).x < toScreen(lm[12]).x;
  const [onL, onR] = leftOnLeft ? [LEFT, RIGHT] : [RIGHT, LEFT];
  const segments = { armL: onL.arm, armR: onR.arm, legL: onL.leg, legR: onR.leg };
  let sum = 0, n = 0;
  for (const [limb, segs] of Object.entries(segments)) {
    const target = pose[limb];
    if (!target) continue;
    const isLeg = limb.startsWith('leg');
    segs.forEach(([a, b], i) => {
      const visible = lm[a].v > 0.5 && lm[b].v > 0.5;
      if (isLeg && !visible) return;
      n++;
      if (!visible) return;
      const A = toScreen(lm[a]), B = toScreen(lm[b]);
      const ang = Math.atan2(B.y - A.y, B.x - A.x);
      const cos = Math.cos(ang - rad(target[i]));
      sum += Math.max(0, Math.min(1, (cos - Math.cos(rad(55))) / (1 - Math.cos(rad(55)))));
    });
  }
  return n ? sum / n : 0;
}

// The target as a glowing stick figure on the game panel.
function drawFigure(canvas, pose) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W, H);
  paintFigure(c, pose, 0, 0, W, H);
}

// Stick figure for a pose, fitted into the box (x, y, W, H).
function paintFigure(c, pose, x, y, W, H) {
  c.save();
  c.translate(x, y);
  c.strokeStyle = '#fff';
  c.fillStyle = '#fff';
  c.lineCap = 'round';
  c.lineWidth = Math.max(3, H * 0.035);
  c.shadowColor = 'rgba(255,255,255,0.7)';
  c.shadowBlur = 10;
  const u = H / 10;
  const cx = W / 2, neck = { x: cx, y: u * 3 }, hip = { x: cx, y: u * 6 };
  const sh = { L: { x: cx - u * 0.9, y: u * 3.2 }, R: { x: cx + u * 0.9, y: u * 3.2 } };
  const hp = { L: { x: cx - u * 0.5, y: u * 6 }, R: { x: cx + u * 0.5, y: u * 6 } };
  const line = (a, b) => { c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke(); };
  const step = (p, deg, len) => ({ x: p.x + Math.cos(rad(deg)) * len, y: p.y + Math.sin(rad(deg)) * len });
  c.beginPath();
  c.arc(cx, u * 2.1, u * 0.75, 0, Math.PI * 2);
  c.stroke();
  line(neck, hip);
  line(sh.L, sh.R);
  line(hp.L, hp.R);
  for (const side of ['L', 'R']) {
    const [up, fore] = pose[`arm${side}`];
    const elbow = step(sh[side], up, u * 1.5);
    line(sh[side], elbow);
    line(elbow, step(elbow, fore, u * 1.4));
    const [thigh, shin] = pose[`leg${side}`] || [90, 90];
    const knee = step(hp[side], thigh, u * 1.9);
    line(hp[side], knee);
    line(knee, step(knee, shin, u * 1.8));
  }
  c.restore();
}

// One shareable image per match: [target pose | photo | X-ray], with captions.
function compose({ plain, xray }, pose, points) {
  const H = 900, pad = 28, strip = 340, foot = 64;
  const w = Math.round((plain.width / plain.height) * H);
  const canvas = Object.assign(document.createElement('canvas'), { width: strip + 2 * w + pad * 4, height: H + pad * 2 + foot });
  const c = canvas.getContext('2d');
  c.fillStyle = '#000';
  c.fillRect(0, 0, canvas.width, canvas.height);
  c.strokeStyle = 'rgba(255,255,255,0.45)';
  c.lineWidth = 2;
  // Target pose.
  c.strokeRect(pad, pad, strip, H);
  paintFigure(c, pose, pad + strip * 0.15, pad + 60, strip * 0.7, H * 0.55);
  c.fillStyle = '#fff';
  c.textAlign = 'center';
  c.font = '600 22px ui-monospace, Menlo, monospace';
  c.fillText('THE POSE', pad + strip / 2, pad + 44);
  c.font = '700 34px ui-monospace, Menlo, monospace';
  wrap(c, pose.name.toUpperCase(), pad + strip / 2, pad + H * 0.72, strip - 40, 42);
  c.font = '600 30px ui-monospace, Menlo, monospace';
  c.fillText(`+${points} PTS`, pad + strip / 2, pad + H - 50);
  // Photo and X-ray.
  const x1 = pad * 2 + strip, x2 = x1 + w + pad;
  c.drawImage(plain, x1, pad, w, H);
  c.drawImage(xray, x2, pad, w, H);
  c.strokeRect(x1, pad, w, H);
  c.strokeRect(x2, pad, w, H);
  c.textAlign = 'left';
  c.font = '500 20px ui-monospace, Menlo, monospace';
  c.fillStyle = 'rgba(255,255,255,0.7)';
  c.fillText(`X-RAY SCANNER · POSE GAME · ${new Date().toLocaleString()}`, pad, canvas.height - foot / 2 + 6);
  return new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
}

function wrap(c, text, x, y, maxW, lineH) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (c.measureText(test).width > maxW && line) { lines.push(line); line = word; } else line = test;
  }
  lines.push(line);
  lines.forEach((l, i) => c.fillText(l, x, y + i * lineH));
}

// End-of-game gallery: every matched pose, tap to discard/keep, then save the kept ones.
class Gallery {
  constructor() {
    this.el = document.getElementById('gallery');
    this.list = this.el.querySelector('.shots');
    this.items = [];
    document.getElementById('saveKept').addEventListener('click', () => this.save());
    document.getElementById('doneGallery').addEventListener('click', () => this.close());
  }

  open(items) {
    if (!items.length) return;
    this.items = items;
    this.list.replaceChildren(...items.map((item) => {
      const fig = document.createElement('figure');
      const img = Object.assign(document.createElement('img'), { src: item.url, alt: `Pose game photo: ${item.pose}` });
      const btn = Object.assign(document.createElement('button'), { type: 'button', className: 'tool' });
      const cap = document.createElement('figcaption');
      const render = () => {
        fig.classList.toggle('discarded', !item.kept);
        btn.textContent = item.kept ? 'Discard' : 'Keep';
        cap.textContent = item.kept ? item.pose : `${item.pose} · discarded`;
      };
      btn.addEventListener('click', () => { item.kept = !item.kept; render(); this.updateSave(); });
      img.addEventListener('click', () => btn.click());
      render();
      fig.append(img, cap, btn);
      return fig;
    }));
    this.updateSave();
    this.el.hidden = false;
    // Closes by itself after 90 s so the costume never gets stuck here.
    this.timer = setTimeout(() => this.close(), 90000);
  }

  updateSave() {
    const n = this.items.filter((i) => i.kept).length;
    const btn = document.getElementById('saveKept');
    btn.textContent = n ? `Save ${n} photo${n > 1 ? 's' : ''}` : 'Nothing to save';
    btn.disabled = n === 0;
  }

  // iPad: the share sheet (Save Images puts them in Photos). Mac: downloads.
  async save() {
    const kept = this.items.filter((i) => i.kept);
    if (!kept.length) return;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const files = kept.map((i, n) => new File([i.blob], `xray-pose-${stamp}-${n + 1}.jpg`, { type: 'image/jpeg' }));
    if (navigator.canShare?.({ files })) {
      try { await navigator.share({ files }); return; } catch (err) { if (err.name === 'AbortError') return; }
    }
    kept.forEach((item, n) => {
      const a = document.createElement('a');
      a.href = item.url;
      a.download = files[n].name;
      a.click();
    });
  }

  close() {
    clearTimeout(this.timer);
    this.el.hidden = true;
    for (const i of this.items) URL.revokeObjectURL(i.url);
    this.items = [];
    this.list.replaceChildren();
  }
}
