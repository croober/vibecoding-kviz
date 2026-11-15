// TV nadstavba, část nastavení tlačítek ovladače: dialog „Ovládání TV“ (menu ☰), vlastní přiřazení akcí a překlad kláves.
// Vkládá se jen do APK (android-tv/prepare.mjs) a MUSÍ se načíst před tv-remote.js: vlastní tlačítko se tu přeloží na běžnou
// klávesu (šipka, Enter, číslice, kanál, Menu) dřív, než ji uvidí obsluha ovládání.
//
// Pravidla: výchozí tlačítka akcí fungují vždy (nejde se zamknout); vlastní tlačítko je jedno na akci a nesmí kolidovat
// s výchozím tlačítkem jiné akce ani s vlastním tlačítkem jiné akce. Zpět přemapovat nejde (řeší ho Android).
//
// Spoléhá na věci z app.js: globál closeMenu; prvky #menuPanel, #menuTvSettings, #menuHelp.
(() => {
  "use strict";
  if (!window.KvizTv || !window.KvizTvCore) return; // jen v TV režimu (APK)
  const { ACTIONS, createKeymap, defaultActionOf, keyLabel, keyId } = window.KvizTvCore;
  const $ = (id) => document.getElementById(id);
  const keymap = createKeymap(window.KvizTv.store);
  const actionById = (id) => ACTIONS.find((a) => a.id === id);
  const BACK_KEYS = ["Escape", "GoBack", "BrowserBack"];

  const labelOf = (id) => {
    const own = keymap.get(id);
    return own ? own.label : actionById(id).def;
  };
  const changed = () => window.dispatchEvent(new Event("kviz-tv-keys-changed"));

  /* ---------- Dialog ---------- */
  const capApp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  const backAvailable = !!(capApp && capApp.addListener);

  const dlg = document.createElement("dialog");
  dlg.id = "tvKeysDialog";
  dlg.className = "dialog help";
  dlg.innerHTML = `
    <div class="dialog-head">
      <h3>Ovládání TV</h3>
      <button type="button" class="icon-btn" id="tvKeysClose" aria-label="Zavřít" title="Zavřít"><i class="ph ph-x"></i></button>
    </div>
    <details class="tv-sec" id="tvSecKeys">
      <summary><span>Tlačítka ovladače</span><small id="tvKeysSum"></small></summary>
      <p class="muted extra-hint">U každé akce je vidět, které tlačítko ji ovládá. „Změnit“ přiřadí jiné tlačítko ovladače. Výchozí tlačítka fungují pořád. Zpět přiřazování zruší.</p>
      <div class="tv-key-rows" id="tvKeyRows"></div>
      <p class="tv-key-msg" id="tvKeyMsg" role="status" aria-live="polite"></p>
      <div class="confirm-actions">
        <button type="button" class="btn ghost" id="tvKeysReset">Obnovit výchozí</button>
      </div>
    </details>
    <details class="tv-sec" id="tvSecSize">
      <summary><span>Velikost rozhraní</span><small id="tvSizeSum"></small></summary>
      <div class="tv-size-row">
        <span class="tv-key-name">Menší číslo šířky = větší rozhraní</span>
        <button type="button" class="btn ghost" id="tvSizeBigger">Větší</button>
        <b id="tvSizeVal"></b>
        <button type="button" class="btn ghost" id="tvSizeSmaller">Menší</button>
      </div>
    </details>
    <details class="tv-sec" id="tvSecSound">
      <summary><span>Zvuk</span><small id="tvSoundSum"></small></summary>
      <div class="tv-size-row">
        <span class="tv-key-name">Zvukové odezvy kvízu (odpovědi, body, výsledky)</span>
        <button type="button" class="btn ghost" id="tvSoundDown">Tišeji</button>
        <b id="tvSoundVal"></b>
        <button type="button" class="btn ghost" id="tvSoundUp">Hlasitěji</button>
      </div>
      <div class="confirm-actions">
        <button type="button" class="btn ghost" id="tvSoundTest">Vyzkoušet zvuk</button>
      </div>
    </details>
    <details class="tv-sec" id="tvSecInfo">
      <summary><span>Informace o zařízení</span><small>poslední stisk, Zpět, verze</small></summary>
      <div class="tv-key-info" id="tvKeyInfo" aria-live="polite">Poslední stisknuté tlačítko: zatím nic.</div>
      <p class="muted extra-hint" id="tvBackInfo"></p>
      <p class="muted extra-hint" id="tvBuildInfo"></p>
      <p class="muted extra-hint" id="tvScreenInfo"></p>
    </details>
    <div class="confirm-actions">
      <button type="button" class="btn primary" id="tvKeysDone">Zavřít</button>
    </div>`;
  document.body.appendChild(dlg);
  const showScreen = () => { $("tvScreenInfo").textContent = "Obrazovka: " + window.innerWidth + " × " + window.innerHeight + " px, měřítko (DPR) " + (window.devicePixelRatio || 1); };
  showScreen();
  window.addEventListener("resize", showScreen);
  $("tvBuildInfo").textContent = "Verze aplikace: 1.0." + (window.KVIZ_TV_BUILD || "?");
  $("tvBackInfo").textContent = backAvailable
    ? "Tlačítko Zpět: funguje (aplikace ho zachytává)."
    : "Tlačítko Zpět: aplikace ho nezachytává, Zpět může aplikaci rovnou zavřít.";

  /* ---------- Velikost rozhraní ---------- */
  // šířka rozvržení v CSS px (viewport): menší číslo = větší rozhraní. Televize hlásí 960 px, což je moc velké, 1920 moc malé.
  const WIDTHS = [1120, 1280, 1440, 1600, 1760, 1920];
  const WIDTH_KEY = "kviz-tv-width";
  const DEFAULT_WIDTH = 1440;
  const savedWidth = () => { const w = Number(window.KvizTv.store.get(WIDTH_KEY)); return WIDTHS.includes(w) ? w : DEFAULT_WIDTH; };
  function applyWidth(w) {
    const meta = document.querySelector('meta[name="viewport"]');
    if (meta) meta.setAttribute("content", "width=" + w + ", user-scalable=no");
    $("tvSizeVal").textContent = Math.round((1440 / w) * 100) + " %";
    $("tvSizeBigger").disabled = WIDTHS.indexOf(w) <= 0;
    $("tvSizeSmaller").disabled = WIDTHS.indexOf(w) >= WIDTHS.length - 1;
    if (typeof updateSummaries === "function") updateSummaries();
  }
  function stepWidth(d) {
    const i = Math.max(0, Math.min(WIDTHS.length - 1, WIDTHS.indexOf(savedWidth()) + d));
    window.KvizTv.store.set(WIDTH_KEY, String(WIDTHS[i]));
    applyWidth(WIDTHS[i]);
    setTimeout(showScreen, 300); // rozměr okna se po změně metaznačky přepočítá se zpožděním
  }
  $("tvSizeBigger").addEventListener("click", () => stepWidth(-1));
  $("tvSizeSmaller").addEventListener("click", () => stepWidth(1));
  applyWidth(savedWidth());

  // jen jeden blok otevřený naráz (na TV je málo místa); souhrn vedle názvu ukazuje stav bez rozbalení
  /* ---------- Zvuk ---------- */
  const snd = window.KvizTvSound;
  function renderSound() {
    const n = snd ? snd.getLevel() : 0;
    $("tvSoundVal").textContent = snd ? snd.LEVELS[n].name : "nedostupný";
    $("tvSoundDown").disabled = !snd || n <= 0;
    $("tvSoundUp").disabled = !snd || n >= snd.LEVELS.length - 1;
    $("tvSoundTest").disabled = !snd || n === 0;
    $("tvSoundSum").textContent = $("tvSoundVal").textContent;
  }
  if (snd) {
    $("tvSoundDown").addEventListener("click", () => { snd.setLevel(snd.getLevel() - 1); renderSound(); snd.play("plus", true); });
    $("tvSoundUp").addEventListener("click", () => { snd.setLevel(snd.getLevel() + 1); renderSound(); snd.play("plus", true); });
    $("tvSoundTest").addEventListener("click", () => { snd.play("correct", true); setTimeout(() => snd.play("wrong", true), 700); });
  }
  renderSound();

  dlg.querySelectorAll("details.tv-sec > summary").forEach((sm) => sm.addEventListener("click", () => {
    const d = sm.parentNode;
    if (!d.open) dlg.querySelectorAll("details.tv-sec").forEach((o) => { if (o !== d) o.open = false; }); // klik se ještě nezpracoval: d se právě otevírá
  }));
  function updateSummaries() {
    const n = ACTIONS.filter((a) => keymap.get(a.id)).length;
    $("tvKeysSum").textContent = n ? n + " vlastní" : "všechna výchozí";
    $("tvSizeSum").textContent = $("tvSizeVal").textContent;
  }

  let capturing = null; // id akce, na kterou se čeká na stisk tlačítka
  const setMsg = (t, bad) => {
    $("tvKeyMsg").textContent = t || "";
    $("tvKeyMsg").classList.toggle("bad", !!bad);
  };

  function renderRows(focusAction) {
    const rows = $("tvKeyRows");
    rows.innerHTML = "";
    ACTIONS.forEach((a) => {
      const own = keymap.get(a.id);
      const row = document.createElement("div");
      row.className = "tv-key-row" + (capturing === a.id ? " capturing" : "");
      const name = document.createElement("span");
      name.className = "tv-key-name";
      name.textContent = a.label;
      const cur = document.createElement("span");
      cur.className = "tv-key-cur";
      if (capturing === a.id) cur.textContent = "Stiskni tlačítko…";
      else if (own) cur.innerHTML = `<b></b> <small>vlastní · výchozí ${a.def} zůstává</small>`, cur.querySelector("b").textContent = own.label;
      else cur.innerHTML = `<b></b> <small>výchozí</small>`, cur.querySelector("b").textContent = a.def;
      const change = document.createElement("button");
      change.type = "button";
      change.className = "btn ghost";
      change.dataset.action = a.id;
      change.dataset.act = "change";
      change.textContent = capturing === a.id ? "Zrušit" : "Změnit";
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "btn ghost";
      clear.dataset.action = a.id;
      clear.dataset.act = "clear";
      clear.textContent = "Výchozí";
      clear.disabled = !own;
      row.append(name, cur, change, clear);
      rows.appendChild(row);
    });
    updateSummaries();
    if (focusAction) {
      const b = rows.querySelector(`[data-action="${focusAction}"][data-act="change"]`);
      if (b) b.focus();
    }
  }

  $("tvKeyRows").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const id = b.dataset.action;
    if (b.dataset.act === "clear") {
      keymap.clear(id);
      setMsg("Vráceno výchozí tlačítko.");
      renderRows(id);
      changed();
    } else if (capturing === id) {
      capturing = null;
      setMsg("");
      renderRows(id);
    } else {
      capturing = id;
      setMsg(`Stiskni tlačítko ovladače pro: ${actionById(id).label}. Zpět = zrušit.`);
      renderRows(id);
    }
  });
  $("tvKeysReset").addEventListener("click", () => {
    keymap.reset();
    capturing = null;
    setMsg("Všechna tlačítka jsou zpět na výchozích.");
    renderRows();
    changed();
  });
  $("tvKeysClose").addEventListener("click", () => dlg.close("cancel"));
  $("tvKeysDone").addEventListener("click", () => dlg.close("ok"));
  dlg.addEventListener("close", () => { capturing = null; setMsg(""); });

  // stisk v režimu přiřazování
  function onCaptureKey(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat) return;
    const action = capturing;
    if (BACK_KEYS.includes(e.key)) return onBack();
    const owner = defaultActionOf(e);
    if (owner === action) { // výchozí tlačítko téže akce: vlastní se ruší
      keymap.clear(action);
      capturing = null;
      setMsg(`Tohle je výchozí tlačítko této akce, platí výchozí nastavení.`);
      renderRows(action);
      changed();
      return;
    }
    if (owner) return setMsg(`Toto tlačítko je pevně určené pro: ${actionById(owner).label}. Zkus jiné.`, true);
    const other = keymap.set(action, keyId(e), keyLabel(e));
    if (other) return setMsg(`Toto tlačítko už ovládá: ${actionById(other).label}. Zkus jiné.`, true);
    capturing = null;
    setMsg(`Nastaveno: ${keyLabel(e)}.`);
    renderRows(action);
    changed();
  }

  // Zpět z tv-remote.js: při přiřazování ho zruší (true = zpracováno)
  function onBack() {
    if (!capturing || !dlg.open) return false;
    const a = capturing;
    capturing = null;
    setMsg("Přiřazování zrušeno.");
    renderRows(a);
    return true;
  }

  /* ---------- Překlad vlastních tlačítek (musí být první listener kláves) ---------- */
  window.addEventListener("keydown", (e) => {
    if (e.tvMapped || e.tvSynthetic) return;
    if (dlg.open) $("tvKeyInfo").textContent = `Poslední stisk: key ${e.key} · code ${e.code || "(prázdné)"} · keyCode ${e.keyCode} · id ${keyId(e)}`;
    if (capturing && dlg.open && !e.tvLink) return onCaptureKey(e);
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const action = keymap.lookup(keyId(e));
    if (!action) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const s = actionById(action).send;
    const ev = new KeyboardEvent("keydown", { key: s.key, code: s.code, keyCode: s.keyCode, bubbles: true, cancelable: true, repeat: e.repeat });
    ev.tvMapped = true; // přeložená klávesa jde dál normální obsluhou
    (document.activeElement || document.body).dispatchEvent(ev);
  }, true);

  /* ---------- Položka v menu ---------- */
  const item = document.createElement("button");
  item.setAttribute("role", "menuitem");
  item.id = "menuTvKeys";
  item.innerHTML = '<i class="ph ph-television-simple"></i><span>Ovládání TV</span>';
  item.addEventListener("click", () => {
    if (typeof closeMenu === "function") closeMenu();
    renderRows();
    renderSound();
    setMsg("");
    dlg.querySelectorAll("details.tv-sec").forEach((d) => (d.open = false)); // vždy začít se sbalenými bloky
    dlg.showModal();
  });
  const anchor = $("menuTvSettings") || $("menuHelp");
  if (anchor) anchor.after(item);
  else document.querySelector("#menuPanel .menu-box")?.appendChild(item);

  window.KvizTvKeys = { keymap, labelOf, onBack };
})();
