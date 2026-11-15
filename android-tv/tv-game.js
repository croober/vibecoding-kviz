// TV nadstavba, herní režim s hráči: spojí zprávy hráčů z mobilního ovládání (tv-link.js) s herní logikou (game-core.js)
// a každému hráči posílá jeho snímek. Sám nic nevykresluje; zapnutí hry nabízí lobby, kolo bzučáku řídí tv-buzz.js.
// Vkládá se jen do APK (android-tv/prepare.mjs) jako poslední TV skript, za tv-link.js.
// Rozhraní: kontrakt hráčů (.claude-work/2026-11-15-hraci-buzzer/kontrakt.md) § 4 (KvizGameCore), § 5 (KvizTvLink.players),
// § 7 (KvizTvGame).
//
// Bezpečnost: podklad snímku se bere jen z KvizTvLink.players.context() (vyjmenovaná pole, z otázky jen příznak
// odhalení), k otázce ani ke stavu kvízu tenhle soubor nepřistupuje. Hráči jde jen zpráva state a vždy jednomu
// hráči přes players.send; clientId se bere jen z parametru posluchače (tv-link.js ho má z registru podle spojení).
// Připojení hráče kolo nemění – stisky, zámky týmů i pořadí hlídá KvizGameCore.
//
// Spoléhá na (při jejich změně zkontrolovat tenhle soubor):
//   KvizTv.store (tv-server.js), KvizTvLink (tv-link.js: players, info, setPlayerMode a výměna klíče ovladače),
//   KvizGameCore (game-core.js), KvizLinkCore.sameState (link-core.js);
//   prvky z app.js: #teams a #answers (děti se překreslují), body[data-view].
(() => {
  "use strict";
  const Tv = window.KvizTv;
  const TvLink = window.KvizTvLink;
  const GameCore = window.KvizGameCore;
  const Link = window.KvizLinkCore;
  if (!Tv || !TvLink || !GameCore || !Link) return; // webová verze nebo vypnuté mobilní ovládání: tiše konec

  const SETTINGS_KEY = "kviz-tv-game-v1";
  const SEND_DELAY_MS = 50;
  const DEFAULT_SETTINGS = { enabled: false, autoPoints: true };
  const OFF = { ok: false, reason: "off" };

  const store = Tv.store;
  const link = TvLink.players;
  const game = GameCore.createGame();
  const hooks = { onBuzz: null };
  const listeners = [];
  const lastSent = new Map(); // clientId → poslední odeslaný snímek
  let rev = 0;
  let sendTimer = null;

  /* ---------- Nastavení ---------- */
  // Poškozený záznam i cizí typy vedou na výchozí hodnoty; platí jen true a false.
  function loadSettings() {
    let saved = null;
    try { saved = JSON.parse(store.get(SETTINGS_KEY)); } catch { saved = null; }
    const readFlag = (key) => (saved && typeof saved[key] === "boolean" ? saved[key] : DEFAULT_SETTINGS[key]);
    return { enabled: readFlag("enabled"), autoPoints: readFlag("autoPoints") };
  }
  const settingsNow = loadSettings();
  const saveSettings = () => store.set(SETTINGS_KEY, JSON.stringify(settingsNow));

  function callSafely(fn, args, what) {
    try {
      fn(...args);
    } catch (err) {
      console.warn("tv-game: chyba " + what, err);
    }
  }
  function notify() {
    listeners.forEach((cb) => callSafely(cb, [], "v posluchači změny"));
  }

  /* ---------- Snímky hráčům ---------- */
  function viewOf(clientId, withRev) {
    return game.viewFor(clientId, Object.assign({}, link.context(), { enabled: settingsNow.enabled, rev: withRev }));
  }

  // Snímek do welcome: rev roste jen s odeslaným snímkem.
  function welcomeView(clientId) {
    rev += 1;
    const view = viewOf(clientId, rev);
    lastSent.set(clientId, view);
    return view;
  }

  function sendViews() {
    sendTimer = null;
    const list = link.list();
    const known = new Set(list.map((p) => p.clientId));
    Array.from(lastSent.keys()).forEach((id) => { if (!known.has(id)) lastSent.delete(id); });
    list.filter((p) => p.connected).forEach((p) => {
      const next = viewOf(p.clientId, rev + 1);
      if (Link.sameState(next, lastSent.get(p.clientId))) return;
      rev += 1;
      lastSent.set(p.clientId, next);
      link.send(p.clientId, Object.assign({ t: "state" }, next));
    });
  }
  function refresh() {
    if (!sendTimer) sendTimer = setTimeout(sendViews, SEND_DELAY_MS);
  }

  /* ---------- Zprávy a spojení hráčů ---------- */
  function onJoin(clientId, msg) {
    const res = game.join(clientId, msg.name, msg.team, link.context().teams);
    notify();
    return res;
  }
  function onBuzz(clientId, msg, rx) {
    const res = game.buzz(clientId, msg.q, rx, performance.now());
    if (res.ok && res.first && typeof hooks.onBuzz === "function") callSafely(hooks.onBuzz, [], "v hooks.onBuzz");
    return res;
  }

  link.onMessage((clientId, msg, rx) => {
    if (!settingsNow.enabled) return OFF;
    let res = OFF;
    if (msg.t === "join") res = onJoin(clientId, msg);
    else if (msg.t === "buzz") res = onBuzz(clientId, msg, rx);
    refresh();
    return { ok: res.ok, reason: res.reason };
  });

  link.onConnection((clientId, connected) => {
    game.setConnected(clientId, connected === true);
    refresh();
    notify();
  });

  link.setView(welcomeView);

  /* ---------- Sledování stránky ---------- */
  function watchPage() {
    const watch = (id, onChange) => {
      const node = document.getElementById(id);
      if (!node) return console.warn("tv-game: chybí prvek #" + id + ", jeho změny se hráčům nehlásí");
      new MutationObserver(onChange).observe(node, { childList: true });
    };
    watch("teams", () => {
      game.remapTeams(link.context().teams);
      refresh();
      notify();
    });
    watch("answers", refresh);
    new MutationObserver(refresh).observe(document.body, { attributes: true, attributeFilter: ["data-view"] });
  }

  /* ---------- Rozhraní ---------- */
  // Akce uživatele: klíč ovladače se mění jen při přepnutí z vypnuto na zapnuto (staré odkazy a QR přestanou platit).
  function setEnabled(on) {
    const next = on === true;
    if (next === settingsNow.enabled) return;
    settingsNow.enabled = next;
    if (next) TvLink.rotateRemoteKey();
    TvLink.setPlayerMode(next);
    saveSettings();
    refresh();
    notify();
  }
  function setAutoPoints(on) {
    settingsNow.autoPoints = on === true;
    saveSettings();
    notify();
  }
  // Soupiska doplněná o odezvu spojení (jen u připojeného hráče).
  function players() {
    const rtt = new Map(link.list().map((p) => [p.clientId, p.rttMs]));
    return game.players().map((p) => Object.assign({}, p, { rttMs: rtt.has(p.clientId) ? rtt.get(p.clientId) : null }));
  }
  function playerUrl() {
    return TvLink.info().playerUrl;
  }
  function onChange(cb) {
    if (typeof cb === "function") listeners.push(cb);
  }

  window.KvizTvGame = {
    settings: () => Object.assign({}, settingsNow),
    setEnabled, setAutoPoints, players, playerUrl, onChange, game, refresh, hooks,
  };

  // Start aplikace: uložená zapnutá hra jen skryje kartu ovladače, klíč ovladače zůstává (R29).
  if (settingsNow.enabled) TvLink.setPlayerMode(true);
  watchPage();
})();
