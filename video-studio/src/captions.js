// Burned-in captions: centred white text a little above the middle of the
// frame (clear of the app buttons on TikTok / Reels / Shorts).

import { clamp, easeOut } from './util.js';

function wrap(ctx, text, maxWidth) {
  const lines = [];
  let cur = '';
  for (const word of text.split(/\s+/)) {
    const test = cur ? `${cur} ${word}` : word;
    if (cur && ctx.measureText(test).width > maxWidth) {
      lines.push(cur);
      cur = word;
    } else cur = test;
  }
  if (cur) lines.push(cur);
  return lines;
}

// Same number of lines as greedy wrapping, but with even line lengths.
function balancedWrap(ctx, text, maxWidth) {
  const greedy = wrap(ctx, text, maxWidth);
  if (greedy.length < 2) return greedy;
  let lo = maxWidth * 0.4;
  let hi = maxWidth;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (wrap(ctx, text, mid).length > greedy.length) lo = mid;
    else hi = mid;
  }
  return wrap(ctx, text, hi);
}

export function drawCaption(ctx, cap, t, W, H, style = {}) {
  if (!cap) return;
  const size = Math.round(W * (style.size ?? 0.047));
  const k = easeOut((t - cap.start) / 0.14);
  ctx.save();
  ctx.font = `${style.weight ?? 600} ${size}px Inter`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = balancedWrap(ctx, cap.text, W * (style.maxWidth ?? 0.66));
  const lh = size * 1.24;
  const cy = H * (style.y ?? 0.37) + (1 - k) * size * 0.25;
  const y0 = cy - ((lines.length - 1) * lh) / 2;
  ctx.globalAlpha = clamp(k * 1.4);
  ctx.shadowColor = 'rgba(6,4,18,0.75)';
  ctx.shadowBlur = size * 0.45;
  ctx.shadowOffsetY = size * 0.06;
  ctx.fillStyle = style.color ?? '#ffffff';
  lines.forEach((line, i) => ctx.fillText(line, W / 2, y0 + i * lh));
  ctx.restore();
}
