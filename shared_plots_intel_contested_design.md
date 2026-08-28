# Проект shared-плотлайнов, intel, plotAwareness, contested и standing_orders

## 1. Цель

Этот документ фиксирует архитектуру взаимодействия сюжетных плотлайнов двух городов во время Conflux.

Ключевые задачи:

- любой обычный plot может технически быть `shared`;
- второй город не обязан сразу знать содержание shared-плотлайна;
- информация о чужих плотлайнах может просачиваться через общий `intel`;
- игрок может целенаправленно разведать конкретный plot;
- после раскрытия plot его хроника становится доступной соседу;
- если оба игрока начинают реально действовать внутри одного plot, его native-драматургия временно уступает место действиям игроков;
- mystery/suspense сохраняют фундаментальные инварианты;
- `standing_orders` остаются отдельной упрощённой сущностью и не участвуют в полноценной plot-разведке.

---

# 2. Общая модель

Во время Conflux нет отдельного типа `sharedConflux`.

Вместо этого обычные плотлайны получают свойство `shared`.

Тип plot остаётся прежним:

```text
mystery
suspense
standing_order
...
```

Ортогонально типу существуют:

```text
SHARED
true / false

PLOT AWARENESS PER CITY
true / false

CONCERNS
список городов, реально участвовавших в plot

CONTESTED
вычисляемый runtime-режим
```

---

# 3. `shared`

`shared` — техническое свойство плотлайна.

```yaml
shared: true
```

Означает:

> Plot существует в общем пространстве Conflux и технически может быть доступен агентам обоих городов.

`shared` НЕ означает:

- что второй игрок знает название plot;
- что он знает synopsis;
- что он автоматически получает его хронику;
- что он участвует в plot;
- что plot contested.

Иными словами:

```text
shared = техническая доступность
```

а не:

```text
shared = фактическая осведомлённость
```

---

# 4. `intel`

Текущий `confluxAwareness` рекомендуется переименовать в:

```text
intel
```

`intel` — общая информационная проницаемость между городами.

Например:

```yaml
intel:
  alleriaToBobrovsk: 35
  bobrovskToAlleria: 60
```

Он влияет на вероятность того, что чужая информация:

- просочится отдельной хроникой;
- станет доступна через informant;
- либо целый plot случайно станет раскрыт.

`intel` не является knowledge-state конкретного plot.

---

# 5. `plotAwareness`

Для каждого shared-плотлайна хранится бинарный awareness относительно каждого города.

Пример:

```yaml
plotAwareness:
  alleria: true
  bobrovsk: false
```

## `plotAwareness = false`

Город не знает plot как полноценную сюжетную линию.

Он не получает автоматически:

- title;
- synopsis;
- полную историю plot;
- новые хроники plot.

При этом отдельная хроника plot может случайно просочиться через обычный `intel`.

## `plotAwareness = true`

Plot считается раскрытым этому городу.

С этого момента он виден примерно так же, как хозяину:

- виден title;
- виден synopsis;
- доступна существующая хроника plot;
- новые хроники plot автоматически попадают в эфир;
- игрок может осознанно создавать дела внутри plot.

Для MVP не вводятся промежуточные уровни awareness.

---

# 6. Три способа получить `plotAwareness = true`

## Способ 1 — случайный reveal через `intel`

На тике shared-плотлайн может целиком раскрыться соседнему городу через общий `intel`.

```text
plotAwareness[B] = false
        ↓
intel reveal succeeds
        ↓
plotAwareness[B] = true
```

Это отдельный возможный результат информационной проницаемости.

---

## Способ 2 — успешный targeted intel-process

Игрок может отдать приказ:

> Узнайте, что происходит с этим событием.

Если приказ удалось привязать к конкретному plot, создаётся дело:

```yaml
process:
  plotId: ...
  ownerCity: ...
  intel: true
```

`intel: true` — специальный уже существующий флаг дела в ruler prompt и tool call.

Такой process можно создать **только на конкретный plot**.

Успех:

```text
plotAwareness[ownerCity] = true
```

После этого plot полностью раскрывается городу.

---

## Способ 3 — все хроники plot уже раскрыты

Если по обычным механизмам доступа город уже получил **все существующие хроники данного plot**, plot автоматически считается раскрытым.

```text
if all plot chronicles are visible to city:
    plotAwareness[city] = true
```

Логика простая:

> Если игрок и так уже видел всю историю plot, нет смысла продолжать считать plot скрытым.

После этого новые хроники также идут в эфир автоматически.

---

# 7. Просочившаяся хроника при `plotAwareness = false`

Plot может оставаться неизвестным как полноценная линия, но отдельная его хроника уже быть видимой.

Например:

> Купцы рассказывают, что к северным уступам Аллерии уже второй раз отправляют людей с канатами и зимней одеждой.

При этом:

```text
plotAwareness[Bobrovsk] = false
```

Игрок может спросить:

> Что там происходит?

Если ответа в доступной фактологии нет, informant отвечает:

> Неизвестно.

Но игрок может дать приказ:

> Узнайте, что это за событие.
> Разведайте, зачем они туда ходят.
> Выясните, что происходит у северных уступов.

Это уже действие и может породить `intel:true` process.

---

# 8. `sourcePlotId` на хронике

Каждая хроника, порождённая plot, должна хранить ссылку на породивший её plot.

Пример:

```yaml
chronicle:
  id: chronicle_123
  text: >
    Купцы рассказывают, что к северным уступам
    Аллерии снова отправилась экспедиция.

  sourcePlotId: plot_456
```

Это обязательный provenance.

Он позволяет сделать:

```text
player refers to leaked chronicle
        ↓
agent resolves chronicle
        ↓
sourcePlotId
        ↓
targeted intel-process создаётся прямо в нужном plot
```

Это лучше, чем создавать абстрактное дело и затем отдельным сильным judge пытаться определить, к какой линии оно относится.

---

# 9. Мягкий вопрос и приказ на разведку

## Мягкий вопрос

Примеры:

```text
"Что это?"
"Что там происходит?"
"Почему они туда ходят?"
```

Если игрок просто спрашивает о текущем знании:

```text
→ informant
```

Informant отвечает только тем, что уже известно.

Если неизвестно:

> Неизвестно.

Он не создаёт нового знания.

## Приказ добыть информацию

Примеры:

```text
"Узнайте, что там происходит."
"Разведайте это событие."
"Выясните, зачем они туда ходят."
```

Такой приказ создаёт process непосредственно внутри target plot:

```yaml
process:
  plotId: plot_456
  ownerCity: bobrovsk
  intel: true
  goal: >
    Выяснить, что происходит в линии событий,
    замеченной по просочившейся хронике.
```

---

# 10. Семантика `intel: true`

`intel: true` означает:

> Дело направлено на получение доступа к информации конкретного plot, а не на изменение его мира.

Такое дело:

- можно создать только на конкретный plot;
- не считается обычным вмешательством в сюжет;
- не триггерит `contested`;
- при успехе раскрывает plot целиком.

---

# 11. Outcome targeted-intel дела

Для MVP семантика максимально простая.

## FAILURE

```text
plotAwareness остаётся false
```

## SUCCESS

```text
plotAwareness = true
```

## CRITICAL SUCCESS

Для MVP можно использовать ту же механику:

```text
plotAwareness = true
```

Дополнительные преимущества critical можно добавить позже, если они понадобятся.

---

# 12. После reveal

Как только:

```text
plotAwareness[city] = true
```

город получает plot примерно так же, как хозяин:

- title;
- synopsis;
- все существующие хроники plot;
- будущие хроники plot.

Для MVP сознательно не моделируем:

- private chronicles;
- отдельные тайные действия после reveal;
- уровни знания plot;
- частичную подписку.

Считаем:

> После успешного раскрытия шпионы знают, где смотреть, поэтому дальнейших plot-specific секретов нет.

---

# 13. Mystery после reveal

Важно:

```text
plotAwareness = true
```

не означает доступ к внутреннему hidden truth mystery.

Второй игрок видит игровую поверхность plot примерно так же, как хозяин:

- synopsis;
- chronicle;
- открытые факты;
- раскрытые clues.

Но truth graph остаётся внутренней истиной world simulation.

```text
reveal plot ≠ reveal mystery answer
```

---

# 14. Suspense после reveal

Для suspense аналогично.

Второй город видит:

- premise;
- текущий synopsis;
- уже произошедшие discoveries;
- хронику.

Но не получает автоматически нераскрытые `hiddenPremises`.

---

# 15. `standing_orders`

`standing_orders` не считаются полноценными плотлайнами в обычном смысле.

Для них используется отдельная максимально простая visibility-логика.

## Awareness standing order

Standing order считается известным соседнему городу, если сосед видит **хотя бы одну его хронику**.

```text
any standing_order chronicle visible
→ standing_order known
```

Не нужно ждать все хроники.

---

# 16. Standing orders нельзя разведать

Для `standing_order` нельзя создавать targeted:

```yaml
intel: true
```

Они не поддерживают plot reconnaissance.

Standing order — это постоянное правило / источник recurring events, а не обычная скрытая сюжетная линия.

Если хотя бы один его pulse стал известен соседу, standing order считается известным.

---

# 17. Chronicle provenance для standing_order

У standing-order chronicle всё равно хранится источник:

```yaml
chronicle:
  sourcePlotId: standing_order_id
```

Это полезно для:

- UI;
- группировки recurring events;
- reducers;
- связи хроник с источником.

Но `sourcePlotId` здесь не открывает targeted espionage.

---

# 18. `concerns`

У plot остаётся список:

```yaml
concerns:
  - cityA
  - cityB
```

Город добавляется в `concerns`, когда в plot стартует его первый **обычный non-intel process**.

Targeted разведка:

```yaml
intel: true
```

не добавляет город в `concerns`.

То есть:

```text
intel process
→ awareness
→ NOT concerns
```

А реальное вмешательство:

```text
исследовать
помочь
украсть
захватить
помешать
строить
торговаться
атаковать
```

→ добавляет город в `concerns`.

---

# 19. Значение `concerns`

`concerns` — история реального участия.

Он отвечает:

> Какие города уже непосредственно действовали внутри этого plot?

Он НЕ отвечает:

- кто сейчас active;
- кто просто знает plot;
- contested ли plot сейчас.

Коротко:

```text
plotAwareness = information
concerns = participation history
contested = current multi-player control mode
```

---

# 20. `contested`

`contested` не становится permanent plot type и не является необратимым состоянием.

Это вычисляемый runtime-режим.

Главная формула:

```text
contested =
count(
  distinct ownerCity
  among ACTIVE NON-INTEL processes in plot
) >= 2
```

---

# 21. Что считается ACTIVE

Process считается active, пока реально не завершён.

Это включает длительные дела.

Пример:

```text
Аллерия:
трёхмесячная экспедиция
месяц 2/3

Бобровск:
в этом месяце начинает свою операцию

→ contested = true
```

Неважно, что Аллерия не отдала новый приказ в текущем месяце: её process всё ещё active.

---

# 22. Intel-process не триггерит contested

Пример:

```text
Аллерия:
исследовать Холодный Ход

Бобровск:
разведать, что происходит с Холодным Ходом
intel = true
```

Результат:

```text
contested = false
```

Короткое правило:

> **Узнать — не contested. Вмешаться — contested.**

---

# 23. Помощь тоже может сделать plot contested

Contested не обязательно означает конфликт.

Пример:

```text
Аллерия:
исследовать Холодный Ход

Бобровск:
отправить своих шахтёров помочь
```

Оба процесса:

- non-intel;
- active;
- принадлежат разным городам.

Значит:

```text
contested = true
```

Причина:

> Оба игрока теперь непосредственно пишут состояние одной истории.

---

# 24. Когда contested включается

Перед генерацией текущего plot beat engine смотрит на active processes.

Если:

```text
>= 2 distinct ownerCity
among active non-intel processes
```

то:

```text
contested = true
```

И используется contested beat policy.

---

# 25. Когда contested снимается

После завершения процессов состояние пересчитывается.

Если:

```text
active non-intel processes
принадлежат максимум одному городу
```

то:

```text
contested = false
```

Plot возвращается к native logic своего типа.

Contested не оставляет permanent mode-флаг.

---

# 26. Пример lifecycle

## Месяц 1

Аллерия:

> Отправить экспедицию в Холодный Ход.

Бобровск ничего не делает.

```text
contested = false
```

Работает native suspense.

## Месяц 2

Аллерия:

> Вскрыть найденную дверь.

Бобровск:

> Тайно проникнуть туда и забрать часть находок.

Оба non-intel process active.

```text
contested = true
```

Работает contested beat.

## Месяц 3

Оба процесса завершились.

Аллерия:

> Продолжить исследование.

Бобровск ничего не делает.

```text
contested = false
```

Снова работает native suspense.

Все последствия contested-месяца остаются частью мира.

---

# 27. Native mode

Когда:

```text
contested = false
```

plot обслуживается своей обычной машиной.

```text
mystery
→ mystery phase/reveal logic

suspense
→ suspense depth/phase/discovery logic

standing_order
→ standing order pulse logic
```

---

# 28. Contested mode

Когда:

```text
contested = true
```

главным режиссёром становятся действия игроков.

Принцип:

> Player actions > authored dramaturgy.

Beat-agent получает:

- текущее состояние plot;
- active processes обоих городов;
- их outcomes;
- существующие world facts;
- инварианты исходного типа.

Его задача:

> Материализовать в одном непротиворечивом развитии то, что реально произошло из действий двух игроков.

---

# 29. Что временно отходит на второй план в contested

Для suspense:

- planned pacing;
- discovery ladder;
- depth shortcut logic;
- авторское дозирование раскрытия.

Для mystery:

- аккуратный reveal pacing;
- драматургическое дозирование clues.

Это не значит, что эти структуры удаляются.

Но если действия игроков создают более прямой и интересный ход событий, приоритет у действий игроков.

---

# 30. Что НЕ отключается в contested

Исходный тип plot остаётся источником world invariants.

## Mystery

Нельзя:

- переписывать truth graph;
- менять заранее установленного виновника;
- переписывать прошлое;
- противоречить causal truth.

Коротко:

```text
players may change the future
but not rewrite the mystery past
```

## Suspense

Нельзя:

- противоречить установленным hiddenPremises;
- отменять произошедшие discoveries;
- переписывать существующие world facts.

Но будущее открыто.

Игроки могут закончить story способом, которого starter не предполагал.

---

# 31. Discovery ladder в contested не обязательный сценарий

Пример:

Suspense «Холодный Ход» содержит:

```text
discoveryLadder:
1. источник холода
2. искусственная структура
3. запечатанная камера
```

Но два игрока начинают борьбу за вход.

Если в результате проход обрушен навсегда, story может закончиться, даже если камера так и не была открыта.

Это нормально.

Hidden truth о камере продолжает существовать в canon, но игроки могли никогда её не узнать.

---

# 32. Mystery тоже может закончиться без полного раскрытия

Например:

> Неизвестный диверсант портит мост.

Один из игроков полностью сносит мост.

Если causal problem больше не существует, story может быть практически завершена, даже если culprit так и не установлен.

То есть:

```text
causal resolution
может произойти без
epistemic resolution
```

Особенно в contested gameplay.

---

# 33. После contested native logic продолжает из нового мира

`CONTESTED` не является отдельной параллельной историей.

Он изменяет state того же plot.

Когда:

```text
contested = false
```

native mystery/suspense engine получает уже обновлённый world state.

Он не пытается вернуть story на заранее написанные рельсы.

---

# 34. Стоит ли хранить `contested`

Предпочтительно считать его derived/runtime field.

```text
contested =
distinct active non-intel process owners >= 2
```

Можно логировать вычисленное значение для дебага.

Но не нужно хранить permanent story-state, который потом надо вручную снимать.

---

# 35. Routing plot beat

Рекомендуемый routing:

```text
if plot.type == standing_order:
    use standing_order logic

else if contested(plot):
    use contested beat logic

else:
    use native plot logic
```

Где native:

```text
mystery → mystery machinery
suspense → suspense machinery
```

---

# 36. Общая схема разведки

```text
SHARED PLOT
plotAwareness[B] = false
        │
        ├─ ничего не просочилось
        │
        ├─ одна или несколько chronicles leaked
        │        ↓
        │   игрок видит след
        │        ↓
        │   "что это?" → informant
        │        ↓
        │   "узнай" → intel:true process in target plot
        │        ↓
        │   SUCCESS → plotAwareness=true
        │
        ├─ intel случайно reveal'ит plot целиком
        │        ↓
        │   plotAwareness=true
        │
        └─ все chronicles уже видимы
                 ↓
            plotAwareness=true
```

---

# 37. Standing order visibility

```text
STANDING ORDER
        ↓
ни одной хроники сосед не видел
        → unknown

хотя бы одна chronicle стала видимой
        → standing_order known
```

Targeted intel для standing order отсутствует.

---

# 38. Минимальная data model

## Plot

```yaml
plot:
  id:
  type:
  shared:

  plotAwareness:
    cityA: true
    cityB: false

  concerns:
    - cityA

  processes:
    - ...

  chronicles:
    - ...

  nativeState:
    ...
```

## Chronicle

```yaml
chronicle:
  id:
  text:
  sourcePlotId:
  visibleTo:
    - cityA
```

## Process

```yaml
process:
  id:
  plotId:
  ownerCity:
  active:
  intel: false
  goal:
```

Targeted reconnaissance:

```yaml
process:
  id:
  plotId:
  ownerCity:
  active: true
  intel: true
  goal: >
    Выяснить, что происходит в этом plot.
```

---

# 39. Derived helpers

## Plot revealed

```text
isPlotRevealed(city, plot)
=
plot.plotAwareness[city]
```

## All chronicles visible

```text
allChroniclesVisible(city, plot)
=
every plot chronicle visible to city
```

Если true:

```text
plotAwareness[city] = true
```

## Contested

```text
isContested(plot)
=
count(
  distinct ownerCity
  among processes
  where active == true
    and intel == false
) >= 2
```

---

# 40. Update rules

## Когда chronicle leaked

```text
chronicle.visibleTo += city
```

После этого для обычного plot:

```text
if allChroniclesVisible(city, plot):
    plotAwareness[city] = true
```

Для standing order:

```text
if anyChronicleVisible(city, standingOrder):
    standingOrder becomes known to city
```

---

# 41. Когда targeted intel SUCCESS

```text
plotAwareness[city] = true
```

И все существующие хроники plot становятся видимыми городу:

```text
for chronicle in plot.chronicles:
    chronicle.visibleTo += city
```

---

# 42. Когда обычный intel целиком reveal'ит plot

То же самое:

```text
plotAwareness[city] = true
```

И выполняется backfill всей хроники plot.

---

# 43. Когда город стартует обычный process в plot

Если:

```text
intel == false
```

то:

```text
if ownerCity not in concerns:
    concerns += ownerCity
```

Также логично автоматически иметь:

```text
plotAwareness[ownerCity] = true
```

потому что невозможно осознанно вмешиваться в конкретный plot и одновременно считать его неизвестным.

---

# 44. Когда стартует intel-process

```text
intel == true
```

Он:

- не добавляет город в `concerns`;
- не считается для contested;
- при успехе ставит `plotAwareness = true`.

---

# 45. Что сознательно НЕ моделируем в MVP

Не вводим:

- уровни `plotAwareness`;
- private chronicles;
- plot-specific secrecy после reveal;
- отдельные проценты разведданных по plot;
- сложные типы шпионов;
- partial reveal states;
- permanent `CONTESTED` state;
- отдельный semantic type `sharedConflux`.

---

# 46. Основные инварианты

## Shared

```text
shared ≠ revealed
```

## Intel

```text
intel = глобальная проницаемость информации между городами
```

## Plot awareness

```text
plotAwareness = бинарный факт:
этот город знает plot как полноценную линию
```

## Chronicle provenance

```text
каждая сюжетная chronicle хранит sourcePlotId
```

## Targeted espionage

```text
можно разведать только конкретный plot
```

## Intel process

```text
intel:true
→ не concerns
→ не contested
→ success reveals plot
```

## Concerns

```text
история реального non-intel участия
```

## Contested

```text
>= 2 города с active non-intel process
```

## Native vs contested

```text
один активный игрок
→ native dramaturgy

несколько активных игроков
→ player actions dominate
```

## Mystery

```text
contested не переписывает frozen truth
```

## Suspense

```text
contested не переписывает established premises,
но может полностью изменить будущий ход story
```

## Standing orders

```text
1 visible chronicle → known

targeted intel запрещён
```

---

# 47. Рекомендуемый порядок реализации

## P0

1. Переименовать `confluxAwareness` → `intel`.
2. Добавить `sourcePlotId` на plot chronicles.
3. Добавить бинарный `plotAwareness[city]`.
4. После reveal делать все хроники plot видимыми городу.
5. Если все хроники уже видимы — автоматически выставлять awareness.
6. Поддержать `intel:true` process только с конкретным `plotId`.
7. SUCCESS такого process → reveal plot.

## P1

8. Исключить `intel:true` из `concerns`.
9. Исключить `intel:true` из contested calculation.
10. Добавлять город в `concerns` на первом обычном process.
11. Добавить derived `isContested(plot)`.
12. Routing:
   - contested → contested beat;
   - иначе → native beat.

## P2

13. Mystery contested beat сохраняет frozen truth.
14. Suspense contested beat сохраняет established hidden/world premises.
15. После contested native engine продолжает из изменённого state.
16. Standing order: одна видимая chronicle → order known.
17. Запретить targeted intel для standing orders.

---

# 48. Итоговая концепция

```text
shared
→ технически общий plot

intel
→ насколько информация течёт между городами

chronicle leak
→ отдельный чужой след

plotAwareness
→ plot целиком раскрыт

intel:true process
→ целенаправленная попытка раскрыть конкретный plot

concerns
→ кто реально вмешивался

contested
→ кто прямо сейчас активно пишет этот plot действиями
```

Главный Conflux-принцип:

> **Разведка открывает чужую историю. Реальное вмешательство позволяет игрокам временно перехватить у сценариста её режиссуру. Но уже установленная реальность plot остаётся обязательной.**
