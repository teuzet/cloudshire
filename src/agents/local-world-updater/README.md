# local-world-updater

Судья каскада по refs: одна сущность против одного изменения.

- Вход: изменение (`CascadeChange`) и сущность-подписчик.
- Выход: `CascadeVerdict`. Для updated обязателен text.
- Передаётся в `runCascade` как `judge`. Агент сломался — поток считает unchanged.
