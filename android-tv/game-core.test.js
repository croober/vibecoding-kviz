import { test } from "node:test";
import assert from "node:assert/strict";
// klasický skript pro prohlížeč; v Node se vystaví přes globalThis
import "./game-core.js";

const { LIMITS, TIMING, cleanName, createGame } = globalThis.KvizGameCore;

const TEAMS = [
  { name: "Červení", emoji: "🔴", color: "#f00" },
  { name: "Modří", emoji: "🔵", color: "#00f" },
  { name: "Zelení", emoji: "🟢", color: "#0f0" }
];
const FORBIDDEN_RE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
const cp = (s) => Array.from(s).length;

test("konstanty podle kontraktu", () => {
  assert.deepEqual(LIMITS, { name: 16, players: 12, teams: 4 });
  assert.deepEqual(TIMING, { armDelayMs: 1000, windowMs: 60, earlyPenaltyMs: 1500 });
});

test("cleanName: ořez a sloučení bílých znaků", () => {
  assert.equal(cleanName("  Pepa   z  Brna "), "Pepa z Brna");
  assert.equal(cleanName("a\tb\nc"), "a b c");
});

test("cleanName: null pro nepoužitelné vstupy", () => {
  for (const v of ["", "   ", "\u0000\u0007\u001F", "\u200B\u202E\uFEFF", 5, null, undefined, {}, ["a"]]) {
    assert.equal(cleanName(v), null, String(v));
  }
});

test("cleanName: neviditelné znaky se odstraní (podvržení jména)", () => {
  for (const v of ["Pe\u200Bpa", "\u202EPepa", "Pepa\uFEFF", "Pe\u0000pa"]) {
    assert.equal(cleanName(v), "Pepa");
  }
});

test("cleanName: zkrácení na 16 kódových bodů", () => {
  assert.equal(cleanName("a".repeat(20)), "a".repeat(16));
  const emoji = cleanName("😀".repeat(20));
  assert.equal(cp(emoji), 16);
  assert.equal(emoji, "😀".repeat(16));
  assert.doesNotMatch(emoji, LONE_SURROGATE_RE);
  assert.equal(cleanName("a".repeat(15) + " " + "b".repeat(5)), "a".repeat(15));
});

test("cleanName: výstup neobsahuje zakázané znaky", () => {
  const inputs = ["a\u0001b\u007Fc\u0085d", "x\u200Dy\u2066z\u2069", "\u202Aab\u202C", "t\u2060u\uFEFFv", "q\r\n\tw"];
  for (const v of inputs) assert.doesNotMatch(cleanName(v), FORBIDDEN_RE, JSON.stringify(v));
});

test("join: stejné jméno dostane příponu", () => {
  const g = createGame();
  assert.equal(g.join("a", "Pepa", 0, TEAMS).player.name, "Pepa");
  assert.equal(g.join("b", "Pepa", 0, TEAMS).player.name, "Pepa 2");
  assert.equal(g.join("c", "Pepa", 1, TEAMS).player.name, "Pepa 3");
  assert.equal(g.join("d", "PEPA", 1, TEAMS).player.name, "PEPA 4");
  assert.equal(g.join("e", "pepa", 1, TEAMS).player.name, "pepa 5");
});

test("join: vlastní jméno hráče se nepočítá", () => {
  const g = createGame();
  g.join("a", "Pepa", 0, TEAMS);
  g.join("b", "Franta", 0, TEAMS);
  assert.equal(g.join("a", "Pepa", 1, TEAMS).player.name, "Pepa");
  assert.equal(g.join("a", "pepa", 1, TEAMS).player.name, "pepa");
});

test("join: přípona u jména o 16 znacích", () => {
  const g = createGame();
  g.join("a", "x".repeat(16), 0, TEAMS);
  const name = g.join("b", "x".repeat(16), 0, TEAMS).player.name;
  assert.ok(cp(name) <= 16);
  assert.match(name, / 2$/);
  const emoji = g.join("c", "😀".repeat(16), 0, TEAMS).player.name;
  const second = g.join("d", "😀".repeat(16), 0, TEAMS).player.name;
  assert.equal(emoji, "😀".repeat(16));
  assert.ok(cp(second) <= 16);
  assert.match(second, / 2$/);
  assert.doesNotMatch(second, LONE_SURROGATE_RE);
});

test("join: neplatný tým nebo jméno", () => {
  const g = createGame();
  for (const team of [-1, 1.5, "0", null, undefined, TEAMS.length]) {
    assert.deepEqual(g.join("a", "Pepa", team, TEAMS), { ok: false, reason: "invalid" }, String(team));
  }
  assert.equal(g.join("a", "Pepa", 0, []).reason, "invalid");
  assert.equal(g.join("a", "Pepa", 0, undefined).reason, "invalid");
  assert.equal(g.join("a", "  ", 0, TEAMS).reason, "invalid");
  assert.equal(g.players().length, 0);
});

test("join: existující clientId mění jméno a tým, hráč nepřibývá", () => {
  const g = createGame();
  g.join("a", "Pepa", 0, TEAMS);
  const res = g.join("a", "Karel", 2, TEAMS);
  assert.deepEqual(res, { ok: true, player: { clientId: "a", name: "Karel", team: 2 } });
  assert.equal(g.players().length, 1);
  assert.equal(g.players()[0].name, "Karel");
  assert.equal(g.players()[0].team, 2);
});

test("join: limit hráčů a uvolnění odpojeným", () => {
  const g = createGame({ maxPlayers: 2 });
  g.join("a", "A", 0, TEAMS);
  g.join("b", "B", 0, TEAMS);
  assert.deepEqual(g.join("c", "C", 0, TEAMS), { ok: false, reason: "full" });
  assert.equal(g.join("a", "A2", 1, TEAMS).ok, true);
  g.setConnected("a", false);
  assert.equal(g.join("c", "C", 0, TEAMS).ok, true);
  assert.deepEqual(g.players().map((p) => p.clientId), ["b", "c"]);
});

test("join: výchozí limit je 12", () => {
  const g = createGame();
  for (let i = 0; i < 12; i++) assert.equal(g.join("id" + i, "H" + i, 0, TEAMS).ok, true);
  assert.equal(g.join("id12", "H12", 0, TEAMS).reason, "full");
});

test("players: kopie bez interních polí", () => {
  const g = createGame();
  g.join("a", "Pepa", 0, TEAMS);
  const list = g.players();
  assert.deepEqual(Object.keys(list[0]).sort(), ["clientId", "connected", "name", "team"]);
  list[0].name = "Hacker";
  list[0].team = 2;
  list.push({});
  assert.equal(g.players()[0].name, "Pepa");
  assert.equal(g.players()[0].team, 0);
  assert.equal(g.players().length, 1);
});

test("remove a setConnected: neznámý clientId vrací false", () => {
  const g = createGame();
  g.join("a", "Pepa", 0, TEAMS);
  assert.equal(g.remove("x"), false);
  assert.equal(g.setConnected("x", true), false);
  assert.equal(g.setConnected("a", false), true);
  assert.equal(g.players()[0].connected, false);
  assert.equal(g.remove("a"), true);
  assert.equal(g.players().length, 0);
});

test("remapTeams: prohození týmů, přejmenování, odebrání, beze změny", () => {
  const g = createGame();
  g.join("a", "Pepa", 0, TEAMS);
  g.join("b", "Franta", 1, TEAMS);
  assert.equal(g.remapTeams(TEAMS), false);

  const swapped = [TEAMS[1], TEAMS[0], TEAMS[2]];
  assert.equal(g.remapTeams(swapped), true);
  assert.deepEqual(g.players().map((p) => p.team), [1, 0]);

  const renamed = [swapped[0], { ...swapped[1], name: "Rudí" }, swapped[2]];
  assert.equal(g.remapTeams(renamed), true);
  assert.deepEqual(g.players().map((p) => p.team), [1, 0]);
  // po přejmenování se hráč drží dál na stejném indexu
  assert.equal(g.remapTeams(renamed), false);

  assert.equal(g.remapTeams([renamed[0]]), true);
  assert.deepEqual(g.players().map((p) => p.team), [null, 0]);
  assert.equal(g.remapTeams([renamed[0]]), false);
});

test("remapTeams: změna počtu týmů je změna", () => {
  const g = createGame();
  g.join("a", "Pepa", 0, TEAMS);
  assert.equal(g.remapTeams([TEAMS[0], TEAMS[1]]), true);
  assert.equal(g.players()[0].team, 0);
});

test("clientId __proto__ a constructor soupisku nerozbije", () => {
  const g = createGame();
  assert.equal(g.join("__proto__", "A", 0, TEAMS).ok, true);
  assert.equal(g.join("constructor", "B", 1, TEAMS).ok, true);
  assert.equal(g.join("__proto__", "A2", 2, TEAMS).ok, true);
  assert.deepEqual(g.players().map((p) => [p.clientId, p.name, p.team]), [["__proto__", "A2", 2], ["constructor", "B", 1]]);
  assert.equal(g.setConnected("constructor", false), true);
  assert.equal(g.remove("__proto__"), true);
  assert.equal(g.remove("toString"), false);
  // totéž jako přezdívka: nesmí se tvářit jako obsazená
  assert.equal(g.join("x", "__proto__", 0, TEAMS).player.name, "__proto__");
  assert.equal(g.join("y", "constructor", 0, TEAMS).player.name, "constructor");
});

test("remapTeams: odebrání prvního ze tří týmů, hráči odebraného týmu zůstanou bez týmu", () => {
  const g = createGame();
  g.join("x", "X", 0, TEAMS);
  g.join("y", "Y", 1, TEAMS);
  g.join("z", "Z", 2, TEAMS);
  assert.equal(g.remapTeams([TEAMS[1], TEAMS[2]]), true);
  assert.deepEqual(g.players().map((p) => p.team), [null, 0, 1]);
  g.remapTeams([TEAMS[1]]);
  assert.deepEqual(g.players().map((p) => p.team), [null, 0, null]);
});

test("remapTeams: úprava názvu, emoji nebo barvy při stejném počtu hráče ponechá", () => {
  const g = createGame();
  g.join("x", "X", 0, TEAMS);
  g.join("y", "Y", 1, TEAMS);
  const edited = [{ ...TEAMS[0], name: "Rudí" }, { ...TEAMS[1], emoji: "💙" }, TEAMS[2]];
  assert.equal(g.remapTeams(edited), true);
  assert.deepEqual(g.players().map((p) => p.team), [0, 1]);
  const recolored = [edited[0], { ...edited[1], color: "#007" }, edited[2]];
  assert.equal(g.remapTeams(recolored), true);
  assert.deepEqual(g.players().map((p) => p.team), [0, 1]);
});

test("cleanName: ignorovatelné znaky Unicode se odstraní, variační selektor emoji zůstane", () => {
  assert.equal(cleanName("Pepaㅤ"), "Pepa");
  assert.equal(cleanName("Pe­paᅟ͏"), "Pepa");
  assert.equal(cleanName("ㅤ"), null);
  assert.equal(cleanName("❤️"), "❤️");
  const g = createGame();
  g.join("a", "Pepa", 0, TEAMS);
  assert.equal(g.join("b", "Pepaㅤ", 0, TEAMS).player.name, "Pepa 2");
});

test("cleanName: osamělá půlka surrogate páru se nahradí", () => {
  const out = cleanName("a\uD800b");
  assert.doesNotMatch(out, LONE_SURROGATE_RE);
  assert.equal(out, "a�b");
});

test("createGame: neplatné maxPlayers se nahradí výchozím limitem", () => {
  for (const bad of [0, -1, 2.5, "3", NaN, null]) {
    const g = createGame({ maxPlayers: bad });
    for (let i = 0; i < 12; i++) assert.equal(g.join("id" + i, "H" + i, 0, TEAMS).ok, true, String(bad));
    assert.equal(g.join("id12", "H12", 0, TEAMS).reason, "full", String(bad));
  }
});
