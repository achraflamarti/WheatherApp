// Camera shots. Each shot type is a small recipe: where the camera sits,
// what it looks at, the lens (fov) and the focus. During a shot the camera
// creeps in slowly and drifts like it is hand-held; the drift is seeded
// noise, so it is identical on every render.

import * as THREE from 'three';
import { clamp, lerp, noise1 } from './util.js';

const v = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

export function cameraAt(shot, t, stage) {
  const k = clamp((t - shot.start) / Math.max(0.001, shot.end - shot.start));
  const s = shot.seed >>> 0;
  const side = s & 1 ? 1 : -1;
  const A = stage.anchors[shot.subject] || Object.values(stage.anchors)[0];
  const B = stage.anchors[shot.other] || A;
  const heads = Object.values(stage.anchors).map((a) => a.head);
  const mid = heads.reduce((acc, h) => acc.add(h), v()).multiplyScalar(1 / heads.length);
  let pos;
  let target;
  let fov;
  let focus;
  let strength;
  let roll = 0;

  switch (shot.type) {
    case 'close': {
      // in front of the subject, swung a little toward the person they talk to
      const H = A.head;
      const toB = B.head.clone().sub(H).setY(0);
      if (toB.lengthSq() < 1e-6) toB.set(side, 0, 0);
      toB.normalize();
      const dir = v(0, 0, 0.85).addScaledVector(toB, 0.5).normalize();
      const dist = lerp(A.close, A.close * 0.9, k);
      pos = H.clone().addScaledVector(dir, dist);
      pos.y += A.closeLift;
      target = H.clone();
      target.y += A.closeAim;
      fov = 28;
      focus = dist;
      strength = 34;
      roll = A.kind === 'buddy' ? side * 0.035 : 0;
      break;
    }
    case 'low': {
      // down on the keyboard looking up at the speaker; blurry keys in front,
      // the glowing screen behind
      const H = A.head;
      const toB = B.head.clone().sub(H).setY(0);
      if (toB.lengthSq() < 1e-6) toB.set(side, 0, 0);
      toB.normalize();
      const dir = v(0, 0, 0.9).addScaledVector(toB, -0.35).normalize();
      pos = H.clone().addScaledVector(dir, lerp(A.low, A.low * 0.92, k));
      pos.y = 0.2;
      target = H.clone();
      target.y += A.lowAim;
      fov = 32;
      focus = pos.distanceTo(H);
      strength = 30;
      break;
    }
    case 'two': {
      // three-quarter view from the listener's side: the listener soft at the
      // frame edge, the speaker in focus behind them (a vertical frame is too
      // narrow to fit both side by side up close)
      const S = A.head;
      const L = B.head;
      const u = L.clone().sub(S).setY(0);
      if (u.lengthSq() < 1e-6) u.set(side, 0, 0);
      u.normalize();
      const m = S.clone().add(L).multiplyScalar(0.5);
      m.y = Math.min(S.y, L.y) - 0.05;
      const dir = v(0, 0, Math.cos(1.15)).addScaledVector(u, Math.sin(1.15)).normalize();
      pos = m.clone().addScaledVector(dir, lerp(3.7, 3.45, k));
      pos.y += 0.3;
      target = m.clone().addScaledVector(u, 0.05);
      target.y += 0.1;
      fov = 40;
      focus = pos.distanceTo(S);
      strength = 24;
      break;
    }
    case 'screen': {
      // the laptop screen fills the frame, the characters small at the bottom
      const P = shot.panel ? stage.panelWorld(shot.panel) : stage.displayWorld();
      pos = v(P.x * 0.9 + side * 0.25, 1.45, lerp(6.4, 5.9, k));
      target = v(P.x, 2.6, P.z);
      fov = 40;
      focus = pos.distanceTo(P);
      strength = 22;
      break;
    }
    case 'wide':
    default: {
      // pull back far enough to fit the whole cast across the narrow frame
      const reach = Math.max(...heads.map((h) => Math.abs(h.x))) + 0.5;
      const back = Math.max(7.1, reach / (0.5625 * Math.tan((20 * Math.PI) / 180)));
      pos = v(side * 0.2, 1.05, back + lerp(0.5, 0, k));
      target = v(0, 1.85, -1.4);
      fov = 40;
      focus = pos.distanceTo(mid);
      strength = 16;
    }
  }

  // hand-held drift
  pos.x += 0.012 * noise1(t * 0.35, s);
  pos.y += 0.008 * noise1(t * 0.31, s + 7);
  target.x += 0.006 * noise1(t * 0.27, s + 13);
  target.y += 0.006 * noise1(t * 0.29, s + 17);

  return { pos, target, fov, roll, dof: { focus, strength } };
}
