# Backend na Cloudflare Workers

Alternativa k `server.js` (Express): stejné API (`POST /api/generate`) a stejný klient, ale běží na Cloudflare Workers. Worker zároveň servíruje web z `../public`. Kód serveru (`../server.js`) ani web se tím nemění.

- `src/index.js` – Worker: basic auth, kontrola tokenu, volání Claude API, statika (binding `ASSETS`).
- `src/quiz.js` – čistá logika (prompt, schéma, validace, míchání). **Je to kopie částí `../server.js`**; při změně promptu nebo schématu tam je potřeba sjednotit obě místa.
- `src/quiz.test.js` – testy logiky (`npm test`).
- Obrázkové otázky: Worker importuje `../../images.js` ze serveru přímo (`attachImages`, `IMAGE_HOSTS`), bez kopie. Vlastní je jen proxy `GET /api/img` (ta v `images.js` je pro Express).

## Lokální spuštění

```bash
cd worker
npm install
cp .dev.vars.example .dev.vars   # doplň ANTHROPIC_API_KEY a ACCESS_TOKEN (volitelně basic auth)
npm run dev                      # http://127.0.0.1:8787
```

Rychlá kontrola bez volání Claude (má vrátit validační chybu, token prošel; bez tokenu 401):

```bash
curl -XPOST http://127.0.0.1:8787/api/generate -H 'Content-Type: application/json' -H "X-Access-Token: $ACCESS_TOKEN" -d '{}'
```

## Tajné hodnoty

| Proměnná | Význam |
|---|---|
| `ANTHROPIC_API_KEY` | klíč ke Claude API, zůstává jen na serveru |
| `ACCESS_TOKEN` | token pro generování (hlavička `X-Access-Token`); bez něj je generování vypnuté (503) |
| `BASIC_AUTH_USER`, `BASIC_AUTH_PASS` | volitelně: jméno a heslo pro celý web i API (když `BASIC_AUTH_USER` chybí, basic auth není) |
| `CLAUDE_MODEL` | volitelně, výchozí `claude-sonnet-5-5` |

Lokálně v `.dev.vars` (mimo git), v produkci jako secrets ve Wrangleru (`wrangler secret put <NÁZEV>`).

## Nasazení

Kompletní postup (přihlášení, secrets, nasazení, vlastní doména, IP omezení, řešení potíží) je v [`../docs/cloudflare.md`](../docs/cloudflare.md). Nasazení provádí majitel účtu ručně, nic se nedělá automaticky.

**Konfigurace Workeru:** v gitu je jen vzor `wrangler.jsonc.example`. Před prvním nasazením ho zkopíruj na `wrangler.jsonc` (ten je v `.gitignore`) a nahraď zástupnou doménu `kviz.example.cz` svou. Díky tomu se tvoje doména nikdy necommituje ani nepřepíše při `git pull`.

## Omezení na IP adresu

Dělá se v Cloudflare, ne v kódu: v dashboardu u domény *Security → WAF → Custom rules* pravidlo „IP Source Address není v seznamu (domácí IP) → Block“. Domácí IP se může měnit; pak televize dostane odpověď „zakázáno“, dokud pravidlo neaktualizuješ. U IPv6 omezuj podle IPv6 adresy nebo prefixu.

Pozor: pravidla se vážou na zónu (doménu) ve tvém účtu a podle dokumentace Cloudflare se na adresu `*.workers.dev` nevztahují. Pro IP omezení proto dej Worker na vlastní doménu a `workers.dev` vypni (viz `../docs/cloudflare.md`, krok 6).

## Omezení Cloudflare

- Na tarifu Free je limit CPU času 10 ms na požadavek (čekání na síť se nepočítá). Zpracování dlouhé odpovědi z Claude (stream až 64 000 tokenů) ho může překročit; pak je potřeba Workers Paid. **Ověřit se skutečným klíčem na reálném požadavku**, v lokálním testu to změřeno není.
- Limity se mění, aktuální hodnoty jsou v dokumentaci Cloudflare (Workers → Limits).

## Nastavení v Android TV aplikaci

Menu ☰ → *Nastavení serveru*: adresa Workeru (`https://…`), token a případně `uživatel:heslo` pro basic auth. Podrobnosti viz `../android-tv/`.
