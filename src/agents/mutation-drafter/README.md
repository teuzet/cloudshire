# mutation-drafter

Первый шаг воли игрока: свободная фраза → одно изменение (create/modify/delete).

- Вход: правила, воля покровителя, живые объекты города.
- Выход: `MutationDraft`. Проверка: цель существует, защищённое не удаляется, длины в пределах.
- Дальше по цепочке: feasibility-judge → impact-judge → consequences-generator → consequence-judge.
