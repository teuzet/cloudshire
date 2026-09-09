# Архитектура

Один процесс Node: storage + игровой фасад + веб + Telegram + два будильника.

```
src/index.js
  bootstrap.createAppContext     config, storage, AgentRuntime, GameApp
  clients/web/server.js          /play /mini /admin /freeform
  scheduler/days.js              будильник по сроку ближайшего задания (одиночный город)
  scheduler/ticks.js             clock-aligned interval (сопряжённая пара)
  clients/telegram/bot.js        polling → GameApp.handleUserMessage

чат → GameApp
  нет домена → onboarding → genesis.generateDomain
  есть домен → runRuler (тулы в rulerTools.js); на время хода часы мира стоят

день → dayLoop.runDayLoop         города вне стыка
  armDomainSchedule               завести сроки: посев, угрозы, дела
  drainDomainJobs                 разобрать назревшее (worldLoop.js)
    process_finish → исход дела → бит нити → разбор остальных обязательств
    threat_fire    → срабатывание угрозы или разрешение
    seed_attempt / seed_appear → посев истории
  herald                          весть покровителю об одном событии
  statJudge, keepStories

тик → tick.runWorldTick           только города в стыке
  матчмейкинг сопряжений
  resolveConfluxSharedMonth / resolveDomainMonth
  письмо месяца (tickNews)
```

Два будильника — не дублирование, а граница: у одиночного города календаря нет,
у пары он общий и пока месячный. Кто кого пропускает, описано в
[REFACTOR_CONTINUOUS_TIME.md](REFACTOR_CONTINUOUS_TIME.md) §16.

Принцип: **движок считает, агент говорит.** Броски, слоты, очередь дел, отбор битов — код. Модель получает готовый факт и пишет текст.

---

## Слои

| Каталог | Зачем |
|---------|--------|
| `src/game/` | Правила мира |
| `src/agents/runtime.js` | Вызов агента: tools, дедлайн, сборка system из canon/styles/instructions |
| `src/llm/` | OpenAI и Anthropic за одним интерфейсом; usage в Mongo/`logs` |
| `src/storage/` | YAML или Mongo, один API |
| `src/clients/` | Тонкие адаптеры |
| `config/default.yaml` | Кнопки игры **и** все промпты агентов |

## Ключевые модули игры

| Файл | Роль |
|------|------|
| `app.js` | Фасад: чат, онбординг, генезис в фоне, новости, wipe |
| `rulerTools.js` | Тулы жреца |
| `onboarding.js` / `onboardingTools.js` | Черновик и тулы до города |
| `genesis.js` / `genesisConcept.js` / `genesisAxes.js` | Сборка домена из READY-концепта |
| `officers.js` | Четыре столпа, слоты |
| `plotlines.js` | Модель нитей, конфиг, жребий аннотаций |
| `plotEngine.js` | Часы, очередь дел, биты без LLM |
| `storyteller.js` | Авторы завязки и бита |
| `freeform*.js` | Лаборатория свободной истории: стартер, рассказчик, судья |
| `gameClock.js` / `scheduler.js` | Игровые дни и очередь заданий на домен |
| `worldLoop.js` / `dayLoop.js` | Обработчики заданий и проход мира по дням |
| `bands.js` / `deeds.js` / `deedJudge.js` | Полосы срока и сложности, дело в днях |
| `threats.js` / `threatSmith.js` | Скрытые обязательства нити и их автор |
| `reconcile.js` / `reconciler.js` | Что делать с остальными делами нити после события |
| `herald.js` / `notify.js` / `priestOrders.js` | Весть об одном событии, пуши, наказы |
| `cityRules.js` | Постоянный порядок города и наказ на сопряжение |
| `monthResolve.js` / `tick.js` | Оркестрация месяца / мира на стыке |
| `conflux*.js` | Стыковка островов |
| `annotationPool.js` / `annotationCatalog.js` | Пулы и wipe-resistant каталог |

Точнее: [PLOTS.md](PLOTS.md), [GENESIS.md](GENESIS.md), [ANNOTATIONS.md](ANNOTATIONS.md), [CONFLUX.md](CONFLUX.md), [REFACTOR_CONTINUOUS_TIME.md](REFACTOR_CONTINUOUS_TIME.md).

## Агенты

Модель задаётся **на агента** в YAML. Почти всё игровое — `gpt-5.6-luna`. Исключения: генезис longform — Claude; ядро тайны — terra; фабрика аннотаций — Claude (офлайн/досев); портреты — `gpt-image-2`.

Жрец: `turnBudgetMs` 120 с, вложенные вызовы (ломастер, информатор, оценка срока) делят этот дедлайн.

## Storage

YAML: `data/world.yaml`, `domains/`, `users/`, `confluxes/`, `annotation-catalog.yaml`.  
Mongo: коллекции `world`, `domains`, `users`, `confluxes`, `annotation_catalog`, `usage`, `world_archives`.

Wipe архивирует мир; каталог аннотаций не трогает. Картинки сейчас ещё пишутся в документ домена (`imageBase64` / `portraitBase64`) — отдельный проход вынесет их на хостинг.
