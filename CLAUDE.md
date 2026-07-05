# CLAUDE.md

## Zasada: podbijanie cache w sw.js

Przy każdej zmianie w `index.html`, `app.js` lub `styles.css` podbij
stałą `CACHE` w [sw.js](sw.js) (np. `czas-pracy-v2` → `czas-pracy-v3`).

`sw.js` używa strategii network-first dla tych trzech plików, więc
przeglądarka i tak zawsze próbuje najpierw pobrać świeżą wersję z sieci —
ale nazwa cache musi się zmienić, żeby `activate` skasował stary wpis
cache (inaczej stare pliki mogą zalegać w nieużywanym już cache) i żeby
telefony w pełni offline (bez połączenia w momencie aktualizacji)
dostały świeży precache przy najbliższej okazji z siecią.

Bez podbicia wersji aplikacja nadal działa poprawnie online (network-first
i tak pobiera nowy kod), ale higiena cache się psuje.
