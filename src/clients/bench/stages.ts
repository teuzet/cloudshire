/**
 * Этапы стенда. Каждый этап — настоящий игровой поток на памяти, ручных часах
 * и сид-рандоме; меняется только модель. Вход этапа — кейс (YAML) и, кроме
 * генезиса, снимок состояния, из которого поток сам собирает вход каждого агента.
 *
 *   genesis — онбординг + генезис: из разговора (или готовой «рыбы») — город;
 *   will    — воля игрока: реплики покровителю → поручения, стройки, фронты со ставками;
 *   seeding — посев сюжетов из базы (scenarios/) или по зерну на город.
 */

import { z } from 'zod';
import { ManualClock } from '../../adapters/clock/manual.js';
import { MemoryNotifier } from '../../adapters/notifier/memory.js';
import { seededRandom } from '../../adapters/random/seeded.js';
import { MemoryStorage } from '../../adapters/storage/memory.js';
import type { AgentDeps } from '../../agents/_shared/runtime.js';
import type { City, World } from '../../core/city.js';
import type { Rules } from '../../core/rules.js';
import { msPerGameDay } from '../../core/time.js';
import type { Scenario } from '../../core/world/scenario.js';
import { CityLocks } from '../../flows/city-lock.js';
import { requireWorld, sendAll, today, type FlowDeps } from '../../flows/context.js';
import { onboardingMessage, runGenesis } from '../../flows/onboarding.js';
import { patronMessage } from '../../flows/priest-turn.js';
import { plantStory } from '../../flows/seeding.js';
import { ensureWorld, type NamesFile } from '../../flows/world.js';
import type { OutboundMessage } from '../../ports/notifier.js';
import type { OnboardingDraft } from '../../ports/storage.js';

export const STAGES = ['genesis', 'will', 'seeding'] as const;
export type StageName = (typeof STAGES)[number];

/** Какие агенты участвуют в этапе — для отчёта и подсказок. Фактический список берётся из вызовов. */
export const STAGE_AGENTS: Record<StageName, string[]> = {
  genesis: ['onboarding-guide', 'city-genesis', 'world-objects-genesis', 'officer-nature', 'city-brief'],
  will: [
    'priest',
    'loremaster',
    'will-interpreter',
    'canon-warden',
    'stage-planner',
    'contribution-appraiser',
    'footprint-mapper',
    'risk-appraiser',
    'key-sealer',
    'alignment-judge',
    'chronicler',
  ],
  seeding: ['scenario-writer', 'chronicler', 'herald'],
};

export const OWNER = 'bench';

// ───────────────────────────── снимок состояния ─────────────────────────────

export interface Snapshot {
  version: 1;
  /** Момент «сейчас» снимка: от него стенд ставит ручные часы. */
  now: number;
  world: World;
  cities: City[];
  drafts: OnboardingDraft[];
  origin: { run: string | null; stage: StageName | null; case: string | null; note?: string };
}

// ───────────────────────────── кейсы ─────────────────────────────

const seasonSchema = z.object({ name: z.string().min(1), rules: z.array(z.string()).default([]) });

export const genesisCaseSchema = z
  .object({
    title: z.string().min(1),
    note: z.string().optional(),
    seed: z.number().int().optional(),
    season: seasonSchema.optional(),
    /** Реплики игрока проводнику по очереди, пока тот не даст «рыбу». */
    dialog: z.array(z.string().min(1)).optional(),
    /** Или сразу «рыба», без проводника. */
    city: z
      .object({
        city_name: z.string().nullable().default(null),
        patron_name: z.string().min(1),
        patron_gender: z.enum(['female', 'male']),
        pitch: z.string().min(1),
      })
      .optional(),
  })
  .refine((c) => Boolean(c.dialog?.length) !== Boolean(c.city), { message: 'нужно ровно одно: dialog или city' });

export const willCaseSchema = z.object({
  title: z.string().min(1),
  note: z.string().optional(),
  seed: z.number().int().optional(),
  /** Имя снимка из bench/states/. */
  state: z.string().min(1),
  messages: z
    .array(
      z.union([
        z.string().min(1),
        z.object({ text: z.string().min(1), quote: z.string().optional(), skipDays: z.number().min(0).default(0) }),
      ]),
    )
    .min(1),
});

export const seedingCaseSchema = z.object({
  title: z.string().min(1),
  note: z.string().optional(),
  seed: z.number().int().optional(),
  state: z.string().min(1),
  /** Что сажать по очереди: id заготовки из scenarios/ или null — история по зерну. */
  plant: z.array(z.string().nullable()).min(1),
});

export type GenesisCase = z.infer<typeof genesisCaseSchema>;
export type WillCase = z.infer<typeof willCaseSchema>;
export type SeedingCase = z.infer<typeof seedingCaseSchema>;

export function parseCase(stage: StageName, raw: unknown): GenesisCase | WillCase | SeedingCase {
  const schema = stage === 'genesis' ? genesisCaseSchema : stage === 'will' ? willCaseSchema : seedingCaseSchema;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`кейс ${stage}: ${issue?.path.join('.') || '(корень)'}: ${issue?.message ?? 'неверно'}`);
  }
  return parsed.data;
}

/** Снимок, на котором стоит кейс (у генезиса его нет). */
export function caseState(c: GenesisCase | WillCase | SeedingCase): string | null {
  return 'state' in c ? c.state : null;
}

// ───────────────────────────── прогон ─────────────────────────────

export interface StageEnv {
  rules: Rules;
  agents: AgentDeps;
  scenarios: readonly Scenario[];
  names: NamesFile;
  warn: (event: string, data: Record<string, unknown>) => void;
}

/** Строка стенограммы: что сказал игрок и что ему ответили. */
export interface TranscriptLine {
  who: 'patron' | 'guide' | 'priest' | 'news' | 'system';
  text: string;
}

export interface StageResult {
  transcript: TranscriptLine[];
  /** Чем кончился этап одной фразой. */
  outcome: string;
  before: Snapshot | null;
  after: Snapshot;
}

const DEFAULT_NOW = Date.UTC(2026, 10, 1);

async function stand(env: StageEnv, now: number, seed: number) {
  const clock = new ManualClock(now);
  const inbox = new MemoryNotifier();
  const storage = new MemoryStorage();
  const deps: FlowDeps = {
    rules: env.rules,
    agents: env.agents,
    storage,
    clock,
    random: seededRandom(seed),
    notifier: inbox,
    scenarios: env.scenarios,
    log: { warn: env.warn },
  };
  return { deps, clock, inbox, storage, locks: new CityLocks() };
}

async function load(storage: MemoryStorage, snap: Snapshot): Promise<void> {
  await storage.saveWorld(structuredClone(snap.world));
  for (const city of snap.cities) await storage.saveCity(structuredClone(city));
  for (const draft of snap.drafts) await storage.saveDraft(structuredClone(draft));
}

async function snapshot(deps: FlowDeps, storage: MemoryStorage, now: number, origin: Snapshot['origin']): Promise<Snapshot> {
  const city = await storage.getCityByOwner(OWNER);
  const draft = await storage.getDraft(OWNER);
  return {
    version: 1,
    now,
    world: await requireWorld(deps),
    cities: city ? [city] : [],
    drafts: draft ? [draft] : [],
    origin,
  };
}

function newsLines(inbox: MemoryNotifier): TranscriptLine[] {
  return inbox.drain(OWNER).map((m: OutboundMessage) => ({ who: m.kind === 'news' ? 'news' : 'system', text: m.text }));
}

export async function runGenesisStage(env: StageEnv, c: GenesisCase, seed: number): Promise<StageResult> {
  const s = await stand(env, DEFAULT_NOW, seed);
  await ensureWorld(s.deps, { names: env.names, ...(c.season ? { season: c.season } : {}) });
  const transcript: TranscriptLine[] = [];
  let ready = false;

  if (c.city) {
    await s.storage.saveDraft({
      ownerId: OWNER,
      messages: [],
      seed: { cityName: c.city.city_name, patronName: c.city.patron_name, patronGender: c.city.patron_gender, pitch: c.city.pitch },
      status: 'generating',
      revision: 0,
    });
    ready = true;
  } else {
    for (const line of c.dialog ?? []) {
      transcript.push({ who: 'patron', text: line });
      const r = await onboardingMessage(s.deps, { ownerId: OWNER, text: line });
      if (r.kind !== 'reply') break;
      transcript.push({ who: 'guide', text: r.text });
      if (r.ready) {
        ready = true;
        break;
      }
    }
  }

  let outcome: string;
  if (!ready) {
    outcome = 'Проводник так и не собрал «рыбу»: реплики кончились раньше. Генезис не запускался.';
  } else {
    const city = await runGenesis(s.deps, OWNER);
    transcript.push(...newsLines(s.inbox));
    outcome = city ? `Город «${city.name}» поднялся.` : 'Генезис сорвался: см. предупреждения.';
  }
  return { transcript, outcome, before: null, after: await snapshot(s.deps, s.storage, s.clock.now(), { run: null, stage: 'genesis', case: null }) };
}

export async function runWillStage(env: StageEnv, c: WillCase, seed: number, state: Snapshot): Promise<StageResult> {
  const s = await stand(env, state.now, seed);
  await load(s.storage, state);
  if (!(await s.storage.getCityByOwner(OWNER))) throw new Error(`в снимке ${c.state} нет города игрока`);
  const transcript: TranscriptLine[] = [];

  for (const m of c.messages) {
    const msg = typeof m === 'string' ? { text: m, quote: undefined, skipDays: 0 } : m;
    if (msg.skipDays) s.clock.advance(Math.round(msg.skipDays * msPerGameDay(env.rules)));
    transcript.push({ who: 'patron', text: msg.text });
    const r = await patronMessage(s.deps, s.locks, { ownerId: OWNER, text: msg.text, quote: msg.quote ?? null });
    transcript.push(...newsLines(s.inbox));
    if (r.kind === 'no_city') throw new Error('город пропал посреди этапа');
    transcript.push({ who: r.kind === 'reply' ? 'priest' : 'system', text: r.text });
  }
  const after = await snapshot(s.deps, s.storage, s.clock.now(), { run: null, stage: 'will', case: null });
  const opened = (after.cities[0]?.fronts.length ?? 0) - (state.cities[0]?.fronts.length ?? 0);
  return { transcript, outcome: `Реплик: ${c.messages.length}. Новых фронтов: ${opened}.`, before: state, after };
}

export async function runSeedingStage(env: StageEnv, c: SeedingCase, seed: number, state: Snapshot): Promise<StageResult> {
  const s = await stand(env, state.now, seed);
  await load(s.storage, state);
  const found = await s.storage.getCityByOwner(OWNER);
  if (!found) throw new Error(`в снимке ${c.state} нет города игрока`);
  const city = structuredClone(found);
  const world = await requireWorld(s.deps);
  const day = today(s.deps, world);
  const transcript: TranscriptLine[] = [];
  const news: OutboundMessage[] = [];
  let planted = 0;

  for (const id of c.plant) {
    const template = id ? env.scenarios.find((x) => x.id === id) : null;
    if (id && !template) throw new Error(`нет заготовки ${id} в scenarios/`);
    const before = city.fronts.length;
    // Поток сам выбирает заготовку из deps.scenarios — даём ему ровно ту, что просит кейс.
    const msg = await plantStory({ ...s.deps, scenarios: template ? [template] : [] }, city, day);
    if (city.fronts.length > before) planted++;
    else transcript.push({ who: 'system', text: `Посадка ${id ?? 'по зерну'} не случилась.` });
    if (msg) news.push(msg);
  }
  await s.storage.saveCity(city);
  await sendAll(s.deps, news);
  transcript.push(...newsLines(s.inbox));
  return {
    transcript,
    outcome: `Посажено историй: ${planted} из ${c.plant.length}.`,
    before: state,
    after: await snapshot(s.deps, s.storage, s.clock.now(), { run: null, stage: 'seeding', case: null }),
  };
}
