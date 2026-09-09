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
  'DIRECT — успех сам ставит одну из концовок карточки. Укажи endingId.',
  'RELEVANT — успех снимает одну из перечисленных угроз. Укажи threatId.',
  'DANGEROUS — успех сам вызывает угрозу или плохую концовку. Укажи threatId, который сработает.',
  'UNRELATED — даже полный успех историю не двигает.',
];

export function applyAlignment(process, alignment, { endingId = '', threatId = '' } = {}) {
  const value = parseAlignment(alignment);
  if (process) {
    process.plotEngagement = value;
    process.plotAligned = value === 'DIRECT';
    process.endingId = value === 'DIRECT' ? String(endingId || '') : '';
    process.threatId = value === 'RELEVANT' || value === 'DANGEROUS' ? String(threatId || '') : '';
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
