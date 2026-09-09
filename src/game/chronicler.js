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
import { findOfficer } from './officers.js';
import { findPlotEnding } from './freeform.js';
import { livesLeft } from './threats.js';
import { toolFail } from '../agents/toolResult.js';

export const CHRONICLE_ENTRY_MAX = 400;

/** Поводы для записи. Совпадают с поводами вести, кроме новой истории: её пишет посев. */
export const CHRONICLE_OCCASIONS = ['дело', 'угроза', 'разрешение'];

/** Сколько прошлых записей истории показать: хвоста хватает, начало живёт в синопсисе. */
export const CHRONICLE_TAIL = 6;

const FINISH_WORD = {
  fail: 'ПРОВАЛ: цель не достигнута или достигнута лишь частично',
  ok: 'УСПЕХ: цель достигнута, возможна небольшая негативная побочка',
  crit: 'ПОЛНЫЙ УСПЕХ: цель достигнута особенно удачно',
};

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

/** Запасная запись, если модель не ответила. Без названий дел и историй. */
export function fallbackDeedEntry(process, finish) {
  const what = String(process?.goal || process?.detail || '').trim();
  const tail = what ? `: ${what}` : '.';
  if (finish === 'fail') return `Порученную работу довести не удалось${tail}`;
  return `Порученную работу закончили${tail}`;
}

function who(domain, process) {
  const officer = findOfficer(domain, {
    officerId: process?.officerId,
    office: process?.office,
  });
  if (officer?.name) return `${officer.title} ${officer.name}`;
  if (process?.characterName) return String(process.characterName);
  return null;
}

/**
 * Что механика сделала с историей — словами, без чисел.
 *
 * Это главный вход хрониста: именно отсюда он узнаёт, что осмотр лестницы
 * ничего не починил, а только выяснил. Без этой строки агент домысливает
 * благополучный ремонт, и синопсис уезжает в развязку на первом же деле.
 */
export function deedConsequenceLines({ plot, applied, threat = null, closed = false }) {
  const lines = [];
  const alignment = applied?.alignment || 'UNRELATED';
  const finish = applied?.finish || 'ok';

  if (!plot) {
    lines.push('Эта работа ни с какой городской историей не связана: просто исполненное поручение.');
    return lines;
  }

  if (alignment === 'DIRECT') {
    if (finish === 'fail') {
      lines.push('Работа била прямо в суть истории и не вышла. Вопрос остался неразрешённым, и цена промаха уже видна.');
    } else if (closed) {
      lines.push('Это и есть развязка истории: суть вопроса решена.');
    } else {
      lines.push(
        'Работа продвинула суть истории, но не решила её. Пиши только достигнутое, ' +
          'не пиши, что вопрос закрыт или что беды больше нет.',
      );
    }
  } else if (alignment === 'RELEVANT') {
    if (finish === 'fail') {
      lines.push('Работа должна была снять нависшее, но не справилась: нависшее осталось.');
    } else if (threat?.text) {
      lines.push(`Нависшее снято, этого уже не случится: ${threat.text}`);
      lines.push('Пиши, что именно предотвратили. Саму беду как случившуюся не пиши.');
    } else {
      lines.push('Работа сняла одну нависшую над городом беду.');
    }
  } else if (alignment === 'DANGEROUS') {
    if (applied?.fired && threat?.text) {
      lines.push(`Работа своей цели достигла, но ценой беды, и беда случилась: ${threat.text}`);
    } else if (finish === 'fail') {
      lines.push('Опасная работа не вышла — и тем город уберёгся.');
    } else {
      lines.push('Работа достигла цели, но подточила и без того шаткое: нависшее стало ближе.');
    }
  } else {
    lines.push(
      'Историю это не двигает: работа сама по себе, её итог не меняет положения дел. ' +
        'Не приписывай ей сдвига в истории.',
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
  const own = String(ending?.text || '').trim();
  if (own) return own;
  return String(findPlotEnding(plot, ending?.endingId)?.text || '').trim() || null;
}

function plotBlock(plot, chronicleTail = []) {
  if (!plot) return [];
  const lines = [`ЧАСТЬ ИСТОРИИ (название — служебное, в запись не выноси): ${plot.title || '—'}`];
  if (plot.synopsis) lines.push(`Как обстояло до сего дня: ${plot.synopsis}`);
  if (chronicleTail.length) {
    lines.push('Уже записано по этой истории (не отменяй и не повторяй):');
    for (const t of chronicleTail) lines.push(`- ${t}`);
  }
  return lines;
}

/**
 * Запись о завершившемся деле.
 *
 * `chronicleTail` — хвост хроники этой истории: без него агент пишет заново
 * то, что уже записано, и город каждый раз находит одну и ту же протечку.
 */
export function formatDeedPrompt({
  domain,
  plot,
  process,
  applied,
  threat = null,
  closed = false,
  ending = null,
  chronicleTail = [],
  dateLabel = '',
}) {
  const actor = who(domain, process);
  const finale = closed ? endingText(plot, ending) : null;
  return [
    'ПОВОД: закончилась работа, которую город вёл по воле покровителя.',
    dateLabel ? `Когда: ${dateLabel}.` : null,
    '',
    'ЧТО БЫЛО ПОРУЧЕНО (служебная формулировка, в запись её не переписывай):',
    process?.detail || process?.summary || '—',
    process?.goal ? `Чего добивались: ${process.goal}` : null,
    actor ? `Кто вёл: ${actor}.` : 'Кто вёл: город сам, без названного лица.',
    `ИСХОД (решено броском, не спорь): ${FINISH_WORD[applied?.finish] || FINISH_WORD.ok}.`,
    '',
    ...deedConsequenceLines({ plot, applied, threat, closed }),
    finale ? `Развязка истории, к которой это привело: ${finale}` : null,
    '',
    ...plotBlock(plot, chronicleTail),
    '',
    'Напиши одну запись хроники о том, что случилось в городе. Вызови submit_chronicle.',
  ]
    .filter((l) => l != null)
    .join('\n');
}

/**
 * Запись о сработавшем обязательстве мира.
 *
 * Текст угрозы написан в будущем времени — это предсказание, которое движок
 * держал до срока. В хронику оно должно попасть уже случившимся, иначе
 * летопись начинает пророчествовать.
 */
export function formatThreatPrompt({
  plot,
  threat,
  kind = 'threat',
  closed = false,
  severity = null,
  chronicleTail = [],
  dateLabel = '',
}) {
  const resolution = kind === 'resolution';
  return [
    resolution
      ? 'ПОВОД: беда выдохлась сама. Город привык, вопрос перестал быть вопросом.'
      : 'ПОВОД: город не успел, и то, чего боялись, случилось.',
    dateLabel ? `Когда: ${dateLabel}.` : null,
    '',
    'ЭТО БЫЛО НАПИСАНО ЗАРАНЕЕ, В БУДУЩЕМ ВРЕМЕНИ. Теперь оно произошло:',
    threat?.text || '—',
    'Перепиши это как случившееся, в прошедшем времени, со своими подробностями места и людей.',
    'Не пиши, что это ещё только случится или что этого можно избежать.',
    severity && !resolution ? `Насколько тяжело (полоса движка, в запись не выноси): ${severity}.` : null,
    closed
      ? resolution
        ? 'Этим история кончается: без победы и без крушения. Напиши, чем всё улеглось.'
        : 'Этим история кончается плохо. Напиши развязку, а не подступ к ней.'
      : 'История не закрыта: беда случилась, но вопрос остался. Не пиши итог и мораль.',
    '',
    ...plotBlock(plot, chronicleTail),
    '',
    'Напиши одну запись хроники. Вызови submit_chronicle.',
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
  log: parentLog,
} = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'chronicler', domainId: domain?.id });
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
              `Что случилось в городе, до ${CHRONICLE_ENTRY_MAX} символов. Сухо и предметно, ` +
              'в прошедшем времени. Без названий дел и историй, без кавычек с названиями.',
          },
        },
      },
      handler: async ({ entry }) => {
        const text = String(entry || '').trim();
        if (!text) return toolFail('empty', 'Нужна запись.');
        draft.text = text.slice(0, CHRONICLE_ENTRY_MAX);
        return { ok: true };
      },
    },
  ];

  try {
    await runtime.run({
      agentId: 'chronicler',
      tools,
      maxTurns: 2,
      toolChoice: { type: 'function', function: { name: 'submit_chronicle' } },
      log,
      scene: `chronicle_${occasion}`,
      domainId: domain?.id,
      extraSystem: domain?.name ? `Город «${domain.name}».` : null,
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
