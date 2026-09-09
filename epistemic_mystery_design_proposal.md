# Experiment Proposal: Epistemic Mystery Design → City Binding → Concrete Truth Graph

## Цель

Попробовать более универсальную Phase 1 для mystery-историй.

Главная идея:

> Mystery — это не обязательно преступление, заговор или человеческое действие.

Центральная структура mystery:

```text
Есть наблюдаемый X.
У X существует уже свершившаяся скрытая причина.
Игрок должен восстановить, что именно произошло,
почему это произошло и как скрытая истина объясняет X.
```

Скрытая причина может быть:

- человеческим действием;
- природным процессом;
- поведением существа;
- древним событием;
- ошибочной идентификацией;
- аномальным явлением;
- цепочкой случайностей;
- скрытой структурой;
- социальным процессом.

Поэтому Phase 1 должна начинать не с actor/motive,
а с **эпистемической конструкции тайны**.

---

# Новый pipeline

```text
DIRECTOR TAGS
      ↓
PHASE 1 — ABSTRACT MYSTERY DESIGN
      ↓
KERNEL JUDGE
      ↓
CITY BINDER
      ↓
CONCRETE TRUTH GRAPH
      ↓
STRICT MYSTERY JUDGE
      ↓
MASK / OBSERVED PROJECTION
      ↓
PRESENTATION
      ↓
GAME
```

Phase 1 отвечает:

> Что именно неизвестно игроку,
> какого рода истина скрыта,
> почему разумные наблюдатели не видят её сразу,
> какой формы причинная цепочка,
> и почему раскрытие интересно?

Phase 2 отвечает:

> Как эта mystery конкретно существует в данном городе?

---

# 1. `mysteryQuestion`

Определяет **какого рода неизвестность является центром mystery**.

Возможные значения:

```text
CAUSE
AGENT
MOTIVE
PROVENANCE
IDENTITY
LOCATION
MECHANISM
HISTORY
RELATION
NATURE
```

## CAUSE

Почему наблюдаемый X вообще происходит?

## AGENT

Кто вызвал X или совершил скрытое действие?

## MOTIVE

Зачем кто-то совершил уже установленное действие?

## PROVENANCE

Откуда взялся объект, вещество, явление, след или группа?

## IDENTITY

Кто или что на самом деле является наблюдаемым Y?

## LOCATION

Куда исчез объект / человек / группа или где он теперь находится?

## MECHANISM

Как физически, социально или аномально возможно наблюдаемое X?

## HISTORY

Что произошло здесь раньше и породило нынешние следы?

## RELATION

Как связаны два или несколько наблюдаемых явления?

## NATURE

Что вообще представляет собой наблюдаемый объект, процесс или явление?

---

# 2. `answerShape`

Определяет **какого рода истина окажется за mystery**.

Возможные значения:

```text
HUMAN_ACTION
NATURAL_PROCESS
CREATURE_BEHAVIOR
ANCIENT_EVENT
HIDDEN_STRUCTURE
ANOMALOUS_PHENOMENON
SOCIAL_PROCESS
CHAIN_OF_ACCIDENTS
MISIDENTIFICATION
INTENTIONAL_DECEPTION
```

## HUMAN_ACTION

Скрытая причина — конкретное человеческое действие.

## NATURAL_PROCESS

Причина — физический, биологический, климатический или геологический процесс.

## CREATURE_BEHAVIOR

Причина — поведение известного или неизвестного существа/вида.

## ANCIENT_EVENT

Нынешние следы порождены конкретным событием прошлого.

## HIDDEN_STRUCTURE

Причина связана с устройством скрытого места, объекта или системы.

## ANOMALOUS_PHENOMENON

Причина — редкое магическое или сверхъестественное явление с конкретными правилами.

## SOCIAL_PROCESS

Наблюдаемая mystery возникает из коллективного человеческого поведения,
не обязательно из преступления или одного actor.

## CHAIN_OF_ACCIDENTS

Причина — несколько естественно связанных ошибок или случайностей.

## MISIDENTIFICATION

Ключевой объект/человек/явление ошибочно принимают за нечто другое.

## INTENTIONAL_DECEPTION

Кто-то сознательно создаёт ложную картину происходящего.

---

# 3. `causalShape`

Определяет **абстрактную причинную форму**.

Phase 1 не обязана всегда использовать одинаковые семантические A/B/C.

Она выбирает подходящую цепочку causal functions.

Базовые causal functions:

```text
ORIGIN
TRIGGER
PAST_EVENT
ACTION
INTERACTION
TRANSFORMATION
TRANSFER
ACCUMULATION
SPREAD
ACTIVATION
DECAY
SEPARATION
REDIRECTION
REPLACEMENT
MISIDENTIFICATION
CONCEALMENT
PRESERVATION
EXPOSURE
TRAPPING
MANIFESTATION
```

Примеры:

### Natural mystery

```text
TRIGGER
→ TRANSFORMATION
→ TRANSFER
→ MANIFESTATION
```

### Historical mystery

```text
PAST_EVENT
→ PRESERVATION
→ EXPOSURE
→ MANIFESTATION
```

### Social mystery

```text
ACTION
→ CONCEALMENT
→ TRANSFER
→ MANIFESTATION
```

### Creature mystery

```text
TRIGGER
→ CREATURE_BEHAVIOR
→ DEPOSITION / TRANSFER
→ MANIFESTATION
```

### Misidentification mystery

```text
ORIGIN
→ MISIDENTIFICATION
→ REPEATED_INTERACTION
→ MANIFESTATION
```

---

# 4. `epistemicMask`

Это одна из главных частей Phase 1.

`epistemicMask` отвечает:

> Почему разумные люди, наблюдающие X,
> ещё не понимают истинную причину?

Mystery не должна существовать потому,
что все персонажи игнорируют очевидное.

Возможные значения:

```text
DELAY
DISTANCE
COMMON_MEDIATOR
RARE_CONDITION
LOOKALIKE
MULTIPLE_CAUSES
HIDDEN_STAGE
OLD_ASSUMPTION
SCALE_MISMATCH
INDIRECT_EFFECT
PARTIAL_VISIBILITY
FALSE_CORRELATION
```

## DELAY

Причина и эффект разделены временем.

## DISTANCE

Причина и X возникают в разных местах.

## COMMON_MEDIATOR

Обычный ресурс, процедура или среда скрывают реальный источник.

## RARE_CONDITION

Механизм проявляется только при редком условии.

## LOOKALIKE

Истинная причина похожа на более обычную.

## MULTIPLE_CAUSES

Несколько эффектов выглядят независимыми или имеют разные очевидные объяснения.

## HIDDEN_STAGE

Критический промежуточный этап физически или социально невидим.

## OLD_ASSUMPTION

Существующее знание разумно и обычно верно,
но в этом конкретном случае вводит в заблуждение.

## SCALE_MISMATCH

Маленькая причина создаёт большой эффект или наоборот,
что затрудняет правильную атрибуцию.

## INDIRECT_EFFECT

X является вторичным последствием,
а первичная причина проявляется в другом месте или форме.

## PARTIAL_VISIBILITY

Наблюдатели видят только часть causal chain.

## FALSE_CORRELATION

X естественно совпадает с другим событием,
которое выглядит более вероятной причиной.

---

# 5. `revealPayoff`

Определяет:

> Почему ответ вообще стоит расследования?

Возможные значения:

```text
EXPLAINS_ANOMALY
REVEALS_NEW_WORLD_FACT
EXPOSES_HUMAN_SECRET
REINTERPRETS_HISTORY
DISCOVERS_HIDDEN_PLACE
REVEALS_NEW_CREATURE_BEHAVIOR
CHANGES_KNOWN_NATURAL_RULE
CONNECTS_SEPARATE_EVENTS
REVEALS_SYSTEMIC_RISK
REVEALS_NEW_OPPORTUNITY
```

Reveal payoff нужен,
чтобы mystery не сводилась к:

```text
"почему запись неправильная?"
"писец ошибся"
```

Формально это mystery,
но драматургическая ценность почти нулевая.

---

# 6. `observedPattern`

Phase 1 фиксирует не concrete X,
а **тип наблюдаемого рисунка**.

Например:

```yaml
observedPattern:
  - Один и тот же необычный след появляется повторно.
  - След возникает в местах, которые на первый взгляд не связаны.
  - У эффекта есть временной или пространственный паттерн.
```

Или:

```yaml
observedPattern:
  - Несколько независимых свидетельств противоречат принятой версии прошлого.
  - Каждое свидетельство само по себе можно объяснить обычно.
  - Вместе они требуют другого объяснения.
```

Phase 2 уже решает,
что именно является:

- следом;
- симптомом;
- объектом;
- местом;
- группой;
- событием.

---

# 7. `answerPattern`

Phase 1 должна сформулировать **форму скрытого ответа**,
не конкретную city implementation.

Пример:

```yaml
answerPattern: >
  Наблюдаемый материал не производится в месте появления.
  Его регулярно переносит живое существо из удалённой зоны
  после конкретного изменения среды.
```

Это уже достаточно содержательно,
чтобы существовала mystery.

Но ещё не выбраны:

- материал;
- существо;
- удалённая зона;
- конкретное изменение среды;
- место проявления.

---

# 8. `mysteryProposition`

Полезно свести центральную mystery в один объект:

```yaml
mysteryProposition:
  observed:
    >
      Что разумно наблюдает город.

  unknown:
    kind: PROVENANCE

  apparentExplanation:
    >
      Какое объяснение кажется естественным на старте.

  hiddenAnswer:
    >
      Какой формы на самом деле ответ.

  whyNotObvious:
    >
      Как epistemicMask объективно скрывает истину.

  payoff:
    >
      Почему раскрытие меняет понимание ситуации.
```

Это должно существовать **до causal chain**.

Если mystery proposition сама по себе неинтересна,
не надо спасать её сложным causal graph.

---

# 9. Пример природной mystery

```yaml
mysteryQuestion: PROVENANCE
answerShape: CREATURE_BEHAVIOR

epistemicMask:
  primary: DISTANCE
  secondary: COMMON_MEDIATOR

revealPayoff: REVEALS_NEW_CREATURE_BEHAVIOR

mysteryProposition:
  observed: >
    В освоенной зоне регулярно появляется необычный материал.

  apparentExplanation: >
    Материал кажется продуктом местного природного процесса.

  hiddenAnswer: >
    Материал приносится существами из удалённой части острова
    после изменения их обычного поведения.

  whyNotObvious: >
    Перенос происходит вдали от наблюдателей,
    а материал появляется уже после того,
    как существа покинули место.

  payoff: >
    Раскрытие показывает неизвестную ранее связь
    между поведением местного вида и удалённой частью острова.

causalShape:
  - TRIGGER
  - CREATURE_BEHAVIOR
  - TRANSFER
  - MANIFESTATION
```

---

# 10. Пример historical mystery

```yaml
mysteryQuestion: HISTORY
answerShape: ANCIENT_EVENT

epistemicMask:
  primary: PARTIAL_VISIBILITY
  secondary: OLD_ASSUMPTION

revealPayoff: REINTERPRETS_HISTORY

mysteryProposition:
  observed: >
    Несколько физических следов старого места
    противоречат принятому объяснению его происхождения.

  apparentExplanation: >
    Следы считаются результатом обычного износа
    или поздней переделки.

  hiddenAnswer: >
    Они являются остатками конкретного события,
    произошедшего до нынешнего использования места.

  whyNotObvious: >
    Большая часть следов уничтожена или скрыта,
    а существующая версия истории хорошо объясняет каждый след по отдельности.

  payoff: >
    Истина меняет понимание важного события прошлого.

causalShape:
  - PAST_EVENT
  - PRESERVATION
  - EXPOSURE
  - MANIFESTATION
```

---

# 11. Пример anomalous mystery

```yaml
mysteryQuestion: MECHANISM
answerShape: ANOMALOUS_PHENOMENON

epistemicMask:
  primary: RARE_CONDITION
  secondary: FALSE_CORRELATION

revealPayoff: CHANGES_KNOWN_NATURAL_RULE

mysteryProposition:
  observed: >
    При редком сочетании условий обычный объект
    проявляет невозможное в нормальных обстоятельствах свойство.

  apparentExplanation: >
    Эффект связывают с более заметным сопутствующим событием.

  hiddenAnswer: >
    У объекта есть стабильное аномальное свойство,
    активируемое другим, менее заметным условием.

  whyNotObvious: >
    Истинное условие почти всегда совпадает
    с более очевидным событием.

  payoff: >
    Раскрытие устанавливает новый устойчивый факт
    о физике или сверхъестественном устройстве мира.
```

---

# 12. Phase 1 не должна придумывать concrete city implementation

Запрещено без необходимости фиксировать:

```text
конкретную профессию
конкретный институт
конкретную гильдию
конкретный храм
конкретную инфраструктуру
конкретный городской ресурс
конкретный район
конкретную массовую практику
конкретную технологию
```

Но Phase 1 может фиксировать:

```text
shared resource
remote area
existing practice
recognized authority
old place
living species
physical trace
affected group
common material
```

---

# 13. `bindingRequirements`

Phase 1 должна явно сообщать,
что потребуется от города для конкретизации.

Пример:

```yaml
bindingRequirements:
  required:
    - >
      В городе или его окружении должен существовать
      естественный носитель наблюдаемого материала.

    - >
      Должна существовать удалённая зона,
      между которой и освоенной областью возможен перенос.

    - >
      Должно существовать существо или вид,
      поведение которого можно естественно связать с переносом.

  forbidden:
    - >
      Не создавать новую крупную отрасль,
      институт или массовый обычай только ради mystery.
```

---

# 14. `BINDING_FAILED`

City Binder должен иметь право отказаться.

```yaml
status: BINDING_FAILED
reason: >
  Для реализации answerPattern пришлось бы
  добавить в city canon крупную новую систему,
  которой раньше не существовало.
```

Binding failure лучше,
чем насильственное натягивание skeleton на город.

---

# 15. Phase 1 Judge

Phase 1 judge проверяет не concrete physics,
а качество epistemic design.

Основные проверки:

```text
MYSTERY_QUESTION_VALID
ANSWER_SHAPE_VALID
EPISTEMIC_MASK_VALID
NO_IDIOT_MYSTERY
CAUSAL_SHAPE_COHERENT
REVEAL_PAYOFF_MEANINGFUL
PORTABILITY
TAG_FIT
NO_CITY_OVERBINDING
```

---

# 16. `NO_IDIOT_MYSTERY`

Главный вопрос:

> Есть ли объективная причина,
> почему разумные наблюдатели ещё не знают ответа?

Fail, если mystery требует,
чтобы персонажи игнорировали очевидный causal experiment.

Пример плохой mystery:

```text
люди задыхаются только в закрытом помещении
↓
после проветривания сразу становится лучше
↓
все продолжают считать причиной небесное проклятие
```

Если нет дополнительного сильного mask,
это не mystery.

---

# 17. `EPISTEMIC_MASK_VALID`

Mask должен:

- реально скрывать нужный answer;
- быть независим от глупости персонажей;
- не противоречить observedPattern;
- не требовать искусственного сокрытия очевидных фактов.

---

# 18. `REVEAL_PAYOFF_MEANINGFUL`

Judge спрашивает:

> Если игрок узнает hiddenAnswer,
> изменится ли его понимание мира, события, людей или риска?

Если ответ:

```text
"да, теперь известно, что это была обычная мелкая ошибка"
```

при высоком gravity или deep mystery,
payoff слабый.

---

# 19. Phase 2 City Binder

City Binder получает:

```text
Abstract Mystery Design
+
full city canon
+
existing characters
+
recent plots
+
overused motifs
```

И выбирает:

- concrete X;
- concrete source;
- concrete places;
- concrete people if needed;
- concrete physical/social/anomalous mechanism;
- concrete clues;
- concrete chronology.

После этого он строит настоящий:

```text
A → B → C → X
```

---

# 20. Concrete Truth Graph

На Phase 2 появляются:

```yaml
truthGraph:
  nodes:
    A:
      event:
    B:
      event:
    C:
      event:
    X:
      observedEffect:

  edges:
    - from: A
      to: B
      mechanism:
      counterfactual:

    - from: B
      to: C
      mechanism:
      counterfactual:

    - from: C
      to: X
      mechanism:
      counterfactual:
```

Именно этот graph становится world canon.

---

# 21. Phase 2 Strict Judge

Теперь уже применяются строгие concrete checks:

```text
BROKEN_CAUSAL_EDGE
IMPLAUSIBLE_HUMAN_ACTION
BROKEN_GOAL_LINK
UNSUPPORTED_PHYSICAL_EFFECT
UNSUPPORTED_ANOMALOUS_RULE
UNEXPLAINED_ENTITY
UNEXPLAINED_ACCESS
UNEXPLAINED_KNOWLEDGE
TEMPORAL_CONTRADICTION
UNSUPPORTED_X
MASK_COLLAPSED
CITY_CANON_CONTRADICTION
FORCED_CITY_BINDING
WRONG_MYSTERY_TYPE
```

---

# 22. `MASK_COLLAPSED`

После concrete binding нужно повторно проверить epistemicMask.

Phase 1 могла сказать:

```text
DISTANCE
```

Но Phase 2 могла выбрать такую реализацию,
где источник прекрасно виден из места X.

Тогда mask разрушен.

Judge должен проверить:

> Сохранилась ли реальная причина,
> почему truth не очевидна в concrete story?

---

# 23. Truth claims и resolution

После создания concrete truthGraph:

```yaml
truthClaims:
  - id: ...
    node: A
    value: ...

  - id: ...
    node: B
    value: ...

  - id: ...
    node: C
    value: ...
```

Resolution задаётся ссылками:

```yaml
resolutionRequires:
  - claim_id_1
  - claim_id_2
  - claim_id_3
```

Не дублировать truth отдельным текстовым каноном.

---

# 24. Предлагаемая schema Phase 1

```yaml
abstractMystery:
  mysteryType:

  seed:
    gravity:
    scale:
    source:
    entry:
    situation:
    dynamic:
    canonRelation:
    tonePrimary:
    toneSecondary:
    association:

  mysteryQuestion:
    kind:

  answerShape:

  mysteryProposition:
    observed:
    apparentExplanation:
    hiddenAnswer:
    whyNotObvious:
    payoff:

  epistemicMask:
    primary:
    secondary:

  causalShape:
    - function:
    - function:
    - function:
    - function:

  observedPattern:
    - ...
    - ...

  revealPayoff:

  bindingRequirements:
    required:
      - ...
    forbidden:
      - ...

  legacyPotential:
    axes:
      - ...
```

---

# 25. Prompt principle for Phase 1

Главная инструкция генератору:

```text
Do not start by inventing a crime, actor or city event.

Start by designing an epistemic problem:

1. What does the player observe?
2. What kind of question does this observation create?
3. What kind of hidden answer exists?
4. Why is that answer not obvious to reasonable observers?
5. What causal shape connects the hidden truth to the observation?
6. Why is the reveal worth discovering?

Only after these are coherent,
produce the abstract mystery design.
```

---

# 26. Главное отличие от предыдущих вариантов

Не:

```text
actor → motive → action → harm
```

И не:

```text
полностью concrete A → B → C → X
```

А:

```text
UNKNOWN
+
ANSWER SHAPE
+
EPISTEMIC MASK
+
CAUSAL SHAPE
+
REVEAL PAYOFF
```

И только затем:

```text
CITY BINDING
→ concrete truthGraph
```

---

# 27. Главный принцип

> Хорошая mystery определяется не только тем,
> что у X есть скрытая причина.

Она определяется ещё и тем,
что:

1. вопрос действительно интересен;
2. ответ существует заранее;
3. ответ не очевиден по объективной причине;
4. causal chain объясняет наблюдения;
5. раскрытие меняет понимание ситуации или мира.

Именно это должна гарантировать Phase 1.
