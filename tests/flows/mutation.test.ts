import { describe, expect, test } from 'vitest';
import { toolReply, toolsReply } from '../../src/adapters/llm/fake.js';
import { patronMessage } from '../../src/flows/priest-turn.js';
import { runDueCities } from '../../src/flows/scheduler.js';
import { blankCity } from '../helpers/fixtures.js';
import { stand } from '../helpers/game.js';

async function cityWithWill(feasibility: object) {
  const s = await stand();
  const world = (await s.deps.storage.getWorld())!;
  const city = blankCity({ worldId: world.id, ownerId: 'u1' });
  await s.deps.storage.saveCity(city);
  s.llm
    .script('priest', toolsReply(['order_change', { office: 'treasurer', intent: 'Построить большую баллисту у края' }], ['submit_reply', { text: 'Ада начнёт.' }]))
    .always('mutation-drafter', toolReply('submit_mutation', { kind: 'create', type: 'structure', name: 'Великая баллиста', description: 'Баллиста на северном краю' }))
    .always('feasibility-judge', toolReply('submit_feasibility', feasibility))
    .always('impact-judge', toolReply('submit_impact', { impact: 'MAJOR', stat_profile: { security: 4, prosperity: -1 } }))
    .always('consequences-generator', (req) => {
      const n = Number(/Нужно кандидатов: (\d+)/.exec(JSON.stringify(req.messages))?.[1] ?? 0);
      return toolReply('submit_consequences', {
        items: Array.from({ length: n }, (_, i) => ({ description: `Последствие ${i}`, impact: 'MINOR', drift: 'SLOW' })),
      });
    })
    // Первое последствие отбраковано: в фронт идут следующие.
    .script('consequence-judge', toolReply('submit_consequence_verdict', { ok: false }))
    .always('consequence-judge', toolReply('submit_consequence_verdict', { ok: true }));
  return { ...s, cityId: city.id };
}

describe('воля игрока как фронт', () => {
  test('стройка открывается, последствия выходят на порогах, объект появляется в конце', async () => {
    const s = await cityWithWill({ verdict: 'FEASIBLE' });
    const reply = await patronMessage(s.deps, s.locks, { ownerId: 'u1', text: 'Постройте баллисту' });
    expect(reply).toMatchObject({ kind: 'reply', acted: true });

    let city = (await s.deps.storage.getCity(s.cityId))!;
    const build = city.fronts.find((f) => f.origin === 'mutation')!;
    const budget = s.r.fronts.impact.consequences.MAJOR;
    expect(build.pendingConsequences.map((c) => c.description)).toEqual(Array.from({ length: budget }, (_, i) => `Последствие ${i + 1}`));
    expect(build.ratePerDay).toBeGreaterThan(0);
    const securityBefore = city.stats.security;

    for (let i = 0; i < 2000 && city.fronts.find((f) => f.id === build.id)!.status === 'active'; i++) {
      s.passDays(1);
      await runDueCities(s.deps, s.locks);
      city = (await s.deps.storage.getCity(s.cityId))!;
    }
    expect(city.fronts.find((f) => f.id === build.id)!.status).toBe('resolved');
    expect(city.objects.find((o) => o.name === 'Великая баллиста')?.status).toBe('active');
    expect(city.stats.security).toBeGreaterThan(securityBefore);
    const sides = city.fronts.filter((f) => f.origin === 'consequence');
    expect(sides).toHaveLength(budget);
    expect(sides.every((f) => f.refs.includes(build.id))).toBe(true);
    // Каскад спросил последствия про конец стройки.
    expect(s.llm.callsTo('local-world-updater').length).toBeGreaterThanOrEqual(budget);
    expect(city.officers.find((o) => o.office === 'treasurer')!.assignmentId).toBeNull();
  });

  test('LOCKED: дела нет, сановник свободен, ход не действие', async () => {
    const s = await cityWithWill({ verdict: 'LOCKED', missing: 'камень с каменоломни' });
    const reply = await patronMessage(s.deps, s.locks, { ownerId: 'u1', text: 'Постройте баллисту' });
    expect(reply).toMatchObject({ acted: false });
    const city = (await s.deps.storage.getCity(s.cityId))!;
    expect(city.fronts).toHaveLength(0);
    expect(city.officers.every((o) => !o.assignmentId)).toBe(true);
    const toolResults = s.llm.callsTo('priest');
    expect(toolResults).toHaveLength(1);
    expect(s.llm.callsTo('impact-judge')).toHaveLength(0);
  });
});
