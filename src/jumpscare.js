// Jumpscare for when someone leans in too close.
//
// An 0.8 s burst rendered from the real skull with a separate jaw: a flash of rainbow static,
// then the skull rushes from a quarter of the screen to filling it, jaw dropping, eyes burning red, and the
// whole thing (picture and scream) cuts off dead. Everything goes through a post pass: rainbow static, RGB split, tearing, barrel warp, roll,
// inversion strobes. Videos listed in media/jumpscares.json (files in media/jumpscares/) join the
// rotation and go through the same distortion.
import * as THREE from 'three';
import { xrayMaterial } from './xraymat.js';

const SOUND = 'media/static_scream.mp3';
const DURATION = 0.8;

const postVert = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const postFrag = /* glsl */ `
  uniform sampler2D tScene;
  uniform float time, rgb, tear, noise, invert, hue, roll, warp, flash, blackout;
  varying vec2 vUv;
  float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }
  vec3 hsv(vec3 c) {
    vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
    return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
  }
  void main() {
    vec2 uv = vUv;
    vec2 cc = uv - 0.5;
    float r2 = dot(cc, cc);
    uv = 0.5 + cc * (1.0 + warp * r2 * 2.0);
    // Tearing: random horizontal bands slide sideways.
    float tick = floor(time * 24.0);
    float band = floor(uv.y * 28.0);
    float on = step(0.55, rand(vec2(band * 1.7, tick)));
    uv.x += (rand(vec2(band, tick)) - 0.5) * tear * on;
    uv.y = fract(uv.y + roll);
    // RGB split, wider on torn bands.
    float s = rgb * (1.0 + on * 2.0);
    vec3 col = vec3(
      texture2D(tScene, uv + vec2(s, 0.0)).r,
      texture2D(tScene, uv).g,
      texture2D(tScene, uv - vec2(s, s * 0.3)).b
    );
    if (uv.x < 0.0 || uv.x > 1.0) col = vec3(0.0);
    // Rainbow static in chunky pixels.
    vec2 px = floor(gl_FragCoord.xy / 3.0);
    float n = rand(px + time * 61.0);
    vec3 rainbow = hsv(vec3(fract(n * 2.0 + hue + vUv.y * 0.7), 0.85, n));
    col = mix(col, rainbow, clamp(noise * (0.55 + 0.45 * rand(px * 0.37 + tick)), 0.0, 1.0));
    col *= 0.82 + 0.18 * sin(gl_FragCoord.y * 3.14159);
    col = mix(col, 1.0 - col, invert);
    col += vec3(flash, flash * 0.1, flash * 0.1);
    col *= 1.0 - 0.9 * r2;
    col *= 1.0 - blackout;
    gl_FragColor = vec4(col, 1.0);
  }
`;

const rnd = (a = 1) => (Math.random() - 0.5) * 2 * a;

export class Jumpscare {
  constructor(anatomy) {
    this.canvas = document.getElementById('scare');
    this.video = document.getElementById('scareVideo');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false });
    this.renderer.setClearColor(0x000000, 1);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 100);
    this.camera.position.set(0, 0, 3);
    this.target = new THREE.WebGLRenderTarget(16, 16);

    // Skull in view coordinates (y up, face toward the camera), about 1 unit tall, jaw hinged.
    const flip = new THREE.Matrix4().makeScale(1, -1, -1);
    const cranium = anatomy.parts.cranium.clone().applyMatrix4(flip);
    const jaw = anatomy.parts.jaw.clone().applyMatrix4(flip);
    const box = new THREE.Box3().setFromBufferAttribute(cranium.attributes.position).union(new THREE.Box3().setFromBufferAttribute(jaw.attributes.position));
    const size = box.getSize(new THREE.Vector3());
    const c = box.getCenter(new THREE.Vector3());
    for (const g of [cranium, jaw]) {
      g.translate(-c.x, -c.y, -c.z);
      g.scale(1 / size.y, 1 / size.y, 1 / size.y);
    }
    const mat = xrayMaterial({ base: 0.03, rim: 0.85, power: 2.2 });
    this.skull = new THREE.Group();
    this.skull.add(new THREE.Mesh(cranium, mat));
    // The jaw pivots at its condyles: the top, rearmost part of the mandible.
    jaw.computeBoundingBox();
    const hinge = new THREE.Vector3(0, jaw.boundingBox.max.y - 0.02, jaw.boundingBox.min.z + 0.05);
    jaw.translate(-hinge.x, -hinge.y, -hinge.z);
    this.jaw = new THREE.Group();
    this.jaw.position.copy(hinge);
    this.jaw.add(new THREE.Mesh(jaw, mat));
    this.skull.add(this.jaw);
    // Burning eyes deep in the sockets.
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0xff2a1a, transparent: true, blending: THREE.AdditiveBlending, depthTest: false });
    this.eyes = [-1, 1].map((sgn) => {
      const e = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 12), eyeMat);
      e.position.set(sgn * 0.13 * (size.x / size.y), 0.1, 0.28 * (size.z / size.y));
      this.skull.add(e);
      return e;
    });
    this.scene.add(this.skull);

    this.post = new THREE.ShaderMaterial({
      uniforms: Object.fromEntries(['time', 'rgb', 'tear', 'noise', 'invert', 'hue', 'roll', 'warp', 'flash', 'blackout'].map((k) => [k, { value: 0 }])),
      vertexShader: postVert,
      fragmentShader: postFrag,
      depthTest: false,
    });
    this.post.uniforms.tScene = { value: this.target.texture };
    this.postScene = new THREE.Scene();
    this.postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.post));
    this.postCamera = new THREE.Camera();

    this.videos = [];
    fetch('media/jumpscares.json')
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => { this.videos = list.map((f) => `media/jumpscares/${f}`); })
      .catch(() => {});
    this.active = null;
    this.resize();
  }

  // Must be called with an AudioContext created inside a tap, so iOS allows sound later.
  async unlock(ctx) {
    try {
      this.audio = ctx;
      await ctx.resume();
      this.buffer = await ctx.decodeAudioData(await (await fetch(SOUND)).arrayBuffer());
      // Louder than the file: drive it into a soft clipper (adds grit, which suits a static scream).
      const drive = 2.6;
      const curve = new Float32Array(1024);
      for (let i = 0; i < curve.length; i++) {
        const x = (i / (curve.length - 1)) * 2 - 1;
        curve[i] = Math.tanh(drive * x) / Math.tanh(drive);
      }
      this.shaper = ctx.createWaveShaper();
      this.shaper.curve = curve;
      this.shaper.oversample = '2x';
      this.master = ctx.createGain();
      this.shaper.connect(this.master).connect(ctx.destination);
    } catch (err) {
      console.warn('Jumpscare sound unavailable', err);
    }
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.target.setSize(Math.round(w * dpr), Math.round(h * dpr));
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  get playing() { return this.active !== null; }

  // Plays a random slice of the scream for exactly `seconds`, then cuts.
  scream(seconds) {
    if (!this.buffer || !this.master) return null;
    const ctx = this.audio;
    const t0 = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    const pre = ctx.createGain();
    pre.gain.value = 1.4;
    src.connect(pre).connect(this.shaper);
    this.master.gain.cancelScheduledValues(t0);
    this.master.gain.setValueAtTime(1, t0);
    // A 10 ms ramp at the very end avoids a click without softening the cut.
    this.master.gain.setValueAtTime(1, t0 + seconds - 0.01);
    this.master.gain.linearRampToValueAtTime(0, t0 + seconds);
    const offset = Math.random() * Math.max(0, this.buffer.duration - seconds - 0.1);
    src.start(t0, offset);
    src.stop(t0 + seconds + 0.02);
    return src;
  }

  trigger() {
    if (this.active) return;
    const kinds = ['skull', ...this.videos];
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    document.body.classList.add('scaring');
    const a = { kind, start: performance.now(), duration: DURATION, hue: Math.random(), dir: Math.random() < 0.5 ? -1 : 1 };
    this.active = a;
    if (kind !== 'skull') {
      this.video.src = kind;
      this.video.muted = true;
      this.video.currentTime = 0;
      this.video.play().catch(() => this.finish());
      this.videoTex = new THREE.VideoTexture(this.video);
      this.post.uniforms.tScene.value = this.videoTex;
      a.duration = 4;
    } else {
      this.post.uniforms.tScene.value = this.target.texture;
    }
    a.src = this.scream(a.duration);
    requestAnimationFrame((t) => this.frame(t));
  }

  finish() {
    const a = this.active;
    this.active = null;
    try { a?.src?.stop(); } catch { /* already stopped */ }
    this.video.pause();
    this.videoTex?.dispose();
    this.videoTex = null;
    document.body.classList.remove('scaring');
  }

  frame(now) {
    const a = this.active;
    if (!a) return;
    const t = (now - a.start) / 1000;
    if (t >= a.duration) { this.finish(); return; }
    requestAnimationFrame((n) => this.frame(n));
    const u = this.post.uniforms;
    u.time.value = t;
    u.hue.value = a.hue + t * 0.6;

    if (a.kind !== 'skull') {
      const end = t > a.duration - 0.35;
      u.noise.value = t < 0.12 || end ? 1 : 0.15 + 0.2 * Math.random();
      u.rgb.value = 0.006 + 0.01 * Math.random();
      u.tear.value = 0.08;
      u.invert.value = Math.random() < 0.06 ? 1 : 0;
      u.warp.value = 0.2;
      u.roll.value = Math.random() < 0.05 ? Math.random() : 0;
      u.flash.value = 0;
      u.blackout.value = t > a.duration - 0.12 ? 1 : 0;
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.postScene, this.postCamera);
      return;
    }

    const sk = this.skull;
    let jawOpen = 0, eyes = 0, shake = 0;
    // Defaults; phases override.
    let noise = 0.2, rgb = 0.004, tear = 0.03, invert = 0, warp = 0.1, roll = 0, flash = 0, blackout = 0;
    sk.visible = true;

    if (t < 0.04) {
      // One frame of static before it hits.
      noise = 1;
      sk.visible = false;
    } else {
      // From about a quarter of the screen to filling it, accelerating so it seems to fly at the
      // glass, then holding in your face for the last 0.15 s.
      const p = Math.min(1, (t - 0.04) / (DURATION - 0.19));
      const e = p * p;
      sk.position.set(rnd(0.02 + 0.06 * p), rnd(0.02 + 0.05 * p), -1.2 + e * 3.55);
      sk.rotation.set(-0.15 * (1 - p) + rnd(0.08 * p), a.dir * 0.3 * (1 - p), rnd(0.1 * p));
      jawOpen = 0.15 + 0.6 * Math.min(1, p * 1.4) + 0.05 * Math.sin(t * 90);
      eyes = 1 + 1.6 * p;
      noise = 0.2 + 0.3 * p + (Math.random() < 0.15 ? 0.35 : 0);
      rgb = 0.006 + 0.03 * p;
      tear = 0.04 + 0.2 * p;
      warp = 0.1 + 0.4 * p;
      invert = p > 0.6 && Math.random() < 0.3 ? 1 : 0;
      flash = p > 0.8 && Math.random() < 0.4 ? 0.45 : 0;
      roll = p > 0.7 && Math.random() < 0.2 ? rnd(0.08) : 0;
    }

    if (shake) sk.position.add(new THREE.Vector3(rnd(shake), rnd(shake), 0));
    this.jaw.rotation.x = jawOpen;
    for (const e of this.eyes) e.scale.setScalar(Math.max(0.01, eyes * (0.85 + 0.3 * Math.random())));
    u.noise.value = noise; u.rgb.value = rgb; u.tear.value = tear; u.invert.value = invert;
    u.warp.value = warp; u.roll.value = roll; u.flash.value = flash; u.blackout.value = blackout;

    this.renderer.setRenderTarget(this.target);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.postScene, this.postCamera);
  }
}
