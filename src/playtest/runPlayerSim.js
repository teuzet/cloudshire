import path from 'node:path';
import { generateDomain, domainSummary } from '../game/genesis.js';
import { runWorldTick } from '../game/tick.js';
import { projectRoot } from '../config.js';
import { loadScenario } from './loadScenario.js';
import {
  buildGenesisSnapshot,
  writeArtifacts,
} from './report.js';

const PLAYTEST_USER = 'playtest-user';

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function formatDialogHistory(domain) {
  const history = domain.characters?.[0]?.dialogHistory || [];
  if (!history.length) return '(диалог ещё пуст — только приветствие правителя могло быть)';
  return history
    .slice(-16)
    .map((m) => `${m.role === 'assistant' ? 'Правитель' : 'Покровитель'}: ${m.content}`)
    .join('\n\n');
}

function formatPending(domain) {
  const active = (domain.state?.pendingActions || []).filter((a) => a.status === 'active');
  if (!active.length) return '(нет active pending)';
  return active
    .map(
      (a) =>
        `- ${a.summary} (${a.monthsDone ?? 0}/${a.durationMonths ?? 1} мес.): ${a.detail || ''}`,
    )
    .join('\n');
}

function formatMilestones(domain) {
  const list = domain.milestones || [];
  if (!list.length) return '(майлстоунов нет)';
  return list
    .map((m) => {
      const st = m.status && m.status !== 'open' ? ` [${m.status}]` : '';
      const pts = m.points != null ? ` (${m.points} очков)` : '';
      return `- ${m.text}${pts}${st}`;
    })
    .join('\n');
}

function formatGoals(scenario) {
  const parts = [];
  if (scenario.ambition) {
    parts.push(`AMBITION сценария:\n${scenario.ambition}`);
  }
  if (scenario.goals?.length) {
    parts.push(`Goals:\n${scenario.goals.map((g, i) => `${i + 1}. ${g}`).join('\n')}`);
  }
  return parts.join('\n\n') || 'Двигай открытые майлстоуны домена.';
}

async function applyTalk({ app, domainId, playerLine, step, ticksDone, transcript, log }) {
  log.info('playtest.step.talk', { step, ticksDone, text: playerLine });
  const result = await app.handleUserMessage(PLAYTEST_USER, playerLine, {
    channel: 'playtest',
  });
  const entry = {
    step,
    kind: 'talk',
    ticksDone,
    player: playerLine,
    ruler: result.reply,
    agent: result.agent,
    toolTrace: (result.toolTrace || []).map((t) => ({
      name: t.name,
      ok: t.result?.ok !== false,
      error: t.result?.error || t.result?.reason || null,
    })),
  };
  transcript.push(entry);
  log.info('playtest.step.ruler', {
    step,
    replyPreview: String(result.reply || '').slice(0, 200),
    tools: entry.toolTrace.map((t) => t.name),
  });
  return result;
}

async function applyTick({
  config,
  runtime,
  storage,
  app,
  domainId,
  step,
  ticksDone,
  transcript,
  tickResults,
  log,
  forced = false,
  reason = null,
}) {
  log.info('playtest.step.tick', {
    step,
    ticksDone: ticksDone + 1,
    reason,
  });
  const tickResult = await runWorldTick({ config, runtime, storage, app });
  tickResults.push(tickResult);
  const afterTick = await storage.getDomain(domainId);
  const lastAssistant = (afterTick.characters?.[0]?.dialogHistory || [])
    .filter((m) => m.role === 'assistant')
    .at(-1);

  transcript.push({
    step,
    kind: 'tick',
    ticksDone: ticksDone + 1,
    tick: {
      tickIndex: tickResult.world?.tickIndex,
      gameDate: tickResult.world?.gameDate,
      domainResults: (tickResult.results || []).map((d) => ({
        domainId: d.domainId,
        name: d.name,
        chronicleAdds: d.chronicleCount || 0,
        skipped: d.skipped || false,
      })),
    },
    tickNews: lastAssistant?.content || null,
    forced,
    reason,
  });
  return ticksDone + 1;
}

/**
 * @param {object} ctx — createAppContext result
 * @param {object} opts
 */
export async function runPlayerSim(ctx, opts = {}) {
  const {
    scenarioPath = 'scenarios/smoke.yaml',
    ticks = 5,
    maxSteps = 40,
    scripted = false,
    outDir: outDirOpt = null,
    wipe = true,
  } = opts;

  const { config, storage, runtime, app, log } = ctx;
  const parentLog = log.child({ scope: 'playtest' });
  const scenario = loadScenario(scenarioPath);
  const dataDir = config.storage?.yaml?.dir || '(unknown)';
  const targetTicks = Math.max(1, Number(ticks) || 5);
  const stepCap = Math.max(targetTicks * 2, Number(maxSteps) || 40);

  if (wipe) {
    parentLog.info('playtest.wipe', { dataDir });
    await storage.wipeAll();
  }

  parentLog.info('playtest.genesis.start', {
    cityName: scenario.cityName,
    scenario: scenario.id,
    targetTicks,
  });

  const domain = await generateDomain({
    config,
    runtime,
    storage,
    ownerUserId: PLAYTEST_USER,
    forcedName: scenario.cityName,
    playerBrief: scenario.playerBrief,
    log: parentLog,
    onProgress: (msg) => parentLog.info('playtest.genesis.progress', { message: msg }),
  });

  const greeting = domain._greeting.startsWith(domain.characters[0].name)
    ? domain._greeting
    : `${domain.characters[0].name}: ${domain._greeting}`;
  await app.persistDialog(domain, 'assistant', greeting);

  const genesis = buildGenesisSnapshot(domain);
  parentLog.info('playtest.genesis.done', domainSummary(domain));

  const transcript = [];
  const tickResults = [];
  let ticksDone = 0;
  let step = 0;
  let scriptedIndex = 0;
  let forcedRemaining = false;

  while (ticksDone < targetTicks && step < stepCap) {
    step += 1;
    const current = await storage.getDomain(domain.id);

    if (scripted) {
      const action = scenario.scriptedActions[scriptedIndex];
      if (!action) {
        ticksDone = await applyTick({
          config,
          runtime,
          storage,
          app,
          domainId: domain.id,
          step,
          ticksDone,
          transcript,
          tickResults,
          log: parentLog,
          forced: true,
          reason: 'scripted_exhausted',
        });
        continue;
      }
      scriptedIndex += 1;
      if (action.tick) {
        ticksDone = await applyTick({
          config,
          runtime,
          storage,
          app,
          domainId: domain.id,
          step,
          ticksDone,
          transcript,
          tickResults,
          log: parentLog,
        });
      } else {
        await applyTalk({
          app,
          domainId: domain.id,
          playerLine: action.talk,
          step,
          ticksDone,
          transcript,
          log: parentLog,
        });
      }
      continue;
    }

    const decision = await decidePlayerAction({
      runtime,
      scenario,
      domain: current,
      ticksDone,
      targetTicks,
      step,
      stepCap,
      log: parentLog,
    });

    await applyTalk({
      app,
      domainId: domain.id,
      playerLine: decision.message,
      step,
      ticksDone,
      transcript,
      log: parentLog,
    });

    if (decision.tick) {
      step += 1;
      ticksDone = await applyTick({
        config,
        runtime,
        storage,
        app,
        domainId: domain.id,
        step,
        ticksDone,
        transcript,
        tickResults,
        log: parentLog,
      });
    }
  }

  if (ticksDone < targetTicks) {
    parentLog.warn('playtest.force_remaining_ticks', {
      ticksDone,
      targetTicks,
      step,
    });
    forcedRemaining = true;
    while (ticksDone < targetTicks) {
      step += 1;
      ticksDone = await applyTick({
        config,
        runtime,
        storage,
        app,
        domainId: domain.id,
        step,
        ticksDone,
        transcript,
        tickResults,
        log: parentLog,
        forced: true,
        reason: 'max_steps_exhausted',
      });
    }
  }

  const finalDomain = await storage.getDomain(domain.id);
  const outDir =
    outDirOpt ||
    path.join(projectRoot(), 'artifacts', `playtest-${stamp()}-${scenario.id}`);

  const written = await writeArtifacts(outDir, {
    scenario,
    ticks: targetTicks,
    ticksDone,
    steps: step,
    scripted,
    forcedRemaining,
    tickResults,
    genesis,
    domain: finalDomain,
    transcript,
    dataDir,
  });

  parentLog.info('playtest.done', {
    outDir: written.outDir,
    ticksDone,
    steps: step,
    flags: written.flags.length,
    pending: written.snapshot.pending.length,
    chronicle: written.snapshot.chronicle.length,
    facts: written.snapshot.facts.length,
  });

  return {
    ok: true,
    userId: PLAYTEST_USER,
    scenario,
    domainId: domain.id,
    domainName: domain.name,
    ticks: targetTicks,
    ticksDone,
    steps: step,
    forcedRemaining,
    outDir: written.outDir,
    flags: written.flags,
    genesis,
    transcript,
    snapshot: written.snapshot,
  };
}

/**
 * Каждый ход: обязательный talk_to_ruler, опционально force_tick в том же ходе.
 */
async function decidePlayerAction({
  runtime,
  scenario,
  domain,
  ticksDone,
  targetTicks,
  step,
  stepCap,
  log,
}) {
  let talkMessage = null;
  let wantTick = false;

  const tools = [
    {
      name: 'talk_to_ruler',
      description:
        'ОБЯЗАТЕЛЬНО на каждом ходе: одна сухая реплика правителю (статус, майлстоун, приказ).',
      parameters: {
        type: 'object',
        required: ['message'],
        properties: {
          message: {
            type: 'string',
            description: '1–2 предложения по-русски, сухо, без лести и мета',
          },
        },
      },
      handler: async ({ message }) => {
        talkMessage = String(message || '').trim();
        return { ok: true, hint: 'Если больше нечего сказать до смены месяца — вызови force_tick.' };
      },
    },
    {
      name: 'force_tick',
      description:
        'Сдвинуть игровой месяц. Только ПОСЛЕ talk_to_ruler, когда ждать нечего.',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        wantTick = true;
        return { ok: true };
      },
    },
  ];

  const remaining = targetTicks - ticksDone;
  await runtime.run({
    agentId: 'player',
    tools,
    maxTurns: 6,
    toolChoice: { type: 'function', function: { name: 'talk_to_ruler' } },
    log,
    scene: 'playtest_player',
    domainId: domain.id,
    userMessages: [
      {
        role: 'user',
        content: [
          `Город: «${domain.name}». Правитель: ${domain.characters?.[0]?.name || 'правитель'}.`,
          `Тиков сделано ${ticksDone}/${targetTicks} (осталось ${remaining}). Ход/шаг ${step}/${stepCap}.`,
          '',
          'МАЙЛСТОУНЫ СЕЗОНА (главный ориентир — пытайся их двигать):',
          formatMilestones(domain),
          '',
          formatGoals(scenario),
          '',
          'Pending сейчас:',
          formatPending(domain),
          '',
          'История диалога (хвост):',
          formatDialogHistory(domain),
          '',
          'Сейчас: СНАЧАЛА talk_to_ruler (обязательно). Потом при необходимости force_tick.',
          'Молчать нельзя. Говори по майлстоуну или по последствиям прошлого месяца.',
          remaining <= 1
            ? 'Последние тики — добей видимый прогресс по выбранному майлстоуну.'
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  });

  if (!talkMessage) {
    throw new Error(`Player agent skipped talk_to_ruler at step ${step}`);
  }
  return { message: talkMessage, tick: wantTick };
}
