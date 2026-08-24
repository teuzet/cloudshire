import fs from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from '../config.js';
import { createLlmProvider } from '../llm/index.js';

const CONTENT_MAX = 900;

function clip(text, max) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const last = cut.lastIndexOf(' ');
  return `${(last > max * 0.6 ? cut.slice(0, last) : cut).replace(/[\s,;:—-]+$/, '')}…`;
}

export function islandImageDir(config) {
  const raw = config?.genesis?.image?.dir || 'data/images';
  return path.isAbsolute(raw) ? raw : path.join(projectRoot(), raw);
}

export function islandImageFile(config, domainId) {
  return path.join(islandImageDir(config), `${domainId}.png`);
}

export function buildIslandImagePrompt(domain, config) {
  const style = String(config?.genesis?.image?.style || '').trim();
  const overview = clip(domain?.aspects?.overview || domain?.description, CONTENT_MAX);
  const geography = clip(domain?.aspects?.geography, 500);
  return [
    'Wide 16:9 establishing painting of ONE flying island, seen from a high distant vantage.',
    `The place is called ${domain?.name || 'the city'}; do not write the name or any other letters in the picture.`,
    'SCALE AND LAYOUT (mandatory, do not ignore):',
    'The island is LARGE. A compact city sits in the CENTER, occupying only a fraction of the land.',
    'Around the city — miles of countryside before any cliff: fields, orchards, woods, hamlets, tracks, quarries.',
    'The rim is far away: a distant drop into cloud, not touching the city walls.',
    'Do NOT paint a city that fills the island or sits on the brink. Do NOT crop so the streets meet the void.',
    'CONTENT (what the city looks like — follow this, do not invent another city):',
    overview || 'A compact stone city on a broad inhabited flying island.',
    geography ? `The land around the city: ${geography}` : '',
    'STYLE (obey strictly; every city in this world shares it):',
    style,
    'No text, captions, UI, frames, signatures, maps, flags with letters, or earth landmarks.',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function removeIslandImage(config, domain) {
  const file = domain?.imagePath
    ? path.resolve(projectRoot(), domain.imagePath)
    : domain?.id
      ? islandImageFile(config, domain.id)
      : null;
  if (!file) return;
  const root = path.resolve(islandImageDir(config));
  if (!file.startsWith(root + path.sep) && file !== root) return;
  await fs.unlink(file).catch(() => {});
}

/**
 * Рисует остров. Ошибка не бросается наружу — генезис от картинки не зависит.
 */
export async function generateIslandImage({ config, domain, log }) {
  const cfg = config?.genesis?.image || {};
  if (cfg.enabled === false) return null;
  const prompt = buildIslandImagePrompt(domain, config);
  try {
    const provider = createLlmProvider(config, cfg.provider || 'openai');
    const { buffer } = await provider.image({
      model: cfg.model || 'gpt-image-2',
      prompt,
      size: cfg.size || '1792x1024',
      quality: cfg.quality || 'medium',
    });
    const abs = islandImageFile(config, domain.id);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, buffer);
    const rel = path.relative(projectRoot(), abs);
    log?.info('island_image.saved', { domainId: domain.id, path: rel, bytes: buffer.length });
    return { path: rel, abs };
  } catch (err) {
    log?.warn('island_image.failed', { domainId: domain.id, error: err.message });
    return null;
  }
}
