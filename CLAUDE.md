# Cloudshire v2 — инструкции для Claude

Текстовый мультиплеерный годсим в Telegram: игрок — бог-покровитель летающего
города, говорит с верховным жрецом. TypeScript strict, Node 20+, ESM.
Общение с Ником по-русски. Принципы разработки: docs/v2/DEV_PRINCIPLES.md
(ветка claude/project-thread-tg58y5, пока не влита). Механика мира: docs/design/fronts.md.

## Карта

- `src/core/` — чистая логика мира: правила, время, объекты, фронты, статы, очередь, мана. Без IO, LLM и `process.env`.
- `src/ports/` — интерфейсы Llm, Storage, Clock, Random, Notifier.
- `src/adapters/` — реализации портов. Только здесь импортируются SDK, Mongo и Telegram. LLM: openai, anthropic, router, fake (тесты), cassette.
- `src/agents/<name>/` — LLM-агенты: prompt.md, schema.ts, run.ts, README.md. Список и правила — src/agents/README.md.
- `src/flows/` — сценарии, склеивающие core и агентов (шаг 3, ещё нет).
- `src/clients/` — Telegram, mini-app, dev-клиент (шаг 4, ещё нет).
- `config/agents.yaml` — модели агентов (`провайдер:модель`).
- `config/game.yaml` — все игровые числа. Проверяется `parseRules`, отсутствие ключа — ошибка.
- `scenarios/*.yaml` — заготовки историй, схема в `src/core/world/scenario.ts`.

## Жёсткие правила

- Импорт только вниз: clients → flows → agents → core. Проверяет `npm run lint:deps`.
- Агенты не импортируют и не вызывают друг друга; общий код — `src/agents/_shared`.
- Время и рандом берутся из портов, не из `Date.now()` и `Math.random()`.
- LLM решает смысл, код решает количество: числа считает только core.
- Не запускай настоящие модели, пока Ник явно не попросил.
- Ключи только в секретах окружения, никогда в логах и коммитах.

## Команды

- `npm run check` — typecheck + lint:deps + тесты. Гоняй перед каждым коммитом.
- `npm test`, `npm run test:watch`.
