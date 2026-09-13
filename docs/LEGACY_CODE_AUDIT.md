# Аудит ошмётков старой логики

Дата: 13 сентября 2026. Правки не вносились: это снимок мёртвого, двойного и вредного кода после перехода на игровые дни и канон пары.

Смотрелись `src/game/*`, планировщики, yaml-агенты, `/play` и `/admin`, пересечение с `docs/REFACTOR_CONTINUOUS_TIME.md`.

Критерий: кусок либо **жив** (его зовёт дневной цикл / ход жреца / живое задание), либо **двойной** (месяц и день пишутся вместе), либо **пустой** (заглушка / нет импортеров), либо **вредный** (живой код пишет поля, которые другой живой код тут же стирает). Имя модуля само по себе не приговор: `legacyResolver` — живой след после закрытия нити.

---

## Что сейчас живое

Не называть мёртвым:

| Путь | Что делает |
|---|---|
| `dayLoop.js` + `scheduler/days.js` + `worldLoop.js` | игровой день, очередь заданий, рассказ события |
| `herald`, `chronicler`, `deedJudge`, `threatSmith`, `reconciler` | событие, хроника, срок, угроза, разбор нити |
| `conflux_dock` / `conflux_undock` / `conflux_contact` | стыковка, расстыковка, описание прохода |
| `confluxLeak`, `confluxForecast`, `informant`, `undockChronicle`, `undockPassage`, `publishPairCanon` | канон пары |
| `plantStakedStory` через `seed_appear` | посев городской истории со ставками |
| аннотации (`mysteryAnnotation`, судьи, пул) | живой конвейер тайны **на зерне**, не на карточке нити |
| `legacyResolver` | след после закрытия; имя столкнулось со словом «legacy» |
| `keepStories` / `confluxStoryKeep` | синопсис после события; живые вызовы из `dayLoop` и прогноза |
| `emitConfluxAnnouncements` | живое: дневной цикл зовёт после матчмейка |
| `writePairChronicle` | живое для жертвы тайного дела соседа (`worldLoop` ~363); не только мёртвый бит пары |
| производные `expectedMonths` / `monthsLeft` у дел | намеренно: мини-аппка и тулы жреца |
| `tickIndex` как `floor(dayIndex / 30)` | производное из часов, не отдельный календарь |

Живой мир: день → задание (`threat_fire`, `process_finish`, `seed_*`, `conflux_dock|undock|contact`) → рассказчик → хроника. Месячного батча событий больше нет.

---

## Расхождение с планом §16

`docs/REFACTOR_CONTINUOUS_TIME.md` §16 ещё говорит: пара ходит месяцем (`tick.js` → `monthResolve.js` → `tickNews`), одиночный город — днями; `runDayLoop` пропускает стык, `runWorldTick` — соло.

Так **уже не работает**.

- `monthResolve.js` нет.
- Пара разбирается теми же дневными заданиями (`drainConfluxJobs` в `dayLoop`).
- `runWorldTick` только подтягивает часы (`skipped: 'derived_clock'`) и не обходит города.
- Месячный бит пары (`conflux_beat` / `confluxBeat`) никто не ставит в очередь.

Комментарий в `src/index.js` про «месячную доску сопряжения» и заголовок рефактора («месячный ход остался только у сопряжённой пары») описывают замысел первого прохода, не текущий код.

---

## 1. Месячный тик — оболочка

### `runWorldTick`

`src/game/tick.js`: `syncWorldClock`, возврат `{ skipped: 'derived_clock', results: [] }`. Вызовы остались: `src/index.js`, CLI, плейтест, `/play` force-tick, `src/clients/web/server.js`.

Force-tick на самом деле крутит `skipGameDays` / `skipStoredWorldDays`, потом будит дневной цикл. `runWorldTick` после этого ничего не решает. `scheduler.triggerNow` при `tick.enabled: false` — пустышка, поэтому force-tick всё равно падает в `doTick` → тот же no-op.

### Планировщик 00:00 / 02:00

`src/scheduler/ticks.js` жив как модуль. `config/default.yaml` `tick.enabled: false` → `startTickScheduler` сразу возвращает `{ stop, triggerNow: null }`. Поля `world.scheduler` (`lastTickAt`, `nextTickAt`, `tickInProgress`) и `recordTickCompleted` остаются.

`src/game/tickClock.js`: «стенные часы сервера — только для nextTickAt админского force_tick». Игровой календарь считается в `gameClock.js`. Часть хелперов (`gameDateFromTickIndex`) ещё импортируют `freeform.js` / `miniCity.js`.

### Письмо месяца

| Кусок | Статус |
|---|---|
| агент `tickNews` в yaml | живой ключ, комментарий на `herald`: «Заменяет tickNews» |
| `GameApp.narrateTickNews` | полный путь письма месяца; **нет внешних вызовов** |
| `src/game/newsSchedule.js` | расписание месяцев 1–12, detail/clickbait |
| `newsScheduleOf` в ходе жреца | живой **текст** в extraSystem: «Письма о месяце (движок шлёт сам)» + инструкция звать `set_news_schedule` |
| тул `set_news_schedule` | **нет** (живой путь уведомлений — `set_notify` / `read_notify`) |
| агент `fillerNews` + `quietMonth` | полный «тихий месяц»; **нет внешних вызовов** |

Плейтест, агент игрока и `scenarios/smoke.yaml` всё ещё говорят `force_tick` как «месяц должен пройти». Реальная промотка — дни.

`emitApproachPhotos` в `tick.js` ниоткуда не зовут. Соседние `emitConfluxAnnouncements` — живые.

---

## 2. Сопряжение: месячный бит мёртв, поля месяца живы

Пара **уже на днях**: `prepStartDay` / `dockStartDay` / `dockEndDay`, задания dock/undock/contact.

### Пустые заглушки

`processConfluxApproachingPhase` — `void` всех аргументов, пустой возврат. Комментарий всё ещё велит после резолва звать `advanceDockedConfluxes`.

`advanceDockedConfluxes` — `{ notes: [], undockAddsByDomain: Map }`. Вызовов нет.

`approachMonthText` в `confluxBoard.js` — нет вызовов.

### Счётчики «месяцев стыковки»

`advanceConfluxLifetimeCounters` всё ещё `+= 1` к `confluxMonthsDocked` / `confluxMonthsSolo`, как будто каждый вызов — месяц. **Самих вызовов нет.** Поля нормализуются в `models.js`, рисуются в `/play` и `/admin` как `monthsSolo` / `monthsDocked`. На новом мире они так и останутся нулями; `targetDockedFraction` в yaml нечем мерить.

### Двойная запись срока пары

При создании конфлюкса одновременно:

- дни: `createdDay`, `prepStartDay`, `dockStartDay`, `dockEndDay`;
- месяцы: `etaMonths`, `durationMonths`, `dockAtTick`, `createdTick`.

`monthsUntilDock` сначала считает дни/30, иначе падает на тиковую арифметику `dockAtTick ?? createdTick + etaMonths`. Ломастер и админка говорят «до сопряжения, мес.».

Yaml: живые `prepDaysMin/Max`, `dockDaysMin/Max` и рядом фолбэк `etaMonths` / `durationMonths` / `minDomainAgeMonths` / `maxNewPairsPerTick` «пока живые миры не пересозданы».

`schedulePairJobs` ставит только dock / undock / contact. `contactAtFraction` — `void`.

### `conflux_beat` и `confluxBeat.js`

Обработчик `conflux_beat` в `confluxJobs.js` и список kinds в `scheduler.js` живы. **Никто не планирует** это задание. Сработает только на старом сейве с висящим job: тогда пойдёт `writePairChronicle` со старым kind `beat`.

`src/game/confluxBeat.js` — полный месячный автор бита пары (`agentId: 'confluxBeat'`). **Импортеров в репозитории нет.** Агент в yaml остался. `confluxStoryKeep` в yaml всё ещё: «Событие уже написал confluxBeat». Шапка `storyteller.js` то же.

`conflux_transfer` — алиас на `conflux_undock`.

`confluxResolver` в yaml: «Тик = один игровой месяц». Живое применение — описание контакта/прохода (`generateContact`), не месячная хроника пары. Хронику расстыковки пишет `undockChronicle`.

---

## 3. Тайна: вредный остаток, не пыль

Это главный кандидат на уже красные тесты `tests/plot-canon.test.js:349` и `tests/suspense-engine.test.js:16`, `:121`. Здесь не чинить — только зафиксировать развилку.

### Карточка нити больше не хранит граф

`STALE_PLOT_FIELDS` в `plotlines.js` на каждом `normalizePlotlines` / `createPlotline` **удаляет**:

`truth`, `truthGraph`, `observedFacts`, `resolutionFacts`, `asksSequel`, `annotationId`, `ifSolved`, `ifUnsolved`, `discoveryLadder`, `closureGate`, `legacyAxes`, `act`, `urgency0`, `gravity0`, плюс старые оси (`arena`, `hook`, `conflict`, …).

`storyTypeOf` сводит `mystery` / `suspense` / `freeform` к `'story'` (ставка + `hiddenPremises`). `pickStoryType()` всегда возвращает `'story'`.

### Посев тайны всё ещё пытается писать стёртое

`seedMysteryPlot` передаёт в `createPlotline` `truthGraph`, `observedFacts`, `resolutionFacts`, `annotationId`, `ifSolved`, `act: 1`, `gravity0`.

`createPlotline` эти аргументы **даже не деструктурирует** — они отбрасываются. Если бы попали на объект, `stripStalePlotFields` всё равно стёр бы их.

Живой посев в проде — `plantStakedStory` (`seed_appear`, `/play` дев-кнопка). `seedPlot` / `seedMysteryPlot` / `seedSuspensePlot` **никто не вызывает**. `seedPlot` при нынешнем `pickStoryType()` сразу выходит: `typed_story_not_in_live_month`.

Читатели старого графа на карточке всё ещё есть: `loremaster.js` (`storyType === 'mystery' && (truthGraph || truth)`), мёртвый `confluxBeat.js`, `storyteller.beatPlot`, `undockContinuation.js` (смотрит `plot.truthGraph` / `discoveryLadder` по `storyType`). На живой карточке этих полей нет — ветки либо молчат, либо смотрят пустоту.

Живая тайна сидит в **аннотации и пуле**, не в плотлайне. Путать эти два контура опасно.

### Трёхтакт выключен рубильником

`isThreeActPlot()` **всегда `false`**. Из-за этого мертвы:

- почти весь `storyActs.js` / `applyStoryActMove`;
- ветки в `plotEngine.js` и `rolls.js`;
- условие `mystery = threeAct && plot.storyType === 'mystery'` в `beatPlot`.

Агенты `mysteryBeat` / `suspenseBeat` / `storyBeat` в yaml живут. `plotBeatAgentId` мапит staked story на `freeformTell`, иначе `storyBeat`. Продакшен это не зовёт: `beatPlot` экспортирован и **нигде не вызывается**.

### Температура и возраст в месяцах

Комментарий: «Температура карточки выключена. Поле оставляем, не ведём.»

- `warmPlotlines()` возвращает `[]`, но `app.js` зовёт после хода жреца.
- `advancePlotClocks` / `advancePlotMonth`: только `ageMonths += 1`, `decay` в `void`. В дневном цикле не зовутся (тесты + алиас).
- Поля `temperature`, `ageMonths`, `maxAgeMonths`, `lastBeatTick` нормализуются, в Telegram «возраст=N/M мес.», в `rolls.js` `agePressure`, в `plotCanFade`. Без продвижения часов `ageMonths` на живой нити не растёт — выгорание по возрасту фактически стоит.

`lastBeatTick` пишут только мёртвые `beatPlot` и `confluxBeat`.

---

## 4. Месячный движок нитей vs дневной цикл

Не на живом пути (тесты / внутренние хелперы):

| Кусок | Где остался |
|---|---|
| `planBeats` («план битов месяца», `maxPerTick`) | `plotEngine.js`; тесты `plot-canon`, `plot-queue` |
| `applyQueuedEngineProgress` / `applyEngineProgress` | месячный *шаг* дела (`monthsLeft -= 1`); живое дело кончается один раз на `process_finish` |
| `clearMonthLog`, `planQuietDrift` (пусто), `openLogGate` | `plotEngine.js`; внешних вызовов нет |
| `beats.maxPerTick: 3` | yaml / `plotConfig` |
| `createStatBudget` | месячные бюджеты world/player |

`monthLog` **ещё пишется** после хода жреца и показан в `/play` и админке. Читатель `openLogGate` мёртв. Имя лжёт: это уже не журнал месяца, а кольцо последних реплик.

Дела: шапка `deeds.js` честно говорит, что `expectedMonths` / `monthsLeft` / `durationMonths` — производные для мини-аппки, тулов жреца и «старого месячного пути сопряжения». `processes.js` синхронизирует `durationMonths = expectedMonths`. Это не мёртвый код, но второй язык срока рядом с полосами дней.

---

## 5. Мёртвые модули и yaml-агенты

| Кусок | Почему мёртв |
|---|---|
| `src/game/confluxBeat.js` | нет импортеров |
| `beatPlot` | нет прод-вызовов |
| `quietMonth` + агент `fillerNews` | нет прод-вызовов |
| `narrateTickNews` + агент `tickNews` | нет прод-вызовов |
| `processConfluxApproachingPhase` / `advanceDockedConfluxes` | пустые заглушки, нет вызовов |
| `approachMonthText` | нет вызовов |
| `emitApproachPhotos` | нет вызовов |
| `advanceConfluxLifetimeCounters` | нет вызовов |
| `seedPlot` / `seedMysteryPlot` / `seedSuspensePlot` | нет прод-вызовов; `pickStoryType` всегда `story` |
| `conflux_beat` job | обработчик есть, планировщика нет |
| `isThreeActPlot` / большая часть `storyActs.js` | жёстко `false` |
| `config/freeform-legacy-agents.yaml` | архив; runtime не читает. Код `freeformStarter.js` / `freeformArchitectStart` лежит; живая `/freeform` ими не пользуется (`tests/freeform.test.js` это проверяет) |
| yaml `mysteryBeat`, `suspenseBeat`, `storyBeat`, `confluxBeat` | агенты без живого `agentId` |

Не путать с живым `freeformArchitectTell` / `freeformAssemble` — это текущий посев staked story.

---

## 6. Поля и UI, которые всё ещё говорят «месяц»

Домен: `createdTick` (и `createdDay = createdTick * 30` при нормализации), `confluxMonthsDocked` / `confluxMonthsSolo`.

Процесс: `expectedMonths`, `monthsLeft`, `monthsDone`, `durationMonths`, `objectiveMonths`.

Нить: `ageMonths`, `maxAgeMonths`, `lastBeatTick`, `createdTick`, `temperature`.

Конфлюкс: `etaMonths`, `durationMonths`, `dockAtTick`, `monthsDocked`.

Факт лора: рядом с `day` всё ещё штамп `tick`.

Интерфейс: `/play` и `/admin` — «до сопряжения, мес.», `monthsDocked/durationMonths`; ломастер — «сопряжение примерно через N мес.»; Telegram — возраст нити в месяцах; `scripts/world-report.js` overdue = `monthsLeft === 0`; wipe в `/play` — «дождись конца месяца».

Промпты: ход жреца про письма месяца и несуществующий `set_news_schedule`; `confluxResolver` / `tickNews` / `confluxBeat` / `confluxStoryKeep` / `mysteryBeat` — лексика месяца.

---

## 7. Мелочь, которая путает чтение кода

- Шапка `plotlines.js`: «отбор битов, окраска и часы — в движке тика»; `urgency` — «шанс, что история сама сдвинется в месяц без дела».
- `FREEFORM_URGENCY_MONTHS` — диапазоны в месяцах при живой глубине в актах/угрозах.
- `judgePlotSeed(..., { storyType: 'mystery' })` ещё требует `truthGraph` — нужен только мёртвому посеву.
- `stripPlotSecrets` выкидывает `truthGraph` / `discoveryLadder`, которых на карточке уже нет; `hiddenPremises` живые — их выкидывать правильно.
- `undockContinuation` смотрит `plot.source` / `plot.situation` — оба в `STALE_PLOT_FIELDS`.
- Комментарий force-tick в `index.js` и сообщение wipe «конец месяца» описывают старую модель двух календарей.

---

## Порядок уборки, если брать

Не делать в этом проходе. Когда будет задача — узкими коммитами, сначала вредное, потом пыль.

1. **Тайна на карточке.** Либо перестать сеять граф в плотлайн (`seedMysteryPlot` и читатели), либо перестать стирать поля и снова хранить граф. Сейчас оба контура включены наполовину — отсюда красные тесты. Живой контур: аннотация + staked story.
2. **Снять трёхтакт.** `isThreeActPlot`, `storyActs.js`, yaml `mysteryBeat`/`suspenseBeat`/`storyBeat`, `beatPlot`, ветки в `plotEngine`/`rolls`.
3. **Месячный бит пары.** Удалить `confluxBeat.js`, yaml `confluxBeat`, handler `conflux_beat`, поправить комментарии `confluxStoryKeep` / `storyteller.js`. Не трогать `writePairChronicle` — он нужен саботажу.
4. **Письмо месяца.** `narrateTickNews`, `tickNews`, `fillerNews`/`quietMonth`, `newsSchedule` + ложная инструкция `set_news_schedule`. Живые уведомления не трогать.
5. **Заглушки пары.** Пустые approaching/docked, `approachMonthText`, `emitApproachPhotos`, невызываемый `advanceConfluxLifetimeCounters` (решить: вести счётчики в днях или выкинуть UI).
6. **Двойные поля срока.** Когда сейвы можно не читать: `etaMonths`/`dockAtTick` vs дни; `ageMonths` либо перевести в дни, либо честно выкинуть выгорание.
7. **Оболочка тика.** Когда force-tick перестанет звать `runWorldTick`: `scheduler/ticks.js`, `tick.enabled`, поля `world.scheduler`. `tickIndex` как `day/30` можно оставить до полной замены штампов в лоре.
8. **Архив freeform.** `config/freeform-legacy-agents.yaml` и `freeformStarter.js`, если лаборатория ими точно не пользуется.
9. **Документы.** Поправить §16 `REFACTOR_CONTINUOUS_TIME.md` и шапки модулей, чтобы не обещать второй календарь пары.

Пока живые миры не архивированы, фолбэк-ключи yaml (`etaMonths`, `durationMonths`, `minDomainAgeMonths`) лучше не выкидывать вслепую — на старом сейве они ещё якорь.
