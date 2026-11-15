// TV nadstavba, část mobilního ovládání: napojí nativní plugin KvizLink (WebSocket server na TV) na obsluhu kláves.
// Příkaz z mobilu se nepřekládá na volání funkcí, ale na událost klávesy s příznakem tvLink, kterou zpracuje stávající kód
// (stejná navigace, zvuky i potvrzovací dotazy jako z ovladače). Vkládá se jen do APK (android-tv/prepare.mjs) jako poslední TV skript.
// Rozhraní: kontrakt mobilního ovládání § 1 (plugin), § 2 (protokol), § 3 (snímek), § 4 (úložiště);
// role, klíč ovladače a směrování zpráv: kontrakt hráčů (.claude-work/2026-11-15-hraci-buzzer/kontrakt.md) § 1, § 2, § 5.
//
// Bezpečnost (kontrakt hráčů § 1 a § 5):
//   - Role remote (ovladač) se přihlásí jen s klíčem ovladače settings.remoteKey (12 znaků, je jen v QR kódu,
//     nikdy v konzoli); role player (hráč) smí jen join a buzz. O roli rozhoduje
//     KvizLinkCore.allowedFor před každou cestou k onKey a onText.
//   - Na plátně je klíč jen uvnitř QR kódu (dialog i karta na zadání). Textová adresa s klíčem se ukáže jen v dialogu,
//     když se QR nepodařilo vykreslit (otevírá ho moderátor vědomě); karta na zadání se bez QR neukáže vůbec.
//   - Výměna klíče: rotateRemoteKey() vytvoří nový klíč a pošle ho zprávou rekey jen připojeným ovladačům
//     (už se klíčem prokázaly), ty zůstávají připojené; staré QR a odkazy přestanou platit. „Nový kód“
//     (restart s newToken) mění token i klíč a všechny odpojí, rekey se tam neposílá.
//   - Každé spojení má omezovač zpráv (RATE_MAX_MESSAGES za RATE_WINDOW_MS, čas z performance.now());
//     po překročení, odmítnutém klíči nebo rehello se spojení označí k zavření a jeho další zprávy se zahodí.
//   - Snímek stavu ovladače (snapshot) dostávají jen ovladače; seznam zařízení a karta s QR počítají jen ovladače.
//   - Rozhraní KvizTvLink.players (pro tv-game.js): identita hráče se bere jen z registru podle spojení, zpráva jde
//     vždy jednomu hráči (hromadné odeslání hráčům neexistuje) a players.context() skládá podklad snímku
//     z vyjmenovaných polí – z otázky jen příznak revealed, z týmu jen name, emoji, color (žádné body).
//
// Spoléhá na věci z app.js (při jejich změně zkontrolovat tenhle soubor):
//   globály: state (view, bigTeams, locked, teams[name, emoji, color], quiz.questions, index), currentQ (jen .revealed)
//   prvky:   #topic (cíl textu na zadání, našeptávač na událost input), #teams a #answers (děti se překreslují),
//            #answers .answer, #menuPanel, #emojiPicker, dialog[open], body[data-view],
//            název týmu se ukládá na change, pole v Nastavení serveru (tv-server.js) na input i change,
//            #main (karta s QR jako první dítě), #menuBtn, #menuPanel .menu-box, globály closeMenu a confirmDialog
// a na TV vrstvu: #tvSettingsDialog a #tvSettingsForm > p.extra-hint (tv-server.js), #menuTvKeys (tv-keys.js),
//   #tvReplay (tv-remote.js), globál qrcode (vendor/qrcode.js, qrcode-generator: qrcode(0, "M"), addData, make,
//   getModuleCount, isDark); KvizTv.store (tv-server.js), KvizTvCore (core.js), KvizLinkCore (link-core.js, načtený po core.js),
//   KvizTvRemote.handleBack a isField (tv-remote.js), volitelně KvizTvSound.play (tv-sound.js); Capacitor.Plugins.KvizLink.
//   Citlivá pole tvToken a tvBasicAuth (tv-server.js) se maskují i po přepnutí na „Zobrazit“ (SECRET_FIELD_IDS);
//   tvServerUrl jde z mobilu přepsat jen při prázdném tokenu i basic auth (údaje by jinak šly na podstrčenou adresu).
(() => {
  "use strict";
  const plugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.KvizLink;
  if (!window.KvizTv || !plugin) return; // jen v APK s pluginem; webová verze skončí tiše
  const Link = window.KvizLinkCore;
  // bez core.js (nebo s link-core.js načteným před ním) zná link-core jen 4 akce a klávesy by tiše nic nedělaly
  if (!window.KvizTvCore || !Link || Link.REMOTE_ACTIONS.indexOf("ok") < 0) {
    console.warn("tv-link: chybí KvizTvCore nebo KvizLinkCore (pořadí skriptů v prepare.mjs), mobilní ovládání vypnuto");
    return;
  }
  if (!window.KvizTvRemote) {
    console.warn("tv-link: chybí KvizTvRemote (tv-remote.js), mobilní ovládání vypnuto");
    return;
  }

  const $ = (id) => document.getElementById(id);
  const appState = () => (typeof state !== "undefined" ? state : {});
  const store = window.KvizTv.store;
  const STORE_KEY = "kviz-tv-link";
  const DEFAULT_PORT = 8765;
  const HELLO_TIMEOUT_MS = 5000;
  const STATE_DELAY_MS = 50;
  const RATE_MAX_MESSAGES = 30; // omezovač zpráv jednoho spojení (kontrakt hráčů § 3)
  const RATE_WINDOW_MS = 1000;
  // Token a basic auth serveru kvízu: hodnota nesmí na mobil ani tehdy, když je pole přepnuté na čitelný text.
  const SECRET_FIELD_IDS = ["tvToken", "tvBasicAuth"];

  /* ---------- Nastavení: token, port a klíč ovladače (kontrakt § 4, kontrakt hráčů § 1) ---------- */
  // Kratší, delší nebo s cizími znaky by šel klíč snáz uhodnout (nebo by neprošel registrem), proto se nahradí novým.
  function isValidRemoteKey(key) {
    return typeof key === "string" && key.length === Link.REMOTE_KEY_LENGTH
      && Array.from(key).every((ch) => Link.TOKEN_ALPHABET.includes(ch));
  }

  function loadSettings() {
    let saved = {};
    try { saved = JSON.parse(store.get(STORE_KEY)) || {}; } catch { saved = {}; }
    return {
      token: typeof saved.token === "string" && saved.token ? saved.token : Link.newToken(),
      port: Number.isSafeInteger(saved.port) ? saved.port : DEFAULT_PORT,
      remoteKey: isValidRemoteKey(saved.remoteKey) ? saved.remoteKey : Link.newRemoteKey(),
    };
  }
  const settings = loadSettings();
  const saveSettings = () => store.set(STORE_KEY, JSON.stringify(settings));
  saveSettings(); // nově vytvořený token a klíč se uloží hned

  /* ---------- Stav serveru a posluchači ---------- */
  let server = { running: false, port: settings.port, addresses: [], error: null };
  const listeners = [];
  function changed() {
    listeners.forEach((cb) => {
      try { cb(); } catch (err) { console.warn("tv-link: chyba posluchače", err); }
    });
  }
  function applyServer(s) {
    server = {
      running: !!s.running,
      port: Number.isSafeInteger(s.port) ? s.port : server.port,
      addresses: Array.isArray(s.addresses) ? s.addresses : [],
      error: null,
    };
    if (server.running && server.port !== settings.port) { settings.port = server.port; saveSettings(); }
    changed();
  }

  function start() {
    return plugin.start({ port: settings.port, token: settings.token })
      .then(applyServer)
      .catch((err) => {
        console.warn("tv-link: server se nespustil", err && err.code, err);
        server = { running: false, port: settings.port, addresses: [], error: (err && err.code) || "failed" };
        changed();
      });
  }

  /* ---------- Odesílání ---------- */
  const clients = Link.createClients();
  const helloTimers = {}; // connId -> časovač spojení, které ještě neposlalo hello
  const limiters = {};    // connId -> omezovač zpráv spojení
  const closing = new Set(); // spojení, která TV zavírá: jejich další zprávy se zahodí
  // Nedávno skončená spojení: pozdní zpráva po události close se zahodí a nezaloží neuklizený omezovač.
  // Pozdní zprávy chodí hned po close, proto stačí omezená paměť (nejstarší se zapomíná).
  const recentlyClosed = new Set();
  const RECENTLY_CLOSED_MAX = 64;

  function rememberClosed(connId) {
    recentlyClosed.add(connId);
    if (recentlyClosed.size > RECENTLY_CLOSED_MAX) recentlyClosed.delete(recentlyClosed.values().next().value);
  }

  function send(connId, msg) {
    const data = JSON.stringify(Object.assign({ v: Link.PROTOCOL }, msg));
    return plugin.send({ id: connId, data }).catch((err) => console.warn("tv-link: odeslání selhalo", connId, err && err.code));
  }
  function closeConn(connId, reason) {
    closing.add(connId);
    return plugin.close({ id: connId, reason }).catch(() => {});
  }
  // Chyba a potom zavření; spojení se označí hned, aby se zprávy přijaté mezitím už nezpracovaly.
  // Když mezitím přišla událost close (záznam v closing je pryč), nezavírá se znovu – záznam by v closing zůstal.
  function refuse(connId, code) {
    closing.add(connId);
    send(connId, { t: "error", code }).then(() => {
      if (closing.has(connId)) closeConn(connId, code);
    });
  }
  const ack = (connId, seq, ok, reason) => send(connId, reason ? { t: "ack", seq, ok, reason } : { t: "ack", seq, ok });
  const newLimiter = () => Link.createRateLimiter(RATE_MAX_MESSAGES, RATE_WINDOW_MS);

  function clearHelloTimer(connId) {
    clearTimeout(helloTimers[connId]);
    delete helloTimers[connId];
  }

  /* ---------- Snímek stavu (kontrakt § 3) ---------- */
  let rev = 0;            // roste s každým odeslaným snímkem (welcome i state)
  let lastState = null;   // poslední stav, který mají všechny připojené mobily (bez rev)
  let stateTimer = null;

  function overlayNow() {
    if (document.querySelector("dialog[open]")) return "dialog";
    if (!$("menuPanel").hidden) return "menu";
    if (!$("emojiPicker").hidden) return "emoji";
    return null;
  }

  const isSecretField = (n) => n.type === "password" || SECRET_FIELD_IDS.includes(n.id);

  // aria-label má přednost: <label for="topic"> nese i nápovědu „· více témat odděl čárkou“, aria-label je „Téma kvízu“.
  function labelOf(n) {
    const aria = n.getAttribute("aria-label");
    if (aria) return aria;
    const label = n.labels && n.labels[0];
    const text = label ? label.textContent.replace(/\s+/g, " ").trim() : "";
    return text || n.placeholder || "Text";
  }

  // Vstup pro KvizLinkCore.fieldView: hodnota citlivého pole se ani nepřečte.
  function activeField() {
    const n = document.activeElement;
    if (!window.KvizTvRemote.isField(n)) return null;
    const secret = isSecretField(n);
    const label = labelOf(n);
    return {
      key: n.id || n.name || label, // název týmu nemá id ani name, popisek „Název týmu N“ je jedinečný
      label,
      type: secret ? "password" : n.type,
      value: secret ? "" : n.value,
      maxLength: n.maxLength,
    };
  }

  // Snímek pro mobil; bez `withRev` je jen pro porovnání (sameState rev nebere v úvahu).
  function snapshot(withRev) {
    const s = appState();
    const q = typeof currentQ === "function" ? currentQ() : null;
    const quiz = s.quiz && Array.isArray(s.quiz.questions)
      ? { index: s.index, total: s.quiz.questions.length, revealed: !!(q && q.revealed) }
      : null;
    return Link.stateView("remote", {
      rev: withRev,
      view: s.view,
      locked: !!s.locked,
      overlay: overlayNow(),
      teamCount: Array.isArray(s.teams) ? s.teams.length : 0,
      quiz,
      field: activeField(),
    });
  }

  // Jediná cesta rozeslání snímku: jen ovladačům po hello, jen když se stav změnil. Hráč snímek ovladače nedostane nikdy.
  function sendState() {
    stateTimer = null;
    const next = snapshot();
    if (Link.sameState(next, lastState)) return;
    lastState = next; // i bez připojených mobilů: nový mobil dostane aktuální stav ve welcome
    const targets = clients.list().filter((c) => c.connected && c.role === "remote");
    if (!targets.length) return;
    rev += 1;
    const msg = Object.assign({ t: "state" }, next, { rev });
    targets.forEach((c) => send(c.connId, msg));
  }
  function scheduleState() {
    if (!stateTimer) stateTimer = setTimeout(sendState, STATE_DELAY_MS);
  }

  // keyup zachytí změny hodnoty bez události input (výběr návrhu tématu v app.js pickSuggest).
  function watchState() {
    ["focusin", "focusout", "input", "keyup"].forEach((type) => document.addEventListener(type, scheduleState, true));
    const observer = new MutationObserver(scheduleState);
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-view", "open"] });
    const watch = (id, options) => {
      const node = $(id);
      if (node) observer.observe(node, options);
      else console.warn("tv-link: chybí prvek #" + id + ", jeho změny se mobilu nehlásí");
    };
    ["menuPanel", "emojiPicker"].forEach((id) => watch(id, { attributes: true, attributeFilter: ["hidden"] }));
    ["teams", "answers"].forEach((id) => watch(id, { childList: true }));
  }

  /* ---------- Příkazy z mobilu ---------- */
  // V běžícím kvízu patří ← → a OK z mobilu otázkám: když fokus uvízl na tlačítku v záhlaví (křížek, menu),
  // vrátí se na kotvu, ať se klávesa nezmění v prostorový pohyb po záhlaví nebo v zavření kvízu.
  function parkHeaderFocus(init) {
    if (!["ArrowLeft", "ArrowRight", "Enter"].includes(init.key)) return;
    const s = appState();
    const active = document.activeElement;
    if (s.view !== "quiz" || s.bigTeams || overlayNow() || !active || !active.closest(".topbar-actions")) return;
    const anchor = $("tvAnchor");
    if (anchor) anchor.focus({ preventScroll: true });
  }

  function dispatchKey(init) {
    parkHeaderFocus(init);
    const ev = new KeyboardEvent("keydown", init);
    ev.tvLink = true; // bez tvSynthetic a tvMapped: obslouží ho tv-remote.js i zvuk stisku v tv-sound.js
    (document.activeElement || document.body).dispatchEvent(ev);
  }

  // Odpověď číslem: jen v běžícím (nearchivním) kvízu v malém zobrazení týmů, bez překryvu, na neodhalené otázce.
  function answerButton(n) {
    const s = appState();
    if (s.view !== "quiz" || s.bigTeams || s.locked || overlayNow()) return null;
    const q = typeof currentQ === "function" ? currentQ() : null;
    if (!q || q.revealed) return null;
    const btn = $("answers").querySelectorAll(".answer")[n - 1];
    return btn && !btn.disabled ? btn : null;
  }

  function onKey(connId, msg) {
    if (!clients.accept(connId, msg.seq)) return ack(connId, msg.seq, false, "duplicate");
    const cmd = Link.commandOf(msg.action);
    if (!cmd) return ack(connId, msg.seq, false, "invalid");
    if (cmd.kind === "key") dispatchKey(cmd.init);
    else if (cmd.kind === "back") {
      window.KvizTvRemote.handleBack();
      if (window.KvizTvSound) window.KvizTvSound.play("click");
    } else if (cmd.kind === "answer") {
      const btn = answerButton(cmd.n);
      if (!btn) return ack(connId, msg.seq, false, "locked");
      btn.click();
    }
    scheduleState(); // klávesa z mobilu nemá keyup, výběr návrhu tématu by se jinak mobilu neohlásil
    return ack(connId, msg.seq, true);
  }

  // Pole pro text z mobilu: právě aktivní pole TV, jinak na zadání bez překryvu pole tématu.
  function textTarget() {
    const active = document.activeElement;
    if (window.KvizTvRemote.isField(active)) return active;
    if (appState().view !== "setup" || overlayNow()) return null;
    const topic = $("topic");
    if (!topic || topic.disabled) return null;
    topic.focus();
    return topic;
  }

  // Adresu serveru jde z mobilu měnit jen při prázdném tokenu i basic auth: draft se ukládá hned
  // a „Otestovat spojení“ by uložené přihlašovací údaje poslal na adresu podstrčenou z mobilu.
  // Zjišťuje se jen prázdnost, hodnota tajných polí se nikam nepředává.
  function serverUrlGuarded(n) {
    if (n.id !== "tvServerUrl") return false;
    return SECRET_FIELD_IDS.some((id) => { const f = $(id); return !!f && f.value !== ""; });
  }

  // Text z mobilu je nedůvěryhodný: jen do .value, jednořádkové pole bez nových řádků, číslo jen číslice, oříznout na maxLength.
  function cleanText(n, value) {
    let text = n.tagName === "TEXTAREA" ? value : value.replace(/\r\n?|\n/g, " ");
    if (n.type === "number") text = text.replace(/\D/g, "");
    return n.maxLength > 0 ? text.slice(0, n.maxLength) : text;
  }

  function onText(connId, msg) {
    if (!clients.accept(connId, msg.seq)) return ack(connId, msg.seq, false, "duplicate");
    const n = textTarget();
    if (!n || n.disabled) return ack(connId, msg.seq, false, "nofield");
    if (appState().locked && !n.closest("dialog")) return ack(connId, msg.seq, false, "locked");
    if (serverUrlGuarded(n)) return ack(connId, msg.seq, false, "locked");
    n.value = cleanText(n, msg.value);
    n.dispatchEvent(new Event("input", { bubbles: true }));
    if (msg.done) {
      n.dispatchEvent(new Event("change", { bubbles: true }));
      window.KvizTvRemote.confirmField(n); // potvrzení pole jako Enter ovladače
    }
    return ack(connId, msg.seq, true);
  }

  /* ---------- Hráči: posluchači herní vrstvy (kontrakt hráčů § 5) ---------- */
  // Po jednom posluchači, žádný seznam: herní vrstva je jen jedna (tv-game.js).
  let playerMessageCb = null;    // (clientId, msg, rx) -> { ok, reason? }
  let playerConnectionCb = null; // (clientId, connected)
  let playerViewFn = null;       // (clientId) -> snímek hráče

  // Výjimka v herní vrstvě nesmí zastavit příjem zpráv; do konzole jen druh chyby, nic ze zprávy.
  function callSafely(fn, args, what) {
    try {
      return { ok: true, value: fn(...args) };
    } catch (err) {
      console.warn("tv-link: chyba " + what, err && err.name);
      return { ok: false };
    }
  }

  function notifyConnection(clientId, connected) {
    if (playerConnectionCb) callSafely(playerConnectionCb, [clientId, connected], "posluchače spojení hráčů");
  }

  // Snímek pro welcome hráče; bez funkce, při výjimce nebo neplatném výsledku fáze „vypnuto“.
  function playerWelcomeState(clientId) {
    const res = playerViewFn ? callSafely(playerViewFn, [clientId], "funkce snímku hráče") : { ok: false };
    const view = res.ok ? res.value : null;
    return view && typeof view === "object" && !Array.isArray(view) ? view : { rev: ++rev, phase: "off" };
  }

  // join a buzz: clientId jen z registru podle spojení, nikdy ze zprávy; ack z návratové hodnoty posluchače.
  function onPlayerMessage(connId, msg, rx) {
    if (!clients.accept(connId, msg.seq)) return ack(connId, msg.seq, false, "duplicate");
    const client = clients.byConn(connId);
    const res = playerMessageCb ? callSafely(playerMessageCb, [client.clientId, msg, rx], "posluchače zpráv hráčů") : { ok: false };
    const out = res.ok ? res.value : null;
    if (!out || typeof out.ok !== "boolean") return ack(connId, msg.seq, false, "off");
    if (!out.ok) return ack(connId, msg.seq, false, typeof out.reason === "string" ? out.reason : "off");
    if (msg.t === "join") clients.pin(connId); // zapsaný hráč se při plném registru uvolňuje až po nezapsaných
    return ack(connId, msg.seq, true);
  }

  function onHello(connId, msg) {
    clearHelloTimer(connId);
    const res = clients.hello(connId, msg, { remoteKey: settings.remoteKey });
    if (!res.ok) {
      if (res.code === "rehello") closeConn(connId, "rehello");
      else if (res.code === "forbidden" || res.code === "full") refuse(connId, res.code);
      else send(connId, { t: "error", code: res.code });
      return;
    }
    if (res.replaced !== undefined) closeConn(res.replaced, "replaced");
    const c = res.client;
    // Snímek ovladače jen ovladači; hráč dostane snímek z herní vrstvy (players.setView).
    const state = c.role === "remote" ? snapshot(++rev) : playerWelcomeState(c.clientId);
    send(connId, { t: "welcome", clientId: c.clientId, resume: c.resume, role: c.role, state });
    // Nahrazené staré spojení se při svém close už nehlásí (registr ho od spojení odvázal), hlásí se jen připojení.
    if (c.role === "player") notifyConnection(c.clientId, true);
    changed();
  }

  // Pořadí kroků je závazné (kontrakt hráčů § 5, Pravidla směrování v onMessage).
  function onMessage(e) {
    const connId = e.id;
    if (closing.has(connId) || recentlyClosed.has(connId)) return;
    if (!limiters[connId]) limiters[connId] = newLimiter(); // zpráva dřív než událost open
    if (!limiters[connId].allow(performance.now())) return closeConn(connId, "rate");
    const parsed = Link.parseMessage(e.data);
    if (!parsed.ok) return send(connId, { t: "error", code: parsed.code });
    const msg = parsed.msg;
    if (msg.t === "hello") return onHello(connId, msg);
    const client = clients.byConn(connId);
    if (!client) return send(connId, { t: "error", code: "hello_required" });
    if (!Link.allowedFor(client.role, msg.t)) return send(connId, { t: "error", code: "forbidden" });
    if (msg.t === "key") return onKey(connId, msg);
    if (msg.t === "text") return onText(connId, msg);
    if (msg.t === "join" || msg.t === "buzz") return onPlayerMessage(connId, msg, e.rx);
  }

  /* ---------- Události pluginu ---------- */
  plugin.addListener("open", (e) => {
    limiters[e.id] = newLimiter();
    helloTimers[e.id] = setTimeout(() => {
      delete helloTimers[e.id];
      if (!clients.byConn(e.id)) closeConn(e.id, "hello_timeout");
    }, HELLO_TIMEOUT_MS);
  });
  plugin.addListener("message", onMessage);
  plugin.addListener("close", (e) => {
    clearHelloTimer(e.id);
    delete limiters[e.id];
    closing.delete(e.id);
    rememberClosed(e.id);
    const dropped = clients.drop(e.id);
    if (!dropped) return;
    if (dropped.role === "player") notifyConnection(dropped.clientId, false);
    changed();
  });
  plugin.addListener("rtt", (e) => {
    const c = clients.byConn(e.id);
    if (c) c.rttMs = e.ms;
  });
  plugin.addListener("state", applyServer); // obnova po pauze aktivity

  /* ---------- Rozhraní pro dialog s QR (faze-4-list-4) ---------- */
  // Adresa ovladače v síti; s klíčem jen pro QR kód, bez klíče pro text na plátně.
  function remoteUrl(remoteKey) {
    const ip = Link.pickAddress(server.addresses);
    return server.running && ip ? Link.buildUrl(ip, server.port, settings.token, remoteKey) : null;
  }
  // Adresa pro hráče: jen kód místnosti, klíč ovladače buildPlayerUrl nepřijímá.
  function playerUrl() {
    const ip = Link.pickAddress(server.addresses);
    return server.running && ip ? Link.buildPlayerUrl(ip, server.port, settings.token) : null;
  }
  function info() {
    return {
      running: server.running,
      port: server.port,
      addresses: server.addresses.slice(),
      error: server.error,
      token: settings.token,
      url: remoteUrl(settings.remoteKey), // s klíčem ovladače: jen do QR kódu (textem jen v dialogu bez QR)
      displayUrl: remoteUrl(), // bez klíče
      playerUrl: playerUrl(),
    };
  }
  // Seznam ovladačů bez tajemství resume (hráči se tu nepočítají).
  const clientList = () => clients.list().filter((c) => c.role === "remote").map((c) => ({
    clientId: c.clientId, name: c.name, connected: c.connected,
    rttMs: c.connected && c.rttMs !== undefined ? c.rttMs : null, // po odpojení se staré měření neukazuje
  }));
  // „Nový kód“ mění token i klíč ovladače: staré odkazy a QR přestanou platit.
  function restart(options) {
    if (options && options.newToken) {
      settings.token = Link.newToken();
      settings.remoteKey = Link.newRemoteKey();
      saveSettings();
    }
    return start();
  }
  // Nový klíč ovladače bez odpojení: dostanou ho jen připojené ovladače, nikdy hráči ani hromadným odesláním.
  function rotateRemoteKey() {
    settings.remoteKey = Link.newRemoteKey();
    saveSettings();
    const msg = { t: "rekey", remoteKey: settings.remoteKey };
    clients.list().filter((c) => c.role === "remote" && c.connected).forEach((c) => send(c.connId, msg));
    changed(); // překreslí QR v dialogu i na kartě
  }
  function onChange(cb) {
    if (typeof cb === "function") listeners.push(cb);
  }

  // Hra s hráči: karta ovladače se na zadání neukazuje (klíč se tím nemění).
  let playerMode = false;
  function setPlayerMode(on) {
    playerMode = on === true;
    renderCard();
  }

  /* ---------- Rozhraní pro hráče (kontrakt hráčů § 5) ---------- */
  const VIEWS = ["setup", "loading", "quiz", "results", "archive"];
  const CONTEXT_TEAMS_MAX = 4;
  const asText = (v) => (v === undefined || v === null ? "" : String(v));
  const countOrZero = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : 0);

  // Připojený hráč podle clientId; ovladač, neznámý i odpojený klient = null.
  function connectedPlayer(clientId) {
    return clients.list().find((c) => c.clientId === clientId && c.role === "player" && c.connected) || null;
  }

  // Podklad pro KvizGameCore.viewFor: každé pole se skládá výslovně, nic ze stavu se nepředává celé.
  function playerContext() {
    const s = appState();
    const view = VIEWS.includes(s.view) ? s.view : "setup";
    const hasQuiz = !!s.quiz && Array.isArray(s.quiz.questions);
    const q = hasQuiz && typeof currentQ === "function" ? currentQ() : null;
    return {
      view,
      locked: s.locked === true || view === "archive",
      teams: Array.isArray(s.teams)
        ? s.teams.slice(0, CONTEXT_TEAMS_MAX).map((t) => ({
          name: asText(t && t.name), emoji: asText(t && t.emoji), color: asText(t && t.color),
        }))
        : [],
      index: countOrZero(s.index),
      total: hasQuiz ? s.quiz.questions.length : 0,
      revealed: !!q && q.revealed === true, // z otázky jen tento příznak
    };
  }

  const players = {
    onMessage(cb) { playerMessageCb = typeof cb === "function" ? cb : null; },
    onConnection(cb) { playerConnectionCb = typeof cb === "function" ? cb : null; },
    setView(fn) { playerViewFn = typeof fn === "function" ? fn : null; },
    // Vždy jednomu hráči přes jeho spojení.
    send(clientId, msg) {
      const c = connectedPlayer(clientId);
      if (!c || !msg || typeof msg !== "object") return false;
      send(c.connId, msg);
      return true;
    },
    close(clientId, reason) {
      const c = connectedPlayer(clientId);
      if (!c) return false;
      closeConn(c.connId, reason);
      return true;
    },
    // Bez resume a connId; odezva jen u připojeného hráče.
    list() {
      return clients.list().filter((c) => c.role === "player").map((c) => ({
        clientId: c.clientId, connected: c.connected,
        rttMs: c.connected && c.rttMs !== undefined ? c.rttMs : null,
      }));
    },
    context: playerContext,
  };

  window.KvizTvLink = { info, clients: clientList, restart, rotateRemoteKey, onChange, qrSvg, setPlayerMode, players };

  /* ---------- QR kód (globál qrcode z vendor/qrcode.js, balíček qrcode-generator) ---------- */
  const SVG_NS = "http://www.w3.org/2000/svg";
  const QR_MARGIN = 4; // tichá zóna v modulech, je součástí SVG

  // SVG s tmavými moduly na bílém poli; bez knihovny (nebo při chybě kódování) null.
  function qrSvg(url, label) {
    if (typeof window.qrcode !== "function" || !url) return null;
    let qr;
    try {
      qr = window.qrcode(0, "M");
      qr.addData(url);
      qr.make();
    } catch (err) {
      console.warn("tv-link: QR kód se nepodařilo vytvořit", err);
      return null;
    }
    const n = qr.getModuleCount();
    const size = n + QR_MARGIN * 2;
    let d = "";
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + QR_MARGIN} ${r + QR_MARGIN}h1v1h-1z`;
    }
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
    svg.setAttribute("focusable", "false");
    const bg = document.createElementNS(SVG_NS, "rect");
    bg.setAttribute("width", size);
    bg.setAttribute("height", size);
    bg.setAttribute("fill", "#fff");
    const modules = document.createElementNS(SVG_NS, "path");
    modules.setAttribute("d", d);
    modules.setAttribute("fill", "#000");
    svg.append(bg, modules);
    return svg;
  }

  // Adresa se zvýrazněným tokenem za „t=“ a zbytkem adresy za ním (vše přes textContent).
  function fillUrl(node, url, token) {
    node.textContent = "";
    const at = url.indexOf("t=" + token);
    if (at < 0) { node.textContent = url; return; }
    const cut = at + 2;
    const b = document.createElement("b");
    b.textContent = token;
    node.append(url.slice(0, cut), b, url.slice(cut + token.length));
  }

  // připravuji (server zatím nic nevrátil) · ready (je adresa) · offline (chyba nebo žádná adresa v síti)
  function linkKind(i) {
    if (i.url) return "ready";
    return !i.running && !i.error ? "preparing" : "offline";
  }

  /* ---------- Dialog „Ovládání z mobilu“ ---------- */
  const QR_LABEL = "QR kód s adresou ovladače pro mobil";
  const MAX_DEVICE_ROWS = 6;
  const SLOW_RTT_MS = 300;
  const RTT_REFRESH_MS = 2000; // událost rtt nevolá onChange, odezvy se v otevřeném dialogu obnovují samy

  const dlg = document.createElement("dialog");
  dlg.id = "tvLinkDialog";
  dlg.className = "dialog help";
  dlg.setAttribute("aria-labelledby", "tvLinkTitle");
  dlg.innerHTML = `
    <div class="dialog-head">
      <h3 id="tvLinkTitle">Ovládání z mobilu</h3>
      <button type="button" class="icon-btn" id="tvLinkClose" aria-label="Zavřít" title="Zavřít"><i class="ph ph-x" aria-hidden="true"></i></button>
    </div>
    <div class="tv-link-body">
      <div class="tv-link-qr" id="tvLinkQr"></div>
      <div class="tv-link-info">
        <ol class="tv-link-steps">
          <li>Připoj mobil ke stejné Wi-Fi jako televize.</li>
          <li>Naskenuj QR kód fotoaparátem mobilu.</li>
        </ol>
        <p class="tv-link-noqr" id="tvLinkNoQr" hidden>QR kód se nepodařilo zobrazit. Adresu opiš do prohlížeče v mobilu a neukazuj ji hostům.</p>
        <div id="tvLinkAddr" hidden>
          <code class="tv-link-url" id="tvLinkUrl"></code>
          <p class="tv-link-code">Kód v adrese: <b id="tvLinkToken"></b></p>
        </div>
        <p class="tv-link-status" id="tvLinkStatus" role="status" aria-live="polite"><i aria-hidden="true"></i><span></span></p>
        <ul class="tv-link-devices" id="tvLinkDevices" aria-label="Připojená zařízení" hidden></ul>
        <p class="tv-link-msg" id="tvLinkMsg" role="status" aria-live="polite"></p>
      </div>
    </div>
    <div class="confirm-actions">
      <button type="button" class="btn ghost" id="tvLinkNew"><i class="ph ph-arrows-clockwise" aria-hidden="true"></i> Nový kód</button>
      <button type="button" class="btn ghost" id="tvLinkRetry" hidden><i class="ph ph-arrows-clockwise" aria-hidden="true"></i> Zkusit znovu</button>
      <button type="button" class="btn primary" id="tvLinkDone">Zavřít</button>
    </div>`;
  // Před Nastavením serveru: tv-remote.js bere jako aktivní první dialog[open] v DOM (navigace i Zpět),
  // dialog otevřený z Nastavení tak dostane šipky a Zpět zavře jen jeho.
  const settingsDlg = $("tvSettingsDialog");
  if (settingsDlg) settingsDlg.before(dlg);
  else document.body.appendChild(dlg);

  const part = (id) => dlg.querySelector("#" + id);
  let dlgUrl;          // url, pro kterou je vykreslený QR (undefined = ještě nic)
  let dlgKind = null;
  let busy = false;    // probíhá Nový kód / Zkusit znovu
  let opener = null;   // prvek, na který se po zavření vrátí fokus
  let rttTimer = null;

  function setMsg(text, bad) {
    part("tvLinkMsg").textContent = text || "";
    part("tvLinkMsg").classList.toggle("bad", !!bad);
  }

  function renderQrBox(i, kind) {
    const box = part("tvLinkQr");
    const svg = kind === "ready" ? qrSvg(i.url, QR_LABEL) : null;
    const noLib = kind === "ready" && !svg;
    box.textContent = "";
    box.className = "tv-link-qr" + (kind === "ready" ? "" : " empty") + (kind === "offline" ? " offline" : "");
    box.hidden = noLib;
    part("tvLinkNoQr").hidden = !noLib;
    dlg.querySelector(".tv-link-body").classList.toggle("no-qr", noLib);
    dlg.querySelector(".tv-link-steps li:last-child").hidden = noLib; // „Naskenuj QR kód“ bez QR nedává smysl
    if (svg) box.appendChild(svg);
    else if (kind !== "ready") {
      const icon = document.createElement("i");
      icon.className = "ph " + (kind === "offline" ? "ph-wifi-slash" : "ph-hourglass-medium");
      icon.setAttribute("aria-hidden", "true");
      const title = document.createElement("b");
      title.textContent = kind === "offline" ? "Televize není připojená k síti" : "Připravuji připojení…";
      box.append(icon, title);
      if (kind === "offline") {
        const text = document.createElement("span");
        text.textContent = "Připoj televizi k Wi-Fi nebo kabelem do stejné sítě jako mobil a zkus to znovu.";
        box.appendChild(text);
      }
    }
    // Textová adresa s klíčem jen bez QR (gate faze-3-list-5, varianta A); jinak se z DOM smaže.
    part("tvLinkAddr").hidden = !noLib;
    if (noLib) {
      fillUrl(part("tvLinkUrl"), i.url, i.token);
      part("tvLinkToken").textContent = i.token;
    } else {
      part("tvLinkUrl").textContent = "";
      part("tvLinkToken").textContent = "";
    }
  }

  function renderStatus(kind, count) {
    const st = part("tvLinkStatus");
    const [cls, icon, text] = kind === "offline" ? ["bad", "ph-wifi-slash", "Bez připojení k síti"]
      : kind === "preparing" ? ["", "ph-hourglass-medium", "Připravuji připojení…"]
      : count ? ["ok", "ph-check-circle", `Připojeno: ${count} zařízení`]
      : ["", "ph-hourglass-medium", "Čeká na připojení mobilu"];
    st.className = "tv-link-status" + (cls ? " " + cls : "");
    st.querySelector("i").className = "ph " + icon;
    const span = st.querySelector("span");
    if (span.textContent !== text) span.textContent = text; // aria-live: číst jen skutečnou změnu
  }

  function deviceRow(c, n) {
    const li = document.createElement("li");
    const slow = c.rttMs !== null && c.rttMs > SLOW_RTT_MS;
    if (slow) li.className = "slow";
    const icon = document.createElement("i");
    icon.className = "ph ph-device-mobile";
    icon.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.textContent = c.name || "Mobil " + n; // jméno z mobilu je nedůvěryhodné: jen textContent
    const rtt = document.createElement("small");
    if (slow) {
      const warn = document.createElement("i");
      warn.className = "ph ph-warning-circle";
      warn.setAttribute("aria-hidden", "true");
      rtt.append(warn, " pomalé spojení");
    } else rtt.textContent = c.rttMs !== null ? `odezva ${c.rttMs} ms` : "odezva –";
    li.append(icon, name, rtt);
    return li;
  }

  function renderDevices(connected) {
    const ul = part("tvLinkDevices");
    ul.textContent = "";
    ul.hidden = !connected.length;
    const shown = connected.length > MAX_DEVICE_ROWS ? MAX_DEVICE_ROWS - 1 : connected.length;
    connected.slice(0, shown).forEach((c, k) => ul.appendChild(deviceRow(c, k + 1)));
    if (connected.length > shown) {
      const more = document.createElement("li");
      more.className = "more";
      more.textContent = `a další ${connected.length - shown}`;
      ul.appendChild(more);
    }
  }

  // Tlačítka se nepřestavují (fokus by spadl na body), jen se přepíná Nový kód / Zkusit znovu.
  function renderButtons(kind) {
    const offline = kind === "offline";
    const hide = offline ? part("tvLinkNew") : part("tvLinkRetry");
    const show = offline ? part("tvLinkRetry") : part("tvLinkNew");
    const hadFocus = document.activeElement === hide;
    hide.hidden = true;
    show.hidden = false;
    if (hadFocus) show.focus();
  }

  // Po částech: QR, adresa a kód jen při změně url nebo stavu, stav a seznam vždy.
  function renderDialog() {
    const i = info();
    const kind = linkKind(i);
    if (i.url !== dlgUrl || kind !== dlgKind) {
      renderQrBox(i, kind);
      dlgUrl = i.url;
      dlgKind = kind;
    }
    const connected = clientList().filter((c) => c.connected);
    renderStatus(kind, connected.length);
    renderDevices(kind === "offline" ? [] : connected);
    renderButtons(kind);
  }

  function openDialog(from) {
    opener = from || document.activeElement;
    setMsg("");
    dlgUrl = undefined; // při otevření vždy překreslit celé
    renderDialog();
    if (!dlg.open) dlg.showModal();
    (dlgKind === "offline" ? part("tvLinkRetry") : part("tvLinkDone")).focus();
    clearInterval(rttTimer);
    rttTimer = setInterval(() => { if (dlg.open) renderDialog(); }, RTT_REFRESH_MS);
  }

  dlg.addEventListener("close", () => {
    clearInterval(rttTimer);
    rttTimer = null;
    const back = opener;
    opener = null;
    if (back && back.isConnected && !back.closest("dialog:not([open])")) back.focus();
  });
  part("tvLinkClose").addEventListener("click", () => dlg.close("cancel"));
  part("tvLinkDone").addEventListener("click", () => dlg.close("ok"));

  function runRestart(newToken) {
    busy = true;
    setMsg(newToken ? "Vytvářím nový kód…" : "Zkouším znovu…");
    return restart({ newToken }).then(() => {
      busy = false;
      const i = info();
      if (newToken) {
        if (i.error) setMsg("Nový kód se nepodařilo vytvořit. Zkus to znovu.", true);
        else setMsg("Nový kód je připravený. Mobily se musí připojit znovu.");
      } else setMsg(i.url ? "" : "Televize pořád není připojená k síti.", !i.url);
      if (dlg.open) renderDialog();
    });
  }

  part("tvLinkNew").addEventListener("click", () => {
    if (busy) return;
    const ask = typeof confirmDialog === "function"
      ? confirmDialog({
        icon: "📱",
        title: "Odpojit všechna zařízení a vytvořit nový kód?",
        text: "Připojené mobily se odpojí a budou muset naskenovat nový QR kód.",
        ok: "Nový kód",
        danger: true,
      })
      : Promise.resolve(true);
    ask.then((ok) => {
      if (dlg.open) part("tvLinkNew").focus();
      if (ok && !busy && dlg.open) runRestart(true);
    });
  });
  part("tvLinkRetry").addEventListener("click", () => {
    if (!busy) runRestart(false);
  });

  /* ---------- Vstupy do dialogu: menu, Nastavení serveru, nápověda na zadání ---------- */
  const menuItem = document.createElement("button");
  menuItem.setAttribute("role", "menuitem");
  menuItem.id = "menuTvLink";
  menuItem.innerHTML = '<i class="ph ph-device-mobile"></i><span>Ovládání z mobilu</span>';
  menuItem.addEventListener("click", () => {
    if (typeof closeMenu === "function") closeMenu();
    openDialog($("menuBtn"));
  });
  const menuAnchor = $("menuTvKeys") || $("menuTvSettings");
  if (menuAnchor) menuAnchor.after(menuItem);
  else document.querySelector("#menuPanel .menu-box")?.appendChild(menuItem);

  const settingsHint = document.querySelector("#tvSettingsForm > p.extra-hint");
  if (settingsHint) {
    const fromSettings = document.createElement("button");
    fromSettings.type = "button"; // formulář má method="dialog": submit by Nastavení zavřel
    fromSettings.id = "tvLinkFromSettings";
    fromSettings.className = "btn ghost tv-link-open";
    fromSettings.innerHTML = '<i class="ph ph-device-mobile" aria-hidden="true"></i> Psát z mobilu';
    fromSettings.addEventListener("click", () => openDialog(fromSettings));
    settingsHint.after(fromSettings);
  } else console.warn("tv-link: chybí #tvSettingsForm, tlačítko Psát z mobilu se nepřidá");

  const replay = $("tvReplay");
  if (replay) {
    const hint = document.createElement("p");
    hint.className = "tv-bubble-hint simple-only tv-link-hint";
    hint.innerHTML = '<i class="ph ph-device-mobile" aria-hidden="true"></i>Psát a ovládat jde i z mobilu: menu → Ovládání z mobilu';
    replay.after(hint);
  }

  /* ---------- Karta s QR na úvodní obrazovce (jen k zobrazení, bez fokusu) ---------- */
  // Vložená jako první dítě <main>; zobrazuje se jen v pohledu setup (CSS přes body[data-view]).
  // Bez adresy v síti nebo bez QR se skryje: klíč ovladače nesmí na plátno textem.
  const card = document.createElement("aside");
  card.className = "tv-link-card";
  card.id = "tvLinkCard";
  card.setAttribute("aria-label", "Ovládání z mobilu");
  card.hidden = true;
  card.innerHTML = `
    <div class="tv-link-card-box">
      <div class="tv-link-card-qr"></div>
      <b class="tv-link-card-title">Ovládání z mobilu</b>
      <p class="tv-link-card-text">Naskenuj QR kód fotoaparátem mobilu.</p>
      <code class="tv-link-card-url" hidden></code>
    </div>`;
  const main = $("main");
  if (main) main.prepend(card);
  let cardUrl;

  function renderCard() {
    // Připojený ovladač = spárováno: QR s tokenem a klíčem se z promítané obrazovky schová (viz bezpečnostní kontrola fáze 4).
    // Ve hře s hráči se karta ovladače neukazuje vůbec (QR pro hráče řeší lobby).
    const paired = clientList().some((c) => c.connected);
    const url = paired || playerMode ? null : info().url;
    if (url === cardUrl) return;
    cardUrl = url;
    const box = card.querySelector(".tv-link-card-qr");
    box.textContent = "";
    const svg = url ? qrSvg(url, QR_LABEL) : null;
    if (svg) box.appendChild(svg);
    card.hidden = !svg; // bez QR se karta neukáže, adresa ovladače na kartě nikdy není
    document.body.classList.toggle("tv-link-card-on", !!svg); // místo vpravo pro kartu, ať nepřekrývá zadání ani bubliny
  }

  onChange(() => {
    renderCard();
    if (dlg.open) renderDialog();
  });

  watchState();
  start();
})();
