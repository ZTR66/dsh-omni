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
  // The Zhipu body takes `size` and `fps`.
  body: (input) => ({
    model: input.model,
    prompt: input.prompt,
    size: input.size,
    fps: input.fps,
    with_audio: false,
  }),
};

/**
 * Agnes Video: an OpenAI-Videos-compatible API.
 *
 * Two details differ from every other provider here and both cost a debugging
 * round if guessed:
 *
 *   - the create call is `POST /v1/videos` returning `video_id`, and the result
 *     is read from a *different* path, `GET /agnesapi?video_id=…&model_name=…`
 *   - `size` must be the literal string `720P`; `agnes-video-2.5-flash` rejects
 *     anything else with `size must be 720P` rather than snapping it
 *
 * `agnes-video-2.5-flash` is priced at $0/s during the trial, which makes it the
 * sensible default for anyone trying the tool out.
 */
const AGNES_VIDEO = {
  id: 'agnes-video',
  label: 'Agnes Video',
  match: (provider) => /agnes-ai\.(cn|com)/i.test(provider?.baseUrl ?? ''),
  submitPath: '/videos',
  // Absolute-ish: the poll lives at the site root, not under /v1.
  pollPath: '/agnesapi?video_id={videoId}&model_name={model}',
  idPath: 'video_id',
  alternateIdPaths: ['id', 'task_id'],
  statusPath: 'status',
  success: ['completed', 'COMPLETED', 'succeeded', 'SUCCEEDED'],
  failure: ['failed', 'FAILED', 'error', 'ERROR'],
  videoPath: 'url',
  intervalMs: 2000,
  timeoutMs: 600000,
  // Flash only accepts the literal "720P".
  body: (input) => ({
    model: input.model,
    prompt: input.prompt,
    seconds: String(input.seconds ?? 5),
    mode: 'text',
    size: '720P',
    aspect_ratio: input.aspectRatio ?? '16:9',
  }),
};

/** Pick a video adapter for a provider. */
export function resolveVideoAdapter(provider) {
  if (AGNES_VIDEO.match(provider)) return AGNES_VIDEO;
  if (ZHIPU_VIDEO.match(provider)) return ZHIPU_VIDEO;
  // An unknown provider gets the OpenAI-Videos shape, which is the most common.
  return AGNES_VIDEO;
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
  const body = adapter.body({
    model,
    prompt,
    size,
    fps,
    seconds: Number(request?.seconds ?? 5),
    aspectRatio: String(request?.aspectRatio ?? '16:9'),
  });

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
    // 429 on this model is a queue, not a failure of the request. Saying so
    // saves the caller from "fixing" a prompt that was fine.
    const busy = submitted.status === 429 || String(code) === '1305';
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
