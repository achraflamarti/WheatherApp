// Audio: one voice clip per line, then a single mixed track for the video.
//
// Voice clips come from (in order of priority):
//   1. "audio": "path/to/recording.wav" on the line (your own recording)
//   2. a TTS command from script.audio.tts when script.audio.voices is "tts"
//   3. "babble": cartoon syllables synthesised from the text (no setup)
// Each clip is trimmed of silence and measured: its length times the line,
// its loudness envelope drives the character's mouth.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashString, mulberry32 } from '../src/util.js';

export const SR = 48000;
export const ENVELOPE_RATE = 60;

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

export function writeWav(file, samples, sampleRate = SR) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

// Any audio file -> mono Float32Array at SR (via ffmpeg).
export function decode(file) {
  const res = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], {
    maxBuffer: 1 << 30,
  });
  if (res.error) throw new Error(`Could not run ffmpeg (${res.error.message}). Install it or set FFMPEG_PATH.`);
  if (res.status !== 0) throw new Error(`ffmpeg could not read ${file}:\n${res.stderr}`);
  const buf = res.stdout;
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
}

// Cut leading/trailing silence (keeps a few ms of air).
function trim(samples) {
  const th = 0.012;
  let a = 0;
  let b = samples.length - 1;
  while (a < b && Math.abs(samples[a]) < th) a++;
  while (b > a && Math.abs(samples[b]) < th) b--;
  a = Math.max(0, a - Math.round(0.03 * SR));
  b = Math.min(samples.length, b + Math.round(0.06 * SR));
  return samples.slice(a, b);
}

// Loudness per 1/60 s, mapped to 0..1 relative to the clip's own loud parts.
export function envelope(samples) {
  const hop = SR / ENVELOPE_RATE;
  const n = Math.ceil(samples.length / hop);
  const rms = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    const a = Math.floor(i * hop);
    const b = Math.min(samples.length, Math.floor((i + 1) * hop));
    for (let j = a; j < b; j++) sum += samples[j] * samples[j];
    rms[i] = Math.sqrt(sum / Math.max(1, b - a));
  }
  const sorted = [...rms].sort((x, y) => x - y);
  const loud = sorted[Math.floor(sorted.length * 0.92)] || 1e-4;
  const out = [];
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const db = 20 * Math.log10(rms[i] / loud + 1e-9); // 0 dB = loud part of this clip
    let v = Math.max(0, Math.min(1, (db + 30) / 28));
    v = v > prev ? v : prev * 0.72 + v * 0.28; // open fast, close a bit slower
    prev = v;
    out.push(Math.round(v * 100) / 100);
  }
  return out;
}

// ---- babble: cartoon speech made from the text's syllables ----

const VOWELS = {
  a: [730, 1090, 2440],
  e: [530, 1840, 2480],
  i: [300, 2200, 2950],
  o: [570, 840, 2410],
  u: [320, 900, 2250],
};

function syllables(word) {
  const w = word.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!w) return [];
  if (/^\d+$/.test(w)) return [...w].map(() => 'i');
  const groups = w.match(/[aeiouy]+/g) || ['a'];
  let n = groups.length;
  if (n > 1 && /[^aeiouy]e$/.test(w)) n--; // silent final e
  return groups.slice(0, Math.max(1, n)).map((g) => (g[0] === 'y' ? 'i' : g[0]));
}

export function babble(text, voice = {}) {
  const base = voice.pitch ?? 180;
  const speed = voice.speed ?? 1;
  const bright = voice.timbre === 'bright';
  const rnd = mulberry32(hashString(text) ^ Math.round(base));
  const words = text.split(/\s+/).filter(Boolean);
  const question = /\?\s*$/.test(text);
  const events = [];
  let t = 0.03;
  words.forEach((word, wi) => {
    const syl = syllables(word);
    syl.forEach((v, si) => {
      const stressed = si === 0;
      const dur = ((stressed ? 0.15 : 0.12) * (0.85 + rnd() * 0.3)) / speed;
      const progress = (wi + si / Math.max(1, syl.length)) / words.length;
      let semis = (rnd() - 0.5) * 4 + (stressed ? 1 : 0);
      semis += question ? progress * 5 : -progress * 3; // questions rise, statements fall
      events.push({ t, dur, f0: base * Math.pow(2, semis / 12), formants: VOWELS[v] || VOWELS.a, amp: stressed ? 1 : 0.8 });
      t += dur + 0.02 / speed;
    });
    if (/[.!?…]$/.test(word)) t += 0.28 / speed;
    else if (/[,;:]$/.test(word)) t += 0.16 / speed;
    else t += 0.07 / speed;
  });
  const out = new Float32Array(Math.ceil((t + 0.05) * SR));
  for (const ev of events) syllable(out, ev, bright, rnd);
  let peak = 0;
  for (const s of out) peak = Math.max(peak, Math.abs(s));
  if (peak > 0) for (let i = 0; i < out.length; i++) out[i] *= 0.7 / peak;
  return out;
}

function syllable(buf, ev, bright, rnd) {
  const n0 = Math.floor(ev.t * SR);
  const n = Math.floor(ev.dur * SR);
  const nh = Math.min(48, Math.floor(5500 / ev.f0));
  const amps = new Float32Array(nh + 1);
  for (let k = 1; k <= nh; k++) {
    const f = k * ev.f0;
    let g = 0;
    ev.formants.forEach((fc, j) => {
      const bw = 80 + 60 * j;
      g += [1, 0.55, 0.22][j] / (1 + ((f - fc) / bw) ** 2);
    });
    amps[k] = (g / Math.pow(k, bright ? 0.25 : 0.55)) * (bright && k % 2 === 0 ? 0.6 : 1);
  }
  let phase = 0;
  let breath = 0; // low-passed noise at the onset reads as a soft consonant
  for (let i = 0; i < n && n0 + i < buf.length; i++) {
    const tt = i / SR;
    const a = Math.min(1, tt / 0.014);
    const r = Math.min(1, Math.max(0, (ev.dur - tt) / 0.04));
    const env = Math.sin((a * Math.PI) / 2) ** 2 * Math.sin((r * Math.PI) / 2) ** 2 * ev.amp;
    const f0 = ev.f0 * (1 + 0.04 * (1 - tt / ev.dur));
    phase += (2 * Math.PI * f0) / SR;
    let s = 0;
    for (let k = 1; k <= nh; k++) s += amps[k] * Math.sin(k * phase);
    breath += ((tt < 0.022 ? rnd() * 2 - 1 : 0) - breath) * 0.28;
    buf[n0 + i] += s * env + breath * 0.1 * Math.max(0, 1 - tt / 0.03);
  }
}

// ---- TTS via any command line tool ----

// Split a command template into argv, honouring quotes, then fill placeholders.
// Running without a shell means text never needs escaping.
function commandArgs(template, vars) {
  const tokens = template.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  return tokens.map((tok) =>
    tok.replace(/^["']|["']$/g, '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)),
  );
}

function runTTS(template, vars) {
  const [cmd, ...args] = commandArgs(template, vars);
  const res = spawnSync(cmd, args, { input: vars.text, stdio: ['pipe', 'inherit', 'inherit'] });
  if (res.error) throw new Error(`TTS command "${cmd}" failed to start: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`TTS command exited with code ${res.status}: ${cmd} ${args.join(' ')}`);
  if (!fs.existsSync(vars.out)) throw new Error(`TTS command did not write ${vars.out}`);
}

// Make (or reuse) one clip per line. Returns timing.json content plus the samples.
export function prepareVoices(script, { root, workDir, mode: forcedMode, log = () => {} }) {
  const audio = script.audio || {};
  const mode = forcedMode || audio.voices || 'babble';
  if (mode === 'none') return { timing: { envelopeRate: ENVELOPE_RATE, lines: [] }, clips: [] };
  const voiceDir = path.join(workDir, 'voice');
  fs.mkdirSync(voiceDir, { recursive: true });
  const clips = [];
  const lines = [];
  script.lines.forEach((line, i) => {
    const who = script.characters[line.who] || {};
    const spoken = line.say || line.text;
    let file;
    if (line.audio) {
      file = path.resolve(root, line.audio);
    } else if (mode === 'tts') {
      if (!audio.tts) throw new Error('audio.voices is "tts" but audio.tts (the command) is missing');
      const ext = audio.ttsFormat || 'mp3';
      const key = crypto.createHash('sha1').update([audio.tts, who.voice, spoken].join('\n')).digest('hex').slice(0, 10);
      file = path.join(voiceDir, `${String(i + 1).padStart(2, '0')}-${key}.${ext}`);
      if (!fs.existsSync(file)) {
        log(`  voice ${i + 1}/${script.lines.length}: ${spoken}`);
        const textfile = path.join(voiceDir, `line-${i + 1}.txt`);
        fs.writeFileSync(textfile, spoken);
        runTTS(audio.tts, { text: spoken, voice: who.voice || '', out: file, textfile });
      }
    } else if (mode === 'babble') {
      file = path.join(voiceDir, `${String(i + 1).padStart(2, '0')}-babble.wav`);
      writeWav(file, babble(spoken, who));
    } else {
      throw new Error(`Unknown audio.voices "${mode}" (use "babble", "tts" or "none")`);
    }
    const samples = trim(decode(file));
    clips.push({ file, samples });
    lines.push({ duration: samples.length / SR, envelope: envelope(samples) });
  });
  return { timing: { envelopeRate: ENVELOPE_RATE, lines }, clips };
}

// Place clips on the timeline, add music (ducked under voices), return mono samples.
export function mixTrack({ clips, starts, duration, root, audio = {} }) {
  const total = Math.round(duration * SR);
  const voice = new Float32Array(total);
  clips.forEach((clip, i) => {
    const off = Math.round(starts[i] * SR);
    const gain = audio.voiceVolume ?? 0.9;
    for (let j = 0; j < clip.samples.length && off + j < total; j++) voice[off + j] += clip.samples[j] * gain;
  });
  const out = Float32Array.from(voice);
  if (audio.music) {
    const music = decode(path.resolve(root, audio.music));
    const vol = audio.musicVolume ?? 0.18;
    let duck = 0;
    for (let i = 0; i < total; i++) {
      // follow the voice level so music dips while someone talks
      const v = Math.abs(voice[i]);
      duck = v > duck ? duck + (v - duck) * 0.002 : duck * 0.99997;
      const fadeIn = Math.min(1, i / (0.6 * SR));
      const fadeOut = Math.min(1, (total - i) / (1.8 * SR));
      out[i] += music[i % music.length] * vol * (1 - Math.min(0.6, duck * 3)) * fadeIn * fadeOut;
    }
  }
  let peak = 0;
  for (const s of out) peak = Math.max(peak, Math.abs(s));
  if (peak > 0.98) for (let i = 0; i < total; i++) out[i] *= 0.98 / peak;
  return out;
}
