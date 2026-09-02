const tg = window.Telegram?.WebApp;
try {
  tg?.ready();
  tg?.expand();
  tg?.setHeaderColor?.('#12100e');
  tg?.setBackgroundColor?.('#12100e');
} catch {
  /* вне Telegram */
}

const panel = document.getElementById('panel');
const cityName = document.getElementById('cityName');
const gameDate = document.getElementById('gameDate');
const bg = document.getElementById('bg');

let state = null;
let tab = 'stats';

function previewUserId() {
  return new URLSearchParams(location.search).get('userId') || '';
}

function authHeaders() {
  const headers = {};
  if (tg?.initData) headers['X-Telegram-Init-Data'] = tg.initData;
  return headers;
}

function queryAuth() {
  const q = new URLSearchParams();
  if (tg?.initData) q.set('initData', tg.initData);
  const uid = previewUserId();
  if (uid) q.set('userId', uid);
  const s = q.toString();
  return s ? `?${s}` : '';
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"]/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[c]));
}

function empty(text) {
  return `<p class="empty muted">${esc(text)}</p>`;
}

function portraitSrc(officer) {
  if (officer?.portraitUrl) return officer.portraitUrl;
  const id = officer?.id || officer?.officerId;
  if (id) return `/api/mini/officer-portrait/${encodeURIComponent(id)}${queryAuth()}`;
  return '';
}

function islandBgUrl(city) {
  if (city?.imageUrl) return city.imageUrl;
  return `/api/mini/island-image${queryAuth()}`;
}

function renderStats(stats, faith) {
  const faithCard = faith
    ? `
      <article class="card faith">
        <div class="stat-head">
          <h2>${esc(faith.name)}</h2>
          <span class="stat-val">${esc(faith.value)} · ${esc(faith.epithet)}</span>
        </div>
        <div class="gauge" aria-hidden="true"><span style="width:${Math.max(0, Math.min(100, faith.value))}%"></span></div>
        <p class="muted">${esc(faith.about)}</p>
      </article>`
    : '';
  if (!stats?.length) return faithCard || empty('Статов пока нет.');
  const cards = stats
    .map((s) => {
      const o = s.officer;
      const portrait = o?.hasPortrait
        ? `<img class="portrait" src="${esc(portraitSrc(o))}" alt="">`
        : '';
      const person = o
        ? `<p class="meta">${esc(o.title)} ${esc(o.name)}${o.busy ? ' · при деле' : ' · свободен'}</p>
           ${o.nature ? `<p class="muted">${esc(o.nature)}</p>` : ''}`
        : '';
      return `
      <article class="card officer">
        ${portrait}
        <div class="stat-head">
          <h2>${esc(s.name)}</h2>
          <span class="stat-val">${esc(s.value)} · ${esc(s.epithet)}</span>
        </div>
        <div class="gauge" aria-hidden="true"><span style="width:${Math.max(0, Math.min(100, s.value))}%"></span></div>
        <p class="muted">${esc(s.about)}</p>
        ${person}
      </article>`;
    })
    .join('');
  return faithCard + cards;
}

function renderProcesses(list, mana) {
  const manaCard = mana
    ? `
      <article class="card faith">
        <div class="stat-head">
          <h2>${esc(mana.name)}</h2>
          <span class="stat-val">${esc(mana.value)} / ${esc(mana.max)}</span>
        </div>
        <div class="gauge" aria-hidden="true"><span style="width:${Math.max(0, Math.min(100, mana.value))}%"></span></div>
        <p class="muted">${esc(mana.about)}</p>
      </article>`
    : '';
  if (!list?.length) return manaCard + empty('Сановников пока нет.');
  const cards = list
    .map((slot) => {
      const p = slot.process;
      const portrait = slot.hasPortrait
        ? `<img class="portrait" src="${esc(portraitSrc(slot))}" alt="">`
        : '';
      if (!p) {
        return `
        <article class="card officer">
          ${portrait}
          <h2>${esc(slot.title)} ${esc(slot.name)}</h2>
          <p class="meta">свободен</p>
        </article>`;
      }
      const stats = p.linkedStats?.length ? p.linkedStats.join(', ') : '';
      const left = p.monthsLeft == null ? '' : `ещё ~${p.monthsLeft} мес.`;
      const pause = p.paused ? 'на паузе' : '';
      const blessed = p.blessed ? 'благословлено' : '';
      const meta = [pause, left, stats, blessed].filter(Boolean).join(' · ');
      let bless = '';
      if (!p.paused && !p.blessed && p.id) {
        if (p.canBless) {
          bless = `<button type="button" class="bless-btn" data-bless="${esc(p.id)}">благословить · ${esc(p.blessCost)} маны</button>`;
        } else {
          bless = `<p class="meta">благословить · ${esc(p.blessCost)} маны (не хватает)</p>`;
        }
      }
      return `
        <article class="card officer">
          ${portrait}
          <h2>${esc(slot.title)} ${esc(slot.name)}</h2>
          <p>${esc(p.summary)}</p>
          ${p.detail ? `<p class="muted">${esc(p.detail)}</p>` : ''}
          ${meta ? `<p class="meta">${esc(meta)}</p>` : ''}
          ${bless}
        </article>`;
    })
    .join('');
  return manaCard + cards;
}

function renderEvents(events) {
  if (!events?.length) return empty('Сейчас нет открытых историй.');
  return events
    .map((e) => {
      const deeds = e.processes?.length
        ? e.processes
            .map((p) => {
              const left = p.monthsLeft == null ? '' : ` · ещё ~${p.monthsLeft} мес.`;
              return `<p class="meta">${esc(p.summary)}${esc(left)}</p>`;
            })
            .join('')
        : '<p class="meta">Связанных дел нет.</p>';
      return `
        <article class="card">
          <h2>${esc(e.title)}</h2>
          <p>${esc(e.synopsis)}</p>
          ${deeds}
        </article>`;
    })
    .join('');
}

function renderOrders(list) {
  if (!list?.length) return empty('Указов нет.');
  return list
    .map((o) => {
      const term = o.indefinite
        ? 'бессрочно'
        : o.remainingMonths == null
          ? ''
          : `ещё ${o.remainingMonths} мес.`;
      const when = o.since ? `принят ${o.since}` : '';
      const meta = [when, term].filter(Boolean).join(' · ');
      return `
        <article class="card">
          <p>${esc(o.text)}</p>
          ${meta ? `<p class="meta">${esc(meta)}</p>` : ''}
        </article>`;
    })
    .join('');
}

function render() {
  if (!state) return;
  if (!state.city) {
    cityName.textContent = 'Города пока нет';
    gameDate.textContent = '';
    bg.hidden = true;
    panel.innerHTML = empty(
      state.generating ? 'Остров ещё поднимается. Загляни чуть позже.' : 'Сначала создай остров в чате с ботом.',
    );
    return;
  }
  cityName.textContent = state.city.name;
  gameDate.textContent = state.gameDate || '';
  if (state.city.hasImage) {
    bg.style.backgroundImage = `url("${islandBgUrl(state.city)}")`;
    bg.hidden = false;
  } else {
    bg.hidden = true;
  }
  const body =
    tab === 'events'
      ? renderEvents(state.events)
      : tab === 'processes'
        ? renderProcesses(state.processes, state.mana)
        : tab === 'orders'
          ? renderOrders(state.orders)
          : renderStats(state.stats, state.faith);
  panel.innerHTML = body;
}

async function load() {
  try {
    const res = await fetch(`/api/mini/state${queryAuth()}`, { headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      cityName.textContent = 'Город';
      panel.innerHTML = empty(
        data.error === 'need_telegram'
          ? 'Открой справочник из Telegram — кнопкой «Город» внизу чата.'
          : data.message || 'Не удалось открыть город.',
      );
      return;
    }
    state = data;
    render();
  } catch (err) {
    panel.innerHTML = empty(err.message || 'Нет связи с миром.');
  }
}

document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tab]');
  if (!btn) return;
  tab = btn.dataset.tab;
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('on', b === btn);
  render();
});

document.getElementById('panel').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-bless]');
  if (!btn) return;
  const processId = btn.getAttribute('data-bless');
  btn.disabled = true;
  try {
    const res = await fetch(`/api/mini/bless${queryAuth()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ processId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      btn.disabled = false;
      btn.textContent = data.message || data.error || 'не вышло';
      return;
    }
    await load();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = err.message || 'нет связи';
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void load();
});

void load();
