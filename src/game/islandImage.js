import fs from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from '../config.js';
import { createLlmProvider } from '../llm/index.js';
import { getLogger, truncate } from '../log.js';
import { toolFail } from '../agents/toolResult.js';

const CONTENT_MAX = 900;
const WISH_MAX = 500;
const AGENT_CONTENT_MAX = 1200;

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

/** Визуальные пожелания игрока: город и свободный текст, не характер правителя. */
export function formatPlayerVisualWish(brief) {
  const parts = [brief?.city, brief?.freeform]
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  return parts.join('\n');
}

function fallbackContent(domain) {
  const overview = clip(domain?.aspects?.overview || domain?.description, CONTENT_MAX);
  const geography = clip(domain?.aspects?.geography, 400);
  const landmarks = clip(domain?.aspects?.landmarks, 300);
  return [
    overview || 'A compact stone city on a broad inhabited flying island.',
    geography ? `The land around the city: ${geography}` : '',
    landmarks ? `Notable places: ${landmarks}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

const LAYOUT = [
  'SCALE AND LAYOUT (mandatory, do not ignore):',
  'The island is LARGE. A compact city sits in the CENTER, occupying only a fraction of the land.',
  'Around the city — miles of countryside before any cliff: fields, orchards, woods, hamlets, tracks, quarries.',
  'The rim is far away: a distant drop into cloud, not touching the city walls.',
  'Do NOT paint a city that fills the island or sits on the brink. Do NOT crop so the streets meet the void.',
  'No sky-ships, no hanging harbors, no docks on the rim.',
].join('\n');

/** Собирает финальный промпт: контент агента + обязательный стиль из конфига. */
export function composeIslandImagePrompt({ name, content, style, playerWish } = {}) {
  const wish = clip(playerWish, WISH_MAX);
  return [
    'Wide 16:9 establishing painting of ONE flying island, seen from a high distant vantage.',
    `The place is called ${name || 'the city'}; do not write the name or any other letters in the picture.`,
    LAYOUT,
    wish
      ? `The patron asked to see this — it MUST be visible and distinctive, not a generic substitute:\n${wish}`
      : '',
    'UNIQUE FEATURES OF THIS CITY (follow closely; this is not a generic sky-isle):',
    clip(content, AGENT_CONTENT_MAX) || 'A compact inhabited city with its own terrain and work.',
    'STYLE (obey strictly; every city in this world shares this medium; do not change it):',
    String(style || '').trim(),
    'No text, captions, UI, frames, signatures, maps, flags with letters, or earth landmarks.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildIslandImagePrompt(domain, config, { content, playerWish } = {}) {
  const style = String(config?.genesis?.image?.style || '').trim();
  const wish = playerWish ?? formatPlayerVisualWish(domain?.playerBrief);
  return composeIslandImagePrompt({
    name: domain?.name,
    content: content || fallbackContent(domain),
    style,
    playerWish: wish,
  });
}

function cityBriefForImageAgent(domain) {
  const aspects = domain?.aspects || {};
  const parts = [
    ['Overview', aspects.overview],
    ['Geography', aspects.geography],
    ['Districts', aspects.districts],
    ['Architecture', aspects.architecture],
    ['Landmarks', aspects.landmarks],
    ['Crafts', aspects.crafts],
  ]
    .map(([title, text]) => {
      const body = clip(text, 420);
      return body ? `${title}: ${body}` : '';
    })
    .filter(Boolean);
  return parts.join('\n') || clip(domain?.description, 800);
}

async function askIslandImageContent({ runtime, domain, playerWish, log }) {
  if (!runtime) return null;
  const draft = { content: null };
  try {
    await runtime.run({
      agentId: 'islandImage',
      tools: [
        {
          name: 'submit_image_content',
          description:
            'English visual brief: unique visible features of THIS city. No art-style, no lighting recipe.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['content'],
            properties: {
              content: {
                type: 'string',
                description:
                  '120–900 characters, English. Concrete visible things: terrain, roofs, work, plants, color of stone. Not style.',
              },
            },
          },
          handler: async ({ content }) => {
            const text = String(content || '').trim();
            if (text.length < 80) {
              return toolFail('thin_content', 'Слишком общо. Назови конкретные видимые черты ЭТОГО города.');
            }
            draft.content = text;
            return { ok: true };
          },
        },
      ],
      maxTurns: 3,
      toolChoice: { type: 'function', function: { name: 'submit_image_content' } },
      log,
      scene: 'island_image_prompt',
      domainId: domain?.id,
      extraSystem: playerWish
        ? `PATRON WISHES (must appear in the picture, prominent):\n${clip(playerWish, WISH_MAX)}`
        : 'The patron left no visual wishes — pick the city’s own striking features.',
      userMessages: [
        {
          role: 'user',
          content: [
            `City: ${domain?.name || 'unknown'}.`,
            cityBriefForImageAgent(domain),
            'Call submit_image_content with English visual content only.',
          ].join('\n\n'),
        },
      ],
    });
  } catch (err) {
    log?.warn('island_image.prompt_failed', { error: err.message });
    return null;
  }
  return draft.content;
}

/**
 * Рисует остров. Ошибка не бросается наружу — генезис от картинки не зависит.
 */
export async function generateIslandImage({ config, domain, runtime, playerBrief, log }) {
  const cfg = config?.genesis?.image || {};
  if (cfg.enabled === false) return null;
  const wish = formatPlayerVisualWish(playerBrief || domain?.playerBrief);
  const content = await askIslandImageContent({
    runtime,
    domain,
    playerWish: wish,
    log: (log || getLogger()).child({ scope: 'island_image' }),
  });
  const prompt = buildIslandImagePrompt(domain, config, { content, playerWish: wish });
  log?.info('island_image.prompt', {
    domainId: domain?.id,
    agent: Boolean(content),
    wish: Boolean(wish),
    preview: truncate(prompt, 400),
  });
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
    return { path: rel, abs, base64: buffer.toString('base64'), buffer };
  } catch (err) {
    log?.warn('island_image.failed', { domainId: domain.id, error: err.message });
    return null;
  }
}

export async function resolveIslandImage({ domain, config }) {
  if (!domain) return null;
  if (domain.imagePath) {
    const abs = path.resolve(projectRoot(), domain.imagePath);
    try {
      const buffer = await fs.readFile(abs);
      return { abs, buffer, path: domain.imagePath };
    } catch {
      /* fall through to base64 */
    }
  }
  if (domain.imageBase64) {
    const buffer = Buffer.from(domain.imageBase64, 'base64');
    const abs = islandImageFile(config, domain.id);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, buffer);
    return { abs, buffer, path: path.relative(projectRoot(), abs) };
  }
  return null;
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
