import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, test } from 'vitest';
import { FakeLlm, toolReply, toolsReply } from '../../src/adapters/llm/fake.js';
import { fixedSettings } from '../../src/agents/_shared/settings.js';
import { compareRuns, runStage, saveState, type BenchConfig } from '../../src/clients/bench/bench.js';
import type { Snapshot } from '../../src/clients/bench/stages.js';
import { scriptGenesis } from '../helpers/genesis.js';
import { lanternIsle } from '../helpers/game.js';
import { rules } from '../helpers/fixtures.js';

const names = { female: ['Айра', 'Вена', 'Ирма', 'Лира', 'Мэа', 'Нэя'], male: ['Орм', 'Кайр', 'Тэн', 'Вэс', 'Дар', 'Рун'] };

function scripted(): FakeLlm {
  const llm = new FakeLlm()
    .script(
      'onboarding-guide',
      toolReply('submit_onboarding', { reply: 'Как тебя звать, покровитель?' }),
      toolReply('submit_onboarding', { reply: 'Начинаем.', seed: { patron_name: 'Тарн', patron_gender: 'male', pitch: 'Город облачных рыбаков' } }),
    )
    .always('front-chronicle', toolReply('submit_chronicle', { text: 'К краю прибило островок с фонарями.' }))
    .always('herald', toolReply('submit_news', { text: 'Покровитель, у края горят чужие фонари.' }))
    .always('scenario-writer', toolReply('submit_scenario', { ...lanternIsle(), title: 'Островок у рыбаков' }))
    .always('priest', toolsReply(['order_change', { office: 'treasurer', intent: 'Построить маяк на краю' }], ['submit_reply', { text: 'Казначей начнёт.' }]))
    .always('mutation-drafter', toolReply('submit_mutation', { kind: 'create', type: 'structure', name: 'Маяк', description: 'Маяк на краю острова' }))
    .always('feasibility-judge', toolReply('submit_feasibility', { verdict: 'FEASIBLE' }))
    .always('impact-judge', toolReply('submit_impact', { impact: 'MAJOR', stat_profile: { security: 3 } }))
    .always('consequences-generator', (req) => {
      const n = Number(/Нужно кандидатов: (\d+)/.exec(JSON.stringify(req.messages))?.[1] ?? 0);
      return toolReply('submit_consequences', {
        items: Array.from({ length: n }, (_, i) => ({ description: `Чужие корабли видят свет ${i}`, impact: 'MINOR', drift: 'SLOW' })),
      });
    })
    .always('consequence-judge', toolReply('submit_consequence_verdict', { ok: true }));
  return scriptGenesis(llm, rules(), { cityName: 'Сетьград', patronName: 'Тарн' });
}

function bench(live: FakeLlm | null): BenchConfig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'));
  const put = (rel: string, value: unknown) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), yaml.dump(value));
  };
  put('cases/genesis/fishers.yaml', { title: 'Рыбаки', dialog: ['Привет', 'Я Тарн, хочу город рыбаков', 'Да'] });
  put('cases/will/lighthouse.yaml', { title: 'Маяк', state: 'day0', messages: ['Постройте маяк'] });
  put('cases/seeding/lantern.yaml', { title: 'Фонари', state: 'day0', plant: ['lantern-isle'] });
  let t = Date.UTC(2026, 10, 11, 12, 0);
  return {
    dir,
    rules: rules(),
    settings: fixedSettings(),
    scenarios: [lanternIsle()],
    names,
    live,
    now: () => (t += 60_000),
    gitSha: 'test',
  };
}

const read = (cfg: BenchConfig, ...parts: string[]) => fs.readFileSync(path.join(cfg.dir, ...parts), 'utf8');

describe('стенд агентов', () => {
  test('три этапа подряд: генезис → снимок → воля игрока и посев на нём', async () => {
    const cfg = bench(scripted());
    const g = await runStage(cfg, { stage: 'genesis', caseName: 'fishers' });
    expect(g.error).toBeNull();
    expect(g.outcome).toContain('Сетьград');
    expect(Object.keys(g.agents)).toEqual(expect.arrayContaining(['onboarding-guide', 'city-genesis', 'world-objects-genesis', 'officer-nature', 'city-brief']));
    const report = read(cfg, 'runs', g.id, 'report.md');
    expect(report).toContain('[city-brief](agents/city-brief.md)');
    expect(report).toContain('**Игрок:** Я Тарн, хочу город рыбаков');
    expect(read(cfg, 'runs', g.id, 'agents', 'city-genesis.md')).toContain('submit_core');

    saveState(cfg, g.id, 'day0', 'город после генезиса');
    const snap = JSON.parse(read(cfg, 'states', 'day0.json')) as Snapshot;
    expect(snap.cities[0]?.name).toBe('Сетьград');
    expect(snap.origin).toMatchObject({ run: g.id, stage: 'genesis', note: 'город после генезиса' });

    const w = await runStage(cfg, { stage: 'will', caseName: 'lighthouse' });
    expect(w.error).toBeNull();
    expect(w.outcome).toContain('Новых фронтов: 1');
    const willReport = read(cfg, 'runs', w.id, 'report.md');
    expect(willReport).toContain('**Жрец:** Казначей начнёт.');
    expect(willReport).toContain('создать structure «Маяк»');
    expect(willReport).toContain('Чужие корабли видят свет');
    expect(Object.keys(w.agents)).toEqual(expect.arrayContaining(['priest', 'mutation-drafter', 'impact-judge', 'consequence-judge']));

    const s = await runStage(cfg, { stage: 'seeding', caseName: 'lantern' });
    expect(s.error).toBeNull();
    expect(s.outcome).toBe('Посажено историй: 1 из 1.');
    const seedReport = read(cfg, 'runs', s.id, 'report.md');
    expect(seedReport).toContain('Башня на островке');
    expect(seedReport).toContain('**Весть:** Покровитель, у края горят чужие фонари.');
  });

  test('повтор с кассеты без ключей даёт тот же город; правка агента без ключей — понятная ошибка', async () => {
    const cfg = bench(scripted());
    const first = await runStage(cfg, { stage: 'genesis', caseName: 'fishers' });

    const offline = { ...cfg, live: null };
    const again = await runStage(offline, { stage: 'genesis', caseName: 'fishers', replay: first.id, label: 'replay' });
    expect(again.error).toBeNull();
    expect(again.totals).toMatchObject({ live: 0, cassette: first.totals.calls });
    const a = JSON.parse(read(cfg, 'runs', first.id, 'state.json')) as Snapshot;
    const b = JSON.parse(read(cfg, 'runs', again.id, 'state.json')) as Snapshot;
    expect(b.cities[0]).toEqual(a.cities[0]);

    const forced = await runStage(offline, { stage: 'genesis', caseName: 'fishers', replay: first.id, forceLive: ['city-brief'] });
    expect(forced.error).toBeNull(); // бриф идёт через запасной путь потока
    expect(read(cfg, 'runs', forced.id, 'report.md')).toContain('ключей моделей нет');

    const changed = await runStage(offline, { stage: 'genesis', caseName: 'fishers', replay: first.id, models: { 'city-genesis': 'openai:other' } });
    expect(changed.error).toBeNull();
    expect(changed.outcome).toContain('Генезис сорвался');

    const text = compareRuns(cfg, first.id, again.id);
    expect(text).toContain('| city-genesis | fake:model | fake:model | тот же |');
    expect(fs.existsSync(path.join(cfg.dir, 'compare', `${first.id}__${again.id}.md`))).toBe(true);
  });

  test('кейс воли без снимка — подсказка, как его сделать', async () => {
    const cfg = bench(scripted());
    await expect(runStage(cfg, { stage: 'will', caseName: 'lighthouse' })).rejects.toThrow('bench save-state');
  });
});
