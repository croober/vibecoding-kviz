// Stránka hráče: jen vstup a zobrazení. Nic nepočítá ani nerozhoduje, ukazuje snímek, který pošle televize,
// a posílá jen dvě zprávy: join (přezdívka a tým) a buzz (stisk bzučáku).
// Protokol, snímek a prvky stránky: kontrakt hráčů § 2 (zprávy), § 4 (viewFor) a § 6 (prvky, stavy, texty, úložiště).
// Kód spojení je záměrně napsaný podruhé podle mobile.js (rozhodnutí R15), společný modul se nevyčleňuje.
// Přezdívky a názvy týmů jsou cizí text: do stránky jdou jen přes textContent a style.setProperty.
(() => {
  "use strict";

  const PROTOCOL = 1;
  const RECONNECT_DELAYS = [500, 1000, 2000, 5000]; // poslední hodnota je strop
  const FAILED_AFTER = 3; // tolik pokusů po sobě bez otevření = „Nedaří se spojit“
  const NOTE_MS = 2500;
  const PENALTY_MS = 1500;
  const VIBRATE_MS = 200;
  const MAX_NAME = 16;
  const MAX_TEAMS = 4;
  const MAX_TEXT = 64; // mez délky textů ze snímku (rozvržení, ne bezpečnost)
  const MAX_PENDING = 16;
  const MAX_RESUME = 4096; // mez z kontraktu § 2 (hello.resume)
  const TEAM_COLOR = /^#[0-9a-fA-F]{3,8}$/;
  const KICK_REASON = "kicked";

  const PHASES = new Set(["off", "lobby", "wait", "armed", "answering", "closed"]);
  const RESULTS = new Set(["correct", "wrong"]);
  const CHANGE_PHASES = new Set(["lobby", "closed"]);
  const NEUTRAL_BUZZ = { canBuzz: false, team: null, by: null, mine: false, teamLocked: false, result: null };

  const $ = (id) => document.getElementById(id);
  const el = {
    app: $("app"), noToken: $("no-token"),
    status: $("status"), connIcon: $("conn-icon"), connText: $("conn-text"),
    ctxText: $("ctx-text"), connHint: $("conn-hint"),
    off: $("off"), join: $("join"), game: $("game"),
    nick: $("nick"), teamList: $("team-list"), noTeams: $("no-teams"),
    joinBtn: $("join-btn"), joinCancel: $("join-cancel"),
    meEmoji: $("me-emoji"), meTeam: $("me-team"), meName: $("me-name"), change: $("change"),
    buzz: $("buzz"), buzzTitle: $("buzz-title"), buzzSub: $("buzz-sub"),
    note: $("note"), noteText: $("note-text"),
  };

  const CONN_VIEW = {
    connecting: { icon: "ph-circle-notch spin", text: "Připojuji k televizi…" },
    open: { icon: "ph-wifi-high", text: "Připojeno" },
    lost: { icon: "ph-wifi-slash", text: "Odpojeno, zkouším znovu…" },
    failed: { icon: "ph-wifi-x", text: "Nedaří se spojit" },
    full: { icon: "ph-wifi-x", text: "Hra je plná" },
    kicked: { icon: "ph-user-minus", text: "Moderátor tě odebral ze hry" },
  };
  const CONN_HINT = {
    failed: "Mobil musí být na stejné Wi-Fi jako televize. Pokud se na televizi změnil kód, naskenuj QR znovu.",
    full: "Ke hře je připojeno moc hráčů. Zkus to za chvíli.",
    kicked: "Chceš-li hrát dál, naskenuj QR kód na televizi znovu.",
  };
  const JOIN_NOTES = {
    invalid: "Zadej přezdívku a vyber tým",
    full: "Hra je plná",
    locked: "Tým jde změnit až po téhle otázce",
    off: "Hra s hráči není zapnutá",
  };
  const BUZZ_NOTES = {
    locked: "Tvůj tým už odpovídal",
    late: "Někdo byl rychlejší",
    nojoin: "Nejdřív se připoj ke hře",
  };
  const BUZZ_TEXT = {
    lobby: ["Čekej na otázku", "Kvíz ještě neběží."],
    wait: ["Připrav se…", ""],
    armed: ["BZUČÁK", "Znáš odpověď? Mačkej!"],
    sent: ["Odesláno…", ""],
    penalty: ["Moc brzy!", "Chvilku počkej."],
    locked: ["Tvůj tým už odpovídal", "U téhle otázky už bzučet nemůžeš."],
    mine: ["Odpovídáš ty!", "Řekni odpověď nahlas."],
    closed: ["Otázka je vyhodnocená", ""],
  };
  const CLOSED_RESULT_TEXT = { correct: "Správně!", wrong: "Tentokrát ne." };
  const TEXT_TEAM_ANSWERS = "Odpovídá tvůj tým";
  const TEXT_OTHER_ANSWERS = "Odpovídá";
  const TEXT_WAITING_QUIZ = "Čekáme na kvíz";
  const LABEL_JOIN = "Připojit se";
  const LABEL_SAVE = "Uložit";

  const params = new URLSearchParams(location.search);
  const token = params.get("t"); // parametr k (klíč ovladače) hráč nečte
  if (!token) {
    el.app.hidden = true;
    el.noToken.hidden = false;
    return; // bez tokenu se nepřipojujeme
  }

  // --- úložiště (každý přístup v try/catch, stránka musí fungovat i bez něj) ---

  const storageKey = `kviz-player-${token}`;

  const isClientId = (v) => typeof v === "string" && v.length >= 8 && v.length <= 32;

  function loadStored() {
    try {
      const data = JSON.parse(localStorage.getItem(storageKey));
      if (data && isClientId(data.clientId)) return data;
    } catch { /* prázdné nebo nedostupné úložiště */ }
    return null;
  }

  function saveStored() {
    try { localStorage.setItem(storageKey, JSON.stringify(stored)); } catch { /* bez úložiště */ }
  }

  function randomId() {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  const stored = loadStored() || { clientId: randomId(), resume: null, seq: 0 };
  // Uložená data mohl změnit kdokoli s přístupem k úložišti: každé pole se ověří na typ a rozsah.
  if (!Number.isSafeInteger(stored.seq) || stored.seq < 0) stored.seq = 0;
  if (typeof stored.resume !== "string" || stored.resume.length < 1 || stored.resume.length > MAX_RESUME) stored.resume = null;
  if (typeof stored.name !== "string" || Array.from(stored.name).length > MAX_NAME) delete stored.name;
  if (!Number.isInteger(stored.team) || stored.team < 0 || stored.team >= MAX_TEAMS) delete stored.team;
  saveStored();

  // --- stav ---

  let socket = null;
  let connState = "connecting"; // connecting | open | lost | failed | full | kicked (konečný stav, bez dalších pokusů)
  let welcomed = false;
  let failures = 0;
  let reconnectTimer = null;
  let noteTimer = null;
  let penaltyTimer = null;
  let snapshot = null; // poslední platný snímek (už ověřený normalizeSnapshot)
  let lastRev = -1;
  let changing = false; // hráč stiskl „Změnit tým“
  let formDirty = false; // hráč formulář upravil, předvyplnění ho už nesmí přepsat
  let selectedTeam = null;
  let teamsKey = "";
  let autoJoinSent = false; // automatický join nejvýš jednou na spojení
  let localBuzz = null; // { kind: "sent" | "penalty", index } – místní stav bzučáku
  let lastBuzzState = null;
  const pending = new Map(); // seq → { kind: "join" | "buzz", name?, team? } kvůli hláškám k ack

  // --- ověření snímku (televize je důvěryhodná jen do té míry, že snímek nesmí shodit stránku) ---

  const isIndex = (v, count) => Number.isInteger(v) && v >= 0 && v < count;
  const isCount = (v) => Number.isInteger(v) && v >= 0;
  const text = (v) => String(v).slice(0, MAX_TEXT);
  // Hodnotu z mapy textů jen z jejích vlastních klíčů (klíč přichází z televize).
  const lookup = (map, key) => (typeof key === "string" && Object.hasOwn(map, key) ? map[key] : undefined);
  // Zápis do živé oblasti (aria-live) jen při změně, ať čtečka nehlásí totéž dokola.
  function setText(node, value) {
    if (node.textContent !== value) node.textContent = value;
  }

  function normalizeTeams(raw) {
    if (!Array.isArray(raw)) return null;
    const teams = [];
    for (const t of raw.slice(0, MAX_TEAMS)) {
      if (!t || typeof t.name !== "string" || typeof t.emoji !== "string" || typeof t.color !== "string") return null;
      // Neplatná barva se nepoužije (prázdný řetězec), tým se zobrazí bez ní.
      teams.push({ name: text(t.name), emoji: text(t.emoji), color: TEAM_COLOR.test(t.color) ? t.color : "" });
    }
    return teams;
  }

  // Vrací nový objekt jen s ověřenými poli, nebo null (neplatný snímek se zahodí).
  function normalizeSnapshot(raw) {
    if (!raw || typeof raw !== "object" || !Number.isSafeInteger(raw.rev) || !PHASES.has(raw.phase)) return null;
    // Záložní snímek televize ve fázi off nese jen rev a phase; ostatní pole jsou neutrální (kontrakt § 4).
    if (raw.phase === "off") return { rev: raw.rev, phase: "off", me: null, teams: [], quiz: null, buzz: { ...NEUTRAL_BUZZ } };
    const teams = normalizeTeams(raw.teams);
    if (!teams) return null;

    let me = null;
    if (raw.me) {
      if (typeof raw.me.name !== "string") return null;
      me = { name: text(raw.me.name), team: isIndex(raw.me.team, teams.length) ? raw.me.team : null };
    }

    let quiz = null;
    if (raw.quiz) {
      if (!isCount(raw.quiz.index) || !isCount(raw.quiz.total)) return null;
      quiz = { index: raw.quiz.index, total: raw.quiz.total };
    }

    const b = raw.buzz;
    if (!b || typeof b !== "object") return null;
    const buzz = {
      canBuzz: b.canBuzz === true,
      team: isIndex(b.team, teams.length) ? b.team : null,
      by: typeof b.by === "string" ? text(b.by) : null,
      mine: b.mine === true,
      teamLocked: b.teamLocked === true,
      result: RESULTS.has(b.result) ? b.result : null,
    };
    return { rev: raw.rev, phase: raw.phase, me, teams, quiz, buzz };
  }

  // --- stav bzučáku (jedna čistá funkce, pořadí podle kontraktu § 6) ---

  function computeBuzzState(s, local) {
    switch (s.phase) {
      case "off":
      case "lobby":
        return "lobby";
      case "closed":
        return "closed";
      case "answering":
        if (s.buzz.mine) return "mine";
        return s.me && s.me.team !== null && s.buzz.team === s.me.team ? "team" : "other";
      default: // wait | armed
        if (local && local.kind === "penalty") return "penalty";
        if (local && local.kind === "sent") return "sent";
        if (s.buzz.canBuzz) return "armed";
        return s.buzz.teamLocked ? "locked" : "wait";
    }
  }

  function buzzTexts(state, s) {
    if (state === "team") return { title: TEXT_TEAM_ANSWERS, sub: s.buzz.by || "" };
    if (state === "other") {
      const team = s.buzz.team !== null ? s.teams[s.buzz.team] : null;
      return { title: team ? `${TEXT_OTHER_ANSWERS} ${team.name}` : TEXT_OTHER_ANSWERS, sub: s.buzz.by || "" };
    }
    if (state === "closed") {
      const own = s.me && s.me.team !== null && s.buzz.team === s.me.team;
      return { title: BUZZ_TEXT.closed[0], sub: (own && lookup(CLOSED_RESULT_TEXT, s.buzz.result)) || "" };
    }
    const [title, sub] = BUZZ_TEXT[state];
    return { title, sub };
  }

  // --- zobrazení ---

  function setConn(state) {
    connState = state;
    const v = CONN_VIEW[state];
    el.status.dataset.conn = state;
    el.connIcon.className = `ph ${v.icon}`;
    setText(el.connText, v.text);
    const hint = CONN_HINT[state];
    el.connHint.hidden = !hint;
    el.connHint.textContent = hint || "";
    render();
  }

  function showNote(message) {
    el.noteText.textContent = message;
    el.note.classList.add("show");
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      el.note.classList.remove("show");
      el.noteText.textContent = "";
    }, NOTE_MS);
  }

  function contextText(s) {
    if (!s) return "";
    return s.quiz ? `Otázka ${s.quiz.index + 1} / ${s.quiz.total}` : TEXT_WAITING_QUIZ;
  }

  function currentScreen(s) {
    if (!s) return "join"; // před prvním snímkem: formulář s vypnutými prvky
    if (s.phase === "off") return "off";
    if (!s.me || s.me.team === null || changing) return "join";
    return "game";
  }

  function render() {
    const s = snapshot;
    const connected = connState === "open" && welcomed && s !== null;
    if (s && !CHANGE_PHASES.has(s.phase)) changing = false; // změna týmu v běžícím kole nejde, hráč musí vidět bzučák
    const screen = currentScreen(s);

    el.app.dataset.screen = screen;
    el.off.hidden = screen !== "off";
    el.join.hidden = screen !== "join";
    el.game.hidden = screen !== "game";
    el.ctxText.textContent = contextText(s);

    if (screen !== "join") formDirty = false;
    if (screen === "join") renderJoin(s, connected);
    if (screen === "game") renderGame(s, connected);
  }

  function buildTeamButton(team, index) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "team-pick";
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", "false");
    btn.dataset.team = String(index);
    if (team.color) btn.style.setProperty("--team", team.color);
    const emoji = document.createElement("span");
    emoji.className = "team-emoji";
    emoji.textContent = team.emoji;
    const name = document.createElement("span");
    name.className = "team-name";
    name.textContent = team.name;
    btn.append(emoji, name);
    return btn;
  }

  function cleanNick() {
    return Array.from(el.nick.value.trim()).slice(0, MAX_NAME).join("").trim();
  }

  function renderJoin(s, connected) {
    const teams = s ? s.teams : [];
    const hasTeam = !!(s && s.me && s.me.team !== null);

    if (!formDirty) {
      // Předvyplnění z úložiště (nebo ze současného stavu při změně týmu), dokud hráč nezačne psát nebo vybírat.
      const nick = stored.name || (s && s.me ? s.me.name : "");
      if (el.nick.value !== nick) el.nick.value = nick;
      selectedTeam = hasTeam ? s.me.team : (isIndex(stored.team, teams.length) ? stored.team : null);
    }
    if (!isIndex(selectedTeam, teams.length)) selectedTeam = null;

    // Seznam týmů se překresluje jen při změně týmů, výběr se drží v selectedTeam.
    const key = JSON.stringify(teams);
    if (key !== teamsKey) {
      teamsKey = key;
      el.teamList.replaceChildren(...teams.map(buildTeamButton));
    }
    for (const btn of el.teamList.children) {
      btn.setAttribute("aria-checked", String(Number(btn.dataset.team) === selectedTeam));
      btn.disabled = !connected;
    }

    el.noTeams.hidden = !s || teams.length > 0; // bez prvního snímku se „žádné týmy“ neukazuje
    el.nick.disabled = !connected;
    el.joinBtn.textContent = hasTeam ? LABEL_SAVE : LABEL_JOIN;
    el.joinBtn.disabled = !connected || cleanNick() === "" || selectedTeam === null;
    el.joinCancel.hidden = !hasTeam;
  }

  function renderGame(s, connected) {
    const team = s.teams[s.me.team];
    el.meEmoji.textContent = team.emoji;
    el.meTeam.textContent = team.name;
    el.meName.textContent = s.me.name;
    el.change.disabled = !connected || !CHANGE_PHASES.has(s.phase);

    const state = computeBuzzState(s, localBuzz);
    const texts = buzzTexts(state, s);
    el.buzz.dataset.state = state;
    el.buzz.disabled = !connected || state !== "armed";
    setText(el.buzzTitle, texts.title);
    setText(el.buzzSub, texts.sub);

    if (state === "mine" && lastBuzzState !== "mine" && navigator.vibrate) navigator.vibrate(VIBRATE_MS);
    lastBuzzState = state;
  }

  // --- spojení ---

  function send(message) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ v: PROTOCOL, ...message }));
    return true;
  }

  function nextSeq() {
    stored.seq += 1;
    saveStored();
    return stored.seq;
  }

  function sendHello() {
    const hello = { t: "hello", clientId: stored.clientId, role: "player" };
    if (stored.resume) hello.resume = stored.resume;
    send(hello);
  }

  // Odešle zprávu se seq a zapamatuje si její druh, aby šla k ack správná hláška.
  function sendTracked(message, info) {
    const seq = nextSeq();
    pending.set(seq, info);
    if (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value);
    if (send({ ...message, seq })) return true;
    pending.delete(seq);
    return false;
  }

  function sendJoin(name, team) {
    return sendTracked({ t: "join", name, team }, { kind: "join", name, team });
  }

  function sendBuzz(index) {
    return sendTracked({ t: "buzz", q: index }, { kind: "buzz" });
  }

  function connect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try { socket.close(); } catch { /* už zavřeno */ }
    }
    if (connState !== "failed" && connState !== "full") setConn(failures > 0 ? "lost" : "connecting");
    welcomed = false;

    try {
      socket = new WebSocket(`ws://${location.host}/ws?t=${encodeURIComponent(token)}`);
    } catch {
      scheduleReconnect();
      return;
    }
    socket.onopen = sendHello;
    socket.onmessage = (event) => handleMessage(event.data);
    socket.onclose = (event) => {
      welcomed = false;
      if (event.reason === KICK_REASON) stopKicked();
      else scheduleReconnect();
    };
    socket.onerror = () => { /* následuje close, tam se řeší opakování */ };
  }

  function scheduleReconnect() {
    if (reconnectTimer || connState === "kicked") return;
    const delay = RECONNECT_DELAYS[Math.min(failures, RECONNECT_DELAYS.length - 1)];
    failures += 1;
    if (connState !== "full") setConn(failures >= FAILED_AFTER ? "failed" : "lost");
    else render();
    reconnectTimer = setTimeout(connect, delay);
  }

  // Moderátor hráče odebral: už se nepřipojujeme a přezdívka s týmem se z mobilu smažou.
  function stopKicked() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    welcomed = false;
    delete stored.name;
    delete stored.team;
    saveStored();
    snapshot = null;
    lastRev = -1;
    localBuzz = null;
    changing = false;
    formDirty = false;
    setConn("kicked");
  }

  function startPenalty(index) {
    clearTimeout(penaltyTimer);
    localBuzz = { kind: "penalty", index };
    penaltyTimer = setTimeout(() => {
      if (localBuzz && localBuzz.kind === "penalty") localBuzz = null;
      render();
    }, PENALTY_MS);
  }

  // Po návratu do hry po odpojení se hráč zapíše sám, když televize o něm neví a mobil má uložené údaje.
  function maybeAutoJoin(s) {
    if (autoJoinSent || s.phase === "off" || s.me !== null) return;
    if (typeof stored.name !== "string" || stored.name === "" || !isIndex(stored.team, s.teams.length)) return;
    autoJoinSent = true;
    sendJoin(stored.name, stored.team);
  }

  function applyState(raw) {
    const s = normalizeSnapshot(raw);
    if (!s) return;
    if (s.rev <= lastRev && snapshot) return; // starší snímek
    lastRev = s.rev;
    snapshot = s;
    // Odeslaný stisk končí, jakmile se změní fáze nebo otázka.
    if (localBuzz && localBuzz.kind === "sent" && (s.phase !== "armed" || !s.quiz || s.quiz.index !== localBuzz.index)) {
      localBuzz = null;
    }
    render();
    maybeAutoJoin(s);
  }

  function handleAck(msg) {
    const info = pending.get(msg.seq);
    if (!info) return;
    pending.delete(msg.seq);
    if (info.kind === "join") {
      if (msg.ok === true) {
        stored.name = info.name;
        stored.team = info.team;
        saveStored();
      } else if (lookup(JOIN_NOTES, msg.reason)) showNote(lookup(JOIN_NOTES, msg.reason));
      return;
    }
    if (msg.ok !== false) return;
    if (msg.reason === "early") startPenalty(localBuzz ? localBuzz.index : 0);
    else {
      localBuzz = null;
      if (lookup(BUZZ_NOTES, msg.reason)) showNote(lookup(BUZZ_NOTES, msg.reason));
    }
    render();
  }

  function handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== "string") return;

    if (msg.t === "welcome") {
      if (typeof msg.resume === "string") {
        stored.resume = msg.resume;
        saveStored();
      }
      // Televize může při obsazeném clientId přidělit nové: používá se od té chvíle (stejná mez jako u hello).
      if (isClientId(msg.clientId) && msg.clientId !== stored.clientId) {
        stored.clientId = msg.clientId;
        saveStored();
      }
      welcomed = true;
      failures = 0;
      lastRev = -1; // po novém spojení platí první snímek bez ohledu na čítač
      autoJoinSent = false;
      if (localBuzz && localBuzz.kind === "sent") localBuzz = null; // odpověď na stisk mohla zaniknout s výpadkem
      setConn("open");
      applyState(msg.state);
    } else if (msg.t === "state") {
      applyState(msg);
    } else if (msg.t === "ack") {
      handleAck(msg);
    } else if (msg.t === "error") {
      if (msg.code === "hello_required") sendHello();
      else if (msg.code === "full") setConn("full");
      // ostatní chyby se ignorují
    }
  }

  // Po návratu na stránku zkus spojení hned, mobil mezitím mohl spojení zahodit.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || connState === "kicked") return;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    failures = 0;
    connect();
  });

  // --- ovládání ---

  el.nick.addEventListener("input", () => {
    formDirty = true;
    render();
  });

  el.teamList.addEventListener("click", (event) => {
    const btn = event.target.closest(".team-pick");
    if (!btn || btn.disabled) return;
    selectedTeam = Number(btn.dataset.team);
    formDirty = true;
    render();
  });

  el.join.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = cleanNick();
    if (el.joinBtn.disabled || name === "" || selectedTeam === null) return;
    sendJoin(name, selectedTeam);
    changing = false; // formulář zůstane vyplněný, dokud snímek nepřepne obrazovku
    render();
  });

  el.joinCancel.addEventListener("click", () => {
    changing = false;
    formDirty = false;
    render();
  });

  el.change.addEventListener("click", () => {
    if (el.change.disabled) return;
    changing = true;
    formDirty = false;
    render();
  });

  el.buzz.addEventListener("click", () => {
    const s = snapshot;
    if (el.buzz.dataset.state !== "armed" || el.buzz.disabled || !s || !s.quiz || localBuzz) return;
    if (!sendBuzz(s.quiz.index)) return;
    localBuzz = { kind: "sent", index: s.quiz.index };
    render();
  });

  render();
  connect();
})();
