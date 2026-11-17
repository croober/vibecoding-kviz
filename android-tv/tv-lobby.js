// TV nadstavba, lobby hry s hráči: dialog „Hráči na mobilech“ (zapnutí hry, QR kód pro hráče, soupiska, odebrání hráče)
// a karta „Hrát s mobily – bzučák“ na zadání s tlačítky Zapnout / Vypnout a Nastavení (ovládají se jako ostatní tlačítka zadání).
// Vkládá se jen do APK (android-tv/prepare.mjs) hned za tv-game.js. Vzhled i chování dialogu napodobují „Ovládání z mobilu“ (tv-link.js).
// Rozhraní: kontrakt hráčů (.claude-work/2026-11-15-hraci-buzzer/kontrakt.md) § 7 (KvizTvGame, prvky a texty TV) a § 8 (karta).
//
// Bezpečnost: přezdívky hráčů, názvy týmů a jména ovladačů jsou cizí text na promítané obrazovce. Do stránky jdou
// jen přes textContent; innerHTML je tu jen u statických šablon (dialog, karta, položka menu) bez proměnných. Adresa pro hráče je vždy
// jen KvizTvGame.playerUrl() (bez klíče ovladače).
//
// Spoléhá na věci z app.js (při jejich změně zkontrolovat tenhle soubor):
//   globály: state (teams[name, emoji]), confirmDialog, closeMenu
//   prvky:   #main (sem první dítě #tvSideCards), #teams (změna dětí obnoví kartu), #menuBtn, #menuPanel .menu-box,
//            dialog[open] (aktivní je první v DOM, viz tv-remote.js)
// a na TV vrstvu: KvizTv (tv-server.js), KvizTvGame (tv-game.js), KvizTvLink.qrSvg a clients (tv-link.js),
//   #menuTvLink, #tvLinkDialog a #tvLinkCard (tv-link.js; karta se přesouvá do #tvSideCards pod kartu hry),
//   #menuTvKeys (tv-keys.js), #tvSettingsDialog (tv-server.js), prostorová navigace a Zpět (tv-remote.js).
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
  const CARD_MAX_NAMES = 10; // nejvýš přezdívek na kartě, zbytek „a další {n}“ (dál je ještě zkrátí fitCardTeams podle výšky)
  // Rezerva pod kartou: stín a zaoblení boxu nesmí zasahovat do lišty týmů, ořez v #main by je uťal.
  const CARD_FIT_MARGIN_PX = 8;

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
    <div class="tv-game-mode" id="tvGameMode" role="radiogroup" aria-labelledby="tvGameModeLabel">
      <span class="tv-game-mode-label" id="tvGameModeLabel">Režim hry</span>
      <label class="tv-game-mode-opt">
        <input type="radio" name="tvGameMode" value="buzz">
        <span class="tv-game-mode-box"><i class="ph ph-check-circle" aria-hidden="true"></i><span>Bzučák – kdo první zabzučí, odpovídá nahlas</span></span>
      </label>
      <label class="tv-game-mode-opt">
        <input type="radio" name="tvGameMode" value="answers">
        <span class="tv-game-mode-box"><i class="ph ph-check-circle" aria-hidden="true"></i><span>Odpovědi na mobilu – každý vybere 1, 2 nebo 3, rychlost přidá body</span></span>
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
  const modeRadios = [...dlg.querySelectorAll('input[name="tvGameMode"]')];
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

  const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
  const setClass = (node, cls) => { if (node.className !== cls) node.className = cls; };

  // Varování podle režimu: bzučák potřebuje 2 týmy, odpovědi aspoň 1 (kontrakt § 8). Text i viditelnost jen při změně.
  const WARN_TEXTS = { buzz: "Bzučák potřebuje aspoň 2 týmy.", answers: "Odpovědi potřebují aspoň 1 tým." };
  const MIN_TEAMS = { buzz: 2, answers: 1 };
  function renderWarn(node, s) {
    const hidden = !(s.enabled && (appState().teams || []).length < MIN_TEAMS[s.mode]);
    if (node.hidden !== hidden) node.hidden = hidden;
    setText(node.querySelector("span"), WARN_TEXTS[s.mode]);
  }

  // Stav připojení v dialogu i na kartě: uzel s <i> a <span>, třída „ok“ při aspoň jednom připojeném.
  function renderStatus(st, enabled, connectedCount) {
    st.hidden = !enabled;
    const [icon, text] = connectedCount
      ? ["ph-check-circle", `Připojeno hráčů: ${connectedCount}`]
      : ["ph-hourglass-medium", "Zatím nikdo není připojený"];
    st.classList.toggle("ok", connectedCount > 0);
    setClass(st.querySelector("i"), "ph " + icon);
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
    for (const radio of modeRadios) {
      const checked = radio.value === s.mode;
      if (radio.checked !== checked) radio.checked = checked;
    }
    renderWarn(part("tvGameWarn"), s);
    const key = `${s.enabled}|${url || ""}`;
    if (key !== qrKey) {
      renderQrBox(s.enabled, url);
      qrKey = key;
    }
    renderStatus(part("tvGameStatus"), s.enabled, list.filter((p) => p.connected).length);
    renderPlayers(list);
  }

  /* ---------- Karta „Hrát s mobily – bzučák“ na zadání (kontrakt § 8) ---------- */
  // Boční sloupec #tvSideCards je první dítě <main>: nahoře karta hry, pod ní karta ovladače z tv-link.js (přesunutý uzel).
  // Ukazuje se jen v pohledu setup (CSS). Stav off: pozvánka a Zapnout; stav on: QR pro hráče, počet, Vypnout, Nastavení, jména.
  // QR hráčů je jen ve stavu on a karta ovladače se při zapnuté hře skrývá (tv-link.js), takže oba QR nejsou vidět zároveň.
  // Tlačítka vznikají jednou; obnova mění jen texty, ikony, třídy a hidden, aby fokus ovladače nespadl na body.
  const card = document.createElement("aside");
  card.className = "tv-game-card";
  card.id = "tvGameCard";
  card.setAttribute("aria-label", "Hrát s mobily – bzučák");
  card.innerHTML = `
    <div class="tv-game-card-box">
      <div class="tv-game-card-qr" hidden></div>
      <i class="tv-game-card-icon" aria-hidden="true"></i>
      <b class="tv-game-card-title"></b>
      <p class="tv-game-card-text"></p>
      <p class="tv-game-card-status" role="status" aria-live="polite" hidden><i aria-hidden="true"></i><span></span></p>
      <p class="tv-game-card-warn" role="note" hidden><i class="ph ph-warning" aria-hidden="true"></i><span>Bzučák potřebuje aspoň 2 týmy.</span></p>
      <div class="tv-game-card-actions">
        <button type="button" id="tvGameCardToggle"><i aria-hidden="true"></i><span></span></button>
        <button type="button" class="btn ghost" id="tvGameCardSettings" aria-label="Nastavení hry s hráči" hidden><i class="ph ph-gear-six" aria-hidden="true"></i><span>Nastavení</span></button>
      </div>
      <ul class="tv-game-card-teams" hidden></ul>
    </div>`;
  const inCard = (sel) => card.querySelector(sel);
  const cardQr = inCard(".tv-game-card-qr");
  const cardIcon = inCard(".tv-game-card-icon");
  const cardTitle = inCard(".tv-game-card-title");
  const cardText = inCard(".tv-game-card-text");
  const cardStatus = inCard(".tv-game-card-status");
  const cardWarn = inCard(".tv-game-card-warn");
  const toggleBtn = inCard("#tvGameCardToggle");
  const toggleIcon = toggleBtn.querySelector("i");
  const toggleLabel = toggleBtn.querySelector("span");
  const settingsBtn = inCard("#tvGameCardSettings");
  const cardTeams = inCard(".tv-game-card-teams");
  const main = $("main");
  const linkCard = $("tvLinkCard");
  const side = main ? document.createElement("div") : null;
  if (side) {
    side.id = "tvSideCards";
    side.className = "tv-side-cards";
    side.appendChild(card);
    if (linkCard) side.appendChild(linkCard); // tv-link.js drží referenci, přesun mu nevadí
    main.prepend(side);
  }
  let cardQrKey = null; // „zapnuto|adresa“, pro kterou je vykreslené pole QR karty

  // Vzhled pozvánky (stav off) podle režimu hry; nadpis je i aria-label karty.
  const CARD_MODES = {
    buzz: {
      icon: "ph ph-bell-ringing",
      title: "Hrát s mobily – bzučák",
      text: "Hosté se připojí mobilem. Kdo první zabzučí, odpovídá za svůj tým.",
    },
    answers: {
      icon: "ph ph-device-mobile",
      title: "Hrát s mobily – odpovědi",
      text: "Hosté se připojí mobilem a odpovídají sami. Rychlá správná odpověď dá víc bodů.",
    },
  };

  const CARD_STATES = {
    off: {
      button: "btn primary",
      buttonIcon: "ph ph-power",
      label: "Zapnout",
    },
    on: {
      icon: "",
      title: "Připoj se ke hře",
      text: "Naskenuj QR kód mobilem a vyber si tým.",
      button: "btn ghost",
      buttonIcon: "",
      label: "Vypnout",
    },
  };

  // QR jen ve stavu on a jen z Game.playerUrl(); bez adresy nebo bez SVG náhradní text (vzor renderQrBox).
  function renderCardQr(enabled, url) {
    const key = `${enabled}|${url || ""}`;
    if (key === cardQrKey) return;
    cardQrKey = key;
    cardQr.textContent = "";
    cardQr.hidden = !enabled;
    const svg = enabled && url ? Link.qrSvg(url, QR_LABEL) : null;
    cardQr.className = "tv-game-card-qr" + (svg ? "" : " empty") + (enabled && !url ? " offline" : "");
    if (!enabled) return;
    if (svg) { cardQr.appendChild(svg); return; }
    const icon = document.createElement("i");
    icon.setAttribute("aria-hidden", "true");
    icon.className = url ? "ph ph-warning-circle" : "ph ph-wifi-slash";
    const title = document.createElement("b");
    title.textContent = url ? "QR kód se nepodařilo zobrazit. Adresa je v Nastavení." : "Televize není připojená k síti";
    cardQr.append(icon, title);
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
    renderMoreRow(list.length - (CARD_MAX_NAMES - left));
    cardTeams.hidden = !cardTeams.children.length;
  }

  // Řádek „a další {n}“ vždy poslední; n = hráči bez zobrazené přezdívky.
  function renderMoreRow(rest) {
    let more = cardTeams.querySelector(".tv-game-card-more");
    if (rest <= 0) { if (more) more.remove(); return; }
    if (!more) {
      more = document.createElement("li");
      more.className = "tv-game-card-more";
    }
    setText(more, `a další ${rest}`);
    cardTeams.appendChild(more);
  }

  // Seznam jmen se zkracuje, dokud karta nepřesahuje spodek #main (za ním by se ořízla bez náznaku).
  // Mimo zadání (karta skrytá) a v úzkém okně (karta pod zadáním, sloupec není sticky) se nic neměří.
  // Odebírá jen přezdívky a hlavičky týmů, které zůstaly bez jména; tlačítka, QR a stav zůstávají.
  function fitCardTeams(total) {
    if (!main || !side || card.offsetParent === null || getComputedStyle(side).position !== "sticky") return;
    const box = card.querySelector(".tv-game-card-box");
    const limit = main.getBoundingClientRect().bottom - CARD_FIT_MARGIN_PX;
    const shown = () => cardTeams.querySelectorAll(".tv-game-card-player").length;
    renderMoreRow(total - shown()); // řádek „a další“ se měří také, proto vzniká už před prvním měřením
    for (let pass = 0; pass < CARD_MAX_NAMES && box.getBoundingClientRect().bottom > limit; pass++) {
      const players = cardTeams.querySelectorAll(".tv-game-card-player");
      const last = players[players.length - 1];
      if (!last) break;
      const head = last.previousElementSibling;
      const next = last.nextElementSibling;
      last.remove();
      if (head && head.classList.contains("tv-game-card-team") && !(next && next.classList.contains("tv-game-card-player"))) head.remove();
      renderMoreRow(total - shown());
    }
    cardTeams.hidden = !cardTeams.children.length;
  }

  // Dva stavy podle Game.settings().enabled; karta je na zadání vidět vždy.
  function renderCard(s, url, list) {
    const on = s.enabled;
    const modeLook = CARD_MODES[s.mode];
    const look = on ? CARD_STATES.on : { ...CARD_STATES.off, ...modeLook };
    card.dataset.state = on ? "on" : "off";
    if (card.getAttribute("aria-label") !== modeLook.title) card.setAttribute("aria-label", modeLook.title);
    setClass(cardIcon, ("tv-game-card-icon " + look.icon).trim());
    cardIcon.hidden = !look.icon;
    setText(cardTitle, look.title);
    setText(cardText, look.text);
    setClass(toggleBtn, look.button);
    setClass(toggleIcon, look.buttonIcon);
    toggleIcon.hidden = !look.buttonIcon;
    setText(toggleLabel, look.label);
    if (!on && document.activeElement === settingsBtn) toggleBtn.focus(); // skryté tlačítko by fokus ztratilo
    settingsBtn.hidden = !on;

    renderCardQr(on, url);
    renderStatus(cardStatus, on, list.filter((p) => p.connected).length);
    renderWarn(cardWarn, s);
    if (on) renderCardTeams(list);
    else { cardTeams.textContent = ""; cardTeams.hidden = true; }

    card.hidden = false;
    document.body.classList.toggle("tv-game-card-on", card.isConnected && !card.hidden); // místo vpravo na zadání (CSS)
    if (side) side.classList.toggle("both", !!linkCard && !linkCard.hidden); // dvě karty ve sloupci: menší QR (CSS)
    if (on) fitCardTeams(list.length); // až po rozložení stránky (třída těla mění šířku zadání)
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
    // Hra vypnutá v dialogu skryje Nastavení na kartě: fokus pak na Zapnout vedle něj.
    const back = opener === settingsBtn && settingsBtn.hidden ? toggleBtn : opener;
    opener = null;
    if (back && back.isConnected && !back.closest("dialog:not([open])")) back.focus();
  });
  part("tvGameClose").addEventListener("click", () => dlg.close("cancel"));
  part("tvGameDone").addEventListener("click", () => dlg.close("ok"));

  Game.onChange(refresh);
  Link.onChange(refresh);
  const teamsNode = $("teams");
  if (teamsNode) new MutationObserver(refresh).observe(teamsNode, { childList: true });
  else console.warn("tv-lobby: chybí prvek #teams, karta se po změně týmů neobnoví");
  // Skrytá karta (mimo zadání) nejde změřit: po návratu na zadání a po změně velikosti okna se seznam přepočítá z plného soupisu.
  new MutationObserver(refresh).observe(document.body, { attributes: true, attributeFilter: ["data-view"] });
  window.addEventListener("resize", refresh);
  refresh(); // karta po startu aplikace (hra mohla zůstat zapnutá)

  /* ---------- Přepínače, tlačítka karty a odebrání hráče ---------- */
  const ask = (opts) => (typeof confirmDialog === "function" ? confirmDialog(opts) : Promise.resolve(true));

  // Jediná cesta k zapnutí (přepínač v dialogu i karta). Zapnutí vymění klíč ovladače: připojené ovladače
  // ho dostanou samy, proto je moderátor nejdřív uvidí podle jmen. Po dokončení fokus zpět na back.
  function requestEnable(back) {
    const remotes = Link.clients().filter((c) => c.connected);
    const names = remotes.map((c, n) => c.name || "Mobil " + (n + 1)).join(", ");
    const confirmed = remotes.length
      ? ask({
          icon: "📱",
          title: "Zapnout hru s hráči?",
          text: `Kód ovladače se vymění a staré odkazy přestanou platit. Připojené ovladače zůstanou: ${names}. Pokud některý nepoznáváš, zruš to a v menu → Ovládání z mobilu dej Nový kód.`,
          ok: "Zapnout",
        })
      : Promise.resolve(true);
    return confirmed.then((ok) => {
      if (ok) Game.setEnabled(true);
      refresh();
      if (back && back.isConnected && !back.closest("dialog:not([open])")) back.focus();
    });
  }

  enabledBox.addEventListener("change", () => {
    if (!enabledBox.checked) { Game.setEnabled(false); return; }
    enabledBox.checked = false; // zůstane vypnuto, dokud se zapnutí nepotvrdí
    requestEnable(enabledBox);
  });
  autoBox.addEventListener("change", () => Game.setAutoPoints(autoBox.checked));
  // Přepnutí režimu jen ukládá volbu: klíč ovladače ani běžící kolo se nemění, fokus zůstává na zvoleném přepínači.
  for (const radio of modeRadios) {
    radio.addEventListener("change", () => { if (radio.checked) Game.setMode(radio.value); });
  }

  // Vypnutí bez dotazu (R50); fokus zůstává na tlačítku, mění se jen jeho text.
  toggleBtn.addEventListener("click", () => {
    if (Game.settings().enabled) Game.setEnabled(false);
    else requestEnable(toggleBtn);
  });
  settingsBtn.addEventListener("click", () => openDialog(settingsBtn));

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
