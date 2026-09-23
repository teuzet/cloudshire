/**
 * Лестница выравнивания дела на нити.
 *
 * Порядок вопросов жёсткий, и он важен: сначала «закрывает ли», потом
 * «предотвращает ли», потом «не вызовет ли». Первое совпадение выигрывает,
 * иначе агент будет ставить DANGEROUS всему, что вообще касается беды.
 */

export const DEED_ALIGNMENTS = ['DIRECT', 'RELEVANT', 'DANGEROUS', 'UNRELATED'];

export function parseAlignment(raw, fallback = 'UNRELATED') {
  const key = String(raw || '').trim().toUpperCase();
  return DEED_ALIGNMENTS.includes(key) ? key : fallback;
}

/** Дело числится на нити и занимает её внимание. */
export function alignmentAttends(alignment) {
  return alignment === 'DIRECT' || alignment === 'RELEVANT' || alignment === 'DANGEROUS';
}

/** Жрец обязан переспросить: игрок целится не туда или прямо себе во вред. */
export function alignmentNeedsWarning(alignment) {
  return alignment === 'DANGEROUS' || alignment === 'UNRELATED';
}

export const ALIGNMENT_WARNING = {
  DANGEROUS:
    'Это не отведёт беду, а ускорит её. Скажи прямо, чем именно это грозит, и переспроси. Настоит — исполняй.',
  UNRELATED:
    'Это истории не двигает. Скажи, что делу здесь нечего решать, и предложи то, что решает. Настоит — прими как отдельное поручение.',
};

export const ALIGNMENT_LADDER = [
  'DIRECT — успех работает по первопричине истории.',
  'RELEVANT — успех снимает одну или несколько бед. По каждой беде: blocked и why.',
  'DANGEROUS — успех сам вызывает одну беду. Укажи её id в causesThreatId.',
  'UNRELATED — даже полный успех историю не двигает.',
];

export function applyAlignment(process, alignment, { threatId = '', threatIds = [] } = {}) {
  const value = parseAlignment(alignment);
  const ids = [...(Array.isArray(threatIds) ? threatIds : []), threatId]
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  const unique = [...new Set(ids)];
  if (process) {
    process.plotEngagement = value;
    process.plotAligned = value === 'DIRECT';
    process.endingId = '';
    process.threatIds = value === 'RELEVANT' ? unique : value === 'DANGEROUS' ? unique.slice(0, 1) : [];
    process.threatId = process.threatIds[0] || '';
  }
  return value;
}

export function alignmentOf(process) {
  const raw = String(process?.plotEngagement || '').toUpperCase();
  if (DEED_ALIGNMENTS.includes(raw)) return raw;
  if (process?.plotAligned === true) return 'DIRECT';
  if (process?.plotAligned === false) return 'RELEVANT';
  return null;
}
