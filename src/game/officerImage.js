/**
 * Портреты сановников: квадрат, тот же стиль, что у острова, погрудный кадр.
 * Генезис город игроку не блокирует — как картина острова.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from '../config.js';
import { createLlmProvider } from '../llm/index.js';
import { getLogger, truncate } from '../log.js';
import { persistPngToR2, officerObjectKey } from '../storage/r2.js';
import { formatAxesForSpeech, formatLookForSpeech, officerGender, ensureOfficerLook } from './officers.js';

function clip(text, max) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const last = cut.lastIndexOf(' ');
  return `${(last > max * 0.6 ? cut.slice(0, last) : cut).replace(/[\s,;:—-]+$/, '')}…`;
}

export function officerImageDir(config) {
  const raw = config?.genesis?.officers?.image?.dir || 'data/images/officers';
  return path.isAbsolute(raw) ? raw : path.join(projectRoot(), raw);
}

export function officerImageFile(config, domainId, office) {
  return path.join(officerImageDir(config), `${domainId}_${office}.png`);
}

export function composeOfficerPortraitPrompt({ officer, style, cityName } = {}) {
  const sex = officerGender(officer);
  const female = sex === 'female';
  const look = formatLookForSpeech(officer?.look, sex);
  const age = Number(officer?.look?.ageYears || officer?.ageYears);
  const ageBit = Number.isFinite(age) ? ` about ${Math.round(age)} years old` : '';
  const name = String(officer?.name || '').trim();
  return [
    female
      ? `Square Northern-Renaissance bust or half-length portrait of ONE living WOMAN${ageBit}.`
      : `Square Northern-Renaissance bust or half-length portrait of ONE living MAN${ageBit}.`,
    female
      ? 'The sitter is an adult woman: feminine face and body. Do not paint a man, a boy, or an androgynous male scholar.'
      : 'The sitter is an adult man: masculine face and body. Do not paint a woman or a girl.',
    'Facing the viewer, calm indoor light, no letters, no UI, no coat of arms, no frame.',
    female
      ? `This woman holds office in the city ${cityName || ''}: ${officer?.title || 'officer'}. Paint her, not the word of the office.`
      : `This man holds office in the city ${cityName || ''}: ${officer?.title || 'officer'}. Paint him, not the word of the office.`,
    female ? 'Use she/her. This officer is a woman.' : 'Use he/him. This officer is a man.',
    name
      ? `The given name is ${name}; never letter the name or any caption on the painting.`
      : 'Do not write any name on the painting.',
    look ? `Appearance: ${look}.` : '',
    officer?.nature ? `Character (paint temperament, not attributes): ${clip(officer.nature, 280)}` : '',
    officer?.axes ? `Temperament hints: ${formatAxesForSpeech(officer.axes)}.` : '',
    'STYLE (obey strictly; same world as the island vedute, but this is a portrait, not a landscape):',
    String(style || '').trim(),
    'No text, captions, signatures, modern clothing, anime, CGI sheen.',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function generateOfficerPortrait({ config, domain, officer, log }) {
  const cfg = config?.genesis?.officers?.image || {};
  if (cfg.enabled === false || !officer) return null;
  ensureOfficerLook(officer, config);
  const style =
    String(cfg.style || '').trim() ||
    String(config?.genesis?.image?.style || '').trim();
  const prompt = composeOfficerPortraitPrompt({
    officer,
    style,
    cityName: domain?.name,
  });
  log?.info('officer_image.prompt', {
    domainId: domain?.id,
    office: officer.office,
    gender: officerGender(officer),
    preview: truncate(prompt, 300),
  });
  try {
    const provider = createLlmProvider(config, cfg.provider || config?.genesis?.image?.provider || 'openai');
    const { buffer } = await provider.image({
      model: cfg.model || config?.genesis?.image?.model || 'gpt-image-2',
      prompt,
      size: cfg.size || '1024x1024',
      quality: cfg.quality || 'medium',
    });
    const abs = officerImageFile(config, domain.id, officer.office);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, buffer);
    const rel = path.relative(projectRoot(), abs);
    const uploaded = await persistPngToR2(config, {
      key: officerObjectKey(domain.id, officer.office),
      buffer,
      log,
    });
    officer.portraitPath = rel;
    officer.portraitUrl = uploaded?.url || null;
    officer.portraitKey = uploaded?.key || null;
    officer.portraitBase64 = uploaded ? null : buffer.toString('base64');
    log?.info('officer_image.saved', {
      domainId: domain.id,
      office: officer.office,
      path: rel,
      bytes: buffer.length,
      url: officer.portraitUrl,
    });
    return {
      path: rel,
      abs,
      url: officer.portraitUrl,
      key: officer.portraitKey,
      base64: officer.portraitBase64,
    };
  } catch (err) {
    log?.warn('officer_image.failed', {
      domainId: domain?.id,
      office: officer?.office,
      error: err.message,
    });
    return null;
  }
}

export async function generateOfficerPortraits({ config, domain, log }) {
  const list = domain?.officers || [];
  await Promise.all(
    list.map((officer) => generateOfficerPortrait({ config, domain, officer, log })),
  );
  return list;
}

export async function resolveOfficerPortrait({ domain, officer, config }) {
  if (!officer) return null;
  if (officer.portraitPath) {
    const abs = path.resolve(projectRoot(), officer.portraitPath);
    try {
      const buffer = await fs.readFile(abs);
      return { abs, buffer, path: officer.portraitPath };
    } catch {
      /* fall through */
    }
  }
  if (officer.portraitBase64) {
    const buffer = Buffer.from(officer.portraitBase64, 'base64');
    const abs = officerImageFile(config, domain.id, officer.office);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, buffer);
    return { abs, buffer, path: path.relative(projectRoot(), abs) };
  }
  return null;
}

export async function removeOfficerPortraits(config, domain) {
  const root = path.resolve(officerImageDir(config));
  for (const officer of domain?.officers || []) {
    const file = officer?.portraitPath
      ? path.resolve(projectRoot(), officer.portraitPath)
      : domain?.id && officer?.office
        ? officerImageFile(config, domain.id, officer.office)
        : null;
    if (!file) continue;
    if (!file.startsWith(root + path.sep) && file !== root) continue;
    await fs.unlink(file).catch(() => {});
  }
}
