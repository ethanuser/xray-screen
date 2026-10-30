// X-ray scanner costume: camera, vision models, mode switching, and the render loop.
//
// URL options (all optional):
//   ?mode=me          start in Self-diagnostic (hold the screen 1 s to switch)
//   ?pose=lite        use the faster, less stable pose model
//   ?mirror=0         don't mirror the camera view in Mode 1
//   ?hfov=70          front camera horizontal field of view, degrees (for parallax distance)
//   ?ppi=132          CSS pixels per inch of the screen (iPad is 132)
//   ?chest=0          body height (m) the screen centre sits at, relative to the bottom of the sternum
//   ?scale=1          anatomy size multiplier (Mode 2)
//   ?skeleton=2d      Subject scan with the simple drawn skeleton instead of the 3D anatomy
//   ?scare=0          turn off the jumpscare
//   ?scareAt=0.32     face width (fraction of the frame) that triggers the jumpscare
//   ?fps=30           drawing frame-rate cap (battery)
//   ?vision=15        tracking rate cap (battery)
//   ?debug=1          show the debug readout (or press d)
//   ?diag=1           diagnostic view: camera image, raw (red) vs tracked (white) points, stability numbers
//   ?record=20        record 20 s of tracking data after Start and download it (or press r to start/stop)
//   ?replay=file.json replay a recording through the full pipeline instead of using the camera
//   ?nocam=1          preview Mode 2 without a camera
//   ?fake=1           drive Mode 1 with a synthetic person and hand (no camera)
import { FilesetResolver, PoseLandmarker, HandLandmarker, FaceDetector, FaceLandmarker } from '@mediapipe/tasks-vision';
import { Tracker } from './tracking.js';
import { loadAnatomy } from './xraymat.js';
import { SkeletonXRay } from './skeleton3d.js';
import { XRay2D } from './xray2d.js';
import { Inside3D } from './inside3d.js';
import { Jumpscare } from './jumpscare.js';
import { Diagnostics } from './diag.js';
import { PhotoBooth } from './photo.js';
import { syntheticPose, syntheticPerson } from './figure.js';
import { SoundBank } from './sounds.js';
import { PoseGame } from './game.js';
import { setupSoundPanel } from './soundpanel.js';
import * as THREE from 'three';

const q = new URLSearchParams(location.search);
const num = (k, d) => (q.has(k) ? parseFloat(q.get(k)) : d);
const isIPad = /iPad/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const cfg = {
  mirror: q.get('mirror') !== '0',
  hfov: num('hfov', 70),
  ppi: num('ppi', isIPad ? 132 : 113),
  // Defaults framed for an iPad hung at chest height in a box: anatomy a bit larger than life
  // (the box holds the screen off the body) and the view shifted down toward the upper abdomen.
  chestY: num('chest', -0.04),
  scale: num('scale', 1.2),
  poseModel: q.get('pose') === 'lite' ? 'lite' : 'full',
  skeleton3d: q.get('skeleton') !== '2d',
  scare: q.get('scare') !== '0',
  scareAt: num('scareAt', 0.32),
  diag: q.get('diag') === '1',
  // Battery: the screen refreshes at up to 120 Hz on iPad Pro and the camera at 30 Hz, but neither
  // drawing nor tracking needs that; motion easing fills the gaps.
  fps: num('fps', 30),
  visionFps: num('vision', 15),
  record: num('record', 0),
  replay: q.get('replay'),
};
const LABELS = { them: 'Subject scan', me: 'Self-diagnostic' };

const $ = (id) => document.getElementById(id);
const video = $('video');
let xray, inside, scare, rig;
// A body freezes (rather than jumping) on frames where its shoulders are lost or its proportions
// suddenly change, which is what happens when hands cover the face or the camera.
const shoulderWidth = (world) => Math.hypot(world[11].x - world[12].x, world[11].y - world[12].y, world[11].z - world[12].z);
// New bodies must persist for 6 frames and can't overlap an existing one, which filters out the
// phantom extra bodies the pose model sometimes reports during occlusion.
const bodyTracker = new Tracker({
  count: 33,
  centerIds: [11, 12, 23, 24],
  coreIds: [11, 12],
  minCore: 2,
  minSeparation: 0.15,
  confirmFrames: 6,
  maxStep: 0.1,
  holdMs: 1200,
  easeMs: 80,
  validate: (det, item) => {
    const now = shoulderWidth(det.world), before = shoulderWidth(item.tWorld);
    return Math.abs(now / before - 1) < 0.35;
  },
});
// Hands drawn on their own fade quickly so there are no ghost copies; hands attached to a body
// are remembered by the body itself. Hand landmarks carry no visibility scores.
const handTracker = new Tracker({
  count: 21, centerIds: [0, 5, 9, 13, 17], useVisibility: false,
  maxJump: 0.15, minSeparation: 0.04, confirmFrames: 3, maxStep: 0.2, holdMs: 150, fadeMs: 150, easeMs: 50,
});
const handInfo = (h) => ({ ...h, side: h.extra.side, bodyId: h.extra.bodyId });

let mode = q.get('mode') === 'me' ? 'me' : 'them';
let pose, handsModel, faces, faceMesh;
let people = [];
let hands = [];
let face = null; // { cx, cy, w } of the largest face, normalised to the frame (Self-diagnostic)
let headPoses = []; // [{ nose, width, q }] from the face tracker (Subject scan)
let closeFrames = 0, scareArmed = true, scareCooldownUntil = 0, wasScaring = false;
let lastDraw = 0, lastVision = 0, visionCount = 0, lastFaces = [];
let parallax = true;
try { parallax = localStorage.getItem('xray-parallax') !== 'off'; } catch { /* storage blocked */ }
let booth = null;
const sounds = new SoundBank();
// Idle attract mode: after a few seconds with nobody in view, a skeleton beckons people closer.
const ATTRACT_AFTER_MS = 3000;
let lastSeen = 0, attracting = false, lastAttractSound = -1e9;
// Thumbs-up gesture: consecutive tracking frames it has been held, and when the last photo was taken.
let thumbFrames = 0, lastThumbPhoto = -1e9;
let game = null;
// Self-diagnostic framing adjusted by drag (pan) and pinch (zoom), remembered on this device.
const DEFAULT_VIEW = { x: 0, y: 0, zoom: 1 };
let view = { ...DEFAULT_VIEW };
try { Object.assign(view, JSON.parse(localStorage.getItem('xray-view') || '{}')); } catch { /* storage blocked */ }
const saveView = () => { try { localStorage.setItem('xray-view', JSON.stringify(view)); } catch { /* storage blocked */ } };
let lastFrame = null; // the latest raw tracking frame, for the diagnostic view
let recording = null; // { start, frames } while recording
let replay = null; // { frames, start, next, videoW, videoH } while replaying
const diag = cfg.diag ? new Diagnostics($('diag')) : null;
document.body.classList.toggle('diag', cfg.diag);
let lastVideoTime = -1, lastTs = 0;
let fps = 0, lastFrameT = performance.now();
const ms = { pose: 0, hands: 0, face: 0, draw: 0 };
const timed = (key, fn) => {
  const t0 = performance.now();
  const r = fn();
  ms[key] += (performance.now() - t0 - ms[key]) * 0.1;
  return r;
};
let debug = q.get('debug') === '1';
document.body.classList.toggle('debug', debug);
document.body.classList.toggle('mode-inside', mode === 'me');

async function createTask(Task, fileset, options) {
  try {
    return await Task.createFromOptions(fileset, { ...options, baseOptions: { ...options.baseOptions, delegate: 'GPU' } });
  } catch (err) {
    console.warn('GPU delegate failed, using CPU', err);
    return Task.createFromOptions(fileset, { ...options, baseOptions: { ...options.baseOptions, delegate: 'CPU' } });
  }
}

async function setupScenes() {
  $('err').textContent = 'Loading anatomy…';
  const anatomy = await loadAnatomy();
  rig = anatomy.rig;
  xray = cfg.skeleton3d ? new SkeletonXRay($('xray'), anatomy) : new XRay2D($('xray'));
  xray.mirror = cfg.mirror;
  inside = new Inside3D($('inside'), anatomy);
  inside.configure(cfg);
  inside.setView(view);
  scare = new Jumpscare(anatomy);
}

async function loadModels() {
  $('err').textContent = 'Loading vision models…';
  const fileset = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm');
  [pose, handsModel, faces, faceMesh] = await Promise.all([
    createTask(PoseLandmarker, fileset, {
      baseOptions: { modelAssetPath: `models/pose_landmarker_${cfg.poseModel}.task` },
      runningMode: 'VIDEO',
      numPoses: 3,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    }),
    createTask(HandLandmarker, fileset, {
      baseOptions: { modelAssetPath: 'models/hand_landmarker.task' },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    }),
    createTask(FaceDetector, fileset, {
      baseOptions: { modelAssetPath: 'models/blaze_face_short_range.tflite' },
      runningMode: 'VIDEO',
      minDetectionConfidence: 0.5,
    }),
    // Head rotation (including nodding up and down) for the skulls, and face size for the jumpscare.
    createTask(FaceLandmarker, fileset, {
      baseOptions: { modelAssetPath: 'models/face_landmarker.task' },
      runningMode: 'VIDEO',
      numFaces: 3,
      outputFacialTransformationMatrixes: true,
      outputFaceBlendshapes: false,
    }),
  ]);
}

// ?nocam=1 previews Mode 2 without a camera or vision models (idle viewpoint drift only).
async function startWithoutCamera(audio) {
  await setupScenes();
  await scare.unlock(audio);
  await startSounds(audio);
  mode = 'me';
  document.body.classList.add('mode-inside');
  $('start').hidden = true;
  showTools();
  const idle = (now) => {
    requestAnimationFrame(idle);
    inside.render(now, null);
    $('status').textContent = 'Preview · no camera';
    $('modeLabel').textContent = LABELS.me;
  };
  requestAnimationFrame(idle);
}

// ?fake=1 loads everything, then drives Mode 1 with a synthetic person and a hand built from the
// rig's rest pose with a curling index finger. Tests the rigging without a camera.
async function startFake(audio) {
  await setupScenes();
  await scare.unlock(audio);
  await startSounds(audio);
  await loadModels();
  $('start').hidden = true;
  showTools();
  mode = 'them';
  const restHand = rig.points.handR.map((a) => new THREE.Vector3(a[0], a[1], a[2]));
  const fakeLoop = (now) => {
    requestAnimationFrame(fakeLoop);
    // During the pose game the figure copies each target (pose or move) about 1.5 s into the round.
    const g = game?.state;
    const arms = g?.phase === 'pose' && now - g.phaseStart > 1500 ? game.demoArms(now) : null;
    const { image, world } = syntheticPose(now, arms ? { arms } : { sway: Math.sin(now / 900) * 0.03, turn: Math.sin(now / 1300) * 0.5 });
    // Every third 1.5 s window, simulate a hand covering the face: arms lose confidence and the
    // head landmarks jump around with high confidence. The skeleton should hold still through it.
    if (!game?.active && Math.floor(now / 1500) % 3 === 2) {
      image.forEach((p, i) => {
        if (i >= 13 && i <= 22) Object.assign(p, { x: p.x + (Math.random() - 0.5) * 0.3, visibility: 0.15 });
        else if (i <= 10) Object.assign(p, { x: p.x + (Math.random() - 0.5) * 0.4, y: p.y + Math.random() * 0.2, visibility: 0.9 });
      });
    }
    bodyTracker.update([{ image, world }], now);
    people = bodyTracker.tick(now);

    // Hand: rest pose, index finger curling, whole hand rocking; shown at the top-right of the frame.
    const curl = (0.5 - 0.5 * Math.cos(now / 400)) * 1.2;
    const hw = restHand.map((p) => p.clone());
    const axis = new THREE.Vector3().subVectors(hw[17], hw[5]).normalize();
    for (const [pivot, from] of [[5, 6], [6, 7], [7, 8]]) {
      const rot = new THREE.Quaternion().setFromAxisAngle(axis, curl * 0.6);
      for (let j = from; j <= 8; j++) hw[j].sub(hw[pivot]).applyQuaternion(rot).add(hw[pivot]);
    }
    const rock = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.sin(now / 1100) * 0.6, Math.PI));
    const c = hw[9].clone();
    const handWorld = hw.map((p) => p.sub(c).applyQuaternion(rock));
    // visibility 0, as real hand landmarks report it.
    const handImage = handWorld.map((p) => ({ x: 0.2 + p.x * 2.2, y: 0.4 + p.y * 3.9, visibility: 0 }));
    // Every other 4 s the hand attaches to the figure's right wrist, the path a real hand takes when the body is in view.
    const attached = Math.floor(now / 4000) % 2 === 1 && people.length;
    handTracker.update([{ image: handImage, world: handWorld, extra: { side: 'R', bodyId: attached ? people[0].id : null } }], now);
    hands = handTracker.tick(now).map(handInfo);

    xray.setVideoSize(1280, 720);
    xray.update(people, hands);
    xray.render();
    game?.update(people, now, toDisplay);
    $('status').textContent = Math.floor(now / 1500) % 3 === 2 ? 'Test figure · simulated occlusion' : 'Test figure · no camera';
    $('modeLabel').textContent = LABELS.them;
  };
  requestAnimationFrame(fakeLoop);
}

async function start() {
  $('go').disabled = true;
  // Audio must be unlocked inside this tap for the jumpscare scream to play later on iPad.
  const unlock = new (window.AudioContext || window.webkitAudioContext)();
  unlock.resume();
  // Speech also needs a first use inside a tap before the photo countdown can speak later.
  if ('speechSynthesis' in window) speechSynthesis.speak(Object.assign(new SpeechSynthesisUtterance(' '), { volume: 0 }));
  const fail = (msg) => { $('go').disabled = false; $('err').textContent = msg; };
  if (q.get('nocam') === '1') return startWithoutCamera(unlock).catch((e) => fail(e.message));
  if (q.get('fake') === '1') return startFake(unlock).catch((e) => { console.error(e); fail(e.message); });
  if (cfg.replay) return startReplay(unlock).catch((e) => { console.error(e); fail(`Couldn't replay: ${e.message}`); });
  $('err').textContent = 'Starting camera…';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      // 960x540 is plenty for the models (they downscale anyway) and costs less to process.
      video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 540 } },
    });
    video.srcObject = stream;
    await video.play();
  } catch (err) {
    return fail(window.isSecureContext
      ? `Camera unavailable: ${err.message}. Allow camera access and try again.`
      : 'The camera needs a secure page. On the iPad, open the https:// address the server prints.');
  }

  try {
    await setupScenes();
    await scare.unlock(unlock);
    await startSounds(unlock);
    await loadModels();
  } catch (err) {
    console.error(err);
    return fail(`Couldn't load: ${err.message}`);
  }

  xray.setVideoSize(video.videoWidth, video.videoHeight);
  $('start').hidden = true;
  showTools();
  keepAwake();
  if (cfg.record) startRecording(cfg.record);
  requestAnimationFrame(loop);
}

// Replays a recording (made with ?record or the r key) through the same trackers and renderers.
async function startReplay(audio) {
  await setupScenes();
  await scare.unlock(audio);
  await startSounds(audio);
  $('err').textContent = 'Loading recording…';
  const data = await (await fetch(cfg.replay)).json();
  replay = { frames: data.frames, videoW: data.videoW, videoH: data.videoH, start: null, next: 0 };
  xray.setVideoSize(data.videoW, data.videoH);
  $('start').hidden = true;
  showTools();
  requestAnimationFrame(loop);
}

let wakeLock = null;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not supported or refused */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && $('start').hidden) keepAwake();
});

// Recordings and replays use a compact, rounded copy of each frame's tracking results.
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const pack = (lms) => lms.map((p) => [r4(p.x), r4(p.y), r4(p.z ?? 0), r4(p.visibility ?? 0)]);
const unpack = (arr) => arr.map(([x, y, z, visibility]) => ({ x, y, z, visibility }));

function runVision(now) {
  const ts = (lastTs = Math.max(now, lastTs + 1));

  // Mode 2 only needs the viewer's face; Mode 1 only needs bodies, hands and faces.
  if (mode === 'me') {
    if (parallax) detectFace(ts);
    return;
  }
  const pr = timed('pose', () => pose.detectForVideo(video, ts));
  const hr = timed('hands', () => handsModel.detectForVideo(video, ts));
  // The face mesh (head rotation, jumpscare distance) runs on every other tracking frame.
  const fr = visionCount++ % 2 === 0 ? timed('face', () => faceMesh.detectForVideo(video, ts)) : null;
  const frame = {
    pose: (pr.landmarks || []).map((lm, i) => ({ image: pack(lm), world: pack(pr.worldLandmarks[i]) })),
    hands: (hr.landmarks || []).map((lm, i) => ({ image: pack(lm), world: pack(hr.worldLandmarks[i]), label: hr.handedness[i]?.[0]?.categoryName })),
    // 1 is the nose tip; 234 and 454 are the outer edges of the face.
    faces: !fr ? lastFaces : (lastFaces = (fr.faceLandmarks || []).map((lm, i) => ({
      nose: [r4(lm[1].x), r4(lm[1].y)],
      width: r4(Math.abs(lm[454].x - lm[234].x)),
      matrix: fr.facialTransformationMatrixes?.[i] ? Array.from(fr.facialTransformationMatrixes[i].data, r4) : null,
    }))),
  };
  if (recording) recording.frames.push({ t: Math.round(now - recording.start), ...frame });
  ingest(frame, now);
}

// Feeds one frame of tracking results (live or replayed) into the trackers.
function ingest(frame, now) {
  lastFrame = frame;
  bodyTracker.update(frame.pose.map((p) => ({ image: unpack(p.image), world: unpack(p.world) })), now);
  const dets = [];
  for (const h of frame.hands) {
    const image = unpack(h.image);
    // Skip a second detection of the same hand.
    if (dets.some((d) => Math.hypot(d.image[0].x - image[0].x, d.image[0].y - image[0].y) < 0.03)) continue;
    dets.push({ image, world: unpack(h.world), extra: whoseHand(image[0], h.label) });
  }
  handTracker.update(dets, now);
  readHeads(frame.faces);
  checkScare(now);
  checkThumbsUp(dets, now);
}

// Thumb pointing up with the other four fingers curled, on any hand. Uses the hand tracker's
// metric 3D points, so it works whichever way the fist faces. y points down.
function isThumbsUp(w) {
  const d = (a, b) => Math.hypot(w[a].x - w[b].x, w[a].y - w[b].y, w[a].z - w[b].z);
  const tx = w[4].x - w[2].x, ty = w[4].y - w[2].y, tz = w[4].z - w[2].z;
  const thumbLen = Math.hypot(tx, ty, tz);
  if (thumbLen < 0.025 || -ty < 0.7 * thumbLen) return false;
  if (w[4].y > Math.min(w[8].y, w[12].y, w[16].y, w[20].y) - 0.01) return false;
  // Curled: each fingertip is nearer the wrist than that finger's middle knuckle.
  return [[8, 6], [12, 10], [16, 14], [20, 18]].every(([tip, pip]) => d(tip, 0) < d(pip, 0) * 1.05);
}

// Held for about a third of a second (5 tracking frames), at most one photo every 8 s.
function checkThumbsUp(dets, now) {
  const up = mode === 'them' && !game?.active && !overlayOpen() && dets.some((d) => isThumbsUp(d.world));
  thumbFrames = up ? thumbFrames + 1 : 0;
  if (thumbFrames >= 5 && now - lastThumbPhoto > 8000 && !booth?.busy && !scare.playing && !overlayOpen()) {
    thumbFrames = 0;
    lastThumbPhoto = now;
    sounds.play('thumbsup');
    takePhoto();
  }
}

async function startSounds(audio) {
  await sounds.load(audio);
  sounds.play('ambient', { volume: 0.25, loop: true });
}

// Face tracker -> head rotation per face, converted from MediaPipe's face space (x right, y up,
// z toward the camera) into the skeleton's (x right, y down, z away): R' = C·R·C, C = diag(1,-1,-1).
const C = new THREE.Matrix4().makeScale(1, -1, -1);
function readHeads(faceList) {
  headPoses = faceList.map((f) => {
    let q = null;
    if (f.matrix) {
      q = new THREE.Quaternion();
      C.clone().multiply(new THREE.Matrix4().fromArray(f.matrix)).multiply(C).decompose(new THREE.Vector3(), q, new THREE.Vector3());
    }
    return { nose: { x: f.nose[0], y: f.nose[1] }, width: f.width, q };
  });
}

function startRecording(seconds = 0) {
  recording = { start: performance.now(), frames: [] };
  if (seconds) setTimeout(stopRecording, seconds * 1000);
}

// Saves the recording as a JSON file (downloads on a Mac; on iPad Safari it opens the share sheet).
function stopRecording() {
  if (!recording) return;
  const data = { videoW: video.videoWidth || 1280, videoH: video.videoHeight || 720, frames: recording.frames };
  recording = null;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  a.download = `xray-recording-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// Replay: feed every recorded frame whose time has come, looping at the end.
function pullReplay(now) {
  if (replay.start === null) replay.start = now;
  const t = now - replay.start;
  while (replay.next < replay.frames.length && replay.frames[replay.next].t <= t) {
    const f = replay.frames[replay.next++];
    ingest(f, replay.start + f.t);
  }
  if (replay.next >= replay.frames.length) {
    replay.start = null;
    replay.next = 0;
    bodyTracker.items = [];
    handTracker.items = [];
  }
}

// Lean in too close and the machine screams. Re-arms once the face backs off again.
function checkScare(now) {
  if (!cfg.scare || scare.playing || game?.active || document.body.classList.contains('shooting') || overlayOpen()) return;
  const widest = headPoses.reduce((m, h) => Math.max(m, h.width), 0);
  if (widest < cfg.scareAt * 0.7) scareArmed = true;
  closeFrames = widest > cfg.scareAt ? closeFrames + 1 : 0;
  if (scareArmed && closeFrames >= 6 && now > scareCooldownUntil) {
    scareArmed = false;
    scareCooldownUntil = now + 6000;
    scare.trigger();
  }
}

function detectFace(ts) {
  const fr = timed('face', () => faces.detectForVideo(video, ts));
  face = null;
  for (const d of fr.detections || []) {
    const b = d.boundingBox;
    const k = d.keypoints;
    const w = b.width / video.videoWidth;
    if (face && face.w >= w) continue;
    // Keypoints 0 and 1 are the eyes; use their midpoint as the eye position.
    const cx = k && k.length > 1 ? (k[0].x + k[1].x) / 2 : (b.originX + b.width / 2) / video.videoWidth;
    const cy = k && k.length > 1 ? (k[0].y + k[1].y) / 2 : (b.originY + b.height * 0.4) / video.videoHeight;
    face = { cx, cy, w };
  }
}

// Match a tracked hand to a body wrist so the body hides its own coarse hand. With no body nearby,
// fall back to MediaPipe's handedness, which assumes a mirrored image, so it is flipped here.
function whoseHand(wrist, label) {
  let best = null, bestD = 0.08;
  for (const p of people) {
    for (const [i, side] of [[15, 'L'], [16, 'R']]) {
      const d = Math.hypot(p.lm[i].x - wrist.x, p.lm[i].y - wrist.y);
      if (p.lm[i].v > 0.3 && d < bestD) { best = { side, bodyId: p.id }; bestD = d; }
    }
  }
  if (best) return best;
  return { side: label === 'Left' ? 'R' : 'L', bodyId: null };
}

// A photo panel or the pose-game gallery is on screen.
const overlayOpen = () => !$('photos').hidden || !$('gallery').hidden;

// ---------- toolbar ----------

function showTools() {
  $('tools').hidden = false;
  const fsSupported = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen;
  $('fullscreenBtn').hidden = !fsSupported;
  updateParallaxBtn();
}

function toggleFullscreen() {
  const el = document.documentElement;
  const isFull = document.fullscreenElement || document.webkitFullscreenElement;
  if (isFull) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  else (el.requestFullscreen || el.webkitRequestFullscreen).call(el)?.catch?.(() => {});
}
for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) {
  document.addEventListener(ev, () => {
    $('fullscreenBtn').textContent = document.fullscreenElement || document.webkitFullscreenElement ? 'Exit full screen' : 'Full screen';
  });
}

function updateParallaxBtn() {
  $('parallaxBtn').textContent = parallax ? 'Parallax on' : 'Parallax off';
  $('parallaxBtn').setAttribute('aria-pressed', String(parallax));
}
function toggleParallax() {
  parallax = !parallax;
  face = null;
  try { localStorage.setItem('xray-parallax', parallax ? 'on' : 'off'); } catch { /* storage blocked */ }
  updateParallaxBtn();
}

// Two pictures of the same instant, framed like the screen: the people, and the people as an X-ray
// (a faint grey ghost of them under the skeleton, with a caption).
function capturePhotos() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = Math.round(window.innerWidth * dpr), H = Math.round(window.innerHeight * dpr);
  const make = () => Object.assign(document.createElement('canvas'), { width: W, height: H });
  const plain = make();
  const pc = plain.getContext('2d');
  pc.fillStyle = '#000';
  pc.fillRect(0, 0, W, H);
  if (video.videoWidth) {
    const vw = video.videoWidth, vh = video.videoHeight, s = Math.max(W / vw, H / vh);
    pc.save();
    if (xray.mirror) { pc.translate(W, 0); pc.scale(-1, 1); }
    pc.drawImage(video, (W - vw * s) / 2, (H - vh * s) / 2, vw * s, vh * s);
    pc.restore();
  }
  const ray = make();
  const rc = ray.getContext('2d');
  const ghost = pc.getImageData(0, 0, W, H);
  const g = ghost.data;
  for (let i = 0; i < g.length; i += 4) {
    const y = (g[i] * 0.3 + g[i + 1] * 0.59 + g[i + 2] * 0.11) * 0.16;
    g[i] = g[i + 1] = g[i + 2] = y;
  }
  rc.putImageData(ghost, 0, 0);
  // Draw a fresh frame and copy it straight away, before the browser can clear the WebGL buffer.
  xray.update(people, hands, headPoses);
  xray.render();
  rc.globalCompositeOperation = 'screen';
  rc.drawImage($('xray'), 0, 0, W, H);
  rc.globalCompositeOperation = 'source-over';
  const fs = Math.round(14 * dpr);
  rc.font = `${fs}px ui-monospace, Menlo, monospace`;
  rc.fillStyle = 'rgba(255,255,255,0.8)';
  rc.fillText(`X-RAY SCANNER · SUBJECT SCAN · ${new Date().toLocaleString()}`, fs * 1.4, H - fs * 1.4);
  return { plain, xray: ray };
}

function startGame() {
  if (mode !== 'them' || scare.playing || booth?.busy || overlayOpen()) return;
  game ||= new PoseGame({ audio: scare.audio || null, sounds, capture: capturePhotos });
  if (game.active) game.stop();
  else game.start(performance.now());
}

// Normalised landmark -> mirrored display pixels (the pose game compares angles as players see them).
const toDisplay = (p) => ({ x: (xray.mirror ? 1 - p.x : p.x) * xray.vw, y: p.y * xray.vh });

function takePhoto() {
  if (mode !== 'them' || scare.playing) return;
  booth ||= new PhotoBooth({ audio: scare.audio || null, sounds, capture: capturePhotos });
  booth.run();
}

$('fullscreenBtn').addEventListener('click', toggleFullscreen);
$('parallaxBtn').addEventListener('click', toggleParallax);
$('resetViewBtn').addEventListener('click', () => {
  view = { ...DEFAULT_VIEW };
  inside.setView(view);
  saveView();
});
$('photoBtn').addEventListener('click', takePhoto);
$('gameBtn').addEventListener('click', startGame);

function setMode(m) {
  if (m !== 'them') game?.stop();
  mode = m;
  face = null;
  document.body.classList.toggle('mode-inside', mode === 'me');
}

// Viewer's eye in metres relative to the screen centre, from the face in the front camera.
const tmpEye = new THREE.Vector3();
const centreEye = new THREE.Vector3(0, 0, 0.45);
function eyePosition() {
  if (!parallax) return centreEye;
  if (!face) return null;
  const th = Math.tan(((cfg.hfov / 2) * Math.PI) / 180);
  const tv = (th * video.videoHeight) / video.videoWidth;
  // A face (as BlazeFace boxes it) is about 15 cm wide.
  const d = Math.min(2, Math.max(0.18, 0.15 / (2 * th * face.w)));
  // The raw frame is unmirrored: the camera's right is the viewer's left, so x flips.
  const x = -(face.cx - 0.5) * 2 * th * d;
  const y = -(face.cy - 0.5) * 2 * tv * d;
  // Front camera sits just above the top edge of the screen.
  return tmpEye.set(x, y + inside.screenH / 2 + 0.008, d);
}

function status() {
  const n = people.filter((p) => p.alpha > 0.5).length;
  if (mode === 'me') return face ? 'Imaging operator chest' : 'Standby · no operator';
  if (!n && hands.length) return 'Hand in field';
  return n ? `${n} subject${n > 1 ? 's' : ''} in field` : 'No subject · step into view';
}

function loop(now) {
  requestAnimationFrame(loop);
  // Tracking pauses during a jumpscare (the scare covers the screen and people flinch, so it would
  // only glitch), then starts fresh afterwards.
  if (scare.playing) {
    wasScaring = true;
    return;
  }
  if (wasScaring) {
    wasScaring = false;
    bodyTracker.items = [];
    handTracker.items = [];
    closeFrames = 0;
  }
  if (replay) pullReplay(now);
  else if (video.readyState >= 2 && video.currentTime !== lastVideoTime && now - lastVision >= 1000 / cfg.visionFps - 4) {
    lastVideoTime = video.currentTime;
    lastVision = now;
    runVision(now);
  }
  if (now - lastDraw < 1000 / cfg.fps - 4) return;
  lastDraw = now;
  people = bodyTracker.tick(now);
  hands = handTracker.tick(now).map(handInfo);
  // Attract mode: nobody in view for a few seconds -> a beckoning skeleton and an invitation.
  if (people.length || hands.length) lastSeen = now;
  const wantAttract = mode === 'them' && !game?.active && now - lastSeen > ATTRACT_AFTER_MS && !overlayOpen() && !booth?.busy;
  if (wantAttract !== attracting) {
    attracting = wantAttract;
    document.body.classList.toggle('attract', attracting);
    if (attracting && now - lastAttractSound > 30000) { sounds.play('attract'); lastAttractSound = now; }
  }
  sounds.setLoopVolume('ambient', scare.playing ? 0 : 0.25);
  timed('draw', () => {
    if (mode === 'them' && attracting) {
      xray.update([syntheticPerson(now, { beckon: true, sway: Math.sin(now / 1400) * 0.02, alpha: Math.min(1, (now - lastSeen - ATTRACT_AFTER_MS) / 800) })], [], []);
      xray.render();
    } else if (mode === 'them') {
      xray.update(people, hands, headPoses);
      xray.render();
      game?.update(people, now, toDisplay);
    } else {
      inside.render(now, eyePosition());
    }
  });

  const dt = now - lastFrameT;
  lastFrameT = now;
  fps += (1000 / Math.max(1, dt) - fps) * 0.05;
  $('status').textContent = recording ? `Recording ${((now - recording.start) / 1000).toFixed(0)} s · press r to save` : status();
  if (diag && mode === 'them') diag.draw({ frame: lastFrame, people, hands, mirror: xray.mirror, videoW: xray.vw, videoH: xray.vh, now });
  $('modeLabel').textContent = LABELS[mode];
  if (debug) {
    const e = mode === 'me' ? inside.eye : null;
    $('debug').textContent = [
      `fps ${fps.toFixed(0)}  video ${video.videoWidth}x${video.videoHeight}`,
      `people ${people.length}  hands ${hands.length}  face ${face ? face.w.toFixed(2) : '-'}`,
      `ms  pose ${ms.pose.toFixed(1)}  hands ${ms.hands.toFixed(1)}  face ${ms.face.toFixed(1)}  draw ${ms.draw.toFixed(1)}`,
      e ? `eye x ${(e.x * 100).toFixed(1)} y ${(e.y * 100).toFixed(1)} z ${(e.z * 100).toFixed(1)} cm` : '',
      `screen ${(inside.screenW * 100).toFixed(1)} x ${(inside.screenH * 100).toFixed(1)} cm`,
    ].join('\n');
  }
}

// Hold the screen for 1 second to switch between Them and Me; a bar fills while holding.
const HOLD_MS = 1000;
let holdStart = null, holdTimer = null;
function drawHold() {
  if (holdStart === null) return;
  $('hold').style.transform = `scaleX(${Math.min(1, (performance.now() - holdStart) / HOLD_MS)})`;
  requestAnimationFrame(drawHold);
}
function endHold() {
  holdStart = null;
  clearTimeout(holdTimer);
  $('hold').style.transform = 'scaleX(0)';
}
// Pointers currently down on the scene, for drag-to-pan and pinch-to-zoom in Self-diagnostic.
const pointers = new Map();
let pressStart = null;
window.addEventListener('pointerdown', (e) => {
  if (!$('start').hidden || overlayOpen() || document.body.classList.contains('shooting')) return;
  if (e.target instanceof Element && e.target.closest('#tools')) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  // A second finger means a pinch, not a hold.
  if (pointers.size > 1) { endHold(); return; }
  pressStart = { x: e.clientX, y: e.clientY };
  endHold();
  holdStart = performance.now();
  holdTimer = setTimeout(() => { setMode(mode === 'them' ? 'me' : 'them'); endHold(); }, HOLD_MS);
  requestAnimationFrame(drawHold);
});
window.addEventListener('pointermove', (e) => {
  const prev = pointers.get(e.pointerId);
  if (!prev) return;
  // Moving more than a few pixels is a drag, which cancels the hold.
  if (pressStart && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 10) endHold();
  const before = [...pointers.values()].map((p) => ({ ...p }));
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (mode !== 'me' || holdStart !== null) return;
  const after = [...pointers.values()];
  const mid = (ps) => ({ x: ps.reduce((a, p) => a + p.x, 0) / ps.length, y: ps.reduce((a, p) => a + p.y, 0) / ps.length });
  const m0 = mid(before), m1 = mid(after);
  // Content moves with the finger; it sits a little behind the glass, so move it a bit further.
  const k = inside.metresPerPixel() * 1.3;
  view.x += (m1.x - m0.x) * k;
  view.y -= (m1.y - m0.y) * k;
  if (after.length >= 2) {
    const d0 = Math.hypot(before[0].x - before[1].x, before[0].y - before[1].y);
    const d1 = Math.hypot(after[0].x - after[1].x, after[0].y - after[1].y);
    if (d0 > 10) view.zoom = Math.min(3, Math.max(0.5, view.zoom * (d1 / d0)));
  }
  inside.setView(view);
});
const releasePointer = (e) => {
  pointers.delete(e.pointerId);
  endHold();
  if (pointers.size === 0) { pressStart = null; if (mode === 'me') saveView(); }
};
window.addEventListener('pointerup', releasePointer);
window.addEventListener('pointercancel', releasePointer);
// Mac: scroll or trackpad-pinch to zoom.
window.addEventListener('wheel', (e) => {
  if (mode !== 'me' || !$('start').hidden) return;
  e.preventDefault();
  view.zoom = Math.min(3, Math.max(0.5, view.zoom * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002))));
  inside.setView(view);
  saveView();
}, { passive: false });
window.addEventListener('keydown', (e) => {
  if (e.key === '1') setMode('them');
  if (e.key === '2') setMode('me');
  if (e.key === 'm' && xray) xray.mirror = !xray.mirror;
  if (e.key === 's' && scare) scare.trigger();
  if (e.key === 'p' && $('start').hidden) takePhoto();
  if (e.key === 'g' && $('start').hidden) startGame();
  if (e.key === 'f') toggleFullscreen();
  if (e.key === 'r' && !replay && $('start').hidden) recording ? stopRecording() : startRecording();
  if (e.key === 'd') { debug = !debug; document.body.classList.toggle('debug', debug); }
});
window.addEventListener('resize', () => { xray?.resize(); inside?.resize(); scare?.resize(); });

$('go').addEventListener('click', start);
setupSoundPanel(sounds);
