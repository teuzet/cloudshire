const ENGLISH_WORD =
  /\b(?:progress|ok|okay|please|hello|update|status|building|already|done|help|thanks|welcome)\b/i;
const NUMBERED_LIST = /(?:^|\n)\s*(?:\d+[\.\)]\s+|[-*•]\s+)/;
const ALREADY_BUILDING =
  /(?:уже\s+(?:начал[аи]?|стро(?:ю|им|ит)|возвод(?:им|ю)|вед(?:ём|ем)\s+работ)|работ[ыа]\s+(?:ид[уё]т|начались)|мы\s+уже\s+(?:строим|возводим))/i;

/**
 * @param {{ player: string, ruler: string, toolTrace?: object[] }} turn
 * @param {{ pendingBefore?: object[], pendingAfter?: object[] }} ctx
 */
export function analyzeTurn(turn, ctx = {}) {
  const flags = [];
  const reply = turn.ruler || '';

  if (ENGLISH_WORD.test(reply)) {
    flags.push('english_in_ruler_reply');
  }
  if (NUMBERED_LIST.test(reply)) {
    flags.push('list_like_ruler_reply');
  }
  if (ALREADY_BUILDING.test(reply)) {
    const declared = (turn.toolTrace || []).some((t) => t.name === 'declare_action');
    const hadPending = (ctx.pendingAfter || []).some((a) => a.status === 'active');
    if (!declared && !hadPending) {
      flags.push('claims_building_without_pending');
    } else if (declared || hadPending) {
      flags.push('claims_already_building_while_pending');
    }
  }

  return flags;
}

/**
 * @param {object[]} transcript
 * @param {object} domain
 */
export function collectFlags(transcript, domain) {
  const pending = (domain.state?.pendingActions || []).filter((a) => a.status === 'active');
  const all = [];
  const talks = transcript.filter((t) => t.kind !== 'tick');
  const ticks = transcript.filter((t) => t.kind === 'tick');

  if (ticks.length > 0 && talks.length === 0) {
    all.push({ step: 0, flag: 'zero_talks_only_ticks' });
  }

  for (const turn of transcript) {
    if (turn.kind === 'tick') continue;
    const flags = analyzeTurn(turn, { pendingAfter: pending });
    for (const f of flags) {
      all.push({ step: turn.step ?? turn.turn, flag: f });
    }
  }
  return all;
}
