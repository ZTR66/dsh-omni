# dsh-omni

One plugin for every modality: **watch video, hear audio, generate images and clips** — all through tools a model can call.

The DeepSeek Harness message model carries only text and images, so "let the model watch this video" cannot mean handing it a video file. Everything here converts: a video becomes a grid of timestamped frames, audio becomes a transcript plus measurable features. The model reads those and reasons about them.

## What it does

### Watching a video: you choose the density

`video_scan` turns a time range into one image of cells, each with a burned-in timecode, and returns a `timeline` mapping cell number to second.

```
video_scan({ input, fps: 2, cellWidth: 240 })            // whole film, find the structure
video_scan({ input, from: 24, to: 30, fps: 5, cellWidth: 480 })  // read one stretch
video_frames({ input, at: [26.5], width: 1280 })         // one exact frame
```

The sampling density is a parameter, not a policy. A first pass over an unfamiliar film wants 2 fps at 240 px — cheap, shows where things change. Reading on-screen text needs 5–10 fps at 480 px or more on a short range. Encoding "two passes" as a fixed strategy would make both cases worse.

### Measuring music

`audio_analyze` returns numbers, not adjectives:

```json
{
  "tempo":    { "bpm": 117.45, "beats": 22, "regularity": 0.977, "detected": true },
  "tonality": { "root": "C", "mode": "major", "estimatedKey": "C major" },
  "timbre":   { "centroidHz": 1562.5, "zeroCrossRate": 0.0779 },
  "dynamics": { "rmsDb": -21.64, "peakDb": -0.92, "crestDb": 20.73 },
  "sections": [ { "at": 0, "level": "loud", "energy": 0.9 } ]
}
```

`tempo.detected: false` is a real answer, not a failure — ambient beds and speech have no periodic beat, and inventing a number there would be misleading. There is no instrument classifier; that needs a trained model this plugin does not ship.

### Speech, both ways

`audio_transcribe` tries the Host's recogniser first, then a local faster-whisper model, and reports which route ran. A local run needs no network and no key. `audio_speak` synthesises speech through edge-tts and reports the measured pace in characters per second, so a narration whose rhythm is wrong is visible before the film is assembled.

### Drawing vs paying

`video_generate` is the most expensive and least controllable tool here, so it refuses to be convenient:

- **Scenes code can draw are refused outright** — a title card, a chart, a geometric shape, a transition. The check is by *kind*, not by how much of the film they represent: a title card is a title card whether it is 2% or 80% of the running time.
- **Anything that passes needs consent** — either an explicit user request with the user's own words, or an approval prompt through the Host. A deployment with no approval service is refused rather than trusted, because an unattended process should not spend money.
- **You build the film with `video_compose`** and generate only the shots that genuinely need a model (a real wave, a real face, a specific material).

## Tools

| Tool | What it does |
|---|---|
| `omni_env_check` | Report ffmpeg, Python libraries, Whisper models, local generation services, and the interpreter split |
| `omni_probe` | Read real media metadata: codec, resolution, frame rate, sample rate, channel layout |
| `video_scan` | Video range → grid of timestamped cells + timeline |
| `video_frames` | Exact frames at full resolution |
| `video_compose` | Stills and clips + audio → MP4 (H.264 High, yuv420p, AAC 48 kHz) |
| `video_extract_audio` | Video → audio track |
| `video_generate` | Text → clip, behind a capability gate and a consent gate |
| `audio_transcribe` | Speech → timestamped text (Host or local) |
| `audio_analyze` | Loudness, tempo, tonality, timbre, energy profile |
| `audio_speak` | Text → MP3, with measured pace |
| `audio_cut` | Cut segments or join files for audio |
| `image_generate` | Text → image across eight provider adapters |

Plus a `omni-media` skill that loads the decision tree into the model when a media task arrives.

## Install

```sh
dsh plugin --profile <your profile> add dsh-omni
```

Requires DSH `>=0.2.0-rc.1` and Node 20+.

### Dependencies

The plugin is small; the tools are not self-contained. `omni_env_check` reports what is missing and how to install it.

| Component | Needed for | Install |
|---|---|---|
| ffmpeg / ffprobe | everything involving a container | `winget install Gyan.FFmpeg` |
| librosa + soundfile | audio analysis | `pip install librosa soundfile` |
| faster-whisper | local transcription | `pip install faster-whisper` |
| edge-tts | speech synthesis | `pip install edge-tts` |

Generation needs a provider and a key, configured in **设置 → 全模态**. Nothing about generation works without one, and the key is stored in the Host credential store rather than this plugin's config.

## Image-to-video

`video_generate` accepts `firstFrame`, `lastFrame` or `images`. The adapter picks
the mode from what you supply, because the three modes have disjoint field sets and
a stray field is a rejected request:

| Supplied | Agnes mode | Effect |
|---|---|---|
| nothing | `text` | text-to-video |
| `firstFrame` / `lastFrame` | `keyframe` | the frames anchor the shot's start and end |
| `images` | `reference` | assets inform content and style, not exact framing |

**The image must be a public URL.** The provider fetches it from its own network
while the task runs, so a local path, a `file://` URI, `localhost` or a private
address will never resolve for their crawler — and the failure surfaces as a
generic task error naming neither the URL nor the reason. The plugin checks the
shape of the URL before spending a request and says which of those it is.

A signed URL that expires before the queue drains fails the same way; keep the
link alive until the task completes.

## Provider adapters

**Image** — OpenAI Images, GPT-Image, Gemini, SiliconFlow, Volcengine Ark, Zhipu CogView, DashScope Wanx, Mona Studio, plus local A1111/ComfyUI/SwarmUI. Fields differ per provider (size, quality, response shape); the differences live in descriptors, so the caller sees one shape.

**Video** — Seedance (Volcengine Ark), Agnes Video, Zhipu CogVideoX.

## Two environment traps this plugin works around

**The Python split.** On a machine with both a DSH runtime and a system Python, packages divide between them: the runtime may have librosa while the system one has edge-tts. A single script that both analyses and synthesises fails at import time, so each operation runs in the interpreter that can actually do it, and `omni_env_check` reports the split as `pythonConflict`.

**Windows stdio encoding.** Python defaults stdio to the console code page there, so a `json.dumps(..., ensure_ascii=False)` payload comes back as mojibake even though the data is correct. Every Python child runs with `PYTHONIOENCODING=utf-8`.

## Known limits

- Video and audio are never handed to the model directly; the Host has no such modality. Everything is converted first.
- No instrument classification.
- The local generation backends are wired by configuration but were never verified on a machine without one running. If one fails, report the error rather than assuming the plugin is broken.
- Transcription of lyrics from a dense mix needs a vocal-isolation step first.

## Licence

MIT. See `LICENSE`.
