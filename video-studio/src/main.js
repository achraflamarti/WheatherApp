// Entry point. Builds the scene from a script and exposes
//
//   window.studio.renderFrame(t)   draw the frame at t seconds
//
// render.mjs calls it for frame 0, 1, 2, ... and saves each one. Opened in a
// normal browser (npm run dev) the page instead shows a small player, which
// only *chooses* t from the wall clock; renderFrame itself never reads it.

import * as THREE from 'three';
import { cameraAt } from './camera.js';
import { drawCaption } from './captions.js';
import { createCast } from './characters.js';
import { createPost } from './post.js';
import { createSet } from './set.js';
import { buildTimeline, captionAt, shotAt } from './timeline.js';

const params = new URLSearchParams(location.search);
const renderMode = params.has('render');

async function fetchJSON(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function loadFonts() {
  const faces = ['400 32px Inter', '500 32px Inter', '600 32px Inter', '700 32px Inter', '500 32px "JetBrains Mono"', '700 32px "JetBrains Mono"'];
  await Promise.all(faces.map((f) => document.fonts.load(f)));
}

async function boot() {
  const scriptUrl = params.get('script') || 'videos/demo.json';
  const name = scriptUrl.split('/').pop().replace(/\.json$/, '');
  const script = await fetchJSON(scriptUrl);
  const timingUrl = params.get('timing') || `out/${name}/timing.json`;
  const timing = await fetchJSON(timingUrl).catch(() => ({}));
  const tl = buildTimeline(script, timing);
  const scale = Number(params.get('scale') || (renderMode ? 1 : 0.5));
  const W = Math.round((tl.width * scale) / 2) * 2;
  const H = Math.round((tl.height * scale) / 2) * 2;
  await loadFonts();

  const glCanvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const set = createSet(scene, tl);
  const cast = createCast(scene, tl);
  const camera = new THREE.PerspectiveCamera(35, W / H, 0.05, 80);
  const look = { ...(script.look || {}) };
  if (params.get('debug') === 'dof') look.debugView = true; // red = blur amount, blue = distance
  const post = createPost(renderer, W, H, look);
  const stage = { anchors: cast.anchors, panelWorld: set.panelWorld, displayWorld: set.displayWorld };

  const out = document.getElementById('out');
  out.width = W;
  out.height = H;
  const ctx = out.getContext('2d');

  function renderFrame(t) {
    const shot = shotAt(tl, t);
    const cam = cameraAt(shot, t, stage);
    camera.fov = cam.fov;
    camera.updateProjectionMatrix();
    camera.position.copy(cam.pos);
    camera.up.set(0, 1, 0);
    camera.lookAt(cam.target);
    if (cam.roll) camera.rotateZ(cam.roll);
    camera.updateMatrixWorld(true);

    set.update(t);
    cast.update(t, camera.position);
    post.render(scene, camera, { dof: cam.dof, frame: Math.round(t * tl.fps) });

    ctx.drawImage(glCanvas, 0, 0);
    drawCaption(ctx, captionAt(tl, t), t, W, H, tl.captionStyle);
    return shot.type;
  }

  window.studio = {
    info: { name, fps: tl.fps, width: W, height: H, duration: tl.duration, frames: tl.frames },
    timeline: tl,
    renderFrame,
    capture(t, type = 'image/png', quality) {
      renderFrame(t);
      return out.toDataURL(type, quality);
    },
  };

  if (!renderMode) startPlayer(tl, renderFrame, name);
  return window.studio.info;
}

function startPlayer(tl, renderFrame, name) {
  document.body.classList.add('player');
  const bar = document.getElementById('bar');
  const play = document.getElementById('play');
  const scrub = document.getElementById('scrub');
  const label = document.getElementById('time');
  const audio = new Audio(`out/${name}/audio.wav`);
  bar.hidden = false;
  let playing = false;
  let t = 0;
  let origin = 0;

  const show = (time) => {
    t = Math.min(time, tl.duration);
    const shot = renderFrame(t);
    scrub.value = String(Math.round((t / tl.duration) * 1000));
    label.textContent = `${t.toFixed(2)}s · frame ${Math.round(t * tl.fps)} · ${shot}`;
  };
  const toggle = () => {
    playing = !playing;
    play.textContent = playing ? 'Pause' : 'Play';
    if (playing) {
      if (t >= tl.duration - 0.05) t = 0;
      origin = performance.now() - t * 1000;
      audio.currentTime = t;
      audio.play().catch(() => {});
    } else audio.pause();
  };
  play.onclick = toggle;
  scrub.oninput = () => {
    if (playing) toggle();
    show((Number(scrub.value) / 1000) * tl.duration);
  };
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      toggle();
    }
  });
  const tick = (now) => {
    if (playing) {
      const next = (now - origin) / 1000;
      if (next >= tl.duration) toggle();
      show(Math.min(next, tl.duration));
    }
    requestAnimationFrame(tick);
  };
  show(0);
  requestAnimationFrame(tick);
}

window.studioReady = boot().catch((err) => {
  document.body.insertAdjacentHTML('beforeend', `<pre style="color:#f88;padding:16px">${err.stack || err}</pre>`);
  throw err;
});
