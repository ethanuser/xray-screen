// Mode 1: X-ray the people in front of the screen with a real anatomical skeleton.
//
// Each bone group from BodyParts3D is rigid, so it is rigged by attaching it to tracked joints:
//   - frames (torso, pelvis, head, hands, feet) take a full rotation from three landmarks;
//   - long bones and finger bones swing from their parent's rotation to point at the next joint,
//     and stretch slightly along their length so each one ends exactly where the next begins.
// Rotations come from MediaPipe's 3D world landmarks (metres), so bones foreshorten correctly when
// limbs point toward the camera. A weak-perspective fit of world x/y onto the 2D landmarks then
// lays each person over where they actually are in the frame. Hands that belong to a tracked body
// are posed inside that body's frame, anchored at its wrist, so they never come loose from the arm.
import * as THREE from 'three';
import { xrayMaterial } from './xraymat.js';

const VIS = 0.4;
// How long a tracked hand's finger pose is remembered (relative to the forearm) after the hand
// tracker loses it, before falling back to a rigid hand.
const HAND_MEMORY_MS = 1500;
const P = { nose: 0, earL: 7, earR: 8, shL: 11, shR: 12, elL: 13, elR: 14, wrL: 15, wrR: 16, pinkyL: 17, pinkyR: 18,
  indexL: 19, indexR: 20, hipL: 23, hipR: 24, knL: 25, knR: 26, anL: 27, anR: 28, heelL: 29, heelR: 30, toeL: 31, toeR: 32 };
// Landmarks used to fit each person onto the image.
const FIT = [0, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
// Finger chains as [bone, from landmark, to landmark] in MediaPipe's 21-point hand order.
// 'hand' means the bone starts where the rigid hand frame puts it (the metacarpal bases).
const FINGERS = [
  [['meta1', 1, 2], ['thumb_proximal', 2, 3], ['thumb_distal', 3, 4]],
  [['meta2', 'hand', 5], ['index_proximal', 5, 6], ['index_middle', 6, 7], ['index_distal', 7, 8]],
  [['meta3', 'hand', 9], ['middle_proximal', 9, 10], ['middle_middle', 10, 11], ['middle_distal', 11, 12]],
  [['meta4', 'hand', 13], ['ring_proximal', 13, 14], ['ring_middle', 14, 15], ['ring_distal', 15, 16]],
  [['meta5', 'hand', 17], ['little_proximal', 17, 18], ['little_middle', 18, 19], ['little_distal', 19, 20]],
];
const HAND_BONES = FINGERS.flat().map(([name]) => name);

const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const toV = (p) => new THREE.Vector3(p.x, p.y, p.z);
const mid = (a, b) => a.clone().add(b).multiplyScalar(0.5);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// Orthonormal frame: x toward pX, y toward pY (orthogonalised), z = x × y.
function frame(p0, pX, pY) {
  const x = pX.clone().sub(p0).normalize();
  const y = pY.clone().sub(p0);
  y.sub(x.clone().multiplyScalar(y.dot(x))).normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}
// Rotation taking a rest frame onto a live frame.
const frameRot = (rest, live) => live.clone().multiply(rest.clone().invert());

// Rigid transform: rest point `restAt` lands on live point `liveAt`, rotated by q, scaled by k.
function rigid(liveAt, q, k, restAt) {
  const m = new THREE.Matrix4().compose(liveAt, q, new THREE.Vector3(k, k, k));
  return m.multiply(new THREE.Matrix4().makeTranslation(-restAt.x, -restAt.y, -restAt.z));
}
const apply = (m, p) => p.clone().applyMatrix4(m);

// Swing a bone from its parent's rotation so it points from liveFrom to liveTo.
function swing(seg, parentQ, liveFrom, liveTo) {
  const restDir = seg.to.clone().sub(seg.from).normalize().applyQuaternion(parentQ);
  const liveDir = liveTo.clone().sub(liveFrom).normalize();
  return new THREE.Quaternion().setFromUnitVectors(restDir, liveDir).multiply(parentQ);
}

// Like rigid(), but also stretches the bone along its own axis (within limits) so its far end
// lands on liveTo. Without this, small length mismatches show up as gaps at every joint.
function bone(seg, q, k, liveFrom, liveTo, lo = 0.75, hi = 1.35) {
  const d = seg.to.clone().sub(seg.from);
  const restLen = d.length();
  d.normalize();
  const a = clamp(liveFrom.distanceTo(liveTo) / (k * restLen), lo, hi) - 1;
  // I + a·d·dᵀ: scale by (1 + a) along d only.
  const s = new THREE.Matrix4().set(
    1 + a * d.x * d.x, a * d.x * d.y, a * d.x * d.z, 0,
    a * d.y * d.x, 1 + a * d.y * d.y, a * d.y * d.z, 0,
    a * d.z * d.x, a * d.z * d.y, 1 + a * d.z * d.z, 0,
    0, 0, 0, 1,
  );
  const m = new THREE.Matrix4().compose(liveFrom, q, new THREE.Vector3(k, k, k));
  return m.multiply(s).multiply(new THREE.Matrix4().makeTranslation(-seg.from.x, -seg.from.y, -seg.from.z));
}

// Least-squares scale + offset mapping world x/y (metres) onto screen pixels.
function fitWeakPerspective(world, screen, ids) {
  let n = 0, wx = 0, wy = 0, sx = 0, sy = 0;
  for (const i of ids) { n++; wx += world[i].x; wy += world[i].y; sx += screen[i].x; sy += screen[i].y; }
  if (n < 3) return null;
  wx /= n; wy /= n; sx /= n; sy /= n;
  let num = 0, den = 0;
  for (const i of ids) {
    const ax = world[i].x - wx, ay = world[i].y - wy;
    num += ax * (screen[i].x - sx) + ay * (screen[i].y - sy);
    den += ax * ax + ay * ay;
  }
  if (den < 1e-8) return null;
  const s = num / den;
  return { s, tx: sx - s * wx, ty: sy - s * wy };
}

export class SkeletonXRay {
  constructor(canvas, anatomy) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setClearColor(0x000000, 1);
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(0, 1, 0, 1, -1e5, 1e5);
    this.parts = anatomy.parts;
    this.vw = 1280;
    this.vh = 720;
    this.mirror = true;
    this.bodies = new Map();
    this.hands = new Map();

    const r = anatomy.rig;
    this.rest = { seg: {}, pt: {} };
    for (const [k, s] of Object.entries(r.segments)) this.rest.seg[k] = { from: v3(s.from), to: v3(s.to) };
    for (const [k, p] of Object.entries(r.points)) this.rest.pt[k] = Array.isArray(p[0]) ? p.map(v3) : v3(p);
    const R = this.rest.pt;
    // Bridges between frames: top and bottom centres of the neck and lumbar spine.
    for (const name of ['neck', 'lumbar']) {
      const g = this.parts[name];
      g.computeBoundingBox();
      const b = g.boundingBox;
      const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
      this.rest.seg[name] = { from: new THREE.Vector3(cx, b.min.y, cz), to: new THREE.Vector3(cx, b.max.y, cz) };
    }
    R.midSh = mid(R.shoulderL, R.shoulderR);
    R.midHip = mid(R.hipL, R.hipR);
    R.midEar = mid(R.earL, R.earR);
    this.restFrames = {
      torso: frame(R.midSh, R.shoulderL, R.midHip),
      pelvis: frame(R.midHip, R.hipL, R.midSh),
      head: frame(R.midEar, R.earL, R.nose),
      footL: frame(R.ankleL, R.toeL, R.heelL),
      footR: frame(R.ankleR, R.toeR, R.heelR),
      handL: frame(R.handL[0], R.handL[5], R.handL[17]),
      handR: frame(R.handR[0], R.handR[5], R.handR[17]),
    };
    this.restTorsoLen = R.midSh.distanceTo(R.midHip);
    this.restShoulderW = R.shoulderL.distanceTo(R.shoulderR);
    this.restHandLen = R.handR[0].distanceTo(R.handR[9]);
    this.resize();
  }

  resize() {
    this.W = window.innerWidth;
    this.H = window.innerHeight;
    // Many overlapping additive layers are fill-rate heavy; 1.5x is sharp enough on Retina.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setSize(this.W, this.H, false);
    Object.assign(this.camera, { left: 0, right: this.W, top: 0, bottom: this.H });
    this.camera.updateProjectionMatrix();
  }

  setVideoSize(vw, vh) { this.vw = vw; this.vh = vh; }

  // Normalised image point -> screen pixels (cover fit, unmirrored; the group transform mirrors).
  toScreen(p) {
    const s = Math.max(this.W / this.vw, this.H / this.vh);
    return { x: (this.W - this.vw * s) / 2 + p.x * this.vw * s, y: (this.H - this.vh * s) / 2 + p.y * this.vh * s };
  }

  // Each rig gets its own material so it can fade in and out independently.
  makeRig(names) {
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    const mat = xrayMaterial({ base: 0.04, rim: 0.85, power: 2.0, ortho: true });
    const rig = { group, meshes: {}, mat, alpha: 0, fit: null, k: null, qHead: null, handMem: {} };
    for (const n of names) {
      const m = new THREE.Mesh(this.parts[n], mat);
      m.matrixAutoUpdate = false;
      m.frustumCulled = false;
      m.userData.fade = 0;
      // Per-bone fade on a shared material: set the uniform just before each bone draws.
      m.onBeforeRender = () => {
        mat.uniforms.gain.value = rig.alpha * m.userData.fade;
        mat.uniformsNeedUpdate = true;
      };
      group.add(m);
      rig.meshes[n] = m;
    }
    this.scene.add(group);
    return rig;
  }

  dropRig(map, key) {
    const rig = map.get(key);
    this.scene.remove(rig.group);
    rig.mat.dispose();
    map.delete(key);
  }

  // Bones fade in and out instead of blinking.
  fade(mesh, on) {
    const f = mesh.userData;
    f.fade += ((on ? 1 : 0) - f.fade) * (on ? 0.25 : 0.1);
    mesh.visible = f.fade > 0.01;
  }

  // Smooths the fit so the skeleton doesn't shimmer when landmarks drop in and out. A sudden big
  // change in scale is usually a bad frame, so it is followed only very slowly.
  placeGroup(rig, fit, alpha) {
    if (fit) {
      if (!rig.fit) rig.fit = { ...fit };
      else {
        const rate = Math.abs(fit.s / rig.fit.s - 1) > 0.25 ? 0.05 : 0.35;
        for (const key of ['s', 'tx', 'ty']) rig.fit[key] += (fit[key] - rig.fit[key]) * rate;
      }
    }
    if (!rig.fit) return false;
    const { s, tx, ty } = rig.fit;
    const sx = this.mirror ? -s : s;
    const ox = this.mirror ? this.W - tx : tx;
    rig.group.matrix.set(sx, 0, 0, ox, 0, s, 0, ty, 0, 0, s, 0, 0, 0, 0, 1);
    rig.alpha = alpha;
    rig.group.visible = alpha > 0.02;
    return true;
  }

  // heads: [{ nose, q }] head rotations from the face tracker, matched to bodies by nose position.
  update(people, hands, heads = []) {
    const seen = new Set();
    for (const person of people) {
      seen.add(person.id);
      let rig = this.bodies.get(person.id);
      if (!rig) {
        const names = ['skull', 'neck', 'torso', 'lumbar', 'pelvis'];
        for (const S of ['L', 'R']) {
          names.push(`humerus${S}`, `forearm${S}`, `femur${S}`, `shin${S}`, `foot${S}`, `carpals${S}`);
          names.push(...HAND_BONES.map((n) => n + S));
        }
        rig = this.makeRig(names);
        this.bodies.set(person.id, rig);
      }
      this.poseBody(rig, person, hands, heads);
    }
    for (const id of [...this.bodies.keys()]) if (!seen.has(id)) this.dropRig(this.bodies, id);

    // Hands with no body in view get their own fit onto the image.
    const seenH = new Set();
    for (const hand of hands) {
      if (hand.bodyId !== null && this.bodies.has(hand.bodyId)) continue;
      const S = hand.side;
      const key = `${hand.id}${S}`;
      seenH.add(key);
      let rig = this.hands.get(key);
      if (!rig) {
        rig = this.makeRig([`carpals${S}`, ...HAND_BONES.map((n) => n + S)]);
        this.hands.set(key, rig);
      }
      const w = hand.world.map(toV);
      const k = this.smoothK(rig, w[0].distanceTo(w[9]) / this.restHandLen);
      this.poseHand(rig, S, w, k);
      const screen = hand.lm.map((p) => this.toScreen(p));
      this.placeGroup(rig, fitWeakPerspective(hand.world, screen, [...Array(21).keys()]), hand.alpha);
    }
    for (const key of [...this.hands.keys()]) if (!seenH.has(key)) this.dropRig(this.hands, key);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  smoothK(rig, k) {
    rig.k = rig.k === null ? k : rig.k + (k - rig.k) * 0.15;
    return rig.k;
  }

  poseBody(rig, person, hands, heads) {
    const { seg, pt } = this.rest;
    const lm = person.lm;
    const w = person.world.map(toV);
    const ok = (...ids) => ids.every((i) => lm[i].v > VIS);
    const show = (name, on) => this.fade(rig.meshes[name], on);
    const set = (name, m) => rig.meshes[name].matrix.copy(m);

    const screen = lm.map((p) => this.toScreen(p));
    const fitIds = FIT.filter((i) => lm[i].v > 0.6);
    if (!this.placeGroup(rig, fitWeakPerspective(person.world, screen, fitIds), person.alpha)) return;
    if (!ok(P.shL, P.shR)) { rig.alpha *= 0.9; return; }

    const midSh = mid(w[P.shL], w[P.shR]);
    const midHip = mid(w[P.hipL], w[P.hipR]);
    const k = this.smoothK(rig, 0.5 * (midSh.distanceTo(midHip) / this.restTorsoLen + w[P.shL].distanceTo(w[P.shR]) / this.restShoulderW));

    // Torso and pelvis.
    const qTorso = frameRot(this.restFrames.torso, frame(midSh, w[P.shL], midHip));
    const mTorso = rigid(midSh, qTorso, k, pt.midSh);
    set('torso', mTorso);
    show('torso', true);
    const hipsOk = ok(P.hipL, P.hipR);
    const qPelvis = hipsOk ? frameRot(this.restFrames.pelvis, frame(midHip, w[P.hipL], midSh)) : qTorso;
    const mPelvis = rigid(midHip, qPelvis, k, pt.midHip);
    set('pelvis', mPelvis);
    show('pelvis', hipsOk);
    const lumFrom = apply(mTorso, seg.lumbar.from), lumTo = apply(mPelvis, seg.lumbar.to);
    set('lumbar', bone(seg.lumbar, swing(seg.lumbar, qTorso, lumFrom, lumTo), k, lumFrom, lumTo));
    show('lumbar', hipsOk);

    // Head rotation, best source first: the face tracker (full pitch, yaw and roll), then the ears
    // and nose from the body, then the torso. Smoothed either way.
    const head = heads.find((h) => h.q && Math.hypot(h.nose.x - lm[P.nose].x, h.nose.y - lm[P.nose].y) < 0.08);
    const headOk = ok(P.nose, P.earL, P.earR);
    let qHeadNow, headAt;
    if (head) {
      qHeadNow = head.q.clone();
      headAt = w[P.nose].clone().add(pt.midEar.clone().sub(pt.nose).multiplyScalar(k).applyQuaternion(qHeadNow));
    } else if (headOk) {
      qHeadNow = frameRot(this.restFrames.head, frame(mid(w[P.earL], w[P.earR]), w[P.earL], w[P.nose]));
      headAt = mid(w[P.earL], w[P.earR]);
    } else {
      qHeadNow = qTorso.clone();
      headAt = w[P.nose].clone().add(pt.midEar.clone().sub(pt.nose).multiplyScalar(k).applyQuaternion(qTorso));
    }
    rig.qHead = rig.qHead ? rig.qHead.slerp(qHeadNow, 0.4) : qHeadNow;
    const mHead = rigid(headAt, rig.qHead, k, pt.midEar);
    set('skull', mHead);
    show('skull', ok(P.nose));
    const neckFrom = apply(mHead, seg.neck.from), neckTo = apply(mTorso, seg.neck.to);
    set('neck', bone(seg.neck, swing(seg.neck, rig.qHead, neckFrom, neckTo), k, neckFrom, neckTo, 0.6, 1.6));
    show('neck', ok(P.nose));

    for (const S of ['L', 'R']) {
      const id = (n) => P[n + S];
      // Arm.
      const qHum = swing(seg[`humerus${S}`], qTorso, w[id('sh')], w[id('el')]);
      set(`humerus${S}`, bone(seg[`humerus${S}`], qHum, k, w[id('sh')], w[id('el')]));
      show(`humerus${S}`, ok(id('sh'), id('el')));
      const qFore = swing(seg[`forearm${S}`], qHum, w[id('el')], w[id('wr')]);
      set(`forearm${S}`, bone(seg[`forearm${S}`], qFore, k, w[id('el')], w[id('wr')]));
      show(`forearm${S}`, ok(id('el'), id('wr')));

      // Hand: the hand tracker's fingers when it has this hand, re-anchored at this wrist;
      // otherwise a rigid hand from the body's wrist, index and pinky points.
      // A hand the tracker just lost keeps its last finger pose, carried by the forearm.
      const now = performance.now();
      const tracked = hands.find((h) => h.side === S && h.bodyId === person.id && h.alpha > 0.5);
      const wrist = w[id('wr')];
      if (tracked) {
        const hw = tracked.world.map(toV);
        const shift = wrist.clone().sub(hw[0]);
        const inv = qFore.clone().invert();
        rig.handMem[S] = {
          t: now,
          k: clamp(hw[0].distanceTo(hw[9]) / this.restHandLen, 0.8 * k, 1.25 * k),
          rel: hw.map((p) => p.add(shift).sub(wrist).applyQuaternion(inv)),
        };
      }
      const mem = rig.handMem[S];
      if (mem && now - mem.t < HAND_MEMORY_MS) {
        const hw = mem.rel.map((p) => p.clone().applyQuaternion(qFore).add(wrist));
        this.poseHand(rig, S, hw, mem.k, ok(id('wr')));
      } else {
        const qHand = frameRot(this.restFrames[`hand${S}`], frame(wrist, w[id('index')], w[id('pinky')]));
        this.poseRigidHand(rig, S, rigid(wrist, qHand, k, pt[`hand${S}`][0]), ok(id('wr'), id('index'), id('pinky')));
      }

      // Leg.
      const qFem = swing(seg[`femur${S}`], qPelvis, w[id('hip')], w[id('kn')]);
      set(`femur${S}`, bone(seg[`femur${S}`], qFem, k, w[id('hip')], w[id('kn')]));
      show(`femur${S}`, hipsOk && ok(id('kn')));
      const qShin = swing(seg[`shin${S}`], qFem, w[id('kn')], w[id('an')]);
      set(`shin${S}`, bone(seg[`shin${S}`], qShin, k, w[id('kn')], w[id('an')]));
      show(`shin${S}`, ok(id('kn'), id('an')));
      const qFoot = frameRot(this.restFrames[`foot${S}`], frame(w[id('an')], w[id('toe')], w[id('heel')]));
      set(`foot${S}`, rigid(w[id('an')], qFoot, k, pt[`ankle${S}`]));
      show(`foot${S}`, ok(id('an'), id('toe'), id('heel')));
    }
  }

  // Whole hand in its rest pose, carried by one rigid transform (body landmarks only).
  poseRigidHand(rig, S, mHand, visible) {
    for (const name of [`carpals${S}`, ...HAND_BONES.map((n) => n + S)]) {
      rig.meshes[name].matrix.copy(mHand);
      this.fade(rig.meshes[name], visible);
    }
  }

  // Fully articulated hand from 21 world landmarks: carpals ride the hand frame, and each finger
  // bone swings down its chain and stretches to reach the next landmark.
  poseHand(rig, S, w, k, visible = true) {
    const { seg, pt } = this.rest;
    const qHand = frameRot(this.restFrames[`hand${S}`], frame(w[0], w[5], w[17]));
    const mHand = rigid(w[0], qHand, k, pt[`hand${S}`][0]);
    rig.meshes[`carpals${S}`].matrix.copy(mHand);
    this.fade(rig.meshes[`carpals${S}`], visible);
    for (const chain of FINGERS) {
      let parentQ = qHand;
      for (const [name, a, b] of chain) {
        const s = seg[name + S];
        const from = a === 'hand' ? apply(mHand, s.from) : w[a];
        const q = swing(s, parentQ, from, w[b]);
        const mesh = rig.meshes[name + S];
        mesh.matrix.copy(bone(s, q, k, from, w[b], 0.7, 1.4));
        this.fade(mesh, visible);
        parentQ = q;
      }
    }
  }
}
