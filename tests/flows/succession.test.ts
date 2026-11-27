import { describe, expect, test } from 'vitest';
import { toolReply } from '../../src/adapters/llm/fake.js';
import { applyStake } from '../../src/core/world/stake.js';
import { fillOffices } from '../../src/flows/succession.js';
import { poolFrom } from '../helpers/genesis.js';
import { blankCity, rules } from '../helpers/fixtures.js';
import { stand } from '../helpers/game.js';

const r = rules();
let n = 0;
const ctx = (extra: Record<string, unknown> = {}) => ({ day: 10, newId: (p: string) => `${p}_${++n}`, ...extra });

describe('смертные жрец и сановники', () => {
  test('у города из старого сохранения люди на должностях становятся объектами без смены людей', async () => {
    const s = await stand();
    const city = blankCity();
    expect(await fillOffices(s.deps, city, 0)).toEqual([]);
    const holders = city.objects.filter((o) => o.holds);
    expect(holders.map((o) => o.name).sort()).toEqual(['Ада', 'Борислав', 'Вета', 'Гордей', 'Илан']);
    expect(city.priest.objectId).toBe(holders.find((o) => o.holds === 'priest')!.id);
    expect(city.chronicle).toHaveLength(0);
  });

  test('человека на должности уносит только ставка с правом на это', async () => {
    const s = await stand();
    const city = blankCity();
    await fillOffices(s.deps, city, 0);
    const marshal = city.officers.find((o) => o.office === 'marshal')!;
    // Обычная беда и помеха человека на должности не трогают.
    applyStake(r, city, [{ op: 'delete', target: marshal.objectId! }, { op: 'retire', target: marshal.objectId! }], ctx({ trouble: 'Пожар' }));
    expect(city.objects.find((o) => o.id === marshal.objectId)?.status).toBe('active');
    const res = applyStake(r, city, [{ op: 'delete', target: marshal.objectId! }], ctx({ trouble: 'Набег', holderLoss: true }));
    expect(city.objects.find((o) => o.id === marshal.objectId)?.status).toBe('deleted');
    expect(res.changes[0]).toMatchObject({ kind: 'object_removed', name: 'Борислав' });
  });

  test('пустую должность сразу занимает преемник: хроника, сообщение системы, поручение остаётся', async () => {
    const s = await stand();
    s.llm.always('successor', (req) =>
      toolReply('submit_successor', { name: poolFrom(req)[0], nature: 'Спокоен и упрям. Ведёт стражу без суеты.', arrival: 'Стражу принял новый маршал.' }),
    );
    const city = blankCity();
    await fillOffices(s.deps, city, 0);
    const marshal = city.officers.find((o) => o.office === 'marshal')!;
    marshal.assignmentId = 'as_1';
    const oldId = marshal.objectId!;
    applyStake(r, city, [{ op: 'delete', target: oldId }], ctx({ holderLoss: true }));
    const priestId = city.priest.objectId!;
    applyStake(r, city, [{ op: 'delete', target: priestId }], ctx({ holderLoss: true }));

    const out = await fillOffices(s.deps, city, 12);
    expect(marshal.name).not.toBe('Борислав');
    expect(marshal.assignmentId).toBe('as_1');
    expect(marshal.objectId).not.toBe(oldId);
    expect(city.objects.find((o) => o.id === marshal.objectId)).toMatchObject({ name: marshal.name, holds: 'marshal', status: 'active' });
    expect(city.priest.name).not.toBe('Илан');
    expect(city.priest.predecessor).toMatchObject({ name: 'Илан', day: 12 });
    expect(city.chronicle.filter((c) => c.source === 'succession')).toHaveLength(2);
    expect(out.map((m) => m.kind)).toEqual(['system', 'system']);
    expect(out[0]?.text).toContain('Илан больше не верховный жрец');
    // Имена новых людей вышли из пула мира, остальные вернулись.
    const pool = (await s.deps.storage.getWorld())!.namePool.map((p) => p.name);
    expect(pool).not.toContain(marshal.name);
    expect(pool).not.toContain(city.priest.name);
    expect(pool).toHaveLength(8);
  });
});
