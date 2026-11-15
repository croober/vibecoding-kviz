// TV nadstavba, část ovládání dálkovým ovladačem. V kvízu: ↑↓ mezi odpověďmi (nahoře tlačítko v záhlaví, dole nastavení), ←→ otázky,
// OK potvrdí; čísla 1–4 (0 = všichni) vyberou tým (znovu = zrušit), ↑↓ nebo kanál ▲▼ mu pak přidá/odebere bod; → na neodhalené otázce chce potvrzení. Jinde: prostorová navigace šipek.
// Vkládá se jen do APK (android-tv/prepare.mjs), webová verze ji nenačítá; public/ se nemění.
//
// Spoléhá na věci z app.js (při jejich změně zkontrolovat tenhle soubor):
//   globály: state, addPoints, questionPoints, scoringActive, closeMenu, closeEmojiPicker, closeSuggest, confirmDialog,
//            bubbleTimer, swapBubble, startBubbles (bubliny s tématy)
//   odpovědi: #answers .answer .letter (písmeno A/B/C se v TV přepíše na číslo)
//   funkce:  pick (obalí se kvůli automatickým bodům při jednom týmu), currentQ, showError (hláška nad lištou týmů), replayEntry(id) a seznam archive (rychlé „Hrát znovu“)
//   prvky:   #barSettings, .topbar-actions, #topicBubbles (.bubble), .topic-row, #menuBtn, #menuPanel, #menuTvSettings, #emojiPicker, #topic, #topicSuggest, #teams, .scoreboard
//   třídy:   .team, .answer, .side-btn, body.close-head
// Vystavuje window.KvizTvRemote = { handleBack, isField, confirmField } pro tv-link.js (mobilní ovládání).
(() => {
  "use strict";
  if (!window.KvizTv || !window.KvizTvCore) return; // jen v TV režimu (APK)
  const { pickNext, scrollTarget, keyId, digitOf, isChannelKey, isMenuKey } = window.KvizTvCore;
  const $ = (id) => document.getElementById(id);
  const appState = () => (typeof state !== "undefined" ? state : {});

  // běžící kvíz v malém zobrazení týmů: tady šipky nemění fokus mezi týmy, týmy se vybírají čísly
  const quizMode = () => appState().view === "quiz" && !appState().bigTeams;

  // Neutrální místo pro fokus: po překreslení otázky (odpovědi se přestaví) fokus nepadá na první tlačítko v záhlaví;
  // šipka dolů odtud jde na první odpověď. Mimo navigaci (tabindex -1), bez viditelného rámečku.
  const anchor = document.createElement("div");
  anchor.id = "tvAnchor";
  anchor.tabIndex = -1;
  document.body.appendChild(anchor);
  const isIdle = (n) => !n || n === document.body || n === anchor;
  function parkFocus() {
    if (appState().view !== "quiz" || appState().bigTeams) return;
    if (document.querySelector("dialog[open]") || !$("menuPanel").hidden || !$("emojiPicker").hidden) return;
    if (isIdle(document.activeElement)) anchor.focus({ preventScroll: true });
  }

  /* ---------- Fokusovatelné prvky a prostorová navigace ---------- */
  const FOCUSABLE = 'button, a[href], input, select, textarea, summary, [tabindex], [role="menuitem"]';

  // nativní modální dialog > otevřené menu > výběr emoji > celá stránka
  function getScope() {
    const dlg = document.querySelector("dialog[open]");
    if (dlg) return dlg;
    if (!$("menuPanel").hidden) return $("menuPanel");
    if (!$("emojiPicker").hidden) return $("emojiPicker");
    return document.body;
  }

  // skryté vstupy (radio, přepínače) mají vlastní vzhled v okolním štítku, ten se použije pro polohu
  const rectOf = (n) => {
    const target = n.matches('input[type="radio"], input[type="checkbox"]') ? n.closest("label") || n.parentElement || n : n;
    return target.getBoundingClientRect();
  };

  function focusables(scope) {
    const list = [];
    scope.querySelectorAll(FOCUSABLE).forEach((n) => {
      if (n.disabled || n.tabIndex < 0 || n.type === "hidden") return;
      if (n.closest("[hidden], [inert]") || n.closest("dialog:not([open])")) return;
      if (quizMode() && n.classList.contains("team")) return;
      const r = rectOf(n);
      if (r.width < 2 || r.height < 2) return;
      const cs = getComputedStyle(n);
      if (cs.visibility === "hidden" || cs.display === "none") return;
      list.push({ el: n, rect: r });
    });
    return list;
  }

  const readingOrder = (a, b) => (Math.abs(a.rect.top - b.rect.top) > 20 ? a.rect.top - b.rect.top : a.rect.left - b.rect.left);

  // kam se dostane fokus, když zatím nikde není
  function defaultTarget(items, dir, scope) {
    return items.slice().sort(readingOrder)[0].el;
  }

  // nejbližší posuvný kontejner (od prvku nahoru, jinak dialog / <main>)
  function scroller(from, scope) {
    for (let n = from; n && n !== document.body; n = n.parentElement) {
      if (n.scrollHeight > n.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(n).overflowY)) return n;
    }
    const main = document.querySelector("main");
    return scope === document.body && main && main.scrollHeight > main.clientHeight + 1 ? main : null;
  }

  // ↑/↓ bez dalšího ovladatelného prvku posune obsah (souhrn výsledků, průběh kvízu, dlouhé dialogy); vrací true, když se posunulo
  function scrollByArrow(dir, from, scope) {
    if (dir !== "up" && dir !== "down") return false;
    const box = scroller(from, scope);
    if (!box) return false;
    const to = scrollTarget(dir, box.scrollTop, box.scrollHeight, box.clientHeight);
    if (to < 0) return false;
    box.scrollTo({ top: to });
    return true;
  }

  function moveFocus(dir) {
    const scope = getScope();
    const items = focusables(scope);
    const active = document.activeElement;
    if (!items.length) { scrollByArrow(dir, active, scope); return; }
    const hasFocus = !isIdle(active) && scope.contains(active);
    if (!hasFocus) return defaultTarget(items, dir, scope).focus();
    const cur = items.find((i) => i.el === active) || { el: active, rect: rectOf(active) };
    const idx = pickNext(items.map((i) => i.rect), cur.rect, dir);
    if (idx >= 0) items[idx].el.focus();
    else scrollByArrow(dir, active, scope);
  }

  const isTextInput = (n) =>
    !!n && n.tagName === "INPUT" && !/^(radio|checkbox|button|submit|reset|range|file|color)$/.test(n.type);
  const isField = (n) => isTextInput(n) || (!!n && n.tagName === "TEXTAREA");

  /* ---------- Textová pole: editace až na OK ---------- */
  // Virtuální klávesnice pohlcuje šipky ovladače, proto pole při fokusu klávesnici nevyvolá (readonly):
  // OK pole otevře k psaní, Enter (Hotovo) editaci ukončí a šipky zase přepínají prvky.
  let editing = null;
  let switching = false; // blur/focus při přepnutí editace nesmí editaci hned zrušit
  const isEditing = (n) => !!n && n === editing;
  function lockField(n) {
    n.readOnly = true;
    n.setAttribute("inputmode", "none");
  }
  function refocus(n) { // blur schová klávesnici (a zavře našeptávač), fokus zůstane na poli
    switching = true;
    n.blur();
    n.focus();
    switching = false;
    if (n === $("topic") && n.value) n.dispatchEvent(new Event("input", { bubbles: true })); // znovu nabídne našeptávač
  }
  // „Hotovo“ z mobilu: jako Enter při editaci (pole se zamkne, našeptávač se zavře), ale bez znovunabídnutí našeptávače.
  function confirmField(n) {
    if (editing === n) editing = null;
    lockField(n);
    switching = true;
    n.blur();
    n.focus();
    switching = false;
  }
  function startEdit(n) {
    editing = n;
    n.readOnly = false;
    n.setAttribute("inputmode", n.type === "number" ? "numeric" : "text");
    switching = true;
    n.blur();
    n.focus();
    switching = false;
    if (navigator.virtualKeyboard && navigator.virtualKeyboard.show) navigator.virtualKeyboard.show();
    try { const l = n.value.length; if (n.setSelectionRange && n.type !== "number") n.setSelectionRange(l, l); } catch (err) { /* pole bez výběru */ }
  }
  function endEdit(n) {
    if (editing !== n) return;
    editing = null;
    lockField(n);
    refocus(n);
  }
  document.addEventListener("focusin", (e) => {
    const n = e.target;
    if (isField(n) && n !== editing) lockField(n);
  }, true);
  document.addEventListener("focusout", (e) => {
    if (!switching && e.target === editing) { editing = null; lockField(e.target); }
  }, true);

  // ← / → v kvízu nechat na app.js (předchozí / další otázka), pokud fokus není na týmech ani jinde
  function passesToApp(dir, active) {
    if (dir !== "left" && dir !== "right") return false;
    const s = appState();
    if (s.view !== "quiz" || s.bigTeams || document.querySelector("dialog[open]")) return false;
    if (!$("menuPanel").hidden || !$("emojiPicker").hidden) return false;
    return isIdle(active) || active.matches(".answer, .side-btn");
  }

  // kvíz: ↑↓ projde seznam [tlačítko v záhlaví, odpovědi…, nastavení dole]; ←→ zůstává pro otázky
  function quizVertical(dir) {
    const items = focusables(document.body);
    const pick = (sel) => items.filter((i) => i.el.matches(sel)).map((i) => i.el);
    const answers = pick("#answers .answer");
    const head = pick(".topbar-actions button")[0];
    const gear = pick("#barSettings")[0];
    const list = [head, ...answers, gear].filter(Boolean);
    if (!list.length) return;
    const active = document.activeElement;
    let i = list.indexOf(active);
    if (i < 0 && active && active.closest && active.closest(".topbar-actions")) i = 0;
    const target = i < 0
      ? (dir === "down" ? answers[0] || list[0] : head || list[0])
      : list[Math.max(0, Math.min(list.length - 1, i + (dir === "down" ? 1 : -1)))];
    if (target) target.focus();
  }

  // otázka, která se ještě nevyhodnotila (běžící kvíz); → na ní chce potvrzení
  function unanswered() {
    const q = typeof currentQ === "function" ? currentQ() : null;
    return !!q && !q.revealed && !appState().locked;
  }
  function askSkip() {
    confirmDialog({ icon: "⏭️", title: "Přejít dál bez odpovědi?", text: "Otázka ještě nebyla vyhodnocena.", ok: "Přejít dál" }).then((ok) => {
      if (ok) synthKey("ArrowRight", "ArrowRight"); // vlastní událost TV skript přeskočí, obslouží ji app.js
    });
  }

  function onArrow(e, dir) {
    const active = document.activeElement;
    // našeptávač témat si šipky nahoru/dolů obsluhuje sám
    if (active === $("topic") && !$("topicSuggest").hidden && (dir === "up" || dir === "down")) return;
    if (active && active.tagName === "SELECT") return;
    if (isEditing(active) && (dir === "left" || dir === "right")) return; // pohyb kurzoru při psaní
    if ((dir === "up" || dir === "down") && quizMode() && sel !== -1 && getScope() === document.body) {
      e.preventDefault(); // vybraný tým: ↑ přidá a ↓ odebere bod (OK, Zpět nebo znovu stejné číslo výběr zruší)
      e.stopImmediatePropagation();
      if (!e.repeat && scoringActive()) awardPoints(dir === "up" ? 1 : -1);
      return;
    }
    if (dir === "right" && passesToApp(dir, active) && unanswered()) { // → na neodhalené otázce: potvrdit
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat) askSkip();
      return;
    }
    if (passesToApp(dir, active)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if ((dir === "up" || dir === "down") && getScope() === document.body && quizMode()) return quizVertical(dir);
    moveFocus(dir);
  }

  /* ---------- OK ---------- */
  const ACTIVATABLE = 'button, a[href], [role="menuitem"], [tabindex], summary, label, input[type="radio"], input[type="checkbox"]';
  const teamIndex = (card) => Array.prototype.indexOf.call($("teams").children, card);

  // Výběr týmu pro body: číslo 1–4 (0 = všichni), kanál ▲/▼ pak přidá/odebere bod. Vybraný tým je výrazně zvýrazněný.
  let sel = -1; // index týmu, "all", nebo -1
  function applySelection() {
    const cards = $("teams").children;
    if (!quizMode() || (sel !== "all" && sel >= cards.length)) sel = -1;
    Array.prototype.forEach.call(cards, (c, i) => c.classList.toggle("tv-selected", sel === "all" || sel === i));
  }
  function awardPoints(sign) {
    if (sel === -1 && $("teams").children.length === 1) return addPoints(0, sign * questionPoints()); // jediný tým je vždy ten správný, výběr se nenastavuje
    if (sel === -1) {
      if (typeof showError === "function") showError("Nejdřív vyber tým číslem 1–4 (0 = všichni týmy).");
      return;
    }
    addPoints(sel, sign * questionPoints()); // překreslí lištu, výběr se vrátí přes applySelection
  }

  function onEnter(e) {
    const active = document.activeElement;
    if (quizMode() && sel !== -1 && !document.querySelector("dialog[open]") && $("menuPanel").hidden && !isField(active)) {
      e.preventDefault(); // OK při vybraném týmu jen zruší výběr (↑/↓ pak zase vybírají odpovědi)
      e.stopImmediatePropagation();
      if (!e.repeat) { sel = -1; applySelection(); }
      return;
    }
    const onTeam = active && active.classList && active.classList.contains("team") && !appState().bigTeams;
    if (onTeam) { // mimo kvíz klik na kartu otevře nastavení týmů jako dotyk
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat) active.click();
      return;
    }
    if (active && active.tagName === "SELECT") return; // nativní chování výběru
    if (isField(active)) {
      // vybraná položka našeptávače: nechat app.js (vybere ji)
      if (active === $("topic") && !$("topicSuggest").hidden && $("topicSuggest").querySelector(".suggest-item.active")) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      if (isEditing(active)) endEdit(active); else startEdit(active);
      return;
    }
    // Podržení OK televize bere jako systémovou zkratku (otevře nastavení aplikace) – opakování proto spolknout
    if (e.repeat) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (isIdle(active)) return; // bez fokusu: app.js (ukázat odpověď / další)
    // odpověď už je vyhodnocená: OK jde na další otázku (i když fokus zůstal na tlačítku odpovědi)
    if (active.matches(".answer") && appState().view === "quiz" && !appState().bigTeams && !unanswered()) {
      e.preventDefault();
      e.stopImmediatePropagation();
      anchor.focus({ preventScroll: true });
      synthKey("Enter", "Enter");
      return;
    }
    if (active.matches(ACTIVATABLE)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      active.click();
    }
  }

  const isOkKey = (e) => e.key === "Enter" || keyId(e) === "kc23";

  // vlastní (přeložené) události se nesmí znovu zpracovat tímto skriptem
  const synthKey = (key, code) => {
    const ev = new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true });
    ev.tvSynthetic = true;
    (document.activeElement || document.body).dispatchEvent(ev);
  };

  // čísla: 1–4 vyberou tým, 0 všechny týmy (jen v běžícím kvízu; jinde se spolknou, ať nespustí nic z app.js)
  function onDigit(e, d) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat || !quizMode()) return;
    if (!$("teams").children.length) { // bez týmů čísla 1–3 vybírají odpovědi podle pořadí
      const btn = d >= 1 ? $("answers").querySelectorAll(".answer")[d - 1] : null;
      if (btn && !btn.disabled && unanswered()) btn.click();
      return;
    }
    const next = d === 0 ? "all" : d <= $("teams").children.length ? d - 1 : -2;
    if (next === -2) return;
    sel = sel === next ? -1 : next; // stejné číslo podruhé výběr zruší
    if (sel !== -1 && window.KvizTvSound) window.KvizTvSound.play("select");
    applySelection();
  }

  // kanál ▲/▼: +/− bod vybranému týmu
  function onChannel(e, sign) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat || !quizMode() || !scoringActive()) return;
    awardPoints(sign);
  }

  window.addEventListener("keydown", (e) => {
    if (e.tvSynthetic || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isMenuKey(e)) { // tlačítko Menu na ovladači = menu aplikace
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      if ($("menuPanel").hidden) { if ($("menuBtn").offsetParent !== null || document.body.dataset.view !== "quiz") $("menuBtn").click(); }
      else { closeMenu(); $("menuBtn").focus(); }
      return;
    }
    const digit = digitOf(e);
    const typing = isEditing(document.activeElement);
    const free = !typing && !document.querySelector("dialog[open]") && $("menuPanel").hidden && $("emojiPicker").hidden;
    const ch = isChannelKey(e);
    if (ch && free) return onChannel(e, ch);
    if (digit !== null && free) return onDigit(e, digit);
    const dir = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" }[e.key];
    if (dir) onArrow(e, dir);
    else if (isOkKey(e)) onEnter(e);
  }, true);

  // logo je odkaz, v navigaci jen překáží (horní řada má být menu)
  const brand = $("brand");
  if (brand) brand.tabIndex = -1;

  // u odpovědí číslo místo písmene (pořadí; odpověď se vybírá šipkami a OK)
  const answersBox = $("answers");
  const numberAnswers = () => answersBox.querySelectorAll(".answer .letter").forEach((l) => {
    const n = "ABC".indexOf(l.textContent.trim());
    if (n >= 0) l.textContent = String(n + 1);
  });
  new MutationObserver(() => { numberAnswers(); parkFocus(); }).observe(answersBox, { childList: true });
  numberAnswers();

  // vysvětlivky ovládání nad lištou týmů (jen v kvízu, viz tv.css)
  const legend = document.createElement("p");
  legend.className = "tv-legend";
  // popisky tlačítek podle nastavení (vlastní tlačítko, jinak výchozí)
  const lab = (id) => (window.KvizTvKeys ? window.KvizTvKeys.labelOf(id) : "?");
  function renderLegend() {
    const b = (id) => "<b>" + lab(id) + "</b>";
    const teams = ["team1", "team2", "team3", "team4"].map(lab);
    const teamsTxt = teams.every((t, i) => t === String(i + 1)) ? "<b>1</b>–<b>4</b>" : teams.map((t) => "<b>" + t + "</b>").join(" ");
    if (!$("teams").children.length) { // bez týmů: čísla vybírají odpovědi
      legend.innerHTML = "<span>" + b("up") + " " + b("down") + " odpověď</span><span><b>1</b>–<b>3</b> odpověď číslem</span><span>" + b("ok") + " potvrdí / další</span><span>" + b("left") + " " + b("right") + " otázky</span><span>" + b("menu") + " nabídka</span>";
      return;
    }
    if ($("teams").children.length === 1) { // jeden tým: body za správnou odpověď se přičtou samy, výběr týmu odpadá
      legend.innerHTML = "<span>" + b("up") + " " + b("down") + " odpověď</span><span>" + b("ok") + " potvrdí / další</span><span>" + b("left") + " " + b("right") + " otázky</span><span>správná odpověď = body automaticky · " + b("plus") + " " + b("minus") + " ± bod ručně</span><span>" + b("menu") + " nabídka</span>";
      return;
    }
    legend.innerHTML = "<span>" + b("up") + " " + b("down") + " odpověď</span><span>" + b("ok") + " potvrdí / další</span><span>" + b("left") + " " + b("right") + " otázky</span><span>" + teamsTxt + " vybrat tým (znovu = zrušit) · " + b("all") + " všichni</span><span>vybraný tým: " + b("up") + " " + b("down") + " nebo " + b("plus") + " " + b("minus") + " ± bod · " + b("ok") + " zrušit</span><span>" + b("menu") + " nabídka</span>";
  }
  renderLegend();
  window.addEventListener("kviz-tv-keys-changed", renderLegend);
  $("teams").before(legend);

  /* ---------- Jeden tým: správná odpověď přičte body sama ---------- */
  // pick() z app.js se obalí: po výběru odpovědi (poprvé u otázky) se při jediném týmu a správné odpovědi přičtou body
  // podle obtížnosti (questionPoints). Špatná odpověď ani „ukázat odpověď“ bez výběru body nemění.
  if (typeof pick === "function" && typeof currentQ === "function") {
    const origPick = pick;
    window.pick = function (key) {
      const q = currentQ();
      const wasOpen = !!q && !q.revealed && !appState().locked;
      const res = origPick.apply(this, arguments);
      if (wasOpen && q.revealed && q.picked === q.correct && appState().teams.length === 1 && scoringActive()) {
        addPoints(0, questionPoints());
      }
      return res;
    };
  }

  /* ---------- Karty týmů (mimo kvíz ovladatelné prvky, v kvízu se vybírají čísly) ---------- */
  // renderTeams() lištu při každé změně přestaví; mimo velké zobrazení je karta div (button jen na dotykovém zařízení)
  function applyTeamTabindex() {
    if (appState().bigTeams) return;
    $("teams").querySelectorAll(":scope > .team").forEach((c) => {
      if (c.tabIndex < 0) c.tabIndex = 0;
      c.setAttribute("role", "button");
    });
  }
  const onTeamsChange = () => { applyTeamTabindex(); applySelection(); renderLegend(); };
  new MutationObserver(onTeamsChange).observe($("teams"), { childList: true });
  onTeamsChange();

  /* ---------- Bubliny s tématy jako fokusovatelná nápověda ---------- */
  // plují a vyměňují se, takže při fokusu se pohyb zastaví; po odchodu fokusu se obnoví
  const bubbleBox = $("topicBubbles");
  const bubbleFocused = () => !!(document.activeElement && bubbleBox.contains(document.activeElement));
  let bubblesPaused = false;
  function pauseBubbles() {
    if (bubblesPaused) return;
    bubblesPaused = true;
    clearInterval(bubbleTimer);
    bubbleTimer = null;
    bubbleBox.classList.add("paused");
  }
  function resumeBubbles() {
    if (!bubblesPaused) return;
    bubblesPaused = false;
    bubbleBox.classList.remove("paused");
    // jen když zadání s bublinami pořád běží (jinak je stopBubbles vyprázdnil)
    if (!bubbleTimer && bubbleBox.children.length && appState().view === "setup") bubbleTimer = setInterval(swapBubble, 3200);
  }
  bubbleBox.addEventListener("focusin", pauseBubbles);
  bubbleBox.addEventListener("focusout", () => setTimeout(() => { if (!bubbleFocused()) resumeBubbles(); }, 0));
  const syncBubbles = () => {
    const W = bubbleBox.clientWidth;
    bubbleBox.querySelectorAll(".bubble").forEach((b) => {
      if (b.tabIndex < 0) b.tabIndex = 0;
      // pojistka: střed bubliny drží tak, aby se celá (i s plutím a zvětšením při fokusu) vešla do plochy
      const half = b.offsetWidth * 0.55 + 24, x = parseFloat(b.style.left);
      if (W > 0 && half * 2 < W && x > W - half) b.style.left = W - half + "px";
    });
    if (bubblesPaused && !bubbleFocused()) resumeBubbles(); // fokusovaná bublina zanikla
  };
  new MutationObserver(syncBubbles).observe(bubbleBox, { childList: true });
  syncBubbles(); // bubliny mohly vzniknout dřív, než se tenhle skript načetl
  // bubliny se rozmisťují podle šířky plochy v okamžiku vytvoření; na TV se rozměr okna (široký viewport) a písmo ustálí až po startu,
  // takže pravé bubliny pak ční za okraj. Při změně šířky plochy nebo po načtení písma se proto rozmístí znovu.
  let bubbleW = 0, bubbleRelayout = null;
  function relayoutBubbles() {
    clearTimeout(bubbleRelayout);
    bubbleRelayout = setTimeout(() => {
      if (appState().view !== "setup" || bubblesPaused || bubbleFocused() || document.querySelector("dialog[open]")) return;
      if (typeof startBubbles === "function" && bubbleBox.children.length) startBubbles();
    }, 300);
  }
  if (window.ResizeObserver) {
    new ResizeObserver(() => {
      const w = Math.round(bubbleBox.clientWidth);
      if (bubbleW && Math.abs(w - bubbleW) > 2) relayoutBubbles();
      bubbleW = w;
    }).observe(bubbleBox);
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(relayoutBubbles);

  const hint = document.createElement("p");
  hint.className = "muted tv-bubble-hint simple-only";
  hint.textContent = "↓ nápady na témata · OK vybere";
  const topicRow = document.querySelector(".topic-row");
  if (topicRow) topicRow.after(hint);

  /* ---------- Rychlé „Hrát znovu“ na úvodní obrazovce ---------- */
  // tlačítko s posledním kvízem z archivu: OK → stejný dialog jako „Hrát znovu“ v archivu (nové otázky / jiné pořadí), bez psaní
  const replayBtn = document.createElement("button");
  replayBtn.type = "button";
  replayBtn.id = "tvReplay";
  replayBtn.className = "btn ghost simple-only tv-replay";
  replayBtn.hidden = true;
  replayBtn.innerHTML = '<i class="ph ph-arrows-clockwise" aria-hidden="true"></i> <span></span>';
  function lastEntry() {
    const list = typeof archive !== "undefined" && Array.isArray(archive) ? archive : [];
    const real = list.filter((e) => e.source !== "demo"); // ukázkové kvízy až když nic jiného není
    const pool = real.length ? real : list;
    return pool.reduce((a, b) => (!a || (b.createdAt || 0) > (a.createdAt || 0) ? b : a), null);
  }
  function renderReplay() {
    const e = lastEntry();
    replayBtn.hidden = !e;
    replayBtn.dataset.id = e ? e.id : "";
    if (e) replayBtn.querySelector("span").textContent = "Hrát znovu: " + e.topic.replace(/s*(ukázkový kvíz)s*$/, "");
  }
  replayBtn.addEventListener("click", () => {
    if (replayBtn.dataset.id && typeof replayEntry === "function") replayEntry(replayBtn.dataset.id);
  });
  hint.after(replayBtn);
  renderReplay();
  new MutationObserver(renderReplay).observe(document.body, { attributes: true, attributeFilter: ["data-view"] });

  /* ---------- Tlačítko Zpět ---------- */
  function exitApp() {
    const App = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (App && App.exitApp) App.exitApp();
    else window.close();
  }

  function handleBack() {
    if (window.KvizTvKeys && window.KvizTvKeys.onBack()) return; // nastavení tlačítek: Zpět ruší probíhající přiřazování
    if (editing) return endEdit(editing);
    if (quizMode() && sel !== -1 && !document.querySelector("dialog[open]") && $("menuPanel").hidden) { sel = -1; return applySelection(); }
    const dlg = document.querySelector("dialog[open]");
    if (dlg) return dlg.close("cancel");
    if (!$("emojiPicker").hidden) return closeEmojiPicker();
    if (!$("menuPanel").hidden) { closeMenu(); return $("menuBtn").focus(); }
    if (!$("topicSuggest").hidden) return closeSuggest();
    const act = document.activeElement;
    if (act && act.classList && act.classList.contains("bubble")) return $("topic").focus();
    const s = appState();
    // stavy, které umí Esc v app.js: velké týmy, archivní kvíz, archiv, běžící kvíz (s potvrzením)
    if (s.bigTeams || s.locked || s.view === "archive" || document.body.classList.contains("close-head")) {
      return document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    }
    confirmDialog({ icon: "📺", title: "Ukončit aplikaci?", ok: "Ukončit", danger: true }).then((ok) => { if (ok) exitApp(); });
  }

  const capApp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (capApp && capApp.addListener) capApp.addListener("backButton", handleBack);

  // pro mobilní ovládání (tv-link.js): Zpět z mobilu jde stejnou cestou jako z ovladače
  window.KvizTvRemote = { handleBack, isField, confirmField };
})();
