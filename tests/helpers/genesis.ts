import { toolReply, type FakeLlm } from '../../src/adapters/llm/fake.js';
import { STAT_IDS, type Rules } from '../../src/core/rules.js';
import type { LlmRequest } from '../../src/ports/llm.js';

/** Список ИМЕНА из системного промпта запроса. */
export function poolFrom(req: LlmRequest): string[] {
  const lines = req.system.split('\n');
  const i = lines.findIndex((l) => l.startsWith('ИМЕНА (пол'));
  return (lines[i + 1] ?? '')
    .split(', ')
    .map((n) => n.replace(/ \([жм]\)$/, ''))
    .filter(Boolean);
}

export const PORTRAIT = 'Город каменотёсов на крутом острове, живёт камнем и помнит своё прошлое. '.repeat(40);

/** Список объектов: цепочка связей, две большие вещи разного рода, один скрытый. */
export function objectPlan(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    name: `Мастерская ${i}`,
    type: 'building',
    links: [`Мастерская ${(i + 1) % count}`],
    parent: '',
    hidden: i === 2,
    arc: i === 0 ? 'mystery' : i === 1 ? 'danger' : 'none',
  }));
}

/** Описания к списку из запроса: имена берутся из блока СПИСОК ОБЪЕКТОВ. */
export function detailsFor(req: LlmRequest): Record<string, unknown> {
  const text = req.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
  const block = text.split('СПИСОК ОБЪЕКТОВ')[1] ?? '';
  const names = [...block.matchAll(/^- (.+?) \(/gm)].map((m) => m[1]!);
  return {
    objects: names.map((name, i) => ({
      name,
      description: 'Каменная мастерская.',
      weight: i % 2 ? 'MINOR' : 'SIGNIFICANT',
      stat_profile: { [STAT_IDS[i % 4]!]: 1 + (i % 3) },
    })),
  };
}

/** Ответы всем агентам генезиса: портрет, объекты в два шага, сановники, бриф, сверка, стартовая сцена. */
export function scriptGenesis(
  llm: FakeLlm,
  r: Rules,
  opts: { cityName: string; patronName: string; unknowns?: Array<{ text: string; object_ids: string[] }>; missing?: string[] },
): FakeLlm {
  return llm
    .always('city-genesis', (req) =>
      toolReply('submit_portrait', {
        city_name: opts.cityName,
        priest_name: poolFrom(req)[0],
        priest_nature: 'Тиха и внимательна к знамениям.',
        portrait: PORTRAIT,
        hidden: 'Под первой мастерской спит старая жила.',
      }),
    )
    .always('world-objects-genesis', (req) => {
      const tool = req.tools![0]!.name;
      if (tool === 'submit_object_list') {
        const text = req.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
        if (text.includes('ДЕТАЛИ ИГРОКА')) {
          return toolReply('submit_object_list', { objects: [{ name: 'Добор', type: 'site', links: ['Мастерская 0'], parent: '', hidden: false, arc: 'none' }] });
        }
        return toolReply('submit_object_list', { objects: objectPlan(r.fronts.genesisObjects.minCount) });
      }
      return toolReply('submit_object_details', detailsFor(req));
    })
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
      return toolReply('submit_city_brief', { brief: `${opts.cityName} живёт камнем. `.repeat(90), unknowns });
    })
    .always('pitch-auditor', () =>
      toolReply('submit_audit', {
        details: [{ detail: 'каменотёсы', place: 'brief' }, ...(opts.missing ?? []).map((detail) => ({ detail, place: 'missing' }))],
      }),
    )
    .always('city-intro', () =>
      toolReply('submit_intro', {
        view: 'Внизу плывёт остров, в его середине лежит город каменотёсов, и в храме горят огни. '.repeat(9),
        priest_call: [`${opts.patronName}... Ты слышишь меня?`, 'Я жду.'],
      }),
    );
}
