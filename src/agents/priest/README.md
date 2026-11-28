# priest

Ход разговора: реплика покровителя → вызовы дел → речь жреца.

- Вход: правила, город, день, реплика (и цитата, если это ответ на сообщение).
- Тулы: `assign_officer`, `order_change`, `withdraw_assignment`, `write_note`, `queue_order`, `unqueue_order`,
  `set_standing_order`, `consult_loremaster`, `check_existence`; итоговый — `submit_reply`.
- `queue_order` с `condition` и `watch` ставит поручение, которое ждёт события («если бунтовщики пойдут
  на склады, сбейте цепи»). Сверяет условие condition-judge на проходе жреца (`src/flows/steward.ts`).
- Обработчики тулов даёт поток хода жреца. `assign_officer` и `order_change` ведут в один поток
  воли игрока (`src/flows/will.ts`): что это за приказ, решает will-interpreter.
- `acted` — было ли действие с делом; от этого зависит цена хода в мане.
- Ключ фронта, подвох, события и улики жрецу не видны: только описания идущего и ждущие замыслы.
