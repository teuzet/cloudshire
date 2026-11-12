/**
 * Ход жреца: покровитель написал — город догоняется до сегодня, жрец отвечает,
 * дела заводятся, мана списывается. Чтение бесплатно: без маны жрец не слышит,
 * но вести и хроника доступны всегда.
 */

import type { City } from '../core/city.js';
import { appendDialog } from '../core/chronicle.js';
import { canAfford, spendMana, turnCost } from '../core/mana.js';
import { runPriestTurn, type PriestHandlers, type ToolOutcome } from '../agents/priest/run.js';
import { askLoremaster } from '../agents/loremaster/run.js';
import { judgeExistence } from '../agents/existence-judge/run.js';
import { activeFacts } from '../core/lore.js';
import type { CityLocks } from './city-lock.js';
import { newId, requireWorld, sendAll, today, tryAgent, type FlowDeps } from './context.js';
import { processDue } from './day.js';
import { playerWill, withdraw } from './will.js';

const MAX_NOTES = 20;

export type PatronReply =
  | { kind: 'reply'; text: string; acted: boolean; manaLeft: number }
  | { kind: 'no_mana'; text: string }
  | { kind: 'no_city' }
  | { kind: 'failed'; text: string };

function handlersFor(deps: FlowDeps, city: City, day: number): PriestHandlers {
  const tired = (): ToolOutcome => ({ ok: false, error: 'no_mana', say: 'Сил на новое дело сегодня нет: веры не хватает. Можно только говорить.' });
  const withAction = deps.rules.mana.turnCostWithAction;

  return {
    // Оба инструмента ведут в один поток: что это за приказ, решает Толкователь воли.
    async assignOfficer({ office, task }) {
      if (!canAfford(city, withAction)) return tired();
      return playerWill(deps, city, office, task, day);
    },
    async orderChange({ office, intent }) {
      if (!canAfford(city, withAction)) return tired();
      return playerWill(deps, city, office, intent, day);
    },
    async withdraw({ office }) {
      return withdraw(deps, city, office, day);
    },
    async writeNote({ text }) {
      city.notes.push({ id: newId(deps, 'note'), text, day });
      if (city.notes.length > MAX_NOTES) city.notes.splice(0, city.notes.length - MAX_NOTES);
      return { ok: true, say: 'Запомнил.' };
    },
    async consultLoremaster({ question, story_id }) {
      try {
        const lore = await askLoremaster(deps.agents, {
          city,
          day,
          questions: [question],
          asker: 'priest',
          frontId: story_id ?? null,
          newFactId: () => newId(deps, 'fact'),
        });
        return { ok: true, say: lore.text };
      } catch (err) {
        deps.log?.warn('loremaster_failed', { cityId: city.id, error: String(err) });
        return { ok: false, error: 'loremaster_failed', say: 'Сейчас это не припомнить. Отвечай из того, что знаешь, или скажи, что не знаешь.' };
      }
    },
    async checkExistence({ thing, context }) {
      const ruling = await tryAgent(
        deps,
        'existence-judge',
        () =>
          judgeExistence(deps.agents, {
            thing,
            context,
            objects: city.objects.filter((o) => o.status === 'active' && !o.hidden),
            facts: activeFacts(city),
          }),
        { verdict: 'unknown' as const, objectId: null, reason: '' },
      );
      if (ruling.verdict === 'exists') {
        const obj = ruling.objectId ? city.objects.find((o) => o.id === ruling.objectId) : null;
        return { ok: true, say: obj ? `Это есть в городе: ${obj.name}. ${obj.description}` : `Это есть в городе. ${ruling.reason}` };
      }
      if (ruling.verdict === 'absent') return { ok: true, say: `Такого в мире нет: ${ruling.reason}` };
      if (ruling.verdict === 'unknown') {
        return {
          ok: true,
          say: `Есть ли «${thing}», неизвестно. Узнать это можно только поиском: если покровитель велит, это поручение искать (order_change «найти …»).`,
        };
      }
      // Подробность без пользы сама по себе: лормастер дописывает её в канон.
      try {
        const lore = await askLoremaster(deps.agents, {
          city,
          day,
          questions: [`Что такое «${thing}» в нашем городе? Опиши коротко, как это устроено. Повод: ${context}`],
          asker: 'priest',
          frontId: null,
          newFactId: () => newId(deps, 'fact'),
        });
        return { ok: true, say: `Это есть в городе. ${lore.text}` };
      } catch (err) {
        deps.log?.warn('loremaster_failed', { cityId: city.id, error: String(err) });
        return { ok: true, say: `Это есть в городе: ${thing}. ${ruling.reason}` };
      }
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
