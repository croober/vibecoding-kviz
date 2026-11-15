// TV nadstavba, část server: nastavení serveru, test spojení, přesměrování /api/* a obrázky otázek.
// Vkládá se jen do APK (android-tv/prepare.mjs), webová verze ji nenačítá.
// Závisí na prvcích z index.html: #menuPanel, #menuHelp a na funkci closeMenu() z app.js.
(() => {
  "use strict";
  const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  if (!isNative) return;
  document.body.classList.add("tv");

  const config = window.KVIZ_TV_CONFIG || {};

  /* ---------- Nastavení serveru ---------- */
  // API běží na vlastním serveru; v APK je origin jen lokální, proto se adresa serveru zadává v nastavení.
  // Token drží app.js (klíč kviz-token), adresa a basic auth jsou zde. tv-config.json dává jen výchozí hodnoty.
  const SETTINGS_KEY = "kviz-tv-settings";
  const TOKEN_KEY = "kviz-token";
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} },
  };
  const loadSettings = () => {
    let saved = {};
    try { saved = JSON.parse(store.get(SETTINGS_KEY)) || {}; } catch {}
    return {
      serverUrl: saved.serverUrl ?? config.serverUrl ?? "",
      basicAuth: saved.basicAuth ?? config.basicAuth ?? "",
    };
  };
  const saveSettings = (s) => store.set(SETTINGS_KEY, JSON.stringify(s));
  if (config.token && !store.get(TOKEN_KEY)) store.set(TOKEN_KEY, config.token);

  const normalizeUrl = (v) => v.trim().replace(/\/+$/, "");
  const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

  // požadavky na /api/* jdou na nastavený server (s basic auth, je-li zadaná)
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (typeof input !== "string" || !input.startsWith("/api/")) return nativeFetch(input, init);
    const { serverUrl, basicAuth } = loadSettings();
    if (!serverUrl) {
      openSettings();
      return Promise.reject(new Error("Nejdřív nastav adresu serveru (menu ☰ → Nastavení serveru)."));
    }
    const headers = { ...(init && init.headers) };
    if (basicAuth) headers.Authorization = `Basic ${b64(basicAuth)}`;
    return nativeFetch(normalizeUrl(serverUrl) + input, { ...init, headers });
  };

  /* ---------- Obrázky otázek ---------- */
  // app.js nastavuje img.src na relativní /api/img?u=… (proxy na serveru). V APK by mířilo na lokální adresu aplikace
  // a <img> neumí poslat basic auth, proto se obrázek stáhne přes fetch (s hlavičkami) a vloží jako blob.
  // Zachytává se setter HTMLImageElement.src, takže funguje i přednačítání přes new Image().src = …
  const IMG_PREFIX = "/api/img";
  const PLACEHOLDER = "data:image/gif;base64,R0lGODlhAQABAAAAACw="; // průhledný 1×1, ať nezůstane obrázek z předchozí otázky
  const MAX_PARALLEL_IMAGES = 4;
  const srcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  const imageCache = new Map(); // /api/img?u=… → Promise<blob: URL | null>
  const imageQueue = [];
  let imageRunning = 0;
  const pumpImages = () => {
    while (imageRunning < MAX_PARALLEL_IMAGES && imageQueue.length) {
      imageRunning++;
      imageQueue.shift()().finally(() => { imageRunning--; pumpImages(); });
    }
  };
  const loadImage = (path) => {
    if (!imageCache.has(path)) {
      imageCache.set(path, new Promise((resolve) => {
        imageQueue.push(async () => {
          try {
            const { serverUrl, basicAuth } = loadSettings();
            const headers = basicAuth ? { Authorization: `Basic ${b64(basicAuth)}` } : {};
            const res = await nativeFetch(normalizeUrl(serverUrl) + path, { headers });
            if (!res.ok) return resolve(null);
            const type = (res.headers.get("content-type") || "image/jpeg").split(";")[0];
            resolve(URL.createObjectURL(new Blob([await res.arrayBuffer()], { type })));
          } catch {
            resolve(null);
          }
        });
        pumpImages();
      }).then((url) => { if (!url) imageCache.delete(path); return url; })); // neúspěch se příště zkusí znovu
    }
    return imageCache.get(path);
  };
  const wanted = new WeakMap(); // img → naposledy požadovaná adresa (starší dokončené načtení se zahodí)
  const shown = new WeakMap(); // img → adresa, jejíž obrázek je právě zobrazený (app.js nastavuje src při každém překreslení)
  Object.defineProperty(HTMLImageElement.prototype, "src", {
    configurable: true,
    enumerable: srcDesc.enumerable,
    get() { return srcDesc.get.call(this); },
    set(value) {
      const v = String(value);
      if (!v.startsWith(IMG_PREFIX) || !loadSettings().serverUrl) {
        wanted.delete(this);
        shown.delete(this);
        return srcDesc.set.call(this, v);
      }
      wanted.set(this, v);
      if (shown.get(this) === v) return; // už zobrazeno
      shown.delete(this);
      srcDesc.set.call(this, PLACEHOLDER); // než se obrázek načte, nezůstat u obrázku z předchozí otázky
      loadImage(v).then((blobUrl) => {
        if (wanted.get(this) !== v) return;
        // bez blobu (síť, basic auth) zkusit aspoň přímou adresu serveru
        srcDesc.set.call(this, blobUrl || normalizeUrl(loadSettings().serverUrl) + v);
        shown.set(this, v);
      });
    },
  });

  const dialog = document.createElement("dialog");
  dialog.id = "tvSettingsDialog";
  dialog.className = "dialog help";
  dialog.innerHTML = `
    <form method="dialog" id="tvSettingsForm">
      <div class="dialog-head">
        <h3>Nastavení serveru</h3>
        <button type="button" class="icon-btn" id="tvCloseBtn" aria-label="Zavřít" title="Zavřít"><i class="ph ph-x"></i></button>
      </div>
      <p class="muted extra-hint">Kvízy generuje server. Text jde vložit z mobilu přes aplikaci Google TV (klávesnice v telefonu).</p>
      <label class="muted extra-hint" for="tvServerUrl">Adresa serveru</label>
      <input id="tvServerUrl" type="url" class="token-input" autocomplete="off" placeholder="https://kviz.example.cz">
      <label class="muted extra-hint" for="tvToken">Přístupový token</label>
      <div class="tv-token-row">
        <input id="tvToken" type="password" class="token-input" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="token">
        <button type="button" class="btn ghost" id="tvTokenShow" aria-pressed="false"><i class="ph ph-eye" aria-hidden="true"></i> <span>Zobrazit</span></button>
      </div>
      <label class="muted extra-hint" for="tvBasicAuth">Basic auth (jen když je server chráněný) – uživatel:heslo</label>
      <input id="tvBasicAuth" type="password" class="token-input" autocomplete="off" placeholder="uživatel:heslo">
      <p class="error" id="tvSettingsError" role="alert" hidden></p>
      <p class="tv-test-result" id="tvTestResult" role="status" hidden></p>
      <div class="confirm-actions">
        <button type="button" class="btn ghost" id="tvTestBtn"><i class="ph ph-plugs-connected" aria-hidden="true"></i> Otestovat spojení</button>
        <button type="button" class="btn ghost" id="tvCancelBtn">Zavřít</button>
        <button class="btn primary" value="ok">Uložit</button>
      </div>
    </form>`;
  document.body.appendChild(dialog);
  const field = (id) => dialog.querySelector("#" + id);

  const URL_ERROR = "Adresa serveru musí začínat https://";
  const isValidUrl = (url) => /^https:\/\/[^\s/]+/.test(url);

  function openSettings() {
    const s = loadSettings();
    field("tvServerUrl").value = s.serverUrl;
    field("tvToken").value = store.get(TOKEN_KEY) || "";
    field("tvBasicAuth").value = s.basicAuth;
    field("tvSettingsError").hidden = true;
    field("tvTestResult").hidden = true;
    field("tvToken").type = "password"; // při každém otevření skrytý
    field("tvTokenShow").querySelector("span").textContent = "Zobrazit";
    field("tvTokenShow").querySelector("i").className = "ph ph-eye";
    dialog.returnValue = "";
    if (!dialog.open) dialog.showModal();
  }

  /* ---------- Test spojení ---------- */
  // Pošle POST /api/generate s prázdným tělem: server po kontrole basic auth a tokenu vrátí validační chybu 400
  // a Claude nevolá (stejně se chová server.js i worker/). Testuje hodnoty z formuláře, i neuložené.
  const TEST_TIMEOUT_MS = 15000;
  async function testConnection() {
    const out = field("tvTestResult");
    const btn = field("tvTestBtn");
    const err = field("tvSettingsError");
    const showResult = (ok, text) => {
      out.textContent = text;
      out.className = "tv-test-result " + (ok ? "ok" : "bad");
      out.hidden = false;
    };
    err.hidden = true;
    const url = normalizeUrl(field("tvServerUrl").value);
    if (!url) return showResult(false, "Vyplň adresu serveru.");
    if (!isValidUrl(url)) return showResult(false, URL_ERROR);
    const headers = { "Content-Type": "application/json", "X-Access-Token": field("tvToken").value.trim() };
    const basic = field("tvBasicAuth").value.trim();
    if (basic) headers.Authorization = `Basic ${b64(basic)}`;

    btn.disabled = true;
    showResult(true, "Zkouším spojení…");
    try {
      const res = await Promise.race([
        nativeFetch(url + "/api/generate", { method: "POST", headers, body: "{}" }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), TEST_TIMEOUT_MS)),
      ]);
      const data = await res.json().catch(() => ({}));
      if (res.status === 400) showResult(true, "Spojení funguje: server odpovídá, přihlášení i token jsou v pořádku.");
      else if (res.status === 401 && data.code === "token") showResult(false, "Server odpovídá, ale přístupový token nesedí.");
      else if (res.status === 401) showResult(false, "Server odpovídá, ale basic auth (uživatel:heslo) nesedí nebo chybí.");
      else if (res.status === 403) showResult(false, "Server spojení odmítl (403). Zkontroluj omezení podle IP adresy v Cloudflare.");
      else if (res.status === 503) showResult(false, "Server odpovídá, ale nemá nastavený ACCESS_TOKEN (generování je vypnuté).");
      else if (res.status === 429) showResult(false, "Server hlásí příliš mnoho pokusů. Počkej minutu a zkus to znovu.");
      else if (res.status === 404) showResult(false, "Adresa odpovídá, ale není to server kvízu (404). Zkontroluj adresu.");
      else showResult(false, `Server odpověděl neočekávaně (HTTP ${res.status}).`);
    } catch (e) {
      showResult(false, e.message === "timeout"
        ? "Server neodpověděl do 15 sekund."
        : "Server se nepodařilo zastihnout. Zkontroluj adresu a připojení televize k internetu.");
    } finally {
      btn.disabled = false;
    }
  }
  field("tvTestBtn").addEventListener("click", testConnection);
  // zobrazit/skrýt token, ať je vidět, co se napsalo (klávesnice televize píše naslepo)
  field("tvTokenShow").addEventListener("click", () => {
    const input = field("tvToken");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    field("tvTokenShow").setAttribute("aria-pressed", String(show));
    field("tvTokenShow").querySelector("span").textContent = show ? "Skrýt" : "Zobrazit";
    field("tvTokenShow").querySelector("i").className = "ph " + (show ? "ph-eye-slash" : "ph-eye");
  });
  field("tvCloseBtn").addEventListener("click", () => dialog.close("cancel"));
  field("tvCancelBtn").addEventListener("click", () => dialog.close("cancel"));

  // Průběžné ukládání: údaje se zapíšou při každé změně, takže nezmizí, ať se dialog zavře jakkoli
  // (Zpět, Enter z klávesnice televize, ztráta fokusu). Adresa se čistí až při použití, nesmyslná jen nefunguje.
  function saveDraft() {
    saveSettings({ serverUrl: normalizeUrl(field("tvServerUrl").value), basicAuth: field("tvBasicAuth").value.trim() });
    store.set(TOKEN_KEY, field("tvToken").value.trim());
  }
  ["tvServerUrl", "tvToken", "tvBasicAuth"].forEach((id) => {
    field(id).addEventListener("input", saveDraft);
    field(id).addEventListener("change", saveDraft);
  });

  dialog.addEventListener("submit", (e) => {
    if (e.submitter && e.submitter.value !== "ok") return;
    const url = normalizeUrl(field("tvServerUrl").value);
    if (url && !isValidUrl(url)) {
      e.preventDefault();
      const err = field("tvSettingsError");
      err.textContent = URL_ERROR;
      err.hidden = false;
      return;
    }
    saveSettings({ serverUrl: url, basicAuth: field("tvBasicAuth").value.trim() });
    store.set(TOKEN_KEY, field("tvToken").value.trim());
  });

  // položka v menu ☰ (za Klávesové zkratky)
  const item = document.createElement("button");
  item.setAttribute("role", "menuitem");
  item.id = "menuTvSettings";
  item.innerHTML = '<i class="ph ph-hard-drives"></i><span>Nastavení serveru</span>';
  item.addEventListener("click", () => {
    if (typeof closeMenu === "function") closeMenu();
    openSettings();
  });
  const anchor = document.getElementById("menuHelp");
  if (anchor) anchor.after(item);
  else document.querySelector("#menuPanel .menu-box")?.appendChild(item);

  // sdílené s tv-remote.js
  window.KvizTv = { config, loadSettings, openSettings, store };

  // první spuštění bez adresy serveru: rovnou nastavení serveru
  if (!store.get("kviz-tv-first-seen")) {
    store.set("kviz-tv-first-seen", "1");
    if (!loadSettings().serverUrl) setTimeout(openSettings, 600);
  }
})();
