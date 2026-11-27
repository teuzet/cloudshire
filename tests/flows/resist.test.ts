/**
 * Сопротивление стороны: правка вредит тому, у кого есть воля, и он стоит на месте работ.
 * Платы работой нет, расплата идёт через риск самого дела; способ работы может её снять.
 */

import { describe, expect, test } from 'vitest';
import { toolReply } from '../../src/adapters/llm/fake.js';
import { priestTurnBlock } from '../../src/agents/priest/run.js';
import type { City, Front } from '../../src/core/city.js';
import { candidateWeight, candidates } from '../../src/core/world/dynamics.js';
import { createFront } from '../../src/core/world/fronts.js';
import { createObject } from '../../src/core/world/objects.js';
import { reapplyResistance, setResistance } from '../../src/core/world/resist.js';
import { plantScenario } from '../../src/core/world/scenario.js';
import { newId } from '../../src/flows/context.js';
import { refreshAllFronts } from '../../src/flows/fronts.js';
import { playerWill } from '../../src/flows/will.js';
import { blankCity, rules } from '../helpers/fixtures.js';
import { lanternIsle, lastUser, scriptFrontAgents, stand } from '../helpers/game.js';

type Stand = Awaited<ReturnType<typeof stand>> & { city: City; fronts: Front[] };

/** Островок с башней, в башне засели бунтовщики, островок держат цепи у причала. */
async function islet(opts: { hiddenRebels?: boolean } = {}): Promise<Stand> {
  const s = await stand();
  const city = blankCity();
  city.steward = { mode: 'report', wait: 'weeks', spare: [], text: '' };
  scriptFrontAgents(s.llm);
  const { fronts } = plantScenario(s.r, city, lanternIsle(), { day: 0, newId: (p) => newId(s.deps, p) });
  const clock = fronts.find((f) => f.form === 'clock')!;
  const tower = named(city, 'Башня на островке');
  const isle = named(city, 'Островок с горящими фонарями');
  city.objects.push(
    createObject(s.r, { id: 'pier', type: 'structure', name: 'Причал', description: 'Каменный причал у кромки.', statEffect: { prosperity: 4 }, day: 0 }),
    createObject(s.r, { id: 'rebels', type: 'community', name: 'Бунтовщики в башне', description: 'Два десятка беглых засели в башне и грабят причалы.', parentId: tower.id, hidden: Boolean(opts.hiddenRebels), day: 0 }),
    createObject(s.r, { id: 'fishers', type: 'community', name: 'Рыбаки', description: 'Рыбачья слобода на другом краю острова.', day: 0 }),
  );
  const chains = createObject(s.r, { id: 'chains', type: 'object', name: 'Причальные цепи', description: 'Цепи держат островок у причала.', parentId: isle.id, day: 0 });
  chains.holds = [{ frontId: clock.id, effect: 'stop', day: 0 }];
  city.objects.push(chains);
  // Рыбаки участвуют в своём деле далеко от островка: оценщик их видит, но на месте работ их нет.
  city.fronts.push(createFront({ id: 'nets', form: 'tension', origin: 'story', title: 'Спор о сетях', description: 'Рыбаки спорят о новых сетях.', capacity: 4, deadlineDay: 90, refs: ['fishers'], day: 0 }));
  refreshAllFronts(s.deps, city, 0);
  return { ...s, city, fronts };
}

function named(city: City, name: string) {
  return city.objects.find((o) => o.name === name)!;
}

const knockChains = (s: Stand, manner: string | null = null) =>
  s.llm
    .script('will-interpreter', toolReply('submit_will', { label: 'project', front_id: null, goal: 'Сбить причальные цепи', manner }))
    .script(
      'stage-planner',
      toolReply('submit_stages', {
        stages: [{ title: 'Сбить цепи', work: 'Кузнецы сбивают цепи с причала.', result: { kind: 'remove_object', object_id: 'chains', name: 'Причальные цепи', description: 'Цепей больше нет.' }, site: { name: 'У цепей', description: '' }, outcome_known: true }],
      }),
    )
    .script('footprint-mapper', toolReply('submit_footprint', { relations: [{ object_id: 'pier', relation: 'linked', reason: 'цепи держатся за причал' }] }))
    .script(
      'influence-appraiser',
      toolReply('submit_influence', {
        effects: [],
        // Бунтовщики уплывут вместе с островком; рыбакам далеко, но и им это во вред.
        sides: [
          { id: 'rebels', stance: 'loses' },
          { id: 'fishers', stance: 'loses' },
        ],
        reason: 'Без цепей островок уйдёт вместе с башней.',
      }),
    );

describe('сопротивление стороны', () => {
  test('сбить цепи: бунтовщики в башне против — риск на ступень выше, у малого дела веха посередине, жрец знает', async () => {
    const s = await islet();
    knockChains(s);
    const out = await playerWill(s.deps, s.city, 'marshal', 'Сбейте цепи', 0);
    expect(out).toMatchObject({ ok: true });
    const deed = s.city.fronts.at(-1)!;

    // Оценщик влияния видит сторону в башне: она на том же островке, что и цепи.
    expect(lastUser(s.llm.callsTo('influence-appraiser').at(-1)!)).toContain('rebels — Бунтовщики в башне');
    // Против только те, кто на месте работ: рыбакам далеко.
    expect(deed.resist).toEqual([{ objectId: 'rebels', answered: false }]);
    expect(deed.risk).toBe('normal');
    expect(deed.resistShift).toBe(1);
    expect(deed.milestones).toBe(2);
    expect(out.say).toContain('Обычная работа');
    expect(out.say).toContain('будут мешать работе: Бунтовщики в башне');
    expect(out.say).not.toContain('Рыбаки');
    expect(priestTurnBlock(s.r, s.city, 0)).toContain('противится: Бунтовщики в башне');

    // Осложнение на вехе охотнее приходит от противника.
    const list = candidates(s.r, s.city, deed, { moment: 'milestone', kind: 'light' });
    const opponent = list.find((c) => c.dynamic.id === 'opponent-strikes');
    expect(opponent?.object?.id).toBe('rebels');
    const plain = { ...opponent!, dynamic: { ...opponent!.dynamic, from: ['pressures' as const] } };
    expect(candidateWeight(s.r, s.city, opponent!, 0)).toBeCloseTo(s.r.fronts.director.opponentWeight * candidateWeight(s.r, s.city, plain, 0));
  });

  test('способ снимает: ночью, с лодок — находчивость окупилась; новый способ возвращает сопротивление', async () => {
    const s = await islet();
    knockChains(s, 'ночью, с лодок, пока бунтовщики ушли в набег');
    s.llm.script('role-fitter', toolReply('submit_fit', { fits: false, reason: 'Бунтовщиков нет на месте.' }));
    const out = await playerWill(s.deps, s.city, 'marshal', 'Сбейте цепи ночью, с лодок, пока бунтовщики ушли в набег', 0);
    const deed = s.city.fronts.at(-1)!;
    expect(deed.resist).toEqual([{ objectId: 'rebels', answered: true }]);
    expect(deed.risk).toBe('safe');
    expect(out.say).toContain('Против и Бунтовщики в башне, но так, как велено вести работу, помешать им не удастся.');
    const fit = lastUser(s.llm.callsTo('role-fitter').at(-1)!);
    expect(fit).toContain('Сможет ли эта сторона помешать работе, если вести её так?');
    expect(fit).toContain('Как ведут работу: ночью, с лодок');

    // Покровитель велел работать днём у всех на виду: бунтовщикам снова есть чем помешать.
    s.llm
      .script('will-interpreter', toolReply('submit_will', { label: 'strategy', front_id: deed.id, goal: 'Сбивать цепи днём', manner: 'днём, у всех на виду' }))
      .script('role-fitter', toolReply('submit_fit', { fits: true, reason: 'Днём бунтовщики в башне.' }));
    const again = await playerWill(s.deps, s.city, 'marshal', 'Сбивайте цепи днём, у всех на виду', 0);
    expect(deed.resist).toEqual([{ objectId: 'rebels', answered: false }]);
    expect(deed.risk).toBe('normal');
    expect(again.say).toContain('будут мешать работе: Бунтовщики в башне');
  });

  test('скрытая сторона сопротивляется, но жрец о ней не знает', async () => {
    const s = await islet({ hiddenRebels: true });
    knockChains(s);
    const out = await playerWill(s.deps, s.city, 'marshal', 'Сбейте цепи', 0);
    const deed = s.city.fronts.at(-1)!;
    expect(deed.resist).toEqual([{ objectId: 'rebels', answered: false }]);
    expect(deed.risk).toBe('normal');
    expect(out.say).not.toContain('Бунтовщики');
    expect(priestTurnBlock(s.r, s.city, 0)).not.toContain('Бунтовщики');
    // Осложнения от скрытого противника не приходят: он не выдаёт себя.
    expect(candidates(s.r, s.city, deed, { moment: 'milestone', kind: 'light' }).some((c) => c.dynamic.id === 'opponent-strikes')).toBe(false);
  });
});

describe('сопротивление в ядре', () => {
  const r = rules();
  const deed = (risk: Front['risk']) => createFront({ id: 'd', form: 'deed', origin: 'player', title: 'Дело', description: '', capacity: 6, risk, day: 0 });

  test('ступень одна на всех противников и не выше «рискованно»; снято — вернулась; новая оценка риска получает прибавку снова', () => {
    const front = deed('hard');
    setResistance(front, [
      { objectId: 'a', answered: false },
      { objectId: 'b', answered: false },
    ]);
    expect(front.risk).toBe('risky');
    setResistance(front, [
      { objectId: 'a', answered: true },
      { objectId: 'b', answered: false },
    ]);
    expect(front.risk).toBe('risky');
    setResistance(front, [
      { objectId: 'a', answered: true },
      { objectId: 'b', answered: true },
    ]);
    expect(front.risk).toBe('hard');
    expect(front.resistShift).toBeUndefined();

    const edge = deed('risky');
    setResistance(edge, [{ objectId: 'a', answered: false }]);
    expect(edge.risk).toBe('risky');
    setResistance(edge, []);
    expect(edge.risk).toBe('risky');
    expect(edge.resist).toBeUndefined();

    const fresh = deed('safe');
    setResistance(fresh, [{ objectId: 'a', answered: false }]);
    fresh.risk = 'normal';
    reapplyResistance(fresh);
    expect(fresh.risk).toBe('hard');
    expect(r.fronts.dynamics.some((d) => d.id === 'opponent-strikes' && d.from.includes('opponent'))).toBe(true);
  });
});
