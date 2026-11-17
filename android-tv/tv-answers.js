// TV nadstavba, kolo odpovědí na mobilech: podle toho, co je právě na televizi, otevírá kolo herní vrstvy
// (KvizTvGame.answers), hlídá odpočet, zavře příjem po vypršení limitu nebo po hlasu všech připojených hráčů s týmem
// a za chvíli otázku sám odhalí voláním reveal() z app.js. Po odhalení kolo jednou vyhodnotí a týmům přičte body
// přes addPoints z app.js. Při odchodu z otázky kolo zruší bez bodů.
// Nad odpověďmi je pruh #tvAnswersBar: odpočet a počet odpovědí, po uzavření důvod, po odhalení hlasy a výsledek týmů.
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
    renderBar();
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
  // Návrat true znamená „kolo se změnilo“: Game.refresh() po vyhodnocení volá sync() podle toho, ne tahle funkce.
  function finishRevealed() {
    cancelTimers();
    const round = answers.round();
    if (!answers.running() || evaluatedRound === round.round) return false;
    answers.close("reveal");
    evaluatedRound = round.round;
    onRevealed();
    return true;
  }

  /* ---------- Pruh odpočtu a výsledku ---------- */
  const BAR_TICK_MS = 250;
  const MS_PER_SECOND = 1000;
  const CLOSE_TITLES = { time: "Čas vypršel", all: "Všichni odpověděli" };
  let barTicker = null; // obnova odpočtu, běží jen ve stavu open

  // Pruh je sourozenec těsně před #answers (app.js přestavuje jen děti #answers, pruh přežije).
  function createBar() {
    const bar = document.createElement("div");
    bar.id = "tvAnswersBar";
    bar.className = "tv-answers-bar";
    bar.setAttribute("role", "status");
    bar.setAttribute("aria-live", "polite");
    bar.hidden = true;
    const title = document.createElement("p");
    title.className = "tv-answers-title";
    const meta = document.createElement("p");
    meta.className = "tv-answers-meta";
    const progress = document.createElement("div");
    progress.className = "tv-answers-progress";
    const teams = document.createElement("ul");
    teams.className = "tv-answers-teams";
    bar.append(title, meta, progress, teams);
    const list = $("answers");
    if (list) list.before(bar);
    else console.warn("tv-answers: chybí prvek #answers, pruh odpočtu se nezobrazí");
    return { bar, title, meta, progress, teams };
  }
  const bar = createBar();

  // Stav pruhu podle kola otázky na obrazovce; null = pruh se skrývá.
  function barState() {
    if (!playable() || !roundIsCurrent()) return null;
    const status = answers.round().status;
    if (status === "open" || status === "closed") return status;
    return status === "result" && answers.result() !== null ? "result" : null;
  }

  function stopTicker() {
    clearInterval(barTicker);
    barTicker = null;
  }

  function renderOpen() {
    const round = answers.round();
    const msLeft = Math.max(round.deadlineAt - performance.now(), 0);
    const seconds = Math.ceil(msLeft / MS_PER_SECOND);
    bar.title.textContent = "Odpovídejte na mobilech";
    bar.meta.textContent = "Zbývá " + seconds + " s · Odpovědělo " + round.count + " z " + expectedIds().length + " · OK = ukázat odpověď";
    bar.progress.style.setProperty("--left", String(round.limitMs > 0 ? Math.min(msLeft / round.limitMs, 1) : 0));
  }

  function renderClosed() {
    bar.title.textContent = CLOSE_TITLES[answers.round().closeReason] || "";
    bar.meta.textContent = "Za chvíli ukážu správnou odpověď · OK = hned";
  }

  // Názvy týmů jsou cizí text: jen textContent.
  function teamLine(res) {
    const teams = appState().teams;
    const team = Array.isArray(teams) ? teams[res.team] : null;
    const label = team ? [team.emoji, team.name].filter(Boolean).join(" ") : "";
    const answer = String(res.answer).toUpperCase();
    const item = document.createElement("li");
    item.textContent = label + ": " + answer + (res.correct ? " ✓ +" + res.points : " ✗");
    return item;
  }

  function renderResult() {
    const res = answers.result();
    const v = res.votes;
    bar.title.textContent = v.a + v.b + v.c === 0 ? "Nikdo neodpověděl" : "Hlasy: A " + v.a + " · B " + v.b + " · C " + v.c;
    bar.meta.textContent = "";
    bar.teams.replaceChildren(...res.teams.map(teamLine));
  }

  // Vyplní pruh podle kola; volá se po každém srovnání, změně herní vrstvy a každých 250 ms ve stavu open.
  function renderBar() {
    const kind = barState();
    bar.bar.hidden = kind === null;
    if (kind === null) {
      stopTicker();
      return;
    }
    bar.bar.dataset.state = kind;
    bar.meta.hidden = kind === "result";
    bar.teams.replaceChildren();
    if (kind === "open") {
      if (!barTicker) barTicker = setInterval(() => runSafely(renderBar, "při obnově odpočtu"), BAR_TICK_MS);
      renderOpen();
      return;
    }
    stopTicker();
    if (kind === "closed") renderClosed();
    else renderResult();
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
      renderBar();
    }, "při srovnání kola s obrazovkou");
  }
  function scheduleSync() {
    if (!syncTimer) syncTimer = setTimeout(sync, SYNC_DELAY_MS);
  }

  /* ---------- Obal pick ---------- */
  // Obal pick() z app.js (už obaleného v tv-remote.js a tv-buzz.js). V kole odpovědí moderátor za tým nevybírá:
  // OK ovladače, klik i A/B/C z mobilu ovladače jen ukážou správnou odpověď přes reveal(). Původní pick by
  // s jedním týmem v tv-remote.js přičetl bod podruhé a průběh v archivu by ukázal volbu moderátora jako odpověď týmu.
  // Mimo kolo (jiný režim, archiv, otázka bez kola) volá původní funkci beze změny. V kole bez reveal() se neudělá nic,
  // původní pick by bod přičetl podruhé.
  function wrapPick() {
    if (typeof pick !== "function" || typeof currentQ !== "function") return;
    const basePick = pick;
    window.pick = function () {
      const q = questionNow();
      const inRound = playable() && roundIsCurrent() && answers.running() && !!q && !q.revealed;
      if (!inRound) return basePick.apply(this, arguments);
      if (typeof reveal !== "function") return undefined;
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
