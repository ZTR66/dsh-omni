/**
 * Image generation and editing.
 *
 * The adapter differences live in `image-adapters.js`; this file does the work
 * that is the same for every provider: resolve a credential, build the request,
 * wait for an async task if the platform enqueues one, then put the bytes on
 * disk where the caller can find them.
 *
 * Two details worth stating because they are easy to get wrong:
 *
 * **Credentials are read from the DSH credential store, never from config.**
 * The plugin config holds a reference name (`apiKeyEnv`) and the service resolves
 * it per request, so rotating a key does not require editing a file and the key
 * never reaches the browser.
 *
 * **A finished image is written to a file and reported by path.** The Host's
 * tool-output render supports text blocks; returning an `{ type: 'image' }` block
 * from a tool result made the entire result disappear on this build, so the
 * markdown link plus the saved path is what works.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveImageAdapter, fitSize, buildBody,
  readImage, readTaskId, readTaskState,
} from './image-adapters.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolve the API key for one provider through the credential service. */
/**
 * Resolve the API key for one provider.
 *
 * The field is named `apiKeyEnv` because the intended value is a credential
 * reference: the name of a key the Host stores, so the secret never lands in the
 * patch file. A settings page that pastes a key directly into that field is a
 * mistake that has to keep working, though — the alternative is a plugin that
 * silently refuses to generate with a perfectly good key sitting in its config.
 *
 * So the value is classified rather than trusted:
 *
 *   - it looks like a credential reference (`SOMETHING_API_KEY`, uppercase) → resolve it
 *   - it looks like a secret (has the shape providers issue) → use it as-is
 *   - either way, fall back to the environment under that name
 *
 * A resolved value is never logged and never returned to a browser.
 */
async function resolveKey(ctx, provider) {
  // An inline key under its own field is unambiguous.
  if (typeof provider?.key === 'string' && provider.key.trim() !== '') return provider.key.trim();

  const raw = typeof provider?.apiKeyEnv === 'string' ? provider.apiKeyEnv.trim() : '';
  if (raw === '') return '';

  // A reference name is an identifier: upper-case with underscores, ending in
  // _API_KEY or _KEY. A secret contains lower-case, digits, or punctuation that
  // an identifier cannot.
  const looksLikeRef = /^[A-Z][A-Z0-9_]*$/.test(raw) && /_API_KEY$|_KEY$|_TOKEN$/.test(raw);
  if (looksLikeRef === false) {
    // Not a reference: it is the key itself.
    return raw;
  }

  const credentials = (() => {
    try {
      return ctx?.get?.('credentials');
    }
    catch {
      return undefined;
    }
  })();

  if (credentials && typeof credentials.resolve === 'function') {
    try {
      const resolved = await credentials.resolve(raw);
      const value = resolved?.value ?? resolved;
      if (typeof value === 'string' && value !== '') return value;
    }
    catch { /* fall through to the environment */ }
  }

  const fromEnv = process.env[raw];
  return typeof fromEnv === 'string' ? fromEnv : '';
}

/** Join a base URL and a path without doubling or dropping a slash. */
function joinUrl(base, path) {
  const left = String(base ?? '').replace(/\/+$/, '');
  const right = String(path ?? '');
  if (right === '') return left;
  return `${left}/${right.replace(/^\/+/, '')}`;
}

/** One HTTP call with a timeout and a readable failure. */
async function callJson(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let payload = null;
    try {
      payload = text === '' ? null : JSON.parse(text);
    }
    catch {
      payload = null;
    }
    if (!response.ok) {
      const detail = payload === null
        ? text.slice(0, 400)
        : JSON.stringify(payload).slice(0, 400);
      return { ok: false, status: response.status, detail, payload };
    }
    return { ok: true, status: response.status, payload, text };
  }
  catch (error) {
    const aborted = error?.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      detail: aborted ? `请求超时（${Math.round(timeoutMs / 1000)} 秒）` : String(error?.message ?? error),
    };
  }
  finally {
    clearTimeout(timer);
  }
}

/** Download an image URL into memory. */
async function download(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return { ok: false, error: `下载图片失败：HTTP ${response.status}` };
    const buffer = Buffer.from(await response.arrayBuffer());
    const mediaType = response.headers.get('content-type') ?? 'image/png';
    return { ok: true, bytes: buffer, mediaType };
  }
  catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
  finally {
    clearTimeout(timer);
  }
}

/** Build the Gemini request, whose body shares nothing with the OpenAI shape. */
function buildGeminiRequest(model, prompt) {
  return {
    contents: [{ parts: [{ text: prompt }] }],
  };
}

/** Read the image out of a Gemini response. */
function readGeminiResponse(payload) {
  const candidates = payload?.candidates;
  if (!Array.isArray(candidates)) return null;
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const inline = part?.inlineData ?? part?.inline_data;
      if (inline && typeof inline.data === 'string') {
        return { kind: 'base64', data: inline.data, mediaType: inline.mimeType ?? inline.mime_type };
      }
    }
  }
  return null;
}

/**
 * Generate one image.
 *
 * @param {object} ctx plugin context, used for the credential service.
 * @param {object} request `{ providers, providerId?, model?, prompt, size?, n? }`.
 */
export async function generateImage(ctx, request = {}) {
  const prompt = typeof request?.prompt === 'string' ? request.prompt.trim() : '';
  if (prompt === '') return { ok: false, error: 'prompt is required' };

  const providers = Array.isArray(request?.providers) ? request.providers : [];
  if (providers.length === 0) {
    return {
      ok: false,
      error: '没有配置图片生成服务',
      hint: '在插件设置里添加一个提供商：baseUrl、模型 id、密钥引用名（apiKeyEnv）',
    };
  }

  const provider = request?.providerId === undefined
    ? providers[0]
    : (providers.find((p) => p.id === request.providerId) ?? providers[0]);
  const model = typeof request?.model === 'string' && request.model !== ''
    ? request.model
    : (Array.isArray(provider.models) && provider.models.length > 0 ? provider.models[0] : '');

  const adapter = resolveImageAdapter(provider, model);
  const key = await resolveKey(ctx, provider);
  // A local adapter needs no key; a cloud one without a key fails here rather
  // than at the provider with an opaque 401.
  if (key === '' && adapter.local !== true) {
    return {
      ok: false,
      error: `「${provider.name ?? provider.id}」没有可用的密钥`,
      hint: '在凭据库或环境变量里配置 apiKeyEnv 指向的引用',
    };
  }

  const fitted = fitSize(adapter, request?.size);
  // Parsed once here so the crop decision later does not re-parse a string.
  //
  // This is deliberately independent of `adapter.supportsSize`: a provider that
  // rejects a size field still has to honour the shape the caller asked for, so
  // the crop is the fallback. Mona returns 1408×768 for a `1024x1024` request and
  // answers 400 for any ratio field, so cropping is the only path to a square.
  const ratioSource = /^\d+\s*[x*×]\s*\d+$/i.test(String(request?.size ?? '').trim())
    ? String(request.size).trim()
    : String(fitted.size ?? '').trim();
  const ratioMatch = /^(\d+)\s*[x*×]\s*(\d+)$/i.exec(ratioSource);
  const requestedRatio = ratioMatch === null
    ? null
    : Number(ratioMatch[1]) / Number(ratioMatch[2]);
  const outDir = typeof request?.outDir === 'string' && request.outDir !== ''
    ? request.outDir
    : join(process.cwd(), 'omni-images');
  mkdirSync(outDir, { recursive: true });

  const headers = {
    ...(adapter.headers ?? {}),
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
  // Per-request headers may be functions so a nonce can differ each call.
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'function') headers[name] = value();
  }
  if (adapter.id === 'google-gemini') {
    delete headers.Authorization;
    headers['x-goog-api-key'] = key;
  }

  const body = adapter.custom === 'gemini'
    ? buildGeminiRequest(model, prompt)
    : buildBody(adapter, {
      model,
      prompt,
      negativePrompt: request?.negativePrompt,
      size: fitted.size,
      n: Math.max(1, Math.min(4, Number(request?.n ?? 1))),
      quality: request?.quality,
    });

  const started = Date.now();
  const url = joinUrl(provider.baseUrl, adapter.endpoints?.generate ?? '/images/generations');
  let image = null;
  let taskId = null;

  if (adapter.async === true) {
    const submitted = await callJson(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }, 120000);
    if (submitted.ok !== true) {
      return {
        ok: false,
        error: `提交任务失败（HTTP ${submitted.status}）`,
        detail: submitted.detail,
        adapter: adapter.id,
      };
    }
    taskId = readTaskId(adapter, submitted.payload);
    if (taskId === null) {
      return {
        ok: false,
        error: '提交后没有拿到任务 id',
        detail: JSON.stringify(submitted.payload).slice(0, 400),
        adapter: adapter.id,
      };
    }

    const poll = adapter.poll ?? {};
    const deadline = Date.now() + (Number(poll.timeoutMs) || 300000);
    let interval = Number(poll.intervalMs) || 2000;
    let last = null;
    while (Date.now() < deadline) {
      await sleep(interval);
      const polled = await callJson(
        joinUrl(provider.baseUrl, String(poll.path ?? '/tasks/{taskId}').replace('{taskId}', encodeURIComponent(taskId))),
        { method: 'GET', headers },
        60000,
      );
      if (polled.ok !== true) {
        last = { state: 'pending', status: `HTTP ${polled.status}` };
        interval = Math.min(Math.round(interval * 1.3), 6000);
        continue;
      }
      last = readTaskState(adapter, polled.payload);
      if (last.state === 'done') {
        image = readImage(last.node) ?? readImage(polled.payload);
        break;
      }
      if (last.state === 'failed') {
        return { ok: false, error: `任务失败（${last.status}）`, detail: last.message, taskId };
      }
      interval = Math.min(Math.round(interval * 1.2), 5000);
    }
    if (image === null) {
      return {
        ok: false,
        error: `任务超时${last === null ? '' : `（最后状态 ${last.status}）`}`,
        taskId,
      };
    }
  }
  else {
    const called = await callJson(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }, 180000);
    if (called.ok !== true) {
      return {
        ok: false,
        error: `请求失败（HTTP ${called.status}）`,
        detail: called.detail,
        adapter: adapter.id,
      };
    }
    image = adapter.custom === 'gemini'
      ? readGeminiResponse(called.payload)
      : readImage(called.payload);
    if (image === null) {
      return {
        ok: false,
        error: '响应里没有找到图片',
        detail: JSON.stringify(called.payload ?? {}).slice(0, 400),
        adapter: adapter.id,
      };
    }
  }

  // Turn whatever we got into bytes on disk.
  let bytes;
  let mediaType = 'image/png';
  if (image.kind === 'base64') {
    const cleaned = image.data.replace(/^data:[^;]+;base64,/, '');
    bytes = Buffer.from(cleaned, 'base64');
    if (typeof image.mediaType === 'string') mediaType = image.mediaType;
  }
  else {
    const fetched = await download(image.url, 120000);
    if (fetched.ok !== true) return { ok: false, error: fetched.error };
    bytes = fetched.bytes;
    mediaType = fetched.mediaType;
  }

  // Trust the bytes over the declared type.
  //
  // A base64 response frequently carries no media type, and defaulting to PNG
  // then wrote a JPEG under a .png name — a file whose extension lies, which
  // breaks later steps that trust it. The magic number is authoritative.
  mediaType = sniffMediaType(bytes) ?? mediaType;

  const extension = mediaType.includes('jpeg') ? 'jpg'
    : mediaType.includes('webp') ? 'webp'
      : mediaType.includes('gif') ? 'gif' : 'png';
  const path = join(outDir, `image-${Date.now()}.${extension}`);
  writeFileSync(path, bytes);

  // Some platforms decide the aspect ratio themselves and reject a ratio field:
  // Mona answers 400 `request body does not match the documented input schema`
  // for `aspectRatio`, and returns 768×1376 for a prompt asking for a square.
  // Cropping to the requested shape afterwards is the only way to honour the
  // request, and it is reported so the caller knows the file was adjusted.
  let finalPath = path;
  let cropped = null;
  if (requestedRatio !== null) {
    const crop = await cropToRatio(request.ffmpegConfig ?? {}, path, requestedRatio, outDir);
    if (crop !== null) {
      finalPath = crop.path;
      cropped = { from: crop.from, to: crop.to };
    }
  }

  return {
    ok: true,
    path: finalPath,
    bytes: existsSync(finalPath) ? statSync(finalPath).size : bytes.length,
    mediaType,
    provider: provider.name ?? provider.id,
    model,
    adapter: adapter.id,
    size: fitted.size,
    sizeAdjusted: fitted.adjusted === true ? fitted.requested : undefined,
    cropped,
    taskId,
    seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
  };
}

/**
 * Identify an image from its magic number.
 *
 * Providers are inconsistent about declaring a media type — some omit it
 * entirely, some return `application/octet-stream` for a JPEG — so the bytes are
 * the only reliable source. Returns null for anything unrecognised, letting the
 * caller keep whatever it already had.
 */
function sniffMediaType(bytes) {
  if (bytes === undefined || bytes.length < 12) return null;
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (bytes.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  return null;
}

/**
 * Crop an image to a target aspect ratio.
 *
 * Only called when the provider ignored the requested shape. Returns null when
 * the image already matches or ffprobe/ffmpeg cannot handle it — a failed crop
 * must not lose an otherwise good render.
 */
async function cropToRatio(config, path, ratio, outDir) {
  const { probe } = await import('./ffmpeg.js');
  const info = await probe(config, path);
  if (info.ok !== true || info.video === null) return null;

  const { width, height } = info.video;
  const current = width / height;
  if (Math.abs(current - ratio) < 0.02) return null;

  // Fit the requested ratio inside the existing image, then centre-crop.
  let cropWidth = width;
  let cropHeight = Math.round(width / ratio);
  if (cropHeight > height) {
    cropHeight = height;
    cropWidth = Math.round(height * ratio);
  }
  const x = Math.round((width - cropWidth) / 2);
  const y = Math.round((height - cropHeight) / 2);

  const { ffmpeg } = await import('./ffmpeg.js');
  const output = join(outDir, `image-${Date.now()}-crop${path.slice(path.lastIndexOf('.'))}`);
  const result = await ffmpeg(config, [
    '-i', path,
    '-vf', `crop=${cropWidth}:${cropHeight}:${x}:${y}`,
    output,
  ], { timeoutMs: 60000 });

  if (result.ok !== true || !existsSync(output)) return null;
  return {
    path: output,
    from: `${width}×${height}`,
    to: `${cropWidth}×${cropHeight}`,
  };
}

/** Render an image result for a person to read. */
export function formatImage(result) {
  if (result?.ok !== true) {
    const lines = ['# 生图失败', '', result?.error ?? '未知错误'];
    if (result?.detail) lines.push('', '```', String(result.detail).slice(0, 600), '```');
    if (result?.hint) lines.push('', `提示：${result.hint}`);
    if (result?.taskId) lines.push(`\n任务 id：${result.taskId}（可凭它到平台后台查看）`);
    return lines.join('\n');
  }
  const lines = [
    '# 图片已生成',
    '',
    `- 文件：${result.path}`,
    `- 尺寸：${result.size}`,
    `- 格式：${result.mediaType}`,
    `- 大小：${Math.round(result.bytes / 1024)} KB`,
    `- 服务：${result.provider}（${result.adapter}）`,
    `- 模型：${result.model}`,
    `- 耗时：${result.seconds} 秒`,
  ];
  if (result.sizeAdjusted !== undefined) {
    lines.push(`- 注意：请求 ${result.sizeAdjusted}，模型不支持，已用最接近的 ${result.size}`);
  }
  return lines.join('\n');
}
