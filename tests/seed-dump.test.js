import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { formatPlotSeedDumpMarkdown, writePlotSeedDump } from '../src/game/seedDump.js';
import { plantStakedStory } from '../src/game/storyteller.js';
import { loadConfig } from '../src/config.js';

const LONG_PUBLIC =
  'Смолосборщики, разрабатывавшие новый мёртвый наплыв на восточном откосе, вскрыли под коркой смолы полость с телом твари — крупной, с костяным гребнем, каких прежде не добывали в этих лесах. Тварь оказалась жива.';
const LONG_HIDDEN =
  'старший смолосборщик уже видел такой гребень в расходных книгах деда и спрятал страницу.';

test('дамп посева держит полную хронику, а не обрезку в 200 знаков', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cloudshire-seed-dump-'));
  const payload = {
    at: '2026-09-10T22:50:40.000Z',
    domain: { id: 'domain_test', name: 'Аллерия' },
    request: {
      gravity: 'CRISIS',
      fromGenesis: true,
      requireMystery: true,
      seedText: 'город на смоле',
    },
    pack: {
      gravity: 'CRISIS',
      rolls: [
        {
          axes: [
            { groupId: 'arena', tagId: 'creature' },
            { groupId: 'worldRelation', tagId: 'surfaced' },
            { groupId: 'target', tagId: 'work' },
            { groupId: 'knowledge', tagId: 'few_know' },
          ],
          author: { id: 'mieville' },
        },
      ],
      drafts: [
        {
          index: 1,
          arena: 'CREATURE',
          worldRelation: 'SURFACED',
          target: 'WORK',
          knowledge: 'FEW_KNOW',
          engine: 'DISCOVERY',
          timing: 'FRESH_INCIDENT',
          chronicle: LONG_PUBLIC,
          hiddenLayer: LONG_HIDDEN,
        },
      ],
      reviews: [
        {
          index: 1,
          verdict: 'FAIL',
          summary: 'Масштаб мал.',
          repair: 'Подними до кризиса города.',
          issues: [{ code: 'GRAVITY', reason: 'Одна тварь.' }],
        },
      ],
      candidates: [{ index: 1, arena: 'CREATURE', chronicle: LONG_PUBLIC, hiddenLayer: LONG_HIDDEN }],
      finalReviews: [],
      winner: null,
      pickedIndex: null,
    },
    outcome: 'no_winner',
  };
  try {
    const md = formatPlotSeedDumpMarkdown(payload);
    assert.match(md, /спрятал страницу/);
    assert.match(md, /`arena:creature\+worldRelation:surfaced\+target:work\+knowledge:few_know\+mieville`/);
    assert.match(md, /CREATURE · SURFACED · WORK · FEW_KNOW/);
    assert.doesNotMatch(md, /DISCOVERY|FRESH_INCIDENT/);
    assert.doesNotMatch(md, /Тварь оказ…/);
    assert.match(md, /Финальный пул: пуст/);
    assert.match(md, /Пул пуст: ни один кандидат не получил PASS/);
    const written = await writePlotSeedDump(payload, { logging: { seedDump: true, seedDumpDir: dir } });
    assert.ok(written?.mdPath);
    const files = await readdir(dir);
    assert.ok(files.some((name) => name.endsWith('.md')));
    const saved = await readFile(written.mdPath, 'utf8');
    assert.ok(saved.includes(LONG_PUBLIC));
    assert.ok(saved.includes(LONG_HIDDEN));
    assert.match(saved, /hiddenLayer:/);
    const json = JSON.parse(await readFile(written.jsonPath, 'utf8'));
    assert.equal(json.drafts[0].chronicle, LONG_PUBLIC);
    assert.equal(json.drafts[0].hiddenLayer, LONG_HIDDEN);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('дамп посева отдельно называет финальный пул PASS', () => {
  const md = formatPlotSeedDumpMarkdown({
    at: '2026-09-11T00:00:00.000Z',
    domain: { id: 'domain_test', name: 'Аллерия' },
    request: { gravity: 'RUPTURE', fromGenesis: true },
    pack: {
      drafts: [
        { index: 1, authorName: 'Шерли Джексон', chronicle: 'Звери выходят из леса вереницами.' },
        { index: 2, authorName: 'Франц Кафка', chronicle: 'Корни держат остров в воздухе.' },
        { index: 3, authorName: 'Станислав Лем', chronicle: 'Джунгли отступают к краю.' },
      ],
      reviews: [
        { index: 1, verdict: 'PASS', summary: 'держит' },
        { index: 2, verdict: 'FAIL', summary: 'космология' },
        { index: 3, verdict: 'FAIL', summary: 'космология' },
      ],
      candidates: [
        { index: 1, authorName: 'Шерли Джексон', chronicle: 'Звери выходят из леса вереницами.' },
        { index: 2, authorName: 'Франц Кафка', chronicle: 'Вырубка оголяет почву у кромки.' },
        { index: 3, authorName: 'Станислав Лем', chronicle: 'Край осыпается по счёту летописца.' },
      ],
      finalReviews: [
        null,
        { index: 2, verdict: 'PASS', summary: 'после правки' },
        { index: 3, verdict: 'FAIL', summary: 'всё ещё слабо' },
      ],
      winner: { index: 2, authorName: 'Франц Кафка', chronicle: 'Вырубка оголяет почву у кромки.' },
      pickedIndex: 2,
      pickSource: 'agent',
      pickWhy: 'звери живее вырубки',
    },
    outcome: 'planted',
    plot: { title: 'Оголённая кромка' },
  });
  assert.match(md, /Финальный пул: кандидаты 1 \(первый PASS\), 2 \(PASS после починки\) \(2 из 3\); выбран 2/);
  assert.match(md, /Дешёвый агент выбрал среди PASS/);
  assert.match(md, /звери живее вырубки/);
  assert.match(md, /Звери выходят из леса вереницами/);
  assert.match(md, /Вырубка оголяет почву у кромки/);
  assert.match(md, /\*\*Стартовый вариант\*\*/);
  assert.match(md, /\*\*Вердикт судьи\*\*/);
  assert.match(md, /\*\*Текущее состояние\*\*/);
  assert.match(md, /\*\*Актуальный вердикт судьи\*\*/);
  assert.doesNotMatch(md, /## Черновик|## Судья пачки|## После починки/);
  assert.equal((md.match(/_в пуле:/g) || []).length, 2);
  assert.match(md, /## Победитель/);
});

test('живой посев пишет в дамп полную затравку, а не обрезку логгера', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cloudshire-seed-plant-'));
  const silentLog = { child: () => silentLog, info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const config = loadConfig();
  config.logging = { ...config.logging, seedDump: true, seedDumpDir: dir };
  const runtime = {
    assembleChat: () => ({ systemContent: '', userContent: '' }),
    async run(opts) {
      const tool = opts.tools?.[0];
      if (!tool) return;
      if (opts.agentId === 'freeformBrainstorm') {
        await tool.handler({
          candidates: [1, 2, 3].map(() => ({
            chronicle: LONG_PUBLIC,
            hiddenLayer: LONG_HIDDEN,
          })),
        });
      } else if (opts.agentId === 'freeformBrainstormJudge') {
        await tool.handler({
          reviews: [1, 2, 3].map((i) => ({ index: i, verdict: 'PASS', summary: 'держит' })),
        });
      } else if (opts.agentId === 'freeformAssemble') {
        await tool.handler({
          title: 'Смоляная полость',
          chronicle: LONG_PUBLIC,
          hiddenPremises: ['старший спрятал страницу деда'],
        });
      }
    },
  };
  try {
    const planted = await plantStakedStory({
      config,
      runtime,
      domain: { name: 'Аллерия', lore: [], plotlines: [], stats: {} },
      world: { tickIndex: 1, dayIndex: 10, gameDate: { year: 1, month: 1, label: 'Год 1, месяц 1' } },
      seedText: 'город на смоле',
      gravity: 'CRISIS',
      requireMystery: true,
      rng: () => 0,
      log: silentLog,
    });
    assert.ok(planted?.plot);
    const files = await readdir(dir);
    const mdFile = files.find((name) => name.endsWith('.md'));
    assert.ok(mdFile);
    const saved = await readFile(path.join(dir, mdFile), 'utf8');
    assert.match(saved, /спрятал страницу/);
    assert.doesNotMatch(saved, /Тварь оказ…/);
    assert.match(
      saved,
      /Финальный пул: кандидаты 1 \(первый PASS\), 2 \(первый PASS\), 3 \(первый PASS\) \(3 из 3\); выбран [123]/,
    );
    assert.match(saved, /## Финальный пул/);
    assert.match(saved, /_в пуле: первый PASS_/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
