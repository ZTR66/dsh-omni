/**
 * Single-frame extraction at exact moments.
 *
 * This is the third level of the "look wider, then closer" workflow: a grid
 * shows *where* something happens, this shows *what it says*. So the default is
 * the source resolution rather than a downscale — the point of coming here is
 * usually to read text that a grid cell was too small to render.
 *
 * Seeking accuracy matters more than speed here. `-ss` before `-i` is fast but
 * lands on the nearest keyframe, which can be seconds away on a long-GOP file;
 * `-ss` after `-i` decodes to the exact frame. For reading a specific caption,
 * being two seconds off defeats the purpose, so the slow form is used.
 */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ffmpeg, probe } from './ffmpeg.js';
import { formatClock } from './scan.js';

/** Clamp a requested width to something a reader can use. */
function normaliseWidth(value, sourceWidth) {
  if (value === undefined || value === null || value === '') return sourceWidth ?? 1280;
  const width = Number(value);
  if (!Number.isFinite(width)) return sourceWidth ?? 1280;
  return Math.max(160, Math.min(3840, Math.round(width)));
}

/**
 * Extract one frame per requested moment.
 *
 * @param {object} config plugin config.
 * @param {object} request `{ input, at, width?, outDir? }`.
 * @returns {Promise<object>} `{ ok, frames: [{ at, label, path, bytes }] }`.
 */
export async function extractFrames(config, request = {}) {
  const input = typeof request?.input === 'string' ? request.input : '';
  if (input === '') return { ok: false, error: 'input is required' };
  if (!existsSync(input)) return { ok: false, error: `file not found: ${input}` };

  // One moment or many; a single value is the common case.
  const raw = Array.isArray(request?.at) ? request.at : [request?.at];
  const moments = raw
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (moments.length === 0) {
    return { ok: false, error: 'at is required: one second offset, or an array of them' };
  }
  if (moments.length > 24) {
    return { ok: false, error: 'at most 24 moments per call; use a grid for dense sampling' };
  }

  const info = await probe(config, input);
  if (info.ok !== true) return { ok: false, error: `cannot probe the file: ${info.error}` };
  if (info.video === null) return { ok: false, error: 'this file has no video track' };
  const duration = info.duration ?? 0;

  const beyond = moments.filter((m) => m > duration);
  if (beyond.length > 0) {
    return { ok: false, error: `these moments are past the end of the file (${duration}s): ${beyond.join(', ')}` };
  }

  const width = normaliseWidth(request?.width, info.video.width);
  const dir = request?.outDir ?? join(process.cwd(), 'omni-frames');
  mkdirSync(dir, { recursive: true });
  const stamp = Date.now();

  const frames = [];
  for (const [index, at] of moments.entries()) {
    const output = join(dir, `frame-${stamp}-${index}-${Math.round(at * 1000)}.png`);
    // `-ss` after `-i` decodes to the exact frame rather than the prior keyframe.
    const result = await ffmpeg(config, [
      '-i', input,
      '-ss', String(at),
      '-frames:v', '1',
      '-vf', `scale=${width}:-2`,
      output,
    ], { timeoutMs: 120000 });

    if (result.ok !== true || !existsSync(output)) {
      return {
        ok: false,
        error: `failed to capture the frame at ${at}s`,
        detail: (result.log ?? '').split('\n').slice(-6).join('\n'),
        captured: frames,
      };
    }
    frames.push({
      at: Number(at.toFixed(3)),
      label: formatClock(at),
      path: output,
      bytes: statSync(output).size,
    });
  }

  return {
    ok: true,
    source: { file: input, duration, width: info.video.width, height: info.video.height },
    requestedWidth: width,
    frames,
  };
}

/** Render a frame-extraction result for a person to read. */
export function formatFrames(result) {
  if (result?.ok !== true) {
    const lines = ['# 抽帧失败', '', result?.error ?? '未知错误'];
    if (result?.detail) lines.push('', '```', result.detail, '```');
    if (Array.isArray(result?.captured) && result.captured.length > 0) {
      lines.push('', `已成功 ${result.captured.length} 张。`);
    }
    return lines.join('\n');
  }
  const lines = [
    `# 抽取 ${result.frames.length} 帧`,
    '',
    `- 源：${result.source.file.split(/[\\/]/).pop()}`,
    `- 输出宽度：${result.requestedWidth}px`,
    '',
  ];
  for (const frame of result.frames) {
    lines.push(`- **${frame.label}** → ${frame.path}（${Math.round(frame.bytes / 1024)} KB）`);
  }
  return lines.join('\n');
}
