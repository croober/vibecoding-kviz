// TV nadstavba: zvuková odezva (správná / špatná odpověď, body, další otázka, výsledky, chyba, bzučák…). Zvuky se syntetizují přes Web Audio API,
// takže nepotřebují soubory ani licence. Vkládá se jen do APK (android-tv/prepare.mjs) před tv-keys.js; public/ se nemění.
//
// Spoléhá na věci z app.js: globály state, logEvent (obalí se; události pick, reveal, points, question, results), showError;
//   atribut body[data-view] (loading → quiz = kvíz je připravený).
// Nastavení (úroveň hlasitosti) je v localStorage `kviz-tv-sound`, mění se v menu Ovládání TV.
(() => {
  "use strict";
  if (!window.KvizTv) return; // jen v TV režimu (APK)
  const store = window.KvizTv.store;
  const appState = () => (typeof state !== "undefined" ? state : {});

  /* ---------- Hlasitost ---------- */
  const KEY = "kviz-tv-sound";
  const LEVELS = [
    { id: 0, name: "vypnuto", gain: 0 },
    { id: 1, name: "tiše", gain: 0.25 },
    { id: 2, name: "středně", gain: 0.55 },
    { id: 3, name: "hlasitě", gain: 1 },
  ];
  const DEFAULT_LEVEL = 2;
  function getLevel() {
    const n = Number(store.get(KEY));
    return n >= 0 && n < LEVELS.length && store.get(KEY) !== null && store.get(KEY) !== "" ? n : DEFAULT_LEVEL;
  }
  function setLevel(n) {
    n = Math.max(0, Math.min(LEVELS.length - 1, n));
    store.set(KEY, String(n));
    if (master) master.gain.value = LEVELS[n].gain;
    return n;
  }

  /* ---------- Zvukový kontext ---------- */
  let ctx = null, master = null;
  function audio() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = LEVELS[getLevel()].gain;
      master.connect(ctx.destination);
    } catch (e) { ctx = null; }
    return ctx;
  }
  // prohlížeč povolí zvuk až po gestu; stisk tlačítka ovladače stačí
  const unlock = () => { const c = audio(); if (c && c.state === "suspended") c.resume(); };
  window.addEventListener("keydown", unlock, true);
  window.addEventListener("pointerdown", unlock, true);

  // jeden tón: frekvence (volitelně klouže na `to`), start (s), délka (s), tvar, hlasitost
  function tone(freq, at, dur, type, vol, to) {
    const c = ctx, t0 = c.currentTime + at;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type || "sine";
    o.frequency.setValueAtTime(freq, t0);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(master);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  /* ---------- Zvuky ---------- */
  const NOTE = { c5: 523.25, e5: 659.25, g5: 783.99, a5: 880, c6: 1046.5, e6: 1318.5 };
  const SOUNDS = {
    correct: { prio: 2, play: () => { tone(NOTE.c5, 0, 0.16, "triangle", 0.5); tone(NOTE.e5, 0.1, 0.16, "triangle", 0.5); tone(NOTE.g5, 0.2, 0.34, "triangle", 0.55); } },
    wrong: { prio: 2, play: () => { tone(190, 0, 0.3, "sawtooth", 0.28, 110); tone(150, 0.12, 0.3, "sawtooth", 0.22, 90); } },
    reveal: { prio: 1, play: () => tone(560, 0, 0.14, "sine", 0.45, 320) },
    plus: { prio: 1, play: () => { tone(NOTE.a5, 0, 0.1, "triangle", 0.4); tone(NOTE.e6, 0.07, 0.18, "triangle", 0.35); } },
    minus: { prio: 1, play: () => tone(520, 0, 0.22, "triangle", 0.4, 300) },
    select: { prio: 0, play: () => tone(1100, 0, 0.05, "sine", 0.3) },
    next: { prio: 0, play: () => tone(320, 0, 0.14, "sine", 0.28, 640) },
    ready: { prio: 2, play: () => { tone(NOTE.e5, 0, 0.14, "triangle", 0.45); tone(NOTE.a5, 0.12, 0.3, "triangle", 0.5); } },
    results: { prio: 3, play: () => { [NOTE.c5, NOTE.e5, NOTE.g5, NOTE.c6].forEach((f, i) => tone(f, i * 0.14, 0.4, "triangle", 0.5)); tone(NOTE.e6, 0.6, 0.7, "triangle", 0.45); } },
    click: { prio: 0, play: () => tone(900, 0, 0.04, "sine", 0.22, 700) },
    error: { prio: 1, play: () => tone(160, 0, 0.22, "square", 0.22, 110) },
    // bzučák: dva stejně vysoké ostré pulzy (ostatní zvuky kloužou nebo stoupají), volá tv-buzz.js
    buzz: { prio: 2, play: () => { tone(740, 0, 0.12, "square", 0.3); tone(740, 0.16, 0.24, "square", 0.32); } },
  };

  // krátké zvuky nesmí přebít důležitější těsně po sobě (správná odpověď → body; kvíz hotový → první otázka)
  let lastAt = 0, lastPrio = -1, played = 0; // played: počet zvuků jiných než klik (pozná, jestli stisk už dostal vlastní zvuk)
  const bootAt = Date.now();
  function play(name, force) {
    const s = SOUNDS[name];
    if (!s || (!force && getLevel() === 0)) return;
    if (!force && Date.now() - bootAt < 1500) return; // obnova uloženého stavu po startu
    const now = Date.now();
    const isClick = name === "click";
    if (!force && now - lastAt < 450 && (isClick ? lastPrio > 0 : s.prio <= lastPrio)) return;
    const c = audio();
    if (!c) return;
    if (c.state === "suspended") c.resume();
    if (!isClick) { lastAt = now; lastPrio = s.prio; played++; } // klik na tlačítko nepřebíjí ostatní zvuky
    try { s.play(); } catch (e) { /* zvuk nikdy nesmí shodit aplikaci */ }
  }

  /* ---------- Napojení na události aplikace ---------- */
  function onEvent(type, data) {
    const s = appState();
    if (s.locked) return; // archivní kvíz je jen ke čtení
    if (type === "pick") play(data && data.correct ? "correct" : "wrong");
    else if (type === "reveal") play("reveal");
    else if (type === "points") play(data && data.delta < 0 ? "minus" : "plus");
    else if (type === "question") play("next");
    else if (type === "results") play("results");
  }
  if (typeof logEvent === "function") {
    const orig = logEvent;
    window.logEvent = function (type, data) {
      const r = orig.apply(this, arguments);
      try { onEvent(type, data); } catch (e) { /* viz výše */ }
      return r;
    };
  }
  if (typeof showError === "function") {
    const origErr = showError;
    window.showError = function () {
      try { play("error"); } catch (e) { /* viz výše */ }
      return origErr.apply(this, arguments);
    };
  }
  // kvíz je vygenerovaný: z načítání rovnou do kvízu
  let prevView = document.body.dataset.view;
  new MutationObserver(() => {
    const v = document.body.dataset.view;
    if (prevView === "loading" && v === "quiz") play("ready");
    prevView = v;
  }).observe(document.body, { attributes: true, attributeFilter: ["data-view"] });

  /* ---------- Výchozí zvuk každého stisku ---------- */
  // každý stisk tlačítka ovladače cvakne, pokud na něj nezazněl jiný (specifický) zvuk; kontrola až po obsluze stisku
  function clickUnlessSound() {
    const before = played;
    setTimeout(() => { if (played === before) play("click"); }, 0);
  }
  const isEditing = () => {
    const a = document.activeElement;
    return !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA") && !a.readOnly;
  };
  window.addEventListener("keydown", (e) => {
    if (e.repeat || e.tvSynthetic || e.tvMapped || e.ctrlKey || e.metaKey || e.altKey) return; // přeložené kopie už zvuk měly
    if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") return;
    if (isEditing() && e.key !== "Enter") return; // psaní na klávesnici televize necvaká
    clickUnlessSound();
  }, true);
  const capApp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (capApp && capApp.addListener) capApp.addListener("backButton", clickUnlessSound);

  window.KvizTvSound = { play, getLevel, setLevel, LEVELS };
})();
