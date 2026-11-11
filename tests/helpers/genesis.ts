import { toolReply, type FakeLlm } from '../../src/adapters/llm/fake.js';
import { ASPECTS } from '../../src/agents/city-genesis/aspects.js';
import { STAT_IDS, type Rules } from '../../src/core/rules.js';
import type { LlmRequest } from '../../src/ports/llm.js';

/** Список ИМЕНА из системного промпта запроса. */
export function poolFrom(req: LlmRequest): string[] {
  const lines = req.system.split('\n');
  const i = lines.findIndex((l) => l.startsWith('ИМЕНА:'));
  return (lines[i + 1] ?? '').split(', ').filter(Boolean);
}

export function aspectText(id: string): string {
  return `Раздел ${id}: устойчивый лор города, который живёт так поколениями. `.repeat(6);
}

/** Ответы всем агентам генезиса: ядро, аспекты, объекты, сановники, бриф. */
export function scriptGenesis(
  llm: FakeLlm,
  r: Rules,
  opts: { cityName: string; patronName: string; unknowns?: Array<{ text: string; object_ids: string[] }> },
): FakeLlm {
  return llm
    .always('city-genesis', (req) => {
      const tool = req.tools![0]!.name;
      if (tool === 'submit_core') {
        return toolReply('submit_core', {
          city_name: opts.cityName,
          priest_name: poolFrom(req)[0],
          priest_gender: 'female',
          priest_description: 'Тиха и внимательна к знамениям.',
          greeting: `${opts.patronName}, город слышит тебя.`,
          opening_lore: Array.from({ length: 8 }, (_, i) => `Постоянный факт ${i + 1}.`),
        });
      }
      const ids = Object.keys((req.tools![0]!.parameters as { properties: Record<string, unknown> }).properties);
      return toolReply('submit_aspects', Object.fromEntries(ids.map((id) => [id, aspectText(id)])));
    })
    .always('world-objects-genesis', () =>
      toolReply('submit_world_objects', {
        objects: Array.from({ length: r.fronts.genesisObjects.minCount }, (_, i) => ({
          type: 'building',
          name: `Мастерская ${i}`,
          description: 'Каменная мастерская.',
          weight: i % 2 ? 'MINOR' : 'SIGNIFICANT',
          stat_profile: { [STAT_IDS[i % 4]!]: 1 + (i % 3) },
        })),
      }),
    )
    .always('officer-nature', (req) => {
      const n = poolFrom(req);
      return toolReply('submit_officer_natures', {
        officers: ['treasurer', 'marshal', 'keeper', 'chancellor'].map((office, i) => ({
          office,
          name: n[i],
          gender: i % 2 ? 'male' : 'female',
          nature: 'Решает быстро и не выносит пустых слов.',
        })),
      });
    })
    .always('city-brief', (req) => {
      const objIds = [...req.system.matchAll(/^- (obj_\S+)/gm)].map((m) => m[1]!);
      const unknowns = (opts.unknowns ?? []).map((u) => ({ ...u, object_ids: u.object_ids.map((x) => (x === '$first' ? objIds[0]! : x)) }));
      return toolReply('submit_city_brief', { brief: `${opts.cityName} живёт камнем. `.repeat(10), unknowns });
    });
}

export const ASPECT_COUNT = ASPECTS.length;
