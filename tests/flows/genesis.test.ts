import { describe, expect, test } from 'vitest';
import { toolReply } from '../../src/adapters/llm/fake.js';
import { STAT_IDS } from '../../src/core/rules.js';
import { onboardingMessage, runGenesis } from '../../src/flows/onboarding.js';
import type { LlmRequest } from '../../src/ports/llm.js';
import { stand } from '../helpers/game.js';

function poolFrom(req: LlmRequest): string[] {
  const line = req.system.split('\n').find((l, i, all) => all[i - 1]?.startsWith('ИМЕНА:')) ?? '';
  return line.split(', ').filter(Boolean);
}

const person = (name: string) => ({ name, gender: 'female', nature: 'тиха' });

describe('онбординг → генезис', () => {
  test('город поднимается из разговора, статы в бюджете, первое слово доходит', async () => {
    const s = await stand();
    s.llm
      .script(
        'onboarding-guide',
        toolReply('submit_onboarding', { reply: 'Как тебя звать?' }),
        toolReply('submit_onboarding', { reply: 'Поднимаю.', seed: { city_name: 'Мерв', patron_name: 'Алаэр', patron_gender: 'female', pitch: 'Каменотёсы' } }),
      )
      .always('city-genesis', (req) => {
        const n = poolFrom(req);
        return toolReply('submit_genesis', {
          city_name: 'Мерв',
          description: 'Город каменотёсов. '.repeat(20),
          brief: 'Мерв живёт камнем. '.repeat(10),
          priest: person(n[0]!),
          officers: { treasurer: person(n[1]!), marshal: person(n[2]!), keeper: person(n[3]!), chancellor: person(n[4]!) },
          greeting: 'Алаэр, город слышит тебя.',
        });
      })
      .always('world-objects-genesis', () =>
        toolReply('submit_world_objects', {
          objects: Array.from({ length: s.r.fronts.genesisObjects.minCount }, (_, i) => ({
            type: 'building',
            name: `Мастерская ${i}`,
            description: 'Каменная мастерская.',
            weight: i % 2 ? 'MINOR' : 'SIGNIFICANT',
            stat_profile: { [STAT_IDS[i % 4]!]: 1 + (i % 3) },
          })),
        }),
      );

    expect(await onboardingMessage(s.deps, { ownerId: 'u1', text: 'привет' })).toMatchObject({ kind: 'reply', ready: false });
    expect(await onboardingMessage(s.deps, { ownerId: 'u1', text: 'Я Алаэр, город каменотёсов' })).toMatchObject({ ready: true });
    expect(await onboardingMessage(s.deps, { ownerId: 'u1', text: 'ну что?' })).toMatchObject({ kind: 'busy' });

    const city = await runGenesis(s.deps, 'u1');
    expect(city?.name).toBe('Мерв');
    expect(city?.patronName).toBe('Алаэр');
    const sum = STAT_IDS.reduce((a, id) => a + city!.stats[id], 0);
    expect(sum).toBe(s.r.genesis.statBudget);
    for (const id of STAT_IDS) {
      expect(city!.stats[id]).toBeGreaterThanOrEqual(s.r.genesis.statMin);
      expect(city!.stats[id]).toBeLessThanOrEqual(s.r.genesis.statMax);
    }
    expect(city!.jobs.find((j) => j.kind === 'seed')?.dueDay).toBe(s.r.seeding.firstStoryDay);
    expect(s.inbox.sent.map((m) => m.text)).toEqual(['Алаэр, город слышит тебя.']);
    expect(await s.deps.storage.getDraft('u1')).toBeNull();

    // Пять человек взяли имена из пула мира, остальные имена вернулись.
    const world = await s.deps.storage.getWorld();
    const people = [city!.priest.name, ...city!.officers.map((o) => o.name)];
    for (const n of people) expect(world!.namePool).not.toContain(n);
    expect(world!.namePool.length + people.length).toBe(10);
    expect(await onboardingMessage(s.deps, { ownerId: 'u1', text: 'ещё' })).toEqual({ kind: 'has_city' });
  });

  test('сломанный генезис: черновик failed, имена вернулись, игрок предупреждён', async () => {
    const s = await stand();
    s.llm
      .script('onboarding-guide', toolReply('submit_onboarding', { reply: 'Поднимаю.', seed: { patron_name: 'Алаэр', patron_gender: 'male', pitch: 'x' } }))
      .always('city-genesis', toolReply('submit_genesis', { city_name: 'М' }));
    await onboardingMessage(s.deps, { ownerId: 'u1', text: 'старт' });
    expect(await runGenesis(s.deps, 'u1')).toBeNull();
    expect((await s.deps.storage.getDraft('u1'))?.status).toBe('failed');
    expect((await s.deps.storage.getWorld())?.namePool).toHaveLength(10);
    expect(s.inbox.sent[0]?.kind).toBe('system');
    // После сбоя игрок может говорить дальше.
    s.llm.script('onboarding-guide', toolReply('submit_onboarding', { reply: 'Ещё раз?' }));
    expect(await onboardingMessage(s.deps, { ownerId: 'u1', text: 'давай' })).toMatchObject({ kind: 'reply' });
  });
});
