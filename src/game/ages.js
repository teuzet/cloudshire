/**
 * Возраст людей: агент даёт полные годы, движок запоминает год и месяц
 * рождения и считает возраст от текущей даты мира. Год может быть отрицательным.
 */

function clampAgeYears(n, fallback = 32) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.max(3, Math.min(99, v));
}

function rollAdultAge(rng = Math.random) {
  return 18 + Math.floor(rng() * 43);
}

function worldYearMonth(world) {
  const year = Number(world?.gameDate?.year);
  const month = Number(world?.gameDate?.month);
  return {
    year: Number.isFinite(year) ? Math.round(year) : null,
    month: Number.isInteger(month) && month >= 1 && month <= 12 ? month : null,
  };
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

function applyLookAge(person) {
  if (person?.look && typeof person.look === 'object') {
    person.look.ageYears = person.ageYears;
  }
}

/** Полных лет на дату мира. Без даты — то, что уже записано. */
export function personAgeYears(person, world) {
  const birthYear = Number(person?.birthYear);
  if (!Number.isFinite(birthYear)) {
    const raw = Number(person?.ageYears);
    return Number.isFinite(raw) ? clampAgeYears(raw) : null;
  }
  const { year, month } = worldYearMonth(world);
  if (year == null) {
    const raw = Number(person?.ageYears);
    return Number.isFinite(raw) ? clampAgeYears(raw) : null;
  }
  const birthMonth = Number(person?.birthMonth);
  let age = year - birthYear;
  if (month != null && Number.isInteger(birthMonth) && birthMonth >= 1 && birthMonth <= 12 && month < birthMonth) {
    age -= 1;
  }
  return clampAgeYears(age);
}

function ensureBirthYear(person, world, ageYears) {
  if (Number.isFinite(Number(person.birthYear))) {
    person.birthYear = Math.round(Number(person.birthYear));
    return;
  }
  const { year, month } = worldYearMonth(world);
  if (year == null) return;
  let birthYear = year - ageYears;
  if (month != null && person.birthMonth > month) birthYear -= 1;
  person.birthYear = birthYear;
}

/** Проставить год/месяц рождения, возраст посчитать от даты мира. */
export function stampPersonAge(person, world, { ageYears = null, rng = Math.random } = {}) {
  if (!person || typeof person !== 'object') return person;
  const month = Math.round(Number(person.birthMonth));
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    person.birthMonth = 1 + Math.floor(rng() * 12);
  } else {
    person.birthMonth = month;
  }
  const given = Number.isFinite(Number(person.ageYears))
    ? clampAgeYears(person.ageYears)
    : clampAgeYears(ageYears, rollAdultAge(rng));
  ensureBirthYear(person, world, given);
  const computed = personAgeYears(person, world);
  person.ageYears = computed ?? given;
  applyLookAge(person);
  refreshPersonText(person);
  return person;
}

export function maybeBirthday(person, world) {
  if (!person || person.status === 'dead') return false;
  const prev = Number(person.ageYears);
  stampPersonAge(person, world);
  return Number(person.ageYears) !== prev;
}

export function ageDomainPeople(domain, world) {
  if (!domain) return domain;
  for (const ch of domain.characters || []) maybeBirthday(ch, world);
  for (const o of domain.officers || []) maybeBirthday(o, world);
  for (const c of domain.lore || []) {
    if (!(c.tags || []).includes('character')) continue;
    maybeBirthday(c, world);
  }
  return domain;
}
