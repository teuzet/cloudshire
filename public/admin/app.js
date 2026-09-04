const $ = (id) => document.getElementById(id);

const STAT_NAMES = {
  prosperity: 'Благосостояние',
  security: 'Безопасность',
  knowledge: 'Знание',
  influence: 'Влияние',
};

const STAT_EPITHETS = [
  [0, 'ужасающе'],
  [12, 'плачевно'],
  [25, 'скудно'],
  [37, 'скромно'],
  [50, 'обычно'],
  [62, 'заметно'],
  [75, 'сильно'],
  [87, 'блистательно'],
  [100, 'божественно'],
];

const ENTITY_KIND_LABELS = {
  place: 'место',
  institution: 'институт',
  resource: 'ресурс',
  craft: 'ремесло',
  infrastructure: 'инфраструктура',
  custom: 'обычай',
  tension: 'напряжение',
  cult: 'культ',
  artifact: 'артефакт',
  substance: 'вещество',
  secret_place: 'тайное место',
};

const AXIS_LABELS = {
  landscapeForm: 'форма острова',
  climateBand: 'климат',
  settlementPattern: 'посадка города',
  productiveBase: 'чем живут',
  socialOrder: 'кто держит порядок',
  signatureDomain: 'узнаваемая черта',
  settlementExtent: 'размах поселения',
  historicalCondition: 'историческое состояние',
  civicTemper: 'нрав города',
  structuralPressure: 'давнее напряжение',
};

const ASPECT_TITLES = {
  overview: 'Общий облик',
  history: 'История и основание',
  geography: 'География и климат',
  districts: 'Районы и планировка',
  economy: 'Хозяйство и ресурсы',
  crafts: 'Ремёсла, техника или магия труда',
  society: 'Общество и сословия',
  customs: 'Обычаи и праздники',
  faith: 'Вера и культ покровителя',
  governance: 'Власть и закон',
  defense: 'Оборона и сила',
  knowledge: 'Знание и обучение',
  landmarks: 'Места силы и достопримечательности',
  transport: 'Пути и пространство острова',
  dailyLife: 'Повседневность',
  relations: 'Внешний горизонт и сопряжения',
  threats: 'Хронические риски',
  rumors: 'Предания и неизвестные области',
};

const BRIEF_UNKNOWN_RE = /\n*Неизвестно \(канон\):\s*/u;

let domainsCache = [];
let usersCache = [];
let activeTab = 'overview';
let openChat = null;
let view = {
  type: null,
  domainId: null,
  userId: null,
  domain: null,
  onboarding: null,
  lore: { entries: [], facts: [] },
  confluxes: [],
};

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

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtClock(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}

function epithet(value) {
  const n = Number(value);
  const v = Number.isFinite(n) ? n : 50;
  let label = STAT_EPITHETS[0][1];
  for (const [k, word] of STAT_EPITHETS) {
    if (k <= v) label = word;
  }
  return label;
}

function statName(id) {
  return STAT_NAMES[id] || id;
}

function empty(text) {
  return `<p class="muted">${esc(text)}</p>`;
}

function block(title, html) {
  return `<section class="ins-block"><h3>${esc(title)}</h3>${html}</section>`;
}

function keyVals(rows) {
  const items = (rows || []).filter((row) => row && row[1] != null && row[1] !== '');
  if (!items.length) return empty('нет данных');
  return `<div class="kvs">${items
    .map(
      ([k, v]) =>
        `<div class="kv"><span class="muted">${esc(k)}</span><span>${esc(v)}</span></div>`,
    )
    .join('')}</div>`;
}

function meter(value) {
  const n = Math.max(0, Math.min(100, Number(value) || 0));
  return `<div class="meter" title="${n} из 100"><span style="width:${n}%"></span></div>`;
}

function parseCityBrief(raw) {
  const text = String(raw || '').trim();
  if (!text) return { body: '', unknowns: [] };
  const parts = text.split(BRIEF_UNKNOWN_RE);
  if (parts.length === 1) return { body: text, unknowns: [] };
  const body = String(parts[0] || '').trim();
  const unknowns = String(parts.slice(1).join('\n') || '')
    .split('\n')
    .map((line) => line.replace(/^\s*[-•*]\s*/, '').trim())
    .filter(Boolean);
  return { body, unknowns };
}

function selected() {
  const v = $('domainSelect').value;
  if (!v) return null;
  if (v.startsWith('draft:')) return { type: 'draft', userId: v.slice(6) };
  return { type: 'domain', domainId: v };
}

function fillDomainSelect() {
  const sel = $('domainSelect');
  const prev = sel.value;
  sel.innerHTML = '';
  const drafts = (usersCache || []).filter((u) => u.onboarding && !u.domainId);

  if (!domainsCache.length && !drafts.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = 'нет городов';
    sel.appendChild(o);
    return;
  }

  if (domainsCache.length) {
    const group = document.createElement('optgroup');
    group.label = 'Города';
    for (const d of domainsCache) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = `${channelTag(d.channel)} ${d.name} · ${d.ownerUserId || '?'}`;
      group.appendChild(opt);
    }
    sel.appendChild(group);
  }

  if (drafts.length) {
    const group = document.createElement('optgroup');
    group.label = 'Онбординг';
    for (const u of drafts) {
      const opt = document.createElement('option');
      opt.value = `draft:${u.userId}`;
      const name = u.cityName || 'черновик';
      opt.textContent = `${channelTag(u.channel)} ${name} · ${u.userId}`;
      group.appendChild(opt);
    }
    sel.appendChild(group);
  }

  const wanted =
    prev ||
    (view.type === 'draft' && view.userId ? `draft:${view.userId}` : view.domainId) ||
    '';
  if (wanted && [...sel.options].some((o) => o.value === wanted)) sel.value = wanted;
  else sel.value = sel.options[0]?.value || '';
}

function fillConfluxDomainSelects(list) {
  for (const selId of ['confluxA', 'confluxB']) {
    const sel = $(selId);
    const prev = sel.value;
    sel.innerHTML = '';
    const emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = list.length ? '— выбери —' : 'нет доменов';
    sel.appendChild(emptyOpt);
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

function renderStatus(status) {
  const date = status.world?.gameDate?.label || 'нет даты';
  const tick = status.world?.tickIndex;
  const next = fmtClock(status.world?.scheduler?.nextTickAt);
  const last = fmtClock(status.world?.scheduler?.lastTickAt);
  const ticking = Boolean(status.worldTicking);
  const tg = status.telegram?.enabled ? 'Telegram вкл' : 'Telegram выкл';
  $('status').innerHTML =
    `<div class="date">${esc(date)}</div>` +
    `<div>тик ${esc(tick ?? '—')} · интервал ${esc(status.tickIntervalHours ?? '—')} ч</div>` +
    `<div class="muted small">след. ${esc(next || '—')}${last ? ` · прошлый ${esc(last)}` : ''}</div>` +
    `<div class="muted small">${esc(status.domainCount ?? 0)} городов · ${esc(status.storage || '—')} · ${esc(tg)}</div>` +
    (ticking ? '<div class="tick-flag">идёт шаг времени</div>' : '');
}

async function refreshConfluxUi() {
  const all = $('confluxFilter').value === 'all';
  const data = await api(`/api/confluxes${all ? '?all=1' : ''}`);
  const rows = data.confluxes || [];
  view.confluxes = rows;
  if (!rows.length) {
    $('confluxPanel').innerHTML = empty(all ? 'conflux нет' : 'активных conflux нет');
    return;
  }
  $('confluxPanel').innerHTML = rows
    .map((c) => {
      const names = (c.domainNames || c.domainIds || []).join(' ↔ ');
      let detail = '';
      if (c.status === 'approaching') {
        detail = `eta ${c.monthsUntilDock ?? '—'} мес.`;
      } else if (c.contact) {
        detail = `${c.contact.kind || '?'}${c.contact.description ? ` · ${String(c.contact.description).slice(0, 120)}` : ''}`;
      } else if (c.status === 'docked') {
        detail = `в стыковке ${c.monthsDocked ?? 0}/${c.durationMonths ?? '?'}`;
      } else {
        detail = c.status || '';
      }
      return (
        `<article class="conflux-card">` +
        `<div class="muted small">[${esc(c.status || '?')}]${c.rematch ? ' · повтор' : ''}</div>` +
        `<strong>${esc(names)}</strong>` +
        `<div class="muted small">${esc(detail)}</div>` +
        `</article>`
      );
    })
    .join('');
}

function activeConfluxFor(domainId) {
  if (!domainId) return null;
  return (view.confluxes || []).find((c) =>
    (c.domainIds || []).map(String).includes(String(domainId)),
  ) || null;
}

function renderStats(stats) {
  const row = $('statsRow');
  row.innerHTML = '';
  if (!stats || typeof stats !== 'object') return;
  const entries = Array.isArray(stats)
    ? stats.map((s) => [s.id || s.name, s.value])
    : Object.entries(stats);
  for (const [id, value] of entries) {
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    const el = document.createElement('div');
    el.className = 'stat';
    el.innerHTML =
      `<b>${esc(statName(id))}</b> <span class="val">${esc(n)}</span>` +
      ` <span class="muted">${esc(epithet(n))}</span>`;
    row.appendChild(el);
  }
}

function setImage(domain) {
  const wrap = $('cityImageWrap');
  const img = $('cityImage');
  const emptyEl = $('cityImageEmpty');
  if (!domain) {
    wrap.classList.add('hidden');
    img.removeAttribute('src');
    return;
  }
  wrap.classList.remove('hidden');
  const hasFile = Boolean(domain.imageUrl || domain.imagePath || domain.imageBase64);
  if (!hasFile) {
    img.classList.add('hidden');
    emptyEl.classList.remove('hidden');
    img.removeAttribute('src');
    return;
  }
  emptyEl.classList.add('hidden');
  img.classList.remove('hidden');
  const stamp = encodeURIComponent(domain.updatedAt || domain.lastTickAt || domain.id);
  img.src = `/api/domains/${encodeURIComponent(domain.id)}/image?t=${stamp}`;
  img.onerror = () => {
    img.classList.add('hidden');
    emptyEl.classList.remove('hidden');
  };
}

function renderHeader() {
  const domain = view.domain;
  const onboarding = view.onboarding;
  $('btnRulerChat').disabled = !domain;
  $('btnOnboardChat').disabled = !(onboarding || view.userId);

  if (view.type === 'draft') {
    $('cityTitle').textContent = onboarding?.cityName || 'черновик онбординга';
    $('citySub').textContent = [
      channelTag(onboarding?.channel),
      view.userId,
      onboarding?.phase ? `фаза ${onboarding.phase}` : null,
      onboarding?.generating ? 'идёт генезис' : null,
    ]
      .filter(Boolean)
      .join(' · ');
    $('statsRow').innerHTML = '';
    setImage(null);
    return;
  }

  if (!domain) {
    $('cityTitle').textContent = 'выбери город';
    $('citySub').textContent = '';
    $('statsRow').innerHTML = '';
    setImage(null);
    return;
  }

  const ruler = domain.characters?.[0];
  $('cityTitle').textContent = domain.name || domain.id;
  $('citySub').textContent = [
    channelTag(domain.channel),
    domain.ownerUserId,
    ruler ? `${ruler.name}${ruler.title ? `, ${ruler.title}` : ''}` : null,
    domain.state?.patronName ? `покровитель ${domain.state.patronName}` : null,
    domain.population != null ? `${domain.population} жит.` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  renderStats(domain.stats);
  setImage(domain);
}

function plotCard(p) {
  const kindLabel =
    p.kind === 'order' ? 'указ' : p.kind === 'errand' ? 'дело' : p.kind === 'story' ? 'история' : p.kind;
  const meta = [
    kindLabel,
    p.urgency != null ? `срочность ${p.urgency}` : null,
    p.gravity != null ? `масштаб ${p.gravity}` : null,
    p.temperature != null ? `жар ${p.temperature}` : null,
    p.maxAgeMonths != null ? `возраст ${p.ageMonths ?? 0}/${p.maxAgeMonths}` : null,
    p.beatCount != null ? `битов ${p.beatCount}` : null,
    p.durationMonths
      ? `срок ${p.durationMonths} мес.`
      : p.expiresTick != null
        ? `до тика ${p.expiresTick}`
        : p.kind === 'order'
          ? 'бессрочно'
          : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const text = p.orderText || p.synopsis || '';
  return (
    `<article class="ins-card"><h4>${esc(p.title || p.id)}</h4>` +
    (meta ? `<div class="muted small">${esc(meta)}</div>` : '') +
    (text ? `<p class="pre">${esc(text)}</p>` : '') +
    (p.closeWhen ? `<p class="muted small">закроется, когда: ${esc(p.closeWhen)}</p>` : '') +
    (p.relatedStats?.length ? `<p class="muted small">статы: ${esc(p.relatedStats.join(', '))}</p>` : '') +
    `<p class="muted small">${esc(p.id)}</p></article>`
  );
}

function processCard(p) {
  const total = p.expectedMonths ?? p.durationMonths ?? '?';
  const left = p.monthsLeft;
  const active = !p.status || p.status === 'active';
  const paused = p.status === 'paused';
  const clock = paused
    ? `пауза · осталось ${left ?? '?'} из ${total} мес.`
    : active
      ? `осталось ${left ?? '?'} из ${total} мес.`
      : `${p.status}${p.resolvedTick != null ? ` · тик ${p.resolvedTick}` : ''}`;
  const meta = [
    clock,
    p.linkedStats?.length ? `статы: ${p.linkedStats.join(', ')}` : null,
    p.office || null,
    p.initiative === 'ruler' ? 'сам правитель' : null,
    p.blessed ? 'благословлено' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    `<article class="ins-card${active || paused ? '' : ' dim'}"><h4>${esc(p.summary || p.title || p.id)}</h4>` +
    `<div class="muted small">${esc(meta)}</div>` +
    (p.goal ? `<p class="muted small">цель: ${esc(p.goal)}</p>` : '') +
    (p.detail ? `<p class="pre">${esc(p.detail)}</p>` : '') +
    `<p class="muted small">${esc(p.id)}</p></article>`
  );
}

function loreCard(e, extra = '') {
  const stats = e.statChanges
    ? Object.entries(e.statChanges)
        .map(([k, v]) => `${statName(k)} ${v.from}→${v.to}`)
        .join(', ')
    : '';
  const meta = [e.gameDateLabel, e.importance, e.author, stats, extra].filter(Boolean).join(' · ');
  return (
    `<article class="ins-card${e.retiredAt ? ' dim' : ''}">` +
    (meta ? `<div class="muted small">${esc(meta)}</div>` : '') +
    `<p class="pre">${esc(e.text || e.about || '')}</p></article>`
  );
}

function closedList(items, emptyText) {
  if (!items?.length) return empty(emptyText);
  return `<ul>${items
    .map(
      (p) =>
        `<li>${esc(p.title || p.id)} <span class="muted small">${esc(p.reason || p.closeReason || p.status || '')}</span></li>`,
    )
    .join('')}</ul>`;
}

function renderOverview() {
  const d = view.domain;
  if (!d) return empty('города ещё нет — открой онбординг');
  const ruler = d.characters?.[0];
  const solo = d.confluxMonthsSolo ?? 0;
  const docked = d.confluxMonthsDocked ?? 0;
  const cf = activeConfluxFor(d.id);
  const tags = (d.tags || []).map((t) => t.tagName || t.tagId).filter(Boolean);
  const out = [];
  out.push(
    block(
      'Город',
      keyVals([
        ['имя', d.name],
        ['id', d.id],
        ['статус', d.status],
        ['канал', d.channel],
        ['владелец', d.ownerUserId],
        ['население', d.population],
        ['покровитель', d.state?.patronName || 'ещё не назван'],
        ['вера', d.state?.faith],
        ['мана', d.state?.mana != null ? `${d.state.mana} / 100` : null],
        ['основан на тике', d.createdTick],
        ['последний тик', fmtClock(d.lastTickAt) || d.lastTickAt],
      ]),
    ),
  );
  const stats = d.stats && typeof d.stats === 'object' ? Object.entries(d.stats) : [];
  if (stats.length) {
    out.push(
      block(
        'Статы',
        stats
          .map(([id, value]) => {
            const n = Number(value);
            return (
              `<div class="kv"><span class="muted">${esc(statName(id))}</span><span>${esc(n)} · ${esc(epithet(n))}</span></div>` +
              meter(n)
            );
          })
          .join(''),
      ),
    );
  }
  if (ruler) {
    out.push(
      block(
        'Правитель',
        keyVals([
          ['имя', `${ruler.name}${ruler.title ? `, ${ruler.title}` : ''}`],
          ['возраст', ruler.ageYears != null ? `${ruler.ageYears} лет` : null],
          ['верность', ruler.loyalty],
          ['ужас', ruler.terror],
        ]) +
          (ruler.loyalty != null ? meter(ruler.loyalty) : '') +
          (ruler.terror != null ? meter(ruler.terror) : ''),
      ),
    );
  }
  if (tags.length) out.push(block('Метки', `<p>${esc(tags.join(', '))}</p>`));
  out.push(
    block(
      'Сопряжение',
      cf
        ? keyVals([
            ['статус', cf.status],
            ['партнёры', (cf.domainNames || []).join(' ↔ ')],
            ['до стыковки, мес.', cf.monthsUntilDock],
            ['в стыковке', cf.monthsDocked != null ? `${cf.monthsDocked}/${cf.durationMonths || '?'}` : null],
          ])
        : empty('сейчас остров идёт один'),
    ),
  );
  out.push(
    block(
      'Счёт сопряжений',
      keyVals([
        ['месяцев в соло', solo],
        ['месяцев в стыковке', docked],
        ['прежние партнёры', Object.keys(d.confluxPartners || {}).length || '—'],
      ]),
    ),
  );
  const log = d.state?.monthLog || [];
  if (log.length) {
    out.push(
      block(
        'Журнал этого месяца',
        `<ul>${log.map((m) => `<li>${esc(m.text || m)}</li>`).join('')}</ul>`,
      ),
    );
  }
  return out.join('');
}

function renderGenesis() {
  const d = view.domain;
  if (!d) return empty('города ещё нет');
  const out = [];
  if (d.description) out.push(block('Полное описание', `<p class="pre">${esc(d.description)}</p>`));
  const brief = d.playerBrief;
  if (brief && (brief.city || brief.ruler || brief.freeform)) {
    out.push(
      block(
        'Пожелания игрока',
        keyVals([
          ['город', brief.city],
          ['правитель', brief.ruler],
        ]) + (brief.freeform ? `<p class="pre">${esc(brief.freeform)}</p>` : ''),
      ),
    );
  }
  const concept = d.concept;
  if (concept && typeof concept === 'object') {
    const feats = (concept.definingFeatures || [])
      .map((f) => `<li><span class="muted small">[${esc(f.source || '')} ${esc(f.domain || '')}]</span> ${esc(f.description || '')}</li>`)
      .join('');
    const v = concept.backgroundViability || {};
    out.push(
      block(
        'Концепт',
        keyVals([
          ['имя', concept.name],
          ['радиус, км', concept.radiusKm],
          ['суть', concept.identity?.oneLine || concept.preview],
          ['правитель', concept.ruler ? `${concept.ruler.title || ''} ${concept.ruler.description || ''}`.trim() : null],
        ]) +
          (concept.landscape ? `<p class="pre">${esc(concept.landscape)}</p>` : '') +
          (feats ? `<ul>${feats}</ul>` : '') +
          keyVals([
            ['поселение', concept.settlement],
            ['хозяйство', concept.livelihood],
            ['общество', concept.society],
            ['история', concept.history],
            ['культура', concept.culture],
            ['культ', concept.patronCult],
            ['неизведанное', concept.unknownOrWildAreas],
            ['вода / еда / топливо / стройка', [v.water, v.food, v.fuel, v.construction].filter(Boolean).join(' · ') || null],
          ]),
      ),
    );
  }
  const seed = d.genesisSeed;
  if (seed && typeof seed === 'object') {
    const rows = Array.isArray(seed)
      ? seed.map((t) => [t.groupName || t.groupId, `${t.tagName || t.tagId || t.value || ''}${t.source ? ` · ${t.source}` : ''}`])
      : Object.entries(seed).map(([k, raw]) => {
          const row = raw && typeof raw === 'object' ? raw : { value: raw };
          return [AXIS_LABELS[k] || k, `${row.value || row.tagName || '—'}${row.source ? ` · ${row.source}` : ''}`];
        });
    if (rows.length) out.push(block('Оси генезиса', keyVals(rows)));
  }
  const dirs = d.playerDirectives;
  if (dirs) {
    const lists = [
      ['обязательно', dirs.required],
      ['желательно', dirs.preferred],
      ['нельзя', dirs.forbidden],
    ]
      .filter(([, list]) => list?.length)
      .map(([label, list]) => `<p><span class="muted">${esc(label)}:</span> ${esc(list.join('; '))}</p>`)
      .join('');
    const conflicts = (dirs.unresolvedConflicts || [])
      .map((c) => `<li>${esc(c.requested || '')}${c.reason ? ` — ${esc(c.reason)}` : ''}</li>`)
      .join('');
    if (lists || conflicts) {
      out.push(block('Директивы', lists + (conflicts ? `<ul>${conflicts}</ul>` : '')));
    }
  }
  const aspects = d.aspects && typeof d.aspects === 'object' ? Object.entries(d.aspects) : [];
  for (const [id, text] of aspects) {
    if (!String(text || '').trim()) continue;
    out.push(block(ASPECT_TITLES[id] || id, `<p class="pre">${esc(text)}</p>`));
  }
  if (!out.length) return empty('генезиса пока нет');
  return out.join('');
}

function renderBrief() {
  const d = view.domain;
  if (!d) return empty('города ещё нет');
  const parsed = parseCityBrief(d.cityBrief);
  const out = [];
  out.push(
    block(
      'Бриф города',
      parsed.body ? `<p class="pre">${esc(parsed.body)}</p>` : empty('брифа нет'),
    ),
  );
  if (parsed.unknowns.length) {
    out.push(
      block(
        'Неизвестно (канон)',
        `<ul>${parsed.unknowns.map((u) => `<li>${esc(u)}</li>`).join('')}</ul>`,
      ),
    );
  }
  const entities = d.cityEntities || [];
  if (entities.length) {
    const byKind = new Map();
    for (const e of entities) {
      const kind = e.kind || 'place';
      if (!byKind.has(kind)) byKind.set(kind, []);
      byKind.get(kind).push(e);
    }
    for (const [kind, list] of byKind) {
      out.push(
        block(
          `${ENTITY_KIND_LABELS[kind] || kind} (${list.length})`,
          list
            .map(
              (e) =>
                `<article class="ins-card"><h4>${esc(e.name)}</h4>` +
                (e.about ? `<p class="pre">${esc(e.about)}</p>` : '') +
                `</article>`,
            )
            .join(''),
        ),
      );
    }
  } else {
    out.push(block('Якоря города', empty('якорей нет')));
  }
  return out.join('');
}

function splitPlots(domain) {
  const open = domain?.plotlines || [];
  const closed = domain?.closedPlotlines || [];
  const is = (p, kind) => String(p?.kind || 'story') === kind;
  return {
    stories: open.filter((p) => is(p, 'story')),
    orders: open.filter((p) => is(p, 'order')),
    errands: open.filter((p) => is(p, 'errand')),
    closedStories: closed.filter((p) => is(p, 'story') || !p.kind),
    closedOrders: closed.filter((p) => is(p, 'order')),
  };
}

function renderStories() {
  const d = view.domain;
  if (!d) return empty('города ещё нет');
  const { stories, closedStories } = splitPlots(d);
  return (
    block(
      `Истории (${stories.length})`,
      stories.length ? stories.map(plotCard).join('') : empty('открытых историй нет'),
    ) +
    (closedStories.length ? block('Закрытые истории', closedList(closedStories, 'нет')) : '')
  );
}

function renderOrders() {
  const d = view.domain;
  if (!d) return empty('города ещё нет');
  const { orders, closedOrders } = splitPlots(d);
  const mods = d.state?.modifiers || d.modifiers || [];
  const requests = d.state?.pendingOrderRequests || [];
  const out = [
    block(
      `Указы (${orders.length})`,
      orders.length ? orders.map(plotCard).join('') : empty('действующих указов нет'),
    ),
  ];
  if (mods.length) {
    out.push(
      block(
        `Постоянные следы (${mods.length})`,
        mods
          .map(
            (m) =>
              `<article class="ins-card"><h4>${esc(m.text || m.summary || m.id)}</h4>` +
              `<div class="muted small">${esc(
                [m.indefinite === false || m.durationMonths ? `${m.durationMonths || m.remainingMonths || '?'} мес.` : 'бессрочно', m.by || m.initiative]
                  .filter(Boolean)
                  .join(' · '),
              )}</div></article>`,
          )
          .join(''),
      ),
    );
  }
  if (requests.length) {
    out.push(
      block(
        'Заявки на указы',
        requests
          .map((r) => {
            const text = r.text || r.summary || r.orderText || '';
            const meta = [r.status, r.durationMonths ? `${r.durationMonths} мес.` : null]
              .filter(Boolean)
              .join(' · ');
            return (
              `<article class="ins-card">` +
              (meta ? `<div class="muted small">${esc(meta)}</div>` : '') +
              (text ? `<p class="pre">${esc(text)}</p>` : empty('заявка без текста')) +
              `</article>`
            );
          })
          .join(''),
      ),
    );
  }
  if (closedOrders.length) out.push(block('Снятые указы', closedList(closedOrders, 'нет')));
  return out.join('');
}

function personCard({ name, title, meta, about, portraitUrl }) {
  const fallback = `<div class="person-fallback">${esc(title || 'нет портрета')}</div>`;
  const pic = portraitUrl
    ? `<img src="${esc(portraitUrl)}" alt="" />`
    : fallback;
  return (
    `<article class="ins-card person-card">${pic}<div>` +
    `<h4>${esc(name)}${title ? ` <span class="muted small">${esc(title)}</span>` : ''}</h4>` +
    (meta ? `<div class="muted small">${esc(meta)}</div>` : '') +
    (about ? `<p class="pre">${esc(about)}</p>` : '') +
    `</div></article>`
  );
}

function renderPeople() {
  const d = view.domain;
  if (!d) return empty('города ещё нет');
  const out = [];
  const ruler = d.characters?.[0];
  if (ruler) {
    out.push(
      block(
        'Правитель',
        personCard({
          name: ruler.name,
          title: ruler.title,
          meta: [
            Number.isFinite(Number(ruler.ageYears)) ? `${ruler.ageYears} лет` : null,
            ruler.gender,
            `верность ${ruler.loyalty ?? '—'}`,
            `ужас ${ruler.terror ?? '—'}`,
          ]
            .filter(Boolean)
            .join(' · '),
          about: ruler.description,
          portraitUrl: ruler.portraitUrl || ruler.portrait || null,
        }),
      ),
    );
  }
  const officers = d.officers || [];
  if (officers.length) {
    out.push(
      block(
        `Сановники (${officers.length})`,
        officers
          .map((o) =>
            personCard({
              name: o.name,
              title: o.title || o.office,
              meta: [
                o.statId ? statName(o.statId) : null,
                o.look?.ageYears != null ? `${o.look.ageYears} лет` : null,
                o.axes
                  ? `воля ${o.axes.will ?? '—'} · ум ${o.axes.wits ?? '—'} · милость ${o.axes.mercy ?? '—'}`
                  : null,
              ]
                .filter(Boolean)
                .join(' · '),
              about: o.nature,
              portraitUrl: o.portraitUrl || null,
            }),
          )
          .join(''),
      ),
    );
  }
  const cast = (d.lore || []).filter((f) => (f.tags || []).includes('character') && !f.retiredAt);
  if (cast.length) {
    out.push(
      block(
        `Люди города (${cast.length})`,
        cast
          .map((c) =>
            personCard({
              name: c.name,
              title: c.role,
              meta: [
                Number.isFinite(Number(c.ageYears)) ? `${c.ageYears} лет` : null,
                c.gender,
                c.status && c.status !== 'alive' ? c.status : null,
              ]
                .filter(Boolean)
                .join(' · '),
              about: c.about || c.text,
            }),
          )
          .join(''),
      ),
    );
  }
  if (!out.length) return empty('людей пока нет');
  return out.join('');
}

function renderChronicle() {
  const list = [...(view.lore?.entries || [])].reverse();
  if (!list.length) return block('Хроника', empty('записей пока нет'));
  const plots = [...(view.domain?.plotlines || []), ...(view.domain?.closedPlotlines || [])];
  const byId = Object.fromEntries(plots.filter((p) => p?.id).map((p) => [String(p.id), p.title || p.id]));
  return block(
    `Хроника (${list.length})`,
    list
      .map((e) => {
        const links = (e.relatedPlotlineIds || []).map((id) => byId[String(id)] || id).filter(Boolean);
        return loreCard(e, links.length ? `нить: ${links.join(', ')}` : '');
      })
      .join(''),
  );
}

function renderFacts() {
  const list = view.lore?.facts || [];
  if (!list.length) return block('Факты', empty('фактов пока нет'));
  const live = list.filter((f) => !f.retiredAt);
  return block(`Факты (${live.length} живых из ${list.length})`, list.map((f) => loreCard(f)).join(''));
}

function renderProcesses() {
  const d = view.domain;
  if (!d) return empty('города ещё нет');
  const list = d.state?.pendingActions || d.processes || [];
  const { errands } = splitPlots(d);
  const active = list.filter((p) => !p.status || p.status === 'active' || p.status === 'paused');
  const done = list.filter((p) => p.status && p.status !== 'active' && p.status !== 'paused');
  const out = [
    block(
      `Дела (${active.length})`,
      active.length ? active.map(processCard).join('') : empty('активных дел нет'),
    ),
  ];
  if (done.length) out.push(block(`Закрытые дела (${done.length})`, done.map(processCard).join('')));
  if (errands.length) out.push(block('Поручения-нити', errands.map(plotCard).join('')));
  return out.join('');
}

function renderConfluxTab() {
  const d = view.domain;
  if (!d) return empty('города ещё нет');
  const cf = activeConfluxFor(d.id);
  const hist = block(
    'Счёт сопряжений',
    keyVals([
      ['месяцев в соло', d.confluxMonthsSolo ?? 0],
      ['месяцев в стыковке', d.confluxMonthsDocked ?? 0],
      [
        'прежние партнёры',
        Object.entries(d.confluxPartners || {})
          .map(([id, n]) => `${id} × ${n}`)
          .join(', ') || '—',
      ],
    ]),
  );
  if (!cf) return block('Сопряжение', empty('сейчас остров идёт один')) + hist;
  const contact = cf.contact || {};
  return (
    block(
      'Сопряжение',
      keyVals([
        ['статус', cf.status],
        ['id', cf.id],
        ['партнёры', (cf.domainNames || cf.domainIds || []).join(' ↔ ')],
        ['повторная', cf.rematch ? 'да' : 'нет'],
        ['до стыковки, мес.', cf.monthsUntilDock],
        ['стыковка на тике', cf.dockAtTick],
        ['в стыковке', `${cf.monthsDocked ?? 0}/${cf.durationMonths ?? '?'}`],
        ['проход', contact.kind],
        ['описание прохода', contact.description],
        ['контроль', contact.control],
      ]),
    ) + hist
  );
}

const TAB_RENDER = {
  overview: renderOverview,
  genesis: renderGenesis,
  brief: renderBrief,
  stories: renderStories,
  orders: renderOrders,
  people: renderPeople,
  chronicle: renderChronicle,
  facts: renderFacts,
  processes: renderProcesses,
  conflux: renderConfluxTab,
};

function renderTab() {
  for (const btn of document.querySelectorAll('#cityTabs .tab')) {
    btn.classList.toggle('active', btn.dataset.tab === activeTab);
  }
  const render = TAB_RENDER[activeTab];
  $('tabBody').innerHTML = render ? render() : empty('нет вкладки');
}

function fillChat(messages, { title, meta, userLabel, botLabel, emptyText }) {
  $('chatTitle').textContent = title;
  $('chatMeta').textContent = meta || '';
  const box = $('chatMessages');
  box.innerHTML = '';
  if (!messages?.length) {
    const el = document.createElement('div');
    el.className = 'bubble bot';
    el.textContent = emptyText;
    box.appendChild(el);
    return;
  }
  const slice = messages.length > 80 ? messages.slice(-80) : messages;
  if (messages.length > slice.length) {
    const note = document.createElement('div');
    note.className = 'bubble bot';
    note.textContent = `… показаны последние ${slice.length} из ${messages.length} реплик`;
    box.appendChild(note);
  }
  for (const m of slice) {
    const el = document.createElement('div');
    const role = m.role === 'user' ? 'user' : 'bot';
    el.className = `bubble ${role}`;
    const who = m.role === 'user' ? userLabel : botLabel;
    const kind = m.kind ? ` · ${m.kind}` : '';
    const at = m.at ? ` · ${fmtClock(m.at) || m.at}` : '';
    const metaEl = document.createElement('span');
    metaEl.className = 'meta';
    metaEl.textContent = `${who}${kind}${at}`;
    el.appendChild(metaEl);
    el.appendChild(document.createTextNode(m.content || ''));
    box.appendChild(el);
  }
  box.scrollTop = box.scrollHeight;
}

function renderOpenChat() {
  if (!openChat) return;
  if (openChat === 'ruler') {
    const domain = view.domain;
    const ruler = domain?.characters?.[0];
    fillChat(ruler?.dialogHistory || [], {
      title: 'Диалог с правителем',
      meta: domain ? `${domain.name} · ${ruler?.name || 'правитель'}` : '',
      userLabel: 'покровитель',
      botLabel: ruler?.name || 'правитель',
      emptyText: 'диалог пока пуст',
    });
    return;
  }
  const onb = view.onboarding;
  fillChat(onb?.messages || [], {
    title: 'Онбординг',
    meta: [onb?.cityName, onb?.userId, onb?.phase].filter(Boolean).join(' · '),
    userLabel: 'покровитель',
    botLabel: 'проводник',
    emptyText: 'чат онбординга пуст',
  });
}

function openChatWindow(kind) {
  openChat = kind;
  $('chatOverlay').classList.remove('hidden');
  renderOpenChat();
}

function closeChatWindow() {
  openChat = null;
  $('chatOverlay').classList.add('hidden');
}

function clearView() {
  view = {
    type: null,
    domainId: null,
    userId: null,
    domain: null,
    onboarding: null,
    lore: { entries: [], facts: [] },
    confluxes: view.confluxes || [],
  };
}

async function loadSelection() {
  const sel = selected();
  if (!sel) {
    clearView();
    renderHeader();
    renderTab();
    if (openChat) renderOpenChat();
    return;
  }

  if (sel.type === 'draft') {
    const onboarding = await api(`/api/users/${encodeURIComponent(sel.userId)}/onboarding`).catch(() => null);
    view = {
      ...view,
      type: 'draft',
      domainId: null,
      userId: sel.userId,
      domain: null,
      onboarding,
      lore: { entries: [], facts: [] },
    };
    renderHeader();
    renderTab();
    if (openChat === 'ruler') closeChatWindow();
    else if (openChat) renderOpenChat();
    return;
  }

  const domainId = sel.domainId;
  const [domain, onboarding, lore] = await Promise.all([
    api(`/api/domains/${encodeURIComponent(domainId)}`),
    api(`/api/domains/${encodeURIComponent(domainId)}/onboarding`).catch(() => null),
    api(`/api/domains/${encodeURIComponent(domainId)}/chronicle`).catch(() => ({ entries: [], facts: [] })),
  ]);
  view = {
    ...view,
    type: 'domain',
    domainId,
    userId: domain.ownerUserId || onboarding?.userId || null,
    domain,
    onboarding,
    lore: { entries: lore.entries || [], facts: lore.facts || [] },
  };
  renderHeader();
  renderTab();
  if (openChat) renderOpenChat();
}

async function refresh() {
  const status = await api('/api/status');
  renderStatus(status);
  const [domains, users] = await Promise.all([api('/api/domains'), api('/api/users').catch(() => [])]);
  domainsCache = domains;
  usersCache = users;
  fillDomainSelect();
  fillConfluxDomainSelects(domainsCache);
  await refreshConfluxUi();
  try {
    await loadSelection();
  } catch (err) {
    renderHeader();
    $('tabBody').innerHTML = empty(err.message || 'не удалось загрузить город');
  }
}

$('domainSelect').addEventListener('change', () => {
  void loadSelection();
});

$('cityTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  activeTab = btn.dataset.tab;
  renderTab();
});

$('btnRefresh').addEventListener('click', () => void refresh());
$('btnConfluxRefresh').addEventListener('click', () => void refreshConfluxUi());
$('confluxFilter').addEventListener('change', () => void refreshConfluxUi());

$('btnRulerChat').addEventListener('click', () => openChatWindow('ruler'));
$('btnOnboardChat').addEventListener('click', () => openChatWindow('onboarding'));
$('btnChatClose').addEventListener('click', () => closeChatWindow());
$('chatOverlay').addEventListener('click', (e) => {
  if (e.target === $('chatOverlay')) closeChatWindow();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openChat) closeChatWindow();
});

$('btnTick').addEventListener('click', async () => {
  if (!confirm('Прокрутить месяц для ВСЕХ городов?')) return;
  $('btnTick').disabled = true;
  $('btnTick').classList.add('busy');
  try {
    const result = await api('/api/tick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    alert(`Tick ok · ${result.world?.gameDate?.label || ''} · domains ${result.results?.length ?? 0}`);
    await refresh();
  } catch (err) {
    alert(err.message);
  } finally {
    $('btnTick').disabled = false;
    $('btnTick').classList.remove('busy');
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
    await api('/api/dev/wipe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    view.domainId = null;
    view.userId = null;
    closeChatWindow();
    await refresh();
  } catch (err) {
    alert(err.message);
  }
});

void refresh();
setInterval(() => void refresh(), 30000);
