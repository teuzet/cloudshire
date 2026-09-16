import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHRONICLE_ENTRY_MAX,
  CHRONICLE_FINALE_MAX,
  chronicleEntryLimit,
  deedConsequenceLines,
  deedTriggerLines,
  fallbackDeedEntry,
  formatDeedPrompt,
  formatFinalePrompt,
  formatThreatPrompt,
  threatTriggerLines,
  endingText,
  entryRegister,
  finishForPrompt,
  plotChronicleTail,
  writeChronicle,
} from '../src/game/chronicler.js';
import { FINISH_LABELS } from '../src/game/rolls.js';
import { loadConfig } from '../src/config.js';

const silentLog = {
  child: () => silentLog,
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function plot(extra = {}) {
  return {
    id: 'p1',
    kind: 'story',
    title: 'Гулкая лестница',
    synopsis: 'ступени гудят после шагов, причина неизвестна',
    gravity: 'CRISIS',
    depth: 0,
    maxDepth: 2,
    failCount: 0,
    maxFails: 2,
    threats: [],
    ...extra,
  };
}

function domain(extra = {}) {
  return {
    id: 'd1',
    name: 'Варшена',
    lore: [],
    officers: [{ id: 'o1', office: 'chancellor', title: 'Канцлер', name: 'Жален' }],
    ...extra,
  };
}

const deed = {
  id: 'proc1',
  summary: 'Осмотреть гулкую лестницу',
  detail: 'Вскрыть ступени в Срединном поясе и посмотреть, отчего гул',
  goal: 'Узнать причину гула',
  officerId: 'o1',
  office: 'chancellor',
};

// ─────────────────────────── последствия делом ───────────────────────────

test('дело на сбор сведений не даёт права писать, что вопрос решён', () => {
  const lines = deedConsequenceLines({
    plot: plot(),
    applied: { alignment: 'DIRECT', finish: 'ok' },
    closed: false,
  }).join('\n');
  assert.match(lines, /не решила/, 'иначе агент допишет ремонт, которого не было');
  assert.match(lines, /не пиши, что вопрос закрыт/i);
  assert.match(lines, /История не закрыта/);
});

test('закрывшее историю дело получает право на развязку', () => {
  const lines = deedConsequenceLines({
    plot: plot({ depth: 2 }),
    applied: { alignment: 'DIRECT', finish: 'crit' },
    closed: true,
  }).join('\n');
  assert.match(lines, /развязка/);
  assert.doesNotMatch(lines, /История не закрыта/);
});

test('снятая беда идёт в запись предотвращённой, а не случившейся', () => {
  const lines = deedConsequenceLines({
    plot: plot(),
    applied: { alignment: 'RELEVANT', finish: 'ok' },
    threat: { id: 't1', known: true, text: 'Известковая пыль забьёт водосборный сток' },
  }).join('\n');
  assert.match(lines, /Нависшее снято/);
  assert.match(lines, /как случившуюся не пиши/);
});

test('снятая беда, которой город не видел, в запись текстом не попадает', () => {
  const lines = deedConsequenceLines({
    plot: plot(),
    applied: { alignment: 'RELEVANT', finish: 'ok' },
    threat: { id: 't1', known: false, text: 'Стая хищных тварей сорвёт загон на дальнем выгоне' },
  }).join('\n');
  assert.match(lines, /которой город не видел/);
  assert.match(lines, /город этого не знает/);
  assert.doesNotMatch(lines, /хищных тварей/);
});

test('UNRELATED-делу прямо запрещают двигать историю', () => {
  const lines = deedConsequenceLines({
    plot: plot(),
    applied: { alignment: 'UNRELATED', finish: 'ok' },
  }).join('\n');
  assert.match(lines, /Историю это не двигает/);
});

test('дело без истории — просто исполненное поручение', () => {
  const lines = deedConsequenceLines({ plot: null, applied: { alignment: 'UNRELATED', finish: 'ok' } });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /ни с какой городской историей не связана/);
});

test('история на последней жизни запрещает облегчение', () => {
  const lines = deedConsequenceLines({
    plot: plot({ failCount: 2, maxFails: 2 }),
    applied: { alignment: 'RELEVANT', finish: 'fail' },
  }).join('\n');
  assert.match(lines, /на последнем/);
});

// ──────────────────────────────── промпты ────────────────────────────────

test('промпт дела несёт исход, исполнителя и хвост хроники', () => {
  const p = plot();
  const text = formatDeedPrompt({
    domain: domain(),
    plot: p,
    process: deed,
    applied: { alignment: 'DIRECT', finish: 'ok' },
    chronicleTail: ['осенью ступени начали гудеть'],
    dateLabel: 'Год 1, месяц 5, день 18',
  });
  assert.match(text, /Канцлер Жален/, 'без исполнителя запись обезличена');
  assert.match(text, /мужчина/);
  assert.match(text, /Назови его в записи/);
  assert.match(text, /согласуй род/);
  assert.match(text, /свободен и чем заняться дальше — не пиши/);
  assert.match(text, /УСПЕХ/);
  assert.match(text, /Узнать причину гула/);
  assert.match(text, /осенью ступени начали гудеть/);
  assert.match(text, /в запись не выноси/, 'название истории служебное');
  assert.doesNotMatch(text, /Год 1, месяц 5, день 18/, 'дату в текст не кладём');
  assert.match(text, /Календарную дату в текст не пиши/);
});

test('сановница в промпте хрониста — женский род, не «назови его»', () => {
  const text = formatDeedPrompt({
    domain: domain({
      officers: [{ id: 'o1', office: 'marshal', title: 'Маршал', name: 'Орена', gender: 'female' }],
    }),
    process: { ...deed, officerId: 'o1', office: 'marshal' },
    applied: { finish: 'crit' },
  });
  assert.match(text, /Маршал Орена \(женщина\)/);
  assert.match(text, /Назови её в записи/);
  assert.match(text, /провела, закончила, не довела/);
  assert.doesNotMatch(text, /Назови его в записи/);
});

test('делу через проход дают место и встречу, а не только поручение', () => {
  const text = formatDeedPrompt({
    domain: domain(),
    process: { ...deed, crossIsland: true },
    applied: { finish: 'crit' },
    partnerName: 'Аллерия',
    passage: 'Проход сейчас: края легли берег в берег, спуск по осыпи.',
    pairArchive: '- (на проходе) Острова сошлись.',
  });
  assert.match(text, /ЗАДЕВАЛА ПРОХОД/);
  assert.match(text, /«Аллерия»/);
  assert.match(text, /спуск по осыпи/, 'место берётся из прохода, а не из приказа');
  assert.match(text, /Острова сошлись/, 'архив встречи виден хронисту');
  assert.match(text, new RegExp(`до ${CHRONICLE_FINALE_MAX} символов`));
  // Дело через проход — не обязательно вылазка: посольство и дозор идут так же.
  assert.doesNotMatch(text, /куда несли|что под ногами/);
});

test('описание прохода не приезжает дважды — отдельно и внутри архива', () => {
  const passage = 'Проход сейчас: края легли берег в берег, спуск по осыпи.\nСостояние прохода: открыт.';
  const text = formatDeedPrompt({
    domain: domain(),
    process: { ...deed, crossIsland: true },
    applied: { finish: 'crit' },
    partnerName: 'Аллерия',
    passage,
    pairArchive: '- (на проходе) края легли берег в берег, спуск по осыпи.\n- (на проходе) Ночью увели зерно.',
  });
  assert.equal(text.match(/спуск по осыпи/g).length, 1, 'место названо один раз');
  assert.match(text, /Ночью увели зерно/, 'остальной архив остаётся');
});

test('поручение подано как намерение и как мерка, а не как текст записи', () => {
  const text = formatDeedPrompt({ domain: domain(), process: deed, applied: { finish: 'ok' } });
  assert.match(text, /ЧТО СОБИРАЛИСЬ СДЕЛАТЬ/);
  assert.match(text, /в летопись его не переписывай/);
  assert.match(text, /это мерка, а не текст записи/);
  // Домашней работе соседа не показывают: выдумывать проход не с чего.
  assert.doesNotMatch(text, /ЗАДЕВАЛА ПРОХОД/);
});

test('расширенной записи не велят быть сухой — иначе объём не используется', () => {
  assert.match(entryRegister(CHRONICLE_ENTRY_MAX), /Сухо/);
  assert.doesNotMatch(entryRegister(CHRONICLE_FINALE_MAX), /Сухо/);
  assert.match(entryRegister(CHRONICLE_FINALE_MAX), /подробно/);
});

test('кросс-островной записи прямо велят не сжиматься в сводку', () => {
  const text = formatDeedPrompt({
    domain: domain(),
    process: { ...deed, crossIsland: true },
    applied: { finish: 'ok' },
    partnerName: 'Керсай',
    passage: 'Края легли берег в берег.',
  });
  assert.match(text, /не короче четырёх предложений/);
  assert.match(text, /пиши в полную силу/);
  // Подробность и перечень — разные вещи, иначе правило против списков её съедает.
  assert.match(text, /не добавить/);
  const local = formatDeedPrompt({ domain: domain(), process: deed, applied: { finish: 'ok' } });
  assert.doesNotMatch(local, /не короче четырёх предложений/);
});

test('объём кросс-островной записи не уходит в описание прохода', () => {
  const text = formatDeedPrompt({
    domain: domain(),
    process: { ...deed, crossIsland: true },
    applied: { finish: 'ok' },
    partnerName: 'Керсай',
    passage: 'Края легли берег в берег, спуск по осыпи.',
  });
  assert.match(text, /Проход городу знаком и описан/);
  assert.match(text, /обстановка работы, а не её событие/);
  assert.match(text, /ближе к людям и к тому, чем работа обернулась/);
});

test('исход приходит общим словарём броска, своего у хрониста нет', () => {
  assert.equal(finishForPrompt('crit'), FINISH_LABELS.crit);
  assert.equal(finishForPrompt('fail'), FINISH_LABELS.fail);
  assert.equal(finishForPrompt(undefined), FINISH_LABELS.ok, 'без исхода — успех');
  for (const finish of ['crit', 'ok', 'fail']) {
    const text = formatDeedPrompt({ domain: domain(), process: deed, applied: { finish } });
    assert.match(text, new RegExp(`ИСХОД: ${FINISH_LABELS[finish].replace(/[[\]]/g, '\\$&')}`));
  }
});

test('конфиг: три исхода расшифрованы и крит не равен успеху', () => {
  const cfg = loadConfig();
  const text = cfg.agents.chronicler.instructions;
  assert.match(text, /\[КРИТИЧЕСКИЙ УСПЕХ\] — вышло больше, чем просили/);
  assert.match(text, /\[УСПЕХ\] —/);
  assert.match(text, /\[ПРОВАЛ\] —/);
  assert.match(text, /не должна получаться одна и та же запись/);
  // Исход показывают итогом, а не оценочным словом.
  assert.match(text, /«удачно»/);
});

test('промпт беды требует прошедшего времени', () => {
  const text = formatThreatPrompt({
    plot: plot(),
    threat: { text: 'Известковая пыль забьёт водосборный сток, и дождь смоет посевы' },
    kind: 'threat',
    severity: 'УЩЕРБ',
  });
  assert.match(text, /В БУДУЩЕМ ВРЕМЕНИ/);
  assert.match(text, /как случившееся, в прошедшем времени/);
  assert.match(text, /забьёт водосборный сток/, 'предсказание отдаём как есть');
  assert.match(text, /История не закрыта/);
  assert.doesNotMatch(text, /длиннее обычной/);
});

test('финальная запись несёт и случившееся, и всю тройку концовки', () => {
  const p = plot({
    cause: 'марш держится на одной осевшей опоре',
    endings: [
      {
        id: 'e_bad',
        kind: 'BAD_ENDING',
        text: 'марш обвалился вместе с людьми',
        questionGone: 'спорить о лестнице больше не о чем: её нет',
        nowDifferent: 'Срединный пояс отрезан от нижних дворов',
      },
    ],
  });
  const text = formatFinalePrompt({
    plot: p,
    ending: { kind: 'BAD_ENDING', text: '', endingId: 'e_bad' },
    triggerLines: threatTriggerLines({ text: 'Северное крыло рухнет на мостки' }),
    entryMax: CHRONICLE_FINALE_MAX,
  });
  assert.match(text, /этим история кончается/i);
  assert.match(text, /Северное крыло рухнет на мостки/);
  assert.match(text, /марш обвалился вместе с людьми/);
  assert.match(text, /спорить о лестнице больше не о чем/);
  assert.match(text, /Срединный пояс отрезан/);
  assert.match(text, /марш держится на одной осевшей опоре/);
  assert.match(text, /утратой, а не решением/);
  assert.match(text, new RegExp(`до ${CHRONICLE_FINALE_MAX} символов`));
  assert.equal(chronicleEntryLimit(CHRONICLE_FINALE_MAX), CHRONICLE_FINALE_MAX);
  assert.equal(chronicleEntryLimit(10), CHRONICLE_ENTRY_MAX);
});

test('развязка берётся из заготовленных концовок, а не из пустого ending.text', () => {
  const p = plot({
    depth: 2,
    endings: [
      { id: 'e_good', kind: 'GOOD_ENDING', text: 'ход расчистили, лестница смолкла' },
      { id: 'e_bad', kind: 'BAD_ENDING', text: 'марш обвалился вместе с людьми' },
    ],
  });
  const ending = { kind: 'GOOD_ENDING', text: '', endingId: 'e_good', processId: 'proc1' };
  assert.equal(endingText(p, ending), 'ход расчистили, лестница смолкла');
  assert.equal(endingText(p, { kind: 'GOOD_ENDING', text: '', endingId: null }), null);

  const text = formatFinalePrompt({
    plot: p,
    ending,
    triggerLines: deedTriggerLines({
      domain: domain(),
      process: deed,
      applied: { alignment: 'DIRECT', finish: 'crit' },
    }),
  });
  assert.match(text, /лестница смолкла/);
  assert.match(text, /Канцлер Жален/);
  assert.match(text, /\[КРИТИЧЕСКИЙ УСПЕХ\]/);
  assert.match(text, /что-то приобрёл/);
});

test('обычная запись о деле развязку не тянет — её пишет финальный бриф', () => {
  const text = formatDeedPrompt({
    domain: domain(),
    plot: plot({ endings: [{ id: 'e_good', kind: 'GOOD_ENDING', text: 'лестница смолкла' }] }),
    process: deed,
    applied: { alignment: 'DIRECT', finish: 'ok' },
    closed: false,
  });
  assert.doesNotMatch(text, /Развязка истории|лестница смолкла/);
});

test('нейтральная развязка — не победа и не крушение', () => {
  const p = plot({
    endings: [{ id: 'e_n', kind: 'NEUTRAL_ENDING', text: 'осевшее крыло огородили и забыли' }],
  });
  const text = formatFinalePrompt({
    plot: p,
    ending: { kind: 'NEUTRAL_ENDING', text: '', endingId: 'e_n' },
    triggerLines: threatTriggerLines({ text: 'Осевшее крыло огородят и забудут о нём' }),
  });
  assert.match(text, /Ни победы, ни крушения/);
  assert.match(text, /заплатил|исчерпал/);
});

// ──────────────────────────── запасная запись ────────────────────────────

test('запасная запись не называет ни дела, ни истории', () => {
  const ok = fallbackDeedEntry(deed, 'ok');
  const bad = fallbackDeedEntry(deed, 'fail');
  for (const text of [ok, bad]) {
    assert.doesNotMatch(text, /«|»/, 'кавычки с названием — метагейм');
    assert.doesNotMatch(text, /Осмотреть гулкую лестницу/);
  }
  assert.match(ok, /Узнать причину гула/);
  assert.match(bad, /не удалось/);
  assert.match(
    fallbackDeedEntry(deed, 'ok', { actor: 'Канцлер Жален' }),
    /Канцлер Жален закончил/,
  );
  assert.match(
    fallbackDeedEntry(deed, 'ok', { actor: 'Маршал Орена', gender: 'female' }),
    /Маршал Орена закончила/,
  );
});

// ───────────────────────────── хвост хроники ─────────────────────────────

test('хвост берётся только по своей истории и только из хроники', () => {
  const d = domain({
    lore: [
      { id: 'f1', text: 'своё', tags: ['chronicle'], sourcePlotId: 'p1' },
      { id: 'f2', text: 'чужое', tags: ['chronicle'], sourcePlotId: 'p2' },
      { id: 'f3', text: 'через связь', tags: ['chronicle'], relatedPlotlineIds: ['p1'] },
      { id: 'f4', text: 'служебное', tags: ['fact'], sourcePlotId: 'p1' },
    ],
  });
  assert.deepEqual(plotChronicleTail(d, 'p1'), ['своё', 'через связь']);
  assert.deepEqual(plotChronicleTail(d, null), []);
});

test('хвост урезается до последних записей', () => {
  const d = domain({
    lore: Array.from({ length: 20 }, (_, i) => ({
      id: `f${i}`,
      text: `запись ${i}`,
      tags: ['chronicle'],
      sourcePlotId: 'p1',
    })),
  });
  const tail = plotChronicleTail(d, 'p1', 3);
  assert.deepEqual(tail, ['запись 17', 'запись 18', 'запись 19']);
});

// ─────────────────────────────── сам вызов ───────────────────────────────

test('хронист возвращает запись и режет её по пределу', async () => {
  const calls = [];
  const runtime = {
    run: async (opts) => {
      calls.push(opts);
      await opts.tools[0].handler({ entry: 'Ж'.repeat(CHRONICLE_ENTRY_MAX + 50) });
      return {};
    },
  };
  const res = await writeChronicle({
    runtime,
    domain: domain(),
    occasion: 'дело',
    prompt: 'что случилось',
    log: silentLog,
  });
  assert.equal(res.text.length, CHRONICLE_ENTRY_MAX);
  assert.equal(calls[0].agentId, 'chronicler');
  assert.equal(calls[0].scene, 'chronicle_дело');
  assert.match(calls[0].extraSystem, /Варшена/);
  assert.match(calls[0].tools[0].parameters.properties.entry.description, new RegExp(`до ${CHRONICLE_ENTRY_MAX}`));
});

test('финальная запись режется по расширенному пределу и пишется своим агентом', async () => {
  const calls = [];
  const runtime = {
    run: async (opts) => {
      calls.push(opts);
      await opts.tools[0].handler({ entry: 'Ж'.repeat(CHRONICLE_FINALE_MAX + 20) });
      return {};
    },
  };
  const res = await writeChronicle({
    runtime,
    domain: domain(),
    occasion: 'развязка',
    agentId: 'chronicleFinale',
    prompt: 'финал',
    maxChars: CHRONICLE_FINALE_MAX,
    log: silentLog,
  });
  assert.equal(res.text.length, CHRONICLE_FINALE_MAX);
  assert.equal(calls[0].agentId, 'chronicleFinale');
  assert.equal(calls[0].scene, 'chronicle_развязка');
});

test('конфиг: у финального хрониста свой контракт, у обычного — запрет тянуть срок в прошедшее', () => {
  const agents = loadConfig().agents;
  assert.ok(agents.chronicleFinale, 'финальную запись пишет отдельный агент');
  assert.match(agents.chronicleFinale.instructions, /ПОСЛЕДНЮЮ запись/);
  assert.match(agents.chronicleFinale.instructions, /больше не пишут/);
  assert.match(agents.chronicleFinale.instructions, /к зиме/);
  assert.match(agents.chronicler.instructions, /СРОК ИЗ ВВОДА НЕ ПЕРЕНОСИ В ПРОШЕДШЕЕ ВРЕМЯ/);
  assert.match(agents.chronicler.instructions, /«К зиме начали разрушаться» — бессмыслица/);
  assert.match(agents.herald.instructions, /ПОВОД «РАЗВЯЗКА»/);
  assert.match(agents.herald.instructions, /утрату прямо/);
});

test('пустой ответ модели не выдаётся за запись', async () => {
  const runtime = {
    run: async (opts) => {
      const res = await opts.tools[0].handler({ entry: '   ' });
      assert.equal(res.ok, undefined, 'пустую запись инструмент не принимает');
      return {};
    },
  };
  assert.equal(
    await writeChronicle({ runtime, domain: domain(), prompt: 'что случилось', log: silentLog }),
    null,
    'решать, чем закрыть дыру, — не работа хрониста',
  );
});

test('упавшая модель не рушит ход', async () => {
  const runtime = {
    run: async () => {
      throw new Error('модель отвалилась');
    },
  };
  assert.equal(await writeChronicle({ runtime, domain: domain(), prompt: 'что', log: silentLog }), null);
});
