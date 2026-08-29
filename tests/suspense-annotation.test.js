import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { plotConfig } from '../src/game/plotlines.js';
import {
  normalizeSuspenseAnnotation,
  SUSPENSE_ANNOTATION_JUDGE_CODES,
  formatSuspenseAnnotationJudgeCase,
} from '../src/game/suspenseAnnotation.js';

const LONG =
  'На склоне уже две недели кладут яйца насекомые, которых раньше здесь не было. Пастухи обходят полосу и гонят стада ниже, хотя трава там хуже. Совет пока спорит, жечь ли край.';

test('нормализация suspense brief требует все секции', () => {
  const thin = normalizeSuspenseAnnotation({ workingTitle: 'Кладка', situation: 'мало' });
  assert.equal(thin.annotation, null);
  const ok = normalizeSuspenseAnnotation({
    workingTitle: 'Чёрная кладка',
    situation: LONG,
    threat: `${LONG} Если не выжечь край до сезона дождей, личинки займут основной склон.`,
    whyNotSolvedNow: `${LONG} Жечь нельзя без потери раннего выпаса, а ночной сбор руками не покрывает площадь.`,
    escalation: `${LONG} Каждую неделю кладок больше, и полоса сползает к основному склону.`,
    pointOfNoReturn: `${LONG} Когда личинки уйдут под дёрн основного склона, выжигать придётся уже кормовую базу.`,
    ifPrevented: `${LONG} Город жертвует ранним выпасом, удерживает популяцию на краю и сохраняет основное стадо.`,
    ifNotPrevented: `${LONG} Через сезон значительная часть прежнего выпаса непригодна, стада сокращают.`,
  });
  assert.equal(ok.reason, null);
  assert.ok(ok.annotation.text.includes('Угроза:'));
  assert.match(ok.annotation.ifPrevented, /стадо/);
});

test('конфиг и коды судьи болванки саспенса', () => {
  const cfg = plotConfig(loadConfig());
  assert.equal(cfg.suspenseAnnotation.judgeAttempts, 2);
  assert.ok(SUSPENSE_ANNOTATION_JUDGE_CODES.includes('SUSPENSE_NOT_MYSTERY'));
  assert.ok(SUSPENSE_ANNOTATION_JUDGE_CODES.includes('ARENA_FIDELITY'));
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
