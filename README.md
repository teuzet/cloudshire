# Cloudshire

Текстовая мультиплеерная игра для Telegram на LLM-агентах.

Документация: [docs/PROJECT.md](docs/PROJECT.md)

## Быстрый старт

```bash
cp .env.example .env
# пропиши OPENAI_API_KEY

npm install
npm start
```

Открой http://127.0.0.1:3000 — локальная имитация чата.

CLI:

```bash
npm run cli -- status
npm run cli -- agent-ping
npm run cli -- chat -u local-user "Хочу начать игру"
npm run cli -- tick
npm run cli -- domains
```

Автопрогон (полный генезис + агент-игрок до N force-tick, store в `data-test/`, отчёт в `artifacts/`):

```bash
npm run playtest
npm run playtest -- --ticks 5
npm run playtest -- --scripted --ticks 5
```

План: [docs/PLAYTEST_AGENT.md](docs/PLAYTEST_AGENT.md).

Хранилище по умолчанию — YAML в `data/`. Переключение на Mongo: в `config/default.yaml` поставь `storage.driver: mongo`.

Telegram: положи `TELEGRAM_BOT_TOKEN` в `.env` и перезапусти `npm start` — бот поднимется сам
(polling). Явно выключить: `TELEGRAM_ENABLED=0`. Веб на http://127.0.0.1:3000 остаётся админкой
и видит все домены, в том числе заведённые из Telegram (`[tg]` в слотах).

### Локальный клиент

- **Новый город** — отдельный слот (параллельные города).
- Переключение слотов в селекте.
- Панель **Хроника** + кнопка обновления.
- Force tick двигает игровой месяц (12 тиков = 1 игровой год ≈ 1 реальные сутки).
