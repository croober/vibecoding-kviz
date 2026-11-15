// TV nadstavba, část přípravy hry: pamatuje si zadání z minula (počet otázek, obtížnost) a před novým kvízem se zeptá, kolik týmů hraje.
// Vkládá se jen do APK (android-tv/prepare.mjs) za tv-remote.js; public/ se nemění (obrázkový režim si app.js pamatuje sám).
//
// Spoléhá na věci z app.js: globály state, setCount, renderTeams, save, logTeams, ANIMALS, MIN_TEAMS, MAX_TEAMS;
//   prvky #setupForm, #count, #countChips, input[name="level"]; state.quiz.archiveId.
(() => {
  "use strict";
  if (!window.KvizTv || !window.KvizTvCore) return; // jen v TV režimu (APK)
  const $ = (id) => document.getElementById(id);
  const store = window.KvizTv.store;
  const appState = () => (typeof state !== "undefined" ? state : {});

  /* ---------- Pamatovat si zadání z minula ---------- */
  const SETUP_KEY = "kviz-tv-setup";
  const form = $("setupForm");

  function loadSetup() {
    try { return JSON.parse(store.get(SETUP_KEY)) || {}; } catch { return {}; }
  }
  function saveSetup() {
    const level = form.querySelector('input[name="level"]:checked');
    store.set(SETUP_KEY, JSON.stringify({ count: Number($("count").value) || undefined, level: level ? level.value : undefined }));
  }
  function applySetup() {
    const s = loadSetup();
    if (s.count && typeof setCount === "function") setCount(s.count);
    if (s.level) {
      const radio = form.querySelector('input[name="level"][value="' + s.level + '"]');
      if (radio) radio.checked = true;
    }
  }
  applySetup();
  // chipy a tlačítka +/− mění hodnotu bez události, proto se po každém kliknutí i změně zadání uloží aktuální stav
  form.addEventListener("click", () => setTimeout(saveSetup, 0));
  form.addEventListener("change", () => setTimeout(saveSetup, 0));
  form.addEventListener("submit", saveSetup, true);

  /* ---------- Kolik týmů hraje? ---------- */
  // před každým novým kvízem (poprvé, co se objeví jeho první otázka); rozehraný nebo archivní kvíz se neptá
  const ASKED_KEY = "kviz-tv-teams-asked";
  const dlg = document.createElement("dialog");
  dlg.id = "tvTeamsDialog";
  dlg.className = "dialog help";
  dlg.innerHTML = `
    <div class="dialog-head"><h3>Kolik týmů hraje?</h3></div>
    <p class="muted extra-hint">Vyber počet týmů. Názvy a ikony jdou změnit v nastavení. Zpět nechá týmy, jak jsou.</p>
    <div class="tv-team-count" id="tvTeamCount"></div>`;
  document.body.appendChild(dlg);
  const box = $("tvTeamCount");
  [[0, "Bez týmů"], [1, "1 tým"], [2, "2 týmy"], [3, "3 týmy"], [4, "4 týmy"]].forEach(([n, text]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn ghost";
    b.dataset.n = String(n);
    b.textContent = text;
    b.addEventListener("click", () => { setTeamCount(n); dlg.close("ok"); });
    box.appendChild(b);
  });

  // upraví počet týmů: nadbytečné ubere od konce, chybějící přidá s dalšími volnými zvířaty (body zůstávají)
  function setTeamCount(n) {
    const s = appState();
    n = Math.max(MIN_TEAMS, Math.min(MAX_TEAMS, n));
    while (s.teams.length > n) logTeams("remove", s.teams.pop());
    while (s.teams.length < n) {
      const used = new Set(s.teams.map((t) => t.emoji));
      const animal = ANIMALS.find((a) => !used.has(a.emoji));
      if (!animal) break;
      s.teams.push({ ...animal, score: 0 });
      logTeams("add", s.teams[s.teams.length - 1]);
    }
    renderTeams();
    save();
  }

  function isFreshQuiz() {
    const s = appState();
    return s.view === "quiz" && !s.locked && !!s.quiz && s.index === 0 && !s.quiz.questions.some((q) => q.revealed);
  }
  function maybeAskTeams() {
    const s = appState();
    if (!isFreshQuiz() || !s.quiz.archiveId || dlg.open || document.querySelector("dialog[open]")) return;
    if (store.get(ASKED_KEY) === s.quiz.archiveId) return; // pro tenhle kvíz už se ptali
    store.set(ASKED_KEY, s.quiz.archiveId);
    const n = s.teams.length;
    dlg.showModal();
    const current = box.querySelector('[data-n="' + n + '"]');
    box.querySelectorAll("button").forEach((b) => b.classList.toggle("tv-current", b === current));
    if (current) current.focus();
  }
  new MutationObserver(() => setTimeout(maybeAskTeams, 0)).observe(document.body, { attributes: true, attributeFilter: ["data-view"] });
  setTimeout(maybeAskTeams, 0);

  window.KvizTvSetup = { setTeamCount, loadSetup, applySetup };
})();
