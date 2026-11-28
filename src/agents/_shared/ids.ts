/**
 * Модель иногда теряет последний знак длинного id («obj_oeispna6ytd» вместо «obj_oeispna6ytdh»):
 * на живом прогоне из-за этого Разбивщик трижды не смог назвать цепи и сбил приказ на другой объект.
 * Такой id правим на единственный известный, который с него начинается и длиннее не больше чем на два знака.
 */
export function fixId<T extends string | null | undefined>(id: T, known: Iterable<string>): T {
  if (!id) return id;
  const all = [...known];
  if (all.includes(id)) return id;
  const hits = all.filter((k) => k.startsWith(id) && k.length - id.length <= 2);
  return (hits.length === 1 ? hits[0] : id) as T;
}
