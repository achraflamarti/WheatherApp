// Turns a script (who says what) into a timeline: when each line starts and
// ends, which caption is on screen, where the camera points, and what the
// laptop screen shows. Shared by the browser (to draw frames) and Node (to
// place audio), so picture and sound always agree on timing.

import { clamp, hashString, noise1, smoothstep } from './util.js';

export const DEFAULTS = {
  fps: 30,
  width: 1080,
  height: 1920,
  lead: 0.45, // quiet beat before the first line
  tail: 1.6, // hold after the last line
  gap: 0.3, // pause when the speaker changes
  sameSpeakerGap: 0.14, // pause when the same character keeps talking
  maxShot: 4.4, // lines longer than this get a cut in the middle
};

export const SHOT_TYPES = ['close', 'low', 'two', 'wide', 'screen'];

export function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// Rough speaking time for a line when there is no audio clip to measure.
export function estimateDuration(text) {
  const words = wordCount(text);
  const stops = (text.match(/[.!?…](\s|$)/g) || []).length;
  const commas = (text.match(/[,;:](\s|$)/g) || []).length;
  return Math.max(1.0, 0.2 + words * 0.33 + stops * 0.16 + commas * 0.1);
}

// Break a line into caption-sized chunks: whole sentences, merged while they fit.
export function splitCaptions(text, maxChars = 62) {
  const sentences = (text.match(/[^.!?…]+(?:[.!?…]+["'’”)\]]*|$)/g) || [text])
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((s) => splitLong(s, maxChars));
  const chunks = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && (cur + ' ' + s).length > maxChars) {
      chunks.push(cur);
      cur = s;
    } else {
      cur = cur ? `${cur} ${s}` : s;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : [text];
}

function splitLong(s, maxChars) {
  if (s.length <= maxChars * 1.25) return [s];
  const mid = s.length / 2;
  let best = -1;
  for (const re of [/[,;:]\s/g, /\s/g]) {
    for (const m of s.matchAll(re)) {
      if (best < 0 || Math.abs(m.index - mid) < Math.abs(best - mid)) best = m.index;
    }
    if (best > 0 && Math.abs(best - mid) < s.length * 0.3) break;
  }
  if (best <= 0) return [s];
  const cut = s[best] === ' ' ? best : best + 1;
  return [...splitLong(s.slice(0, cut).trim(), maxChars), ...splitLong(s.slice(cut).trim(), maxChars)];
}

// `timing` comes from render.mjs: measured voice clip lengths and loudness envelopes.
export function buildTimeline(script, timing = {}) {
  const cfg = { ...DEFAULTS, ...(script.video || {}) };
  const characters = script.characters || {};
  const ids = Object.keys(characters);
  const clips = timing.lines || [];
  const lines = [];
  let t = cfg.lead;
  (script.lines || []).forEach((src, i) => {
    if (!characters[src.who]) throw new Error(`Line ${i + 1}: unknown character "${src.who}"`);
    const prev = script.lines[i - 1];
    if (prev) t += src.pause ?? (prev.who === src.who ? cfg.sameSpeakerGap : cfg.gap);
    const clip = clips[i];
    // never shorter than the time it takes to read the caption
    const readable = 0.3 + wordCount(src.text) * 0.24;
    const speech = clip && clip.duration > 0 ? Math.max(clip.duration, readable) : estimateDuration(src.text);
    const line = {
      index: i,
      who: src.who,
      text: src.text,
      mood: src.mood || 'neutral',
      listener: src.listener || null, // mood of the others while this line plays
      gesture: src.gesture ?? null,
      shot: src.shot || null,
      screen: src.screen || null,
      start: t,
      speechEnd: t + speech,
      end: t + speech + (src.hold || 0),
      envelope: clip?.envelope || null,
      seed: hashString(`${i}:${src.who}:${src.text}`),
    };
    lines.push(line);
    t = line.end;
  });
  const duration = t + cfg.tail;
  const tl = {
    ...cfg,
    duration,
    frames: Math.ceil(duration * cfg.fps),
    envelopeRate: timing.envelopeRate || 60,
    ids,
    characters,
    lines,
    screen: script.screen || {},
    captionStyle: script.captions || {},
  };
  tl.captions = buildCaptions(lines, duration);
  tl.shots = buildShots(lines, ids, duration, cfg);
  tl.screenEvents = buildScreenEvents(lines);
  return tl;
}

function buildCaptions(lines, duration) {
  const out = [];
  lines.forEach((line, i) => {
    const chunks = splitCaptions(line.text);
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const span = line.speechEnd - line.start;
    let t = line.start;
    for (const text of chunks) {
      const d = span * (text.length / total);
      out.push({ text, who: line.who, start: t, end: t + d });
      t += d;
    }
    // Keep the caption up through short pauses so it does not flicker.
    const next = lines[i + 1];
    const last = out[out.length - 1];
    last.end = next
      ? next.start - line.end < 0.9
        ? next.start
        : line.end + 0.35
      : Math.min(duration, line.end + 1.0);
  });
  return out;
}

function otherOf(lines, i, ids) {
  const who = lines[i].who;
  for (let k = i - 1; k >= 0; k--) if (lines[k].who !== who) return lines[k].who;
  for (let k = i + 1; k < lines.length; k++) if (lines[k].who !== who) return lines[k].who;
  return ids.find((id) => id !== who) || who;
}

// Pick a camera shot per line. A `shot` on the line wins ("close", "low",
// "two", "wide", "screen", optionally "close:sam" for a reaction shot).
// Otherwise: alternate close-ups and low-angle shots between speakers, show the laptop screen when a line types something on it, and
// end on a wide shot.
function buildShots(lines, ids, duration, cfg) {
  const shots = [];
  const turns = {};
  let prevType = null;
  lines.forEach((line, i) => {
    const prev = lines[i - 1];
    const next = lines[i + 1];
    const start = prev ? (prev.end + line.start) / 2 : 0;
    const end = next ? (line.end + next.start) / 2 : duration;
    let type;
    let subject = line.who;
    if (line.shot) {
      const [ty, sub] = String(line.shot).split(':');
      type = ty;
      if (sub) subject = sub;
    } else if (i === 0) type = 'close';
    else if (line.screen) type = 'screen';
    else if (!next) type = 'wide';
    else if (prev.who === line.who) type = prevType === 'close' ? 'two' : 'close';
    else {
      turns[line.who] = (turns[line.who] || 0) + 1;
      type = turns[line.who] % 2 ? 'low' : 'close';
    }
    if (!SHOT_TYPES.includes(type)) throw new Error(`Line ${i + 1}: unknown shot "${line.shot}"`);
    const base = {
      subject,
      other: subject === line.who ? otherOf(lines, i, ids) : line.who,
      panel: line.screen?.panel || null,
      line: i,
    };
    const limit = type === 'screen' ? cfg.maxShot * 1.4 : cfg.maxShot;
    if (!line.shot && type !== 'wide' && end - start > limit) {
      const cut = line.start + (line.speechEnd - line.start) * 0.5;
      const alt = type === 'close' ? 'two' : 'close';
      shots.push({ ...base, type, start, end: cut, seed: line.seed });
      shots.push({ ...base, type: alt, start: cut, end, seed: line.seed + 1 });
      prevType = alt;
    } else {
      shots.push({ ...base, type, start, end, seed: line.seed });
      prevType = type;
    }
  });
  if (!shots.length) shots.push({ type: 'wide', subject: ids[0], other: ids[1] || ids[0], start: 0, end: duration, seed: 1, line: -1 });
  return shots;
}

function buildScreenEvents(lines) {
  const events = [];
  for (const line of lines) {
    const s = line.screen;
    if (!s || !s.panel) continue;
    events.push({
      panel: s.panel,
      start: line.start + (s.delay ?? 0.2),
      type: [].concat(s.type || []),
      bubble: s.bubble ?? null,
      clear: s.clear !== false,
      cps: s.cps || 34,
    });
  }
  return events;
}

// ---- queries (pure functions of t) ----

export function shotAt(tl, t) {
  for (const s of tl.shots) if (t < s.end) return s;
  return tl.shots[tl.shots.length - 1];
}

export function captionAt(tl, t) {
  for (const c of tl.captions) if (t >= c.start && t < c.end) return c;
  return null;
}

export function lineAt(tl, t) {
  for (const l of tl.lines) if (t >= l.start && t < l.end) return l;
  return null;
}

// The line that most recently started at time t (or null before the first).
export function latestLine(tl, t) {
  let found = null;
  for (const l of tl.lines) {
    if (l.start <= t) found = l;
    else break;
  }
  return found;
}

// How open a speaker's mouth is (0..1) at time t during `line`.
export function voiceLevel(tl, line, t) {
  if (!line || t < line.start || t > line.speechEnd) return 0;
  const lt = t - line.start;
  if (line.envelope) {
    const i = Math.floor(lt * tl.envelopeRate);
    return line.envelope[i] ?? 0;
  }
  // No audio: fake a syllable rhythm so the character still looks like it talks.
  const syll = 0.5 + 0.5 * Math.sin(lt * Math.PI * 2 * 4.2 + (line.seed % 7));
  const words = 0.65 + 0.35 * noise1(lt * 2.6, line.seed);
  return clamp(syll * words) * smoothstep(0, 0.06, lt) * smoothstep(0, 0.1, line.speechEnd - t);
}
