// TV nadstavba, lobby hry s hráči: dialog „Hráči na mobilech“ (zapnutí hry, QR kód pro hráče, soupiska, odebrání hráče).
// Vkládá se jen do APK (android-tv/prepare.mjs) hned za tv-game.js. Vzhled i chování dialogu napodobují „Ovládání z mobilu“ (tv-link.js).
// Rozhraní: kontrakt hráčů (.claude-work/2026-11-15-hraci-buzzer/kontrakt.md) § 7 (KvizTvGame, prvky a texty TV).
//
// Bezpečnost: přezdívky hráčů, názvy týmů a jména ovladačů jsou cizí text na promítané obrazovce. Do stránky jdou
// jen přes textContent; innerHTML je tu jen u statické šablony dialogu bez proměnných. Adresa pro hráče je vždy
// jen KvizTvGame.playerUrl() (bez klíče ovladače).
//
// Spoléhá na věci z app.js (při jejich změně zkontrolovat tenhle soubor):
//   globály: state (teams[name, emoji]), confirmDialog, closeMenu
//   prvky:   #menuBtn, #menuPanel .menu-box, dialog[open] (aktivní je první v DOM, viz tv-remote.js)
// a na TV vrstvu: KvizTv (tv-server.js), KvizTvGame (tv-game.js), KvizTvLink.qrSvg a clients (tv-link.js),
//   #menuTvLink a #tvLinkDialog (tv-link.js), #menuTvKeys (tv-keys.js), #tvSettingsDialog (tv-server.js).
(() => {
  "use strict";
  const Game = window.KvizTvGame;
  const Link = window.KvizTvLink;
  if (!window.KvizTv || !Game || !Link) return; // jen v APK s herním režimem; webová verze skončí tiše

  const $ = (id) => document.getElementById(id);
  const appState = () => (typeof state !== "undefined" ? state : {});
  const QR_LABEL = "QR kód s adresou pro hráče";
  const SLOW_RTT_MS = 300;
  const REFRESH_MS = 2000; // odezvy hráčů nevolají onChange, otevřený dialog se obnovuje sám
  const NO_TEAM = "none";
  const CARD_MAX_NAMES = 12; // přezdívek na kartě, zbytek „a další {n}“

  /* ---------- Dialog ---------- */
  const dlg = document.createElement("dialog");
  dlg.id = "tvGameDialog";
  dlg.className = "dialog help";
  dlg.setAttribute("aria-labelledby", "tvGameTitle");
  dlg.innerHTML = `
    <div class="dialog-head">
      <h3 id="tvGameTitle">Hráči na mobilech</h3>
      <button type="button" class="icon-btn" id="tvGameClose" aria-label="Zavřít" title="Zavřít"><i class="ph ph-x" aria-hidden="true"></i></button>
    </div>
    <div class="tv-game-toggles">
      <label class="toggle">
        <input type="checkbox" id="tvGameEnabled">
        <span class="switch" aria-hidden="true"></span>
        <span class="toggle-text">Hra s hráči</span>
      </label>
      <label class="toggle">
        <input type="checkbox" id="tvGameAuto">
        <span class="switch" aria-hidden="true"></span>
        <span class="toggle-text">Bod za správnou odpověď automaticky</span>
      </label>
    </div>
    <p class="tv-game-warn" id="tvGameWarn" role="note" hidden><i class="ph ph-warning" aria-hidden="true"></i><span>Bzučák potřebuje aspoň 2 týmy.</span></p>
    <div class="tv-game-body">
      <div class="tv-game-qr" id="tvGameQr"></div>
      <div class="tv-game-info">
        <ol class="tv-game-steps">
          <li>Připoj mobil ke stejné Wi-Fi jako televize.</li>
          <li>Naskenuj QR kód a vyber si tým.</li>
        </ol>
        <code class="tv-game-url" id="tvGameUrl" hidden></code>
        <p class="tv-game-status" id="tvGameStatus" role="status" aria-live="polite"><i aria-hidden="true"></i><span></span></p>
        <ul class="tv-game-players" id="tvGamePlayers" aria-label="Připojení hráči" hidden></ul>
      </div>
    </div>
    <div class="confirm-actions">
      <button type="button" class="btn primary" id="tvGameDone">Zavřít</button>
    </div>`;
  // Před Ovládáním z mobilu: tv-remote.js bere jako aktivní první dialog[open] v DOM.
  const linkDlg = $("tvLinkDialog");
  if (linkDlg) linkDlg.before(dlg);
  else document.body.appendChild(dlg);

  const part = (id) => dlg.querySelector("#" + id);
  const enabledBox = part("tvGameEnabled");
  const autoBox = part("tvGameAuto");
  const playersUl = part("tvGamePlayers");
  let qrKey = null;   // „zapnuto|adresa“, pro kterou je vykreslené pole QR
  let opener = null;  // prvek, na který se po zavření vrátí fokus
  let timer = null;

  /* ---------- Pole QR a adresa ---------- */
  function renderQrBox(enabled, url) {
    const box = part("tvGameQr");
    const urlNode = part("tvGameUrl");
    const svg = enabled && url ? Link.qrSvg(url, QR_LABEL) : null;
    box.textContent = "";
    box.className = "tv-game-qr" + (svg ? "" : " empty") + (enabled && !url ? " offline" : "");
    urlNode.hidden = !(enabled && url);
    urlNode.textContent = enabled && url ? url : "";
    if (svg) { box.appendChild(svg); return; }
    const icon = document.createElement("i");
    icon.setAttribute("aria-hidden", "true");
    const title = document.createElement("b");
    if (!enabled) {
      icon.className = "ph ph-users-three";
      title.textContent = "Zapni hru s hráči a ukáže se QR kód pro připojení.";
    } else if (!url) {
      icon.className = "ph ph-wifi-slash";
      title.textContent = "Televize není připojená k síti";
    } else { // adresa je, ale QR se nepodařilo vykreslit: zbývá textová adresa
      icon.className = "ph ph-warning-circle";
      title.textContent = "QR kód se nepodařilo zobrazit. Adresu opiš do prohlížeče v mobilu.";
    }
    box.append(icon, title);
  }

  function renderStatus(enabled, connectedCount) {
    const st = part("tvGameStatus");
    st.hidden = !enabled;
    const [cls, icon, text] = connectedCount
      ? ["ok", "ph-check-circle", `Připojeno hráčů: ${connectedCount}`]
      : ["", "ph-hourglass-medium", "Zatím nikdo není připojený"];
    st.className = "tv-game-status" + (cls ? " " + cls : "");
    st.querySelector("i").className = "ph " + icon;
    const span = st.querySelector("span");
    if (span.textContent !== text) span.textContent = text; // aria-live: číst jen skutečnou změnu
  }

  /* ---------- Soupiska: řádky drží podle clientId, obnova mění jen texty ---------- */
  const rows = new Map();    // clientId -> { li, name, small, smallKey, btn }
  const groups = new Map();  // klíč týmu (index nebo NO_TEAM) -> { li, label }

  function groupFor(key) {
    let g = groups.get(key);
    if (!g) {
      const li = document.createElement("li");
      li.className = "tv-game-group";
      g = { li, label: document.createElement("span") };
      li.appendChild(g.label);
      groups.set(key, g);
    }
    return g;
  }

  function groupLabel(key) {
    if (key === NO_TEAM) return "Bez týmu";
    const team = (appState().teams || [])[key];
    return team ? `${team.emoji} ${team.name}` : "Bez týmu";
  }

  function makeRow(p) {
    const li = document.createElement("li");
    li.className = "tv-game-player";
    const icon = document.createElement("i");
    icon.className = "ph ph-device-mobile";
    icon.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    const small = document.createElement("small");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn ghost";
    btn.textContent = "Odebrat";
    btn.addEventListener("click", () => askKick(p.clientId, name.textContent));
    li.append(icon, name, small, btn);
    return { li, name, small, smallKey: null, btn };
  }

  // Stav hráče vždy i textem (ne jen barvou): odezva / pomalé spojení / odpojeno.
  function fillStatus(row, p) {
    const slow = p.connected && p.rttMs !== null && p.rttMs > SLOW_RTT_MS;
    const text = !p.connected ? "odpojeno" : slow ? "pomalé spojení" : p.rttMs !== null ? `odezva ${p.rttMs} ms` : "odezva –";
    row.li.classList.toggle("slow", slow);
    row.li.classList.toggle("off", !p.connected);
    if (row.smallKey === text) return;
    row.smallKey = text;
    row.small.textContent = "";
    if (slow) {
      const warn = document.createElement("i");
      warn.className = "ph ph-warning-circle";
      warn.setAttribute("aria-hidden", "true");
      row.small.append(warn, " " + text);
    } else row.small.textContent = text;
  }

  function teamKey(p) {
    const teams = appState().teams || [];
    return Number.isInteger(p.team) && p.team >= 0 && p.team < teams.length ? p.team : NO_TEAM;
  }

  function renderPlayers(list) {
    const focused = document.activeElement;
    const focusedId = [...rows].find(([, r]) => r.btn === focused);
    const teamCount = (appState().teams || []).length;
    const keys = [];
    for (let i = 0; i < teamCount; i++) keys.push(i);
    keys.push(NO_TEAM);

    const wanted = [];
    const seen = new Set();
    for (const key of keys) {
      const inGroup = list.filter((p) => teamKey(p) === key);
      if (!inGroup.length) continue;
      const g = groupFor(key);
      const label = groupLabel(key);
      if (g.label.textContent !== label) g.label.textContent = label;
      wanted.push(g.li);
      for (const p of inGroup) {
        let row = rows.get(p.clientId);
        if (!row) { row = makeRow(p); rows.set(p.clientId, row); }
        if (row.name.textContent !== p.name) row.name.textContent = p.name; // cizí text: jen textContent
        fillStatus(row, p);
        seen.add(p.clientId);
        wanted.push(row.li);
      }
    }
    for (const [id, row] of rows) {
      if (!seen.has(id)) { row.li.remove(); rows.delete(id); }
    }
    for (const g of groups.values()) {
      if (!wanted.includes(g.li)) g.li.remove(); // hlavička prázdné skupiny; uzel se znovu použije
    }
    // Uzly se přesouvají jen tam, kde nesedí pořadí; zbytek (i fokusované tlačítko) zůstává na místě.
    wanted.forEach((node, i) => {
      if (playersUl.children[i] !== node) playersUl.insertBefore(node, playersUl.children[i] || null);
    });
    playersUl.hidden = !wanted.length;

    if (dlg.open && focusedId && document.activeElement !== focusedId[1].btn) {
      const row = rows.get(focusedId[0]);
      (row && row.btn.isConnected ? row.btn : part("tvGameDone")).focus();
    }
  }

  /* ---------- Obnova otevřeného dialogu ---------- */
  function renderDialog(s, url, list) {
    if (enabledBox.checked !== s.enabled) enabledBox.checked = s.enabled;
    if (autoBox.checked !== s.autoPoints) autoBox.checked = s.autoPoints;
    autoBox.disabled = !s.enabled;
    part("tvGameWarn").hidden = !(s.enabled && (appState().teams || []).length < 2);
    const key = `${s.enabled}|${url || ""}`;
    if (key !== qrKey) {
      renderQrBox(s.enabled, url);
      qrKey = key;
    }
    renderStatus(s.enabled, list.filter((p) => p.connected).length);
    renderPlayers(list);
  }

  /* ---------- Karta na zadání: QR a kdo je v kterém týmu (jen k zobrazení, bez fokusu) ---------- */
  // Vložená jako první dítě <main>, ukazuje se jen v pohledu setup (CSS). Karta ovladače se při hře s hráči skrývá (tv-link.js).
  const card = document.createElement("aside");
  card.className = "tv-game-card";
  card.id = "tvGameCard";
  card.setAttribute("aria-label", "Připoj se ke hře");
  card.hidden = true;
  card.innerHTML = `
    <div class="tv-game-card-box">
      <div class="tv-game-card-qr"></div>
      <b class="tv-game-card-title">Připoj se ke hře</b>
      <p class="tv-game-card-text">Naskenuj QR kód mobilem a vyber si tým.</p>
      <ul class="tv-game-card-teams"></ul>
    </div>`;
  const cardQr = card.querySelector(".tv-game-card-qr");
  const cardTeams = card.querySelector(".tv-game-card-teams");
  const main = $("main");
  if (main) main.prepend(card);
  let cardUrl = null; // adresa, pro kterou je vykreslené QR karty

  function renderCardQr(url) {
    if (url === cardUrl) return;
    cardUrl = url;
    cardQr.textContent = "";
    const svg = url ? Link.qrSvg(url, QR_LABEL) : null;
    if (svg) cardQr.appendChild(svg);
  }

  // Přezdívky po týmech, nejvýš CARD_MAX_NAMES; zbytek jen počtem. Odpojený hráč zeslabeně a s textem.
  function renderCardTeams(list) {
    cardTeams.textContent = "";
    let left = CARD_MAX_NAMES;
    for (const key of [...(appState().teams || []).keys(), NO_TEAM]) {
      const inGroup = list.filter((p) => teamKey(p) === key);
      if (!inGroup.length || !left) continue;
      const head = document.createElement("li");
      head.className = "tv-game-card-team";
      head.textContent = groupLabel(key);
      cardTeams.appendChild(head);
      for (const p of inGroup.slice(0, left)) {
        const li = document.createElement("li");
        li.className = "tv-game-card-player" + (p.connected ? "" : " off");
        li.textContent = p.connected ? p.name : `${p.name} (odpojeno)`;
        cardTeams.appendChild(li);
      }
      left -= Math.min(left, inGroup.length);
    }
    const rest = list.length - (CARD_MAX_NAMES - left);
    if (rest > 0) {
      const more = document.createElement("li");
      more.className = "tv-game-card-more";
      more.textContent = `a další ${rest}`;
      cardTeams.appendChild(more);
    }
    cardTeams.hidden = !cardTeams.children.length;
  }

  function renderCard(s, url, list) {
    renderCardQr(s.enabled ? url : null);
    const visible = !!cardUrl && cardQr.firstChild !== null;
    card.hidden = !visible;
    document.body.classList.toggle("tv-game-card-on", visible); // místo vpravo, ať karta nepřekrývá zadání ani bubliny
    if (visible) renderCardTeams(list);
  }

  /* ---------- Jedna obnova: nastavení a soupiska se čtou jednou pro kartu i dialog ---------- */
  function refresh() {
    const s = Game.settings();
    const url = Game.playerUrl();
    const list = s.enabled ? Game.players() : [];
    renderCard(s, url, list);
    if (dlg.open) renderDialog(s, url, list);
  }

  function openDialog(from) {
    opener = from || document.activeElement;
    qrKey = null; // při otevření vždy překreslit celé
    refresh();
    if (!dlg.open) dlg.showModal();
    part("tvGameDone").focus();
    clearInterval(timer);
    timer = setInterval(() => { if (dlg.open) refresh(); }, REFRESH_MS);
  }

  dlg.addEventListener("close", () => {
    clearInterval(timer);
    timer = null;
    const back = opener;
    opener = null;
    if (back && back.isConnected && !back.closest("dialog:not([open])")) back.focus();
  });
  part("tvGameClose").addEventListener("click", () => dlg.close("cancel"));
  part("tvGameDone").addEventListener("click", () => dlg.close("ok"));

  Game.onChange(refresh);
  Link.onChange(refresh);
  refresh(); // karta po startu aplikace (hra mohla zůstat zapnutá)

  /* ---------- Přepínače a odebrání hráče ---------- */
  const ask = (opts) => (typeof confirmDialog === "function" ? confirmDialog(opts) : Promise.resolve(true));

  // Zapnutí vymění klíč ovladače: připojené ovladače ho dostanou samy, proto je moderátor nejdřív uvidí podle jmen.
  enabledBox.addEventListener("change", () => {
    if (!enabledBox.checked) { Game.setEnabled(false); return; }
    const remotes = Link.clients().filter((c) => c.connected);
    if (!remotes.length) { Game.setEnabled(true); return; }
    enabledBox.checked = false; // zůstane vypnuto, dokud moderátor nepotvrdí
    const names = remotes.map((c, n) => c.name || "Mobil " + (n + 1)).join(", ");
    ask({
      icon: "📱",
      title: "Zapnout hru s hráči?",
      text: `Kód ovladače se vymění a staré odkazy přestanou platit. Připojené ovladače zůstanou: ${names}. Pokud některý nepoznáváš, zruš to a v menu → Ovládání z mobilu dej Nový kód.`,
      ok: "Zapnout",
    }).then((ok) => {
      if (ok) Game.setEnabled(true);
      if (dlg.open) {
        refresh();
        enabledBox.focus();
      }
    });
  });
  autoBox.addEventListener("change", () => Game.setAutoPoints(autoBox.checked));

  function askKick(clientId, name) {
    ask({
      icon: "📱",
      title: `Odebrat hráče ${name}?`,
      text: "Z tohoto mobilu se do hry nepřipojí, dokud hru s hráči nevypneš a znovu nezapneš.",
      ok: "Odebrat",
      danger: true,
    }).then((ok) => {
      if (ok) Game.kick(clientId);
      if (!dlg.open) return;
      refresh();
      const row = rows.get(clientId);
      (row && row.btn.isConnected ? row.btn : part("tvGameDone")).focus();
    });
  }

  /* ---------- Položka menu ---------- */
  const menuItem = document.createElement("button");
  menuItem.setAttribute("role", "menuitem");
  menuItem.id = "menuTvGame";
  menuItem.innerHTML = '<i class="ph ph-users-three"></i><span>Hráči na mobilech</span>';
  menuItem.addEventListener("click", () => {
    if (typeof closeMenu === "function") closeMenu();
    openDialog($("menuBtn"));
  });
  const menuAnchor = $("menuTvLink") || $("menuTvKeys") || $("menuTvSettings");
  if (menuAnchor) menuAnchor.after(menuItem);
  else document.querySelector("#menuPanel .menu-box")?.appendChild(menuItem);
})();
