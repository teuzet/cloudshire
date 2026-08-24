const $ = (id) => document.getElementById(id);
const STORE_KEY = 'cloudshire.play.userId';

let userId = localStorage.getItem(STORE_KEY) || 'local-user';
let lastStats = {};
let renderedCount = -1;
let busy = false;
let inspectTab = 'city';
let inspectData = null;

$('userId').value = userId;

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || res.statusText);
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

function renderHistory(history) {
  const box = $('messages');
  box.innerHTML = '';
  if (!history.length) {
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
    } else if (m.kind === 'onboarding') {
      box.appendChild(bubble('ruler', m.content, 'проводник'));
    } else {
      box.appendChild(bubble('ruler', m.content));
    }
  }
  box.scrollTop = box.scrollHeight;
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

async function refresh({ force = false } = {}) {
  try {
    const state = await api(`/api/play/state?userId=${encodeURIComponent(userId)}`);
    $('gameDate').textContent = state.gameDate?.label || '';
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

    if (force || state.history.length !== renderedCount) {
      renderHistory(state.history);
      renderedCount = state.history.length;
    }

    $('btnTick').classList.toggle('hidden', !state.canForceTick);
    $('btnTick').disabled = Boolean(state.ticking || state.generating);
    $('btnWipe').classList.toggle('hidden', !state.canWipe);
    $('wipeNote').hidden = !state.canWipe;
    $('btnWipe').disabled = Boolean(state.ticking);

    if (state.generating) {
      setBanner(state.generatingProgress || 'Остров создаётся — правитель напишет сам, это минута-две.');
    } else if (state.ticking) setBanner('Идёт шаг времени: правитель занят делами месяца.');
    else setBanner('');

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
  const pending = bubble('ruler', '…', 'печатает');
  pending.classList.add('pending');
  $('messages').appendChild(pending);
  $('messages').scrollTop = $('messages').scrollHeight;
  $('text').value = '';
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
      $('messages').appendChild(bubble('ruler', result.reply, label));
      $('messages').scrollTop = $('messages').scrollHeight;
    }
  } catch (err) {
    setBanner(err.message);
  } finally {
    pending.remove();
    busy = false;
    $('send').disabled = false;
    await refresh({ force: true });
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
        ['основан на тике', d.createdTick],
        ['последний тик', d.lastTickAt],
      ]),
    ),
  );
  out.push(
    block(
      'Статы',
      keyVals((d.stats || []).map((s) => [s.name, `${s.value} · ${s.epithet}`])),
    ),
  );
  if (d.characters?.length) {
    out.push(
      block(
        'Правитель',
        keyVals(
          d.characters.flatMap((ch) => [
            ['имя', `${ch.name}${ch.title ? `, ${ch.title}` : ''}`],
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
      'Стыковка',
      c
        ? keyVals([
            ['статус', c.status],
            ['партнёр', c.partnerName],
            ['до стыковки, мес.', c.monthsUntilDock],
            ['состыкованы, мес.', `${c.monthsDocked}/${c.durationMonths}`],
            ['повторная', c.rematch ? 'да' : 'нет'],
            ['проход', c.contact ? `${c.contact.kind || '?'} — ${c.contact.description || ''}` : null],
          ])
        : `<p class="muted">сейчас остров идёт один</p>`,
    ) +
      block(
        'Счёт стыковок',
        keyVals([
          ['месяцев в соло', d.confluxHistory?.monthsSolo],
          ['месяцев в стыковке', d.confluxHistory?.monthsDocked],
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

function renderPlotsTab(d) {
  const plots = d.plotlines || [];
  const body = plots.length
    ? plots
        .map((p) => {
          const meta = [
            p.kind,
            `важность ${p.importance}`,
            `жар ${p.temperature}`,
            `возраст ${p.ageMonths}/${p.maxAgeMonths}`,
            `битов ${p.beatCount}`,
            p.mirrorOf ? 'зеркало' : null,
            p.partnerGone ? 'партнёр ушёл' : null,
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            `<article class="ins-card"><h4>${esc(p.title)}</h4>` +
            `<div class="muted small">${esc(meta)}</div>` +
            (p.synopsis ? `<p class="pre">${esc(p.synopsis)}</p>` : '') +
            (p.closeWhen ? `<p class="small muted">закроется, когда: ${esc(p.closeWhen)}</p>` : '') +
            (p.relatedStats?.length
              ? `<p class="small muted">статы: ${esc(p.relatedStats.join(', '))}</p>`
              : '') +
            (p.relatedProcessIds?.length
              ? `<p class="small muted">дела: ${esc(p.relatedProcessIds.join(', '))}</p>`
              : '') +
            `<p class="small muted">${esc(p.id)}</p></article>`
          );
        })
        .join('')
    : '<p class="muted">открытых нитей нет</p>';

  const closed = (d.closedPlotlines || []).length
    ? block(
        'Закрытые нити',
        `<ul>${d.closedPlotlines
          .map((p) => `<li>${esc(p.title)} <span class="muted small">${esc(p.reason || p.closeReason || '')}</span></li>`)
          .join('')}</ul>`,
      )
    : '';

  return block(`Нити (${plots.length})`, body) + closed;
}

function renderOrdersBlocks(d) {
  const orders = d.standingOrders || [];
  return block(
    `Постоянные распоряжения (${orders.length})`,
    orders.length
      ? `<ul>${orders
          .map(
            (o) =>
              `<li>${esc(o.text)} <span class="muted small">${esc(
                [o.initiative === 'ruler' ? 'сам правитель' : o.by, o.declaredTick != null ? `тик ${o.declaredTick}` : null].filter(Boolean).join(' · '),
              )}</span></li>`,
          )
          .join('')}</ul>`
      : '<p class="muted">распоряжений нет</p>',
  );
}

function processCard(p) {
  const total = p.expectedMonths ?? p.durationMonths ?? '?';
  const objective = p.objectiveMonths;
  const left = p.monthsLeft;
  const active = !p.status || p.status === 'active';
  const clock = active
    ? `осталось ${left ?? '?'} из ${total} мес.`
    : `${p.status}${p.resolvedTick != null ? ` · тик ${p.resolvedTick}` : ''} · шло ${total} мес.`;
  const pace =
    objective && Number(objective) !== Number(total)
      ? `оценка ${objective} мес.`
      : objective
        ? `оценка ${objective} мес.`
        : null;
  const finish =
    p.finishKind === 'fail'
      ? 'исход: провал'
      : p.finishKind === 'crit'
        ? 'исход: критический успех'
        : p.finishKind === 'ok'
          ? 'исход: нейтральный успех'
          : null;
  const meta = [
    clock,
    pace,
    finish,
    p.linkedStats?.length ? `статы: ${p.linkedStats.join(', ')}` : null,
    p.initiative === 'ruler' ? 'сам правитель' : null,
    p.lastAdvanceKind ? `последний ход: ${p.lastAdvanceKind}${p.lastAdvance != null ? ` (${p.lastAdvance})` : ''}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    `<article class="ins-card${active ? '' : ' dim'}"><h4>${esc(p.summary || p.title || p.id)}</h4>` +
    `<div class="muted small">${esc(meta)}</div>` +
    (p.detail ? `<p class="pre">${esc(p.detail)}</p>` : '') +
    `<p class="small muted">${esc(p.id)}</p></article>`
  );
}

function renderProcessesTab(d) {
  const list = d.processes || [];
  const active = list.filter((p) => !p.status || p.status === 'active');
  const done = list.filter((p) => p.status && p.status !== 'active');
  const activeBlock = block(
    `Дела (${active.length})`,
    active.length ? active.map(processCard).join('') : '<p class="muted">активных дел нет</p>',
  );
  const doneBlock = done.length
    ? block(`Закрытые дела (${done.length})`, done.map(processCard).join(''))
    : '';
  return activeBlock + doneBlock + renderOrdersBlocks(d);
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
          (c.role ? `<div class="muted small">${esc(c.role)}</div>` : '') +
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
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) await refreshInspector();
});

$('btnInspectClose').addEventListener('click', () => $('inspector').classList.add('hidden'));

$('inspectTabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  inspectTab = tab.dataset.tab;
  renderInspector();
});

$('btnTick').addEventListener('click', async () => {
  $('btnTick').disabled = true;
  try {
    await api('/api/play/tick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    setBanner('Шаг времени запущен: письмо о месяце придёт в чат само.');
  } catch (err) {
    setBanner(err.message);
    $('btnTick').disabled = false;
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

$('btnSlots').addEventListener('click', () => $('slots').classList.toggle('hidden'));

$('btnSwitch').addEventListener('click', async () => {
  userId = $('userId').value.trim() || 'local-user';
  localStorage.setItem(STORE_KEY, userId);
  renderedCount = -1;
  lastStats = {};
  inspectData = null;
  await refresh({ force: true });
});

$('btnNew').addEventListener('click', async () => {
  const { userId: fresh } = await api('/api/play/slot', { method: 'POST' });
  userId = fresh;
  $('userId').value = fresh;
  localStorage.setItem(STORE_KEY, fresh);
  renderedCount = -1;
  lastStats = {};
  inspectData = null;
  await refresh({ force: true });
  $('text').focus();
});

void refresh({ force: true });
setInterval(() => void refresh(), 8000);
