import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { plotConfig, formatSuspenseAnnotationAxesForPrompt } from '../src/game/plotlines.js';
import {
  normalizeSuspenseAnnotation,
  SUSPENSE_ANNOTATION_JUDGE_CODES,
  SUSPENSE_BRIEF_SECTION_SENTENCE_MAX,
  formatSuspenseAnnotationJudgeCase,
  formatSuspenseAnnotationRevisionForPrompt,
} from '../src/game/suspenseAnnotation.js';
import { BRIEF_SECTION_SENTENCE_MAX as MYSTERY_SENTENCE_MAX } from '../src/game/mysteryAnnotation.js';

const LONG =
  'На склоне уже две недели кладут яйца насекомые, которых раньше здесь не было. Пастухи обходят полосу и гонят стада ниже, хотя трава там хуже. Совет пока спорит, жечь ли край.';
const SIX = `${LONG} Четвёртое предложение фиксирует срок. Пятое называет цену бездействия. Шестое указывает, кто уже несёт потери.`;
const SEVEN = `${SIX} Седьмое лишнее.`;

function validBrief(extra = {}) {
  return {
    workingTitle: 'Чёрная кладка',
    situation: LONG,
    threat: `${LONG} Если не выжечь край до сезона дождей, личинки займут основной склон.`,
    whyNotSolvedNow: `${LONG} Жечь нельзя без потери раннего выпаса, а ночной сбор руками не покрывает площадь.`,
    escalation: `${LONG} Каждую неделю кладок больше, и полоса сползает к основному склону.`,
    pointOfNoReturn: `${LONG} Когда личинки уйдут под дёрн основного склона, выжигать придётся уже кормовую базу.`,
    ifPrevented: `${LONG} Город жертвует ранним выпасом, удерживает популяцию на краю и сохраняет основное стадо.`,
    ifNotPrevented: `${LONG} Через сезон значительная часть прежнего выпаса непригодна, стада сокращают.`,
    ...extra,
  };
}

test('нормализация suspense brief требует все секции', () => {
  const thin = normalizeSuspenseAnnotation({ workingTitle: 'Кладка', situation: 'мало' });
  assert.equal(thin.annotation, null);
  const ok = normalizeSuspenseAnnotation(validBrief());
  assert.equal(ok.reason, null);
  assert.ok(ok.annotation.text.includes('Угроза:'));
  assert.match(ok.annotation.ifPrevented, /стадо/);
});

test('саспенс держит потолок 6 предложений, mystery остаётся на 4', () => {
  assert.equal(SUSPENSE_BRIEF_SECTION_SENTENCE_MAX, 6);
  assert.equal(MYSTERY_SENTENCE_MAX, 4);
  assert.equal(normalizeSuspenseAnnotation(validBrief({ threat: SIX })).reason, null);
  assert.equal(
    normalizeSuspenseAnnotation(validBrief({ threat: SEVEN })).reason,
    'long_sentences:threat',
  );
});

test('конфиг и коды судьи болванки саспенса', () => {
  const cfg = plotConfig(loadConfig());
  assert.equal(cfg.suspenseAnnotation.judgeAttempts, 2);
  assert.ok(SUSPENSE_ANNOTATION_JUDGE_CODES.includes('SUSPENSE_NOT_MYSTERY'));
  assert.ok(SUSPENSE_ANNOTATION_JUDGE_CODES.includes('ARENA_FIDELITY'));
  assert.ok(SUSPENSE_ANNOTATION_JUDGE_CODES.includes('WORLD_FIDELITY'));
  const agents = loadConfig().agents;
  assert.equal(agents.suspenseAnnotation.provider, 'anthropic');
  assert.equal(agents.suspenseAnnotation.model, 'claude-sonnet-4-6');
  assert.equal(agents.suspenseAnnotationJudge.model, 'gpt-5.6-luna');
  assert.match(agents.suspenseAnnotation.instructions, /threatArena/);
  const caseText = formatSuspenseAnnotationJudgeCase({
    seed: { gravity: 58, tags: [{ groupId: 'truthArena', tagName: 'ECOLOGY', tagId: 'ecology' }] },
    annotation: { workingTitle: 'Кладка', text: 'brief' },
  });
  assert.match(caseText, /АРЕНА УГРОЗЫ/);
});

test('YAML саспенса: gravity 80+, civic-memory, космология, HUMAN', () => {
  const gen = loadConfig().agents.suspenseAnnotation.instructions;
  assert.match(gen, /gravity 80\+/);
  assert.match(gen, /праздник, молитвы, монумент/);
  assert.match(gen, /нашествие крылатых/);
  assert.match(gen, /воздушных кораблей/);
  assert.match(gen, /сопряжен/);
  assert.match(gen, /A → B → C/);
  assert.match(gen, /убери человеческие решения/);
  assert.match(gen, /мох, войлок или ил/);
  assert.match(gen, /белого щелочного порошка|белый щелочной порошок/);
  assert.match(gen, /навигационные огни/);
  assert.match(gen, /не универсальный субстрат countdown/);
  assert.match(gen, /NO PLOT-SHAPED MECHANISMS/);
  assert.match(gen, /MECHANISM BUDGET/);
  assert.match(gen, /2–6 предложений/);
  assert.match(gen, /workingTitle называет то же проявление/);
  assert.match(gen, /Люди будут недовольны/);
  assert.match(gen, /Не обязана означать, что спасать город уже бессмысленно/);
  assert.equal(gen.includes('<2–4 предложения'), false);
  assert.equal(gen.includes('Одна грандиозная ветка'), false);
  const judge = loadConfig().agents.suspenseAnnotationJudge.instructions;
  assert.match(judge, /WORLD_FIDELITY/);
  assert.match(judge, /gravity 80\+/);
  assert.match(judge, /нормирование на год/);
  assert.match(judge, /праздник, молитвы, монумент/);
  assert.match(judge, /карьер не наклоняет/);
  assert.match(judge, /не достраивай удобное звено/);
  assert.match(judge, /Люди будут недовольны/);
  assert.match(judge, /остров входит в ураган/);
});

test('промпт осей саспенса: 80+ меню, civic-memory, ECOLOGY не мох', () => {
  const ecology = formatSuspenseAnnotationAxesForPrompt({
    gravity: 88,
    tags: [
      { groupId: 'truthArena', tagId: 'ecology', tagName: 'ECOLOGY' },
      { groupId: 'worldRelation', tagId: 'native', tagName: 'NATIVE' },
    ],
  });
  assert.match(ecology, /GRAVITY 80\+/);
  assert.match(ecology, /civic-memory/);
  assert.match(ecology, /нашествие крылатых/);
  assert.match(ecology, /мха\/войлока в канавах/);
  assert.match(ecology, /порчу посева/);
  assert.match(ecology, /80\+ ECOLOGY/);
  assert.match(ecology, /воздушных судов/);
  assert.match(ecology, /остров изолирован/);
  assert.match(ecology, /не универсальный субстрат countdown/);
  assert.equal(ecology.includes('белого щелочного порошка'), false);
  assert.equal(ecology.includes('одной грандиозной ветки'), false);
  const human = formatSuspenseAnnotationAxesForPrompt({
    gravity: 91,
    tags: [
      { groupId: 'threatArena', tagId: 'human', tagName: 'HUMAN' },
      { groupId: 'worldRelation', tagId: 'native', tagName: 'NATIVE' },
    ],
  });
  assert.match(human, /убери человеческие решения/);
  assert.match(human, /80\+ HUMAN/);
  assert.match(human, /культ, подтачивающий веру/);
  const contact = formatSuspenseAnnotationAxesForPrompt({
    gravity: 40,
    tags: [
      { groupId: 'threatArena', tagId: 'material', tagName: 'MATERIAL' },
      { groupId: 'worldRelation', tagId: 'contact', tagName: 'CONTACT' },
    ],
  });
  assert.match(contact, /белого минерального порошка/);
  assert.match(contact, /редкое сопряжение/);
  assert.equal(contact.includes('GRAVITY 80+'), false);
  const high = formatSuspenseAnnotationJudgeCase({
    seed: { gravity: 91, tags: [{ groupId: 'truthArena', tagId: 'earth', tagName: 'EARTH' }] },
    annotation: { workingTitle: 'Склон', text: 'brief' },
  });
  assert.match(high, /если не предотвратить/);
  assert.match(high, /GRAVITY 80\+/);
  assert.match(high, /карьер меняет массу/);
  assert.match(high, /сила из недр/);
});

test('repair саспенса: 80+ не урезает конец, низкий gravity может', () => {
  const high = formatSuspenseAnnotationRevisionForPrompt({
    gravity: 88,
    judge: { summary: 'слабо', issues: [{ code: 'GRAVITY_FIDELITY', reason: 'мелочь' }] },
    annotation: { workingTitle: 'Кладка', text: 'brief' },
  });
  assert.match(high, /Нельзя чинить PLAUSIBLE_ENOUGH переносом/);
  assert.match(high, /не урезай конец до нормирования/);
  assert.match(high, /GRAVITY_FIDELITY/);
  const low = formatSuspenseAnnotationRevisionForPrompt({ gravity: 12 });
  assert.match(low, /можно урезать последствия до полосы/);
});
