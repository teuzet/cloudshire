# Cloudshire

Текстовая мультиплеерная god-sim для Telegram: игрок — покровитель острова, говорит со жрецом.

Документация:

- [Продукт](docs/PROJECT.md)
- [Архитектура](docs/ARCHITECTURE.md)
- [Нити и дела](docs/PLOTS.md) · [Генезис](docs/GENESIS.md) · [Аннотации](docs/ANNOTATIONS.md)
- [Сопряжение](docs/CONFLUX.md) · [Указы](docs/STANDING_ORDERS.md)
- [Деплой](docs/DEPLOY.md) · [Playtest](docs/PLAYTEST_AGENT.md)

## Быстрый старт

```bash
cp .env.example .env
# OPENAI_API_KEY; для генезиса longform — ключ Anthropic

npm install
npm start
```

Открой http://127.0.0.1:3000 — локальная имитация чата.

```bash
npm run cli -- status
npm run cli -- agent-ping
npm run cli -- chat -u local-user "Хочу начать игру"
npm run cli -- tick
npm test
```

Хранилище по умолчанию — YAML в `data/`. Mongo: `STORAGE_DRIVER=mongo` (см. `.env.example`).

Telegram: `TELEGRAM_BOT_TOKEN` в `.env`. Веб на :3000 остаётся админкой.

Playtest: `npm run playtest` — см. [docs/PLAYTEST_AGENT.md](docs/PLAYTEST_AGENT.md).
