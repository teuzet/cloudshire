#!/usr/bin/env node
import { Command } from 'commander';
import { createAppContext } from './bootstrap.js';
import { runWorldTick } from './game/tick.js';
import { domainSummary } from './game/genesis.js';
import { loreToPromptText } from './game/models.js';
import { runPlayerSim } from './playtest/runPlayerSim.js';

const program = new Command();
program.name('cloudshire').description('CLI управления Cloudshire').version('0.1.0');

async function withApp(fn, opts = {}) {
  const ctx = await createAppContext(opts);
  try {
    await fn(ctx);
  } finally {
    await ctx.storage.close();
  }
}

program
  .command('status')
  .description('Статус мира и хранилища')
  .action(async () => {
    await withApp(async ({ app }) => {
      console.log(JSON.stringify(await app.getStatus(), null, 2));
    });
  });

program
  .command('domains')
  .description('Список доменов')
  .action(async () => {
    await withApp(async ({ app }) => {
      const domains = await app.listDomains();
      console.log(JSON.stringify(domains.map(domainSummary), null, 2));
    });
  });

program
  .command('inspect')
  .argument('<domainId>', 'ID домена')
  .description('Показать домен')
  .option('--lore', 'Печатать лор текстом')
  .action(async (domainId, opts) => {
    await withApp(async ({ app }) => {
      const domain = await app.inspectDomain(domainId);
      if (!domain) {
        console.error('Домен не найден');
        process.exitCode = 1;
        return;
      }
      if (opts.lore) {
        console.log(loreToPromptText(domain.lore));
        return;
      }
      console.log(JSON.stringify(domain, null, 2));
    });
  });

program
  .command('tick')
  .description('Force-tick всего мира')
  .action(async () => {
    await withApp(async (ctx) => {
      const result = await runWorldTick(ctx);
      console.log(JSON.stringify(result, null, 2));
    });
  });

program
  .command('wipe')
  .description('Стереть все домены, пользователей и сбросить мир')
  .action(async () => {
    await withApp(async ({ app }) => {
      const status = await app.wipeAll();
      console.log(JSON.stringify({ ok: true, status }, null, 2));
    });
  });

program
  .command('chat')
  .description('Одно сообщение в пайплайн (онбординг или правитель)')
  .requiredOption('-u, --user <userId>', 'ID пользователя', 'cli-user')
  .argument('<text...>', 'Текст сообщения')
  .action(async (textParts, opts) => {
    await withApp(async ({ app }) => {
      const text = textParts.join(' ');
      const result = await app.handleUserMessage(opts.user, text, { channel: 'cli' });
      console.log(result.reply);
      if (result.created) console.error('[created domain]', result.domainId);
    });
  });

program
  .command('agent-ping')
  .description('Проверка LLM wrapper (простой вызов onboarding без tools)')
  .action(async () => {
    await withApp(async ({ runtime }) => {
      const result = await runtime.run({
        agentId: 'onboarding',
        userMessages: [
          {
            role: 'user',
            content: 'Поприветствуй меня одним коротким предложением по-русски. Tools не вызывай.',
          },
        ],
        tools: [],
        maxTurns: 1,
      });
      console.log(result.text);
      console.log(`[model=${result.model} agent=${result.agentId}]`);
    });
  });

program
  .command('playtest')
  .description('Полный генезис + агент-игрок до N force-tick; артефакты в artifacts/')
  .option('--ticks <n>', 'Сколько игровых месяцев (force_tick) должно пройти', '5')
  .option('--max-steps <n>', 'Потолок шагов (talk+tick), защита от бесконечной болтовни', '40')
  .option('--scenario <path>', 'YAML сценария', 'scenarios/smoke.yaml')
  .option('--scripted', 'Действия из scenario.scriptedActions вместо LLM-player', false)
  .option('--data-dir <dir>', 'Каталог YAML store (не трогает ./data)', 'data-test')
  .option('--out <dir>', 'Куда писать артефакты')
  .option('--no-wipe', 'Не wipe store перед прогоном')
  .action(async (opts) => {
    await withApp(
      async (ctx) => {
        const result = await runPlayerSim(ctx, {
          scenarioPath: opts.scenario,
          ticks: Number(opts.ticks),
          maxSteps: Number(opts.maxSteps),
          scripted: Boolean(opts.scripted),
          outDir: opts.out || null,
          wipe: opts.wipe !== false,
        });
        console.log(
          JSON.stringify(
            {
              ok: result.ok,
              domainId: result.domainId,
              domainName: result.domainName,
              ticksDone: result.ticksDone,
              ticks: result.ticks,
              steps: result.steps,
              forcedRemaining: result.forcedRemaining,
              outDir: result.outDir,
              flags: result.flags,
              pending: result.snapshot.pending.length,
              chronicle: result.snapshot.chronicle.length,
              facts: result.snapshot.facts.length,
            },
            null,
            2,
          ),
        );
        console.error(`Playtest artifacts: ${result.outDir}/summary.md`);
      },
      { dataDir: opts.dataDir },
    );
  });

program.parseAsync(process.argv);
