/**
 * Image generation adapters.
 *
 * Every provider speaks a slightly different dialect: the size field is `size`
 * or `width,height` or `aspect_ratio`; the answer is `b64_json` or `url` or raw
 * bytes; some enqueue a task and need polling. Those differences live in the
 * descriptors below so the calling code sees one shape.
 *
 * Two rules keep this maintainable:
 *
 *   - **`send` is an allow-list.** Only listed fields reach the request body. A
 *     platform that rejects unknown parameters therefore cannot be broken by a
 *     field added for another platform.
 *   - **`compose` rewrites names.** Where a platform uses different field names
 *     (Mona's `productCode`, Volcengine's `watermark`), the OpenAI-shaped values
 *     are translated rather than special-cased in the caller.
 *
 * The `mona` descriptor carries values measured on this machine: its task is
 * identified by `taskId`, finishes with `status: "success"`, and lists results
 * under `images[].url`. Those were not guessed — an earlier version guessed `id`,
 * `SUCCEEDED` and `result`, and every generation reported a timeout.
 */

/** The eight providers worth shipping: five cloud, three local. */
export const ADAPTERS = [
  {
    // Mona Studio. Async task queue with a non-OpenAI body shape.
    //
    // `Idempotency-Key` must differ per request: a static value made the platform
    // treat every generate as a replay and hand back the first task id forever.
    id: 'mona',
    label: 'Mona Studio',
    match: (provider) => /monastudiopro\.com/i.test(provider.baseUrl ?? ''),
    async: true,
    submit: '/images/tasks',
    headers: { 'Idempotency-Key': () => `omni-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` },
    poll: {
      path: '/images/tasks/{taskId}',
      idPath: 'taskId',
      statusPath: 'status',
      resultPath: 'images',
      success: ['success', 'SUCCESS', 'succeeded', 'SUCCEEDED', 'completed', 'done'],
      failure: ['failed', 'FAILED', 'failure', 'FAILURE', 'canceled', 'cancelled', 'error', 'ERROR'],
      intervalMs: 2000,
      timeoutMs: 300000,
    },
    endpoints: { generate: '/images/tasks' },
    transport: 'json',
    send: ['model', 'prompt', 'n'],
    compose: (fields) => ({
      productCode: fields.model,
      variantKey: '1k',
      prompt: fields.prompt,
      count: fields.n ?? 1,
    }),
    supportsSize: false,
  },
  {
    id: 'gpt-image',
    label: 'OpenAI GPT-Image',
    match: (provider, model) => /gpt-?image/i.test(model),
    endpoints: { generate: '/images/generations' },
    transport: 'json',
    send: ['model', 'prompt', 'size', 'n', 'quality'],
    sizeStyle: 'string',
    allowedSizes: ['1024x1024', '1536x1024', '1024x1536', 'auto'],
    defaultSize: '1024x1024',
    qualityOptions: ['low', 'medium', 'high', 'auto'],
  },
  {
    id: 'google-gemini',
    label: 'Google Gemini / Nano Banana',
    match: (provider) => /generativelanguage\.googleapis\.com/i.test(provider.baseUrl ?? ''),
    endpoints: { generate: ':generateContent' },
    transport: 'json',
    send: [],
    // Gemini does not take an OpenAI-shaped body at all; the request is built by
    // `buildGeminiRequest` and the response read by `readGeminiResponse`.
    custom: 'gemini',
    supportsSize: false,
  },
  {
    // Zhipu BigModel's CogView models. Its endpoint is OpenAI-Images-compatible,
    // so this descriptor exists mainly to name the provider in reports and to
    // pin the sizes CogView actually accepts — `cogview-3-flash` rejects 1792.
    id: 'zhipu',
    label: '智谱 BigModel',
    match: (provider) => /bigmodel\.cn/i.test(provider.baseUrl ?? ''),
    endpoints: { generate: '/images/generations' },
    transport: 'json',
    send: ['model', 'prompt', 'size'],
    sizeStyle: 'string',
    allowedSizes: ['1024x1024', '768x1024', '1024x768', '512x512'],
    defaultSize: '1024x1024',
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    match: (provider) => /siliconflow/i.test(provider.baseUrl ?? ''),
    endpoints: { generate: '/images/generations' },
    transport: 'json',
    send: ['model', 'prompt', 'image_size', 'batch_size'],
    sizeStyle: 'string',
    sizeField: 'image_size',
    allowedSizes: ['1024x1024', '768x1024', '1024x768', '512x512'],
    defaultSize: '1024x1024',
  },
  {
    id: 'volcengine-ark',
    label: '火山方舟 Seedream',
    match: (provider) => /volces\.com/i.test(provider.baseUrl ?? ''),
    endpoints: { generate: '/images/generations' },
    transport: 'json',
    send: ['model', 'prompt', 'size', 'response_format', 'watermark', 'n'],
    responseFormat: 'url',
    watermark: false,
    sizeStyle: 'string',
    allowedSizes: ['1024x1024', '864x1152', '1152x864'],
    defaultSize: '1024x1024',
  },
  {
    id: 'dashscope',
    label: '阿里云百炼 通义万相',
    match: (provider) => /dashscope\.aliyuncs\.com/i.test(provider.baseUrl ?? ''),
    async: true,
    submit: '/services/aigc/text2image/image-synthesis',
    headers: { 'X-DashScope-Async': 'enable' },
    poll: {
      path: '/tasks/{taskId}',
      idPath: 'output.task_id',
      statusPath: 'output.task_status',
      resultPath: 'output.results',
      success: ['SUCCEEDED'],
      failure: ['FAILED', 'CANCELED', 'UNKNOWN'],
      intervalMs: 2000,
      timeoutMs: 300000,
    },
    endpoints: { generate: '/services/aigc/text2image/image-synthesis' },
    transport: 'json',
    send: ['model', 'prompt', 'size', 'n'],
    compose: (fields) => ({
      model: fields.model,
      input: { prompt: fields.prompt },
      parameters: { size: fields.size, n: fields.n ?? 1 },
    }),
    sizeStyle: 'string',
    sizeSeparator: '*',
    allowedSizes: ['1024x1024', '1280x720', '720x1280', '1024x768', '768x1024'],
    defaultSize: '1024x1024',
  },
  {
    // Local AUTOMATIC1111 / Forge / SD.Next. No key, and the endpoint is
    // `/sdapi/v1/txt2img` rather than anything OpenAI-shaped.
    id: 'a1111',
    label: 'AUTOMATIC1111 / Forge',
    match: (provider) => /:(7860)\b/.test(provider.baseUrl ?? ''),
    local: true,
    endpoints: { generate: '/sdapi/v1/txt2img' },
    transport: 'json',
    send: ['prompt', 'negative_prompt', 'width', 'height', 'steps', 'cfg_scale'],
    sizeStyle: 'widthHeight',
    defaultSize: '1024x1024',
    custom: 'a1111',
  },
  {
    // The baseline every OpenAI-compatible gateway speaks. Listed second so the
    // more specific descriptors below win when their model ids match.
    id: 'openai-images',
    label: 'OpenAI Images 兼容',
    match: () => true,
    endpoints: { generate: '/images/generations' },
    transport: 'json',
    send: ['model', 'prompt', 'size', 'n', 'response_format'],
    responseFormat: 'b64_json',
    sizeStyle: 'string',
    allowedSizes: ['1024x1024', '1536x1024', '1024x1536', '512x512', '256x256'],
    defaultSize: '1024x1024',
  },
];

/** Pick the descriptor for a provider and model. */
export function resolveImageAdapter(provider, model) {
  const explicit = String(provider?.adapter ?? '').trim().toLowerCase();
  if (explicit !== '') {
    const hit = ADAPTERS.find((a) => a.id === explicit);
    if (hit !== undefined) return hit;
  }
  for (const adapter of ADAPTERS) {
    try {
      if (adapter.match(provider ?? {}, model ?? '')) return adapter;
    }
    catch { /* one bad matcher must not hide the rest */ }
  }
  return ADAPTERS[ADAPTERS.length - 1];
}

/**
 * Snap a requested size to one the model accepts.
 *
 * Asking for 256×256 on a model whose floor is 1024×1024 is a normal mistake; the
 * useful response is to render at the nearest legal size rather than reject. The
 * adjustment is reported so the caller knows the file is not what it asked for.
 */
export function fitSize(adapter, requested) {
  if (adapter.supportsSize === false) return { size: adapter.defaultSize ?? '1024x1024', adjusted: false };
  const match = /^(\d+)\s*[x*×]\s*(\d+)$/i.exec(String(requested ?? '').trim());
  if (match === null) return { size: adapter.defaultSize ?? '1024x1024', adjusted: false };

  const width = Number(match[1]);
  const height = Number(match[2]);
  const allowed = adapter.allowedSizes ?? [];
  if (allowed.length === 0) return { size: `${width}x${height}`, adjusted: false };

  const wanted = `${width}x${height}`;
  if (allowed.includes(wanted)) return { size: wanted, adjusted: false };

  // Nearest by the log of the aspect ratio plus absolute size, so a request that
  // keeps its shape is preferred over one that merely matches the pixel count.
  const targetAspect = Math.log(width / height);
  let best = allowed[0];
  let bestScore = Infinity;
  for (const candidate of allowed) {
    if (candidate === 'auto') continue;
    const [w, h] = candidate.split('x').map(Number);
    if (!Number.isFinite(w) || !Number.isFinite(h)) continue;
    const aspectPenalty = Math.abs(Math.log(w / h) - targetAspect) * 4;
    const sizePenalty = Math.abs(Math.log((w * h) / (width * height))) * 0.5;
    const score = aspectPenalty + sizePenalty;
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return { size: best, adjusted: true, requested: wanted };
}

/** Encode the size into the field this adapter wants. */
export function encodeSize(adapter, size) {
  if (adapter.supportsSize === false) return {};
  if (adapter.sizeStyle === 'widthHeight') {
    const [width, height] = size.split('x').map(Number);
    return { width, height };
  }
  const field = adapter.sizeField ?? 'size';
  const value = adapter.sizeSeparator === '*' ? size.replace('x', '*') : size;
  return { [field]: value };
}

/** Build one request body, honouring the adapter's allow-list and renames. */
export function buildBody(adapter, input) {
  const fields = {
    model: input.model,
    prompt: input.prompt,
    negative_prompt: input.negativePrompt,
    n: input.n ?? 1,
    quality: input.quality,
    ...encodeSize(adapter, input.size),
  };
  const body = {};
  for (const key of adapter.send ?? []) {
    const value = fields[key];
    if (value === undefined || value === null || value === '') continue;
    body[key] = value;
  }
  if (adapter.responseFormat !== undefined) body.response_format = adapter.responseFormat;
  if (adapter.watermark !== undefined) body.watermark = adapter.watermark;
  return adapter.compose ? adapter.compose(body) : body;
}

/** Where the finished image is, given whatever shape the provider replied with. */
export function readImage(result) {
  if (result === null || typeof result !== 'object') return null;

  // b64 first: it is the shape that needs no second request.
  const b64 = result.b64_json ?? result.image_base64 ?? result.image;
  if (typeof b64 === 'string' && b64.length > 64) {
    return { kind: 'base64', data: b64 };
  }

  // Then any URL field, at the top level or one level down.
  const url = result.url ?? result.image_url ?? result.imageUrl;
  if (typeof url === 'string' && url !== '') return { kind: 'url', url };

  for (const value of Object.values(result)) {
    if (value === null || typeof value !== 'object') continue;
    const nested = readImage(value);
    if (nested !== null) return nested;
  }
  return null;
}

/** Pull the first task id out of a submit response. */
export function readTaskId(adapter, payload) {
  const path = adapter?.poll?.idPath ?? 'id';
  let current = payload;
  for (const key of String(path).split('.')) {
    if (current === null || current === undefined) return null;
    current = current[key];
  }
  return current === undefined || current === null ? null : String(current);
}

/** Collapse one platform's status vocabulary into queued / done / failed. */
export function readTaskState(adapter, payload) {
  const poll = adapter?.poll ?? {};
  let status = payload;
  for (const key of String(poll.statusPath ?? 'status').split('.')) {
    if (status === null || status === undefined) {
      status = '';
      break;
    }
    status = status[key];
  }
  const text = String(status ?? '').toUpperCase();
  const success = (poll.success ?? []).map((s) => s.toUpperCase());
  const failure = (poll.failure ?? []).map((s) => s.toUpperCase());
  if (success.includes(text)) {
    let node = payload;
    for (const key of String(poll.resultPath ?? 'result').split('.')) {
      if (node === null || node === undefined) break;
      node = node[key];
    }
    return { state: 'done', status: text, node };
  }
  if (failure.includes(text)) {
    const message = payload?.message ?? payload?.error ?? text;
    return { state: 'failed', status: text, message: String(message) };
  }
  return { state: 'pending', status: text };
}
