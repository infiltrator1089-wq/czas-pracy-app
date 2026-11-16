# Synchronizacja z Arkuszem Google — instrukcja krok po kroku

Po tej konfiguracji każda zmiana w aplikacji sama ląduje w Twoim Arkuszu Google.
Jeśli telefon się zepsuje lub zgubisz dane, odzyskasz wszystko przyciskiem
**☁️ Przywróć z chmury**.

Czas: ok. 10–15 minut, jednorazowo. Potrzebujesz konta Google i komputera.

## Jak to działa (w skrócie)

- Dane **zawsze zapisują się najpierw w telefonie** — aplikacja działa bez zasięgu.
- Zmiany idą do Arkusza w tle. Bez internetu czekają w kolejce i wysyłają się
  same, gdy tylko wrócisz do aplikacji z zasięgiem.
- Pasek pod tytułem pokazuje stan: ✅ zsynchronizowane / ⏳ czeka na wysłanie.
  Jeśli coś czeka dłużej niż 24 h, pojawia się czerwony baner
  „⚠ X dni niezsynchronizowanych od …”.
- Arkusz ma dwie karty: **Dane** (aktualny stan) i **Historia** (dziennik,
  do którego tylko dopisujemy — nic z niej nie jest nigdy kasowane).

## Krok 1 — załóż Arkusz

1. Wejdź na <https://sheets.google.com> → **Pusty arkusz**.
2. Nazwij go np. **Czas pracy** (kliknij „Arkusz bez tytułu” u góry).

## Krok 2 — wklej skrypt

1. W arkuszu: **Rozszerzenia → Apps Script** (*Extensions → Apps Script*). Otworzy się edytor.
2. Usuń cały domyślny kod (`function myFunction() {…}`).
3. Otwórz plik [`apps-script/Code.gs`](apps-script/Code.gs) z tego repozytorium,
   skopiuj **całą zawartość** i wklej do edytora.
4. Kliknij ikonę dyskietki (**Zapisz projekt**). Nazwa projektu dowolna.

## Krok 3 — uruchom `setup` (utworzy karty i token)

1. Na pasku nad kodem, obok przycisku **Uruchom** (*Run*), jest lista funkcji — domyślnie
   ustawiona na `doGet`. **Zmień ją na `setup`** (to najczęstsza pomyłka), potem kliknij **Uruchom**.
   (Jeśli w widoku *Wykonania / Executions* widzisz tylko wiersz z `doGet`, uruchomiłeś złą funkcję.)
2. Google poprosi o uprawnienia → **Przejrzyj uprawnienia** → wybierz swoje konto.
3. Zobaczysz ostrzeżenie „Ta aplikacja nie jest zweryfikowana”. To normalne dla
   własnego skryptu: **Zaawansowane → Otwórz projekt (niebezpieczne)** → **Zezwól**.
   (Skrypt ma dostęp tylko do tego jednego arkusza.)
4. Po uruchomieniu otwórz **Dziennik wykonania** (*Execution log*) na dole.
   Znajdziesz tam linię:

   ```
   TOKEN (skopiuj do ustawień aplikacji): <64 znaki>
   ```

   Jeśli logu nie widać na dole edytora: w widoku *Wykonania / Executions* rozwiń wiersz
   funkcji `setup` i w „Cloud logs” kliknij *Odśwież / Refresh* (logi bywają opóźnione).
   Token jest też w *Ustawienia projektu → Właściwości skryptu → TOKEN*.

   **Skopiuj ten token** (sprawdź też, że w arkuszu pojawiły się karty „Dane” i „Historia”).
   Token jest zapisany także w: *Ustawienia projektu (ikona koła zębatego) →
   Właściwości skryptu → TOKEN*, więc nie przepadnie.

> Token to hasło do Twoich danych. Nie wysyłaj go publicznie, nie rób jego
> zrzutów ekranu i nie wpisuj do kodu ani do repozytorium.

## Krok 4 — wdróż jako aplikację internetową

1. W edytorze: **Wdróż → Nowe wdrożenie** (*Deploy → New deployment*).
2. Kliknij ikonę koła zębatego obok „Wybierz typ” → **Aplikacja internetowa** (*Web app*).
3. Ustaw:
   - **Opis:** `czas pracy v1`
   - **Wykonaj jako:** **Ja** (*Me*)
   - **Kto ma dostęp:** **Wszyscy** (*Anyone*) — to jest konieczne, żeby aplikacja
     w telefonie mogła wysłać dane bez logowania do Google. Zabezpieczeniem jest
     token (skrypt odrzuca każde żądanie bez poprawnego tokenu).
4. **Wdróż** → skopiuj **Adres URL aplikacji internetowej** (kończy się na `/exec`).
5. Sprawdź w przeglądarce: wklej ten adres w nowej karcie. Powinieneś zobaczyć:

   ```
   {"ok":true,"service":"czas-pracy-sync","version":1}
   ```

   (Ten adres bez tokenu nie ujawnia żadnych danych.)

## Krok 5 — połącz aplikację

1. Otwórz aplikację na telefonie → **⚙** obok paska stanu.
2. Wklej **adres URL** (z kroku 4) i **token** (z kroku 3).
3. Dotknij **Testuj połączenie**. Oczekiwany wynik: `✅ Połączono. Wierszy w arkuszu: 0`.
   - `Nieprawidłowy token` → token skopiowany z błędem (spacje?) lub po `rotateToken()`.
   - `Skrypt zwrócił nieoczekiwaną odpowiedź…` → wdrożenie nie ma dostępu „Wszyscy” (krok 4.3).
   - `Brak połączenia z serwerem` → sprawdź adres i internet.
4. **Zapisz**. Cała dotychczasowa historia z telefonu wyśle się do Arkusza
   automatycznie (zobaczysz ✅ po kilku sekundach).

## Krok 6 — sprawdź, że działa (2 minuty)

- [ ] W karcie **Dane** pojawiły się wiersze z Twoimi dniami (godziny w formacie `05:17`, nie jako daty).
- [ ] Zmień godzinę zakończenia jakiegoś dnia → po paru sekundach zmienia się w **Dane**,
      a w **Historii** pojawia się wiersz `update` ze **starą** wartością.
- [ ] Włącz tryb samolotowy, zmień coś → pasek pokazuje `⏳ … Offline`. Wyłącz tryb
      samolotowy i wróć do aplikacji → samo zmienia się na ✅.
- [ ] Wyczyść wszystkie pola jednego dnia → w **Dane** ten wiersz ma `deleted = TRUE`.
      Uwaga: pola czyszczone po kolei, gdy jest zasięg, synchronizują się jako osobne
      zmiany, więc w wierszu mogą zostać tylko ostatnie niewyczyszczone pola. **Pełne,
      pierwotne wartości dnia są zawsze w Historii** (wiersze `update` / `delete`,
      kolumny `prev_…`).

## Zabezpieczenie karty „Historia” (zalecane)

Skrypt tylko dopisuje do Historii. Żeby nie skasować jej przypadkiem ręcznie:
prawy klik na karcie **Historia → Chroń arkusz** (*Protect sheet*) → **Ustaw uprawnienia →
Ograniczaj, kto może edytować → Tylko Ty**. Skrypt działa jako Ty, więc nadal będzie
mógł dopisywać.

## Co zrobić, gdy…

**…przypadkowo wyczyściłem dzień.** Dane nie przepadły, ale szukaj ich w karcie
**Historia**, nie w „Dane”. Wiersz tego dnia w **Dane** ma `deleted = TRUE`, lecz mógł
stracić część pól (pola czyszczone po kolei z zasięgiem wysyłają się jako osobne zmiany).
W **Historii** znajdź po dacie (kolumna `date`) **najwcześniejszy** wiersz `update` lub
`delete` z tego dnia — kolumny `prev_start`, `prev_cardIn`, `prev_cardOut`, `prev_end`,
`prev_pause`, `prev_note` zawierają pierwotne wartości sprzed czyszczenia. Wpisz je
z powrotem w aplikacji.

**…telefon się zepsuł / mam nowy telefon.** Zainstaluj aplikację → **⚙** → wpisz
adres i token → **Zapisz** → **☁️ Przywróć z chmury**. Aplikacja pobierze wszystkie
dni, sprawdzi format, błędne wiersze pokaże jako ostrzeżenie (z numerem wiersza w
arkuszu) i scali resztę. Skasowane dni nie wracają.

**…chcę mieć kopię w pliku.** **💾 Eksport JSON** zapisuje pełną kopię; **📂 Import JSON**
wczytuje ją z powrotem (scala po ID, nowsza wersja wygrywa, błędne wpisy pomija).
Rób to od czasu do czasu jako drugi, niezależny zapas.

**…podejrzewam, że ktoś zna token.** W Apps Script wybierz funkcję **`rotateToken`** →
**Uruchom**, skopiuj nowy token z dziennika wykonania i wpisz go w ⚙ w aplikacji.
Stary token od razu przestaje działać.

**…zmieniam kod skryptu.** Po edycji **Wdróż → Zarządzaj wdrożeniami → ✏️ Edytuj →
Wersja: Nowa wersja → Wdróż**. Bez tego adres `/exec` dalej serwuje stary kod.

## Ograniczenia (warto znać)

- Wysyłka działa, gdy **aplikacja jest otwarta**. Zmiany zrobione offline wyślą się
  przy następnym otwarciu z zasięgiem — przeglądarka nie pozwala niezawodnie
  wysyłać w tle przy zamkniętej aplikacji. Dopóki nie widzisz ✅, ostatnie zmiany
  mogą być tylko w telefonie.
- Konflikt (ten sam dzień edytowany na dwóch urządzeniach) rozstrzyga **nowszy
  znacznik czasu** zegara urządzenia. Przy jednym telefonie to nie ma znaczenia.
- Jeden dzień kalendarzowy = jeden wpis. Ręczne edytowanie karty **Dane** jest
  możliwe, ale nie zmieniaj kolumn `id` i `updatedAt` (nowszy `updatedAt` = Twoja
  ręczna zmiana wygra z telefonem).
- Karta **Dane** zawiera tylko dane wejściowe (godziny, uwagi). Czasu brutto i netto
  w arkuszu nie ma — te wartości liczy aplikacja.
