/**
 * Лормастер: отвечает на вопросы о фактах города и на ходу дописывает канон.
 * Факты он пишет прямо в город через операции ядра; сохраняет город поток.
 */

import type { City, Front, LoreFact } from '../../core/city.js';
import { activeAssignments } from '../../core/world/assignments.js';
import { activeFronts } from '../../core/world/fronts.js';
import { activeFacts, addFact, retireFact, updateFact, type LoreResult } from '../../core/lore.js';
import { gameDate } from '../../core/time.js';
import type { LlmUsage } from '../../ports/llm.js';
import { composeSystem, loadPrompt } from '../_shared/canon.js';
import { bullets, chronicleBlock } from '../_shared/format.js';
import { runToolLoop, type AgentDeps, type LoopTool } from '../_shared/runtime.js';
import {
  addFactSchema,
  answersSchema,
  readLoreSchema,
  retireFactSchema,
  updateFactSchema,
  type AddFactArgs,
  type Answers,
  type RetireFactArgs,
  type UpdateFactArgs,
} from './schema.js';

export interface LoremasterInput {
  city: City;
  day: number;
  questions: string[];
  /** Кто спрашивает: priest, herald и т.п. — для журнала. */
  asker: string;
  /** Идущая история, о которой спросили. Закрытая или чужая — без фокуса. */
  frontId: string | null;
  newFactId: () => string;
}

export interface LoremasterResult {
  answers: Answers;
  added: LoreFact[];
  focusFrontId: string | null;
  /** Ответы одним текстом для того, кто спрашивал. */
  text: string;
  usage: LlmUsage;
}

const prompt = loadPrompt(import.meta.url);

const UNKNOWNS_LOCK =
  ' canonicalUnknowns — установленный пробел мира: на эти вопросы «неизвестно» в submit_answers, без add_fact. ' +
  'Соседние бытовые детали не из списка устанавливай. Висящему пункту не противоречь.';

export function formatUnknowns(unknowns: ReadonlyArray<{ text: string }>): string {
  if (!unknowns.length) return 'Канонических неизвестностей нет.';
  return [
    'Канонические неизвестности (установленный пробел мира — не раскрывай и не ставь причину/источник/ответ):',
    ...unknowns.map((u) => `- ${u.text}`),
    'Соседние бытовые детали той же темы, которых нет в списке, устанавливай. Висящему пункту не противоречь.',
  ].join('\n');
}

export function formatOpenStories(fronts: Front[]): string {
  if (!fronts.length) return 'Открытых историй нет.';
  return [
    'Открытые истории (не решай их и не выдумывай развязку, виновника, скрытую причину):',
    ...fronts.map((f) => `- ${f.id} — ${f.description}`),
    'Канон истины и скрытые посылки здесь не приведены. Если вопрос про конкретную идущую историю — её должен передать спрашивающий как story_id.',
  ].join('\n');
}

function stakeText(front: Front): string | null {
  const s = front.stake;
  if (!s) return null;
  if ('reveal' in s) return s.reveal.text;
  if ('create' in s) return `появится: ${s.create.name}. ${s.create.description}`;
  if ('modify' in s) return `изменится ${s.modify.target}${s.modify.intent ? `: ${s.modify.intent}` : ''}`;
  if ('delete' in s) return `исчезнет ${s.delete.target}`;
  return null;
}

/** Идущая история под фокусом: что город уже выяснил и что знаешь только ты. */
export function formatFocusedStory(front: Front): string {
  const revealed = front.clues.filter((c) => c.status === 'revealed');
  const hidden = front.clues.filter((c) => c.status === 'hidden');
  const outcome = stakeText(front);
  const lines: Array<string | null> = [
    `ФОКУС: история ${front.id}. Это идущая история — не закрытая.`,
    `Как сейчас: ${front.description}`,
    'Можно дописать мелкие детали места, обычая, материала, имени фона — если они не заводят новое направление сюжета и не ломают повествование.',
    'Нельзя: назвать разгадку, подступ, виновника, мотив или причину; ставить исход; заводить новую интригу, конфликт или расследование.',
  ];
  if (revealed.length) {
    lines.push('ГОРОД ЭТО УЖЕ ВЫЯСНИЛ (можно отвечать прямо, это установлено):');
    for (const c of revealed) lines.push(`- ${c.fact}`);
  }
  if (hidden.length || front.alignment || outcome) {
    lines.push(
      'НЕРАСКРЫТО (знаешь ты, город нет). В ответ и в fact — только косвенное: куда смотреть, что уже странно, какой обычай или место рядом. Не называй механизм, виновника, улику и разгадку. Не перечисляй кандидатов и не отрицай их поимённо.',
    );
    if (outcome) lines.push(`- чем кончится: ${outcome}`);
    if (front.alignment) lines.push(`- что двигает историю: ${front.alignment.trim()}`);
    for (const c of hidden) lines.push(`- подступ: ${c.fact}`);
  } else if (!revealed.length) {
    lines.push('Скрытого слоя нет. Не выдумывай исход, виновника, скрытый мотив или причину нерешённого в этой истории.');
  }
  return lines.filter(Boolean).join('\n');
}

function factLines(facts: LoreFact[]): string {
  return facts.length ? bullets(facts.map((f) => `${f.id}: ${f.text}`)) : '(фактов пока нет)';
}

/** Сведения, которые лормастер открывает через read_lore. */
export function lorePayload(input: LoremasterInput, focus: Front | null): Record<string, unknown> {
  const { city, day } = input;
  const facts = activeFacts(city);
  const people = [
    `${city.priest.name} (${city.priest.gender === 'female' ? 'женщина' : 'мужчина'}), верховный жрец: ${city.priest.nature}`,
    ...city.officers.map((o) => `${o.name} (${o.gender === 'female' ? 'женщина' : 'мужчина'}), ${o.title}: ${o.nature}`),
  ];
  const payload: Record<string, unknown> = {
    ok: true,
    gameDate: gameDate(day).label,
    cityName: city.name,
    priest: city.priest.name,
    description: city.brief,
    chronicle: chronicleBlock(city.chronicle) || '(хроника пуста)',
    facts: factLines(facts),
    knownPeople: bullets(people),
    activeAssignments: activeAssignments(city).map((a) => a.text),
    openStories: formatOpenStories(activeFronts(city)),
    canonicalUnknowns: formatUnknowns(city.unknowns),
    reminder: focus
      ? 'Перед тобой хроника и факты. Если ответ из них выводится целиком — ничего не записывай, отвечай. ' +
        'Придумал новое: уточнение старого факта — update_fact, иначе add_fact. ' +
        'focusStory — идущая история, о которой спросили. Нераскрытый слой там дан тебе, городу он неизвестен. ' +
        'Из него в ответ и в fact — только косвенное: направление, странность, место рядом. Разгадку и подступы не называй. ' +
        'Новый факт по этой истории система сама привяжет.' +
        (city.unknowns.length ? UNKNOWNS_LOCK : '')
      : 'Перед тобой хроника и факты. Если ответ из них выводится целиком — ничего не записывай, отвечай. ' +
        'Придумал новое: уточнение старого факта — update_fact, иначе add_fact. ' +
        'Хронику только читаешь. Открытые истории — краткие карточки без скрытой разгадки. Не решай их. ' +
        'Сыгранную историю читай только по хронике. ' +
        'Закрытую историю не описывай как текущую беду. ' +
        '«Неизвестно» — только для пункта пробелов, скрытого открытой истории или если факт противоречил бы канону. ' +
        'Факт, противоречащий хронике или состоянию, — устарел: update_fact или retire_fact.' +
        (city.unknowns.length ? UNKNOWNS_LOCK : ''),
  };
  if (focus) {
    payload.focusStory = formatFocusedStory(focus);
    payload.storyChronicle = chronicleBlock(city.chronicle.filter((e) => e.frontId === focus.id)) || '(по этой истории в хронике пока пусто)';
    payload.storyFacts = factLines(facts.filter((f) => f.frontId === focus.id));
  }
  return payload;
}

const FAIL_TEXT: Record<Exclude<LoreResult, { ok: true }>['error'], string> = {
  not_a_fact:
    'Это не факт, а запись незнания. Незнание в факт не пишется. ' +
    'Если вопрос не из canonicalUnknowns и не скрытое живой истории — add_fact с конкретным утверждением. ' +
    '«Неизвестно» только в submit_answers и только для пункта списка или защищённого вопроса открытой истории.',
  too_short: 'Новая формулировка слишком короткая. Напиши сухой факт в 1–2 фразы.',
  fact_not_found: 'Факт с таким id не найден. Возьми id из facts в read_lore или создай новый через add_fact.',
};

interface Ctx {
  input: LoremasterInput;
  focus: Front | null;
  added: LoreFact[];
}

function report(result: LoreResult): unknown {
  return result.ok ? { ok: true, factId: result.fact.id } : { ok: false, error: result.error, agentMessage: FAIL_TEXT[result.error] };
}

const TOOLS: LoopTool<Ctx>[] = [
  {
    name: 'read_lore',
    description: 'Прочитать описание города, факты и хронику.',
    schema: readLoreSchema,
    run: (_args: never, ctx: Ctx) => lorePayload(ctx.input, ctx.focus),
  },
  {
    name: 'add_fact',
    description: 'Зафиксировать новый выведенный факт (не запись о случившемся).',
    schema: addFactSchema,
    run: (args: never, ctx: Ctx) => {
      const { text } = args as AddFactArgs;
      const result = addFact(ctx.input.city, {
        id: ctx.input.newFactId(),
        text,
        day: ctx.input.day,
        frontId: ctx.focus?.id ?? null,
        author: 'loremaster',
      });
      if (result.ok) ctx.added.push(result.fact);
      return report(result);
    },
  },
  {
    name: 'update_fact',
    description: 'Переписать устаревший факт (например, событие уже произошло или условие изменилось). fact_id — id из facts.',
    schema: updateFactSchema,
    run: (args: never, ctx: Ctx) => {
      const a = args as UpdateFactArgs;
      return report(updateFact(ctx.input.city, a.fact_id, a.text, a.reason ?? null));
    },
  },
  {
    name: 'retire_fact',
    description: 'Снять факт, который больше не верен (событие отменено, условие исчезло). Факт не удаляется, а помечается устаревшим.',
    schema: retireFactSchema,
    run: (args: never, ctx: Ctx) => {
      const a = args as RetireFactArgs;
      return report(retireFact(ctx.input.city, a.fact_id, a.reason ?? null));
    },
  },
];

export function loremasterUser(input: LoremasterInput, focus: Front | null): string {
  return [
    `Спрашивает: ${input.asker}`,
    `Город: ${input.city.name}`,
    '',
    'Вопросы:',
    input.questions.map((q, i) => `${i + 1}. ${q}`).join('\n') || '(нет вопросов)',
    '',
    focus
      ? `Фокус — идущая история ${focus.id}. Нераскрытый слой — в read_lore.focusStory: из него только косвенное, разгадку и подступы не называй и в fact не пиши. Детали фона можно дописать; новое направление сюжета — нельзя.`
      : 'Фокуса на идущей истории нет: канон тайн истории не дан. Сыгранное читай только по хронике. Не решай открытые истории.',
    'Канонические неизвестности — в read_lore.canonicalUnknowns. Их не раскрывай. Остальное, чего нет в списке, можно установить.',
    'Порядок: read_lore → если ответ целиком выводится из хроники и фактов, сразу submit_answers. ' +
      'Если придумал новое: уточнение старого факта — update_fact, иначе add_fact, затем submit_answers.',
    'Перед ответом сверь факты с хроникой, openStories и состоянием: устаревшие обнови или сними, не пересказывай их как правду.',
    'Факты как справочник, не проза. Пример: «Местный продукт — виноград; сладкий, тонкая кожица.»',
  ].join('\n');
}

export async function askLoremaster(deps: AgentDeps, input: LoremasterInput): Promise<LoremasterResult> {
  const focus = input.frontId ? (activeFronts(input.city).find((f) => f.id === input.frontId) ?? null) : null;
  const ctx: Ctx = { input, focus, added: [] };
  const result = await runToolLoop(deps, {
    agent: 'loremaster',
    system: composeSystem(['world'], prompt),
    messages: [{ role: 'user', content: loremasterUser(input, focus) }],
    tools: TOOLS,
    final: { name: 'submit_answers', description: 'Итоговые ответы на вопросы (после нужных add_fact).', schema: answersSchema },
    ctx,
    first: 'read_lore',
    maxSteps: 10,
  });
  const answers = result.final.answers;
  return {
    answers,
    added: ctx.added,
    focusFrontId: focus?.id ?? null,
    text: answers.map((a) => `В: ${a.question}\nО: ${a.answer}${a.invented ? ' (уточнено)' : ''}`).join('\n\n'),
    usage: result.usage,
  };
}
