/**
 * Полный слепок попытки посева: хроники, отзывы судьи, исход.
 * Session log режет tool args — этот файл пишет тексты целиком.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from '../config.js';
import { getLogger } from '../log.js';
import { collectBrainstormPoolEntries } from './freeformBrainstorm.js';

export function seedDumpEnabled(config) {
  return config?.logging?.seedDump !== false;
}

export function seedDumpDir(config) {
  const raw = config?.logging?.seedDumpDir;
  if (raw) return path.resolve(projectRoot(), raw);
  const root = config?.logging?.dir || 'logs';
  return path.resolve(projectRoot(), root, 'plot-seeds');
}

function slug(value, fallback = 'city') {
  const text = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9а-яё_-]+/gi, '-')
    .replace(/^-+|-+$/g, '');
  return text || fallback;
}

function stampName(at = new Date()) {
  return at.toISOString().replace(/[:.]/g, '-');
}

function candidateText(candidate) {
  return String(candidate?.chronicle || candidate?.text || candidate?.hook || '').trim();
}

function formatAxes(candidate) {
  return [candidate?.arena, candidate?.worldRelation, candidate?.conflictSource, candidate?.temporalShape]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' · ');
}

function formatCandidateBlock(candidate, index) {
  const n = Number(candidate?.index) || index;
  const axes = formatAxes(candidate);
  const author = String(candidate?.authorName || '').trim();
  const text = candidateText(candidate);
  return [
    `### Кандидат ${n}`,
    axes || null,
    author ? `автор: ${author}` : null,
    '',
    text || '_пусто_',
  ]
    .filter((line) => line != null)
    .join('\n');
}

function formatReviewBlock(review, index) {
  const n = Number(review?.index) || index;
  const verdict = String(review?.verdict || '?').trim();
  const issues = (review?.issues || [])
    .map((issue) => `- \`${issue.code}\`: ${issue.reason}`)
    .join('\n');
  return [
    `### ${n} — ${verdict}`,
    '',
    review?.summary || '_нет краткого отзыва_',
    review?.repair ? `\n**repair:** ${review.repair}` : null,
    issues ? `\n${issues}` : null,
  ]
    .filter((line) => line != null)
    .join('\n');
}

function sameCandidatePack(left = [], right = []) {
  if (left.length !== right.length) return false;
  return left.every((item, i) => candidateText(item) === candidateText(right[i]));
}

const POOL_SOURCE_LABEL = {
  first_pass: 'первый PASS',
  repaired: 'PASS после починки',
};

function poolEntriesFromPack(pack) {
  return collectBrainstormPoolEntries(
    pack?.drafts || [],
    pack?.reviews || [],
    pack?.candidates || [],
    pack?.finalReviews || [],
  );
}

function formatPoolLine(entries, { winnerIndex = null, slotCount = 0 } = {}) {
  if (!entries.length) return 'пуст — судья никого не пропустил';
  const listed = entries
    .map((entry) => `${entry.index} (${POOL_SOURCE_LABEL[entry.source] || entry.source})`)
    .join(', ');
  const of = slotCount > 0 ? ` (${entries.length} из ${slotCount})` : '';
  const picked = Number.isInteger(Number(winnerIndex)) && Number(winnerIndex) > 0 ? `; выбран ${winnerIndex}` : '';
  return `кандидаты ${listed}${of}${picked}`;
}

function pickRolls(pack) {
  return (pack?.rolls || []).map((roll) =>
    [
      ...(roll.pair || []).map((tag) => `${tag.groupId}:${tag.tagId}`),
      roll.conflictSource?.id,
      roll.temporalShape?.id,
      roll.author?.id,
    ]
      .filter(Boolean)
      .join('+'),
  );
}

export function serializePlotSeedDump(payload) {
  const pack = payload.pack || {};
  return {
    outcome: payload.outcome || null,
    error: payload.error || null,
    at: payload.at || new Date().toISOString(),
    domain: {
      id: payload.domain?.id || null,
      name: payload.domain?.name || null,
    },
    request: {
      gravity: payload.request?.gravity || pack.gravity || null,
      fromVoid: Boolean(payload.request?.fromVoid),
      fromGenesis: Boolean(payload.request?.fromGenesis),
      requireMystery: Boolean(payload.request?.requireMystery),
      seedText: payload.request?.seedText || '',
    },
    rolls: pack.rolls || [],
    drafts: pack.drafts || [],
    reviews: pack.reviews || [],
    candidates: pack.candidates || [],
    finalReviews: pack.finalReviews || [],
    winnerIndex: pack.pickedIndex ?? null,
    winner: pack.winner || null,
    pickSource: pack.pickSource || null,
    pickWhy: pack.pickWhy || '',
    pool: poolEntriesFromPack(pack).map((entry) => ({
      index: entry.index,
      source: entry.source,
      candidate: entry.candidate || null,
    })),
    assembled: payload.assembled || null,
    plot: payload.plot || null,
    prompts: {
      architect: pack.prompt || '',
      judge: pack.judgePrompt || '',
      repair: pack.repairPrompt || '',
      finalJudge: pack.finalJudgePrompt || '',
      extraRepair: pack.extraRepairPrompt || '',
      extraJudge: pack.extraJudgePrompt || '',
      pick: pack.pickPrompt || '',
    },
  };
}

export function formatPlotSeedDumpMarkdown(payload) {
  const data = serializePlotSeedDump(payload);
  const rolls = pickRolls({ rolls: data.rolls });
  const drafts = data.drafts || [];
  const later = data.candidates || [];
  const repairedDiffer = drafts.length && later.length && !sameCandidatePack(drafts, later);
  const grain = data.request.fromGenesis
    ? 'описание города'
    : data.request.fromVoid
      ? 'пустота'
      : 'хроника';
  const lines = [
    `# ${data.domain.name || data.domain.id || 'город'} · ${data.request.gravity || 'seed'} · ${grain}${
      data.request.requireMystery ? ' · с тайной' : ''
    }`,
    '',
    data.outcome === 'planted'
      ? `Посев удался: «${data.plot?.title || data.assembled?.title || 'без названия'}».`
      : data.outcome === 'no_winner'
        ? 'История не посадилась: судья никого не пропустил (`no_winner`).'
        : `Посев оборвался: ${data.error || data.outcome || 'ошибка'}.`,
    '',
    `- Время: ${data.at}`,
    `- Город: ${data.domain.name || '—'} (${data.domain.id || 'без id'})`,
    `- Зерно: ${grain}`,
    `- Масштаб: ${data.request.gravity || '—'}`,
    `- Тайна: ${data.request.requireMystery ? 'обязательна' : 'нет'}`,
    `- Исход: \`${data.outcome || 'unknown'}\``,
    `- Финальный пул: ${formatPoolLine(data.pool || [], {
      winnerIndex: data.winnerIndex,
      slotCount: (data.drafts || []).length,
    })}`,
    '',
    '## Жребий осей',
    '',
    rolls.length ? rolls.map((line) => `- \`${line}\``).join('\n') : '_жребий не сохранился_',
    '',
    '## Черновик',
    '',
    drafts.length
      ? drafts.map((item, i) => formatCandidateBlock(item, i + 1)).join('\n\n')
      : '_нет черновиков_',
    '',
    '## Судья пачки',
    '',
    (data.reviews || []).length
      ? data.reviews.map((item, i) => formatReviewBlock(item, i + 1)).join('\n\n')
      : '_нет отзыва_',
  ];

  if (repairedDiffer) {
    lines.push('', '## После починки', '', later.map((item, i) => formatCandidateBlock(item, i + 1)).join('\n\n'));
  }
  if ((data.finalReviews || []).some(Boolean)) {
    lines.push(
      '',
      '## Судья после починки',
      '',
      data.finalReviews
        .filter(Boolean)
        .map((item, i) => formatReviewBlock(item, i + 1))
        .join('\n\n'),
    );
  }
  if ((data.pool || []).length) {
    lines.push(
      '',
      '## Финальный пул',
      '',
      `${
        data.pickSource === 'agent'
          ? 'Дешёвый агент выбрал среди PASS'
          : data.pickSource === 'single'
            ? 'В пуле один PASS'
            : data.pickSource === 'fallback'
              ? 'Агент не выбрал, случайный среди PASS'
              : 'Выбор среди PASS'
      }: ${formatPoolLine(data.pool, {
        winnerIndex: data.winnerIndex,
        slotCount: (data.drafts || []).length,
      })}.`,
      data.pickWhy ? `Почему: ${data.pickWhy}` : null,
      '',
      data.pool
        .map((entry) => {
          const origin = POOL_SOURCE_LABEL[entry.source] || entry.source;
          return `${formatCandidateBlock(entry.candidate, entry.index)}\n\n_в пуле: ${origin}_`;
        })
        .join('\n\n'),
    );
  } else {
    lines.push('', '## Финальный пул', '', 'Пул пуст: ни один кандидат не получил PASS.');
  }
  if (data.winner) {
    lines.push('', '## Победитель', '', formatCandidateBlock(data.winner, data.winnerIndex || 1));
    if (data.pickWhy) lines.push('', data.pickWhy);
  }
  if (data.assembled?.chronicle) {
    lines.push('', '## Собранная хроника', '', data.assembled.chronicle);
  }
  lines.push('', '## Итог', '', `Посев: \`${data.outcome || 'unknown'}\`${data.error ? ` (${data.error})` : ''}.`);
  return `${lines.filter((line) => line != null).join('\n')}\n`;
}

export async function writePlotSeedDump(payload, config) {
  if (!seedDumpEnabled(config)) return null;
  try {
    const dir = seedDumpDir(config);
    await fs.mkdir(dir, { recursive: true });
    const base = [
      slug(payload.domain?.name || payload.domain?.id),
      slug(payload.request?.gravity || payload.pack?.gravity || 'seed', 'seed'),
      payload.request?.requireMystery ? 'mystery' : 'plain',
      stampName(payload.at ? new Date(payload.at) : new Date()),
    ].join('-');
    const jsonPath = path.join(dir, `${base}.json`);
    const mdPath = path.join(dir, `${base}.md`);
    const data = serializePlotSeedDump(payload);
    await fs.writeFile(jsonPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await fs.writeFile(mdPath, formatPlotSeedDumpMarkdown(payload), 'utf8');
    getLogger().info('seed.dump_written', { jsonPath, mdPath, outcome: data.outcome });
    return { jsonPath, mdPath };
  } catch (err) {
    getLogger().warn('seed.dump_failed', { error: err.message });
    return null;
  }
}
