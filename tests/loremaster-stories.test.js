import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatStoriesForLoremaster, storiesForLoremaster } from '../src/game/loremaster.js';

test('лормастер видит идущие истории и канон тайны как защищённый', () => {
  const plots = formatStoriesForLoremaster([
    {
      title: 'Гул в цистерне',
      kind: 'story',
      storyType: 'mystery',
      synopsis: 'Ночами в нижней цистерне гудит вода.',
      closeWhen: 'Найдут источник гула.',
      truthGraph: {
        nodes: [
          { id: 'A', text: 'Цистерну перестали чистить.', knowledge: 'hidden' },
          { id: 'X', text: 'Ночами вода гудит.', knowledge: 'observed' },
        ],
        edges: [{ from: 'A', to: 'X', reason: 'ил сжимает поток', knowledge: 'hidden' }],
      },
    },
  ]);
  assert.match(plots, /ТАЙНА/);
  assert.match(plots, /ЗАЩИЩЕНА/);
  assert.equal(plots.includes('«Гул в цистерне»'), false);
  assert.match(plots, /Цистерну перестали чистить/);
  assert.match(plots, /скрыто/i);
});

test('лормастер не берёт указы и подхватывает shared-нить с конфлюкса', () => {
  const domain = {
    id: 'a',
    plotlines: [
      { id: 'ord', title: 'Налог', kind: 'order', synopsis: 'Собирают налог.' },
      { id: 'loc', title: 'Гул', kind: 'story', synopsis: 'Гудит вода.' },
    ],
  };
  const conflux = {
    plotlines: [
      {
        id: 'main',
        title: 'Сопряжение',
        kind: 'story',
        isMainConflux: true,
        synopsis: 'Острова сближаются.',
      },
    ],
  };
  const list = storiesForLoremaster(domain, conflux);
  assert.equal(list.some((p) => p.id === 'ord'), false);
  assert.equal(list.some((p) => p.id === 'loc'), true);
  assert.equal(list.some((p) => p.id === 'main'), true);
});
