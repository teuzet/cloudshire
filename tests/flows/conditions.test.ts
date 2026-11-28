/**
 * Условный приказ: поручение в очереди ждёт события. Код слышит события того, за чем следят,
 * сверщик условия решает, сбылось ли; сбылось — приказ исполняется, как будто сказан сейчас.
 */

import { describe, expect, test } from 'vitest';
import { toolReply } from '../../src/adapters/llm/fake.js';
import { priestTurnBlock } from '../../src/agents/priest/run.js';
import type { City } from '../../src/core/city.js';
import { createAssignment } from '../../src/core/world/assignments.js';
import { conditionalOrders, touchesCondition } from '../../src/core/world/conditions.js';
import { createFront } from '../../src/core/world/fronts.js';
import { createObject } from '../../src/core/world/objects.js';
import { recomputeStats } from '../../src/core/world/stats.js';
import { record } from '../../src/flows/chronicle.js';
import { refreshAllFronts } from '../../src/flows/fronts.js';
import { handlersFor } from '../../src/flows/priest-turn.js';
import { runSteward } from '../../src/flows/steward.js';
import { blankCity } from '../helpers/fixtures.js';
import { lastUser, scriptFrontAgents, stand } from '../helpers/game.js';

const IF = 'если бунтовщики пойдут на склады';

/** Цепные дворы бунтуют и грозят складам у пристани; мост с цепями ведёт от дворов к складам. */
async function riotTown() {
  const s = await stand();
  const city: City = blankCity();
  city.steward = { mode: 'report', wait: 'weeks', spare: [], text: '' };
  scriptFrontAgents(s.llm);
  city.objects.push(
    createObject(s.r, { id: 'yards', type: 'district', name: 'Цепные дворы', description: 'Кузни и склады цепей.', day: 0 }),
    createObject(s.r, { id: 'rebels', type: 'community', name: 'Бунтовщики с цепных дворов', description: 'Кузнецы, которым не платят третий месяц.', parentId: 'yards', day: 0 }),
    createObject(s.r, { id: 'stores', type: 'building', name: 'Склады у пристани', description: 'Зерно и соль города.', statEffect: { prosperity: 5 }, day: 0 }),
    createObject(s.r, { id: 'chains', type: 'structure', name: 'Цепной мост', description: 'Мост на цепях от дворов к пристани.', day: 0 }),
    createObject(s.r, { id: 'reef', type: 'site', name: 'Северный риф', description: 'Скалы под островом.', day: 0 }),
  );
  const riot = createFront({ id: 'riot', form: 'threat', origin: 'story', title: 'Бунт на цепных дворах', description: 'Бунтовщики грозят пойти на склады.', capacity: 8, deadlineDay: 90, refs: ['rebels', 'stores'], failStake: [{ op: 'stats', points: { prosperity: -3 } }], day: 0 });
  city.fronts.push(riot);
  recomputeStats(city, s.r);
  refreshAllFronts(s.deps, city, 0);
  const queue = (office: 'marshal' | null = 'marshal', watch = ['riot']) =>
    handlersFor(s.deps, city, 0).queueOrder({ office, task: 'Сбить цепи на мосту', condition: IF, watch });
  const event = (gist: string, frontId: string | null, day = 1, changes: Parameters<typeof record>[2]['changes'] = []) =>
    record(s.deps, city, { gist, changes, source: 'milestone', frontId, day, kind: 'beat', officer: null, announce: false });
  const judge = (met: boolean) => s.llm.script('condition-judge', toolReply('submit_condition', { met, reason: met ? 'Сбылось.' : 'Пока нет.' }));
  const cutChains = (stages = 1) =>
    s.llm.script('will-interpreter', toolReply('submit_will', { label: 'project', front_id: null, goal: 'Сбить цепи на мосту' })).script(
      'stage-planner',
      toolReply('submit_stages', {
        stages: Array.from({ length: stages }, (_, i) => ({
          title: `Шаг ${i + 1}`,
          work: 'Кузнецы сбивают цепи.',
          result: { kind: 'remove_object', object_id: 'chains', name: 'Цепной мост', description: 'Мост без цепей.' },
          site: { name: 'Работы у моста', description: '' },
          outcome_known: true,
        })),
      }),
    );
  return { ...s, city, riot, queue, event, judge, cutChains };
}

describe('поручение с условием', () => {
  test('ставится с тем, за чем следить; жрец видит условие в очереди; больше трёх не ждут', async () => {
    const s = await riotTown();
    const out = await s.queue('marshal', ['riot', 'nowhere']);
    expect(out.ok).toBe(true);
    expect(out.say).toContain(`Поручение ждёт условия «${IF}»`);
    expect(s.city.queue?.[0]?.condition).toEqual({ text: IF, watch: ['riot'], heard: [] });
    expect(priestTurnBlock(s.r, s.city, 0)).toContain(`Сбить цепи на мосту (когда: ${IF})`);

    await s.queue();
    await s.queue();
    const fourth = await s.queue();
    expect(fourth).toMatchObject({ ok: false, error: 'too_many_conditions' });
    expect(conditionalOrders(s.city)).toHaveLength(s.r.fronts.steward.conditionsMax);
  });

  test('ждёт при свободных руках; сверяется только по событиям того, за чем следит', async () => {
    const s = await riotTown();
    await s.queue();
    await runSteward(s.deps, s.city, 1);
    expect(s.llm.callsTo('condition-judge')).toHaveLength(0);
    expect(s.city.officers.find((o) => o.office === 'marshal')!.assignmentId).toBeNull();

    // Чужое событие условия не касается.
    await s.event('На северном рифе нашли обломки лодки.', null, 1, [{ kind: 'fact', text: 'Обломки на рифе.' }]);
    expect(s.city.queue?.[0]?.condition?.heard).toEqual([]);

    await s.event('Бунтовщики собрались на площади у дворов и кричат старшинам.', 'riot');
    s.judge(false);
    await runSteward(s.deps, s.city, 1);
    expect(lastUser(s.llm.callsTo('condition-judge').at(-1)!)).toContain('Бунтовщики собрались на площади');
    expect(s.city.queue?.[0]?.condition?.heard).toEqual([]);
    expect(s.city.officers.find((o) => o.office === 'marshal')!.assignmentId).toBeNull();
  });

  test('условие сбылось: приказ идёт обычным путём, жрец приносит весть', async () => {
    const s = await riotTown();
    await s.queue();
    await s.event('Толпа с цепных дворов двинулась к складам у пристани.', 'riot');
    s.judge(true);
    s.cutChains();
    await runSteward(s.deps, s.city, 2);
    expect(s.city.queue).toEqual([]);
    const marshal = s.city.officers.find((o) => o.office === 'marshal')!;
    const asg = s.city.assignments.find((a) => a.id === marshal.assignmentId)!;
    const deed = s.city.fronts.find((f) => f.id === asg.frontId)!;
    expect(deed.stake.some((op) => op.op === 'delete' && op.target === 'chains')).toBe(true);
    const last = s.city.chronicle.at(-1)!;
    expect(last).toMatchObject({ source: 'steward', frontId: deed.id });
    expect(last.text).toContain(`Сбылось условие покровителя «${IF}»`);
  });

  test('сбылось, а названный занят большим делом: поручение встаёт первым в обычную очередь', async () => {
    const s = await riotTown();
    const marshal = s.city.officers.find((o) => o.office === 'marshal')!;
    createAssignment(s.city, { id: 'asg_riot', front: s.riot, officer: marshal, text: 'Говорить с бунтовщиками', day: 0 });
    s.city.queue = [{ id: 'q0', office: 'marshal', task: 'Починить пристань', day: 0 }];
    await s.queue();
    await s.event('Толпа двинулась к складам.', 'riot');
    s.judge(true);
    s.cutChains(2);
    await runSteward(s.deps, s.city, 2);
    expect(s.city.queue?.map((q) => ({ office: q.office, task: q.task, condition: q.condition }))).toEqual([
      { office: 'marshal', task: 'Сбить цепи на мосту', condition: undefined },
      { office: 'marshal', task: 'Починить пристань', condition: undefined },
    ]);
    expect(s.city.chronicle.at(-1)!.text).toContain('возьмётся за поручение, как только освободится');
  });

  test('отслеживаемое кончилось, а условие не сбылось: поручение гаснет, и жрец об этом говорит', async () => {
    const s = await riotTown();
    await s.queue();
    s.riot.status = 'done';
    await s.event('Кузнецам заплатили, бунт утих.', 'riot');
    s.judge(false);
    await runSteward(s.deps, s.city, 3);
    expect(s.city.queue).toEqual([]);
    const last = s.city.chronicle.at(-1)!;
    expect(last.source).toBe('steward');
    expect(last.text).toContain(`Условие покровителя «${IF}» погасло`);
    expect(last.text).toContain('Сбить цепи на мосту');
  });

  test('новая беда рядом с отслеживаемым слышна; без отслеживаемого слышны только новые беды', async () => {
    const s = await riotTown();
    await s.queue();
    await s.queue(null, []);
    const [watching, open] = conditionalOrders(s.city);
    const fresh = createFront({ id: 'arson', form: 'threat', origin: 'complication', title: 'Поджог у складов', description: 'Кто-то поджёг сено у складов.', capacity: 4, deadlineDay: 40, refs: ['stores'], day: 5 });
    const far = createFront({ id: 'storm', form: 'threat', origin: 'story', title: 'Шторм у рифа', description: 'Шторм бьёт в северный риф.', capacity: 4, deadlineDay: 40, refs: ['reef'], day: 5 });
    const mine = createFront({ id: 'road', form: 'deed', origin: 'player', title: 'Дорога к рифу', description: 'Стража мостит дорогу.', capacity: 4, refs: ['reef'], day: 5 });
    s.city.fronts.push(fresh, far, mine);
    const at = (frontId: string) => ({ frontId, day: 5 });
    expect(touchesCondition(s.city, watching!, at('arson'), [])).toBe(true);
    expect(touchesCondition(s.city, watching!, at('storm'), [])).toBe(false);
    expect(touchesCondition(s.city, open!, at('storm'), [])).toBe(true);
    expect(touchesCondition(s.city, open!, at('road'), [])).toBe(false);
    // Старое дело без отслеживаемого не слышно: только новые беды.
    expect(touchesCondition(s.city, open!, { frontId: 'storm', day: 9 }, [])).toBe(false);
    // Перемена участника отслеживаемого дела слышна и без самого дела.
    expect(touchesCondition(s.city, watching!, { frontId: null, day: 9 }, [{ kind: 'object_changed', objectId: 'stores', name: 'Склады у пристани', delta: { prosperity: -1, influence: 0, security: 0, knowledge: 0 }, description: null }])).toBe(true);
  });
});
