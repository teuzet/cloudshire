/**
 * Воля игрока: приказ, который жрец передал сановнику, превращается в дело.
 *
 * Толкователь относит приказ к одному из шести видов. Дальше у каждого вида своя цепочка узких
 * агентов, и после каждого их слова числа считает ядро: ёмкость из вклада, вехи из ёмкости,
 * шанс беды из ступени риска и темпа. Сановник из приказа сразу становится ведущим.
 */

import { FORM_WORDS } from '../core/world/changes.js';
import { clipWords } from '../core/text.js';
import type { City, Front, Officer, Project, ProjectStage, StakeOp, WorldObject } from '../core/city.js';
import { activeFacts } from '../core/lore.js';
import { findOfficer, officeDef } from '../core/officers.js';
import type { Office, RiskStep, StatMap, Tempo, Verdict } from '../core/rules.js';
import { emptyStatMap } from '../core/rules.js';
import { realWaitLabel, spanBand, DAYS_PER_MONTH } from '../core/time.js';
import { assignmentOf, canDetour, closeAssignment, createAssignment, detour, leadOf, officerOf } from '../core/world/assignments.js';
import type { Change } from '../core/world/changes.js';
import { activeFronts, childFronts, closeFront, createFront, daysLeft, deadlineOf, findFront, frontGist, occupyFootprint, withOuter } from '../core/world/fronts.js';
import { moveSaving, withNested } from '../core/world/patch.js';
import { hiddenAbout, prizeFronts, type HiddenAbout } from '../core/world/hidden.js';
import { carriedWork, frontsOn, linkLines, resultName } from '../core/world/links.js';
import { setResistance } from '../core/world/resist.js';
import { applyHold, holdersOf, ownMotion } from '../core/world/hold.js';
import {
  basePrice,
  changeCapacity,
  diffPoints,
  dominantStat,
  hindranceRemovalCapacity,
  magnitude,
  newObjectCapacity,
  patchCapacity,
  pushCapacity,
  rawToPoints,
  scaleOf,
} from '../core/world/numbers.js';
import { attachedTo, createObject, findObject } from '../core/world/objects.js';
import { recomputeStats } from '../core/world/stats.js';
import { TYPE_WORDS } from '../agents/_shared/blocks.js';
import { judgeAlignment } from '../agents/alignment-judge/run.js';
import { judgeCanon } from '../agents/canon-warden/run.js';
import { mapFootprint } from '../agents/footprint-mapper/run.js';
import { appraiseRisk } from '../agents/risk-appraiser/run.js';
import { fitRole } from '../agents/role-fitter/run.js';
import { planStages, type PlannedStage } from '../agents/stage-planner/run.js';
import { interpretWill, type Will } from '../agents/will-interpreter/run.js';
import { appraise, leadLabel, officerLabel, seal, situationOf, touchesOf, visibleBriefs } from './briefs.js';
import { record } from './chronicle.js';
import { newId, tryAgent, type FlowDeps } from './context.js';
import { refreshAllFronts } from './fronts.js';
import { answerResist, influenceOf, linkWords, resistOf, resistWords, withLinks } from './patch.js';
import { answerHindrances, answerWords } from './hindrances.js';

export type WillOutcome = { ok: true; say: string } | { ok: false; error: string; say: string };

const RISK_WORDS: Record<RiskStep, string> = {
  safe: 'Дело спокойное.',
  normal: 'Обычная работа: заминки бывают.',
  hard: 'Дело трудное: по пути наверняка встретятся помехи.',
  risky: 'Дело опасное: беда скорее случится, чем нет.',
  impossible: 'Дело на грани невозможного: беды будут на каждом шагу.',
};

const TEMPO_SAY: Record<Tempo, string> = { [-1]: 'без спешки, осторожно', 0: 'обычным ходом', 1: 'в спешке' };

const refuse = (error: string, say: string): WillOutcome => ({ ok: false, error, say });

function title(deps: FlowDeps, officer: Officer): string {
  return `${officeDef(deps.rules, officer.office).title} ${officer.name}`.trim();
}

function busy(deps: FlowDeps, city: City, officer: Officer): WillOutcome {
  const a = assignmentOf(city, officer);
  const front = a ? findFront(city, a.frontId) : null;
  const she = officer.gender === 'female';
  const now = `${title(deps, officer)} уже ${she ? 'занята' : 'занят'}${front ? `: ${frontGist(front)}` : ''}.`;
  // Отвлечься можно на малое дело и только раз: с малого дела не отвлекаются.
  const more = a?.returnTo
    ? `Это малое дело, ради него ${she ? 'она уже отвлеклась' : 'он уже отвлёкся'} от большого; пусть закончит, или возьмётся другой.`
    : `Отвлечься ${she ? 'она' : 'он'} может только на малое дело, а это большое. Сначала снять с нынешнего дела или взять другого.`;
  return refuse('officer_busy', `${now} ${more}`);
}

/** Что жрец скажет, когда занятый сановник отвлекается на малое дело. Пусто — сановник свободен. */
function detourWords(deps: FlowDeps, city: City, officer: Officer): string {
  const a = assignmentOf(city, officer);
  const front = a ? findFront(city, a.frontId) : null;
  if (!front) return '';
  return `Ради этого ${officer.gender === 'female' ? 'она' : 'он'} отвлекается от дела «${frontGist(front)}»: оно постоит и пойдёт дальше само, когда малое будет сделано.`;
}

/** Сколько ждать: словами и в реальном времени. */
function waitWords(deps: FlowDeps, city: City, front: Front, day: number): string {
  const left = daysLeft(front, day);
  if (left == null) return '';
  const work = `Работы: ${spanBand(left)} (${realWaitLabel(left, deps.rules)}).`;
  // Полосы грубые: «сезон» работы и «сезон» срока не скажут, успеет ли сановник. Это считает код.
  // Срок бывает и чужой: часы рядом унесут то, на чём дело держится.
  const deadline = deadlineOf(city, front);
  if (deadline == null || day + left <= deadline) return work;
  return `${work} До срока меньше: к сроку не успеть${front.plus ? ', случай уйдёт раньше' : ''}.`;
}

function willInput(city: City) {
  return {
    fronts: activeFronts(city).map((f) => ({
      id: f.id,
      title: frontGist(f),
      kind: f.plus ? (deadlineOf(city, f) != null ? 'удобный случай со сроком' : 'удобный случай') : FORM_WORDS[f.form],
      description: f.description,
      lead: leadLabel(city, f).label,
      // Что держит дело: без этого приказ «сбить цепи» не отличить от приказа «удержать островок».
      holders: holdersOf(city, f.id)
        .filter((h) => !h.obj.hidden)
        .map((h) => h.obj.name),
      hindrances: attachedTo(city, f.id)
        .filter((o) => (o.attach?.rate ?? 0) < 0)
        .map((o) => ({ name: o.name, description: o.description })),
    })),
    projects: city.projects
      .filter((p) => p.status === 'waiting')
      .map((p) => ({ id: p.id, title: p.title, next: p.stages[p.stageIndex]?.title ?? '' })),
  };
}

/** Приказ сановнику словами жреца. Возвращает то, что жрец узнаёт в ответ на инструмент. */
export async function playerWill(deps: FlowDeps, city: City, office: Office, text: string, day: number): Promise<WillOutcome> {
  const officer = findOfficer(city, office);
  if (!officer) return refuse('no_officer', 'Такого сановника нет.');
  const order = text.trim();
  const will = await tryAgent<Will>(
    deps,
    'will-interpreter',
    () => interpretWill(deps.agents, { order, officer: officerLabel(officer), ...willInput(city) }),
    { label: 'project', frontId: null, projectId: null, deedKind: null, goal: order.slice(0, 400), manner: null, projectTempo: null, workTempo: null },
  );

  let outcome: WillOutcome;
  switch (will.label) {
    case 'project':
      outcome = await newProject(deps, city, officer, will, day);
      break;
    case 'continue':
      outcome = await continueProject(deps, city, officer, will, day);
      break;
    case 'strategy':
      outcome = await setStrategy(deps, city, officer, will, day);
      break;
    case 'deed':
      outcome = await atomicDeed(deps, city, officer, will, day);
      break;
    case 'tempo':
      outcome = setTempo(deps, city, will, day);
      break;
    case 'cancel':
      outcome = await cancelWork(deps, city, will, day);
      break;
  }
  refreshAllFronts(deps, city, day);
  return outcome;
}

// ───────────────────────────── проект ─────────────────────────────

/** Дело, которому суждено рухнуть, идёт одним этапом: цель целиком. */
function doomedStage(goal: string, planned: PlannedStage[] | null): ProjectStage {
  const last = planned?.[planned.length - 1];
  return {
    title: clipWords(last?.title ?? goal, 80),
    work: goal,
    result: last?.result ?? { kind: 'fact', objectId: null, type: null, name: goal.slice(0, 80), description: goal, parentId: null },
    site: planned?.[0]?.site ?? { name: `Работы: ${goal}`.slice(0, 80), description: '' },
    outcomeKnown: true,
  };
}

async function newProject(deps: FlowDeps, city: City, officer: Officer, will: Will, day: number): Promise<WillOutcome> {
  // Занятый сановник берётся только за малое: насколько дело мало, станет ясно по его цене.
  if (officer.assignmentId && !canDetour(city, officer)) return busy(deps, city, officer);
  const objects = visibleBriefs(city);
  const ruling = await tryAgent(
    deps,
    'canon-warden',
    // Страж судит о мире, а не о событиях: то, что идёт рядом, приказ как раз и меняет, поэтому он видит только место.
    () => judgeCanon(deps.agents, { goal: will.goal, facts: activeFacts(city).slice(-30).map((f) => f.text), objects: visibleBriefs(city, false) }),
    { verdict: 'possible' as const, reason: '', goal: will.goal, gaps: [] as string[] },
  );

  let unattainable: string | null = null;
  if (ruling.verdict === 'unattainable') {
    const warned = city.unattainableWarning;
    const inWindow = warned != null && day - warned.day <= deps.rules.fronts.unattainableWarnDays;
    const repeat =
      inWindow &&
      (
        await tryAgent(
          deps,
          'role-fitter',
          () => fitRole(deps.agents, { question: 'Это тот же замысел, что и прежний?', subject: will.goal, context: `Прежний замысел: ${warned.goal}` }),
          { fits: true, reason: '' },
        )
      ).fits;
    if (!repeat) {
      city.unattainableWarning = { goal: will.goal, day };
      return refuse(
        'unattainable',
        `Довести это до конца город не сможет: ${ruling.reason} Если покровитель повторит приказ, ${title(deps, officer)} возьмётся, но дело кончится крахом и по дороге наделает бед.`,
      );
    }
    unattainable = ruling.reason;
    city.unattainableWarning = null;
  }

  const planned = await tryAgent(deps, 'stage-planner', () => planStages(deps.agents, { goal: ruling.goal, gaps: ruling.gaps, objects }), null);
  if (!planned && !unattainable) return refuse('failed', 'Волю не удалось облечь в дело. Пусть покровитель скажет иначе.');
  const stages: ProjectStage[] = unattainable ? [doomedStage(ruling.goal, planned)] : (planned ?? []);
  if (officer.assignmentId && (unattainable || stages.length > 1)) return busy(deps, city, officer);

  const project: Project = {
    id: newId(deps, 'proj'),
    title: clipWords(ruling.goal, 120),
    goal: ruling.goal,
    stages,
    stageIndex: 0,
    frontId: null,
    unattainable,
    status: 'waiting',
    createdDay: day,
    answers: will.frontId,
    report: Boolean(will.report),
    manner: will.manner,
    projectTempo: will.projectTempo,
    workTempo: will.workTempo,
  };
  city.projects.push(project);
  const started = await startStage(deps, city, project, officer, will, day);
  if (!started.ok) return started;
  return ruling.verdict === 'amended' ? { ok: true, say: `${started.say} Замысел пришлось поправить: ${ruling.reason}` } : started;
}

async function continueProject(deps: FlowDeps, city: City, officer: Officer, will: Will, day: number): Promise<WillOutcome> {
  const waiting = city.projects.filter((p) => p.status === 'waiting');
  const project = waiting.find((p) => p.id === will.projectId) ?? (waiting.length === 1 ? waiting[0] : null);
  if (!project) return refuse('no_project', 'Замысла, который ждёт продолжения, нет. Если это новое дело, пусть покровитель назовёт цель.');
  if (officer.assignmentId) return busy(deps, city, officer);
  // Новое слово о способе и темпе остаётся с замыслом и на следующие шаги.
  if (will.manner) project.manner = will.manner;
  if (will.projectTempo != null) project.projectTempo = will.projectTempo;
  if (will.workTempo != null) project.workTempo = will.workTempo;
  if (will.report) project.report = true;
  return startStage(deps, city, project, officer, { ...will, manner: project.manner ?? null, projectTempo: project.projectTempo ?? null, workTempo: project.workTempo ?? null }, day);
}

/**
 * Следующий шаг замысла начинается сам, если покровитель не велел докладывать: тот же сановник,
 * тот же способ и темп. Пусто — шаг может начаться; иначе причина, почему замысел ждёт слова.
 */
export function autoStageBlock(city: City, project: Project, officer: Officer | null): string | null {
  if (project.status !== 'waiting') return 'замысел не ждёт продолжения';
  if (project.report) return 'покровитель велел докладывать между шагами';
  if (!officer || officer.assignmentId) return 'сановник занят другим';
  const stage = project.stages[project.stageIndex];
  if (!stage) return 'шагов больше нет';
  return stageBlock(city, stage, project.answers ?? null);
}

export async function autoStage(deps: FlowDeps, city: City, project: Project, officer: Officer, day: number): Promise<WillOutcome> {
  const will: Will = {
    label: 'continue',
    frontId: project.answers ?? null,
    projectId: project.id,
    deedKind: null,
    goal: project.goal,
    manner: project.manner ?? null,
    projectTempo: project.projectTempo ?? null,
    workTempo: project.workTempo ?? null,
  };
  const out = await startStage(deps, city, project, officer, will, day);
  refreshAllFronts(deps, city, day);
  return out;
}

interface StagePlan {
  capacity: number;
  stake: StakeOp[];
  /** По чему судить профиль дела. */
  points: StatMap;
  target: WorldObject | null;
}

/** Фронты, которые держит объект или вложенное в него: когда его не станет, они пойдут как прежде. */
function heldBy(city: City, objectId: string): string[] {
  const ids = withNested(city, [objectId]);
  return [...new Set(city.objects.filter((o) => ids.has(o.id)).flatMap((o) => (o.holds ?? []).map((h) => h.frontId)))];
}

/**
 * То, что уже стоит рядом, помогает работе или мешает ей, пока она идёт: каменоломня у стройки,
 * слух на плато. Держит дело, пока оно идёт; общий потолок считает код скорости. Слова для жреца.
 */
function holdFound(deps: FlowDeps, city: City, front: Front, day: number): string {
  const help: string[] = [];
  const hinder: string[] = [];
  for (const entry of front.footprint) {
    if (entry.relation !== 'helps' && entry.relation !== 'hinders') continue;
    const obj = findObject(city, entry.objectId);
    if (!obj || obj.status !== 'active' || obj.hidden || obj.temporary || obj.out) continue;
    // Что занято работой, уже в ней; что работа меняет, само ей не помогает.
    if (front.footprint.some((f) => f.objectId === obj.id && f.relation === 'occupies')) continue;
    if (front.stake.some((op) => 'target' in op && op.target === obj.id)) continue;
    const hold = applyHold(deps.rules, city, front, obj, { frontId: front.id, effect: entry.relation === 'helps' ? 'hurry' : 'slow', found: true }, day);
    if (hold) (entry.relation === 'helps' ? help : hinder).push(obj.name);
  }
  return [help.length ? `Работе поможет то, что рядом: ${help.join(', ')}.` : '', hinder.length ? `Работе будет мешать то, что рядом: ${hinder.join(', ')}.` : ''].filter(Boolean).join(' ');
}

/** Что результат отпустит: оно пойдёт как прежде, и жрецу надо это знать заранее. */
function freedWords(city: City, ids: readonly string[]): string {
  const parts = [...new Set(ids)].flatMap((id) => {
    const f = findFront(city, id);
    if (!f || f.status !== 'active') return [];
    return [ownMotion(f) === 'clock' ? `снова надвигается «${frontGist(f)}»` : `снова пойдёт работа над «${frontGist(f)}»`];
  });
  return parts.length ? `Когда будет готово, ${parts.join('; ')}.` : '';
}

/** Узнавать нечего: жрец говорит это до начала дела, как о недостижимом. */
function revealBlock(city: City, about: HiddenAbout): string | null {
  const front = about.frontId ? findFront(city, about.frontId) : null;
  const obj = about.objectId ? findObject(city, about.objectId) : null;
  if (!front && !obj) return 'Неясно, о чём узнавать. Пусть покровитель назовёт дело или место.';
  if (hiddenAbout(city, about).length) return null;
  const subject = front ? `«${frontGist(front)}»` : obj!.name;
  // Остальное — приз идущего дела: его открывает только успех самого дела.
  const prize = prizeFronts(city, about)[0];
  if (prize) return `Расспросами больше ничего не узнать (${subject}): остальное откроется, только когда будет доведено до конца «${frontGist(prize)}».`;
  return `Узнавать больше нечего: всё, что можно узнать здесь (${subject}), городу уже известно.`;
}

/** Чем этап не может начаться: того, что он меняет, больше нет. */
function stageBlock(city: City, stage: ProjectStage, about: string | null): string | null {
  const r = stage.result;
  if (r.kind === 'new_object' || r.kind === 'fact') return null;
  if (r.kind === 'reveal') return revealBlock(city, { frontId: about, objectId: r.objectId });
  const target = r.objectId ? findObject(city, r.objectId) : null;
  if (!target || target.status !== 'active') {
    const verb = { restore_object: 'вернуть', change_object: 'изменить', remove_object: 'убрать', move_object: 'перенести' }[r.kind];
    return `Того, что этот шаг должен был ${verb}, в городе больше нет.`;
  }
  if (r.kind === 'remove_object' && target.protected) return `${target.name} убрать нельзя: на этом держится сам город.`;
  if (r.kind === 'move_object') {
    if (target.out) return `${target.name} сейчас не действует: переносить нечего, сначала это нужно вернуть.`;
    const to = r.parentId ? findObject(city, r.parentId) : null;
    if (to && withOuter(city, [to.id]).has(target.id)) return `${target.name} нельзя перенести внутрь самого себя.`;
  }
  return null;
}

/**
 * Цена и ставка этапа. `apart` — что результат переменит в идущем рядом: это посчитано отдельной ценой,
 * и оценщик вклада его не считает второй раз.
 */
async function planStake(deps: FlowDeps, city: City, stage: ProjectStage, day: number, apart: readonly string[] = [], about: string | null = null): Promise<StagePlan | string> {
  const r = stage.result;
  const target = r.objectId ? findObject(city, r.objectId) : null;
  switch (r.kind) {
    case 'new_object': {
      const type = r.type ?? 'building';
      const { points } = await appraise(deps, city, { type, name: r.name, description: r.description }, null, apart);
      const parent = r.parentId ? findObject(city, r.parentId) : null;
      return {
        capacity: newObjectCapacity(deps.rules, type, points),
        stake: [{ op: 'create', object: { type, name: r.name, description: r.description, points, parentId: parent?.status === 'active' ? parent.id : null }, result: true }],
        points,
        target: null,
      };
    }
    case 'restore_object': {
      if (!target || target.status !== 'active') return 'Того, что этот шаг должен был вернуть, в городе больше нет.';
      if (target.out) {
        // Сколько вернётся, решает код: прежний вклад объекта. Цена — как у перемены на эту разницу.
        const delta = diffPoints(target.out.was, rawToPoints(city, target.statEffect));
        return { capacity: changeCapacity(deps.rules, target.type, delta), stake: [{ op: 'restore', target: target.id, description: r.description }], points: delta, target };
      }
      return planStake(deps, city, { ...stage, result: { ...r, kind: 'change_object' } }, day, apart);
    }
    case 'change_object': {
      if (!target || target.status !== 'active') return 'Того, что этот шаг должен был изменить, в городе больше нет.';
      const before = rawToPoints(city, target.statEffect);
      const { points } = await appraise(deps, city, { type: target.type, name: target.name, description: r.description }, { points: before, event: stage.work }, apart);
      const delta = diffPoints(points, before);
      return {
        capacity: changeCapacity(deps.rules, target.type, delta),
        stake: [{ op: 'revalue', target: target.id, points, description: r.description }],
        points: delta,
        target,
      };
    }
    case 'remove_object': {
      if (!target || target.status !== 'active') return 'Того, что этот шаг должен был убрать, в городе больше нет.';
      if (target.protected) return `${target.name} убрать нельзя: на этом держится сам город.`;
      const before = rawToPoints(city, target.statEffect);
      // Убрать то, на чём живёт беда, значит снять саму беду: это стоит остаток её шкалы.
      const capacity = changeCapacity(deps.rules, target.type, before) + carriedWork(city, target, day);
      return { capacity, stake: [{ op: 'delete', target: target.id }], points: before, target };
    }
    case 'move_object': {
      if (!target || target.status !== 'active') return 'Того, что этот шаг должен был перенести, в городе больше нет.';
      const to = r.parentId ? findObject(city, r.parentId) : null;
      // Перенос стоит половину цены вида, а если уводит вещь из-под удара, ещё и спасённое (со скидкой сдерживания).
      const { saved } = moveSaving(city, target.id, to?.status === 'active' ? to.id : null, day);
      const h = deps.rules.fronts.hold;
      const rescue = saved > 0 ? Math.max(h.priceMin, saved * h.price.stop) : 0;
      return {
        capacity: Math.round((basePrice(deps.rules, target.type) / 2 + rescue) * 100) / 100,
        stake: [{ op: 'move', target: target.id, parentId: to?.status === 'active' ? to.id : null }],
        points: emptyStatMap(),
        target,
      };
    }
    case 'fact':
      return { capacity: basePrice(deps.rules, 'fact'), stake: [{ op: 'fact', text: r.description }], points: emptyStatMap(), target: null };
    case 'reveal':
      // Узнать скрытое стоит как факт: что именно откроется, решит код в день готовности.
      return { capacity: basePrice(deps.rules, 'fact'), stake: [{ op: 'uncover', frontId: about, objectId: target?.status === 'active' ? target.id : null }], points: emptyStatMap(), target: null };
  }
}

/** Запустить текущий этап проекта: фронт-дело с местом работ, ключом и ведущим. */
async function startStage(deps: FlowDeps, city: City, project: Project, officer: Officer, will: Will, day: number): Promise<WillOutcome> {
  const stage = project.stages[project.stageIndex];
  if (!stage) {
    project.status = 'done';
    return refuse('no_stage', 'Этот замысел уже доведён до конца.');
  }
  const lost = stageBlock(city, stage, project.answers ?? null);
  if (lost) {
    project.status = 'cancelled';
    return refuse('stage_lost', lost);
  }

  const work = `${stage.title}. ${stage.work}`;
  const links = await tryAgent(
    deps,
    'footprint-mapper',
    () => mapFootprint(deps.agents, { work, result: `${stage.result.name}. ${stage.result.description}`, objects: visibleBriefs(city) }),
    [],
  );
  const footprint = links.filter((l) => findObject(city, l.objectId)?.status === 'active');

  // Новое привязывается к тому, с чем работа его связала: по этим связям потом пойдёт эхо.
  const linked = footprint.filter((l) => l.relation === 'linked').map((l) => l.objectId);

  // Как готовый результат повлияет на то, что идёт рядом: слово агента, цена и связи от кода.
  const kind = stage.result.kind;
  const target = stage.result.objectId ? (findObject(city, stage.result.objectId) ?? null) : null;
  // Новое место: куда кладут новое или куда переносят то, что есть.
  const parent = (kind === 'new_object' || kind === 'move_object') && stage.result.parentId ? findObject(city, stage.result.parentId) : null;
  const resultType = kind === 'new_object' ? (stage.result.type ?? 'building') : target?.type;
  const resultText = `${stage.result.name}${resultType ? ` (${TYPE_WORDS[resultType]})` : ''}: ${stage.result.description}`;
  const patchIds = [...new Set([...footprint.map((l) => l.objectId), ...(target ? [target.id] : []), ...(parent?.status === 'active' ? [parent.id] : [])])];
  // Что код сделает сам, когда результат будет готов: оценщику это нужно, чтобы судить о сторонах.
  const settled =
    kind === 'remove_object' && target
      ? { ends: frontsOn(city, target).map((f) => f.id), freed: heldBy(city, target.id), saved: [] as string[] }
      : kind === 'move_object' && target
        ? { ends: [], freed: [], saved: moveSaving(city, target.id, parent?.status === 'active' ? parent.id : null, day).fronts }
        : { ends: [], freed: [], saved: [] };
  const gist = (id: string) => {
    const f = findFront(city, id);
    return f ? `«${frontGist(f)}»` : '';
  };
  const follows = [
    ...settled.ends.map((id) => `кончится: ${gist(id)}`),
    ...settled.freed.map((id) => {
      const f = findFront(city, id);
      return `${f && ownMotion(f) === 'clock' ? 'снова надвигается' : 'снова идёт как прежде'}: ${gist(id)}`;
    }),
    ...settled.saved.map((id) => `больше не унесёт это: ${gist(id)}`),
  ];
  // Знание само ничего не держит и не меняет: на что оно повлияет, решит следующий приказ.
  const patch =
    project.unattainable || kind === 'reveal'
      ? null
      : await influenceOf(deps, city, {
        work,
        result: resultText,
        cause: stage.result.name,
        objectIds: patchIds,
        named: project.answers ?? null,
        // Что живёт на убираемом, кончится само, что оно держало, пойдёт как прежде, а от чего перенос
        // уводит вещь, уже не унесёт её: это код делает сам, и это уже в цене.
        settled: [...settled.ends, ...settled.freed, ...settled.saved],
        follows,
        // Вещь, которая остаётся (новая, изменённая, возвращённая, перенесённая), может держать.
        anchor: kind !== 'remove_object' && kind !== 'fact',
        day,
        later: project.stages.slice(project.stageIndex + 1).map((st) => st.title),
        // Изменённое или возвращённое правкой само уходит из-под смягчённого удара.
        shielded: (kind === 'change_object' || kind === 'restore_object') && target ? [target.id] : [],
        workers: footprint.filter((l) => l.relation === 'occupies').map((l) => l.objectId),
        // Изменённое может перестать держать то, что держало: это решает оценщик по новому описанию.
        held: kind === 'change_object' && target?.holds?.length ? { objectId: target.id, holds: target.holds } : undefined,
      });

  // Вклад результата оценивается после влияний: то, что он держит, уже посчитано своей ценой.
  const plan = await planStake(deps, city, stage, day, patch ? linkLines(city, patch.links, stage.result.name) : [], project.answers ?? null);
  if (typeof plan === 'string') {
    project.status = 'cancelled';
    return refuse('stage_lost', plan);
  }
  // Вещь платит за свой вклад и за большее из двух: изготовление или то, что она держит и закрывает.
  // Снос и факт вещи не оставляют: у них влияние прибавляется к цене работы.
  const own = magnitude(plan.points);
  const price = patch?.price ?? 0;
  const lasting = kind === 'new_object' || kind === 'change_object' || kind === 'restore_object';
  const capacity = lasting && price > 0 ? patchCapacity(own, plan.capacity - own, price) : Math.round((plan.capacity + price) * 100) / 100;
  // Занятый сановник отвлекается только на малое: этап замысла не дороже предела.
  if (officer.assignmentId && (project.stages.length > 1 || capacity > deps.rules.fronts.detour.maxCapacity)) {
    project.status = 'cancelled';
    return busy(deps, city, officer);
  }
  const linkedStake = plan.stake.map((op): StakeOp => (op.op === 'create' ? { ...op, object: { ...op.object, refs: linked } } : op));
  const stake = patch ? withLinks(linkedStake, patch, plan.target?.id ?? null) : linkedStake;

  const site = createObject(deps.rules, {
    id: newId(deps, 'obj'),
    type: 'site',
    name: stage.site?.name ?? `Работы: ${stage.title}`,
    description: stage.site?.description || stage.work,
    parentId: plan.target?.id ?? null,
    temporary: true,
    day,
  });
  city.objects.push(site);

  // Кому готовое во вред и кто стоит на месте работ, тот сопротивляется: риск дела выше, пока способ это не снимет.
  const lastStage = project.stageIndex >= project.stages.length - 1;
  const resist = patch ? await resistOf(deps, city, { plan: patch, objectIds: patchIds, work, result: resultText, manner: lastStage ? will.manner : null }) : [];
  const opposed = resist.some((r) => !r.answered);
  // Риск самой работы. Противников оценщик риска не видит: за них код поднимет ступень сам, иначе они посчитаны дважды.
  const against = new Set(resist.map((r) => r.objectId));
  const risk: RiskStep = project.unattainable
    ? 'impossible'
    : (
        await tryAgent(
          deps,
          'risk-appraiser',
          () => appraiseRisk(deps.agents, { work, touches: touchesOf(city, { footprint: footprint.filter((l) => !against.has(l.objectId)) }) }),
          { step: 'normal' as const, reason: '' },
        )
      ).step;

  const o = deps.rules.fronts.outcome;
  // Узнанное подвоха не бывает: что откроется, и так решает мир.
  const twistNeeded = !stage.outcomeKnown && kind !== 'reveal' && !project.unattainable && deps.random.rng() * (o.asPlanned + o.twist) >= o.asPlanned;
  const scale = scaleOf(deps.rules, capacity).milestones;
  const pulse = risk === 'impossible' || Boolean(project.unattainable);

  const front = createFront({
    id: newId(deps, 'front'),
    form: 'deed',
    origin: 'player',
    title: stage.title,
    description: stage.work,
    capacity,
    // Малому делу с противником нужна веха посередине: иначе сопротивлению негде сказаться.
    milestones: project.unattainable || opposed ? Math.max(2, scale) : scale,
    pulseDay: pulse ? day + DAYS_PER_MONTH : null,
    stake,
    risk,
    tempo: will.projectTempo ?? 0,
    footprint,
    atStake: capacity,
    unattainable: project.unattainable,
    projectId: project.id,
    siteId: site.id,
    profile: dominantStat(plan.points),
    day,
  });
  if (patch?.links.length) front.links = patch.links;
  setResistance(front, resist);
  city.fronts.push(front);
  const occupied = occupyFootprint(city, front);
  const nearby = holdFound(deps, city, front, day);
  recomputeStats(city, deps.rules);

  const key = await seal(deps, city, front, { twistNeeded });
  front.key = key ? { moves: key.moves, twist: twistNeeded ? key.twist : null } : null;
  const verdict: Verdict =
    will.manner && front.key
      ? (
          await tryAgent(
            deps,
            'alignment-judge',
            () => judgeAlignment(deps.agents, { situation: situationOf(front), moves: front.key?.moves ?? [], proposal: will.manner ?? '' }),
            { verdict: 'fits' as const, matchedMove: null },
          )
        ).verdict
      : 'fits';
  // Способ из приказа описывает замысел целиком. Пока идёт не последний этап, рассказчики его не видят:
  // иначе этап «разработать методику» описывают как уже построенную обсерваторию.
  const away = detourWords(deps, city, officer);
  detour(city, { id: newId(deps, 'asg'), front, officer, text: lastStage ? (will.manner ?? '') : '', verdict, tempo: will.workTempo ?? 0, day });
  project.frontId = front.id;
  project.status = 'running';
  refreshAllFronts(deps, city, day);

  const changes: Change[] = [
    { kind: 'front_opened', frontId: front.id, title: frontGist(front), form: front.form, plus: false },
    { kind: 'object_created', objectId: site.id, name: site.name, type: site.type, points: emptyStatMap(), temporary: true, hidden: false },
  ];
  await record(deps, city, {
    gist: `${title(deps, officer)} по воле покровителя ${officer.gender === 'female' ? 'взялась' : 'взялся'} за работу. ${front.description}`,
    changes,
    source: 'will',
    frontId: front.id,
    day,
    kind: 'beat',
    officer,
    announce: false,
  });

  const names = occupied.map((id) => findObject(city, id)?.name).filter(Boolean);
  const later = project.stages.slice(project.stageIndex + 1).map((s) => s.title);
  return {
    ok: true,
    say: [
      `${title(deps, officer)} ${officer.gender === 'female' ? 'начала' : 'начал'} работу: ${frontGist(front)}.`,
      away,
      waitWords(deps, city, front, day),
      RISK_WORDS[front.risk],
      resistWords(city, front.resist ?? []),
      linkWords(city, front.links ?? [], stage.result.name),
      freedWords(city, [...settled.freed, ...(patch?.released ?? [])]),
      names.length ? `На время работ заняты и дают городу меньше: ${names.join(', ')}.` : '',
      nearby,
      later.length ? `Это первый шаг замысла. Дальше, по слову покровителя: ${later.join('; ')}.` : '',
    ]
      .filter(Boolean)
      .join(' '),
  };
}

// ───────────────────────────── стратегия ─────────────────────────────

async function setStrategy(deps: FlowDeps, city: City, officer: Officer, will: Will, day: number): Promise<WillOutcome> {
  const front = will.frontId ? findFront(city, will.frontId) : null;
  if (!front || front.status !== 'active') return refuse('no_front', 'Неясно, какого дела это касается. Пусть покровитель назовёт его.');
  // Часы работой не сдвинуть: их держат вещью. Приказ о них — новое дело, которое на них отвечает.
  if (front.form === 'clock') return newProject(deps, city, officer, { ...will, label: 'project' }, day);
  const lead = leadOf(city, front.id);
  // Свободный сановник на чужом деле помогает ему разовым вкладом: ведущий у дела один.
  if (lead && lead.office !== officer.office && !officer.assignmentId) {
    return atomicDeed(deps, city, officer, { ...will, label: 'deed', deedKind: 'push' }, day);
  }
  if (lead && lead.office !== officer.office) {
    const other = officerOf(city, lead);
    return refuse('has_lead', `«${frontGist(front)}» уже ведёт ${other ? title(deps, other) : 'другой сановник'}. Сначала снять его с этого дела.`);
  }
  if (!lead && officer.assignmentId) return busy(deps, city, officer);

  const manner = will.manner ?? will.goal;
  const verdict = (
    await tryAgent(
      deps,
      'alignment-judge',
      () => judgeAlignment(deps.agents, { situation: situationOf(front), moves: front.key?.moves ?? [], proposal: manner }),
      { verdict: 'fits' as const, matchedMove: null },
    )
  ).verdict;
  if (lead) {
    lead.text = manner.slice(0, 600);
    lead.verdict = verdict;
    if (will.workTempo != null) lead.tempo = will.workTempo;
  } else {
    createAssignment(city, { id: newId(deps, 'asg'), front, officer, text: manner, verdict, tempo: will.workTempo ?? 0, day });
  }
  if (will.projectTempo != null) front.tempo = will.projectTempo;
  const answer = await answerHindrances(deps, city, front, manner, day);
  // Новый способ может снять сопротивление стороны или вернуть его.
  if (front.resist?.length) {
    const made = resultName(city, front);
    setResistance(front, await answerResist(deps, city, front.resist, { work: front.description, result: made ?? frontGist(front), manner }));
  }
  refreshAllFronts(deps, city, day);
  return {
    ok: true,
    say: [
      `${title(deps, officer)} ведёт «${front.title || frontGist(front)}» так, как велено.`,
      answerWords(answer),
      front.resist?.length ? `${resistWords(city, front.resist)} ${RISK_WORDS[front.risk]}` : '',
      waitWords(deps, city, front, day),
      leftBehind(city, officer, front, day),
    ]
      .filter(Boolean)
      .join(' '),
  };
}

/** Дело, с которого сановника сняли сегодня, если оно другое и стоит без ведущего: жрец должен сказать об этом честно. */
function leftBehind(city: City, officer: Officer, front: Front, day: number): string {
  const prev = city.assignments
    .filter((a) => a.office === officer.office && a.endDay === day && a.frontId !== front.id)
    .at(-1);
  const old = prev ? findFront(city, prev.frontId) : null;
  if (!old || old.status !== 'active' || leadOf(city, old.id)) return '';
  return `Это другое дело. Прежнее дело «${frontGist(old)}» по-прежнему стоит без ведущего.`;
}

// ───────────────────────────── атомарное дело ─────────────────────────────

async function atomicDeed(deps: FlowDeps, city: City, officer: Officer, will: Will, day: number): Promise<WillOutcome> {
  const parent = will.frontId ? findFront(city, will.frontId) : null;
  if (!parent || parent.status !== 'active') return refuse('no_front', 'Неясно, какому делу это должно помочь. Пусть покровитель назовёт его.');
  if (parent.capacity <= 0) return refuse('only_wait', `«${frontGist(parent)}»: работой это не сдвинуть, остаётся дождаться срока.`);
  // Разовое задание — малое дело: занятый сановник отвлекается на него и возвращается.
  if (officer.assignmentId && !canDetour(city, officer)) return busy(deps, city, officer);
  const kind = will.deedKind ?? 'push';
  const proposal = will.manner ?? will.goal;
  const verdict = (
    await tryAgent(
      deps,
      'alignment-judge',
      () => judgeAlignment(deps.agents, { situation: situationOf(parent), moves: parent.key?.moves ?? [], proposal }),
      { verdict: 'fits' as const, matchedMove: null },
    )
  ).verdict;

  let capacity: number;
  let stake: StakeOp[];
  let targetId: string | null = null;
  if (kind === 'clear') {
    const hindrances = attachedTo(city, parent.id).filter((o) => (o.attach?.rate ?? 0) < 0);
    const hindrance = hindrances.find((h) => will.goal.toLowerCase().includes(h.name.toLowerCase())) ?? hindrances[0];
    if (!hindrance) return refuse('no_hindrance', `На деле «${frontGist(parent)}» сейчас нет помех, которые можно убрать.`);
    capacity = hindranceRemovalCapacity(deps.rules, parent.capacity);
    stake = [{ op: 'delete', target: hindrance.id }];
    targetId = hindrance.id;
  } else if (kind === 'helper') {
    const planned = await tryAgent(deps, 'stage-planner', () => planStages(deps.agents, { goal: will.goal, gaps: [], objects: visibleBriefs(city) }), null);
    const named = planned?.find((s) => s.result.kind === 'new_object')?.result;
    const helper = { type: named?.type ?? ('community' as const), name: named?.name ?? will.goal.slice(0, 80), description: named?.description ?? will.goal };
    const { points } = await appraise(deps, city, helper);
    // Помощник временный: его цена не больше доли самого дела, иначе помощь дороже работы.
    const cap = Math.max(deps.rules.fronts.push.min, parent.capacity * deps.rules.fronts.helper.maxShare);
    capacity = Math.min(newObjectCapacity(deps.rules, helper.type, points), cap);
    stake = [{ op: 'attach', frontId: parent.id, rate: deps.rules.fronts.helper.unitsPerMonth, object: { ...helper, points } }];
  } else {
    capacity = pushCapacity(deps.rules, parent.capacity);
    stake = [{ op: 'progress', frontId: parent.id, amount: capacity * deps.rules.fronts.verdict[verdict] }];
  }

  const risk = (
    await tryAgent(deps, 'risk-appraiser', () => appraiseRisk(deps.agents, { work: will.goal, touches: touchesOf(city, parent) }), { step: 'normal' as const, reason: '' })
  ).step;
  const front = createFront({
    id: newId(deps, 'front'),
    form: 'deed',
    origin: 'deed',
    title: clipWords(will.goal, 120),
    description: will.manner ?? will.goal,
    capacity,
    milestones: 1,
    stake,
    risk,
    tempo: parent.tempo,
    footprint: parent.footprint.map((f) => ({ ...f })),
    parentId: parent.id,
    atStake: capacity,
    profile: parent.profile,
    deed: { kind, verdict, targetId },
    day,
  });
  city.fronts.push(front);
  const away = detourWords(deps, city, officer);
  // У разового вклада вердикт уже учтён в размере толчка; у остальных он задаёт скорость самого задания.
  detour(city, { id: newId(deps, 'asg'), front, officer, text: will.manner ?? '', verdict: kind === 'push' ? 'fits' : verdict, tempo: will.workTempo ?? 0, day });
  refreshAllFronts(deps, city, day);
  return {
    ok: true,
    say: [
      `${title(deps, officer)} ${officer.gender === 'female' ? 'взялась' : 'взялся'} за задание для дела «${frontGist(parent)}»: ${frontGist(front)}.`,
      away,
      waitWords(deps, city, front, day),
      RISK_WORDS[risk],
    ]
      .filter(Boolean)
      .join(' '),
  };
}

// ───────────────────────────── темп и отмена ─────────────────────────────

function setTempo(deps: FlowDeps, city: City, will: Will, day: number): WillOutcome {
  const front = will.frontId ? findFront(city, will.frontId) : null;
  if (!front || front.status !== 'active') return refuse('no_front', 'Неясно, какого дела это касается. Пусть покровитель назовёт его.');
  if (will.projectTempo == null && will.workTempo == null) return refuse('no_tempo', 'Неясно, торопить дело или вести осторожнее.');
  const said: string[] = [];
  if (will.projectTempo != null) {
    front.tempo = will.projectTempo;
    for (const child of childFronts(city, front.id)) if (child.origin === 'deed') child.tempo = will.projectTempo;
    said.push(`дело пойдёт ${TEMPO_SAY[will.projectTempo]}`);
  }
  const lead = leadOf(city, front.id);
  if (will.workTempo != null && lead) {
    lead.tempo = will.workTempo;
    const officer = officerOf(city, lead);
    said.push(`${officer ? title(deps, officer) : 'ведущий'} будет работать ${TEMPO_SAY[will.workTempo]}`);
  }
  if (!said.length) return refuse('no_lead', `«${frontGist(front)}» сейчас никто не ведёт: торопить некого.`);
  refreshAllFronts(deps, city, day);
  return { ok: true, say: [`«${frontGist(front)}»: ${said.join('; ')}.`, waitWords(deps, city, front, day), 'Спешка ускоряет работу и чаще приводит к бедам, осторожность наоборот.'].filter(Boolean).join(' ') };
}

async function cancelWork(deps: FlowDeps, city: City, will: Will, day: number): Promise<WillOutcome> {
  const front = will.frontId ? findFront(city, will.frontId) : null;
  if (!front || front.status !== 'active') return refuse('no_front', 'Неясно, что именно прекратить. Пусть покровитель назовёт дело.');
  if (!(front.origin === 'player' || front.origin === 'deed' || front.plus)) {
    return refuse('not_ours', `«${frontGist(front)}» начато не по воле покровителя: его можно унять работой или переждать, но не отменить.`);
  }
  const lead = leadLabel(city, front).officer;
  const changes = closeFront(deps.rules, city, front, 'cancelled', day);
  const project = front.projectId ? city.projects.find((p) => p.id === front.projectId) : null;
  if (project) {
    project.status = 'cancelled';
    project.frontId = null;
  }
  refreshAllFronts(deps, city, day);
  await record(deps, city, {
    gist: `По воле покровителя дело прекращено: ${frontGist(front)}.`,
    changes,
    source: 'will',
    frontId: front.id,
    day,
    kind: 'resolution',
    officer: lead,
    announce: false,
  });
  return { ok: true, say: `Дело «${frontGist(front)}» прекращено.${front.siteId ? ' То, что успели сделать, осталось стоять как есть.' : ''}` };
}

/** Снять сановника с дела. Исполнитель атомарного дела уносит дело с собой; большое дело остаётся без ведущего. */
export function withdraw(deps: FlowDeps, city: City, office: Office, day: number): WillOutcome {
  const officer = findOfficer(city, office);
  if (!officer) return refuse('no_officer', 'Такого сановника нет.');
  const assignment = assignmentOf(city, officer);
  if (!assignment) return refuse('not_busy', `${title(deps, officer)} и так свободен.`);
  const front = findFront(city, assignment.frontId);
  if (front && front.status === 'active' && front.origin === 'deed') {
    closeFront(deps.rules, city, front, 'cancelled', day);
  } else {
    closeAssignment(city, assignment, day);
  }
  refreshAllFronts(deps, city, day);
  const left = front && front.status === 'active' ? ` Дело «${frontGist(front)}» осталось без ведущего и стоит.` : front ? ` Задание «${frontGist(front)}» брошено.` : '';
  // Снятый с малого дела возвращается к большому, от которого отвлекался.
  const back = assignmentOf(city, officer);
  const backFront = back ? findFront(city, back.frontId) : null;
  const returned = backFront ? ` ${officer.gender === 'female' ? 'Она вернулась' : 'Он вернулся'} к делу «${frontGist(backFront)}».` : '';
  return { ok: true, say: `${title(deps, officer)} ${officer.gender === 'female' ? 'снята' : 'снят'} с дела.${left}${returned}` };
}
