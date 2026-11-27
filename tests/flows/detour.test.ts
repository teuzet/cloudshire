/**
 * Отвлечься и вернуться: занятый сановник берётся за малое дело, его большое дело стоит
 * и продолжается само, когда малое готово. Отвлечься можно один раз.
 */

import { describe, expect, test } from 'vitest';
import { toolReply } from '../../src/adapters/llm/fake.js';
import { priestTurnBlock } from '../../src/agents/priest/run.js';
import type { City, Front } from '../../src/core/city.js';
import { assignmentOf, leadOf } from '../../src/core/world/assignments.js';
import { createFront, nextEventDay } from '../../src/core/world/fronts.js';
import { createObject } from '../../src/core/world/objects.js';
import { recomputeStats } from '../../src/core/world/stats.js';
import { today } from '../../src/flows/context.js';
import { processDue } from '../../src/flows/day.js';
import { refreshAllFronts } from '../../src/flows/fronts.js';
import { playerWill, withdraw } from '../../src/flows/will.js';
import { blankCity } from '../helpers/fixtures.js';
import { scriptFrontAgents, stand } from '../helpers/game.js';

type Stand = Awaited<ReturnType<typeof stand>> & { city: City; wall: Front; grain: Front };

/** Маршал строит стену; рядом идёт беда с зерном, за которой стоит скрытый приказчик. */
async function busyMarshal(): Promise<Stand> {
  const s = await stand();
  const city = blankCity();
  city.steward = { mode: 'report', wait: 'weeks', spare: [], text: '' };
  scriptFrontAgents(s.llm, { 'Стена у кромки': [{ stat: 'security', direction: 'up', size: 'large' }] });
  city.objects.push(
    createObject(s.r, { id: 'barns', type: 'building', name: 'Нижние амбары', description: 'Три амбара с зерном.', statEffect: { prosperity: 6 }, day: 0 }),
    createObject(s.r, { id: 'clerk', type: 'person', name: 'Приказчик Ордена весов', description: 'По ночам вывозит мешки.', hidden: true, day: 0 }),
  );
  const grain = createFront({ id: 'grain', form: 'threat', origin: 'story', title: 'Пропажа зерна', description: 'Из амбаров пропадает зерно.', capacity: 8, deadlineDay: 200, refs: ['barns', 'clerk'], failStake: [{ op: 'stats', points: { prosperity: -3 } }], day: 0 });
  city.fronts.push(grain);
  recomputeStats(city, s.r);
  refreshAllFronts(s.deps, city, 0);
  s.llm
    .script('will-interpreter', toolReply('submit_will', { label: 'project', goal: 'Построить стену у кромки' }))
    .script(
      'stage-planner',
      toolReply('submit_stages', {
        stages: [{ title: 'Стена', work: 'Каменщики кладут стену.', result: { kind: 'new_object', type: 'structure', name: 'Стена у кромки', description: 'Высокая стена у кромки.' }, site: { name: 'Стройка стены', description: '' }, outcome_known: true }],
      }),
    );
  expect((await playerWill(s.deps, city, 'marshal', 'Построй стену у кромки', 0)).ok).toBe(true);
  return { ...s, city, wall: city.fronts.at(-1)!, grain };
}

async function finish(s: Stand, front: Front) {
  for (let i = 0; i < 30 && front.status === 'active'; i++) {
    const world = (await s.deps.storage.getWorld())!;
    s.passDays(Math.max(0, nextEventDay(front)! - today(s.deps, world)));
    await processDue(s.deps, world, s.city);
  }
}

const pushGrain = (s: Stand) =>
  s.llm.script('will-interpreter', toolReply('submit_will', { label: 'deed', front_id: 'grain', deed_kind: 'push', goal: 'Поставить сторожей у амбаров на ночь' }));

describe('отвлечься и вернуться', () => {
  test('маршал на стройке берёт разовое задание: стена стоит, потом идёт сама', async () => {
    const s = await busyMarshal();
    const { city, wall } = s;
    const marshal = city.officers.find((o) => o.office === 'marshal')!;
    const big = assignmentOf(city, marshal)!;
    expect(wall.ratePerDay).toBeGreaterThan(0);

    pushGrain(s);
    const out = await playerWill(s.deps, city, 'marshal', 'Поставь сторожей у амбаров на ночь', 0);
    expect(out.ok).toBe(true);
    expect(out.say).toContain(`отвлекается от дела «Каменщики кладут стену»`);
    const deed = city.fronts.at(-1)!;
    expect(deed.origin).toBe('deed');
    // Стена за маршалом, но стоит.
    expect(leadOf(city, wall.id)?.id).toBe(big.id);
    expect(big.paused).toBe(true);
    expect(wall.ratePerDay).toBe(0);
    const block = priestTurnBlock(s.r, city, 0);
    expect(block).toContain('потом вернётся к делу «Каменщики кладут стену»');
    expect(block).toContain('но сейчас отвлёкся на малое дело');

    await finish(s, deed);
    expect(marshal.assignmentId).toBe(big.id);
    expect(big.paused).toBe(false);
    expect(wall.ratePerDay).toBeGreaterThan(0);
  });

  test('с малого дела не отвлекаются: второе задание ждёт', async () => {
    const s = await busyMarshal();
    pushGrain(s);
    expect((await playerWill(s.deps, s.city, 'marshal', 'Поставь сторожей у амбаров на ночь', 0)).ok).toBe(true);
    pushGrain(s);
    const again = await playerWill(s.deps, s.city, 'marshal', 'Поставь ещё сторожей', 0);
    expect(again).toMatchObject({ ok: false, error: 'officer_busy' });
    expect(again.say).toContain('уже отвлёкся от большого');
  });

  test('выяснить скрытое — тоже малое дело: маршал узнаёт приказчика и возвращается к стене', async () => {
    const s = await busyMarshal();
    const { city, wall } = s;
    const marshal = city.officers.find((o) => o.office === 'marshal')!;
    const big = assignmentOf(city, marshal)!;
    s.llm
      .script('will-interpreter', toolReply('submit_will', { label: 'project', front_id: 'grain', goal: 'Узнать, кто стоит за пропажей зерна' }))
      .script(
        'stage-planner',
        toolReply('submit_stages', { stages: [{ title: 'Расспросы', work: 'Расспросить сторожей.', result: { kind: 'reveal', object_id: null, name: 'Кто за пропажей', description: 'Кто за пропажей' }, site: { name: 'Расспросы', description: '' }, outcome_known: false }] }),
      );
    expect((await playerWill(s.deps, city, 'marshal', 'Выясни, кто стоит за пропажей зерна', 0)).ok).toBe(true);
    await finish(s, city.fronts.at(-1)!);
    expect(city.objects.find((o) => o.id === 'clerk')!.hidden).toBe(false);
    expect(marshal.assignmentId).toBe(big.id);
    expect(wall.ratePerDay).toBeGreaterThan(0);
  });

  test('снять с малого дела: сановник возвращается к большому', async () => {
    const s = await busyMarshal();
    const { city, wall } = s;
    pushGrain(s);
    await playerWill(s.deps, city, 'marshal', 'Поставь сторожей у амбаров на ночь', 0);
    const out = withdraw(s.deps, city, 'marshal', 0);
    expect(out.say).toContain('Он вернулся к делу «Каменщики кладут стену»');
    expect(wall.ratePerDay).toBeGreaterThan(0);
  });
});
