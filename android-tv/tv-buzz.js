// TV nadstavba, kolo bzučáku: podle toho, co je právě na televizi, otevírá, odjišťuje, pozastavuje, vyhodnocuje
// a zavírá kolo herní logiky (KvizGameCore přes KvizTvGame.game). Vítěze ukáže pruhem #tvBuzzBar před #answers,
// třídou tv-buzz na kartě týmu a zvukem; Zpět ovladače při bzučení tým uvolní (KvizTvBuzz.onBack z tv-remote.js).
// Vkládá se jen do APK (android-tv/prepare.mjs) jako poslední TV skript, za tv-lobby.js.
// Rozhraní: kontrakt hráčů (.claude-work/2026-11-15-hraci-buzzer/kontrakt.md) § 4 (Kolo, TIMING), § 7 (KvizTvBuzz).
//
// Pravidla kola (stisky, zámky týmů, tresty, pořadí) jsou jen v KvizGameCore; tady se jen rozhoduje, kdy je zavolat.
// Bezpečnost: z otázky se čtou jen revealed, picked a correct a nikam se neposílají ani neukládají; do state se nezapisuje.
// Snímky hráčům skládá a posílá jen tv-game.js (tady jen KvizTvGame.refresh()).
//
// Spoléhá na věci z app.js (při jejich změně zkontrolovat tenhle soubor):
//   globály: state (view, index, locked, bigTeams, quiz (jen identita), teams (emoji, name)),
//            currentQ (jen .revealed, .picked, .correct)
//   prvky:   body[data-view], třída těla teams-big (velké zobrazení týmů), dialog[open], #menuPanel a #emojiPicker
//            (atribut hidden), #teams (děti = karty týmů v pořadí state.teams) a #answers (děti se překreslují
//            při odhalení i změně otázky, sourozenci ne)
// a na TV vrstvu: KvizTv (tv-server.js), KvizTvGame (tv-game.js: game, settings, refresh, hooks.onBuzz, onChange),
//   KvizGameCore.TIMING (game-core.js), KvizTvSound.play("buzz") (tv-sound.js, volitelně).
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
  let answering = null;   // { clientId, name, team } vítěze bzučení (pruh a karta týmu)

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

  /* ---------- Vítěz bzučení: pruh nad odpověďmi a zvýrazněná karta týmu ---------- */
  const BUZZ_CLASS = "tv-buzz";

  // Pruh je sourozenec těsně před #answers (app.js přestavuje jen děti #answers, pruh přežije).
  function createBar() {
    const bar = document.createElement("div");
    bar.id = "tvBuzzBar";
    bar.className = "tv-buzz-bar";
    bar.setAttribute("role", "status");
    bar.setAttribute("aria-live", "assertive");
    bar.hidden = true;
    const who = document.createElement("p");
    who.className = "tv-buzz-who";
    const hint = document.createElement("p");
    hint.className = "tv-buzz-hint";
    hint.textContent = "Vyber odpověď, kterou tým řekl · Zpět = bez odpovědi";
    bar.append(who, hint);
    const answers = $("answers");
    if (answers) answers.before(bar);
    else console.warn("tv-buzz: chybí prvek #answers, pruh Odpovídá se nezobrazí");
    return { bar, who };
  }
  const buzzBar = createBar();

  // Vyplní pruh a označí kartu týmu podle `answering`; volá se i po překreslení lišty týmů (nová karta, nový název).
  // Přezdívka i název týmu jsou cizí text: jen textContent.
  function renderAnswering() {
    const cards = $("teams") ? $("teams").children : [];
    Array.prototype.forEach.call(cards, (card, i) => card.classList.toggle(BUZZ_CLASS, !!answering && answering.team === i));
    buzzBar.bar.hidden = !answering;
    if (!answering) return;
    const teams = appState().teams;
    const team = Array.isArray(teams) ? teams[answering.team] : null;
    const teamLabel = team ? [team.emoji, team.name].filter(Boolean).join(" ") : "";
    buzzBar.who.textContent = "Odpovídá: " + [teamLabel, answering.name].filter(Boolean).join(" – ");
  }

  function showAnswering(winner) {
    answering = winner;
    renderAnswering();
    if (window.KvizTvSound) window.KvizTvSound.play("buzz");
  }
  function clearAnswering() {
    answering = null;
    renderAnswering();
  }

  // Vítěz zmizel z kola: odebraný hráč (kick) uvolní kolo jako Zpět, jinak (přeskupení týmů) kolo už vynulovala herní logika.
  function syncAnswering() {
    if (!answering) return false;
    if (game.round().status !== "answering") {
      clearAnswering();
      return true;
    }
    if (game.players().some((p) => p.clientId === answering.clientId)) return false;
    game.release();
    clearAnswering();
    return true;
  }

  // Zpět ovladače při bzučení = tým neodpověděl: zamkne se do konce otázky, bzučák se otevře ostatním.
  function onBack() {
    if (!answering) return false;
    game.release();
    clearAnswering();
    Game.refresh();
    sync();
    return true;
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
    if (syncAnswering()) changed = true;
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
    clearTimeout(syncTimer);
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
    // Překreslená lišta týmů ztratí třídu tv-buzz; vrací se hned, ne až po srovnání kola (vzor tv-remote.js).
    if ($("teams")) new MutationObserver(renderAnswering).observe($("teams"), { childList: true });
    Game.onChange(scheduleSync);
  }

  Game.hooks.onBuzz = onBuzz;
  window.KvizTvBuzz = { onBack };
  watchPage();
  scheduleSync();
})();
