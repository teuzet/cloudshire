import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepStories, keepSharedStories, formatKeepPlotBlock } from '../src/game/storyteller.js';

function mockRuntime({ agentId: expected, synopsis }) {
  let seen = null;
  return {
    seen: () => seen,
    async run({ tools, agentId }) {
      seen = { agentId, toolNames: tools.map((t) => t.name) };
      assert.equal(agentId, expected);
      const submit = tools.find((t) => t.name === 'submit_story_keep');
      assert.ok(submit);
      await submit.handler({ plots: synopsis });
      return { toolTrace: [] };
    },
  };
}

test('storyKeep сжимает синопсис и больше не имеет story_surfaced', async () => {
  const domain = {
    id: 'd1',
    name: 'Астра',
    plotlines: [
      {
        id: 'p1',
        title: 'Гул',
        kind: 'story',
        synopsis: 'В цистерне гудит вода.',
        closeWhen: 'Найдут источник.',
      },
    ],
  };
  const runtime = mockRuntime({
    agentId: 'storyKeep',
    synopsis: [
      {
        plotId: 'p1',
        synopsis: 'В цистерне гудело. Нашли ил в трубах, ночью вода стихла.',
      },
    ],
  });
  const result = await keepStories({
    runtime,
    domain,
    world: { gameDate: { label: 'Год 1, месяц 2' } },
    chronicleAdds: [{ text: 'Нашли ил в трубах.', relatedPlotlineIds: ['p1'] }],
  });
  assert.equal(result.updated, 1);
  assert.equal(runtime.seen().toolNames.includes('story_surfaced'), false);
  assert.match(domain.plotlines[0].synopsis, /ил/);
});

// ─────────────────────────── карточка для reducer'а ───────────────────────────

function stakedPlot(extra = {}) {
  return {
    id: 'p1',
    kind: 'story',
    storyType: 'story',
    title: 'Гулкая лестница',
    synopsis: 'ступени гудят после шагов',
    gravity: 'CRISIS',
    depth: 0,
    maxDepth: 2,
    failCount: 0,
    maxFails: 2,
    endings: [
      { id: 'e1', kind: 'GOOD_ENDING', text: 'Причину гула нашли и устранили, проход снова открыт' },
      { id: 'e2', kind: 'NEUTRAL_ENDING', text: 'Лестницу закрыли и обходят другой дорогой' },
      { id: 'e3', kind: 'BAD_ENDING', text: 'Ступени обрушились под людьми' },
    ],
    ...extra,
  };
}

test('концовки нити со ставками — варианты будущего, а не случившийся исход', () => {
  const text = formatKeepPlotBlock(stakedPlot(), ['ступени вскрыли, нашли водоотводный ход']);
  assert.match(text, /ВОЗМОЖНЫЕ ИСХОДЫ/);
  assert.match(text, /ни один ещё не наступил/);
  assert.doesNotMatch(
    text,
    /Успешный исход/,
    'склеенный список концовок под этим заголовком reducer читал как развязку',
  );
  assert.match(text, /Причину гула нашли/);
  assert.match(text, /Ступени обрушились/);
  assert.match(text, /ОТКРЫТА и не разрешена: пройдено 0 из 2, промахов 0 из 2/);
  assert.match(text, /ступени вскрыли/);
});

test('закрытая нить прямо названа закрытой', () => {
  const text = formatKeepPlotBlock(stakedPlot({ status: 'closed', depth: 2 }), ['лестницу починили']);
  assert.match(text, /ЗАКРЫТА/);
  assert.doesNotMatch(text, /ОТКРЫТА/);
});

test('нить без своих записей это и говорит', () => {
  assert.match(formatKeepPlotBlock(stakedPlot(), []), /Свежих записей у неё нет/);
});

test('у обычной нити один успешный исход остаётся успешным исходом', () => {
  const text = formatKeepPlotBlock(
    { id: 'p2', kind: 'story', title: 'Гул', synopsis: 'гудит', closeWhen: 'Найдут источник.', mootWhen: 'Гул стих.' },
    [],
  );
  assert.match(text, /Успешный исход: Найдут источник\./);
  assert.match(text, /Теряет смысл, когда: Гул стих\./);
  assert.doesNotMatch(text, /ВОЗМОЖНЫЕ ИСХОДЫ/);
});

test('confluxStoryKeep обновляет общий синопсис shared-нити', async () => {
  const plot = {
    id: 'p_shared',
    title: 'Проход',
    kind: 'story',
    shared: true,
    isMainConflux: true,
    synopsis: 'Острова сближаются.',
    closeWhen: 'Острова разошлись.',
  };
  const conflux = { id: 'c1', domainIds: ['a', 'b'], plotlines: [plot] };
  const runtime = mockRuntime({
    agentId: 'confluxStoryKeep',
    synopsis: [
      {
        plotId: 'p_shared',
        synopsis: 'Острова сошлись. Стража Ксарета и Берила стоят у щели.',
      },
    ],
  });
  const result = await keepSharedStories({
    runtime,
    conflux,
    domains: [
      { id: 'a', name: 'Ксарет' },
      { id: 'b', name: 'Берил' },
    ],
    world: { gameDate: { label: 'Год 1, месяц 8' }, tickIndex: 8 },
    chronicleAdds: [{ text: 'Стража обоих городов встала у щели.', relatedPlotlineIds: ['p_shared'] }],
  });
  assert.equal(result.updated, 1);
  assert.match(conflux.plotlines[0].synopsis, /щели/);
});
