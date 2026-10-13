// The set: two tiny characters standing on a laptop keyboard at night, with
// the laptop screen glowing behind them and a window full of city lights.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { SCREEN_H, SCREEN_W, drawScreen, panelDots, panelRect } from './screen.js';
import { mulberry32, noise1, smoothstep } from './util.js';

export const STAGE = {
  keyTop: 0.07, // characters stand at this height
  markZ: 0.33, // the key row they stand on
  hingeZ: -1.8,
  lidTilt: 0.13, // how far the lid leans back (radians)
  displayW: 8.2,
  displayH: 8.2 * (SCREEN_H / SCREEN_W),
  displayY: 2.92, // display centre, measured up the lid
};

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function softDot() {
  return canvasTexture(64, 64, (g) => {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.3, 'rgba(255,255,255,0.6)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  });
}

function nightWindow(seed) {
  const rnd = mulberry32(seed);
  return canvasTexture(2048, 1024, (g, W, H) => {
    const sky = g.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#020215');
    sky.addColorStop(0.55, '#070a3c');
    sky.addColorStop(1, '#1a124e');
    g.fillStyle = sky;
    g.fillRect(0, 0, W, H);
    for (let i = 0; i < 160; i++) {
      g.fillStyle = `rgba(200,210,255,${0.2 + rnd() * 0.5})`;
      g.beginPath();
      g.arc(rnd() * W, rnd() * H * 0.6, 0.8 + rnd() * 1.6, 0, Math.PI * 2);
      g.fill();
    }
    // city lights: they turn into soft bokeh once the lens blurs them
    for (let i = 0; i < 140; i++) {
      const x = rnd() * W;
      const y = H * (0.6 + rnd() * 0.38);
      const r = 3 + rnd() * 10;
      const warm = rnd() < 0.7;
      const rgb = warm ? `255,${Math.round(185 + rnd() * 45)},${Math.round(110 + rnd() * 50)}` : '150,170,255';
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, `rgba(${rgb},${0.55 + rnd() * 0.45})`);
      grad.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#030309';
    g.fillRect(W * 0.5 - 20, 0, 40, H);
    g.fillRect(0, H * 0.32 - 12, W, 24);
  });
}

function trackpadGlow() {
  return canvasTexture(512, 256, (g, W, H) => {
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    const grad = g.createRadialGradient(W / 2, H * 0.15, 10, W / 2, H * 0.15, W * 0.55);
    grad.addColorStop(0, 'rgba(190,165,255,0.9)');
    grad.addColorStop(0.5, 'rgba(120,90,230,0.35)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
  });
}

export function createSet(scene, tl) {
  RectAreaLightUniformsLib.init();
  const root = new THREE.Group();
  scene.add(root);
  scene.background = new THREE.Color('#05040b');

  const metal = new THREE.MeshStandardMaterial({ color: '#1a1828', roughness: 0.38, metalness: 0.6 });

  const desk = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 60),
    new THREE.MeshStandardMaterial({ color: '#0b0913', roughness: 0.85 }),
  );
  desk.rotation.x = -Math.PI / 2;
  desk.position.y = -0.3;
  desk.receiveShadow = true;
  root.add(desk);

  const base = new THREE.Mesh(new RoundedBoxGeometry(8.9, 0.3, 5.4, 3, 0.12), metal);
  base.position.set(0, -0.15, 0.82);
  base.receiveShadow = true;
  root.add(base);

  // keyboard backlight, visible through the gaps between keys
  const backlight = new THREE.Mesh(
    new THREE.PlaneGeometry(7.6, 2.95),
    new THREE.MeshBasicMaterial({ color: new THREE.Color('#5a36ff').multiplyScalar(0.42) }),
  );
  backlight.rotation.x = -Math.PI / 2;
  backlight.position.set(0, 0.003, -0.24);
  root.add(backlight);

  // keys: five staggered rows, the bottom one with a space bar
  const rows = [
    { z: -1.38, first: 0.5 },
    { z: -0.81, first: 0.78 },
    { z: -0.24, first: 0.92 },
    { z: STAGE.markZ, first: 1.2 },
    { z: 0.9, first: 0.5, space: 4 },
  ];
  const keys = [];
  const left = -3.72;
  const right = 3.72;
  for (const row of rows) {
    let x = left;
    for (let i = 0; x < right - 0.01; i++) {
      let w = i === 0 ? row.first : 0.5;
      if (row.space === i) w = 2.85;
      if (right - (x + w) < 0.57) w = right - x;
      keys.push({ x: x + w / 2, z: row.z, w });
      x += w + 0.07;
    }
  }
  const keyMesh = new THREE.InstancedMesh(
    new RoundedBoxGeometry(0.5, 0.1, 0.5, 2, 0.05),
    new THREE.MeshStandardMaterial({ color: '#221f30', roughness: 0.5, metalness: 0.15 }),
    keys.length,
  );
  const m = new THREE.Matrix4();
  keys.forEach((k, i) => {
    m.compose(new THREE.Vector3(k.x, 0.02, k.z), new THREE.Quaternion(), new THREE.Vector3(k.w / 0.5, 1, 1));
    keyMesh.setMatrixAt(i, m);
  });
  keyMesh.receiveShadow = true;
  keyMesh.castShadow = true;
  root.add(keyMesh);

  const pad = new THREE.Mesh(
    new RoundedBoxGeometry(3.6, 0.02, 1.3, 2, 0.01),
    new THREE.MeshStandardMaterial({
      color: '#1c192a',
      roughness: 0.25,
      metalness: 0.4,
      emissive: '#ffffff',
      emissiveMap: trackpadGlow(),
      emissiveIntensity: 0.8,
    }),
  );
  pad.position.set(0, 0.0, 2.3);
  root.add(pad);

  // lid + display
  const lid = new THREE.Group();
  lid.position.set(0, 0, STAGE.hingeZ);
  lid.rotation.x = -STAGE.lidTilt;
  root.add(lid);
  const shell = new THREE.Mesh(new RoundedBoxGeometry(8.9, 5.95, 0.16, 3, 0.07), metal);
  shell.position.set(0, 2.98, -0.09);
  lid.add(shell);
  const bezel = new THREE.Mesh(
    new THREE.PlaneGeometry(8.78, 5.84),
    new THREE.MeshStandardMaterial({ color: '#040309', roughness: 0.25, metalness: 0.2 }),
  );
  bezel.position.set(0, 2.98, 0.001);
  lid.add(bezel);

  const screenCanvas = document.createElement('canvas');
  screenCanvas.width = SCREEN_W;
  screenCanvas.height = SCREEN_H;
  // A CPU-backed canvas uploads fast; we skip GPU mipmaps (slow in software)
  // and instead average several taps across each pixel in the shader below.
  const screenCtx = screenCanvas.getContext('2d', { willReadFrequently: true });
  const screenTex = new THREE.CanvasTexture(screenCanvas);
  screenTex.colorSpace = THREE.SRGBColorSpace;
  screenTex.generateMipmaps = false;
  screenTex.minFilter = THREE.LinearFilter;
  const display = new THREE.Mesh(
    new THREE.PlaneGeometry(STAGE.displayW, STAGE.displayH),
    new THREE.ShaderMaterial({
      uniforms: { map: { value: screenTex }, gain: { value: 1.12 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        uniform float gain;
        varying vec2 vUv;
        void main() {
          vec2 dx = dFdx(vUv) / 3.0;
          vec2 dy = dFdy(vUv) / 3.0;
          vec3 c = vec3(0.0);
          for (int i = -1; i <= 1; i++)
            for (int j = -1; j <= 1; j++) c += texture2D(map, vUv + dx * float(i) + dy * float(j)).rgb;
          gl_FragColor = vec4(c / 9.0 * gain, 1.0);
        }`,
    }),
  );
  display.position.set(0, STAGE.displayY, 0.004);
  lid.add(display);

  // canvas px -> lid-local position on the display
  const toLid = (px, py, z = 0.004) =>
    new THREE.Vector3(
      (px / SCREEN_W - 0.5) * STAGE.displayW,
      STAGE.displayY + (0.5 - py / SCREEN_H) * STAGE.displayH,
      z,
    );

  // HDR status/record dots so they bloom like real LEDs
  const panels = tl.screen.panels || [];
  const dotGeo = new THREE.CircleGeometry(1, 24);
  const green = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.25, 1.0, 0.5).multiplyScalar(1.8) });
  const red = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.25, 0.28).multiplyScalar(2.2) });
  panels.slice(0, 6).forEach((p, i) => {
    const d = panelDots(i);
    for (const [spot, mat] of [
      [d.status, green],
      [d.record, red],
    ]) {
      const dot = new THREE.Mesh(dotGeo, mat);
      dot.position.copy(toLid(spot.x, spot.y, 0.007));
      dot.scale.setScalar((spot.r / SCREEN_W) * STAGE.displayW);
      lid.add(dot);
    }
  });

  // the screen lights the scene from behind
  const screenLight = new THREE.RectAreaLight('#7d84ff', 2.6, STAGE.displayW, STAGE.displayH);
  screenLight.position.set(0, STAGE.displayY, 0.06);
  screenLight.rotation.y = Math.PI; // area lights shine down their -z axis
  lid.add(screenLight);

  // window behind the laptop
  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(48, 24),
    new THREE.MeshBasicMaterial({ map: nightWindow(7), fog: false }),
  );
  backdrop.position.set(0, 7, -16);
  root.add(backdrop);

  // lights
  root.add(new THREE.HemisphereLight('#7a70d0', '#120d24', 0.85));
  const key = new THREE.SpotLight('#ffb06a', 30, 14, 0.55, 0.9, 1.6);
  key.position.set(-2.9, 2.1, 2.4);
  key.target.position.set(-0.55, 0.62, STAGE.markZ);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0003;
  key.shadow.normalBias = 0.015;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 12;
  root.add(key, key.target);
  // soft warm fill from the right so orange stays orange
  const fill = new THREE.SpotLight('#ffcfa8', 9, 12, 0.6, 1, 1.6);
  fill.position.set(2.6, 1.6, 2.6);
  fill.target.position.set(0.7, 0.5, STAGE.markZ);
  root.add(fill, fill.target);
  const under = new THREE.PointLight('#9466ff', 5.5, 6, 1.8);
  under.position.set(0, 0.32, 2.1);
  root.add(under);

  // drifting dust
  const N = 220;
  const rnd = mulberry32(99);
  const motes = Array.from({ length: N }, () => ({
    x: rnd() * 7 - 3.5,
    y: rnd() * 4.4 + 0.1,
    z: rnd() * 5 - 1.5,
    vx: (rnd() - 0.5) * 0.05,
    vy: 0.02 + rnd() * 0.05,
    ph: rnd() * 100,
    warm: rnd() < 0.75,
    b: 0.3 + rnd() * 0.7,
  }));
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  dustGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  const dust = new THREE.Points(
    dustGeo,
    new THREE.PointsMaterial({
      size: 0.028,
      map: softDot(),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  dust.frustumCulled = false;
  root.add(dust);
  const wrap = (v, lo, hi) => lo + ((((v - lo) % (hi - lo)) + (hi - lo)) % (hi - lo));

  function update(t) {
    drawScreen(screenCtx, tl, t);
    screenTex.needsUpdate = true;

    const pos = dustGeo.attributes.position.array;
    const col = dustGeo.attributes.color.array;
    motes.forEach((s, i) => {
      const y = wrap(s.y + s.vy * t, 0.1, 4.5);
      pos[i * 3] = wrap(s.x + s.vx * t + 0.1 * noise1(t * 0.15 + s.ph, i), -3.5, 3.5);
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = s.z + 0.08 * noise1(t * 0.12 + s.ph * 2, i + 999);
      const k = s.b * smoothstep(0.1, 0.6, y) * smoothstep(4.5, 3.9, y) * (0.7 + 0.3 * Math.sin(t * 1.3 + s.ph)) * 1.5;
      col[i * 3] = (s.warm ? 1.0 : 0.72) * k;
      col[i * 3 + 1] = (s.warm ? 0.78 : 0.68) * k;
      col[i * 3 + 2] = (s.warm ? 0.52 : 1.0) * k;
    });
    dustGeo.attributes.position.needsUpdate = true;
    dustGeo.attributes.color.needsUpdate = true;
  }

  // World-space centre of a panel on the display (for the camera).
  function panelWorld(id) {
    const i = Math.max(0, panels.findIndex((p) => p.id === id));
    const r = panelRect(i);
    lid.updateMatrixWorld(true);
    return lid.localToWorld(toLid(r.x + r.w / 2, r.y + r.h / 2));
  }

  function displayWorld() {
    lid.updateMatrixWorld(true);
    return lid.localToWorld(toLid(SCREEN_W / 2, SCREEN_H / 2));
  }

  return { update, panelWorld, displayWorld };
}
