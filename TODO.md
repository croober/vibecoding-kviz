# TODO

Větev `android-tv`. Hotové věci jsou v `docs/` a `worker/README.md`, tady jen to, co zbývá.

## Návrh pro kolegu: sdílený modul server ↔ Worker

Logika generátoru (`SYSTEM`, `QUIZ_SCHEMA`, `RANDOM_AREAS`, `LEVELS`, parsování vstupu, sestavení promptu, míchání) je ve `server.js` a kopie ve `worker/src/quiz.js`. Dnes ji hlídá test `worker/src/drift.test.js` (selže, když se rozejdou), ale neodstraňuje duplicitu.

Návrh: přesunout logiku do jednoho souboru (např. `quiz-core.js`), který importuje `server.js` (Express adaptér) i Worker. `images.js` už takhle sdílený je (Worker ho importuje přímo; jen `imageProxy` je pro Express).

- Je to zásah do jádra (`server.js`) a do souboru, který kolega mění nejčastěji, proto potřebuje jeho souhlas, nejlépe aby změnu provedl nebo odsouhlasil on (pull request).
- Odhad: půl dne včetně testů. Po přesunu `drift.test.js` odpadne.
- Do té doby: při změně promptu nebo schématu ve `server.js` pustit `npm test` ve `worker/` a sjednotit `quiz.js` / `index.js`.

## Android TV

- [x] Obrázkové otázky v televizi: `tv.js` stáhne `/api/img` přes fetch s basic auth a vloží jako blob (ověřeno v prohlížeči s mockem). **Neověřeno v APK:** jestli `CapacitorHttp` vrací binární odpověď (`arrayBuffer()`) správně; při selhání se zkusí přímá adresa serveru.
- [x] Ovládání dálkovým ovladačem (D-pad, OK, Zpět, fokus, TV styly); ověřeno jen v jsdom (`tv-smoke`, mimo repo). **Čeká na test na TV:** Zpět přes `Capacitor.Plugins.App`, okraje (overscan), klávesnice u polí.
- [x] Mapování kláves: ↑↓ odpovědi, ←→ otázky, čísla 1–4/0 vybírají tým, kanál ▲▼ ± bod, Menu, vysvětlivky pod týmy (po testu na TV několikrát přepracováno). Tlačítka jdou přemapovat v menu → Ovládání TV. Ověřit na TV, že ovladač kanálová tlačítka posílá.
- [x] Bubliny s tématy jako fokusovatelná nápověda; čeká na test na TV.
- [ ] Kontrola kompatibility se staršími TV: `color-mix()` (33×) a `:has()` v `style.css` nemusí na starém WebView fungovat; záložní hodnoty v `tv.css` / `prepare.mjs`.
- [x] Ikona aplikace, TV banner a splash (Gemini, zdroje v `docs/ikony/`); vzhled zkontrolovat na TV.
- [ ] Ověřit APK na emulátoru Android TV (API 28 a 34) a na skutečné televizi, zejména `CapacitorHttp` (hlavičky, diakritika, binární odpovědi).
- [ ] `npm run android:debug` zatím nenastavuje JDK 17 (Gradle 8.2.1 neběží na JDK 22): zabudovat `JAVA_HOME`, nebo popsat v `docs/ANDROID.md`.
- [x] `docs/ANDROID.md` a README o TV build.

## Worker (Cloudflare)

- [ ] Znovu nasadit s novou verzí (obrázky, omezení počtu požadavků).
- [ ] Nastavit `ANTHROPIC_API_KEY` a vyzkoušet reálné generování, i s obrázky; změřit CPU na tarifu Free.
- [ ] Zapnout basic auth (`BASIC_AUTH_USER`, `BASIC_AUTH_PASS`) a ověřit.
- [ ] IP pravidlo ve WAF (až po ověření generování), viz `docs/cloudflare.md` krok 6c.
- [ ] Limit výdajů u klíče v Anthropic Console.
