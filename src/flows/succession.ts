/**
 * Смертные жрец и сановники. Человек на должности — объект города; ставка крупной истории или воля
 * покровителя может его унести. Должность не пустует: преемник встаёт в тот же день, о смене пишет хроника,
 * покровитель получает сообщение системы.
 */

import type { City, Post } from '../core/city.js';
import { appendChronicle } from '../core/chronicle.js';
import { createHolder, postTitle, rollTemper } from '../core/officers.js';
import { findObject } from '../core/world/objects.js';
import type { OutboundMessage } from '../ports/notifier.js';
import { writeSuccessor } from '../agents/successor/run.js';
import { newId, returnNames, takeNames, tryAgent, type FlowDeps } from './context.js';

interface Seat {
  post: Post;
  person: { name: string; gender: 'female' | 'male'; nature: string; objectId?: string | null };
  focus: string;
}

function seats(deps: FlowDeps, city: City): Seat[] {
  return [
    { post: 'priest', person: city.priest, focus: 'правит городом и единственный говорит с покровителем' },
    ...city.officers.map((o) => ({ post: o.office, person: o, focus: deps.rules.officers.find((d) => d.office === o.office)?.focus ?? '' })),
  ];
}

/** Завести человека-объект для того, кто сидит на должности без него (город из старого сохранения). */
function adopt(deps: FlowDeps, city: City, seat: Seat, day: number): void {
  const obj = createHolder(deps.rules, { id: newId(deps, 'obj'), post: seat.post, ...seat.person, day });
  city.objects.push(obj);
  seat.person.objectId = obj.id;
}

/** Что случилось с человеком: последняя строка его памяти или общая формула. */
function causeOf(city: City, objectId: string): string {
  const obj = findObject(city, objectId);
  return obj?.log?.at(-1)?.text ?? 'его не стало';
}

/**
 * Занять пустые должности. Зови после всего, что исполняет ставки: дня города и хода жреца.
 * Возвращает сообщения покровителю о смене людей.
 */
export async function fillOffices(deps: FlowDeps, city: City, day: number): Promise<OutboundMessage[]> {
  const out: OutboundMessage[] = [];
  for (const seat of seats(deps, city)) {
    if (seat.person.objectId === undefined) {
      adopt(deps, city, seat, day);
      continue;
    }
    const obj = seat.person.objectId ? findObject(city, seat.person.objectId) : null;
    if (obj && obj.status === 'active') continue;

    const old = { name: seat.person.name, nature: seat.person.nature };
    const cause = seat.person.objectId ? causeOf(city, seat.person.objectId) : 'его не стало';
    const taken = new Set(seats(deps, city).map((s) => s.person.name));
    const names = (await takeNames(deps, 4)).filter((n) => !taken.has(n.name));
    const title = postTitle(deps.rules, seat.post, seat.person.gender);
    const fallbackName = names[0] ?? { name: `${old.name} Младший`, gender: seat.person.gender };
    const next = await tryAgent(
      deps,
      'successor',
      () => writeSuccessor(deps.agents, { cityName: city.name, brief: city.brief, post: title, focus: seat.focus, predecessor: old, cause, names }),
      { ...fallbackName, nature: 'Новый человек на должности, город ещё присматривается к нему.', arrival: `${fallbackName.name} занимает место, которое прежде занимал человек по имени ${old.name}.` },
    );
    await returnNames(deps, names.filter((n) => n.name !== next.name));

    seat.person.name = next.name;
    seat.person.gender = next.gender;
    seat.person.nature = next.nature;
    adopt(deps, city, seat, day);
    if (seat.post === 'priest') city.priest.predecessor = { name: old.name, day, cause };
    else {
      const officer = city.officers.find((o) => o.office === seat.post);
      if (officer) officer.temper = rollTemper(deps.random.rng);
    }

    const newTitle = postTitle(deps.rules, seat.post, next.gender);
    appendChronicle(city, { id: newId(deps, 'chr'), day, text: next.arrival, source: 'succession', frontId: null });
    out.push({
      ownerId: city.ownerId,
      text: `${old.name} больше не ${title}. ${newTitle[0]!.toUpperCase()}${newTitle.slice(1)} теперь ${next.name}.`,
      kind: 'system',
      cityId: city.id,
    });
    deps.log?.warn('succession', { cityId: city.id, post: seat.post, from: old.name, to: next.name });
  }
  return out;
}
