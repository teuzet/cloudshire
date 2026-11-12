/**
 * Отчёты прогона: общий report.md (что вышло в игре, сводка по агентам,
 * предупреждения) и по файлу на агента с полными промптами и ответами.
 */

import type { City, Front, StakeOp } from '../../core/city.js';
import type { LlmMessage, LlmResponse } from '../../ports/llm.js';
import type { CallRecord } from './llm.js';
import type { StageName, StageResult, TranscriptLine } from './stages.js';

export interface RunMeta {
  id: string;
  stage: StageName;
  case: string;
  title: string;
  note: string | null;
  label: string | null;
  state: string | null;
  replayOf: string | null;
  forceLive: string[];
  startedAt: string;
  gitSha: string | null;
  seed: number;
  /** Модель и хеш системного промпта (первого вызова) по каждому агенту. */
  agents: Record<string, { model: string; promptHash: string }>;
  totals: { calls: number; live: number; cassette: number; inputTokens: number; outputTokens: number; ms: number };
  outcome: string;
  error: string | null;
}

export interface Warning {
  event: string;
  data: Record<string, unknown>;
}

export interface AgentStats {
  agent: string;
  model: string;
  calls: number;
  /** Вызовы, где попытка/шаг больше первого: повторы после ошибки или шаги цикла тулов. */
  extraSteps: number;
  errors: number;
  fallbacks: number;
  live: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
}

const FENCE = '~~~~';

function block(text: string, lang = ''): string {
  return `${FENCE}${lang}\n${text.trimEnd()}\n${FENCE}`;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)} с`;
}

export function agentStats(calls: CallRecord[], warnings: Warning[]): AgentStats[] {
  const byAgent = new Map<string, AgentStats>();
  for (const c of calls) {
    const s = byAgent.get(c.agent) ?? {
      agent: c.agent,
      model: c.request.model,
      calls: 0,
      extraSteps: 0,
      errors: 0,
      fallbacks: 0,
      live: 0,
      inputTokens: 0,
      outputTokens: 0,
      ms: 0,
    };
    s.calls++;
    if (c.attempt > 1) s.extraSteps++;
    if (c.error) s.errors++;
    if (c.source === 'live') s.live++;
    s.inputTokens += c.response?.usage.inputTokens ?? 0;
    s.outputTokens += c.response?.usage.outputTokens ?? 0;
    s.ms += c.ms;
    byAgent.set(c.agent, s);
  }
  for (const w of warnings) {
    const what = typeof w.data.what === 'string' ? w.data.what : w.event.replace(/_failed$/, '');
    const s = byAgent.get(what);
    if (s) s.fallbacks++;
  }
  return [...byAgent.values()];
}

// ───────────────────────────── что вышло в игре ─────────────────────────────

function stakeLine(ops: StakeOp[]): string {
  if (!ops.length) return 'нет';
  return ops
    .map((op) => {
      switch (op.op) {
        case 'create':
          return `создать ${op.object.type} «${op.object.name}» ${json(op.object.points).replace(/\s+/g, ' ')}`;
        case 'revalue':
          return `переоценить ${op.target} ${json(op.points).replace(/\s+/g, ' ')}`;
        case 'modify':
          return `изменить ${op.target}${op.intent ? `: ${op.intent}` : ''}`;
        case 'delete':
          return `убрать ${op.target}`;
        case 'reveal':
          return `раскрыть ${op.target}`;
        case 'fact':
          return `факт: ${op.text}`;
        case 'link':
          return `связать ${op.a} и ${op.b}`;
        case 'progress':
          return `прогресс ${op.amount} фронту ${op.frontId}`;
        case 'rollback':
          return `откат на веху ${op.frontId}`;
        case 'cancel':
          return `отмена ${op.frontId}`;
        case 'attach':
          return `${op.rate < 0 ? 'помеха' : 'помощник'} «${op.object.name}» на ${op.frontId}`;
        case 'stats':
          return `статы ${json(op.points).replace(/\s+/g, ' ')}`;
      }
    })
    .join('; ');
}

function frontBlock(f: Front): string {
  const lines = [
    `- **${f.title}** (${f.form}, ${f.origin}, ${f.id}): ${f.description}`,
    `  - ёмкость ${f.capacity}, вех ${f.milestones}, риск ${f.risk}, темп проекта ${f.tempo}, скорость ${f.ratePerDay.toFixed(3)}/день${f.deadlineDay != null ? `, срок на день ${f.deadlineDay}` : ''}`,
    `  - ставка: ${stakeLine(f.stake)}`,
  ];
  if (f.failStake.length) lines.push(`  - по сроку: ${stakeLine(f.failStake)}`);
  if (f.unattainable) lines.push(`  - недостижимо: ${f.unattainable}`);
  if (f.key) lines.push(`  - ключ: ${f.key.moves.join('; ')}${f.key.twist ? ` | подвох: ${f.key.twist}` : ''}`);
  if (f.footprint.length) lines.push(`  - отпечаток: ${f.footprint.map((e) => `${e.objectId} ${e.relation}`).join(', ')}`);
  if (f.script?.events.length) lines.push(`  - события: ${f.script.events.map((e) => e.description).join('; ')}`);
  if (f.script?.clues.length) lines.push(`  - улики: ${f.script.clues.map((c) => c.fact).join('; ')}`);
  if (f.refs.length) lines.push(`  - участники: ${f.refs.join(', ')}`);
  return lines.join('\n');
}

function genesisSummary(city: City): string {
  return [
    `**${city.name}** — покровитель ${city.patronName}. Жрец ${city.priest.name}: ${city.priest.nature}`,
    '',
    `Сановники:\n${city.officers.map((o) => `- ${o.title} ${o.name} (${o.gender}): ${o.nature}`).join('\n')}`,
    '',
    `Статы: ${json(city.stats).replace(/\s+/g, ' ')}`,
    '',
    `Объекты (${city.objects.length}):\n${city.objects.map((o) => `- ${o.name} (${o.type}, ${o.id}): ${o.description}`).join('\n')}`,
    '',
    `Стартовые факты:\n${city.facts.map((f) => `- ${f.text}`).join('\n')}`,
    '',
    `Канонические неизвестности:\n${city.unknowns.length ? city.unknowns.map((u) => `- ${u.text} → ${u.objectIds.join(', ')}`).join('\n') : '- нет'}`,
    '',
    `Бриф (${city.brief.length} знаков):`,
    block(city.brief),
    '',
    `Описание (${city.description.length} знаков):`,
    block(city.description),
  ].join('\n');
}

function newFronts(before: City | null, after: City): Front[] {
  const had = new Set(before?.fronts.map((f) => f.id) ?? []);
  return after.fronts.filter((f) => !had.has(f.id));
}

function willSummary(before: City | null, after: City): string {
  const had = new Set(before?.assignments.map((a) => a.id) ?? []);
  const assignments = after.assignments.filter((a) => !had.has(a.id));
  const fronts = newFronts(before, after);
  const notes = after.notes.slice(before?.notes.length ?? 0);
  const facts = after.facts.filter((f) => !before?.facts.some((x) => x.id === f.id));
  return [
    `Мана: ${before?.mana.value.toFixed(1) ?? '?'} → ${after.mana.value.toFixed(1)}`,
    '',
    `Новые поручения:\n${assignments.length ? assignments.map((a) => `- ${a.office} → ${a.frontId}: «${a.text || 'без наказа'}» (${a.verdict}, темп ${a.tempo})`).join('\n') : '- нет'}`,
    '',
    `Новые фронты:\n${fronts.length ? fronts.map(frontBlock).join('\n') : '- нет'}`,
    '',
    `Новые факты лора:\n${facts.length ? facts.map((f) => `- ${f.text}`).join('\n') : '- нет'}`,
    '',
    `Заметки жреца:\n${notes.length ? notes.map((n) => `- ${n.text}`).join('\n') : '- нет'}`,
  ].join('\n');
}

function seedingSummary(before: City | null, after: City): string {
  const fronts = newFronts(before, after);
  const objects = after.objects.filter((o) => !before?.objects.some((x) => x.id === o.id));
  const chronicle = after.chronicle.slice(before?.chronicle.length ?? 0);
  return [
    `Посаженные истории:\n${fronts.length ? fronts.map(frontBlock).join('\n') : '- нет'}`,
    '',
    `Новые объекты:\n${objects.length ? objects.map((o) => `- ${o.name} (${o.type}, ${o.id}): ${o.description}`).join('\n') : '- нет'}`,
    '',
    `Хроника:\n${chronicle.length ? chronicle.map((e) => `- ${e.text}`).join('\n') : '- нет'}`,
  ].join('\n');
}

function gameSummary(stage: StageName, result: StageResult): string {
  const after = result.after.cities[0] ?? null;
  if (!after) return 'Города нет.';
  const before = result.before?.cities[0] ?? null;
  if (stage === 'genesis') return genesisSummary(after);
  if (stage === 'will') return willSummary(before, after);
  return seedingSummary(before, after);
}

function transcriptBlock(lines: TranscriptLine[]): string {
  if (!lines.length) return '_пусто_';
  const who: Record<TranscriptLine['who'], string> = { patron: 'Игрок', guide: 'Проводник', priest: 'Жрец', news: 'Весть', system: 'Служебное' };
  return lines.map((l) => `**${who[l.who]}:** ${l.text.replace(/\n/g, '  \n')}`).join('\n\n');
}

export function mainReport(meta: RunMeta, result: StageResult | null, stats: AgentStats[], warnings: Warning[]): string {
  const t = meta.totals;
  const rows = stats.map(
    (s) =>
      `| [${s.agent}](agents/${s.agent}.md) | ${s.model} | ${s.calls} | ${s.extraSteps} | ${s.errors} | ${s.fallbacks} | ${s.live} | ${s.inputTokens} / ${s.outputTokens} | ${secs(s.ms)} |`,
  );
  return [
    `# ${meta.stage} / ${meta.case}${meta.label ? ` [${meta.label}]` : ''}`,
    '',
    `${meta.title}${meta.note ? `\n\n${meta.note}` : ''}`,
    '',
    `- прогон: \`${meta.id}\`, ${meta.startedAt}, git ${meta.gitSha ?? '?'}, seed ${meta.seed}`,
    `- снимок: ${meta.state ?? '—'}; кассета: ${meta.replayOf ?? '—'}; вживую всегда: ${meta.forceLive.join(', ') || '—'}`,
    `- вызовов ${t.calls} (вживую ${t.live}, с кассеты ${t.cassette}), токены ${t.inputTokens} / ${t.outputTokens}, время моделей ${secs(t.ms)}`,
    '',
    `**Итог:** ${meta.error ? `прогон упал: ${meta.error}` : meta.outcome}`,
    '',
    '## Агенты',
    '',
    'Повторы — вызовы после первой попытки (ошибка формы или смысла) или следующие шаги цикла тулов у жреца и лормастера. Запасной путь — агент сломался, поток пошёл дальше без него.',
    '',
    '| Агент | Модель | Вызовов | Повторов | Ошибок | Запасной путь | Вживую | Токены in / out | Время |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    '## Предупреждения потока',
    '',
    warnings.length ? warnings.map((w) => `- \`${w.event}\` ${json(w.data).replace(/\s+/g, ' ')}`).join('\n') : '- нет',
    '',
    '## Разговор',
    '',
    result ? transcriptBlock(result.transcript) : '_прогон упал до разговора_',
    '',
    '## Что вышло в игре',
    '',
    result ? gameSummary(meta.stage, result) : '_нет_',
    '',
  ].join('\n');
}

// ───────────────────────────── по агенту ─────────────────────────────

function messageBlock(m: LlmMessage): string {
  if (m.role === 'user') return `**user**\n\n${block(m.content)}`;
  if (m.role === 'tool') return `**tool result** (${m.toolCallId})\n\n${block(m.content)}`;
  const calls = (m.toolCalls ?? []).map((c) => `вызов \`${c.name}\` (${c.id}):\n\n${block(prettyArgs(c.arguments), 'json')}`).join('\n\n');
  return `**assistant**${m.content ? `\n\n${block(m.content)}` : ''}${calls ? `\n\n${calls}` : ''}`;
}

function prettyArgs(args: string): string {
  try {
    return json(JSON.parse(args));
  } catch {
    return args;
  }
}

function responseBlock(r: LlmResponse): string {
  const parts = [`stop: ${r.stop}, модель ${r.model}, токены ${r.usage.inputTokens} / ${r.usage.outputTokens} (кэш ${r.usage.cachedInputTokens})`];
  if (r.text) parts.push(block(r.text));
  for (const c of r.toolCalls) parts.push(`вызов \`${c.name}\`:\n\n${block(prettyArgs(c.arguments), 'json')}`);
  return parts.join('\n\n');
}

export function agentReport(agent: string, calls: CallRecord[], stats: AgentStats | undefined, meta: RunMeta): string {
  const out = [
    `# ${agent} — ${meta.stage} / ${meta.case}`,
    '',
    `[← к прогону](../report.md)`,
    '',
    stats
      ? `Модель ${stats.model}. Вызовов ${stats.calls}, повторов ${stats.extraSteps}, ошибок ${stats.errors}, запасной путь ${stats.fallbacks}. Токены ${stats.inputTokens} / ${stats.outputTokens}, ${secs(stats.ms)}.`
      : '',
    '',
  ];
  let prevSystem: string | null = null;
  let prevCount = 0;
  calls.forEach((c, i) => {
    out.push(`## Вызов ${i + 1} (шаг ${c.attempt}, ${c.source === 'live' ? 'вживую' : 'с кассеты'}, ${secs(c.ms)}, ключ ${c.key})`, '');
    if (c.request.system === prevSystem) out.push('**system:** тот же, что выше.', '');
    else out.push('**system**', '', block(c.request.system), '');
    prevSystem = c.request.system;
    // На повторе сообщения растут: показываем только новые.
    const continues = c.attempt > 1 && c.request.messages.length > prevCount;
    const fresh = continues ? c.request.messages.slice(prevCount) : c.request.messages;
    if (continues) out.push(`_первые ${prevCount} сообщений — как в прошлом вызове_`, '');
    for (const m of fresh) out.push(messageBlock(m), '');
    prevCount = c.request.messages.length + 1;
    out.push('**Ответ модели**', '', c.response ? responseBlock(c.response) : `ошибка: ${c.error ?? '?'}`, '');
  });
  return out.join('\n');
}
