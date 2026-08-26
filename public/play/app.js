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
    } else if (m.kind === 'conflux_announce') {
      box.appendChild(bubble('news', m.content, 'сопряжение на горизонте'));
    } else if (m.kind === 'conflux_approach') {
      box.appendChild(bubble('news', m.content, 'остров близко'));
    } else if (m.kind === 'onboarding') {
      box.appendChild(bubble('ruler', m.content, 'проводник'));
    } else {
      box.appendChild(bubble('ruler', m.content));
    }
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
    renderIslands(state.islands || []);

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
            ['наша информированность', c.awareness ? `${c.awareness.ours}/100` : null],
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

function plotCard(p, names = {}) {
  const concerns = (p.concernsDomainIds || [])
    .map((id) => names[id] || id)
    .filter(Boolean);
  const host = p.hostDomainId ? names[p.hostDomainId] || p.hostDomainId : null;
  const meta = [
    p.kind,
    p.storyType === 'mystery' ? 'тайна' : p.storyType === 'suspense' ? 'саспенс' : null,
    p.act ? `такт ${p.act}` : null,
    p.escalationLevel != null ? `кризис ${p.escalationLevel}/${p.maxEscalations ?? 3}` : null,
    p.urgency != null ? `срочность ${p.urgency}` : null,
    p.gravity != null ? `масштаб ${p.gravity}` : null,
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

function awarenessMeter(label, value) {
  const n = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    `<div>` +
    `<div class="kv"><span class="muted">${esc(label)}</span><span>${n}/100</span></div>` +
    `<div class="meter" title="${n} из 100"><span style="width:${n}%"></span></div>` +
    `</div>`
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
        'Закрытые нити',
        `<ul>${d.closedPlotlines
          .map((p) => `<li>${esc(p.title)} <span class="muted small">${esc(p.reason || p.closeReason || '')}</span></li>`)
          .join('')}</ul>`,
      )
    : '';

  return note + block(`Нити города (${plots.length})`, body) + closed;
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
  const info = c.informant || {};
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
      'Информатор',
      awarenessMeter('мы знаем о них', c.awareness?.ours) +
        awarenessMeter('они знают о нас', c.awareness?.theirs) +
        `<p class="muted small">${
          c.status === 'docked'
            ? 'Информированность растёт только в сопряжении. Информатор отвечает лишь из известных записей; секреты соседа сюда не попадают.'
            : 'Пока острова только сближаются, информированность не растёт. Информатор заработает после сопряжения.'
        }</p>`,
    ),
  );

  const knownNote =
    info.publicCount != null
      ? `известно ${info.knownCount || 0} из ${info.publicCount} публичных записей соседа`
      : `известно ${info.knownCount || 0}`;
  out.push(
    block(
      `Что знает наш информатор (${knownNote})`,
      loreCards(info.known, 'ещё ничего не известно'),
    ),
  );

  const theyNote =
    info.theyPublicCount != null
      ? `известно ${info.theyKnowCount || 0} из ${info.theyPublicCount} наших публичных`
      : `известно ${info.theyKnowCount || 0}`;
  out.push(
    block(
      `Что знает их информатор (${theyNote})`,
      loreCards(info.theyKnow, 'они ещё ничего не знают'),
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
        'Закрытые нити сопряжения',
        `<ul>${c.closedPlotlines
          .map((p) => `<li>${esc(p.title)} <span class="muted small">${esc(p.reason || p.closeReason || '')}</span></li>`)
          .join('')}</ul>`,
      ),
    );
  }

  const active = procs.filter((p) => !p.status || p.status === 'active' || p.status === 'paused');
  const done = procs.filter((p) => p.status && p.status !== 'active' && p.status !== 'paused');
  out.push(
    block(
      `Дела сопряжения (${active.length})`,
      active.length ? active.map((p) => processCard(p, { viewerId: d.id })).join('') : '<p class="muted">дел на сопряжении нет</p>',
    ),
  );
  if (done.length) {
    out.push(
      block(`Закрытые дела сопряжения (${done.length})`, done.map((p) => processCard(p, { viewerId: d.id })).join('')),
    );
  }

  if (c.lore?.length) {
    out.push(block(`Внутренняя хроника сопряжения (${c.lore.length})`, loreCards([...c.lore].reverse())));
  }

  out.push(hist);
  return out.join('');
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

function processCard(p, opts = {}) {
  const total = p.expectedMonths ?? p.durationMonths ?? '?';
  const objective = p.objectiveMonths;
  const left = p.monthsLeft;
  const active = !p.status || p.status === 'active';
  const paused = p.status === 'paused';
  const own = !p.ownerDomainId || p.ownerDomainId === opts.viewerId;
  const clock = paused
    ? `пауза · осталось ${left ?? '?'} из ${total} мес.`
    : active
      ? `осталось ${left ?? '?'} из ${total} мес.`
      : `${p.status}${p.resolvedTick != null ? ` · тик ${p.resolvedTick}` : ''} · шло ${total} мес.`;
  const pace =
    objective && Number(objective) !== Number(total)
      ? `оценка ${objective} мес.`
      : objective
        ? `оценка ${objective} мес.`
        : null;
  const finish =
    p.finishBlessed || (p.blessed && p.finishKind === 'crit')
      ? 'исход: [КРИТИЧЕСКИЙ УСПЕХ] (благословение)'
      : p.finishKind === 'fail'
        ? 'исход: [ПРОВАЛ]'
        : p.finishKind === 'crit'
          ? 'исход: [КРИТИЧЕСКИЙ УСПЕХ]'
          : p.finishKind === 'ok'
            ? 'исход: [УСПЕХ]'
            : null;
  const meta = [
    clock,
    pace,
    finish,
    p.blessed && active ? 'благословлено' : null,
    p.linkedStats?.length ? `статы: ${p.linkedStats.join(', ')}` : null,
    p.initiative === 'ruler' ? 'сам правитель' : null,
    p.lastAdvanceKind ? `последний ход: ${p.lastAdvanceKind}${p.lastAdvance != null ? ` (${p.lastAdvance})` : ''}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const blessBtn =
    active && own && opts.viewerId && !p.blessed
      ? `<button type="button" class="bless-btn" data-bless="${esc(p.id)}">благословить</button>`
      : '';
  return (
    `<article class="ins-card${active ? '' : ' dim'}"><h4>${esc(p.summary || p.title || p.id)}</h4>` +
    `<div class="muted small">${esc(meta)}</div>` +
    (p.goal ? `<p class="muted small">цель: ${esc(p.goal)}</p>` : '') +
    (p.detail ? `<p class="pre">${esc(p.detail)}</p>` : '') +
    `<p class="small muted">${esc(p.id)}</p>` +
    (blessBtn ? `<div class="row-actions">${blessBtn}</div>` : '') +
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
    active.length ? active.map((p) => processCard(p, { viewerId: d.id })).join('') : '<p class="muted">активных дел нет</p>',
  );
  const doneBlock = done.length
    ? block(`Закрытые дела (${done.length})`, done.map((p) => processCard(p, { viewerId: d.id })).join(''))
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

$('inspectBody').addEventListener('click', async (e) => {
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
