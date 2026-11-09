/**
 * Audio cutting and joining.
 *
 * Kept separate from the analysis and speech modules because it has nothing to
 * do with either: this is plain ffmpeg timeline surgery, and it is the piece
 * people reach for when a narration runs long or a music bed needs trimming to
 * a rendered film's length.
 *
 * One deliberate limit: every segment is re-encoded rather than stream-copied.
 * A stream copy is faster but only cuts on keyframes, and an audio cut that
 * lands 40 ms late is audible on a beat. The cost is a few seconds per file.
 */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ffmpeg, probe } from './ffmpeg.js';
import { formatClock } from './scan.js';

/**
 * Cut one file into one or more segments, or join several files.
 *
 * @param {object} config plugin config.
 * @param {object} request `{ input?, segments?, inputs?, outDir? }`.
 * @returns {Promise<object>} `{ ok, files: [...] }`.
 */
export async function cutAudio(config, request = {}) {
  const outDir = typeof request?.outDir === 'string' && request.outDir !== ''
    ? request.outDir
    : join(process.cwd(), 'omni-audio');
  mkdirSync(outDir, { recursive: true });
  const stamp = Date.now();

  // ---- joining several files into one -----------------------------------
  const list = Array.isArray(request?.inputs) ? request.inputs : [];
  if (list.length > 0) {
    for (const file of list) {
      if (typeof file !== 'string' || !existsSync(file)) {
        return { ok: false, error: `file not found: ${file}` };
      }
    }
    const output = join(outDir, `joined-${stamp}.mp3`);
    // The concat demuxer needs a list file with one `file '...'` line per input;
    // single quotes inside a path are escaped as '\''.
    const listFile = join(outDir, `.list-${stamp}.txt`);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      listFile,
      list.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join('\n'),
      'utf8',
    );
    const result = await ffmpeg(config, [
      '-f', 'concat', '-safe', '0', '-i', listFile,
      '-c:a', 'libmp3lame', '-q:a', '2',
      output,
    ], { timeoutMs: 300000 });
    try {
      const { rmSync } = await import('node:fs');
      rmSync(listFile, { force: true });
    }
    catch { /* the list file is harmless if it survives */ }

    if (result.ok !== true || !existsSync(output)) {
      return {
        ok: false,
        error: '拼接失败',
        detail: (result.log ?? '').split('\n').slice(-8).join('\n'),
      };
    }
    const info = await probe(config, output);
    return {
      ok: true,
      mode: 'join',
      files: [{
        path: output,
        bytes: statSync(output).size,
        seconds: info.ok === true ? info.duration : null,
        sources: list.length,
      }],
    };
  }

  // ---- cutting one file ------------------------------------------------
  const input = typeof request?.input === 'string' ? request.input : '';
  if (input === '') return { ok: false, error: 'input or inputs is required' };
  if (!existsSync(input)) return { ok: false, error: `file not found: ${input}` };

  const info = await probe(config, input);
  if (info.ok !== true) return { ok: false, error: `cannot probe the file: ${info.error}` };
  if (info.audio === null) return { ok: false, error: 'this file has no audio track' };
  const duration = info.duration ?? 0;

  const raw = Array.isArray(request?.segments) ? request.segments : [];
  const segments = raw.map((segment, index) => ({
    from: Math.max(0, Number(segment?.from ?? 0)),
    to: Math.min(duration, Number(segment?.to ?? duration)),
    index,
  }));
  if (segments.length === 0) {
    return { ok: false, error: 'segments is required: [{ from, to }, …]' };
  }
  for (const segment of segments) {
    if (!(segment.to > segment.from)) {
      return { ok: false, error: `segment ${segment.index} is empty: from=${segment.from} to=${segment.to}` };
    }
  }

  const files = [];
  for (const segment of segments) {
    const output = join(outDir, `cut-${stamp}-${segment.index}.mp3`);
    // `-ss` after `-i` decodes to the exact sample; `-t` is a duration, not an
    // end time, so it is given as the difference.
    const result = await ffmpeg(config, [
      '-i', input,
      '-ss', String(segment.from),
      '-t', String(segment.to - segment.from),
      '-vn', '-c:a', 'libmp3lame', '-q:a', '2',
      output,
    ], { timeoutMs: 300000 });

    if (result.ok !== true || !existsSync(output)) {
      return {
        ok: false,
        error: `segment ${segment.index} 剪切失败`,
        detail: (result.log ?? '').split('\n').slice(-6).join('\n'),
        done: files,
      };
    }
    const cutInfo = await probe(config, output);
    files.push({
      path: output,
      bytes: statSync(output).size,
      from: segment.from,
      to: segment.to,
      seconds: cutInfo.ok === true ? cutInfo.duration : Number((segment.to - segment.from).toFixed(2)),
      label: `${formatClock(segment.from)} → ${formatClock(segment.to)}`,
    });
  }

  return { ok: true, mode: 'cut', source: { file: input, duration }, files };
}

/** Render a cut result for a person to read. */
export function formatCut(result) {
  if (result?.ok !== true) {
    const lines = ['# 音频处理失败', '', result?.error ?? '未知错误'];
    if (result?.detail) lines.push('', '```', result.detail, '```');
    if (Array.isArray(result?.done) && result.done.length > 0) {
      lines.push('', `已完成 ${result.done.length} 段。`);
    }
    return lines.join('\n');
  }
  if (result.mode === 'join') {
    const file = result.files[0];
    return [
      '# 拼接完成',
      '',
      `- 文件：${file.path}`,
      `- 来源：${file.sources} 个文件`,
      `- 时长：${file.seconds ?? '未知'} 秒`,
      `- 大小：${Math.round(file.bytes / 1024)} KB`,
    ].join('\n');
  }
  const lines = [
    `# 切出 ${result.files.length} 段`,
    '',
    `- 源：${result.source.file.split(/[\\/]/).pop()}（${result.source.duration} 秒）`,
    '',
  ];
  for (const file of result.files) {
    lines.push(`- ${file.label} → ${file.path}（${file.seconds ?? '?'} 秒，${Math.round(file.bytes / 1024)} KB）`);
  }
  return lines.join('\n');
}
