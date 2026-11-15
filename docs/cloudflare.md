# Nasazení backendu na Cloudflare Workers

Návod krok za krokem pro `worker/` (backend kvízu). Nic se nenasazuje automaticky, všechny příkazy spouštíš ty.
Postup byl sestaven podle dokumentace Cloudflare (listopad 2026). Názvy položek v dashboardu se mohou mírně lišit, kde jsem si nebyl jistý, je to u kroku poznamenáno.

## Co budeš potřebovat

- Účet na [cloudflare.com](https://dash.cloudflare.com) (stačí Free).
- Node.js 22+ (už máš) a `npm install` ve složce `worker/`.
- Klíč ke Claude API (`sk-ant-…`) z Anthropic Console.
- **Vlastní doménu** přidanou v Cloudflare (zóna), pokud chceš IP omezení (viz krok 6). Bez ní jde Worker nasadit, ale ne omezit podle IP.

## 1. Příprava lokálně

```bash
cd worker
npm install
cp .dev.vars.example .dev.vars   # jen pro lokální zkoušku; doplň vlastní hodnoty
npm test                         # testy logiky
npm run dev                      # http://127.0.0.1:8787
```

Zkoušku s opravdovým klíčem dělej na malém počtu otázek (3).

## 2. Přihlášení do Cloudflare

```bash
npx wrangler login
```

Otevře se prohlížeč, přihlásíš se a povolíš Wrangleru přístup. Ověření: `npx wrangler whoami`.

## 3. Vytvoř si tajné hodnoty

**Přístupový token.** Silný náhodný řetězec (na Windows bez `openssl`):

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Výstup si ulož do správce hesel. Je to `ACCESS_TOKEN`.

**Basic auth (volitelné).** Zvol uživatelské jméno a dlouhé heslo. Chrání celý web i API.

**Limit výdajů u Anthropicu.** V Anthropic Console nastav klíči (nebo workspace) měsíční limit. Je to poslední pojistka, kdyby se cokoli prolomilo.

## 4. Nahraj tajné hodnoty do Cloudflare

Každý příkaz se zeptá na hodnotu (nevkládej ji do příkazu a nikomu ji neposílej):

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put ACCESS_TOKEN
npx wrangler secret put BASIC_AUTH_USER    # volitelné
npx wrangler secret put BASIC_AUTH_PASS    # volitelné
```

Kontrola, že tam jsou (zobrazí jen názvy): `npx wrangler secret list`.
Volitelně `CLAUDE_MODEL` (výchozí `claude-sonnet-5-5`).

Poznámka: pokud Worker ještě neexistuje, `secret put` se zeptá, jestli ho má vytvořit. Můžeš také napřed udělat krok 5.

## 5. Nasazení

Nejdřív zkouška sestavení bez nasazení:

```bash
npx wrangler deploy --dry-run
```

Potom ostré nasazení:

```bash
npx wrangler deploy
```

Při prvním nasazení se Wrangler zeptá na `workers.dev` subdomínu. Worker pak běží na adrese `kviz.<tvoje-subdomena>.workers.dev`. Pokud na první pokus přijde chyba 523, počkej zhruba minutu.

Zkouška (nahraď adresu, token i basic auth):

```bash
curl -u uzivatel:heslo https://kviz.<subdomena>.workers.dev/api/generate -XPOST -H 'Content-Type: application/json' -H "X-Access-Token: TVŮJ_TOKEN" -d '{}'
```

Očekávaná odpověď: `{"error":"Zadej téma kvízu nebo zapni náhodné téma."}`. To znamená, že basic auth i token prošly.
Bez tokenu má přijít `401` s `"code":"token"`, bez basic auth `401` s přihlašovacím oknem.

Pak otevři adresu v prohlížeči (zeptá se na jméno a heslo), vygeneruj kvíz o 3 otázkách a ověř, že funguje.

## 6. Vlastní doména a omezení na domácí IP

**Důležité:** IP pravidla se nastavují ve tvé zóně v Cloudflare. Podle dokumentace se pravidla tvé zóny na adresu `*.workers.dev` nevztahují. Proto je potřeba **Worker dát na vlastní doménu a `workers.dev` vypnout**, jinak by šlo IP omezení obejít přes `workers.dev` adresu.

### 6a. Vlastní doména

Dashboard: *Workers & Pages* → tvůj Worker → *Settings* → *Domains & Routes* → *Add* → *Custom Domain* → zadej host (např. `kviz.example.cz`). Cloudflare vytvoří DNS záznam. Doména musí být aktivní zóna ve tvém účtu a hostname nesmí mít existující CNAME záznam.

Pokud to chceš mít v kódu, odkomentuj a uprav v `worker/wrangler.jsonc`:

```jsonc
"workers_dev": false,
"routes": [{ "pattern": "kviz.example.cz", "custom_domain": true }],
```

a znovu nasaď (`npx wrangler deploy`).

### 6b. Vypnutí workers.dev

Dashboard: Worker → *Settings* → *Domains & Routes* → u `workers.dev` *Disable*. Nebo `"workers_dev": false` v konfiguraci. Pozor: když vypneš jen v dashboardu a konfigurace zůstane beze změny, další nasazení Wranglerem ho zase zapne.

### 6c. WAF pravidlo na IP adresu

Dashboard: tvoje doména → *Security* → *Security rules* → *Create rule* → *Custom rules*.

1. Název: např. `kviz-jen-domaci-ip`.
2. Podmínka: pole **IP Source Address** (`ip.src`), operátor **is not in**, hodnota tvoje veřejná IP (zjistíš na webu typu „what is my IP“).
3. Akce: **Block**.
4. *Deploy*.

V editoru výrazu by to mělo být zhruba `not ip.src in {1.2.3.4}`. Přesné označení položek v dashboardu jsem v dokumentaci neověřil, takže se řiď tím, co ti dashboard nabídne.

Kolik pravidel dovoluje tarif Free, jsem neověřil. Ověř v dokumentaci Cloudflare.

**Pozor na změnu IP:** domácí IP se obvykle mění. Pak televize dostane „zakázáno“ (HTTP 403) a vypadá to jako rozbitá aplikace. Řešení: aktualizuj IP v pravidle. Pokud televize komunikuje přes IPv6, je potřeba zadat IPv6 adresu nebo prefix, ne jen IPv4. Při sdílené IP (CGNAT, mobilní internet) omezení nic neřeší.

Poznámka: Cloudflare má na webech Browser Integrity Check a Bot Fight Mode, které někdy blokují klienty s „neprohlížečovým“ User-Agentem. Pokud televize dostane 403 i z povolené IP, může to být tohle. Zkus v Cloudflare vytvořit pravidlo, které je pro cestu `/api/*` přeskočí. Chování nativního klienta Androidu jsem neověřoval.

### 6d. Ochrana proti hádání hesla (omezení počtu požadavků)

Worker má dva omezovače (`worker/wrangler.jsonc`, sekce `ratelimits`), klíčem je IP adresa klienta:

| Omezovač | Limit | Co chrání |
|---|---|---|
| `AUTH_LIMITER` | 150 požadavků za 60 s | každý požadavek na Worker se počítá před kontrolou hesla, takže hádání basic auth a tokenu zbrzdí na zhruba 150 pokusů za minutu z jedné IP. Limit je vyšší kvůli obrázkovým otázkám: klient při startu kvízu přednačítá všechny obrázky (`/api/img`) najednou |
| `GENERATE_LIMITER` | 10 požadavků za 60 s | generování kvízů (náklady na Claude), počítá se až po ověření tokenu |

Po překročení přijde `429` s `"code":"rate"` a hlavičkou `Retry-After: 60`. Načtení aplikace ani běžné hraní limit nedosáhne.

**Omezení, o kterých musíš vědět:**
- Cloudflare uvádí, že limity jsou přibližné a počítají se zvlášť v každé lokalitě (jejich servery nesdílejí počítadla). Útočník rozložený do více lokalit nebo IP je může obejít. Je to brzda, ne zámek.
- Skutečná obrana je silné heslo a token (token z kroku 3 má 192 bitů, tedy prakticky neuhodnutelný) a IP pravidlo ve WAF (6c).
- Omezovač podle IP může omezit i tebe, pokud sdílíš IP s někým, kdo by hádal. Pro domácí použití není problém.
- Binding vyžaduje Wrangler 4.36 nebo novější (máš novější). Jestli je k dispozici na tarifu Free, jsem v dokumentaci nenašel. Kdyby ho nasazení odmítlo, napiš mi.
- Změna limitů: upravit `limit` a `period` ve `wrangler.jsonc` (perioda jen 10 nebo 60 s) a znovu nasadit.
- Navíc můžeš v dashboardu zapnout vlastní pravidlo rate limiting ve WAF. Jaké limity dovoluje tarif Free, jsem neověřil.

## 7. Zadání v Android TV aplikaci

Menu ☰ → **Nastavení serveru**:

- **Adresa serveru:** `https://kviz.example.cz` (musí začínat `https://`, bez lomítka na konci).
- **Přístupový token:** hodnota `ACCESS_TOKEN`.
- **Basic auth:** `uzivatel:heslo` (jedno pole, dvojtečka mezi jménem a heslem). Prázdné, pokud basic auth nepoužíváš.

Psaní ovladačem je pomalé. Použij mobil: aplikace **Google TV** má na mobilu klávesnici, která posílá text do pole v televizi, a umí i vložit text ze schránky. Zkopíruj si token a heslo v telefonu a vlož je.

Hodnoty se uloží v televizi (`localStorage`). Pokud smažeš data aplikace nebo ji odinstaluješ, bude se zadávat znovu.

## 8. Aktualizace a údržba

- Změna kódu Workeru: znovu `npx wrangler deploy`.
- Změna tajné hodnoty: znovu `npx wrangler secret put <NÁZEV>` (vytvoří a hned nasadí novou verzi).
- Logy v reálném čase: `npx wrangler tail`.
- Při změně promptu nebo schématu ve `server.js` uprav i `worker/src/quiz.js`.
- Při úniku tokenu: vygeneruj nový, nahraj ho (`secret put ACCESS_TOKEN`) a změň ho v televizi.

## 9. Limity a ceny

- **Tarif Free:** limit CPU času je 10 ms na požadavek (čekání na síť se nepočítá) a 100 000 požadavků denně. Zpracování dlouhé odpovědi z Claude může limit CPU překročit. **Ověř na skutečném požadavku s větším počtem otázek.** Pokud narazíš, přejdi na Workers Paid (placený tarif, aktuální cenu najdeš na webu Cloudflare) nebo kontaktuj mě, upravíme volání bez SDK.
- **Obrázkové otázky** přidávají práci: Worker stahuje obrázky z Wikipedie, převádí je na base64 a posílá Claude ke kontrole (vision). To je výrazně náročnější na CPU než čisté generování, takže na tarifu Free je velké riziko překročení limitu CPU. Zkus nejdřív bez obrázků a pak s malým počtem obrázkových otázek. Reálně to ve Workeru zatím vyzkoušené není (potřebuje klíč).
- Doba trvání požadavku limitovaná není, dokud je klient připojený.
- Aktuální hodnoty limitů: dokumentace Cloudflare, *Workers → Platform → Limits*.

## 10. Řešení potíží

| Příznak | Pravděpodobná příčina |
|---|---|
| `401` s přihlašovacím oknem | chybí nebo je špatný basic auth |
| `401` s `"code":"token"` | chybí nebo je špatný přístupový token |
| `403` | IP pravidlo ve WAF (změnila se IP?), nebo Browser Integrity Check |
| `503` „chybí ACCESS_TOKEN“ | nenahraný secret `ACCESS_TOKEN` |
| `500` „neplatný ANTHROPIC_API_KEY“ | klíč chybí, je špatný nebo zrušený |
| `429` s `"code":"rate"` | omezení počtu požadavků z jedné IP (viz kapitola o ochraně proti hádání hesla), počkej minutu |
| `429` bez `code` | limit API u Anthropicu |
| `502` | chyba na straně Claude API, nebo odpověď byla příliš dlouhá (méně otázek) |
| chyba 1101 / 1102 | Worker spadl nebo překročil limit zdrojů (zkus `wrangler tail`, případně Workers Paid) |
| Televize hlásí, že není adresa serveru | nevyplněné *Nastavení serveru* |
| Televize: chyba při generování, v prohlížeči to jde | basic auth nebo token v televizi, nebo HTTP adresa místo HTTPS |
