import crypto from 'node:crypto';

const MAX_AGE_SEC = 48 * 60 * 60;

/**
 * Проверка initData мини-аппки Telegram.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function validateTelegramInitData(initData, botToken, { maxAgeSec = MAX_AGE_SEC, nowSec = null } = {}) {
  const raw = String(initData || '').trim();
  const token = String(botToken || '').trim();
  if (!raw) return { ok: false, error: 'no_init_data' };
  if (!token) return { ok: false, error: 'no_bot_token' };

  const params = new URLSearchParams(raw);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]+$/i.test(hash)) return { ok: false, error: 'no_hash' };
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const computed = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: 'bad_hash' };
  }

  const authDate = Number(params.get('auth_date'));
  const now = nowSec == null ? Date.now() / 1000 : Number(nowSec);
  if (maxAgeSec && Number.isFinite(authDate) && now - authDate > maxAgeSec) {
    return { ok: false, error: 'expired' };
  }

  let user = null;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch {
    return { ok: false, error: 'bad_user' };
  }
  if (!user || user.id == null) return { ok: false, error: 'no_user' };
  return { ok: true, userId: String(user.id), user };
}

export function telegramBotToken(config) {
  const envName = config?.telegram?.tokenEnv || 'TELEGRAM_BOT_TOKEN';
  return String(process.env[envName] || '').trim();
}

/** HTTPS-адрес мини-аппки. Пусто — кнопку меню не ставим. */
export function miniAppUrl(config) {
  const raw = String(
    process.env.TELEGRAM_MINI_APP_URL || config?.telegram?.miniAppUrl || '',
  ).trim();
  if (raw) {
    const base = raw.replace(/\/+$/, '');
    if (/\/mini$/i.test(base)) return `${base}/`;
    return `${base}/mini/`;
  }
  const railway = String(process.env.RAILWAY_PUBLIC_DOMAIN || '').trim();
  if (railway) return `https://${railway.replace(/^https?:\/\//, '')}/mini/`;
  return '';
}

export function miniAppMenuText(config) {
  return String(config?.telegram?.miniAppMenu || 'Город').trim() || 'Город';
}
