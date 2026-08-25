/**
 * Возраст людей: агент даёт полные годы, месяц рождения ставит движок
 * и раз в год прибавляет год в этот месяц.
 */

function clampAgeYears(n, fallback = 32) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.max(3, Math.min(99, v));
}

function rollAdultAge(rng = Math.random) {
  return 18 + Math.floor(rng() * 43);
}

function refreshPersonText(person) {
  if (!person || typeof person !== 'object') return;
  if (!Array.isArray(person.tags) || !person.tags.includes('character')) return;
  person.text = [
    person.name,
    Number.isFinite(Number(person.ageYears)) ? `${person.ageYears} лет` : null,
    person.role,
    person.about,
  ]
    .filter(Boolean)
    .join(' — ')
    .slice(0, 500);
}

/** Проставить возраст и месяц рождения, если их ещё нет. */
export function stampPersonAge(person, world, { ageYears = null, rng = Math.random } = {}) {
  if (!person || typeof person !== 'object') return person;
  if (!Number.isFinite(Number(person.ageYears))) {
    person.ageYears = clampAgeYears(ageYears, rollAdultAge(rng));
  } else {
    person.ageYears = clampAgeYears(person.ageYears);
  }
  const month = Math.round(Number(person.birthMonth));
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    person.birthMonth = 1 + Math.floor(rng() * 12);
  } else {
    person.birthMonth = month;
  }
  const year = Number(world?.gameDate?.year);
  const nowMonth = Number(world?.gameDate?.month);
  if (!Number.isFinite(Number(person.agedInYear))) {
    person.agedInYear =
      Number.isFinite(year) && Number.isFinite(nowMonth)
        ? person.birthMonth <= nowMonth
          ? year
          : year - 1
        : 0;
  }
  refreshPersonText(person);
  return person;
}

export function maybeBirthday(person, world) {
  if (!person || person.status === 'dead') return false;
  stampPersonAge(person, world);
  const year = Number(world?.gameDate?.year);
  const month = Number(world?.gameDate?.month);
  if (!Number.isFinite(year) || month !== person.birthMonth) return false;
  if (year <= Number(person.agedInYear)) return false;
  person.ageYears = clampAgeYears(person.ageYears + 1);
  person.agedInYear = year;
  refreshPersonText(person);
  return true;
}

export function ageDomainPeople(domain, world) {
  if (!domain) return domain;
  for (const ch of domain.characters || []) maybeBirthday(ch, world);
  for (const c of domain.lore || []) {
    if (!(c.tags || []).includes('character')) continue;
    maybeBirthday(c, world);
  }
  return domain;
}
