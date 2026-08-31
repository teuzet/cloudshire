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
const candidates = document.getElementById('candidates');
const candidatesMeta = document.getElementById('candidatesMeta');
const candidatesList = document.getElementById('candidatesList');

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
  return parts.join(' · ');
}

function renderCandidates(list, gravity) {
  if (!list?.length) {
    candidates.classList.add('hidden');
    candidatesMeta.textContent = '';
    candidatesList.innerHTML = '';
    return;
  }
  candidates.classList.remove('hidden');
  const g = String(gravity || '').trim();
  candidatesMeta.textContent = g ? `Gravity ${g} — одна посадка на всех трёх.` : '';
  candidatesList.innerHTML = list
    .map((v, i) => {
      const axes = axesLine(v);
      const n = v.index || i + 1;
      return `<article class="candidate"><strong>${esc(n)}. ${esc(v.title || 'кандидат')}</strong>${
        axes ? `<p class="axes">${esc(axes)}</p>` : ''
      }${seedFieldsHtml(v)}</article>`;
    })
    .join('');
}

function renderPlot(plot) {
  if (!plot) {
    plotCard.classList.add('hidden');
    plotCard.innerHTML = '';
    return;
  }
  const closes = (plot.closeWhen || []).map((x) => `<li>${esc(x)}</li>`).join('') || '<li class="muted">—</li>';
  const hidden = (plot.hiddenPremises || []).map((x) => `<li>${esc(x)}</li>`).join('') || '<li class="muted">нет тайны</li>';
  const axes = axesLine(plot);
  plotCard.classList.remove('hidden');
  plotCard.innerHTML = `
    <h2 class="plot-title">${esc(plot.title)}</h2>
    ${axes ? `<p class="axes">${esc(axes)}</p>` : ''}
    <p class="meta">${esc(plot.synopsis || '')}</p>
    ${plot.whyMoves ? `<p class="muted"><strong>whyMoves.</strong> ${esc(plot.whyMoves)}</p>` : ''}
    ${seedFieldsHtml(plot)}
    <p class="muted">urgency ${esc(plot.urgency)}${plot.gravity != null ? ` · gravity ${esc(plot.gravity)}` : ''}</p>
    <h2>closeWhen</h2>
    <ul>${closes}</ul>
    <h2>hiddenPremises (лаборатория)</h2>
    <ul>${hidden}</ul>
  `;
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

function renderArchitectPrompt(text) {
  const prompt = String(text || '');
  if (!prompt) {
    architectPrompt.classList.add('hidden');
    architectPromptText.textContent = '';
    return;
  }
  architectPrompt.classList.remove('hidden');
  architectPromptText.textContent = prompt;
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

  renderPlot(state.plot);
  seedForm.classList.remove('hidden');
  deedForm.classList.toggle('hidden', state.mode !== 'story');
  closedNote.classList.toggle('hidden', state.mode !== 'closed');
  const seedText = document.getElementById('seedText');
  const seedGravity = document.getElementById('seedGravity');
  seedText.value = state.lastChronicle || '';
  seedGravity.value = state.lastGravity || 'EPISODE';
  renderCandidates(state.lastCandidates, state.lastGravity);
  renderRejected(state.lastRejected, state.lastJudge);
  renderArchitectPrompt(state.lastArchitectPrompt);
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
  });
});

deedForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (pending) return;
  void post('/api/freeform/deed', {
    summary: document.getElementById('deedText').value,
    durationMonths: document.getElementById('deedMonths').value,
    finish: document.getElementById('deedFinish').value,
  });
});

document.getElementById('btnReset').addEventListener('click', () => {
  if (pending) return;
  void post('/api/freeform/reset', {});
});

void load();
