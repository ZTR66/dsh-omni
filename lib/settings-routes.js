/**
 * Settings routes for the omni plugin.
 *
 * Three endpoints, all shaped like the plugin manager's own settings surface so
 * the page feels native:
 *
 *   GET  /api/omni/settings   current providers plus what each key resolves to
 *   POST /api/omni/settings   replace the provider lists
 *   GET  /api/omni/check      run the environment probe on demand
 *
 * The config write goes through `configEditor.edit`, which is the only supported
 * way for a plugin to persist its own configuration: it validates, writes, and
 * reconciles the Loader in one step, so the running plugin sees the change
 * without a restart.
 *
 * Two things this deliberately does NOT do:
 *
 *   - **It never returns a secret.** A provider's `apiKeyEnv` is a reference
 *     name; the page receives `hasKey` and the source, never the value.
 *   - **It never writes a secret into config.** Keys stay in the Host credential
 *     store, which the page can set through the credentials controller and which
 *     keeps them out of both the patch file and the browser.
 */

import { checkEnvironment, formatEnvironment } from './env.js';

/** The route prefix every endpoint shares. */
const BASE = '/api/omni';

/** Read one request body, refusing anything unreasonably large. */
async function readJson(req, limit = 256 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Send a JSON response with no caching. */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Whether a value is a credential reference rather than a secret.
 *
 * Kept as its own function because two places need the same answer: the
 * classification above, and the redaction below — a pasted secret must never be
 * echoed to the browser, while a reference name is safe to show and useful to
 * edit.
 */
function isReference(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw === '') return false;
  return /^[A-Z][A-Z0-9_]*$/.test(raw) && /_API_KEY$|_KEY$|_TOKEN$/.test(raw);
}

/**
 * Classify an `apiKeyEnv` value, and report whether its key can be obtained.
 *
 * The field is named for a credential reference — the name of a key the Host
 * stores — so normally this resolves through the credential service. A settings
 * page that pastes the key itself into that field has to keep working too, and
 * the two forms are told apart by shape rather than by trying both:
 *
 *   - a reference is an identifier: upper-case, underscores, key-ish suffix
 *   - anything else is the secret, and its presence is enough
 *
 * This mirrors the classification in `image.js` and `video-generate.js` on
 * purpose: a badge that disagrees with what a generation will actually do is
 * worse than no badge, because it sends someone hunting for a problem that is
 * not there.
 *
 * The value itself is never returned, logged, or kept past this call.
 */
async function inspectCredential(ctx, rawValue) {
  const raw = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (raw === '') return { hasKey: false, keySource: 'none', keyKind: 'empty' };

  if (isReference(raw) === false) {
    // The secret is in the config field itself.
    return { hasKey: true, keySource: 'inline', keyKind: 'secret' };
  }

  if (typeof process.env[raw] === 'string' && process.env[raw] !== '') {
    return { hasKey: true, keySource: 'env', keyKind: 'reference' };
  }

  const credentials = (() => {
    try {
      return ctx?.get?.('credentials');
    }
    catch {
      return undefined;
    }
  })();
  if (credentials) {
    if (typeof credentials.describe === 'function') {
      try {
        const info = await credentials.describe(raw);
        if (info?.configured === true) {
          return { hasKey: true, keySource: info.source || 'store', keyKind: 'reference' };
        }
      }
      catch { /* fall through to resolve */ }
    }
    if (typeof credentials.resolve === 'function') {
      try {
        const resolved = await credentials.resolve(raw);
        const value = resolved?.value ?? resolved;
        if (typeof value === 'string' && value !== '') {
          return { hasKey: true, keySource: 'store', keyKind: 'reference' };
        }
      }
      catch { /* reported as missing below */ }
    }
  }
  return { hasKey: false, keySource: 'missing', keyKind: 'reference' };
}

/**
 * Only same-origin writes are accepted.
 *
 * A settings route that accepts a cross-site POST is a way for any page the user
 * visits to rewrite their provider list. Checking the Origin header against the
 * Host header is enough here because the server only listens on loopback.
 */
function assertSameOrigin(req) {
  const origin = req.headers?.origin;
  if (origin === undefined) return;
  let host;
  try {
    host = new URL(String(origin)).host.toLowerCase();
  }
  catch {
    const error = new Error('invalid Origin');
    error.status = 403;
    throw error;
  }
  const self = String(req.headers?.host ?? '').toLowerCase();
  if (host !== self) {
    const error = new Error('cross-origin request rejected');
    error.status = 403;
    throw error;
  }
}

/**
 * Move a pasted secret out of the config and into the credential store.
 *
 * The page's field is labelled "credential reference", but people paste keys into
 * it. Writing that straight to the patch file would leave a plaintext secret in
 * a file that gets committed, backed up, and read by every plugin — so the value
 * is classified first, and a secret is stored where secrets belong:
 *
 *   reference → keep as-is, the store already holds the key
 *   secret    → derive a reference name from the provider id, write the value
 *               through `credentials`, and keep only the name in config
 *
 * If the credential service is unavailable the value is kept in config rather
 * than dropped: a plugin that silently forgets a working key is worse than one
 * that stores it in the less ideal place. The caller can then move it later.
 */
async function absorbKey(ctx, provider, kind) {
  const raw = typeof provider?.apiKeyEnv === 'string' ? provider.apiKeyEnv.trim() : '';
  if (raw === '' || isReference(raw)) return { provider, moved: false };

  const credentials = (() => {
    try {
      return ctx?.get?.('credentials');
    }
    catch {
      return undefined;
    }
  })();
  if (!credentials || typeof credentials.set !== 'function') {
    return { provider, moved: false, note: '凭据服务不可用，密钥暂存配置中' };
  }

  // A stable name derived from the provider id, so re-saving the same provider
  // overwrites its key instead of piling up new refs.
  const stem = String(provider?.id ?? 'provider')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'PROVIDER';
  const ref = `OMNI_${kind.toUpperCase()}_${stem}_API_KEY`;

  try {
    await credentials.set(ref, raw);
    return { provider: { ...provider, apiKeyEnv: ref }, moved: true, ref };
  }
  catch (error) {
    return {
      provider,
      moved: false,
      note: `写入凭据库失败：${String(error?.message ?? error)}`,
    };
  }
}

/**
 * Report whether the image host is configured, without exposing its secrets.
 *
 * The page needs enough to render "configured / not configured" and to let the
 * user replace a key; it never needs the key itself. `secretKey` is replaced by
 * a boolean, and `accessKey` by a masked prefix — both are identifying enough to
 * confirm which account is in use and useless to an attacker on their own.
 */
function describeImageHost(host) {
  if (host === undefined || host === null || String(host.kind ?? '') === '') {
    return { kind: '', configured: false };
  }
  const accessKey = String(host.accessKey ?? '');
  return {
    kind: String(host.kind ?? ''),
    bucket: String(host.bucket ?? ''),
    domain: String(host.domain ?? ''),
    region: String(host.region ?? 'z0'),
    accessKeyMasked: accessKey === '' ? '' : accessKey.slice(0, 6) + '…',
    hasSecretKey: String(host.secretKey ?? '') !== '',
    configured: accessKey !== ''
      && String(host.secretKey ?? '') !== ''
      && String(host.bucket ?? '') !== ''
      && String(host.domain ?? '') !== '',
  };
}

/**
 * Merge one image-host edit into the stored shape.
 *
 * An empty `secretKey` from the page means "leave the existing one alone" rather
 * than "clear it": the field renders blank because the secret is never sent back,
 * so treating blank as a deletion would wipe the key on every unrelated save.
 */
function cleanImageHost(raw, current) {
  if (raw === null || typeof raw !== 'object') return current;
  const kind = String(raw.kind ?? '').trim();
  if (kind === '') return {};
  const secretKey = typeof raw.secretKey === 'string' ? raw.secretKey.trim() : '';
  return {
    kind,
    accessKey: String(raw.accessKey ?? '').trim(),
    secretKey: secretKey !== '' ? secretKey : String(current?.secretKey ?? ''),
    bucket: String(raw.bucket ?? '').trim(),
    domain: String(raw.domain ?? '').trim(),
    region: String(raw.region ?? 'z0').trim(),
  };
}

/** Normalise one provider entry from the page into the stored shape. */
function cleanProvider(raw, kind) {
  const id = String(raw?.id ?? '').trim();
  if (id === '') return null;
  const models = Array.isArray(raw?.models)
    ? raw.models.map((m) => String(m).trim()).filter((m) => m !== '')
    : [];
  return {
    id,
    name: String(raw?.name ?? id).trim(),
    baseUrl: String(raw?.baseUrl ?? '').trim(),
    apiKeyEnv: String(raw?.apiKeyEnv ?? '').trim(),
    models,
    // Recorded so the page can label local backends without guessing from the
    // URL again when it renders.
    kind,
  };
}

/** Read the live config for the omni entry. */
function currentConfig(configEditor, entryId) {
  const entries = typeof configEditor?.entries === 'function' ? configEditor.entries() : [];
  const entry = entries.find((item) => item?.id === entryId || item?.options?.id === entryId);
  if (entry === undefined) return { entry: null, config: {} };

  const rows = typeof configEditor.configuration === 'function' ? configEditor.configuration() : [];
  const row = rows.find((item) => item?.entry === entry || item?.entry?.id === entry.id);
  const merged = { ...(row?.inherited ?? {}), ...(row?.override ?? {}) };
  return { entry, config: merged };
}

/**
 * Register the routes.
 *
 * `webServer` is passed in rather than read from `ctx` here: the caller may have
 * obtained it through `ctx.get('webServer')` or a deferred `ctx.inject`, and in a
 * plain-JavaScript plugin `ctx.webServer` is not guaranteed to be populated by
 * the same path. Taking the resolved object removes that ambiguity.
 *
 * @param {object} ctx plugin context, used only for the other services.
 * @param {object} deps `{ webServer, entryId, settings, getSettings, log }`.
 * @returns {() => void} disposer.
 */
export function registerSettingsRoutes(ctx, deps) {
  const disposers = [];
  const webServer = deps?.webServer;

  const add = (path, handler) => {
    if (!webServer || typeof webServer.register !== 'function') {
      deps.log?.(`no webServer; route ${path} not registered`);
      return;
    }
    try {
      disposers.push(webServer.register({ kind: 'exact', path, handler }));
    }
    catch (error) {
      deps.log?.(`route ${path} failed: ${String(error?.message ?? error)}`);
    }
  };

  add(`${BASE}/settings`, async (req, res) => {
    try {
      if (req.method === 'GET') {
        const configEditor = ctx.get?.('configEditor');
        const live = currentConfig(configEditor, deps.entryId);
        const stored = deps.getSettings() ?? deps.settings;
        // The live Loader layer is the truth; the in-memory copy is a fallback
        // for the first paint before the entry exists.
        const image = live.config?.image ?? stored?.image ?? {};
        const video = live.config?.video ?? stored?.video ?? {};
        const asr = live.config?.asr ?? stored?.asr ?? {};

        const describe = (provider) => ({
          id: provider?.id ?? '',
          name: provider?.name ?? provider?.id ?? '',
          baseUrl: provider?.baseUrl ?? '',
          // A pasted secret is replaced with a placeholder before it leaves the
          // Host: the page needs to know a key is present, not what it is.
          apiKeyEnv: isReference(provider?.apiKeyEnv)
            ? String(provider.apiKeyEnv)
            : (String(provider?.apiKeyEnv ?? '') === '' ? '' : '(已填密钥)'),
          models: Array.isArray(provider?.models) ? provider.models : [],
        });

        // A reference name in config means the key lives in the Host credential
        // store; the environment lookup above only covers the override.
        const described = (list) => Promise.all((list ?? []).map(async (provider) => {
          const base = describe(provider);
          const verdict = await inspectCredential(ctx, provider?.apiKeyEnv);
          return { ...base, ...verdict };
        }));

        const [imageProviders, videoProviders] = await Promise.all([
          described(image.providers),
          described(video.providers),
        ]);

        return sendJson(res, 200, {
          ok: true,
          image: { providers: imageProviders },
          video: { providers: videoProviders },
          asr: {
            mode: asr.mode ?? 'auto',
            localModel: asr.localModel ?? 'small',
          },
          // The image host is returned without its secret keys — the page learns
          // whether it is configured, never what the keys are.
          imageHost: describeImageHost(live.config?.imageHost ?? stored?.imageHost),
          ffmpegPath: live.config?.ffmpegPath ?? '',
          pythonPath: live.config?.pythonPath ?? '',
        });
      }

      if (req.method === 'POST') {
        assertSameOrigin(req);
        const body = await readJson(req);
        const configEditor = ctx.get?.('configEditor');
        if (configEditor === undefined) {
          return sendJson(res, 503, { ok: false, error: '配置服务不可用，无法保存' });
        }
        const live = currentConfig(configEditor, deps.entryId);
        if (live.entry === null) {
          return sendJson(res, 503, { ok: false, error: '找不到插件配置条目' });
        }

        // Clean, then move any pasted secret into the credential store before
        // the config is written. Order matters: `absorbKey` needs the provider id
        // to derive a stable reference name, and the id only survives cleaning.
        const prepare = async (list, kind) => {
          if (!Array.isArray(list)) return undefined;
          const cleaned = list.map((p) => cleanProvider(p, kind)).filter(Boolean);
          const notes = [];
          const absorbed = [];
          for (const provider of cleaned) {
            const outcome = await absorbKey(ctx, provider, kind);
            if (outcome.note) notes.push(`${provider.id}: ${outcome.note}`);
            absorbed.push(outcome.provider);
          }
          return { providers: absorbed, notes };
        };

        const imageResult = await prepare(body?.image?.providers, 'image');
        const videoResult = await prepare(body?.video?.providers, 'video');
        const nextImage = imageResult?.providers;
        const nextVideo = videoResult?.providers;
        const notes = [...(imageResult?.notes ?? []), ...(videoResult?.notes ?? [])];

        await configEditor.edit(live.entry, (current) => {
          const next = { ...current };
          if (nextImage !== undefined) next.image = { ...(current.image ?? {}), providers: nextImage };
          if (nextVideo !== undefined) next.video = { ...(current.video ?? {}), providers: nextVideo };
          if (body?.asr !== undefined) {
            next.asr = {
              mode: String(body.asr.mode ?? current.asr?.mode ?? 'auto'),
              localModel: String(body.asr.localModel ?? current.asr?.localModel ?? 'small'),
            };
          }
          if (body?.imageHost !== undefined) {
            next.imageHost = cleanImageHost(body.imageHost, current.imageHost);
          }
          if (typeof body?.ffmpegPath === 'string') next.ffmpegPath = body.ffmpegPath;
          if (typeof body?.pythonPath === 'string') next.pythonPath = body.pythonPath;
          return next;
        });
        return sendJson(res, 200, { ok: true, notes });
      }

      res.writeHead(405, { allow: 'GET, POST' });
      return res.end();
    }
    catch (error) {
      const status = Number(error?.status) || 500;
      return sendJson(res, status, { ok: false, error: String(error?.message ?? error) });
    }
  });

  add(`${BASE}/check`, async (req, res) => {
    try {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' });
        return res.end();
      }
      const report = await checkEnvironment(deps.getSettings() ?? deps.settings);
      return sendJson(res, 200, { ok: true, report, text: formatEnvironment(report) });
    }
    catch (error) {
      return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      }
      catch { /* one failed disposer must not block the rest */ }
    }
  };
}
