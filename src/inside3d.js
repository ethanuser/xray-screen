// Mode 2: a window into the wearer's chest.
// The screen is treated as a pane of glass lying on the wearer's skin. Real anatomy (BodyParts3D)
// sits at real size behind it, and the camera is placed at the viewer's eye with an off-axis
// frustum, so the view shifts with their head the way a real window does.
//
// Coordinates here: x = wearer's left (the viewer's right), y = up, z = toward the viewer.
// y = 0 is the bottom of the sternum; z = 0 is the skin / screen plane.
import * as THREE from 'three';
import { xrayMaterial } from './xraymat.js';

export class Inside3D {
  constructor(canvas, anatomy) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setClearColor(0x000000, 1);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera();
    this.body = new THREE.Group();
    this.scene.add(this.body);
    const fade = 0.22;
    this.mats = {
      bone: xrayMaterial({ base: 0.04, rim: 0.75, power: 2.2, depthFade: fade }),
      lung: xrayMaterial({ base: 0.0, rim: 0.2, power: 2.5, depthFade: fade }),
      organ: xrayMaterial({ base: 0.01, rim: 0.3, power: 2.2, depthFade: fade }),
      heart: xrayMaterial({ base: 0.03, rim: 0.55, power: 1.8, depthFade: fade }),
      rice: xrayMaterial({ base: 0.16, rim: 0.4, power: 1.5 }),
    };
    this.build(anatomy.parts);
    this.eye = new THREE.Vector3(0, 0, 0.45);
    this.resize();
  }

  // ppi: CSS pixels per physical inch of this screen. chestY: which body height the screen centre sits at.
  configure({ ppi, chestY, scale }) {
    this.ppi = ppi;
    this.body.position.y = -chestY;
    this.body.scale.setScalar(scale);
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setSize(w, h, false);
    const ppi = this.ppi || 132;
    this.screenW = (w / ppi) * 0.0254;
    this.screenH = (h / ppi) * 0.0254;
  }

  build(parts) {
    // Rest frame (x left, y down, z back) -> this view (x left, y up, z toward the viewer).
    const flip = new THREE.Matrix4().makeScale(1, -1, -1);
    const geo = (name) => parts[name].clone().applyMatrix4(flip);

    const torso = geo('torso');
    torso.computeBoundingBox();
    const heartGeo = geo('heart');
    heartGeo.computeBoundingBox();
    const heartC = heartGeo.boundingBox.getCenter(new THREE.Vector3());
    // Anchor: the front of the ribcage just under the skin, the middle of the heart 5.5 cm above
    // the bottom of the sternum, and the body's midline at x = 0.
    const tb = torso.boundingBox;
    const offset = new THREE.Vector3(-(tb.min.x + tb.max.x) / 2, 0.055 - heartC.y, -0.012 - tb.max.z);
    const place = (g) => g.translate(offset.x, offset.y, offset.z);

    // A mesh that pulses about its own centre (heart beat, breathing).
    const centred = (g, mat) => {
      place(g);
      g.computeBoundingBox();
      const c = g.boundingBox.getCenter(new THREE.Vector3());
      g.translate(-c.x, -c.y, -c.z);
      const m = new THREE.Mesh(g, mat);
      m.position.copy(c);
      return m;
    };

    this.ribcage = new THREE.Mesh(place(torso), this.mats.bone);
    this.body.add(this.ribcage);
    this.body.add(new THREE.Mesh(place(geo('lumbar')), this.mats.bone));
    this.body.add(new THREE.Mesh(place(geo('neck')), this.mats.bone));
    this.lungs = [centred(geo('lungL'), this.mats.lung), centred(geo('lungR'), this.mats.lung)];
    this.body.add(...this.lungs);
    this.heart = centred(heartGeo, this.mats.heart);
    this.body.add(this.heart);
    this.body.add(new THREE.Mesh(place(geo('liver')), this.mats.lung));
    this.stomach = centred(geo('stomach'), this.mats.organ);
    this.body.add(this.stomach);

    // Today's meal: cooked instant brown rice, as stated on the box.
    const sb = this.stomach.geometry.boundingBox;
    const size = sb.getSize(new THREE.Vector3());
    const grains = 420;
    const rice = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 6), this.mats.rice, grains);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < grains; i++) {
      let p;
      do { p = new THREE.Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1); } while (p.lengthSq() > 1);
      // Settled in the lower half of the stomach.
      p.set(p.x * size.x * 0.3, -Math.abs(p.y) * size.y * 0.25 - size.y * 0.05, p.z * size.z * 0.25);
      e.set(rand() * 6.3, rand() * 6.3, rand() * 6.3);
      q.setFromEuler(e);
      m.compose(p, q, new THREE.Vector3(0.0028, 0.0011, 0.0011));
      rice.setMatrixAt(i, m);
    }
    this.stomach.add(rice);
    this.stomachY = this.stomach.position.y;
  }

  // eye: viewer's eye position in metres, relative to the screen centre, or null when nobody is looking.
  render(t, eye) {
    const sec = t / 1000;

    // Idle: drift the viewpoint slowly so the window still looks alive.
    const target = eye || new THREE.Vector3(0.07 * Math.sin(sec * 0.31), 0.035 * Math.sin(sec * 0.23), 0.45);
    this.eye.lerp(target, eye ? 0.35 : 0.04);

    // Breathing about 15 times a minute.
    const breath = 0.5 - 0.5 * Math.cos((2 * Math.PI * sec) / 4.0);
    for (const l of this.lungs) l.scale.set(1 + 0.05 * breath, 1 + 0.07 * breath, 1 + 0.05 * breath);
    this.ribcage.scale.set(1 + 0.012 * breath, 1, 1 + 0.015 * breath);
    this.stomach.position.y = this.stomachY - 0.004 * breath;

    // Heartbeat at 72 bpm, as a lub-dub double pulse.
    const phase = ((sec * 72) / 60) % 1;
    const pulse = Math.exp(-(((phase - 0.06) / 0.045) ** 2)) + 0.6 * Math.exp(-(((phase - 0.28) / 0.05) ** 2));
    this.heart.scale.setScalar(1 + 0.06 * pulse);
    this.mats.heart.uniforms.gain.value = 1 + 0.6 * pulse;

    // Off-axis frustum through the screen rectangle (z = 0), seen from the eye.
    const E = this.eye;
    const ez = Math.max(0.12, E.z);
    const n = 0.01, f = 3;
    const W = this.screenW, H = this.screenH;
    const l = ((-W / 2 - E.x) * n) / ez;
    const r = ((W / 2 - E.x) * n) / ez;
    const bt = ((-H / 2 - E.y) * n) / ez;
    const tp = ((H / 2 - E.y) * n) / ez;
    this.camera.position.set(E.x, E.y, ez);
    this.camera.quaternion.identity();
    this.camera.projectionMatrix.makePerspective(l, r, tp, bt, n, f);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();

    this.renderer.render(this.scene, this.camera);
  }
}
