/**
 * Онбординг и генезис.
 *
 *   onboardingMessage — разговор с проводником до готовой «рыбы»;
 *   runGenesis        — из «рыбы» город: портрет → список объектов со связями → их описания и статы →
 *                       сановники → бриф неизменного → сверка с питчем и добор → стартовая сцена.
 *
 * Генезис долгий (несколько вызовов модели), поэтому клиент запускает его отдельно
 * и показывает игроку, что город собирается.
 */

import { newCity, type City } from '../core/city.js';
import { appendChronicle, appendDialog } from '../core/chronicle.js';
import { scheduleJob } from '../core/jobs.js';
import { createOfficers, rollTemper } from '../core/officers.js';
import { createObject } from '../core/world/objects.js';
import { genesisStats, objectContribution } from '../core/world/stats.js';
import type { OnboardingDraft } from '../ports/storage.js';
import { guideOnboarding } from '../agents/onboarding-guide/run.js';
import { clerkBook } from '../agents/onboarding-guide/book.js';
import { drawSpirits, shortlistQuestions } from '../core/clerk.js';
import { writeCityPortrait } from '../agents/city-genesis/run.js';
import { writeOfficerNatures } from '../agents/officer-nature/run.js';
import { writeCityBrief } from '../agents/city-brief/run.js';
import { auditPitch } from '../agents/pitch-auditor/run.js';
import { writeCityIntro } from '../agents/city-intro/run.js';
import { describeWorldObjects, planWorldObjects, type GenesisObjectDraft } from '../agents/world-objects-genesis/run.js';
import type { WorldObject } from '../core/city.js';
import { newId, requireWorld, returnNames, sendAll, takeNames, today, tryAgent, type FlowDeps } from './context.js';

export type OnboardingReply =
  /** text — реплика клерка; pitch — текст питча, если его надо показать игроку под репликой (новый или изменённый). */
  | { kind: 'reply'; text: string; pitch: string | null; ready: boolean }
  | { kind: 'busy'; text: string }
  | { kind: 'has_city' };

/**
 * Ход разговора с клерком. Клерк пишет реплику и текст питча; поток хранит питч, который игрок видел,
 * подаёт клерку настроения для набросков и вопросы на выбор и запускает сборку только после согласия игрока.
 */
export async function onboardingMessage(deps: FlowDeps, args: { ownerId: string; text: string }): Promise<OnboardingReply> {
  if (await deps.storage.getCityByOwner(args.ownerId)) return { kind: 'has_city' };
  const book = clerkBook();
  const draft: OnboardingDraft = (await deps.storage.getDraft(args.ownerId)) ?? {
    ownerId: args.ownerId,
    messages: [],
    seed: null,
    status: 'talking',
    revision: 0,
  };
  if (draft.status === 'generating') return { kind: 'busy', text: 'Город ещё поднимается. Жрец напишет, когда всё будет готово.' };

  draft.status = 'talking';
  const state = (draft.clerk ??= { spirits: [], spiritsUsed: [], asked: [], heard: [] });
  if (!state.spirits.length) state.spirits = drawSpirits(book, deps.random.rng, state.spiritsUsed).map((s) => s.id);
  const spirits = state.spirits.flatMap((id) => book.spirits.find((s) => s.id === id) ?? []);
  const questions = shortlistQuestions(book, deps.random.rng, state.asked, state.heard);
  const shown = draft.pitch ?? null;

  if (args.text.trim()) draft.messages.push({ role: 'patron', text: args.text.trim() });
  const out = await tryAgent(deps, 'onboarding-guide', () => guideOnboarding(deps.agents, { turns: draft.messages, pitch: shown, spirits, questions }), null);
  if (!out) {
    const text = 'Не расслышал. Скажи ещё раз, каким ты видишь свой город?';
    draft.messages.push({ role: 'guide', text });
    await deps.storage.saveDraft(draft);
    return { kind: 'reply', text, pitch: null, ready: false };
  }

  const changed = out.pitch != null && out.pitch !== shown;
  draft.pitch = out.pitch ?? shown;
  draft.messages.push({ role: 'guide', text: changed ? `${out.reply}\n\n[Питч, показанный игроку]\n${out.pitch}` : out.reply });
  if (out.usedQuestion && !state.asked.includes(out.usedQuestion)) state.asked.push(out.usedQuestion);
  state.heard = [...new Set([...state.heard, ...out.themesHeard])];
  if (out.usedSketches) {
    // Эти настроения показаны: попросит игрок другие варианты — придут свежие.
    state.spiritsUsed = [...new Set([...state.spiritsUsed, ...state.spirits])];
    state.spirits = [];
  }
  if (out.seed) {
    draft.seed = out.seed;
    draft.status = 'generating';
  }
  await deps.storage.saveDraft(draft);
  return { kind: 'reply', text: out.reply, pitch: changed ? out.pitch : null, ready: Boolean(out.seed) };
}

const PEOPLE = 5;

/**
 * Собрать город из «рыбы». Сломалась модель — черновик помечается failed,
 * игрок получает служебное сообщение и может начать заново.
 */
/** Шаги сборки города для полоски прогресса: номер шага и что сейчас делается. */
export type GenesisProgress = (step: number, total: number, label: string) => Promise<void>;

/** Портрет, список объектов, описания, сановники, бриф, сверка, стартовая сцена и готовый город. */
export const GENESIS_STEPS = 8;

/** Запасная стартовая сцена, если агент сцены сломался. */
function fallbackIntro(cityName: string, patronName: string): { view: string; priestCall: string[] } {
  return {
    view: `Внизу, в облаках, плывёт твой остров. В его середине лежит город ${cityName}, и в храме горят огни ритуала.`,
    priestCall: [`${patronName}... Ты слышишь меня?`],
  };
}

/** Объекты города из черновиков: связи по именам становятся ссылками в обе стороны. */
function buildObjects(deps: FlowDeps, drafts: readonly GenesisObjectDraft[], day: number, existing: WorldObject[] = []): WorldObject[] {
  const key = (n: string): string => n.trim().toLowerCase();
  const byName = new Map(existing.map((o) => [key(o.name), o]));
  const made = drafts.map((d) => {
    const obj = createObject(deps.rules, {
      id: newId(deps, 'obj'),
      type: d.type,
      name: d.name,
      description: d.description,
      statEffect: objectContribution(deps.rules, d.weight, d.statProfile),
      day,
      hidden: d.hidden,
      arc: d.arc,
    });
    byName.set(key(d.name), obj);
    return obj;
  });
  drafts.forEach((d, i) => {
    const obj = made[i]!;
    if (d.parent) obj.parentId = byName.get(key(d.parent))?.id ?? null;
    for (const name of d.links) {
      const other = byName.get(key(name));
      if (!other || other.id === obj.id) continue;
      if (!obj.refs.includes(other.id)) obj.refs.push(other.id);
      if (!other.refs.includes(obj.id)) other.refs.push(obj.id);
    }
  });
  return made;
}

export async function runGenesis(deps: FlowDeps, ownerId: string, onProgress?: GenesisProgress): Promise<City | null> {
  const draft = await deps.storage.getDraft(ownerId);
  if (!draft?.seed || draft.status !== 'generating') return null;
  const world = await requireWorld(deps);
  const day = today(deps, world);
  const names = await takeNames(deps, PEOPLE + 3);

  const progress = async (step: number, label: string): Promise<void> => {
    try {
      await onProgress?.(step, GENESIS_STEPS, label);
    } catch (err) {
      deps.log?.warn('genesis_progress_failed', { ownerId, error: String(err) });
    }
  };

  try {
    const seed = draft.seed;
    await progress(0, 'начинаю…');
    // 1. Портрет: свободный текст о городе, скрытая правда, имя и жрец.
    const portrait = await writeCityPortrait(deps.agents, { seed, names, seasonRules: world.season.rules });
    const text = { rules: deps.rules, cityName: portrait.cityName, portrait: portrait.portrait, hidden: portrait.hidden };
    // 2–3. Объекты: список со связями, затем описания и вклад.
    await progress(1, 'расставляю места, людей и обычаи…');
    const plan = await planWorldObjects(deps.agents, text);
    await progress(2, 'описываю каждое место…');
    const objects = buildObjects(deps, await describeWorldObjects(deps.agents, { ...text, plan }), day);
    // 4. Сановники.
    await progress(3, 'выбираю сановников…');
    const officers = await writeOfficerNatures(deps.agents, {
      rules: deps.rules,
      cityName: portrait.cityName,
      description: portrait.portrait,
      names: names.filter((n) => n.name !== portrait.priest.name),
      taken: [portrait.priest.name],
    });
    const people = [portrait.priest.name, ...Object.values(officers).map((p) => p.name)];
    // 5. Бриф: неизменное в городе, после объектов.
    await progress(4, 'записываю, чем живёт город…');
    const briefInput = {
      cityName: portrait.cityName,
      patronName: seed.patronName,
      patronGender: seed.patronGender,
      description: portrait.portrait,
      hidden: portrait.hidden,
      people,
    };
    const brief = await tryAgent(deps, 'city-brief', () => writeCityBrief(deps.agents, { ...briefInput, objects }), {
      brief: portrait.portrait.slice(0, 2000),
      unknowns: [],
    });
    // 6. Сверка с питчем: пропавшие детали добираются объектами.
    await progress(5, 'сверяю с твоим замыслом…');
    const audit = await tryAgent(deps, 'pitch-auditor', () => auditPitch(deps.agents, { pitch: seed.pitch, brief: brief.brief, objects }), {
      found: [],
      missing: [],
    });
    if (audit.missing.length) {
      const extra = await tryAgent(
        deps,
        'genesis-topup',
        async () => {
          const more = await planWorldObjects(deps.agents, { ...text, mustCover: audit.missing, existing: objects.map((o) => o.name) });
          return buildObjects(deps, await describeWorldObjects(deps.agents, { ...text, plan: more }), day, objects);
        },
        [],
      );
      objects.push(...extra);
      if (extra.length) deps.log?.warn('genesis_topup', { ownerId, missing: audit.missing, added: extra.map((o) => o.name) });
    }
    const stats = genesisStats(deps.rules, objects.map((o) => o.statEffect));
    // 7. Стартовая сцена: вид сверху и первый зов жреца.
    await progress(6, 'жрец готовит ритуал…');
    const visible = objects.filter((o) => !o.hidden);
    const intro = await tryAgent(
      deps,
      'city-intro',
      () =>
        writeCityIntro(deps.agents, {
          cityName: portrait.cityName,
          patronName: seed.patronName,
          patronGender: seed.patronGender,
          brief: brief.brief,
          objects: visible,
          priest: portrait.priest,
        }),
      fallbackIntro(portrait.cityName, seed.patronName),
    );

    const city = newCity({
      id: newId(deps, 'city'),
      worldId: world.id,
      ownerId,
      name: portrait.cityName,
      patronName: seed.patronName,
      description: portrait.portrait,
      brief: brief.brief,
      unknowns: brief.unknowns,
      facts: [],
      priest: portrait.priest,
      // Характер-темп сановника бросается при рождении города и от должности не зависит.
      officers: createOfficers(deps.rules, officers).map((o) => ({ ...o, temper: rollTemper(deps.random.rng) })),
      objects,
      stats: stats.stats,
      statScale: stats.statScale,
      statLedger: stats.ledger,
      manaStart: deps.rules.mana.start,
      day,
    });
    const patronWord = seed.patronGender === 'female' ? 'своей покровительнице' : 'своему покровителю';
    appendChronicle(city, {
      id: newId(deps, 'chr'),
      day,
      text: `Верховный жрец ${portrait.priest.name} подготовил ритуал и впервые воззвал к ${patronWord} ${seed.patronName}.`,
      source: 'genesis',
      frontId: null,
    });
    for (const line of intro.priestCall) appendDialog(city, { role: 'priest', text: line, day, kind: 'news' });
    scheduleJob(city, { id: newId(deps, 'job'), kind: 'seed', dueDay: day + deps.rules.seeding.firstStoryDay });

    const used = new Set(people);
    await returnNames(deps, names.filter((n) => !used.has(n.name)));
    const saved = await deps.storage.saveCity(city);
    await deps.storage.deleteDraft(ownerId);
    await progress(GENESIS_STEPS, 'город готов');
    await sendAll(deps, [
      { ownerId, text: intro.view, kind: 'system', cityId: saved.id },
      ...intro.priestCall.map((line) => ({ ownerId, text: line, kind: 'news' as const, cityId: saved.id })),
    ]);
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
