#!/usr/bin/env node
// Render a script to an MP4.
//
//   npm run render                               videos/demo.json -> out/demo.mp4
//   npm run render -- videos/my-video.json       any script
//   npm run render -- videos/demo.json --scale 0.5   quick half-size draft
//   npm run render -- videos/demo.json --frame 400   one frame -> out/demo/frame-0400.png
//   npm run render -- videos/demo.json --sheet       contact sheet -> out/demo/sheet.jpg
//   npm run check                                 prove frames come out identical
//   npm run dev                                   live preview in your browser
//
// Other options: --from 10 --to 20 (seconds), --workers 2 (parallel pages),
// --voices babble|tts|none (override script.audio.voices), --cpu (force the
// software renderer even if you have a GPU), --out path.mp4

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { mixTrack, prepareVoices, writeWav } from './lib/audio.mjs';
import { buildTimeline } from './src/timeline.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

const FLAGS = new Set(['dev', 'check', 'cpu', 'no-audio']); // options without a value

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      opts._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    const takesValue = !FLAGS.has(key) && next !== undefined && !next.startsWith('--');
    // --sheet takes an optional frame count
    if (takesValue && (key !== 'sheet' || /^\d+$/.test(next))) {
      opts[key] = next;
      i++;
    } else opts[key] = true;
  }
  return opts;
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

function serve(port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(ROOT, rel);
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// In render mode nothing in the page may read the clock or real randomness.
// This makes accidental Math.random()/Date.now() calls repeatable instead.
function determinismGuard() {
  let s = 0x2f6b2b1d;
  Math.random = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  Date.now = () => 1700000000000;
  performance.now = () => 0;
}

// Uses the GPU when there is one, otherwise Chromium's software renderer.
async function openPages(n, url, size, cpu) {
  const args = ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'];
  if (cpu) args.push('--use-angle=swiftshader');
  const browser = await chromium.launch({ args });
  const pages = [];
  for (let i = 0; i < n; i++) {
    const page = await browser.newPage({ viewport: size, deviceScaleFactor: 1 });
    await page.addInitScript(determinismGuard);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e));
    page.on('console', (m) => m.type() === 'error' && errors.push(new Error(m.text())));
    await page.goto(url);
    try {
      await page.evaluate(() => window.studioReady);
    } catch (e) {
      throw new Error(`The scene failed to load:\n${errors.map((x) => x.message).join('\n') || e.message}`);
    }
    pages.push(page);
  }
  return { browser, pages };
}

// PNG for stills; video frames travel as high-quality JPEG (much faster, and
// the H.264 encode that follows is lossy anyway).
async function capture(page, t, type = 'image/png') {
  const dataUrl = await page.evaluate(([time, mime]) => window.studio.capture(time, mime, 0.95), [t, type]);
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

// Render frame indices on several pages at once, delivering them in order.
async function renderFrames(pages, frames, fps, onFrame, type) {
  const done = new Map();
  let cursor = 0;
  let next = 0;
  let chain = Promise.resolve();
  const flush = () => {
    chain = chain.then(async () => {
      while (done.has(next)) {
        const buf = done.get(next);
        done.delete(next);
        await onFrame(buf, frames[next], next);
        next++;
      }
    });
    return chain;
  };
  await Promise.all(
    pages.map(async (page) => {
      while (cursor < frames.length) {
        const i = cursor++;
        while (i - next > pages.length * 3) await new Promise((r) => setTimeout(r, 15));
        done.set(i, await capture(page, frames[i] / fps, type));
        flush();
      }
    }),
  );
  await flush();
}

function progress(label, i, total, startedAt) {
  const elapsed = (Date.now() - startedAt) / 1000;
  const rate = i / Math.max(elapsed, 1e-3);
  const eta = (total - i) / Math.max(rate, 1e-6);
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  process.stdout.write(`\r  ${label} ${i}/${total}  ${rate.toFixed(2)} fps  ETA ${mmss(eta)}   `);
}

// Run a command; `feed(stdin)` may stream data into it.
function run(cmd, args, feed) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: [feed ? 'pipe' : 'ignore', 'inherit', 'inherit'] });
    let feedError = null;
    p.on('error', (e) => reject(new Error(`Could not run ${cmd}: ${e.message}`)));
    p.on('close', (code) => {
      if (feedError) reject(feedError);
      else if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with ${code}`));
    });
    if (feed) {
      p.stdin.on('error', () => {}); // ffmpeg quitting early surfaces via its exit code
      Promise.resolve()
        .then(() => feed(p.stdin))
        .catch((e) => {
          feedError = e;
          p.stdin.end();
        });
    }
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const scriptPath = opts._[0] || 'videos/demo.json';
  const scriptRel = path.relative(ROOT, path.resolve(scriptPath)).split(path.sep).join('/');
  if (scriptRel.startsWith('..') || path.isAbsolute(scriptRel)) {
    throw new Error(`Put your script inside this folder (e.g. videos/), not ${scriptPath}`);
  }
  const name = path.basename(scriptPath, '.json');
  const workDir = path.join(ROOT, 'out', name);
  fs.mkdirSync(workDir, { recursive: true });
  const script = JSON.parse(fs.readFileSync(path.resolve(scriptPath), 'utf8'));

  // 1. voices -> timing (line lengths + mouth envelopes)
  const voiceMode = opts['no-audio'] ? 'none' : opts.voices;
  console.log(`▸ ${name}: preparing voices (${voiceMode || script.audio?.voices || 'babble'})`);
  const { timing, clips } = prepareVoices(script, { root: ROOT, workDir, mode: voiceMode, log: console.log });
  fs.writeFileSync(path.join(workDir, 'timing.json'), JSON.stringify(timing));
  const tl = buildTimeline(script, timing);
  const audioFile = path.join(workDir, 'audio.wav');
  if (clips.length || script.audio?.music) {
    const samples = mixTrack({
      clips,
      starts: tl.lines.map((l) => l.start),
      duration: tl.frames / tl.fps,
      root: ROOT,
      audio: script.audio,
    });
    writeWav(audioFile, samples);
  } else fs.rmSync(audioFile, { force: true });
  const hasAudio = fs.existsSync(audioFile);
  console.log(`  ${tl.lines.length} lines, ${tl.duration.toFixed(1)} s, ${tl.frames} frames, ${tl.shots.length} shots`);

  const server = await serve(opts.dev ? Number(opts.port || 5173) : 0);
  const port = server.address().port;
  const query = `script=${encodeURIComponent(scriptRel)}&timing=${encodeURIComponent(`out/${name}/timing.json`)}`;

  if (opts.dev) {
    console.log(`\n  Preview: http://localhost:${port}/?${query}\n  (space = play/pause, Ctrl+C to stop)`);
    return;
  }

  const scale = Number(opts.scale || 1);
  const W = Math.round((tl.width * scale) / 2) * 2;
  const H = Math.round((tl.height * scale) / 2) * 2;
  const url = `http://127.0.0.1:${port}/?${query}&render=1&scale=${scale}${opts.debug ? `&debug=${opts.debug}` : ''}`;
  const workers = Math.max(1, Number(opts.workers || 1));
  const { browser, pages } = await openPages(opts.check ? 2 : workers, url, { width: W, height: H }, opts.cpu);
  const gpuName = await pages[0].evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });
  console.log(`  renderer: ${gpuName}`);

  try {
    if (opts.frame !== undefined) {
      const f = Number(opts.frame);
      const file = path.join(workDir, `frame-${String(f).padStart(4, '0')}.png`);
      fs.writeFileSync(file, await capture(pages[0], f / tl.fps));
      console.log(`✓ ${path.relative(process.cwd(), file)}`);
      return;
    }

    if (opts.sheet) {
      const n = Number(opts.sheet === true ? 12 : opts.sheet);
      const cols = 4;
      const sheetDir = path.join(workDir, 'sheet');
      fs.rmSync(sheetDir, { recursive: true, force: true });
      fs.mkdirSync(sheetDir, { recursive: true });
      const frames = Array.from({ length: n }, (_, k) => Math.floor(((k + 0.5) / n) * tl.frames));
      await renderFrames(pages, frames, tl.fps, async (buf, f, k) => {
        fs.writeFileSync(path.join(sheetDir, `${String(k).padStart(3, '0')}.png`), buf);
      });
      const file = path.join(workDir, 'sheet.jpg');
      await run(FFMPEG, [
        '-y', '-v', 'error', '-i', path.join(sheetDir, '%03d.png'),
        '-vf', `scale=360:-2,tile=${cols}x${Math.ceil(n / cols)}:padding=6:color=white`,
        '-frames:v', '1', '-q:v', '3', file,
      ]);
      console.log(`✓ ${path.relative(process.cwd(), file)}`);
      return;
    }

    if (opts.check) {
      // Render the same frames in two different orders on two pages; the PNGs must match.
      const picks = [0.13, 0.42, 0.77].map((k) => Math.floor(k * tl.frames));
      const hash = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);
      const a = [];
      for (const f of picks) a.push(hash(await capture(pages[0], f / tl.fps)));
      const b = [];
      for (const f of [...picks].reverse()) b.unshift(hash(await capture(pages[1], f / tl.fps)));
      let ok = true;
      picks.forEach((f, i) => {
        const same = a[i] === b[i];
        ok &&= same;
        console.log(`  frame ${f}: ${a[i]} vs ${b[i]}  ${same ? 'identical' : 'DIFFERENT'}`);
      });
      console.log(ok ? '✓ deterministic: same frame, same pixels, any order' : '✗ frames differ between renders');
      process.exitCode = ok ? 0 : 1;
      return;
    }

    // Full render: stream PNG frames straight into ffmpeg (no frames on disk).
    const from = Math.max(0, Math.floor(Number(opts.from || 0) * tl.fps));
    const to = Math.min(tl.frames, opts.to ? Math.ceil(Number(opts.to) * tl.fps) : tl.frames);
    const outFile = path.resolve(opts.out || path.join(ROOT, 'out', `${name}${opts.from || opts.to ? `-${from}-${to}` : ''}.mp4`));
    const frames = Array.from({ length: to - from }, (_, k) => from + k);
    const args = ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(tl.fps), '-c:v', 'mjpeg', '-i', '-'];
    if (hasAudio) args.push('-ss', String(from / tl.fps), '-t', String(frames.length / tl.fps), '-i', audioFile);
    args.push('-map', '0:v');
    if (hasAudio) args.push('-map', '1:a', '-c:a', 'aac', '-b:a', '192k', '-ac', '2');
    args.push(
      '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '17',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
      '-movflags', '+faststart', outFile,
    );
    console.log(`▸ rendering ${frames.length} frames at ${W}×${H} with ${pages.length} page(s)`);
    const startedAt = Date.now();
    await run(FFMPEG, args, async (stdin) => {
      try {
        await renderFrames(pages, frames, tl.fps, async (buf, f, k) => {
          if (!stdin.write(buf)) await new Promise((r) => stdin.once('drain', r));
          if (k % 10 === 0 || k === frames.length - 1) progress('frame', k + 1, frames.length, startedAt);
        }, 'image/jpeg');
      } finally {
        stdin.end();
      }
    });
    process.stdout.write('\n');
    console.log(`✓ ${path.relative(process.cwd(), outFile)}  (${((Date.now() - startedAt) / 1000).toFixed(0)} s)`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});
