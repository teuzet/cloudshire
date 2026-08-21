const $ = (id) => document.getElementById(id);

let domainsCache = [];
let activeDomainId = null;

function channelTag(channel) {
  if (channel === 'telegram') return '[tg]';
  if (channel === 'web') return '[web]';
  if (channel === 'cli') return '[cli]';
  return `[${channel || '?'}]`;
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || res.statusText);
  return data;
}

function fmtLoreEntries(entries) {
  if (!entries?.length) return 'записей пока нет';
  return entries
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

function fmtFacts(facts) {
  if (!facts?.length) return 'фактов пока нет';
  return facts
    .map((f) => {
      const who = f.author ? `(${f.author}) ` : '';
      const date = f.gameDateLabel ? `${f.gameDateLabel} ` : '';
      return `${date}${who}${f.text}`;
    })
    .join('\n\n');
}

function fillDomainSelect(list, selectedId) {
  const sel = $('domainSelect');
  const prev = selectedId || sel.value;
  sel.innerHTML = '';
  if (!list.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = 'нет доменов';
    sel.appendChild(o);
    return;
  }
  for (const d of list) {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = `${channelTag(d.channel)} ${d.name} · ${d.ownerUserId || '?'}`;
    sel.appendChild(opt);
  }
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
  else sel.value = list[0].id;
}

function fillConfluxDomainSelects(list) {
  for (const selId of ['confluxA', 'confluxB']) {
    const sel = $(selId);
    const prev = sel.value;
    sel.innerHTML = '';
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = list.length ? '— выбери —' : 'нет доменов';
    sel.appendChild(empty);
    for (const d of list) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = `${d.name} (${d.id})`;
      sel.appendChild(opt);
    }
    if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
  }
  if (list.length >= 2 && !$('confluxA').value) {
    $('confluxA').value = list[0].id;
    $('confluxB').value = list[1].id;
  }
}

async function refreshConfluxUi() {
  const all = $('confluxFilter').value === 'all';
  const data = await api(`/api/confluxes${all ? '?all=1' : ''}`);
  const rows = data.confluxes || [];
  if (!rows.length) {
    $('confluxPanel').textContent = all ? 'conflux нет' : 'активных conflux нет';
    return;
  }
  $('confluxPanel').textContent = rows
    .map((c) => {
      const names = (c.domainNames || c.domainIds || []).join(' ↔ ');
      const rematch = c.rematch ? ' · rematch' : '';
      let detail = '';
      if (c.status === 'approaching') {
        detail = `eta ${c.monthsUntilDock} мес. (dock@${c.dockAtTick})`;
      } else if (c.contact) {
        detail = `${c.contact.kind || '?'} · ${String(c.contact.description || '').slice(0, 140)}`;
      } else {
        detail = `docked ${c.monthsDocked}/${c.durationMonths}`;
      }
      return `• [${c.status}] ${names}${rematch}\n  ${c.id}\n  ${detail}`;
    })
    .join('\n\n');
}

async function loadPushes(ownerUserId) {
  $('messages').innerHTML = '';
  $('ownerLabel').textContent = ownerUserId || '';
  if (!ownerUserId) return;
  const data = await api(`/api/users/${encodeURIComponent(ownerUserId)}/pushes`).catch(() => ({
    messages: [],
  }));
  const list = (data.messages || []).slice(-30);
  if (!list.length) {
    const el = document.createElement('div');
    el.className = 'bubble bot';
    el.textContent = 'пушей пока нет (in-memory за эту сессию процесса)';
    $('messages').appendChild(el);
    return;
  }
  for (const m of list) {
    const el = document.createElement('div');
    el.className = 'bubble bot';
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${m.kind || 'push'} · ${m.at || ''}`;
    el.appendChild(meta);
    el.appendChild(document.createTextNode(m.content || ''));
    $('messages').appendChild(el);
  }
  $('messages').scrollTop = $('messages').scrollHeight;
}

async function loadDomain(domainId) {
  activeDomainId = domainId || null;
  if (!domainId) {
    $('domain').textContent = 'выбери домен';
    $('milestones').textContent = '—';
    $('pending').textContent = '—';
    $('plotlines').textContent = '—';
    $('genesis').textContent = '—';
    $('chronicle').textContent = '—';
    $('facts').textContent = '—';
    await loadPushes(null);
    return;
  }

  const domain = await api(`/api/domains/${encodeURIComponent(domainId)}`);
  const solo = domain.confluxMonthsSolo ?? 0;
  const docked = domain.confluxMonthsDocked ?? 0;
  const total = solo + docked;
  const frac = total ? ((docked / total) * 100).toFixed(0) : '—';

  $('domain').textContent = JSON.stringify(
    {
      id: domain.id,
      name: domain.name,
      status: domain.status,
      channel: domain.channel,
      ownerUserId: domain.ownerUserId,
      population: domain.population,
      createdTick: domain.createdTick,
      conflux: {
        monthsSolo: solo,
        monthsDocked: docked,
        dockedFractionPct: frac,
        partners: domain.confluxPartners || {},
      },
      stats: domain.stats,
      lastTickAt: domain.lastTickAt,
    },
    null,
    2,
  );

  const ruler = domain.characters?.[0];
  $('milestones').textContent = JSON.stringify(
    {
      ruler: ruler
        ? {
            name: ruler.name,
            title: ruler.title,
            loyalty: ruler.loyalty,
            terror: ruler.terror,
          }
        : null,
      milestones: domain.milestones || [],
      tags: (domain.tags || []).map((t) => t.tagName || t.tagId),
    },
    null,
    2,
  );

  const processes = domain.state?.pendingActions || domain.processes || [];
  $('pending').textContent = processes.length
    ? JSON.stringify(processes, null, 2)
    : 'нет активных процессов';

  $('plotlines').textContent = (domain.plotlines || []).length
    ? JSON.stringify(domain.plotlines, null, 2)
    : 'нет открытых плотлайнов';

  $('genesis').textContent = domain.description || '—';

  const lore = await api(`/api/domains/${encodeURIComponent(domainId)}/chronicle`);
  $('chronicle').textContent = fmtLoreEntries(lore.entries);
  $('facts').textContent = fmtFacts(lore.facts);

  await loadPushes(domain.ownerUserId);
}

async function refresh() {
  const status = await api('/api/status');
  $('status').textContent = JSON.stringify(
    {
      storage: status.storage,
      tick: status.world?.gameDate,
      tickIndex: status.world?.tickIndex,
      scheduler: status.world?.scheduler,
      domainCount: status.domainCount,
      intervalHours: status.tickIntervalHours,
      worldTicking: status.worldTicking,
      telegram: status.telegram,
    },
    null,
    2,
  );

  domainsCache = await api('/api/domains');
  fillDomainSelect(domainsCache, activeDomainId);
  fillConfluxDomainSelects(domainsCache);
  await refreshConfluxUi();
  await loadDomain($('domainSelect').value || null);
}

$('domainSelect').addEventListener('change', () => {
  void loadDomain($('domainSelect').value);
});

$('btnRefresh').addEventListener('click', () => void refresh());
$('btnConfluxRefresh').addEventListener('click', () => void refreshConfluxUi());
$('confluxFilter').addEventListener('change', () => void refreshConfluxUi());

$('btnTick').addEventListener('click', async () => {
  $('btnTick').disabled = true;
  try {
    const result = await api('/api/tick', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    alert(`Tick ok · ${result.world?.gameDate?.label || ''} · domains ${result.results?.length ?? 0}`);
    await refresh();
  } catch (err) {
    alert(err.message);
  } finally {
    $('btnTick').disabled = false;
  }
});

$('btnConflux').addEventListener('click', async () => {
  try {
    await api('/api/dev/conflux', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        domainIdA: $('confluxA').value,
        domainIdB: $('confluxB').value,
        etaMonths: Number($('confluxEta').value),
        durationMonths: Number($('confluxDuration').value),
      }),
    });
    await refresh();
  } catch (err) {
    alert(err.message);
  }
});

$('btnWipe').addEventListener('click', async () => {
  if (!confirm('Wipe ALL domains and reset world?')) return;
  if (!confirm('Точно? Это необратимо для текущего мира.')) return;
  try {
    await api('/api/dev/wipe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    activeDomainId = null;
    await refresh();
  } catch (err) {
    alert(err.message);
  }
});

void refresh();
setInterval(() => void refresh(), 30000);
