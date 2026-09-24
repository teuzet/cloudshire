/**
 * Хронист — автор одной записи в хронике города.
 *
 * До него запись писал сам движок шаблоном: «Дело «Осмотреть лестницу»
 * кончилось успехом». Это плохо сразу дважды. Во-первых, хроника — летопись
 * города, а не журнал действий игрока: в ней не должно быть ни названий дел,
 * ни названий историй, потому что за пределами интерфейса их никто так не
 * зовёт. Во-вторых, жрец потом пересказывал этот шаблон, и получалась
 * отчётность вместо вести.
 *
 * Разделение простое: хронист фиксирует, ЧТО случилось в городе; жрец
 * (`herald`) пересказывает уже записанное своим голосом. Один и тот же агент
 * не может делать оба дела, не сваливаясь в отчёт.
 *
 * Механику решает движок и передаёт готовой: исход броска, что стало с
 * нависшим, закрылась ли история. Хронист с этим не спорит и ничего не
 * добавляет к причинности.
 */

import { getLogger, truncate } from '../log.js';
import { chronicleEntries } from './models.js';
import { FINISH_LABELS } from './rolls.js';
import { findOfficer, officerGender } from './officers.js';
import { livesLeft, firedThreatScale } from './threats.js';
import { formatFreeformGravityForPrompt } from './freeform.js';
import { formatStoryFactsBlock, storyLinkedFacts } from './memory.js';
import { toolFail } from '../agents/toolResult.js';

export const CHRONICLE_ENTRY_MAX = 400;
/** Финальную запись пишет отдельный агент, и ей нужно место на всю развязку. */
export const CHRONICLE_FINALE_MAX = 900;

export function chronicleEntryLimit(raw) {
  const n = Math.round(Number(raw) || 0);
  return n > CHRONICLE_ENTRY_MAX ? n : CHRONICLE_ENTRY_MAX;
}

/**
 * Рядовому дню хватает сухой строчки, и просить о ней надо прямо: иначе запись
 * разрастается. Но то же слово «сухо» в расширенной записи съедает весь объём —
 * модель отдаёт сводку в два предложения и на длинном пределе.
 */
export function entryRegister(limit) {
  return chronicleEntryLimit(limit) > CHRONICLE_ENTRY_MAX
    ? 'Предметно и подробно: город будет помнить это долго, коротить незачем.'
    : 'Сухо и предметно.';
}

/** Исход одним токеном и толкованием. Словарь общий с броском, своего не заводим. */
export function finishForPrompt(finish) {
  return FINISH_LABELS[finish] || FINISH_LABELS.ok;
}

/** Поводы для записи. Совпадают с поводами вести, кроме новой истории: её пишет посев. */
export const CHRONICLE_OCCASIONS = ['дело', 'угроза', 'разрешение'];

/** Сколько прошлых записей истории показать: хвоста хватает, начало живёт в синопсисе. */
export const CHRONICLE_TAIL = 6;


/** Хвост хроники одной истории — чтобы хронист не переоткрывал уже открытое. */
export function plotChronicleTail(domain, plotId, limit = CHRONICLE_TAIL) {
  if (!plotId) return [];
  const id = String(plotId);
  return chronicleEntries(domain?.lore)
    .filter(
      (f) =>
        String(f?.sourcePlotId || '') === id ||
        (f?.relatedPlotlineIds || []).some((x) => String(x) === id),
    )
    .slice(-limit)
    .map((f) => String(f.text || '').trim())
    .filter(Boolean);
}

/** Родная хроника нити: без субъектификаций сопряжения. */
export function nativePlotChronicleTail(domain, plotId, limit = CHRONICLE_TAIL) {
  if (!plotId) return [];
  const id = String(plotId);
  return chronicleEntries(domain?.lore)
    .filter((f) => {
      const tags = f?.tags || [];
      if (tags.includes('subjective')) return false;
      return (
        String(f?.sourcePlotId || '') === id ||
        (f?.relatedPlotlineIds || []).some((x) => String(x) === id)
      );
    })
    .slice(-limit)
    .map((f) => String(f.text || '').trim())
    .filter(Boolean);
}

/** Запасная запись, если модель не ответила. Без названий дел и историй. */
export function fallbackDeedEntry(process, finish, { actor, gender } = {}) {
  const what = String(process?.goal || process?.detail || '').trim();
  const tail = what ? `: ${what}` : '.';
  const who = String(actor || '').trim();
  const female = gender === 'female';
  if (finish === 'fail') {
    return who
      ? `${who} не ${female ? 'довела' : 'довёл'} порученную работу${tail}`
      : `Порученную работу довести не удалось${tail}`;
  }
  return who
    ? `${who} ${female ? 'закончила' : 'закончил'} порученную работу${tail}`
    : `Порученную работу закончили${tail}`;
}

export function findDeedOfficer(domain, process) {
  return (
    findOfficer(domain, {
      officerId: process?.officerId,
      office: process?.office,
    }) || null
  );
}

export function deedActor(domain, process) {
  const officer = findDeedOfficer(domain, process);
  if (officer?.name) return `${officer.title} ${officer.name}`;
  if (process?.characterName) return String(process.characterName);
  return null;
}

export function deedActorGender(domain, process) {
  const officer = findDeedOfficer(domain, process);
  return officer ? officerGender(officer) : null;
}

function actorVoice(officer) {
  const female = officer && officerGender(officer) === 'female';
  return female
    ? { word: 'женщина', them: 'её', free: 'она свободна', did: 'провела, закончила, не довела' }
    : { word: 'мужчина', them: 'его', free: 'он свободен', did: 'провёл, закончил, не довёл' };
}

/** Строка для хрониста: сан, имя, пол — род глаголов, скобки в летопись не копировать. */
export function deedActorPrompt(domain, process) {
  const officer = findDeedOfficer(domain, process);
  const name = officer?.name
    ? `${officer.title} ${officer.name}`
    : process?.characterName
      ? String(process.characterName)
      : null;
  if (!name) return 'Кто вёл: город сам, без названного лица.';
  const v = actorVoice(officer);
  const genderBit = officer ? ` (${v.word})` : '';
  return (
    `Кто вёл: ${name}${genderBit}. ` +
    `Назови ${v.them} в записи, согласуй род глаголов (${v.did}). Пол в скобках в текст не пиши. ` +
    `Что ${v.free} и чем заняться дальше — не пиши.`
  );
}

/**
 * Что механика сделала с историей — словами, без чисел.
 *
 * Это главный вход хрониста: именно отсюда он узнаёт, что осмотр лестницы
 * ничего не починил, а только выяснил. Без этой строки агент домысливает
 * благополучный ремонт, и синопсис уезжает в развязку на первом же деле.
 */
export function deedConsequenceLines({ plot, applied, threat = null, averted = [], closed = false }) {
  const lines = [];
  const alignment = applied?.alignment || 'UNRELATED';
  const finish = applied?.finish || 'ok';
  const linked = Boolean(threat?.text);

  if (!plot) {
    lines.push('Эта работа ни с какой городской историей не связана: просто исполненное поручение.');
    return lines;
  }

  if (alignment === 'DIRECT') {
    if (finish === 'fail' && linked) {
      lines.push('Работа била прямо в суть истории и не вышла.');
      lines.push(`Из этого провала выросла беда, и она случилась: ${threat.text}`);
      lines.push('Свяжи провал и беду одной причиной. Пиши как одно событие, не как два.');
    } else if (finish === 'fail') {
      lines.push('Работа била прямо в суть истории и не вышла. Вопрос остался неразрешённым.');
    } else if (closed) {
      lines.push('Это и есть развязка истории: суть вопроса решена.');
    } else {
      lines.push(
        'Работа продвинула суть истории, но не решила её. Пиши только достигнутое, ' +
          'не пиши, что вопрос закрыт или что беды больше нет.',
      );
    }
  } else if (alignment === 'RELEVANT') {
    const gone = (averted || []).map((t) => t?.text).filter(Boolean);
    if (finish === 'fail' && linked) {
      lines.push('Работа должна была снять нависшее, но не справилась.');
      lines.push(`Из этого провала выросла беда, и она случилась: ${threat.text}`);
      lines.push('Свяжи провал и беду одной причиной.');
    } else if (finish === 'fail') {
      lines.push('Работа должна была снять нависшее, но не справилась: нависшее осталось.');
    } else if (gone.length) {
      lines.push('Работа отвела беду, которой город не ждал. Теперь он знает, чего избежал:');
      for (const text of gone) lines.push(`- ${text}`);
      lines.push('Напиши, что именно заметили и отвели. Это и есть событие записи.');
    } else {
      lines.push('Работа сняла одну нависшую над городом беду.');
    }
  } else if (alignment === 'DANGEROUS') {
    if (linked && finish !== 'fail') {
      lines.push(`Работа своей цели достигла и тем вызвала беду: ${threat.text}`);
      lines.push('Свяжи работу и беду: одно вышло из другого.');
    } else if (finish === 'fail') {
      lines.push('Опасная работа не вышла — и тем город уберёгся.');
    } else {
      lines.push('Работа достигла цели.');
    }
  } else {
    lines.push(
      'Историю это не двигает: работа сама по себе, её итог не меняет положения дел. ' +
        'Не приписывай ей сдвига в истории.',
    );
  }

  // Раскрытое дело переводит скрытое в знание города: с этой минуты его не
  // только можно, но и нужно писать — иначе разгадка умирает непрочитанной.
  const revealed = Array.isArray(applied?.revealed) ? applied.revealed : [];
  if (applied?.answer) {
    lines.push(`Этой работой город РАЗГАДАЛ, в чём дело: ${applied.answer}`);
    lines.push(
      'Это и есть главное в записи. Пиши как установленное, а не как догадку. ' +
        'Но вопрос этим не решён: город теперь знает, с чем имеет дело, и не более.',
    );
  } else if (revealed.length) {
    lines.push('Этой работой город ВЫЯСНИЛ следующее, и теперь знает это точно:');
    for (const text of revealed) lines.push(`- ${text}`);
    lines.push(
      'Запиши, что именно выяснили — это главное в записи. Пиши как установленное, ' +
        'а не как догадку. Дальше выясненного не заходи: до сути ещё не дошли, ' +
        'и остального скрытого не домысливай.',
    );
  }

  if (!closed) {
    lines.push(
      livesLeft(plot) <= 0
        ? 'История не закрыта и держится на последнем: не пиши облегчения и покоя.'
        : 'История не закрыта. Не пиши итог, вывод и урок на будущее.',
    );
  }
  return lines;
}

/**
 * Текст развязки.
 *
 * У `plot.ending`, которую ставит движок, текст пустой: там только вид и ссылка
 * на заготовленную концовку. Сам текст лежит в `plot.endings`.
 */
export function endingText(plot, ending) {
  void plot;
  return String(ending?.text || '').trim() || null;
}

function plotBlock(plot, chronicleTail = [], storyFacts = []) {
  if (!plot) return [];
  const lines = [`ЧАСТЬ ИСТОРИИ (название — служебное, в запись не выноси): ${plot.title || '—'}`];
  if (plot.synopsis) lines.push(`Как обстояло до сего дня: ${plot.synopsis}`);
  if (chronicleTail.length) {
    lines.push('Уже записано по этой истории (не отменяй и не повторяй):');
    for (const t of chronicleTail) lines.push(`- ${t}`);
  }
  const facts = formatStoryFactsBlock(storyFacts);
  if (facts) lines.push(facts);
  return lines;
}

/**
 * Запись о завершившемся деле.
 *
 * `chronicleTail` — хвост хроники этой истории: без него агент пишет заново
 * то, что уже записано, и город каждый раз находит одну и ту же протечку.
 */
/**
 * Соседний берег словами мира, а не поручения.
 *
 * Без этого блока хронист знает о месте ровно то, что стояло в приказе, и
 * запись выходит приказом в прошедшем времени: другого материала у неё нет.
 * Работа не обязательно вылазка — так же идут посольство, торг и дозор.
 */
function neighbourBlock({ partnerName = '', passage = '', pairArchive = '' } = {}) {
  const lines = ['ЭТА РАБОТА ЗАДЕВАЛА ПРОХОД И СОСЕДНИЙ ГОРОД.'];
  if (partnerName) lines.push(`Сосед за проходом — «${partnerName}».`);
  if (passage) lines.push(`Место, уже описанное в летописи (справка, другого не выдумывай):\n${passage}`);
  const archive = archiveBeyondPassage(pairArchive, passage);
  if (archive) {
    lines.push(`Что уже записано об этой встрече (не повторяй как новость и не противоречь):\n${archive}`);
  }
  lines.push(
    'Проход городу знаком и описан: из чего он, куда идёт и как по нему ходят, в этой записи',
    'повторять нечего. Он обстановка работы, а не её событие.',
    'Города сходятся редко, и такую работу помнят дольше прочих: пиши в полную силу,',
    'не сводкой. Подробно — значит подойти ближе к людям и к тому, чем работа обернулась,',
    'а не добавить ещё пунктов к перечню задетого и пройденного.',
  );
  lines.push('');
  return lines;
}

/** Описание прохода уже отдано отдельно — в архиве оно только съедает окно. */
function archiveBeyondPassage(pairArchive, passage) {
  const place = String(passage || '').trim();
  if (!place) return String(pairArchive || '').trim();
  return String(pairArchive || '')
    .split('\n')
    .filter((line) => {
      const body = line.replace(/^-\s*\([^)]*\)\s*/, '').trim();
      return body && !place.includes(body);
    })
    .join('\n')
    .trim();
}

export function formatDeedPrompt({
  domain,
  plot,
  process,
  applied,
  threat = null,
  averted = [],
  closed = false,
  chronicleTail = [],
  storyFacts = null,
  dateLabel = '',
  partnerName = '',
  passage = '',
  pairArchive = '',
}) {
  void dateLabel;
  const cross = Boolean(process?.crossIsland);
  return [
    'ПОВОД: закончилась работа, которую город вёл по воле покровителя.',
    '',
    'ЧТО СОБИРАЛИСЬ СДЕЛАТЬ (намерение, записанное заранее; в летопись его не переписывай):',
    process?.detail || process?.summary || '—',
    process?.goal ? `По чему мерили успех (это мерка, а не текст записи): ${process.goal}` : null,
    deedActorPrompt(domain, process),
    `ИСХОД: ${finishForPrompt(applied?.finish)}`,
    '',
    ...deedConsequenceLines({ plot, applied, threat, averted, closed }),
    '',
    ...plotBlock(plot, chronicleTail, storyFacts ?? storyLinkedFacts(domain, plot)),
    '',
    ...(cross ? neighbourBlock({ partnerName, passage, pairArchive }) : []),
    'Календарную дату в текст не пиши: она стоит на записи отдельно.',
    cross
      ? `Одна связная запись, не короче четырёх предложений, до ${CHRONICLE_FINALE_MAX} символов. Вызови submit_chronicle.`
      : 'Напиши одну запись хроники о том, что случилось в городе. Вызови submit_chronicle.',
  ]
    .filter((l) => l != null)
    .join('\n');
}

/**
 * Запись о сработавшем обязательстве мира, которое историю не закрыло.
 * Развязку пишет `formatFinalePrompt`: там другой объём работы.
 *
 * Текст угрозы написан в будущем времени — это предсказание, которое движок
 * держал до срока. В хронику оно должно попасть уже случившимся, иначе
 * летопись начинает пророчествовать.
 */
function threatGravityLines(scale, config) {
  return [
    formatFreeformGravityForPrompt(scale, config),
    'Тяжесть случившегося для города держи на этом уровне. Событие то же, причину не подменяй.',
  ].join('\n');
}

export function formatThreatPrompt({
  domain = null,
  plot,
  threat,
  chronicleTail = [],
  storyFacts = null,
  dateLabel = '',
  config = null,
  causeLines = [],
}) {
  void dateLabel;
  return [
    'ПОВОД: напряжение истории дошло до края, и одна из бед случилась.',
    '',
    ...causeBlock(causeLines),
    'ЭТО БЫЛО НАПИСАНО ЗАРАНЕЕ, В БУДУЩЕМ ВРЕМЕНИ. Теперь оно произошло:',
    threat?.text || '—',
    'Перепиши это как случившееся, в прошедшем времени, со своими подробностями места и людей.',
    'Не пиши, что это ещё только случится или что этого можно избежать.',
    'История не закрыта: беда случилась, но первопричина осталась. Не пиши итог и мораль.',
    '',
    threatGravityLines(firedThreatScale(plot, threat), config),
    '',
    ...plotBlock(plot, chronicleTail, storyFacts ?? storyLinkedFacts(domain, plot)),
    '',
    'Календарную дату в текст не пиши: она стоит на записи отдельно.',
    'Напиши одну запись хроники. Вызови submit_chronicle.',
  ]
    .filter((l) => l != null)
    .join('\n');
}

const ENDING_KIND_LINE = {
  GOOD_ENDING:
    'Вопрос снят, и город на этом что-то приобрёл. Приобретение назови прямо, ' +
    'но не превращай запись в триумф: цена тоже была.',
  NEUTRAL_ENDING:
    'Это нейтральная концовка. Вопрос снят, но город за это заплатил или он просто исчерпал себя. ' +
    'Ни победы, ни крушения: напиши, чем всё улеглось и во что это обошлось.',
  BAD_ENDING:
    'Вопрос закрыт утратой, а не решением: города лишился того, из-за чего всё это стояло. ' +
    'Не пиши «стало хуже» — пиши, чего больше нет.',
};

/**
 * Провальное дело, из которого выросла беда.
 *
 * Один и тот же блок и для промежуточной угрозы, и для концовки: событие
 * остаётся тем, что выбрал движок, а дело только объясняет, откуда оно взялось.
 */
export function failedDeedCauseLines({ domain, process, applied }) {
  const actor = deedActor(domain, process);
  const officer = findDeedOfficer(domain, process);
  const v = actorVoice(officer);
  return [
    'ПРОВАЛЬНОЕ ДЕЛО ПРИВЕЛО К СОБЫТИЮ НИЖЕ.',
    `Город вёл работу: ${process?.detail || process?.summary || '—'}`,
    process?.goal ? `Чего добивались: ${process.goal}` : null,
    actor
      ? `Кто вёл: ${actor}${officer ? ` (${v.word})` : ''}. Согласуй род (${v.did}). Пол в скобках в текст не пиши.`
      : 'Кто вёл: город сам, без названного лица.',
    `ИСХОД: ${finishForPrompt(applied?.finish || 'fail')}`,
    'Дело не вышло, и из этого провала случилось событие, которое написано следом.',
    'Пиши их одной причиной: сначала провал, потом событие. Событие не подменяй другим.',
  ].filter(Boolean);
}

function causeBlock(causeLines) {
  const lines = (causeLines || []).filter((line) => line != null && String(line).trim());
  return lines.length ? [...lines, ''] : [];
}

/** Ввод финальной записи, когда историю закрыло дело города. */
export function deedTriggerLines({ domain, process, applied }) {
  const actor = deedActor(domain, process);
  const officer = findDeedOfficer(domain, process);
  const v = actorVoice(officer);
  const revealed = Array.isArray(applied?.revealed) ? applied.revealed : [];
  return [
    `Город вёл работу по воле покровителя: ${process?.detail || process?.summary || '—'}`,
    process?.goal ? `Чего добивались: ${process.goal}` : null,
    actor
      ? `Кто вёл: ${actor}${officer ? ` (${v.word})` : ''}. Согласуй род (${v.did}).`
      : 'Кто вёл: город сам, без названного лица.',
    `ИСХОД: ${finishForPrompt(applied?.finish)}`,
    applied?.answer ? `Этой же работой город разгадал, в чём было дело: ${applied.answer}` : null,
    revealed.length ? `Этой работой выяснилось, и город теперь это знает:\n- ${revealed.join('\n- ')}` : null,
  ].filter(Boolean);
}

/** Ввод финальной записи, когда историю закрыло сработавшее обязательство мира. */
export function threatTriggerLines(threat) {
  return [
    'Это было написано заранее, в будущем времени. Теперь оно произошло:',
    threat?.text || '—',
    'Перепиши случившимся, со своими подробностями места и людей.',
  ];
}

/**
 * Последняя запись об истории.
 *
 * Отдельно от `formatDeedPrompt` и `formatThreatPrompt`, потому что там задача —
 * зафиксировать один ход, а здесь закрыть линию: обычный хронист на таком
 * брифе сводил событие и развязку в одну сухую строчку.
 *
 * `triggerLines` даёт вызывающий: у дела и у сработавшей беды это разные вводы.
 * `causeLines` — провальное дело, если именно оно сорвало беду: событие ниже
 * от этого не меняется.
 */
export function formatFinalePrompt({
  domain = null,
  plot,
  ending = null,
  triggerLines = [],
  causeLines = [],
  chronicleTail = [],
  storyFacts = null,
  dateLabel = '',
  entryMax = CHRONICLE_FINALE_MAX,
  config = null,
  scale = null,
}) {
  void dateLabel;
  const kind = ending?.kind || 'NEUTRAL_ENDING';
  const limit = chronicleEntryLimit(entryMax);
  return [
    'ПОВОД: этим история кончается. Это последняя запись о ней.',
    '',
    ...causeBlock(causeLines),
    'ЧТО ПРИВЕЛО К РАЗВЯЗКЕ:',
    ...triggerLines,
    '',
    plot?.cause ? `Первопричина, из-за которой всё это стояло: ${plot.cause}` : null,
    ending?.text ? `Уже намеченная развязка: ${ending.text}` : null,
    '',
    scale ? threatGravityLines(scale, config) : null,
    scale ? '' : null,
    ENDING_KIND_LINE[kind] || ENDING_KIND_LINE.NEUTRAL_ENDING,
    'Покажи, почему вопрос больше не стоит и что в городе теперь иначе.',
    '',
    ...plotBlock(plot, chronicleTail, storyFacts ?? storyLinkedFacts(domain, plot)),
    '',
    'Календарную дату в текст не пиши: она стоит на записи отдельно.',
    `Одна связная запись до ${limit} символов. Вызови submit_chronicle.`,
  ]
    .filter((l) => l != null)
    .join('\n');
}

/**
 * Позвать хрониста. Возвращает `{ text }` или `null`, если модель промолчала:
 * решение, чем закрыть дыру, принимает вызывающий, а не этот файл.
 */
export async function writeChronicle({
  runtime,
  domain,
  occasion = 'дело',
  prompt,
  maxChars = CHRONICLE_ENTRY_MAX,
  agentId = 'chronicler',
  log: parentLog,
} = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'chronicler', domainId: domain?.id, agentId });
  const limit = chronicleEntryLimit(maxChars);
  const draft = { text: null };
  const tools = [
    {
      name: 'submit_chronicle',
      description: 'Одна запись хроники о случившемся. Названий дел и историй в ней нет.',
      parameters: {
        type: 'object',
        required: ['entry'],
        properties: {
          entry: {
            type: 'string',
            description:
              `Что случилось в городе, до ${limit} символов. ${entryRegister(limit)} ` +
              'В прошедшем времени. Без названий дел и историй, без кавычек с названиями.',
          },
        },
      },
      handler: async ({ entry }) => {
        const text = String(entry || '').trim();
        if (!text) return toolFail('empty', 'Нужна запись.');
        draft.text = text.slice(0, limit);
        return { ok: true };
      },
    },
  ];

  try {
    await runtime.run({
      agentId,
      tools,
      maxTurns: 2,
      toolChoice: { type: 'function', function: { name: 'submit_chronicle' } },
      log,
      scene: `chronicle_${occasion}`,
      domainId: domain?.id,
      extraSystem: [
        domain?.name ? `Город «${domain.name}».` : '',
        'Календарную дату в текст не пиши: она стоит на записи отдельно.',
      ]
        .filter(Boolean)
        .join(' ') || null,
      userMessages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    log.warn('chronicler.failed', { error: err.message });
    return null;
  }
  if (!draft.text) {
    log.warn('chronicler.empty', { occasion });
    return null;
  }
  log.info('chronicler.done', { occasion, preview: truncate(draft.text, 140) });
  return { text: draft.text };
}
