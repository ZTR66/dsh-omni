/**
 * ffmpeg / ffprobe wrappers.
 *
 * Two things here are less obvious than they look:
 *
 * 1. **The font path.** `drawtext` fails with `Fontconfig error: Cannot load
 *    default config file` on a Windows build without fontconfig. Passing an
 *    explicit `fontfile=` is the only way to burn a timestamp, and the path must
 *    have its drive colon escaped (`C\:/Windows/...`) or ffmpeg reads it as a
 *    protocol.
 *
 * 2. **Argument arrays, never shell strings.** Every value that reaches ffmpeg
 *    comes from a caller (a filename, a time, a scale). Building one string and
 *    handing it to a shell would make a filename with a quote an injection
 *    vector; passing an argv array removes that entirely.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Default location this machine happens to have, else whatever is on PATH. */
const FALLBACK_FFMPEG = 'D:\\ffmpeg-2026-06-10-git-b29bdd3715-full_build\\bin\\ffmpeg.exe';

/** Resolve the executable to use, honouring an explicit config path first. */
export function resolveBinary(config, name) {
  if (typeof config?.ffmpegPath === 'string' && config.ffmpegPath !== '') {
    const dir = dirname(config.ffmpegPath);
    const candidate = join(dir, `${name}${process.platform === 'win32' ? '.exe' : ''}`);
    if (existsSync(candidate)) return candidate;
    if (existsSync(config.ffmpegPath)) return config.ffmpegPath;
  }
  // A local full build is common on Windows and is not always on PATH.
  if (process.platform === 'win32') {
    const candidate = join(dirname(FALLBACK_FFMPEG), `${name}.exe`);
    if (existsSync(candidate)) return candidate;
  }
  return name;
}

/**
 * A font file drawtext can actually load.
 *
 * Windows ships `msyh.ttc` (Microsoft YaHei) which covers CJK, so a Chinese
 * label renders. The drive colon is escaped because ffmpeg parses a bare `C:` as
 * a protocol prefix.
 */
export function fontPath() {
  const candidates = process.platform === 'win32'
    ? ['C:\\Windows\\Fonts\\msyh.ttc', 'C:\\Windows\\Fonts\\arial.ttf']
    : ['/System/Library/Fonts/Helvetica.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      // ffmpeg's filter parser reads a bare `C:` as a protocol prefix, so the
      // colon after the drive letter is escaped. Convert the separators first —
      // doing it in the other order turns `C\:` into `C/:`.
      return candidate.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:');
    }
  }
  return null;
}

/** Run ffmpeg and capture stderr, which is where it reports almost everything. */
export async function ffmpeg(config, args, options = {}) {
  const binary = resolveBinary(config, 'ffmpeg');
  try {
    const { stderr } = await run(binary, ['-hide_banner', '-y', ...args], {
      timeout: options.timeoutMs ?? 600000,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return { ok: true, log: stderr ?? '' };
  }
  catch (error) {
    // `stderr` and `stdout` are both empty when the failure is Node refusing the
    // call itself — a non-integer timeout, a missing binary — so the message is
    // folded into the log. Without this the caller reports an empty detail and
    // the real cause is invisible.
    const message = String(error?.message ?? error);
    return {
      ok: false,
      log: `${error?.stderr ?? ''}${error?.stdout ?? ''}${message !== '' ? `\n${message}` : ''}`,
      message,
    };
  }
}

/**
 * Parse one media file.
 *
 * ffprobe's `-of json` output is used rather than `default=noprint_wrappers`
 * because a video has several streams and the flat form loses which stream a
 * value came from.
 */
export async function probe(config, file) {
  if (typeof file !== 'string' || file === '') {
    return { ok: false, error: 'file is required' };
  }
  if (!existsSync(file)) {
    return { ok: false, error: `file not found: ${file}` };
  }

  const binary = resolveBinary(config, 'ffprobe');
  let payload;
  try {
    const { stdout } = await run(binary, [
      '-v', 'error',
      '-show_format', '-show_streams',
      '-of', 'json',
      file,
    ], { timeout: 60000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    payload = JSON.parse(stdout);
  }
  catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }

  const streams = Array.isArray(payload.streams) ? payload.streams : [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  const format = payload.format ?? {};

  // A nominal frame rate arrives as "30/1"; the average is a different number
  // for variable-rate files, so both are reported rather than picking one.
  const ratio = (value) => {
    if (typeof value !== 'string' || !value.includes('/')) return value === undefined ? null : Number(value);
    const [num, den] = value.split('/').map(Number);
    return den === 0 ? null : Number((num / den).toFixed(3));
  };

  return {
    ok: true,
    file,
    container: format.format_name ?? null,
    duration: format.duration === undefined ? null : Number(format.duration),
    sizeBytes: format.size === undefined ? null : Number(format.size),
    bitRate: format.bit_rate === undefined ? null : Number(format.bit_rate),
    video: video === undefined ? null : {
      codec: video.codec_name ?? null,
      width: video.width ?? null,
      height: video.height ?? null,
      fps: ratio(video.r_frame_rate),
      avgFps: ratio(video.avg_frame_rate),
      frames: video.nb_frames === undefined ? null : Number(video.nb_frames),
      pixelFormat: video.pix_fmt ?? null,
    },
    audio: audio === undefined ? null : {
      codec: audio.codec_name ?? null,
      sampleRate: audio.sample_rate === undefined ? null : Number(audio.sample_rate),
      channels: audio.channels ?? null,
      channelLayout: audio.channel_layout ?? null,
      bitRate: audio.bit_rate === undefined ? null : Number(audio.bit_rate),
    },
    hasVideo: video !== undefined,
    hasAudio: audio !== undefined,
  };
}

/** Render a probe result for a person to read. */
export function formatProbe(result) {
  if (result?.ok !== true) return `# 媒体探测失败\n\n${result?.error ?? '未知错误'}`;
  const lines = [
    `# ${result.file.split(/[\\/]/).pop()}`,
    '',
    `- 容器: ${result.container ?? '未知'}`,
    `- 时长: ${result.duration === null ? '未知' : `${result.duration.toFixed(2)} 秒`}`,
    `- 大小: ${result.sizeBytes === null ? '未知' : `${(result.sizeBytes / 1024 / 1024).toFixed(2)} MB`}`,
    `- 码率: ${result.bitRate === null ? '未知' : `${Math.round(result.bitRate / 1000)} kbps`}`,
  ];
  if (result.video !== null) {
    const v = result.video;
    lines.push('', '## 视频轨');
    lines.push(`- 编码: ${v.codec ?? '未知'}`);
    lines.push(`- 分辨率: ${v.width}×${v.height}`);
    lines.push(`- 帧率: ${v.fps ?? '未知'} fps（平均 ${v.avgFps ?? '未知'}）`);
    lines.push(`- 总帧数: ${v.frames ?? '未知'}`);
    lines.push(`- 像素格式: ${v.pixelFormat ?? '未知'}`);
  }
  if (result.audio !== null) {
    const a = result.audio;
    lines.push('', '## 音频轨');
    lines.push(`- 编码: ${a.codec ?? '未知'}`);
    lines.push(`- 采样率: ${a.sampleRate ?? '未知'} Hz`);
    lines.push(`- 声道: ${a.channels ?? '未知'}（${a.channelLayout ?? '未知'}）`);
  }
  if (result.video === null && result.audio === null) {
    lines.push('', '没有可识别的音视频轨。');
  }
  return lines.join('\n');
}
