/**
 * Ход жреца: покровитель написал — город догоняется до сегодня, жрец отвечает,
 * дела заводятся, мана списывается. Чтение бесплатно: без маны жрец не слышит,
 * но вести и хроника доступны всегда.
 */

import type { City } from '../core/city.js';
import { appendDialog } from '../core/chronicle.js';
import { canAfford, spendMana, turnCost } from '../core/mana.js';
import { officeDef } from '../core/officers.js';
import type { Office } from '../core/rules.js';
import { runPriestTurn, type PriestHandlers, type ToolOutcome } from '../agents/priest/run.js';
import type { CityLocks } from './city-lock.js';
import { newId, requireWorld, sendAll, today, type FlowDeps } from './context.js';
import { processDue } from './day.js';
import { freeOfficer, openMutation, placeAssignment, withdrawOfficer } from './fronts.js';

const MAX_NOTES = 20;

export type PatronReply =
  | { kind: 'reply'; text: string; acted: boolean; manaLeft: number }
  | { kind: 'no_mana'; text: string }
  | { kind: 'no_city' }
  | { kind: 'failed'; text: string };

function officerName(deps: FlowDeps, city: City, office: Office): string {
  const o = city.officers.find((x) => x.office === office);
  return `${officeDef(deps.rules, office).title} ${o?.name ?? ''}`.trim();
}

function handlersFor(deps: FlowDeps, city: City, day: number): PriestHandlers {
  const busy = (office: Office, what: string | null): ToolOutcome => ({
    ok: false,
    error: 'officer_busy',
    say: `${officerName(deps, city, office)} уже занят${what ? `: ${what}` : ''}. Сначала снять его с этого дела или взять другого.`,
  });
  const tired = (): ToolOutcome => ({ ok: false, error: 'no_mana', say: 'Сил на новое дело сегодня нет: веры не хватает. Можно только говорить.' });
  const withAction = deps.rules.mana.turnCostWithAction;

  return {
    async assignOfficer({ office, task }) {
      if (!canAfford(city, withAction)) return tired();
      const check = freeOfficer(city, office);
      if (!check.ok) return check.error === 'officer_busy' ? busy(office, check.busyWith) : { ok: false, error: 'no_officer', say: 'Такого сановника нет.' };
      const placed = await placeAssignment(deps, city, check.officer, task, day);
      return placed.front
        ? { ok: true, say: `${officerName(deps, city, office)} взялся за дело.` }
        : { ok: true, say: `${officerName(deps, city, office)} взялся, но не похоже, что это сдвинет что-то из того, что сейчас идёт в городе.` };
    },
    async orderChange({ office, intent }) {
      if (!canAfford(city, withAction)) return tired();
      const check = freeOfficer(city, office);
      if (!check.ok) return check.error === 'officer_busy' ? busy(office, check.busyWith) : { ok: false, error: 'no_officer', say: 'Такого сановника нет.' };
      const outcome = await openMutation(deps, city, check.officer, intent, day);
      if (outcome.kind === 'blocked') {
        return outcome.feasibility.verdict === 'LOCKED'
          ? { ok: false, error: 'locked', say: `Начать пока нельзя: не хватает того, что нужно: ${outcome.feasibility.missing}.` }
          : { ok: false, error: 'impossible', say: `Такого город не сможет: ${outcome.feasibility.reason}` };
      }
      if (outcome.kind === 'failed') return { ok: false, error: 'failed', say: 'Волю не удалось облечь в дело. Пусть покровитель скажет иначе.' };
      return {
        ok: true,
        say: `${officerName(deps, city, office)} начал работу: ${outcome.draft.description}.${outcome.consequences ? ' Дело большое, и у него будут последствия.' : ''}`,
      };
    },
    async withdraw({ office }) {
      const r = withdrawOfficer(deps, city, office, day);
      return r.ok ? { ok: true, say: `${officerName(deps, city, office)} снят с дела: ${r.text}.` } : { ok: false, error: 'not_busy', say: `${officerName(deps, city, office)} и так свободен.` };
    },
    async writeNote({ text }) {
      city.notes.push({ id: newId(deps, 'note'), text, day });
      if (city.notes.length > MAX_NOTES) city.notes.splice(0, city.notes.length - MAX_NOTES);
      return { ok: true, say: 'Запомнил.' };
    },
  };
}

export async function patronMessage(
  deps: FlowDeps,
  locks: CityLocks,
  args: { ownerId: string; text: string; quote?: string | null },
): Promise<PatronReply> {
  const found = await deps.storage.getCityByOwner(args.ownerId);
  if (!found) return { kind: 'no_city' };

  return locks.run(found.id, async () => {
    const world = await requireWorld(deps);
    let city = (await deps.storage.getCity(found.id)) ?? found;
    const news = await processDue(deps, world, city);
    // Если ход сорвётся, дела, заведённые на полпути, не должны остаться без ответа жреца.
    const beforeTurn = structuredClone(city);
    const day = today(deps, world);

    let reply: PatronReply;
    if (!canAfford(city, turnCost(deps.rules, { acted: false }))) {
      reply = { kind: 'no_mana', text: 'Алтарь молчит: веры не хватает, чтобы жрец услышал тебя. Она прибудет со временем.' };
    } else {
      try {
        const turn = await runPriestTurn(
          deps.agents,
          { rules: deps.rules, city, day, message: args.text, quote: args.quote ?? null, dialogDepth: deps.rules.priest.dialogDepth },
          handlersFor(deps, city, day),
        );
        const cost = turnCost(deps.rules, { acted: turn.acted });
        if (!spendMana(city, cost)) spendMana(city, turnCost(deps.rules, { acted: false }));
        appendDialog(city, { role: 'patron', text: args.text, day, kind: 'reply' });
        appendDialog(city, { role: 'priest', text: turn.reply, day, kind: 'reply' });
        reply = { kind: 'reply', text: turn.reply, acted: turn.acted, manaLeft: Math.floor(city.mana.value) };
      } catch (err) {
        deps.log?.warn('priest_failed', { cityId: city.id, error: String(err) });
        city = beforeTurn;
        reply = { kind: 'failed', text: 'Жрец не ответил. Этот ход не засчитан — повтори волю, когда будешь готов.' };
      }
    }
    await deps.storage.saveCity(city);
    await sendAll(deps, news);
    return reply;
  });
}
