# TV nadstavba (Android TV)

Skripty a styly, které `npm run android:prepare` vkládá do APK (`www-android/`). Složka `public/` se nemění. Celý popis, sestavení APK a kontrolní seznam jsou v [`docs/ANDROID.md`](../docs/ANDROID.md).

| Soubor | Co dělá |
|---|---|
| `core.js` (`core.test.js`) | čistá logika ovládání, testy `npm run test:tv` |
| `tv-server.js` | nastavení serveru a obrázky |
| `tv-keys.js` | nastavení a překlad vlastních tlačítek ovladače |
| `tv-sound.js` | zvukové odezvy (Web Audio) |
| `tv-remote.js` | ovládání ovladačem a výběr týmu čísly |
| `tv-setup.js` | zadání z minula a dotaz na počet týmů |
| `link-core.js` (`link-core.test.js`) | čistá logika protokolu mobilního ovládání, testy `npm run test:tv` |
| `tv-link.js` | most mezi nativním pluginem `KvizLink`, mobilní stránkou a ovládáním TV: příkazy z mobilu jako klávesy, snímek stavu, dialog a karta s QR |
| `mobile/` | mobilní ovládací stránka (`index.html`, `mobile.css`, `mobile.js`), servíruje ji TV |
| `tv.css` | styly TV vrstvy |
| `prepare.mjs` | kopíruje `public/`, vkládá skripty a knihovnu QR (`vendor/qrcode.js` z `qrcode-generator`) |

Nativní plugin `KvizLink` je v `android/app/src/main/java/cz/croober/kviz/link/`. Postup připojení mobilu, síťové požadavky a ladění: sekce [Ovládání z mobilu](../docs/ANDROID.md#ovládání-z-mobilu).

`tv-config.json` (adresa serveru, token, basic auth) je mimo git, vzor je `tv-config.example.json`.
