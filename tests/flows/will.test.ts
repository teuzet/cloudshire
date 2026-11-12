import { describe, expect, test } from 'vitest';
import { toolReply } from '../../src/adapters/llm/fake.js';
import type { City } from '../../src/core/city.js';
import { leadOf } from '../../src/core/world/assignments.js';
import { createFront, nextEventDay } from '../../src/core/world/fronts.js';
import { createObject } from '../../src/core/world/objects.js';
import { recomputeStats } from '../../src/core/world/stats.js';
import { addFront } from '../../src/flows/fronts.js';
import { playerWill, withdraw } from '../../src/flows/will.js';
import { blankCity } from '../helpers/fixtures.js';
import { scriptFrontAgents, stand } from '../helpers/game.js';

const BALLISTA = [
  { stat: 'security', direction: 'up' as const, size: 'large' },
  { stat: 'prosperity', direction: 'down' as const, size: 'small' },
];

function will(args: Record<string, unknown>) {
  return toolReply('submit_will', { goal: 'Построить большую баллисту на стене', ...args });
}

function stage(result: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { title: 'Постройка баллисты', work: 'Каменщики поднимают на стену станину и собирают орудие.', result, site: { name: 'Стройка баллисты', description: 'Леса на стене.' }, outcome_known: true, ...extra };
}

async function town() {
  const s = await stand();
  const city = blankCity();
  city.objects.push(
    createObject(s.r, { id: 'guild', type: 'organization', name: 'Гильдия каменщиков', description: 'Старая гильдия.', statEffect: { prosperity: 5 }, day: 0 }),
    createObject(s.r, { id: 'quarter', type: 'community', name: 'Жители квартала', description: 'Живут под стеной.', day: 0 }),
    createObject(s.r, { id: 'wall', type: 'structure', name: 'Стена', description: 'Старая стена.', statEffect: { security: 5 }, day: 0 }),
  );
  recomputeStats(city, s.r);
  scriptFrontAgents(s.llm, { 'Великая баллиста': BALLISTA });
  s.llm.always(
    'stage-planner',
    toolReply('submit_stages', { stages: [stage({ kind: 'new_object', type: 'structure', name: 'Великая баллиста', description: 'Большое орудие на стене.' })] }),
  );
  return { ...s, city };
}

/** Идущее дело игрока с ведущим маршалом: родитель для стратегий и атомарных дел. */
function running(s: Awaited<ReturnType<typeof town>>, city: City) {
  s.llm.script('will-interpreter', will({ label: 'project' }));
  return playerWill(s.deps, city, 'marshal', 'Построить баллисту', 0).then(() => city.fronts[0]!);
}

describe('воля игрока: новый проект', () => {
  test('баллиста: агенты дают ярлыки, код считает ёмкость, вехи, занятость и скорость', async () => {
    const s = await town();
    const { city } = s;
    s.llm
      .script('will-interpreter', will({ label: 'project', manner: 'Нанять гильдию каменщиков', project_tempo: 'hurry' }))
      .script(
        'footprint-mapper',
        toolReply('submit_footprint', {
          relations: [
            { object_id: 'guild', relation: 'occupies', reason: 'мастера заняты на стройке' },
            { object_id: 'quarter', relation: 'pressures', reason: 'стройка шумит под окнами' },
            { object_id: 'wall', relation: 'linked', reason: 'орудие стоит на стене' },
          ],
        }),
      )
      .script('risk-appraiser', toolReply('submit_risk', { step: 'hard', reason: 'Высота и тяжёлый камень.' }))
      .script('alignment-judge', toolReply('submit_alignment', { verdict: 'spot_on', matched_move: 2 }));

    const out = await playerWill(s.deps, city, 'marshal', 'Пусть маршал строит баллисту, и быстро', 0);

    const front = city.fronts[0]!;
    expect(front).toMatchObject({ form: 'deed', origin: 'player', capacity: 22, milestones: 3, risk: 'hard', tempo: 1, profile: 'security', pulseDay: null, unattainable: null });
    expect(front.stake).toEqual([
      { op: 'create', object: { type: 'structure', name: 'Великая баллиста', description: 'Большое орудие на стене.', points: { prosperity: -2, security: 12, knowledge: 0, influence: 0 }, parentId: null, refs: ['wall'] }, result: true },
    ]);
    expect(front.key).toMatchObject({ twist: null });
    expect(front.key?.moves).toHaveLength(3);
    expect(leadOf(city, front.id)).toMatchObject({ office: 'marshal', text: 'Нанять гильдию каменщиков', verdict: 'spot_on', tempo: 0 });
    expect(city.projects[0]).toMatchObject({ status: 'running', frontId: front.id, stageIndex: 0 });

    // Гильдия занята и даёт городу три четверти вклада; место работ появилось как временный объект.
    expect(city.objects.find((o) => o.id === 'guild')?.occupiedBy).toBe(front.id);
    expect(city.stats.prosperity).toBe(54);
    expect(city.objects.find((o) => o.id === front.siteId)).toMatchObject({ type: 'site', name: 'Стройка баллисты', temporary: true });

    // Скорость: 4 в месяц × «в точку» × спешка проекта × поправка маршала (безопасность 55, дело его профиля).
    expect(front.ratePerDay * 30).toBeCloseTo(4 * 1.5 * 1.2 * 1.07);
    expect(city.jobs.find((j) => j.state === 'pending' && j.payload.frontId === front.id)?.dueDay).toBe(nextEventDay(front));

    expect(out).toMatchObject({ ok: true });
    expect(out.say).toContain('начал работу: Постройка баллисты');
    expect(out.say).toContain('Дело трудное');
    expect(out.say).toContain('Гильдия каменщиков');
    expect(out.say).not.toMatch(/22|7,56/);
    // Начало дела идёт в хронику, но вестью не становится: игрок и так говорит со жрецом.
    expect(city.chronicle.at(-1)).toMatchObject({ source: 'will', frontId: front.id });
    expect(s.llm.callsTo('herald')).toHaveLength(0);
  });

  test('агенты видят только свой вход: оценщику вклада не показывают числа, запечатывателю — участников', async () => {
    const s = await town();
    s.llm.script('will-interpreter', will({ label: 'project' }));
    await playerWill(s.deps, s.city, 'marshal', 'Построить баллисту', 0);
    const appraiser = s.llm.callsTo('contribution-appraiser')[0]!;
    expect(appraiser.messages[0]?.content).toContain('Предмет: «Великая баллиста», большое сооружение');
    expect(appraiser.messages[0]?.content).not.toMatch(/\d/);
    expect(s.llm.callsTo('key-sealer')[0]?.messages[0]?.content).toContain('Нужно скрытое свойство исхода: нет');
    expect(s.llm.callsTo('will-interpreter')[0]?.messages[0]?.content).toContain('маршал Борислав');
  });

  test('занятый сановник: приказ на новое дело не принимается', async () => {
    const s = await town();
    await running(s, s.city);
    s.llm.script('will-interpreter', will({ label: 'project', goal: 'Вырыть колодец' }));
    const out = await playerWill(s.deps, s.city, 'marshal', 'Вырыть колодец', 1);
    expect(out).toMatchObject({ ok: false, error: 'officer_busy' });
    expect(s.city.fronts).toHaveLength(1);
  });

  test('поправка канона: дело идёт с поправленной целью, жрец узнаёт причину', async () => {
    const s = await town();
    s.llm
      .script('will-interpreter', will({ label: 'project', goal: 'Зачаровать стену' }))
      .script('canon-warden', toolReply('submit_canon_verdict', { verdict: 'amended', reason: 'Колдовства в городе нет.', amended_goal: 'Укрепить стену контрфорсами' }));
    const out = await playerWill(s.deps, s.city, 'marshal', 'Зачаровать стену', 0);
    expect(out.ok).toBe(true);
    expect(out.say).toContain('Колдовства в городе нет.');
    expect(s.city.projects[0]?.goal).toBe('Укрепить стену контрфорсами');
    expect(s.llm.callsTo('stage-planner')[0]?.messages[0]?.content).toContain('Укрепить стену контрфорсами');
  });
});

describe('недостижимая цель', () => {
  const doomed = toolReply('submit_canon_verdict', { verdict: 'unattainable', reason: 'Под островом нет земли, до которой можно дотянуться.' });

  test('сначала предупреждение, повторный приказ запускает дело, которое кончится крахом', async () => {
    const s = await town();
    const { city } = s;
    s.llm.always('will-interpreter', will({ label: 'project', goal: 'Построить подъёмник до земли' })).always('canon-warden', doomed);

    const first = await playerWill(s.deps, city, 'marshal', 'Построить подъёмник до земли', 5);
    expect(first).toMatchObject({ ok: false, error: 'unattainable' });
    expect(first.say).toContain('Под островом нет земли');
    expect(city.unattainableWarning).toEqual({ goal: 'Построить подъёмник до земли', day: 5 });
    expect(city.fronts).toHaveLength(0);
    expect(s.llm.callsTo('role-fitter')).toHaveLength(0);

    const second = await playerWill(s.deps, city, 'marshal', 'Я сказал: строить подъёмник', 6);
    expect(second.ok).toBe(true);
    const front = city.fronts[0]!;
    expect(front).toMatchObject({ risk: 'impossible', unattainable: 'Под островом нет земли, до которой можно дотянуться.', pulseDay: 36 });
    expect(front.milestones).toBeGreaterThanOrEqual(2);
    expect(city.projects[0]).toMatchObject({ unattainable: front.unattainable, status: 'running' });
    expect(city.projects[0]?.stages).toHaveLength(1);
    expect(city.unattainableWarning).toBeNull();
    // Ступень недостижимому делу ставит код, оценщика риска не спрашивают.
    expect(s.llm.callsTo('risk-appraiser')).toHaveLength(0);
  });

  test('другая недостижимая цель получает своё предупреждение; старое предупреждение выдыхается', async () => {
    const s = await town();
    const { city } = s;
    s.llm.always('will-interpreter', will({ label: 'project', goal: 'Взорвать остров' })).always('canon-warden', doomed);
    city.unattainableWarning = { goal: 'Построить подъёмник до земли', day: 5 };
    s.llm.script('role-fitter', toolReply('submit_fit', { fits: false, reason: 'Другой замысел.' }));
    expect(await playerWill(s.deps, city, 'marshal', 'Взорвать остров', 6)).toMatchObject({ ok: false, error: 'unattainable' });
    expect(city.unattainableWarning).toEqual({ goal: 'Взорвать остров', day: 6 });

    const late = 6 + s.r.fronts.unattainableWarnDays + 1;
    expect(await playerWill(s.deps, city, 'marshal', 'Взорвать остров', late)).toMatchObject({ ok: false, error: 'unattainable' });
    expect(city.fronts).toHaveLength(0);
  });
});

describe('стратегия, темп, отмена', () => {
  test('стратегия ставит сановника ведущим; вердикт хранится и задаёт скорость', async () => {
    const s = await town();
    const { city } = s;
    const threat = addFront(
      s.deps,
      city,
      createFront({ id: 'thr', form: 'threat', origin: 'echo', title: 'Стена оседает', description: 'Кладка пошла трещинами.', capacity: 4, deadlineDay: 120, key: { moves: ['Подвести контрфорсы.', 'Отвести воду.', 'Снять лишний груз.'], twist: null }, day: 0 }),
      0,
    );
    s.llm
      .script('will-interpreter', will({ label: 'strategy', front_id: 'thr', goal: 'Заняться стеной', manner: 'Молиться у стены', work_tempo: 'careful' }))
      .script('alignment-judge', toolReply('submit_alignment', { verdict: 'off' }));
    const out = await playerWill(s.deps, city, 'keeper', 'Пусть хранительница молится у стены, не торопясь', 0);
    expect(out.ok).toBe(true);
    expect(leadOf(city, 'thr')).toMatchObject({ office: 'keeper', text: 'Молиться у стены', verdict: 'off', tempo: -1 });
    expect(threat.ratePerDay * 30).toBeCloseTo(4 * 0.5 * 0.8 * 0.9);
    // Вердикт жрецу не сообщается: ключ запечатан.
    expect(out.say).not.toMatch(/мимо|не годится|off/);

    // Тот же сановник меняет стратегию; чужой сановник на занятое дело не встаёт.
    s.llm
      .script('will-interpreter', will({ label: 'strategy', front_id: 'thr', goal: 'Подвести контрфорсы', manner: 'Подвести контрфорсы' }))
      .script('alignment-judge', toolReply('submit_alignment', { verdict: 'spot_on', matched_move: 1 }));
    await playerWill(s.deps, city, 'keeper', 'Подвести контрфорсы', 3);
    expect(leadOf(city, 'thr')).toMatchObject({ verdict: 'spot_on', text: 'Подвести контрфорсы', tempo: -1 });
    expect(city.assignments).toHaveLength(1);

    s.llm.script('will-interpreter', will({ label: 'strategy', front_id: 'thr', goal: 'Помочь' }));
    expect(await playerWill(s.deps, city, 'marshal', 'Маршал, помоги', 3)).toMatchObject({ ok: false, error: 'has_lead' });
  });

  test('часы работой не сдвинуть', async () => {
    const s = await town();
    addFront(s.deps, s.city, createFront({ id: 'clk', form: 'clock', origin: 'complication', title: 'Старая кузня пустеет', description: '', capacity: 0, deadlineDay: 120, day: 0 }), 0);
    s.llm.script('will-interpreter', will({ label: 'strategy', front_id: 'clk', goal: 'Спасти кузню' }));
    expect(await playerWill(s.deps, s.city, 'keeper', 'Спасти кузню', 0)).toMatchObject({ ok: false, error: 'only_wait' });
  });

  test('темп проекта и темп поручения — разные рычаги', async () => {
    const s = await town();
    const front = await running(s, s.city);
    const base = front.ratePerDay;
    s.llm.script('will-interpreter', will({ label: 'tempo', front_id: front.id, project_tempo: 'hurry', work_tempo: 'hurry' }));
    const out = await playerWill(s.deps, s.city, 'marshal', 'Торопи стройку и сам торопись', 2);
    expect(out.ok).toBe(true);
    expect(front.tempo).toBe(1);
    expect(leadOf(s.city, front.id)?.tempo).toBe(1);
    expect(front.ratePerDay / base).toBeCloseTo(1.4);
    expect(out.say).toContain('Спешка ускоряет работу и чаще приводит к бедам');
  });

  test('отмена: своё дело прекращается, начатое остаётся стоять; чужую беду отменить нельзя', async () => {
    const s = await town();
    const { city } = s;
    const front = await running(s, city);
    addFront(s.deps, city, createFront({ id: 'thr', form: 'threat', origin: 'story', title: 'Чужая беда', description: '', capacity: 4, deadlineDay: 120, day: 0 }), 0);
    s.llm.script('will-interpreter', will({ label: 'cancel', front_id: 'thr', goal: 'Отменить' }));
    expect(await playerWill(s.deps, city, 'keeper', 'Отменить беду', 1)).toMatchObject({ ok: false, error: 'not_ours' });

    s.llm.script('will-interpreter', will({ label: 'cancel', front_id: front.id, goal: 'Бросить стройку' }));
    const out = await playerWill(s.deps, city, 'marshal', 'Бросить стройку', 4);
    expect(out.ok).toBe(true);
    expect(front.status).toBe('cancelled');
    expect(city.projects[0]?.status).toBe('cancelled');
    expect(city.officers.every((o) => !o.assignmentId)).toBe(true);
    expect(city.objects.find((o) => o.id === front.siteId)).toMatchObject({ status: 'active', temporary: false });
    expect(city.jobs.some((j) => j.state === 'pending' && j.payload.frontId === front.id)).toBe(false);
    expect(city.chronicle.at(-1)?.source).toBe('will');
  });

  test('снятый ведущий оставляет большое дело стоять', async () => {
    const s = await town();
    const front = await running(s, s.city);
    const out = withdraw(s.deps, s.city, 'marshal', 3);
    expect(out.ok).toBe(true);
    expect(front).toMatchObject({ status: 'active', ratePerDay: 0 });
    expect(withdraw(s.deps, s.city, 'marshal', 3)).toMatchObject({ ok: false, error: 'not_busy' });
  });
});

describe('атомарные дела', () => {
  test('разовый вклад, помощник и расчистка помехи — дочерние дела со своей ценой и ставкой', async () => {
    const s = await town();
    const { city } = s;
    const parent = await running(s, city);
    city.objects.push(createObject(s.r, { id: 'rubble', type: 'threat', name: 'Завал на подвозе', description: 'Камень лежит поперёк дороги.', temporary: true, attach: { frontId: parent.id, rate: -2 }, day: 0 }));

    // Разовый вклад: 15% ёмкости родителя; «в точку» увеличивает сам толчок.
    s.llm
      .script('will-interpreter', will({ label: 'deed', front_id: parent.id, deed_kind: 'push', goal: 'Привезти гранит из каменоломни', manner: 'Договориться с теми, кого это касается' }))
      .script('alignment-judge', toolReply('submit_alignment', { verdict: 'spot_on', matched_move: 2 }))
      .script('risk-appraiser', toolReply('submit_risk', { step: 'normal' }));
    const push = await playerWill(s.deps, city, 'keeper', 'Пусть хранительница привезёт гранит', 1);
    expect(push.ok).toBe(true);
    const pushFront = city.fronts.at(-1)!;
    expect(pushFront).toMatchObject({ origin: 'deed', parentId: parent.id, capacity: 3.3, milestones: 1, risk: 'normal', deed: { kind: 'push', verdict: 'spot_on' } });
    expect(pushFront.stake[0]).toMatchObject({ op: 'progress', frontId: parent.id });
    expect((pushFront.stake[0] as { amount: number }).amount).toBeCloseTo(3.3 * 1.5);
    expect(leadOf(city, pushFront.id)).toMatchObject({ office: 'keeper', verdict: 'fits' });

    // Помощник: Планировщик называет, кого привлечь, цена считается как у нового объекта.
    s.llm
      .script('will-interpreter', will({ label: 'deed', front_id: parent.id, deed_kind: 'helper', goal: 'Нанять артель возчиков' }))
      .script('stage-planner', toolReply('submit_stages', { stages: [stage({ kind: 'new_object', type: 'community', name: 'Артель возчиков', description: 'Наёмные возчики с телегами.' }, { title: 'Наём артели' })] }));
    await playerWill(s.deps, city, 'treasurer', 'Пусть казначей наймёт возчиков', 1);
    const helperFront = city.fronts.at(-1)!;
    expect(helperFront).toMatchObject({ origin: 'deed', capacity: 3, deed: { kind: 'helper' } });
    expect(helperFront.stake[0]).toMatchObject({ op: 'attach', frontId: parent.id, rate: 2, object: { name: 'Артель возчиков', type: 'community' } });

    // Расчистка: помеха названа в приказе.
    s.llm.script('will-interpreter', will({ label: 'deed', front_id: parent.id, deed_kind: 'clear', goal: 'Разобрать завал на подвозе' }));
    await playerWill(s.deps, city, 'chancellor', 'Пусть канцлер разберёт завал', 1);
    const clearFront = city.fronts.at(-1)!;
    expect(clearFront).toMatchObject({ capacity: 3.3, deed: { kind: 'clear', targetId: 'rubble' }, stake: [{ op: 'delete', target: 'rubble' }] });

    expect(city.officers.every((o) => o.assignmentId)).toBe(true);
    // Исполнитель, снятый с атомарного дела, уносит его с собой.
    withdraw(s.deps, city, 'chancellor', 2);
    expect(clearFront.status).toBe('cancelled');
    expect(parent.status).toBe('active');
  });

  test('расчищать нечего — дело не заводится', async () => {
    const s = await town();
    const parent = await running(s, s.city);
    s.llm.script('will-interpreter', will({ label: 'deed', front_id: parent.id, deed_kind: 'clear', goal: 'Разобрать завал' }));
    expect(await playerWill(s.deps, s.city, 'keeper', 'Разобрать завал', 1)).toMatchObject({ ok: false, error: 'no_hindrance' });
    expect(s.city.fronts).toHaveLength(1);
  });
});
