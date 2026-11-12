/**
 * Воля игрока: приказ, который жрец передал сановнику, превращается в дело.
 *
 * Толкователь относит приказ к одному из шести видов. Дальше у каждого вида своя цепочка узких
 * агентов, и после каждого их слова числа считает ядро: ёмкость из вклада, вехи из ёмкости,
 * шанс беды из ступени риска и темпа. Сановник из приказа сразу становится ведущим.
 */

import { clipWords } from '../core/text.js';
import type { City, Front, Officer, Project, ProjectStage, StakeOp, WorldObject } from '../core/city.js';
import { activeFacts } from '../core/lore.js';
import { findOfficer, officeDef } from '../core/officers.js';
import type { Office, RiskStep, StatMap, Tempo, Verdict } from '../core/rules.js';
import { emptyStatMap } from '../core/rules.js';
import { realWaitLabel, spanBand, DAYS_PER_MONTH } from '../core/time.js';
import { assignmentOf, closeAssignment, createAssignment, leadOf, officerOf } from '../core/world/assignments.js';
import type { Change } from '../core/world/changes.js';
import { activeFronts, childFronts, closeFront, createFront, daysLeft, findFront, occupyFootprint } from '../core/world/fronts.js';
import {
  basePrice,
  changeCapacity,
  diffPoints,
  dominantStat,
  hindranceRemovalCapacity,
  newObjectCapacity,
  pushCapacity,
  rawToPoints,
  scaleOf,
} from '../core/world/numbers.js';
import { attachedTo, createObject, findObject } from '../core/world/objects.js';
import { recomputeStats } from '../core/world/stats.js';
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

export type WillOutcome = { ok: true; say: string } | { ok: false; error: string; say: string };

const RISK_WORDS: Record<RiskStep, string> = {
  safe: 'Дело спокойное.',
  normal: 'Риск обычный.',
  hard: 'Дело трудное: без осложнений едва ли обойдётся.',
  risky: 'Дело рискованное: беда скорее случится, чем нет.',
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
  return refuse('officer_busy', `${title(deps, officer)} уже занят${front ? `: ${front.title}` : ''}. Сначала снять его с этого дела или взять другого.`);
}

/** Сколько ждать: словами и в реальном времени. */
function waitWords(deps: FlowDeps, front: Front, day: number): string {
  const left = daysLeft(front, day);
  return left == null ? '' : `Работы: ${spanBand(left)} (${realWaitLabel(left, deps.rules)}).`;
}

function willInput(city: City) {
  return {
    fronts: activeFronts(city).map((f) => ({
      id: f.id,
      title: f.title,
      description: f.description,
      lead: leadLabel(city, f).label,
      hindrances: attachedTo(city, f.id)
        .filter((o) => (o.attach?.rate ?? 0) < 0)
        .map((o) => o.name),
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
  if (officer.assignmentId) return busy(deps, city, officer);
  const objects = visibleBriefs(city);
  const ruling = await tryAgent(
    deps,
    'canon-warden',
    () => judgeCanon(deps.agents, { goal: will.goal, facts: activeFacts(city).slice(-30).map((f) => f.text), objects }),
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
  return startStage(deps, city, project, officer, will, day);
}

interface StagePlan {
  capacity: number;
  stake: StakeOp[];
  /** По чему судить профиль дела. */
  points: StatMap;
  target: WorldObject | null;
}

async function planStake(deps: FlowDeps, city: City, stage: ProjectStage): Promise<StagePlan | string> {
  const r = stage.result;
  const target = r.objectId ? findObject(city, r.objectId) : null;
  switch (r.kind) {
    case 'new_object': {
      const type = r.type ?? 'building';
      const { points } = await appraise(deps, city, { type, name: r.name, description: r.description });
      const parent = r.parentId ? findObject(city, r.parentId) : null;
      return {
        capacity: newObjectCapacity(deps.rules, type, points),
        stake: [{ op: 'create', object: { type, name: r.name, description: r.description, points, parentId: parent?.status === 'active' ? parent.id : null }, result: true }],
        points,
        target: null,
      };
    }
    case 'change_object': {
      if (!target || target.status !== 'active') return 'Того, что этот шаг должен был изменить, в городе больше нет.';
      const before = rawToPoints(city, target.statEffect);
      const { points } = await appraise(deps, city, { type: target.type, name: target.name, description: r.description }, { points: before, event: stage.work });
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
      return { capacity: changeCapacity(deps.rules, target.type, before), stake: [{ op: 'delete', target: target.id }], points: before, target };
    }
    case 'fact':
      return { capacity: basePrice(deps.rules, 'fact'), stake: [{ op: 'fact', text: r.description }], points: emptyStatMap(), target: null };
  }
}

/** Запустить текущий этап проекта: фронт-дело с местом работ, ключом и ведущим. */
async function startStage(deps: FlowDeps, city: City, project: Project, officer: Officer, will: Will, day: number): Promise<WillOutcome> {
  const stage = project.stages[project.stageIndex];
  if (!stage) {
    project.status = 'done';
    return refuse('no_stage', 'Этот замысел уже доведён до конца.');
  }
  const plan = await planStake(deps, city, stage);
  if (typeof plan === 'string') {
    project.status = 'cancelled';
    return refuse('stage_lost', plan);
  }

  const work = `${stage.title}. ${stage.work}`;
  const links = await tryAgent(
    deps,
    'footprint-mapper',
    () => mapFootprint(deps.agents, { work, result: `${stage.result.name}. ${stage.result.description}`, objects: visibleBriefs(city) }),
    [],
  );
  const footprint = links.filter((l) => findObject(city, l.objectId)?.status === 'active');
  const risk: RiskStep = project.unattainable
    ? 'impossible'
    : (await tryAgent(deps, 'risk-appraiser', () => appraiseRisk(deps.agents, { work, touches: touchesOf(city, { footprint }) }), { step: 'normal' as const, reason: '' })).step;

  // Новое привязывается к тому, с чем работа его связала: по этим связям потом пойдёт эхо.
  const linked = footprint.filter((l) => l.relation === 'linked').map((l) => l.objectId);
  const stake = plan.stake.map((op): StakeOp => (op.op === 'create' ? { ...op, object: { ...op.object, refs: linked } } : op));

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

  const o = deps.rules.fronts.outcome;
  const twistNeeded = !stage.outcomeKnown && !project.unattainable && deps.random.rng() * (o.asPlanned + o.twist) >= o.asPlanned;
  const scale = scaleOf(deps.rules, plan.capacity).milestones;
  const pulse = risk === 'impossible' || Boolean(project.unattainable);

  const front = createFront({
    id: newId(deps, 'front'),
    form: 'deed',
    origin: 'player',
    title: stage.title,
    description: stage.work,
    capacity: plan.capacity,
    milestones: project.unattainable ? Math.max(2, scale) : scale,
    pulseDay: pulse ? day + DAYS_PER_MONTH : null,
    stake,
    risk,
    tempo: will.projectTempo ?? 0,
    footprint,
    atStake: plan.capacity,
    unattainable: project.unattainable,
    projectId: project.id,
    siteId: site.id,
    profile: dominantStat(plan.points),
    day,
  });
  city.fronts.push(front);
  const occupied = occupyFootprint(city, front);
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
  createAssignment(city, { id: newId(deps, 'asg'), front, officer, text: will.manner ?? '', verdict, tempo: will.workTempo ?? 0, day });
  project.frontId = front.id;
  project.status = 'running';
  refreshAllFronts(deps, city, day);

  const changes: Change[] = [
    { kind: 'front_opened', frontId: front.id, title: front.title, form: front.form, plus: false },
    { kind: 'object_created', objectId: site.id, name: site.name, type: site.type, points: emptyStatMap(), temporary: true, hidden: false },
  ];
  await record(deps, city, {
    gist: `${title(deps, officer)} ${officer.gender === 'female' ? 'начала' : 'начал'} дело по воле покровителя: ${front.title}. ${front.description}`,
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
      `${title(deps, officer)} начал работу: ${front.title}.`,
      waitWords(deps, front, day),
      RISK_WORDS[risk],
      names.length ? `На время работ заняты и дают городу меньше: ${names.join(', ')}.` : '',
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
  if (front.form === 'clock') return refuse('only_wait', `«${front.title}»: работой это не сдвинуть, остаётся дождаться срока.`);
  const lead = leadOf(city, front.id);
  if (lead && lead.office !== officer.office) {
    const other = officerOf(city, lead);
    return refuse('has_lead', `«${front.title}» уже ведёт ${other ? title(deps, other) : 'другой сановник'}. Сначала снять его с этого дела.`);
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
  refreshAllFronts(deps, city, day);
  return { ok: true, say: [`${title(deps, officer)} ведёт «${front.title}» так, как велено.`, waitWords(deps, front, day)].filter(Boolean).join(' ') };
}

// ───────────────────────────── атомарное дело ─────────────────────────────

async function atomicDeed(deps: FlowDeps, city: City, officer: Officer, will: Will, day: number): Promise<WillOutcome> {
  const parent = will.frontId ? findFront(city, will.frontId) : null;
  if (!parent || parent.status !== 'active') return refuse('no_front', 'Неясно, какому делу это должно помочь. Пусть покровитель назовёт его.');
  if (parent.capacity <= 0) return refuse('only_wait', `«${parent.title}»: работой это не сдвинуть, остаётся дождаться срока.`);
  if (officer.assignmentId) return busy(deps, city, officer);
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
    if (!hindrance) return refuse('no_hindrance', `На деле «${parent.title}» сейчас нет помех, которые можно убрать.`);
    capacity = hindranceRemovalCapacity(deps.rules, parent.capacity);
    stake = [{ op: 'delete', target: hindrance.id }];
    targetId = hindrance.id;
  } else if (kind === 'helper') {
    const planned = await tryAgent(deps, 'stage-planner', () => planStages(deps.agents, { goal: will.goal, gaps: [], objects: visibleBriefs(city) }), null);
    const named = planned?.find((s) => s.result.kind === 'new_object')?.result;
    const helper = { type: named?.type ?? ('community' as const), name: named?.name ?? will.goal.slice(0, 80), description: named?.description ?? will.goal };
    const { points } = await appraise(deps, city, helper);
    capacity = newObjectCapacity(deps.rules, helper.type, points);
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
  // У разового вклада вердикт уже учтён в размере толчка; у остальных он задаёт скорость самого задания.
  createAssignment(city, { id: newId(deps, 'asg'), front, officer, text: will.manner ?? '', verdict: kind === 'push' ? 'fits' : verdict, tempo: will.workTempo ?? 0, day });
  refreshAllFronts(deps, city, day);
  return {
    ok: true,
    say: [`${title(deps, officer)} взялся за задание для дела «${parent.title}»: ${front.title}.`, waitWords(deps, front, day), RISK_WORDS[risk]].filter(Boolean).join(' '),
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
  if (!said.length) return refuse('no_lead', `«${front.title}» сейчас никто не ведёт: торопить некого.`);
  refreshAllFronts(deps, city, day);
  return { ok: true, say: [`«${front.title}»: ${said.join('; ')}.`, waitWords(deps, front, day), 'Спешка ускоряет работу и чаще приводит к бедам, осторожность наоборот.'].filter(Boolean).join(' ') };
}

async function cancelWork(deps: FlowDeps, city: City, will: Will, day: number): Promise<WillOutcome> {
  const front = will.frontId ? findFront(city, will.frontId) : null;
  if (!front || front.status !== 'active') return refuse('no_front', 'Неясно, что именно прекратить. Пусть покровитель назовёт дело.');
  if (!(front.origin === 'player' || front.origin === 'deed' || front.plus)) {
    return refuse('not_ours', `«${front.title}» начато не по воле покровителя: его можно унять работой или переждать, но не отменить.`);
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
    gist: `По воле покровителя дело прекращено: ${front.title}.`,
    changes,
    source: 'will',
    frontId: front.id,
    day,
    kind: 'resolution',
    officer: lead,
    announce: false,
  });
  return { ok: true, say: `Дело «${front.title}» прекращено.${front.siteId ? ' То, что успели сделать, осталось стоять как есть.' : ''}` };
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
  const left = front && front.status === 'active' ? ` Дело «${front.title}» осталось без ведущего и стоит.` : front ? ` Задание «${front.title}» брошено.` : '';
  return { ok: true, say: `${title(deps, officer)} снят с дела.${left}` };
}
