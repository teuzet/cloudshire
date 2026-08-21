# Деплой Cloudshire (тестовый запуск)

## Архитектура теста

- **Игроки:** только Telegram
- **Админка:** веб UI + Basic auth (`ADMIN_USER` / `ADMIN_PASSWORD`)
- **Данные:** MongoDB Atlas (`STORAGE_DRIVER=mongo`)
- **Тик:** каждые 2 часа; `world.scheduler.nextTickAt` в Mongo переживает рестарт (один catch-up)
- **Логи приложения:** stdout (Heroku Logs); usage LLM → коллекция `usage`

## Heroku + Atlas

1. Создай app и добавь buildpack Node (engines.node >= 20).
2. Config vars:

```
STORAGE_DRIVER=mongo
MONGODB_URI=mongodb+srv://…
MONGODB_DB=cloudshire
ADMIN_USER=…
ADMIN_PASSWORD=…
OPENAI_API_KEY=…
TELEGRAM_BOT_TOKEN=…
TELEGRAM_ENABLED=1
TICK_INTERVAL_HOURS=2
LOG_LEVEL=info
```

3. Deploy (`git push heroku …` или GitHub integration). `Procfile`: `web: node src/index.js`.
4. Открой `https://<app>.herokuapp.com/` — логин Basic → админка.
5. Health без auth: `GET /health`.

## Локально с Atlas

```bash
cp .env.example .env
# заполни MONGODB_URI, ADMIN_*, OPENAI_*, TELEGRAM_*
STORAGE_DRIVER=mongo npm start
```

Yaml по-прежнему: без `STORAGE_DRIVER=mongo` (дефолт `yaml` в `config/default.yaml`).

## Поведение тика

- После тика: `lastTickAt`, `nextTickAt = now + interval`.
- Рестарт: если `nextTickAt` уже прошёл — **один** catch-up тик, без пачки.
- Пока тик идёт, Telegram игроку с доменом отвечает системно («сейчас шаг времени…»).
- Домены (и conflux-пары) резолвятся **параллельно**.

## Админка

- Просмотр доменов, хроники, процессов, плотлайнов, conflux
- Force tick / force conflux / wipe
- Без игрового веб-чата (`POST /api/chat` → 404)
