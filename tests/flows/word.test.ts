/**
 * Якорь на слове: слух, уговор, перемирие держат фронт, пока им верят. Стоят половину прочного,
 * зато режиссёр бьёт по ним охотнее, а беда «слову перестали верить» ломает саму вещь.
 */

import { describe, expect, test } from 'vitest';
import { toolReply } from '../../src/adapters/llm/fake.js';
import type { City } from '../../src/core/city.js';
import { buildSide } from '../../src/core/world/complications.js';
import { candidateWeight, candidates, isWordAnchor } from '../../src/core/world/dynamics.js';
import { createFront, deadlineOf } from '../../src/core/world/fronts.js';
import { holdersOf } from '../../src/core/world/hold.js';
import { createObject } from '../../src/core/world/objects.js';
import { applyStake } from '../../src/core/world/stake.js';
import { recomputeStats } from '../../src/core/world/stats.js';
import { emptyStatMap } from '../../src/core/rules.js';
import { newId } from '../../src/flows/context.js';
import { refreshAllFronts } from '../../src/flows/fronts.js';
import { playerWill } from '../../src/flows/will.js';
import { blankCity } from '../helpers/fixtures.js';
import { scriptFrontAgents, stand } from '../helpers/game.js';

/** Бунтовщики в башне набирают людей; слух о море в башне отпугивает новичков. Рядом стража строит заставу. */
async function rumorTown() {
  const s = await stand();
  const city: City = blankCity();
  city.steward = { mode: 'report', wait: 'weeks', spare: [], text: '' };
  scriptFrontAgents(s.llm);
  city.objects.push(
    createObject(s.r, { id: 'tower', type: 'structure', name: 'Башня у кромки', description: 'Старая башня.', day: 0 }),
    createObject(s.r, { id: 'rebels', type: 'community', name: 'Бунтовщики в башне', description: 'Засели в башне.', parentId: 'tower', day: 0 }),
    createObject(s.r, { id: 'walls', type: 'structure', name: 'Городская стена', description: 'Стена у ворот.', statEffect: { security: 5 }, day: 0 }),
  );
  const recruit = createFront({ id: 'recruit', form: 'threat', origin: 'story', title: 'Набор в башню', description: 'Бунтовщики зовут к себе бедноту и скоро пойдут на склады.', capacity: 8, deadlineDay: 90, refs: ['rebels', 'tower'], failStake: [{ op: 'stats', points: { security: -3 } }], day: 0 });
  const rumor = createObject(s.r, { id: 'rumor', type: 'practice', name: 'Слух о море в башне', description: 'Говорят, в башне мор.', day: 0 });
  rumor.holds = [{ frontId: 'recruit', effect: 'slow', word: true, day: 0 }];
  const outpost = createFront({ id: 'outpost', form: 'deed', origin: 'player', title: 'Застава у башни', description: 'Стража ставит заставу у башни.', capacity: 6, risk: 'normal', footprint: [{ objectId: 'tower', relation: 'pressures', reason: 'застава смотрит на башню' }], day: 0 });
  city.objects.push(rumor);
  city.fronts.push(recruit, outpost);
  recomputeStats(city, s.r);
  refreshAllFronts(s.deps, city, 0);
  return { ...s, city, recruit, rumor, outpost };
}

describe('якорь на слове', () => {
  test('режиссёр охотнее берёт в роль вещь на слове рядом с делом', async () => {
    const { r, city, rumor, outpost } = await rumorTown();
    expect(isWordAnchor(rumor)).toBe(true);
    const list = candidates(r, city, outpost, { moment: 'milestone', kind: 'light' });
    const breaks = list.find((c) => c.dynamic.id === 'word-breaks');
    expect(breaks?.object?.id).toBe('rumor');
    expect(breaks?.shape).toBe('tension');
    const plain = { ...breaks!, object: city.objects.find((o) => o.id === 'walls')! };
    expect(candidateWeight(r, city, breaks!, 0)).toBeCloseTo(r.fronts.director.wordWeight * candidateWeight(r, city, plain, 0));
  });

  test('слову перестали верить: беда ломает слух, набор в башню идёт как прежде', async () => {
    const s = await rumorTown();
    const { r, city, recruit, rumor } = s;
    const slowed = deadlineOf(city, recruit)!;
    const front = buildSide(r, city, {
      shape: 'threat',
      origin: 'complication',
      target: rumor,
      newPoints: emptyStatMap(),
      dress: { title: 'Слух выдыхается', description: 'В башне видели здоровых людей.', outburst: 'Слуху больше не верят.', newObject: null },
      key: null,
      dynamicId: 'word-breaks',
      breaks: 4,
      id: 'cracks',
      day: 0,
      rng: () => 0.5,
    });
    expect(front.failStake).toEqual([{ op: 'delete', target: 'rumor' }]);
    expect(front.atStake).toBe(4);
    applyStake(r, city, front.failStake, { day: 10, newId: (p) => newId(s.deps, p), frontId: front.id, trouble: 'Слух выдыхается' });
    expect(holdersOf(city, 'recruit')).toEqual([]);
    refreshAllFronts(s.deps, city, 10);
    expect(deadlineOf(city, recruit)!).toBeLessThan(slowed);
  });
});

describe('стоящее рядом помогает и мешает новому делу', () => {
  test('дорога помогает водоводу, слух мешает: держат дело, пока оно идёт, вместе не больше потолка', async () => {
    const s = await stand();
    const city: City = blankCity();
    city.steward = { mode: 'report', wait: 'weeks', spare: [], text: '' };
    scriptFrontAgents(s.llm);
    city.objects.push(
      createObject(s.r, { id: 'road', type: 'structure', name: 'Каменная дорога', description: 'Дорога к родникам.', day: 0 }),
      createObject(s.r, { id: 'road2', type: 'structure', name: 'Новая дорога', description: 'Ещё одна дорога.', day: 0 }),
      createObject(s.r, { id: 'whisper', type: 'practice', name: 'Слух о проклятых родниках', description: 'Шепчут, что вода несёт мор.', day: 0 }),
    );
    recomputeStats(city, s.r);
    s.llm
      .script('will-interpreter', toolReply('submit_will', { label: 'project', goal: 'Проложить водовод' }))
      .script('stage-planner', toolReply('submit_stages', { stages: [{ title: 'Водовод', work: 'Землекопы кладут трубы.', result: { kind: 'new_object', type: 'structure', name: 'Водовод', description: 'Водовод в квартал.' }, site: { name: 'Стройка водовода', description: '' }, outcome_known: true }] }))
      .script(
        'footprint-mapper',
        toolReply('submit_footprint', {
          relations: [
            { object_id: 'road', relation: 'helps', reason: 'по дороге подвозят трубы' },
            { object_id: 'road2', relation: 'helps', reason: 'и по этой тоже' },
            { object_id: 'whisper', relation: 'hinders', reason: 'слух отпугивает работников' },
          ],
        }),
      );
    const out = await playerWill(s.deps, city, 'treasurer', 'Проложи водовод с верхних родников', 0);
    expect(out.say).toContain('Работе поможет то, что рядом: Каменная дорога, Новая дорога.');
    expect(out.say).toContain('Работе будет мешать то, что рядом: Слух о проклятых родниках.');
    const deed = city.fronts.at(-1)!;
    expect(holdersOf(city, deed.id).map((h) => [h.obj.id, h.hold.effect, h.hold.found])).toEqual([
      ['road', 'hurry', true],
      ['road2', 'hurry', true],
      ['whisper', 'slow', true],
    ]);
    // Две дороги и слух вместе дают +2 единицы в месяц, но не больше 30% работы ведущего.
    const withHolds = deed.ratePerDay;
    for (const o of city.objects) o.holds = [];
    refreshAllFronts(s.deps, city, 0);
    expect(withHolds).toBeCloseTo(deed.ratePerDay * (1 + s.r.fronts.hold.foundCap));
  });
});
