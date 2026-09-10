/**
 * Канон сопряжения: одно структурное событие → летопись каждого задетого города.
 * Работа субъектификатора, вход — данные, не нейтральная проза.
 */

import { writeChronicle } from './chronicler.js';
import { appendChronicle } from './freeform.js';

export function confluxEvent({
  kind,
  day = 0,
  actorDomainId = null,
  targetDomainId = null,
  deed = null,
  outcome = null,
  plotId = null,
  passageState = null,
  learnedHow = null,
  statDeltas = null,
  textHint = '',
} = {}) {
  return {
    kind: String(kind || 'event'),
    day: Math.round(Number(day) || 0),
    actorDomainId: actorDomainId ? String(actorDomainId) : null,
    targetDomainId: targetDomainId ? String(targetDomainId) : null,
    deed: deed || null,
    outcome: outcome || null,
    plotId: plotId || null,
    passageState: passageState || null,
    learnedHow: learnedHow || null,
    statDeltas: statDeltas || null,
    textHint: String(textHint || '').trim(),
  };
}

function touches(event, domainId) {
  if (!event || !domainId) return false;
  const id = String(domainId);
  if (event.actorDomainId === id) return true;
  if (event.targetDomainId === id) return true;
  if (!event.actorDomainId && !event.targetDomainId) return true;
  return false;
}

function oneSidedVictim(event, domainId) {
  const id = String(domainId);
  return (
    event.targetDomainId === id &&
    event.actorDomainId &&
    event.actorDomainId !== id &&
    (event.outcome === 'secret_ok' || event.kind === 'sabotage_hidden')
  );
}

function viewpointPrompt(event, domain, partner) {
  const self = domain?.name || 'этот город';
  const other = partner?.name || 'соседний город';
  const actorIsSelf = event.actorDomainId === domain.id;
  const targetIsSelf = event.targetDomainId === domain.id;
  const who =
    actorIsSelf && targetIsSelf
      ? `Событие произошло у нас в «${self}».`
      : actorIsSelf
        ? `Действовали мы («${self}»), сторона — «${other}».`
        : targetIsSelf
          ? `Действовал сосед («${other}»), задеты мы («${self}»).`
          : `Событие на сопряжении «${self}» и «${other}».`;
  const hidden = oneSidedVictim(event, domain.id)
    ? 'Мы видели следствие, причины не знаем. Причину не выдумывай и не раскрывай.'
    : '';
  return [
    who,
    event.textHint ? `Что случилось: ${event.textHint}` : '',
    event.deed?.summary ? `Поручение (не повторяй как отчёт): ${event.deed.summary}` : '',
    event.outcome ? `Исход: ${event.outcome}` : '',
    event.passageState ? `Проход сейчас: ${event.passageState}` : '',
    event.learnedHow ? `Как узнали: ${event.learnedHow}` : '',
    hidden,
    'Пиши летопись ЭТОГО города. Соседа не делай «нами».',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Записать событие пары. Город, которого оно не коснулось, записи не получает.
 */
export async function writePairChronicle({
  runtime,
  world,
  event,
  domains = [],
  conflux = null,
  log,
} = {}) {
  const facts = [];
  if (!event) return facts;
  for (const domain of domains) {
    if (!touches(event, domain.id)) continue;
    const partner = domains.find((d) => d.id !== domain.id) || null;
    const prompt = viewpointPrompt(event, domain, partner);
    const written = runtime
      ? await writeChronicle({
          runtime,
          domain,
          occasion: 'дело',
          prompt,
          log,
        })
      : null;
    const text = String(written?.text || event.textHint || '').trim();
    if (!text) continue;
    const fact = appendChronicle(domain, world, {
      text,
      plotId: event.plotId || conflux?.container?.id || conflux?.mainPlotId || null,
      author: 'chronicler',
      importance: 'major',
      tags: ['chronicle', 'conflux', conflux?.id ? `conflux:${conflux.id}` : null].filter(Boolean),
      day: event.day,
    });
    facts.push({ domainId: domain.id, fact });
  }
  return facts;
}
