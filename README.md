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

Хранилище по умолчанию — YAML в `data/`. Переключение на Mongo: в `config/default.yaml` поставь `storage.driver: mongo`.

Telegram: `telegram.enabled: true` и `TELEGRAM_BOT_TOKEN` в `.env`.

### Локальный клиент

- **Новый город** — отдельный слот (параллельные города).
- Переключение слотов в селекте.
- Панель **Хроника** + кнопка обновления.
- Force tick двигает игровой месяц (12 тиков = 1 игровой год ≈ 1 реальные сутки).
