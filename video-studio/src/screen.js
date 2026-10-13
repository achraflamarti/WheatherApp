// The laptop screen: a dashboard of agent panels drawn with the 2D canvas API.
// Like everything else it is a pure function of t. Lines from the script type
// themselves out at a fixed speed, status timers count up with t, and
// {frame}/{t} placeholders show the frame actually being rendered.

import { clockString } from './util.js';

export const SCREEN_W = 2560;
export const SCREEN_H = 1600;
const COLS = 3;
const ROWS = 2;
const MARGIN = 44;
const GAP = 40;
const TOP = 124;

export function panelRect(index) {
  const pw = (SCREEN_W - MARGIN * 2 - GAP * (COLS - 1)) / COLS;
  const ph = (SCREEN_H - TOP - MARGIN - GAP * (ROWS - 1)) / ROWS;
  const col = index % COLS;
  const row = Math.floor(index / COLS);
  return { x: MARGIN + col * (pw + GAP), y: TOP + row * (ph + GAP), w: pw, h: ph };
}

// Where the glowing dots sit (canvas px), so the 3D set can place HDR dots on them.
export function panelDots(index) {
  const r = panelRect(index);
  return {
    status: { x: r.x + 36, y: r.y + 52, r: 8 },
    record: { x: r.x + r.w - 26 - 46, y: r.y + r.h - 128 + 51, r: 18 },
  };
}

// Panel contents at time t.
export function panelsAt(tl, t) {
  const panels = (tl.screen.panels || []).slice(0, COLS * ROWS).map((p) => ({
    ...p,
    lines: [...(p.lines || [])],
    cursor: false,
  }));
  const byId = Object.fromEntries(panels.map((p) => [p.id, p]));
  let focus = null;
  for (const ev of tl.screenEvents) {
    if (ev.start > t) break;
    const p = byId[ev.panel];
    if (!p) continue;
    if (ev.bubble != null) p.bubble = ev.bubble;
    if (ev.clear) p.lines = [];
    let budget = Math.floor((t - ev.start) * ev.cps);
    let typing = false;
    for (const text of ev.type) {
      if (budget <= 0) break;
      const shown = text.slice(0, budget);
      p.lines.push(shown);
      if (shown.length < text.length) {
        typing = true;
        break;
      }
      budget -= text.length + 6; // short beat between lines
    }
    const doneAt = ev.start + (ev.type.join('').length + ev.type.length * 6) / ev.cps;
    for (const q of panels) q.cursor = false;
    p.cursor = typing || t < doneAt + 2.5;
    p.typing = typing;
    focus = p.id;
  }
  return { panels, focus };
}

function fill(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function dot(ctx, x, y, r, color) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

export function drawScreen(ctx, tl, t) {
  const { panels, focus } = panelsAt(tl, t);
  const frame = Math.round(t * tl.fps);
  const vars = {
    t: t.toFixed(2),
    frame: String(frame).padStart(4, '0'),
    frames: tl.frames,
    fps: tl.fps,
    time: clockString(t),
    width: tl.width,
    height: tl.height,
  };

  const bg = ctx.createLinearGradient(0, 0, 0, SCREEN_H);
  bg.addColorStop(0, '#0d0a20');
  bg.addColorStop(1, '#080614');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);

  // title bar
  roundRect(ctx, SCREEN_W / 2 - 560, 34, 1120, 62, 16);
  ctx.fillStyle = '#110e26';
  ctx.fill();
  ctx.strokeStyle = '#221e40';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.font = '500 28px Inter';
  ctx.fillStyle = '#8f8bb2';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(fill(tl.screen.title || 'Main canvas', vars), SCREEN_W / 2, 66);

  panels.forEach((p, i) => drawPanel(ctx, p, panelRect(i), vars, t, p.id === focus, tl));
}

function drawPanel(ctx, p, r, vars, t, focused, tl) {
  ctx.save();
  roundRect(ctx, r.x, r.y, r.w, r.h, 26);
  const g = ctx.createLinearGradient(0, r.y, 0, r.y + r.h);
  g.addColorStop(0, '#16132d');
  g.addColorStop(1, '#100e22');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = focused ? 3 : 2;
  ctx.strokeStyle = focused ? '#514a90' : '#26223f';
  ctx.stroke();
  ctx.clip();

  // header: status dot, agent name, menu
  const hx = r.x + 36;
  const hy = r.y + 52;
  dot(ctx, hx, hy, 8, '#43dc8c');
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '600 30px Inter';
  ctx.fillStyle = '#ece9fb';
  ctx.fillText(fill(p.title || p.id, vars), hx + 22, hy + 1);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#5a5680';
  ctx.fillText('···', r.x + r.w - 34, hy - 4);

  // the request bubble
  if (p.bubble) {
    ctx.font = '600 26px Inter';
    const text = fill(p.bubble, vars);
    const bw = Math.min(r.w - 120, ctx.measureText(text).width + 46);
    const bx = r.x + r.w - 34 - bw;
    const by = r.y + 96;
    roundRect(ctx, bx, by, bw, 52, 15);
    ctx.fillStyle = '#2b2749';
    ctx.fill();
    ctx.fillStyle = '#ece9fb';
    ctx.textAlign = 'center';
    ctx.fillText(text, bx + bw / 2, by + 27);
  }

  // terminal lines; the newest is bold
  const lx = r.x + 40;
  const lh = 48;
  const firstY = r.y + 214;
  const maxLines = Math.max(1, Math.floor((r.h - 214 - 196) / lh) + 1);
  const lines = p.lines.slice(-maxLines);
  ctx.textAlign = 'left';
  lines.forEach((ln, k) => {
    const y = firstY + k * lh;
    const last = k === lines.length - 1;
    const text = fill(ln, vars);
    ctx.font = '500 29px "JetBrains Mono"';
    ctx.fillStyle = '#6e6998';
    ctx.fillText('›', lx, y);
    ctx.font = `${last ? 700 : 500} 29px "JetBrains Mono"`;
    ctx.fillStyle = last ? '#ffffff' : '#c4c0dd';
    ctx.fillText(text, lx + 34, y);
    if (last && p.cursor && (p.typing || Math.floor(t * 2.4) % 2 === 0)) {
      const cx = lx + 34 + ctx.measureText(text).width + 6;
      ctx.fillStyle = '#e9e6ff';
      ctx.fillRect(cx, y - 17, 15, 34);
    }
  });

  // footer: elapsed status + input box
  ctx.font = '500 24px Inter';
  ctx.fillStyle = '#6b6791';
  ctx.textAlign = 'left';
  const since = p.since ?? 100 + (p.title || '').length * 9;
  ctx.fillText(`${p.state || 'working'} · ${clockString(since + t)}`, r.x + 40, r.y + r.h - 162);

  const ib = { x: r.x + 26, y: r.y + r.h - 128, w: r.w - 52, h: 102 };
  roundRect(ctx, ib.x, ib.y, ib.w, ib.h, 18);
  ctx.fillStyle = '#0e0c1f';
  ctx.fill();
  ctx.strokeStyle = '#26223f';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.font = '500 26px Inter';
  ctx.fillStyle = '#7b77a2';
  ctx.fillText(tl.screen.ask || 'Ask the agent…', ib.x + 24, ib.y + 34);
  ctx.font = '600 20px Inter';
  const chip = p.model || 'studio';
  const cw = ctx.measureText(chip).width + 28;
  roundRect(ctx, ib.x + 20, ib.y + 56, cw, 32, 9);
  ctx.fillStyle = '#211d3b';
  ctx.fill();
  ctx.fillStyle = '#a7a3c8';
  ctx.fillText(chip, ib.x + 34, ib.y + 73);
  dot(ctx, ib.x + ib.w - 46, ib.y + ib.h / 2, 18, '#ec5f64');

  // fade text that would run off the right edge
  const fade = ctx.createLinearGradient(r.x + r.w - 60, 0, r.x + r.w, 0);
  fade.addColorStop(0, 'rgba(16,14,34,0)');
  fade.addColorStop(1, 'rgba(16,14,34,1)');
  ctx.fillStyle = fade;
  ctx.fillRect(r.x + r.w - 60, r.y + 170, 60, r.h - 340);
  ctx.restore();
}
