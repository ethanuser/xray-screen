// Pose matching game: five rounds of random poses. Each round shows a target stick figure and
// announces it; players copy it like a mirror. Matching is by limb direction on screen (so it works
// at any distance or size), scored against whoever in view matches best. Hold a match for half a
// second to score; faster earns a bonus.

// Limb directions in degrees on screen, as the player sees the mirrored display:
// 0 = pointing right, 90 = down, -90 = up, 180 = left. "L" is the arm/leg on screen-left.
// Legs (legL/legR, same format) are only scored when visible; none of these poses use them,
// because legs are usually out of frame up close.
export const POSES = [
  { name: 'Touchdown', armL: [-90, -90], armR: [-90, -90] },
  { name: 'Y for YMCA', armL: [-125, -125], armR: [-55, -55] },
  { name: 'Scarecrow', armL: [180, 180], armR: [0, 0] },
  { name: 'Muscles', armL: [180, -90], armR: [0, -90] },
  { name: 'Walk like an Egyptian', armL: [180, -90], armR: [0, 90] },
  { name: "I'm a little teapot", armL: [135, 45], armR: [-25, -45] },
  { name: 'Dab', armL: [-35, 170], armR: [-35, -35] },
  { name: 'Hands on head', armL: [-150, -30], armR: [-30, -150] },
  { name: 'Superhero', armL: [135, 45], armR: [45, 135] },
  { name: 'Point at the sky', armL: [90, 90], armR: [-60, -60] },
  { name: 'Robot', armL: [90, 0], armR: [90, 180] },
];
// Landmark pairs per limb segment for the body's own left (odd) and right (even) side. Which of
// them is on screen-left is decided per frame from where the shoulders appear.
const LEFT = { arm: [[11, 13], [13, 15]], leg: [[23, 25], [25, 27]] };
const RIGHT = { arm: [[12, 14], [14, 16]], leg: [[24, 26], [26, 28]] };
const ROUNDS = 5;
const ROUND_MS = 7000;
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
  constructor({ audio, sounds }) {
    this.audio = audio;
    this.sounds = sounds;
    this.el = document.getElementById('game');
    this.fig = document.getElementById('gameFigure');
    this.state = null;
  }

  get active() { return this.state !== null; }

  start(now) {
    const order = [...POSES].sort(() => Math.random() - 0.5).slice(0, ROUNDS);
    this.state = { order, round: -1, score: 0, phase: 'intro', phaseStart: now, match: 0, heldSince: null };
    document.body.classList.add('gaming');
    this.el.hidden = false;
    this.show({ title: 'Pose game', sub: 'Copy the skeleton. Hold it to score.', figure: null, meter: null, timer: null });
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
    else if (s.phase === 'pose') {
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
    } else if (s.phase === 'end' && t > 5000) this.stop();
  }

  nextRound(now) {
    const s = this.state;
    s.round++;
    s.phase = 'pose';
    s.phaseStart = now;
    s.match = 0;
    s.heldSince = null;
    s.lastTick = null;
    this.say(s.order[s.round].name);
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

// The target as a glowing stick figure.
function drawFigure(canvas, pose) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W, H);
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
}
