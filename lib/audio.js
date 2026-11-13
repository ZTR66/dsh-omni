/**
 * Audio: analysis, transcription, speech and cutting.
 *
 * The recurring difficulty is that the libraries live in **different Python
 * interpreters**. On this machine librosa is installed in the DSH runtime's
 * Python while edge-tts is installed in the system one. A single script that
 * both analysed and synthesised would fail at import time, so each operation
 * runs in the interpreter that can actually do it, and `env.js` reports the
 * split rather than hiding it.
 *
 * Everything that shells out passes an argv array, never a shell string: paths
 * and text come from the caller and a filename containing a quote must not be
 * able to change the command.
 */

import { execFile } from 'node:child_process';
import { existsSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ffmpeg, resolveBinary } from './ffmpeg.js';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = join(HERE, '..', 'scripts');

/**
 * Force UTF-8 on a Python child's pipes.
 *
 * On Windows Python defaults stdin/stdout to the console code page. A script that
 * prints `json.dumps(..., ensure_ascii=False)` therefore emits GBK-encoded bytes
 * while Node decodes them as UTF-8, and every Chinese character arrives as a
 * replacement character — the data was always correct, only the pipe was wrong.
 */
const PYTHON_UTF8_ENV = {
  PYTHONIOENCODING: 'utf-8',
  PYTHONUTF8: '1',
};

/** The interpreter that has librosa, preferring the runtime's own. */
async function analysisPython(config) {
  const candidates = [];
  if (typeof config?.pythonPath === 'string' && config.pythonPath !== '') candidates.push(config.pythonPath);
  if (process.env.DSH_PYTHON) candidates.push(process.env.DSH_PYTHON);
  const runtime = join(
    process.env.USERPROFILE ?? process.env.HOME ?? '',
    '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python',
    process.platform === 'win32' ? 'python.exe' : 'python3',
  );
  if (existsSync(runtime)) candidates.push(runtime);
  candidates.push(process.platform === 'win32' ? 'python' : 'python3');

  for (const python of candidates) {
    try {
      await run(python, ['-c', 'import librosa'], { timeout: 25000, windowsHide: true });
      return python;
    }
    catch { /* try the next interpreter */ }
  }
  return null;
}

/** The interpreter that has edge-tts, which is often the system one. */
async function speechPython(config) {
  const candidates = [];
  if (typeof config?.pythonPath === 'string' && config.pythonPath !== '') candidates.push(config.pythonPath);
  if (process.env.DSH_PYTHON) candidates.push(process.env.DSH_PYTHON);
  const runtime = join(
    process.env.USERPROFILE ?? process.env.HOME ?? '',
    '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python',
    process.platform === 'win32' ? 'python.exe' : 'python3',
  );
  if (existsSync(runtime)) candidates.push(runtime);
  candidates.push(process.platform === 'win32' ? 'python' : 'python3');

  for (const python of candidates) {
    try {
      await run(python, ['-c', 'import edge_tts'], { timeout: 20000, windowsHide: true });
      return python;
    }
    catch { /* try the next interpreter */ }
  }
  return null;
}

/**
 * Analyse one audio file.
 *
 * The numbers come from `scripts/analyze.py`; this wrapper only validates the
 * input and turns a failed process into a readable message instead of a stack
 * trace. A missing library is reported with its install line, because "cannot
 * decode" from a missing soundfile is not actionable on its own.
 */
export async function analyseAudio(config, request = {}) {
  const input = typeof request?.input === 'string' ? request.input : '';
  if (input === '') return { ok: false, error: 'input is required' };
  if (!existsSync(input)) return { ok: false, error: `file not found: ${input}` };

  const python = await analysisPython(config);
  if (python === null) {
    return {
      ok: false,
      error: '找不到安装了 librosa 的 Python',
      install: 'pip install librosa soundfile numpy',
      hint: '运行 omni_env_check 查看每个解释器里有什么',
    };
  }

  // librosa reads audio containers, not video ones — feeding it an .mp4 fails
  // with "Format not recognised", which names neither the cause nor the fix.
  // transcribeAudio already decoded with `-vn` before handing the file on; this
  // path did not, so the same input that transcribes fine failed to analyse.
  // Decode to 16 kHz mono WAV first, which is what the analysis measures anyway.
  let audioPath = input;
  let decodedWav = null;
  if (/\.(mp4|mov|mkv|avi|webm|m4v|flv|wmv)$/i.test(input)) {
    decodedWav = join(
      process.env.TEMP ?? process.env.TMPDIR ?? '.',
      `omni-analyse-${Date.now()}.wav`,
    );
    const decoded = await ffmpeg(config, ['-i', input, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', decodedWav], {
      timeoutMs: 300000,
    });
    if (decoded.ok !== true) {
      return { ok: false, error: '无法提取音频轨', detail: (decoded.log ?? '').split('\n').slice(-6).join('\n') };
    }
    audioPath = decodedWav;
  }

  const script = join(SCRIPT_DIR, 'analyze.py');
  try {
    const { stdout } = await run(python, [script, audioPath], {
      timeout: 300000,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, ...PYTHON_UTF8_ENV },
    });
    const parsed = JSON.parse(stdout);
    return parsed;
  }
  catch (error) {
    return {
      ok: false,
      error: '音频分析失败',
      detail: String(error?.stderr ?? error?.message ?? error).split('\n').slice(-6).join('\n'),
    };
  }
  finally {
    // The decoded WAV is an intermediate; leaving it behind fills %TEMP%.
    if (decodedWav !== null) {
      try { rmSync(decodedWav, { force: true }); } catch { /* best effort */ }
    }
  }
}

/** Render an analysis result for a person to read. */
export function formatAnalysis(result) {
  if (result?.ok !== true) {
    const lines = ['# 音频分析失败', '', result?.error ?? '未知错误'];
    if (result?.install) lines.push('', `安装：${result.install}`);
    if (result?.hint) lines.push(`提示：${result.hint}`);
    if (result?.detail) lines.push('', '```', result.detail, '```');
    return lines.join('\n');
  }

  const lines = [
    `# ${String(result.file).split(/[\\/]/).pop()}`,
    '',
    `- 时长：${result.duration} 秒`,
    `- 采样率：${result.sampleRate} Hz`,
    '',
    '## 响度',
    `- RMS：${result.dynamics.rmsDb} dBFS`,
    `- 峰值：${result.dynamics.peakDb} dBFS`,
    `- 峰均比：${result.dynamics.crestDb} dB`,
    '',
    '## 节奏',
  ];

  const tempo = result.tempo ?? {};
  if (tempo.error) {
    lines.push(`- 检测失败：${tempo.error}`);
  }
  else if (tempo.detected === false) {
    lines.push(`- ${tempo.note ?? '未检测到节拍'}`);
  }
  else {
    lines.push(`- BPM：${tempo.bpm}`);
    lines.push(`- 拍点数：${tempo.beats}`);
    lines.push(`- 规律性：${tempo.regularity}（1.0 = 完全等距）`);
  }

  const tonality = result.tonality ?? {};
  lines.push('', '## 音高');
  if (tonality.error) {
    lines.push(`- 检测失败：${tonality.error}`);
  }
  else {
    lines.push(`- 估计调性：**${tonality.estimatedKey}**`);
    lines.push(`- 主要音：${(tonality.topPitches ?? []).join(', ')}`);
    const chroma = tonality.chroma ?? {};
    const strongest = Object.entries(chroma).sort((a, b) => b[1] - a[1]).slice(0, 6);
    lines.push(`- 音级分布（前 6）：${strongest.map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  }

  const timbre = result.timbre ?? {};
  lines.push('', '## 音色');
  if (timbre.error) {
    lines.push(`- 检测失败：${timbre.error}`);
  }
  else {
    // The absolute numbers mean little alone; the parenthetical reading is what
    // makes them usable, and it is derived from the number, not guessed.
    const brightness = timbre.centroidHz > 3000 ? '偏亮' : timbre.centroidHz > 1200 ? '中等' : '偏暗';
    const noisiness = timbre.zeroCrossRate > 0.1 ? '偏噪' : timbre.zeroCrossRate > 0.03 ? '中等' : '偏纯净';
    lines.push(`- 频谱质心：${timbre.centroidHz} Hz（${brightness}）`);
    lines.push(`- 85% 滚降点：${timbre.rolloffHz} Hz`);
    lines.push(`- 过零率：${timbre.zeroCrossRate}（${noisiness}）`);
  }

  if (Array.isArray(result.sections) && result.sections.length > 0) {
    lines.push('', '## 能量变化');
    for (const section of result.sections.slice(0, 20)) {
      lines.push(`- ${section.at}s 起：${section.level}（${section.energy}）`);
    }
  }

  return lines.join('\n');
}

/**
 * Transcribe one audio file.
 *
 * Three routes are tried in order, and each one that is skipped says why:
 *
 *   1. an explicitly configured provider or the Host's `speechToText` service
 *   2. the local faster-whisper install
 *   3. nothing — reported with the command to install a recogniser
 *
 * The Host route is checked first because a host-provided recogniser is assumed
 * to be the deployment's intended one. The local route exists so a machine with
 * no host recogniser can still work offline.
 */
export async function transcribeAudio(ctx, config, request = {}) {
  const input = typeof request?.input === 'string' ? request.input : '';
  if (input === '') return { ok: false, error: 'input is required' };
  if (!existsSync(input)) return { ok: false, error: `file not found: ${input}` };

  const language = typeof request?.language === 'string' && request.language !== ''
    ? request.language
    : 'zh';
  const mode = String(config?.asr?.mode ?? 'auto');

  // Route 1 — the Host's own recogniser, when it has one.
  if (mode !== 'local') {
    const hostResult = await tryHostTranscription(ctx, input, language);
    if (hostResult !== null) return hostResult;
  }

  if (mode === 'cloud') {
    return {
      ok: false,
      error: '配置为云端识别，但宿主没有注册可用的识别器',
      hint: '在 DSH 设置里配置语音识别 provider，或把 asr.mode 改成 local 使用本地模型',
    };
  }

  // Route 2 — local faster-whisper.
  return transcribeLocal(config, input, language, request);
}

/** Ask the Host's speechToText service, if it exists and is ready. */
async function tryHostTranscription(ctx, input, language) {
  let service;
  try {
    service = ctx?.get?.('speechToText');
  }
  catch {
    return null;
  }
  if (!service || typeof service.transcribe !== 'function') return null;

  try {
    const snapshot = typeof service.snapshot === 'function' ? service.snapshot() : null;
    const providers = snapshot?.providers ?? [];
    const ready = providers.find((p) => p.preparation?.phase === 'ready')
      ?? providers.find((p) => p.preparation?.phase === 'standby')
      ?? providers[0];
    if (ready === undefined) return null;

    const audio = readFileSync(input);
    const spec = service.resolve({
      audio: new Uint8Array(audio),
      providerId: ready.id,
      language,
    });
    const controller = new AbortController();
    const transcript = await service.transcribe(spec, controller.signal);
    return {
      ok: true,
      route: 'host',
      provider: ready.name ?? String(ready.id),
      file: input,
      language,
      text: transcript.text ?? '',
      audioSeconds: transcript.audioSeconds ?? null,
      inferenceSeconds: transcript.inferenceSeconds ?? null,
    };
  }
  catch (error) {
    // A host recogniser that exists but fails is reported rather than silently
    // falling through, because the failure reason is usually actionable.
    return {
      ok: false,
      route: 'host',
      error: '宿主语音识别失败',
      detail: String(error?.message ?? error),
      hint: '可以改用本地识别：把 asr.mode 设为 local',
    };
  }
}

/**
 * Local transcription through faster-whisper.
 *
 * The audio is decoded to a float32 array here rather than handed to whisper as
 * a path. faster-whisper 1.2.1 calls PyAV with a `metadata_errors` keyword that
 * the installed PyAV rejects, so passing a path raises
 * `TypeError: open() got an unexpected keyword argument 'metadata_errors'`.
 * Feeding it samples bypasses PyAV entirely.
 */
async function transcribeLocal(config, input, language, request) {
  const python = await analysisPython(config);
  if (python === null) {
    return {
      ok: false,
      error: '找不到可用的 Python',
      install: 'pip install faster-whisper',
    };
  }

  // Decode to 16 kHz mono PCM first: whisper expects that rate and the
  // conversion is one ffmpeg call.
  const wav = join(
    process.env.TEMP ?? process.env.TMPDIR ?? '.',
    `omni-asr-${Date.now()}.wav`,
  );
  const decoded = await ffmpeg(config, ['-i', input, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', wav], {
    timeoutMs: 300000,
  });
  if (decoded.ok !== true) {
    return { ok: false, error: '无法提取音频轨', detail: (decoded.log ?? '').split('\n').slice(-6).join('\n') };
  }

  const model = typeof request?.model === 'string' && request.model !== ''
    ? request.model
    : String(config?.asr?.localModel ?? 'small');

  const script = join(SCRIPT_DIR, 'transcribe.py');
  try {
    const { stdout } = await run(python, [script, wav, model, language], {
      timeout: 1800000,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        // Python defaults stdio to the console code page on Windows, so a
        // `json.dumps(..., ensure_ascii=False)` payload comes back as mojibake
        // even though the data is correct. Forcing UTF-8 on the pipe fixes it.
        ...PYTHON_UTF8_ENV,
        // huggingface.co intermittently answers 502 from this network; the
        // mirror serves the same files. Only used when the model is not cached.
        HF_ENDPOINT: process.env.HF_ENDPOINT ?? 'https://hf-mirror.com',
      },
    });
    const parsed = JSON.parse(stdout);
    if (parsed?.ok === true) {
      return { ...parsed, route: 'local', file: input, model };
    }
    return parsed;
  }
  catch (error) {
    return {
      ok: false,
      route: 'local',
      error: '本地识别失败',
      detail: String(error?.stderr ?? error?.message ?? error).split('\n').slice(-8).join('\n'),
    };
  }
}

/** Render a transcript for a person to read. */
export function formatTranscript(result) {
  if (result?.ok !== true) {
    const lines = ['# 转写失败', '', result?.error ?? '未知错误'];
    if (result?.detail) lines.push('', '```', result.detail, '```');
    if (result?.install) lines.push('', `安装：${result.install}`);
    if (result?.hint) lines.push(`提示：${result.hint}`);
    return lines.join('\n');
  }

  const lines = [
    `# 转写完成`,
    '',
    `- 来源：${String(result.file).split(/[\\/]/).pop()}`,
    `- 通道：${result.route === 'host' ? '宿主识别器' : '本地 faster-whisper'}${result.model ? `（${result.model}）` : ''}`,
    `- 语种：${result.language ?? '自动'}`,
  ];
  if (result.audioSeconds !== undefined && result.audioSeconds !== null) {
    lines.push(`- 音频时长：${result.audioSeconds} 秒`);
  }
  lines.push('');

  if (Array.isArray(result.segments) && result.segments.length > 0) {
    lines.push('## 时间码文本', '');
    for (const segment of result.segments) {
      lines.push(`**[${segment.start.toFixed(2)} – ${segment.end.toFixed(2)}]** ${segment.text}`);
    }
    lines.push('');
    lines.push('## 全文', '', result.text ?? '');
  }
  else {
    lines.push('## 全文', '', result.text ?? '');
  }
  return lines.join('\n');
}

/**
 * Synthesise speech with edge-tts.
 *
 * edge-tts lives in the system Python on this machine while librosa lives in the
 * DSH runtime's, so the interpreter is resolved specifically for it. The text is
 * passed through a temporary file rather than as an argument: a long paragraph
 * would otherwise hit the command-line length limit, and quoting a paragraph
 * safely through a shell is exactly the kind of thing that goes wrong.
 */
export async function speakAudio(config, request = {}) {
  const text = typeof request?.text === 'string' ? request.text.trim() : '';
  if (text === '') return { ok: false, error: 'text is required' };
  if (text.length > 20000) return { ok: false, error: 'text is limited to 20000 characters per call' };

  const voice = typeof request?.voice === 'string' && request.voice !== ''
    ? request.voice
    : 'zh-CN-YunyangNeural';
  const rate = typeof request?.rate === 'string' ? request.rate : '+0%';
  const outDir = typeof request?.outDir === 'string' && request.outDir !== ''
    ? request.outDir
    : join(process.cwd(), 'omni-speech');

  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(outDir, { recursive: true });
  const stamp = Date.now();
  const textFile = join(outDir, `.text-${stamp}.txt`);
  const output = join(outDir, `speech-${stamp}.mp3`);
  writeFileSync(textFile, text, 'utf8');

  const python = await speechPython(config);
  // Written to the temp directory, not to `scripts/`: that folder ships in the
  // package, and a file the plugin generates on first use has no business
  // appearing in a published tarball or in the repository.
  const scriptFile = join(tmpdir(), 'omni-speak.py');
  const fsPromises = await import('node:fs');
  fsPromises.mkdirSync(dirname(scriptFile), { recursive: true });
  fsPromises.writeFileSync(scriptFile, SPEAK_HELPER, 'utf8');

  const command = python === null ? null : [python, [scriptFile, textFile, output, voice, rate]];
  // edge-tts is also installed as a standalone console command on some setups;
  // prefer it when the Python module is missing.
  const ffmpegBinary = resolveBinary(config, 'ffmpeg');

  try {
    if (command !== null) {
      await run(command[0], command[1], { timeout: 300000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    }
    else {
      await run('edge-tts', ['--voice', voice, '--rate', rate, '--file', textFile, '--write-media', output], {
        timeout: 300000, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
      });
    }
  }
  catch (error) {
    return {
      ok: false,
      error: '语音合成失败',
      detail: String(error?.stderr ?? error?.message ?? error).split('\n').slice(-6).join('\n'),
      install: python === null ? 'pip install edge-tts' : undefined,
    };
  }
  finally {
    try {
      const { rmSync } = await import('node:fs');
      rmSync(textFile, { force: true });
    }
    catch { /* the temp text file is harmless if it survives */ }
  }

  if (!existsSync(output)) {
    return { ok: false, error: 'edge-tts 报告成功但没有生成文件' };
  }

  // Probe the result so the caller gets a real duration rather than a guess.
  const info = await run(ffmpegBinary, ['-i', output], { timeout: 30000, windowsHide: true })
    .then(({ stderr }) => stderr)
    .catch((error) => String(error?.stderr ?? ''));
  const match = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(info);
  const seconds = match === null ? null : Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);

  return {
    ok: true,
    path: output,
    bytes: statSync(output).size,
    voice,
    rate,
    characters: text.length,
    seconds: seconds === null ? null : Number(seconds.toFixed(2)),
    // 5.5–6 characters per second is the pace a knowledge short reads at; a
    // wildly different ratio usually means the voice or rate is wrong.
    charsPerSecond: seconds === null || seconds === 0 ? null : Number((text.length / seconds).toFixed(2)),
  };
}

/** Render a speech result for a person to read. */
export function formatSpeech(result) {
  if (result?.ok !== true) {
    const lines = ['# 语音合成失败', '', result?.error ?? '未知错误'];
    if (result?.detail) lines.push('', '```', result.detail, '```');
    if (result?.install) lines.push('', `安装：${result.install}`);
    return lines.join('\n');
  }
  const lines = [
    '# 语音已生成',
    '',
    `- 文件：${result.path}`,
    `- 时长：${result.seconds ?? '未知'} 秒`,
    `- 音色：${result.voice}`,
    `- 语速：${result.rate}`,
    `- 字数：${result.characters}`,
    `- 大小：${Math.round(result.bytes / 1024)} KB`,
  ];
  if (result.charsPerSecond !== null) {
    const pace = result.charsPerSecond;
    const reading = pace < 3 ? '偏慢' : pace > 8 ? '偏快' : '正常';
    lines.push(`- 语速实测：${pace} 字/秒（${reading}，知识片通常 5.5–6）`);
  }
  return lines.join('\n');
}

/** Written on first use so the package ships without a build step. */
const SPEAK_HELPER = `import asyncio, sys, pathlib

async def main():
    text_file, output, voice, rate = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    text = pathlib.Path(text_file).read_text(encoding='utf-8')
    try:
        import edge_tts
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)
    communicate = edge_tts.Communicate(text, voice, rate=rate)
    await communicate.save(output)

asyncio.run(main())
`;
