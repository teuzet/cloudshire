import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import {
  formatRulerPersonaForPrompt,
  formatRulerMemoryForPrompt,
  formatRulerVoiceForPrompt,
  writeRulerMemory,
} from '../src/game/rulerMemory.js';

function domainWithPriest(memory = []) {
  return {
    name: 'Севрайн',
    characters: [
      {
        name: 'Фендри',
        title: 'верховный хранитель',
        description: 'Бережлив до скупости, говорит коротко и колко.',
      },
    ],
    state: { rulerMemory: memory },
  };
}

test('персоналия жреца одинаково собирается для разговора и письма', () => {
  const text = formatRulerPersonaForPrompt(domainWithPriest());
  assert.match(text, /Ты Фендри, верховный хранитель города «Севрайн»/);
  assert.match(text, /Бережлив до скупости/);
  assert.match(text, /не общий шаблон жреца/);
});

test('память в письме только для чтения, в разговоре можно переписать', () => {
  const domain = domainWithPriest();
  writeRulerMemory(domain, 'Звать только Орион, без титулов всуе.', { tick: 1 });
  const chat = formatRulerMemoryForPrompt(domain, { writable: true });
  const letter = formatRulerMemoryForPrompt(domain, { writable: false });
  assert.match(chat, /пока не перепишешь/);
  assert.match(letter, /только чтение/);
  assert.match(letter, /Звать только Орион/);
  assert.equal(letter.includes('перепишешь'), false);
});

test('общий голос: персоналия плюс память; пустая память не добавляет блока', () => {
  const empty = formatRulerVoiceForPrompt(domainWithPriest(), { writable: false });
  assert.match(empty, /Фендри/);
  assert.equal(empty.includes('ТВОЯ ПАМЯТЬ'), false);

  const domain = domainWithPriest();
  writeRulerMemory(domain, 'Не будить по мелочам.', { tick: 2 });
  const voice = formatRulerVoiceForPrompt(domain, { writable: false });
  assert.match(voice, /Фендри/);
  assert.match(voice, /Не будить по мелочам/);
  assert.match(voice, /только чтение/);
});

test('ruler и tickNews делят стиль priestVoice; письмо без инструментов памяти', () => {
  const config = loadConfig();
  assert.ok(config.styles.priestVoice.includes('один голос'));
  assert.deepEqual(config.agents.ruler.styles, ['names', 'priestVoice']);
  assert.deepEqual(config.agents.tickNews.styles, ['names', 'priestVoice']);
  assert.match(config.agents.tickNews.instructions, /Память в письме только читай/);
});
