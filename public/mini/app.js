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
const sheet = document.getElementById('sheet');
const sheetBody = document.getElementById('sheetBody');

let state = null;
let tab = 'stats';
let cityTab = 'description';
let openOfficerId = null;

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

function genderLabel(gender) {
  if (gender === 'female') return 'женщина';
  if (gender === 'male') return 'мужчина';
  return '';
}

function portraitButton(slot) {
  const id = slot?.officerId || '';
  const src = portraitSrc(slot);
  const inner = src
    ? `<img class="portrait" src="${esc(src)}" alt="">`
    : '';
  return `<button type="button" class="portrait-btn${src ? '' : ' blank'}" data-open-officer="${esc(id)}" aria-label="Подробнее">${inner}</button>`;
}

/** Сколько ждать: игровой срок и рядом реальный, чтобы игрок мог спланировать. */
function waitText(days, real) {
  if (days == null) return '';
  const d = Math.max(0, Math.round(days));
  const word = d % 10 === 1 && d % 100 !== 11 ? 'день' : d % 10 >= 2 && d % 10 <= 4 && (d % 100 < 12 || d % 100 > 14) ? 'дня' : 'дней';
  return real ? `${d} ${word} (${real})` : `${d} ${word}`;
}

function processMeta(p) {
  if (!p) return '';
  const stats = p.linkedStats?.length ? p.linkedStats.join(', ') : '';
  const pause = p.paused ? 'на паузе' : '';
  const left = p.remainingDays != null ? `ещё ${waitText(p.remainingDays, p.remainingReal)}` : '';
  const span = p.totalDays ? `всего ${waitText(p.totalDays)}` : '';
  const hard = p.impossible ? 'невыполнимо' : p.difficulty ? `дело ${p.difficulty}` : '';
  const pace = p.pace && p.pace !== 'обычно' ? p.pace : '';
  const blessed = p.blessed ? 'благословлено' : '';
  const chances = p.finishChances;
  const odds = chances
    ? `исход: провал ${chances.fail}% · успех ${chances.ok}% · крит ${chances.crit}%`
    : '';
  return [pause, left, span, hard, pace, stats, blessed, odds].filter(Boolean).join(' · ');
}

function blessMarkup(p) {
  if (!p || p.paused || p.blessed || !p.id) return '';
  if (p.canBless) {
    return `<button type="button" class="bless-btn" data-bless="${esc(p.id)}">благословить · ${esc(p.blessCost)} маны</button>`;
  }
  return `<p class="meta">благословить · ${esc(p.blessCost)} маны (не хватает)</p>`;
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
      const portrait = portraitButton(slot);
      if (!p) {
        return `
        <article class="card officer">
          ${portrait}
          <h2>${esc(slot.title)} ${esc(slot.name)}</h2>
          <p class="meta">свободен</p>
        </article>`;
      }
      const meta = processMeta(p);
      return `
        <article class="card officer">
          ${portrait}
          <h2>${esc(slot.title)} ${esc(slot.name)}</h2>
          <p>${esc(p.summary)}</p>
          ${p.detail ? `<p class="muted">${esc(p.detail)}</p>` : ''}
          ${meta ? `<p class="meta">${esc(meta)}</p>` : ''}
          ${blessMarkup(p)}
        </article>`;
    })
    .join('');
  return manaCard + cards;
}

function closeSheet() {
  openOfficerId = null;
  if (!sheet || sheet.hidden) return;
  sheet.hidden = true;
  if (sheetBody) sheetBody.innerHTML = '';
  try {
    tg?.BackButton?.hide();
  } catch {
    /* вне Telegram */
  }
}

function openOfficerSheet(officerId, { focus = true } = {}) {
  if (!officerId) return;
  const slot = (state?.processes || []).find((p) => p.officerId === officerId);
  if (!slot || !sheet || !sheetBody) return;
  const proc = slot.process;
  const src = portraitSrc(slot);
  const nature = (slot.nature || '').trim();
  const temper = (slot.temper || '').trim();
  const metaBits = [];
  if (slot.ageYears != null) metaBits.push(`${slot.ageYears} лет`);
  const gender = genderLabel(slot.gender);
  if (gender) metaBits.push(gender);
  const procMeta = proc ? processMeta(proc) : '';
  const procBlock = proc
    ? `<section class="sheet-section">
        <h3>Дело</h3>
        <p>${esc(proc.summary || '')}</p>
        ${proc.detail ? `<p class="muted">${esc(proc.detail)}</p>` : ''}
        ${procMeta ? `<p class="meta">${esc(procMeta)}</p>` : ''}
        ${blessMarkup(proc)}
      </section>`
    : `<p class="meta">свободен</p>`;
  sheetBody.innerHTML = `
    ${src
      ? `<img class="sheet-portrait" src="${esc(src)}" alt="">`
      : `<div class="sheet-portrait blank" aria-hidden="true"></div>`}
    ${slot.title ? `<p class="sheet-kicker">${esc(slot.title)}</p>` : ''}
    <h2 id="sheetTitle">${esc(slot.name || '')}</h2>
    ${metaBits.length ? `<p class="muted">${esc(metaBits.join(' · '))}</p>` : ''}
    ${temper ? `<p class="muted">${esc(temper)}</p>` : ''}
    ${nature ? `<section class="sheet-section"><h3>Характер</h3><p>${esc(nature)}</p></section>` : ''}
    ${procBlock}
  `;
  openOfficerId = officerId;
  sheet.hidden = false;
  try {
    tg?.BackButton?.show();
  } catch {
    /* вне Telegram */
  }
  if (focus) sheet.querySelector('.sheet-close')?.focus();
}

function scaleMarks(event) {
  const total = Math.max(1, Math.round(Number(event.marksTotal) || 4));
  const lit = Math.max(0, Math.min(total, Math.round(Number(event.marks) || 0)));
  const label = event.scale ? esc(event.scale) : '';
  const marks = Array.from({ length: total }, (_, i) =>
    `<span class="shard${i < lit ? ' lit' : ''}" aria-hidden="true">!</span>`,
  ).join('');
  return `<p class="scale">${label ? `<span class="scale-name">${label}</span>` : ''}<span class="shards" aria-label="${lit} из ${total}">${marks}</span></p>`;
}

function renderEvents(events) {
  if (!events?.length) return empty('Сейчас нет открытых историй.');
  return events
    .map((e) => {
      const deeds = e.processes?.length
        ? e.processes
            .map((p) => {
              const left =
                p.remainingDays != null
                  ? ` · ещё ${waitText(p.remainingDays, p.remainingReal)}`
                  : p.paused
                    ? ' · на паузе'
                    : '';
              return `<p class="meta">${esc(p.summary)}${esc(left)}</p>`;
            })
            .join('')
        : '<p class="meta">Связанных дел нет.</p>';
      return `
        <article class="card">
          <h2>${esc(e.title)}</h2>
          ${scaleMarks(e)}
          <p>${esc(e.synopsis)}</p>
          ${deeds}
        </article>`;
    })
    .join('');
}

function renderOrders(list) {
  if (!list?.length) return empty('Постоянного порядка в городе нет.');
  return list
    .map((o) => {
      const when = o.since ? `заведено: ${o.since}` : '';
      return `
        <article class="card">
          <p>${esc(o.text)}</p>
          ${when ? `<p class="meta">${esc(when)}</p>` : ''}
        </article>`;
    })
    .join('');
}

function renderSections(sections) {
  return sections
    .map((s) => {
      const paras = String(s.text || '')
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => `<p>${esc(p)}</p>`)
        .join('');
      return `
        <article class="card lore">
          <h2>${esc(s.title)}</h2>
          ${paras || `<p>${esc(s.text || '')}</p>`}
        </article>`;
    })
    .join('');
}

function renderChronicle(entries) {
  if (!entries.length) return empty('Хроника пока пуста.');
  return entries
    .map(
      (f) => `
        <article class="card lore">
          ${f.date ? `<p class="meta">${esc(f.date)}</p>` : ''}
          <p>${esc(f.text)}</p>
        </article>`,
    )
    .join('');
}

function renderPeople(people) {
  if (!people.length) return empty('Город пока безымянен.');
  return people
    .map((p) => {
      const meta = [p.role, p.ageYears ? `${p.ageYears} лет` : '', p.dead ? 'мёртв' : '']
        .filter(Boolean)
        .join(' · ');
      return `
        <article class="card lore">
          <h2>${esc(p.name)}</h2>
          ${meta ? `<p class="meta">${esc(meta)}</p>` : ''}
          ${p.about ? `<p>${esc(p.about)}</p>` : ''}
        </article>`;
    })
    .join('');
}

function renderCity(city) {
  const tabs = city?.tabs || [];
  if (!tabs.length) {
    const sections = city?.sections || [];
    return sections.length ? renderSections(sections) : empty('Описания города пока нет.');
  }
  const active = tabs.find((t) => t.id === cityTab) || tabs[0];
  const nav = tabs
    .map(
      (t) =>
        `<button type="button" class="subtab${t.id === active.id ? ' on' : ''}" data-city-tab="${esc(t.id)}">${esc(t.title)}</button>`,
    )
    .join('');
  const body = active.entries
    ? renderChronicle(active.entries)
    : active.people
      ? renderPeople(active.people)
      : renderSections(active.sections || []);
  return `<nav class="subtabs">${nav}</nav>${body}`;
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
          : tab === 'city'
            ? renderCity(state.city)
            : renderStats(state.stats, state.faith);
  panel.innerHTML = body;
  if (openOfficerId) {
    const still = (state.processes || []).some((p) => p.officerId === openOfficerId);
    if (still) openOfficerSheet(openOfficerId, { focus: false });
    else closeSheet();
  }
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

async function blessProcess(processId, btn) {
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(`/api/mini/bless${queryAuth()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ processId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (btn) {
        btn.disabled = false;
        btn.textContent = data.message || data.error || 'не вышло';
      }
      return;
    }
    closeSheet();
    await load();
  } catch (err) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = err.message || 'нет связи';
    }
  }
}

document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tab]');
  if (!btn) return;
  tab = btn.dataset.tab;
  closeSheet();
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('on', b === btn);
  render();
});

panel.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-city-tab]');
  if (!btn) return;
  cityTab = btn.dataset.cityTab;
  render();
});

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-close-sheet]')) {
    closeSheet();
    return;
  }
  const portraitBtn = e.target.closest('[data-open-officer]');
  if (portraitBtn) {
    openOfficerSheet(portraitBtn.getAttribute('data-open-officer'));
    return;
  }
  const blessBtn = e.target.closest('[data-bless]');
  if (blessBtn && !blessBtn.disabled) {
    void blessProcess(blessBtn.getAttribute('data-bless'), blessBtn);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSheet();
});

try {
  tg?.BackButton?.onClick(closeSheet);
} catch {
  /* вне Telegram */
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void load();
});

void load();
