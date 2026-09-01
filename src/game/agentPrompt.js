/** Снимок реального пакета агента: system + user + tools. */

export function formatAgentPrompt(packed) {
  if (!packed) return '';
  const lines = [];
  if (packed.agentId) lines.push(`agent: ${packed.agentId}`);
  if (packed.provider || packed.model) {
    lines.push(`model: ${[packed.provider, packed.model].filter(Boolean).join('/')}`);
  }
  lines.push('', '=== SYSTEM ===', packed.systemContent || '');
  for (const msg of packed.messages || []) {
    if (msg.role === 'system') continue;
    lines.push('', `=== ${String(msg.role || 'user').toUpperCase()} ===`, msg.content || '');
  }
  if (packed.tools?.length) {
    lines.push('', '=== TOOLS ===', JSON.stringify(packed.tools, null, 2));
  }
  return lines.join('\n').trim();
}

export function captureAgentPrompt(runtime, opts) {
  const userOnly = (opts?.userMessages || [])
    .map((m) => m.content || '')
    .filter(Boolean)
    .join('\n\n');
  if (typeof runtime?.assembleChat !== 'function') return userOnly;
  try {
    return formatAgentPrompt(
      runtime.assembleChat({
        agentId: opts.agentId,
        extraSystem: opts.extraSystem || '',
        userMessages: opts.userMessages || [],
        tools: opts.tools || [],
      }),
    );
  } catch {
    return userOnly;
  }
}
