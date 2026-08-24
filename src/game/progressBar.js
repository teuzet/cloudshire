const BAR = 8;

export function formatProgressBar(step, total, label) {
  const max = Math.max(1, Number(total) || 1);
  const now = Math.max(0, Math.min(max, Number(step) || 0));
  const filled = Math.round((now / max) * BAR);
  const bar = `${'▓'.repeat(filled)}${'░'.repeat(BAR - filled)}`;
  const text = String(label || '').trim();
  return `Создаю летающий остров\n${bar}  ${text}`.trim();
}
