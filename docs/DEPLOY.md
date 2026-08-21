# Деплой Cloudshire (тестовый запуск)

## Архитектура теста

- **Игроки:** только Telegram (long polling — отдельный webhook URL не нужен)
- **Админка:** веб UI + Basic auth (`ADMIN_USER` / `ADMIN_PASSWORD`)
- **Данные:** MongoDB Atlas (`STORAGE_DRIVER=mongo`)
- **Тик:** каждые 2 часа; `world.scheduler.nextTickAt` в Mongo переживает рестарт (один catch-up)
- **Логи:** stdout платформы; usage LLM → коллекция `usage` в Mongo

Рекомендуемый хост для теста: **Railway**.

---

## Railway + Atlas

### 0. Atlas (один раз)

1. Cluster уже есть.
2. **Database Access** — user/password для приложения.
3. **Network Access** → Add IP → `0.0.0.0/0` (Railway не даёт стабильный egress IP на простом тарифе).
4. Connect → Drivers → скопируй `mongodb+srv://…` URI (с паролем и `/?retryWrites=true&w=majority`).

### 1. Проект на Railway

1. [railway.app](https://railway.app) → Login (лучше через GitHub).
2. **New Project** → **Deploy from GitHub repo** → `teuzet/cloudshire`.
3. Branch: **`dev`** (или `main`, если перенесёшь туда код).
4. Railway подхватит Node (engines >= 20) и `npm start` → `node src/index.js`.
5. В сервисе: **Settings** → **Networking** → **Generate Domain** (публичный HTTPS URL админки).

### 2. Variables

В сервисе → **Variables** (или Shared Variables проекта):

```
STORAGE_DRIVER=mongo
MONGODB_URI=mongodb+srv://USER:PASS@CLUSTER.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB=cloudshire

ADMIN_USER=admin
ADMIN_PASSWORD=<длинный пароль>

OPENAI_API_KEY=sk-…
TELEGRAM_BOT_TOKEN=…
TELEGRAM_ENABLED=1

TICK_INTERVAL_HOURS=2
TICK_ENABLED=1
LOG_LEVEL=info
```

`PORT` Railway выставит сам — не задавай вручную.

После сохранения Variables сервис перезадеплоится.

### 3. Проверка

1. `https://<твой>.up.railway.app/health` → `{"ok":true}` (без логина).
2. `https://<твой>.up.railway.app/` → Basic auth → админка.
3. Напиши боту в Telegram `/start` — должен ответить онбординг/правитель.
4. В админке: домен появится после генезиса; **Force tick** для ручной проверки.

### 4. Логи и рестарты

- **Deployments / Logs** в Railway — stdout приложения.
- Рестарт контейнера не сбрасывает игровое время: якорь в `world.scheduler` в Mongo.
- Один инстанс (replicas = 1): два процесса с одним Telegram-токеном будут конфликтовать на polling.

### 5. Типичные проблемы

| Симптом | Что проверить |
|--------|----------------|
| Crash на старте / Mongo | URI, пароль URL-encoded, Network Access `0.0.0.0/0` |
| Админка без пароля / 401 forever | `ADMIN_USER` + `ADMIN_PASSWORD` |
| Бот молчит | `TELEGRAM_BOT_TOKEN`, логи `telegram.status` |
| Тиков нет | `TICK_ENABLED`, логи `scheduler.*` |

---

## Heroku + Atlas (альтернатива)

Те же Variables, что выше. `Procfile`: `web: node src/index.js`.  
Deploy: GitHub integration или `git push heroku dev:main`.

---

## Локально с Atlas

```bash
cp .env.example .env
# MONGODB_URI, ADMIN_*, OPENAI_*, TELEGRAM_*
STORAGE_DRIVER=mongo npm start
```

Без `STORAGE_DRIVER=mongo` — локальный yaml в `./data`.

## Поведение тика

- После тика: `lastTickAt`, `nextTickAt = now + interval`.
- Рестарт: если `nextTickAt` уже прошёл — **один** catch-up тик, без пачки.
- Пока тик идёт, Telegram отвечает системно («сейчас шаг времени…»).
- Домены (и conflux-пары) резолвятся **параллельно**.

## Админка

- Просмотр доменов, хроники, процессов, плотлайнов, conflux
- Force tick / force conflux / wipe
- Без игрового веб-чата (`POST /api/chat` → 404)
