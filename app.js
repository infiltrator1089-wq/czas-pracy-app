const DOW = ['Pon', 'Wt', 'Śr', 'Czw', 'Pt', 'Sob', 'Nie'];
const STORAGE_KEY = 'timesheet.weeks.v1';

function pad2(n) { return String(n).padStart(2, '0'); }

function toISODate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function fromISODate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0 = Sunday
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function parseHM(str) {
  if (!str) return null;
  const parts = str.split(':');
  if (parts.length !== 2) return null;
  const h = Number(parts[0]), m = Number(parts[1]);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function diffWrap(startStr, endStr) {
  const s = parseHM(startStr), e = parseHM(endStr);
  if (s == null || e == null) return null;
  let d = e - s;
  if (d < 0) d += 24 * 60;
  return d;
}

function formatMin(mins) {
  if (mins == null) return '—';
  const sign = mins < 0 ? '-' : '';
  mins = Math.abs(Math.round(mins));
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${sign}${pad2(h)}:${pad2(m)}`;
}

function emptyDay(dateISO) {
  return { date: dateISO, start: '', cardIn: '', cardOut: '', end: '', pause: '', note: '' };
}

// --- storage ---
function loadAllWeeks() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveAllWeeks(weeks) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(weeks));
}

function weekHasData(days) {
  return days.some(d => d.start || d.cardIn || d.cardOut || d.end || d.pause || d.note);
}

function getWeek(mondayISO) {
  const weeks = loadAllWeeks();
  if (weeks[mondayISO]) return weeks[mondayISO];
  const monday = fromISODate(mondayISO);
  return Array.from({ length: 7 }, (_, i) => emptyDay(toISODate(addDays(monday, i))));
}

function persistWeek(mondayISO, days) {
  const weeks = loadAllWeeks();
  if (weekHasData(days)) {
    weeks[mondayISO] = days;
  } else {
    delete weeks[mondayISO];
  }
  saveAllWeeks(weeks);
}

// --- computation ---
function computeDay(day) {
  const cardTime = diffWrap(day.cardIn, day.cardOut);
  const gross = diffWrap(day.start, day.end);
  const pauseMin = parseHM(day.pause);
  const worked = Boolean(day.start && day.end);
  const net = gross != null ? gross - (pauseMin || 0) : null;
  return { cardTime, gross, pauseMin, net, worked };
}

function computeWeek(days) {
  let sumGross = 0, sumNet = 0, sumPause = 0, workedDays = 0;
  for (const day of days) {
    const c = computeDay(day);
    if (c.worked) {
      workedDays++;
      sumGross += c.gross || 0;
      sumNet += c.net || 0;
      sumPause += c.pauseMin || 0;
    }
  }
  const avg = workedDays > 0 ? sumNet / workedDays : 0;
  return { sumGross, sumNet, sumPause, workedDays, avg };
}

// --- state ---
let currentMonday = getMonday(new Date());
let currentDays = getWeek(toISODate(currentMonday));

const weekBody = document.getElementById('weekBody');
const weekTitle = document.getElementById('weekTitle');
const todayISO = toISODate(new Date());

function formatWeekRange(monday) {
  const sunday = addDays(monday, 6);
  const dm = d => `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}`;
  return `${dm(monday)}–${dm(sunday)}.${sunday.getFullYear()}`;
}

function fieldToLabel(field) {
  return { start: 'Początek', cardIn: 'Włożenie karty', cardOut: 'Wyjęcie karty', end: 'Koniec', pause: 'Pauza', note: 'Uwagi' }[field];
}

// --- validation (display-only, never blocks saving) ---
const TIME_FORMAT_RE = /^([0-1][0-9]|2[0-3]):([0-5][0-9])$/;

function isValidTimeFormat(str) {
  if (!str) return true;
  return TIME_FORMAT_RE.test(str);
}

function validateDay(day) {
  const fieldErrors = {};
  ['start', 'cardIn', 'cardOut', 'end', 'pause'].forEach(field => {
    fieldErrors[field] = Boolean(day[field]) && !isValidTimeFormat(day[field]);
  });

  const startEndMismatch = Boolean(day.start) !== Boolean(day.end);
  const cardMismatch = Boolean(day.cardIn) !== Boolean(day.cardOut);
  const missingPair = {
    start: startEndMismatch && !day.start,
    end: startEndMismatch && !day.end,
    cardIn: cardMismatch && !day.cardIn,
    cardOut: cardMismatch && !day.cardOut,
  };

  const c = computeDay(day);
  const negativeNet = c.net != null && c.net < 0;
  const longDay = c.gross != null && c.gross > 16 * 60;

  const hasIssue = Object.values(fieldErrors).some(Boolean)
    || Object.values(missingPair).some(Boolean)
    || negativeNet
    || longDay;

  return { fieldErrors, missingPair, negativeNet, longDay, hasIssue };
}

function dayIssueTitle(v) {
  const msgs = [];
  Object.entries(v.fieldErrors).forEach(([field, bad]) => {
    if (bad) msgs.push(`Nieprawidłowy format: ${fieldToLabel(field)}`);
  });
  if (v.negativeNet) msgs.push('Pauza dłuższa niż czas pracy');
  if (v.longDay) msgs.push('Podejrzanie długi dzień — sprawdź czasy');
  Object.entries(v.missingPair).forEach(([field, bad]) => {
    if (bad) msgs.push(`Brakuje: ${fieldToLabel(field)}`);
  });
  return msgs.join(' • ');
}

function render() {
  weekTitle.textContent = `📅 Tydzień: ${formatWeekRange(currentMonday)}`;
  weekBody.innerHTML = '';

  currentDays.forEach((day, idx) => {
    const c = computeDay(day);
    const d = fromISODate(day.date);
    const tr = document.createElement('tr');
    if (day.date === todayISO) tr.classList.add('today');

    tr.innerHTML = `
      <td class="day-cell"><span class="dow">${DOW[idx]}</span>${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}<span class="day-warning-icon hidden">⚠️</span></td>
      <td data-label="Początek"><input type="time" data-field="start" value="${day.start}"></td>
      <td data-label="Włożenie karty"><input type="time" data-field="cardIn" value="${day.cardIn}"></td>
      <td data-label="Wyjęcie karty"><input type="time" data-field="cardOut" value="${day.cardOut}"></td>
      <td class="computed" data-label="Czas na karcie"></td>
      <td data-label="Koniec"><input type="time" data-field="end" value="${day.end}"></td>
      <td data-label="Pauza"><input type="time" data-field="pause" value="${day.pause}"></td>
      <td class="computed gross" data-label="Czas brutto"></td>
      <td class="computed net" data-label="Czas netto"></td>
      <td data-label="Uwagi"><input type="text" data-field="note" value="${day.note}" placeholder="—"></td>
    `;

    tr.querySelectorAll('input').forEach(input => {
      input.addEventListener('change', () => {
        const field = input.dataset.field;
        currentDays[idx][field] = input.value;
        persistWeek(toISODate(currentMonday), currentDays);
        updateRowDisplay(tr, currentDays[idx]);
        renderSummary();
      });
    });

    updateRowDisplay(tr, day);
    weekBody.appendChild(tr);
  });

  renderSummary();
}

function updateRowDisplay(tr, day) {
  const c = computeDay(day);
  const v = validateDay(day);

  const cells = tr.querySelectorAll('.computed');
  cells[0].textContent = formatMin(c.cardTime);

  cells[1].textContent = formatMin(c.gross);
  cells[1].classList.toggle('gross-warning', v.longDay);
  if (v.longDay) cells[1].title = 'Podejrzanie długi dzień — sprawdź czasy';
  else cells[1].removeAttribute('title');

  cells[2].textContent = (v.negativeNet ? '⚠ ' : '') + formatMin(c.net);
  cells[2].classList.toggle('net-negative', v.negativeNet);
  if (v.negativeNet) cells[2].title = 'Pauza dłuższa niż czas pracy';
  else cells[2].removeAttribute('title');

  ['start', 'cardIn', 'cardOut', 'end', 'pause'].forEach(field => {
    const input = tr.querySelector(`input[data-field="${field}"]`);
    input.classList.toggle('input-error', Boolean(v.fieldErrors[field]));
    input.classList.toggle('input-missing', Boolean(v.missingPair[field]));
    if (v.fieldErrors[field]) input.title = 'Nieprawidłowy format czasu (HH:MM)';
    else if (v.missingPair[field]) input.title = 'Brakuje pary — uzupełnij drugie pole';
    else input.removeAttribute('title');
  });

  const icon = tr.querySelector('.day-warning-icon');
  icon.classList.toggle('hidden', !v.hasIssue);
  icon.title = dayIssueTitle(v);
}

function renderSummary() {
  const s = computeWeek(currentDays);
  document.getElementById('workedDaysLabel').textContent = s.workedDays;
  document.getElementById('sumGross').textContent = formatMin(s.sumGross);
  document.getElementById('sumNet').textContent = formatMin(s.sumNet);
  document.getElementById('sumPause').textContent = formatMin(s.sumPause);
  document.getElementById('sumDays').textContent = s.workedDays;
  document.getElementById('sumAvg').textContent = formatMin(s.avg);

  const motivation = document.getElementById('motivation');
  if (s.workedDays === 7) motivation.textContent = 'Pełny tydzień, szacunek! 💪';
  else if (s.workedDays >= 5) motivation.textContent = `Solidny tydzień, ${s.workedDays} dni! 💪`;
  else if (s.workedDays >= 1) motivation.textContent = `Uzupełniono ${s.workedDays} ${s.workedDays === 1 ? 'dzień' : 'dni'} w tym tygodniu.`;
  else motivation.textContent = 'Brak wpisanych dni w tym tygodniu — dodaj pierwsze godziny.';
}

function goToWeek(monday) {
  currentMonday = getMonday(monday);
  currentDays = getWeek(toISODate(currentMonday));
  render();
}

document.getElementById('prevWeek').addEventListener('click', () => goToWeek(addDays(currentMonday, -7)));
document.getElementById('nextWeek').addEventListener('click', () => goToWeek(addDays(currentMonday, 7)));

// --- copy / export ---
document.getElementById('copyBtn').addEventListener('click', async () => {
  const s = computeWeek(currentDays);
  let text = `Tydzień: ${formatWeekRange(currentMonday)}\n\n`;
  currentDays.forEach((day, idx) => {
    const c = computeDay(day);
    const d = fromISODate(day.date);
    text += `${DOW[idx]} ${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}: `
      + `Początek ${day.start || '—'}, Koniec ${day.end || '—'}, Pauza ${day.pause || '—'} `
      + `→ brutto ${formatMin(c.gross)}, netto ${formatMin(c.net)}${day.note ? ' (' + day.note + ')' : ''}\n`;
  });
  text += `\nŁączny czas brutto: ${formatMin(s.sumGross)}\n`;
  text += `Łączny czas netto: ${formatMin(s.sumNet)}\n`;
  text += `Łączna pauza: ${formatMin(s.sumPause)}\n`;
  text += `Przepracowane dni: ${s.workedDays}\n`;
  text += `Średnia netto/dzień: ${formatMin(s.avg)}\n`;

  try {
    await navigator.clipboard.writeText(text);
    flashButton('copyBtn', '✅');
  } catch {
    prompt('Kopiuj ręcznie:', text);
  }
});

function flashButton(id, icon) {
  const btn = document.getElementById(id);
  const original = btn.textContent;
  btn.textContent = icon;
  setTimeout(() => { btn.textContent = original; }, 1200);
}

document.getElementById('downloadBtn').addEventListener('click', () => {
  const headers = ['Data', 'Poczatek', 'Wlozenie karty', 'Wyjecie karty', 'Czas na karcie', 'Koniec', 'Pauza', 'Czas brutto', 'Czas netto', 'Uwagi'];
  const rows = [headers.join(';')];
  currentDays.forEach((day, idx) => {
    const c = computeDay(day);
    const d = fromISODate(day.date);
    rows.push([
      `${DOW[idx]} ${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}`,
      day.start, day.cardIn, day.cardOut, formatMin(c.cardTime),
      day.end, day.pause, formatMin(c.gross), formatMin(c.net), day.note
    ].join(';'));
  });
  const s = computeWeek(currentDays);
  rows.push('');
  rows.push(`Laczny czas brutto;${formatMin(s.sumGross)}`);
  rows.push(`Laczny czas netto;${formatMin(s.sumNet)}`);
  rows.push(`Laczna pauza;${formatMin(s.sumPause)}`);
  rows.push(`Przepracowane dni;${s.workedDays}`);
  rows.push(`Srednia netto/dzien;${formatMin(s.avg)}`);

  const blob = new Blob(['﻿' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `czas-pracy_${toISODate(currentMonday)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// --- history ---
const historyBtn = document.getElementById('historyBtn');
const historyList = document.getElementById('historyList');

historyBtn.addEventListener('click', () => {
  historyList.classList.toggle('hidden');
  if (!historyList.classList.contains('hidden')) renderHistory();
});

function renderHistory() {
  const weeks = loadAllWeeks();
  const keys = Object.keys(weeks).sort().reverse();
  historyList.innerHTML = '';
  if (keys.length === 0) {
    historyList.innerHTML = '<p style="color:var(--muted);margin:6px;">Brak zapisanych tygodni.</p>';
    return;
  }
  keys.forEach(key => {
    const monday = fromISODate(key);
    const s = computeWeek(weeks[key]);
    const item = document.createElement('div');
    item.className = 'history-item';
    item.innerHTML = `<span>${formatWeekRange(monday)}</span><span class="h-net">${formatMin(s.sumNet)} netto</span>`;
    item.addEventListener('click', () => {
      goToWeek(monday);
      historyList.classList.add('hidden');
    });
    historyList.appendChild(item);
  });
}

render();

// --- service worker + update banner ---
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then(reg => {
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateBar(reg);
          }
        });
      });
    }).catch(() => {});
  });

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}

function showUpdateBar(reg) {
  const bar = document.getElementById('updateBar');
  bar.classList.remove('hidden');
  document.getElementById('updateReloadBtn').addEventListener('click', () => {
    if (reg.waiting) reg.waiting.postMessage('SKIP_WAITING');
  }, { once: true });
}
