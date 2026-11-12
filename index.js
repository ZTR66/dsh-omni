/**
 * dsh-omni — one plugin for every modality.
 *
 * The Host's message model carries only `text` and `image` blocks, so "let the
 * model watch a video" and "let the model hear audio" cannot mean handing raw
 * bytes to the LLM. What this plugin does instead is convert: a video becomes a
 * grid of frames with a timeline, audio becomes a transcript plus measurable
 * features. The model reads those and reasons about them.
 *
 * Three design rules run through the implementation:
 *
 * 1. **The caller decides how much detail.** Sampling density, ranges and
 *    resolution are parameters, not a fixed strategy. Every result carries a
 *    timeline so a narrower follow-up can be asked for by second.
 *
 * 2. **Missing dependencies are reported, not crashed on.** ffmpeg, the Python
 *    libraries and local generation services are all probed up front, and each
 *    gap names its install command.
 *
 * 3. **Generation is gated by capability, not by cost.** `video_generate` refuses
 *    scenes that code could draw, whatever fraction of the film they represent,
 *    and anything it does allow needs either an explicit user request or an
 *    approval outcome.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkEnvironment, formatEnvironment } from './lib/env.js';
import { probe, formatProbe } from './lib/ffmpeg.js';
import { renderGrid, formatGrid } from './lib/scan.js';
import { extractFrames, formatFrames } from './lib/frames.js';
import {
  analyseAudio, formatAnalysis,
  transcribeAudio, formatTranscript,
  speakAudio, formatSpeech,
} from './lib/audio.js';
import { cutAudio, formatCut } from './lib/audio-cut.js';
import {
  composeVideo, formatCompose,
  extractAudio, formatExtractAudio,
} from './lib/compose.js';
import { generateImage, formatImage } from './lib/image.js';
import { registerSettingsRoutes } from './lib/settings-routes.js';
import {
  checkCapability, requestConsent,
  generateVideo, formatVideo,
} from './lib/video-generate.js';

export const name = '@ztr66/dsh-omni';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Only `tools` is declared.
 *
 * A missing injected service stops `apply` from running at all, which leaves the
 * plugin stuck in "loading" with nothing in the log. Everything else — ffmpeg,
 * Python, approval, the web server — is looked up at call time so a host without
 * one of them still loads and simply reports that capability as unavailable.
 */
export const inject = ['tools'];

export function apply(ctx, config = {}) {
  const log = (message) => {
    try {
      ctx?.logger?.info?.(`[dsh-omni] ${message}`);
    }
    catch { /* logging must never break a tool call */ }
  };

  log('apply');

  // A live view of the plugin config.
  //
  // `config` is the object the loader handed to `apply` and is frozen at that
  // moment. Anything saved later through the settings page — a provider list, a
  // credential reference, the image host — lands in the loader's entry instead,
  // so reading `config` directly would keep serving the startup values forever.
  // The getter closes over `config` as a fallback and prefers the current entry,
  // which makes a save visible to the next tool call without a restart.
  const currentConfig = () => {
    try {
      const editor = ctx.get?.('configEditor');
      if (editor && typeof editor.entries === 'function') {
        const entry = editor.entries().find((item) => item?.id === 'omni' || item?.options?.id === 'omni');
        if (entry !== undefined && typeof editor.configuration === 'function') {
          const row = editor.configuration().find((item) => item?.entry === entry || item?.entry?.id === entry.id);
          const merged = { ...(row?.inherited ?? {}), ...(row?.override ?? {}) };
          if (Object.keys(merged).length > 0) return merged;
        }
        if (entry?.config !== undefined) return entry.config;
      }
    }
    catch { /* fall through to the startup config */ }
    return config ?? {};
  };

  const settings = {
    get ffmpegPath() { return typeof currentConfig().ffmpegPath === 'string' ? currentConfig().ffmpegPath : ''; },
    get pythonPath() { return typeof currentConfig().pythonPath === 'string' ? currentConfig().pythonPath : ''; },
    get asr() { return currentConfig().asr ?? {}; },
    get image() { return currentConfig().image ?? {}; },
    get video() { return currentConfig().video ?? {}; },
    get imageHost() { return currentConfig().imageHost; },
  };

  // Every tool registration is collected so `apply` can return one disposer.
  const disposers = [];
  let toolCount = 0;
  const register = (definition) => {
    try {
      const dispose = ctx.tools.register(definition);
      disposers.push(dispose);
      toolCount += 1;
    }
    catch (error) {
      log(`failed to register ${definition.name}: ${String(error?.message ?? error)}`);
    }
  };

  // ---- environment ------------------------------------------------------

  register({
    name: 'omni_env_check',
    description: [
      'Check what this machine can do with media, and what is missing.',
      '',
      'This reports capability, not direction — it does not say what to make. Run it once you know what',
      'you are building, not before: a machine that checks its tools first ends up letting the tools decide',
      'the content, which is backwards.',
      '',
      'It reports, per stage: ffmpeg/ffprobe, the Python libraries for analysis and speech, downloaded',
      'Whisper models, whether the voice engine lives in a different interpreter, and which local',
      'generation services are listening. Each gap names its install command.',
      '',
      'The `readyFor` block grades by deliverable — probing, storyboards, composition, audio analysis,',
      'local transcription, speech, local image and video generation — so you can tell what is possible',
      'right now rather than reading a single ready flag.',
    ].join('\n'),
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() {
      const report = await checkEnvironment(settings);
      // A capability report is not a plan; say so where the model reads it.
      return '> **这是能力报告，不是方案。** 它说明这台机器能做什么，不说明要做什么。\n'
        + '> 等你清楚要做什么了，再来查环境才有意义。\n\n'
        + formatEnvironment(report);
    },
  });

  register({
    name: 'omni_probe',
    description: [
      'Read the real metadata of any media file: container, duration, size, bit rate, video codec,',
      'resolution, frame rate, frame count, pixel format, audio codec, sample rate and channel layout.',
      '',
      'Use it before deciding how to sample a video, and to confirm an exported file is what you think',
      'it is. It reads the file rather than trusting its extension.',
    ].join('\n'),
    parameters: {
      input: { type: 'string', required: true, description: 'Path to a media file.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      const result = await probe(settings, args?.input);
      return formatProbe(result);
    },
  });

  // ---- video understanding ---------------------------------------------

  register({
    name: 'video_scan',
    description: [
      'Turn a range of a video into one image of timestamped cells.',
      '',
      'This is how you "watch" a video: the Host cannot pass video to a model, so the frames become an',
      'image and the timeline becomes text. Use it in two passes — a cheap wide pass to find out where',
      'things happen, then a narrower, denser pass on the part that matters.',
      '',
      'You choose the density. `fps` controls how often a frame is taken, `cellWidth` how readable each',
      'cell is. A first look at an unfamiliar film is usually `fps: 1` or `2` with `cellWidth: 240`.',
      'Reading on-screen text needs `fps: 4`–`10` with `cellWidth: 480` or more on a short range.',
      '',
      'The result carries `timeline`: cell number to exact second. Quote those seconds when you refer',
      'to a moment, and pass them back as `from`/`to` (or to video_frames) to look closer.',
      '',
      'Timestamps are burned into each cell when a font is available, so the grid is readable on its own.',
    ].join('\n'),
    parameters: {
      input: { type: 'string', required: true, description: 'Path to a video file.' },
      from: { type: 'number', description: 'Start second. Defaults to 0.' },
      to: { type: 'number', description: 'End second. Defaults to the end of the file.' },
      fps: { type: 'number', description: 'Frames per second to sample. 0.5 coarse, 2 default-ish, 10 fine. Ignored when `grid` is given.' },
      cellWidth: { type: 'number', description: 'Pixel width of each cell, 120–1280. Bigger is more readable and a bigger file.' },
      grid: { type: 'string', description: 'Fixed shape instead of an fps: 2x2, 3x3, 4x4, 5x5, 6x6, 3x4, 4x3, 5x4, 6x5.' },
      maxCells: { type: 'number', description: 'Cap on cell count when sampling by fps. Defaults to 120.' },
      timestamps: { type: 'boolean', description: 'Burn the timecode into each cell. Defaults to true.' },
      outDir: { type: 'string', description: 'Directory for the PNG. Defaults to a temp directory.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      const result = await renderGrid(settings, args ?? {});
      return formatGrid(result);
    },
  });

  register({
    name: 'video_frames',
    description: [
      'Capture one or more exact frames at full resolution.',
      '',
      'This is the closest look available: a grid cell may be too small to read text, and this is not.',
      'Reach for it after a grid or a scan shows you a moment worth reading — pass the seconds from that',
      "result's timeline.",
      '',
      'Frames are grabbed by decoding to the requested moment, not by seeking to the nearest keyframe,',
      'so the picture is the one that is actually there. Up to 24 moments per call.',
    ].join('\n'),
    parameters: {
      input: { type: 'string', required: true, description: 'Path to a video file.' },
      at: { type: 'number', description: 'One second offset. Use an array via `at` for several.' },
      width: { type: 'number', description: 'Output width. Defaults to the source width.' },
      outDir: { type: 'string', description: 'Directory for the PNGs.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      const result = await extractFrames(settings, args ?? {});
      return formatFrames(result);
    },
  });

  register({
    name: 'audio_analyze',
    description: [
      'Measure what is inside an audio file: loudness, tempo, tonality and timbre.',
      '',
      'Use it when the answer depends on properties of the sound rather than on words — matching a',
      'music bed to a film mood, checking whether a recording is too quiet, deciding where a track',
      'changes energy, or telling a major from a minor key before picking visuals.',
      '',
      'Every field is measured, not guessed: `bpm`, `regularity` (how evenly spaced the beats are),',
      '`estimatedKey`, `centroidHz` (brightness), `zeroCrossRate` (noisiness), spectrum spread, and an',
      'energy profile per second.',
      '',
      'A `tempo.detected: false` is a real answer, not a failure: ambient beds, speech and free-rhythm',
      'recordings have no periodic beat, and reporting a number there would be misleading.',
      '',
      'It does not identify instruments — that needs a trained classifier this plugin does not ship.',
      'It also does not transcribe; use audio_transcribe for words.',
    ].join('\n'),
    parameters: {
      input: { type: 'string', required: true, description: 'Path to an audio file (or a video with an audio track).' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      const result = await analyseAudio(settings, args ?? {});
      return formatAnalysis(result);
    },
  });

  register({
    name: 'audio_transcribe',
    description: [
      'Turn speech into timestamped text.',
      '',
      'This is the only way to "hear" audio here: the Host cannot pass sound to a model, so the words',
      'become text the model can read. Ask for it whenever understanding what is being said matters —',
      'a narrated video, a meeting recording, a voice memo.',
      '',
      'Two routes exist and the result says which one ran: the Host\'s own recogniser when the deployment',
      'has one, otherwise a local faster-whisper model. A local run needs no network and no API key, and',
      'downloads its model on first use.',
      '',
      'The transcript carries second-level timestamps, so a later call can ask about "the part around',
      '2:15" and be understood.',
    ].join('\n'),
    parameters: {
      input: { type: 'string', required: true, description: 'Path to an audio file or a video with audio.' },
      language: { type: 'string', description: 'BCP-47-ish language code such as zh or en. Defaults to zh; use auto to detect.' },
      model: { type: 'string', description: 'Local model size when the local route runs: tiny, base, small, medium. Defaults to the configured value.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      const result = await transcribeAudio(ctx, settings, args ?? {});
      return formatTranscript(result);
    },
  });

  register({
    name: 'audio_speak',
    description: [
      'Turn text into speech.',
      '',
      'Produces an MP3 that video_compose can lay under a rendered film. The default voice reads as a',
      'professional news anchor, which is the pace a knowledge short wants; pass `voice` to change it.',
      '',
      'The result reports the measured duration and characters per second, so a narration whose pace is',
      'wrong is visible before it is used rather than after the film is assembled.',
    ].join('\n'),
    parameters: {
      text: { type: 'string', required: true, description: 'What to say. Up to 20000 characters.' },
      voice: { type: 'string', description: 'An edge-tts voice id. Defaults to zh-CN-YunyangNeural.' },
      rate: { type: 'string', description: 'Speaking rate as an edge-tts percentage, e.g. +10% or -5%. Defaults to +0%.' },
      outDir: { type: 'string', description: 'Directory for the MP3.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      const result = await speakAudio(settings, args ?? {});
      return formatSpeech(result);
    },
  });

  register({
    name: 'audio_cut',
    description: [
      'Cut an audio file into segments, or join several files into one.',
      '',
      'Use it to trim a narration that runs long, cut a music bed down to a film\'s length, or stitch',
      'several takes together. Segments are re-encoded rather than stream-copied, because a copy only',
      'cuts on keyframes and a cut that lands tens of milliseconds late is audible on a beat.',
      '',
      'Pass `segments` to cut one file, or `inputs` to join several.',
    ].join('\n'),
    parameters: {
      input: { type: 'string', description: 'Source file when cutting. Mutually exclusive with inputs.' },
      segments: { type: 'array', items: { type: 'object' }, description: 'To cut: [{ from: seconds, to: seconds }, …].' },
      inputs: { type: 'array', items: { type: 'string' }, description: 'To join: ordered file paths.' },
      outDir: { type: 'string', description: 'Directory for the results.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      const result = await cutAudio(settings, args ?? {});
      return formatCut(result);
    },
  });

  register({
    name: 'video_compose',
    description: [
      'Assemble stills and clips into one MP4, with an audio track underneath.',
      '',
      'This is how a film gets finished. Generation models produce one clip at a time; somebody still',
      'has to order them, hold each still for the right duration, and lay the narration under it. The',
      'encoder settings are fixed to what plays everywhere (H.264 High, yuv420p, AAC 48 kHz stereo), so',
      'the output is a file you can upload rather than one that needs re-encoding.',
      '',
      'Inputs are forgiving: a list of stills with per-image `seconds`, a list of clips with optional',
      '`start`/`end` trims, either or both, and an optional audio track. Without audio a silent track is',
      'added so the output is shaped like every other film.',
      '',
      'Prefer this over video_generate whenever the frames can be drawn, captured or generated one at a',
      'time: it costs nothing, renders deterministically, and a wording change is a re-render rather than',
      'a new charge.',
    ].join('\n'),
    parameters: {
      images: { type: 'array', items: { type: 'object' }, description: 'Stills to hold: [{ path, seconds }, …].' },
      clips: { type: 'array', items: { type: 'object' }, description: 'Existing footage: [{ path, start?, end? }, …].' },
      audio: { type: 'string', description: 'Audio track to lay under the film.' },
      width: { type: 'number', description: 'Output width. Defaults to 1920.' },
      height: { type: 'number', description: 'Output height. Defaults to 1080.' },
      fps: { type: 'number', description: 'Output frame rate, 12–60. Defaults to 30.' },
      outDir: { type: 'string', description: 'Directory for the MP4.' },
      out: { type: 'string', description: 'Exact output path, overriding outDir.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      const result = await composeVideo(settings, args ?? {});
      return formatCompose(result);
    },
  });

  register({
    name: 'video_extract_audio',
    description: [
      'Pull the audio track out of a video.',
      '',
      'Needed before transcribing or analysing the sound of a video, because the recogniser and the',
      'analyser both want an audio file. Do not try to transcribe an MP4 directly.',
    ].join('\n'),
    parameters: {
      input: { type: 'string', required: true, description: 'Path to a video file.' },
      sampleRate: { type: 'number', description: 'Force an output sample rate. Omit to keep the source rate.' },
      outDir: { type: 'string', description: 'Directory for the MP3.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      const result = await extractAudio(settings, args ?? {});
      return formatExtractAudio(result);
    },
  });

  register({
    name: 'image_generate',
    description: [
      'Generate an image with the configured image model.',
      '',
      'Model, size and quality come from the plugin settings, not from this call: the provider list and',
      'the active model are user choices, and letting the conversation model invent them produced',
      'requests the provider rejected. Pass `providerId` or `model` only to override a configured',
      'choice deliberately.',
      '',
      'The result is a file path plus a markdown image line. Reply with that line and nothing else; do not',
      'describe the picture unless the user asks you to look at it.',
      '',
      'On failure report the error verbatim. Do not switch provider or model on your own.',
    ].join('\n'),
    parameters: {
      prompt: { type: 'string', required: true, description: 'Final prompt for the active model.' },
      providerId: { type: 'string', description: 'Override the configured provider.' },
      model: { type: 'string', description: 'Override the configured model id.' },
      size: { type: 'string', description: 'Requested size such as 1024x1024. Snapped to what the model supports.' },
      negativePrompt: { type: 'string', description: 'Only for models that accept it.' },
      outDir: { type: 'string', description: 'Directory for the image.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      const result = await generateImage(ctx, {
        ...(args ?? {}),
        providers: Array.isArray(settings.image?.providers) ? settings.image.providers : [],
      });
      if (result.ok === true) {
        // A markdown image line the client can render, then the detail block.
        return `![生成图片](${result.path})\n\n${formatImage(result)}`;
      }
      return formatImage(result);
    },
  });

  register({
    name: 'video_generate',
    description: [
      '用生成模型做整片，通常是最差的选择。',
      '',
      '先问自己三个问题：',
      '1. 这个镜头能用代码画吗？（文字、几何、图表、转场、界面演示 → 能）',
      '2. 能用已有素材剪吗？（能 → 用 video_compose）',
      '3. 只有以上都不行时，才用我。',
      '',
      '我按段计费，且每次结果不同 —— 改一个词就要重新生成。一支 60 秒的片子全用我，成本远高于',
      '代码渲染且难以修改。多半你只需要我做 1–2 个关键镜头，其余交给 video_compose。',
      '',
      '因此本工具会先做能力判定：如果场景描述里是文字、图表、几何、转场这类代码能画的内容，',
      '直接拒绝并给出替代方案，不看它占全片多少比例。',
      '',
      '能通过判定的场景还需要用户确认（走宿主审批），除非用户在对话里明确要求过生成模型。',
      '审批服务缺失时一律拒绝 —— 无人值守的环境不该自行花钱。',
    ].join('\n'),
    parameters: {
      prompt: { type: 'string', required: true, description: '这个镜头的画面描述。' },
      scenes: {
        type: 'array',
        items: { type: 'object' },
        description: '可选：分镜清单 [{ description, why }]。给了会逐条判定，全部通过才执行。',
      },
      userRequested: { type: 'boolean', description: '用户明确要求用生成模型时为 true，可跳过审批。' },
      userWords: { type: 'string', description: 'userRequested 时附上用户原话，作为依据。' },
      providerId: { type: 'string', description: '指定服务商。' },
      model: { type: 'string', description: '指定模型。' },
      size: { type: 'string', description: '分辨率，如 1920x1080（Agnes 用档位：720P / 1080P / 1K / 2K）。' },
      fps: { type: 'number', description: '帧率，默认 30。' },
      firstFrame: {
        type: 'string',
        description: '首帧图片的**公网 URL**。给了就走图生视频（Agnes keyframe 模式 / 智谱 image2video）。'
          + '提供商在它自己的网络里抓这张图，所以本地路径和 localhost 都不行。',
      },
      lastFrame: {
        type: 'string',
        description: '尾帧图片的公网 URL，可单独用也可和 firstFrame 一起用。',
      },
      images: {
        type: 'array',
        items: { type: 'string' },
        description: '参考图片 URL 列表（Agnes reference 模式，最多 8 张）。和 firstFrame 互斥。',
      },
      outDir: { type: 'string', description: '输出目录。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const scenes = Array.isArray(args?.scenes) && args.scenes.length > 0
        ? args.scenes
        : [{ description: String(args?.prompt ?? ''), why: undefined }];

      // Gate 1 — capability. Every scene must be one code cannot draw.
      const rejections = [];
      for (const scene of scenes) {
        const verdict = checkCapability(scene);
        if (verdict.allowed !== true) rejections.push({ scene, verdict });
      }
      if (rejections.length > 0) {
        const lines = ['# 已拒绝：这些场景代码就能画', ''];
        for (const { scene, verdict } of rejections) {
          lines.push(`- **${String(scene?.description ?? '').slice(0, 50)}**`);
          lines.push(`  ${verdict.reason}`);
          if (verdict.suggestion) lines.push(`  → ${verdict.suggestion}`);
        }
        lines.push('', '请重新规划，或明确告诉用户这支片子主要靠 AI 生成以及大致成本。');
        return lines.join('\n');
      }

      // Gate 2 — consent. An explicit user request is its own authorisation; the
      // words are required so the claim can be checked against the conversation.
      const userRequested = args?.userRequested === true
        && String(args?.userWords ?? '').trim().length > 0;
      if (!userRequested) {
        const consent = await requestConsent(ctx, exec?.agent, {
          toolName: 'video_generate',
          reason: `即将调用视频生成模型：${String(args?.prompt ?? '').slice(0, 80)}`,
          displayReason: {
            en: `Call the video generation model: ${String(args?.prompt ?? '').slice(0, 80)}`,
            zh: `即将调用视频生成模型：${String(args?.prompt ?? '').slice(0, 80)}`,
          },
        });
        if (consent.allowed !== true) {
          return [
            '# 未获批准',
            '',
            consent.reason,
            consent.hint ? `\n提示：${consent.hint}` : '',
          ].filter(Boolean).join('\n');
        }
      }

      const result = await generateVideo(ctx, settings, {
        ...(args ?? {}),
        providers: Array.isArray(settings.video?.providers) ? settings.video.providers : [],
      });
      return formatVideo(result);
    },
  });

  // ---- the skill ------------------------------------------------------
  //
  // Registered as a runtime skill so the model loads the method — which tool
  // answers which question, and when a generation model is the wrong choice —
  // at the moment a media task arrives, rather than carrying a page of guidance
  // in the system prompt for every conversation.
  try {
    const skills = ctx.get?.('skills');
    if (skills && typeof skills.register === 'function') {
      const content = readFileSync(join(HERE, 'skills', 'omni-media', 'SKILL.md'), 'utf8');
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
      const body = frontmatter === null ? content : content.slice(frontmatter[0].length).trim();
      const description = frontmatter === null
        ? 'Media work: video, audio, images.'
        : (/\bdescription:\s*(.+)/.exec(frontmatter[1])?.[1] ?? 'Media work: video, audio, images.').replace(/^["']|["']$/g, '');
      disposers.push(skills.register({
        name: 'omni-media',
        description,
        content: body,
        invocation: 'auto',
      }));
      log('skill registered: omni-media');
    }
    else {
      log('skills service unavailable; omni-media skill not registered');
    }
  }
  catch (error) {
    log(`skill registration failed: ${String(error?.message ?? error)}`);
  }

  // ---- settings routes -------------------------------------------------
  //
  // Registered fire-and-forget: `webServer` may become available after this
  // plugin applies, and a missing route only means the settings page cannot load
  // — the tools still work.
  let settingsDisposer = null;
  try {
    const webServer = ctx.get?.('webServer');
    if (webServer && typeof webServer.register === 'function') {
      settingsDisposer = registerSettingsRoutes(ctx, {
        webServer,
        entryId: 'omni',
        settings,
        getSettings: () => settings,
        log,
      });
      log('settings routes registered');
    }
    else if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (webCtx) => {
        try {
          settingsDisposer = registerSettingsRoutes(webCtx, {
            webServer: webCtx.webServer,
            entryId: 'omni',
            settings,
            getSettings: () => settings,
            log,
          });
          log('settings routes registered (deferred)');
        }
        catch (error) {
          log(`deferred settings routes failed: ${String(error?.message ?? error)}`);
        }
      });
    }
    else {
      log('webServer unavailable; settings page will not load');
    }
  }
  catch (error) {
    log(`settings routes failed: ${String(error?.message ?? error)}`);
  }

  const dispose = () => {
    if (settingsDisposer !== null) {
      try { settingsDisposer(); } catch { /* ignore */ }
      settingsDisposer = null;
    }
    for (const fn of disposers.splice(0)) {
      try {
        fn();
      }
      catch { /* a failed disposer must not block the others */ }
    }
  };
  log(`registered ${toolCount} tools`);
  return dispose;
}
