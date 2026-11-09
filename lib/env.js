/**
 * Environment detection for the media pipeline.
 *
 * Every capability this plugin offers depends on something outside the package:
 * ffmpeg for anything involving a container, a Python interpreter with specific
 * libraries for analysis and speech, or a local service listening on a port for
 * generation. Rather than failing mid-operation with an opaque error, one check
 * reports the whole picture up front and names the exact install command for
 * whatever is missing.
 *
 * Detection is read-only. It runs `--version`, imports a module, or probes a TCP
 * port; it never installs anything and never starts a service.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createConnection } from 'node:net';

const run = promisify(execFile);

/** First line of a command's version output, or null when it cannot run. */
async function versionOf(cmd, args = ['--version']) {
  try {
    const { stdout, stderr } = await run(cmd, args, { timeout: 8000, windowsHide: true });
    const line = `${stdout || stderr}`.split('\n').map((s) => s.trim()).filter(Boolean)[0];
    return line ?? 'present';
  }
  catch {
    return null;
  }
}

/**
 * Ask one Python interpreter which modules it can import, and their versions.
 *
 * The interpreter's own version is reported separately: `3.12.14` is the Python
 * version, not the library version, and conflating the two produced a report that
 * named a Pillow version that did not exist.
 */
async function probePython(python) {
  if (python === undefined || python === null) return null;
  const script = [
    'import importlib, json, sys',
    'out = {"version": sys.version.split()[0], "modules": {}, "versions": {}}',
    'for m in ["PIL", "numpy", "librosa", "soundfile", "scipy", "faster_whisper", "edge_tts"]:',
    '    try:',
    '        mod = importlib.import_module(m)',
    '        out["modules"][m] = True',
    '        out["versions"][m] = str(getattr(mod, "__version__", "") or "")',
    '    except Exception:',
    '        out["modules"][m] = False',
    'print(json.dumps(out))',
  ].join('\n');
  try {
    const { stdout } = await run(python, ['-c', script], { timeout: 25000, windowsHide: true });
    return JSON.parse(String(stdout).trim());
  }
  catch {
    return null;
  }
}

/** Candidates worth probing, in the order a user would expect them. */
function pythonCandidates(config) {
  const list = [];
  if (typeof config?.pythonPath === 'string' && config.pythonPath !== '') {
    list.push({ label: '配置指定', path: config.pythonPath });
  }
  const dshPython = process.env.DSH_PYTHON;
  if (dshPython) list.push({ label: 'DSH 运行时', path: dshPython });
  // The DSH runtime ships its own interpreter beside the app.
  const runtimePython = join(
    homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python',
    process.platform === 'win32' ? 'python.exe' : 'python3',
  );
  if (existsSync(runtimePython)) list.push({ label: 'DSH 内置 Python', path: runtimePython });
  list.push({ label: '系统 Python', path: process.platform === 'win32' ? 'python' : 'python3' });
  return list;
}

/** Whether something accepts connections on this loopback port. */
function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    const settle = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1200);
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    socket.once('timeout', () => settle(false));
  });
}

/** The local generation backends people actually run, and their default ports. */
const LOCAL_BACKENDS = [
  { id: 'a1111', label: 'AUTOMATIC1111 / Forge', port: 7860, media: ['image'] },
  { id: 'comfyui', label: 'ComfyUI', port: 8188, media: ['image', 'video'] },
  { id: 'swarmui', label: 'SwarmUI', port: 7801, media: ['image'] },
  { id: 'sdserver', label: 'stable-diffusion.cpp server', port: 8080, media: ['image'] },
];

/**
 * Where faster-whisper keeps downloaded models.
 *
 * huggingface_hub uses `~/.cache/huggingface/hub` on every platform unless
 * HF_HOME overrides it — including Windows, where the AppData convention would
 * suggest otherwise. Checking AppData first reported "no models" on a machine
 * that had one, so both locations are searched.
 */
function whisperCacheDirs() {
  const dirs = [];
  if (process.env.HF_HOME) dirs.push(join(process.env.HF_HOME, 'hub'));
  if (process.env.HFC_HOME) dirs.push(process.env.HFC_HOME);
  dirs.push(join(homedir(), '.cache', 'huggingface', 'hub'));
  if (process.platform === 'win32') {
    dirs.push(join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'huggingface', 'hub'));
  }
  return [...new Set(dirs)];
}

/**
 * Build the report.
 *
 * @param {object} config plugin config: ffmpegPath, pythonPath, asr, image, video.
 */
export async function checkEnvironment(config = {}) {
  const ffmpegCmd = typeof config?.ffmpegPath === 'string' && config.ffmpegPath !== ''
    ? config.ffmpegPath
    : 'ffmpeg';
  const ffmpeg = await versionOf(ffmpegCmd, ['-version']);
  const ffprobe = await versionOf(
    ffmpegCmd.replace(/ffmpeg(\.exe)?$/i, (m) => `ffprobe${m.includes('.exe') ? '.exe' : ''}`),
    ['-version'],
  );

  const interpreters = [];
  for (const candidate of pythonCandidates(config)) {
    const probed = await probePython(candidate.path);
    if (probed !== null) interpreters.push({ ...candidate, ...probed });
  }

  const has = (mod) => interpreters.some((i) => i.modules?.[mod] === true);
  const who = (mod) => interpreters.filter((i) => i.modules?.[mod] === true).map((i) => i.label);
  const ver = (mod) => interpreters.find((i) => i.modules?.[mod] === true)?.versions?.[mod] || undefined;

  // Whisper models are directories named `models--<org>--<model>`.
  let whisperModels = [];
  try {
    const { readdirSync } = await import('node:fs');
    for (const dir of whisperCacheDirs()) {
      if (!existsSync(dir)) continue;
      const found = readdirSync(dir)
        .filter((name) => name.startsWith('models--') && /whisper/i.test(name))
        .map((name) => name.replace(/^models--[^-]+--/, '').replace(/_/g, ' '));
      whisperModels.push(...found);
    }
    whisperModels = [...new Set(whisperModels)];
  }
  catch { /* an unreadable cache is simply "no models found" */ }

  const localBackends = [];
  for (const backend of LOCAL_BACKENDS) {
    localBackends.push({ ...backend, running: await portOpen(backend.port) });
  }

  const groups = {
    container: [
      {
        name: 'ffmpeg',
        ok: ffmpeg !== null,
        version: ffmpeg ?? undefined,
        required: true,
        install: 'winget install Gyan.FFmpeg  (或 https://ffmpeg.org/download.html)',
      },
      {
        name: 'ffprobe',
        ok: ffprobe !== null,
        required: true,
        note: '随 ffmpeg 一起安装',
      },
    ],
    analysis: [
      {
        name: 'librosa',
        ok: has('librosa'),
        version: ver('librosa'),
        python: who('librosa').join(', ') || undefined,
        required: false,
        install: 'pip install librosa',
        neededFor: '节奏 / 音高 / 音色分析',
      },
      {
        name: 'soundfile',
        ok: has('soundfile'),
        version: ver('soundfile'),
        python: who('soundfile').join(', ') || undefined,
        required: false,
        install: 'pip install soundfile',
        note: 'librosa 读音频需要它',
      },
      {
        name: 'numpy',
        ok: has('numpy'),
        version: ver('numpy'),
        python: who('numpy').join(', ') || undefined,
        required: true,
        install: 'pip install numpy',
      },
      {
        name: 'PIL',
        ok: has('PIL'),
        version: ver('PIL'),
        python: who('PIL').join(', ') || undefined,
        required: false,
        install: 'pip install pillow',
        neededFor: '宫格拼图（不用 ffmpeg 拼时）',
      },
    ],
    speech: [
      {
        name: 'faster-whisper',
        ok: has('faster_whisper'),
        version: ver('faster_whisper'),
        python: who('faster_whisper').join(', ') || undefined,
        required: false,
        install: 'pip install faster-whisper',
        neededFor: '本地语音识别',
      },
      {
        name: 'whisper-models',
        ok: whisperModels.length > 0,
        models: whisperModels.length > 0 ? whisperModels : undefined,
        required: false,
        note: whisperModels.length === 0
          ? '首次转写会自动下载；下载失败时设置 HF_ENDPOINT=https://hf-mirror.com'
          : undefined,
      },
      {
        name: 'edge-tts',
        ok: has('edge_tts') || (await versionOf('edge-tts', ['--version'])) !== null,
        version: ver('edge_tts') ?? (await versionOf('edge-tts', ['--version'])) ?? undefined,
        python: who('edge_tts').join(', ') || undefined,
        required: false,
        install: 'pip install edge-tts',
        neededFor: '文字转语音',
      },
    ],
    localGeneration: localBackends.map((backend) => ({
      name: backend.label,
      ok: backend.running,
      port: backend.port,
      media: backend.media,
      required: false,
      note: backend.running ? '正在运行' : '未监听 —— 仅在使用本地生成时需要',
    })),
  };

  const missing = [];
  for (const group of Object.values(groups)) {
    for (const item of group) {
      if (item.required === true && item.ok !== true) missing.push(item.name);
    }
  }

  // Report the split when the analysis libraries and the voice engine live in
  // different interpreters: one script cannot both analyse and synthesise.
  const partial = interpreters.filter((i) => {
    const analysis = i.modules?.librosa === true || i.modules?.numpy === true;
    const voice = i.modules?.edge_tts === true;
    return (voice && !analysis) || (analysis && !voice);
  });
  const conflict = interpreters.length > 1 && partial.length > 0
    && !interpreters.some((i) => i.modules?.librosa === true && i.modules?.edge_tts === true);

  const readyFor = {
    probe: ffprobe !== null,
    storyboard: ffprobe !== null && ffmpeg !== null,
    compose: ffmpeg !== null,
    audioAnalyze: has('librosa') && has('soundfile'),
    transcribeLocal: has('faster_whisper'),
    speak: has('edge_tts') || (await versionOf('edge-tts', ['--version'])) !== null,
    imageLocal: localBackends.some((b) => b.running && b.media.includes('image')),
    videoLocal: localBackends.some((b) => b.running && b.media.includes('video')),
  };

  return {
    checkedAt: new Date().toISOString(),
    platform: process.platform,
    groups,
    missing,
    interpreters: interpreters.map((i) => ({
      label: i.label,
      path: i.path,
      version: i.version,
      modules: i.modules,
    })),
    pythonConflict: conflict
      ? {
        detected: true,
        detail: interpreters.map((i) => `${i.label}：${Object.entries(i.modules).filter(([, v]) => v).map(([k]) => k).join('/') || '无'}`).join('；'),
        advice: '分析与合成要分两步跑，各自用能导入所需模块的解释器',
      }
      : { detected: false },
    readyFor,
    nextStep: missing.length === 0 ? null : `缺少 ${missing.join('、')}`,
  };
}

/** Render the report as text a person can act on. */
export function formatEnvironment(report) {
  const lines = [`# 媒体环境 — ${report.platform}`, ''];
  const headings = {
    container: '容器处理',
    analysis: '音频分析',
    speech: '语音',
    localGeneration: '本地生成服务',
  };
  for (const [key, items] of Object.entries(report.groups)) {
    lines.push(`## ${headings[key] ?? key}`);
    for (const item of items) {
      const mark = item.ok ? '就绪' : (item.required ? '缺失' : '可选');
      const bits = [`- ${item.name}: ${mark}`];
      if (item.version) bits.push(`(${item.version})`);
      if (item.python) bits.push(`在 ${item.python}`);
      if (Array.isArray(item.models) && item.models.length > 0) bits.push(`已下载: ${item.models.join(', ')}`);
      if (item.port) bits.push(`:${item.port}`);
      lines.push(bits.join(' '));
      if (item.ok !== true && item.install) lines.push(`  安装：${item.install}`);
      if (item.neededFor) lines.push(`  用于：${item.neededFor}`);
      if (item.note) lines.push(`  说明：${item.note}`);
    }
    lines.push('');
  }
  lines.push('## 能做');
  const labels = {
    probe: '媒体探测',
    storyboard: '视频宫格',
    compose: '视频组装',
    audioAnalyze: '音频分析',
    transcribeLocal: '本地转写',
    speak: '语音合成',
    imageLocal: '本地生图',
    videoLocal: '本地生视频',
  };
  for (const [key, ok] of Object.entries(report.readyFor)) {
    lines.push(`- ${labels[key] ?? key}: ${ok ? '是' : '否'}`);
  }
  if (report.pythonConflict?.detected === true) {
    lines.push('', '## Python 环境分裂', report.pythonConflict.detail, `建议：${report.pythonConflict.advice}`);
  }
  if (report.nextStep !== null) lines.push('', '## 下一步', report.nextStep);
  return lines.join('\n');
}
