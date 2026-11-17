# Android TV

Kvíz jde zabalit do APK pro Android TV (Capacitor). Web ani lokální verze se tím nemění: TV vrstva z `android-tv/` se vkládá jen při buildu do `www-android/`.

## Sestavení APK

Potřebuješ JDK 17 (Gradle 8.2.1 neběží na JDK 22) a Android SDK.

1. `npm install`
2. Volitelně vytvoř `android-tv/tv-config.json` podle `tv-config.example.json` (adresa serveru, token, basic auth). Soubor je mimo git. Bez něj se server nastaví až v aplikaci (menu → Nastavení serveru).
3. `npm run android:prepare` – zkopíruje `public/` do `www-android/`, nahradí CDN lokálními písmy a ikonami, vloží TV skripty.
4. `npx cap sync android`
5. V `android/` s `JAVA_HOME` na JDK 17: `gradlew.bat assembleDebug`
6. APK: `android/app/build/outputs/apk/debug/app-debug.apk` (debug, mimo Play Store).

Stejné kroky jedním příkazem (příprava, sync, sestavení; Windows): `npm run android:debug`.

Backend: `worker/` (Cloudflare Worker, viz `worker/README.md` a `docs/cloudflare.md`) nebo vlastní server. V `worker/wrangler.jsonc` je zástupná doména `kviz.example.cz`, před nasazením ji nahraď vlastní. Adresu serveru, token a basic auth pak zadej v aplikaci na TV (menu → Nastavení serveru) nebo předem v `android-tv/tv-config.json`.

Debug APK je jen pro vývoj a vlastní televizi: neposílej ho dalším lidem (ladicí build zapisuje do logu zařízení víc údajů) a nepodepisuje se pro Play Store.

## Velikost rozhraní

Televize hlásí hustotu pixelů 2×, takže WebView měl na šířku jen 960 px (na Android TV 1080p naměřeno 960 × 540, měřítko 2) a vše vypadalo obří. Úprava hustoty v `MainActivity` nezabrala. Zabralo `<meta name="viewport" content="width=…">`, které do `index.html` v APK vkládá `prepare.mjs` (jen APK, web se nemění), spolu s „širokým viewportem“ zapnutým v `MainActivity.java`: WebView počítá s rozvržením o dané šířce a zmenší ho na obrazovku. Šířka 1920 vyšla moc malá, výchozí je proto **1440**.

Velikost jde změnit v menu → Ovládání TV → blok **Velikost rozhraní** (Větší / Menší, kroky 1120–1920 px, 100 % = 1440). Volba se pamatuje (`kviz-tv-width`) a řádek „Obrazovka“ v bloku Informace o zařízení ukazuje skutečný rozměr okna. Výběr ikony týmu je v TV vždy uprostřed obrazovky a celý vidět (s posuvníkem, když se nevejde).

## Instalace na televizi

- ADB: `adb connect <IP televize>` a `adb install -r app-debug.apk` (na TV zapnout ladění USB/sítě ve volbách pro vývojáře).
- Nebo nahrát APK na úložiště a otevřít aplikací Downloader / správcem souborů.
- Přes URL: vystav `app-debug.apk` na jakémkoli statickém HTTP serveru ve stejné síti (např. jednoduchý server na počítači na vlastním portu) a v aplikaci Downloader na TV zadej adresu souboru. Instalace z neznámých zdrojů se povoluje pro Downloader.

## Ovládání dálkovým ovladačem

| Tlačítko | Co dělá |
|---|---|
| ↑ ↓ (v kvízu) | zvýrazní odpověď; ↑ z první odpovědi na tlačítko v záhlaví (X / menu), ↓ z poslední na nastavení dole |
| OK | potvrdí zvýrazněnou odpověď; po odhalení jde na další otázku; při vybraném týmu jen zruší výběr |
| ← → (v kvízu) | předchozí / další otázka; → na neodhalené otázce se zeptá „Přejít dál bez odpovědi?“ (OK přejde, Zpět zůstane) |
| 1–4 | vybere tým pro body (zvýrazněný tlustým rámcem); stejné číslo podruhé výběr zruší |
| 0 | vybere všechny týmy (podruhé zruší) |
| 1–3 bez týmů | vybere odpověď podle pořadí (týmy se nevybírají) |
| ↑ / ↓ při vybraném týmu | +bod / −bod vybranému týmu (místo výběru odpovědí); výběr zruší OK, Zpět nebo stejné číslo |
| kanál ▲ / ▼ | totéž jako ↑ / ↓ u vybraného týmu (bez výběru ukáže hlášku) |
| Menu | otevře nabídku |
| Zpět | zavře dialog / menu / emoji, při bzučení (pruh „Odpovídá“) tým uvolní bez odpovědi, v kvízu se zeptá na opuštění, na úvodní obrazovce na ukončení aplikace |
| ↓ z pole s tématem | na tlačítko „Hrát znovu: <poslední téma>“ (OK nabídne nové otázky od AI, nebo stejné v jiném pořadí) a na bubliny |
| šipky mimo kvíz | přesun fokusu podle polohy prvků; ↓ z pole s tématem na bubliny (OK vloží téma, Zpět vrátí do pole) |

**Textová pole:** šipky na pole jen přesunou fokus (klávesnice se neukáže, jinak by pohlcovala šipky). **OK** pole otevře k psaní s klávesnicí televize, **Enter / Hotovo** na klávesnici psaní ukončí a šipky zase přepínají prvky; Zpět psaní také ukončí. Našeptávač u tématu se po Hotovo ukáže dál: ↓/↑ vybírají položku, OK ji vloží. Téma se pak odešle šipkou na tlačítko vedle pole. Pohodlněji se píše z mobilu přes aplikaci Google TV.

**Posouvání:** ↑/↓ posune obsah (souhrn výsledků, průběh kvízu, dlouhé dialogy), když v tom směru už není další ovladatelný prvek.

### Nastavení tlačítek (menu → Ovládání TV)

Dialog má čtyři sbalitelné bloky (otevřený je vždy jen jeden, souhrn vedle názvu ukazuje stav bez rozbalení): **Tlačítka ovladače**, **Velikost rozhraní**, **Zvuk** a **Informace o zařízení** (poslední stisk, Zpět, verze, rozměr obrazovky). Nadpis bloku se otevře šipkami a OK. Popis níže je blok Tlačítka ovladače.

Seznam všech akcí (šipky, OK, týmy 1–4, všichni, přidat/odebrat bod, Menu) s tlačítkem, které je právě ovládá. U akce „Změnit“ počká na stisk tlačítka ovladače a přiřadí ho, „Výchozí“ vrátí původní, „Obnovit výchozí“ zruší všechna vlastní. Zpět přiřazování zruší. Výchozí tlačítka fungují vždy, takže se nejde zamknout. Jedna akce má jedno vlastní tlačítko. Tlačítko, které je výchozí pro jinou akci nebo už je vlastní jiné akce, dialog odmítne a řekne, komu patří. V bloku Informace o zařízení je vidět poslední stisknuté tlačítko (`key`, `code`, `keyCode`), stav Zpět a číslo verze. Vlastní přiřazení je v `localStorage` (`kviz-tv-keys`), řádek vysvětlivek v kvízu se řídí jím. Zpět přemapovat nejde.

### Zvuk

Aplikace reaguje zvukem na události kvízu: správná odpověď (veselé „ding“), špatná (nízké „bzzt“), ukázání odpovědi bez výběru, +bod / −bod, výběr týmu číslem, další otázka, kvíz je vygenerovaný, výsledky (fanfára) a chybová hláška. Zvuky se syntetizují přes Web Audio API (`android-tv/tv-sound.js`), žádné soubory ani licence. V archivním kvízu je ticho, při obnově rozehraného kvízu po startu také. **Každý stisk tlačítka ovladače** (šipky, OK, čísla, kanály, Menu, Zpět) navíc krátce cvakne, pokud na něj nezazněl jiný zvuk; opakované držení tlačítka a psaní na klávesnici televize necvaká. Hlasitost (vypnuto / tiše / středně / hlasitě, výchozí středně) a zkušební zvuk jsou v menu → Ovládání TV → Zvuk, volba je v `localStorage` (`kviz-tv-sound`). Krátké zvuky nepřebíjejí důležitější těsně po sobě (správná odpověď má přednost před zvukem bodu). `MainActivity` povoluje přehrávání bez gesta, ale zvuk se odemyká i prvním stiskem tlačítka.

### Příprava hry

- **Zadání z minula:** počet otázek a obtížnost se pamatují (`localStorage` `kviz-tv-setup`) a při dalším spuštění se obnoví. Obrázkový režim si pamatuje už `app.js`, upřesnění (instrukce) se záměrně nepamatuje, bývá specifické pro téma.
- **Kolik týmů hraje?** Když se poprvé objeví první otázka nového kvízu, otevře se okno s volbou *Bez týmů / 1 / 2 / 3 / 4 týmy* (aktuální počet je zvýrazněný a vybraný). Zpět nechá týmy, jak jsou. Nadbytečné týmy se ubírají od konce, chybějící se přidávají s dalšími volnými zvířaty. Rozehraný nebo archivní kvíz se neptá. Názvy a ikony jdou dál měnit v nastavení týmů.

### Jeden tým

S jediným týmem se body za **správnou odpověď** přičtou samy (podle obtížnosti, u adaptivního bodování 1–3). Špatná odpověď ani „ukázat odpověď“ bez výběru body nemění. Výběr týmu odpadá a kanál ▲/▼ upravuje body ručně. Řádek vysvětlivek to říká. Dělá to TV vrstva (obalí `pick()` z `app.js`), web se nemění.

### Poznámky ke klávesám

Čísla a kanály se čtou i když televize neposílá `code` (použije se `key` nebo `keyCode`; kanály: `ChannelUp/Down`, keyCode 166/167, 427/428, nebo PageUp/PageDown). V kvízu je pod týmy řádek s vysvětlivkami. Týmy se v kvízu šipkami nevybírají, jen čísly. Výběr týmu zůstává i při přechodu na další otázku.

Podržení OK televize může brát jako systémovou zkratku, proto aplikace opakované OK zachytává a nic nedělá.

Číslo verze aplikace (v dialogu Ovládání TV) roste s každým sestavením, takže se instaluje jako aktualizace.

## Ovládání z mobilu

TV aplikace spouští vlastní malý server (nativní plugin `KvizLink`, WebSocket) a z mobilu jde kvíz ovládat jako dálkovým ovladačem a psát do polí. Příkaz z mobilu se na TV zpracuje jako stisk klávesy ovladače (stejná navigace, zvuky i potvrzovací dotazy). Mobil nic nepočítá, jen zobrazuje stav, který mu televize pošle. Aplikaci na mobil instalovat nemusíš, stačí prohlížeč.

### Připojení

1. Mobil připoj ke **stejné Wi-Fi** (nebo síti) jako televize.
2. Na úvodní obrazovce (zadání) je vpravo karta **Ovládání z mobilu** s QR kódem. Jinak otevři menu → **Ovládání z mobilu** (u Nastavení serveru je i tlačítko **Psát z mobilu**).
3. Naskenuj QR fotoaparátem mobilu. Otevře se stránka ovladače. QR obsahuje klíč ovladače, proto se adresa textem ukáže jen tehdy, když nejde QR vykreslit.

Karta ovladače stojí na zadání pod kartou hry (**Hrát s mobily – bzučák**). Karta QR na zadání se **skryje, jakmile je připojený mobil** (QR s kódem by jinak zůstal na promítané obrazovce), a po odpojení se vrátí. Bez adresy v síti (televize není na Wi-Fi) karta zmizí a dialog ukáže „Televize není připojená k síti“ a tlačítko **Zkusit znovu**. Dialog ukazuje stav (čeká na připojení / připojeno), seznam připojených mobilů s odezvou (u pomalého spojení varování) a tlačítko **Nový kód**.

### Co umí mobilní stránka

- **Ovladač:** šipky, OK, Zpět, Menu (stejné akce jako na ovladači televize).
- **Týmy a body:** tlačítka 1–4 a Vše vybírají týmy, plus / minus mění body vybranému týmu. Tlačítka se řídí počtem týmů na TV (výběr týmů je od dvou týmů, body od jednoho); mimo kvíz jsou skrytá a v archivu, při otevřeném menu nebo dialogu zamčená.
- **Odpověď číslem:** tlačítka 1 / 2 / 3 vyberou odpověď. Fungují jen v běžícím (ne archivním) kvízu, v malém zobrazení týmů, bez otevřeného menu nebo dialogu a na neodhalené otázce; jinak TV odpoví „locked“ a mobil ukáže hlášku.
- **Psaní do aktivního pole:** vybrané pole na TV se objeví na mobilu a text se na TV přepisuje při psaní, **Hotovo** pole potvrdí (změna se uloží jako po Hotovo na klávesnici televize). Na zadání bez vybraného pole se píše do pole s tématem. Pole s heslem (token, basic auth v Nastavení serveru) se maskuje: hodnota z TV na mobil nikdy nejde, na mobilu jde jen přepsat. **Adresu serveru** jde z mobilu měnit jen tehdy, když je token i basic auth prázdný (údaje by jinak mohly odejít na podstrčenou adresu). V archivním kvízu se mimo dialogy nepíše. Délka textu je omezená (500 znaků nebo `maxLength` pole).
- Stav: ukazuje připojení, aktuální obrazovku a zámek archivu. Při výpadku spojení se mobil připojuje sám (a hned po návratu na stránku), spárování si pamatuje v prohlížeči.

### Síť a adresa

- Server běží na TV na portu **8765** (obsazený port nahradí dalším, až 8774), protokol **http**, jen v lokální síti. Adresa ovladače: `http://<IP televize>:<port>/m/?t=<kód>&k=<klíč>`.
- **Kód místnosti** (6 znaků) bez správného kódu WebSocket nenaváže, sám ale nedává žádná práva. **Klíč ovladače** (12 znaků, jen v QR) dává právo ovládat televizi, viz Hráči na mobilech a bzučák. Kód vzniká při prvním spuštění (`localStorage` `kviz-tv-link`) a mění se tlačítkem **Nový kód**, které odpojí všechny mobily; ty pak musí naskenovat nový QR. Stránka bez kódu v adrese ukáže výzvu ke skenování QR.
- Server se při odchodu aplikace do pozadí zastaví a po návratu spustí znovu na stejném portu a s týmž kódem, mobily se připojí samy.
- Nejvýš 16 současných spojení. Celé ovládání je hotové jen v APK s pluginem; webová verze (`public/`) o něm neví.
- Ladění: `adb forward tcp:8765 tcp:8765` a v prohlížeči na počítači `http://localhost:8765/m/?t=<kód>&k=<klíč>` (klíč je jen v QR ovladače; stránku hráče otevře `/m/player.html?t=<kód>`). Logika protokolu má testy `npm run test:tv`.

## Hráči na mobilech a bzučák

Hra s hráči je volitelná a vypnutá. Hráči se připojí svým mobilem (bez instalace), vyberou si přezdívku a tým a na otázku „bzučí“: televize vybere, kdo stiskl první, a ukáže, který tým odpovídá. Odpověď vybírá moderátor ovladačem na TV, mobil hráče v režimu **Bzučák** (výchozí) nikdy nedostane otázku, odpovědi ani správnou odpověď. Výjimka je volitelný režim **Odpovědi na mobilu** (viz níže), kde hráč otázku a tři odpovědi dostane a správnou odpověď až po odhalení na TV. Dělá to TV vrstva (`game-core.js`, `answer-core.js`, `tv-game.js`, `tv-lobby.js`, `tv-buzz.js`, `tv-answers.js`, stránka `mobile/player.*`), `public/` se nemění.

### Připojení

1. Mobily hráčů připoj ke **stejné Wi-Fi** jako televize.
2. Na úvodní obrazovce (zadání) je vpravo karta **Hrát s mobily – bzučák** s tlačítkem **Zapnout** (jinak menu → **Hráči na mobilech** → **Hra s hráči**). Po zapnutí karta ukáže QR pro hráče, počet a přezdívky připojených (nejvýš 10, podle výšky obrazovky i méně, zbytek jako „a další {n}“), tlačítko **Vypnout** a **Nastavení** (otevře dialog Hráči na mobilech s Odebrat a automatickým bodem). Karta se promítá hráčům a nepřekrývá zadání. QR ovladače se při zapnuté hře skryje; tlačítko **QR ovladače** na kartě otevře dialog Ovládání z mobilu (pro moderátora, QR se ukáže až tam).
3. Hráč QR naskenuje, napíše přezdívku (nejvýš 16 znaků) a vybere tým. Stránka si přezdívku a tým pamatuje, po výpadku se připojí sama.
4. Připojit se smí **nejvýš 12 hráčů**. Týmy se berou z lišty týmů na TV (nejvýš 4). Dialog ukazuje soupisku podle týmů s odezvou a tlačítkem **Odebrat**.
5. **Bzučák potřebuje aspoň 2 týmy.** S jedním týmem se hráči připojit smějí, ale bzučák se neodjistí a bod za správnou odpověď se přičítá jako dřív (viz Jeden tým).

Hra se zapíná a vypíná na kartě na zadání nebo v dialogu Hráči na mobilech; zapnutí z obou míst se při připojeném ovladači ptá stejně (dotaz vyjmenuje jména ovladačů, čte se jen při otevření dotazu a může ho potvrdit i ovladač připojený z mobilu). Zapnutí hry i přepínač **Bod za správnou odpověď automaticky** (výchozí zapnutý) se pamatují (`localStorage` `kviz-tv-game-v1`).

### Pravidla kola

- **Odjištění:** bzučák se odjistí **1 s** po zobrazení otázky. Dřív je tlačítko na mobilu „Připrav se…“.
- **Předčasný stisk:** stisk před odjištěním dá hráči trest **1,5 s** (tlačítko „Moc brzy!“).
- **Kdo byl první:** televize sbírá stisky po prvním stisku **60 ms** a vítěze vybere podle času příjmu na TV (ne podle hodin mobilů). Jeden stisk na hráče; dokud tým odpovídá, další stisky se nepřijímají.
- **Pruh „Odpovídá“:** nad odpověďmi se ukáže „Odpovídá: <tým> – <přezdívka>“, karta týmu se zvýrazní a zazní zvuk. Moderátor vybere odpověď, kterou tým řekl (ovladačem, nebo z mobilu ovladače tlačítky 1 / 2 / 3).
- **Zpět = bez odpovědi:** tlačítko Zpět při bzučení tým uvolní, tým je do konce otázky zamčený a bzučák se otevře ostatním. Při velkém zobrazení týmů Zpět nejdřív zavře ono.
- **Druhá šance:** špatná odpověď, když může bzučet jiný tým s připojeným hráčem, otázku **neodhalí**: odpověď se jen označí jako špatná, tým se zamkne a bzučák se otevře ostatním. Zbývá-li jen zamčený tým, otázka se odhalí a kolo skončí. Špatné pokusy se do průběhu kvízu nezapisují.
- **Automatický bod:** správná odpověď přičte bzučícímu týmu body samy (podle obtížnosti, jako u Jednoho týmu), **právě jednou**. Vypínač je v dialogu Hráči na mobilech. Bez bzučení (nikdo nestiskl, moderátor vybírá sám) se body přičítají ručně jako dřív.
- **Co bzučák pozastaví:** otevřený dialog, menu nebo výběr emoji a velké zobrazení týmů. Pozastavený bzučák nepřijímá stisky. Už odjištěný je po návratu aktivní hned, bez nové prodlevy; neodjištěný se odjistí 1 s po návratu. Archivní kvíz bzučák nemá vůbec (je jen ke čtení).
- Odebrání nebo přeřazení týmu na TV vrátí kolo do „Připrav se…“ a může nechat hráče bez týmu; ten si tým vybere znovu. Přejmenování týmu hráče nepřesune.

### Dva QR kódy a klíč ovladače

- **QR pro hráče je veřejný:** dává jen právo hrát (přezdívka, tým, bzučení). Adresa: `http://<IP televize>:<port>/m/player.html?t=<kód>`.
- **QR ovladače je tajný a hráčům se neukazuje.** Kdo ho naskenuje, ovládá celý kvíz (včetně psaní do polí). Proto je ve hře s hráči karta ovladače na zadání skrytá a dialog Ovládání z mobilu při zapnuté hře varuje „Běží hra s hráči. Tenhle QR kód je jen pro moderátora, neukazuj ho hráčům.“
- **Klíč ovladače** (12 znaků) je jen uvnitř QR ovladače (`&k=<klíč>`), na TV se nevypisuje textem (výjimka: nejde-li QR vykreslit, ukáže se adresa pro ruční opsání). Ovladač bez platného klíče televize odmítne. Hráči klíč nedostanou nikdy.
- **Výměna klíče:** při **zapnutí** hry se klíč vymění. Připojené ovladače dostanou nový klíč samy a zůstanou připojené; dialog je před zapnutím vyjmenuje („Zapnout hru s hráči?“, jména nebo „Mobil <n>“), aby šlo poznat cizí zařízení (pak zrušit a dát Nový kód). Tlačítko **Nový kód** vymění kód místnosti i klíč a odpojí všechny ovladače i hráče; hráči musí znovu naskenovat QR pro hráče. Staré záložky a QR ovladače s původním klíčem neplatí.
- Mobil ovladače klíč po připojení z adresy odstraní (`history.replaceState`). V historii prohlížeče a ve čtečce QR ale původní adresa s klíčem zůstává (z globální historie ji `replaceState` neodstraní). Platí jen do další výměny klíče (zapnutí hry, Nový kód), proto mobil, který ovladač jednou používal, nepůjčuj dál a po akci klíč vyměň.

### Odebrání hráče

Tlačítko **Odebrat** v soupisce hráče odpojí a zapíše do seznamu odebraných (nejvýš 32, nejstarší vypadne). Odebraný mobil se do hry nevrátí **do vypnutí a zapnutí hry s hráči nebo restartu aplikace**; seznam je jen v paměti TV. Důvod odebrání hráč uvidí („Moderátor tě odebral ze hry“). Odebrání je poctivé zdržení, ne zámek: televize pozná zařízení podle `clientId`, který si volí mobil, takže hráč, který smaže data stránky, se přihlásí znovu s novým. Ověřování zařízení je mimo rozsah.

### Síť a bezpečnost

Spojení mobilu s televizí je `ws://` a `http://`, **bez šifrování**, jen v místní síti. Kdo síť odposlouchává, přečte `resume` hráče a může převzít jeho identitu (a u ovladače klíč při připojení). **Hrajte jen na důvěryhodné Wi-Fi**, ne na veřejné nebo hotelové. Další ochrany (klíč ovladače, role, omezení počtu zpráv a 16 spojení) mají omezit zneužití hosty v téže síti, ne odposlech.

### Omezení

- Soupiska je jen v paměti TV. Po restartu aplikace se hráči zapíšou sami, jakmile se jejich mobil znovu připojí (stránka si pamatuje přezdívku a tým); kolo se nepamatuje.
- Hráč smí **měnit tým jen mimo kvíz nebo po odhalení otázky** (mimo běžící kolo); jinak „Tým jde změnit až po téhle otázce“.
- Kdo bzučel, se do archivu ani průběhu kvízu nezapisuje.
- Odpovědi hráčů na mobilu (hráč sám volí 1 / 2 / 3) jsou jen v režimu **Odpovědi na mobilu**, popis v další sekci. V režimu Bzučák odpovídá vždy moderátor.
- Vyžaduje WebView ≥ Chrome 111: čištění přezdívky (`cleanName` v `game-core.js`) používá `toWellFormed()`, na starším WebView končí každý `join` chybou TypeError a nepřipojí se žádný hráč. Kosmetika: ztlumení přepínače v dialogu používá `:has()` (Chrome 105+), bez něj se přepínač jen nezešedí.

### Protokol hráče

Stejný WebSocket jako ovladač (`/ws?t=<kód>`), verze protokolu `v: 1`, role `player` (ovladač `remote` s klíčem). Hráč smí poslat jen `hello` (role `player`, `clientId`, volitelně `resume`), `join` (`name` 1–16 znaků, `team` 0–3) a `buzz` (`q` index otázky ze snímku). Cokoli jiného televize odmítne (`forbidden`), omezení: 30 zpráv za sekundu na spojení (jinak se spojení zavře s důvodem `rate`). Důvody odmítnutí v `ack`: u `join` `invalid`, `full`, `locked`, `off`; u `buzz` `nojoin`, `closed`, `early`, `locked`, `late`, `off`. Televize hráči posílá jen `welcome`, `ack` (odpověď na `join` a `buzz`), `error` a snímek `state` s poli `rev`, `phase` (`off`, `lobby`, `wait`, `armed`, `answering`, `closed`), `me`, `teams`, `quiz` (jen pořadí otázky), `buzz` (`canBuzz`, `team`, `by`, `mine`, `teamLocked`, `result`). Přezdívky a názvy týmů jsou cizí text a zobrazují se jen jako text. Podrobné rozhraní: hlavičky `game-core.js`, `tv-game.js`, `mobile/player.js`. Zprávu `answer` a snímek režimu odpovědí popisuje následující sekce.

## Odpovědi na mobilu

Volitelný režim hry s hráči: každý hráč vybere na svém mobilu odpověď 1, 2 nebo 3 (v protokolu klíče `a` / `b` / `c`) a rychlá správná odpověď dá týmu víc bodů. Dělá to `answer-core.js` (čistá logika kola, testy `npm run test:tv`), `tv-answers.js` (řadič kola, poslední TV skript) a stránka `mobile/player.*`; `public/` se nemění.

### Volba režimu

V dialogu **Hráči na mobilech** je skupina **Režim hry**: **Bzučák** (výchozí, také pro starší uložené nastavení) nebo **Odpovědi na mobilu**. Volba se pamatuje (`localStorage` `kviz-tv-game-v1`, pole `mode`). Karta na zadání podle režimu mění nadpis („Hrát s mobily – bzučák“ / „Hrát s mobily – odpovědi“). Varování „Bzučák potřebuje aspoň 2 týmy.“ platí jen v režimu Bzučák; odpovědi potřebují aspoň 1 tým. **Změna režimu uprostřed kola kolo restartuje** (rozehrané hlasy se zahodí a kolo se případně otevře znovu podle nového režimu). Změna režimu nemění klíč ovladače ani QR.

### Pravidla kola

- **Otevření:** po zobrazení neodhalené otázky, když hra běží v režimu odpovědí, je aspoň 1 tým a aspoň 1 připojený hráč s týmem. Pruh pod odpovědmi ukáže „Odpovídejte na mobilech“, odpočet **30 s** a „Odpovědělo n z m“.
- **Hlas:** každý hráč smí v kole odpovědět **jednou** (druhý pokus dostane `locked`). Hlas se nedá vzít zpět.
- **Uzavření:** vypršel čas (titulek „Čas vypršel“) nebo odpověděli všichni připojení hráči s týmem („Všichni odpověděli“). Za 1,5 s se správná odpověď **odhalí sama**, pokud není otevřený dialog, menu ani výběr emoji (pak se počká na jejich zavření). **OK moderátora** během kola (i po uzavření) odhalí hned; v kole odpovědí moderátor za tým nevybírá, takže se bod nepřičte dvakrát (platí i s jedním týmem).
- **Odpočet** menu, dialog ani velké zobrazení týmů nezastaví.
- **Zamčený archiv:** archivní kvíz je jen ke čtení, kolo se nevede a hráči otázku nedostanou (jen čekací obrazovku).
- **Změna týmu hráče** je během kola (otevřeném i uzavřeném) zamčená; mimo kolo jde jako dřív.

### Bodování

Odpověď týmu určí **většina hlasů jeho hráčů**; při shodě rozhodne dřívější hlas (podle času příjmu na TV). Správná odpověď dá týmu základ podle obtížnosti (`questionPoints()`, stejný jako u Jednoho týmu) plus bonus za rychlost: `základ + zaokrouhleno(základ × (30 − t) / 30)`, kde `t` jsou celé sekundy od zobrazení otázky mobilu k nejdřívějšímu hlasu pro zvolenou odpověď. Příklad se základem 1: do 15 s 2 body, od 16 s 1 bod; se základem 3: ihned 6, po 10 s 5, po 29 s 3. Špatná odpověď nebo žádný hlas = 0. Body se zapíšou **právě jednou po odhalení** přes `addPoints` jako běžné body týmu (událost `points` v průběhu kvízu), jen při zapnutém **Bod za správnou odpověď automaticky** a když se body počítají; odhalení je událost `reveal`.

**Mobil čas neposílá.** Zpráva `answer` nese jen číslo kola a klíč. Čas měří TV z okamžiku příjmu (`rx`) vůči okamžiku, kdy odeslala snímek s otázkou, takže hodiny mobilů se neporovnávají.

### Co hráč dostane a změněný invariant

V režimu odpovědí hráč dostane text otázky, tři odpovědi a příznak, že otázka má obrázek; **správnou odpověď a výsledek jejího týmu až ve fázi výsledku** (rozložení hlasů protokol sice nese, ale mobil ani TV ho nezobrazují) (po odhalení na TV). Nikdy nedostane vysvětlení, obrázek ani jeho zdroj, obtížnost, téma, volbu moderátora ani hlasy jednotlivců. **Obrázková otázka** se na mobilu ukáže jen s textem a poznámkou „Obrázek je na televizi“. Otázku pro hráče čte jen `tv-link.js` (`players.question()`, tvar určuje `KvizLinkCore.questionView`, text se krátí na 500 a odpověď na 200 znaků); `tv-game.js` dostane hotový filtrovaný objekt a snímek skládá `KvizAnswerCore.viewFor`. Režim Bzučák zůstává beze změny.

### Protokol

Hráč smí navíc poslat `answer` (`round` = číslo kola ze snímku `ask.round`, `key` = `a` / `b` / `c`, `seq`); jiná pole se zahodí. Důvody v `ack`: `nojoin`, `closed` (kolo není otevřené nebo vypršel čas), `late` (jiné kolo), `locked` (už odpověděl), `invalid`, `off` (hra vypnutá, jiný režim, odebraný hráč). `join` s žádostí o jiný tým během kola dostane `locked`. Snímek `state` má v režimu odpovědí navíc `mode: "answers"` a `ask` (`round`, `question`, `answers`, `image`, `limitMs`, `remainingMs`, `mine`, `answered`, `expected`, ve fázi `result` ještě `result` s `correct`, hlasy a výsledek týmu hráče); `phase` je `off`, `lobby`, `wait`, `answer`, `closed` nebo `result`. Verze protokolu zůstává `v: 1`. Na mobilu se souhrn hlasů nezobrazuje (jen správná odpověď, vlastní volba a text týmu), odpočet běží z `remainingMs`.

### Omezení

- **Víc klientů jedné osoby = víc hlasů.** Hráče televize pozná podle `clientId`, který si volí mobil, takže kdo se připojí dvěma mobily (nebo smaže data stránky), hlasuje dvakrát. Model důvěry je stejný jako u bzučáku; tlačítko **Odebrat** existuje.
- Hlasy a kolo se nepamatují po restartu aplikace.
- Vyžaduje WebView ≥ Chrome 111 (stejně jako hra s hráči).

## Kontrolní seznam ručního testu na TV

- [ ] Ovládání TV: tři sbalitelné bloky se dají otevřít šipkami a OK, otevřený je vždy jen jeden.
- [ ] Velikost rozhraní: výchozí (100 %) je čitelná z gauče; v Ovládání TV jde zvětšit / zmenšit a po restartu zůstane.
- [ ] Výběr ikony týmu je celý vidět na obrazovce.
- [ ] Aplikace se spustí na celou obrazovku, okraje nejsou oříznuté, písmo je čitelné z gauče.
- [ ] Menu → Ovládání TV: OK, šipky, Zpět se ukážou; dole stojí „Zpět: funguje“.
- [ ] Nastavení serveru: zadat adresu a token (z mobilu), „Otestovat spojení“ vrátí OK.
- [ ] Zadání: pod polem je „Hrát znovu: <téma>“ s posledním kvízem z archivu (OK → volba nové otázky / jiné pořadí).
- [ ] Zadání: ↓ přejde na bubliny, plutí stojí, OK vloží téma, Zpět vrátí do pole.
- [ ] Vygenerovat kvíz (i s obrázkovými otázkami, obrázek se zobrazí).
- [ ] Otázka: ↑↓ zvýrazní odpověď, OK vybere, OK dál; ← → mezi otázkami.
- [ ] Týmy: číslo vybere tým (rámec je dobře vidět, není oříznutý), kanál ▲/▼ přidá/odebere bod.
- [ ] Výsledky, archiv (A nebo menu), archivní kvíz jen ke čtení, Zpět vrací.
- [ ] Zpět v kvízu se zeptá na opuštění; na úvodní obrazovce na ukončení.
- [ ] Číslo 0 vybere všechny týmy, pod týmy je řádek s vysvětlivkami. Pokud kanálová tlačítka nereagují, zjisti jejich kód v menu → Ovládání TV.
- [ ] Tlačítko v záhlaví (X / menu) a nastavení dole jdou vybrat šipkami; menu jde otevřít i tlačítkem Menu; podržení OK nevyvolá nastavení televize.
- [ ] Zadání: počet otázek a obtížnost zůstanou podle minula (i po restartu aplikace).
- [ ] Před novým kvízem se zeptá „Kolik týmů hraje?“, volba se projeví v liště týmů.
- [ ] Vybraný tým: ↑/↓ mění body (ne odpovědi), OK / Zpět / stejné číslo výběr zruší a ↑/↓ zase vybírají odpovědi.
- [ ] → na neodhalené otázce se zeptá „Přejít dál bez odpovědi?“; po odhalení se neptá.
- [ ] Bez týmů: čísla 1–3 vyberou odpověď; po vyhodnocení OK jde na další otázku a fokus je na neutrálním místě (↓ vybere první odpověď).
- [ ] Zadání: bubliny s tématy vpravo nejsou oříznuté ani po delším čekání.
- [ ] Zvuk: každý stisk ovladače (i Zpět) cvakne, držení tlačítka a psaní na klávesnici ne.
- [ ] Zvuk: správná odpověď zazní jinak než špatná, +bod / −bod, další otázka, výsledky (fanfára); Ovládání TV → Zvuk mění hlasitost a „Vyzkoušet zvuk“ zahraje; vypnuto = ticho, v archivním kvízu je ticho.
- [ ] Jeden tým: správná odpověď přičte body sama, špatná ne.
- [ ] Ovládání TV: u akcí je vidět tlačítko, „Změnit“ přiřadí jiné (např. barevné), nastavení přežije restart aplikace.
- [ ] Nastavení serveru: po Zpět nebo Enter z klávesnice údaje zůstanou vyplněné.
- [ ] Textové pole: šipka na pole klávesnici neukáže, OK ji otevře, Hotovo ji zavře a šipky fungují; u tématu jde ↓ + OK vybrat z našeptávače.
- [ ] Souhrn po dokončení kvízu (zvlášť archivní s průběhem): ↑/↓ posouvá obsah až na konec i zpět.
- [ ] Mobil: karta s QR na zadání je čitelná ze 3 m a nepřekrývá zadání ani bubliny; menu → Ovládání z mobilu otevře dialog s QR a adresou.
- [ ] Mobil: po naskenování QR se stránka připojí, karta QR na zadání zmizí; po zavření stránky (odpojení) se karta vrátí.
- [ ] Mobil: šipky, OK, Zpět a Menu ovládají TV stejně jako ovladač (včetně dotazu „Přejít dál bez odpovědi?“); týmy 1–4 / Vše a plus / minus mění body.
- [ ] Mobil: 1 / 2 / 3 vyberou odpověď v běžícím kvízu; po odhalení, v archivu a při otevřeném menu nereagují.
- [ ] Mobil: psaní tématu na zadání se přepisuje do pole na TV; Hotovo ho potvrdí. V Nastavení serveru se token a basic auth na mobil nezobrazí (jen jdou přepsat) a adresu serveru nejde z mobilu změnit, když je token nebo basic auth vyplněný.
- [ ] Mobil: po odchodu aplikace TV do pozadí a návratu se mobil připojí sám, bez nového skenování.
- [ ] Mobil: „Nový kód“ (s potvrzením) odpojí mobil; starý QR už nefunguje, nový ano.
- [ ] Mobil: dialog Ovládání z mobilu ukáže víc připojených mobilů s odezvou; ovládat jde z libovolného.
- [ ] Mobil: bez Wi-Fi karta QR zmizí a dialog ukáže „Televize není připojená k síti“; po připojení k síti „Zkusit znovu“ QR vrátí.
- [ ] Hráči: na zadání je vidět karta „Hrát s mobily – bzučák“ i při vypnuté hře a tlačítko **Zapnout** jde vybrat šipkami; po zapnutí (karta nebo menu → Hráči na mobilech) se ukáže QR pro hráče a karta nepřekrývá zadání ani bubliny (čitelná ze 3 m).
- [ ] Hráči: zapnutí z karty s připojeným ovladačem se zeptá („Zapnout hru s hráči?“ se jmény ovladačů); bez ovladače se zapne rovnou.
- [ ] Hráči: **Nastavení** na kartě otevře dialog Hráči na mobilech a **Zpět** vrátí fokus na kartu.
- [ ] Hráči: **QR ovladače** na kartě (jen při zapnuté hře) otevře dialog Ovládání z mobilu s varováním pro moderátora, QR ovladače se na kartě nezobrazí a **Zpět** vrátí fokus na tlačítko.
- [ ] Hráči: s 12 hráči ve 4 týmech karta nepřesahuje lištu týmů a zbytek přezdívek je v „a další {n}“.
- [ ] Hráči: s 8 hráči při velikosti rozhraní 1120 px karta nepřesahuje lištu týmů (i bez řádku „a další {n}“).
- [ ] Hráči: tři mobily naskenují QR hráče, zadají přezdívku a tým; objeví se v soupisce i na kartě, odezva se obnovuje.
- [ ] Hráči: dotaz „Zapnout hru s hráči?“ při připojeném ovladači vyjmenuje jména ovladačů; po zapnutí ovladač zůstane připojený a dál funguje.
- [ ] Hráči: stará záložka (adresa) ovladače s původním klíčem je po zapnutí hry odmítnuta; mobil hráče (adresa `player.html`) televizi neovládá.
- [ ] Hráči: dialog Ovládání z mobilu při zapnuté hře ukáže upozornění, že QR ovladače je jen pro moderátora; karta ovladače na zadání se neukazuje.
- [ ] Bzučák: po zobrazení otázky se tlačítka hráčů po 1 s odjistí; stisk dvou mobilů současně vybere jednoho vítěze, pruh „Odpovídá“, zvýrazněná karta týmu a zvuk.
- [ ] Bzučák: stisk před odjištěním dá trest 1,5 s („Moc brzy!“) a po trestu jde znovu bzučet.
- [ ] Bzučák: špatná odpověď při druhém týmu otázku neodhalí, označí odpověď a bzučák se otevře ostatním; správná odpověď přičte bod týmu jednou, s vypnutým automatickým bodem ne.
- [ ] Bzučák: Zpět při bzučení tým uvolní bez odpovědi (zamkne ho); při velkém zobrazení týmů Zpět zavře nejdřív ono.
- [ ] Bzučák: otevřené menu nebo dialog bzučák pozastaví (tlačítka hráčů nereagují), po zavření se odjistí znovu.
- [ ] Hráči: zhasnutí a probuzení mobilu hráče ho vrátí do hry bez nového skenování; restart aplikace na TV během hry hráče vrátí do soupisky sám.
- [ ] Hráči: změna týmů na TV při připojených hráčích (odebrání týmu, jiné pořadí) hráče nenechá v cizím týmu, hráč bez týmu si vybere znovu.
- [ ] Hráči: Odebrat hráče vyžádá potvrzení a hráč se po pokusu o návrat na stránku do hry nedostane (do vypnutí a zapnutí hry).
- [ ] Hráči: archivní kvíz bzučák nemá (tlačítka hráčů nejsou aktivní); s jedním týmem je bzučák vypnutý a bod se přičte jako dřív.
- [ ] Odpovědi: v dialogu Hráči na mobilech je skupina Režim hry (výchozí Bzučák), jde přepnout šipkami a OK a volba přežije restart aplikace; karta na zadání změní nadpis na „Hrát s mobily – odpovědi“.
- [ ] Odpovědi: tři mobily odpovídají 1 / 2 / 3, na TV pod odpověďmi běží pruh s odpočtem 30 s a „Odpovědělo n z m“, na mobilech se odpočet shoduje s TV.
- [ ] Odpovědi: když odpoví všichni, kolo se uzavře („Všichni odpověděli“) a po chvíli se správná odpověď odhalí sama; po vypršení času totéž s „Čas vypršel“.
- [ ] Odpovědi: body týmu odpovídají pravidlům (většina hlasů týmu, základ podle obtížnosti plus bonus za rychlost) a přičtou se právě jednou; špatná odpověď bodů nedá.
- [ ] Odpovědi: OK moderátora během kola odhalí odpověď hned a body se nepřičtou dvakrát, i s jedním týmem.
- [ ] Odpovědi: obrázková otázka je na mobilu jen jako text s poznámkou „Obrázek je na televizi“, na TV je obrázek vidět a pruh s výsledkem pod odpověďmi ho nezakrývá (ani při velkém písmu a 12 hráčích).
- [ ] Odpovědi: po odhalení ukáže mobil správnou odpověď a vlastní volbu na tlačítkách a pod nimi text týmu („Tvůj tým: +n bodů“, když tým zvolil totéž co hráč; „Tvůj tým zvolil 2 · +n bodů“, když jinou odpověď; „Tvůj tým neodpověděl“); odpovědi jsou označené 1 / 2 / 3; po zhasnutí a probuzení mobilu hráč uvidí svou odpověď beze ztráty.
- [ ] Odpovědi: pruh s výsledkem (jen řádky týmů „tým: 2 ✓ +n“ / „✗“, bez souhrnu hlasů; „Nikdo neodpověděl“, když nehlasoval nikdo) a texty jsou čitelné z gauče při výchozí i zvětšené velikosti rozhraní, s 12 hráči ve 4 týmech se vejdou.
- [ ] Odpovědi: změna režimu uprostřed kola kolo restartuje (hlasy se zahodí); druhý mobil téhož hráče hlasuje samostatně, **Odebrat** ho odpojí.
- [ ] Odpovědi: archiv ukáže „Ukázána správná odpověď“ a přičtené body v průběhu; archivní kvíz mobilům otázku neposílá.

## Ladění

`chrome://inspect` v Chrome na počítači (televize přes ADB), WebView aplikace je ladicí cíl. Testy logiky: `npm run test:tv`.

Emulátor: AVD s Android TV rozlišením 1920×1080, hustota 320 dpi, `hw.dPad=yes`, ≥ 4 GB RAM a vypnutý Play Store (jinak systém na software renderu padá do ANR). Klávesy `adb shell input keyevent 20/19/66/4`; WebView nemá po startu nativní fokus, proto jednou klepnout (`input tap` mimo týmy), jinak šipky nedorazí. DOM přes `adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>` a CDP. Stav klávesnice: `adb shell dumpsys input_method | grep mInputShown` (s `settings put secure show_ime_with_hard_keyboard 1`).

## Vazba na `public/app.js`

`android-tv/tv-remote.js`, `tv-keys.js`, `tv-setup.js`, `tv-lobby.js` a `tv-buzz.js` spoléhají na globály `state, addPoints, questionPoints, scoringActive, closeMenu, closeEmojiPicker, closeSuggest, confirmDialog, bubbleTimer, swapBubble` a na ID/třídy prvků popsané v hlavičkách souborů. Při změně těchto věcí v `app.js` zkontrolovat TV vrstvu.

`android-tv/tv-link.js` (most mezi pluginem `KvizLink`, mobilní stránkou a ovládáním TV) navíc spoléhá na globály `state` (`view`, `bigTeams`, `locked`, `teams`, `quiz.questions`, `index`), `currentQ`, `closeMenu`, `confirmDialog` a na prvky `#topic`, `#teams`, `#answers` (`.answer`), `#menuPanel`, `#emojiPicker`, `#main`, `#menuBtn`, `dialog[open]`, `body[data-view]`. Z TV vrstvy potřebuje `KvizTv.store` (`tv-server.js`), `KvizTvCore` (`core.js`), `KvizLinkCore` (`link-core.js`), `KvizTvRemote.handleBack` a `isField` (`tv-remote.js`), `#tvSettingsDialog` s `#tvSettingsForm`, `#menuTvKeys`, `#tvReplay` a globál `qrcode` (`vendor/qrcode.js`). Úplný seznam je v hlavičce souboru, při změně těchto věcí ho zkontrolovat.

`android-tv/tv-buzz.js` obaluje `pick` (podruhé, po obalu z `tv-remote.js`: špatná odpověď při bzučení otázku neodhalí) a čte z `app.js` jen `state` (`view`, `index`, `locked`, `bigTeams`, `quiz`, `teams`), `currentQ` (`revealed`, `picked`, `correct`), `addPoints`, `questionPoints`, `scoringActive` a prvky `#answers` (`.answer` v pořadí a, b, c), `#teams` (karty v pořadí týmů), `#menuPanel`, `#emojiPicker`, `dialog[open]` a `body[data-view]`. `tv-game.js` sleduje `#teams`, `#answers` a `body[data-view]`; `tv-lobby.js` potřebuje `state.teams`, `confirmDialog`, `closeMenu`, `#menuBtn` a `#menuPanel`. Při změně těchto věcí v `app.js` zkontrolovat i je. Zpět při bzučení řeší `tv-remote.js` voláním `KvizTvBuzz.onBack`.

`android-tv/tv-answers.js` (kolo odpovědí, poslední TV skript) obaluje `pick` jako nejvnější, po `tv-buzz.js`: v běžícím kole odpovědí místo výběru zavolá `reveal`. Čte z `app.js` `state` (`view`, `index`, `locked`, `quiz`, `teams`), `currentQ` (`revealed`, `correct`), `reveal`, `addPoints`, `questionPoints`, `scoringActive` a prvky `#answers`, `#menuPanel`, `#emojiPicker`, `dialog[open]` a `body[data-view]`; z TV vrstvy `KvizTvGame`, `KvizAnswerCore` a `KvizTv`. Při změně těchto věcí v `app.js` ho zkontrolovat.
