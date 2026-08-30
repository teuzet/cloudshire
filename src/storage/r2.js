/**
 * Cloudflare R2 (S3 API). Картины живут в бакете; в домене только URL и ключ.
 * Ключи — из env, не из YAML.
 */

import { createHash, createHmac } from 'node:crypto';

function trimSlash(s) {
  return String(s || '').trim().replace(/\/+$/, '');
}

export function r2Settings(config = null) {
  const yaml = config?.images?.r2 || {};
  const accountId = String(process.env.R2_ACCOUNT_ID || yaml.accountId || '').trim();
  const accessKeyId = String(process.env.R2_ACCESS_KEY_ID || yaml.accessKeyId || '').trim();
  const secretAccessKey = String(process.env.R2_SECRET_ACCESS_KEY || yaml.secretAccessKey || '').trim();
  const bucket = String(process.env.R2_BUCKET || yaml.bucket || '').trim();
  const publicBaseUrl = trimSlash(process.env.R2_PUBLIC_BASE_URL || yaml.publicBaseUrl || '');
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket || !publicBaseUrl) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket, publicBaseUrl };
}

export function r2Enabled(config = null) {
  return Boolean(r2Settings(config));
}

export function islandObjectKey(domainId) {
  return `islands/${String(domainId)}.png`;
}

export function officerObjectKey(domainId, office) {
  return `officers/${String(domainId)}_${String(office)}.png`;
}

export function r2PublicUrl(settings, key) {
  if (!settings || !key) return null;
  const path = String(key)
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  return `${settings.publicBaseUrl}/${path}`;
}

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

function amzDate(now = new Date()) {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amz: iso, day: iso.slice(0, 8) };
}

function signingKey(secret, day) {
  const kDate = hmac(`AWS4${secret}`, day);
  const kRegion = hmac(kDate, 'auto');
  const kService = hmac(kRegion, 's3');
  return hmac(kService, 'aws4_request');
}

function canonicalPath(bucket, key) {
  const parts = [bucket, ...String(key).split('/').filter(Boolean)].map(encodeURIComponent);
  return `/${parts.join('/')}`;
}

async function signedFetch(settings, { method, key, body = null, contentType = 'image/png' }) {
  const host = `${settings.accountId}.r2.cloudflarestorage.com`;
  const uri = canonicalPath(settings.bucket, key);
  const url = `https://${host}${uri}`;
  const { amz, day } = amzDate();
  const payloadHash = sha256Hex(body || '');
  const headersToSign = [['host', host], ['x-amz-content-sha256', payloadHash], ['x-amz-date', amz]];
  if (method === 'PUT') headersToSign.unshift(['content-type', contentType]);
  const signedHeaderNames = headersToSign.map(([n]) => n).join(';');
  const canonicalHeaders = headersToSign.map(([n, v]) => `${n}:${v}\n`).join('');
  const canonical = [method, uri, '', canonicalHeaders, signedHeaderNames, payloadHash].join('\n');
  const scope = `${day}/auto/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amz, scope, sha256Hex(canonical)].join('\n');
  const signature = createHmac('sha256', signingKey(settings.secretAccessKey, day))
    .update(stringToSign)
    .digest('hex');
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${settings.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaderNames}, Signature=${signature}`;
  const headers = {
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amz,
    authorization,
  };
  if (method === 'PUT') headers['content-type'] = contentType;
  const res = await fetch(url, {
    method,
    headers,
    body: method === 'PUT' ? body : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`R2 ${method} ${res.status}: ${text.slice(0, 240) || res.statusText}`);
  }
  return res;
}

export async function putR2Object(config, { key, buffer, contentType = 'image/png' }) {
  const settings = r2Settings(config);
  if (!settings) throw new Error('R2 is not configured');
  await signedFetch(settings, { method: 'PUT', key, body: buffer, contentType });
  return r2PublicUrl(settings, key);
}

export async function deleteR2Object(config, key) {
  const settings = r2Settings(config);
  if (!settings || !key) return;
  try {
    await signedFetch(settings, { method: 'DELETE', key, body: null, contentType: 'application/octet-stream' });
  } catch {
    /* нет объекта — не мешает wipe */
  }
}

export async function persistPngToR2(config, { key, buffer, log }) {
  const settings = r2Settings(config);
  if (!settings) return null;
  try {
    const url = await putR2Object(config, { key, buffer });
    log?.info('r2.put', { key, bytes: buffer.length });
    return { url, key };
  } catch (err) {
    log?.warn('r2.put_failed', { key, error: err.message });
    return null;
  }
}

export function domainHasIslandImage(domain) {
  return Boolean(domain?.imageUrl || domain?.imagePath || domain?.imageBase64);
}

export function officerHasPortrait(officer) {
  return Boolean(officer?.portraitUrl || officer?.portraitPath || officer?.portraitBase64);
}

/** Стереть объекты домена из бакета. Локальные файлы не трогает. */
export async function purgeDomainMedia(config, domain) {
  if (!domain || !r2Enabled(config)) return;
  const islandKey = domain.imageKey || (domain.id ? islandObjectKey(domain.id) : null);
  if (islandKey) await deleteR2Object(config, islandKey);
  for (const officer of domain.officers || []) {
    const key =
      officer?.portraitKey ||
      (domain.id && officer?.office ? officerObjectKey(domain.id, officer.office) : null);
    if (key) await deleteR2Object(config, key);
  }
}
