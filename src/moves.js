// Movement challenges for the pose game. A pose is a shape; a move is a rhythm, so each move turns
// the body into one number per frame (relative hand height, wrist sway, hand distance...) in units
// of the player's shoulder width, and counts how many big-enough swings that number makes. The
// whip counts fast arm cracks instead. demo(t) animates the stick figure that shows the move,
// in the same arm-angle format as the poses (degrees on the mirrored screen, L = screen-left).

// Counts direction reversals of at least `amp` (a zigzag with hysteresis, so jitter can't count).
// The first movement only sets the direction; only reversals count.
export class Zigzag {
  constructor(amp) {
    this.amp = amp;
    this.count = 0;
    this.dir = 0;
    this.ext = null;
  }
  push(v) {
    if (this.ext === null) { this.ext = v; return; }
    if (this.dir === 0) {
      if (Math.abs(v - this.ext) >= this.amp) { this.dir = Math.sign(v - this.ext); this.ext = v; }
    } else if ((v - this.ext) * this.dir > 0) {
      this.ext = v; // still going the same way
    } else if ((this.ext - v) * this.dir >= this.amp) {
      this.dir = -this.dir;
      this.ext = v;
      this.count++;
    }
  }
}

// The body in mirrored display pixels: shoulder, elbow and wrist per screen side, shoulder width,
// torso centre and time.
export function bodyFrame(person, toScreen, t) {
  const P = (i) => toScreen(person.lm[i]);
  const leftOnLeft = P(11).x < P(12).x;
  const side = (sh, el, wr) => ({ sh: P(sh), el: P(el), wr: P(wr) });
  const odd = side(11, 13, 15), even = side(12, 14, 16);
  const [L, R] = leftOnLeft ? [odd, even] : [even, odd];
  const sw = Math.max(1, Math.hypot(L.sh.x - R.sh.x, L.sh.y - R.sh.y));
  return { L, R, sw, cx: (L.sh.x + R.sh.x) / 2, t };
}

// A zigzag that only counts while `gate` holds; if the gate breaks for over `graceMs` the streak
// starts again. That stops one move (jumping jacks) passing through another's zone (raise the roof)
// from counting.
function gated(amp, graceMs = 300) {
  let z = new Zigzag(amp), off = null;
  return (b, ok, v) => {
    if (ok) { off = null; z.push(v); } else if (off === null) off = b.t; else if (b.t - off > graceMs) z = new Zigzag(amp);
    return z.count;
  };
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const below = (s) => s.wr.y > s.sh.y;
const above = (s, sw, by = 0) => s.wr.y < s.sh.y - by * sw;

export const MOVES = [
  {
    name: '6-7',
    tip: 'Bounce your hands up and down, one then the other',
    required: 6,
    // Both hands must each bounce, and out of step with each other.
    make: () => {
      const diff = gated(0.35), l = gated(0.15), r = gated(0.15);
      return (b) => {
        const ok = below(b.L) && below(b.R);
        return Math.min(diff(b, ok, (b.R.wr.y - b.L.wr.y) / b.sw), l(b, ok, b.L.wr.y / b.sw), r(b, ok, b.R.wr.y / b.sw));
      };
    },
    demo: (t) => { const p = Math.sin(t * 9); return { armL: [100, 180 + 30 * p], armR: [80, 30 * p] }; },
  },
  {
    name: 'Whip it',
    tip: 'Crack an arm like a whip',
    required: 3,
    make: () => {
      let prev = null, last = -1e9, n = 0;
      return (b) => {
        if (prev && b.t > prev.t) {
          const dt = (b.t - prev.t) / 1000;
          // One arm cracks fast while the other stays still (floss and jumping jacks move both).
          const vl = dist(b.L.wr, prev.L.wr) / b.sw / dt, vr = dist(b.R.wr, prev.R.wr) / b.sw / dt;
          if (Math.max(vl, vr) > 6 && Math.min(vl, vr) < 2 && b.t - last > 350) { n++; last = b.t; }
        }
        prev = b;
        return n;
      };
    },
    // A slow wind-up, then a fast crack down and out.
    demo: (t) => {
      const ph = (t * 1.4) % 1;
      const w = ph < 0.75 ? (ph / 0.75) * 0.2 : 0.2 + ((ph - 0.75) / 0.25) * 0.8;
      return { armL: [95, 92], armR: [-70 + 130 * w, -80 + 170 * w] };
    },
  },
  {
    name: 'Wave hello',
    tip: 'Raise a hand and wave',
    required: 4,
    // One hand up with the forearm raised and the elbow fairly still; the other hand down.
    make: () => {
      // A wave never leaves its zone, so even a short break restarts the streak.
      const l = gated(0.4, 100), r = gated(0.4, 100);
      // The elbow is anchored where the wave started; swinging the whole arm breaks the streak.
      const anchor = { L: null, R: null };
      const waving = (key, s, other, sw) => {
        const ok = above(s, sw) && s.wr.y < s.el.y && s.el.y < s.sh.y + 0.6 * sw && below(other);
        if (!ok) { anchor[key] = null; return false; }
        anchor[key] ??= { ...s.el };
        if (dist(s.el, anchor[key]) > 0.5 * sw) { anchor[key] = { ...s.el }; return false; }
        return true;
      };
      return (b) => Math.max(
        l(b, waving('L', b.L, b.R, b.sw), (b.L.wr.x - b.L.el.x) / b.sw),
        r(b, waving('R', b.R, b.L, b.sw), (b.R.wr.x - b.R.el.x) / b.sw),
      );
    },
    demo: (t) => ({ armL: [95, 92], armR: [-20, -90 + 35 * Math.sin(t * 8)] }),
  },
  {
    name: 'Raise the roof',
    tip: 'Both hands over your head, push up',
    required: 4,
    make: () => {
      const z = gated(0.3);
      return (b) => z(b, above(b.L, b.sw, 0.4) && above(b.R, b.sw, 0.4), (b.L.wr.y + b.R.wr.y) / 2 / b.sw);
    },
    demo: (t) => { const p = 20 * Math.sin(t * 7); return { armL: [-150 + p, -100 + p], armR: [-30 - p, -80 - p] }; },
  },
  {
    name: 'Floss',
    tip: 'Swing both arms side to side',
    required: 4,
    make: () => {
      const z = gated(0.6);
      return (b) => z(b, below(b.L) && below(b.R), ((b.L.wr.x + b.R.wr.x) / 2 - b.cx) / b.sw);
    },
    demo: (t) => { const s = Math.sin(t * 6); return { armL: [90 + 40 * s, 90 + 50 * s], armR: [90 + 40 * s, 90 + 50 * s] }; },
  },
  {
    name: 'Chicken dance',
    tip: 'Hands in your armpits, flap!',
    required: 6,
    make: () => {
      const z = gated(0.3);
      return (b) => z(b, dist(b.L.wr, b.L.sh) < 0.9 * b.sw && dist(b.R.wr, b.R.sh) < 0.9 * b.sw, (b.L.el.y + b.R.el.y - b.L.sh.y - b.R.sh.y) / 2 / b.sw);
    },
    demo: (t) => { const s = 25 * Math.sin(t * 9); return { armL: [150 - s, -20], armR: [30 + s, 200] }; },
  },
  {
    name: 'Jumping jacks',
    tip: 'Arms up over your head and back down',
    required: 4,
    // Both arms each swing all the way up and down.
    make: () => {
      const l = new Zigzag(1.4), r = new Zigzag(1.4);
      return (b) => { l.push((b.L.wr.y - b.L.sh.y) / b.sw); r.push((b.R.wr.y - b.R.sh.y) / b.sw); return Math.min(l.count, r.count); };
    },
    demo: (t) => { const k = 0.5 - 0.5 * Math.cos(t * 5); return { armL: [90 + 180 * k, 90 + 180 * k], armR: [90 - 180 * k, 90 - 180 * k] }; },
  },
  {
    name: 'Slow clap',
    tip: 'Clap your hands',
    required: 4,
    // A clap is the hands coming within about half a shoulder-width after being well apart.
    make: () => {
      let open = false, n = 0;
      return (b) => {
        const d = dist(b.L.wr, b.R.wr) / b.sw;
        if (d > 1.0) open = true;
        else if (d < 0.55 && open) { open = false; n++; }
        return n;
      };
    },
    demo: (t) => { const c = 0.5 + 0.5 * Math.sin(t * 6); return { armL: [120, 10 + 90 * c], armR: [60, 170 - 90 * c] }; },
  },
];
