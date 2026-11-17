// TV nadstavba, kolo odpovědí na mobilech: podle toho, co je právě na televizi, otevírá kolo herní vrstvy
// (KvizTvGame.answers), hlídá odpočet, zavře příjem po vypršení limitu nebo po hlasu všech připojených hráčů s týmem
// a za chvíli otázku sám odhalí voláním reveal() z app.js. Po odhalení kolo jednou vyhodnotí a týmům přičte body
// přes addPoints z app.js. Při odchodu z otázky kolo zruší bez bodů.
// Menu, dialog ani velké zobrazení týmů odpočet nezastaví (D5); odhalení jen počká na zavření dialogu, menu a emoji.
// Vkládá se jen do APK (android-tv/prepare.mjs) jako poslední TV skript, za tv-buzz.js.
// Rozhraní: .claude-work/2026-11-17-odpovedi-na-mobilu/kontrakt.md § 7 (tv-answers.js).
//
// Pravidla kola (příjem hlasů, uzávěrka, vyhodnocení) jsou jen v KvizAnswerCore; tady se jen rozhoduje, kdy je zavolat.
// Uzávěrka se řídí stavem a hodinami TV, nikdy údaji z mobilu. Snímky hráčům skládá a posílá jen tv-game.js.
// Bezpečnost: z otázky se čte revealed a správná odpověď (correct) až po odhalení, jen pro vyhodnocení, nikam se
// neposílá; do state se nezapisuje, odhalení jde jen přes reveal() a body jen přes addPoints() z app.js.
//
// Spoléhá na věci z app.js (při jejich změně zkontrolovat tenhle soubor):
//   globály: state (view, locked, index, quiz (jen identita), teams (jen počet)), currentQ (.revealed, po odhalení
//            .correct), reveal, pick (obaluje se – po tv-remote.js a tv-buzz.js je tenhle obal nejvnější),
//            addPoints (index týmu, body; bez force), questionPoints, scoringActive
//   prvky:   body[data-view], dialog[open], #menuPanel a #emojiPicker (atribut hidden), #teams a #answers (děti
//            se překreslují při změně týmů, otázky a odhalení)
// a na TV vrstvu: KvizTvGame (tv-game.js: answers, players, settings, refresh, onChange, hooks.onAnswer),
//   KvizAnswerCore.TIMING (answer-core.js).
(() => {
  "use strict";
  const Game = window.KvizTvGame;
  const AnswerCore = window.KvizAnswerCore;
  if (!Game || !Game.answers || !AnswerCore) return; // jen v APK s režimem odpovědí; jinde skončí tiše

  const $ = (id) => document.getElementById(id);
  const appState = () => (typeof state !== "undefined" ? state : {});
  const questionNow = () => (typeof currentQ === "function" ? currentQ() : null);
  const answers = Game.answers;
  const TIMING = AnswerCore.TIMING;
  const MODE_ANSWERS = "answers";
  const SYNC_DELAY_MS = 50;
  const MIN_TEAMS = 1;
  const MIN_PLAYERS = 1;

  let limitTimer = null;   // konec limitu odpovědí
  let revealTimer = null;  // prodleva mezi uzavřením a automatickým odhalením
  let revealDue = false;   // prodleva uplynula, odhalení čeká na zavření překryvu
  let syncTimer = null;
  let roundIndex = null;   // index otázky, pro kterou bylo kolo otevřeno; null = kolo se při příštím hraní otevře znovu
  let roundQuiz = null;    // state.quiz, pro který bylo kolo otevřeno; nový kvíz = nové kolo
  let evaluatedRound = 0;  // číslo kola, které už prošlo vyhodnocením po odhalení

  /* ---------- Stav obrazovky ---------- */
  function playable() {
    const s = appState();
    const settings = Game.settings();
    return settings.enabled && settings.mode === MODE_ANSWERS && s.view === "quiz" && !s.locked && !!questionNow();
  }

  const isShown = (id) => {
    const node = $(id);
    return !!node && !node.hidden;
  };
  // Překryv nad otázkou (vzor paused v tv-buzz.js bez velkého zobrazení týmů): odpočet běží dál, jen se neodhaluje.
  function overlayOpen() {
    return !!document.querySelector("dialog[open]") || isShown("menuPanel") || isShown("emojiPicker");
  }

  function teamCount() {
    const teams = appState().teams;
    return Array.isArray(teams) ? teams.length : 0;
  }

  // Hráči, od kterých se čeká hlas: připojení a s týmem.
  function expectedIds() {
    return Game.players()
      .filter((p) => p.connected && Number.isInteger(p.team) && p.team >= 0)
      .map((p) => p.clientId);
  }

  // Kolo patří otázce na obrazovce: stejný kvíz (odkaz na state.quiz) i stejný index.
  function roundIsCurrent() {
    const s = appState();
    return roundQuiz === s.quiz && roundIndex === s.index;
  }

  // Jediné místo s podmínkami otevření kola; kolo se pro danou otázku a kvíz otevře jen jednou.
  function canOpen() {
    if (!playable() || roundIsCurrent()) return false;
    return !questionNow().revealed && teamCount() >= MIN_TEAMS && expectedIds().length >= MIN_PLAYERS;
  }

  // Jediné místo s podmínkami automatického odhalení.
  function revealReady() {
    if (!playable() || !roundIsCurrent() || typeof reveal !== "function") return false;
    return answers.round().status === "closed" && !questionNow().revealed && !overlayOpen();
  }

  /* ---------- Časovače ---------- */
  function runSafely(fn, what) {
    try {
      fn();
    } catch (err) {
      console.warn("tv-answers: chyba " + what + (err && err.name ? " (" + err.name + ")" : ""));
    }
  }

  function cancelTimers() {
    clearTimeout(limitTimer);
    limitTimer = null;
    clearTimeout(revealTimer);
    revealTimer = null;
    revealDue = false;
  }

  function tryReveal() {
    if (!revealReady()) return;
    revealDue = false;
    reveal();
  }

  function scheduleReveal() {
    if (revealDue) tryReveal();
    else if (!revealTimer) revealTimer = setTimeout(() => runSafely(onRevealDelay, "při automatickém odhalení"), TIMING.revealDelayMs);
  }

  function onRevealDelay() {
    revealTimer = null;
    revealDue = true;
    tryReveal(); // při otevřeném překryvu to zkusí znovu další sync po jeho zavření
  }

  function onLimit() {
    limitTimer = null;
    if (!roundIsCurrent() || !answers.close("time")) return;
    Game.refresh();
    scheduleReveal();
  }

  /* ---------- Kolo ---------- */
  function openRound() {
    cancelTimers(); // pojistka: časovač předchozího kola nesmí přežít, ani kdyby se změnilo pořadí v syncPlaying
    const s = appState();
    answers.open(s.index, TIMING.limitMs, performance.now());
    roundIndex = s.index;
    roundQuiz = s.quiz;
    limitTimer = setTimeout(() => runSafely(onLimit, "při konci limitu"), TIMING.limitMs);
  }

  // Zruší běžící kolo bez bodů; vrací true, když nějaké běželo.
  function cancelRound() {
    cancelTimers();
    roundIndex = null;
    roundQuiz = null;
    if (!answers.running()) return false;
    answers.cancel();
    return true;
  }

  // Body jen podle přepínače „Bod za správnou odpověď automaticky“ a jen tam, kde app.js bodování připouští
  // (běžící kvíz, ne archiv).
  function canScore() {
    return Game.settings().autoPoints && typeof addPoints === "function" && typeof scoringActive === "function" && scoringActive();
  }

  // Jediný zápis bodů kola: každý tým s kladnými body jednou, vzestupně podle indexu (pořadí res.teams).
  function awardPoints(res) {
    if (!canScore()) return;
    res.teams
      .filter((t) => Number.isInteger(t.team) && Number.isSafeInteger(t.points) && t.points > 0)
      .forEach((t) => addPoints(t.team, t.points));
  }

  // Vyhodnocení po odhalení. Druhé tally() téhož kola vrací null, takže body nevzniknou dvakrát ani při opakovaném
  // volání. Výsledek si drží herní vrstva (answers.result()), odtud ho bere snímek hráčů i pruh na TV.
  function onRevealed() {
    const q = questionNow();
    const base = typeof questionPoints === "function" ? questionPoints() : 1;
    const res = answers.tally(Game.players(), q ? q.correct : null, base);
    if (res) {
      awardPoints(res);
      return;
    }
    // Bez výsledku (např. otázka bez platné správné odpovědi) by kolo zůstalo „uzavřené“ a zámek změny týmu
    // by trval až do další otázky; zruší se bez bodů. Značka kola zůstává, takže se pro otázku znovu neotevře.
    if (answers.running()) answers.cancel();
  }

  // Otázka je odhalená (automaticky, moderátorem nebo jinou cestou): příjem se zavře a kolo se jednou vyhodnotí.
  function finishRevealed() {
    cancelTimers();
    const round = answers.round();
    if (!answers.running() || evaluatedRound === round.round) return false;
    answers.close("reveal");
    evaluatedRound = round.round;
    onRevealed();
    return true;
  }

  /* ---------- Srovnání kola s obrazovkou ---------- */
  // Vrací true, když se kolo změnilo.
  function syncPlaying() {
    let changed = false;
    if (!roundIsCurrent() && cancelRound()) changed = true;
    if (canOpen()) {
      openRound();
      changed = true;
    }
    if (!roundIsCurrent()) return changed;
    if (questionNow().revealed) return finishRevealed() || changed;
    if (answers.round().status === "open" && answers.allAnswered(expectedIds())) {
      clearTimeout(limitTimer);
      limitTimer = null;
      answers.close("all");
      changed = true;
    }
    if (answers.round().status === "closed") scheduleReveal();
    return changed;
  }

  function sync() {
    clearTimeout(syncTimer);
    syncTimer = null;
    runSafely(() => {
      const changed = playable() ? syncPlaying() : cancelRound();
      if (changed) Game.refresh();
    }, "při srovnání kola s obrazovkou");
  }
  function scheduleSync() {
    if (!syncTimer) syncTimer = setTimeout(sync, SYNC_DELAY_MS);
  }

  /* ---------- Obal pick ---------- */
  // Obal pick() z app.js (už obaleného v tv-remote.js a tv-buzz.js). V kole odpovědí moderátor za tým nevybírá:
  // OK ovladače, klik i A/B/C z mobilu ovladače jen ukážou správnou odpověď přes reveal(). Původní pick by
  // s jedním týmem v tv-remote.js přičetl bod podruhé a průběh v archivu by ukázal volbu moderátora jako odpověď týmu.
  // Mimo kolo (jiný režim, archiv, otázka bez kola) volá původní funkci beze změny.
  function wrapPick() {
    if (typeof pick !== "function" || typeof currentQ !== "function") return;
    const basePick = pick;
    window.pick = function () {
      const q = questionNow();
      const inRound = playable() && roundIsCurrent() && answers.running() && !!q && !q.revealed;
      if (!inRound || typeof reveal !== "function") return basePick.apply(this, arguments);
      reveal();
      sync(); // vyhodnocení a body hned, ne až po debounce
      return undefined;
    };
  }

  /* ---------- Sledování ---------- */
  function watchPage() {
    // Druhé observe() na stejném uzlu by přepsalo volby prvního, proto tělo (data-view) a dialogy (open)
    // sleduje každý svým observerem.
    new MutationObserver(scheduleSync).observe(document.body, { attributes: true, attributeFilter: ["data-view"] });
    new MutationObserver(scheduleSync).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open"] });
    const observer = new MutationObserver(scheduleSync);
    const watch = (id, options) => {
      const node = $(id);
      if (node) observer.observe(node, options);
      else console.warn("tv-answers: chybí prvek #" + id + ", jeho změny kolo odpovědí nesleduje");
    };
    ["menuPanel", "emojiPicker"].forEach((id) => watch(id, { attributes: true, attributeFilter: ["hidden"] }));
    ["teams", "answers"].forEach((id) => watch(id, { childList: true }));
    Game.onChange(scheduleSync);
  }

  wrapPick();
  Game.hooks.onAnswer = scheduleSync;
  watchPage();
  scheduleSync();
})();
