/**
 * Плейтест клерка из командной строки: разговор онбординга до питча на настоящих моделях.
 * Генезис не запускается: когда клерк ставит готовность, печатается «рыба» и разговор окончен.
 *
 *   npm run clerk -- <имя прогона> <реплика игрока>     (пустая реплика — игрок только пришёл)
 *   npm run clerk -- <имя прогона> --state               черновик: питч, настроения, заданные вопросы
 *   npm run clerk -- <имя прогона> --genesis             собрать город из готовой «рыбы» (настоящие модели)
 *
 *   PLAYTEST_DIR — папка плейтеста (по умолчанию ./playtest); прогон живёт в clerk/<имя>/:
 *   data/ (черновик), calls/ (вызовы агента), transcript.md
 */

import fs from 'node:fs';
import path from 'node:path';
import { MemoryNotifier } from '../../adapters/notifier/memory.js';
import { clerkBook } from '../../agents/onboarding-guide/book.js';
import { onboardingMessage, runGenesis } from '../../flows/onboarding.js';
import { GENESIS_TUTORIAL, genesisProgressBar } from '../genesis-progress.js';
import { buildApp, loadDotEnv, ROOT } from '../app.js';

const OWNER = 'dev';

async function main(): Promise<void> {
  const [name, ...rest] = process.argv.slice(2);
  if (!name) throw new Error('нужно имя прогона: npm run clerk -- <имя> <реплика>');
  loadDotEnv();
  const dir = path.resolve(process.env.PLAYTEST_DIR ?? path.join(ROOT, 'playtest'), 'clerk', name);
  fs.mkdirSync(dir, { recursive: true });
  process.env.DATA_DIR = path.join(dir, 'data');
  process.env.AGENT_LOG_DIR = path.join(dir, 'calls');
  const transcript = path.join(dir, 'transcript.md');
  const out = (text: string): void => {
    console.log(text);
    fs.appendFileSync(transcript, text + '\n');
  };

  const inbox = new MemoryNotifier();
  const app = await buildApp(process.env, inbox);
  try {
    const book = clerkBook();
    const draft = await app.deps.storage.getDraft(OWNER);
    if (rest[0] === '--state') {
      const state = draft?.clerk;
      console.log(`статус: ${draft?.status ?? 'нет черновика'}`);
      console.log(`настроения сейчас: ${(state?.spirits ?? []).map((id) => book.spirits.find((s) => s.id === id)?.name ?? id).join(' | ') || '—'}`);
      console.log(`настроения показаны: ${(state?.spiritsUsed ?? []).map((id) => book.spirits.find((s) => s.id === id)?.name ?? id).join(' | ') || '—'}`);
      console.log(`заданные вопросы: ${(state?.asked ?? []).map((id) => `${id} ${book.questions.find((q) => q.id === id)?.text ?? ''}`).join(' | ') || '—'}`);
      console.log(`темы: ${(state?.heard ?? []).join(', ') || '—'}`);
      console.log(`питч:\n${draft?.pitch ?? '—'}`);
      if (draft?.seed) console.log(`рыба: ${JSON.stringify(draft.seed, null, 2)}`);
      return;
    }
    if (rest[0] === '--genesis') {
      out(`\n_${GENESIS_TUTORIAL.replace(/\n\n/g, '_\n\n_')}_`);
      const t0 = Date.now();
      const city = await runGenesis(app.deps, OWNER, async (step, total, label) => {
        out(`\n\`${genesisProgressBar(step, total, label).replace('\n', ' · ')}\` (${((Date.now() - t0) / 1000).toFixed(0)} с)`);
      });
      if (!city) return out('\n_Генезис не удался, подробности в calls/_');
      fs.writeFileSync(path.join(dir, 'city.json'), JSON.stringify(city, null, 2));
      out(`\n## ${city.name}\n\n**Жрец:** ${city.priest.name}\n\n**Сановники:** ${city.officers.map((o) => `${o.title} ${o.name}`).join('; ')}`);
      const byId = new Map(city.objects.map((o) => [o.id, o.name]));
      out(
        `\n**Объекты (${city.objects.length}):**\n${city.objects
          .map((o) => `- ${o.name} (${[o.type, o.hidden ? 'скрыт' : '', o.arc ?? ''].filter(Boolean).join(', ')}): ${o.description} → ${o.refs.map((r) => byId.get(r)).join(', ')}`)
          .join('\n')}`,
      );
      out(`\n**Бриф (${city.brief.length} знаков):**\n\n${city.brief}`);
      out(`\n**Неизвестности:** ${city.unknowns.map((u) => u.text).join(' | ') || '—'}`);
      out(`\n**Хроника:** ${city.chronicle.map((c) => c.text).join(' | ')}`);
      out(`\n**Портрет (${city.description.length} знаков):**\n\n${city.description}`);
      const sent = inbox.drain(OWNER);
      out(`\n---\n**Что видит игрок:**\n\n_${(sent.find((m) => m.kind === 'system')?.text ?? '—').replace(/\n+/g, ' ')}_`);
      for (const m of sent.filter((x) => x.kind === 'news')) out(`\n**${city.priest.name}:** ${m.text}`);
      return;
    }
    const text = rest.join(' ').trim();
    if (text) out(`\n**Игрок:** ${text}`);
    const started = Date.now();
    const r = await onboardingMessage(app.deps, { ownerId: OWNER, text });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (r.kind === 'has_city') return out('_у игрока уже есть город_');
    if (r.kind === 'busy') return out(`_разговор окончен: ${r.text}_`);
    out(`\n**Клерк:** ${r.text}`);
    if (r.pitch) out(`\n> ${r.pitch.replace(/\n/g, '\n> ')}`);
    const after = await app.deps.storage.getDraft(OWNER);
    const asked = after?.clerk?.asked ?? [];
    const before = draft?.clerk?.asked ?? [];
    const fresh = asked.filter((id) => !before.includes(id));
    const notes = [`${seconds} с`];
    if (fresh.length) notes.push(`вопрос из базы: ${fresh.join(', ')}`);
    const usedBefore = draft?.clerk?.spiritsUsed ?? [];
    const sketched = (after?.clerk?.spiritsUsed ?? []).filter((id) => !usedBefore.includes(id));
    if (sketched.length) notes.push(`наброски по настроениям: ${sketched.map((id) => book.spirits.find((x) => x.id === id)?.name ?? id).join(' | ')}`);
    out(`\n_${notes.join('; ')}_`);
    if (r.ready && after?.seed) {
      out(`\n_Готово. Имя города: ${after.seed.cityName ?? 'на выбор мира'}; покровитель: ${after.seed.patronName} (${after.seed.patronGender === 'female' ? 'покровительница' : 'покровитель'}). Генезис не запускался._`);
    }
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
