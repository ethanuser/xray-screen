// Builds models/anatomy.glb and models/rig.json from BodyParts3D OBJ parts.
//
//   node scripts/build-anatomy.mjs <bp3d dir>
//
// <bp3d dir> holds partof_element_parts.txt and the unzipped OBJ files (partof_BP3D_4.0_obj_99.zip).
// Source: BodyParts3D, © The Database Center for Life Science. The current README licenses it under CC BY 4.0
// (the OBJ headers say CC BY-SA 2.1 Japan); credit it either way.
//
// Every group becomes one mesh node in a shared "rest" frame, in metres:
//   x = subject's left, y = down, z = toward the subject's back.
// That matches MediaPipe world landmarks for a person facing an unmirrored camera, so the runtime can
// rotate each rigid bone group from rest straight onto tracked joints.
import fs from 'node:fs';
import path from 'node:path';
import { MeshoptSimplifier } from 'meshoptimizer';

const src = process.argv[2];
if (!src) throw new Error('usage: node scripts/build-anatomy.mjs <bp3d dir>');
const outDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'models');

// ---------- part lists ----------
const elements = new Map(); // concept name -> Set of element file ids
const conceptsOf = new Map(); // element file id -> concept names it belongs to
for (const line of fs.readFileSync(path.join(src, 'partof_element_parts.txt'), 'utf8').split('\n').slice(1)) {
  const [, name, file] = line.trim().split('\t');
  if (!name || !file) continue;
  if (!elements.has(name)) elements.set(name, new Set());
  elements.get(name).add(file);
  if (!conceptsOf.has(file)) conceptsOf.set(file, []);
  conceptsOf.get(file).push(name);
}
// Bone groups keep bone only. "skull", for example, includes both eyeballs and the tear glands, and the
// spine includes the discs; none of that shows on an X-ray. The ethmoid is a thin honeycomb that turns
// into noise once simplified.
const ORGANS = new Set(['heart', 'lungL', 'lungR', 'liver', 'stomach']);
const SOFT = /eyeball|lacrimal|ligament|gland|artery|vein|muscle|nerve|intervertebral|tendon|ethmoid|cartilage of|disk/;
const isSoft = (file) => (conceptsOf.get(file) || []).some((c) => SOFT.test(c));
const objFiles = new Map();
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.obj')) objFiles.set(path.basename(e.name, '.obj'), p);
  }
})(src);

const sides = { L: 'left', R: 'right' };
const fingers = { thumb: 'thumb', index: 'index finger', middle: 'middle finger', ring: 'ring finger', little: 'little finger' };
const ordinals = ['first', 'second', 'third', 'fourth', 'fifth'];

const groups = {
  skull: ['skull', 'mandible'],
  // The jumpscare skull opens its jaw, so it needs the cranium and mandible apart.
  cranium: ['skull'],
  jaw: ['mandible'],
  neck: ['set of cervical vertebrae'],
  torso: ['rib cage', 'sternum', 'left clavicle', 'right clavicle', 'left scapula', 'right scapula'],
  lumbar: ['lumbar vertebral column'],
  pelvis: ['left hip bone', 'right hip bone', 'sacrum'],
  heart: ['heart'],
  lungL: ['left lung'],
  lungR: ['right lung'],
  liver: ['liver'],
  stomach: ['stomach'],
};
for (const [S, side] of Object.entries(sides)) {
  groups[`humerus${S}`] = [`${side} humerus`];
  groups[`forearm${S}`] = [`${side} radius`, `${side} ulna`];
  groups[`femur${S}`] = [`${side} femur`, `${side} patella`];
  groups[`shin${S}`] = [`${side} tibia`, `${side} fibula`];
  groups[`foot${S}`] = [...elements.keys()].filter((n) =>
    new RegExp(`^(${side} (calcaneus|talus|cuboid bone|(medial|intermediate|lateral) cuneiform bone|\\w+ metatarsal bone)|navicular bone of ${side} foot|(proximal|middle|distal) phalanx of ${side} (big|second|third|fourth|little) toe)$`).test(n));
  groups[`carpals${S}`] = ['scaphoid', 'lunate', 'triquetral', 'pisiform', 'trapezium', 'trapezoid', 'capitate', 'hamate'].map((b) => `${side} ${b}`);
  ordinals.forEach((o, i) => { groups[`meta${i + 1}${S}`] = [`${side} ${o} metacarpal bone`]; });
  for (const [f, fname] of Object.entries(fingers)) {
    for (const seg of f === 'thumb' ? ['proximal', 'distal'] : ['proximal', 'middle', 'distal']) {
      groups[`${f}_${seg}${S}`] = [`${seg} phalanx of ${side} ${fname}`];
    }
  }
}

// ---------- load ----------
function loadObj(file) {
  const v = [];
  const f = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.startsWith('v ')) {
      const [, x, y, z] = line.trim().split(/\s+/);
      v.push(+x, +y, +z);
    } else if (line.startsWith('f ')) {
      const idx = line.trim().split(/\s+/).slice(1).map((t) => parseInt(t, 10) - 1);
      for (let i = 1; i + 1 < idx.length; i++) f.push(idx[0], idx[i], idx[i + 1]);
    }
  }
  return { v, f };
}

const raw = {};
for (const [name, concepts] of Object.entries(groups)) {
  const files = new Set();
  for (const c of concepts) {
    const set = elements.get(c);
    if (!set) console.warn(`  missing concept "${c}" for ${name}`);
    else set.forEach((x) => files.add(x));
  }
  if (name === 'cranium') elements.get('mandible').forEach((x) => files.delete(x));
  const pos = [];
  const idx = [];
  let found = 0;
  for (const id of files) {
    if (!ORGANS.has(name) && isSoft(id)) continue;
    const file = objFiles.get(id);
    if (!file) continue;
    found++;
    const { v, f } = loadObj(file);
    const base = pos.length / 3;
    pos.push(...v);
    for (const i of f) idx.push(base + i);
  }
  if (!found) throw new Error(`no mesh files for group ${name}`);
  raw[name] = { pos, idx };
}

// ---------- axes ----------
const centroid = (p) => {
  const c = [0, 0, 0];
  for (let i = 0; i < p.length; i += 3) { c[0] += p[i]; c[1] += p[i + 1]; c[2] += p[i + 2]; }
  return c.map((x) => x / (p.length / 3));
};
const C = Object.fromEntries(Object.entries(raw).map(([k, g]) => [k, centroid(g.pos)]));
const sub = (a, b) => a.map((x, i) => x - b[i]);
const axisOf = (d) => { const a = d.map(Math.abs); const i = a.indexOf(Math.max(...a)); return [i, Math.sign(d[i])]; };
const [upAxis, upSign] = axisOf(sub(C.skull, C.femurL));
const [leftAxis, leftSign] = axisOf(sub(C.femurL, C.femurR));
const [antAxis, antSign] = axisOf(sub(C.torso, C.neck).map((x, i) => (i === upAxis || i === leftAxis ? 0 : x)));
// Units: an adult is ~1.7 m tall; the source is in millimetres if the extent is in the thousands.
const allY = [];
for (const g of Object.values(raw)) for (let i = upAxis; i < g.pos.length; i += 300) allY.push(g.pos[i]);
const height = allY.reduce((m, x) => Math.max(m, x), -Infinity) - allY.reduce((m, x) => Math.min(m, x), Infinity);
const unit = height > 100 ? 0.001 : 1;
console.log(`axes: up=${'xyz'[upAxis]}${upSign > 0 ? '+' : '-'} left=${'xyz'[leftAxis]}${leftSign > 0 ? '+' : '-'} anterior=${'xyz'[antAxis]}${antSign > 0 ? '+' : '-'} height=${(height * unit).toFixed(2)}m`);

// Rest frame origin: midpoint between the femoral heads (approx. the pelvis centroid, lowered later).
const toRest = (p) => [p[leftAxis] * leftSign * unit, -p[upAxis] * upSign * unit, -p[antAxis] * antSign * unit];
const meshes = {};
for (const [name, g] of Object.entries(raw)) {
  const pos = new Float32Array(g.pos.length);
  for (let i = 0; i < g.pos.length; i += 3) pos.set(toRest([g.pos[i], g.pos[i + 1], g.pos[i + 2]]), i);
  meshes[name] = { pos, idx: Uint32Array.from(g.idx) };
}
// Flipping one axis (or three) mirrors the mesh; restore outward-facing winding if so.
const R = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
R[0][leftAxis] = leftSign; R[1][upAxis] = -upSign; R[2][antAxis] = -antSign;
const det = R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) - R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0]) + R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0]);
if (det < 0) {
  for (const m of Object.values(meshes)) for (let i = 0; i < m.idx.length; i += 3) [m.idx[i + 1], m.idx[i + 2]] = [m.idx[i + 2], m.idx[i + 1]];
}

// ---------- rig points ----------
const lo = (a) => a.reduce((m, x) => (x < m ? x : m), Infinity);
const hi = (a) => a.reduce((m, x) => (x > m ? x : m), -Infinity);
const pts = (m) => { const out = []; for (let i = 0; i < m.pos.length; i += 3) out.push([m.pos[i], m.pos[i + 1], m.pos[i + 2]]); return out; };
const mean = (P) => P.reduce((a, p) => a.map((x, i) => x + p[i]), [0, 0, 0]).map((x) => x / P.length);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist = (a, b) => Math.hypot(...sub(a, b));
// Principal axis by power iteration on the covariance.
function principal(P) {
  const c = mean(P);
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of P) { const d = sub(p, c); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i][j] += d[i] * d[j]; }
  let v = [0.3, 0.9, 0.2];
  for (let k = 0; k < 50; k++) {
    const w = M.map((row) => dot(row, v));
    const l = Math.hypot(...w);
    v = w.map((x) => x / l);
  }
  return { c, v };
}
// Ends of a long bone: centroids of the vertices in the outer 6% along its principal axis.
// `near` decides which end is the proximal one ("from").
function ends(name, near) {
  const P = pts(meshes[name]);
  const { c, v } = principal(P);
  const t = P.map((p) => dot(sub(p, c), v));
  const t0 = lo(t), t1 = hi(t), band = (t1 - t0) * 0.06;
  const a = mean(P.filter((_, i) => t[i] < t0 + band));
  const b = mean(P.filter((_, i) => t[i] > t1 - band));
  return dist(a, near) < dist(b, near) ? { from: a, to: b } : { from: b, to: a };
}
const round = (p) => p.map((x) => +x.toFixed(4));

const rig = { segments: {}, points: {} };
const top = [0, -10, 0];
for (const S of ['L', 'R']) {
  const hum = ends(`humerus${S}`, top);
  const fore = ends(`forearm${S}`, hum.to);
  const fem = ends(`femur${S}`, top);
  const shin = ends(`shin${S}`, fem.to);
  Object.assign(rig.segments, { [`humerus${S}`]: hum, [`forearm${S}`]: fore, [`femur${S}`]: fem, [`shin${S}`]: shin });
  const carp = mean(pts(meshes[`carpals${S}`]));
  // Hand landmarks in MediaPipe's 21-point order.
  const meta = [1, 2, 3, 4, 5].map((i) => ends(`meta${i}${S}`, carp));
  ordinals.forEach((_, i) => { rig.segments[`meta${i + 1}${S}`] = meta[i]; });
  const hand = [fore.to];
  for (const [f, i] of [['thumb', 0], ['index', 1], ['middle', 2], ['ring', 3], ['little', 4]]) {
    const segs = f === 'thumb' ? ['proximal', 'distal'] : ['proximal', 'middle', 'distal'];
    let prev = meta[i].to;
    const chain = [f === 'thumb' ? meta[0].from : meta[i].to];
    if (f === 'thumb') chain.push(meta[0].to);
    for (const s of segs) {
      const e = ends(`${f}_${s}${S}`, prev);
      rig.segments[`${f}_${s}${S}`] = e;
      chain.push(e.to);
      prev = e.to;
    }
    hand.push(...chain);
  }
  rig.points[`hand${S}`] = hand.map(round);
  // Foot: heel = rearmost calcaneus point, toe = frontmost point of the foot.
  const foot = pts(meshes[`foot${S}`]);
  const heel = foot.reduce((a, p) => (p[2] > a[2] ? p : a));
  const toe = foot.reduce((a, p) => (p[2] < a[2] ? p : a));
  Object.assign(rig.points, {
    [`shoulder${S}`]: round(hum.from), [`elbow${S}`]: round(hum.to), [`wrist${S}`]: round(fore.to),
    [`hip${S}`]: round(fem.from), [`knee${S}`]: round(fem.to), [`ankle${S}`]: round(shin.to),
    [`heel${S}`]: round(heel), [`toe${S}`]: round(toe),
  });
}
// Head: ear canals sit roughly halfway up the skull, a little behind its middle; nose at the front.
{
  const P = pts(meshes.skull);
  const ys = P.map((p) => p[1]), zs = P.map((p) => p[2]), xs = P.map((p) => p[0]);
  const [y0, y1] = [lo(ys), hi(ys)];
  const [z0, z1] = [lo(zs), hi(zs)];
  const [x0, x1] = [lo(xs), hi(xs)];
  const earY = y0 + (y1 - y0) * 0.5, earZ = z0 + (z1 - z0) * 0.58;
  rig.points.earL = round([x1 * 0.92 + x0 * 0.08, earY, earZ]);
  rig.points.earR = round([x0 * 0.92 + x1 * 0.08, earY, earZ]);
  rig.points.nose = round([(x0 + x1) / 2, y0 + (y1 - y0) * 0.52, z0]);
}
for (const s of Object.values(rig.segments)) { s.from = round(s.from); s.to = round(s.to); }

// ---------- simplify ----------
// The source meshes are dense (1M+ triangles); an iPad drawing several skeletons needs far fewer.
await MeshoptSimplifier.ready;
const budget = { skull: 24000, cranium: 22000, torso: 22000, lungL: 4000, lungR: 4000, lumbar: 6000, neck: 4000, footL: 4000, footR: 4000, pelvis: 6000 };
for (const [name, target] of Object.entries(budget)) {
  const m = meshes[name];
  if (m.idx.length / 3 <= target) continue;
  // Weld duplicate vertices (to 0.1 mm) first; unwelded seams stop the simplifier early.
  const key = new Map();
  const weld = new Uint32Array(m.pos.length / 3);
  for (let i = 0; i < weld.length; i++) {
    const k = `${Math.round(m.pos[i * 3] * 1e4)},${Math.round(m.pos[i * 3 + 1] * 1e4)},${Math.round(m.pos[i * 3 + 2] * 1e4)}`;
    if (!key.has(k)) key.set(k, i);
    weld[i] = key.get(k);
  }
  const welded = Uint32Array.from(m.idx, (i) => weld[i]);
  const [idx] = MeshoptSimplifier.simplify(welded, m.pos, 3, target * 3, 0.06);
  // Drop vertices no triangle uses any more.
  const remap = new Int32Array(m.pos.length / 3).fill(-1);
  const pos = [];
  for (const i of idx) if (remap[i] < 0) { remap[i] = pos.length / 3; pos.push(m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2]); }
  meshes[name] = { pos: Float32Array.from(pos), idx: Uint32Array.from(idx, (i) => remap[i]) };
}

// ---------- normals + GLB ----------
function normals(m) {
  const n = new Float32Array(m.pos.length);
  const p = m.pos;
  for (let i = 0; i < m.idx.length; i += 3) {
    const [a, b, c] = [m.idx[i] * 3, m.idx[i + 1] * 3, m.idx[i + 2] * 3];
    const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
    const e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    const fn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    for (const v of [a, b, c]) { n[v] += fn[0]; n[v + 1] += fn[1]; n[v + 2] += fn[2]; }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
  return n;
}

const chunks = [];
let offset = 0;
const bufferViews = [], accessors = [], gltfMeshes = [], nodes = [];
function addView(arr, target) {
  const bytes = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
  const pad = (4 - (bytes.length % 4)) % 4;
  chunks.push(bytes, Buffer.alloc(pad));
  bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
  offset += bytes.length + pad;
  return bufferViews.length - 1;
}
let tris = 0;
for (const [name, m] of Object.entries(meshes)) {
  const n = normals(m);
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.pos.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], m.pos[i + k]); max[k] = Math.max(max[k], m.pos[i + k]); }
  const pv = addView(m.pos, 34962), nv = addView(n, 34962), iv = addView(m.idx, 34963);
  accessors.push({ bufferView: pv, componentType: 5126, count: m.pos.length / 3, type: 'VEC3', min, max });
  accessors.push({ bufferView: nv, componentType: 5126, count: n.length / 3, type: 'VEC3' });
  accessors.push({ bufferView: iv, componentType: 5125, count: m.idx.length, type: 'SCALAR' });
  const a = accessors.length;
  gltfMeshes.push({ name, primitives: [{ attributes: { POSITION: a - 3, NORMAL: a - 2 }, indices: a - 1 }] });
  nodes.push({ name, mesh: gltfMeshes.length - 1 });
  tris += m.idx.length / 3;
}
const bin = Buffer.concat(chunks);
const json = {
  asset: { version: '2.0', generator: 'xray-screen build-anatomy', copyright: 'BodyParts3D, © The Database Center for Life Science, CC BY 4.0' },
  scene: 0,
  scenes: [{ nodes: nodes.map((_, i) => i) }],
  nodes, meshes: gltfMeshes, accessors, bufferViews,
  buffers: [{ byteLength: bin.length }],
};
let jsonBuf = Buffer.from(JSON.stringify(json));
jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
fs.writeFileSync(path.join(outDir, 'anatomy.glb'), Buffer.concat([header, jh, jsonBuf, bh, bin]));
fs.writeFileSync(path.join(outDir, 'rig.json'), JSON.stringify(rig, null, 1));
console.log(`wrote anatomy.glb: ${Object.keys(meshes).length} parts, ${tris} triangles, ${(bin.length / 1e6).toFixed(1)} MB`);
