/**
 * Плейтест из командной строки: игра одного города шаг за шагом, на настоящих моделях.
 * Часы мира всегда стоят, время двигается только командой skip. Каждый вызов агента
 * пишется в журнал (calls/), каждый шаг — в transcript.md. Есть читы для тестов.
 *
 *   npm run play -- <команда> [аргументы]
 *
 *   import <world.json> <city.json>   взять мир и город (например, из data/ dev-клиента)
 *   strip-stories                      убрать посаженные истории: их фронты, объекты, факты, хронику, задания
 *   say <текст>                        слово покровителя жрецу
 *   skip <дни>                         промотать игровые дни и разобрать события
 *   state | fronts | objects [id] | chronicle [n] | facts | calls [n]
 *   save <имя> | load <имя> | saves
 *   mana <n> | faith <n> | seed [id] | seed-on | no-seed | director
 *   roll <frontId> <light|heavy|plus> [dynamicId] [milestone|completion]   чит: осложнение прямо сейчас
 *
 *   PLAYTEST_DIR — папка плейтеста (по умолчанию ./playtest): data/, saves/, calls/, transcript.md
 */

import fs from 'node:fs';
import path from 'node:path';
import { MemoryNotifier } from '../../adapters/notifier/memory.js';
import type { CallSummary } from '../../adapters/llm/logging.js';
import type { City, World } from '../../core/city.js';
import { gameDate } from '../../core/time.js';
import { scheduleJob } from '../../core/jobs.js';
import { activeFronts, settleProgress } from '../../core/world/fronts.js';
import { mysteryShare, plusChance, roomForTrouble, unansweredTroubles } from '../../core/world/director.js';
import { rawToPoints } from '../../core/world/numbers.js';
import { requireWorld, today, type FlowDeps } from '../../flows/context.js';
import { processDue } from '../../flows/day.js';
import { record } from '../../flows/chronicle.js';
import { complicateRolled } from '../../flows/complications.js';
import { sendAll } from '../../flows/context.js';
import { patronMessage } from '../../flows/priest-turn.js';
import { exportGame, importGame, shiftClock, type GameSave } from '../../flows/save.js';
import { plantStory } from '../../flows/seeding.js';
import { pauseWorld, skipWorldDays } from '../../flows/world.js';
import { buildApp, loadDotEnv, ROOT } from '../app.js';
import { cityStatus } from '../views.js';

const OWNER = 'dev';

loadDotEnv();
const DIR = path.resolve(process.env.PLAYTEST_DIR ?? path.join(ROOT, 'playtest'));
const CALLS = path.join(DIR, 'calls');
const SAVES = path.join(DIR, 'saves');
const TRANSCRIPT = path.join(DIR, 'transcript.md');
process.env.DATA_DIR = path.join(DIR, 'data');
process.env.AGENT_LOG_DIR = CALLS;

const calls: CallSummary[] = [];

function out(text: string): void {
  console.log(text);
  fs.appendFileSync(TRANSCRIPT, text + '\n');
}

function callsLine(list: CallSummary[]): string {
  if (!list.length) return '';
  const tokensIn = list.reduce((s, c) => s + c.inputTokens, 0);
  const tokensOut = list.reduce((s, c) => s + c.outputTokens, 0);
  const failed = list.filter((c) => !c.ok);
  const agents = list.map((c) => `${c.agent}${c.ok ? '' : '✗'}`).join(', ');
  return `\n_вызовы ${list[0]!.n}–${list.at(-1)!.n} (${list.length}): ${agents}; токены ${tokensIn}→${tokensOut}${failed.length ? `; ошибки: ${failed.map((c) => `${c.n} ${c.error}`).join('; ')}` : ''}_`;
}

async function city(deps: FlowDeps): Promise<City> {
  const c = await deps.storage.getCityByOwner(OWNER);
  if (!c) throw new Error('города нет: сначала import');
  return c;
}

function frontLine(deps: FlowDeps, c: City, f: City['fronts'][number], day: number): string {
  const copy = structuredClone(f);
  settleProgress(copy, day);
  const lead = c.assignments.find((a) => a.frontId === f.id && a.status === 'active');
  const officer = lead ? c.officers.find((o) => o.office === lead.office)?.name : null;
  const bits = [
    `${f.id} [${f.origin}·${f.plus ? 'plus' : f.form}·${f.risk}${f.tempo ? `·темп ${f.tempo}` : ''}]`,
    `«${f.title}»`,
    `${copy.progress.toFixed(1)}/${f.capacity} (${Math.round((copy.progress / Math.max(1, f.capacity)) * 100)}%)`,
    `вехи ${f.milestonesFired}/${f.milestones}`,
    `${(f.ratePerDay * 30).toFixed(2)}/мес`,
    f.deadlineDay != null ? `срок д.${f.deadlineDay} (через ${f.deadlineDay - day})` : '',
    f.pulseDay != null ? `бросок д.${f.pulseDay}` : '',
    f.parentId ? `родитель ${f.parentId}` : '',
    f.bound ? `грозит ${f.bound}` : '',
    officer ? `ведёт ${officer}${lead?.verdict ? ` (${lead.verdict})` : ''}` : '',
    f.unattainable ? `НЕДОСТИЖИМО: ${f.unattainable}` : '',
  ];
  void deps;
  return bits.filter(Boolean).join(' · ');
}

function frontsText(deps: FlowDeps, c: City, day: number): string {
  const list = activeFronts(c);
  if (!list.length) return 'Фронтов нет.';
  return list.map((f) => frontLine(deps, c, f, day)).join('\n');
}

function statsLine(c: City): string {
  return `статы ${Object.entries(c.stats).map(([k, v]) => `${k} ${Math.round(v as number)}`).join(', ')}; вера ${Math.round(c.faith.value)}; мана ${c.mana.value.toFixed(1)}`;
}

async function newsAndChronicle(deps: FlowDeps, before: City | null, inbox: MemoryNotifier): Promise<void> {
  const after = await city(deps);
  for (const m of inbox.drain(OWNER)) out(`\n> **${m.kind === 'news' ? 'Весть' : m.kind}:** ${m.text.replace(/\n/g, '\n> ')}`);
  const known = new Set(before?.chronicle.map((e) => e.id) ?? []);
  const fresh = after.chronicle.filter((e) => !known.has(e.id));
  if (fresh.length) out(`\nХроника:\n${fresh.map((e) => `- д.${e.day} [${e.source}] ${e.text}`).join('\n')}`);
  if (before) {
    const was = new Map(before.objects.map((o) => [o.id, o]));
    const changes: string[] = [];
    for (const o of after.objects) {
      const prev = was.get(o.id);
      if (!prev) changes.push(`+ ${o.id} ${o.type} «${o.name}»${o.hidden ? ' (скрыт)' : ''}${o.temporary ? ' (временный)' : ''} ${JSON.stringify(rawToPoints(after, o.statEffect))}`);
      else if (prev.status !== o.status) changes.push(`${o.status === 'active' ? '+' : '−'} ${o.id} «${o.name}» ${prev.status}→${o.status}`);
      else if (prev.version !== o.version) changes.push(`~ ${o.id} «${o.name}» v${o.version} ${JSON.stringify(rawToPoints(after, o.statEffect))}`);
    }
    const wasF = new Map(before.fronts.map((f) => [f.id, f]));
    for (const f of after.fronts) {
      const prev = wasF.get(f.id);
      if (!prev) changes.push(`+ фронт ${f.id} [${f.origin}·${f.form}·${f.risk}] «${f.title}»`);
      else if (prev.status !== f.status) changes.push(`фронт ${f.id} «${f.title}» ${prev.status}→${f.status}`);
    }
    if (JSON.stringify(before.stats) !== JSON.stringify(after.stats)) changes.push(`статы ${JSON.stringify(before.stats)} → ${JSON.stringify(after.stats)}`);
    if (changes.length) out(`\nПеремены:\n${changes.join('\n')}`);
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(DIR, { recursive: true });
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) throw new Error('команда? см. шапку src/clients/playtest/main.ts');

  const inbox = new MemoryNotifier();
  const app = await buildApp(process.env, inbox);
  const { deps, locks } = app;
  // Журнал этого запуска: LoggingLlm пишет файлы, сводку читаем из calls.jsonl после команды.
  const jsonl = path.join(CALLS, 'calls.jsonl');
  const callsBefore = fs.existsSync(jsonl) ? fs.readFileSync(jsonl, 'utf8').split('\n').filter(Boolean).length : 0;
  await pauseWorld(deps);

  const world = await requireWorld(deps);
  const day = today(deps, world);
  const before = await deps.storage.getCityByOwner(OWNER);
  const head = `\n## ${new Date().toISOString().slice(0, 16)} · ${gameDate(day).label} (д.${day}) · \`${[cmd, ...args].join(' ')}\``;

  switch (cmd) {
    case 'import': {
      const [worldFile, cityFile] = args;
      if (!worldFile || !cityFile) throw new Error('import <world.json> <city.json>');
      const w = JSON.parse(fs.readFileSync(worldFile, 'utf8')) as World;
      const c = JSON.parse(fs.readFileSync(cityFile, 'utf8')) as City;
      // День берётся таким, каким он был у игрока в момент, когда файл города записан; часы встают на паузу.
      const fileTime = fs.statSync(cityFile).mtimeMs;
      const now = deps.clock.now();
      const clock = shiftClock(w.clock, now - fileTime);
      const save: GameSave = { version: 1, savedAtMs: now, day: 0, world: { ...w, clock: { ...clock, heldAtMs: clock.heldAtMs ?? now } }, city: c, draft: null };
      await importGame(deps, OWNER, save);
      const w2 = await requireWorld(deps);
      out(`${head}\nИмпортирован город «${c.name}», день ${today(deps, w2)}.`);
      break;
    }
    case 'strip-stories': {
      const c = await city(deps);
      const story = new Set(c.fronts.filter((f) => f.origin === 'story').map((f) => f.id));
      const storyObjects = new Set(c.objects.filter((o) => o.createdDay > c.createdDay).map((o) => o.id));
      c.fronts = c.fronts.filter((f) => !story.has(f.id));
      c.objects = c.objects.filter((o) => !storyObjects.has(o.id));
      for (const o of c.objects) o.refs = o.refs.filter((r) => !storyObjects.has(r));
      c.facts = c.facts.filter((f) => !(f.frontId && story.has(f.frontId)) && f.day <= c.createdDay);
      c.chronicle = c.chronicle.filter((e) => e.source !== 'scenario');
      c.dialog = c.dialog.filter((d) => d.day <= c.createdDay);
      c.jobs = c.jobs.filter((j) => j.kind !== 'front_event' && j.state !== 'done');
      c.scenariosUsed = [];
      await deps.storage.saveCity(c);
      out(`${head}\nУбрано: ${story.size} фронтов историй, ${storyObjects.size} объектов. Задания: ${JSON.stringify(c.jobs.map((j) => [j.kind, j.dueDay]))}`);
      break;
    }
    case 'seed-on': {
      const c = await city(deps);
      c.jobs = c.jobs.filter((j) => j.kind !== 'seed');
      scheduleJob(c, { id: `job_seed_${day}`, kind: 'seed', dueDay: day });
      await deps.storage.saveCity(c);
      out(`${head}\nПосев включён: режиссёр проверяет город каждые ${deps.rules.seeding.checkEveryDays} дней.`);
      break;
    }
    case 'no-seed': {
      const c = await city(deps);
      c.jobs = c.jobs.filter((j) => j.kind !== 'seed');
      await deps.storage.saveCity(c);
      out(`${head}\nПосев выключен (задание seed снято).`);
      break;
    }
    case 'seed': {
      const c = await city(deps);
      // seed <id>: посадить именно эту заготовку.
      const pickDeps = args[0] ? { ...deps, scenarios: deps.scenarios.filter((s) => s.id === args[0]) } : deps;
      if (args[0] && !pickDeps.scenarios.length) throw new Error(`нет заготовки ${args[0]}`);
      const msg = await plantStory(pickDeps, c, day);
      await deps.storage.saveCity(c);
      if (msg) await deps.notifier.send(msg);
      out(`${head}\n${msg ? 'Посажена история.' : 'История не посадилась.'}`);
      await newsAndChronicle(deps, before, inbox);
      break;
    }
    case 'say': {
      const text = args.join(' ');
      out(`${head}\n\n**Покровитель:** ${text}`);
      const r = await patronMessage(deps, locks, { ownerId: OWNER, text });
      out(`\n**Жрец** (${r.kind}${r.kind === 'reply' ? `, дело: ${r.acted ? 'да' : 'нет'}, мана ${r.manaLeft}` : ''}): ${'text' in r ? r.text : ''}`);
      await newsAndChronicle(deps, before, inbox);
      break;
    }
    case 'skip': {
      const days = Number(args[0] ?? 1);
      out(`${head}`);
      await skipWorldDays(deps, days);
      const w = await requireWorld(deps);
      const c = await city(deps);
      const news = await locks.run(c.id, async () => {
        const fresh = (await deps.storage.getCity(c.id))!;
        const msgs = await processDue(deps, w, fresh);
        await deps.storage.saveCity(fresh);
        return msgs;
      });
      for (const m of news) await deps.notifier.send(m);
      out(`Теперь ${gameDate(today(deps, w)).label} (д.${today(deps, w)}).`);
      await newsAndChronicle(deps, before, inbox);
      break;
    }
    case 'state': {
      const c = await city(deps);
      out(`${head}\n${cityStatus(deps.rules, c, day)}\n\n${statsLine(c)}\n\nФронты:\n${frontsText(deps, c, day)}\n\nПроекты: ${JSON.stringify(c.projects, null, 1)}\nЗадания: ${JSON.stringify(c.jobs.filter((j) => j.state === 'pending').map((j) => [j.kind, j.dueDay, j.payload]))}`);
      break;
    }
    case 'fronts': {
      const c = await city(deps);
      const id = args[0];
      if (id) {
        const f = c.fronts.find((x) => x.id === id);
        console.log(JSON.stringify(f, null, 2));
      } else out(`${head}\n${frontsText(deps, c, day)}`);
      break;
    }
    case 'objects': {
      const c = await city(deps);
      const id = args[0];
      if (id) console.log(JSON.stringify(c.objects.find((o) => o.id === id), null, 2));
      else
        console.log(
          c.objects
            .filter((o) => o.status === 'active')
            .map((o) => `${o.id} ${o.type} «${o.name}» ${JSON.stringify(rawToPoints(c, o.statEffect))}${o.hidden ? ' скрыт' : ''}${o.occupiedBy ? ` занят ${o.occupiedBy}` : ''}${o.temporary ? ' временный' : ''}${o.attach ? ` attach ${JSON.stringify(o.attach)}` : ''}`)
            .join('\n'),
        );
      break;
    }
    case 'chronicle': {
      const c = await city(deps);
      console.log(c.chronicle.slice(-Number(args[0] ?? 20)).map((e) => `д.${e.day} [${e.source}] ${e.text}`).join('\n\n'));
      break;
    }
    case 'facts': {
      const c = await city(deps);
      console.log(c.facts.filter((f) => f.status === 'active').map((f) => `д.${f.day} ${f.author}: ${f.text}`).join('\n'));
      break;
    }
    case 'dialog': {
      const c = await city(deps);
      console.log(c.dialog.slice(-Number(args[0] ?? 10)).map((d) => `д.${d.day} ${d.role}/${d.kind}: ${d.text}`).join('\n\n'));
      break;
    }
    case 'roll': {
      const [frontId, kind, dynamicId, moment] = args;
      if (!frontId || !kind) throw new Error('roll <frontId> <light|heavy|plus> [dynamicId] [milestone|completion]');
      if (dynamicId && dynamicId !== '-') {
        for (const d of deps.rules.fronts.dynamics) d.enabled = d.id === dynamicId;
        if (!deps.rules.fronts.dynamics.some((d) => d.enabled)) throw new Error(`нет записи ${dynamicId}`);
      }
      const c = await city(deps);
      const parent = c.fronts.find((f) => f.id === frontId);
      if (!parent) throw new Error('нет фронта');
      out(head);
      const made = await complicateRolled(deps, c, parent, kind as 'light' | 'heavy' | 'plus', { moment: (moment as 'milestone' | 'completion') ?? 'milestone' }, day);
      if (!made) out('Осложнение не собралось.');
      else {
        const msg = await record(deps, c, { gist: made.gist, changes: made.changes, source: 'complication', frontId: parent.id, day, kind: 'beat', officer: null, announce: true });
        await deps.storage.saveCity(c);
        await sendAll(deps, msg ? [msg] : []);
      }
      await newsAndChronicle(deps, before, inbox);
      break;
    }
    case 'director': {
      const c = await city(deps);
      const log = (c.storyLog ?? []).map((m) => `д${m.day}: ${m.engine ?? '?'} / ${m.source ?? '?'} / ${m.sphere ?? '?'}${m.mystery ? ' / тайна' : ''}`);
      out(`${head}\nБед без ответа: ${unansweredTroubles(c)}; место для беды ${roomForTrouble(deps.rules, c).toFixed(2)}; доля плюсов ${plusChance(deps.rules, c).toFixed(2)}; доля тайн ${mysteryShare(deps.rules, c, day).toFixed(2)}\n${log.join('\n') || 'журнал пуст'}`);
      break;
    }
    case 'mana': {
      const c = await city(deps);
      c.mana = { value: Number(args[0] ?? 100), day };
      await deps.storage.saveCity(c);
      out(`${head}\nМана ${c.mana.value}.`);
      break;
    }
    case 'faith': {
      const c = await city(deps);
      c.faith = { value: Number(args[0] ?? 50), day };
      await deps.storage.saveCity(c);
      out(`${head}\nВера ${c.faith.value}.`);
      break;
    }
    case 'save': {
      const name = args[0];
      if (!name) throw new Error('save <имя>');
      fs.mkdirSync(SAVES, { recursive: true });
      fs.writeFileSync(path.join(SAVES, `${name}.json`), JSON.stringify(await exportGame(deps, OWNER), null, 2));
      out(`${head}\nСохранено: ${name}`);
      break;
    }
    case 'load': {
      const name = args[0];
      if (!name) throw new Error('load <имя>');
      await importGame(deps, OWNER, JSON.parse(fs.readFileSync(path.join(SAVES, `${name}.json`), 'utf8')) as GameSave);
      await pauseWorld(deps);
      out(`${head}\nЗагружено: ${name}`);
      break;
    }
    case 'saves':
      console.log(fs.existsSync(SAVES) ? fs.readdirSync(SAVES).join('\n') : '');
      break;
    case 'calls': {
      const lines = fs.existsSync(jsonl) ? fs.readFileSync(jsonl, 'utf8').split('\n').filter(Boolean) : [];
      console.log(lines.slice(-Number(args[0] ?? 20)).map((l) => {
        const c = JSON.parse(l) as CallSummary;
        return `${c.n} ${c.agent} ${c.ms}мс ${c.inputTokens}→${c.outputTokens}${c.ok ? '' : ` ✗ ${c.error}`}`;
      }).join('\n'));
      break;
    }
    default:
      throw new Error(`нет команды ${cmd}`);
  }

  const lines = fs.existsSync(jsonl) ? fs.readFileSync(jsonl, 'utf8').split('\n').filter(Boolean) : [];
  calls.push(...lines.slice(callsBefore).map((l) => JSON.parse(l) as CallSummary));
  const line = callsLine(calls);
  if (line) out(line);
  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
