const $ = (id) => document.getElementById(id);
const STORE_KEY = 'cloudshire.play.userId';

let userId = localStorage.getItem(STORE_KEY) || 'local-user';
let lastStats = {};
let renderedCount = -1;
let lastGenerating = false;
let busy = false;
let inspectTab = 'city';
let inspectData = null;
let lastCityDay = null;
let canDev = false;

$('userId').value = userId;

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || res.statusText);
  return data;
}

function bubble(role, content, meta) {
  const el = document.createElement('div');
  el.className = `bubble ${role}`;
  if (meta) {
    const m = document.createElement('span');
    m.className = 'meta';
    m.textContent = meta;
    el.appendChild(m);
  }
  el.appendChild(document.createTextNode(content));
  return el;
}

function renderStats(stats) {
  const row = $('statsRow');
  row.innerHTML = '';
  for (const s of stats || []) {
    const prev = lastStats[s.id];
    const delta = prev == null ? 0 : s.value - prev;
    const el = document.createElement('div');
    el.className = 'stat';
    el.innerHTML =
      `<b>${s.name}</b> <span class="val">${s.value}</span>` +
      (delta ? ` <span class="delta ${delta > 0 ? 'up' : 'down'}">${delta > 0 ? '+' : ''}${delta}</span>` : '') +
      ` <span class="muted">${s.epithet}</span>`;
    row.appendChild(el);
  }
  lastStats = Object.fromEntries((stats || []).map((s) => [s.id, s.value]));
}

function renderHistory(history, tutorial = null) {
  const box = $('messages');
  box.innerHTML = '';
  if (!history.length && !tutorial) {
    box.appendChild(
      bubble('ruler', 'Скажи что-нибудь — проводник поможет создать город и познакомит с правителем.', 'начало'),
    );
    return;
  }
  for (const m of history) {
    if (m.role === 'user') {
      box.appendChild(bubble('user', m.content));
    } else if (m.kind === 'tick_news') {
      box.appendChild(bubble('news', m.content, 'письмо о месяце'));
    } else if (m.kind === 'conflux_announce') {
      box.appendChild(bubble('news', m.content, 'сопряжение на горизонте'));
    } else if (m.kind === 'conflux_approach') {
      box.appendChild(bubble('news', m.content, 'остров близко'));
    } else if (m.kind === 'genesis_tutorial') {
      box.appendChild(bubble('news', m.content, 'пока остров собирается'));
    } else if (m.kind === 'game_date') {
      box.appendChild(bubble('news', m.content, 'календарь'));
    } else if (m.kind === 'onboarding') {
      box.appendChild(bubble('ruler', m.content, 'проводник'));
    } else if (m.kind === 'system') {
      box.appendChild(bubble('news', m.content, 'система'));
    } else if (m.kind === 'ruler_hold') {
      box.appendChild(bubble('ruler', m.content, 'ещё думает'));
    } else {
      box.appendChild(bubble('ruler', m.content));
    }
  }
  if (tutorial) {
    box.appendChild(bubble('news', tutorial, 'пока остров собирается'));
  }
  box.scrollTop = box.scrollHeight;
}

function confluxMark(island) {
  const c = island?.conflux;
  if (!c) return island?.draft ? 'черновик' : '';
  if (c.status === 'docked') return c.partnerName ? `сопряжение · ${c.partnerName}` : 'сопряжение';
  if (c.status === 'approaching') {
    const left = c.monthsUntilDock;
    const when = left == null ? '' : left <= 0 ? 'скоро' : `${left} мес.`;
    return c.partnerName ? `близко · ${c.partnerName}${when ? ` · ${when}` : ''}` : 'близко';
  }
  return '';
}

function renderIslands(islands) {
  const box = $('islandList');
  box.innerHTML = '';
  const list = islands || [];
  if (!list.length) {
    const empty = document.createElement('span');
    empty.className = 'muted small';
    empty.textContent = 'Островов пока нет — «+ город» заведёт второй слот.';
    box.appendChild(empty);
  }
  for (const island of list) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `island-chip${island.userId === userId ? ' active' : ''}`;
    btn.dataset.userId = island.userId;
    const mark = confluxMark(island);
    const name = document.createElement('span');
    name.textContent = island.name;
    btn.appendChild(name);
    if (mark) {
      const extra = document.createElement('span');
      extra.className = 'mark';
      extra.textContent = mark;
      btn.appendChild(extra);
    }
    btn.title = island.ruler ? `${island.name} · ${island.ruler}` : island.name;
    btn.addEventListener('click', () => void switchTo(island.userId));
    box.appendChild(btn);
  }

  const current = list.find((i) => i.userId === userId);
  const neighborId = current?.conflux?.partnerUserId;
  const btnN = $('btnNeighbor');
  if (neighborId && neighborId !== userId) {
    btnN.classList.remove('hidden');
    btnN.textContent = current.conflux.partnerName
      ? `к соседу «${current.conflux.partnerName}»`
      : 'к соседу';
    btnN.dataset.userId = neighborId;
  } else {
    btnN.classList.add('hidden');
    btnN.dataset.userId = '';
  }
}

async function switchTo(nextId) {
  const next = String(nextId || '').trim() || 'local-user';
  if (next === userId) return;
  userId = next;
  $('userId').value = next;
  localStorage.setItem(STORE_KEY, next);
  renderedCount = -1;
  lastStats = {};
  inspectData = null;
  await refresh({ force: true });
  await refreshInspector();
}

function setBanner(text) {
  const el = $('banner');
  if (!text) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  el.textContent = text;
  el.classList.remove('hidden');
}

async function renderSaves() {
  const box = $('saveList');
  if (!box || $('savesBox').classList.contains('hidden')) return;
  try {
    const data = await api('/api/play/snapshots');
    const list = data.snapshots || [];
    if (!list.length) {
      box.innerHTML = '<p class="muted small">Снимков пока нет.</p>';
      return;
    }
    box.innerHTML = list
      .map((s) => {
        const title = s.label || s.worldName || s.dateLabel || s.id;
        const islands =
          typeof s.domainCount === 'number' ? `островов: ${s.domainCount}` : (s.cityNames || []).join(', ');
        const meta = [s.dateLabel, islands].filter(Boolean).join(' · ');
        return (
          `<div class="save-row" data-id="${esc(s.id)}">` +
          `<div><div>${esc(title)}</div><div class="meta">${esc(meta)}</div></div>` +
          `<div class="actions">` +
          `<button type="button" class="ghost" data-load="${esc(s.id)}">загрузить</button>` +
          `<button type="button" class="ghost danger" data-drop="${esc(s.id)}">удалить</button>` +
          `</div></div>`
        );
      })
      .join('');
  } catch (err) {
    box.textContent = err.message;
  }
}

async function refresh({ force = false } = {}) {
  try {
    const state = await api(`/api/play/state?userId=${encodeURIComponent(userId)}`);
    $('gameDate').textContent = state.clockHeld
      ? `${state.gameDate?.label || ''} · пауза`
      : (state.gameDate?.label || '');
    if (state.domain) {
      $('cityName').textContent = state.domain.name;
      $('rulerName').textContent = state.domain.ruler
        ? `${state.domain.ruler.name}, ${state.domain.ruler.title || 'правитель'}`
        : '';
      renderStats(state.domain.stats);
      const img = $('cityImage');
      if (state.domain.imageUrl) {
        if (img.getAttribute('src') !== state.domain.imageUrl) img.src = state.domain.imageUrl;
        img.alt = state.domain.name;
        img.classList.remove('hidden');
      } else {
        img.removeAttribute('src');
        img.alt = '';
        img.classList.add('hidden');
      }
    } else {
      $('cityName').textContent = 'Города пока нет';
      $('rulerName').textContent = '';
      $('statsRow').innerHTML = '';
      const img = $('cityImage');
      img.removeAttribute('src');
      img.alt = '';
      img.classList.add('hidden');
    }

    const tutorial = state.generating ? state.genesisTutorial || null : null;
    if (force || state.history.length !== renderedCount || state.generating !== lastGenerating) {
      renderHistory(state.history, tutorial);
      renderedCount = state.history.length;
      lastGenerating = Boolean(state.generating);
    }

    $('skipBox').classList.toggle('hidden', !state.canForceTick);
    $('btnTick').disabled = Boolean(state.ticking || state.generating);
    $('skipDays').disabled = Boolean(state.ticking || state.generating);
    $('btnClock').classList.toggle('hidden', !state.canForceTick);
    $('btnClock').disabled = Boolean(state.ticking || state.generating);
    $('btnClock').textContent = state.clockHeld ? 'время' : 'пауза';
    $('btnClock').title = state.clockHeld
      ? 'Снова пустить игровое время'
      : 'Остановить время: дела и истории сами не наступают';
    $('btnSeed').classList.toggle('hidden', !state.canForceTick);
    $('btnSeed').disabled = Boolean(state.ticking || state.generating);
    $('btnWipe').classList.toggle('hidden', !state.canWipe);
    $('wipeNote').hidden = !state.canWipe;
    $('savesBox').classList.toggle('hidden', !state.canWipe);
    $('btnWipe').disabled = Boolean(state.ticking);
    if (state.canWipe && !$('slots').classList.contains('hidden')) await renderSaves();
    renderIslands(state.islands || []);
    const nextDev = Boolean(state.canForceTick);
    if (nextDev !== canDev) {
      canDev = nextDev;
      if (!$('inspector').classList.contains('hidden')) renderInspector();
    } else {
      canDev = nextDev;
    }

    if (state.generating) {
      setBanner(state.generatingProgress || 'Остров создаётся — правитель напишет сам, это минута-две.');
    } else if (state.ticking) setBanner('Идёт шаг времени на сопряжении.');
    else if (state.clockHeld) setBanner('Время стоит. Дела и истории сами не тикают; промотать — вручную.');
    else setBanner('');

    // Справочник перечитываем, когда мир реально сдвинулся на день, а не по таймеру.
    const day = state.gameDate?.day ?? null;
    if (cityPanelOpen() && day != null && day !== lastCityDay) reloadCityFrame();
    lastCityDay = day;

    await refreshInspector();
  } catch (err) {
    setBanner(`Сервер недоступен: ${err.message}`);
  }
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('text').value.trim();
  if (!text || busy) return;
  busy = true;
  $('send').disabled = true;
  $('messages').appendChild(bubble('user', text));
  let pending = bubble('ruler', '…', 'печатает');
  pending.classList.add('pending');
  $('messages').appendChild(pending);
  $('messages').scrollTop = $('messages').scrollHeight;
  $('text').value = '';
  const holdPoll = setInterval(async () => {
    try {
      const state = await api(`/api/play/state?userId=${encodeURIComponent(userId)}`);
      const hold = [...(state.pushes || [])].reverse().find((p) => p.kind === 'ruler_hold');
      if (hold?.content && document.body.contains(pending)) {
        const next = bubble('ruler', hold.content, 'ещё думает');
        pending.replaceWith(next);
        pending = next;
        $('messages').scrollTop = $('messages').scrollHeight;
      }
    } catch {
      /* ход ещё идёт */
    }
  }, 2000);
  try {
    const result = await api('/api/play/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, text }),
    });
    // Ответ показываем сразу: перерисовка по state придёт следующим шагом.
    if (result.reply) {
      pending.remove();
      const label = { onboarding: 'проводник', system: 'система' }[result.agent] || null;
      $('messages').appendChild(bubble(result.agent === 'system' ? 'news' : 'ruler', result.reply, label));
      $('messages').scrollTop = $('messages').scrollHeight;
    }
  } catch (err) {
    setBanner(err.message);
  } finally {
    clearInterval(holdPoll);
    pending.remove();
    busy = false;
    $('send').disabled = false;
    await refresh({ force: true });
    // Ход правителя мог завести дело или снять его — справочник устарел даже
    // без смены дня.
    if (cityPanelOpen()) reloadCityFrame();
    $('text').focus();
  }
});

// ---------------------------------------------------------------- инспектор

function esc(value) {
  return String(value ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function block(title, body) {
  return `<section class="ins-block"><h3>${esc(title)}</h3>${body}</section>`;
}

function keyVals(pairs) {
  const rows = pairs
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `<div class="kv"><span class="muted">${esc(k)}</span><span>${esc(v)}</span></div>`)
    .join('');
  return `<div class="kvs">${rows}</div>`;
}

/**
 * Настройки вестей одной строкой. `triggers` — объект флагов, а не список:
 * инспектор показывает состояние домена как есть, не переупаковывая его.
 */
function notifyLine(notify) {
  if (!notify) return null;
  const raw = notify.triggers;
  const on = Array.isArray(raw)
    ? raw
    : Object.keys(raw || {}).filter((k) => raw[k]);
  return `${notify.intensity || '?'} · ${on.length ? on.join(', ') : 'ничего'}`;
}

function renderCityTab(d) {
  const out = [];
  out.push(
    block(
      'Город',
      keyVals([
        ['имя', d.name],
        ['id', d.id],
        ['статус', d.status],
        ['канал', d.channel],
        ['население', d.population],
        ['покровителя зовут', d.patronName || 'ещё не назван'],
        ['вера', d.faith != null ? d.faith : null],
        // Мана дробная: показываем и целое, как видит игрок, и точное значение.
        ['мана', d.mana != null ? `${Math.floor(d.mana)} / 100 (${Number(d.mana).toFixed(2)})` : null],
        ['вести', notifyLine(d.notify)],
        ['основан на тике', d.createdTick],
        ['последний тик', d.lastTickAt],
      ]),
    ),
  );
  out.push(
    block(
      'Статы',
      keyVals(
        (d.stats || []).map((s) => [
          s.name,
          `${s.value} · ${s.epithet}${s.exact != null && s.exact !== s.value ? ` (${s.exact})` : ''}`,
        ]),
      ),
    ),
  );
  if (d.characters?.length) {
    out.push(
      block(
        'Правитель',
        keyVals(
          d.characters.flatMap((ch) => [
            ['имя', `${ch.name}${ch.title ? `, ${ch.title}` : ''}`],
            ...(ch.ageYears != null ? [['возраст', `${ch.ageYears} лет`]] : []),
            ['верность / страх', `${ch.loyalty ?? '—'} / ${ch.terror ?? '—'}`],
          ]),
        ),
      ),
    );
  }
  if (d.description) out.push(block('Описание острова', `<p class="pre">${esc(d.description)}</p>`));
  if (d.tags?.length) out.push(block('Метки', `<p>${esc(d.tags.join(', '))}</p>`));
  const c = d.conflux;
  out.push(
    block(
      'Сопряжение',
      c
        ? keyVals([
            ['статус', c.status],
            ['партнёр', c.partnerName],
            ['до сопряжения, мес.', c.monthsUntilDock],
            ['в сопряжении, мес.', `${c.monthsDocked}/${c.durationMonths}`],
            ['повторная', c.rematch ? 'да' : 'нет'],
            ['проход', c.contact ? `${c.contact.kind || '?'} — ${c.contact.description || ''}` : null],
            ['контроль прохода', c.contact?.control || null],
          ])
        : `<p class="muted">сейчас остров идёт один</p>`,
    ) +
      block(
        'Счёт сопряжений',
        keyVals([
          ['месяцев в соло', d.confluxHistory?.monthsSolo],
          ['месяцев в сопряжении', d.confluxHistory?.monthsDocked],
          ['прежние партнёры', Object.keys(d.confluxHistory?.partners || {}).length || '—'],
        ]),
      ),
  );
  if (d.monthLog?.length) {
    out.push(
      block(
        'Журнал этого месяца',
        `<ul>${d.monthLog.map((m) => `<li>${esc(m.text || m)}</li>`).join('')}</ul>`,
      ),
    );
  }
  return out.join('');
}

const ENDING_KIND_LABEL = {
  GOOD_ENDING: 'хорошая',
  NEUTRAL_ENDING: 'никакая',
  BAD_ENDING: 'плохая',
};

/**
 * Скрытый слой двух типов: разгадка и независимые подступы к ней.
 * Раскрытое переезжает в «город выяснил», но тип у пункта тот же.
 */
function plotFactsBlock(p) {
  const hiddenPremises = Array.isArray(p.hiddenPremises) ? p.hiddenPremises : [];
  const revealedPremises = Array.isArray(p.revealedPremises) ? p.revealedPremises : [];
  const hiddenRows = [
    p.hiddenAnswer ? `<li><b>разгадка:</b> ${esc(p.hiddenAnswer)}</li>` : '',
    ...hiddenPremises.map((t) => `<li>подступ: ${esc(t)}</li>`),
  ]
    .filter(Boolean)
    .join('');
  const knownRows = [
    p.revealedAnswer ? `<li><b>разгадано:</b> ${esc(p.revealedAnswer)}</li>` : '',
    ...revealedPremises.map((t) => `<li>подступ: ${esc(t)}</li>`),
  ]
    .filter(Boolean)
    .join('');
  const inspectHasLayer = Array.isArray(p.hiddenPremises) || Boolean(p.hiddenAnswer);
  return {
    known: knownRows
      ? `<p class="small muted">город выяснил:</p><ul class="small">${knownRows}</ul>`
      : '',
    hidden: !inspectHasLayer
      ? ''
      : hiddenRows
        ? `<p class="small muted">на самом деле:</p><ul class="small">${hiddenRows}</ul>`
        : '<p class="small muted">на самом деле: скрытого слоя нет</p>',
  };
}

/** Что дело выясняет, если сработает: саму разгадку, подступ, или ничего. */
function deedSecretAim(p) {
  const bits = [
    p.reachesAnswer ? '<p class="small muted">целится в разгадку</p>' : '',
    p.premiseText ? `<p class="small muted">подступ: ${esc(p.premiseText)}</p>` : '',
  ].filter(Boolean);
  return bits.join('');
}

/**
 * Концовки — список вариантов, а не одна строка.
 *
 * `closeWhen` у нити со ставками — это все её концовки сразу. Склеенные через
 * запятую они читались как один длинный исход, и понять, что чем кончится,
 * было нельзя.
 */
function endingExtra(e) {
  const bits = [];
  if (e?.questionGone) bits.push(`<div class="muted small">вопрос снят: ${esc(e.questionGone)}</div>`);
  if (e?.nowDifferent) bits.push(`<div class="muted small">теперь иначе: ${esc(e.nowDifferent)}</div>`);
  return bits.join('');
}

function endingsBlock(p) {
  const list = (p.endings || []).filter((e) => e && e.text);
  const closed = p.ending && typeof p.ending === 'object' ? p.ending : null;
  const happened = closed?.text
    ? `<p class="small">случилось: <b>${esc(ENDING_KIND_LABEL[closed.kind] || closed.kind || '?')}</b> — ${esc(closed.text)}</p>`
    : closed?.kind
      ? `<p class="small">случилось: <b>${esc(ENDING_KIND_LABEL[closed.kind] || closed.kind)}</b></p>`
      : '';

  if (list.length) {
    const rows = list
      .map((e) => {
        const hit = closed?.endingId && closed.endingId === e.id;
        const label = ENDING_KIND_LABEL[e.kind] || e.kind || '?';
        return (
          `<li${hit ? ' class="hit"' : ''}>` +
          `<span class="muted small">${esc(label)}${hit ? ' · случилась' : ''}</span> ${esc(e.text)}` +
          endingExtra(e) +
          `</li>`
        );
      })
      .join('');
    const head = closed ? 'чем могло кончиться:' : 'чем может кончиться:';
    return `${happened}<p class="small muted">${head}</p><ul class="small endings">${rows}</ul>`;
  }

  const closeWhen = Array.isArray(p.closeWhen) ? p.closeWhen.filter(Boolean) : p.closeWhen ? [p.closeWhen] : [];
  if (!closeWhen.length) return happened;
  if (closeWhen.length === 1) {
    return `${happened}<p class="small muted">закроется, когда: ${esc(closeWhen[0])}</p>`;
  }
  const rows = closeWhen.map((t) => `<li>${esc(t)}</li>`).join('');
  return `${happened}<p class="small muted">закроется, когда:</p><ul class="small endings">${rows}</ul>`;
}

function plotChroniclesBlock(p) {
  const list = p.chronicles || [];
  if (!list.length) return '<p class="small muted">хроники этой нити нет</p>';
  const rows = list
    .map((e) => {
      const meta = [e.gameDateLabel, e.importance, e.author].filter(Boolean).join(' · ');
      return (
        `<li>` +
        (meta ? `<div class="muted small">${esc(meta)}</div>` : '') +
        `<div class="pre">${esc(e.text)}</div>` +
        `</li>`
      );
    })
    .join('');
  return `<p class="small muted">хроника нити (${list.length}):</p><ul class="small plot-chron">${rows}</ul>`;
}

function plotCard(p, names = {}) {
  const concerns = (p.concernsDomainIds || [])
    .map((id) => names[id] || id)
    .filter(Boolean);
  const host = p.hostDomainId ? names[p.hostDomainId] || p.hostDomainId : null;
  const meta = [
    p.kind,
    p.storyType === 'story' ? 'история' : p.storyType === 'freeform' ? 'сопряжение' : null,
    p.urgency != null ? `срочность ${p.urgency}` : null,
    p.gravity != null ? `масштаб ${p.gravity}` : null,
    p.maxDepth != null
      ? `глубина ${Math.round((Number(p.depth) || 0) * 10) / 10}/${p.maxDepth}`
      : null,
    p.maxFails != null ? `провалов ${p.failCount ?? 0}/${p.maxFails}` : null,
    p.isMainConflux ? 'главная нить сопряжения' : null,
    p.shared ? 'общая' : concerns.length ? 'локальная' : null,
    p.sharedReason ? `стала общей: ${p.sharedReason}` : null,
    host ? `хозяин: ${host}` : null,
    concerns.length ? `касается: ${concerns.join(', ')}` : null,
    `жар ${p.temperature}`,
    `возраст ${p.ageMonths}/${p.maxAgeMonths}`,
    `битов ${p.beatCount}`,
    p.mirrorOf ? 'зеркало' : null,
    p.partnerGone ? 'партнёр ушёл' : null,
    p.status === 'closed' || p.closeReason || p.reason
      ? `закрыта: ${p.closeReason || p.reason}`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  // Нависшее целиком, вместе со скрытым: справочник игрока показывает только
  // известное, а отлаживать сроки надо по всем счётчикам.
  const threats = (p.threats || [])
    .map((t) => {
      const bits = [
        t.outcome === 'neutral' ? 'разрешение' : t.severity || 'угроза',
        t.known ? 'город знает' : 'скрыто',
        `${t.remainingDays ?? '?'} из ${t.totalDays ?? '?'} дн.`,
      ]
        .filter(Boolean)
        .join(' · ');
      const fire =
        canDev && t.id
          ? `<button type="button" class="force-btn danger" data-fire-threat="${esc(t.id)}" data-plot="${esc(p.id)}">сработать</button>`
          : '';
      return `<li>${esc(t.text)} <span class="muted small">${esc(bits)}</span>${fire}</li>`;
    })
    .join('');
  const facts = plotFactsBlock(p);
  const ladder = (p.discoveryLadder || [])
    .map((r) => {
      const label = r.promise || r.text || r.id || '';
      if (!label) return '';
      return `<li>${esc(label)} <span class="muted small">${esc(r.revealed ? 'открыто' : 'скрыто')}</span></li>`;
    })
    .filter(Boolean)
    .join('');
  const truth = p.truth ? `<p class="small muted">истина: ${esc(p.truth)}</p>` : '';
  return (
    `<article class="ins-card"><h4>${esc(p.title)}</h4>` +
    `<div class="muted small">${esc(meta)}</div>` +
    (p.synopsis ? `<p class="pre">${esc(p.synopsis)}</p>` : '') +
    (p.cause ? `<p class="small muted">первопричина: ${esc(p.cause)}</p>` : '') +
    (p.whyMoves ? `<p class="small muted">если не займутся: ${esc(p.whyMoves)}</p>` : '') +
    facts.known +
    facts.hidden +
    truth +
    (ladder ? `<p class="small muted">лестница:</p><ul class="small">${ladder}</ul>` : '') +
    (threats ? `<p class="small muted">нависло:</p><ul class="small threats">${threats}</ul>` : '') +
    plotChroniclesBlock(p) +
    endingsBlock(p) +
    (p.relatedStats?.length
      ? `<p class="small muted">статы: ${esc(p.relatedStats.join(', '))}</p>`
      : '') +
    (p.relatedProcessIds?.length
      ? `<p class="small muted">дела: ${esc(p.relatedProcessIds.join(', '))}</p>`
      : '') +
    `<p class="small muted">${esc(p.id)}</p>` +
    (canDev && p.canDrop
      ? `<div class="row-actions"><button type="button" class="drop-btn" data-drop="${esc(p.id)}">снять с хроникой</button></div>`
      : canDev && p.kind === 'story' && !p.shared && !p.isMainConflux
        ? '<p class="small muted">снять нельзя: на истории ещё есть дело</p>'
        : '') +
    `</article>`
  );
}

function loreCards(list, empty = 'пусто') {
  if (!list?.length) return `<p class="muted">${esc(empty)}</p>`;
  return list
    .map((f) => {
      const meta = [f.gameDateLabel, f.importance, f.author, (f.tags || []).join(', ')]
        .filter(Boolean)
        .join(' · ');
      return (
        `<article class="ins-card">` +
        (meta ? `<div class="muted small">${esc(meta)}</div>` : '') +
        `<p class="pre">${esc(f.text)}</p></article>`
      );
    })
    .join('');
}

function seedFormHtml() {
  if (!canDev) return '';
  return (
    '<form class="seed-form" data-seed-form="1">' +
    '<label>масштаб<select name="gravity">' +
    '<option value="SITUATION">SITUATION</option>' +
    '<option value="EPISODE" selected>EPISODE</option>' +
    '<option value="CRISIS">CRISIS</option>' +
    '<option value="RUPTURE">RUPTURE</option>' +
    '</select></label>' +
    '<label>зерно<select name="grain">' +
    '<option value="genesis">описание города</option>' +
    '<option value="chronicle">недавняя хроника</option>' +
    '<option value="void">пустота</option>' +
    '</select></label>' +
    '<label class="seed-mystery"><input type="checkbox" name="mystery" />посеять с тайной</label>' +
    '<button type="submit">посеять</button>' +
    '</form>'
  );
}

function renderPlotsTab(d) {
  const plots = d.plotlines || [];
  const note = d.conflux?.plotlines?.length
    ? '<p class="muted small">Сюжетные нити сопряжения — во вкладке «сопряжение». Здесь остаются указы города.</p>'
    : '';
  const body = plots.length
    ? plots.map((p) => plotCard(p)).join('')
    : '<p class="muted">открытых нитей нет</p>';

  const closed = (d.closedPlotlines || []).length
    ? block(
        `Закрытые нити (${d.closedPlotlines.length})`,
        d.closedPlotlines.map((p) => plotCard(p)).join(''),
      )
    : '';

  return (
    note +
    block(`Нити города (${plots.length})`, seedFormHtml() + body) +
    closed
  );
}

function renderConfluxTab(d) {
  const c = d.conflux;
  const hist = block(
    'Счёт сопряжений',
    keyVals([
      ['месяцев в соло', d.confluxHistory?.monthsSolo],
      ['месяцев в сопряжении', d.confluxHistory?.monthsDocked],
      ['прежние партнёры', Object.keys(d.confluxHistory?.partners || {}).length || '—'],
    ]),
  );
  if (!c) {
    return block('Сопряжение', '<p class="muted">сейчас остров идёт один</p>') + hist;
  }

  const names = c.domainNames || {};
  const plots = c.plotlines || [];
  const procs = c.processes || [];
  const out = [];

  out.push(
    block(
      'Сопряжение',
      keyVals([
        ['статус', c.status],
        ['партнёр', c.partnerName],
        ['до сопряжения, мес.', c.monthsUntilDock],
        ['в сопряжении, мес.', `${c.monthsDocked}/${c.durationMonths}`],
        ['повторная', c.rematch ? 'да' : 'нет'],
        ['проход', c.contact ? `${c.contact.kind || '?'} — ${c.contact.description || ''}` : null],
        ['контроль прохода', c.contact?.control || null],
        ['главная нить', c.mainPlotId],
      ]),
    ),
  );

  out.push(
    block(
      `Нити сопряжения (${plots.length})`,
      plots.length ? plots.map((p) => plotCard(p, names)).join('') : '<p class="muted">нитей на сопряжении нет</p>',
    ),
  );

  if (c.closedPlotlines?.length) {
    out.push(
      block(
        `Закрытые нити сопряжения (${c.closedPlotlines.length})`,
        c.closedPlotlines.map((p) => plotCard(p, names)).join(''),
      ),
    );
  }

  const active = procs.filter((p) => !p.status || p.status === 'active' || p.status === 'paused');
  const done = procs.filter((p) => p.status && p.status !== 'active' && p.status !== 'paused');
  out.push(
    block(
      `Дела сопряжения (${active.length})`,
      active.length ? active.map((p) => processCard(p, { viewerId: d.id, mana: d.mana })).join('') : '<p class="muted">дел на сопряжении нет</p>',
    ),
  );
  if (done.length) {
    out.push(
      block(`Закрытые дела сопряжения (${done.length})`, done.map((p) => processCard(p, { viewerId: d.id, mana: d.mana })).join('')),
    );
  }

  if (c.lore?.length) {
    out.push(block(`Внутренняя хроника сопряжения (${c.lore.length})`, loreCards([...c.lore].reverse())));
  }

  out.push(hist);
  return out.join('');
}

function renderOrdersBlocks(d) {
  const rules = d.standingRules || [];
  const proxy = d.proxyText || (d.confluxDirective && d.confluxDirective.text) || null;
  const subjects = d.priestOrders || [];
  const out = [
    block(
      `Постоянный порядок (${rules.length})`,
      rules.length
        ? `<ul>${rules
            .map(
              (r) =>
                `<li>${esc(r.text)} <span class="muted small">${esc(
                  [r.sinceLabel || (r.sinceDay != null ? `день ${r.sinceDay}` : null), r.by]
                    .filter(Boolean)
                    .join(' · '),
                )}</span></li>`,
            )
            .join('')}</ul>`
        : '<p class="muted">порядка нет</p>',
    ),
    block(
      'Доверенность',
      proxy ? `<p>${esc(typeof proxy === 'string' ? proxy : proxy.text || '')}</p>` : '<p class="muted">доверенности нет</p>',
    ),
  ];
  if (subjects.length) {
    out.push(
      block(
        `О чём велено докладывать (${subjects.length})`,
        `<ul>${subjects
          .map(
            (o) =>
              `<li>${esc(o.subject)} <span class="muted small">${esc(
                o.lastEventNo != null ? `поминал на событии ${o.lastEventNo}` : 'ещё не поминал',
              )}</span></li>`,
          )
          .join('')}</ul>`,
      ),
    );
  }
  return out.join('');
}

function finishGloss(p) {
  if (!p.finishKind) return null;
  const tag =
    p.finishKind === 'fail'
      ? '[ПРОВАЛ]'
      : p.finishKind === 'crit'
        ? '[КРИТИЧЕСКИЙ УСПЕХ]'
        : p.finishKind === 'ok'
          ? '[УСПЕХ]'
          : null;
  if (!tag) return null;
  const bless = p.finishBlessed || p.blessed ? ' (благословение +1)' : '';
  return `исход: ${tag}${bless}`;
}

function processCard(p, opts = {}) {
  const active = !p.status || p.status === 'active';
  const paused = p.status === 'paused';
  const own = !p.ownerDomainId || p.ownerDomainId === opts.viewerId;
  const scheduled = p.scheduledDays ?? p.objectiveDays ?? '?';
  const clock = paused
    ? `пауза · оставалось ${p.pausedRemainingDays ?? '?'} дн.`
    : active
      ? `осталось ${p.remainingDays ?? '?'} из ${scheduled} дн. (${p.remainingLabel || '?'})`
      : `${p.status}${p.resolvedDay != null ? ` · день ${p.resolvedDay}` : ''} · шло ${scheduled} дн.`;
  const work = [
    p.durationLabel ? `срок: ${p.durationLabel}` : null,
    p.difficultyLabel ? `сложность: ${p.difficultyLabel}` : null,
    p.paceLabel && p.paceLabel !== 'обычно' ? `темп: ${p.paceLabel}` : null,
    p.impossible ? 'невыполнимо' : null,
    p.plotEngagement ? `в нити: ${p.plotEngagement}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const cost = Number.isFinite(Number(p.blessCost)) ? Number(p.blessCost) : null;
  const mana = Number(opts.mana);
  const meta = [
    clock,
    work,
    finishGloss(p),
    p.blessed && active ? 'благословлено' : null,
    p.linkedStats?.length ? `статы: ${p.linkedStats.join(', ')}` : null,
    p.initiative === 'ruler' ? 'сам правитель' : null,
    p.judgeNote ? `оценка: ${p.judgeNote}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  let blessBtn = '';
  if (active && own && opts.viewerId && !p.blessed && cost != null) {
    blessBtn =
      Number.isFinite(mana) && mana < cost
        ? `<span class="muted small">благословить · ${cost} маны (не хватает, есть ${Math.floor(mana)})</span>`
        : `<button type="button" class="bless-btn" data-bless="${esc(p.id)}">благословить · ${cost} маны</button>`;
  }
  const finishBtns =
    canDev && (active || paused)
      ? `<button type="button" class="force-btn danger" data-finish="${esc(p.id)}" data-kind="fail">провал</button>` +
        `<button type="button" class="force-btn" data-finish="${esc(p.id)}" data-kind="ok">успех</button>` +
        `<button type="button" class="force-btn" data-finish="${esc(p.id)}" data-kind="crit">крит</button>`
      : '';
  const actions = [blessBtn, finishBtns].filter(Boolean).join('');
  return (
    `<article class="ins-card${active ? '' : ' dim'}"><h4>${esc(p.summary || p.title || p.id)}</h4>` +
    `<div class="muted small">${esc(meta)}</div>` +
    (p.goal ? `<p class="muted small">цель: ${esc(p.goal)}</p>` : '') +
    (p.detail ? `<p class="pre">${esc(p.detail)}</p>` : '') +
    deedSecretAim(p) +
    `<p class="small muted">${esc(p.id)}</p>` +
    (actions ? `<div class="row-actions">${actions}</div>` : '') +
    `</article>`
  );
}

function renderProcessesTab(d) {
  const list = d.processes || [];
  const note = d.conflux?.processes?.length
    ? '<p class="muted small">Дела сопряжения — во вкладке «сопряжение». Здесь остаются городские.</p>'
    : '';
  const active = list.filter((p) => !p.status || p.status === 'active' || p.status === 'paused');
  const done = list.filter((p) => p.status && p.status !== 'active' && p.status !== 'paused');
  const activeBlock = block(
    `Дела (${active.length})`,
    active.length ? active.map((p) => processCard(p, { viewerId: d.id, mana: d.mana })).join('') : '<p class="muted">активных дел нет</p>',
  );
  const doneBlock = done.length
    ? block(`Закрытые дела (${done.length})`, done.map((p) => processCard(p, { viewerId: d.id, mana: d.mana })).join(''))
    : '';
  return note + activeBlock + doneBlock + renderOrdersBlocks(d);
}

function renderChronicleTab(d) {
  const list = [...(d.chronicle || [])].reverse();
  if (!list.length) return block('Хроника', '<p class="muted">записей пока нет</p>');
  const shown = d.chronicleCount > list.length ? ` (последние ${list.length} из ${d.chronicleCount})` : '';
  return block(
    `Хроника${shown}`,
    list
      .map((e) => {
        const stats = e.statChanges
          ? Object.entries(e.statChanges)
              .map(([k, v]) => `${k} ${v.from}→${v.to}`)
              .join(', ')
          : '';
        const links = [
          e.relatedPlots?.length
            ? `нить: ${e.relatedPlots.map((p) => p.title).join(', ')}`
            : null,
          e.relatedProcess ? `дело: ${e.relatedProcess.title}` : null,
          e.processFinishLabel ? `исход: ${e.processFinishLabel}` : null,
        ].filter(Boolean);
        const meta = [e.gameDateLabel, e.importance, e.author, stats, ...links]
          .filter(Boolean)
          .join(' · ');
        return (
          `<article class="ins-card"><div class="muted small">${esc(meta)}</div>` +
          `<p class="pre">${esc(e.text)}</p></article>`
        );
      })
      .join(''),
  );
}

function renderFactsTab(d) {
  const list = d.facts || [];
  if (!list.length) return block('Факты', '<p class="muted">фактов пока нет</p>');
  return block(
    `Факты (${list.filter((f) => !f.retiredAt).length} живых из ${list.length})`,
    list
      .map(
        (f) =>
          `<article class="ins-card${f.retiredAt ? ' dim' : ''}">` +
          `<div class="muted small">${esc([f.gameDateLabel, f.author, f.retiredAt ? 'снят' : null].filter(Boolean).join(' · '))}</div>` +
          `<p class="pre">${esc(f.text)}</p></article>`,
      )
      .join(''),
  );
}

function renderCastTab(d) {
  const list = d.cast || [];
  if (!list.length) return block('Люди', '<p class="muted">названных людей пока нет</p>');
  return block(
    `Люди (${list.length})`,
    list
      .map(
        (c) =>
          `<article class="ins-card"><h4>${esc(c.name)}${c.status && c.status !== 'alive' ? ` <span class="muted small">${esc(c.status)}</span>` : ''}</h4>` +
          `<div class="muted small">${esc(
            [Number.isFinite(Number(c.ageYears)) ? `${c.ageYears} лет` : null, c.role].filter(Boolean).join(' · '),
          )}</div>` +
          (c.about ? `<p class="pre">${esc(c.about)}</p>` : '') +
          `</article>`,
      )
      .join(''),
  );
}

function renderInspector() {
  const box = $('inspectBody');
  for (const b of document.querySelectorAll('#inspectTabs .tab')) {
    b.classList.toggle('active', b.dataset.tab === inspectTab);
  }
  if (!inspectData) {
    box.textContent = 'загрузка…';
    return;
  }
  const d = inspectData.domain;
  if (!d) {
    box.innerHTML = '<p class="muted">города ещё нет — скажи что-нибудь, чтобы его создать</p>';
    return;
  }
  if (inspectTab === 'raw') {
    box.innerHTML = `<pre class="raw">${esc(JSON.stringify(inspectData, null, 2))}</pre>`;
    return;
  }
  const render = {
    city: renderCityTab,
    conflux: renderConfluxTab,
    plots: renderPlotsTab,
    processes: renderProcessesTab,
    chronicle: renderChronicleTab,
    facts: renderFactsTab,
    cast: renderCastTab,
  }[inspectTab];
  box.innerHTML = render ? render(d) : '';
}

async function refreshInspector() {
  if ($('inspector').classList.contains('hidden')) return;
  try {
    inspectData = await api(`/api/play/inspect?userId=${encodeURIComponent(userId)}`);
    renderInspector();
  } catch (err) {
    $('inspectBody').textContent = `не удалось получить данные: ${err.message}`;
  }
}

$('btnInspect').addEventListener('click', async () => {
  const panel = $('inspector');
  $('cityPanel').classList.add('hidden');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) await refreshInspector();
});

$('btnInspectClose').addEventListener('click', () => $('inspector').classList.add('hidden'));

// ------------------------------------------------------------------ город

/**
 * Мини-аппка живёт в iframe со своим слотом. Перечитываем её только по делу:
 * общий опрос состояния идёт каждые 8 секунд, и дёргать полную перезагрузку
 * страницы так же часто — значит листать справочник рывками.
 */
function reloadCityFrame() {
  const frame = $('cityFrame');
  const src = `/mini?userId=${encodeURIComponent(userId)}#${Date.now()}`;
  frame.setAttribute('src', src);
}

function cityPanelOpen() {
  return !$('cityPanel').classList.contains('hidden');
}

$('btnCity').addEventListener('click', () => {
  const panel = $('cityPanel');
  $('inspector').classList.add('hidden');
  panel.classList.toggle('hidden');
  if (cityPanelOpen()) reloadCityFrame();
});

$('btnCityClose').addEventListener('click', () => $('cityPanel').classList.add('hidden'));
$('btnCityReload').addEventListener('click', () => reloadCityFrame());

$('inspectTabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  inspectTab = tab.dataset.tab;
  renderInspector();
});

$('inspectBody').addEventListener('click', async (e) => {
  const drop = e.target.closest('[data-drop]');
  if (drop) {
    const plotId = drop.getAttribute('data-drop');
    if (!confirm('Снять эту историю вместе с её хроникой? Дел на ней быть не должно.')) return;
    drop.disabled = true;
    try {
      const result = await api('/api/play/drop-story', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, plotId }),
      });
      setBanner(`Сняли «${result.title || 'историю'}» и ${result.droppedLore || 0} записей хроники.`);
      await refreshInspector();
    } catch (err) {
      drop.disabled = false;
      $('inspectBody').insertAdjacentHTML(
        'afterbegin',
        `<p class="banner">${esc(err.message)}</p>`,
      );
    }
    return;
  }
  const fire = e.target.closest('[data-fire-threat]');
  if (fire) {
    const threatId = fire.getAttribute('data-fire-threat');
    const plotId = fire.getAttribute('data-plot');
    fire.disabled = true;
    setBanner('Срабатывает угроза…');
    try {
      const result = await api('/api/play/force-threat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, plotId, threatId }),
      });
      setBanner(
        result.closed
          ? `Угроза сработала — нить «${result.title || ''}» закрылась.`
          : `Угроза сработала${result.title ? `: «${result.title}»` : ''}.`,
      );
      await refresh({ force: true });
    } catch (err) {
      fire.disabled = false;
      setBanner(err.message);
    }
    return;
  }
  const finish = e.target.closest('[data-finish]');
  if (finish) {
    const processId = finish.getAttribute('data-finish');
    const kind = finish.getAttribute('data-kind');
    finish.disabled = true;
    setBanner('Закрываем дело…');
    try {
      const result = await api('/api/play/force-deed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, processId, finish: kind }),
      });
      const label = { fail: 'провалом', ok: 'успехом', crit: 'критом' }[result.finish] || result.finish;
      setBanner(`Дело закрыто ${label}${result.summary ? `: «${result.summary}»` : ''}.`);
      await refresh({ force: true });
    } catch (err) {
      finish.disabled = false;
      setBanner(err.message);
    }
    return;
  }
  const btn = e.target.closest('[data-bless]');
  if (!btn) return;
  const processId = btn.getAttribute('data-bless');
  btn.disabled = true;
  try {
    await api('/api/play/bless', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, processId }),
    });
    await refreshInspector();
  } catch (err) {
    btn.disabled = false;
    $('inspectBody').insertAdjacentHTML(
      'afterbegin',
      `<p class="banner">${esc(err.message)}</p>`,
    );
  }
});

$('inspectBody').addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-seed-form]');
  if (!form) return;
  e.preventDefault();
  const gravity = form.gravity?.value || 'EPISODE';
  const grain = form.grain?.value || 'genesis';
  const mystery = Boolean(form.mystery?.checked);
  const btn = form.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
  $('btnSeed').disabled = true;
  setBanner('Сеем историю — это может занять минуту.');
  try {
    const result = await api('/api/play/seed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, gravity, grain, mystery }),
    });
    setBanner(`Посеяли «${result.plot?.title || 'историю'}» · ${result.gravity} · ${result.grain}`);
    await refreshInspector();
    $('btnSeed').disabled = false;
  } catch (err) {
    setBanner(err.message);
    if (btn) btn.disabled = false;
    $('btnSeed').disabled = false;
  }
});

$('btnSeed').addEventListener('click', async () => {
  $('cityPanel').classList.add('hidden');
  inspectTab = 'plots';
  $('inspector').classList.remove('hidden');
  await refreshInspector();
  const form = document.querySelector('[data-seed-form]');
  form?.querySelector('select[name="gravity"]')?.focus();
});

$('btnTick').addEventListener('click', async () => {
  const days = Math.round(Number($('skipDays').value));
  if (!Number.isFinite(days) || days < 1 || days > 360) {
    setBanner('Сколько дней промотать: целое от 1 до 360.');
    return;
  }
  $('btnTick').disabled = true;
  $('skipDays').disabled = true;
  try {
    await api('/api/play/tick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, days }),
    });
    setBanner(`Промотали ${days} дн.: что назрело, придёт в чат само.`);
  } catch (err) {
    setBanner(err.message);
    $('btnTick').disabled = false;
    $('skipDays').disabled = false;
  }
});

$('btnClock').addEventListener('click', async () => {
  $('btnClock').disabled = true;
  try {
    const held = $('btnClock').textContent !== 'время';
    await api('/api/play/clock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, held }),
    });
    await refresh({ force: true });
  } catch (err) {
    setBanner(err.message);
  } finally {
    $('btnClock').disabled = false;
  }
});

$('btnWipe').addEventListener('click', async () => {
  if (!confirm('Снести все города и завести новый мир? Прежний уйдёт в архив.')) return;
  if (!confirm('Точно? Этот мир вернуть будет нельзя.')) return;
  $('btnWipe').disabled = true;
  try {
    await api('/api/play/wipe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, confirm: true }),
    });
    lastStats = {};
    inspectData = null;
    renderedCount = -1;
    setBanner('Мир заведён заново. Скажи что-нибудь, чтобы создать город.');
    await refresh({ force: true });
  } catch (err) {
    setBanner(err.message);
  } finally {
    $('btnWipe').disabled = false;
  }
});

$('btnSave').addEventListener('click', async () => {
  $('btnSave').disabled = true;
  try {
    const result = await api('/api/play/snapshots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, label: $('saveLabel').value }),
    });
    $('saveLabel').value = '';
    setBanner(`Состояние мира сохранено${result.label ? `: ${result.label}` : ''}.`);
    await renderSaves();
  } catch (err) {
    setBanner(err.message);
  } finally {
    $('btnSave').disabled = false;
  }
});

$('saveList').addEventListener('click', async (e) => {
  const loadId = e.target?.dataset?.load;
  const dropId = e.target?.dataset?.drop;
  if (loadId) {
    if (!confirm('Загрузить состояние мира? Текущее будет заменено.')) return;
    try {
      await api('/api/play/snapshots/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, id: loadId }),
      });
      lastStats = {};
      inspectData = null;
      renderedCount = -1;
      setBanner('Состояние мира загружено.');
      await refresh({ force: true });
    } catch (err) {
      setBanner(err.message);
    }
    return;
  }
  if (dropId) {
    if (!confirm('Удалить этот снимок?')) return;
    try {
      await api(`/api/play/snapshots/${encodeURIComponent(dropId)}`, { method: 'DELETE' });
      await renderSaves();
    } catch (err) {
      setBanner(err.message);
    }
  }
});

$('btnSlots').addEventListener('click', () => {
  $('slots').classList.toggle('hidden');
  if (!$('slots').classList.contains('hidden')) void renderSaves();
});

$('btnSwitch').addEventListener('click', () => void switchTo($('userId').value.trim()));

$('btnNeighbor').addEventListener('click', () => {
  const next = $('btnNeighbor').dataset.userId;
  if (next) void switchTo(next);
});

async function newIslandSlot() {
  const { userId: fresh } = await api('/api/play/slot', { method: 'POST' });
  await switchTo(fresh);
  $('text').focus();
}

$('btnNew').addEventListener('click', () => void newIslandSlot());
$('btnNewIsland').addEventListener('click', () => void newIslandSlot());

void refresh({ force: true });
setInterval(() => void refresh(), 8000);
