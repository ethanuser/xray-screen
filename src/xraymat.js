// Radiograph-style material: surfaces seen edge-on glow brighter, everything adds up like film.
// Black and white only.
import * as THREE from 'three';

const vert = /* glsl */ `
  varying vec3 vN;
  varying vec3 vV;
  varying float vDepth;
  uniform bool ortho;
  void main() {
    vec4 p = vec4(position, 1.0);
    vec3 n = normal;
    #ifdef USE_INSTANCING
      p = instanceMatrix * p;
      n = mat3(instanceMatrix) * n;
    #endif
    vDepth = -(modelMatrix * p).z;
    vec4 mv = modelViewMatrix * p;
    vN = normalize(normalMatrix * n);
    vV = ortho ? vec3(0.0, 0.0, 1.0) : normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const frag = /* glsl */ `
  uniform float base;
  uniform float rim;
  uniform float power;
  uniform float gain;
  uniform float depthFade;
  varying vec3 vN;
  varying vec3 vV;
  varying float vDepth;
  void main() {
    // Optionally fade deeper structures so the front stays readable (Mode 2 only).
    float atten = depthFade > 0.0 ? mix(1.0, 0.3, clamp(vDepth / depthFade, 0.0, 1.0)) : 1.0;
    float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), power);
    gl_FragColor = vec4(vec3((base + rim * f) * gain * atten), 1.0);
  }
`;

export function xrayMaterial({ base = 0.05, rim = 0.7, power = 2.2, ortho = false, depthFade = 0 } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      base: { value: base },
      rim: { value: rim },
      power: { value: power },
      gain: { value: 1 },
      ortho: { value: ortho },
      depthFade: { value: depthFade },
    },
    vertexShader: vert,
    fragmentShader: frag,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
  });
}

// Loads the BodyParts3D meshes (one per rigid bone group) and the rest-pose joint positions.
export async function loadAnatomy() {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const [gltf, rig] = await Promise.all([
    new GLTFLoader().loadAsync('models/anatomy.glb'),
    fetch('models/rig.json').then((r) => r.json()),
  ]);
  const parts = {};
  gltf.scene.traverse((o) => { if (o.isMesh) parts[o.name] = o.geometry; });
  return { parts, rig };
}
