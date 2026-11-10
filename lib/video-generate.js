/**
 * Video generation.
 *
 * Two things make this different from image generation, and both are about
 * restraint rather than capability:
 *
 * **Capability gating.** A generation model is the most expensive and least
 * controllable tool here: it bills per clip, and changing one word means paying
 * again. The failure this guards against is a caller reaching for it because it
 * is available rather than because it is needed — a title card, a chart or a
 * transition can all be drawn by code for nothing. `checkCapability` refuses
 * those outright, whatever fraction of the film they represent.
 *
 * **Consent.** Anything that survives the capability check still needs either an
 * explicit user request or an approval. The approval goes through the Host's own
 * `approval` service so the decision is logged with the session rather than
 * asserted by the model. `unavailable` is treated as a refusal: a deployment
 * that cannot ask is a deployment that does not get to spend money.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePublicUrl } from './image-host.js';

/**
 * Scenes that code can draw. A `generate` entry naming one of these is refused.
 *
 * The list is by *genre*, because that is what a caller can self-report honestly.
 * "A bar chart" is drawable; "a real wave crashing" is not. Anything not on
 * either list is allowed but must state its reason, which is checked for being
 * substantive.
 */
export const CODE_DRAWABLE = [
  { match: /文字|标题|字幕|排版|文字卡|片头|片尾|text|title|caption|typography/i,
    why: '文字与排版用 drawtext 或 SVG 渲染，精确可控' },
  { match: /图表|数据|柱状|折线|饼图|统计|计数器|进度条|chart|graph|data|counter|progress/i,
    why: '图表和计数用代码直接绘制，数值精确' },
  { match: /几何|色块|圆形|方形|线条|图标|logo|图形|geometric|shape|icon|circle|square/i,
    why: '几何图形用 Canvas 或 SVG 绘制' },
  { match: /转场|遮罩|淡入|淡出|过渡|擦除|transition|fade|wipe|mask/i,
    why: '转场用 ffmpeg 滤镜，零成本且可复现' },
  { match: /界面|页面|UI|演示|截图|窗口|dashboard|interface|screen/i,
    why: '界面演示用截图加动效' },
  { match: /粒子|线条生长|路径|光点|粒子聚|particle|path|growing/i,
    why: '粒子和路径动画是 Canvas 的常见能力' },
  { match: /固定镜头|空镜|纯色|背景|no content|blank|solid/i,
    why: '静态或纯色画面不需要生成' },
];

/**
 * Scenes that genuinely need a generator.
 *
 * Split into two tiers because they carry different amounts of evidence:
 *
 *   `subject`  — a concrete thing code cannot draw (a person, a real wave). The
 *                description alone is the reason, so a separate `why` is not
 *                demanded: "真实人物肖像特写" is already specific.
 *   `qualifier` — a style word that only means something when combined with a
 *                subject ("photoreal", "live action"). On its own it does not say
 *                what is being drawn, so a substantive `why` is required.
 */
const NEEDS_GENERATION = [
  { tier: 'subject', match: /人物|人脸|肖像|演员|person|face|portrait|actor/i, why: '真实人物形象' },
  { tier: 'subject', match: /动物|猫|狗|鸟|animal|cat|dog|bird/i, why: '真实动物形象' },
  { tier: 'subject', match: /水|火|烟|云|海浪|火焰|water|fire|smoke|cloud|wave/i, why: '自然流体细节' },
  { tier: 'subject', match: /材质|织物|木纹|金属|玻璃|texture|fabric|wood|metal|glass/i, why: '具体材质特写' },
  { tier: 'qualifier', match: /真实|实拍|现实|photoreal|realistic|live-action/i, why: '实拍质感' },
];

/** Minimum length of a `why` worth accepting, for qualifier-tier matches only. */
const MIN_REASON_LENGTH = 8;

/**
 * Decide whether a scene may use a generation model.
 *
 * @returns {{ allowed: boolean, reason: string, suggestion?: string }}
 */
export function checkCapability(scene) {
  const description = String(scene?.description ?? scene?.why ?? '');
  if (description.trim() === '') {
    // A scene with no description cannot be judged, and allowing it would make
    // the whole check optional in practice.
    return {
      allowed: false,
      reason: '场景缺少描述，无法判断该不该用生成模型',
      suggestion: '在 scenes[].description 里写清这个镜头画的是什么',
    };
  }

  // Code-drawable beats everything: a title card stays a title card even when
  // the caller calls it "photoreal".
  for (const rule of CODE_DRAWABLE) {
    if (rule.match.test(description)) {
      return {
        allowed: false,
        reason: `「${description.slice(0, 40)}」代码就能画：${rule.why}`,
        suggestion: '改用 image_generate（静态）或 video_compose（序列），成本为 0',
      };
    }
  }

  const matches = NEEDS_GENERATION.filter((rule) => rule.match.test(description));
  if (matches.length === 0) {
    return {
      allowed: false,
      reason: `「${description.slice(0, 40)}」没有被判定为必须生成`,
      suggestion: '如果代码确实画不出，请写明画的是什么（如「真实海浪飞沫」），或补一个具体理由',
    };
  }

  // A concrete subject is its own justification.
  const subject = matches.find((rule) => rule.tier === 'subject');
  if (subject !== undefined) {
    return { allowed: true, reason: `需要生成：${subject.why}` };
  }

  // Only a style qualifier matched, so the reason has to come from the caller.
  const qualifier = matches[0];
  const why = String(scene?.why ?? '').trim();
  if (why.length < MIN_REASON_LENGTH) {
    return {
      allowed: false,
      reason: '只有风格词，缺少具体理由',
      suggestion: `请说明画的是什么，为什么代码画不出（${qualifier.why}），至少 ${MIN_REASON_LENGTH} 个字`,
    };
  }
  return { allowed: true, reason: `需要生成：${qualifier.why}（${why}）` };
}

/**
 * Ask the Host for permission to spend.
 *
 * Four outcomes from the service, three of which mean no:
 *   allowed-once → proceed
 *   rejected     → the user said no
 *   cancelled    → the ask was interrupted
 *   unavailable  → nothing could ask; treat as no
 *
 * The last one is the important one. Defaulting to "yes" in a subagent or an
 * automated run would let an unattended process spend money.
 */
export async function requestConsent(ctx, agent, request) {
  let service;
  try {
    service = ctx?.get?.('approval');
  }
  catch {
    service = undefined;
  }
  if (!service || typeof service.request !== 'function') {
    return {
      allowed: false,
      outcome: 'unavailable',
      reason: '这个环境没有审批服务，无法确认是否可以用生成模型',
      hint: '在对话里明确说「用 AI 生成这段」，或用 video_compose 组装已有素材',
    };
  }
  if (agent === undefined || agent === null) {
    return {
      allowed: false,
      outcome: 'unavailable',
      reason: '没有关联到会话，无法请求确认',
    };
  }

  try {
    const outcome = await service.request({
      agent,
      toolName: request.toolName ?? 'video_generate',
      reason: request.reason,
      displayReason: request.displayReason,
      signal: request.signal,
    });
    return {
      allowed: outcome === 'allowed-once',
      outcome,
      reason: outcome === 'allowed-once' ? '用户已确认' : `用户未确认（${outcome}）`,
    };
  }
  catch (error) {
    return {
      allowed: false,
      outcome: 'failed',
      reason: '请求确认时出错',
      detail: String(error?.message ?? error),
    };
  }
}

/** Waiting helper that does not block the event loop. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Join a base URL and a path. */
function joinUrl(base, path) {
  return `${String(base ?? '').replace(/\/+$/, '')}/${String(path ?? '').replace(/^\/+/, '')}`;
}

/** One JSON call with a timeout. */
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
    return { ok: response.ok, status: response.status, payload, text };
  }
  catch (error) {
    return {
      ok: false,
      status: 0,
      text: error?.name === 'AbortError' ? 'timeout' : String(error?.message ?? error),
    };
  }
  finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the API key for one provider.
 *
 * Same classification as the image module: the field is meant to hold a
 * credential reference, but a key pasted into it must still work — a plugin that
 * refuses to generate with a valid key sitting in its own config is worse than
 * one that accepts either form.
 */
async function resolveKey(ctx, provider) {
  if (typeof provider?.key === 'string' && provider.key.trim() !== '') return provider.key.trim();

  const raw = typeof provider?.apiKeyEnv === 'string' ? provider.apiKeyEnv.trim() : '';
  if (raw === '') return '';

  // A reference name is an identifier: upper-case, underscores, ending in a
  // key-ish suffix. Anything else is the secret itself.
  const looksLikeRef = /^[A-Z][A-Z0-9_]*$/.test(raw) && /_API_KEY$|_KEY$|_TOKEN$/.test(raw);
  if (looksLikeRef === false) return raw;

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
  return process.env[raw] ?? '';
}

/** Zhipu CogVideoX: async task queue under /videos/generations. */
const ZHIPU_VIDEO = {
  id: 'zhipu-video',
  label: '智谱 CogVideoX',
  match: (provider) => /bigmodel\.cn/i.test(provider?.baseUrl ?? ''),
  submitPath: '/videos/generations',
  pollPath: '/async-result/{taskId}',
  idPath: 'id',
  statusPath: 'task_status',
  success: ['SUCCESS'],
  failure: ['FAIL', 'FAILED'],
  videoPath: 'video_result',
  intervalMs: 5000,
  timeoutMs: 600000,
  // The Zhipu body takes `size` and `fps`. Image-to-video exists on CogVideoX
  // too, but through `image_url` rather than Agnes's frame fields, so the media
  // options are declared here and ignored when absent.
  body: (input) => {
    const body = {
      model: input.model,
      prompt: input.prompt,
      size: input.size,
      fps: input.fps,
      with_audio: false,
    };
    const first = typeof input.firstFrame === 'string' ? input.firstFrame.trim() : '';
    if (first !== '') {
      body.image_url = first;
      return { body, mode: 'image2video' };
    }
    return { body, mode: 'text2video' };
  },
  mediaFields: ['firstFrame'],
};

/**
 * Agnes Video: an OpenAI-Videos-compatible API.
 *
 * Three details differ from every other provider here, and each cost a debugging
 * round when guessed wrong:
 *
 *   - the create call is `POST /v1/videos` returning `video_id`, and the result is
 *     read from a *different* path, `GET /agnesapi?video_id=…&model_name=…`
 *   - `size` must be a tier string (`720P`, `1080P`, `1K`, `2K`), not pixels
 *   - `mode` decides which media fields are legal: `text` rejects all of them,
 *     `keyframe` takes first/last frame, `reference` takes image/audio/video lists.
 *     Sending a field that does not belong to the mode is a 400.
 *
 * Media must be a **publicly reachable URL**. This is the constraint that bites
 * hardest: Agnes fetches the image itself, from its own network, when the task
 * runs. A link that works in a browser but not from their crawler — an overseas
 * image host, a signed URL that expires before the queue drains, a localhost
 * address — fails with an error that says nothing about the reason.
 */
const AGNES_VIDEO = {
  id: 'agnes-video',
  label: 'Agnes Video',
  match: (provider) => /agnes-ai\.(cn|com)/i.test(provider?.baseUrl ?? ''),
  submitPath: '/videos',
  // The poll lives at the site root, not under /v1. `model_name` is required for
  // keyframe and reference modes; without it the query 404s.
  pollPath: '/agnesapi?video_id={videoId}&model_name={model}',
  idPath: 'video_id',
  alternateIdPaths: ['id', 'task_id'],
  statusPath: 'status',
  success: ['completed', 'COMPLETED', 'succeeded', 'SUCCEEDED'],
  failure: ['failed', 'FAILED', 'error', 'ERROR'],
  videoPath: 'url',
  intervalMs: 2000,
  timeoutMs: 600000,
  /**
   * Build the request body for the mode the caller asked for.
   *
   * `mode` is derived rather than passed straight through, because the three
   * modes have disjoint field sets and the API rejects any field that does not
   * belong to the chosen one. A caller who supplies `firstFrame` gets `keyframe`;
   * a caller who supplies neither gets `text`.
   */
  body: (input) => {
    const body = {
      model: input.model,
      prompt: input.prompt,
      seconds: String(input.seconds ?? 5),
      // Agnes takes a tier, not pixels: "720P" / "1080P" / "1K" / "2K", and
      // rejects anything else with a 400 naming the field but not the fix. A
      // caller who passes 1920x1080 means 1080P, so map it rather than error.
      size: sizeTier(input.size),
      aspect_ratio: input.aspectRatio ?? '16:9',
    };

    const first = typeof input.firstFrame === 'string' ? input.firstFrame.trim() : '';
    const last = typeof input.lastFrame === 'string' ? input.lastFrame.trim() : '';
    const images = Array.isArray(input.images) ? input.images.filter((u) => typeof u === 'string' && u !== '') : [];

    if (first !== '' || last !== '') {
      // Keyframe mode: the frames anchor the shot's start and end.
      body.mode = 'keyframe';
      if (first !== '') body.first_frame = first;
      if (last !== '') body.last_frame = last;
      return { body, mode: 'keyframe' };
    }
    if (images.length > 0) {
      // Reference mode: assets inform content/style, not exact framing.
      body.mode = 'reference';
      body.images = images.slice(0, 8);
      return { body, mode: 'reference' };
    }
    body.mode = 'text';
    return { body, mode: 'text' };
  },
  // Which media fields this adapter accepts, so the caller can validate before
  // spending a request.
  mediaFields: ['firstFrame', 'lastFrame', 'images'],
};

/**
 * Map a requested resolution onto the tier name a provider expects.
 *
 * Callers naturally pass pixels (`1920x1080`), while these APIs take a named
 * tier. Accepting both costs one function and removes a class of 400s; an
 * already-valid tier passes straight through.
 */
function sizeTier(value) {
  const raw = String(value ?? '').trim().toUpperCase();
  if (['720P', '1080P', '1K', '2K'].includes(raw)) return raw;
  // `raw` is upper-cased above, so the separator arrives as `X`, not `x`.
  const match = /^(\d{3,4})\s*[xX*×]\s*(\d{3,4})$/.exec(raw);
  if (match === null) return '720P';
  const longEdge = Math.max(Number(match[1]), Number(match[2]));
  if (longEdge >= 2000) return '2K';
  if (longEdge >= 1600) return '1080P';
  if (longEdge <= 1024 && Number(match[1]) === Number(match[2])) return '1K';
  return '720P';
}

/** Pick a video adapter for a provider. */
export function resolveVideoAdapter(provider) {
  if (AGNES_VIDEO.match(provider)) return AGNES_VIDEO;
  if (ZHIPU_VIDEO.match(provider)) return ZHIPU_VIDEO;
  // An unknown provider gets the OpenAI-Videos shape, which is the most common.
  return AGNES_VIDEO;
}

/**
 * Why a media URL cannot be reached by the provider, or null when it looks fine.
 *
 * The provider downloads the image from its own network. This function answers
 * only the question it can answer cheaply and correctly — whether the URL is the
 * *kind* of address a remote crawler could fetch. It does not make a request:
 * reachability depends on the provider's region, and a link that works from here
 * may still be blocked there. That case is reported by the provider itself.
 */
function checkPublicUrl(value) {
  const raw = String(value).trim();
  if (/^file:\/\//i.test(raw)) {
    return 'file:// 地址只有本机可读，提供商取不到。';
  }
  if (/^[A-Za-z]:[\\/]/.test(raw)) {
    return `本地路径 ${raw.slice(0, 40)} 不是 URL。`;
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return "「" + raw.slice(0, 40) + "」不是合法 URL。";
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return `协议必须是 http(s)，实际是 ${parsed.protocol}`;
  }
  // HTTP works but is often redirected or blocked; say so rather than reject.
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '[::1]') {
    return 'localhost 只有本机可访问，提供商取不到。';
  }
  const privateV4 = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/;
  if (privateV4.test(host)) {
    return `内网地址 ${host} 提供商取不到。`;
  }
  if (!host.includes('.')) {
    return `主机名 ${host} 不是公网域名。`;
  }
  return null;
}

/**
 * Take the URL out of a resolved media value.
 *
 * `resolveMedia` returns either the original string (already public) or the
 * upload result `{ ok, url, uploaded }`. Both shapes reach the adapter, so the
 * extraction lives here rather than at each call site.
 */
function urlOf(value) {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object' && typeof value.url === 'string') return value.url;
  return undefined;
}

/** Walk a dotted path. */
function getPath(node, path) {
  let current = node;
  for (const key of String(path).split('.')) {
    if (current === null || current === undefined) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * Generate one short clip.
 *
 * The capability and consent checks are separate calls that the tool composes,
 * so this function assumes it is allowed to spend and only worries about the
 * protocol: submit, poll, download.
 */
export async function generateVideo(ctx, config, request = {}) {
  const prompt = String(request?.prompt ?? '').trim();
  if (prompt === '') return { ok: false, error: 'prompt is required' };

  const providers = Array.isArray(request?.providers) ? request.providers : [];
  if (providers.length === 0) {
    return { ok: false, error: '没有配置视频生成服务', hint: '在插件设置里添加 baseUrl、模型、密钥引用' };
  }
  const provider = request?.providerId === undefined
    ? providers[0]
    : (providers.find((p) => p.id === request.providerId) ?? providers[0]);

  const adapter = resolveVideoAdapter(provider);
  const model = String(request?.model ?? provider?.models?.[0] ?? 'cogvideox-flash');
  const key = await resolveKey(ctx, provider);
  if (key === '') {
    return { ok: false, error: `「${provider.name ?? provider.id}」没有可用的密钥` };
  }

  const size = String(request?.size ?? '1920x1080');
  const fps = Math.max(12, Math.min(60, Number(request?.fps ?? 30)));
  // Each provider builds its own body: Agnes wants `seconds`/`mode`/`720P`, Zhipu
  // wants `size`/`fps`. Putting the shape in the descriptor keeps the call site
  // free of provider names.
  // The adapter picks the mode from the media the caller supplied, because the
  // modes have disjoint field sets and a stray field is a 400.
  const resolveMedia = async (value) => {
    if (typeof value !== 'string' || value.trim() === '') return value;
    const verdict = checkPublicUrl(value);
    if (verdict === null) return value;
    // Not fetchable as-is: try to make it fetchable by uploading.
    const hosted = await ensurePublicUrl(ctx, config, value);
    return hosted;
  };

  const mediaInput = {
    firstFrame: request?.firstFrame,
    lastFrame: request?.lastFrame,
    images: Array.isArray(request?.images) ? request.images : [],
  };
  const resolvedFrames = await Promise.all([
    resolveMedia(mediaInput.firstFrame),
    resolveMedia(mediaInput.lastFrame),
    ...mediaInput.images.map((u) => resolveMedia(u)),
  ]);
  const uploadedNotes = [];
  for (const item of resolvedFrames) {
    if (item !== null && typeof item === 'object' && item.ok === false) {
      return {
        ok: false,
        error: item.error,
        detail: item.detail,
        hint: item.hint,
      };
    }
    if (item !== null && typeof item === 'object' && item.uploaded === true) {
      uploadedNotes.push(item.url);
    }
  }
  const firstFrameResolved = resolvedFrames[0];
  const lastFrameResolved = resolvedFrames[1];
  const imagesResolved = resolvedFrames.slice(2);


  const built = adapter.body({
    model,
    prompt,
    size,
    fps,
    seconds: Number(request?.seconds ?? 5),
    aspectRatio: String(request?.aspectRatio ?? '16:9'),
    // The resolved values, not the originals: a local path has already become an
    // uploaded URL by this point, and an unchanged public URL passes through.
    firstFrame: urlOf(firstFrameResolved) ?? request?.firstFrame,
    lastFrame: urlOf(lastFrameResolved) ?? request?.lastFrame,
    images: imagesResolved.map((item) => urlOf(item)).filter((u) => typeof u === 'string' && u !== ''),
  });
  const body = built.body;
  const mode = built.mode;

  // A local path or a `file://` URI is not something the provider can fetch, so
  // it is uploaded first and replaced with the resulting URL. An already-public
  // URL passes straight through. Doing this before validation means the check
  // sees what the provider will actually be given.
  const started = Date.now();
  const submitted = await callJson(
    joinUrl(provider.baseUrl, adapter.submitPath),
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    120000,
  );

  if (submitted.ok !== true) {
    const code = submitted.payload?.error?.code;
    const message = submitted.payload?.error?.message ?? submitted.text;
    // 429 and 503 are both "try later", not "your request was wrong". Telling
    // them apart matters: a 503 reported as a plain failure sends the caller off
    // to rewrite a prompt that was fine, and makes an agent give up on a task
    // that would have succeeded a minute later.
    //
    // Agnes puts queue saturation on 503; Zhipu uses 429 with code 1305.
    const busy = submitted.status === 429
      || submitted.status === 503
      || submitted.status === 500
      || String(code) === '1305';
    return {
      ok: false,
      error: busy ? '模型当前访问量过大，请稍后重试' : `提交失败（HTTP ${submitted.status}）`,
      detail: String(message).slice(0, 400),
      retryable: busy,
    };
  }

  // Providers name the id differently: Agnes uses `video_id`, others `id`.
  let taskId = getPath(submitted.payload, adapter.idPath);
  for (const alternate of adapter.alternateIdPaths ?? []) {
    if (taskId !== undefined && taskId !== null) break;
    taskId = getPath(submitted.payload, alternate);
  }
  if (taskId === undefined || taskId === null) {
    return {
      ok: false,
      error: '提交后没有拿到任务 id',
      detail: JSON.stringify(submitted.payload ?? {}).slice(0, 300),
    };
  }

  const deadline = Date.now() + adapter.timeoutMs;
  let interval = adapter.intervalMs;
  let lastStatus = null;
  let videoUrl = null;

  while (Date.now() < deadline) {
    await sleep(interval);
    // Some templates interpolate the task id, some the video id, some the model.
    const pollPath = adapter.pollPath
      .replace('{taskId}', encodeURIComponent(String(taskId)))
      .replace('{videoId}', encodeURIComponent(String(taskId)))
      .replace('{model}', encodeURIComponent(model));
    const polled = await callJson(
      joinUrl(provider.baseUrl, pollPath),
      { method: 'GET', headers: { Authorization: `Bearer ${key}` } },
      60000,
    );
    if (polled.ok !== true) {
      interval = Math.min(Math.round(interval * 1.3), 15000);
      continue;
    }
    lastStatus = String(getPath(polled.payload, adapter.statusPath) ?? '');
    const upper = lastStatus.toUpperCase();
    if (adapter.success.some((s) => s.toUpperCase() === upper)) {
      const node = getPath(polled.payload, adapter.videoPath);
      const first = Array.isArray(node) ? node[0] : node;
      videoUrl = typeof first === 'string' ? first : (first?.url ?? null);
      break;
    }
    if (adapter.failure.some((s) => s.toUpperCase() === upper)) {
      return {
        ok: false,
        error: `生成失败（${lastStatus}）`,
        detail: JSON.stringify(polled.payload ?? {}).slice(0, 300),
        taskId: String(taskId),
      };
    }
    interval = Math.min(Math.round(interval * 1.2), 15000);
  }

  if (videoUrl === null) {
    return {
      ok: false,
      error: `等待超时${lastStatus === null ? '' : `（最后状态 ${lastStatus}）`}`,
      taskId: String(taskId),
      hint: '任务可能仍在后台运行，可凭 taskId 稍后查询',
    };
  }

  // Download immediately: these URLs are usually short-lived.
  const outDir = typeof request?.outDir === 'string' && request.outDir !== ''
    ? request.outDir
    : join(process.cwd(), 'omni-video');
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `clip-${Date.now()}.mp4`);

  try {
    const response = await fetch(videoUrl);
    if (!response.ok) {
      return { ok: false, error: `下载视频失败：HTTP ${response.status}`, url: videoUrl };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    writeFileSync(path, buffer);
  }
  catch (error) {
    return { ok: false, error: `下载视频失败：${String(error?.message ?? error)}`, url: videoUrl };
  }

  return {
    ok: true,
    path,
    bytes: statSync(path).size,
    provider: provider.name ?? provider.id,
    model,
    size,
    fps,
    taskId: String(taskId),
    seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    url: videoUrl,
  };
}

/** Render a video result for a person to read. */
export function formatVideo(result) {
  if (result?.ok !== true) {
    const lines = ['# 视频生成失败', '', result?.error ?? '未知错误'];
    if (result?.detail) lines.push('', '```', String(result.detail).slice(0, 400), '```');
    if (result?.hint) lines.push('', `提示：${result.hint}`);
    if (result?.taskId) lines.push(`\n任务 id：${result.taskId}`);
    if (result?.retryable === true) lines.push('\n可以稍后重试，这不是请求本身的问题。');
    return lines.join('\n');
  }
  return [
    '# 视频片段已生成',
    '',
    `- 文件：${result.path}`,
    `- 尺寸：${result.size} · ${result.fps} fps`,
    `- 大小：${(result.bytes / 1024 / 1024).toFixed(2)} MB`,
    `- 服务：${result.provider}`,
    `- 模型：${result.model}`,
    `- 耗时：${result.seconds} 秒`,
    '',
    '用 video_compose 把它和其他素材组装成整片。',
  ].join('\n');
}
