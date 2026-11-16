/**
 * Czas Pracy — backend synchronizacji (Google Apps Script, Web App).
 *
 * Wklej ten plik w arkuszu: Rozszerzenia → Apps Script. Instrukcja krok po
 * kroku: SYNC-SETUP.md w repozytorium.
 *
 * Arkusz „Dane”      — aktualny stan: jeden wiersz = jeden dzień (po ID).
 *                      Usunięty dzień zostaje jako wiersz z deleted=TRUE
 *                      (miękkie usuwanie, wartości pól są zachowane).
 * Arkusz „Historia”  — dziennik append-only: przy każdym utworzeniu,
 *                      zmianie, usunięciu lub przywróceniu dopisywany jest
 *                      wiersz z POPRZEDNIMI wartościami wszystkich pól.
 *                      Ten kod nigdy nie kasuje ani nie nadpisuje wierszy
 *                      w „Historii”.
 *
 * Protokół (POST, Content-Type: text/plain, treść = JSON):
 *   { token, action: 'ping' }
 *   { token, action: 'sync', changes: [ {id,date,start,cardIn,cardOut,end,
 *                                        pause,note,updatedAt,deleted}, … ] }
 *   { token, action: 'list' }
 * Token jest sprawdzany z właściwością skryptu TOKEN (Ustawienia projektu →
 * Właściwości skryptu). GET zwraca tylko status usługi, bez żadnych danych.
 */

const SHEET_DATA = 'Dane';
const SHEET_HISTORY = 'Historia';
const DATA_HEADERS = ['id', 'date', 'start', 'cardIn', 'cardOut', 'end', 'pause', 'note', 'updatedAt', 'deleted'];
const HISTORY_HEADERS = ['timestamp', 'action', 'id', 'date', 'prev_start', 'prev_cardIn', 'prev_cardOut',
  'prev_end', 'prev_pause', 'prev_note', 'prev_deleted', 'prev_updatedAt'];
const TIME_FIELDS = ['start', 'cardIn', 'cardOut', 'end', 'pause'];
const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BATCH = 200;
const MAX_NOTE = 500;
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;
const PROTOCOL_VERSION = 1;

// ───────────────────────── punkty wejścia ─────────────────────────

function doGet() {
  return json_({ ok: true, service: 'czas-pracy-sync', version: PROTOCOL_VERSION });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'bad_request' });
  }
  const auth = checkToken_(req && req.token);
  if (auth !== 'ok') return json_({ ok: false, error: auth });

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
  } catch (err) {
    return json_({ ok: false, error: 'busy' });
  }
  try {
    switch (req.action) {
      case 'ping': return json_(handlePing_());
      case 'sync': return json_(handleSync_(req.changes));
      case 'list': return json_(handleList_());
      default: return json_({ ok: false, error: 'unknown_action' });
    }
  } catch (err) {
    return json_({ ok: false, error: 'server_error: ' + (err && err.message ? err.message : err) });
  } finally {
    lock.releaseLock();
  }
}

// ───────────────────────── konfiguracja (uruchamiane ręcznie) ─────────────────────────

/** Uruchom raz z edytora: tworzy arkusze i generuje token. */
function setup() {
  ensureSheets_();
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('TOKEN')) {
    const token = newToken_();
    props.setProperty('TOKEN', token);
    Logger.log('TOKEN (skopiuj do ustawień aplikacji): ' + token);
  } else {
    Logger.log('TOKEN jest już ustawiony (Ustawienia projektu → Właściwości skryptu). ' +
      'Aby go wymienić, uruchom rotateToken().');
  }
}

/** Generuje nowy token (stary przestaje działać — trzeba go podmienić w aplikacji). */
function rotateToken() {
  const token = newToken_();
  PropertiesService.getScriptProperties().setProperty('TOKEN', token);
  Logger.log('NOWY TOKEN (wpisz w ustawieniach aplikacji): ' + token);
}

function newToken_() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
}

function checkToken_(given) {
  const expected = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!expected || expected.length < 16) return 'server_not_configured';
  if (typeof given !== 'string' || !safeEqual_(expected, given)) return 'unauthorized';
  return 'ok';
}

function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ───────────────────────── akcje ─────────────────────────

function handlePing_() {
  ensureSheets_();
  return { ok: true, service: 'czas-pracy-sync', version: PROTOCOL_VERSION, rows: readRows_(dataSheet_()).length };
}

function handleList_() {
  ensureSheets_();
  return { ok: true, rows: readRows_(dataSheet_()).map(publicRow_) };
}

function handleSync_(changes) {
  if (!Array.isArray(changes)) throw new Error('bad_changes');
  if (changes.length > MAX_BATCH) throw new Error('batch_too_large');
  ensureSheets_();

  const sh = dataSheet_();
  const byId = {};
  const liveByDate = {};
  readRows_(sh).forEach(r => { byId[r.id] = r; if (!r.deleted) addLive_(liveByDate, r); });

  const updates = {};   // numer wiersza → obiekt (istniejące wiersze do nadpisania)
  const created = [];   // nowe wiersze (dopisywane hurtem)
  const history = [];
  const results = [];
  const stamp = nowStamp_();

  const touch = row => { if (row._row) updates[row._row] = row; };

  changes.forEach(c => {
    const bad = validateChange_(c);
    if (bad) { results.push({ id: c && c.id, status: 'invalid', reason: bad }); return; }

    const ex = byId[c.id];

    // Starsza wersja niż na serwerze → serwer wygrywa.
    if (ex && ex.updatedAt > c.updatedAt) {
      results.push({ id: c.id, status: 'stale', server: publicRow_(ex) });
      return;
    }
    // Ten sam znacznik: powtórna wysyłka tej samej zmiany jest idempotentna.
    if (ex && ex.updatedAt === c.updatedAt && sameContent_(ex, c)) {
      results.push({ id: c.id, status: 'applied', server: publicRow_(ex) });
      return;
    }

    if (c.deleted) {
      if (!ex) {
        const row = blankRow_(c.id, c.date);
        row.updatedAt = c.updatedAt;
        row.deleted = true;
        created.push(row);
        byId[row.id] = row;
        history.push(historyRow_(stamp, 'delete', row.id, row.date, null));
        results.push({ id: c.id, status: 'applied', server: publicRow_(row) });
        return;
      }
      if (!ex.deleted) history.push(historyRow_(stamp, 'delete', ex.id, ex.date, ex));
      removeLive_(liveByDate, ex);
      ex.updatedAt = c.updatedAt;
      ex.deleted = true;           // wartości pól zostają — to miękkie usunięcie
      touch(ex);
      results.push({ id: c.id, status: 'applied', server: publicRow_(ex) });
      return;
    }

    // Zmiana „żywa”: jeden żywy wpis na datę, wygrywa nowszy (przy remisie większe ID).
    const others = (liveByDate[c.date] || []).filter(o => o.id !== c.id);
    const blocker = others.find(o => wins_(o, c));
    if (blocker) {
      results.push({ id: c.id, status: 'stale', server: publicRow_(blocker) });
      return;
    }
    others.forEach(o => {
      history.push(historyRow_(stamp, 'replaced', o.id, o.date, o));
      removeLive_(liveByDate, o);
      o.deleted = true;
      o.updatedAt = Math.max(o.updatedAt, c.updatedAt);
      touch(o);
    });

    if (ex) {
      history.push(historyRow_(stamp, ex.deleted ? 'restore' : 'update', ex.id, ex.date, ex));
      removeLive_(liveByDate, ex);
      assignFields_(ex, c);
      ex.deleted = false;
      touch(ex);
      addLive_(liveByDate, ex);
      results.push({ id: c.id, status: 'applied', server: publicRow_(ex) });
    } else {
      const row = blankRow_(c.id, c.date);
      assignFields_(row, c);
      created.push(row);
      byId[row.id] = row;
      addLive_(liveByDate, row);
      history.push(historyRow_(stamp, 'create', row.id, row.date, null));
      results.push({ id: c.id, status: 'applied', server: publicRow_(row) });
    }
  });

  // Najpierw historia (dziennik ma być kompletny nawet przy błędzie zapisu danych).
  if (history.length) appendHistory_(history);
  Object.keys(updates).forEach(k => writeRows_(sh, Number(k), [updates[k]]));
  if (created.length) writeRows_(sh, sh.getLastRow() + 1, created);

  return { ok: true, results: results, serverTime: Date.now() };
}

// ───────────────────────── logika wpisów ─────────────────────────

function validateChange_(c) {
  if (!c || typeof c !== 'object') return 'not_object';
  if (typeof c.id !== 'string' || !UUID_RE.test(c.id)) return 'bad_id';
  if (typeof c.date !== 'string' || !DATE_RE.test(c.date) || !isRealDate_(c.date)) return 'bad_date';
  for (let i = 0; i < TIME_FIELDS.length; i++) {
    const v = c[TIME_FIELDS[i]];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string' || !TIME_RE.test(v)) return 'bad_' + TIME_FIELDS[i];
  }
  if (c.note != null && (typeof c.note !== 'string' || c.note.length > MAX_NOTE)) return 'bad_note';
  if (typeof c.updatedAt !== 'number' || !isFinite(c.updatedAt) || c.updatedAt <= 0 ||
      c.updatedAt > Date.now() + MAX_FUTURE_MS) return 'bad_updatedAt';
  if (typeof c.deleted !== 'boolean') return 'bad_deleted';
  return null;
}

function isRealDate_(s) {
  const p = s.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  return d.getUTCFullYear() === p[0] && d.getUTCMonth() === p[1] - 1 && d.getUTCDate() === p[2];
}

/** Czy a „wygrywa” z b: nowszy znacznik, przy remisie większe ID. */
function wins_(a, b) {
  return a.updatedAt > b.updatedAt || (a.updatedAt === b.updatedAt && a.id > b.id);
}

function sameContent_(ex, c) {
  if (ex.deleted !== c.deleted) return false;
  if (c.deleted) return true;
  if (ex.date !== c.date || (ex.note || '') !== (c.note || '')) return false;
  return TIME_FIELDS.every(f => (ex[f] || '') === (c[f] || ''));
}

function blankRow_(id, date) {
  return { id: id, date: date, start: '', cardIn: '', cardOut: '', end: '', pause: '', note: '', updatedAt: 0, deleted: false };
}

function assignFields_(row, c) {
  row.date = c.date;
  TIME_FIELDS.forEach(f => { row[f] = c[f] || ''; });
  row.note = c.note || '';
  row.updatedAt = c.updatedAt;
}

function addLive_(liveByDate, row) {
  (liveByDate[row.date] = liveByDate[row.date] || []).push(row);
}

function removeLive_(liveByDate, row) {
  if (liveByDate[row.date]) liveByDate[row.date] = liveByDate[row.date].filter(r => r !== row);
}

function publicRow_(r) {
  return {
    id: r.id, date: r.date, start: r.start, cardIn: r.cardIn, cardOut: r.cardOut, end: r.end,
    pause: r.pause, note: r.note, updatedAt: r.updatedAt, deleted: r.deleted, _row: r._row
  };
}

// ───────────────────────── arkusze ─────────────────────────

function ensureSheets_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  initSheet_(ss, SHEET_DATA, DATA_HEADERS);
  initSheet_(ss, SHEET_HISTORY, HISTORY_HEADERS);
}

function initSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    const sheets = ss.getSheets();
    // Świeży arkusz ma jedną pustą kartę (np. „Arkusz1”) — zamień ją na „Dane”.
    if (name === SHEET_DATA && sheets.length === 1 && sheets[0].getLastRow() === 0) {
      sheets[0].setName(name);
      sh = sheets[0];
    } else {
      sh = ss.insertSheet(name);
    }
  }
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setNumberFormat('@').setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function dataSheet_() { return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_DATA); }
function historySheet_() { return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_HISTORY); }
function tz_() { return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(); }

function nowStamp_() { return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HH:mm:ss'); }

function isDate_(v) { return Object.prototype.toString.call(v) === '[object Date]'; }

// Arkusz potrafi zamienić ręcznie wpisane „05:17” / „2026-06-29” na daty — normalizujemy z powrotem.
function normDate_(v) {
  if (isDate_(v)) return Utilities.formatDate(v, tz_(), 'yyyy-MM-dd');
  return v == null ? '' : String(v).trim();
}

function normTime_(v) {
  if (isDate_(v)) return Utilities.formatDate(v, tz_(), 'HH:mm');
  if (typeof v === 'number' && v >= 0 && v < 1) {
    const mins = Math.round(v * 1440);
    return ('0' + Math.floor(mins / 60)).slice(-2) + ':' + ('0' + (mins % 60)).slice(-2);
  }
  return v == null ? '' : String(v).trim();
}

function toBool_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }

function readRows_(sh) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  const vals = sh.getRange(2, 1, last - 1, DATA_HEADERS.length).getValues();
  const out = [];
  vals.forEach((v, i) => {
    if (v.every(c => c === '' || c == null)) return;      // zupełnie pusty wiersz
    out.push({
      _row: i + 2,
      id: v[0] == null ? '' : String(v[0]).trim(),
      date: normDate_(v[1]),
      start: normTime_(v[2]),
      cardIn: normTime_(v[3]),
      cardOut: normTime_(v[4]),
      end: normTime_(v[5]),
      pause: normTime_(v[6]),
      note: v[7] == null ? '' : String(v[7]),
      updatedAt: v[8] === '' || v[8] == null ? NaN : Number(v[8]),
      deleted: toBool_(v[9])
    });
  });
  return out;
}

function rowToValues_(r) {
  return [r.id, r.date, r.start, r.cardIn, r.cardOut, r.end, r.pause, r.note, r.updatedAt, r.deleted];
}

function ensureCapacity_(sh, lastNeededRow) {
  if (lastNeededRow > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), lastNeededRow - sh.getMaxRows());
}

function writeRows_(sh, startRow, rows) {
  const n = rows.length;
  ensureCapacity_(sh, startRow + n - 1);
  // Format tekstowy PRZED zapisem — inaczej arkusz zamieni „05:17” na godzinę, a „=1+1” w uwagach na formułę.
  sh.getRange(startRow, 1, n, 8).setNumberFormat('@');
  sh.getRange(startRow, 9, n, 1).setNumberFormat('0');
  sh.getRange(startRow, 1, n, DATA_HEADERS.length).setValues(rows.map(rowToValues_));
}

function historyRow_(stamp, action, id, date, prev) {
  const p = prev || {};
  return [stamp, action, id, date,
    p.start || '', p.cardIn || '', p.cardOut || '', p.end || '', p.pause || '', p.note || '',
    prev ? (prev.deleted ? 'TRUE' : 'FALSE') : '',
    prev && prev.updatedAt != null && !isNaN(prev.updatedAt) ? String(prev.updatedAt) : ''];
}

function appendHistory_(rows) {
  const sh = historySheet_();
  const start = sh.getLastRow() + 1;
  ensureCapacity_(sh, start + rows.length - 1);
  const range = sh.getRange(start, 1, rows.length, HISTORY_HEADERS.length);
  range.setNumberFormat('@');
  range.setValues(rows);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
