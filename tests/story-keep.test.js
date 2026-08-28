import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepStories, keepSharedStories } from '../src/game/storyteller.js';

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
      { id: 'p2', title: 'Налог', kind: 'order', synopsis: 'Собирают налог каждый сбор.' },
    ],
  };
  const runtime = mockRuntime({
    agentId: 'storyKeep',
    synopsis: [
      {
        plotId: 'p1',
        synopsis: 'В цистерне гудело. Нашли ил в трубах, ночью вода стихла.',
      },
      { plotId: 'p2', synopsis: 'Нельзя трогать указ.' },
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
  assert.equal(domain.plotlines[1].synopsis, 'Собирают налог каждый сбор.');
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
