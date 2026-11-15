// TV nadstavba, část mobilního ovládání: napojí nativní plugin KvizLink (WebSocket server na TV) na obsluhu kláves.
// Příkaz z mobilu se nepřekládá na volání funkcí, ale na událost klávesy s příznakem tvLink, kterou zpracuje stávající kód
// (stejná navigace, zvuky i potvrzovací dotazy jako z ovladače). Vkládá se jen do APK (android-tv/prepare.mjs) jako poslední TV skript.
// Rozhraní: kontrakt mobilního ovládání § 1 (plugin), § 2 (protokol), § 3 (snímek), § 4 (úložiště).
//
// Spoléhá na věci z app.js (při jejich změně zkontrolovat tenhle soubor):
//   globály: state (view, bigTeams, locked, teams, quiz.questions, index), currentQ
//   prvky:   #topic (cíl textu na zadání, našeptávač na událost input), #teams a #answers (děti se překreslují),
//            #answers .answer, #menuPanel, #emojiPicker, dialog[open], body[data-view],
//            název týmu se ukládá na change, pole v Nastavení serveru (tv-server.js) na input i change,
//            #main (karta s QR jako první dítě), #menuBtn, #menuPanel .menu-box, globály closeMenu a confirmDialog
// a na TV vrstvu: #tvSettingsDialog a #tvSettingsForm > p.extra-hint (tv-server.js), #menuTvKeys (tv-keys.js),
//   #tvReplay (tv-remote.js), globál qrcode (vendor/qrcode.js, qrcode-generator: qrcode(0, "M"), addData, make,
//   getModuleCount, isDark); KvizTv.store (tv-server.js), KvizTvCore (core.js), KvizLinkCore (link-core.js, načtený po core.js),
//   KvizTvRemote.handleBack a isField (tv-remote.js), volitelně KvizTvSound.play (tv-sound.js); Capacitor.Plugins.KvizLink.
//   Citlivá pole tvToken a tvBasicAuth (tv-server.js) se maskují i po přepnutí na „Zobrazit“ (SECRET_FIELD_IDS);
//   tvServerUrl jde z mobilu přepsat jen při prázdném tokenu i basic auth (údaje by jinak šly na podstrčenou adresu).
(() => {
  "use strict";
  const plugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.KvizLink;
  if (!window.KvizTv || !plugin) return; // jen v APK s pluginem; webová verze skončí tiše
  const Link = window.KvizLinkCore;
  // bez core.js (nebo s link-core.js načteným před ním) zná link-core jen 4 akce a klávesy by tiše nic nedělaly
  if (!window.KvizTvCore || !Link || Link.REMOTE_ACTIONS.indexOf("ok") < 0) {
    console.warn("tv-link: chybí KvizTvCore nebo KvizLinkCore (pořadí skriptů v prepare.mjs), mobilní ovládání vypnuto");
    return;
  }
  if (!window.KvizTvRemote) {
    console.warn("tv-link: chybí KvizTvRemote (tv-remote.js), mobilní ovládání vypnuto");
    return;
  }

  const $ = (id) => document.getElementById(id);
  const appState = () => (typeof state !== "undefined" ? state : {});
  const store = window.KvizTv.store;
  const STORE_KEY = "kviz-tv-link";
  const DEFAULT_PORT = 8765;
  const HELLO_TIMEOUT_MS = 5000;
  const STATE_DELAY_MS = 50;
  // Token a basic auth serveru kvízu: hodnota nesmí na mobil ani tehdy, když je pole přepnuté na čitelný text.
  const SECRET_FIELD_IDS = ["tvToken", "tvBasicAuth"];

  /* ---------- Nastavení: token a port (kontrakt § 4) ---------- */
  function loadSettings() {
    let saved = {};
    try { saved = JSON.parse(store.get(STORE_KEY)) || {}; } catch { saved = {}; }
    return {
      token: typeof saved.token === "string" && saved.token ? saved.token : Link.newToken(),
      port: Number.isSafeInteger(saved.port) ? saved.port : DEFAULT_PORT,
    };
  }
  const settings = loadSettings();
  const saveSettings = () => store.set(STORE_KEY, JSON.stringify(settings));
  saveSettings(); // nově vytvořený token se uloží hned

  /* ---------- Stav serveru a posluchači ---------- */
  let server = { running: false, port: settings.port, addresses: [], error: null };
  const listeners = [];
  function changed() {
    listeners.forEach((cb) => {
      try { cb(); } catch (err) { console.warn("tv-link: chyba posluchače", err); }
    });
  }
  function applyServer(s) {
    server = {
      running: !!s.running,
      port: Number.isSafeInteger(s.port) ? s.port : server.port,
      addresses: Array.isArray(s.addresses) ? s.addresses : [],
      error: null,
    };
    if (server.running && server.port !== settings.port) { settings.port = server.port; saveSettings(); }
    changed();
  }

  function start() {
    return plugin.start({ port: settings.port, token: settings.token })
      .then(applyServer)
      .catch((err) => {
        console.warn("tv-link: server se nespustil", err && err.code, err);
        server = { running: false, port: settings.port, addresses: [], error: (err && err.code) || "failed" };
        changed();
      });
  }

  /* ---------- Odesílání ---------- */
  const clients = Link.createClients();
  const helloTimers = {}; // connId -> časovač spojení, které ještě neposlalo hello

  function send(connId, msg) {
    const data = JSON.stringify(Object.assign({ v: Link.PROTOCOL }, msg));
    return plugin.send({ id: connId, data }).catch((err) => console.warn("tv-link: odeslání selhalo", connId, err && err.code));
  }
  const closeConn = (connId, reason) => plugin.close({ id: connId, reason }).catch(() => {});
  const ack = (connId, seq, ok, reason) => send(connId, reason ? { t: "ack", seq, ok, reason } : { t: "ack", seq, ok });

  function clearHelloTimer(connId) {
    clearTimeout(helloTimers[connId]);
    delete helloTimers[connId];
  }

  /* ---------- Snímek stavu (kontrakt § 3) ---------- */
  let rev = 0;            // roste s každým odeslaným snímkem (welcome i state)
  let lastState = null;   // poslední stav, který mají všechny připojené mobily (bez rev)
  let stateTimer = null;

  function overlayNow() {
    if (document.querySelector("dialog[open]")) return "dialog";
    if (!$("menuPanel").hidden) return "menu";
    if (!$("emojiPicker").hidden) return "emoji";
    return null;
  }

  const isSecretField = (n) => n.type === "password" || SECRET_FIELD_IDS.includes(n.id);

  // aria-label má přednost: <label for="topic"> nese i nápovědu „· více témat odděl čárkou“, aria-label je „Téma kvízu“.
  function labelOf(n) {
    const aria = n.getAttribute("aria-label");
    if (aria) return aria;
    const label = n.labels && n.labels[0];
    const text = label ? label.textContent.replace(/\s+/g, " ").trim() : "";
    return text || n.placeholder || "Text";
  }

  // Vstup pro KvizLinkCore.fieldView: hodnota citlivého pole se ani nepřečte.
  function activeField() {
    const n = document.activeElement;
    if (!window.KvizTvRemote.isField(n)) return null;
    const secret = isSecretField(n);
    const label = labelOf(n);
    return {
      key: n.id || n.name || label, // název týmu nemá id ani name, popisek „Název týmu N“ je jedinečný
      label,
      type: secret ? "password" : n.type,
      value: secret ? "" : n.value,
      maxLength: n.maxLength,
    };
  }

  // Snímek pro mobil; bez `withRev` je jen pro porovnání (sameState rev nebere v úvahu).
  function snapshot(withRev) {
    const s = appState();
    const q = typeof currentQ === "function" ? currentQ() : null;
    const quiz = s.quiz && Array.isArray(s.quiz.questions)
      ? { index: s.index, total: s.quiz.questions.length, revealed: !!(q && q.revealed) }
      : null;
    return Link.stateView("remote", {
      rev: withRev,
      view: s.view,
      locked: !!s.locked,
      overlay: overlayNow(),
      teamCount: Array.isArray(s.teams) ? s.teams.length : 0,
      quiz,
      field: activeField(),
    });
  }

  // Jediná cesta rozeslání snímku: jen mobilům po hello, jen když se stav změnil.
  function sendState() {
    stateTimer = null;
    const next = snapshot();
    if (Link.sameState(next, lastState)) return;
    lastState = next; // i bez připojených mobilů: nový mobil dostane aktuální stav ve welcome
    const targets = clients.list().filter((c) => c.connected);
    if (!targets.length) return;
    rev += 1;
    const msg = Object.assign({ t: "state" }, next, { rev });
    targets.forEach((c) => send(c.connId, msg));
  }
  function scheduleState() {
    if (!stateTimer) stateTimer = setTimeout(sendState, STATE_DELAY_MS);
  }

  // keyup zachytí změny hodnoty bez události input (výběr návrhu tématu v app.js pickSuggest).
  function watchState() {
    ["focusin", "focusout", "input", "keyup"].forEach((type) => document.addEventListener(type, scheduleState, true));
    const observer = new MutationObserver(scheduleState);
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-view", "open"] });
    const watch = (id, options) => {
      const node = $(id);
      if (node) observer.observe(node, options);
      else console.warn("tv-link: chybí prvek #" + id + ", jeho změny se mobilu nehlásí");
    };
    ["menuPanel", "emojiPicker"].forEach((id) => watch(id, { attributes: true, attributeFilter: ["hidden"] }));
    ["teams", "answers"].forEach((id) => watch(id, { childList: true }));
  }

  /* ---------- Příkazy z mobilu ---------- */
  // V běžícím kvízu patří ← → a OK z mobilu otázkám: když fokus uvízl na tlačítku v záhlaví (křížek, menu),
  // vrátí se na kotvu, ať se klávesa nezmění v prostorový pohyb po záhlaví nebo v zavření kvízu.
  function parkHeaderFocus(init) {
    if (!["ArrowLeft", "ArrowRight", "Enter"].includes(init.key)) return;
    const s = appState();
    const active = document.activeElement;
    if (s.view !== "quiz" || s.bigTeams || overlayNow() || !active || !active.closest(".topbar-actions")) return;
    const anchor = $("tvAnchor");
    if (anchor) anchor.focus({ preventScroll: true });
  }

  function dispatchKey(init) {
    parkHeaderFocus(init);
    const ev = new KeyboardEvent("keydown", init);
    ev.tvLink = true; // bez tvSynthetic a tvMapped: obslouží ho tv-remote.js i zvuk stisku v tv-sound.js
    (document.activeElement || document.body).dispatchEvent(ev);
  }

  // Odpověď číslem: jen v běžícím (nearchivním) kvízu v malém zobrazení týmů, bez překryvu, na neodhalené otázce.
  function answerButton(n) {
    const s = appState();
    if (s.view !== "quiz" || s.bigTeams || s.locked || overlayNow()) return null;
    const q = typeof currentQ === "function" ? currentQ() : null;
    if (!q || q.revealed) return null;
    const btn = $("answers").querySelectorAll(".answer")[n - 1];
    return btn && !btn.disabled ? btn : null;
  }

  function onKey(connId, msg) {
    if (!clients.accept(connId, msg.seq)) return ack(connId, msg.seq, false, "duplicate");
    const cmd = Link.commandOf(msg.action);
    if (!cmd) return ack(connId, msg.seq, false, "invalid");
    if (cmd.kind === "key") dispatchKey(cmd.init);
    else if (cmd.kind === "back") {
      window.KvizTvRemote.handleBack();
      if (window.KvizTvSound) window.KvizTvSound.play("click");
    } else if (cmd.kind === "answer") {
      const btn = answerButton(cmd.n);
      if (!btn) return ack(connId, msg.seq, false, "locked");
      btn.click();
    }
    scheduleState(); // klávesa z mobilu nemá keyup, výběr návrhu tématu by se jinak mobilu neohlásil
    return ack(connId, msg.seq, true);
  }

  // Pole pro text z mobilu: právě aktivní pole TV, jinak na zadání bez překryvu pole tématu.
  function textTarget() {
    const active = document.activeElement;
    if (window.KvizTvRemote.isField(active)) return active;
    if (appState().view !== "setup" || overlayNow()) return null;
    const topic = $("topic");
    if (!topic || topic.disabled) return null;
    topic.focus();
    return topic;
  }

  // Adresu serveru jde z mobilu měnit jen při prázdném tokenu i basic auth: draft se ukládá hned
  // a „Otestovat spojení“ by uložené přihlašovací údaje poslal na adresu podstrčenou z mobilu.
  // Zjišťuje se jen prázdnost, hodnota tajných polí se nikam nepředává.
  function serverUrlGuarded(n) {
    if (n.id !== "tvServerUrl") return false;
    return SECRET_FIELD_IDS.some((id) => { const f = $(id); return !!f && f.value !== ""; });
  }

  // Text z mobilu je nedůvěryhodný: jen do .value, jednořádkové pole bez nových řádků, číslo jen číslice, oříznout na maxLength.
  function cleanText(n, value) {
    let text = n.tagName === "TEXTAREA" ? value : value.replace(/\r\n?|\n/g, " ");
    if (n.type === "number") text = text.replace(/\D/g, "");
    return n.maxLength > 0 ? text.slice(0, n.maxLength) : text;
  }

  function onText(connId, msg) {
    if (!clients.accept(connId, msg.seq)) return ack(connId, msg.seq, false, "duplicate");
    const n = textTarget();
    if (!n || n.disabled) return ack(connId, msg.seq, false, "nofield");
    if (appState().locked && !n.closest("dialog")) return ack(connId, msg.seq, false, "locked");
    if (serverUrlGuarded(n)) return ack(connId, msg.seq, false, "locked");
    n.value = cleanText(n, msg.value);
    n.dispatchEvent(new Event("input", { bubbles: true }));
    if (msg.done) {
      n.dispatchEvent(new Event("change", { bubbles: true }));
      window.KvizTvRemote.confirmField(n); // potvrzení pole jako Enter ovladače
    }
    return ack(connId, msg.seq, true);
  }

  function onHello(connId, msg) {
    clearHelloTimer(connId);
    const res = clients.hello(connId, msg);
    if (!res.ok) {
      send(connId, { t: "error", code: res.code }).then(() => { if (res.code === "full") closeConn(connId, "full"); });
      return;
    }
    if (res.replaced !== undefined) closeConn(res.replaced, "replaced");
    const c = res.client;
    send(connId, { t: "welcome", clientId: c.clientId, resume: c.resume, role: c.role, state: snapshot(++rev) });
    changed();
  }

  function onMessage(e) {
    const parsed = Link.parseMessage(e.data);
    if (!parsed.ok) return send(e.id, { t: "error", code: parsed.code });
    const msg = parsed.msg;
    if (msg.t === "hello") return onHello(e.id, msg);
    if (!clients.byConn(e.id)) return send(e.id, { t: "error", code: "hello_required" });
    if (msg.t === "key") return onKey(e.id, msg);
    if (msg.t === "text") return onText(e.id, msg);
  }

  /* ---------- Události pluginu ---------- */
  plugin.addListener("open", (e) => {
    helloTimers[e.id] = setTimeout(() => {
      delete helloTimers[e.id];
      if (!clients.byConn(e.id)) closeConn(e.id, "hello_timeout");
    }, HELLO_TIMEOUT_MS);
  });
  plugin.addListener("message", onMessage);
  plugin.addListener("close", (e) => {
    clearHelloTimer(e.id);
    if (clients.drop(e.id)) changed();
  });
  plugin.addListener("rtt", (e) => {
    const c = clients.byConn(e.id);
    if (c) c.rttMs = e.ms;
  });
  plugin.addListener("state", applyServer); // obnova po pauze aktivity

  /* ---------- Rozhraní pro dialog s QR (faze-4-list-4) ---------- */
  function info() {
    const ip = Link.pickAddress(server.addresses);
    return {
      running: server.running,
      port: server.port,
      addresses: server.addresses.slice(),
      error: server.error,
      token: settings.token,
      url: server.running && ip ? Link.buildUrl(ip, server.port, settings.token) : null,
    };
  }
  // Seznam mobilů bez tajemství resume.
  const clientList = () => clients.list().map((c) => ({
    clientId: c.clientId, name: c.name, connected: c.connected,
    rttMs: c.connected && c.rttMs !== undefined ? c.rttMs : null, // po odpojení se staré měření neukazuje
  }));
  function restart(options) {
    if (options && options.newToken) { settings.token = Link.newToken(); saveSettings(); }
    return start();
  }
  function onChange(cb) {
    if (typeof cb === "function") listeners.push(cb);
  }

  window.KvizTvLink = { info, clients: clientList, restart, onChange };

  /* ---------- QR kód (globál qrcode z vendor/qrcode.js, balíček qrcode-generator) ---------- */
  const SVG_NS = "http://www.w3.org/2000/svg";
  const QR_MARGIN = 4; // tichá zóna v modulech, je součástí SVG

  // SVG s tmavými moduly na bílém poli; bez knihovny (nebo při chybě kódování) null.
  function qrSvg(url, label) {
    if (typeof window.qrcode !== "function" || !url) return null;
    let qr;
    try {
      qr = window.qrcode(0, "M");
      qr.addData(url);
      qr.make();
    } catch (err) {
      console.warn("tv-link: QR kód se nepodařilo vytvořit", err);
      return null;
    }
    const n = qr.getModuleCount();
    const size = n + QR_MARGIN * 2;
    let d = "";
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + QR_MARGIN} ${r + QR_MARGIN}h1v1h-1z`;
    }
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
    svg.setAttribute("focusable", "false");
    const bg = document.createElementNS(SVG_NS, "rect");
    bg.setAttribute("width", size);
    bg.setAttribute("height", size);
    bg.setAttribute("fill", "#fff");
    const modules = document.createElementNS(SVG_NS, "path");
    modules.setAttribute("d", d);
    modules.setAttribute("fill", "#000");
    svg.append(bg, modules);
    return svg;
  }

  // Adresa s tokenem zvýrazněným na konci (vše přes textContent).
  function fillUrl(node, url, token) {
    node.textContent = "";
    const cut = url.lastIndexOf(token);
    if (cut < 0) { node.textContent = url; return; }
    const b = document.createElement("b");
    b.textContent = token;
    node.append(url.slice(0, cut), b);
  }

  // připravuji (server zatím nic nevrátil) · ready (je adresa) · offline (chyba nebo žádná adresa v síti)
  function linkKind(i) {
    if (i.url) return "ready";
    return !i.running && !i.error ? "preparing" : "offline";
  }

  /* ---------- Dialog „Ovládání z mobilu“ ---------- */
  const QR_LABEL = "QR kód s adresou ovladače pro mobil";
  const MAX_DEVICE_ROWS = 6;
  const SLOW_RTT_MS = 300;
  const RTT_REFRESH_MS = 2000; // událost rtt nevolá onChange, odezvy se v otevřeném dialogu obnovují samy

  const dlg = document.createElement("dialog");
  dlg.id = "tvLinkDialog";
  dlg.className = "dialog help";
  dlg.setAttribute("aria-labelledby", "tvLinkTitle");
  dlg.innerHTML = `
    <div class="dialog-head">
      <h3 id="tvLinkTitle">Ovládání z mobilu</h3>
      <button type="button" class="icon-btn" id="tvLinkClose" aria-label="Zavřít" title="Zavřít"><i class="ph ph-x" aria-hidden="true"></i></button>
    </div>
    <div class="tv-link-body">
      <div class="tv-link-qr" id="tvLinkQr"></div>
      <div class="tv-link-info">
        <ol class="tv-link-steps">
          <li>Připoj mobil ke stejné Wi-Fi jako televize.</li>
          <li>Naskenuj QR kód fotoaparátem mobilu.</li>
        </ol>
        <p class="tv-link-noqr" id="tvLinkNoQr" hidden>QR kód se nepodařilo zobrazit. Napiš adresu do prohlížeče v mobilu.</p>
        <div id="tvLinkAddr">
          <p class="tv-link-alt muted">Nebo do prohlížeče v mobilu napiš adresu:</p>
          <code class="tv-link-url" id="tvLinkUrl"></code>
          <p class="tv-link-code">Kód v adrese: <b id="tvLinkToken"></b></p>
        </div>
        <p class="tv-link-status" id="tvLinkStatus" role="status" aria-live="polite"><i aria-hidden="true"></i><span></span></p>
        <ul class="tv-link-devices" id="tvLinkDevices" aria-label="Připojená zařízení" hidden></ul>
        <p class="tv-link-msg" id="tvLinkMsg" role="status" aria-live="polite"></p>
      </div>
    </div>
    <div class="confirm-actions">
      <button type="button" class="btn ghost" id="tvLinkNew"><i class="ph ph-arrows-clockwise" aria-hidden="true"></i> Nový kód</button>
      <button type="button" class="btn ghost" id="tvLinkRetry" hidden><i class="ph ph-arrows-clockwise" aria-hidden="true"></i> Zkusit znovu</button>
      <button type="button" class="btn primary" id="tvLinkDone">Zavřít</button>
    </div>`;
  // Před Nastavením serveru: tv-remote.js bere jako aktivní první dialog[open] v DOM (navigace i Zpět),
  // dialog otevřený z Nastavení tak dostane šipky a Zpět zavře jen jeho.
  const settingsDlg = $("tvSettingsDialog");
  if (settingsDlg) settingsDlg.before(dlg);
  else document.body.appendChild(dlg);

  const part = (id) => dlg.querySelector("#" + id);
  let dlgUrl;          // url, pro kterou je vykreslený QR (undefined = ještě nic)
  let dlgKind = null;
  let busy = false;    // probíhá Nový kód / Zkusit znovu
  let opener = null;   // prvek, na který se po zavření vrátí fokus
  let rttTimer = null;

  function setMsg(text, bad) {
    part("tvLinkMsg").textContent = text || "";
    part("tvLinkMsg").classList.toggle("bad", !!bad);
  }

  function renderQrBox(i, kind) {
    const box = part("tvLinkQr");
    const svg = kind === "ready" ? qrSvg(i.url, QR_LABEL) : null;
    const noLib = kind === "ready" && !svg;
    box.textContent = "";
    box.className = "tv-link-qr" + (kind === "ready" ? "" : " empty") + (kind === "offline" ? " offline" : "");
    box.hidden = noLib;
    part("tvLinkNoQr").hidden = !noLib;
    dlg.querySelector(".tv-link-body").classList.toggle("no-qr", noLib);
    dlg.querySelector(".tv-link-steps li:last-child").hidden = noLib; // „Naskenuj QR kód“ bez QR nedává smysl
    if (svg) box.appendChild(svg);
    else if (kind !== "ready") {
      const icon = document.createElement("i");
      icon.className = "ph " + (kind === "offline" ? "ph-wifi-slash" : "ph-hourglass-medium");
      icon.setAttribute("aria-hidden", "true");
      const title = document.createElement("b");
      title.textContent = kind === "offline" ? "Televize není připojená k síti" : "Připravuji připojení…";
      box.append(icon, title);
      if (kind === "offline") {
        const text = document.createElement("span");
        text.textContent = "Připoj televizi k Wi-Fi nebo kabelem do stejné sítě jako mobil a zkus to znovu.";
        box.appendChild(text);
      }
    }
    part("tvLinkAddr").hidden = kind !== "ready";
    if (kind === "ready") {
      fillUrl(part("tvLinkUrl"), i.url, i.token);
      part("tvLinkToken").textContent = i.token;
    }
  }

  function renderStatus(kind, count) {
    const st = part("tvLinkStatus");
    const [cls, icon, text] = kind === "offline" ? ["bad", "ph-wifi-slash", "Bez připojení k síti"]
      : kind === "preparing" ? ["", "ph-hourglass-medium", "Připravuji připojení…"]
      : count ? ["ok", "ph-check-circle", `Připojeno: ${count} zařízení`]
      : ["", "ph-hourglass-medium", "Čeká na připojení mobilu"];
    st.className = "tv-link-status" + (cls ? " " + cls : "");
    st.querySelector("i").className = "ph " + icon;
    const span = st.querySelector("span");
    if (span.textContent !== text) span.textContent = text; // aria-live: číst jen skutečnou změnu
  }

  function deviceRow(c, n) {
    const li = document.createElement("li");
    const slow = c.rttMs !== null && c.rttMs > SLOW_RTT_MS;
    if (slow) li.className = "slow";
    const icon = document.createElement("i");
    icon.className = "ph ph-device-mobile";
    icon.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.textContent = c.name || "Mobil " + n; // jméno z mobilu je nedůvěryhodné: jen textContent
    const rtt = document.createElement("small");
    if (slow) {
      const warn = document.createElement("i");
      warn.className = "ph ph-warning-circle";
      warn.setAttribute("aria-hidden", "true");
      rtt.append(warn, " pomalé spojení");
    } else rtt.textContent = c.rttMs !== null ? `odezva ${c.rttMs} ms` : "odezva –";
    li.append(icon, name, rtt);
    return li;
  }

  function renderDevices(connected) {
    const ul = part("tvLinkDevices");
    ul.textContent = "";
    ul.hidden = !connected.length;
    const shown = connected.length > MAX_DEVICE_ROWS ? MAX_DEVICE_ROWS - 1 : connected.length;
    connected.slice(0, shown).forEach((c, k) => ul.appendChild(deviceRow(c, k + 1)));
    if (connected.length > shown) {
      const more = document.createElement("li");
      more.className = "more";
      more.textContent = `a další ${connected.length - shown}`;
      ul.appendChild(more);
    }
  }

  // Tlačítka se nepřestavují (fokus by spadl na body), jen se přepíná Nový kód / Zkusit znovu.
  function renderButtons(kind) {
    const offline = kind === "offline";
    const hide = offline ? part("tvLinkNew") : part("tvLinkRetry");
    const show = offline ? part("tvLinkRetry") : part("tvLinkNew");
    const hadFocus = document.activeElement === hide;
    hide.hidden = true;
    show.hidden = false;
    if (hadFocus) show.focus();
  }

  // Po částech: QR, adresa a kód jen při změně url nebo stavu, stav a seznam vždy.
  function renderDialog() {
    const i = info();
    const kind = linkKind(i);
    if (i.url !== dlgUrl || kind !== dlgKind) {
      renderQrBox(i, kind);
      dlgUrl = i.url;
      dlgKind = kind;
    }
    const connected = clientList().filter((c) => c.connected);
    renderStatus(kind, connected.length);
    renderDevices(kind === "offline" ? [] : connected);
    renderButtons(kind);
  }

  function openDialog(from) {
    opener = from || document.activeElement;
    setMsg("");
    dlgUrl = undefined; // při otevření vždy překreslit celé
    renderDialog();
    if (!dlg.open) dlg.showModal();
    (dlgKind === "offline" ? part("tvLinkRetry") : part("tvLinkDone")).focus();
    clearInterval(rttTimer);
    rttTimer = setInterval(() => { if (dlg.open) renderDialog(); }, RTT_REFRESH_MS);
  }

  dlg.addEventListener("close", () => {
    clearInterval(rttTimer);
    rttTimer = null;
    const back = opener;
    opener = null;
    if (back && back.isConnected && !back.closest("dialog:not([open])")) back.focus();
  });
  part("tvLinkClose").addEventListener("click", () => dlg.close("cancel"));
  part("tvLinkDone").addEventListener("click", () => dlg.close("ok"));

  function runRestart(newToken) {
    busy = true;
    setMsg(newToken ? "Vytvářím nový kód…" : "Zkouším znovu…");
    return restart({ newToken }).then(() => {
      busy = false;
      const i = info();
      if (newToken) {
        if (i.error) setMsg("Nový kód se nepodařilo vytvořit. Zkus to znovu.", true);
        else setMsg("Nový kód je připravený. Mobily se musí připojit znovu.");
      } else setMsg(i.url ? "" : "Televize pořád není připojená k síti.", !i.url);
      if (dlg.open) renderDialog();
    });
  }

  part("tvLinkNew").addEventListener("click", () => {
    if (busy) return;
    const ask = typeof confirmDialog === "function"
      ? confirmDialog({
        icon: "📱",
        title: "Odpojit všechna zařízení a vytvořit nový kód?",
        text: "Připojené mobily se odpojí a budou muset naskenovat nový QR kód.",
        ok: "Nový kód",
        danger: true,
      })
      : Promise.resolve(true);
    ask.then((ok) => {
      if (dlg.open) part("tvLinkNew").focus();
      if (ok && !busy && dlg.open) runRestart(true);
    });
  });
  part("tvLinkRetry").addEventListener("click", () => {
    if (!busy) runRestart(false);
  });

  /* ---------- Vstupy do dialogu: menu, Nastavení serveru, nápověda na zadání ---------- */
  const menuItem = document.createElement("button");
  menuItem.setAttribute("role", "menuitem");
  menuItem.id = "menuTvLink";
  menuItem.innerHTML = '<i class="ph ph-device-mobile"></i><span>Ovládání z mobilu</span>';
  menuItem.addEventListener("click", () => {
    if (typeof closeMenu === "function") closeMenu();
    openDialog($("menuBtn"));
  });
  const menuAnchor = $("menuTvKeys") || $("menuTvSettings");
  if (menuAnchor) menuAnchor.after(menuItem);
  else document.querySelector("#menuPanel .menu-box")?.appendChild(menuItem);

  const settingsHint = document.querySelector("#tvSettingsForm > p.extra-hint");
  if (settingsHint) {
    const fromSettings = document.createElement("button");
    fromSettings.type = "button"; // formulář má method="dialog": submit by Nastavení zavřel
    fromSettings.id = "tvLinkFromSettings";
    fromSettings.className = "btn ghost tv-link-open";
    fromSettings.innerHTML = '<i class="ph ph-device-mobile" aria-hidden="true"></i> Psát z mobilu';
    fromSettings.addEventListener("click", () => openDialog(fromSettings));
    settingsHint.after(fromSettings);
  } else console.warn("tv-link: chybí #tvSettingsForm, tlačítko Psát z mobilu se nepřidá");

  const replay = $("tvReplay");
  if (replay) {
    const hint = document.createElement("p");
    hint.className = "tv-bubble-hint simple-only tv-link-hint";
    hint.innerHTML = '<i class="ph ph-device-mobile" aria-hidden="true"></i>Psát a ovládat jde i z mobilu: menu → Ovládání z mobilu';
    replay.after(hint);
  }

  /* ---------- Karta s QR na úvodní obrazovce (jen k zobrazení, bez fokusu) ---------- */
  // Vložená jako první dítě <main>; zobrazuje se jen v pohledu setup (CSS přes body[data-view]).
  // Bez adresy v síti se skryje, bez knihovny QR ukáže jen adresu textem.
  const card = document.createElement("aside");
  card.className = "tv-link-card";
  card.id = "tvLinkCard";
  card.setAttribute("aria-label", "Ovládání z mobilu");
  card.hidden = true;
  card.innerHTML = `
    <div class="tv-link-card-box">
      <div class="tv-link-card-qr"></div>
      <b class="tv-link-card-title">Ovládání z mobilu</b>
      <p class="tv-link-card-text"></p>
      <code class="tv-link-card-url"></code>
    </div>`;
  const main = $("main");
  if (main) main.prepend(card);
  let cardUrl;

  function renderCard() {
    // Připojený mobil = spárováno: QR s tokenem se z promítané obrazovky schová (viz bezpečnostní kontrola fáze 4).
    const paired = clientList().some((c) => c.connected);
    const url = paired ? null : info().url;
    if (url === cardUrl) return;
    cardUrl = url;
    const box = card.querySelector(".tv-link-card-qr");
    box.textContent = "";
    const svg = url ? qrSvg(url, QR_LABEL) : null;
    if (svg) box.appendChild(svg);
    box.hidden = !svg;
    card.querySelector(".tv-link-card-text").textContent = svg
      ? "Naskenuj QR kód fotoaparátem mobilu."
      : "QR kód se nepodařilo zobrazit. Napiš adresu do prohlížeče v mobilu.";
    card.querySelector(".tv-link-card-url").textContent = url || "";
    card.hidden = !url;
    card.classList.toggle("no-qr", !svg);
    document.body.classList.toggle("tv-link-card-on", !!url); // místo vpravo pro kartu, ať nepřekrývá zadání ani bubliny
  }

  onChange(() => {
    renderCard();
    if (dlg.open) renderDialog();
  });

  watchState();
  start();
})();
