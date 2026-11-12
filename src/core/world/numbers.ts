/**
 * Все числа системы фронтов: ёмкость, масштаб, скорость, шанс осложнения.
 * Агенты дают только ярлыки (класс вклада, ступень риска, вердикт) — в числа их переводит этот файл.
 */

import {
  emptyStatMap,
  GRADES,
  RISK_STEPS,
  STAT_IDS,
  type Grade,
  type Impact,
  type ObjectType,
  type RiskStep,
  type Rules,
  type StatGrade,
  type StatId,
  type StatMap,
  type Temper,
  type Tempo,
  type Verdict,
} from '../rules.js';
import type { City, Officer } from '../city.js';
import { DAYS_PER_MONTH } from '../time.js';

const round2 = (n: number) => Math.round(n * 100) / 100;

// ───────────────────────────── вклад ─────────────────────────────

/** Сырой бюджет веса объекта генезиса и посаженной истории. */
export function impactRawBudget(rules: Rules, impact: Impact): number {
  return rules.fronts.impact.rawBudget[impact];
}

/** Классы вклада → пункты статов со знаком. */
export function gradePoints(rules: Rules, effects: readonly StatGrade[]): StatMap {
  const out = emptyStatMap();
  for (const e of effects) out[e.stat] = (e.direction === 'down' ? -1 : 1) * rules.fronts.contribution[e.size];
  return out;
}

/** Пункты → ближайшие классы: так вклад существующего объекта показывают агентам. */
export function pointsToGrades(rules: Rules, points: Partial<StatMap>): StatGrade[] {
  const table = rules.fronts.contribution;
  const out: StatGrade[] = [];
  for (const stat of STAT_IDS) {
    const v = Number(points[stat]) || 0;
    const abs = Math.abs(v);
    if (abs < table.small / 2) continue;
    let size: Grade = 'small';
    let best = Infinity;
    for (const g of GRADES) {
      const d = Math.abs(table[g] - abs);
      if (d < best) {
        best = d;
        size = g;
      }
    }
    out.push({ stat, direction: v < 0 ? 'down' : 'up', size });
  }
  return out;
}

/** Сумма модулей вклада: «сила изменения», знак не важен. */
export function magnitude(points: Partial<StatMap>): number {
  return round2(STAT_IDS.reduce((acc, id) => acc + Math.abs(Number(points[id]) || 0), 0));
}

export function diffPoints(a: Partial<StatMap>, b: Partial<StatMap>): StatMap {
  const out = emptyStatMap();
  for (const id of STAT_IDS) out[id] = round2((Number(a[id]) || 0) - (Number(b[id]) || 0));
  return out;
}

/** Стат с наибольшим модулем вклада: профиль дела. */
export function dominantStat(points: Partial<StatMap>): StatId | null {
  let best: StatId | null = null;
  let top = 0;
  for (const id of STAT_IDS) {
    const abs = Math.abs(Number(points[id]) || 0);
    if (abs > top) {
      top = abs;
      best = id;
    }
  }
  return best;
}

/** Сырые единицы объекта ↔ пункты стата города. */
export function rawToPoints(city: Pick<City, 'statScale'>, raw: Partial<StatMap>): StatMap {
  const out = emptyStatMap();
  for (const id of STAT_IDS) out[id] = round2((Number(raw[id]) || 0) * city.statScale);
  return out;
}

export function pointsToRaw(city: Pick<City, 'statScale'>, points: Partial<StatMap>): StatMap {
  const out = emptyStatMap();
  const scale = city.statScale > 0 ? city.statScale : 1;
  for (const id of STAT_IDS) out[id] = (Number(points[id]) || 0) / scale;
  return out;
}

// ───────────────────────────── ёмкость и масштаб ─────────────────────────────

export function basePrice(rules: Rules, kind: ObjectType | 'edit' | 'fact'): number {
  const p = rules.fronts.basePrice;
  return kind === 'edit' ? p.edit : kind === 'fact' ? p.fact : p.byType[kind];
}

/** Ёмкость дела с новым объектом: сумма модулей вклада плюс базовая цена вида. */
export function newObjectCapacity(rules: Rules, type: ObjectType, points: Partial<StatMap>): number {
  return round2(magnitude(points) + basePrice(rules, type));
}

/** Ёмкость перемены существующего объекта: сумма модулей разницы плюс половина базовой цены. */
export function changeCapacity(rules: Rules, type: ObjectType, delta: Partial<StatMap>): number {
  return round2(magnitude(delta) + basePrice(rules, type) / 2);
}

export function scaleOf(rules: Rules, capacity: number): { id: string; milestones: number } {
  const rows = rules.fronts.scale;
  const row = rows.find((r) => r.upTo == null || capacity <= r.upTo) ?? rows[rows.length - 1];
  if (!row) throw new Error('пустая таблица масштаба');
  return { id: row.id, milestones: row.milestones };
}

function share(atStake: number, part: number, min: number): number {
  return Math.max(min, round2(atStake * part));
}

/** Сколько работы нужно, чтобы снять угрозу, которая грозит `atStake`. */
export function threatCapacity(rules: Rules, atStake: number): number {
  return share(atStake, rules.fronts.threat.capacityShare, rules.fronts.threat.capacityMin);
}

/** Погасить напряжение до прорыва дешевле. */
export function quenchCapacity(rules: Rules, atStake: number): number {
  return share(atStake, rules.fronts.tension.quenchShare, rules.fronts.tension.quenchMin);
}

export function opportunityCapacity(rules: Rules, gain: number): number {
  return share(gain, rules.fronts.opportunity.capacityShare, rules.fronts.opportunity.capacityMin);
}

/** Дело, которое убирает помеху с фронта такой ёмкости. */
export function hindranceRemovalCapacity(rules: Rules, parentCapacity: number): number {
  return share(parentCapacity, rules.fronts.hindrance.removalShare, rules.fronts.hindrance.removalMin);
}

/** Атомарное дело «разовый вклад» для фронта такой ёмкости. */
export function pushCapacity(rules: Rules, parentCapacity: number): number {
  return share(parentCapacity, rules.fronts.push.share, rules.fronts.push.min);
}

// ───────────────────────────── темп и скорость ─────────────────────────────

export function temperTempo(temper: Temper): Tempo {
  return temper === 'hasty' ? 1 : temper === 'slow' ? -1 : 0;
}

/** Множитель скорости и шанса беды от суммы рычагов темпа. */
export function tempoFactor(rules: Rules, sum: number): number {
  return Math.max(0.1, round2(1 + rules.fronts.tempoStep * sum));
}

/** Поправка сановника: его стат и то, его ли это профиль. */
export function officerFit(rules: Rules, city: Pick<City, 'stats'>, officer: Pick<Officer, 'statId'>, profile: StatId | null): number {
  const w = rules.fronts.work;
  const stat = Math.max(0, Math.min(100, city.stats[officer.statId]));
  return round2(w.fitFloor + (w.fitSpan * stat) / 100 + (profile && profile === officer.statId ? w.profileBonus : 0));
}

/** Работа ведущего сановника за игровой день. */
export function leadRatePerDay(rules: Rules, args: { verdict: Verdict; tempoSum: number; fit: number }): number {
  const base = rules.fronts.work.unitsPerMonth / DAYS_PER_MONTH;
  return base * rules.fronts.verdict[args.verdict] * tempoFactor(rules, args.tempoSum) * args.fit;
}

/** Скорость помощника или помехи за игровой день. Спешка проекта ускоряет помощников, помехам всё равно. */
export function attachRatePerDay(rules: Rules, ratePerMonth: number, projectTempo: number): number {
  const perDay = ratePerMonth / DAYS_PER_MONTH;
  return perDay > 0 ? perDay * tempoFactor(rules, projectTempo) : perDay;
}

// ───────────────────────────── риск ─────────────────────────────

export function riskRank(step: RiskStep): number {
  return RISK_STEPS.indexOf(step);
}

/**
 * Шанс осложнения на вехе. Темп меняет частоту бед, не их тяжесть.
 * «Безопасно» при спешке бросает как «обычно»; «невозможно» не снижается.
 */
export function complicationChance(rules: Rules, step: RiskStep, tempoSum: number): number {
  const table = rules.fronts.risk.chance;
  if (step === 'impossible') return table.impossible;
  const base = step === 'safe' && tempoSum > 0 ? table.normal : table[step];
  return Math.max(0, Math.min(1, round2(base * tempoFactor(rules, tempoSum))));
}

/** Тяжесть выпавшего осложнения по ступени. `roll` — равномерное число в [0, 1). */
export function severityOf(rules: Rules, step: RiskStep, roll: number): 'light' | 'heavy' {
  return roll < rules.fronts.risk.heavyShare[step] ? 'heavy' : 'light';
}

/** Чем привязанное осложнение грозит делу на этой ступени. */
export function boundThreat(step: RiskStep): 'slow' | 'rollback' | 'cancel' {
  return riskRank(step) >= riskRank('risky') ? 'cancel' : step === 'hard' ? 'rollback' : 'slow';
}

export function monthsToDays(months: number): number {
  return Math.round(months * DAYS_PER_MONTH);
}
