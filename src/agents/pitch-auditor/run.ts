/**
 * Сверщик генезиса: каждая деталь питча есть в брифе или объектом. Пропавшие детали поток добирает
 * новыми объектами (world-objects-genesis в режиме добора).
 */

import type { WorldObject } from '../../core/city.js';
import { composeSystem, loadPrompt } from '../_shared/canon.js';
import { bullets, section } from '../_shared/format.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { auditSchema, type AuditRaw } from './schema.js';

export interface PitchAuditInput {
  pitch: string;
  brief: string;
  objects: ReadonlyArray<Pick<WorldObject, 'name' | 'description'>>;
}

export interface PitchAudit {
  found: Array<{ detail: string; place: string }>;
  missing: string[];
}

const prompt = loadPrompt(import.meta.url);
const norm = (s: string): string => s.trim().toLowerCase();

export const pitchAuditor: StructuredAgent<PitchAuditInput, AuditRaw, PitchAudit> = {
  name: 'pitch-auditor',
  tool: 'submit_audit',
  description: 'Каждая деталь питча и где она в городе: объект, brief или missing.',
  schema: auditSchema,
  system: () => composeSystem([], prompt),
  user: ({ pitch, brief, objects }) =>
    [
      section('ПИТЧ', pitch),
      section('БРИФ', brief),
      section('ОБЪЕКТЫ', bullets(objects.map((o) => `${o.name}: ${o.description}`))),
      'Найди каждую деталь питча. Вызови submit_audit.',
    ].join('\n\n'),
  check: (raw, { objects }) => {
    const names = new Set(objects.map((o) => norm(o.name)));
    const unknown = raw.details.map((d) => d.place).filter((p) => !['brief', 'missing'].includes(norm(p)) && !names.has(norm(p)));
    return unknown.length ? `таких объектов нет в списке: ${unknown.join(', ')}. place — имя ровно как в списке, brief или missing.` : null;
  },
  finish: (raw) => ({
    found: raw.details.filter((d) => norm(d.place) !== 'missing'),
    missing: raw.details.filter((d) => norm(d.place) === 'missing').map((d) => d.detail),
  }),
};

export async function auditPitch(deps: AgentDeps, input: PitchAuditInput): Promise<PitchAudit> {
  return (await runStructured(deps, pitchAuditor, input)).value;
}
