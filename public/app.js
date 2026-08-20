const $ = (id) => document.getElementById(id);

const SLOTS_KEY = 'cloudshire.slots';

function loadSlots() {
  try {
    const raw = localStorage.getItem(SLOTS_KEY);
    const slots = raw ? JSON.parse(raw) : null;
    if (Array.isArray(slots) && slots.length) return slots;
  } catch {
    /* ignore */
  }
  return [{ userId: 'local-user', label: 'local-user' }];
}

function saveSlots(slots) {
  localStorage.setItem(SLOTS_KEY, JSON.stringify(slots));
}

function currentUserId() {
  return $('userId').value.trim() || 'local-user';
}

function renderSlotSelect(slots, selected) {
  const sel = $('slotSelect');
  sel.innerHTML = '';
  for (const s of slots) {
    const opt = document.createElement('option');
    opt.value = s.userId;
    opt.textContent = s.label || s.userId;
    if (s.userId === selected) opt.selected = true;
    sel.appendChild(opt);
  }
}

function appendMessage(role, content, meta = '') {
  const el = document.createElement('div');
  el.className = `bubble ${role}`;
  if (meta) {
    const m = document.createElement('span');
    m.className = 'meta';
    m.textContent = meta;
    el.appendChild(m);
  }
  el.appendChild(document.createTextNode(content));
  $('messages').appendChild(el);
  $('messages').scrollTop = $('messages').scrollHeight;
}

let historyLoadedFor = null;
let activeDomainId = null;

async function loadLorePanels(domainId) {
  if (!domainId) {
    $('chronicle').textContent = '—';
    $('facts').textContent = '—';
    return;
  }
  const data = await fetch(`/api/domains/${encodeURIComponent(domainId)}/chronicle`).then((r) =>
    r.json(),
  );

  if (!data.entries?.length) {
    $('chronicle').textContent = 'записей пока нет';
  } else {
    $('chronicle').textContent = data.entries
      .map((e) => {
        const imp = e.importance ? `{${e.importance}} ` : '';
        let stats = '';
        if (e.statChanges && typeof e.statChanges === 'object') {
          const parts = Object.entries(e.statChanges).map(
            ([k, v]) => `${k} ${v.from}→${v.to}`,
          );
          if (parts.length) stats = ` [${parts.join(', ')}] `;
        }
        return `${e.gameDateLabel || '?'} ${imp}${stats}${e.text}`;
      })
      .join('\n\n');
  }

  if (!data.facts?.length) {
    $('facts').textContent = 'фактов пока нет';
  } else {
    $('facts').textContent = data.facts
      .map((f) => {
        const who = f.author ? `(${f.author}) ` : '';
        const date = f.gameDateLabel ? `${f.gameDateLabel} ` : '';
        return `${date}${who}${f.text}`;
      })
      .join('\n\n');
  }
}

async function refreshSlotsFromServer(slots) {
  const domains = await fetch('/api/domains').then((r) => r.json());
  const byUser = new Map(slots.map((s) => [s.userId, s]));
  for (const d of domains) {
    if (!d.ownerUserId) continue;
    if (!byUser.has(d.ownerUserId)) {
      const slot = { userId: d.ownerUserId, label: `${d.name} (${d.ownerUserId})` };
      slots.push(slot);
      byUser.set(d.ownerUserId, slot);
    } else {
      byUser.get(d.ownerUserId).label = `${d.name} · ${d.ownerUserId}`;
    }
  }
  saveSlots(slots);
  return slots;
}

async function refresh({ loadHistory = false } = {}) {
  const userId = currentUserId();
  let slots = loadSlots();
  slots = await refreshSlotsFromServer(slots);
  renderSlotSelect(slots, userId);

  const status = await fetch('/api/status').then((r) => r.json());
  $('status').textContent = JSON.stringify(status, null, 2);

  const { domain } = await fetch(`/api/users/${encodeURIComponent(userId)}/domain`).then((r) => r.json());
  if (!domain) {
    activeDomainId = null;
    $('domain').textContent = 'нет домена — напиши проводнику «хочу начать игру»';
    $('pending').textContent = '—';
    $('chronicle').textContent = '—';
    $('facts').textContent = '—';
    $('genesis').textContent = '—';
    $('milestones').textContent = '—';
    if (loadHistory || historyLoadedFor !== userId) {
      $('messages').innerHTML = '';
      historyLoadedFor = userId;
    }
    return;
  }

  activeDomainId = domain.id;
  $('domain').textContent = JSON.stringify(
    {
      id: domain.id,
      name: domain.name,
      status: domain.status,
      population: domain.population,
      stats: domain.stats,
      ruler: domain.characters?.[0]
        ? {
            name: domain.characters[0].name,
            title: domain.characters[0].title,
            role: domain.characters[0].role,
          }
        : null,
      stateEvents: domain.state?.events,
      loreCount: domain.lore?.length,
    },
    null,
    2,
  );

  $('milestones').textContent = (domain.milestones || []).length
    ? (domain.milestones || []).map((m) => `• [${m.points}о] ${m.text} (${m.status})`).join('\n')
    : '—';
  $('genesis').textContent = domain.description || '—';

  const pending = (domain.state?.pendingActions || []).filter((a) => a.status === 'active');
  $('pending').textContent = pending.length
    ? pending
        .map((a) => {
          const dur = a.durationMonths ?? '?';
          const done = a.monthsDone ?? 0;
          return `• ${a.summary} [${done}/${dur} мес.]\n  ${a.detail || ''}`;
        })
        .join('\n\n')
    : 'пусто';

  await loadLorePanels(domain.id);

  if (loadHistory || historyLoadedFor !== userId) {
    $('messages').innerHTML = '';
    const history = domain.characters?.[0]?.dialogHistory || [];
    for (const m of history.slice(-40)) {
      appendMessage(m.role === 'assistant' ? 'assistant' : 'user', m.content, 'history');
    }
    historyLoadedFor = userId;
  }
}

function switchSlot(userId) {
  $('userId').value = userId;
  historyLoadedFor = null;
  $('messages').innerHTML = '';
  refresh({ loadHistory: true }).catch(console.error);
}

$('slotSelect').addEventListener('change', (e) => {
  switchSlot(e.target.value);
});

$('btnNewSlot').addEventListener('click', async () => {
  const { userId } = await fetch('/api/dev/new-slot', { method: 'POST' }).then((r) => r.json());
  const slots = loadSlots();
  slots.push({ userId, label: `новый · ${userId}` });
  saveSlots(slots);
  switchSlot(userId);
  appendMessage(
    'assistant',
    'Новый слот. Напиши проводнику, например: «Хочу начать игру».',
    'system',
  );
});

$('btnRefresh').addEventListener('click', () => refresh().catch(console.error));

$('btnWipe').addEventListener('click', async () => {
  if (!confirm('Стереть ВСЕ домены, слоты и сбросить мир?')) return;
  $('btnWipe').disabled = true;
  try {
    await fetch('/api/dev/wipe', { method: 'POST' }).then((r) => r.json());
    localStorage.removeItem(SLOTS_KEY);
    $('messages').innerHTML = '';
    historyLoadedFor = null;
    activeDomainId = null;
    const slots = [{ userId: 'local-user', label: 'local-user' }];
    saveSlots(slots);
    switchSlot('local-user');
    appendMessage('assistant', 'Мир очищен. Можно начинать заново.', 'system · wipe');
  } catch (err) {
    appendMessage('assistant', err.message, 'error');
  } finally {
    $('btnWipe').disabled = false;
  }
});

$('btnTick').addEventListener('click', async () => {
  const btn = $('btnTick');
  if (btn.disabled) return;
  const label = btn.textContent;
  btn.disabled = true;
  btn.classList.add('busy');
  btn.textContent = 'Тик…';
  appendMessage('assistant', 'Force tick запущен — жду ответ сервера…', 'system · force tick');
  try {
    const result = await fetch('/api/tick', { method: 'POST' }).then(async (r) => {
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || r.statusText);
      return data;
    });
    const date = result.world?.gameDate?.label || '';
    const n = result.results?.length || 0;
    const failed = (result.results || []).filter((x) => x.error || x.skipped);
    appendMessage(
      'assistant',
      `Тик готов: ${date} · доменов: ${n}${failed.length ? ` · сбоев/пропусков: ${failed.length}` : ''}`,
      'system · force tick',
    );
    const userId = currentUserId();
    const pushes = await fetch(`/api/users/${encodeURIComponent(userId)}/pushes`).then((r) => r.json());
    const mine = (pushes.messages || []).filter((m) => m.kind === 'tick_news' || m.kind === 'game_end');
    const last = mine.at(-1);
    if (last) appendMessage('assistant', last.content, `push · ${last.kind}`);
    await refresh();
  } catch (err) {
    appendMessage('assistant', `Force tick не удался: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.classList.remove('busy');
    btn.textContent = label;
  }
});

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('text').value.trim();
  if (!text) return;
  const userId = currentUserId();
  appendMessage('user', text);
  $('text').value = '';
  $('text').disabled = true;

  try {
    const result = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, text }),
    }).then(async (r) => {
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || r.statusText);
      return data;
    });

    appendMessage('assistant', result.reply || '(пустой ответ)', result.agent || 'agent');
    await refresh();

    if (result.generating) {
      appendMessage('assistant', 'Жду готовности острова…', 'system');
      await waitForDomain(userId);
    }
  } catch (err) {
    appendMessage('assistant', err.message, 'error');
  } finally {
    $('text').disabled = false;
    $('text').focus();
  }
});

async function waitForDomain(userId) {
  const started = Date.now();
  let seenPush = 0;
  while (Date.now() - started < 180_000) {
    await new Promise((r) => setTimeout(r, 2500));
    const pushes = await fetch(`/api/users/${encodeURIComponent(userId)}/pushes`).then((r) => r.json());
    const msgs = pushes.messages || [];
    while (seenPush < msgs.length) {
      const m = msgs[seenPush];
      seenPush += 1;
      appendMessage('assistant', m.content, `push · ${m.kind || 'outbound'}`);
    }
    const { domain, generating } = await fetch(
      `/api/users/${encodeURIComponent(userId)}/domain`,
    ).then((r) => r.json());
    if (domain) {
      historyLoadedFor = null;
      await refresh({ loadHistory: true });
      return;
    }
    if (!generating && Date.now() - started > 5000) {
      appendMessage('assistant', 'Генерация завершилась без домена. Попробуй ещё раз.', 'error');
      return;
    }
  }
  appendMessage('assistant', 'Слишком долго. Проверь сервер/API-ключ и попробуй снова.', 'error');
}

(() => {
  const slots = loadSlots();
  const first = slots[0].userId;
  $('userId').value = first;
  renderSlotSelect(slots, first);
  refresh({ loadHistory: true })
    .then(async () => {
      const userId = currentUserId();
      const { domain } = await fetch(`/api/users/${encodeURIComponent(userId)}/domain`).then((r) =>
        r.json(),
      );
      if (domain) return;
      if ($('messages').children.length > 0) return;
      const result = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, bootstrap: true }),
      }).then((r) => r.json());
      if (result.reply) appendMessage('assistant', result.reply, result.agent || 'onboarding');
    })
    .catch(console.error);
})();
