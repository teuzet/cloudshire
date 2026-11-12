import { describe, expect, test } from 'vitest';
import { toolReply } from '../../src/adapters/llm/fake.js';
import { priestTurnBlock } from '../../src/agents/priest/run.js';
import type { City, Front } from '../../src/core/city.js';
import type { Rules } from '../../src/core/rules.js';
import { leadOf } from '../../src/core/world/assignments.js';
import { buildBound, buildOpportunity, buildSide, type EventDress } from '../../src/core/world/complications.js';
import { createFront, isFrozen, nextEventDay } from '../../src/core/world/fronts.js';
import { attachedTo, createObject } from '../../src/core/world/objects.js';
import { recomputeStats } from '../../src/core/world/stats.js';
import { today } from '../../src/flows/context.js';
import { processDue } from '../../src/flows/day.js';
import { addFront } from '../../src/flows/fronts.js';
import { playerWill } from '../../src/flows/will.js';
import { blankCity, rng } from '../helpers/fixtures.js';
import { costume, lastUser, rulesWith, scriptFrontAgents, stand } from '../helpers/game.js';

const up = (stat: string, size: string) => ({ stat, direction: 'up' as const, size });
const down = (stat: string, size: string) => ({ stat, direction: 'down' as const, size });
const zero = { prosperity: 0, security: 0, knowledge: 0, influence: 0 };
const dress: EventDress = { title: 'Ропот квартала', description: 'Жители недовольны.', outburst: 'Квартал перекроет подвоз.', newObject: null };

function will(args: Record<string, unknown>) {
  return toolReply('submit_will', { goal: 'Построить большую баллисту на стене', ...args });
}

function stage(title: string, result: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { title, work: `${title}: идёт работа.`, result, site: { name: `Работы: ${title}`, description: '' }, outcome_known: true, ...extra };
}

type Stand = Awaited<ReturnType<typeof stand>> & { city: City };

async function town(dynamics: string[], tweak: (r: Rules) => void = () => {}, appraisals: Parameters<typeof scriptFrontAgents>[1] = {}): Promise<Stand> {
  const s = await stand();
  s.deps.rules = rulesWith(dynamics, tweak);
  const city = blankCity();
  city.objects.push(
    createObject(s.r, { id: 'guild', type: 'organization', name: 'Гильдия каменщиков', description: 'Старая гильдия.', statEffect: { prosperity: 5 }, day: 0 }),
    createObject(s.r, { id: 'quarter', type: 'community', name: 'Жители квартала', description: 'Живут под стеной.', day: 0 }),
    createObject(s.r, { id: 'wall', type: 'structure', name: 'Стена', description: 'Старая стена.', statEffect: { security: 5 }, day: 0 }),
    createObject(s.r, { id: 'tower', type: 'structure', name: 'Сторожевая башня', description: 'Башня на стене.', statEffect: { security: 5 }, refs: ['wall'], day: 0 }),
  );
  recomputeStats(city, s.r);
  scriptFrontAgents(s.llm, {
    'Великая баллиста': [up('security', 'large'), down('prosperity', 'small')],
    'Гильдия каменщиков': [up('prosperity', 'medium')],
    'Стена': [up('security', 'medium')],
    'Сторожевая башня': [up('security', 'medium')],
    ...appraisals,
  });
  s.llm
    .always('stage-planner', toolReply('submit_stages', { stages: [stage('Постройка баллисты', { kind: 'new_object', type: 'structure', name: 'Великая баллиста', description: 'Большое орудие на стене.' })] }))
    .always(
      'footprint-mapper',
      toolReply('submit_footprint', {
        relations: [
          { object_id: 'guild', relation: 'occupies', reason: 'мастера заняты на стройке' },
          { object_id: 'quarter', relation: 'pressures', reason: 'стройка шумит под окнами' },
          { object_id: 'wall', relation: 'linked', reason: 'орудие стоит на стене' },
        ],
      }),
    );
  return { ...s, city };
}

async function start(s: Stand, risk: string, text = 'Построить баллисту'): Promise<Front> {
  s.llm.script('will-interpreter', will({ label: 'project' })).script('risk-appraiser', toolReply('submit_risk', { step: risk }));
  const out = await playerWill(s.deps, s.city, 'marshal', text, await now(s));
  expect(out.ok).toBe(true);
  return s.city.fronts.at(-1)!;
}

async function now(s: Stand): Promise<number> {
  return today(s.deps, (await s.deps.storage.getWorld())!);
}

/** Дожить до дня `day` и разобрать всё, что наступило. */
async function at(s: Stand, day: number) {
  const world = (await s.deps.storage.getWorld())!;
  s.passDays(Math.max(0, day - today(s.deps, world)));
  return processDue(s.deps, world, s.city);
}

/** Дожить до ближайшего события фронта. */
async function next(s: Stand, front: Front) {
  const day = nextEventDay(front);
  if (day == null) throw new Error(`фронт ${front.title} стоит`);
  return at(s, day);
}

const fireAlways = (step: 'hard' | 'risky') => (r: Rules) => {
  r.fronts.risk.chance[step] = 1;
  r.fronts.risk.heavyShare[step] = 1;
};

describe('баллиста: от приказа до результата', () => {
  test('веха → привязанная угроза → её сняли → дело доведено → результат в городе', async () => {
    const s = await town(['key-refuse'], fireAlways('hard'));
    const { city } = s;
    const front = await start(s, 'hard');
    s.llm.script('costumer', costume('Гильдия грозит бросить стройку'));

    // Первая веха: кубик срабатывает, гильдия получает роль, дело встаёт.
    const news = await next(s, front);
    const threat = city.fronts.at(-1)!;
    expect(front.milestonesFired).toBe(1);
    expect(threat).toMatchObject({ form: 'threat', origin: 'complication', parentId: front.id, bound: 'rollback', dynamicId: 'key-refuse', refs: ['guild'], capacity: 2.93 });
    expect(threat.deadlineDay! - threat.createdDay).toBe(30);
    expect(threat.failStake).toEqual([{ op: 'rollback', frontId: front.id }]);
    expect(threat.key?.moves).toHaveLength(3);
    expect(isFrozen(city, front)).toBe(true);
    expect(front.ratePerDay).toBe(0);
    expect(city.dynamicsUsed['key-refuse']).toBe(threat.createdDay);
    expect(news).toHaveLength(1);
    expect(city.chronicle.at(-1)).toMatchObject({ source: 'milestone', frontId: front.id, text: 'Шаг дела «Постройка баллисты». Слух: Гильдия грозит бросить стройку.' });

    // Что именно показали узким агентам.
    const fitter = lastUser(s.llm.callsTo('role-fitter')[0]!);
    expect(fitter).toContain('Вопрос: «Этим людям от работы стало заметно тяжелее?»');
    expect(fitter).toContain('Гильдия каменщиков');
    expect(lastUser(s.llm.callsTo('costumer')[0]!)).toContain('Род события: ');
    expect(lastUser(s.llm.callsTo('key-sealer').at(-1)!)).toContain('Обычно помогает: уступка в оплате или отдыхе');
    expect(lastUser(s.llm.callsTo('chronicler').at(-1)!)).toContain('Дело «Постройка баллисты» встало, пока не снята угроза');

    // Хранительница берёт угрозу стратегией «в точку» и успевает до срока.
    s.deps.rules.fronts.risk.chance.hard = 0;
    s.llm
      .script('will-interpreter', will({ label: 'strategy', front_id: threat.id, goal: 'Унять гильдию', manner: 'Договориться с теми, кого это касается' }))
      .script('alignment-judge', toolReply('submit_alignment', { verdict: 'spot_on', matched_move: 2 }))
      .script('faith-appraiser', toolReply('submit_faith', { case: 'harm_averted', strength: 'notable' }));
    expect((await playerWill(s.deps, city, 'keeper', 'Пусть хранительница договорится с гильдией', await now(s))).ok).toBe(true);
    const faithBefore = city.faith.value;
    const averted = await next(s, threat);
    expect(threat).toMatchObject({ status: 'done' });
    expect(threat.resolvedDay!).toBeLessThan(threat.deadlineDay!);
    expect(city.faith.value).toBeGreaterThan(faithBefore);
    expect(city.officers.find((o) => o.office === 'keeper')?.assignmentId).toBeNull();
    expect(isFrozen(city, front)).toBe(false);
    expect(front.ratePerDay).toBeGreaterThan(0);
    expect(averted).toHaveLength(1);
    expect(city.chronicle.at(-1)).toMatchObject({ source: 'completion', frontId: threat.id });
    expect(lastUser(s.llm.callsTo('resolver')[0]!)).toContain('Исход: беду отвели вовремя');
    expect(lastUser(s.llm.callsTo('faith-appraiser')[0]!)).toContain('Отвести её велел бог');

    // Дело доходит до конца: результат создан, занятое свободно, проект закрыт.
    await next(s, front);
    expect(front.milestonesFired).toBe(2);
    await next(s, front);
    expect(front.status).toBe('done');
    const ballista = city.objects.find((o) => o.name === 'Великая баллиста')!;
    expect(ballista).toMatchObject({ type: 'structure', refs: ['wall'], themes: ['камень'], temporary: false });
    expect(city.stats).toMatchObject({ security: 50 + 5 + 5 + 12, prosperity: 50 + 5 - 2 });
    expect(city.objects.find((o) => o.id === 'guild')?.occupiedBy).toBeNull();
    expect(city.objects.find((o) => o.id === front.siteId)?.status).toBe('deleted');
    expect(city.projects[0]).toMatchObject({ status: 'done', frontId: null });
    expect(city.officers.every((o) => !o.assignmentId)).toBe(true);
    expect(city.chronicle.at(-1)).toMatchObject({ source: 'completion', frontId: front.id });
    expect(lastUser(s.llm.callsTo('herald').at(-1)!)).toContain('Повод: развязка');
    expect(lastUser(s.llm.callsTo('chronicler').at(-1)!)).toContain('Появилось: Великая баллиста (большое сооружение)');
    // Связанные объекты переоценены, но вклад не изменился: эхо не пошло.
    expect(city.fronts.filter((f) => f.status === 'active')).toHaveLength(0);
    expect(city.jobs.filter((j) => j.state === 'pending')).toHaveLength(0);
  });

  test('угрозу не сняли на ступени «сложно»: дело откатывается на веху и идёт дальше', async () => {
    const s = await town(['key-refuse'], fireAlways('hard'));
    const { city } = s;
    const front = await start(s, 'hard');
    s.llm.script('costumer', costume('Гильдия грозит бросить стройку')).script('faith-appraiser', toolReply('submit_faith', { case: 'harm_willed', strength: 'notable' }));
    await next(s, front);
    const threat = city.fronts.at(-1)!;
    s.deps.rules.fronts.risk.chance.hard = 0;

    await at(s, threat.deadlineDay!);
    expect(threat.status).toBe('failed');
    expect(front).toMatchObject({ status: 'active', milestonesFired: 0, progress: 0 });
    expect(front.ratePerDay).toBeGreaterThan(0);
    expect(city.faith.value).toBeLessThan(55);
    expect(city.chronicle.at(-1)).toMatchObject({ source: 'deadline', frontId: threat.id });
    const resolver = lastUser(s.llm.callsTo('resolver')[0]!);
    expect(resolver).toContain('Исход: беда случилась. дело, которому это грозило, откатилось на шаг назад');
    expect(lastUser(s.llm.callsTo('faith-appraiser')[0]!)).toContain('Беда пришла от дела, которое велел бог. Унять её никто не взялся.');
  });

  test('на ступени «рискованно» несброшенная угроза срывает дело целиком', async () => {
    const s = await town(['touched-resist'], fireAlways('risky'));
    const { city } = s;
    const front = await start(s, 'risky');
    s.llm.script('costumer', costume('Квартал перекрыл подвоз'));
    await next(s, front);
    const threat = city.fronts.at(-1)!;
    expect(threat).toMatchObject({ bound: 'cancel', atStake: 22, capacity: 8.8, refs: ['quarter'] });
    await at(s, threat.deadlineDay!);
    expect(front.status).toBe('cancelled');
    expect(city.projects[0]?.status).toBe('cancelled');
    expect(city.objects.find((o) => o.id === front.siteId)).toMatchObject({ status: 'active', temporary: false });
    expect(city.objects.some((o) => o.name === 'Великая баллиста')).toBe(false);
    expect(city.officers.every((o) => !o.assignmentId)).toBe(true);
  });
});

describe('другие исходы броска', () => {
  test('авария съедает часть сделанного и оставляет помеху; атомарное дело её убирает', async () => {
    const s = await town(['accident'], fireAlways('risky'));
    const { city } = s;
    const front = await start(s, 'risky');
    s.llm.script('costumer', costume('Обрушились леса', { new_object: { type: 'threat', name: 'Завал из лесов', description: 'Брёвна и камень лежат на стене.' } }));
    const clean = front.ratePerDay;
    await next(s, front);
    expect(front.progress).toBeCloseTo((22 / 3) * 0.75, 1);
    const rubble = attachedTo(city, front.id)[0]!;
    expect(rubble).toMatchObject({ name: 'Завал из лесов', temporary: true, attach: { rate: -2 }, parentId: front.siteId });
    expect((clean - front.ratePerDay) * 30).toBeCloseTo(2);
    expect(city.fronts.filter((f) => f.status === 'active')).toHaveLength(1);
    expect(s.llm.callsTo('faith-appraiser')).toHaveLength(1);
    expect(city.chronicle.at(-1)?.text).toContain('Обрушились леса');

    // Расчистка: дочернее дело, по завершении помеха исчезает и скорость возвращается.
    s.deps.rules.fronts.risk.chance.risky = 0;
    s.llm.script('will-interpreter', will({ label: 'deed', front_id: front.id, deed_kind: 'clear', goal: 'Разобрать завал из лесов' }));
    await playerWill(s.deps, city, 'keeper', 'Разобрать завал', await now(s));
    const clear = city.fronts.at(-1)!;
    await next(s, clear);
    expect(clear.status).toBe('done');
    expect(rubble.status).toBe('deleted');
    expect(front.ratePerDay).toBeCloseTo(clean);
    expect(city.chronicle.at(-1)).toMatchObject({ source: 'completion', frontId: front.id });
  });

  test('разовый вклад двигает родителя сразу на свою долю', async () => {
    const s = await town([]);
    const { city } = s;
    const front = await start(s, 'safe');
    s.llm.script('will-interpreter', will({ label: 'deed', front_id: front.id, deed_kind: 'push', goal: 'Привезти гранит' }));
    await playerWill(s.deps, city, 'keeper', 'Привезти гранит', 0);
    const push = city.fronts.at(-1)!;
    const day = nextEventDay(push)!;
    await at(s, day);
    expect(push.status).toBe('done');
    expect(front.progress).toBeCloseTo(front.ratePerDay * day + 3.3);
    expect(city.officers.find((o) => o.office === 'keeper')?.assignmentId).toBeNull();
  });

  test('третий сработавший бросок приносит удобный случай; им можно воспользоваться или упустить', async () => {
    const s = await town(['find-at-works'], fireAlways('hard'), { 'Жила небесного железа': [up('prosperity', 'medium')] });
    const { city } = s;
    const front = await start(s, 'hard');
    front.rollsFired = 2;
    s.llm.script('costumer', costume('В кладке нашли жилу', { new_object: { type: 'resource', name: 'Жила небесного железа', description: 'Тяжёлая синяя руда в теле стены.' } }));
    await next(s, front);
    const chance = city.fronts.at(-1)!;
    expect(chance).toMatchObject({ form: 'deed', plus: true, origin: 'complication', capacity: 3.5, atStake: 7, parentId: null });
    expect(chance.deadlineDay! - chance.createdDay).toBe(120);
    expect(chance.stake[0]).toMatchObject({ op: 'create', object: { name: 'Жила небесного железа', points: { prosperity: 5 } } });
    expect(front.rollsFired).toBe(3);

    // Никто не взялся: срок вышел, случай тихо исчез.
    s.deps.rules.fronts.risk.chance.hard = 0;
    await at(s, chance.deadlineDay!);
    expect(chance.status).toBe('cancelled');
    expect(city.objects.some((o) => o.name === 'Жила небесного железа')).toBe(false);
    expect(city.chronicle.some((e) => e.text.includes('Случай упущен'))).toBe(true);
    expect(s.llm.callsTo('herald').some((req) => lastUser(req).includes('Случай упущен'))).toBe(false);
  });

  test('словарь не подошёл: Сочинитель динамики пишет свободную, пробел идёт в лог', async () => {
    const s = await town([], fireAlways('hard'));
    const { city } = s;
    const gaps: string[] = [];
    s.deps.log = { warn: (event) => gaps.push(event) };
    const front = await start(s, 'hard');
    s.llm
      .script('dynamics-composer', toolReply('submit_dynamic', { shape: 'tension', target: 'object', object_id: 'quarter', skeleton: 'Жители устали от шума и копят обиду.', helps: 'Тишина по ночам' }))
      .script('costumer', costume('Квартал копит обиду'));
    await next(s, front);
    const tension = city.fronts.at(-1)!;
    expect(gaps).toContain('dictionary_gap');
    expect(tension).toMatchObject({ form: 'tension', origin: 'complication', parentId: null, dynamicId: null, refs: ['quarter'] });
    // Оценщик вклада не увидел разницы, поэтому на кону малый урон главному стату объекта.
    expect(tension.failStake[0]).toMatchObject({ op: 'revalue', target: 'quarter', points: { prosperity: -2 } });
    expect(isFrozen(city, front)).toBe(false);
  });
});

describe('сроки', () => {
  test('напряжение прорывается в угрозу с коротким сроком; часы просто приходят', async () => {
    const s = await town([]);
    const { city } = s;
    const tower = city.objects.find((o) => o.id === 'tower')!;
    const built = buildSide(s.r, city, { shape: 'tension', origin: 'complication', target: tower, newPoints: zero, dress, key: null, dynamicId: null, id: 'tns', day: 0, rng: rng(2) });
    built.deadlineDay = 60;
    const tension = addFront(s.deps, city, built, 0);
    const clock = addFront(s.deps, city, buildSide(s.r, city, { shape: 'clock', origin: 'complication', target: city.objects[0]!, newPoints: zero, dress: { ...dress, title: 'Гильдия пустеет' }, key: null, dynamicId: null, id: 'clk', day: 0, rng: rng(2) }), 0);
    const burstDay = tension.deadlineDay!;

    const news = await at(s, burstDay);
    expect(tension).toMatchObject({ form: 'threat', status: 'active', capacity: 2, deadlineDay: burstDay + 30 });
    expect(news).toHaveLength(1);
    expect(city.chronicle.at(-1)?.text).toContain('Квартал перекроет подвоз.');

    // Угрозу никто не снял: башня теряет вклад, описание переписано.
    await at(s, burstDay + 30);
    expect(tension.status).toBe('failed');
    expect(tower.statEffect.security).toBe(0);
    expect(tower.description).toContain('Теперь иначе.');
    expect(city.stats.security).toBe(55);

    await at(s, clock.deadlineDay!);
    expect(clock.status).toBe('done');
    expect(city.objects[0]!.statEffect.prosperity).toBe(0);
  });

  test('мелкое привязанное напряжение прорывается помехой на деле', async () => {
    const s = await town([]);
    const { city } = s;
    const front = await start(s, 'normal');
    const tension = addFront(s.deps, city, buildBound(s.r, front, { shape: 'tension', dress, key: null, dynamicId: null, roleId: 'quarter', id: 'tns', day: 0, rng: rng(2) }), 0);
    expect(tension.bound).toBe('slow');
    const clean = front.ratePerDay;
    await at(s, tension.deadlineDay!);
    expect(tension.status).toBe('failed');
    expect(attachedTo(city, front.id).map((o) => o.attach?.rate)).toEqual([-2]);
    expect(front.ratePerDay).toBeLessThan(clean);
  });

  test('удобным случаем воспользовались: ставка сработала', async () => {
    const s = await town([]);
    const { city } = s;
    const chance = addFront(
      s.deps,
      city,
      buildOpportunity(s.r, { origin: 'echo', stake: [{ op: 'revalue', target: 'tower', points: { ...zero, security: 12 } }], gain: 8, dress: { ...dress, title: 'Башне нашлось новое дело' }, key: null, dynamicId: null, refs: ['tower'], id: 'opp', day: 0 }),
      0,
    );
    s.llm.script('will-interpreter', will({ label: 'strategy', front_id: 'opp', goal: 'Занять башню делом' }));
    await playerWill(s.deps, city, 'marshal', 'Занять башню делом', 0);
    await next(s, chance);
    expect(chance.status).toBe('done');
    expect(city.objects.find((o) => o.id === 'tower')?.statEffect.security).toBe(12);
    expect(lastUser(s.llm.callsTo('faith-appraiser').at(-1)!)).toContain('Случай выпал сам; воспользоваться им велел бог.');
  });
});

describe('этапы, подвох, эхо и обновление', () => {
  test('исход с подвохом меняет результат; следующий этап ждёт слова игрока', async () => {
    const s = await town([], (r) => {
      r.fronts.outcome = { asPlanned: 0, twist: 1 };
    }, { 'Поющая шахта': [up('knowledge', 'medium')], 'Школа резонанса': [up('knowledge', 'large')] });
    const { city } = s;
    s.llm.always(
      'stage-planner',
      toolReply('submit_stages', {
        stages: [
          stage('Пробить шахту к поющим кристаллам', { kind: 'new_object', type: 'site', name: 'Поющая шахта', description: 'Шахта к жиле кристаллов.' }, { outcome_known: false }),
          stage('Открыть школу резонанса', { kind: 'new_object', type: 'organization', name: 'Школа резонанса', description: 'Школа при шахте.' }),
        ],
      }),
    );
    const front = await start(s, 'safe', 'Добыть поющие кристаллы и открыть при них школу');
    expect(front.key?.twist).toBe('У результата есть скрытая сторона.');
    expect(front.capacity).toBe(9);
    expect(priestTurnBlock(s.deps.rules, city, 0)).not.toContain('скрытая сторона');

    // Подвох открывается на завершении: описание переписано, вклад переоценён, факт записан.
    s.llm.script('contribution-appraiser', toolReply('submit_contribution', { effects: [up('knowledge', 'medium'), down('security', 'small')] }));
    await next(s, front);
    await next(s, front);
    const mine = city.objects.find((o) => o.name === 'Поющая шахта')!;
    expect(mine.description).toBe('Шахта к жиле кристаллов. Теперь иначе.');
    expect(mine.statEffect).toMatchObject({ knowledge: 5, security: -2 });
    expect(city.facts.at(-1)).toMatchObject({ text: 'У результата есть скрытая сторона.', author: 'event' });
    expect(lastUser(s.llm.callsTo('beat-writer').at(-1)!)).toContain('Открывается сведение: У результата есть скрытая сторона.');

    // Проект ждёт; жрец видит его в блоке хода; слово игрока запускает следующий этап.
    expect(city.projects[0]).toMatchObject({ status: 'waiting', stageIndex: 1, frontId: null });
    expect(city.chronicle.at(-1)?.text).toContain('ждёт слова покровителя. Следующий шаг: Открыть школу резонанса.');
    expect(lastUser(s.llm.callsTo('herald').at(-1)!)).toContain('Повод: событие');
    expect(priestTurnBlock(s.deps.rules, city, await now(s))).toContain('Замыслы, которые ждут слова покровителя');

    s.llm.script('will-interpreter', will({ label: 'continue', project_id: city.projects[0]!.id, goal: 'Продолжать' }));
    const out = await playerWill(s.deps, city, 'keeper', 'Продолжай со школой', await now(s));
    expect(out.ok).toBe(true);
    const second = city.fronts.at(-1)!;
    expect(second).toMatchObject({ title: 'Открыть школу резонанса', capacity: 16, projectId: city.projects[0]!.id });
    expect(second.key?.twist).toBeNull();
    while (second.status === 'active') await next(s, second);
    expect(city.projects[0]?.status).toBe('done');
    expect(city.objects.some((o) => o.name === 'Школа резонанса')).toBe(true);
  });

  test('перемена идёт эхом по связям и обновляет соседние дела', async () => {
    const s = await town([]);
    const { city } = s;
    city.objects.push(createObject(s.r, { id: 'market', type: 'district', name: 'Рынок у стены', description: 'Лавки под стеной.', statEffect: { prosperity: 5 }, refs: ['wall'], day: 0 }));
    recomputeStats(city, s.r);
    // Соседнее дело касается стены: у него есть ведущий со стратегией.
    const search = addFront(
      s.deps,
      city,
      createFront({ id: 'srch', form: 'find', origin: 'story', title: 'Ход под стеной', description: 'Ищут старый ход.', capacity: 30, milestones: 1, refs: ['wall'], key: { moves: ['Простукать кладку.', 'Поднять старые планы.', 'Расспросить каменщиков.'], twist: null }, day: 0 }),
      0,
    );
    s.llm.script('will-interpreter', will({ label: 'strategy', front_id: 'srch', goal: 'Искать ход', manner: 'Простукать кладку' }));
    await playerWill(s.deps, city, 'keeper', 'Искать ход', 0);

    s.llm.always('stage-planner', toolReply('submit_stages', { stages: [stage('Разобрать стену на камень', { kind: 'change_object', object_id: 'wall', name: 'Стена', description: 'От стены остался низкий вал.' })] }));
    s.llm.always('footprint-mapper', toolReply('submit_footprint', { relations: [] }));
    s.llm.script('contribution-appraiser', toolReply('submit_contribution', { effects: [] }));
    const front = await start(s, 'safe', 'Разобрать стену на камень');
    expect(front.capacity).toBe(5 + 4);
    expect(front.stake[0]).toMatchObject({ op: 'revalue', target: 'wall', description: 'От стены остался низкий вал.' });

    // После перемены: башня без стены теряет (минус → угроза эха), рынок выигрывает (плюс → случай).
    s.llm
      .always('contribution-appraiser', (req) => {
        const name = /Предмет: «([^»]+)»/.exec(lastUser(req))?.[1];
        const effects = name === 'Сторожевая башня' ? [] : name === 'Рынок у стены' ? [up('prosperity', 'large')] : [up('security', 'medium')];
        return toolReply('submit_contribution', { effects });
      })
      .always('costumer', (req) => costume(lastUser(req).includes('Сторожевая башня') ? 'Башня без стены' : 'Рынку стало просторно'))
      .script('alignment-judge', toolReply('submit_alignment', { verdict: 'off' }));
    while (front.status === 'active') await next(s, front);

    const wall = city.objects.find((o) => o.id === 'wall')!;
    expect(wall).toMatchObject({ description: 'От стены остался низкий вал.', version: 2 });
    expect(wall.statEffect.security).toBe(0);

    const echoes = city.fronts.filter((f) => f.origin === 'echo');
    const harm = echoes.find((f) => f.title === 'Башня без стены')!;
    const boon = echoes.find((f) => f.title === 'Рынку стало просторно')!;
    expect(harm).toMatchObject({ form: 'threat', plus: false, atStake: 5, capacity: 2, refs: ['tower', 'wall'] });
    expect(harm.deadlineDay! - harm.createdDay).toBe(120);
    expect(harm.failStake).toEqual([{ op: 'revalue', target: 'tower', points: zero }]);
    expect(boon).toMatchObject({ form: 'deed', plus: true, atStake: 7 + 1, capacity: 4 });
    expect(boon.stake[0]).toMatchObject({ op: 'revalue', target: 'market', points: { prosperity: 12 } });
    // Эхо не применяется сразу: вклад башни и рынка пока прежний.
    expect(city.objects.find((o) => o.id === 'tower')?.statEffect.security).toBe(5);
    expect(city.chronicle.filter((e) => e.source === 'complication')).toHaveLength(2);

    // Соседнее дело обновлено: описание переписано, ключ запечатан заново, стратегия переоценена.
    expect(search.description).toBe('Ищут старый ход. Теперь иначе.');
    expect(search.key?.moves).toEqual(['Действовать открыто.', 'Договориться с теми, кого это касается.', 'Не жалеть сил на надзор.']);
    expect(leadOf(city, 'srch')?.verdict).toBe('off');
    const gate = s.llm.callsTo('role-fitter').map(lastUser).find((u) => u.includes('существенно меняет ход дела'))!;
    expect(gate).toContain('Ход под стеной');
  });
});

describe('недостижимое дело', () => {
  test('идёт без костей, сыплет бедами по пути и рушится на последней вехе, оставив след', async () => {
    const s = await town(['occupied-strained'], () => {}, { 'Подъёмник до земли': [up('influence', 'small')], 'Остов подъёмника': [down('prosperity', 'small')], 'Гильдия каменщиков': [] });
    const { city } = s;
    const reason = 'Под островом нет земли, до которой можно дотянуться.';
    s.llm
      .always('will-interpreter', will({ label: 'project', goal: 'Построить подъёмник до земли' }))
      .always('canon-warden', toolReply('submit_canon_verdict', { verdict: 'unattainable', reason }))
      .always('stage-planner', toolReply('submit_stages', { stages: [stage('Подъёмник до земли', { kind: 'new_object', type: 'structure', name: 'Подъёмник до земли', description: 'Канаты и клеть до самой земли.' })] }))
      .always('costumer', costume('Гильдия надрывается на канатах'))
      .always('resolver', (req) =>
        lastUser(req).includes('затея рухнула')
          ? toolReply('submit_resolution', { text: 'Канаты ушли в пустоту, клеть сорвалась.', effect: 'trace', trace: { type: 'landmark', name: 'Остов подъёмника', description: 'Ржавая клеть над пустотой.' } })
          : toolReply('submit_resolution', { text: 'Гильдия надорвалась.', effect: 'none' }),
      )
      .always('faith-appraiser', (req) => toolReply('submit_faith', { case: 'harm_willed', strength: lastUser(req).includes('предупреждали') ? 'grave' : 'minor' }));
    await playerWill(s.deps, city, 'marshal', 'Построить подъёмник до земли', 0);
    await playerWill(s.deps, city, 'marshal', 'Строй, я сказал', 0);
    const front = city.fronts[0]!;
    expect(front).toMatchObject({ unattainable: reason, risk: 'impossible', capacity: 10, milestones: 2, pulseDay: 30 });

    // Первый месячный бросок: тяжёлая побочная беда бьёт по занятой гильдии, дело при этом не встаёт.
    await at(s, 30);
    const trouble = city.fronts[1]!;
    expect(trouble).toMatchObject({ form: 'threat', origin: 'complication', parentId: null, bound: null, refs: ['guild'], dynamicId: 'occupied-strained' });
    expect(isFrozen(city, front)).toBe(false);
    expect(front.pulseDay).toBe(60);
    expect(s.llm.callsTo('risk-appraiser')).toHaveLength(0);

    while (front.status === 'active') await next(s, front);
    expect(front.status).toBe('failed');
    expect(city.projects[0]?.status).toBe('cancelled');
    expect(city.objects.some((o) => o.name === 'Подъёмник до земли')).toBe(false);
    const trace = city.objects.find((o) => o.name === 'Остов подъёмника')!;
    expect(trace).toMatchObject({ type: 'landmark', status: 'active' });
    expect(trace.statEffect.prosperity).toBe(-2);
    expect(lastUser(s.llm.callsTo('resolver').at(-1)!)).toContain(`Исход: затея рухнула. ${reason}`);
    // Беда по гильдии сработала раньше краха: срок у своих бед месяц.
    expect(trouble.status).toBe('failed');
    expect(city.objects.find((o) => o.id === 'guild')?.statEffect.prosperity).toBe(0);
    // Та же беда с тем же участником не открывалась дважды, пока первая была жива.
    const sources = city.chronicle.map((e) => e.source);
    expect(sources).toEqual(expect.arrayContaining(['will', 'complication', 'deadline', 'completion']));
    expect(city.faith.value).toBeLessThan(50);
  });
});
