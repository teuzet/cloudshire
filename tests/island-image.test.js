import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIslandImagePrompt } from '../src/game/islandImage.js';
import { formatIslandReveal } from '../src/game/islandReveal.js';
import { normalizeImageParams } from '../src/llm/openai.js';

test('промпт картины берёт описание города и общий стиль', () => {
  const prompt = buildIslandImagePrompt(
    {
      name: 'Талиндор',
      description: 'Пепельный остров с торфяными грядами и деревянными подъёмниками.',
      tags: [{ tagName: 'Пепельный' }, { tagName: 'Болота и топи' }],
    },
    {
      genesis: {
        image: {
          style: 'Mineral pigments only. Overcast daylight.',
        },
      },
    },
  );
  assert.match(prompt, /Талиндор/);
  assert.match(prompt, /торфяными грядами/);
  assert.match(prompt, /Mineral pigments only/);
  assert.match(prompt, /do not write the name/i);
  assert.match(prompt, /16:9/);
  assert.match(prompt, /CENTER/i);
  assert.match(prompt, /countryside/i);
});

test('после DALL·E не шлёт response_format и меняет модель', () => {
  const body = normalizeImageParams({
    model: 'dall-e-3',
    prompt: 'island',
    size: '1792x1024',
    quality: 'standard',
  });
  assert.equal(body.model, 'gpt-image-2');
  assert.equal(body.quality, 'medium');
  assert.equal(body.size, '1792x1024');
  assert.equal('response_format' in body, false);
});

test('после генезиса коротко называет фишки острова', () => {
  const long = `${'Камень и стекло. '.repeat(80)}Последнее предложение остаётся.`;
  const text = formatIslandReveal({
    name: 'Сарвел',
    aspects: { overview: long },
    tags: [{ tagName: 'Солёные ветры' }, { tagName: 'Кальдера / кратер' }],
    plotlines: [
      { title: 'Сусло на ветру', kind: 'story', synopsis: 'Ночная смена спорит, кому нести чан в цистерну.' },
    ],
    characters: [{ name: 'Таврен', title: 'Верховный жрец' }],
  });
  assert.match(text, /Сарвел/);
  assert.match(text, /Последнее предложение остаётся/);
  assert.doesNotMatch(text, /Солёные ветры|Кальдера/);
  assert.match(text, /Сусло на ветру/);
  assert.match(text, /Таврен/);
  assert.doesNotMatch(text, /…/);
});
