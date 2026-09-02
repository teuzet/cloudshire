const cityName = document.getElementById('cityName');
const gameDate = document.getElementById('gameDate');
const modeLabel = document.getElementById('modeLabel');
const banner = document.getElementById('banner');
const chronicle = document.getElementById('chronicle');
const plotCard = document.getElementById('plotCard');
const seedForm = document.getElementById('seedForm');
const deedForm = document.getElementById('deedForm');
const closedNote = document.getElementById('closedNote');
const rejected = document.getElementById('rejected');
const rejectedList = document.getElementById('rejectedList');
const judgeWhy = document.getElementById('judgeWhy');
const busy = document.getElementById('busy');
const architectPrompt = document.getElementById('architectPrompt');
const architectPromptText = document.getElementById('architectPromptText');
const judgePrompt = document.getElementById('judgePrompt');
const judgePromptText = document.getElementById('judgePromptText');
const repairPrompt = document.getElementById('repairPrompt');
const repairPromptText = document.getElementById('repairPromptText');
const finalJudgePrompt = document.getElementById('finalJudgePrompt');
const finalJudgePromptText = document.getElementById('finalJudgePromptText');
const assemblePrompt = document.getElementById('assemblePrompt');
const assemblePromptText = document.getElementById('assemblePromptText');
const endingsPrompt = document.getElementById('endingsPrompt');
const endingsPromptText = document.getElementById('endingsPromptText');
const urgencyPrompt = document.getElementById('urgencyPrompt');
const urgencyPromptText = document.getElementById('urgencyPromptText');
const alignPrompt = document.getElementById('alignPrompt');
const alignPromptText = document.getElementById('alignPromptText');
const beatArchitectPrompt = document.getElementById('beatArchitectPrompt');
const beatArchitectPromptText = document.getElementById('beatArchitectPromptText');
const beatJudgePrompt = document.getElementById('beatJudgePrompt');
const beatJudgePromptText = document.getElementById('beatJudgePromptText');
const beatRepairPrompt = document.getElementById('beatRepairPrompt');
const beatRepairPromptText = document.getElementById('beatRepairPromptText');
const beatFinalJudgePrompt = document.getElementById('beatFinalJudgePrompt');
const beatFinalJudgePromptText = document.getElementById('beatFinalJudgePromptText');
const beatTellPrompt = document.getElementById('beatTellPrompt');
const beatTellPromptText = document.getElementById('beatTellPromptText');
const promptTrail = document.getElementById('promptTrail');
const candidates = document.getElementById('candidates');
const candidatesMeta = document.getElementById('candidatesMeta');
const candidatesList = document.getElementById('candidatesList');
const beatVariants = document.getElementById('beatVariants');
const beatVariantsMeta = document.getElementById('beatVariantsMeta');
const beatVariantsList = document.getElementById('beatVariantsList');
const deedFields = document.getElementById('deedFields');
const btnDeed = document.getElementById('btnDeed');
const btnAutotick = document.getElementById('btnAutotick');
const btnUndo = document.getElementById('btnUndo');

let state = null;
let pending = false;

function esc(value) {
  return String(value ?? '').replace(/[&<>"]/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[c]));
}

function setBusy(on) {
  pending = on;
  busy.classList.toggle('hidden', !on);
  for (const btn of document.querySelectorAll('button')) btn.disabled = on;
}

function modeText(mode) {
  if (mode === 'story') return 'история';
  if (mode === 'closed') return 'закончена';
  if (mode === 'seeds') return 'затравки';
  return 'нет истории';
}

function seedFieldsHtml(v) {
  const chronicle = String(v?.chronicle || '').trim();
  if (chronicle) return `<p class="rejected-text">${esc(chronicle)}</p>`;
  const rows = [
    ['затравка', v?.hook],
    ['конфликт', v?.conflict],
    ['динамика', v?.dynamics],
    ['последствия', v?.consequences],
  ].filter(([, val]) => String(val || '').trim());
  if (!rows.length) {
    const body = v?.text || v?.premise || v?.whatHappens || '';
    return body ? `<p class="rejected-text">${esc(body)}</p>` : '';
  }
  return rows
    .map(([label, val]) => `<p class="rejected-text"><strong>${esc(label)}.</strong> ${esc(val)}</p>`)
    .join('');
}

function axesLine(v) {
  const parts = [v?.arena, v?.worldRelation, v?.conflictSource, v?.temporalShape]
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  const author = String(v?.authorName || '').trim();
  if (author) parts.push(`как ${author}`);
  return parts.join(' · ');
}

function fieldsEqual(a, b) {
  if (!a || !b) return false;
  const body = (v) => String(v?.chronicle || v?.text || v?.hook || '').trim();
  return body(a) === body(b);
}

function judgeHtml(review) {
  if (!review) return '';
  const issues = (review.issues || [])
    .map((x) => `<li><strong>${esc(x.code)}</strong> — ${esc(x.reason)}</li>`)
    .join('');
  const repair = String(review.repair || '').trim();
  return `<aside class="judge-notes">
    <p class="judge-verdict">${esc(review.verdict || 'PASS')}${
      review.summary ? ` — ${esc(review.summary)}` : ''
    }</p>
    ${issues ? `<ul>${issues}</ul>` : ''}
    ${repair ? `<p class="rejected-text"><strong>правка.</strong> ${esc(repair)}</p>` : '<p class="muted">без правки</p>'}
  </aside>`;
}

function renderCandidates(drafts, repaired, reviews, gravity, finalReviews, pickedIndex, didRepair = false) {
  const list = drafts?.length ? drafts : repaired;
  if (!list?.length) {
    candidates.classList.add('hidden');
    candidatesMeta.textContent = '';
    candidatesList.innerHTML = '';
    return;
  }
  candidates.classList.remove('hidden');
  const g = String(gravity || '').trim();
  candidatesMeta.textContent = g
    ? `Gravity ${g} — одна посадка на всех трёх. PASS первого судьи сразу в пул. Второй цикл только если PASS меньше двух.`
    : '';
  candidatesList.innerHTML = list
    .map((v, i) => {
      const axes = axesLine(v);
      const n = v.index || i + 1;
      const after = repaired?.[i];
      const review = reviews?.[i];
      const finalReview = finalReviews?.[i];
      const changed = after && !fieldsEqual(v, after);
      const picked = Number(pickedIndex) === Number(n);
      const afterBlock =
        didRepair && after
          ? `<h3>${changed ? 'После правки' : 'После правки — без изменений'}</h3>${
              changed ? seedFieldsHtml(after) : '<p class="muted">тот же текст</p>'
            }`
          : '';
      const finalBlock = finalReview
        ? `<h3>Второй судья</h3>${judgeHtml(finalReview)}`
        : '';
      return `<article class="candidate${picked ? ' picked' : ''}"><strong>${esc(n)}. ${esc(v.title || 'кандидат')}</strong>${
        picked ? '<p class="picked-mark">выбрана в историю</p>' : ''
      }${
        axes ? `<p class="axes">${esc(axes)}</p>` : ''
      }<h3>Черновик</h3>${seedFieldsHtml(v)}${judgeHtml(review)}${afterBlock}${finalBlock}</article>`;
    })
    .join('');
}

function renderPlot(plot, align = {}) {
  if (!plot) {
    plotCard.classList.add('hidden');
    plotCard.innerHTML = '';
    return;
  }
  const endings = (plot.endings || []).map((e) => `<li><code>${esc(e.id)}</code> [${esc(e.kind)}] ${esc(e.text)}</li>`).join('');
  const closes = !endings && (plot.closeWhen || []).map((x) => `<li>${esc(x)}</li>`).join('');
  const hidden = (plot.hiddenPremises || []).map((x) => `<li>${esc(x)}</li>`).join('') || '<li class="muted">нет тайны</li>';
  const axes = axesLine(plot);
  const urgency = plot.urgency != null ? `urgency ${esc(plot.urgency)}` : '';
  const countdown = plot.countdown != null ? `автотик через ${esc(plot.countdown)} мес.` : '';
  const gravity = plot.gravity != null ? `gravity ${esc(plot.gravity)}` : '';
  const depth = `глубина ${esc(plot.depth ?? 0)}/${esc(plot.maxDepth ?? '—')}`;
  const fails = `провалы ${esc(plot.failCount ?? 0)}/${esc(plot.maxFails ?? '—')}`;
  const alignLine = align.relation
    ? `связь ${esc(align.relation)}${align.endingId ? ` → ${esc(align.endingId)}` : ''}`
    : '';
  plotCard.classList.remove('hidden');
  plotCard.innerHTML = `
    <h2 class="plot-title">${esc(plot.title)}</h2>
    ${axes ? `<p class="axes">${esc(axes)}</p>` : ''}
    <p class="meta">${esc(plot.synopsis || '')}</p>
    ${plot.whyMoves ? `<p class="muted"><strong>whyMoves.</strong> ${esc(plot.whyMoves)}</p>` : ''}
    <p class="muted">${[urgency, countdown, gravity, depth, fails, alignLine].filter(Boolean).join(' · ')}</p>
    ${endings ? `<h2>endings</h2><ul>${endings}</ul>` : ''}
    ${closes ? `<h2>closeWhen</h2><ul>${closes}</ul>` : ''}
    <h2>hiddenPremises (лаборатория)</h2>
    <ul>${hidden}</ul>
  `;
}

function renderBeatVariants(list, judge, moveKind) {
  if (!list?.length) {
    beatVariants.classList.add('hidden');
    beatVariantsMeta.textContent = '';
    beatVariantsList.innerHTML = '';
    return;
  }
  beatVariants.classList.remove('hidden');
  const kind = moveKind === 'auto' ? 'автотик' : 'дело';
  const why = judge?.why ? `Судья: ${judge.why}` : '';
  const repair = judge?.repair ? `правка: ${judge.repair}` : '';
  beatVariantsMeta.textContent = [`Реакция на ${kind}.`, why, repair].filter(Boolean).join(' ');
  beatVariantsList.innerHTML = list
    .map((v) => {
      const n = v.index;
      const dyn = [v.dynamicName, v.dynamicHint].filter(Boolean).join(' — ');
      const ending = v.endingText ? `<p class="axes">концовка: ${esc(v.endingText)}</p>` : '';
      const picked = v.picked ? '<p class="picked-mark">выбрано</p>' : '';
      const planted =
        v.picked && v.chronicle
          ? `<h3>Посажено в город</h3><p class="rejected-text">${esc(v.chronicle)}</p>`
          : '';
      return `<article class="candidate${v.picked ? ' picked' : ''}"><strong>${esc(n)}. ${esc(
        v.dynamicName || v.title || 'продолжение',
      )}</strong>${picked}${
        dyn ? `<p class="axes">${esc(dyn)}</p>` : '<p class="muted">динамика не размечена</p>'
      }<p class="rejected-text">${esc(v.text || '')}</p>${ending}${planted}</article>`;
    })
    .join('');
}

function renderRejected(list, judge) {
  if (!list?.length && !judge?.why && !judge?.card) {
    rejected.classList.add('hidden');
    return;
  }
  rejected.classList.remove('hidden');
  const pickWhy = judge?.why
    ? `${judge.why}${judge.repair ? ` · починка: ${judge.repair}` : ''}`
    : '';
  const cardWhy = judge?.card
    ? `карточка: ${judge.card.verdict || '?'}${judge.card.summary ? ` — ${judge.card.summary}` : ''}${
        judge.card.repaired ? ' · починена' : ''
      }`
    : '';
  judgeWhy.textContent = [pickWhy, cardWhy].filter(Boolean).join('\n');
  rejectedList.innerHTML = (list || [])
    .map((v) => {
      const axes = axesLine(v);
      return `<div class="rejected-item"><strong>${esc(v.index)}. ${esc(v.title || 'вариант')}</strong>${
        axes ? `<p class="axes">${esc(axes)}</p>` : ''
      }${seedFieldsHtml(v)}</div>`;
    })
    .join('');
}

function renderPromptDump(el, pre, text, { showEmpty = false, emptyNote = 'не вызывался' } = {}) {
  const prompt = String(text || '');
  if (!prompt && !showEmpty) {
    el.classList.add('hidden');
    el.classList.remove('skipped');
    pre.textContent = '';
    return false;
  }
  el.classList.remove('hidden');
  if (!prompt) {
    el.classList.add('skipped');
    pre.textContent = emptyNote;
    return true;
  }
  el.classList.remove('skipped');
  pre.textContent = prompt;
  return true;
}

function renderPromptTrail(state) {
  const seed = [
    state.lastArchitectPrompt,
    state.lastJudgePrompt,
    state.lastRepairPrompt,
    state.lastFinalJudgePrompt,
    state.lastAssemblePrompt,
    state.lastEndingsPrompt,
    state.lastUrgencyPrompt,
  ];
  const showDeed = Boolean(state.lastBeatVariants?.length || state.lastAlignPrompt || state.lastMoveKind);
  const showSeed = !showDeed && seed.some(Boolean);
  promptTrail.classList.toggle('hidden', !showSeed && !showDeed);

  renderPromptDump(architectPrompt, architectPromptText, state.lastArchitectPrompt, { showEmpty: showSeed });
  renderPromptDump(judgePrompt, judgePromptText, state.lastJudgePrompt, { showEmpty: showSeed });
  renderPromptDump(repairPrompt, repairPromptText, state.lastRepairPrompt, {
    showEmpty: showSeed,
    emptyNote: 'не вызывался — PASS уже хватило или правки не было',
  });
  renderPromptDump(finalJudgePrompt, finalJudgePromptText, state.lastFinalJudgePrompt, {
    showEmpty: showSeed,
    emptyNote: 'не вызывался — PASS уже хватило',
  });
  renderPromptDump(assemblePrompt, assemblePromptText, state.lastAssemblePrompt, {
    showEmpty: showSeed,
    emptyNote: 'не вызывался — нет PASS',
  });
  renderPromptDump(endingsPrompt, endingsPromptText, state.lastEndingsPrompt, {
    showEmpty: showSeed || showDeed,
    emptyNote: 'не вызывался',
  });
  renderPromptDump(urgencyPrompt, urgencyPromptText, state.lastUrgencyPrompt, {
    showEmpty: showSeed || showDeed,
    emptyNote: 'не вызывался',
  });

  renderPromptDump(alignPrompt, alignPromptText, state.lastAlignPrompt, {
    showEmpty: showDeed && state.lastMoveKind !== 'auto',
    emptyNote: 'не вызывался — автотик, ручной override или ход не дошёл',
  });
  renderPromptDump(beatArchitectPrompt, beatArchitectPromptText, state.lastBeatArchitectPrompt, {
    showEmpty: showDeed,
    emptyNote: 'не вызывался — дело UNRELATED или ход не дошёл',
  });
  renderPromptDump(beatJudgePrompt, beatJudgePromptText, state.lastBeatJudgePrompt, {
    showEmpty: showDeed,
    emptyNote: 'не вызывался — один кандидат, UNRELATED или ход не дошёл',
  });
  renderPromptDump(beatRepairPrompt, beatRepairPromptText, state.lastBeatRepairPrompt, {
    showEmpty: showDeed,
    emptyNote: 'не вызывался — PASS уже хватило или правки не было',
  });
  renderPromptDump(beatFinalJudgePrompt, beatFinalJudgePromptText, state.lastBeatFinalJudgePrompt, {
    showEmpty: showDeed,
    emptyNote: 'не вызывался — PASS уже хватило',
  });
  renderPromptDump(beatTellPrompt, beatTellPromptText, state.lastBeatTellPrompt, {
    showEmpty: showDeed,
    emptyNote: 'не вызывался — дело UNRELATED или ход не дошёл',
  });
}

function render() {
  if (!state) return;
  cityName.textContent = state.cityName || 'Город';
  gameDate.textContent = state.date || '';
  modeLabel.textContent = modeText(state.mode);

  if (state.lastWarning) {
    banner.textContent = state.lastWarning;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }

  const plotId = state.plot?.id;
  chronicle.innerHTML = (state.chronicles || [])
    .map((e) => {
      const mine = plotId && (e.relatedPlotlineIds || []).includes(plotId);
      return `<li class="${mine ? 'mine' : ''}"><div class="when">${esc(e.gameDateLabel)}</div>${esc(e.text)}</li>`;
    })
    .join('');

  renderPlot(state.plot, {
    relation: state.lastAlignRelation,
    endingId: state.lastAlignEndingId,
  });
  const seeded = state.mode === 'story' || state.mode === 'closed';
  const playing = state.mode === 'story';
  seedForm.classList.toggle('hidden', seeded);
  deedForm.classList.toggle('hidden', !seeded);
  deedFields.classList.toggle('hidden', !playing);
  btnDeed.classList.toggle('hidden', !playing);
  btnAutotick.classList.toggle('hidden', !playing);
  btnUndo.classList.toggle('hidden', !state.canUndo);
  closedNote.classList.toggle('hidden', state.mode !== 'closed');
  const seedText = document.getElementById('seedText');
  const seedGravity = document.getElementById('seedGravity');
  const seedMystery = document.getElementById('seedMystery');
  seedText.value = state.lastChronicle || '';
  seedGravity.value = state.lastGravity || 'EPISODE';
  seedMystery.checked = Boolean(state.lastRequireMystery);
  if (seeded) {
    candidates.classList.add('hidden');
    candidatesMeta.textContent = '';
    candidatesList.innerHTML = '';
  } else {
    renderCandidates(
      state.lastDrafts,
      state.lastCandidates,
      state.lastJudgeReviews,
      state.lastGravity,
      state.lastFinalReviews,
      state.lastPickedIndex,
      Boolean(state.lastRepairPrompt),
    );
  }
  renderBeatVariants(state.lastBeatVariants, state.lastJudge, state.lastMoveKind);
  renderRejected(seeded ? [] : state.lastRejected, seeded ? null : state.lastJudge);
  renderPromptTrail(state);
}

async function load() {
  const res = await fetch('/api/freeform/state');
  state = await res.json();
  render();
}

async function post(url, body) {
  setBusy(true);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (data.state) state = data.state;
    else if (data.cityName || data.mode) state = data;
    if (!res.ok) {
      banner.textContent = data.error || res.statusText;
      banner.classList.remove('hidden');
    }
    render();
  } finally {
    setBusy(false);
  }
}

seedForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (pending) return;
  void post('/api/freeform/seed', {
    text: document.getElementById('seedText').value,
    gravity: document.getElementById('seedGravity').value,
    mystery: document.getElementById('seedMystery').checked,
  });
});

document.getElementById('btnSeedCity').addEventListener('click', () => {
  if (pending) return;
  void post('/api/freeform/seed', {
    fromCity: true,
    gravity: document.getElementById('seedGravity').value,
    mystery: document.getElementById('seedMystery').checked,
  });
});

document.getElementById('btnSeedVoid').addEventListener('click', () => {
  if (pending) return;
  void post('/api/freeform/seed', {
    fromVoid: true,
    gravity: document.getElementById('seedGravity').value,
    mystery: document.getElementById('seedMystery').checked,
  });
});

deedForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (pending) return;
  void post('/api/freeform/deed', {
    summary: document.getElementById('deedText').value,
    durationMonths: document.getElementById('deedMonths').value,
    finish: document.getElementById('deedFinish').value,
    relation: document.getElementById('deedRelation').value,
    endingId: document.getElementById('deedEndingId').value,
  });
});

document.getElementById('btnAutotick').addEventListener('click', () => {
  if (pending) return;
  void post('/api/freeform/autotick', {});
});

document.getElementById('btnUndo').addEventListener('click', () => {
  if (pending) return;
  void post('/api/freeform/undo', {});
});

document.getElementById('btnReset').addEventListener('click', () => {
  if (pending) return;
  void post('/api/freeform/reset', {});
});

void load();
