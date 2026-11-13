/**
 * Посевщик историй: адаптирует заготовку под город или пишет историю по зерну.
 * Ответ проверяется той же схемой, что и заготовки в scenarios/*.yaml.
 */

import type { CanonicalUnknown, PoolName, WorldObject } from '../../core/city.js';
import { scenarioDraftSchema, touchedMysteries, type Scenario } from '../../core/world/scenario.js';
import { composeSystem, loadPrompt } from '../_shared/canon.js';
import { bullets, namesBlock, objectsBlock, section } from '../_shared/format.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';

export interface ScenarioWriterInput {
  cityBrief: string;
  objects: WorldObject[];
  /** Заготовка, которую надо подогнать, или null. */
  template: Scenario | null;
  /** Зерно, если заготовки нет: одна-две фразы. */
  seed: string | null;
  names: readonly PoolName[];
  /** Тайны острова: их объекты новая история не трогает. */
  unknowns: readonly CanonicalUnknown[];
  /** Имена объектов, вокруг которых город живёт сейчас: история охотнее цепляется за них. */
  focus?: readonly string[];
}

const prompt = loadPrompt(import.meta.url);

function mysteryBlock(unknowns: readonly CanonicalUnknown[]): string {
  const locked = unknowns.filter((u) => u.objectIds.length);
  if (!locked.length) return '';
  return section(
    'ТАЙНЫ ОСТРОВА (эти объекты не трогай: ни ссылкой, ни ставкой)',
    bullets(locked.map((u) => `${u.objectIds.join(', ')} — ${u.text}`)),
  );
}

function checkIds(raw: Scenario, existing: Set<string>): string | null {
  const local = new Set<string>();
  for (const id of [...raw.objects.map((o) => o.id), ...raw.fronts.map((f) => f.id)]) {
    if (local.has(id)) return `id ${id} повторяется`;
    local.add(id);
  }
  const known = (id: string) => local.has(id) || existing.has(id);
  for (const o of raw.objects) for (const r of o.refs) if (!known(r)) return `объект ${o.id}: нет ссылки ${r}`;
  for (const f of raw.fronts) {
    for (const r of f.refs) if (!known(r)) return `фронт ${f.id}: нет ссылки ${r}`;
    const s = f.stake;
    const target = s && 'modify' in s ? s.modify.target : s && 'delete' in s ? s.delete.target : s && 'uncover' in s ? s.uncover.target : null;
    if (target && !known(target)) return `фронт ${f.id}: нет цели ставки ${target}`;
    const sub = new Set<string>();
    for (const id of [...f.events.map((e) => e.id), ...f.clues.map((c) => c.id)]) {
      if (sub.has(id)) return `фронт ${f.id}: id ${id} повторяется`;
      sub.add(id);
    }
  }
  return null;
}

/**
 * Подгонка меняет слова, а не устройство: состав объектов, числа, род и срок фронтов, вклад и
 * скрытость объектов берутся из заготовки. Новых объектов и фронтов нет: дописанные писателем
 * объекты забегали вперёд истории (готовый результат, разгадка тайны) и выдавали её с первого дня.
 */
function keepTemplate(raw: Scenario, template: Scenario): Scenario {
  const tObjects = new Map(template.objects.map((o) => [o.id, o]));
  // Писатель иногда переименовывает id: тогда объект заготовки узнаём по месту и типу.
  const objects = raw.objects.flatMap((o, i) => {
    const byPlace = template.objects[i];
    const t = tObjects.get(o.id) ?? (byPlace && byPlace.type === o.type && !raw.objects.some((x) => x.id === byPlace.id) ? byPlace : undefined);
    if (!t) return [];
    const { weight: _w, statProfile: _p, hidden: _h, ...rest } = o;
    return [{ ...rest, type: t.type, ...(t.weight ? { weight: t.weight } : {}), ...(t.statProfile ? { statProfile: t.statProfile } : {}), ...(t.hidden ? { hidden: true } : {}) }];
  });
  // Объект заготовки, который писатель потерял, возвращается как есть.
  const kept = new Set(objects.map((o) => o.id));
  const matched = new Set(raw.objects.flatMap((o, i) => (tObjects.has(o.id) ? [o.id] : template.objects[i] && template.objects[i]!.type === o.type ? [template.objects[i]!.id] : [])));
  for (const t of template.objects) if (!kept.has(t.id) && !matched.has(t.id)) objects.push(t);
  // Писатель мог переименовать объект заготовки: его слово главнее, заново объект не добавляем.
  const present = new Set(objects.map((o) => o.id));
  const targetOf = (st: Scenario['fronts'][number]['stake']) =>
    st && 'modify' in st ? st.modify.target : st && 'delete' in st ? st.delete.target : st && 'uncover' in st ? st.uncover.target : null;
  const written = new Map(raw.fronts.map((f) => [f.id, f]));
  const fronts = template.fronts.map((t, i) => {
    const byPlace = raw.fronts[i];
    const w = written.get(t.id) ?? (byPlace && !template.fronts.some((x) => x.id === byPlace.id) ? byPlace : undefined);
    if (!w) return { ...t, refs: t.refs.filter((r) => present.has(r)) };
    const sameKind = (a: Scenario['fronts'][number]['stake'], b: Scenario['fronts'][number]['stake']) =>
      Boolean(a && b && Object.keys(a)[0] === Object.keys(b)[0]);
    // Ставку-создание и раскрытие писатель может переназвать; числа и цели остаются из заготовки.
    const lost = targetOf(t.stake);
    const stake =
      (t.stake && w.stake && sameKind(t.stake, w.stake) && ('create' in t.stake || 'reveal' in t.stake)) || (lost && !present.has(lost))
        ? w.stake
        : t.stake;
    const fixed = stake && t.stake && 'create' in t.stake && 'create' in stake
      ? { create: { ...stake.create, type: t.stake.create.type, weight: t.stake.create.weight, statProfile: t.stake.create.statProfile } }
      : stake;
    return {
      ...w,
      impact: t.impact,
      drift: t.drift,
      beatCount: t.beatCount,
      ...(t.form ? { form: t.form } : { form: undefined }),
      stake: fixed,
      events: w.events.length === t.events.length ? w.events : t.events,
      clues: w.clues.length === t.clues.length ? w.clues : t.clues,
    };
  });
  // Толчки другим фронтам берутся из заготовки, а цели переводятся на id, которые дал писатель.
  const finalId = new Map(template.fronts.map((t, i) => [t.id, fronts[i]!.id]));
  const withCloses = fronts.map((f, i) => ({
    ...f,
    closes: template.fronts[i]!.closes.map((c) => ({ target: finalId.get(c.target) ?? c.target, share: c.share })),
  }));
  return { ...raw, id: template.id, objects, fronts: withCloses, ...(template.axes ? { axes: template.axes } : {}), ...(template.scale ? { scale: template.scale } : {}) };
}

export const scenarioWriter: StructuredAgent<ScenarioWriterInput, Scenario, Scenario> = {
  name: 'scenario-writer',
  tool: 'submit_scenario',
  description: 'Объекты и фронты новой истории.',
  schema: scenarioDraftSchema,
  system: ({ cityBrief, objects, names, unknowns, focus }) =>
    composeSystem(
      ['world', 'style-names'],
      prompt,
      section('Город', cityBrief),
      section('Объекты города', objectsBlock(objects)),
      section('Сейчас город живёт вокруг этого (историю лучше связать с одним из них)', focus?.length ? bullets([...focus]) : null),
      mysteryBlock(unknowns),
      namesBlock(names),
    ),
  user: ({ template, seed }) =>
    template
      ? `Заготовка (id объектов и фронтов сохрани как есть):\n${JSON.stringify(template, null, 2)}`
      : `Зерно истории: ${seed ?? 'на твой выбор, по городу'}`,
  check: (raw, { objects, unknowns }) => {
    const touched = touchedMysteries(raw, new Set(unknowns.flatMap((u) => u.objectIds)));
    if (touched.length) return `история касается тайны острова: ${touched.join(', ')}. Эти объекты не трогай`;
    return checkIds(raw, new Set(objects.filter((o) => o.status === 'active').map((o) => o.id)));
  },
  finish: (raw, { template }) => (template ? keepTemplate(raw, template) : raw),
};

export async function writeScenario(deps: AgentDeps, input: ScenarioWriterInput): Promise<Scenario> {
  return (await runStructured(deps, scenarioWriter, input)).value;
}
