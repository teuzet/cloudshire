/**
 * Принудительный посев и снятие истории в тестовом клиенте.
 * Живой конвейер тот же (plantStakedStory), зерно и gravity выбирает человек.
 */

import { yearChronicleGrain, formatChronicleGrain, cityGenesisGrainText } from './seedChannels.js';
import {
  findPlotline,
  plotHasLiveProcess,
  parseFreeformGravity,
  FREEFORM_GRAVITY,
  plotConfig,
  countOpen,
} from './plotlines.js';
import { liveThreats } from './threats.js';
import { cancelJobsForPlot } from './scheduler.js';

export const PLAY_SEED_GRAINS = ['genesis', 'chronicle', 'void'];
export const PLAY_DEED_FINISHES = ['fail', 'ok', 'crit'];

export function parsePlaySeedGrain(raw) {
  const key = String(raw || '')
    .trim()
    .toLowerCase();
  if (PLAY_SEED_GRAINS.includes(key)) return key;
  if (key === 'city' || key === 'description') return 'genesis';
  return null;
}

/** Исход дела для кнопок тестового клиента: провал / успех / крит. */
export function parsePlayDeedFinish(raw) {
  const key = String(raw || '')
    .trim()
    .toLowerCase();
  if (PLAY_DEED_FINISHES.includes(key)) return key;
  return null;
}

function factOwnedByPlot(fact, plot) {
  const id = String(plot?.id || '');
  if (!id || !fact) return false;
  if (String(fact.sourcePlotId || '') === id) return true;
  if ((plot.chronicleIds || []).map(String).includes(String(fact.id))) return true;
  if ((plot.factIds || []).map(String).includes(String(fact.id))) return true;
  return false;
}

export function dropPlayStoryBlocker(domain, plot) {
  if (!plot) return { error: 'not_found', message: 'такой истории нет' };
  if (plot.kind !== 'story') {
    return { error: 'not_story', message: 'снять можно только городскую историю' };
  }
  if (plot.shared || plot.isMainConflux || plot.confluxId) {
    return { error: 'conflux', message: 'нить сопряжения отсюда не снимают' };
  }
  if (plotHasLiveProcess(domain, plot)) {
    return { error: 'has_deeds', message: 'на истории ещё есть дело' };
  }
  return null;
}

export function canDropPlayStory(domain, plot) {
  return dropPlayStoryBlocker(domain, plot) == null;
}

/**
 * Снять историю с доски вместе с её хроникой. В архив не кладём:
 * это отладочная отмена посева, а не закрытие сюжета.
 */
export function dropPlayStory(domain, world, plotId, { day = 0 } = {}) {
  const plot = findPlotline(domain, plotId);
  const blocked = dropPlayStoryBlocker(domain, plot);
  if (blocked) return { ok: false, ...blocked };

  for (const threat of liveThreats(plot)) {
    threat.status = 'cancelled';
    threat.cancelledDay = day;
    threat.cancelReason = 'история снята';
  }
  if (world) cancelJobsForPlot(world, plot.id);

  let droppedLore = 0;
  domain.lore = (domain.lore || []).filter((fact) => {
    if (!factOwnedByPlot(fact, plot)) return true;
    droppedLore += 1;
    return false;
  });
  const droppedId = String(plot.id);
  for (const fact of domain.lore) {
    if (!Array.isArray(fact.relatedPlotlineIds)) continue;
    fact.relatedPlotlineIds = fact.relatedPlotlineIds.filter((id) => String(id) !== droppedId);
    if (String(fact.sourcePlotId || '') === droppedId) delete fact.sourcePlotId;
  }

  domain.plotlines = (domain.plotlines || []).filter((p) => String(p.id) !== String(plot.id));
  if (Array.isArray(domain.modifiers)) {
    domain.modifiers = domain.modifiers.filter((m) => String(m.plotId || '') !== String(plot.id));
  }

  return { ok: true, plotId: plot.id, title: plot.title, droppedLore };
}

export function packPlaySeedGrain(domain, world, { grain, gravity, config } = {}) {
  const g = parseFreeformGravity(gravity);
  const source = parsePlaySeedGrain(grain);
  if (!source) {
    return { ok: false, error: 'bad_grain', message: 'зерно: genesis, chronicle или void' };
  }
  const maxOpen = plotConfig(config).board.maxOpen;
  if (countOpen(domain).stories >= maxOpen) {
    return {
      ok: false,
      error: 'board_full',
      message: `на доске уже ${maxOpen} ${maxOpen === 1 ? 'история' : 'истории'} — сначала сними одну`,
    };
  }

  if (source === 'genesis') {
    const seedText = cityGenesisGrainText(domain);
    if (!seedText) {
      return { ok: false, error: 'no_brief', message: 'описания города ещё нет' };
    }
    return {
      ok: true,
      grain: 'genesis',
      gravity: g,
      seedText,
      fromVoid: false,
      fromGenesis: true,
    };
  }
  if (source === 'void') {
    return {
      ok: true,
      grain: 'void',
      gravity: g,
      seedText: '',
      fromVoid: true,
      fromGenesis: false,
    };
  }

  const seedText = formatChronicleGrain(yearChronicleGrain(domain, world));
  if (!seedText) {
    return {
      ok: false,
      error: 'no_chronicle',
      message: 'в хронике за год нет записей вне живых историй',
    };
  }
  return {
    ok: true,
    grain: 'chronicle',
    gravity: g,
    seedText,
    fromVoid: false,
    fromGenesis: false,
  };
}

export { FREEFORM_GRAVITY };
