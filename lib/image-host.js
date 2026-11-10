/**
 * Upload a local file to a host the video provider can reach.
 *
 * The problem this exists for:
 *
 * Agnes (and every provider with a similar design) fetches reference images from
 * *its own* network when the task runs. A local path, a `localhost` URL or a file
 * on an overseas image host is unreachable from there, and the failure comes back
 * as a generic task error that names neither the URL nor the cause. Uploading to a
 * domestic object store first turns "it just fails" into a real link.
 *
 * 七牛 (Qiniu) is implemented because it is the one that works reliably from
 * mainland China without a credit card: 10 GB of free traffic per month, a plain
 * HTTP API, and a stable CDN.
 *
 * The upload token is generated locally — Qiniu's scheme is an HMAC-SHA1 over a
 * base64-encoded policy, so no SDK and no extra dependency is needed. The secret
 * key is only ever used to compute that signature; it is never placed in a URL,
 * a log line, or a returned object.
 */

import { createHmac } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, basename } from 'node:path';

/** Qiniu's region upload hosts. `auto` resolves by probing the bucket's region. */
const UPLOAD_HOSTS = {
  z0: 'https://upload.qiniup.com',
  z1: 'https://upload-z1.qiniup.com',
  z2: 'https://upload-z2.qiniup.com',
  na0: 'https://upload-na0.qiniup.com',
  as0: 'https://upload-as0.qiniup.com',
};

/**
 * URL-safe base64, keeping the `=` padding.
 *
 * Qiniu's spec writes the signing steps as `urlsafe_base64_encode`, and its own
 * worked example shows a padded result (`…DvI=`). Dropping the padding — the
 * usual convention everywhere else — makes the server reject the token with a
 * bare `401 bad token` that names neither the field nor the reason. Keeping it
 * is what makes the HMAC valid.
 */
function urlsafeBase64(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Build the upload token for one object.
 *
 * The policy pins `scope` to `bucket:key` so the token can only write that one
 * object — a leaked token cannot be reused to overwrite anything else, and it
 * expires in minutes rather than the default hour.
 */
export function buildUploadToken({ accessKey, secretKey, bucket, key, expiresInSeconds = 600 }) {
  const deadline = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const putPolicy = JSON.stringify({ scope: `${bucket}:${key}`, deadline });
  const encodedPolicy = urlsafeBase64(putPolicy);
  const sign = createHmac('sha1', secretKey).update(encodedPolicy).digest();
  return `${accessKey}:${urlsafeBase64(sign)}:${encodedPolicy}`;
}

/** Guess a content type from the extension; Qiniu stores what it is given. */
function contentTypeFor(path) {
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    default: return 'application/octet-stream';
  }
}

/**
 * Upload one file and return its public URL.
 *
 * @param {object} config `{ accessKey, secretKey, bucket, domain, region }`.
 * @param {string} localPath file to upload.
 * @param {string} [objectKey] override the generated object name.
 */
export async function uploadToQiniu(config, localPath, objectKey) {
  const accessKey = String(config?.accessKey ?? '').trim();
  const secretKey = String(config?.secretKey ?? '').trim();
  const bucket = String(config?.bucket ?? '').trim();
  const domain = String(config?.domain ?? '').trim().replace(/\/+$/, '');

  if (accessKey === '' || secretKey === '') {
    return { ok: false, error: '缺少七牛 AccessKey / SecretKey' };
  }
  if (bucket === '') return { ok: false, error: '缺少七牛存储空间名（bucket）' };
  if (domain === '') {
    return {
      ok: false,
      error: '缺少七牛访问域名',
      hint: '在七牛控制台给这个空间绑定一个域名，形如 https://cdn.example.com',
    };
  }
  if (!existsSync(localPath)) return { ok: false, error: `文件不存在: ${localPath}` };

  const size = statSync(localPath).size;
  // Qiniu's simple upload caps at 1 GB; the provider's own image limit is far
  // lower, so anything this large is a mistake rather than a real use case.
  if (size > 50 * 1024 * 1024) {
    return { ok: false, error: `文件 ${Math.round(size / 1024 / 1024)} MB 过大，上限 50 MB` };
  }

  const ext = extname(localPath) || '.png';
  const key = objectKey ?? `omni/${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
  const token = buildUploadToken({ accessKey, secretKey, bucket, key });

  const host = UPLOAD_HOSTS[String(config?.region ?? 'z0')] ?? UPLOAD_HOSTS.z0;
  const form = new FormData();
  form.append('token', token);
  form.append('key', key);
  form.append('file', new Blob([readFileSync(localPath)], { type: contentTypeFor(localPath) }),
    basename(localPath));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch(host, { method: 'POST', body: form, signal: controller.signal });
    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch { /* a non-JSON body is reported below */ }

    if (!response.ok) {
      return {
        ok: false,
        error: `七牛上传失败（HTTP ${response.status}）`,
        detail: payload?.error ?? text.slice(0, 300),
      };
    }
    const finalKey = payload?.key ?? key;
    // A Qiniu trial domain (anything on *.clouddn.com / *.qnssl.com shipped with
    // a new bucket) serves plain HTTP only; the certificate is issued for the
    // CDN's own hostnames, so an https request fails TLS verification before it
    // reaches the file. Probing once here means the caller gets a URL that
    // actually loads rather than one that looks right and 404s later.
    const probe = await probeReachable(domain, finalKey);
    return {
      ok: true,
      url: probe.url,
      key: finalKey,
      bytes: size,
      host,
      https: probe.https,
      note: probe.https ? undefined : '该域名只支持 http（七牛测试域名的证书不含此主机名）',
    };
  }
  catch (error) {
    const aborted = error?.name === 'AbortError';
    return {
      ok: false,
      error: aborted ? '七牛上传超时（120 秒）' : '七牛上传失败',
      detail: String(error?.message ?? error),
    };
  }
  finally {
    clearTimeout(timer);
  }
}

/**
 * Find the scheme that actually serves the uploaded file.
 *
 * Tries https first because every provider wants it; falls back to http when the
 * certificate does not cover the hostname, which is the normal state of a Qiniu
 * trial domain.
 */
async function probeReachable(domain, key) {
  const base = domain.replace(/\/+$/, '');
  const httpsUrl = base.startsWith('http') ? base.replace(/^http:/, 'https:') + '/' + key : 'https://' + base + '/' + key;
  try {
    const res = await fetch(httpsUrl, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
    if (res.ok) return { url: httpsUrl, https: true };
  } catch { /* TLS or DNS failure: fall through to http */ }
  return { url: httpsUrl.replace(/^https:/, 'http:'), https: false };
}

/**
 * Resolve whatever the caller passed into a URL the provider can fetch.
 *
 * Three shapes are accepted, because all three occur in practice:
 *
 *   - an already-public `http(s)` URL → returned unchanged, no upload
 *   - a local path → uploaded, then the new URL is returned
 *   - `file://` → treated as a local path
 *
 * Keeping this in one place means every adapter that needs a public image gets
 * the same behaviour and the same error messages.
 */
export async function ensurePublicUrl(ctx, config, value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw === '') return { ok: false, error: '空地址' };

  if (/^https?:\/\//i.test(raw)) return { ok: true, url: raw, uploaded: false };

  const localPath = raw.replace(/^file:\/\/\/?/i, '');
  if (!existsSync(localPath)) {
    return { ok: false, error: `既不是公网 URL，本地也找不到这个文件: ${raw.slice(0, 80)}` };
  }

  const host = config?.imageHost;
  if (host === undefined || host === null || String(host.kind ?? '') === '') {
    return {
      ok: false,
      error: '需要把本地图片上传到图床，但没有配置图床',
      hint: '在设置里配置七牛（accessKey / secretKey / bucket / domain），'
        + '或者直接传一个已经是公网地址的图片 URL',
    };
  }

  if (String(host.kind) !== 'qiniu') {
    return { ok: false, error: `不认识的图床类型: ${host.kind}` };
  }

  const result = await uploadToQiniu(host, localPath);
  if (result.ok !== true) return result;
  return { ok: true, url: result.url, uploaded: true, bytes: result.bytes };
}
