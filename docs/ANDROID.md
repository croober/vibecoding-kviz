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
| Zpět | zavře dialog / menu / emoji, v kvízu se zeptá na opuštění, na úvodní obrazovce na ukončení aplikace |
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
3. Naskenuj QR fotoaparátem mobilu. Otevře se stránka ovladače. Adresu jde napsat i ručně, dialog ji ukazuje pod QR spolu s kódem.

Karta QR na zadání se **skryje, jakmile je připojený mobil** (QR s kódem by jinak zůstal na promítané obrazovce), a po odpojení se vrátí. Bez adresy v síti (televize není na Wi-Fi) karta zmizí a dialog ukáže „Televize není připojená k síti“ a tlačítko **Zkusit znovu**. Dialog ukazuje stav (čeká na připojení / připojeno), seznam připojených mobilů s odezvou (u pomalého spojení varování) a tlačítko **Nový kód**.

### Co umí mobilní stránka

- **Ovladač:** šipky, OK, Zpět, Menu (stejné akce jako na ovladači televize).
- **Týmy a body:** tlačítka 1–4 a Vše vybírají týmy, plus / minus mění body vybranému týmu. Tlačítka se řídí počtem týmů na TV (výběr týmů je od dvou týmů, body od jednoho); mimo kvíz jsou skrytá a v archivu, při otevřeném menu nebo dialogu zamčená.
- **Odpověď číslem:** tlačítka A / B / C vyberou odpověď. Fungují jen v běžícím (ne archivním) kvízu, v malém zobrazení týmů, bez otevřeného menu nebo dialogu a na neodhalené otázce; jinak TV odpoví „locked“ a mobil ukáže hlášku.
- **Psaní do aktivního pole:** vybrané pole na TV se objeví na mobilu a text se na TV přepisuje při psaní, **Hotovo** pole potvrdí (změna se uloží jako po Hotovo na klávesnici televize). Na zadání bez vybraného pole se píše do pole s tématem. Pole s heslem (token, basic auth v Nastavení serveru) se maskuje: hodnota z TV na mobil nikdy nejde, na mobilu jde jen přepsat. **Adresu serveru** jde z mobilu měnit jen tehdy, když je token i basic auth prázdný (údaje by jinak mohly odejít na podstrčenou adresu). V archivním kvízu se mimo dialogy nepíše. Délka textu je omezená (500 znaků nebo `maxLength` pole).
- Stav: ukazuje připojení, aktuální obrazovku a zámek archivu. Při výpadku spojení se mobil připojuje sám (a hned po návratu na stránku), spárování si pamatuje v prohlížeči.

### Síť a adresa

- Server běží na TV na portu **8765** (obsazený port nahradí dalším, až 8774), protokol **http**, jen v lokální síti. Adresa: `http://<IP televize>:<port>/m/?t=<kód>`.
- **Kód v adrese** (6 znaků) je jediná ochrana: bez správného kódu se WebSocket nenaváže. Vzniká při prvním spuštění (`localStorage` `kviz-tv-link`) a mění se jen tlačítkem **Nový kód**, které odpojí všechny mobily; ty pak musí naskenovat nový QR. Stránka bez kódu v adrese ukáže výzvu ke skenování QR.
- Server se při odchodu aplikace do pozadí zastaví a po návratu spustí znovu na stejném portu a s týmž kódem, mobily se připojí samy.
- Nejvýš 16 současných spojení. Celé ovládání je hotové jen v APK s pluginem; webová verze (`public/`) o něm neví.
- Ladění: `adb forward tcp:8765 tcp:8765` a v prohlížeči na počítači `http://localhost:8765/m/?t=<kód>` (kód ukáže dialog Ovládání z mobilu). Logika protokolu má testy `npm run test:tv`.

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
- [ ] Mobil: A / B / C vyberou odpověď v běžícím kvízu; po odhalení, v archivu a při otevřeném menu nereagují.
- [ ] Mobil: psaní tématu na zadání se přepisuje do pole na TV; Hotovo ho potvrdí. V Nastavení serveru se token a basic auth na mobil nezobrazí (jen jdou přepsat) a adresu serveru nejde z mobilu změnit, když je token nebo basic auth vyplněný.
- [ ] Mobil: po odchodu aplikace TV do pozadí a návratu se mobil připojí sám, bez nového skenování.
- [ ] Mobil: „Nový kód“ (s potvrzením) odpojí mobil; starý QR už nefunguje, nový ano.
- [ ] Mobil: dialog Ovládání z mobilu ukáže víc připojených mobilů s odezvou; ovládat jde z libovolného.
- [ ] Mobil: bez Wi-Fi karta QR zmizí a dialog ukáže „Televize není připojená k síti“; po připojení k síti „Zkusit znovu“ QR vrátí.

## Ladění

`chrome://inspect` v Chrome na počítači (televize přes ADB), WebView aplikace je ladicí cíl. Testy logiky: `npm run test:tv`.

Emulátor: AVD s Android TV rozlišením 1920×1080, hustota 320 dpi, `hw.dPad=yes`, ≥ 4 GB RAM a vypnutý Play Store (jinak systém na software renderu padá do ANR). Klávesy `adb shell input keyevent 20/19/66/4`; WebView nemá po startu nativní fokus, proto jednou klepnout (`input tap` mimo týmy), jinak šipky nedorazí. DOM přes `adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>` a CDP. Stav klávesnice: `adb shell dumpsys input_method | grep mInputShown` (s `settings put secure show_ime_with_hard_keyboard 1`).

## Vazba na `public/app.js`

`android-tv/tv-remote.js`, `tv-keys.js` a `tv-setup.js` spoléhají na globály `state, addPoints, questionPoints, scoringActive, closeMenu, closeEmojiPicker, closeSuggest, confirmDialog, bubbleTimer, swapBubble` a na ID/třídy prvků popsané v hlavičkách souborů. Při změně těchto věcí v `app.js` zkontrolovat TV vrstvu.

`android-tv/tv-link.js` (most mezi pluginem `KvizLink`, mobilní stránkou a ovládáním TV) navíc spoléhá na globály `state` (`view`, `bigTeams`, `locked`, `teams`, `quiz.questions`, `index`), `currentQ`, `closeMenu`, `confirmDialog` a na prvky `#topic`, `#teams`, `#answers` (`.answer`), `#menuPanel`, `#emojiPicker`, `#main`, `#menuBtn`, `dialog[open]`, `body[data-view]`. Z TV vrstvy potřebuje `KvizTv.store` (`tv-server.js`), `KvizTvCore` (`core.js`), `KvizLinkCore` (`link-core.js`), `KvizTvRemote.handleBack` a `isField` (`tv-remote.js`), `#tvSettingsDialog` s `#tvSettingsForm`, `#menuTvKeys`, `#tvReplay` a globál `qrcode` (`vendor/qrcode.js`). Úplný seznam je v hlavičce souboru, při změně těchto věcí ho zkontrolovat.
