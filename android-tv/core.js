// Čistá logika TV nadstavby bez závislosti na DOM (jde otestovat v Node: core.test.js).
// V prohlížeči se vystaví jako window.KvizTvCore, v Node jako module.exports.
(function (root) {
  "use strict";

  // vzdálenost dvou intervalů (0, když se překrývají)
  function gap(aStart, aEnd, bStart, bEnd) {
    if (aEnd < bStart) return bStart - aEnd;
    if (bEnd < aStart) return aStart - bEnd;
    return 0;
  }

  // Prostorová navigace: z obdélníku `cur` vybere index nejbližšího obdélníku v daném směru
  // ("up" | "down" | "left" | "right"), nebo -1. Obdélníky: { left, top, right, bottom }.
  // Skóre: vzdálenost přivrácených hran + penalizace za posun mimo osu (preferuje prvky v řadě/sloupci).
  function pickNext(rects, cur, dir) {
    if (!cur) return -1;
    var curCx = (cur.left + cur.right) / 2;
    var curCy = (cur.top + cur.bottom) / 2;
    var best = -1;
    var bestScore = Infinity;
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i];
      if (r.left === cur.left && r.top === cur.top && r.right === cur.right && r.bottom === cur.bottom) continue;
      var cx = (r.left + r.right) / 2;
      var cy = (r.top + r.bottom) / 2;
      var ahead, primary, perpGap, perpCenter;
      if (dir === "right" || dir === "left") {
        ahead = dir === "right" ? cx > curCx + 1 : cx < curCx - 1;
        primary = dir === "right" ? Math.max(0, r.left - cur.right) : Math.max(0, cur.left - r.right);
        perpGap = gap(r.top, r.bottom, cur.top, cur.bottom);
        perpCenter = Math.abs(cy - curCy);
      } else {
        ahead = dir === "down" ? cy > curCy + 1 : cy < curCy - 1;
        primary = dir === "down" ? Math.max(0, r.top - cur.bottom) : Math.max(0, cur.top - r.bottom);
        perpGap = gap(r.left, r.right, cur.left, cur.right);
        perpCenter = Math.abs(cx - curCx);
      }
      if (!ahead) continue;
      var score = primary + perpGap * 3 + perpCenter * 0.5;
      if (score < bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  // Stabilní identifikace klávesy: TV ovladače často hlásí prázdný nebo "Unidentified" `code`, pak se použije `keyCode`.
  function keyId(e) {
    if (e.code && e.code !== "Unidentified") return e.code;
    return "kc" + e.keyCode;
  }

  // Číslice 0–4 z ovladače (body týmům): TV často hlásí prázdný `code`, proto i `key` a `keyCode` (horní řada 48–52, numerická 96–100).
  function digitOf(e) {
    var m = /^(?:Digit|Numpad)([0-4])$/.exec(e.code || "");
    if (m) return Number(m[1]);
    if (/^[0-4]$/.test(e.key || "")) return Number(e.key);
    var k = e.keyCode;
    if (k >= 48 && k <= 52) return k - 48;
    if (k >= 96 && k <= 100) return k - 96;
    return null;
  }

  // Kanál ▲/▼ (nebo PageUp/PageDown): vrací +1 / -1, jinak 0. Android: keyCode 166/167, Tizen 427/428.
  function isChannelKey(e) {
    var k = e.key, c = e.keyCode;
    if (k === "ChannelUp" || k === "PageUp" || c === 166 || c === 427 || c === 33) return 1;
    if (k === "ChannelDown" || k === "PageDown" || c === 167 || c === 428 || c === 34) return -1;
    return 0;
  }

  // Menu tlačítko ovladače (Android: ContextMenu / keyCode 82)
  function isMenuKey(e) {
    return e.key === "ContextMenu" || e.key === "Menu" || e.keyCode === 82;
  }

  // Akce, kterým jde přiřadit tlačítko ovladače. "send" = kanonická klávesa, na kterou se vlastní tlačítko přeloží.
  var ACTIONS = [
    { id: "up", label: "Nahoru (předchozí odpověď)", def: "↑", send: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 } },
    { id: "down", label: "Dolů (další odpověď)", def: "↓", send: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 } },
    { id: "left", label: "Doleva (předchozí otázka)", def: "←", send: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 } },
    { id: "right", label: "Doprava (další otázka)", def: "→", send: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 } },
    { id: "ok", label: "OK (potvrdit)", def: "OK", send: { key: "Enter", code: "Enter", keyCode: 13 } },
    { id: "team1", label: "Vybrat tým 1", def: "1", send: { key: "1", code: "Digit1", keyCode: 49 } },
    { id: "team2", label: "Vybrat tým 2", def: "2", send: { key: "2", code: "Digit2", keyCode: 50 } },
    { id: "team3", label: "Vybrat tým 3", def: "3", send: { key: "3", code: "Digit3", keyCode: 51 } },
    { id: "team4", label: "Vybrat tým 4", def: "4", send: { key: "4", code: "Digit4", keyCode: 52 } },
    { id: "all", label: "Vybrat všechny týmy", def: "0", send: { key: "0", code: "Digit0", keyCode: 48 } },
    { id: "plus", label: "Přidat bod", def: "kanál ▲", send: { key: "ChannelUp", code: "", keyCode: 166 } },
    { id: "minus", label: "Odebrat bod", def: "kanál ▼", send: { key: "ChannelDown", code: "", keyCode: 167 } },
    { id: "menu", label: "Menu", def: "Menu", send: { key: "ContextMenu", code: "ContextMenu", keyCode: 93 } }
  ];

  // Která akce je na tomhle tlačítku od výrobce (výchozí klávesy), nebo null.
  function defaultActionOf(e) {
    var byKey = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" }[e.key];
    if (byKey) return byKey;
    if (e.key === "Enter" || keyId(e) === "kc23") return "ok";
    var d = digitOf(e);
    if (d === 0) return "all";
    if (d >= 1 && d <= 4) return "team" + d;
    var ch = isChannelKey(e);
    if (ch === 1) return "plus";
    if (ch === -1) return "minus";
    if (isMenuKey(e)) return "menu";
    return null;
  }

  // Popisek tlačítka pro člověka: podle e.key, a když ho televize neposílá, podle kódu.
  function keyLabel(e) {
    var k = e.key;
    if (k && k !== "Unidentified" && k !== " " && k.length <= 20) return k.length === 1 ? k.toUpperCase() : k;
    return "kód " + (e.keyCode || keyId(e));
  }

  // Vlastní přiřazení tlačítek: jedna vlastní klávesa na akci, výchozí klávesy zůstávají vždy funkční.
  // storage = { get(k), set(k, v) }; uloženo jako { akce: { id, label } }
  var KEYS_STORAGE = "kviz-tv-keys";
  function createKeymap(storage) {
    var map = {};
    try {
      var raw = JSON.parse(storage.get(KEYS_STORAGE));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) map = raw;
    } catch (err) { map = {}; }
    function save() { storage.set(KEYS_STORAGE, JSON.stringify(map)); }
    function ownerOf(id) {
      for (var a in map) if (map[a] && map[a].id === id) return a;
      return null;
    }
    return {
      get: function (action) { return map[action] || null; },
      // akce přiřazená vlastnímu tlačítku (podle keyId), nebo null
      lookup: function (id) { return ownerOf(id); },
      // přiřadí; když je tlačítko už vlastní u jiné akce, vrátí její id a nic nezmění
      set: function (action, id, label) {
        var other = ownerOf(id);
        if (other && other !== action) return other;
        map[action] = { id: id, label: label };
        save();
        return null;
      },
      clear: function (action) { delete map[action]; save(); },
      reset: function () { map = {}; save(); },
      size: function () { return Object.keys(map).length; }
    };
  }

  // nová poloha posuvu po stisku šipky nahoru/dolů (o ~70 % výšky okna), nebo -1, když už není kam posouvat
  function scrollTarget(dir, top, scrollHeight, clientHeight) {
    var max = Math.max(0, scrollHeight - clientHeight);
    var step = Math.max(40, Math.round(clientHeight * 0.7));
    var next = Math.max(0, Math.min(max, top + (dir === "down" ? step : -step)));
    return Math.abs(next - top) < 1 ? -1 : next;
  }

  var api = { pickNext: pickNext, scrollTarget: scrollTarget, keyId: keyId, digitOf: digitOf, isChannelKey: isChannelKey, isMenuKey: isMenuKey,
    ACTIONS: ACTIONS, defaultActionOf: defaultActionOf, keyLabel: keyLabel, createKeymap: createKeymap };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.KvizTvCore = api;
})(typeof window !== "undefined" ? window : globalThis);
