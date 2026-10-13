# Video Studio

Make short vertical videos (TikTok / Reels / Shorts) where two little 3D
characters talk on a laptop keyboard, with burned-in captions, camera cuts,
depth of field and a glowing dashboard on the screen behind them.

You write the dialogue in a JSON file. Code renders every frame.

```
videos/demo.json  ──►  npm run render  ──►  out/demo.mp4   (1080×1920, 30 fps, H.264 + AAC)
```

## Quick start

You need **Node.js 18+** and **ffmpeg** (`brew install ffmpeg`, `winget install ffmpeg`,
or `sudo apt install ffmpeg`).

```bash
cd video-studio
npm install
npx playwright install chromium     # one time: the headless browser that draws the frames

npm run render                      # renders videos/demo.json  ->  out/demo.mp4
```

While you write, preview in your browser (space = play/pause, drag to scrub):

```bash
npm run dev                         # or: npm run dev -- videos/my-video.json
```

## Make your own video

1. Copy `videos/demo.json` (or `videos/weather-app.json`) to `videos/my-video.json`.
2. Change the lines.
3. Check the shots fast: `npm run sheet -- videos/my-video.json` writes 12 stills to
   `out/my-video/sheet.jpg`.
4. Render: `npm run render -- videos/my-video.json`, which writes `out/my-video.mp4`.

### The script file

```jsonc
{
  "video": { "fps": 30, "width": 1080, "height": 1920 },

  "characters": {
    "sam":   { "type": "human", "voice": "en-US-AndrewNeural", "pitch": 140 },
    "buddy": { "type": "buddy", "voice": "en-US-AnaNeural", "pitch": 300, "timbre": "bright" }
  },

  "audio": { "voices": "babble" },          // "babble" | "tts" | "none" (see Voices)

  "screen": {                               // the dashboard on the laptop screen (up to 6 panels)
    "title": "Main canvas · 6 agents running",
    "panels": [
      { "id": "render", "title": "Studio · renderer", "bubble": "Draw frame t",
        "model": "three.js", "lines": ["renderFrame(t)", "frame {frame} / {frames}"] }
    ]
  },

  "lines": [
    { "who": "sam", "text": "Wait. Was this whole video made with code?", "mood": "curious" },
    { "who": "buddy", "text": "Every single frame.", "mood": "happy",
      "screen": { "panel": "render", "type": ["renderFrame(t)", "t = {t}s"] } }
  ]
}
```

**Line fields** (only `who` and `text` are required):

| field | what it does |
|---|---|
| `who` | which character speaks (a key from `characters`) |
| `text` | the caption, and what gets spoken |
| `say` | spoken text when it should differ from the caption, e.g. `"Render frame of t"` for `renderFrame(t)` |
| `mood` | the speaker's face. Human: `neutral curious skeptical surprised happy serious thinking sad`. Buddy: `neutral happy calm serious surprised curious skeptical thinking sad` (`calm` closes its eyes to lines) |
| `listener` | mood of everyone else during this line |
| `gesture` | human: `talk` (default) `point` `shrug` `wave` `none`. Buddy: `talk` (default) `wave` `hop` `none` |
| `shot` | camera: `close`, `low`, `two`, `wide`, `screen`. Add a character for a reaction shot: `"close:sam"`. Leave it out and shots are picked for you |
| `screen` | type text into a screen panel while the line plays: `{ "panel": "id", "type": ["line 1", "line 2"], "bubble": "…" }` |
| `pause` | seconds of silence before the line (default 0.3, or 0.14 when the same character continues) |
| `hold` | extra seconds after the line |
| `audio` | use your own recording for this line: `"audio": "recordings/line3.wav"` (relative to this folder) |

Screen text can show live values: `{t}` (seconds), `{frame}`, `{frames}`, `{time}` (m:ss).

**Characters**: `"type": "human"` or `"buddy"`. Change colours with `"colors"`, e.g.
`{ "suit": "#2d6a4f", "hair": "#d4a373" }` for the human (keys: `skin nose hair suit pants shirt tie shoes`)
or `{ "body": "#4cc9f0" }` for the buddy. More than two characters works too; they line up left to right.

**Optional sections**: `"captions": { "y": 0.37, "size": 0.047, "maxWidth": 0.66 }` (position and size as
fractions of the frame), `"look": { "exposure": 1, "vignette": 0.38, "grain": 0.022, "bloomStrength": 0.6 }`,
and timing in `"video"`: `lead`, `tail`, `gap`, `maxShot`.

## Voices

Every line becomes a voice clip. Its length sets the line's timing, and its loudness
moves the character's mouth, so captions and lips stay in sync whatever voice you use.

- **`"voices": "babble"`** (default, nothing to install): cartoon syllables generated from the text,
  pitched per character (`pitch`, `timbre`, `speed` on the character).
- **`"voices": "tts"`**: runs any text-to-speech command once per line. Placeholders: `{text}`,
  `{voice}` (the character's `voice`), `{out}` (file to write) and `{textfile}`. The text is also sent
  on stdin. Clips are cached in `out/<name>/voice/`, so only changed lines are regenerated.
  - **edge-tts** (free, natural Microsoft voices, needs internet):
    `pip install edge-tts`, then
    `"tts": "edge-tts --voice {voice} --text {text} --write-media {out}"`.
    List voices with `edge-tts --list-voices`. If `edge-tts` is not on your PATH, use
    `"tts": "python -m edge_tts --voice {voice} --text {text} --write-media {out}"`.
  - **Piper** (free, runs offline): `pip install piper-tts`, download a voice model, then
    `"tts": "piper -m {voice} -f {out}"` (it reads the text from stdin), `"ttsFormat": "wav"`, and set
    each character's `voice` to its `.onnx` model path.
  - **ElevenLabs, OpenAI, …**: write a tiny script that calls their API and saves `{out}`, and
    point `tts` at it (e.g. `"node tools/my-tts.mjs {voice} {textfile} {out}"`).
- **Your own recordings**: `"audio": "path.wav"` on any line.

You can switch modes without editing the file: `npm run render -- videos/demo.json --voices tts`.

**Music**: `"audio": { "music": "music/track.mp3", "musicVolume": 0.18 }` (path relative to this folder). It loops, fades
out at the end and ducks under the voices automatically. Only use music you have the rights to.

## Render options

```
npm run render -- videos/my-video.json [options]

  --scale 0.5          half-size draft (4x faster)
  --from 10 --to 20    render only part (seconds)
  --frame 400          one frame -> out/<name>/frame-0400.png
  --sheet [n]          contact sheet of n stills (default 12) -> out/<name>/sheet.jpg
  --voices babble|tts|none
  --cpu                force software rendering (exact on every machine, but slow)
  --workers 2          render with several browser pages at once (can help with a GPU)
  --out path.mp4       output file
```

## How it works

One rule: **every pixel is a function of time.**

- `renderFrame(t)` (in `src/main.js`) builds the whole picture from scratch using only `t`: the
  camera comes from the shot list, poses from the script, screen text from how much has
  "typed" by `t`, dust from seeded noise.
- Nothing reads the clock and nothing calls `Math.random()`. Anything random comes from seeded
  functions in `src/util.js`. Frame 400 looks identical whether you render it first, last or next week.
  `npm run check` proves it: it renders frames in two different orders on two pages and compares them byte for byte.
- `render.mjs` opens the page in a headless browser, asks for frame 0, 1, 2, … and pipes each image
  into ffmpeg together with the mixed voice track.

| file | role |
|---|---|
| `videos/*.json` | your scripts |
| `src/timeline.js` | script to timing, captions and the shot list |
| `src/characters.js` | the human and buddy rigs: blinks, moods, gestures, lip movement |
| `src/set.js` | laptop, keys, window, lights, dust |
| `src/screen.js` | the dashboard on the laptop screen |
| `src/camera.js` | shot recipes (close, low, two, wide, screen) |
| `src/post.js` | depth of field, bloom, tone mapping, grain |
| `src/captions.js` | burned-in captions |
| `lib/audio.mjs` | voice clips, babble synth, mixing |
| `render.mjs` | the command line tool and preview server |

## Speed

With a GPU (most laptops) the browser renders frames quickly. Without one (servers,
containers) it falls back to software rendering at roughly 0.5 frames per second, so a
45-second video takes about 40 minutes. Iterate with `--sheet` and `--scale 0.5`, then do one
full render at the end.

## Tips

- Open with a question. The first two seconds decide whether people keep watching.
- One short sentence per line (about 12 words or fewer) keeps captions readable.
- 30 to 60 seconds is the sweet spot.
- Captions sit at 37% of the height, clear of the TikTok/Reels buttons.
- Honest limit: this is for animation, titles, diagrams and motion graphics. It will not film a real person.

## Let an AI agent write the script

Paste this into Claude Code (or any coding agent) from this folder:

> Read README.md and videos/demo.json. Write videos/TOPIC.json: a 40-second vertical video
> where `sam` (curious, a bit skeptical) asks and `buddy` (the expert) explains TOPIC.
> 12–16 lines, one short sentence each, open with a hook question, end with a punchline.
> Use moods, and use the screen panels to show the key terms as they come up.
> Then run `npm run sheet -- videos/TOPIC.json`, look at the sheet, fix anything
> that reads badly, and render with `npm run render -- videos/TOPIC.json`.

## Credits

[three.js](https://threejs.org) (MIT), [Playwright](https://playwright.dev) (Apache-2.0),
fonts [Inter](https://rsms.me/inter/) and [JetBrains Mono](https://www.jetbrains.com/lp/mono/)
(SIL Open Font License) via Fontsource.
