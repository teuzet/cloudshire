import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  packPlaySeedGrain,
  parsePlaySeedGrain,
  parsePlayDeedFinish,
  canDropPlayStory,
  dropPlayStory,
} from '../src/game/playDev.js';

function story(id, extra = {}) {
  return {
    id,
    kind: 'story',
    title: `Нить ${id}`,
    synopsis: 'Случилось.',
    chronicleIds: extra.chronicleIds || [],
    relatedProcessIds: extra.relatedProcessIds || [],
    ...extra,
  };
}

test('зерно посева: описание, хроника без живых нитей, пустота', () => {
  assert.equal(parsePlaySeedGrain('city'), 'genesis');
  const domain = {
    cityBrief: 'Город на двух холмах, галерея над лощиной.',
    plotlines: [story('plot_live')],
    lore: [
      {
        id: 'lore_live',
        text: 'Живая нить гудит.',
        tags: ['chronicle'],
        tick: 11,
        relatedPlotlineIds: ['plot_live'],
        sourcePlotId: 'plot_live',
      },
      {
        id: 'lore_old',
        text: 'Весной лощина затопила рынок.',
        tags: ['chronicle'],
        tick: 10,
        gameDateLabel: 'Год 1, месяц 10',
      },
    ],
  };
  const world = { tickIndex: 11 };

  const fromCity = packPlaySeedGrain(domain, world, { grain: 'genesis', gravity: 'SITUATION' });
  assert.equal(fromCity.ok, true);
  assert.equal(fromCity.fromGenesis, true);
  assert.equal(fromCity.fromVoid, false);
  assert.match(fromCity.seedText, /галерея/);
  assert.equal(fromCity.gravity, 'SITUATION');

  const fromChronicle = packPlaySeedGrain(domain, world, { grain: 'chronicle', gravity: 'EPISODE' });
  assert.equal(fromChronicle.ok, true);
  assert.equal(fromChronicle.fromGenesis, false);
  assert.match(fromChronicle.seedText, /лощина затопила/);
  assert.doesNotMatch(fromChronicle.seedText, /Живая нить/);

  const fromVoid = packPlaySeedGrain(domain, world, { grain: 'void', gravity: 'CRISIS' });
  assert.equal(fromVoid.ok, true);
  assert.equal(fromVoid.fromVoid, true);
  assert.equal(fromVoid.seedText, '');
  assert.equal(fromVoid.gravity, 'CRISIS');
});

test('пустое описание и пустая хроника — явная ошибка, не молчаливая пустота', () => {
  const noBrief = packPlaySeedGrain({ lore: [] }, {}, { grain: 'genesis' });
  assert.equal(noBrief.ok, false);
  assert.equal(noBrief.error, 'no_brief');
  const noYear = packPlaySeedGrain({ lore: [], plotlines: [] }, { tickIndex: 3 }, { grain: 'chronicle' });
  assert.equal(noYear.ok, false);
  assert.equal(noYear.error, 'no_chronicle');
});

test('полная доска не сеется поверх', () => {
  const domain = {
    cityBrief: 'Город.',
    plotlines: [1, 2, 3, 4].map((n) => story(`plot_${n}`)),
  };
  const packed = packPlaySeedGrain(domain, {}, { grain: 'void' });
  assert.equal(packed.ok, false);
  assert.equal(packed.error, 'board_full');
});

test('историю без дел снимают вместе с хроникой и очередью угроз', () => {
  const domain = {
    plotlines: [
      story('plot_keep', { chronicleIds: ['lore_keep'] }),
      story('plot_drop', { chronicleIds: ['lore_drop'] }),
    ],
    lore: [
      {
        id: 'lore_drop',
        text: 'Полость в стене.',
        tags: ['chronicle'],
        sourcePlotId: 'plot_drop',
        relatedPlotlineIds: ['plot_drop'],
      },
      {
        id: 'lore_keep',
        text: 'Другое дело.',
        tags: ['chronicle'],
        sourcePlotId: 'plot_keep',
        relatedPlotlineIds: ['plot_keep'],
      },
      {
        id: 'lore_mix',
        text: 'Обе нити мелькнули.',
        tags: ['chronicle'],
        relatedPlotlineIds: ['plot_drop', 'plot_keep'],
      },
    ],
    modifiers: [{ id: 'm1', text: 'след', plotId: 'plot_drop' }],
  };
  const world = {
    jobs: [
      { id: 'j1', state: 'pending', kind: 'threat_fire', payload: { plotId: 'plot_drop' } },
      { id: 'j2', state: 'pending', kind: 'threat_fire', payload: { plotId: 'plot_keep' } },
    ],
  };

  assert.equal(canDropPlayStory(domain, domain.plotlines[1]), true);
  const dropped = dropPlayStory(domain, world, 'plot_drop', { day: 345 });
  assert.equal(dropped.ok, true);
  assert.equal(dropped.droppedLore, 1, 'своя запись уходит, чужие нити в хронике остаются');
  assert.deepEqual(domain.plotlines.map((p) => p.id), ['plot_keep']);
  assert.deepEqual(domain.lore.map((f) => f.id), ['lore_keep', 'lore_mix']);
  assert.deepEqual(domain.lore[1].relatedPlotlineIds, ['plot_keep']);
  assert.equal(domain.modifiers.length, 0);
  assert.equal(world.jobs[0].cancelled, true);
  assert.equal(world.jobs[1].cancelled, undefined);
});

test('историю с живым делом и нить сопряжения не снимают', () => {
  const domain = {
    plotlines: [
      story('plot_busy', { relatedProcessIds: ['act_1'] }),
      story('plot_cf', { shared: true }),
    ],
    state: { pendingActions: [{ id: 'act_1', status: 'active', summary: 'Чинят стык' }] },
  };
  assert.equal(canDropPlayStory(domain, domain.plotlines[0]), false);
  assert.equal(dropPlayStory(domain, {}, 'plot_busy').error, 'has_deeds');
  assert.equal(dropPlayStory(domain, {}, 'plot_cf').error, 'conflux');
  assert.equal(domain.plotlines.length, 2);
});

test('исход для кнопок клиента — только fail, ok, crit', () => {
  assert.equal(parsePlayDeedFinish('fail'), 'fail');
  assert.equal(parsePlayDeedFinish('OK'), 'ok');
  assert.equal(parsePlayDeedFinish('crit'), 'crit');
  assert.equal(parsePlayDeedFinish('success'), null);
  assert.equal(parsePlayDeedFinish(''), null);
});
