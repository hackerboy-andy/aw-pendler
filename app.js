'use strict';

// Stations verified 2026-09-01 via https://api.transitous.org/api/v1/geocode
// (DELFI parent-stop IDs — resolve platforms/tracks automatically, no synthetic walk leg)
const STATIONS = {
  MUC: { id: 'de-DELFI_de:09162:100', name: 'München Hbf', short: 'München' },
  NUE: { id: 'de-DELFI_de:09564:510', name: 'Nürnberg Hbf', short: 'Nürnberg' },
};

const API_BASE = 'https://api.transitous.org/api/v3/plan';
const MIN_FETCH_INTERVAL_MS = 60_000;
const DIRECT_WINDOW_MS = 3 * 60 * 60 * 1000;
const NUM_ITINERARIES = 4;
// Fetch more than we display, since MAX_DURATION_MIN filters some out
// (e.g. the occasional much-slower RB16 routing) — keeps the shown list at 4.
const FETCH_BATCH_SIZE = 8;
const MAX_DURATION_MIN = 130; // 2:10 Std — hide unusually slow routings by default
const RELAXED_DURATION_MIN = 180; // 3:00 Std — one-tap escape hatch for a bad connection window
const FAST_DURATION_MIN = 110; // 1:50 Std — highlight as a best pick
const TRANSFER_MAX_MIN = 120; // 2:00 Std — cap for the manual "auch mit Umstieg" toggle
const FETCH_TIMEOUT_MS = 12_000;
const TICK_INTERVAL_MS = 15_000;

// Session-only overrides (not persisted) — one-tap escape hatches, not
// settings: "I'm stuck between two trains" (showSlow) and "maybe a transfer
// beats waiting for the next direct" (showTransfers).
const state = { lastError: null, showSlow: false, showTransfers: false, transfersLoading: false };
// Accumulated "Später anzeigen" pages per direction, in-memory only (not
// persisted) — reset whenever a fresh network fetch lands for that direction.
const moreState = {};

// ---------- direction ----------

function computeDefaultDirection() {
  return new Date().getHours() < 12 ? 'MUC_NUE' : 'NUE_MUC';
}

function getDirection() {
  return sessionStorage.getItem('pendler.directionOverride') || computeDefaultDirection();
}

function setDirection(dir) {
  sessionStorage.setItem('pendler.directionOverride', dir);
}

function stationsForDirection(dir) {
  return dir === 'MUC_NUE'
    ? { from: STATIONS.MUC, to: STATIONS.NUE }
    : { from: STATIONS.NUE, to: STATIONS.MUC };
}

function cacheKey(dir) {
  return `pendler.cache.${dir}`;
}

// ---------- API ----------

async function fetchPlanPage(fromId, toId, { maxTransfers, numItineraries, time }) {
  const url = new URL(API_BASE);
  url.searchParams.set('fromPlace', fromId);
  url.searchParams.set('toPlace', toId);
  url.searchParams.set('numItineraries', String(numItineraries));
  url.searchParams.set('transitModes', 'REGIONAL_RAIL,BUS');
  if (maxTransfers !== undefined) url.searchParams.set('maxTransfers', String(maxTransfers));
  if (time) url.searchParams.set('time', time);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return { itineraries: (data.itineraries || []).map(parseItinerary) };
  } finally {
    clearTimeout(timer);
  }
}

function parseItinerary(raw) {
  const legs = (raw.legs || []).filter((l) => l.mode !== 'WALK');
  const first = legs[0];
  const last = legs[legs.length - 1];
  return {
    transfers: raw.transfers,
    cancelled: legs.some((l) => l.cancelled),
    legs: legs.map((l) => ({
      mode: l.mode,
      isBus: l.mode === 'BUS',
      line: l.routeShortName || l.displayName || l.mode,
      fromName: l.from.name,
      fromTrack: l.from.track || l.from.scheduledTrack || null,
      toName: l.to.name,
      toTrack: l.to.track || l.to.scheduledTrack || null,
      schedDep: l.scheduledStartTime,
      realDep: l.startTime,
      schedArr: l.scheduledEndTime,
      realArr: l.endTime,
      cancelled: !!l.cancelled,
    })),
    departure: { sched: first.scheduledStartTime, real: first.startTime },
    arrival: { sched: last.scheduledEndTime, real: last.endTime },
  };
}

function scheduledDurationMin(it) {
  const dep = new Date(it.departure.sched).getTime();
  const arr = new Date(it.arrival.sched).getTime();
  return Math.round((arr - dep) / 60000);
}

function withinMaxDuration(it) {
  return scheduledDurationMin(it) <= MAX_DURATION_MIN;
}

function withinEffectiveDuration(it) {
  const max = state.showSlow ? RELAXED_DURATION_MIN : MAX_DURATION_MIN;
  return scheduledDurationMin(it) <= max;
}

// ---------- loading orchestration ----------

async function loadDepartures(direction, { force = false } = {}) {
  updateDirectionButtons(direction);
  paintFromCache(direction);

  const now = Date.now();
  const lastFetchAt = Number(localStorage.getItem('pendler.lastFetchAt') || 0);
  if (!force && now - lastFetchAt < MIN_FETCH_INTERVAL_MS) return;

  setRefreshing(true);
  localStorage.setItem('pendler.lastFetchAt', String(now));
  const { from, to } = stationsForDirection(direction);

  try {
    // Stored unfiltered by duration — the display filter (strict 2:10h by
    // default, relaxed to 3h via the "Auch bis 3h zeigen" toggle) is applied
    // at render time so toggling never needs a fresh network request.
    const primaryPage = await fetchPlanPage(from.id, to.id, { maxTransfers: 0, numItineraries: FETCH_BATCH_SIZE });
    const primary = primaryPage.itineraries;

    const hasDirectSoon = primary.filter(withinMaxDuration).some((it) => {
      const t = new Date(it.departure.real || it.departure.sched).getTime();
      return t - now <= DIRECT_WINDOW_MS;
    });

    // Fetched whenever no direct train is coming soon (the automatic
    // fallback), or the user has manually switched on "auch mit Umstieg".
    let secondary = [];
    if (!hasDirectSoon || state.showTransfers) {
      const withTransfer = await fetchPlanPage(from.id, to.id, { maxTransfers: 1, numItineraries: FETCH_BATCH_SIZE });
      secondary = withTransfer.itineraries.filter((it) => it.transfers >= 1);
    }

    localStorage.setItem(cacheKey(direction), JSON.stringify({
      fetchedAt: Date.now(),
      primary,
      secondary,
      hasDirectSoon,
    }));
    // Fresh data supersedes anything accumulated via "Später anzeigen".
    moreState[direction] = { items: [], secondaryItems: [], loading: false };
    state.lastError = null;
  } catch (err) {
    console.error('[pendler] fetch failed', err);
    state.lastError = err;
  } finally {
    setRefreshing(false);
    paintFromCache(direction);
  }
}

// Anchored on the last shown departure time rather than the API's own
// pageCursor — MOTIS's cursor chaining occasionally drops the itinerary
// sitting exactly on a page boundary (reproduced against the live API:
// a cursor chain silently skipped the 05:00 direct RE1). A fresh
// time-anchored query every click sidesteps that entirely.
function lastShownDepartureIso(direction, key) {
  const raw = localStorage.getItem(cacheKey(direction));
  const payload = raw ? JSON.parse(raw) : null;
  const more = moreState[direction];
  const base = payload ? payload[key] || [] : [];
  const extra = more ? more[key === 'primary' ? 'items' : 'secondaryItems'] || [] : [];
  const all = base.concat(extra);
  if (all.length === 0) return new Date().toISOString();
  return all[all.length - 1].departure.sched;
}

async function onLoadMore() {
  const direction = getDirection();
  if (!moreState[direction]) moreState[direction] = { items: [], secondaryItems: [], loading: false };
  const more = moreState[direction];
  if (more.loading) return;

  const { from, to } = stationsForDirection(direction);
  const anchor = new Date(new Date(lastShownDepartureIso(direction, 'primary')).getTime() + 60_000).toISOString();
  more.loading = true;
  const btn = document.getElementById('btn-more');
  btn.disabled = true;
  btn.textContent = 'Lädt …';

  try {
    const requests = [
      fetchPlanPage(from.id, to.id, { maxTransfers: 0, numItineraries: FETCH_BATCH_SIZE, time: anchor }),
    ];
    // Keep the "mit Umstieg" section extending alongside "später" too, once
    // it's switched on — otherwise it only ever covers the first small batch.
    if (state.showTransfers) {
      const secAnchor = new Date(new Date(lastShownDepartureIso(direction, 'secondary')).getTime() + 60_000).toISOString();
      requests.push(fetchPlanPage(from.id, to.id, { maxTransfers: 1, numItineraries: FETCH_BATCH_SIZE, time: secAnchor }));
    }
    const [page, transferPage] = await Promise.all(requests);
    more.items.push(...page.itineraries);
    if (transferPage) {
      more.secondaryItems.push(...transferPage.itineraries.filter((it) => it.transfers >= 1));
    }
  } catch (err) {
    console.error('[pendler] load-more failed', err);
    flashMessage('Gerade nicht ladbar — später nochmal versuchen');
  } finally {
    more.loading = false;
    btn.disabled = false;
    paintFromCache(direction);
  }
}

function updateRelaxButton() {
  const btn = document.getElementById('btn-relax');
  btn.textContent = state.showSlow ? 'Nur bis 2:10 Std zeigen' : 'Auch bis 3 Std zeigen';
  btn.setAttribute('aria-pressed', String(state.showSlow));
}

function onToggleRelax() {
  state.showSlow = !state.showSlow;
  updateRelaxButton();
  paintFromCache(getDirection());
}

function updateTransfersButton() {
  const btn = document.getElementById('btn-transfers');
  if (state.transfersLoading) {
    btn.textContent = 'Lädt …';
    return;
  }
  btn.textContent = state.showTransfers ? 'Nur direkt zeigen' : 'Auch mit Umstieg (< 2h)';
  btn.setAttribute('aria-pressed', String(state.showTransfers));
}

// Fetches transfer pages until they reach at least as far as the primary
// list already has (via "Später anzeigen") — otherwise turning this on
// *after* paging ahead would only backfill transfer options for today,
// silently missing anything past the point primary already reached.
async function ensureTransferCoverage(direction) {
  const raw = localStorage.getItem(cacheKey(direction));
  const payload = raw ? JSON.parse(raw) : null;
  if (!payload) return;

  const { from, to } = stationsForDirection(direction);
  const more = moreState[direction] || (moreState[direction] = { items: [], secondaryItems: [], loading: false });

  const primaryAll = payload.primary.concat(more.items);
  const horizonMs = primaryAll.length
    ? new Date(primaryAll[primaryAll.length - 1].departure.sched).getTime()
    : Date.now();

  let secondaryAll = (payload.secondary || []).concat(more.secondaryItems || []);
  let anchor;

  state.transfersLoading = true;
  updateTransfersButton();
  try {
    for (let guard = 0; guard < 8; guard++) {
      const coveredMs = secondaryAll.length
        ? new Date(secondaryAll[secondaryAll.length - 1].departure.sched).getTime()
        : 0;
      if (secondaryAll.length && coveredMs >= horizonMs) break;

      const page = await fetchPlanPage(from.id, to.id, { maxTransfers: 1, numItineraries: FETCH_BATCH_SIZE, time: anchor });
      const filtered = page.itineraries.filter((it) => it.transfers >= 1);
      if (filtered.length === 0) break;

      if (secondaryAll.length === 0) {
        payload.secondary = filtered;
      } else {
        more.secondaryItems.push(...filtered);
      }
      secondaryAll = secondaryAll.concat(filtered);
      anchor = new Date(new Date(filtered[filtered.length - 1].departure.sched).getTime() + 60_000).toISOString();
    }
    localStorage.setItem(cacheKey(direction), JSON.stringify(payload));
  } catch (err) {
    console.error('[pendler] transfer fetch failed', err);
    flashMessage('Umstiegsverbindungen gerade nicht ladbar');
  } finally {
    state.transfersLoading = false;
    updateTransfersButton();
  }
}

async function onToggleTransfers() {
  const direction = getDirection();
  state.showTransfers = !state.showTransfers;
  updateTransfersButton();

  if (state.showTransfers) {
    await ensureTransferCoverage(direction);
  }
  paintFromCache(direction);
}

function onManualRefresh() {
  const now = Date.now();
  const lastFetchAt = Number(localStorage.getItem('pendler.lastFetchAt') || 0);
  const wait = MIN_FETCH_INTERVAL_MS - (now - lastFetchAt);
  if (wait > 0) {
    flashMessage(`Aktualisiert erst wieder in ${Math.ceil(wait / 1000)} s`);
    return;
  }
  loadDepartures(getDirection(), { force: true });
}

// ---------- rendering ----------

function formatTime(ms) {
  return new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(min) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} Std` : `${h}:${String(m).padStart(2, '0')} Std`;
}

function formatCountdown(depMs, now) {
  const diffMin = Math.round((depMs - now) / 60000);
  if (diffMin <= 0) return 'jetzt';
  if (diffMin === 1) return 'in 1 min';
  return `in ${diffMin} min`;
}

function paintFromCache(direction) {
  const raw = localStorage.getItem(cacheKey(direction));
  const primaryList = document.getElementById('primary-list');
  const secWrap = document.getElementById('secondary-wrap');
  const secList = document.getElementById('secondary-list');
  const emptyEl = document.getElementById('empty-state');
  const statusEl = document.getElementById('status-line');
  const errorBanner = document.getElementById('error-banner');
  const moreBtn = document.getElementById('btn-more');

  if (state.lastError) {
    errorBanner.hidden = false;
    errorBanner.innerHTML = `Keine Verbindung zu transitous.org.${raw ? ' Zeige den letzten Stand.' : ''} ` +
      `<a href="https://bahn.de" target="_blank" rel="noopener">Auf bahn.de nachsehen</a>.`;
  } else {
    errorBanner.hidden = true;
  }

  if (!raw) {
    primaryList.innerHTML = '';
    secWrap.hidden = true;
    moreBtn.hidden = true;
    emptyEl.hidden = false;
    emptyEl.innerHTML = state.lastError
      ? `Noch keine Daten und gerade keine Verbindung. <a href="https://bahn.de" target="_blank" rel="noopener">Auf bahn.de nachsehen</a>.`
      : 'Lädt …';
    statusEl.textContent = '';
    return;
  }

  const payload = JSON.parse(raw);
  const now = Date.now();
  const more = moreState[direction] || (moreState[direction] = { items: [], secondaryItems: [], loading: false });

  const primaryVisible = payload.primary.filter(withinEffectiveDuration).slice(0, NUM_ITINERARIES);
  const moreVisible = more.items.filter(withinEffectiveDuration);
  renderList(primaryList, primaryVisible.concat(moreVisible), now);

  const secondaryFilter = state.showTransfers
    ? (it) => scheduledDurationMin(it) <= TRANSFER_MAX_MIN
    : withinEffectiveDuration;
  const secondaryAll = (payload.secondary || []).concat(more.secondaryItems || []);
  const secondaryVisible = secondaryAll.filter(secondaryFilter).slice(0, NUM_ITINERARIES);
  if (secondaryVisible.length) {
    secWrap.hidden = false;
    renderList(secList, secondaryVisible, now);
    document.getElementById('secondary-hint').textContent = payload.hasDirectSoon
      ? 'Schnelle Alternative mit einmal Umstieg.'
      : 'Kein direkter RE1 in den nächsten drei Stunden — hier geht’s mit Umstieg früher los.';
  } else {
    secWrap.hidden = true;
  }

  moreBtn.hidden = false;
  if (!more.loading) moreBtn.textContent = 'Später anzeigen';

  const visibleTotal = primaryVisible.length + moreVisible.length + secondaryVisible.length;
  const rawTotal = payload.primary.length + more.items.length + secondaryAll.length;
  emptyEl.hidden = visibleTotal > 0;
  if (visibleTotal === 0) {
    emptyEl.innerHTML = rawTotal > 0 && !state.showSlow
      ? `Nur langsamere Verbindungen gefunden. <button type="button" class="inline-link" id="btn-empty-relax">Auch bis 3h zeigen</button>.`
      : `Keine Verbindungen gefunden. <a href="https://bahn.de" target="_blank" rel="noopener">Auf bahn.de nachsehen</a>.`;
    const relaxLink = document.getElementById('btn-empty-relax');
    if (relaxLink) relaxLink.addEventListener('click', onToggleRelax);
  }

  const stamp = formatTime(payload.fetchedAt);
  statusEl.textContent = state.lastError ? `Stand ${stamp} · gerade keine Verbindung` : `Stand ${stamp}`;
  statusEl.classList.toggle('is-stale', !!state.lastError);
}

function renderList(container, itineraries, now) {
  container.innerHTML = '';
  itineraries.forEach((it) => container.appendChild(renderCard(it, now)));
}

function renderCard(it, now) {
  const isFast = !it.cancelled && scheduledDurationMin(it) <= FAST_DURATION_MIN;
  const card = document.createElement('article');
  card.className = 'card' + (it.cancelled ? ' is-cancelled' : '') + (isFast ? ' is-fast' : '');

  const depSchedMs = new Date(it.departure.sched).getTime();
  const depRealMs = new Date(it.departure.real || it.departure.sched).getTime();
  const delayMin = Math.round((depRealMs - depSchedMs) / 60000);

  const arrSchedMs = new Date(it.arrival.sched).getTime();
  const arrRealMs = new Date(it.arrival.real || it.arrival.sched).getTime();
  const arrDelayMin = Math.round((arrRealMs - arrSchedMs) / 60000);

  const top = document.createElement('div');
  top.className = 'card-top';

  const timeWrap = document.createElement('div');

  if (!it.cancelled && delayMin > 0) {
    const schedSmall = document.createElement('span');
    schedSmall.className = 'sched-time-strike';
    schedSmall.textContent = formatTime(depSchedMs);
    timeWrap.appendChild(schedSmall);
  }

  const depTime = document.createElement('span');
  depTime.className = 'dep-time';
  depTime.textContent = formatTime(it.cancelled ? depSchedMs : (delayMin > 0 ? depRealMs : depSchedMs));
  timeWrap.appendChild(depTime);

  if (it.cancelled) {
    const pill = document.createElement('span');
    pill.className = 'cancelled-pill';
    pill.textContent = 'Ausfall';
    timeWrap.appendChild(pill);
  } else if (delayMin > 0) {
    const pill = document.createElement('span');
    pill.className = 'delay-pill delayed';
    pill.textContent = `+${delayMin}`;
    timeWrap.appendChild(pill);
  }

  const countdown = document.createElement('span');
  countdown.className = 'countdown';
  countdown.textContent = it.cancelled ? '' : formatCountdown(depRealMs, now);

  top.appendChild(timeWrap);
  top.appendChild(countdown);
  card.appendChild(top);

  const firstLeg = it.legs[0];

  const badgeRow = document.createElement('div');
  badgeRow.className = 'badge-row';

  const lineBadge = document.createElement('span');
  lineBadge.className = 'line-badge' + (firstLeg.isBus ? ' is-bus' : '');
  lineBadge.textContent = firstLeg.isBus ? `Bus ${firstLeg.line}` : firstLeg.line;
  badgeRow.appendChild(lineBadge);

  const duration = document.createElement('span');
  duration.className = 'duration-info' + (isFast ? ' is-fast' : '');
  duration.textContent = formatDuration(scheduledDurationMin(it));
  badgeRow.appendChild(duration);

  card.appendChild(badgeRow);

  const route = document.createElement('div');
  route.className = 'route-line' + (it.cancelled ? ' is-cancelled' : '');

  const fromLabel = document.createElement('span');
  fromLabel.className = 'route-label';
  fromLabel.textContent = firstLeg.fromTrack ? `Gleis ${firstLeg.fromTrack}` : firstLeg.fromName;

  const track = document.createElement('span');
  track.className = 'route-track';
  const dotStart = document.createElement('span');
  dotStart.className = 'route-dot';
  const bar = document.createElement('span');
  bar.className = 'route-bar';
  const dotEnd = document.createElement('span');
  dotEnd.className = 'route-dot route-dot-end';
  track.append(dotStart, bar, dotEnd);

  const toLabel = document.createElement('span');
  toLabel.className = 'route-label route-label-end';
  const arrDelayTxt = !it.cancelled && arrDelayMin > 0 ? ` (+${arrDelayMin})` : '';
  toLabel.textContent = `an ${formatTime(arrSchedMs)}${arrDelayTxt}`;

  route.append(fromLabel, track, toLabel);
  card.appendChild(route);

  if (it.legs.length > 1) {
    const block = document.createElement('div');
    block.className = 'transfer-block';

    const note = document.createElement('div');
    note.className = 'transfer-note';
    note.textContent = `Umstieg in ${firstLeg.toName}`;
    block.appendChild(note);

    it.legs.forEach((leg) => {
      const row = document.createElement('div');
      row.className = 'transfer-leg';
      if (leg.cancelled) row.style.textDecoration = 'line-through';

      const t = document.createElement('span');
      t.className = 'leg-time';
      t.textContent = formatTime(new Date(leg.schedDep).getTime());

      const badge = document.createElement('span');
      badge.className = 'line-badge' + (leg.isBus ? ' is-bus' : '');
      badge.textContent = leg.isBus ? `Bus ${leg.line}` : leg.line;

      const dest = document.createElement('span');
      dest.textContent = `${leg.fromName} → ${leg.toName}` + (leg.fromTrack ? ` · Gl. ${leg.fromTrack}` : '');

      row.appendChild(t);
      row.appendChild(badge);
      row.appendChild(dest);
      block.appendChild(row);
    });

    card.appendChild(block);
  }

  return card;
}

function updateDirectionButtons(direction) {
  const btnA = document.getElementById('btn-dir-a');
  const btnB = document.getElementById('btn-dir-b');
  btnA.textContent = `${STATIONS.MUC.short} → ${STATIONS.NUE.short}`;
  btnB.textContent = `${STATIONS.NUE.short} → ${STATIONS.MUC.short}`;
  btnA.setAttribute('aria-pressed', String(direction === 'MUC_NUE'));
  btnB.setAttribute('aria-pressed', String(direction === 'NUE_MUC'));
}

function setRefreshing(v) {
  const btn = document.getElementById('btn-refresh');
  btn.classList.toggle('spinning', v);
  btn.disabled = v;
}

function flashMessage(msg) {
  const el = document.getElementById('status-line');
  el.textContent = msg;
  setTimeout(() => paintFromCache(getDirection()), 2000);
}

// ---------- wiring ----------

function switchDirection(dir) {
  setDirection(dir);
  // A deliberate direction switch is a one-off user action, not polling —
  // fetch immediately rather than making the user wait out the 60s throttle.
  loadDepartures(dir, { force: true });
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

function init() {
  registerServiceWorker();
  updateRelaxButton();
  updateTransfersButton();

  document.getElementById('btn-dir-a').addEventListener('click', () => switchDirection('MUC_NUE'));
  document.getElementById('btn-dir-b').addEventListener('click', () => switchDirection('NUE_MUC'));
  document.getElementById('btn-refresh').addEventListener('click', onManualRefresh);
  document.getElementById('btn-more').addEventListener('click', onLoadMore);
  document.getElementById('btn-relax').addEventListener('click', onToggleRelax);
  document.getElementById('btn-transfers').addEventListener('click', onToggleTransfers);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadDepartures(getDirection());
  });
  window.addEventListener('online', () => loadDepartures(getDirection()));

  loadDepartures(getDirection());
  setInterval(() => paintFromCache(getDirection()), TICK_INTERVAL_MS);
}

document.addEventListener('DOMContentLoaded', init);
