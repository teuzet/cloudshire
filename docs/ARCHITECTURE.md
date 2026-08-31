# Архитектура

Один процесс Node: storage + игровой фасад + веб + Telegram + шедулер тиков.

```
src/index.js
  bootstrap.createAppContext     config, storage, AgentRuntime, GameApp
  clients/web/server.js          /play /mini /admin /freeform
  scheduler/ticks.js             clock-aligned interval
  clients/telegram/bot.js        polling → GameApp.handleUserMessage

чат → GameApp
  нет домена → onboarding → genesis.generateDomain
  есть домен → runRuler (тулы в rulerTools.js)

тик → tick.runWorldTick
  матчмейкинг сопряжений
  resolveConfluxSharedMonth      если docked
  resolveDomainMonth             соло; на стыке skipPlotClocks
    steward → указы → прогресс дел → часы нитей → planBeats
    → storyteller → statJudge → keepStories
  письмо месяца
```

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
| `storyteller.js` | Авторы завязки, бита, указа, тихого месяца |
| `freeform*.js` | Лаборатория свободной истории: стартер, рассказчик, судья |
| `monthResolve.js` / `tick.js` | Оркестрация месяца / мира |
| `conflux*.js` | Стыковка островов |
| `annotationPool.js` / `annotationCatalog.js` | Пулы и wipe-resistant каталог |

Точнее: [PLOTS.md](PLOTS.md), [GENESIS.md](GENESIS.md), [ANNOTATIONS.md](ANNOTATIONS.md), [CONFLUX.md](CONFLUX.md), [STANDING_ORDERS.md](STANDING_ORDERS.md).

## Агенты

Модель задаётся **на агента** в YAML. Почти всё игровое — `gpt-5.6-luna`. Исключения: генезис longform — Claude; ядро тайны — terra; фабрика аннотаций — Claude (офлайн/досев); портреты — `gpt-image-2`.

Жрец: `turnBudgetMs` 120 с, вложенные вызовы (ломастер, информатор, оценка срока) делят этот дедлайн.

## Storage

YAML: `data/world.yaml`, `domains/`, `users/`, `confluxes/`, `annotation-catalog.yaml`.  
Mongo: коллекции `world`, `domains`, `users`, `confluxes`, `annotation_catalog`, `usage`, `world_archives`.

Wipe архивирует мир; каталог аннотаций не трогает. Картинки сейчас ещё пишутся в документ домена (`imageBase64` / `portraitBase64`) — отдельный проход вынесет их на хостинг.
