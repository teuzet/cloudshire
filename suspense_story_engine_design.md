# Новая реализация suspense-историй

## 1. Цель

Новая система suspense должна одновременно решать пять задач:

1. Давать **разнообразные истории**: социальные, политические, исследовательские, мистические, жутковатые, религиозные, природные, катастрофические, приключенческие.
2. Не позволять социальным и экономическим сварам становиться модельным default.
3. Не стагнировать: каждый значимый beat должен реально двигать историю.
4. Уметь отличать короткие живые городские сюжеты от историй, которые хочется разворачивать слоями.
5. Позволять high-gravity историям оставлять **долговременное изменение города**, влияющее на дальнейший canon и будущие генерации.

---

# 2. Базовая природа suspense

Mystery отвечает:

> Что уже произошло на самом деле?

Suspense отвечает:

> Что произойдёт дальше, если город вступит во взаимодействие с текущей нестабильной ситуацией?

Схематично:

```text
MYSTERY
hidden past truth
→ player uncovers it

SUSPENSE
unstable present
→ player acts
→ future remains open
```

При этом suspense может иметь заранее установленные скрытые факты настоящего мира.

Например, для истории «Холодный Ход»:

```yaml
premise:
  Разведчики обнаружили неизвестную пещеру,
  из которой веет жутким холодом.

hiddenPremises:
  - Холод идёт через древнюю искусственную шахту,
    уходящую к нижней стороне острова.
  - В глубине находится запечатанная техническая камера.
```

Игрок этого пока не знает.

Но generator уже знает хороший ответ на локальную неизвестность. Поэтому исследование не заканчивается банальным:

> «там просто сквозняк».

Неопределённым остаётся будущее:

- что сделает экспедиция;
- что будет вскрыто;
- какие последствия возникнут;
- что город сделает с находкой;
- каким станет финальный legacy.

---

# 3. Главный принцип deep suspense

> **Не задерживай раскрытие — углубляй его.**

Плохо:

```text
тик 1: нашли пещеру
тик 2: разведчики сомневаются
тик 3: нужна подготовка
тик 4: всё ещё непонятно, что внутри
```

Хорошо:

```text
тик 1: нашли Холодный Ход
тик 2: выяснили природу холода
тик 3: обнаружили искусственную структуру
тик 4: вскрытие создаёт новую ситуацию
тик 5: город определяет судьбу находки
```

Каждый beat должен отдавать реальный payoff.

---

# 4. Трёхтактная структура suspense

Остаются три фазы, но работают они немного иначе, чем в mystery.

## ACT 1 — CONTACT

Город сталкивается с новой нестабильной ситуацией.

ACT 1 должен:

- представить premise;
- показать, почему она требует внимания;
- дать игроку первое содержательное решение;
- ввести основной cast.

Пример:

> Разведчики обнаружили Холодный Ход и предлагают отправить экспедицию.

## ACT 2 — COMMITMENT / DEEPENING

Город уже взаимодействует с premise.

ACT 2 должен:

- раскрыть новый слой;
- изменить понимание ситуации;
- создать consequence, opportunity или новый meaningful choice;
- не возвращаться к исходному status quo.

Пример:

> Экспедиция выяснила, что ход искусственный, и обнаружила запечатанную камеру.

## ACT 3 — CONSEQUENCE

Финал отвечает:

> Чем эта история стала для города?

Результатом может быть не только исчезновение проблемы, но и:

- новый институт;
- новая религия;
- новый район;
- новый ресурс;
- новая технология;
- новая угроза;
- новая зависимость;
- новая часть географии;
- новая долговременная травма;
- новое отношение между группами.

---

# 5. Три независимые режиссёрские оси

Suspense seed должен отдельно задавать:

```text
TONE
GRAVITY
DEPTH
```

Они не должны подменять друг друга.

---

# 6. Tone

`tone` отвечает:

> Какого рода ощущение должна давать история?

Рекомендуемый формат:

```yaml
tone:
  primary: uncanny
  secondary: exploration
```

Возможные значения:

```text
social
political
adventure
exploration
mystical
uncanny
horror
religious
natural
disaster
wonder
external_threat
economic
technological
```

Примеры:

```text
Холодный Ход:
uncanny + exploration

серебряный порошок после грозы:
wonder + uncanny

гражданская война:
political + tragic

рабочая свара:
social

нападение летучих тварей:
external_threat + adventure
```

---

# 7. Gravity

`gravity` должен приходить **входным параметром** от game/season director.

Он отвечает:

> Насколько крупный след эта история потенциально способна оставить в городе?

Примерная интерпретация:

```text
0–25   minor
26–50  significant
51–75  major
76–100 fate_shaping
```

Gravity НЕ означает:

- насколько сюжет интересный;
- насколько он мистический;
- сколько тиков он должен жить.

Можно иметь:

```text
gravity 15 + mystical
```

и получить небольшую странную историю.

Можно иметь:

```text
gravity 90 + social
```

и получить гражданскую войну.

---

# 8. Gravity как инструмент сезона

Game engine может подавать разные диапазоны gravity по ходу сезона.

Пример:

```text
ранний сезон:    10–35
середина:        25–60
поздний сезон:   50–85
финальные arcs:  70–100
```

Желателен случайный разброс.

Не делать жёстко:

```text
месяц 1 = всегда мелочь
последний месяц = всегда катастрофа
```

---

# 9. Depth

`depth` отвечает:

> Сколько содержательной драматургии эта premise способна и заслуживает выдержать?

```yaml
depth: 1 | 2 | 3
```

## depth 1 — vignette

Короткая история живого города.

Примеры:

- спор двух домов;
- рабочий конфликт;
- локальная проблема снабжения;
- малое бытовое происшествие.

Её нормально закрыть одним сильным вмешательством.

## depth 2 — arc

Обычный полноценный сюжет.

Должен пройти минимум один meaningful turn.

## depth 3 — deep

Исследовательская, мифическая, большая или особенно вкусная история.

Например:

> Холодный Ход.

---

# 10. Depth и gravity независимы

Пример:

```yaml
premise: спор двух крупных домов
gravity: 65
depth: 1
```

История важная, но её не хочется играть пять месяцев.

Другой пример:

```yaml
premise: Холодный Ход
gravity: 35
depth: 3
```

Пока не судьбоносно, но хочется исследовать слоями.

---

# 11. Новый смысл критического успеха

Ключевое правило:

> **CRITICAL выигрывает текущую задачу, а не автоматически весь plot.**

### depth 1

```text
ACT1 + DIRECT + CRITICAL
→ ACT3
→ CRITICAL_SUCCESS
```

### depth 2

```text
ACT1 + DIRECT + CRITICAL
→ major breakthrough
→ ACT2
```

### depth 3

```text
ACT1 + DIRECT + CRITICAL
→ major breakthrough
→ ACT2
→ сильное преимущество / возможная deescalation
```

Deep-story не закрывается автоматически, если её содержательный frontier ещё не исчерпан.

---

# 12. Никакой минимальной длительности в месяцах

Запрещено:

```text
depth 3 должна жить минимум 4 тика
```

Это стимулирует стагнацию.

Правильно:

> deep-story должна пройти через несколько содержательно разных состояний.

Игрок может пройти их быстро, если действует хорошо.

---

# 13. Hidden premises

Если premise содержит явно поставленную неизвестность:

- неизвестное место;
- странный материал;
- аномальный звук;
- необычную погоду;
- новый объект;
- неизвестное существо;

generator должен заранее установить **конкретный содержательный ответ**.

Ответ не обязан быть магическим или древним.

Но он должен быть:

```text
конкретным
объясняющим наблюдаемое
достойным исследования
создающим новую возможность, риск или вопрос
```

Запрещены ответы, практически уничтожающие premise:

```text
"обычный сквозняк"
"случайная трещина"
"просто ошибка"
"ничего особенного"
```

если именно странность была причиной возникновения истории.

---

# 14. Discovery ladder

Для `depth >= 2`, особенно exploration / uncanny / mystical stories, использовать `discoveryLadder`.

Пример:

```yaml
discoveryLadder:
  - id: cold_source
    promise: выяснить, почему из Холодного Хода идёт холод

  - id: artificial_structure
    promise: обнаружить более глубокую природу места

  - id: sealed_chamber
    promise: поставить город перед новым риском или возможностью
```

Это не заранее написанный сценарий будущего.

Это **драматургическая ёмкость** истории.

Правило:

> successful DIRECT beat должен закрывать текущий frontier или существенно его продвигать.

Предпочтительно:

```text
закрыть один вопрос
→ открыть более глубокий вопрос
```

---

# 15. Closure gate

Для depth 2–3 можно хранить:

```yaml
closureGate:
  description: >
    Какой содержательный уровень ситуации должен быть достигнут,
    прежде чем plot становится закрываемым.
```

Пример для Холодного Хода:

```text
Город должен получить непосредственное знание
о глубинной природе Холодного Хода,
а не только обследовать вход.
```

До этого:

```text
closureUnlocked = false
```

После meaningful breakthrough:

```text
closureUnlocked = true
```

Closure gate не должен диктовать конкретное решение игрока.

---

# 16. Генерация premise: сначала событие, потом anchors

Сейчас основной риск — модель видит город и автоматически генерирует:

```text
ремесленники спорят
семьи делят землю
торговцы конфликтуют
```

Новый порядок:

```text
SOURCE + SCALE + TONE + GRAVITY
→ большая premise
→ как она входит именно в этот город
→ какие existing anchors она затрагивает
```

Не:

```text
anchor
→ придумай вокруг него очередной конфликт
```

---

# 17. Source

`source` отвечает:

> Откуда пришла сила или изменение, нарушившие равновесие?

Рекомендуемые значения:

```text
ENVIRONMENT
CREATURE
UNKNOWN
EXTERNAL
SOCIAL
RELIGIOUS
TECHNOLOGICAL
ARCHAEOLOGICAL
ECONOMIC
POLITICAL
```

Пример стартовых весов:

```yaml
sourceWeights:
  ENVIRONMENT: 15
  CREATURE: 10
  UNKNOWN: 15
  EXTERNAL: 8
  RELIGIOUS: 10
  ARCHAEOLOGICAL: 10
  TECHNOLOGICAL: 7
  SOCIAL: 10
  POLITICAL: 8
  ECONOMIC: 7
```

Социальные, политические и экономические сюжеты остаются.

Но больше не доминируют.

---

# 18. Scale

```text
LOCAL
CIVIC
ISLANDWIDE
MYTHIC
```

Пример весов:

```yaml
scaleWeights:
  LOCAL: 20
  CIVIC: 30
  ISLANDWIDE: 30
  MYTHIC: 20
```

### LOCAL

- одна семья;
- одна мастерская;
- одно место;
- небольшая группа.

### CIVIC

- значительная часть города;
- институт;
- отрасль;
- крупный городской конфликт.

### ISLANDWIDE

- весь остров;
- ландшафт;
- климат;
- снабжение;
- массовая миграция;
- общегородское движение.

### MYTHIC

- фундаментальная аномалия;
- событие, достойное внимания божества;
- экзистенциальная угроза;
- крупное религиозное или сверхъестественное изменение.

---

# 19. Situation

Рекомендуемый enum:

```text
THREAT
OPPORTUNITY
DILEMMA
TRANSITION
```

Это важно, чтобы «сюжет» не означал автоматически «бедствие».

---

# 20. Dynamic

`dynamic` отвечает:

> Что произойдёт с ситуацией, если её оставить без внимания?

Примеры:

```text
depletion
accumulation
spread
polarization
deadline
feedback
lock_in
cascade
competition
drift
deepening
```

---

# 21. Анти-доминантное правило для бытовых конфликтов

В suspenseStart:

```text
Обычные конфликты между ремесленниками, семьями,
торговцами, землевладельцами и городскими группами
допустимы и нужны.

Но не выбирай такой конфликт по умолчанию
только потому, что он легко следует из описания города.

Сначала следуй выпавшим SOURCE, SCALE, TONE и GRAVITY.
```

И отдельно:

> Не своди интересную природную, аномальную, религиозную, археологическую или внешнюю premise к обычной сваре групп, если само событие уже достаточно интересно.

Социальная реакция может стать частью ACT 2.

---

# 22. Premise и social response — разные уровни

Полезная модель:

```text
PREMISE
что изменилось в мире

SOCIAL RESPONSE
как люди на это реагируют
```

Например:

```text
PREMISE:
после грозы выпал серебряный порошок

SOCIAL RESPONSE:
лекари боятся заражения
кузнецы хотят исследовать свойства
часть храма считает это знамением
```

История остаётся про серебряный порошок, а не превращается в спор лекарей и кузнецов.

---

# 23. Anti-stagnation: MOMENTUM RULE

Главный runtime-инвариант:

> **Каждый meaningful story beat должен существенно изменить состояние story.**

Beat должен давать хотя бы одно:

- новый подтверждённый факт;
- новый результат действия;
- новый объект;
- новый риск;
- новую возможность;
- новую consequence;
- новый frontier;
- реальное ухудшение;
- реальное улучшение.

Запрещено использовать вместо развития:

- ожидание;
- подготовку;
- формирование комиссии;
- обсуждение;
- запрос разрешения;
- «нужно сначала изучить»;
- «разведчики пока не решаются»;

если engine не сообщил, что именно это и является результатом.

---

# 24. Completed process means completed action

Если process завершился, beat-agent не имеет права понижать глагол.

```text
"исследовать"
≠ "подготовиться исследовать"

"построить"
≠ "обсудить строительство"

"атаковать"
≠ "разведать позиции"

"отправить экспедицию"
≠ "собрать экспедицию"

"провести переговоры"
≠ "пригласить к переговорам"
```

Если process SUCCESS:

> заявленная цель реально осуществлена в мире.

---

# 25. Outcome semantics

## CRITICAL_SUCCESS

Действие выполнено полностью и дало больше полезного результата, чем ожидалось.

## SUCCESS

Основная цель достигнута.

Могут быть:

- цена;
- осложнение;
- новый frontier;
- неполнота вторичного результата.

## FAILURE

Провал — это **плохое изменение состояния**, а не отсутствие события.

Плохо:

> экспедиция не смогла собраться.

Хорошо:

> экспедиция вошла, столкнулась с опасностью, потеряла часть снаряжения и вернулась раньше цели.

---

# 26. NPC не отменяют успешные действия игрока

NPC могут быть осторожными, испуганными и упрямыми.

Но:

> характер NPC не является механизмом отмены process, который engine уже определил как успешно завершённый.

Осторожность меняет **как** они действуют.

Не **действуют ли они вообще**.

---

# 27. Персонажи: структурные роли

Suspense может использовать role-based cast:

```text
INITIATOR
кто приносит premise

DRIVER
кто хочет двигаться вперёд

BRAKE
кто содержательно сопротивляется

STAKEHOLDER
кого затрагивает исход

EXPERT
кто способен открыть новый слой

ANTAGONISTIC_FORCE
если есть сознательное противодействие
```

Не все роли нужны всегда.

---

# 28. Правило новых персонажей

Перед созданием нового named character:

1. Проверить уже существующий cast story.
2. Проверить известных персонажей города, естественно связанных с ситуацией.
3. Использовать существующего, если участие причинно естественно.
4. Создавать нового только если появилась новая устойчивая функция, которую никто существующий не может правдоподобно выполнить.

Правило:

```text
reuse has priority over invention
ONLY when causally natural
```

---

# 29. Lifecycle персонажей

## ACT 1

Обычно 1–2 named characters.

## ACT 1 → ACT 2

Допускается новый значимый персонаж, если сама природа story изменилась.

Например:

```text
пещера
→ оказалась древней структурой
→ появляется архивист
```

## ACT 2

Предпочитать углублять уже существующих персонажей и их позиции.

## ACT 3

Не вводить нового ключевого NPC только ради финального решения.

---

# 30. High-gravity legacy

High-gravity suspense должен потенциально менять сам setting.

Рекомендуемые `legacyAxis`:

```text
geography
institution
religion
population
technology
ecology
external_relation
political_order
resource_base
supernatural_order
infrastructure
culture
```

Пример:

```text
gravity < 50
legacyAxis optional

gravity 50–75
legacyAxis encouraged

gravity >= 75
at least one plausible legacyAxis required
```

---

# 31. Generator не фиксирует финальное legacy заранее

Например:

```yaml
gravity: 91
tone: religious
legacyAxis:
  - religion
```

Premise:

> В городе быстро растёт новая массовая вера.

Но generator НЕ решает заранее, что культ победит.

Разные outcomes могут дать:

```text
подавление
→ усиление старого храма

признание
→ многоконфессиональный город

синтез
→ новый общий обряд

игнорирование
→ автономная религиозная сила
```

---

# 32. Чем выше gravity, тем сильнее итоговый след

### 0–25

Обычно 0–1 небольшой постоянный факт.

### 25–50

Локальное устойчивое изменение.

### 50–75

Значимое изменение устройства города.

### 75–100

Финал почти обязан отвечать:

> Что теперь навсегда иначе в этом городе?

Например:

- новая религия;
- новая власть;
- потерянная часть острова;
- новая технология;
- новый крупный вид;
- новый внешний союз;
- новая сеть древних ходов;
- климатическое изменение.

---

# 33. Legacy возвращается в canon

После resolution high-gravity story должен появляться structured proposal:

```yaml
legacy:
  newEntities:
    - ...

  changedEntities:
    - ...

  newFacts:
    - ...

  retiredFacts:
    - ...

  longTermRisks:
    - ...

  longTermOpportunities:
    - ...
```

После validation эти факты попадают в city canon и участвуют в будущих генерациях.

---

# 34. Рекомендуемый suspense seed

```yaml
suspenseSeed:
  tone:
    primary: uncanny
    secondary: exploration

  gravity: 42
  depth: 3

  scale: CIVIC
  source: UNKNOWN
  situation: OPPORTUNITY
  dynamic: deepening

  association: "граница"
```

High-gravity пример:

```yaml
suspenseSeed:
  tone:
    primary: political
    secondary: tragic

  gravity: 92
  depth: 3

  scale: ISLANDWIDE
  source: SOCIAL
  situation: THREAT
  dynamic: polarization

  legacyAxis:
    - political_order
```

---

# 35. Рекомендуемый output suspenseStart

```yaml
title:

premise:

tone:
  primary:
  secondary:

gravity:
depth:
scale:
source:
situation:
dynamic:

anchorsUsed:
  - ...

characters:
  - name:
    role:
    existing:
    reason:

centralTension:

hiddenPremises:
  - ...

discoveryLadder:
  - id:
    promise:

closureGate:
  description:

legacyAxes:
  - ...

entry:
initialSynopsis:
```

Для depth 1 часть полей может быть optional.

---

# 36. Что suspenseStart НЕ фиксирует

Он не должен заранее выбирать:

- правильное решение;
- точный финал;
- победителя;
- неизбежный legacy;
- конкретные future consequences, зависящие от player action.

Он создаёт:

```text
unstable present
+
dramaturgical capacity
+
possible hidden payoff
```

---

# 37. Phase engine

Engine, а не suspenseBeat, решает:

- phase transition;
- shortcut;
- escalation;
- deescalation;
- closure availability;
- ending.

`suspenseBeat` только материализует решение.

---

# 38. ACT 1 transition logic

## DIRECT + CRITICAL

```text
depth 1:
ACT1 → ACT3
CRITICAL_SUCCESS

depth 2–3:
ACT1 → ACT2
major breakthrough
possible deescalation / advantage
```

## DIRECT + SUCCESS

```text
ACT1 → ACT2
clear meaningful progress
```

## DIRECT + FAILURE

```text
ACT1 → ACT2
setback / bad consequence
```

Не стагнация.

## RELEVANT + CRITICAL

```text
ACT1 → ACT2
strong indirect progress
possible deescalation
```

## RELEVANT + SUCCESS

```text
ACT1 → ACT2
limited progress
```

## RELEVANT + FAILURE

```text
ACT1 → ACT2
escalation
```

## UNRELATED

```text
critical:
possible pressure relief only if causally plausible

success:
plot unchanged

failure:
plot may escalate
```

---

# 39. ACT 2 transition logic

## DIRECT + CRITICAL

Если:

```text
closureUnlocked = true
```

то:

```text
ACT2 → ACT3
CRITICAL_SUCCESS
```

Если нет:

```text
major breakthrough
advance frontier
possibly unlock closure
```

## DIRECT + SUCCESS

Если closure unlocked:

```text
ACT2 → ACT3
SUCCESS
```

Если нет:

```text
advance frontier
stay ACT2
```

## DIRECT + FAILURE

```text
meaningful negative consequence
escalate
```

Если escalation budget исчерпан:

```text
ACT3
FAILURE
```

## RELEVANT

```text
critical:
meaningful progress + possible deescalation

success:
limited progress

failure:
escalate
```

---

# 40. Auto tick

Если story unattended:

```text
roll urgency
```

При срабатывании suspense может:

- распространить проблему;
- закрыть окно возможности;
- активировать antagonist;
- изменить landscape;
- усилить общественную реакцию;
- создать новую consequence.

Auto tick не должен просто сообщать:

> люди всё ещё ждут решения.

---

# 41. Escalation и deepening — не одно и то же

Для suspense особенно важно различать:

```text
PRESSURE ESCALATION
и
DISCOVERY DEEPENING
```

Exploration story может стать **интереснее и больше**, не становясь опаснее.

Например:

> экспедиция обнаружила огромный новый ресурс.

Это deepening, но не обязательно escalation.

---

# 42. Structured beat directive

Engine должен передавать `suspenseBeat` примерно:

```yaml
TACT:
  plotType: suspense

  phaseBefore:
  phaseAfter:

  depth:
  gravity:

  trigger:
    kind: PROCESS | AUTO
    relation: DIRECT | RELEVANT | UNRELATED
    outcome: CRITICAL | SUCCESS | FAILURE | null

  progress:
    mode:
      BREAKTHROUGH |
      ADVANCE |
      SETBACK |
      DEEPEN |
      RESOLVE |
      NO_PLOT_CHANGE

    frontierBefore:
    frontierAfter:

    closureUnlockedBefore:
    closureUnlockedAfter:

  pressure:
    escalationLevelBefore:
    escalationLevelAfter:
    urgencyBefore:
    urgencyAfter:
    gravityBefore:
    gravityAfter:

  ending:
    none | SUCCESS | CRITICAL_SUCCESS | FAILURE

  legacy:
    required:
    allowedAxes:
      - ...
```

---

# 43. Ownership suspenseBeat

`suspenseBeat` имеет право:

- придумать конкретное событие текущего месяца;
- показать действия персонажей;
- раскрыть разрешённый hidden premise;
- материализовать breakthrough;
- создать consequence;
- ввести персонажа по cast policy.

`suspenseBeat` НЕ имеет право:

- менять depth;
- самовольно менять gravity;
- отменять successful process;
- решать, закрылась ли story;
- понижать action до preparation;
- самовольно менять legacy axis.

---

# 44. Prompt-инвариант suspenseBeat

```text
MOMENTUM

Каждый beat обязан существенно изменить состояние story.

Не сохраняй интересное "на потом".

Если текущий такт разрешает раскрытие,
дай конкретный payoff сейчас.

Не заменяй завершённое действие подготовкой к нему.

Провал означает плохое изменение состояния,
а не отсутствие события.

Для deep story:
не задерживай раскрытие — углубляй его.
Закрывай текущий вопрос и открывай следующий,
если engine требует DEEPEN или BREAKTHROUGH.
```

---

# 45. Полный пример: Холодный Ход

## Start

```yaml
title: Холодный Ход

tone:
  primary: uncanny
  secondary: exploration

gravity: 38
depth: 3
scale: CIVIC
source: UNKNOWN
situation: OPPORTUNITY
dynamic: deepening

premise: >
  Разведчики обнаружили неизвестную пещеру,
  из которой непрерывно веет жутким холодом.

hiddenPremises:
  - Холод создаёт древняя искусственная шахта,
    уходящая к нижней стороне острова.
  - За глубинным ледяным проходом находится
    запечатанная техническая камера.

discoveryLadder:
  - cold_source
  - artificial_structure
  - sealed_chamber

closureGate: >
  Город должен непосредственно исследовать
  глубинную природу Холодного Хода
  и определить отношение к найденной структуре.
```

Игрок:

> Отправить экспедицию.

Result:

```text
DIRECT + CRITICAL
```

Engine:

```text
depth = 3
ACT1 → ACT2
progress = BREAKTHROUGH
ending = none
```

Beat:

> Экспедиция возвращается без потерь. Разведчики выяснили, что холод идёт не из природной трещины: стены в глубине выровнены инструментом, а поток воздуха уходит вниз через вертикальную шахту. За покрытым инеем каменным затвором слышен ровный металлический стук.

Крит дал огромный payoff.

Но story не закончилась.

---

# 46. Пример depth 1

```yaml
premise:
  Два старых торговых дома спорят,
  кто имеет право использовать новый причал.

gravity: 42
depth: 1

tone:
  primary: social
```

Игрок блестяще устанавливает новый порядок.

```text
DIRECT + CRITICAL
→ ACT3
→ CRITICAL_SUCCESS
```

Story закрывается.

Это правильно.

---

# 47. Судьбоносный пример

```yaml
tone:
  primary: religious
  secondary: political

gravity: 91
depth: 3

scale: ISLANDWIDE
source: RELIGIOUS
situation: TRANSITION
dynamic: polarization

legacyAxes:
  - religion
  - political_order
```

Premise:

> После необычного небесного явления в городе быстро возникает новая массовая вера.

Финал зависит от player action.

Но история должна оставить крупный след в setting.

---

# 48. Telemetry

Логировать:

```text
tone distribution
source distribution
scale distribution
gravity distribution
depth distribution
```

Также:

```text
average ticks to resolution by depth
critical shortcut rate
ACT1→ACT3 rate by depth
new character count per story
existing character reuse rate
legacy rate by gravity band
```

---

# 49. Anti-stagnation telemetry

Автоматически отмечать beat, если он:

- не добавил нового факта;
- не изменил состояние;
- не выполнил completed process;
- не продвинул frontier;
- не создал consequence.

Например:

```text
NO_MEANINGFUL_STATE_CHANGE
```

Такие beats должны быть редкими.

---

# 50. Variety telemetry

Следить, чтобы generator не схлопнулся обратно в:

```text
SOCIAL
POLITICAL
ECONOMIC
```

Или в новый единственный attractor:

```text
все необычные истории = древний артефакт
```

Полезно измерять:

```text
source entropy
tone entropy
scale distribution
anchor diversity
semantic clustering of premises
```

---

# 51. Основные инварианты

1. **Suspense = открытое будущее.**
2. У локальной неизвестности может быть заранее хороший скрытый ответ.
3. Каждый meaningful beat меняет state.
4. Completed process означает completed action.
5. Failure тоже двигает plot.
6. Critical выигрывает текущую задачу, а depth решает, заканчивается ли вся история.
7. Deep story раскрывается слоями, а не задержками.
8. Social stories нужны, но не являются default.
9. Новые персонажи появляются ради новой устойчивой функции.
10. High-gravity stories потенциально меняют setting.
11. Значимое legacy возвращается в city canon.
12. Большое необычное событие не следует автоматически превращать в спор двух человеческих групп.

---

# 52. MVP-порядок внедрения

## P0

1. Добавить входной `gravity`.
2. Добавить `source`, `scale`, `tone`.
3. Добавить `depth`.
4. Сделать depth-aware critical shortcut.
5. Добавить MOMENTUM RULE.
6. Добавить completed-process semantics.
7. Запретить failure-as-no-event.

## P1

8. Добавить `hiddenPremises`.
9. Добавить `discoveryLadder`.
10. Добавить `closureGate`.
11. Добавить cast roles и reuse policy.

## P2

12. Добавить `legacyAxes`.
13. Генерировать structured legacy после ACT3.
14. Писать legacy обратно в canon.
15. Добавить season gravity curve.
16. Добавить telemetry разнообразия и стагнации.

---

# 53. Итоговая архитектура

```text
SEASON DIRECTOR
   ↓
gravity target
   ↓
SUSPENSE SEEDER
   ↓
source + scale + tone + situation + dynamic
   ↓
SUSPENSE START
   ↓
premise + depth + cast
hiddenPremises + discoveryLadder
closureGate + legacyAxes
   ↓
ACTIVE STORY
   ↓
process / auto tick
   ↓
plotAlign
   ↓
PHASE ENGINE
   ↓
phase + progress + shortcut
frontier + closure + escalation + ending
   ↓
SUSPENSE BEAT
   ↓
ACT 3
   ↓
optional LEGACY GENERATION
   ↓
CITY CANON
```

Главная целевая формула:

> **Маленькие истории делают город живым.  
> Большие истории делают игру достойной бога.  
> Глубокие истории получают время не через задержки, а через новые содержательные слои.**
