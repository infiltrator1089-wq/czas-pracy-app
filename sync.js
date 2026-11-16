/* Synchronizacja z Arkuszem Google (Apps Script Web App).
 *
 * Offline-first: localStorage (`timesheet.weeks.v1`) jest zawsze główną pamięcią. Każda zmiana dnia
 * trafia do kolejki (`timesheet.outbox.v1`, klucz = ID wpisu) i jest wysyłana w tle; bez zasięgu
 * kolejka czeka i wysyła się sama (zdarzenie `online`, powrót do aplikacji, ponowienia z odstępem).
 *
 * Zależności z app.js (używane dopiero w czasie wywołania, nie przy ładowaniu pliku):
 * loadAllWeeks, saveAllWeeks, weekHasData, emptyDay, isDayEmpty, getMonday, toISODate, fromISODate,
 * addDays, fieldToLabel, TIME_FORMAT_RE, refreshCurrentWeek.
 *
 * Adres skryptu i token są wpisywane w ustawieniach aplikacji i trzymane tylko w localStorage
 * telefonu (`timesheet.settings.v1`) — nigdy w repozytorium (jest publiczne).
 */
const Sync = (() => {
  'use strict';

  const SETTINGS_KEY = 'timesheet.settings.v1';
  const OUTBOX_KEY = 'timesheet.outbox.v1';
  const META_KEY = 'timesheet.syncmeta.v1';
  const BATCH_SIZE = 100;
  const STALE_MS = 24 * 60 * 60 * 1000;
  const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;
  const REQUEST_TIMEOUT_MS = 25000;
  const FLUSH_DEBOUNCE_MS = 1500;
  const MAX_RETRY_MS = 5 * 60 * 1000;
  const TIME_FIELDS = ['start', 'cardIn', 'cardOut', 'end', 'pause'];
  const ROW_FIELDS = [...TIME_FIELDS, 'note'];
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  // Token wysyłamy wyłącznie do Google (albo do lokalnej atrapy przy testach), nigdy pod dowolny adres.
  const URL_RE = /^(https:\/\/script\.google\.com\/(a\/macros\/[^/]+\/|macros\/)s\/[A-Za-z0-9_-]+\/exec|http:\/\/(localhost|127\.0\.0\.1):\d+\/exec)$/;

  // ───────────── drobne narzędzia ─────────────

  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.error('Zapis do localStorage nie powiódł się:', key, e);
      return false;
    }
  }

  function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map(x => x.toString(16).padStart(2, '0'));
    return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10).join('')}`;
  }

  const pad = n => String(n).padStart(2, '0');

  function fmtDate(ms) {
    const d = new Date(ms);
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
  }

  function fmtTime(ms) {
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fmtWhen(ms) {
    return fmtDate(ms) === fmtDate(Date.now()) ? `dziś ${fmtTime(ms)}` : `${fmtDate(ms)} ${fmtTime(ms)}`;
  }

  function daysPhrase(n) {
    const m10 = n % 10, m100 = n % 100;
    if (n === 1) return '1 dzień niezsynchronizowany';
    if (m10 >= 2 && m10 <= 4 && !(m100 >= 12 && m100 <= 14)) return `${n} dni niezsynchronizowane`;
    return `${n} dni niezsynchronizowanych`;
  }

  // ───────────── ustawienia, kolejka, metadane ─────────────

  const getSettings = () => readJSON(SETTINGS_KEY, {});
  const isConfigured = () => { const s = getSettings(); return Boolean(s.url && s.token); };
  const getMeta = () => readJSON(META_KEY, {});
  const setMeta = meta => writeJSON(META_KEY, meta);
  const loadOutbox = () => { const o = readJSON(OUTBOX_KEY, {}); return o && typeof o === 'object' ? o : {}; };
  const saveOutbox = outbox => writeJSON(OUTBOX_KEY, outbox);

  function toEntry(day, deleted) {
    const e = { id: day.id, date: day.date, updatedAt: day.updatedAt, deleted: Boolean(deleted) };
    ROW_FIELDS.forEach(f => { e[f] = day[f] || ''; });
    return e;
  }

  function enqueue(entry) {
    const outbox = loadOutbox();
    const prev = outbox[entry.id];
    outbox[entry.id] = { ...entry, queuedAt: prev && prev.queuedAt ? prev.queuedAt : Date.now() };
    saveOutbox(outbox);
  }

  /** Wywoływane z app.js po każdej zmianie pola dnia. Wyczyszczony dzień = wpis usunięty (znacznik usunięcia). */
  function onDayChanged(day) {
    if (!day.id || !isConfigured()) return;
    enqueue(toEntry(day, isDayEmpty(day)));
    updateUI();
    scheduleFlush();
  }

  function enqueueAllLocal() {
    const weeks = loadAllWeeks();
    const outbox = loadOutbox();
    const now = Date.now();
    Object.values(weeks).forEach(days => {
      if (!Array.isArray(days)) return;
      days.forEach(day => {
        if (day.id && !isDayEmpty(day) && !outbox[day.id]) outbox[day.id] = { ...toEntry(day, false), queuedAt: now };
      });
    });
    saveOutbox(outbox);
  }

  // ───────────── walidacja i normalizacja wierszy (przywracanie, import) ─────────────

  function isValidDateStr(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    return toISODate(fromISODate(s)) === s;
  }

  function validateRow(row) {
    if (!row || typeof row !== 'object') return ['to nie jest poprawny wiersz'];
    const errs = [];
    if (typeof row.id !== 'string' || !UUID_RE.test(row.id)) errs.push('niepoprawne ID');
    if (!isValidDateStr(row.date)) errs.push(`niepoprawna data „${row.date}” (oczekiwane RRRR-MM-DD)`);
    TIME_FIELDS.forEach(f => {
      const v = row[f];
      if (v == null || v === '') return;
      if (typeof v !== 'string' || !TIME_FORMAT_RE.test(v)) errs.push(`${fieldToLabel(f)}: „${v}” nie jest w formacie HH:MM`);
    });
    if (row.note != null && (typeof row.note !== 'string' || row.note.length > 500)) errs.push('niepoprawna uwaga (zbyt długa lub nie tekst)');
    const ua = Number(row.updatedAt);
    if (row.updatedAt === '' || row.updatedAt == null || !Number.isFinite(ua) || ua <= 0) errs.push('niepoprawny znacznik czasu modyfikacji');
    else if (ua > Date.now() + MAX_FUTURE_MS) errs.push('znacznik czasu modyfikacji z przyszłości');
    const del = row.deleted;
    if (!(del === true || del === false || /^(true|false)$/i.test(String(del)))) errs.push('niepoprawna flaga usunięcia');
    return errs;
  }

  function normalizeRow(row) {
    const n = {
      id: row.id,
      date: row.date,
      updatedAt: Number(row.updatedAt),
      deleted: row.deleted === true || String(row.deleted).toUpperCase() === 'TRUE',
    };
    ROW_FIELDS.forEach(f => { n[f] = row[f] == null ? '' : String(row[f]); });
    return n;
  }

  function classify(rows) {
    const valid = [], invalid = [];
    (Array.isArray(rows) ? rows : []).forEach((row, index) => {
      const errs = validateRow(row);
      if (errs.length) invalid.push({ row, errs, index });
      else valid.push(normalizeRow(row));
    });
    return { valid, invalid };
  }

  function describeInvalid({ row, errs, index }) {
    const where = row && row._row ? `wiersz ${row._row} w arkuszu` : `pozycja ${index + 1}`;
    const date = row && row.date != null && row.date !== '' ? `, data: ${row.date}` : '';
    return `${where}${date} — ${errs.join('; ')}`;
  }

  // ───────────── scalanie ─────────────

  /** Czy a „wygrywa” z b: nowszy znacznik, przy remisie większe ID (tak samo jak w skrypcie serwera). */
  const wins = (a, b) => a.updatedAt > b.updatedAt || (a.updatedAt === b.updatedAt && String(a.id) > String(b.id));

  /**
   * Scala poprawne wiersze z lokalnymi dniami (po ID, nowsza wersja wygrywa; jeden wpis na datę).
   * Niczego nie kasuje bez nowszego znacznika. `enqueueApplied` — czy zastosowane wiersze mają
   * trafić do chmury (import z pliku: tak; przywracanie z chmury: nie, bo chmura już je ma).
   */
  function mergeRows(rows, { enqueueApplied = false } = {}) {
    const weeks = loadAllWeeks();
    const outbox = loadOutbox();
    const stats = { applied: 0, keptLocal: 0, ignored: 0 };
    let outboxChanged = false;

    for (const row of rows) {
      // Lokalna, jeszcze niewysłana zmiana tego wpisu jest nowsza lub równa → nie cofamy jej.
      const pending = outbox[row.id];
      if (pending && pending.updatedAt >= row.updatedAt) { stats.keptLocal++; continue; }

      const date = fromISODate(row.date);
      const mondayISO = toISODate(getMonday(date));
      const idx = (date.getDay() + 6) % 7;
      const week = weeks[mondayISO] || (weeks[mondayISO] = Array.from({ length: 7 }, (_, i) => emptyDay(toISODate(addDays(fromISODate(mondayISO), i)))));
      const local = week[idx];
      const localEmpty = isDayEmpty(local);
      const rowEmpty = row.deleted || ROW_FIELDS.every(f => !row[f]);

      let apply;
      if (local.id === row.id) {
        apply = row.updatedAt > (local.updatedAt || 0);
      } else if (rowEmpty) {
        stats.ignored++;                 // znacznik usunięcia innego wpisu — ten dzień go nie dotyczy
        continue;
      } else if (localEmpty) {
        apply = true;
      } else {
        apply = wins(row, local);
      }
      if (!apply) { stats.keptLocal++; continue; }

      if (local.id && outbox[local.id]) { delete outbox[local.id]; outboxChanged = true; }   // wypierany wpis
      week[idx] = rowEmpty
        ? { ...emptyDay(row.date), id: row.id, updatedAt: row.updatedAt }
        : { id: row.id, date: row.date, updatedAt: row.updatedAt, ...Object.fromEntries(ROW_FIELDS.map(f => [f, row[f]])) };
      stats.applied++;

      if (enqueueApplied) {
        outbox[row.id] = { ...toEntry(week[idx], rowEmpty), queuedAt: pending && pending.queuedAt ? pending.queuedAt : Date.now() };
        outboxChanged = true;
      }
    }

    Object.keys(weeks).forEach(k => { if (!weekHasData(weeks[k])) delete weeks[k]; });
    saveAllWeeks(weeks);
    if (outboxChanged) saveOutbox(outbox);
    return stats;
  }

  // ───────────── komunikacja z Apps Script ─────────────

  function syncError(code, message) {
    const e = new Error(message || code);
    e.code = code;
    return e;
  }

  function friendly(e) {
    switch (e && e.code) {
      case 'unauthorized': return 'Nieprawidłowy token';
      case 'server_not_configured': return 'Skrypt nie ma ustawionego tokenu (uruchom setup() w Apps Script)';
      case 'busy': return 'Serwer zajęty, spróbuję ponownie';
      case 'bad_response': return 'Skrypt zwrócił nieoczekiwaną odpowiedź — sprawdź, czy wdrożenie ma dostęp „Każdy” (Anyone)';
      case 'timeout': return 'Przekroczono czas oczekiwania na serwer';
      case 'network': return 'Brak połączenia z serwerem';
      default: return (e && e.message) || 'Nieznany błąd';
    }
  }

  async function post(action, payload = {}, creds = getSettings()) {
    if (!creds.url || !creds.token) throw syncError('not_configured', 'Synchronizacja nie jest skonfigurowana');
    if (!URL_RE.test(creds.url)) throw syncError('bad_url', 'Niepoprawny adres skryptu');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      // text/plain = „prosty” request bez preflightu CORS (Apps Script go nie obsługuje).
      res = await fetch(creds.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ token: creds.token, action, ...payload }),
        signal: ctrl.signal,
        credentials: 'omit',
      });
    } catch (e) {
      throw e && e.name === 'AbortError' ? syncError('timeout') : syncError('network');
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw syncError('http', `Serwer odpowiedział HTTP ${res.status}`);
    let data;
    try { data = await res.json(); } catch { throw syncError('bad_response'); }
    if (!data || data.ok !== true) throw syncError((data && data.error) || 'bad_response', data && data.error);
    return data;
  }

  // ───────────── wysyłanie kolejki ─────────────

  let running = null;
  let rerun = false;
  let flushTimer = null;
  let retryTimer = null;
  let retryDelay = 0;

  function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, FLUSH_DEBOUNCE_MS);
  }

  function flush() {
    if (running) { rerun = true; return running; }
    running = (async () => {
      let ok = true;
      do {
        rerun = false;
        ok = await flushOnce();
      } while (rerun && ok);
    })().finally(() => { running = null; updateUI(); });
    updateUI();
    return running;
  }

  async function flushOnce() {
    if (!isConfigured() || !navigator.onLine) return true;
    clearTimeout(retryTimer);
    retryTimer = null;
    const snapshot = Object.values(loadOutbox()).sort((a, b) => a.queuedAt - b.queuedAt);
    if (!snapshot.length) return true;
    try {
      for (let i = 0; i < snapshot.length; i += BATCH_SIZE) {
        const chunk = snapshot.slice(i, i + BATCH_SIZE);
        const changes = chunk.map(({ queuedAt, ...rest }) => rest);
        const data = await post('sync', { changes });
        if (!Array.isArray(data.results)) throw syncError('bad_response');
        applyResults(chunk, data.results);
      }
      const meta = getMeta();
      meta.lastSyncAt = Date.now();
      meta.lastError = null;
      setMeta(meta);
      retryDelay = 0;
      // Użytkownik mógł edytować w trakcie wysyłki — dosyłamy tylko wpisy zmienione lub dodane od migawki.
      // (Wpis, który został w kolejce bez zmian, NIE uruchamia pętli — ponowi go minutowy zegar.)
      const sentStamp = Object.fromEntries(snapshot.map(e => [e.id, e.updatedAt]));
      if (Object.values(loadOutbox()).some(e => !(e.id in sentStamp) || e.updatedAt !== sentStamp[e.id])) rerun = true;
      return true;
    } catch (e) {
      const meta = getMeta();
      meta.lastError = friendly(e);
      setMeta(meta);
      retryDelay = Math.min((retryDelay || 2500) * 2, MAX_RETRY_MS);
      retryTimer = setTimeout(flush, retryDelay);
      return false;
    }
  }

  function applyResults(chunk, results) {
    const sentById = Object.fromEntries(chunk.map(e => [e.id, e]));
    const outbox = loadOutbox();
    const staleRows = [];
    let rejected = 0;
    for (const r of results) {
      const sent = r && sentById[r.id];
      if (!sent) continue;
      const cur = outbox[r.id];
      const unchanged = cur && cur.updatedAt === sent.updatedAt;   // nie edytowany od momentu wysyłki
      if (r.status === 'applied') {
        if (unchanged) delete outbox[r.id];
      } else if (r.status === 'invalid') {
        console.warn('Serwer odrzucił wpis', r);
        if (unchanged) delete outbox[r.id];
        rejected++;
      } else if (r.status === 'stale' && r.server) {
        staleRows.push(r.server);
      }
    }
    saveOutbox(outbox);
    if (rejected) {
      const meta = getMeta();
      meta.lastWarning = `Serwer odrzucił ${rejected} wpis(ów) jako niepoprawne`;
      setMeta(meta);
    }
    if (staleRows.length) {
      // Serwer ma nowszą wersję (np. z innego urządzenia) — przyjmujemy ją, chyba że lokalnie jest jeszcze nowsza.
      const { valid } = classify(staleRows);
      if (mergeRows(valid, { enqueueApplied: false }).applied) refreshCurrentWeek();
    }
  }

  // ───────────── przywracanie, eksport, import ─────────────

  async function restoreFromCloud() {
    if (!isConfigured()) { openSettings(); return; }
    try {
      await flush();                      // najpierw wypychamy lokalne zmiany
      const data = await post('list');
      const { valid, invalid } = classify(data.rows);
      const stats = mergeRows(valid, { enqueueApplied: false });
      refreshCurrentWeek();
      updateUI();
      showReport('☁️ Przywracanie z chmury', [
        `Wierszy w arkuszu: ${Array.isArray(data.rows) ? data.rows.length : 0}`,
        `Zastosowano (nowsze niż lokalne albo brakujące): ${stats.applied}`,
        `Zostawiono lokalne (nowsze lub takie same): ${stats.keptLocal}`,
        ...(stats.ignored ? [`Pominięto znaczniki usunięcia innych wpisów: ${stats.ignored}`] : []),
        `Pominięto błędnych wierszy: ${invalid.length}`,
      ], invalid.map(describeInvalid));
    } catch (e) {
      showReport('☁️ Przywracanie z chmury', [`Nie udało się: ${friendly(e)}`], []);
    }
  }

  function collectLocalEntries() {
    const out = [];
    Object.values(loadAllWeeks()).forEach(days => {
      if (!Array.isArray(days)) return;
      days.forEach(day => { if (day.id && !isDayEmpty(day)) out.push(toEntry(day, false)); });
    });
    return out;
  }

  function exportBackup() {
    const payload = { app: 'czas-pracy', version: 1, exportedAt: new Date().toISOString(), days: collectLocalEntries() };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `czas-pracy-kopia_${toISODate(new Date())}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importBackup(file) {
    let payload;
    try {
      payload = JSON.parse(await file.text());
    } catch {
      showReport('📂 Import kopii', ['To nie jest poprawny plik JSON.'], []);
      return;
    }
    if (!payload || payload.app !== 'czas-pracy' || !Array.isArray(payload.days)) {
      showReport('📂 Import kopii', ['To nie jest kopia z tej aplikacji (brak pola „days”).'], []);
      return;
    }
    const { valid, invalid } = classify(payload.days);
    const stats = mergeRows(valid, { enqueueApplied: isConfigured() });
    refreshCurrentWeek();
    updateUI();
    if (isConfigured()) flush();
    showReport('📂 Import kopii', [
      `Wpisów w pliku: ${payload.days.length}`,
      `Zastosowano (nowsze niż lokalne albo brakujące): ${stats.applied}`,
      `Zostawiono lokalne (nowsze lub takie same): ${stats.keptLocal}`,
      `Pominięto błędnych wpisów: ${invalid.length}`,
    ], invalid.map(describeInvalid));
  }

  // ───────────── interfejs ─────────────

  const $ = id => document.getElementById(id);

  function updateUI() {
    const statusEl = $('syncStatus');
    if (!statusEl) return;
    const entries = Object.values(loadOutbox());
    const n = entries.length;
    const meta = getMeta();
    const configured = isConfigured();
    let text, cls;

    if (!configured) {
      text = '☁️ Synchronizacja wyłączona — dotknij ⚙, aby skonfigurować';
      cls = 'off';
    } else if (running) {
      text = `🔄 Wysyłanie… (${n})`;
      cls = 'busy';
    } else if (n > 0) {
      const offline = !navigator.onLine;
      text = `${offline ? '📴 Offline — ' : ''}⏳ Czeka na wysłanie (${n})`;
      if (meta.lastError && !offline) text += ` · ${meta.lastError}`;
      cls = meta.lastError && !offline ? 'error' : 'pending';
    } else {
      text = '✅ Zsynchronizowane' + (meta.lastSyncAt ? ` · ${fmtWhen(meta.lastSyncAt)}` : '');
      cls = 'ok';
      if (meta.lastWarning) text += ` · ⚠ ${meta.lastWarning}`;
    }
    statusEl.textContent = text;
    statusEl.className = `sync-status ${cls}`;

    const banner = $('staleBanner');
    const oldest = n ? Math.min(...entries.map(e => e.queuedAt || Date.now())) : null;
    if (configured && n > 0 && Date.now() - oldest > STALE_MS) {
      $('staleText').textContent = `⚠ ${daysPhrase(n)} od ${fmtDate(oldest)}`;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  }

  function showReport(title, lines, warnings) {
    $('reportTitle').textContent = title;
    const body = $('reportBody');
    body.textContent = '';
    lines.forEach(line => {
      const p = document.createElement('p');
      p.textContent = line;
      body.appendChild(p);
    });
    if (warnings.length) {
      const h = document.createElement('p');
      h.className = 'report-warn-title';
      h.textContent = `⚠ Błędne wiersze (nie zostały zaimportowane): ${warnings.length}`;
      body.appendChild(h);
      const ul = document.createElement('ul');
      ul.className = 'report-warnings';
      warnings.slice(0, 50).forEach(w => {
        const li = document.createElement('li');
        li.textContent = w;              // textContent — zawartość arkusza nie może wstrzyknąć HTML-a
        ul.appendChild(li);
      });
      if (warnings.length > 50) {
        const li = document.createElement('li');
        li.textContent = `… i ${warnings.length - 50} kolejnych`;
        ul.appendChild(li);
      }
      body.appendChild(ul);
    }
    const dlg = $('reportDialog');
    if (!dlg.open) dlg.showModal();
  }

  function readForm() {
    const saved = getSettings();
    return {
      url: $('settingsUrl').value.trim(),
      token: $('settingsToken').value.trim() || saved.token || '',
    };
  }

  function formProblem({ url, token }) {
    if (!URL_RE.test(url)) return 'Adres musi mieć postać https://script.google.com/macros/s/…/exec';
    if (token.length < 16) return 'Token jest za krótki (min. 16 znaków)';
    return null;
  }

  function openSettings() {
    const s = getSettings();
    $('settingsUrl').value = s.url || '';
    $('settingsToken').value = '';
    $('settingsToken').placeholder = s.token ? '•••• zapisany (puste = bez zmian)' : 'Token z Apps Script';
    $('settingsMsg').textContent = '';
    $('settingsDialog').showModal();
  }

  async function testConnection() {
    const creds = readForm();
    const msg = $('settingsMsg');
    const problem = formProblem(creds);
    if (problem) { msg.textContent = `❌ ${problem}`; return; }
    msg.textContent = 'Testuję połączenie…';
    try {
      const r = await post('ping', {}, creds);
      msg.textContent = `✅ Połączono. Wierszy w arkuszu: ${r.rows}`;
    } catch (e) {
      msg.textContent = `❌ ${friendly(e)}`;
    }
  }

  function saveSettings() {
    const creds = readForm();
    const msg = $('settingsMsg');
    const problem = formProblem(creds);
    if (problem) { msg.textContent = `❌ ${problem}`; return; }
    writeJSON(SETTINGS_KEY, creds);
    const meta = getMeta();
    if (meta.uploadedFor !== creds.url) {      // nowy arkusz → wysyłamy całą dotychczasową historię
      enqueueAllLocal();
      meta.uploadedFor = creds.url;
    }
    meta.lastError = null;
    setMeta(meta);
    $('settingsDialog').close();
    updateUI();
    flush();
  }

  function clearSettings() {
    if (!confirm('Usunąć konfigurację synchronizacji z tego telefonu?\n\nDane lokalne zostają. Niewysłane zmiany wyślą się dopiero po ponownym skonfigurowaniu.')) return;
    localStorage.removeItem(SETTINGS_KEY);
    localStorage.removeItem(OUTBOX_KEY);
    const meta = getMeta();
    delete meta.uploadedFor;
    setMeta(meta);
    $('settingsDialog').close();
    updateUI();
  }

  function bindUI() {
    $('syncStatus').addEventListener('click', () => { if (isConfigured()) flush(); else openSettings(); });
    $('settingsBtn').addEventListener('click', openSettings);
    $('staleRetry').addEventListener('click', () => flush());
    $('settingsTest').addEventListener('click', testConnection);
    $('settingsSave').addEventListener('click', saveSettings);
    $('settingsClear').addEventListener('click', clearSettings);
    $('settingsCancel').addEventListener('click', () => $('settingsDialog').close());
    $('reportClose').addEventListener('click', () => $('reportDialog').close());
    $('restoreBtn').addEventListener('click', restoreFromCloud);
    $('exportBtn').addEventListener('click', exportBackup);
    $('importBtn').addEventListener('click', () => $('importFile').click());
    $('importFile').addEventListener('change', async e => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (file) await importBackup(file);
    });
  }

  function init() {
    bindUI();
    window.addEventListener('online', () => { updateUI(); flush(); });
    window.addEventListener('offline', updateUI);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { updateUI(); flush(); }
    });
    setInterval(() => {
      updateUI();
      if (!retryTimer && navigator.onLine && Object.keys(loadOutbox()).length) flush();
    }, 60 * 1000);

    if (isConfigured()) {
      const meta = getMeta();
      if (meta.uploadedFor !== getSettings().url) {
        enqueueAllLocal();
        meta.uploadedFor = getSettings().url;
        setMeta(meta);
      }
    }
    updateUI();
    flush();
  }

  return {
    init, uuid, onDayChanged, flush, updateUI,
    // wystawione dla testów / diagnostyki
    _internals: { mergeRows, validateRow, classify, loadOutbox, getMeta, URL_RE },
  };
})();
