# Cloudflare R2 — настройка для Cloudshire

Нужно один раз в браузере. Потом четыре строки в `.env` / Railway. Код ещё не подключен: когда ключи будут, напиши.

Публичный URL берём `*.r2.dev` (без своего домена). Cloudflare считает его «для разработки» и может рейтить; для закрытого теста этого хватает.

---

## 0. Аккаунт

1. Зайди на [dash.cloudflare.com](https://dash.cloudflare.com) (регистрация бесплатная).
2. Карта: **My Profile → Billing → Payment Methods**. Без карты R2 часто не включается. В лимите 10 ГБ не списывают.
3. По желанию сразу поставь потолок: **Billing** / уведомления по R2, spending cap $0–5.

## 1. Включить R2

1. В меню: **Storage & databases → R2 → Overview**.
2. Если просит подписку — **Complete checkout**. Это не тариф, а активация. Бесплатный порог остаётся.

## 2. Бакет

1. **Create bucket**.
2. Имя: `cloudshire` (латиница, без пробелов).
3. Location: оставь default. **Create**.

## 3. Публичный URL

1. Открой бакет → **Settings**.
2. **Public Development URL** → **Enable**.
3. Подтверждение: введи `allow` → **Allow**.
4. Скопируй URL вида `https://pub-xxxxxxxx.r2.dev`.  
   Это `R2_PUBLIC_BASE_URL` (без слэша в конце).

Проверка: в Settings у Public URL Access должно быть **Allowed**.

## 4. Токен (ключи S3)

1. **R2 → Overview**. Справа **Account details → API Tokens → Manage**.
2. **Create User API token** (или Account, если ты Super Admin).
3. Permissions: **Object Read & Write**.
4. Scope: только бакет `cloudshire`.
5. **Create**.

Сразу скопируй (секрет второй раз не покажут):

- **Access Key ID** → `R2_ACCESS_KEY_ID`
- **Secret Access Key** → `R2_SECRET_ACCESS_KEY`

## 5. Account ID

На любой странице дашборда справа: **Account ID**.  
Или URL: `dash.cloudflare.com/<этот-хекс>/…`

Это `R2_ACCOUNT_ID`.

## 6. Куда вписать

Локально — `.env` (не коммитить). На проде — Railway **Variables**.

```
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=cloudshire
R2_PUBLIC_BASE_URL=https://pub-xxxxxxxx.r2.dev
```

`R2_BUCKET` — точное имя бакета.  
S3-эндпоинт код соберёт сам: `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`.

## 7. Проверка без кода

В бакете **Upload** любой маленький `test.png`.  
Открой в браузере: `https://pub-….r2.dev/test.png`. Должна открыться картинка. Потом файл можно удалить.

Если 404 — Public Development URL выключен. Если 403 — токен не нужен для чтения публичного объекта; 403 на URL значит бакет ещё не public.

---

Не класть ключи в чат и в git. Когда пять строк на месте — можно подключать загрузку в игру.
