// TV nadstavba, kolo bzučáku: podle toho, co je právě na televizi, otevírá, odjišťuje, pozastavuje, vyhodnocuje
// a zavírá kolo herní logiky (KvizGameCore přes KvizTvGame.game). Sám zatím nic nevykresluje.
// Vkládá se jen do APK (android-tv/prepare.mjs) jako poslední TV skript, za tv-lobby.js.
// Rozhraní: kontrakt hráčů (.claude-work/2026-11-15-hraci-buzzer/kontrakt.md) § 4 (Kolo, TIMING), § 7 (KvizTvBuzz).
//
// Pravidla kola (stisky, zámky týmů, tresty, pořadí) jsou jen v KvizGameCore; tady se jen rozhoduje, kdy je zavolat.
// Bezpečnost: z otázky se čtou jen revealed, picked a correct a nikam se neposílají ani neukládají; do state se nezapisuje.
// Snímky hráčům skládá a posílá jen tv-game.js (tady jen KvizTvGame.refresh()).
//
// Spoléhá na věci z app.js (při jejich změně zkontrolovat tenhle soubor):
//   globály: state (view, index, locked, bigTeams, teams), currentQ (jen .revealed, .picked, .correct)
//   prvky:   body[data-view], třída těla teams-big (velké zobrazení týmů), dialog[open], #menuPanel a #emojiPicker
//            (atribut hidden), #teams a #answers (děti se překreslují; #answers při odhalení i změně otázky)
// a na TV vrstvu: KvizTv (tv-server.js), KvizTvGame (tv-game.js: game, settings, refresh, hooks.onBuzz, onChange),
//   KvizGameCore.TIMING (game-core.js).
(() => {
  "use strict";
  const Game = window.KvizTvGame;
  const GameCore = window.KvizGameCore;
  if (!window.KvizTv || !Game || !GameCore) return; // jen v APK s herním režimem; webová verze skončí tiše

  const $ = (id) => document.getElementById(id);
  const appState = () => (typeof state !== "undefined" ? state : {});
  const questionNow = () => (typeof currentQ === "function" ? currentQ() : null);
  const game = Game.game;
  const TIMING = GameCore.TIMING;
  const SYNC_DELAY_MS = 50;
  const MIN_TEAMS = 2;

  let armTimer = null;    // prodleva před odjištěním bzučáku
  let windowTimer = null; // okno pro skoro současné stisky, po něm se vybere vítěz
  let syncTimer = null;
  let roundIndex = null;  // index otázky, pro kterou běží kolo; null = kolo se při příštím hraní otevře znovu
  let roundQuiz = null;   // state.quiz, pro který běží kolo; nový kvíz (i z menu na obrazovce quiz) = nové kolo
  let answering = null;   // { clientId, name, team } vítěze bzučení; kreslí ho list 8-2

  /* ---------- Stav obrazovky ---------- */
  function playable() {
    const s = appState();
    return Game.settings().enabled && s.view === "quiz" && !s.locked && !!questionNow();
  }

  const isShown = (id) => {
    const node = $(id);
    return !!node && !node.hidden;
  };
  // Překryv nad otázkou (vzor overlayNow v tv-link.js) nebo velké zobrazení týmů.
  function paused() {
    return !!document.querySelector("dialog[open]") || isShown("menuPanel") || isShown("emojiPicker") || !!appState().bigTeams;
  }

  function teamCount() {
    const teams = appState().teams;
    return Array.isArray(teams) ? teams.length : 0;
  }

  // Kolo patří otázce na obrazovce: stejný kvíz (odkaz na state.quiz) i stejný index.
  function roundIsCurrent() {
    const s = appState();
    return roundQuiz === s.quiz && roundIndex === s.index;
  }

  // Jediné místo s podmínkami odjištění; platí při spuštění prodlevy i po jejím uplynutí.
  function armReady() {
    if (!playable() || !roundIsCurrent()) return false;
    const q = questionNow();
    return game.round().status === "waiting" && !q.revealed && !paused() && teamCount() >= MIN_TEAMS;
  }

  /* ---------- Vítěz bzučení ---------- */
  function showAnswering(winner) {
    answering = winner;
  }
  function clearAnswering() {
    answering = null;
  }

  /* ---------- Časovače ---------- */
  function cancelArm() {
    clearTimeout(armTimer);
    armTimer = null;
  }
  function cancelTimers() {
    cancelArm();
    clearTimeout(windowTimer);
    windowTimer = null;
  }

  function runSafely(fn, what) {
    try {
      fn();
    } catch (err) {
      console.warn("tv-buzz: chyba " + what + (err && err.name ? " (" + err.name + ")" : ""));
    }
  }

  function onArmDelay() {
    armTimer = null;
    if (!armReady()) return;
    game.arm();
    Game.refresh();
  }

  function onWindowEnd() {
    windowTimer = null;
    const winner = game.resolve();
    if (winner) showAnswering(winner); // bez vítěze zůstává bzučák otevřený a další stisk spustí nové okno
    Game.refresh();
  }

  function onBuzz() {
    if (!windowTimer) windowTimer = setTimeout(() => runSafely(onWindowEnd, "při vyhodnocení bzučení"), TIMING.windowMs);
  }

  /* ---------- Srovnání kola s obrazovkou ---------- */
  // Vrací true, když se kolo změnilo.
  function syncPlaying() {
    const s = appState();
    const q = questionNow();
    let changed = false;
    if (!roundIsCurrent()) {
      cancelTimers();
      clearAnswering();
      game.openRound(s.index);
      roundIndex = s.index;
      roundQuiz = s.quiz;
      changed = true;
    }
    if (q.revealed && game.round().status !== "closed") {
      cancelTimers();
      clearAnswering();
      game.closeRound(q.picked === q.correct ? "correct" : "wrong");
      changed = true;
    }
    const pause = paused();
    if (game.round().paused !== pause) {
      game.setPaused(pause);
      changed = true;
    }
    if (!armReady()) cancelArm();
    else if (!armTimer) armTimer = setTimeout(() => runSafely(onArmDelay, "při odjištění bzučáku"), TIMING.armDelayMs);
    return changed;
  }

  function stopPlaying() {
    cancelTimers();
    clearAnswering();
    roundIndex = null;
    roundQuiz = null;
    const status = game.round().status;
    if (status === "idle" || status === "closed") return false;
    game.closeRound();
    return true;
  }

  function sync() {
    syncTimer = null;
    runSafely(() => {
      const changed = playable() ? syncPlaying() : stopPlaying();
      if (changed) Game.refresh();
    }, "při srovnání kola s obrazovkou");
  }
  function scheduleSync() {
    if (!syncTimer) syncTimer = setTimeout(sync, SYNC_DELAY_MS);
  }

  /* ---------- Sledování ---------- */
  function watchPage() {
    // Druhé observe() na stejném uzlu by přepsalo volby prvního, proto tělo (data-view, class) a dialogy (open)
    // sleduje každý svým observerem.
    new MutationObserver(scheduleSync).observe(document.body, { attributes: true, attributeFilter: ["data-view", "class"] });
    new MutationObserver(scheduleSync).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open"] });
    const observer = new MutationObserver(scheduleSync);
    const watch = (id, options) => {
      const node = $(id);
      if (node) observer.observe(node, options);
      else console.warn("tv-buzz: chybí prvek #" + id + ", jeho změny kolo bzučáku nesleduje");
    };
    ["menuPanel", "emojiPicker"].forEach((id) => watch(id, { attributes: true, attributeFilter: ["hidden"] }));
    ["teams", "answers"].forEach((id) => watch(id, { childList: true }));
    Game.onChange(scheduleSync);
  }

  Game.hooks.onBuzz = onBuzz;
  watchPage();
  scheduleSync();
})();
