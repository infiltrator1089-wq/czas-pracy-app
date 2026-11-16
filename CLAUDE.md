# CLAUDE.md

## Zasada: podbijanie cache w sw.js

Przy każdej zmianie w `index.html`, `app.js`, `sync.js` lub `styles.css` podbij
stałą `CACHE` w [sw.js](sw.js) (np. `czas-pracy-v3` → `czas-pracy-v4` → `v5`).

`sw.js` używa strategii network-first dla tych czterech plików, więc
przeglądarka i tak zawsze próbuje najpierw pobrać świeżą wersję z sieci —
ale nazwa cache musi się zmienić, żeby `activate` skasował stary wpis
cache (inaczej stare pliki mogą zalegać w nieużywanym już cache) i żeby
telefony w pełni offline (bez połączenia w momencie aktualizacji)
dostały świeży precache przy najbliższej okazji z siecią.

Bez podbicia wersji aplikacja nadal działa poprawnie online (network-first
i tak pobiera nowy kod), ale higiena cache się psuje.

Nowy plik JS/CSS ładowany przez `index.html` trzeba dopisać do `APP_SHELL`
oraz `NETWORK_FIRST_FILES` w `sw.js`.

## Synchronizacja z Arkuszem Google — niezmienniki

Kod: [sync.js](sync.js) (klient), [apps-script/Code.gs](apps-script/Code.gs)
(serwer), instrukcja wdrożenia: [SYNC-SETUP.md](SYNC-SETUP.md).

- **localStorage jest główną pamięcią** (offline-first). Klucz
  `timesheet.weeks.v1` (tygodnie po poniedziałku, 7 dni każdy) zostaje bez
  zmian; dzień dostaje dodatkowo `id` (UUID) i `updatedAt` (ms). Formatu CSV
  i logiki `computeDay` / `computeWeek` nie zmieniać bez wyraźnej prośby.
- Pozostałe klucze: `timesheet.outbox.v1` (kolejka wysyłkowa, klucz = ID),
  `timesheet.settings.v1` (adres skryptu + token), `timesheet.syncmeta.v1`.
- Wyczyszczenie wszystkich pól dnia = usunięcie wpisu (znacznik usunięcia
  w kolejce). Serwer robi **miękkie usuwanie** (wiersz zostaje z
  `deleted=TRUE` i starymi wartościami), a arkusz „Historia” jest
  **append-only** — kod nigdy nie może jej kasować ani nadpisywać.
- Konflikt: wygrywa wyższy `updatedAt`, przy remisie większe ID; jeden
  żywy wpis na datę. Ta sama reguła jest w `sync.js` (`wins`) i `Code.gs` (`wins_`)
  — zmieniać obie naraz.
- **Nigdy nie commitować adresu skryptu ani tokenu** (repo jest publiczne).
  Token żyje we Właściwościach skryptu (Apps Script) i w localStorage telefonu.
- Dane z chmury / pliku są niezaufane: do DOM tylko przez `textContent` lub
  `escapeHtml`, nigdy surowo do `innerHTML`.
- Po zmianie `Code.gs` trzeba w Apps Script zrobić **nową wersję wdrożenia**
  (Wdróż → Zarządzaj wdrożeniami → Edytuj → Nowa wersja), inaczej adres `/exec`
  dalej serwuje stary kod.
