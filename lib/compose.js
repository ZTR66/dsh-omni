/**
 * Composition: images plus audio into a playable video, and demuxing an audio
 * track back out.
 *
 * This is the part that makes "generated or drawn frames" into a deliverable.
 * The generation models produce one clip at a time; somebody still has to put
 * them in order, lay a narration under them, and set the duration. Doing that
 * with an ffmpeg command the caller assembles by hand is where exports go wrong:
 * a missing `-pix_fmt`, a mismatched sample rate, a still image with no duration.
 *
 * So the inputs here are forgiving — a list of stills with per-image durations, a
 * list of clips, an optional audio track — and the encoder settings are fixed to
 * values that play everywhere (H.264 High, yuv420p, AAC 48 kHz stereo).
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpeg, probe } from './ffmpeg.js';

/** A short silence of the given length, used to pad a missing audio track. */
async function writeSilence(config, seconds, dir) {
  const output = join(dir, 'silence.m4a');
  const result = await ffmpeg(config, [
    '-f', 'lavfi',
    '-i', `anullsrc=channel_layout=stereo:sample_rate=48000`,
    '-t', String(seconds),
    '-c:a', 'aac', '-b:a', '128k',
    output,
  ], { timeoutMs: 120000 });
  return result.ok === true && existsSync(output) ? output : null;
}

/**
 * Build one MP4.
 *
 * Two input shapes are supported, and mixing them is fine:
 *
 *   `images: [{ path, seconds }]`  — stills held for a duration
 *   `clips:  [{ path, start?, end? }]` — existing footage, optionally trimmed
 *
 * @param {object} config plugin config.
 * @param {object} request `{ images?, clips?, audio?, out?, width?, height?, fps? }`.
 */
export async function composeVideo(config, request = {}) {
  const images = Array.isArray(request?.images) ? request.images : [];
  const clips = Array.isArray(request?.clips) ? request.clips : [];
  const audio = typeof request?.audio === 'string' && request.audio !== '' ? request.audio : null;

  if (images.length === 0 && clips.length === 0) {
    return { ok: false, error: 'need images or clips to compose' };
  }

  for (const item of [...images, ...clips]) {
    if (typeof item?.path !== 'string' || !existsSync(item.path)) {
      return { ok: false, error: `file not found: ${item?.path ?? '(missing path)'}` };
    }
  }
  if (audio !== null && !existsSync(audio)) {
    return { ok: false, error: `audio not found: ${audio}` };
  }

  const width = Math.max(160, Math.min(3840, Number(request?.width ?? 1920)));
  const height = Math.max(160, Math.min(2160, Number(request?.height ?? 1080)));
  const fps = Math.max(12, Math.min(60, Number(request?.fps ?? 30)));

  const outDir = typeof request?.outDir === 'string' && request.outDir !== ''
    ? request.outDir
    : join(process.cwd(), 'omni-video');
  mkdirSync(outDir, { recursive: true });
  const output = typeof request?.out === 'string' && request.out !== ''
    ? request.out
    : join(outDir, `film-${Date.now()}.mp4`);

  const work = mkdtempSync(join(tmpdir(), 'omni-compose-'));
  const args = [];
  const filters = [];

  let inputIndex = 0;
  let totalSeconds = 0;
  // Each still becomes a looped input with its own duration, then every visual
  // is normalised to the same size and frame rate before the concat filter —
  // mixing sources of different dimensions otherwise fails at the concat step
  // with a message that does not name the culprit.
  const visualLabels = [];

  for (const image of images) {
    const seconds = Math.max(0.04, Number(image.seconds ?? 3));
    args.push('-loop', '1', '-t', String(seconds), '-i', image.path);
    const label = `v${inputIndex}`;
    filters.push(
      `[${inputIndex}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,`
      + `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,`
      + `setsar=1,fps=${fps},format=yuv420p[${label}]`,
    );
    visualLabels.push(label);
    totalSeconds += seconds;
    inputIndex += 1;
  }

  for (const clip of clips) {
    const trimStart = clip?.start === undefined ? null : Math.max(0, Number(clip.start));
    const trimEnd = clip?.end === undefined ? null : Math.max(0, Number(clip.end));
    args.push('-i', clip.path);
    const label = `v${inputIndex}`;
    const chain = [];
    if (trimStart !== null) chain.push(`trim=start=${trimStart}`);
    if (trimEnd !== null) chain.push(`trim=end=${trimEnd}`);
    // `setpts` is required after `trim`, otherwise the output keeps the original
    // timestamps and the concat filter sees gaps.
    if (chain.length > 0) chain.push('setpts=PTS-STARTPTS');
    chain.push(
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
      'setsar=1', `fps=${fps}`, 'format=yuv420p',
    );
    const clipInfo = await probe(config, clip.path);
    const clipSeconds = clipInfo.ok === true && clipInfo.duration !== null
      ? clipInfo.duration - (trimStart ?? 0) - (trimEnd === null ? 0 : Math.max(0, (clipInfo.duration ?? 0) - trimEnd))
      : 0;
    totalSeconds += Math.max(0, clipSeconds);
    filters.push(`[${inputIndex}:v]${chain.join(',')}[${label}]`);
    visualLabels.push(label);
    inputIndex += 1;
  }

  // One concat of every visual, then the audio is mapped separately.
  filters.push(`${visualLabels.map((l) => `[${l}]`).join('')}concat=n=${visualLabels.length}:v=1:a=0[vout]`);

  let audioInputIndex = null;
  if (audio !== null) {
    args.push('-i', audio);
    audioInputIndex = inputIndex;
    inputIndex += 1;
  }
  else {
    // A silent track keeps the output shaped like every other film: players and
    // later ffmpeg steps behave consistently when audio is always present.
    const silence = await writeSilence(config, Math.max(0.1, totalSeconds), work);
    if (silence !== null) {
      args.push('-i', silence);
      audioInputIndex = inputIndex;
      inputIndex += 1;
    }
  }

  args.push('-filter_complex', filters.join(';'));
  args.push('-map', '[vout]');
  if (audioInputIndex !== null) {
    // Resample so a 44.1 kHz bed under a 48 kHz pipeline does not drift.
    args.push('-map', `${audioInputIndex}:a`);
    args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
  }
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '18');
  args.push('-pix_fmt', 'yuv420p', '-movflags', '+faststart');
  args.push('-shortest');
  args.push(output);

  const result = await ffmpeg(config, args, { timeoutMs: Math.ceil(Math.max(300000, totalSeconds * 4000)) });
  rmSync(work, { recursive: true, force: true });

  if (result.ok !== true || !existsSync(output)) {
    return {
      ok: false,
      error: '合成失败',
      detail: (result.log ?? '').split('\n').slice(-12).join('\n'),
    };
  }

  const info = await probe(config, output);
  return {
    ok: true,
    path: output,
    bytes: statSync(output).size,
    duration: info.ok === true ? info.duration : totalSeconds,
    resolution: `${width}×${height}`,
    fps,
    inputs: { images: images.length, clips: clips.length, audio: audio !== null },
  };
}

/** Render a compose result for a person to read. */
export function formatCompose(result) {
  if (result?.ok !== true) {
    const lines = ['# 合成失败', '', result?.error ?? '未知错误'];
    if (result?.detail) lines.push('', '```', result.detail, '```');
    return lines.join('\n');
  }
  return [
    '# 视频已合成',
    '',
    `- 文件：${result.path}`,
    `- 时长：${result.duration ?? '未知'} 秒`,
    `- 分辨率：${result.resolution}`,
    `- 帧率：${result.fps} fps`,
    `- 大小：${(result.bytes / 1024 / 1024).toFixed(2)} MB`,
    '',
    `素材：${result.inputs.images} 张静帧 · ${result.inputs.clips} 段素材 · ${result.inputs.audio ? '有音频' : '无音频（已补静音）'}`,
  ].join('\n');
}

/**
 * Pull the audio track out of a video.
 *
 * Needed before transcription, because the recogniser wants an audio file and
 * nothing here should re-implement container demuxing.
 */
export async function extractAudio(config, request = {}) {
  const input = typeof request?.input === 'string' ? request.input : '';
  if (input === '') return { ok: false, error: 'input is required' };
  if (!existsSync(input)) return { ok: false, error: `file not found: ${input}` };

  const info = await probe(config, input);
  if (info.ok !== true) return { ok: false, error: `cannot probe the file: ${info.error}` };
  if (info.audio === null) return { ok: false, error: 'this file has no audio track' };

  const outDir = typeof request?.outDir === 'string' && request.outDir !== ''
    ? request.outDir
    : join(process.cwd(), 'omni-audio');
  mkdirSync(outDir, { recursive: true });
  const output = join(outDir, `audio-${Date.now()}.mp3`);

  // 16 kHz mono is what a recogniser wants and is also fine for listening to a
  // voice; a music analysis would want the original rate, so it can be passed.
  const sampleRate = Number(request?.sampleRate ?? 0) > 0 ? Number(request.sampleRate) : 0;
  const args = ['-i', input, '-vn'];
  if (sampleRate > 0) args.push('-ar', String(sampleRate));
  args.push('-c:a', 'libmp3lame', '-q:a', '2', output);

  const result = await ffmpeg(config, args, { timeoutMs: 300000 });
  if (result.ok !== true || !existsSync(output)) {
    return {
      ok: false,
      error: '提取音轨失败',
      detail: (result.log ?? '').split('\n').slice(-8).join('\n'),
    };
  }

  const audioInfo = await probe(config, output);
  return {
    ok: true,
    path: output,
    bytes: statSync(output).size,
    duration: audioInfo.ok === true ? audioInfo.duration : null,
    source: { file: input, audioCodec: info.audio.codec },
  };
}

/** Render an extract-audio result for a person to read. */
export function formatExtractAudio(result) {
  if (result?.ok !== true) {
    const lines = ['# 提取音轨失败', '', result?.error ?? '未知错误'];
    if (result?.detail) lines.push('', '```', result.detail, '```');
    return lines.join('\n');
  }
  return [
    '# 音轨已提取',
    '',
    `- 文件：${result.path}`,
    `- 时长：${result.duration ?? '未知'} 秒`,
    `- 大小：${Math.round(result.bytes / 1024)} KB`,
    `- 源编码：${result.source.audioCodec ?? '未知'}`,
    '',
    '可以直接交给 audio_transcribe 或 audio_analyze。',
  ].join('\n');
}
