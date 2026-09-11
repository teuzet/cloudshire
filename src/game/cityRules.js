/**
 * Постоянный порядок города — обычное дело, а не фабрика событий.
 *
 * Старые указы были отдельной подсистемой с собственными каденциями: раз в
 * месяц, с шансом, на стыковке. Это давало ровно две плохие крайности —
 * либо указ ничего не производил и был незаметен, либо производил слишком
 * много и топил игрока в однообразных записях.
 *
 * Теперь всё проще. Объявить правило — дело полосы `DAYS`; оно может и не
 * выйти («объявили, но не приняли»). Успех дописывает строку в постоянные
 * изменения города, а дальше правило просто окрашивает посев по общим
 * правилам: события рождаются угрозами историй, а не расписанием указа.
 *
 * Доверенность — свободный текст правителя себе на потом. Её читает
 * дешёвый судья на стыковке и на ходе нити; дело заводит сановник, если решит.
 */

import { newId } from './ids.js';
import { appendCityModifier, normalizeCityModifiers } from './cityContext.js';
import { dropSeedRequestsForOrder, enqueueSeedRequest } from './seedSchedule.js';
import { gameDateFromDay } from './gameClock.js';
import { pauseDeedClock, startDeed } from './deeds.js';
import {
  bindOfficerProcess,
  findOfficer,
  listOfficers,
  officerActiveProcess,
  pickRandomFreeOfficer,
  releaseOfficerProcess,
} from './officers.js';

/** Что дело делает с постоянным порядком. */
export const RULE_ACTIONS = ['declare', 'revoke'];

/** Правило объявляется словом: это дни, а не сезон. */
export const RULE_DURATION_BAND = 'DAYS';

/** Объявить порядок нетрудно; трудно, чтобы его приняли. */
export const RULE_DIFFICULTY = 'PLAIN';

export function parseRuleAction(raw, fallback = 'declare') {
  const key = String(raw || '').trim().toLowerCase();
  return RULE_ACTIONS.includes(key) ? key : fallback;
}

/** Дело об объявлении или отмене правила — по этим полям его узнаёт движок. */
export function isRuleDeed(process) {
  return Boolean(process?.ruleText) && RULE_ACTIONS.includes(parseRuleAction(process?.ruleAction, ''));
}

/**
 * Разметить дело как объявление правила. Срок и сложность фиксированы:
 * оценщику тут нечего решать, объявление везде одинаково быстрое.
 */
export function markRuleDeed(process, { text, action = 'declare', modifierId = null } = {}) {
  if (!process) return process;
  const body = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  if (!body) return process;
  process.ruleText = body;
  process.ruleAction = parseRuleAction(action);
  if (modifierId) process.ruleModifierId = String(modifierId);
  process.durationBand = RULE_DURATION_BAND;
  process.difficulty = RULE_DIFFICULTY;
  return process;
}

export function cityRules(domain) {
  normalizeCityModifiers(domain);
  return domain.modifiers;
}

export function findRule(domain, { modifierId = null, text = '' } = {}) {
  const list = cityRules(domain);
  if (modifierId) {
    const byId = list.find((m) => m.id === String(modifierId));
    if (byId) return byId;
  }
  const needle = String(text || '').trim().toLowerCase();
  if (!needle) return null;
  return (
    list.find((m) => m.text.toLowerCase() === needle) ||
    list.find((m) => m.text.toLowerCase().includes(needle) || needle.includes(m.text.toLowerCase())) ||
    null
  );
}

export function removeRule(domain, modifierId) {
  const list = cityRules(domain);
  const i = list.findIndex((m) => m.id === String(modifierId));
  if (i < 0) return null;
  const [removed] = list.splice(i, 1);
  return removed;
}

/**
 * Применить исход дела о правиле.
 *
 * Провал — не «ничего не случилось»: волю объявили, а город её не принял.
 * Это тоже событие, и о нём стоит рассказать.
 */
export function applyRuleDeed(domain, process, { finish = 'ok', day = 0, rng = Math.random } = {}) {
  if (!isRuleDeed(process)) return null;
  const action = parseRuleAction(process.ruleAction);
  const label = gameDateFromDay(day).label;

  if (finish === 'fail') {
    return {
      action,
      applied: false,
      text:
        action === 'declare'
          ? `Волю объявили, но город её не принял: ${process.ruleText}`
          : `Отменить прежний порядок не вышло, он держится сам: ${process.ruleText}`,
    };
  }

  if (action === 'revoke') {
    const rule = findRule(domain, { modifierId: process.ruleModifierId, text: process.ruleText });
    if (!rule) return { action, applied: false, text: `Такого порядка в городе уже нет: ${process.ruleText}` };
    removeRule(domain, rule.id);
    // Отмена гасит и отложенные последствия правила: они были его продолжением.
    const dropped = dropSeedRequestsForOrder(domain, rule.id);
    return {
      action,
      applied: true,
      ruleId: rule.id,
      droppedSeeds: dropped,
      text: `Прежний порядок отменён: ${rule.text}`,
    };
  }

  const mod = appendCityModifier(domain, { text: process.ruleText, sinceLabel: label });
  if (!mod) return { action, applied: false, text: `Волю не удалось облечь в порядок: ${process.ruleText}` };
  // Новое правило может дать последствия не сразу: они приходят посевом.
  enqueueSeedRequest(domain, { source: 'errand', sourceOrderId: mod.id, sourceProcessId: process.id, day, rng });
  return {
    action,
    applied: true,
    ruleId: mod.id,
    text: `Город живёт по новому порядку: ${mod.text}`,
  };
}

// ─────────────────────────── наказ на сопряжение ───────────────────────────

export function proxyText(domain) {
  return String(domain?.proxyText || domain?.state?.confluxDirective?.text || '').trim();
}

export function setProxyText(domain, text) {
  const body = String(text || '').replace(/\s+/g, ' ').trim();
  domain.proxyText = body;
  return { ok: true, proxyText: body };
}

export function formatCityRulesForPrompt(domain) {
  const rules = cityRules(domain);
  if (!rules.length) return '';
  return `Постоянный порядок города:\n${rules.map((m) => `- ${m.text}`).join('\n')}`;
}
