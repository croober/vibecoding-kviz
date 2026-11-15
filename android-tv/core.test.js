import { test } from "node:test";
import assert from "node:assert/strict";
// core.js je klasický skript pro prohlížeč; v Node (kořenový package.json má "type": "module") se vystaví přes globalThis
import "./core.js";

const { pickNext, scrollTarget, keyId, digitOf, isChannelKey } = globalThis.KvizTvCore;

const box = (left, top, w = 100, h = 50) => ({ left, top, right: left + w, bottom: top + h });
// mřížka 3×3, políčka 100×50 s mezerou 20
const grid = [];
for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) grid.push(box(c * 120, r * 70));

test("pickNext: mřížka, čtyři směry z prostředního políčka", () => {
  const cur = grid[4];
  assert.equal(pickNext(grid, cur, "up"), 1);
  assert.equal(pickNext(grid, cur, "down"), 7);
  assert.equal(pickNext(grid, cur, "left"), 3);
  assert.equal(pickNext(grid, cur, "right"), 5);
});

test("pickNext: na okraji mřížky není kam jít", () => {
  assert.equal(pickNext(grid, grid[0], "left"), -1);
  assert.equal(pickNext(grid, grid[0], "up"), -1);
  assert.equal(pickNext(grid, grid[8], "right"), -1);
  assert.equal(pickNext(grid, grid[8], "down"), -1);
});

test("pickNext: bez aktuálního prvku nebo bez kandidátů vrací -1", () => {
  assert.equal(pickNext(grid, null, "down"), -1);
  assert.equal(pickNext([], grid[0], "down"), -1);
});

test("pickNext: přednost má prvek ve stejné řadě před blízkým úhlopříčným", () => {
  const cur = box(0, 0);
  const sameRowFar = box(400, 0);
  const diagonalNear = box(110, 200);
  assert.equal(pickNext([diagonalNear, sameRowFar], cur, "right"), 1);
});

test("pickNext: svislý seznam odpovědí A/B/C", () => {
  const answers = [box(0, 0, 800, 80), box(0, 100, 800, 80), box(0, 200, 800, 80)];
  assert.equal(pickNext(answers, answers[0], "down"), 1);
  assert.equal(pickNext(answers, answers[1], "down"), 2);
  assert.equal(pickNext(answers, answers[2], "down"), -1);
  assert.equal(pickNext(answers, answers[2], "up"), 1);
});

test("pickNext: z odpovědí dolů na lištu týmů (jiná šířka a poloha)", () => {
  const answer = box(100, 300, 800, 80);
  const teams = [box(40, 600, 220, 70), box(280, 600, 220, 70), box(520, 600, 220, 70), box(760, 600, 220, 70)];
  const idx = pickNext(teams, answer, "down");
  assert.ok(idx >= 0 && idx <= 3);
  assert.equal(pickNext(teams, teams[1], "right"), 2);
  assert.equal(pickNext(teams, teams[3], "right"), -1);
  assert.equal(pickNext([answer, ...teams], teams[0], "up"), 0); // jediný kandidát nad týmem je odpověď
});

test("pickNext: prvek, který není ve směru, se nebere (stejný střed, překryv)", () => {
  const cur = box(0, 0);
  const same = box(0, 0);
  const above = box(0, -80);
  assert.equal(pickNext([same, above], cur, "down"), -1);
  assert.equal(pickNext([same, above], cur, "up"), 1);
});

test("keyId: použije code, jinak keyCode (TV ovladače často hlásí prázdný code)", () => {
  assert.equal(keyId({ code: "ArrowUp", keyCode: 38 }), "ArrowUp");
  assert.equal(keyId({ code: "", keyCode: 183 }), "kc183");
  assert.equal(keyId({ code: "Unidentified", keyCode: 427 }), "kc427");
  assert.equal(keyId({ keyCode: 23 }), "kc23");
});


test("digitOf: číslice z key, code i keyCode (TV často hlásí prázdný code)", () => {
  assert.equal(digitOf({ code: "Digit3", key: "3" }), 3);
  assert.equal(digitOf({ code: "Numpad0", key: "0" }), 0);
  assert.equal(digitOf({ code: "", key: "Unidentified", keyCode: 50 }), 2);
  assert.equal(digitOf({ code: "", key: "4" }), 4);
  assert.equal(digitOf({ code: "", key: "Unidentified", keyCode: 100 }), 4);
  assert.equal(digitOf({ code: "Digit5", key: "5", keyCode: 53 }), null);
  assert.equal(digitOf({ code: "Enter", key: "Enter", keyCode: 13 }), null);
});

test("isChannelKey: kanál nahoru/dolů z key i keyCode", () => {
  assert.equal(isChannelKey({ key: "ChannelUp" }), 1);
  assert.equal(isChannelKey({ key: "Unidentified", keyCode: 167 }), -1);
  assert.equal(isChannelKey({ key: "PageDown", keyCode: 34 }), -1);
  assert.equal(isChannelKey({ key: "Enter", keyCode: 13 }), 0);
});

const C = globalThis.KvizTvCore;
const mem = () => { const d = {}; return { get: (k) => d[k] ?? null, set: (k, v) => { d[k] = v; } }; };

test("defaultActionOf: výchozí tlačítka akcí", () => {
  assert.equal(C.defaultActionOf({ key: "ArrowUp" }), "up");
  assert.equal(C.defaultActionOf({ key: "Enter" }), "ok");
  assert.equal(C.defaultActionOf({ key: "Unidentified", code: "", keyCode: 23 }), "ok");
  assert.equal(C.defaultActionOf({ key: "3", code: "Digit3" }), "team3");
  assert.equal(C.defaultActionOf({ key: "0", code: "Digit0" }), "all");
  assert.equal(C.defaultActionOf({ key: "ChannelUp" }), "plus");
  assert.equal(C.defaultActionOf({ key: "x", keyCode: 167 }), "minus");
  assert.equal(C.defaultActionOf({ key: "ContextMenu" }), "menu");
  assert.equal(C.defaultActionOf({ key: "F5", code: "F5", keyCode: 116 }), null);
});

test("ACTIONS: id unikátní a každá akce má kanonickou klávesu, která se vrací jako výchozí", () => {
  const ids = C.ACTIONS.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const a of C.ACTIONS) assert.equal(C.defaultActionOf(a.send), a.id, a.id);
});

test("keyLabel: popisek podle key, jinak podle kódu", () => {
  assert.equal(C.keyLabel({ key: "F5", keyCode: 116 }), "F5");
  assert.equal(C.keyLabel({ key: "r", keyCode: 82 }), "R");
  assert.equal(C.keyLabel({ key: "Unidentified", code: "", keyCode: 183 }), "kód 183");
});

test("createKeymap: nastavení, dohledání a uložení", () => {
  const st = mem();
  const km = C.createKeymap(st);
  assert.equal(km.set("team1", "kc183", "kód 183"), null);
  assert.equal(km.lookup("kc183"), "team1");
  assert.equal(km.get("team1").label, "kód 183");
  assert.equal(C.createKeymap(st).lookup("kc183"), "team1");
});

test("createKeymap: kolize vrátí akci, která tlačítko už používá; nové přiřazení akci přepíše", () => {
  const km = C.createKeymap(mem());
  km.set("team1", "kc183", "a");
  assert.equal(km.set("team2", "kc183", "a"), "team1");
  assert.equal(km.lookup("kc183"), "team1");
  assert.equal(km.set("team1", "kc184", "b"), null); // přepsání vlastní klávesy téže akce
  assert.equal(km.lookup("kc183"), null);
  assert.equal(km.lookup("kc184"), "team1");
});

test("createKeymap: clear, reset a poškozený JSON", () => {
  const km = C.createKeymap(mem());
  km.set("ok", "kc1", "x"); km.set("menu", "kc2", "y");
  km.clear("ok");
  assert.equal(km.size(), 1);
  km.reset();
  assert.equal(km.size(), 0);
  const bad = mem(); bad.set("kviz-tv-keys", "{rozbité");
  assert.equal(C.createKeymap(bad).size(), 0);
});

test("scrollTarget: posun o 70 % okna, u okraje -1", () => {
  assert.equal(scrollTarget("down", 0, 3000, 1000), 700);
  assert.equal(scrollTarget("down", 1900, 3000, 1000), 2000);
  assert.equal(scrollTarget("down", 2000, 3000, 1000), -1);
  assert.equal(scrollTarget("up", 300, 3000, 1000), 0);
  assert.equal(scrollTarget("up", 0, 3000, 1000), -1);
  assert.equal(scrollTarget("down", 0, 800, 1000), -1);
});
