// TV nadstavba, herní režim s hráči: spojí zprávy hráčů z mobilního ovládání (tv-link.js) s herní logikou (game-core.js)
// a každému hráči posílá jeho snímek. Sám nic nevykresluje; zapnutí hry nabízí lobby, kolo bzučáku řídí tv-buzz.js.
// Vkládá se jen do APK (android-tv/prepare.mjs) za tv-link.js (posledním TV skriptem je tv-answers.js).
// Rozhraní: kontrakt hráčů (.claude-work/2026-11-15-hraci-buzzer/kontrakt.md) § 4 (KvizGameCore), § 5 (KvizTvLink.players),
// § 7 (KvizTvGame); režim odpovědí: .claude-work/2026-11-17-odpovedi-na-mobilu/kontrakt.md § 6 a § 7.
//
// Režim hry (settings().mode): "buzz" (bzučák, výchozí i pro starší uložené nastavení) nebo "answers" (hráči odpovídají
// na mobilech, kolo drží KvizAnswerCore). Bez answer-core.js zůstává jen bzučák. Kolo odpovědí otevírá a zavírá
// tv-answers.js, tenhle soubor jen směruje zprávy a posílá snímky.
//
// Bezpečnost: podklad snímku se bere jen z KvizTvLink.players.context() (vyjmenovaná pole, z otázky jen příznak
// odhalení); v režimu odpovědí navíc hotová filtrovaná otázka z players.question() (tvar určuje
// KvizLinkCore.questionView) a snímek skládá jen KvizAnswerCore.viewFor. Ke stavu kvízu tenhle soubor nepřistupuje.
// Hráči jde jen zpráva state a vždy jednomu hráči přes players.send; clientId se bere jen z parametru posluchače
// (tv-link.js ho má z registru podle spojení), hlas přijme jen hráč ze soupisky. Připojení hráče kolo nemění –
// stisky, zámky týmů i pořadí hlídá KvizGameCore; změnu týmu během kola odpovědí zakazuje tenhle soubor.
//
// Spoléhá na (při jejich změně zkontrolovat tenhle soubor):
//   KvizTv.store (tv-server.js), KvizTvLink (tv-link.js: players, info, setPlayerMode a výměna klíče ovladače),
//   KvizGameCore (game-core.js), KvizAnswerCore (answer-core.js, volitelně), KvizLinkCore.sameState (link-core.js);
//   prvky z app.js: #teams a #answers (děti se překreslují), body[data-view].
(() => {
  "use strict";
  const Tv = window.KvizTv;
  const TvLink = window.KvizTvLink;
  const GameCore = window.KvizGameCore;
  const Link = window.KvizLinkCore;
  const AnswerCore = window.KvizAnswerCore; // chybí-li, režim odpovědí není k dispozici a hraje se jen bzučák
  if (!Tv || !TvLink || !GameCore || !Link) return; // webová verze nebo vypnuté mobilní ovládání: tiše konec

  const SETTINGS_KEY = "kviz-tv-game-v1";
  const SEND_DELAY_MS = 50;
  const MODE_BUZZ = "buzz";
  const MODE_ANSWERS = "answers";
  const MODES = AnswerCore ? [MODE_BUZZ, MODE_ANSWERS] : [MODE_BUZZ];
  const DEFAULT_SETTINGS = { enabled: false, autoPoints: true, mode: MODE_BUZZ };
  const OFF = { ok: false, reason: "off" };
  const LOCKED = { ok: false, reason: "locked" };
  const MAX_KICKED = 32; // strop seznamu odebraných; při překročení vypadne nejstarší

  const store = Tv.store;
  const link = TvLink.players;
  const game = GameCore.createGame();
  const answers = AnswerCore ? AnswerCore.createAnswers() : null;
  const hooks = { onBuzz: null, onAnswer: null };
  const listeners = [];
  const lastSent = new Map(); // clientId → poslední odeslaný snímek
  const kicked = []; // odebraná clientId (jen v paměti), od nejstaršího
  let rev = 0;
  let sendTimer = null;

  /* ---------- Nastavení ---------- */
  // Poškozený záznam i cizí typy vedou na výchozí hodnoty; u příznaků platí jen true a false, u režimu jen známé
  // hodnoty (starší záznam bez mode, neznámý režim nebo chybějící answer-core.js → bzučák).
  function loadSettings() {
    let saved = null;
    try { saved = JSON.parse(store.get(SETTINGS_KEY)); } catch { saved = null; }
    const readFlag = (key) => (saved && typeof saved[key] === "boolean" ? saved[key] : DEFAULT_SETTINGS[key]);
    const mode = saved && MODES.includes(saved.mode) ? saved.mode : DEFAULT_SETTINGS.mode;
    return { enabled: readFlag("enabled"), autoPoints: readFlag("autoPoints"), mode };
  }
  const settingsNow = loadSettings();
  const saveSettings = () => store.set(SETTINGS_KEY, JSON.stringify(settingsNow));
  const answersMode = () => settingsNow.mode === MODE_ANSWERS && answers !== null;

  // Hráč ze soupisky ve tvaru pro KvizAnswerCore ({ name, team }), nebo null.
  function rosterPlayer(clientId) {
    const found = game.players().find((p) => p.clientId === clientId);
    return found ? { name: found.name, team: found.team } : null;
  }
  // Počet hráčů, od kterých se čeká hlas: připojení a s týmem.
  function expectedCount() {
    return game.players().filter((p) => p.connected && Number.isInteger(p.team) && p.team >= 0).length;
  }

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
  // Odebraný hráč dostane snímek vypnuté hry, takže nenese týmy ani stav hry. V režimu bzučáku se otázka nečte vůbec.
  function viewOf(clientId, withRev) {
    const enabled = settingsNow.enabled && !kicked.includes(clientId);
    const ctx = Object.assign({}, link.context(), { enabled, rev: withRev });
    if (!answersMode()) return game.viewFor(clientId, ctx);
    Object.assign(ctx, { ask: link.question(), now: performance.now(), expected: expectedCount() });
    return answers.viewFor(clientId, ctx, rosterPlayer(clientId));
  }

  // Snímek do welcome: rev roste jen s odeslaným snímkem. Při chybě jde hráči prázdný snímek s vlastním rev.
  function welcomeView(clientId) {
    rev += 1;
    try {
      const view = viewOf(clientId, rev);
      lastSent.set(clientId, view);
      return view;
    } catch (err) {
      console.warn("tv-game: chyba při sestavení snímku welcome", err);
      return { rev, phase: "off" };
    }
  }

  function sendView(player) {
    const next = viewOf(player.clientId, rev + 1);
    if (Link.sameState(next, lastSent.get(player.clientId))) return;
    rev += 1;
    lastSent.set(player.clientId, next);
    // Okamžik otevření kola (od něj se měří čas odpovědi) = nejdřívější odeslání snímku s otázkou, v hodinách pluginu.
    const onSent = next.phase === "answer" && next.ask
      ? (sentAt) => answers.setOpenAt(next.ask.round, sentAt)
      : undefined;
    link.send(player.clientId, Object.assign({ t: "state" }, next), onSent);
  }

  function sendViews() {
    sendTimer = null;
    const list = link.list();
    const known = new Set(list.map((p) => p.clientId));
    Array.from(lastSent.keys()).forEach((id) => { if (!known.has(id)) lastSent.delete(id); });
    list.filter((p) => p.connected).forEach((p) => callSafely(sendView, [p], "při odeslání snímku hráči"));
  }
  function refresh() {
    if (!sendTimer) sendTimer = setTimeout(sendViews, SEND_DELAY_MS);
  }

  /* ---------- Zprávy a spojení hráčů ---------- */
  // Během kola odpovědí nesmí hráč s týmem přejít jinam (bzučák to hlídá sám v KvizGameCore).
  function teamLocked(clientId, team) {
    if (!answersMode() || !answers.running()) return false;
    const player = rosterPlayer(clientId);
    return player !== null && Number.isInteger(player.team) && player.team >= 0 && player.team !== team;
  }
  function onJoin(clientId, msg) {
    if (teamLocked(clientId, msg.team)) return LOCKED;
    const res = game.join(clientId, msg.name, msg.team, link.context().teams);
    if (res.ok) notify();
    return res;
  }
  function onBuzz(clientId, msg, rx) {
    const res = game.buzz(clientId, msg.q, rx, performance.now());
    if (res.ok && res.first && typeof hooks.onBuzz === "function") callSafely(hooks.onBuzz, [], "v hooks.onBuzz");
    return res;
  }
  function onAnswer(clientId, msg, rx) {
    if (!answersMode()) return OFF;
    const res = answers.answer(clientId, msg.round, msg.key, rx, performance.now(), rosterPlayer(clientId));
    if (res.ok && typeof hooks.onAnswer === "function") callSafely(hooks.onAnswer, [], "v hooks.onAnswer");
    return res;
  }

  link.onMessage((clientId, msg, rx) => {
    if (kicked.includes(clientId)) return OFF;
    if (!settingsNow.enabled) return OFF;
    let res = OFF;
    if (msg.t === "join") res = onJoin(clientId, msg);
    else if (msg.t === "buzz") res = onBuzz(clientId, msg, rx);
    else if (msg.t === "answer") res = onAnswer(clientId, msg, rx);
    refresh();
    return { ok: res.ok, reason: res.reason };
  });

  link.onConnection((clientId, connected) => {
    if (connected === true && kicked.includes(clientId)) {
      link.forget(clientId);
      return;
    }
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
    if (next) {
      kicked.length = 0;
      TvLink.rotateRemoteKey();
    }
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
  // Přepnutí režimu nemění klíč ovladače, QR ani režim hráčů v tv-link.js; kolo odpovědí ruší tv-answers.js.
  function setMode(mode) {
    if (!MODES.includes(mode) || mode === settingsNow.mode) return;
    settingsNow.mode = mode;
    saveSettings();
    refresh();
    notify();
  }
  // Soupiska doplněná o odezvu spojení (jen u připojeného hráče).
  function players() {
    const rtt = new Map(link.list().map((p) => [p.clientId, p.rttMs]));
    return game.players().map((p) => Object.assign({}, p, { rttMs: rtt.has(p.clientId) ? rtt.get(p.clientId) : null }));
  }
  // Trvalé odebrání hráče do vypnutí a zapnutí hry. game.remove jde před forget, aby se zavřením spojení nic nevrátilo.
  function kick(clientId) {
    if (!game.remove(clientId)) return false;
    if (!kicked.includes(clientId)) kicked.push(clientId);
    if (kicked.length > MAX_KICKED) kicked.shift();
    link.forget(clientId);
    refresh();
    notify();
    return true;
  }
  function playerUrl() {
    return TvLink.info().playerUrl;
  }
  function onChange(cb) {
    if (typeof cb === "function") listeners.push(cb);
  }

  window.KvizTvGame = {
    settings: () => Object.assign({}, settingsNow),
    setEnabled, setAutoPoints, setMode, players, kick, playerUrl, onChange, game, answers, refresh, hooks,
  };

  // Start aplikace: uložená zapnutá hra jen skryje kartu ovladače, klíč ovladače zůstává (R29).
  if (settingsNow.enabled) TvLink.setPlayerMode(true);
  watchPage();
})();
