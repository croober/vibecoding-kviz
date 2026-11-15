// Mobilní ovladač kvízu: jen vstup. Nic nepočítá, zobrazuje jen snímek, který pošle televize.
// Protokol: zprávy hello, key, text a snímek stavu z kontraktu mobilního ovládání (§ 2 a § 3);
// klíč ovladače a zpráva rekey (výměna klíče bez odpojení): kontrakt hráčů § 1 a § 2.
(() => {
  "use strict";

  const PROTOCOL = 1;
  const RECONNECT_DELAYS = [500, 1000, 2000, 5000]; // poslední hodnota je strop
  const FAILED_AFTER = 3; // tolik pokusů po sobě bez otevření = „Nedaří se spojit“
  const TEXT_DEBOUNCE_MS = 80;
  const PRESS_MS = 120;
  const NOTE_MS = 2500;
  const LABEL_FLASH_MS = 600;
  const MAX_TEXT = 500;

  const $ = (id) => document.getElementById(id);
  const el = {
    app: $("app"), noToken: $("no-token"),
    status: $("status"), connIcon: $("conn-icon"), connText: $("conn-text"),
    ctxText: $("ctx-text"), ctxLock: $("ctx-lock"), connHint: $("conn-hint"),
    writeIdle: $("write-idle"), writeIdleText: $("write-idle-text"),
    form: $("write-form"), label: $("text-label"), input: $("text-input"), area: $("text-area"), done: $("done"),
    eye: $("eye"), eyeIcon: $("eye-icon"), maskNote: $("mask-note"),
    teams: $("teams"), points: $("points"), answers: $("answers"),
    note: $("note"), noteText: $("note-text"),
  };

  const CONN_VIEW = {
    connecting: { icon: "ph-circle-notch spin", text: "Připojuji k televizi…" },
    open: { icon: "ph-wifi-high", text: "Připojeno" },
    lost: { icon: "ph-wifi-slash", text: "Odpojeno, zkouším znovu…" },
    failed: { icon: "ph-wifi-x", text: "Nedaří se spojit" },
    full: { icon: "ph-wifi-x", text: "Televize je plná" },
    forbidden: { icon: "ph-link-break", text: "Tenhle odkaz už neplatí" },
  };
  const CONN_HINT = {
    failed: "Mobil musí být na stejné Wi-Fi jako televize. Pokud se na televizi změnil kód, naskenuj QR znovu.",
    full: "K televizi je připojeno moc zařízení. Odpoj některé a zkus to znovu.",
    forbidden: "Naskenuj QR kód znovu: na televizi menu → Ovládání z mobilu.",
  };
  const OVERLAY_TEXT = { menu: "Menu na televizi", dialog: "Okno na televizi", emoji: "Výběr ikony" };
  const VIEW_TEXT = { setup: "Zadání kvízu", loading: "Připravují se otázky…", results: "Výsledky", archive: "Archiv – jen ke čtení" };
  const INPUT_MODES = { url: "url", number: "numeric", email: "email" };
  const ACK_NOTES = { nofield: "Na televizi není vybrané pole", locked: "Archivní kvíz jde jen prohlížet" };

  const params = new URLSearchParams(location.search);
  const token = params.get("t");
  const urlKey = params.get("k"); // klíč ovladače z QR kódu: jen do hello, nikam se nevypisuje
  if (!token) {
    el.app.hidden = true;
    el.noToken.hidden = false;
    return; // bez tokenu se nepřipojujeme
  }

  // --- úložiště (každý přístup v try/catch, stránka musí fungovat i bez něj) ---

  const storageKey = `kviz-link-${token}`;

  // Klíč ovladače (z adresy, uložený nebo ze zprávy rekey): stejná mez délky jako na TV (link-core LIMITS.remoteKey).
  const REMOTE_KEY_MAX = 64;
  function isRemoteKey(v) {
    return typeof v === "string" && v.length >= 1 && v.length <= REMOTE_KEY_MAX;
  }

  function loadStored() {
    try {
      const data = JSON.parse(localStorage.getItem(storageKey));
      if (data && typeof data.clientId === "string" && data.clientId.length >= 8 && data.clientId.length <= 32) return data;
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
  if (typeof stored.seq !== "number") stored.seq = 0;
  if (!isRemoteKey(stored.remoteKey)) delete stored.remoteKey;
  saveStored();

  // Kandidáti jedné série připojování: první je ten, který naposledy prošel (nebo přišel v rekey), pak druhý zdroj.
  // Po forbidden se první zahodí; seznam se během série jen zkracuje, takže pokusů je nejvýš tolik, kolik je klíčů.
  function keyCandidates(first, second) {
    return [first, second].filter((k, i, all) => isRemoteKey(k) && all.indexOf(k) === i);
  }
  let keys = keyCandidates(urlKey, stored.remoteKey);

  // --- stav ---

  let socket = null;
  let connState = "connecting"; // connecting | open | lost | failed | full | forbidden (konečný stav, bez dalších pokusů)
  let welcomed = false;
  let failures = 0;
  let reconnectTimer = null;
  let snapshot = null;
  let lastRev = -1;
  let lastFieldKey = null;
  let textTimer = null;
  let noteTimer = null;
  let masked = false; // maskované pole je jednořádkové heslo, ostatní jde psát ve víceřádkové textaree
  let pendingText = null; // text, který se nepodařilo odeslat kvůli výpadku; pošle se po welcome

  // --- zobrazení ---

  function setConn(state) {
    connState = state;
    const v = CONN_VIEW[state];
    el.status.dataset.conn = state;
    el.connIcon.className = `ph ${v.icon}`;
    el.connText.textContent = v.text;
    const hint = CONN_HINT[state];
    el.connHint.hidden = !hint;
    el.connHint.textContent = hint || "";
    render();
  }

  function showNote(text) {
    el.noteText.textContent = text;
    el.note.classList.add("show");
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      el.note.classList.remove("show");
      el.noteText.textContent = "";
    }, NOTE_MS);
  }

  function contextText(s) {
    if (s.overlay && OVERLAY_TEXT[s.overlay]) return OVERLAY_TEXT[s.overlay];
    if (s.locked) return VIEW_TEXT.archive;
    if (s.view === "quiz" && s.quiz) {
      return `Otázka ${s.quiz.index + 1} / ${s.quiz.total}${s.quiz.revealed ? " · odhaleno" : ""}`;
    }
    return VIEW_TEXT[s.view] || "";
  }

  // Viditelnost a zamčení ovládání podle posledního snímku a spojení.
  // Před prvním snímkem se nic neskrývá, při odpojení se jen zamyká (rozvržení se nesmí hýbat).
  function render() {
    const s = snapshot;
    const connected = connState === "open" && welcomed && s !== null;
    const locked = !!(s && s.locked);
    const overlay = !!(s && s.overlay);
    const quiz = s ? s.view === "quiz" : true;
    const teamCount = s ? s.teamCount : 4;
    const revealed = !!(s && s.quiz && s.quiz.revealed);
    const scoring = !connected || overlay || locked;

    el.ctxText.textContent = s ? contextText(s) : "";
    el.ctxLock.hidden = !locked;

    el.teams.hidden = !(quiz && teamCount >= 2);
    el.points.hidden = !(quiz && teamCount >= 1);
    el.answers.hidden = !quiz;
    el.teams.style.setProperty("--n", String(teamCount + 1));

    for (const btn of document.querySelectorAll("[data-action]")) {
      const action = btn.dataset.action;
      const teamNo = /^team(\d)$/.exec(action);
      btn.hidden = teamNo ? Number(teamNo[1]) > teamCount : false;
      if (teamNo || action === "all" || action === "plus" || action === "minus") btn.disabled = scoring;
      else if (action.startsWith("answer")) btn.disabled = scoring || revealed;
      else btn.disabled = !connected; // navigace
    }

    renderWrite(s, connected, locked);
  }

  // Pole, do kterého se právě píše: heslo jen jednořádkové, jinak textarea.
  function control() {
    return masked ? el.input : el.area;
  }

  // Textarea je ve výchozím stavu jednořádková; po fokusu se rozbalí a roste podle obsahu.
  function expandArea() {
    el.area.classList.add("expanded");
    el.area.style.height = "auto";
    el.area.style.height = `${el.area.scrollHeight + el.area.offsetHeight - el.area.clientHeight}px`;
  }

  function collapseArea() {
    el.area.classList.remove("expanded");
    el.area.style.height = "";
    el.area.scrollTop = 0;
  }

  function renderWrite(s, connected, locked) {
    const field = s ? s.field : null;
    const setup = s ? s.view === "setup" : false;
    const showForm = !locked && (field || setup || !s);

    el.form.hidden = !showForm;
    el.writeIdle.hidden = showForm;
    el.writeIdleText.textContent = locked ? "Archiv nejde upravovat" : "Vyber pole na televizi";
    if (!showForm) {
      // Skrytý formulář nesmí uchovat rozepsané heslo.
      el.input.value = "";
      el.area.value = "";
      collapseArea();
      return;
    }

    masked = !!(field && field.masked);
    const key = field ? field.key : null;
    const keyChanged = key !== lastFieldKey;
    const ctl = control();

    el.input.hidden = !masked;
    el.area.hidden = masked;
    // Skryté pole nesmí uchovat obsah (heslo) ani ho ukázat v druhém poli.
    if (masked) el.area.value = "";
    else el.input.value = "";
    // Zakázaná textarea nevyvolá blur, proto ji sbalíme i při výpadku spojení.
    if (masked || !connected) collapseArea();
    el.label.htmlFor = ctl.id;
    el.label.textContent = field ? field.label : "Téma kvízu";
    ctl.placeholder = field ? "" : "např. sport, vesmír";
    ctl.maxLength = Math.min((field && field.maxLength) || MAX_TEXT, MAX_TEXT);
    ctl.inputMode = (field && INPUT_MODES[field.type]) || "text";
    ctl.autocapitalize = masked ? "off" : "sentences";
    ctl.spellcheck = !masked;
    ctl.disabled = !connected;
    el.done.disabled = !connected;

    el.eye.hidden = !masked;
    el.maskNote.hidden = !masked;
    ctl.parentElement.classList.toggle("masked", masked);
    if (masked) ctl.setAttribute("aria-describedby", "mask-note");
    else ctl.removeAttribute("aria-describedby");

    if (keyChanged) {
      lastFieldKey = key;
      if (masked) setReveal(false);
      ctl.value = masked || !field ? "" : field.value || "";
      flashLabel();
    } else if (!masked && field && document.activeElement !== ctl) {
      ctl.value = field.value || "";
    }
  }

  function flashLabel() {
    el.label.classList.add("changed");
    setTimeout(() => el.label.classList.remove("changed"), LABEL_FLASH_MS);
  }

  // Přepínač oka existuje jen u maskovaného pole, typ pole proto mění jen tam.
  function setReveal(visible) {
    el.eye.setAttribute("aria-pressed", String(visible));
    el.eye.setAttribute("aria-label", visible ? "Skrýt hodnotu" : "Zobrazit hodnotu");
    el.eyeIcon.className = `ph ${visible ? "ph-eye-slash" : "ph-eye"}`;
    el.input.type = visible ? "text" : "password";
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
    const hello = { t: "hello", clientId: stored.clientId, role: "remote" };
    if (stored.resume) hello.resume = stored.resume;
    if (keys.length) hello.remoteKey = keys[0];
    send(hello);
  }

  // Klíč, se kterým přihlášení prošlo (nebo nový z rekey): uloží se a příští série začíná od něj.
  function rememberKey(key) {
    if (!isRemoteKey(key)) return;
    stored.remoteKey = key;
    saveStored();
    keys = keyCandidates(key, urlKey);
  }

  // Televize odmítla klíč: zkusí se další kandidát na novém spojení; false = kandidáti došli.
  function tryNextKey() {
    keys.shift();
    if (!keys.length) return false;
    connect();
    return true;
  }

  // Televize odmítla všechny klíče: odkaz je neplatný a další pokusy by skončily stejně.
  function stopForbidden() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    welcomed = false;
    setConn("forbidden");
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
    socket.onclose = () => {
      welcomed = false;
      scheduleReconnect();
    };
    socket.onerror = () => { /* následuje close, tam se řeší opakování */ };
  }

  function scheduleReconnect() {
    if (reconnectTimer || connState === "forbidden") return;
    const delay = RECONNECT_DELAYS[Math.min(failures, RECONNECT_DELAYS.length - 1)];
    failures += 1;
    if (connState !== "full") setConn(failures >= FAILED_AFTER ? "failed" : "lost");
    else render();
    reconnectTimer = setTimeout(connect, delay);
  }

  function applyState(state) {
    if (!state || typeof state.rev !== "number") return;
    if (state.rev <= lastRev && snapshot) return; // starší snímek
    lastRev = state.rev;
    snapshot = state;
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
      rememberKey(keys[0]);
      welcomed = true;
      failures = 0;
      lastRev = -1; // po novém spojení platí první snímek bez ohledu na čítač
      setConn("open");
      applyState(msg.state);
      if (pendingText) sendText(pendingText.done);
    } else if (msg.t === "state") {
      applyState(msg);
    } else if (msg.t === "ack") {
      if (msg.ok === false && ACK_NOTES[msg.reason]) showNote(ACK_NOTES[msg.reason]);
    } else if (msg.t === "rekey") {
      if (welcomed) rememberKey(msg.remoteKey); // neplatný klíč rememberKey ignoruje
    } else if (msg.t === "error") {
      if (msg.code === "hello_required") sendHello();
      else if (msg.code === "full") setConn("full");
      else if (msg.code === "forbidden") {
        if (welcomed || !tryNextKey()) stopForbidden();
      }
      else console.warn("Chyba od televize:", msg.code);
    }
  }

  // Po návratu na stránku zkus spojení hned, mobil mezitím mohl spojení zahodit.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || connState === "forbidden") return;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    failures = 0;
    connect();
  });

  // --- ovládání ---

  function press(btn) {
    btn.classList.add("pressed");
    setTimeout(() => btn.classList.remove("pressed"), PRESS_MS);
    if (navigator.vibrate) navigator.vibrate(10);
  }

  el.app.addEventListener("pointerdown", (event) => {
    const btn = event.target.closest("[data-action]");
    if (btn && !btn.disabled) press(btn);
  });

  el.app.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-action]");
    if (!btn || btn.disabled) return;
    if (event.detail === 0) press(btn); // z klávesnice nebo čtečky nepřijde pointerdown
    send({ t: "key", action: btn.dataset.action, seq: nextSeq() });
  });

  function sendText(isDone) {
    clearTimeout(textTimer);
    textTimer = null;
    // Pole na televizi je jednořádkové (public/index.html, #topic), nové řádky se proto nahradí mezerou.
    const value = control().value.replace(/\r?\n/g, " ").slice(0, MAX_TEXT);
    const message = { t: "text", value, seq: nextSeq() };
    if (isDone) message.done = true;
    pendingText = send(message) ? null : { done: !!isDone || (pendingText !== null && pendingText.done) };
  }

  function onTextInput() {
    clearTimeout(textTimer);
    textTimer = setTimeout(() => sendText(false), TEXT_DEBOUNCE_MS);
  }

  el.input.addEventListener("input", onTextInput);
  el.area.addEventListener("input", () => {
    expandArea();
    onTextInput();
  });
  el.area.addEventListener("focus", expandArea);
  el.area.addEventListener("blur", collapseArea);

  // Klepnutí na Hotovo nesmí vzít textaree fokus dřív, než proběhne click, jinak by se pole
  // sbalilo a tlačítko by se pod prstem posunulo. Sbalí ho až submit.
  el.done.addEventListener("pointerdown", (event) => event.preventDefault());

  el.form.addEventListener("submit", (event) => {
    event.preventDefault();
    sendText(true);
    control().blur(); // klávesnice zmizí, pole se sbalí a kříž je zase na dosah
  });

  el.eye.addEventListener("click", () => {
    setReveal(el.eye.getAttribute("aria-pressed") !== "true");
  });

  render();
  connect();
})();
