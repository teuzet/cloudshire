/**
 * Приказ как правка: вещь из приказа получает связи с тем, что идёт рядом.
 * Слово о влиянии даёт агент, цену и последствия считает код.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, test } from 'vitest';
import { toolReply } from '../../src/adapters/llm/fake.js';
import { priestTurnBlock } from '../../src/agents/priest/run.js';
import type { City, Front } from '../../src/core/city.js';
import { deadlineOf, nextEventDay, progressAt } from '../../src/core/world/fronts.js';
import { newObjectCapacity } from '../../src/core/world/numbers.js';
import { clockToll, linkPrice } from '../../src/core/world/patch.js';
import { parseScenario, plantScenario, type Scenario } from '../../src/core/world/scenario.js';
import { newId, today } from '../../src/flows/context.js';
import { processDue } from '../../src/flows/day.js';
import { refreshAllFronts } from '../../src/flows/fronts.js';
import { playerWill } from '../../src/flows/will.js';
import { blankCity } from '../helpers/fixtures.js';
import { lanternIsle, lastUser, scriptFrontAgents, stand } from '../helpers/game.js';

function template(name: string): Scenario {
  return parseScenario(yaml.load(fs.readFileSync(path.resolve(import.meta.dirname, `../../scenarios/${name}.yaml`), 'utf8')));
}

type Stand = Awaited<ReturnType<typeof stand>> & { city: City; fronts: Front[] };
type Effects = Parameters<typeof scriptFrontAgents>[1];

async function planted(scenario: Scenario, appraisals: Effects = {}): Promise<Stand> {
  const s = await stand();
  const city = blankCity();
  city.steward = { mode: 'report', wait: 'weeks', spare: [], text: '' };
  scriptFrontAgents(s.llm, appraisals);
  const { fronts } = plantScenario(s.r, city, scenario, { day: 0, newId: (p) => newId(s.deps, p) });
  refreshAllFronts(s.deps, city, 0);
  return { ...s, city, fronts };
}

async function at(s: Stand, day: number) {
  const world = (await s.deps.storage.getWorld())!;
  s.passDays(Math.max(0, day - today(s.deps, world)));
  return processDue(s.deps, world, s.city);
}

async function finish(s: Stand, front: Front) {
  for (let i = 0; i < 30 && front.status === 'active'; i++) await at(s, nextEventDay(front)!);
}

function named(city: City, name: string) {
  return city.objects.find((o) => o.name === name)!;
}

const stages = (result: Record<string, unknown>, title = 'Работа') =>
  toolReply('submit_stages', { stages: [{ title, work: `${title}: идёт работа.`, result, site: { name: `Работы: ${title}`, description: '' }, outcome_known: true }] });
const influence = (effects: Array<Record<string, unknown>>, sides: Array<Record<string, unknown>> = []) => toolReply('submit_influence', { effects, sides, reason: 'По сценарию теста.' });
const linked = (...ids: string[]) => toolReply('submit_footprint', { relations: ids.map((id) => ({ object_id: id, relation: 'linked', reason: 'связано с результатом' })) });

describe('вещь из приказа держит то, что идёт рядом', () => {
  test('цепи: срок островка встаёт, цена цепей — доля того, что часы унесли бы', async () => {
    const s = await planted(lanternIsle());
    const { city } = s;
    const find = s.fronts.find((f) => f.form === 'find')!;
    const clock = s.fronts.find((f) => f.form === 'clock')!;
    const isle = named(city, 'Островок с горящими фонарями');
    s.llm
      .script('will-interpreter', toolReply('submit_will', { label: 'project', front_id: clock.id, goal: 'Приковать островок цепями к кромке' }))
      .script('stage-planner', stages({ kind: 'new_object', type: 'object', name: 'Причальные цепи', description: 'Толстые цепи держат островок у кромки.' }, 'Приковать островок'))
      .script('footprint-mapper', linked(isle.id))
      .script('influence-appraiser', influence([{ id: clock.id, effect: 'stops', basis: 'solid' }]));
    const out = await playerWill(s.deps, city, 'marshal', 'Прикуйте островок цепями', 0);
    expect(out.ok).toBe(true);

    // Оценщик видел всё, что идёт вокруг островка, и на чём оно держится.
    const asked = lastUser(s.llm.callsTo('influence-appraiser').at(-1)!);
    expect(asked).toContain('Результат: Причальные цепи (вещь): Толстые цепи держат островок у кромки.');
    expect(asked).toContain(`- ${clock.id} (отложенная перемена): Островок с фонарями отчалит`);
    expect(asked).toContain(`- ${find.id} (удобный случай): Добраться до рецепта`);
    expect(asked).toContain('Держится на: Островок с горящими фонарями.');

    // Узкие агенты видят окрестность: что где стоит и что на чём держится.
    const footprint = lastUser(s.llm.callsTo('footprint-mapper').at(-1)!);
    expect(footprint).toContain('Башня на островке (большое сооружение): Закрытая башня. Дверь держит старый засов, окна темны. Находится здесь: Островок с горящими фонарями.');
    expect(footprint).toContain('Здесь находится: Башня на островке. На этом держится: «Добраться до рецепта, который спрятан в башне»; «Островок с фонарями отчалит и уйдёт вместе с башней');

    // Цепи сами городу ничего не дают: вся цена — удержание. Часы унесли бы поиск в башне.
    const deed = city.fronts.at(-1)!;
    const toll = clockToll(s.r, city, clock, 0);
    expect(toll).toBe(find.capacity);
    expect(deed.capacity).toBeCloseTo(toll * s.r.fronts.hold.price.stop);
    expect(deed.links).toEqual([{ frontId: clock.id, effect: 'stop', price: deed.capacity }]);
    expect(out.say).toContain('Когда будет готово: пока есть Причальные цепи, не случится: «Островок с фонарями отчалит и уйдёт вместе с башней');

    // Пока цепи куют, жрец видит, что они переменят.
    expect(priestTurnBlock(s.r, city, 0)).toContain('когда будет готово: пока есть Причальные цепи, не случится: «Островок с фонарями отчалит');

    // Пока цепей нет, срок идёт; с готовыми цепями гонки больше нет.
    expect(deadlineOf(city, find)).toBe(clock.deadlineDay);
    await finish(s, deed);
    expect(deed.status).toBe('done');
    expect(named(city, 'Причальные цепи').holds).toMatchObject([{ frontId: clock.id, effect: 'stop' }]);
    expect(clock).toMatchObject({ status: 'active', deadlineDay: null });
    expect(deadlineOf(city, find)).toBeNull();
    expect(lastUser(s.llm.callsTo('chronicler').at(-1)!)).toContain('Пока есть Причальные цепи, не случится: «Островок с фонарями отчалит');
    // Жрец видит, на чём держится поиск и чем удержан срок.
    const state = priestTurnBlock(s.r, city, 200);
    expect(state).toContain('пока есть Причальные цепи: срок не идёт');
    expect(state).toContain('держится на: Островок с горящими фонарями');
  });

  test('ночная стража: вещь со своим вкладом стоит свою цену плюс долю беды, которую замедляет', async () => {
    const s = await planted(template('arsonist'), { 'Ночная стража': [{ stat: 'security', direction: 'up', size: 'medium' }] });
    const { city } = s;
    const fire = s.fronts.find((f) => f.form === 'threat')!;
    const before = fire.deadlineDay!;
    s.llm
      .script('will-interpreter', toolReply('submit_will', { label: 'project', front_id: fire.id, goal: 'Учредить ночную стражу' }))
      .script('stage-planner', stages({ kind: 'new_object', type: 'organization', name: 'Ночная стража', description: 'Сотня дозорных с баграми обходит кварталы ночью.' }, 'Ночная стража'))
      .script('influence-appraiser', influence([{ id: fire.id, effect: 'slows' }], [{ id: named(city, 'Ночные пожары').id, stance: 'harms' }]));
    expect((await playerWill(s.deps, city, 'marshal', 'Учредите ночную стражу против поджогов', 0)).ok).toBe(true);
    const deed = city.fronts.at(-1)!;
    const own = newObjectCapacity(s.r, 'organization', { security: 5 });
    const hold = linkPrice(s.r, city, fire, { effect: 'slow' }, 0);
    expect(hold).toBeCloseTo((fire.capacity - progressAt(fire, 0)) * s.r.fronts.hold.price.slow);
    expect(deed.capacity).toBeCloseTo(own + hold);
    // Приказ назвал беду сам: она рядом, хотя стража ни с чем в городе не связана.
    expect(lastUser(s.llm.callsTo('influence-appraiser').at(-1)!)).toContain('Что тут на деле помогает:');

    await finish(s, deed);
    const day = today(s.deps, (await s.deps.storage.getWorld())!);
    expect(deed.status).toBe('done');
    // Оставшееся до срока идёт вдвое медленнее.
    expect(fire.deadlineDay).toBe(day + Math.ceil((before - day) / s.r.fronts.hold.slowFactor));
    expect(city.stats.security).toBeGreaterThan(50);
  });

  test('причины больше нет: беда закрыта в день готовности, цена — весь её остаток', async () => {
    const s = await planted(template('arsonist'));
    const { city } = s;
    const fire = s.fronts.find((f) => f.form === 'threat')!;
    city.objects.push({ ...named(city, 'Ночные пожары'), id: 'watch', type: 'organization', name: 'Пожарная вышка', description: 'Вышка с колоколом.', holds: [] });
    s.llm
      .script('will-interpreter', toolReply('submit_will', { label: 'project', front_id: fire.id, goal: 'Вернуть смотрителя на вышку' }))
      .script('stage-planner', stages({ kind: 'change_object', object_id: 'watch', name: 'Пожарная вышка', description: 'На вышке снова служит старый смотритель, ему вернули место и почёт.' }, 'Вернуть смотрителя'))
      .script('influence-appraiser', influence([{ id: fire.id, effect: 'removes_cause' }]));
    const out = await playerWill(s.deps, city, 'chancellor', 'Верните смотрителя на вышку', 0);
    expect(out.ok).toBe(true);
    const deed = city.fronts.at(-1)!;
    expect(deed.links).toMatchObject([{ frontId: fire.id, effect: 'removes', price: fire.capacity }]);
    expect(deed.stake.at(-1)).toEqual({ op: 'end', frontId: fire.id, cause: 'Пожарная вышка' });
    expect(out.say).toContain('Когда будет готово: больше не будет: «Пожары всё ближе к центру»');
    await finish(s, deed);
    expect(fire).toMatchObject({ status: 'done' });
    expect(lastUser(s.llm.callsTo('chronicler').at(-1)!)).toContain('Больше не грозит: «Пожары всё ближе к центру». Причину устранило: Пожарная вышка');
    // Беда кончилась без своей развязки: ставка не сыграла.
    expect(city.stats.security).toBe(50);
  });

  test('слово без вещи исполнить нечем: влияние отброшено и записано в лог как пробел', async () => {
    const s = await planted(template('arsonist'));
    const { city } = s;
    const fire = s.fronts.find((f) => f.form === 'threat')!;
    const warned: Array<{ event: string; data: Record<string, unknown> }> = [];
    s.deps.log = { warn: (event, data) => warned.push({ event, data }) };
    s.llm
      .script('will-interpreter', toolReply('submit_will', { label: 'project', front_id: fire.id, goal: 'Объявить, что поджигателя ищут' }))
      .script('stage-planner', stages({ kind: 'fact', name: 'Поджигателя ищут', description: 'В городе объявлено, что поджигателя ищут.' }, 'Объявить розыск'))
      .script('influence-appraiser', influence([{ id: fire.id, effect: 'stops', basis: 'word' }]));
    expect((await playerWill(s.deps, city, 'chancellor', 'Объявите розыск', 0)).ok).toBe(true);
    const deed = city.fronts.at(-1)!;
    expect(deed.links).toBeUndefined();
    expect(deed.capacity).toBe(s.r.fronts.basePrice.fact);
    expect(warned.find((w) => w.event === 'influence_gap')?.data.dropped).toEqual([{ frontId: fire.id, effect: 'stop', word: true }]);
  });

  test('влияние не на пользу бесплатно, но случается: склад пороха делает стройку опаснее', async () => {
    const s = await planted(lanternIsle());
    const { city } = s;
    const find = s.fronts.find((f) => f.form === 'find')!;
    const isle = named(city, 'Островок с горящими фонарями');
    s.llm
      .script('will-interpreter', toolReply('submit_will', { label: 'project', goal: 'Устроить пороховой погреб на островке' }))
      .script('stage-planner', stages({ kind: 'new_object', type: 'building', name: 'Пороховой погреб', description: 'Погреб с порохом у подножия башни.', parent_id: isle.id }, 'Пороховой погреб'))
      .script('influence-appraiser', influence([{ id: find.id, effect: 'riskier' }]));
    expect((await playerWill(s.deps, city, 'treasurer', 'Устройте пороховой погреб на островке', 0)).ok).toBe(true);
    const deed = city.fronts.at(-1)!;
    expect(deed.links).toEqual([{ frontId: find.id, effect: 'riskier', price: 0 }]);
    expect(deed.capacity).toBe(newObjectCapacity(s.r, 'building', {}));
    const risk = find.risk;
    await finish(s, deed);
    expect(find.risk).not.toBe(risk);
    expect(named(city, 'Пороховой погреб').parentId).toBe(isle.id);
  });
});
