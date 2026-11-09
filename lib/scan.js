/**
 * Storyboard grids: turn a time range of a video into one image of cells.
 *
 * The design decision that matters here is **who chooses the sampling density**.
 * This module does not. It takes `fps`, `cellWidth` and the range from the
 * caller, because the useful density depends on what the caller already knows:
 *
 *   - a first pass over an unfamiliar film wants 2 fps at 240 px per cell, which
 *     is cheap and shows structure without burying the reader in detail
 *   - a second look at a specific 10-second stretch wants 5 fps at 500 px per
 *     cell, because the point is to read what the text says
 *
 * Encoding "two passes" as a fixed strategy would make both cases worse. So the
 * parameters are open and every result carries a `timeline` mapping cell number
 * to seconds, which is what lets the caller ask for a narrower window next.
 *
 * Timestamps are burned into each cell for the same reason: a grid without them
 * shows *that* something happens but not *when*, and "when" is the whole point.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpeg, fontPath, probe } from './ffmpeg.js';

/** Grid shapes that tile cleanly at the cell counts people actually want. */
const GRID_SHAPES = {
  '2x2': { cols: 2, rows: 2 },
  '3x3': { cols: 3, rows: 3 },
  '4x4': { cols: 4, rows: 4 },
  '5x5': { cols: 5, rows: 5 },
  '6x6': { cols: 6, rows: 6 },
  '3x4': { cols: 3, rows: 4 },
  '4x3': { cols: 4, rows: 3 },
  '5x4': { cols: 5, rows: 4 },
  '6x5': { cols: 6, rows: 5 },
};

/**
 * Pick a grid shape for a cell count.
 *
 * The shape only has to be *close* to the count — ffmpeg's `tile` drops empty
 * cells, so a 17-frame sample on a 5×4 grid renders as 17 cells and one blank.
 * Getting the aspect roughly right keeps cells from becoming slivers.
 */
function shapeFor(count) {
  const options = [
    { cols: Math.ceil(Math.sqrt(count)), rows: Math.ceil(count / Math.ceil(Math.sqrt(count))) },
    { cols: 4, rows: Math.ceil(count / 4) },
    { cols: 5, rows: Math.ceil(count / 5) },
    { cols: 6, rows: Math.ceil(count / 6) },
    { cols: 3, rows: Math.ceil(count / 3) },
  ];
  for (const option of options) {
    if (option.cols * option.rows >= count) return option;
  }
  return { cols: 1, rows: count };
}

/** Escape a value for use inside an ffmpeg filter argument. */
function escapeFilterText(text) {
  // `:` separates filter options and `'` closes the quoted value, so both need
  // a backslash. Percent signs are ffmpeg's own expansion syntax.
  return String(text).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/%/g, '\\%');
}

/**
 * Build and run one grid render.
 *
 * @param {object} config plugin config (ffmpegPath).
 * @param {object} request `{ input, from?, to?, fps?, cellWidth?, grid?, timestamps?, outDir? }`.
 * @returns {Promise<object>} `{ ok, path, cells, timeline, … }` or `{ ok:false, error }`.
 */
export async function renderGrid(config, request = {}) {
  const input = typeof request?.input === 'string' ? request.input : '';
  if (input === '') return { ok: false, error: 'input is required' };
  if (!existsSync(input)) return { ok: false, error: `file not found: ${input}` };

  const info = await probe(config, input);
  if (info.ok !== true) return { ok: false, error: `cannot probe the file: ${info.error}` };
  if (info.video === null) return { ok: false, error: 'this file has no video track' };

  const duration = info.duration ?? 0;
  const from = Math.max(0, Number(request?.from ?? 0));
  const to = request?.to === undefined || request?.to === null
    ? duration
    : Math.min(duration, Number(request.to));
  if (!(to > from)) {
    return { ok: false, error: `empty range: from=${from} to=${to} (duration ${duration})` };
  }
  const span = to - from;

  // A caller may give a grid shape or a cell budget. A shape wins, because it is
  // the more specific instruction.
  let cols;
  let rows;
  let fps;
  let cellWidth;
  const shape = GRID_SHAPES[String(request?.grid ?? '')];
  if (shape !== undefined) {
    cols = shape.cols;
    rows = shape.rows;
    const cellCount = cols * rows;
    fps = cellCount / span;
    cellWidth = Math.max(120, Math.min(1280, Number(request?.cellWidth ?? 320)));
  }
  else {
    fps = Math.max(0.05, Math.min(30, Number(request?.fps ?? 2)));
    cellWidth = Math.max(120, Math.min(1280, Number(request?.cellWidth ?? 240)));
    const requested = Math.max(1, Math.round(span * fps));
    const capped = Math.min(requested, Math.max(1, Number(request?.maxCells ?? 120)));
    const chosen = shapeFor(capped);
    cols = chosen.cols;
    rows = chosen.rows;
    fps = capped / span;
  }

  const effectiveCells = Math.max(1, Math.round(span * fps));
  const timestamps = request?.timestamps !== false;

  const dir = request?.outDir ?? mkdtempSync(join(tmpdir(), 'omni-grid-'));
  const ownsDir = request?.outDir === undefined;
  // ffmpeg does not create the parent directory; it fails at the muxing step
  // with a bare "No such file or directory" that names neither the path nor the
  // cause. Creating it here turns a confusing failure into a working render.
  mkdirSync(dir, { recursive: true });
  const output = join(dir, `grid-${Date.now()}.png`);

  // fps first so `drawtext` sees the sampled frames, scale so every cell is the
  // same width, tile last because it consumes whole frames.
  const filters = [`fps=${fps.toFixed(4)}`];
  filters.push(`scale=${cellWidth}:-2`);

  if (timestamps) {
    const font = fontPath();
    if (font !== null) {
      // Seeking with `-ss` before `-i` resets the presentation time to zero, so
      // a raw `%{pts}` label would always start at 00:00 no matter where the
      // range began — the burned-in timecode would contradict the timeline.
      //
      // The fix is to seek after `-i` instead, which keeps the file's own
      // timestamps (at the cost of decoding up to the start point). For a
      // hundred-cell grid that cost is a second or two, and a timecode that
      // lies is worse than a slower render.
      filters.push(
        `drawtext=fontfile='${font}'`
        + `:text='%{pts\\:hms}'`
        + ':x=8:y=8:fontsize=16:fontcolor=yellow'
        + ':box=1:boxcolor=black@0.65:boxborderw=4',
      );
    }
    // No font available: the timeline still carries every timestamp, so the
    // result stays usable even without burned-in labels.
  }

  filters.push(`tile=${cols}x${rows}`);

  const args = ['-i', input];
  // Seek after the input so frame timestamps stay absolute. This decodes up to
  // `from`, which is the price of a burned-in timecode that matches the file.
  if (from > 0) args.push('-ss', String(from));
  if (to < duration) args.push('-t', String(span));
  args.push('-vf', filters.join(','));
  args.push('-frames:v', '1');
  args.push(output);

  const result = await ffmpeg(config, args, { timeoutMs: Math.max(120000, span * 2000) });
  if (result.ok !== true) {
    if (ownsDir) rmSync(dir, { recursive: true, force: true });
    return {
      ok: false,
      error: 'ffmpeg failed to build the grid',
      detail: (result.log ?? '').split('\n').slice(-8).join('\n'),
    };
  }
  if (!existsSync(output)) {
    if (ownsDir) rmSync(dir, { recursive: true, force: true });
    return { ok: false, error: 'ffmpeg reported success but produced no file' };
  }

  // The timeline is the contract with the caller: cell n shows the frame at
  // `from + (n-1)/fps`. Building it here means the caller never recomputes it.
  const timeline = [];
  for (let n = 0; n < effectiveCells; n += 1) {
    const at = from + n / fps;
    if (at > to) break;
    timeline.push({
      n: n + 1,
      at: Number(at.toFixed(3)),
      label: formatClock(at),
    });
  }

  return {
    ok: true,
    path: output,
    bytes: statSync(output).size,
    grid: { cols, rows, capacity: cols * rows, used: timeline.length },
    fps: Number(fps.toFixed(4)),
    perCell: { seconds: Number((1 / fps).toFixed(3)), width: cellWidth },
    range: { from: Number(from.toFixed(3)), to: Number(to.toFixed(3)), span: Number(span.toFixed(3)) },
    timeline,
    source: { file: input, duration, width: info.video.width, height: info.video.height },
    coverage: `每格间隔 ${(1 / fps).toFixed(2)} 秒，覆盖 ${from.toFixed(1)}–${to.toFixed(1)} 秒`,
    ownedDir: ownsDir ? dir : undefined,
  };
}

/** `hh:mm:ss.mmm` for a second offset. */
export function formatClock(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const whole = Math.floor(s);
  const ms = Math.round((s - whole) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(whole).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

/** Render a grid result for a person to read. */
export function formatGrid(result) {
  if (result?.ok !== true) {
    const lines = ['# 宫格生成失败', '', result?.error ?? '未知错误'];
    if (result?.detail) lines.push('', '```', result.detail, '```');
    return lines.join('\n');
  }
  const lines = [
    `# 宫格 ${result.grid.cols}×${result.grid.rows} · ${result.timeline.length} 格`,
    '',
    `- 区间：${result.range.from}–${result.range.to} 秒（共 ${result.range.span} 秒）`,
    `- 采样：${result.fps} fps，每格间隔 ${result.perCell.seconds} 秒`,
    `- 每格宽度：${result.perCell.width}px`,
    `- 文件：${result.path}`,
    '',
    '## 时间轴',
    '',
    '| 格 | 时刻 |',
    '| --- | --- |',
  ];
  for (const cell of result.timeline) {
    lines.push(`| ${cell.n} | ${cell.label} |`);
  }
  lines.push('', `要看更细的一段：传 from/to 并放大 grid，或直接指定时刻取单帧。`);
  return lines.join('\n');
}
