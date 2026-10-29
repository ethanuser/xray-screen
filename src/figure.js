// A synthetic person in MediaPipe's landmark format, used by the test mode (?fake=1) and by the
// idle attract mode, where a skeleton beckons people closer.

// Normalised to a 1280x720 frame at real adult proportions; z is depth in metres (minus = toward camera).
// x here is as seen in a mirror; it is flipped below so landmark 11 (left) lands on the image right,
// as a real camera sees it.
const BASE = {
  0: [0.5, 0.165, -0.1], 2: [0.491, 0.15, -0.08], 5: [0.509, 0.15, -0.08], 7: [0.48, 0.16, 0], 8: [0.52, 0.16, 0],
  9: [0.493, 0.19, -0.08], 10: [0.507, 0.19, -0.08],
  11: [0.452, 0.25, 0], 12: [0.548, 0.25, 0], 13: [0.44, 0.4, 0.02], 14: [0.56, 0.4, 0.02], 15: [0.438, 0.53, -0.02], 16: [0.562, 0.53, -0.02],
  17: [0.433, 0.57, -0.03], 18: [0.567, 0.57, -0.03], 19: [0.437, 0.575, -0.05], 20: [0.563, 0.575, -0.05], 21: [0.442, 0.56, -0.06], 22: [0.558, 0.56, -0.06],
  23: [0.47, 0.51, 0], 24: [0.53, 0.51, 0], 25: [0.47, 0.71, -0.02], 26: [0.53, 0.71, -0.02], 27: [0.47, 0.89, 0.02], 28: [0.53, 0.89, 0.02],
  29: [0.468, 0.91, 0.06], 30: [0.532, 0.91, 0.06], 31: [0.462, 0.935, -0.12], 32: [0.538, 0.935, -0.12],
};
const MX = 3.9, MY = 2.2; // metres per normalised unit (x, y)
const ASPECT = 720 / 1280; // keeps limb lengths right when moving x and y together

// One frame of the figure. beckon: one arm raised, curling "come here". turn: body rotation (rad).
// arms: { armL: [upper, fore], armR: [upper, fore] } in degrees on the mirrored screen (the pose
// game's format; BASE x is already mirror-side, so screen-left is the body's left).
export function syntheticPose(now, { sway = 0, turn = 0, beckon = false, arms = null } = {}) {
  const pts = { ...BASE };
  if (arms) {
    const step = ([x, y], deg, len) => [x + Math.cos((deg * Math.PI) / 180) * len * ASPECT, y + Math.sin((deg * Math.PI) / 180) * len];
    for (const [side, sh, el, wr, pinky, index, thumb] of [['armL', 11, 13, 15, 17, 19, 21], ['armR', 12, 14, 16, 18, 20, 22]]) {
      const [up, fore] = arms[side];
      const elbow = step(BASE[sh], up, 0.15);
      const wrist = step(elbow, fore, 0.13);
      pts[el] = [...elbow, 0];
      pts[wr] = [...wrist, 0];
      pts[pinky] = [...step(wrist, fore + 12, 0.04), 0];
      pts[index] = [...step(wrist, fore - 8, 0.045), 0];
      pts[thumb] = [...step(wrist, fore - 30, 0.03), 0];
    }
  }
  if (beckon) {
    // Upper arm out to the side, forearm raised, hand curling toward the body and back.
    const [sx, sy] = BASE[12];
    const elbow = [sx + 0.1 * ASPECT * 1.6, sy + 0.08];
    const curl = 0.5 - 0.5 * Math.cos(now / 260);
    const angle = -0.15 - 1.0 * curl; // 0 = straight up; negative leans toward the head
    const fore = 0.15;
    const wrist = [elbow[0] + Math.sin(angle) * fore * ASPECT, elbow[1] - Math.cos(angle) * fore];
    const hand = (len, spread) => [wrist[0] + Math.sin(angle - 0.6 * curl + spread) * len * ASPECT, wrist[1] - Math.cos(angle - 0.6 * curl + spread) * len];
    pts[14] = [...elbow, -0.05];
    pts[16] = [...wrist, -0.1];
    pts[18] = [...hand(0.045, 0.25), -0.11];
    pts[20] = [...hand(0.05, -0.05), -0.12];
    pts[22] = [...hand(0.03, -0.5), -0.12];
  }
  const image = [], world = [];
  for (let i = 0; i < 33; i++) {
    const [x, y, z] = pts[i] || [0.5, 0.2, 0];
    const xs = 1 - x + sway * (1 - y);
    const wx = (xs - 0.5) * MX;
    image.push({ x: xs, y, visibility: 0.99 });
    world.push({ x: wx * Math.cos(turn) - z * Math.sin(turn), y: (y - 0.55) * MY, z: wx * Math.sin(turn) + z * Math.cos(turn) });
  }
  return { image, world };
}

// The same frame as a ready-to-draw tracked person (what the trackers would output).
export function syntheticPerson(now, opts) {
  const { image, world } = syntheticPose(now, opts);
  return {
    id: 'attract',
    alpha: opts?.alpha ?? 1,
    lm: image.map((p) => ({ x: p.x, y: p.y, v: p.visibility })),
    world,
  };
}
