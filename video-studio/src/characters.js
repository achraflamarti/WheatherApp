// The cast. Two character types built from primitives:
//   "human": a low-poly person in a suit
//   "buddy": a blocky little creature with bar eyes
// Every pose is computed from t: blinks come from a seeded schedule, mouths
// follow the voice loudness, moods and gestures blend in and out around
// the lines in the script.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { STAGE } from './set.js';
import { latestLine, voiceLevel } from './timeline.js';
import { clamp, hash01, hashString, lerp, mulberry32, noise1, smoothstep } from './util.js';

const HUMAN_MOODS = {
  neutral: { brow: 0, browTilt: 0, asym: 0, eye: 1, smile: 0, open: 0, tilt: 0 },
  curious: { brow: 0.014, browTilt: -0.12, eye: 1.08, smile: 0.15, tilt: 0.07 },
  skeptical: { brow: 0.004, browTilt: 0.16, asym: 1, eye: 0.86, smile: -0.25, tilt: -0.05 },
  surprised: { brow: 0.024, browTilt: -0.1, eye: 1.22, open: 0.35 },
  happy: { brow: 0.01, browTilt: -0.05, eye: 0.8, smile: 1, open: 0.05, tilt: 0.04 },
  serious: { brow: -0.006, browTilt: 0.26, eye: 0.92, smile: -0.1 },
  thinking: { brow: 0.008, browTilt: -0.08, asym: 0.6, eye: 0.88, tilt: 0.09 },
  sad: { brow: 0.006, browTilt: -0.3, eye: 0.85, smile: -0.5, tilt: -0.06 },
};

const BUDDY_MOODS = {
  neutral: { eyeH: 1, eyeTilt: 0, bounce: 0 },
  happy: { eyeH: 0.6, bounce: 1 },
  calm: { eyeH: 0.13 }, // eyes closed to thin lines
  serious: { eyeH: 0.9, eyeTilt: -0.3 },
  surprised: { eyeH: 1.3, bounce: 0.5 },
  curious: { eyeH: 1.08, eyeTilt: 0.12 },
  skeptical: { eyeH: 0.72, eyeTilt: -0.12 },
  thinking: { eyeH: 0.85, eyeTilt: 0.1 },
  sad: { eyeH: 0.8, eyeTilt: 0.3 },
};

const mat = (color, extra = {}) =>
  new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.78, metalness: 0, ...extra });

// Nudge vertices in or out so round shapes look hand-cut. Vertices that share
// a position move together, so faces never crack apart.
function facet(geo, amount, seed) {
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const key = `${Math.round(v.x * 1000)},${Math.round(v.y * 1000)},${Math.round(v.z * 1000)}`;
    const k = 1 + (hash01(hashString(key), seed) - 0.5) * amount;
    pos.setXYZ(i, v.x * k, v.y * k, v.z * k);
  }
  geo.computeVertexNormals();
  return geo;
}

function add(parent, mesh, x = 0, y = 0, z = 0) {
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function shape(points) {
  const s = new THREE.Shape();
  points.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
  s.closePath();
  return new THREE.ShapeGeometry(s);
}

function blendMood(table, a, b, k) {
  const A = { ...table.neutral, ...(table[a] || {}) };
  const B = { ...table.neutral, ...(table[b] || {}) };
  const out = {};
  for (const key of Object.keys(table.neutral)) out[key] = lerp(A[key], B[key], k);
  return out;
}

// Mood of character `id` at t: the speaker uses the line's mood, everyone
// else the line's `listener` mood. Blends over ~0.35 s at each line start.
function moodAt(tl, id, t, table) {
  const lines = tl.lines;
  let i = -1;
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].start - 0.15 <= t) i = k;
    else break;
  }
  const of = (l) => (!l ? 'neutral' : l.who === id ? l.mood : l.listener || 'neutral');
  if (i < 0) return blendMood(table, of(lines[0]), of(lines[0]), 1);
  const k = smoothstep(lines[i].start - 0.15, lines[i].start + 0.2, t);
  return blendMood(table, of(lines[i - 1]), of(lines[i]), k);
}

// How much the character is "in" a line right now (0..1), which line, and how loud.
function speechAt(tl, id, t) {
  let talk = 0;
  let line = null;
  let level = 0;
  for (const l of tl.lines) {
    if (l.who !== id) continue;
    const k = smoothstep(l.start - 0.25, l.start + 0.15, t) * (1 - smoothstep(l.speechEnd - 0.05, l.speechEnd + 0.5, t));
    if (k > talk) {
      talk = k;
      line = l;
    }
    if (t >= l.start && t <= l.speechEnd) level = voiceLevel(tl, l, t);
  }
  return { talk, line, level };
}

function blinkSchedule(seed, duration) {
  const rnd = mulberry32(seed);
  const out = [];
  let t = 0.6 + rnd() * 1.8;
  while (t < duration + 5) {
    out.push(t);
    if (rnd() < 0.18) out.push(t + 0.3);
    t += 2.2 + rnd() * 3.4;
  }
  return out;
}

function blinkAt(times, t) {
  let b = 0;
  for (const bt of times) {
    const d = Math.abs(t - bt);
    if (d < 0.1) b = Math.max(b, 1 - d / 0.1);
  }
  return b;
}

// Who should character `id` look at right now?
function lookTarget(tl, id, t) {
  const line = latestLine(tl, t + 0.2) || tl.lines[0];
  if (line && line.who !== id) return line.who;
  for (let k = (line ? line.index : 0) - 1; k >= 0; k--) if (tl.lines[k].who !== id) return tl.lines[k].who;
  return tl.lines.find((l) => l.who !== id)?.who ?? tl.ids.find((x) => x !== id);
}

function yawToward(root, target) {
  let a = Math.atan2(target.x - root.position.x, target.z - root.position.z) - root.rotation.y;
  a = Math.atan2(Math.sin(a), Math.cos(a));
  return clamp(a, -0.8, 0.8);
}

// ---------------------------------------------------------------- human

function createHuman(def, id, tl) {
  const seed = hashString(id);
  const c = {
    skin: '#f1c39a',
    nose: '#e8a06c',
    hair: '#3b2820',
    suit: '#6c55d8',
    pants: '#5845b8',
    shirt: '#f4f1ff',
    tie: '#d9d4f2',
    shoes: '#efe3c8',
    ink: '#16101a',
    ...(def.colors || {}),
  };
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  for (const s of [-1, 1]) {
    add(root, new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.065, 0.19), mat(c.shoes)), s * 0.072, 0.0325, 0.025);
    add(body, new THREE.Mesh(new THREE.BoxGeometry(0.105, 0.17, 0.115), mat(c.pants)), s * 0.072, 0.145, 0);
  }

  const torsoGeo = new THREE.CylinderGeometry(0.25, 0.21, 0.36, 4, 1);
  torsoGeo.rotateY(Math.PI / 4);
  torsoGeo.scale(1, 1, 0.62);
  const torso = add(body, new THREE.Mesh(torsoGeo, mat(c.suit)), 0, 0.405, 0);
  const shirt = new THREE.Mesh(shape([[-0.078, 0.172], [0.078, 0.172], [0, -0.03]]), mat(c.shirt));
  add(torso, shirt, 0, 0, 0.113);
  const tie = new THREE.Mesh(
    shape([[-0.02, 0.168], [0.02, 0.168], [0.013, 0.13], [0.026, -0.04], [0, -0.085], [-0.026, -0.04], [-0.013, 0.13]]),
    mat(c.tie),
  );
  add(torso, tie, 0, 0, 0.116);

  const arms = {};
  for (const s of [-1, 1]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(s * 0.205, 0.555, 0);
    body.add(shoulder);
    add(shoulder, new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.19, 0.105), mat(c.suit)), 0, -0.085, 0);
    const elbow = new THREE.Group();
    elbow.position.y = -0.17;
    shoulder.add(elbow);
    add(elbow, new THREE.Mesh(new THREE.BoxGeometry(0.087, 0.16, 0.097), mat(c.suit)), 0, -0.07, 0);
    add(elbow, new THREE.Mesh(facet(new THREE.IcosahedronGeometry(0.052, 0), 0.2, seed + s), mat(c.skin)), 0, -0.168, 0);
    arms[s] = { shoulder, elbow };
  }

  const neck = new THREE.Group();
  neck.position.y = 0.585;
  body.add(neck);
  const head = new THREE.Group();
  head.position.y = 0.235;
  neck.add(head);
  const skull = add(head, new THREE.Mesh(facet(new THREE.IcosahedronGeometry(0.25, 1), 0.07, seed), mat(c.skin)));
  skull.scale.set(1.04, 0.95, 0.98);
  for (const s of [-1, 1]) add(head, new THREE.Mesh(facet(new THREE.IcosahedronGeometry(0.05, 0), 0.2, seed + 7), mat(c.skin)), s * 0.255, -0.01, -0.01);

  // face
  const ink = mat(c.ink, { roughness: 0.4 });
  const eyes = [-1, 1].map((s) => {
    const e = add(head, new THREE.Mesh(new THREE.SphereGeometry(0.032, 10, 8), ink), s * 0.085, 0.0, 0.226);
    e.scale.set(1, 1.15, 0.5);
    return e;
  });
  const brows = [-1, 1].map((s) => {
    const b = add(head, new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.017, 0.012), ink), s * 0.09, 0.075, 0.221);
    b.rotation.x = -0.33;
    return b;
  });
  const noseGeo = new THREE.ConeGeometry(0.03, 0.075, 3);
  noseGeo.rotateX(Math.PI / 2);
  const nose = add(head, new THREE.Mesh(noseGeo, mat(c.nose)), 0, -0.035, 0.26);
  nose.rotation.x = 0.25;
  const mouth = new THREE.Group();
  mouth.position.set(0, -0.112, 0.213);
  mouth.rotation.x = 0.45;
  head.add(mouth);
  const mouthMid = add(mouth, new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.016, 0.01), ink));
  const corners = [-1, 1].map((s) => {
    const pivot = new THREE.Group();
    pivot.position.x = s * 0.035;
    mouth.add(pivot);
    add(pivot, new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.016, 0.01), ink), s * 0.011, 0, 0);
    return pivot;
  });

  // hair: a tilted dome plus a few spikes
  const hairMat = mat(c.hair, { roughness: 0.9 });
  const dome = add(
    head,
    new THREE.Mesh(facet(new THREE.SphereGeometry(0.272, 9, 6, 0, Math.PI * 2, 0, Math.PI * 0.55), 0.09, seed + 3), hairMat),
    0,
    0.025,
    -0.012,
  );
  dome.scale.set(1.06, 1.0, 1.05);
  dome.rotation.x = -0.45;
  const rnd = mulberry32(seed + 11);
  const spikes = [
    [-0.13, 0.17, 0.15, 1.0],
    [-0.05, 0.2, 0.16, 1.1],
    [0.04, 0.2, 0.16, 1.05],
    [0.12, 0.17, 0.14, 0.95],
    [-0.02, 0.27, 0.02, -0.15],
    [0.07, 0.25, -0.06, -0.35],
  ];
  for (const [x, y, z, rx] of spikes) {
    const spike = add(head, new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.15, 4), hairMat), x, y, z);
    spike.rotation.set(rx, rnd() * 0.6, (rnd() - 0.5) * 0.5);
  }
  // fringe: short tufts hanging over the forehead so it reads as hair, not a helmet
  for (const [x, rz] of [[-0.14, 0.5], [-0.07, 0.25], [0.0, -0.1], [0.08, -0.3], [0.15, -0.55]]) {
    const tuft = add(head, new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.11, 4), hairMat), x, 0.13, 0.2);
    tuft.rotation.set(Math.PI - 0.55, rnd() * 0.5, rz);
  }

  const blinks = blinkSchedule(seed, tl.duration);
  const rest = { sx: -0.08, sz: 0.1, ex: -0.22 };

  function update(t, ctx) {
    const { tl: timeline, camPos, anchors } = ctx;
    const sp = speechAt(timeline, id, t);
    const mood = moodAt(timeline, id, t, HUMAN_MOODS);
    const blink = blinkAt(blinks, t);
    const talk = sp.talk;
    const level = sp.level;

    // breathing and weight shifts
    const breath = Math.sin((t * Math.PI * 2) / 3.4 + seed);
    torso.scale.set(1 + 0.008 * breath, 1 + 0.012 * breath, 1);
    body.position.y = 0.003 * breath;
    body.rotation.z = 0.025 * noise1(t * 0.35, seed);

    // head: look at whoever matters, cheat toward the camera while talking
    const other = anchors[lookTarget(timeline, id, t)];
    let yaw = other ? yawToward(root, other.head) : 0;
    if (camPos) yaw = lerp(yaw, yawToward(root, camPos), 0.35 * talk);
    neck.rotation.y = yaw * 0.8 + 0.06 * noise1(t * 0.5, seed + 3);
    neck.rotation.x = -0.03 + 0.04 * level * Math.sin(t * 7.0) * talk + 0.03 * noise1(t * 0.6, seed + 4);
    neck.rotation.z = mood.tilt + 0.02 * noise1(t * 0.4, seed + 5);

    // face
    for (const e of eyes) e.scale.y = 1.15 * mood.eye * (1 - 0.9 * blink);
    brows.forEach((b, i) => {
      const s = i ? 1 : -1;
      b.position.y = 0.075 + mood.brow + (s > 0 ? mood.asym * 0.012 : -mood.asym * 0.004) + 0.006 * level * talk;
      b.rotation.z = s * mood.browTilt;
    });
    // closed: a line (corners curl up for a smile); open: a dark square-ish mouth
    const open = Math.max(mood.open, level * 0.95 * talk);
    mouthMid.scale.y = 1 + 3.4 * open;
    mouthMid.scale.x = 1 - 0.18 * open;
    corners.forEach((p, i) => {
      const s = i ? 1 : -1;
      p.rotation.z = s * 0.55 * mood.smile;
      p.scale.x = 1 - 0.85 * open;
    });

    // arms
    const gesture = sp.line?.gesture ?? (sp.line ? defaultHumanGesture(sp.line) : 'none');
    const beat = level * (0.5 + 0.5 * Math.sin(t * 5.5));
    for (const s of [-1, 1]) {
      const a = arms[s];
      let pose = { sx: rest.sx + 0.03 * noise1(t * 0.4, seed + s), sz: rest.sz, ex: rest.ex, ez: 0 };
      if (gesture === 'shrug') pose = { sx: -0.35, sz: 0.75, ex: -1.35, ez: 0 };
      else if (s === 1 && gesture === 'talk') pose = { sx: -0.55 - 0.15 * beat, sz: 0.28, ex: -1.25 - 0.22 * beat, ez: 0 };
      else if (s === 1 && gesture === 'point') pose = { sx: -1.35 - 0.06 * beat, sz: 0.3, ex: -0.55, ez: 0 };
      else if (s === 1 && gesture === 'wave') pose = { sx: -0.2, sz: 2.4, ex: -0.3, ez: 0.45 * Math.sin(t * 11) };
      const g = gesture === 'none' ? 0 : talk;
      a.shoulder.rotation.x = lerp(rest.sx, pose.sx, g);
      a.shoulder.rotation.z = s * lerp(rest.sz, pose.sz, g);
      a.elbow.rotation.x = lerp(rest.ex, pose.ex, g);
      a.elbow.rotation.z = s * pose.ez * g;
    }
    if (gesture === 'shrug') neck.position.y = 0.585 - 0.012 * talk;
    else neck.position.y = 0.585;
  }

  return {
    kind: 'human',
    root,
    update,
    headLocal: new THREE.Vector3(0, 0.82, 0),
    framing: { close: 2.3, closeAim: 0.11, closeLift: 0.04, low: 2.4, lowAim: 0.16 },
  };
}

function defaultHumanGesture(line) {
  const words = line.text.split(/\s+/).length;
  if (words < 4) return 'none';
  if (line.text.trim().endsWith('?')) return line.seed % 3 === 0 ? 'shrug' : 'talk';
  return 'talk';
}

// ---------------------------------------------------------------- buddy

function createBuddy(def, id, tl) {
  const seed = hashString(id);
  const c = { body: '#ea6a3f', eyes: '#140a0c', ...(def.colors || {}) };
  const root = new THREE.Group();
  const bodyMat = mat(c.body, { flatShading: false, roughness: 0.62 });
  const legs = [-0.21, -0.07, 0.07, 0.21].map((x) =>
    add(root, new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.2, 0.075), bodyMat), x, 0.1, 0.05),
  );
  const body = new THREE.Group();
  body.position.y = 0.19;
  root.add(body);
  add(body, new THREE.Mesh(new RoundedBoxGeometry(0.64, 0.5, 0.46, 2, 0.014), bodyMat), 0, 0.25, 0);
  const eyeMat = mat(c.eyes, { roughness: 0.35 });
  const eyes = [-1, 1].map((s) => add(body, new THREE.Mesh(new THREE.BoxGeometry(0.056, 0.125, 0.02), eyeMat), s * 0.125, 0.28, 0.232));
  const arms = [-1, 1].map((s) => {
    const pivot = new THREE.Group();
    pivot.position.set(s * 0.32, 0.23, 0.02);
    body.add(pivot);
    add(pivot, new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.075, 0.12), bodyMat), s * 0.05, 0, 0);
    return pivot;
  });

  const blinks = blinkSchedule(seed, tl.duration);

  function update(t, ctx) {
    const { tl: timeline, camPos, anchors } = ctx;
    const sp = speechAt(timeline, id, t);
    const mood = moodAt(timeline, id, t, BUDDY_MOODS);
    const talk = sp.talk;
    const level = sp.level;
    // extra blink right before speaking, like taking a breath
    const pre = sp.line ? Math.max(0, 1 - Math.abs(t - (sp.line.start - 0.12)) / 0.09) : 0;
    const blink = Math.max(blinkAt(blinks, t), pre);
    const gesture = sp.line?.gesture ?? 'talk';

    const other = anchors[lookTarget(timeline, id, t)];
    let yaw = other ? yawToward(root, other.head) : 0;
    if (camPos) yaw = lerp(yaw, yawToward(root, camPos), 0.4 * talk);

    const idle = Math.sin((t * Math.PI * 2) / 2.6 + seed);
    const hop = gesture === 'hop' && sp.line ? Math.max(0, Math.sin(clamp((t - sp.line.start) / 0.45) * Math.PI)) * 0.08 : 0;
    const happyBounce = mood.bounce * talk * Math.abs(Math.sin(t * 6.2)) * 0.02;
    body.position.y = 0.19 + 0.004 * idle + 0.014 * level * talk + hop + happyBounce;
    body.scale.set(1 - 0.02 * level * talk, 1 + 0.045 * level * talk + 0.006 * idle, 1);
    body.rotation.y = yaw * 0.55 + 0.04 * noise1(t * 0.3, seed);
    body.rotation.z = 0.03 * noise1(t * 0.4, seed + 1) + 0.03 * talk * Math.sin(t * 4.2);
    body.rotation.x = 0.05 * talk;

    eyes.forEach((e, i) => {
      const s = i ? 1 : -1;
      e.scale.y = mood.eyeH * (1 - 0.88 * blink);
      e.rotation.z = s * mood.eyeTilt;
    });

    arms.forEach((a, i) => {
      const s = i ? 1 : -1;
      let r = 0.12 + 0.05 * idle;
      if (gesture === 'wave' && s === -1) r = lerp(r, 1.9 + 0.35 * Math.sin(t * 12), talk);
      else if (gesture !== 'none') r += talk * (0.1 + 0.22 * level * (0.5 + 0.5 * Math.sin(t * 8 + s)));
      a.rotation.z = s * r;
    });

    legs.forEach((leg, i) => {
      leg.position.y = 0.1 + 0.012 * Math.max(0, Math.sin(t * 5 + i * 1.7)) * talk;
    });
  }

  return {
    kind: 'buddy',
    root,
    update,
    headLocal: new THREE.Vector3(0, 0.46, 0),
    framing: { close: 3.1, closeAim: 0.17, closeLift: 0.08, low: 2.9, lowAim: 0.2 },
  };
}

// ---------------------------------------------------------------- cast

export function createCast(scene, tl) {
  const ids = tl.ids;
  const n = ids.length;
  const spacing = n <= 2 ? 1.9 : 1.45;
  const chars = {};
  ids.forEach((id, i) => {
    const def = tl.characters[id];
    const x = (i - (n - 1) / 2) * spacing + (def.offset?.[0] || 0);
    const ch = def.type === 'buddy' ? createBuddy(def, id, tl) : createHuman(def, id, tl);
    ch.root.position.set(x, STAGE.keyTop, STAGE.markZ + (def.offset?.[1] || 0));
    ch.root.rotation.y = def.facing ?? (Math.abs(x) < 0.01 ? 0 : -Math.sign(x) * 0.55);
    scene.add(ch.root);
    chars[id] = ch;
  });

  // rest-pose head positions, used to frame shots
  const anchors = {};
  for (const [id, ch] of Object.entries(chars)) {
    ch.root.updateMatrixWorld(true);
    anchors[id] = { kind: ch.kind, head: ch.root.localToWorld(ch.headLocal.clone()), ...ch.framing };
  }

  function update(t, camPos) {
    for (const [id, ch] of Object.entries(chars)) ch.update(t, { tl, id, camPos, anchors });
  }

  return { chars, anchors, update };
}
