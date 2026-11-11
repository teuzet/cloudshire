/**
 * Посевщик историй: адаптирует заготовку под город или пишет историю по зерну.
 * Ответ проверяется той же схемой, что и заготовки в scenarios/*.yaml.
 */

import type { CanonicalUnknown, PoolName, WorldObject } from '../../core/city.js';
import { scenarioSchema, touchedMysteries, type Scenario } from '../../core/world/scenario.js';
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
    const target = s && 'modify' in s ? s.modify.target : s && 'delete' in s ? s.delete.target : null;
    if (target && !known(target)) return `фронт ${f.id}: нет цели ставки ${target}`;
    const sub = new Set<string>();
    for (const id of [...f.events.map((e) => e.id), ...f.clues.map((c) => c.id)]) {
      if (sub.has(id)) return `фронт ${f.id}: id ${id} повторяется`;
      sub.add(id);
    }
  }
  return null;
}

export const scenarioWriter: StructuredAgent<ScenarioWriterInput, Scenario, Scenario> = {
  name: 'scenario-writer',
  tool: 'submit_scenario',
  description: 'Объекты и фронты новой истории.',
  schema: scenarioSchema,
  system: ({ cityBrief, objects, names, unknowns }) =>
    composeSystem(
      ['world', 'style-names'],
      prompt,
      section('Город', cityBrief),
      section('Объекты города', objectsBlock(objects)),
      mysteryBlock(unknowns),
      namesBlock(names),
    ),
  user: ({ template, seed }) =>
    template ? `Заготовка:\n${JSON.stringify(template, null, 2)}` : `Зерно истории: ${seed ?? 'на твой выбор, по городу'}`,
  check: (raw, { objects, unknowns }) => {
    const touched = touchedMysteries(raw, new Set(unknowns.flatMap((u) => u.objectIds)));
    if (touched.length) return `история касается тайны острова: ${touched.join(', ')}. Эти объекты не трогай`;
    return checkIds(raw, new Set(objects.filter((o) => o.status === 'active').map((o) => o.id)));
  },
  finish: (raw, { template }) => (template ? { ...raw, id: template.id } : raw),
};

export async function writeScenario(deps: AgentDeps, input: ScenarioWriterInput): Promise<Scenario> {
  return (await runStructured(deps, scenarioWriter, input)).value;
}
