/**
 * Tools онбординга Genesis 2: оси, концепт, космология. Без тегов.
 */

import { toolFail } from '../agents/toolResult.js';
import {
  deriveOnboardingPhase,
  hasPitchedCity,
  hasReadyConcept,
  canStartOnboarding,
  playerAsksReroll,
  lastPitchedCityName,
  formatPlayerBrief,
  clipOnboardingBrief,
  validateCityNameAvailable,
  validatePatronName,
  isCityNameOccupied,
  occupiedCityNameError,
  occupiedNameList,
  BRIEF_CITY_MAX,
  BRIEF_RULER_MAX,
  BRIEF_FREEFORM_MAX,
} from './onboarding.js';
import { requestCityConcept } from './genesisConcept.js';
import {
  sampleGenesisAxes,
  setAxisValue,
  genesisAxisById,
  formatGenesisAxesForPrompt,
  missingAxisIds,
  nextAxisOffer,
  sampleOneAxis,
  axesReadyForConcept,
  emptyAxisInterview,
  normalizeAxisInterview,
} from './genesisAxes.js';
import {
  mergePlayerDirectives,
  recordCosmologyConflicts,
  resolveCosmologyConflict,
  hasUnresolvedConflicts,
} from './playerDirectives.js';
import { matchCosmologyHeuristic } from './worldContract.js';

function scanBriefConflicts(draft, extraText = '') {
  const blob = [
    draft.playerBrief?.city,
    draft.playerBrief?.ruler,
    draft.playerBrief?.freeform,
    extraText,
  ]
    .filter(Boolean)
    .join('\n');
  const hits = matchCosmologyHeuristic(blob);
  if (hits.length) {
    draft.playerDirectives = recordCosmologyConflicts(draft.playerDirectives, hits);
  }
  return hits;
}

function ensureInterview(draft) {
  draft.axisInterview = normalizeAxisInterview(draft.axisInterview);
  return draft.axisInterview;
}

function applySampledAxis(draft, config, axisId, source = 'sampled') {
  const one = sampleOneAxis(config, axisId, Math.random);
  if (!one?.value) return false;
  draft.axes = setAxisValue(draft.axes, axisId, one.value, source);
  return true;
}

async function runCityConcept({ app, draft, userId, saveDraft, text }) {
  if (hasReadyConcept(draft) && !playerAsksReroll(text)) {
    return {
      ok: true,
      status: 'READY',
      name: draft.concept.name,
      preview: draft.concept.preview,
      hint: 'Город уже предложен. Покажи preview, не генерируй заново.',
    };
  }
  if (hasUnresolvedConflicts(draft.playerDirectives)) {
    return toolFail(
      'unresolved_conflicts',
      'Сначала разреши конфликты космологии (resolve_cosmology_conflict). Не показывай preview.',
    );
  }
  const uniqueNeeded = draft.mode === 'questions';
  if (!axesReadyForConcept(app.config, draft.axes, draft.axisInterview, { uniqueFeatureRequired: uniqueNeeded })) {
    const missing = missingAxisIds(app.config, draft.axes);
    if (missing.length) {
      const offer = nextAxisOffer(app.config, draft.axes);
      return toolFail(
        'axes_incomplete',
        `Не все оси заданы (${missing.join(', ')}). Сначала resolve_axis${offer ? ` для «${offer.axisId}»` : ''}.`,
      );
    }
    return toolFail(
      'unique_feature_pending',
      'В режиме анкеты спроси уникальную фичу (set_unique_feature) или skip, затем концепт.',
    );
  }
  if (!Object.keys(draft.axes || {}).length) {
    draft.axes = sampleGenesisAxes(app.config, Math.random);
  } else {
    draft.axes = sampleGenesisAxes(app.config, Math.random, {
      keep: draft.axes,
      onlyMissing: true,
    });
  }
  const occupied = await app.occupiedCityNames(userId);
  const result = await requestCityConcept({
    config: app.config,
    runtime: app.runtime,
    axes: draft.axes,
    directives: draft.playerDirectives,
    playerBrief: draft.playerBrief,
    axisInterview: draft.axisInterview,
    occupiedNames: occupiedNameList(occupied),
  });
  if (!result.ok && result.concept?.status !== 'NEEDS_PLAYER_REVISION') {
    return toolFail('concept_failed', 'Концепт не собрался. Попробуй ещё раз.');
  }
  draft.axes = result.axes || draft.axes;
  draft.playerDirectives = result.directives || draft.playerDirectives;
  draft.concept = result.concept;
  if (result.concept?.status === 'NEEDS_PLAYER_REVISION') {
    draft.pitched = false;
    await saveDraft();
    return {
      ok: true,
      status: 'NEEDS_PLAYER_REVISION',
      conflicts: result.concept.conflicts,
      suggestedAdaptations: result.concept.suggestedAdaptations,
      hint: 'Назови конфликты игроку тем же тоном, что слой A. Не чини концепт молча.',
    };
  }
  const occupiedCheck = validateCityNameAvailable(result.concept.name, occupied);
  if (!occupiedCheck.ok) {
    draft.concept = null;
    await saveDraft();
    return toolFail(
      'name_taken',
      occupiedCheck.reason || 'Имя занято. Вызови request_city_concept снова.',
    );
  }
  draft.pitchedName = result.concept.name;
  draft.pitched = true;
  draft.phase = deriveOnboardingPhase(draft);
  await saveDraft();
  return {
    ok: true,
    status: 'READY',
    name: result.concept.name,
    preview: result.concept.preview,
    hint:
      'Питч игроку = preview. Не выдумывай другой город. ОК / точечная правка / другой город. Затем имя бога.',
  };
}

export function buildOnboardingTools({
  app,
  draft,
  userId,
  channel,
  text,
  saveDraft,
  startFlag,
}) {
  return [
    {
      name: 'get_setup',
      description: 'Текущий черновик старта: оси, концепт, brief, имя, конфликты',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        ensureInterview(draft);
        const offer = nextAxisOffer(app.config, draft.axes);
        return {
          ok: true,
          mode: draft.mode || null,
          phase: deriveOnboardingPhase(draft, { generating: app.isGenerating(userId) }),
          axes: draft.axes,
          missingAxes: missingAxisIds(app.config, draft.axes),
          nextAxis: offer,
          uniqueFeatureAsked: draft.axisInterview.uniqueFeatureAsked,
          uniqueFeature: draft.axisInterview.uniqueFeature,
          conceptStatus: draft.concept?.status || null,
          conceptName: draft.concept?.name || null,
          required: draft.playerDirectives?.required || [],
          conflicts: draft.playerDirectives?.unresolvedConflicts || [],
          playerBrief: {
            city: String(draft.playerBrief?.city || '').slice(0, BRIEF_CITY_MAX),
            ruler: String(draft.playerBrief?.ruler || '').slice(0, BRIEF_RULER_MAX),
            freeform: String(draft.playerBrief?.freeform || '').slice(0, BRIEF_FREEFORM_MAX),
          },
          cityName: draft.cityName,
          cityNameApproved: draft.cityNameApproved,
          patronName: draft.patronName,
          patronNameApproved: Boolean(draft.patronNameApproved),
          canStart: canStartOnboarding(draft),
          pitchedName: draft.pitchedName || null,
          pitched: hasPitchedCity(draft) || hasReadyConcept(draft),
        };
      },
    },
    {
      name: 'set_onboarding_mode',
      description:
        'Режим: quick (сразу семпл осей + концепт), brief (описание → оси), questions (опрос по осям). dossier = brief.',
      parameters: {
        type: 'object',
        required: ['mode'],
        properties: {
          mode: { type: 'string', enum: ['quick', 'brief', 'questions', 'dossier'] },
        },
      },
      handler: async ({ mode }) => {
        const resolved = mode === 'dossier' ? 'brief' : mode;
        draft.mode = resolved;
        ensureInterview(draft);
        if (resolved === 'questions') {
          draft.axisInterview = emptyAxisInterview();
        }
        draft.phase = deriveOnboardingPhase(draft);
        await saveDraft();

        if (resolved === 'quick') {
          if (hasReadyConcept(draft) && !playerAsksReroll(text)) {
            return {
              ok: true,
              mode: 'quick',
              alreadyPitched: true,
              name: draft.concept.name,
              preview: draft.concept.preview,
              hint: 'Город уже предложен. Покажи preview, не генерируй заново.',
            };
          }
          draft.axes = sampleGenesisAxes(app.config, Math.random);
          draft.concept = null;
          draft.pitched = false;
          await saveDraft();
          const concept = await runCityConcept({ app, draft, userId, saveDraft, text });
          return {
            ...concept,
            mode: 'quick',
            hint:
              concept.ok && concept.status === 'READY'
                ? 'Покажи игроку preview как есть. Не выдумывай другой город. Прогресс-бар не рисуй — это ещё не генезис.'
                : concept.hint,
          };
        }

        const offer = nextAxisOffer(app.config, draft.axes);
        return {
          ok: true,
          mode: draft.mode,
          phase: draft.phase,
          nextAxis: offer,
          hint:
            resolved === 'questions'
              ? offer
                ? `Задай вопрос оси «${offer.axisId}»: ${offer.prompt}. Варианты + random + agent. После ответа — resolve_axis.`
                : 'Оси заполнены. Спроси уникальную фичу (set_unique_feature) или skip, затем request_city_concept.'
              : resolved === 'brief'
                ? 'Вытяни оси из описания через set_axis. Для пробелов — resolve_axis (вопрос / random / agent). Потом request_city_concept.'
                : null,
        };
      },
    },
    {
      name: 'sample_genesis_axes',
      description:
        'Семплировать оси. Quick / явный reroll. Не описывай город до request_city_concept.',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        if (hasReadyConcept(draft) && !playerAsksReroll(text)) {
          return toolFail(
            'already_pitched',
            `Город уже предложен («${draft.concept.name}»). Не семплируй заново, пока игрок не попросит другой город.`,
          );
        }
        if (draft.mode === 'brief' || draft.mode === 'questions') {
          const missing = missingAxisIds(app.config, draft.axes);
          if (missing.length && !playerAsksReroll(text)) {
            return toolFail(
              'axes_incomplete',
              `Сначала закрой оси через resolve_axis (${missing.join(', ')}), не семплируй всё разом.`,
            );
          }
        }
        draft.axes = sampleGenesisAxes(app.config, Math.random, {
          keep: playerAsksReroll(text) ? null : draft.axes,
          onlyMissing: Boolean(Object.keys(draft.axes || {}).length) && !playerAsksReroll(text),
        });
        if (playerAsksReroll(text) || draft.mode === 'quick') {
          if (playerAsksReroll(text)) {
            draft.axes = sampleGenesisAxes(app.config, Math.random);
            draft.concept = null;
            draft.pitched = false;
            draft.pitchedName = null;
            draft.cityName = null;
            draft.cityNameApproved = false;
            draft.axisInterview = emptyAxisInterview();
          }
        }
        draft.phase = deriveOnboardingPhase(draft);
        await saveDraft();
        return {
          ok: true,
          axes: draft.axes,
          prompt: formatGenesisAxesForPrompt(app.config, draft.axes),
          next: 'Сразу вызови request_city_concept. Не описывай город своей речью до preview.',
        };
      },
    },
    {
      name: 'set_axis',
      description: 'Точечно задать ось (id значения из каталога) — из описания игрока.',
      parameters: {
        type: 'object',
        required: ['axisId', 'value'],
        properties: {
          axisId: { type: 'string' },
          value: { type: 'string' },
        },
      },
      handler: async ({ axisId, value }) => {
        const group = genesisAxisById(app.config, axisId);
        if (!group) return toolFail('unknown_axis', `Нет оси «${axisId}».`);
        draft.axes = setAxisValue(draft.axes, axisId, value, 'player');
        await saveDraft();
        const offer = nextAxisOffer(app.config, draft.axes);
        return {
          ok: true,
          axes: draft.axes,
          missingAxes: missingAxisIds(app.config, draft.axes),
          nextAxis: offer,
        };
      },
    },
    {
      name: 'resolve_axis',
      description:
        'Закрыть одну недостающую ось: choice = id из каталога, random (система), или agent (агент выбирает; передай value).',
      parameters: {
        type: 'object',
        required: ['axisId', 'choice'],
        properties: {
          axisId: { type: 'string' },
          choice: {
            type: 'string',
            description: 'id значения каталога, либо random, либо agent',
          },
          value: {
            type: 'string',
            description: 'id значения, если choice=agent',
          },
        },
      },
      handler: async ({ axisId, choice, value }) => {
        const group = genesisAxisById(app.config, axisId);
        if (!group) return toolFail('unknown_axis', `Нет оси «${axisId}».`);
        const token = String(choice || '').trim();
        const lower = token.toLowerCase();
        if (lower === 'random') {
          if (!applySampledAxis(draft, app.config, axisId, 'sampled')) {
            return toolFail('sample_failed', `Не удалось семплировать ось «${axisId}».`);
          }
        } else if (lower === 'agent') {
          const pick = String(value || '').trim();
          if (pick && (group.values || []).some((v) => v.id === pick)) {
            draft.axes = setAxisValue(draft.axes, axisId, pick, 'agent');
          } else if (!applySampledAxis(draft, app.config, axisId, 'agent')) {
            return toolFail('sample_failed', `Не удалось выбрать ось «${axisId}».`);
          }
        } else {
          if (!(group.values || []).some((v) => v.id === token)) {
            return toolFail(
              'unknown_value',
              `Нет значения «${token}» у оси ${axisId}. Каталог: ${(group.values || []).map((v) => v.id).join(', ')}. Или random / agent.`,
            );
          }
          draft.axes = setAxisValue(draft.axes, axisId, token, 'player');
        }
        ensureInterview(draft);
        await saveDraft();
        const offer = nextAxisOffer(app.config, draft.axes);
        const uniqueNeeded =
          draft.mode === 'questions' && !offer && !draft.axisInterview.uniqueFeatureAsked;
        return {
          ok: true,
          axes: draft.axes,
          missingAxes: missingAxisIds(app.config, draft.axes),
          nextAxis: offer,
          uniqueFeatureNeeded: uniqueNeeded,
          hint: offer
            ? `Следующая ось «${offer.axisId}»: ${offer.prompt}`
            : uniqueNeeded
              ? 'Оси закрыты. Спроси уникальную фичу или set_unique_feature skip, затем request_city_concept.'
              : 'Оси закрыты. Вызови request_city_concept.',
        };
      },
    },
    {
      name: 'set_unique_feature',
      description:
        'Режим questions: уникальная изюминка после осей. text — формулировка игрока; skip=true — без изюминки.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          skip: { type: 'boolean' },
        },
      },
      handler: async ({ text: featureText, skip }) => {
        ensureInterview(draft);
        const raw = String(featureText || '').trim();
        if (skip || !raw) {
          draft.axisInterview.uniqueFeatureAsked = true;
          draft.axisInterview.uniqueFeature = null;
        } else {
          draft.axisInterview.uniqueFeatureAsked = true;
          draft.axisInterview.uniqueFeature = raw.slice(0, 400);
          draft.playerDirectives = mergePlayerDirectives(draft.playerDirectives, {
            preferred: [raw.slice(0, 400)],
          });
          if (!draft.playerBrief) draft.playerBrief = { city: '', ruler: '', freeform: '' };
          const prev = draft.playerBrief.freeform || '';
          if (!prev.includes(raw.slice(0, 40))) {
            draft.playerBrief.freeform = prev ? `${prev}\n${raw}` : raw;
            clipOnboardingBrief(draft.playerBrief);
          }
        }
        await saveDraft();
        return {
          ok: true,
          uniqueFeatureAsked: true,
          uniqueFeature: draft.axisInterview.uniqueFeature,
          next: 'Вызови request_city_concept.',
        };
      },
    },
    {
      name: 'set_player_directives',
      description: 'Добавить required / preferred / forbidden формулировки игрока.',
      parameters: {
        type: 'object',
        properties: {
          required: { type: 'array', items: { type: 'string' } },
          preferred: { type: 'array', items: { type: 'string' } },
          forbidden: { type: 'array', items: { type: 'string' } },
        },
      },
      handler: async (patch) => {
        draft.playerDirectives = mergePlayerDirectives(draft.playerDirectives, patch);
        await saveDraft();
        return { ok: true, playerDirectives: draft.playerDirectives };
      },
    },
    {
      name: 'record_cosmology_conflicts',
      description:
        'Записать конфликт космологии. Пока unresolved — нельзя показывать готовый город и стартовать.',
      parameters: {
        type: 'object',
        required: ['conflicts'],
        properties: {
          conflicts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                requested: { type: 'string' },
                reason: { type: 'string' },
                adaptations: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      handler: async ({ conflicts }) => {
        draft.playerDirectives = recordCosmologyConflicts(draft.playerDirectives, conflicts);
        draft.pitched = false;
        await saveDraft();
        return {
          ok: true,
          unresolved: draft.playerDirectives.unresolvedConflicts,
          hint: 'Назови игроку запрет своими словами и предложи адаптации. Не чини молча.',
        };
      },
    },
    {
      name: 'resolve_cosmology_conflict',
      description: 'Игрок выбрал адаптацию или отказался от запретной идеи.',
      parameters: {
        type: 'object',
        required: ['requested'],
        properties: {
          requested: { type: 'string' },
          chosenAdaptation: { type: 'string' },
          drop: { type: 'boolean', description: 'true — выкинуть идею в forbidden' },
        },
      },
      handler: async ({ requested, chosenAdaptation, drop }) => {
        draft.playerDirectives = resolveCosmologyConflict(draft.playerDirectives, {
          requested,
          chosenAdaptation,
          drop,
        });
        await saveDraft();
        return {
          ok: true,
          unresolved: draft.playerDirectives.unresolvedConflicts,
          next: hasUnresolvedConflicts(draft.playerDirectives)
            ? 'Есть ещё конфликты.'
            : 'Конфликтов нет. Можно request_city_concept.',
        };
      },
    },
    {
      name: 'request_city_concept',
      description:
        'Быстрый концепт: оси + краткое описание + проверка космологии. Без прогресс-бара. Генезис — только start_new_game.',
      parameters: { type: 'object', properties: {} },
      handler: async () => runCityConcept({ app, draft, userId, saveDraft, text }),
    },
    {
      name: 'set_player_brief',
      description:
        'Записать/обновить бриф пожеланий для генезиса. Формулировки игрока важнее краткости.',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string' },
          ruler: { type: 'string' },
          freeform: { type: 'string' },
          replace: { type: 'boolean' },
        },
      },
      handler: async ({ city, ruler, freeform, replace = false }) => {
        if (!draft.playerBrief) draft.playerBrief = { city: '', ruler: '', freeform: '' };
        if (replace) {
          draft.playerBrief = { city: city || '', ruler: ruler || '', freeform: freeform || '' };
        } else {
          if (city) draft.playerBrief.city = city;
          if (ruler) draft.playerBrief.ruler = ruler;
          if (freeform) draft.playerBrief.freeform = freeform;
        }
        clipOnboardingBrief(draft.playerBrief);
        const hits = scanBriefConflicts(draft);
        draft.phase = deriveOnboardingPhase(draft);
        await saveDraft();
        return {
          ok: true,
          playerBrief: draft.playerBrief,
          cosmologyHits: hits,
          hint: hits.length
            ? 'Есть очевидный запрет — назови игроку и record_cosmology_conflicts, не адаптируй молча.'
            : null,
        };
      },
    },
    {
      name: 'check_city_name',
      description: 'Проверить имя города: форма и свободно ли.',
      parameters: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
      handler: async ({ name }) => {
        const occupied = await app.occupiedCityNames(userId);
        const v = validateCityNameAvailable(name, occupied);
        if (!v.ok) {
          return { ok: true, available: false, name: String(name || '').trim(), reason: v.reason };
        }
        return { ok: true, available: true, name: v.name };
      },
    },
    {
      name: 'set_city_name',
      description: 'Зафиксировать имя города после check_city_name и согласия.',
      parameters: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
      handler: async ({ name }) => {
        const occupied = await app.occupiedCityNames(userId);
        const v = validateCityNameAvailable(name, occupied);
        if (!v.ok) {
          draft.cityNameApproved = false;
          await saveDraft();
          return toolFail(
            isCityNameOccupied(name, occupied) ? 'city_name_taken' : 'invalid_city_name',
            v.reason,
            { reason: v.reason },
          );
        }
        draft.cityName = v.name;
        draft.cityNameApproved = true;
        draft.pitchedName = v.name;
        draft.pitched = true;
        if (draft.concept?.status === 'READY') draft.concept.name = v.name;
        draft.phase = deriveOnboardingPhase(draft);
        await saveDraft();
        return { ok: true, cityName: v.name };
      },
    },
    {
      name: 'set_patron_name',
      description: 'Имя бога, как назвал игрок. Без этого start_new_game нельзя.',
      parameters: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
      handler: async ({ name }) => {
        const v = validatePatronName(name);
        if (!v.ok) {
          draft.patronNameApproved = false;
          await saveDraft();
          return toolFail('invalid_patron_name', v.reason, { reason: v.reason });
        }
        draft.patronName = v.name;
        draft.patronNameApproved = true;
        await saveDraft();
        return { ok: true, patronName: v.name };
      },
    },
    {
      name: 'start_new_game',
      description: 'Запуск longform. Нужны READY concept, нет конфликтов, имя города и имя бога.',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        const world = await app.storage.getWorld();
        const existing = await app.storage.getDomainForUser(userId, world.id);
        if (existing) {
          return toolFail(
            'already_has_domain',
            'У игрока уже есть домен в этом сезоне. Не запускай генерацию повторно.',
          );
        }
        if (hasUnresolvedConflicts(draft.playerDirectives)) {
          return toolFail(
            'unresolved_conflicts',
            'Сначала разреши конфликты космологии. Не стартуй генезис.',
          );
        }
        if (!hasReadyConcept(draft)) {
          return toolFail(
            'concept_required',
            'Сначала request_city_concept со статусом READY, покажи preview, дождись согласия.',
          );
        }
        if (!draft.cityNameApproved || !draft.cityName) {
          const occupied = await app.occupiedCityNames(userId);
          const fallback = draft.concept.name || lastPitchedCityName(draft);
          const v = fallback ? validateCityNameAvailable(fallback, occupied) : { ok: false };
          if (v.ok) {
            draft.cityName = v.name;
            draft.cityNameApproved = true;
            draft.concept.name = v.name;
            await saveDraft();
          } else {
            return toolFail(
              fallback && isCityNameOccupied(fallback, occupied)
                ? 'city_name_taken'
                : 'city_name_required',
              fallback && isCityNameOccupied(fallback, occupied)
                ? occupiedCityNameError(fallback)
                : 'Сначала set_city_name, затем start_new_game.',
            );
          }
        } else {
          const occupied = await app.occupiedCityNames(userId);
          const v = validateCityNameAvailable(draft.cityName, occupied);
          if (!v.ok) {
            draft.cityNameApproved = false;
            await saveDraft();
            return toolFail(
              isCityNameOccupied(draft.cityName, occupied) ? 'city_name_taken' : 'invalid_city_name',
              v.reason,
            );
          }
          if (draft.concept.name && draft.concept.name !== draft.cityName) {
            draft.concept.name = draft.cityName;
          }
        }
        if (!draft.patronName) {
          return toolFail(
            'patron_name_required',
            'Сначала set_patron_name с именем, которое придумал игрок.',
          );
        }
        if (app.isGenerating(userId)) return { ok: true, status: 'generating' };

        app.startDomainGeneration(userId, {
          channel,
          forcedName: draft.cityName,
          forcedPatronName: draft.patronName,
          frozenConcept: draft.concept,
          axes: draft.axes,
          playerDirectives: draft.playerDirectives,
          playerBrief: { ...(draft.playerBrief || {}) },
        });
        startFlag.started = true;
        return {
          ok: true,
          status: 'generating',
          cityName: draft.cityName,
          briefPreview: formatPlayerBrief(draft.playerBrief),
        };
      },
    },
  ];
}
