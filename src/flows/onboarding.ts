/**
 * Онбординг и генезис.
 *
 *   onboardingMessage — разговор с проводником до готовой «рыбы»;
 *   runGenesis        — из «рыбы» город: описание, люди, объекты, статы, первое слово жреца.
 *
 * Генезис долгий (несколько вызовов модели), поэтому клиент запускает его отдельно
 * и показывает игроку, что город собирается.
 */

import { newCity, type City } from '../core/city.js';
import { appendChronicle, appendDialog } from '../core/chronicle.js';
import { scheduleJob } from '../core/jobs.js';
import { createOfficers } from '../core/officers.js';
import { createObject } from '../core/world/objects.js';
import { genesisStats, objectContribution } from '../core/world/stats.js';
import type { OnboardingDraft } from '../ports/storage.js';
import { guideOnboarding } from '../agents/onboarding-guide/run.js';
import { writeCityGenesis } from '../agents/city-genesis/run.js';
import { extractWorldObjects } from '../agents/world-objects-genesis/run.js';
import { newId, requireWorld, returnNames, sendAll, takeNames, today, tryAgent, type FlowDeps } from './context.js';

export type OnboardingReply =
  | { kind: 'reply'; text: string; ready: boolean }
  | { kind: 'busy'; text: string }
  | { kind: 'has_city' };

export async function onboardingMessage(deps: FlowDeps, args: { ownerId: string; text: string }): Promise<OnboardingReply> {
  if (await deps.storage.getCityByOwner(args.ownerId)) return { kind: 'has_city' };
  const draft: OnboardingDraft = (await deps.storage.getDraft(args.ownerId)) ?? {
    ownerId: args.ownerId,
    messages: [],
    seed: null,
    status: 'talking',
    revision: 0,
  };
  if (draft.status === 'generating') return { kind: 'busy', text: 'Город ещё поднимается. Жрец напишет, когда всё будет готово.' };

  draft.status = 'talking';
  if (args.text.trim()) draft.messages.push({ role: 'patron', text: args.text.trim() });
  const out = await tryAgent(deps, 'onboarding-guide', () => guideOnboarding(deps.agents, { turns: draft.messages }), {
    reply: 'Не расслышал. Скажи ещё раз, каким ты видишь свой город?',
    seed: null,
  });
  draft.messages.push({ role: 'guide', text: out.reply });
  if (out.seed) {
    draft.seed = out.seed;
    draft.status = 'generating';
  }
  await deps.storage.saveDraft(draft);
  return { kind: 'reply', text: out.reply, ready: Boolean(out.seed) };
}

const PEOPLE = 5;

/**
 * Собрать город из «рыбы». Сломалась модель — черновик помечается failed,
 * игрок получает служебное сообщение и может начать заново.
 */
export async function runGenesis(deps: FlowDeps, ownerId: string): Promise<City | null> {
  const draft = await deps.storage.getDraft(ownerId);
  if (!draft?.seed || draft.status !== 'generating') return null;
  const world = await requireWorld(deps);
  const day = today(deps, world);
  const names = await takeNames(deps, PEOPLE + 3);

  try {
    const genesis = await writeCityGenesis(deps.agents, { seed: draft.seed, names, seasonRules: world.season.rules });
    const drafts = await extractWorldObjects(deps.agents, { rules: deps.rules, cityName: genesis.cityName, description: genesis.description });

    const objects = drafts.map((d) =>
      createObject(deps.rules, {
        id: newId(deps, 'obj'),
        type: d.type,
        name: d.name,
        description: d.description,
        statEffect: objectContribution(deps.rules, d.weight, d.statProfile),
        day,
      }),
    );
    const stats = genesisStats(deps.rules, objects.map((o) => o.statEffect));
    const city = newCity({
      id: newId(deps, 'city'),
      worldId: world.id,
      ownerId,
      name: genesis.cityName,
      patronName: draft.seed.patronName,
      brief: genesis.brief,
      priest: genesis.priest,
      officers: createOfficers(deps.rules, genesis.officers),
      objects,
      stats: stats.stats,
      statScale: stats.statScale,
      statLedger: stats.ledger,
      manaStart: deps.rules.mana.start,
      day,
    });
    appendChronicle(city, { id: newId(deps, 'chr'), day, text: `Основан город ${city.name}.`, source: 'genesis', frontId: null });
    appendDialog(city, { role: 'priest', text: genesis.greeting, day, kind: 'news' });
    scheduleJob(city, { id: newId(deps, 'job'), kind: 'seed', dueDay: day + deps.rules.seeding.firstStoryDay });

    const used = new Set([genesis.priest.name, ...Object.values(genesis.officers).map((p) => p.name)]);
    await returnNames(deps, names.filter((n) => !used.has(n)));
    const saved = await deps.storage.saveCity(city);
    await deps.storage.deleteDraft(ownerId);
    await sendAll(deps, [{ ownerId, text: genesis.greeting, kind: 'news', cityId: saved.id }]);
    return saved;
  } catch (err) {
    deps.log?.warn('genesis_failed', { ownerId, error: String(err) });
    await returnNames(deps, names);
    const fresh = await deps.storage.getDraft(ownerId);
    if (fresh) await deps.storage.saveDraft({ ...fresh, status: 'failed' });
    await sendAll(deps, [{ ownerId, text: 'Город не поднялся: что-то пошло не так. Напиши что-нибудь, и попробуем ещё раз.', kind: 'system', cityId: null }]);
    return null;
  }
}

/** Игрок хочет начать заново: город и черновик удаляются. */
export async function resetPlayer(deps: FlowDeps, ownerId: string): Promise<void> {
  const city = await deps.storage.getCityByOwner(ownerId);
  if (city) await deps.storage.deleteCity(city.id);
  await deps.storage.deleteDraft(ownerId);
}
