/**
 * Жрец: ход разговора с покровителем. Модель зовёт тулы дел, пока не сдаст речь.
 * Сами дела (поручение на фронт, воля как фронт, снятие, заметка) выполняет поток
 * через переданные обработчики — агент только переводит речь в вызовы.
 */

import type { City, DialogEntry } from '../../core/city.js';
import type { Rules } from '../../core/rules.js';
import { activeAssignments } from '../../core/world/assignments.js';
import { activeFronts, findFront } from '../../core/world/fronts.js';
import { activeFacts } from '../../core/lore.js';
import { qualitativeStats } from '../../core/world/stats.js';
import { gameDate } from '../../core/time.js';
import type { LlmMessage, LlmUsage } from '../../ports/llm.js';
import { composeSystem, loadPrompt } from '../_shared/canon.js';
import { bullets, chronicleBlock, frontLine, officerLine, section } from '../_shared/format.js';
import { runToolLoop, type AgentDeps, type LoopTool } from '../_shared/runtime.js';
import {
  assignOfficerSchema,
  consultSchema,
  existenceCheckSchema,
  noteSchema,
  orderChangeSchema,
  replySchema,
  withdrawSchema,
  type AssignOfficerArgs,
  type ConsultArgs,
  type ExistenceCheckArgs,
  type NoteArgs,
  type OrderChangeArgs,
  type WithdrawArgs,
} from './schema.js';

/** Что вернул обработчик. `say` — что жрецу сказать о результате, словами мира. */
export type ToolOutcome = { ok: true; say: string } | { ok: false; error: string; say: string };

export interface PriestHandlers {
  assignOfficer(args: AssignOfficerArgs): Promise<ToolOutcome>;
  orderChange(args: OrderChangeArgs): Promise<ToolOutcome>;
  withdraw(args: WithdrawArgs): Promise<ToolOutcome>;
  writeNote(args: NoteArgs): Promise<ToolOutcome>;
  consultLoremaster(args: ConsultArgs): Promise<ToolOutcome>;
  checkExistence(args: ExistenceCheckArgs): Promise<ToolOutcome>;
}

export interface PriestTurnInput {
  rules: Rules;
  city: City;
  day: number;
  message: string;
  /** Если покровитель ответил на конкретное сообщение — его текст. */
  quote: string | null;
  /** Сколько последних реплик разговора дать модели. */
  dialogDepth?: number;
}

export interface PriestTurn {
  reply: string;
  /** Было ли заведено, изменено или снято дело (для цены хода). */
  acted: boolean;
  calls: Array<{ name: string; args: unknown; result: unknown }>;
  usage: LlmUsage;
}

const prompt = loadPrompt(import.meta.url);
const ACTIONS = new Set(['assign_officer', 'order_change', 'withdraw_assignment']);

/** Блок хода: всё, что жрец знает о городе сейчас. */
export function priestTurnBlock(rules: Rules, city: City, day: number): string {
  const assignments = activeAssignments(city);
  const officers = city.officers.map((o) => {
    const a = assignments.find((x) => x.id === o.assignmentId);
    const front = a ? findFront(city, a.frontId) : null;
    return `${officerLine(o)} — ${a ? `занят: ${front?.title ?? 'дело'}${a.text ? ` (наказ: ${a.text})` : ''}` : 'свободен'}`;
  });
  const fronts = activeFronts(city).map((f) => frontLine(city, f, day));
  const waiting = city.projects
    .filter((p) => p.status === 'waiting')
    .map((p) => `${p.id}: ${p.title} (следующий шаг: ${p.stages[p.stageIndex]?.title ?? 'не назван'})`);
  const facts = activeFacts(city).slice(-30).map((f) => f.text);
  return [
    section('ОПИСАНИЕ ГОРОДА', city.brief),
    `Город: ${city.name}. Покровитель: ${city.patronName}. Сегодня: ${gameDate(day).label}.`,
    `Ты: ${city.priest.name} (${city.priest.gender === 'female' ? 'она' : 'он'}), ${city.priest.nature}`,
    section('Состояние города', qualitativeStats(rules, city.stats)),
    section('Сановники', bullets(officers)),
    section('Что сейчас идёт в городе (id: что идёт)', bullets(fronts)),
    section('Замыслы, которые ждут слова покровителя (id: что дальше)', bullets(waiting)),
    section('Известные факты', bullets(facts)),
    section('Последние записи хроники', chronicleBlock(city.chronicle.slice(-5))),
    section('Память', bullets(city.notes.map((n) => n.text))),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function dialogMessages(dialog: DialogEntry[], message: string, quote: string | null): LlmMessage[] {
  const messages: LlmMessage[] = dialog.map((d) =>
    d.role === 'patron' ? { role: 'user', content: d.text } : { role: 'assistant', content: d.text },
  );
  if (messages[0]?.role === 'assistant') messages.unshift({ role: 'user', content: '(начало разговора)' });
  const current = quote ? `Цитата:\n${quote.split('\n').map((l) => `> ${l}`).join('\n')}\n\n${message}` : message;
  messages.push({ role: 'user', content: current });
  return messages;
}

function tool<A>(name: string, description: string, schema: LoopTool<PriestHandlers>['schema'], run: (h: PriestHandlers, a: A) => Promise<ToolOutcome>): LoopTool<PriestHandlers> {
  return { name, description, schema, run: (args: never, h: PriestHandlers) => run(h, args as A) };
}

const TOOLS: LoopTool<PriestHandlers>[] = [
  tool<AssignOfficerArgs>('assign_officer', 'Поручить сановнику работу.', assignOfficerSchema, (h, a) => h.assignOfficer(a)),
  tool<OrderChangeArgs>('order_change', 'Воля изменить сам город: построить, учредить, снести.', orderChangeSchema, (h, a) => h.orderChange(a)),
  tool<WithdrawArgs>('withdraw_assignment', 'Снять сановника с его дела. Дело остаётся стоять без ведущего. Прекратить дело совсем — order_change «отменить дело …».', withdrawSchema, (h, a) => h.withdraw(a)),
  tool<NoteArgs>('write_note', 'Постоянная заметка памяти.', noteSchema, (h, a) => h.writeNote(a)),
  tool<ConsultArgs>(
    'consult_loremaster',
    'Спросить лормастера о конкретике мира, которой нет в блоке хода. Один вопрос за вызов.',
    consultSchema,
    (h, a) => h.consultLoremaster(a),
  ),
  tool<ExistenceCheckArgs>(
    'check_existence',
    'Есть ли такое в мире. Зови, когда покровитель называет место, людей, вещь или обычай, которых нет в блоке хода, до того как отказать или поручить дело. Ответ скажет: уже есть, теперь записано, неизвестно (можно поручить поиск) или такого нет.',
    existenceCheckSchema,
    (h, a) => h.checkExistence(a),
  ),
];

export async function runPriestTurn(deps: AgentDeps, input: PriestTurnInput, handlers: PriestHandlers): Promise<PriestTurn> {
  const { rules, city, day } = input;
  const system = composeSystem(
    ['safety', 'world', 'patron', 'priest', 'time', 'foreign', 'style-names', 'style-priest-voice'],
    prompt,
    `БЛОК ХОДА\n\n${priestTurnBlock(rules, city, day)}`,
  );
  const result = await runToolLoop(deps, {
    agent: 'priest',
    system,
    messages: dialogMessages(city.dialog.slice(-(input.dialogDepth ?? 12)), input.message, input.quote),
    tools: TOOLS,
    final: { name: 'submit_reply', description: 'Речь жреца покровителю. Только её он увидит.', schema: replySchema },
    ctx: handlers,
    maxSteps: 8,
  });
  const acted = result.calls.some((c) => ACTIONS.has(c.name) && (c.result as ToolOutcome).ok);
  return { reply: result.final.text, acted, calls: result.calls, usage: result.usage };
}
