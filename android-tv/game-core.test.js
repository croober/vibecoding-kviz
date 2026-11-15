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
  assert.equal(cleanName("Pepa\u3164"), "Pepa");
  assert.equal(cleanName("Pe\u00ADpa\u115F\u034F"), "Pepa");
  assert.equal(cleanName("\u3164"), null);
  assert.equal(cleanName("\u2764\uFE0F"), "\u2764\uFE0F");
  const g = createGame();
  g.join("a", "Pepa", 0, TEAMS);
  assert.equal(g.join("b", "Pepa\u3164", 0, TEAMS).player.name, "Pepa 2");
});

test("cleanName: osamělá půlka surrogate páru se nahradí", () => {
  const out = cleanName("a\uD800b");
  assert.doesNotMatch(out, LONE_SURROGATE_RE);
  assert.equal(out, "a\uFFFDb");
});

test("createGame: neplatné maxPlayers se nahradí výchozím limitem", () => {
  for (const bad of [0, -1, 2.5, "3", NaN, null]) {
    const g = createGame({ maxPlayers: bad });
    for (let i = 0; i < 12; i++) assert.equal(g.join("id" + i, "H" + i, 0, TEAMS).ok, true, String(bad));
    assert.equal(g.join("id12", "H12", 0, TEAMS).reason, "full", String(bad));
  }
});

test("cleanName: U+FE0F mimo piktogram se odstraní", () => {
  assert.equal(cleanName("\uFE0F"), null);
  assert.equal(cleanName("\uFE0F\uFE0F"), null);
  assert.equal(cleanName("Pepa\uFE0F"), "Pepa");
  assert.equal(cleanName("\u2764\uFE0F\uFE0F"), "\u2764\uFE0F");
  const g = createGame();
  g.join("a", "Pepa", 0, TEAMS);
  assert.equal(g.join("b", "Pepa\uFE0F", 0, TEAMS).player.name, "Pepa 2");
});

test("join s novými týmy před remapTeams hráče nepřesune do cizího týmu", () => {
  const g = createGame();
  g.join("x", "X", 0, TEAMS);
  g.join("y", "Y", 0, [TEAMS[1], TEAMS[2]]);
  assert.equal(g.players()[0].team, null);
  g.remapTeams([TEAMS[1], TEAMS[2]]);
  assert.deepEqual(g.players().map((p) => p.team), [null, 0]);
});

test("remapTeams: při dvou stejných týmech hráč zůstane ve svém", () => {
  const g = createGame();
  const twins = [TEAMS[0], { ...TEAMS[0] }];
  g.join("x", "X", 1, twins);
  assert.equal(g.remapTeams(twins), false);
  assert.equal(g.players()[0].team, 1);
});

// --- Kolo bzučáku ---

const Q = 3;

// Hra s hráči a0, a1 (tým 0), b0 (tým 1), c0 (tým 2) a otevřeným kolem otázky Q.
function roundGame() {
  const g = createGame();
  g.join("a0", "A0", 0, TEAMS);
  g.join("a1", "A1", 0, TEAMS);
  g.join("b0", "B0", 1, TEAMS);
  g.join("c0", "C0", 2, TEAMS);
  g.openRound(Q);
  return g;
}

function armedGame() {
  const g = roundGame();
  g.arm();
  return g;
}

test("kolo: nová hra je idle", () => {
  const r = createGame().round();
  assert.deepEqual(r, { q: null, status: "idle", paused: false, team: null, by: null, byClientId: null, lockedTeams: [], result: null });
});

test("buzz: pořadí podle rx, ne podle volání", () => {
  const g = armedGame();
  assert.deepEqual(g.buzz("a0", Q, 1050, 0), { ok: true, first: true });
  assert.deepEqual(g.buzz("b0", Q, 1040, 0), { ok: true, first: false });
  assert.equal(g.round().status, "collecting");
  assert.deepEqual(g.resolve(), { clientId: "b0", name: "B0", team: 1 });
});

test("buzz: shodné rx vyhrává dřívější volání, nekonečné rx je poslední", () => {
  let g = armedGame();
  g.buzz("b0", Q, 1000, 0);
  g.buzz("a0", Q, 1000, 0);
  assert.equal(g.resolve().clientId, "b0");

  for (const bad of [NaN, undefined, Infinity]) {
    g = armedGame();
    g.buzz("a0", Q, bad, 0);
    g.buzz("b0", Q, 99999, 0);
    assert.equal(g.resolve().clientId, "b0", String(bad));
  }

  g = armedGame();
  g.buzz("a0", Q, NaN, 0);
  g.buzz("b0", Q, Infinity, 0);
  assert.equal(g.resolve().clientId, "a0");
});

test("buzz: opakovaný stisk v collecting nezlepší čas", () => {
  const g = armedGame();
  g.buzz("a0", Q, 1050, 0);
  g.buzz("b0", Q, 1040, 0);
  assert.deepEqual(g.buzz("a0", Q, 1000, 0), { ok: true, first: false });
  assert.equal(g.resolve().clientId, "b0");
});

test("buzz: důvody v pořadí kontrol", () => {
  const g = createGame();
  g.join("a0", "A0", 0, TEAMS);
  g.join("b0", "B0", 1, TEAMS);
  g.join("x", "X", 2, TEAMS);
  g.remapTeams([TEAMS[0], TEAMS[1]]); // x zůstane bez týmu
  assert.equal(g.buzz("nikdo", Q, 0, 0).reason, "nojoin");
  assert.equal(g.buzz("x", Q, 0, 0).reason, "nojoin");
  assert.equal(g.buzz("a0", Q, 0, 0).reason, "closed"); // idle

  g.openRound(Q);
  g.setPaused(true);
  assert.equal(g.buzz("a0", Q, 0, 0).reason, "closed"); // pozastaveno i ve waiting
  g.arm();
  assert.equal(g.buzz("a0", Q, 0, 0).reason, "closed");
  g.setPaused(false);
  assert.equal(g.buzz("a0", Q + 1, 0, 0).reason, "late");

  g.buzz("a0", Q, 0, 0);
  g.resolve();
  assert.equal(g.buzz("b0", Q, 0, 0).reason, "late"); // answering
  g.release();
  assert.equal(g.buzz("a0", Q, 0, 0).reason, "locked"); // zamčený tým
  g.closeRound(null);
  assert.equal(g.buzz("b0", Q, 0, 0).reason, "closed");
});

test("buzz: předčasný stisk zamkne hráče na 1,5 s a trest se neprodlužuje", () => {
  const g = roundGame();
  const now = 5000;
  assert.deepEqual(g.buzz("a0", Q, 0, now), { ok: false, reason: "early" });
  assert.equal(g.buzz("a0", Q, 0, now + 1000).reason, "locked"); // opakovaný stisk během trestu
  g.arm();
  assert.equal(g.buzz("a0", Q, 0, now + TIMING.earlyPenaltyMs - 1).reason, "locked");
  assert.deepEqual(g.buzz("a0", Q, 0, now + TIMING.earlyPenaltyMs), { ok: true, first: true });
});

test("openRound: smaže tresty, zámky, vítěze i stisky a zachová paused", () => {
  const g = roundGame();
  g.buzz("c0", Q, 0, 1000); // trest
  g.arm();
  g.buzz("a0", Q, 0, 1000);
  g.resolve();
  g.release();
  g.buzz("b0", Q, 0, 1000);
  g.resolve();
  g.setPaused(true);
  assert.equal(g.round().status, "answering");

  g.openRound(Q + 1);
  assert.deepEqual(g.round(), { q: Q + 1, status: "waiting", paused: true, team: null, by: null, byClientId: null, lockedTeams: [], result: null });
  g.setPaused(false);
  g.arm();
  assert.equal(g.buzz("c0", Q + 1, 0, 1000).ok, true); // trest smazán
  assert.equal(g.resolve().clientId, "c0"); // starý stisk b0 nepřežil
});

test("arm: jen z waiting", () => {
  const g = createGame();
  g.join("a0", "A0", 0, TEAMS);
  g.join("b0", "B0", 1, TEAMS);
  assert.equal(g.arm(), false);
  assert.equal(g.round().status, "idle");
  g.openRound(Q);
  assert.equal(g.arm(), true);
  assert.equal(g.arm(), false);
  assert.equal(g.round().status, "armed");
  g.buzz("a0", Q, 0, 0);
  assert.equal(g.arm(), false);
  assert.equal(g.round().status, "collecting");
  g.resolve();
  assert.equal(g.arm(), false);
  assert.equal(g.round().status, "answering");
  g.closeRound("correct");
  assert.equal(g.arm(), false);
  assert.equal(g.round().status, "closed");
});

test("resolve: mimo collecting null, potom answering s vítězem", () => {
  const g = roundGame();
  assert.equal(g.resolve(), null); // waiting
  g.arm();
  assert.equal(g.resolve(), null); // armed
  assert.equal(g.round().status, "armed");
  g.buzz("b0", Q, 10, 0);
  g.resolve();
  const r = g.round();
  assert.equal(r.status, "answering");
  assert.equal(r.team, 1);
  assert.equal(r.by, "B0");
  assert.equal(r.byClientId, "b0");
  assert.equal(g.resolve(), null); // answering
});

test("resolve: odebraný vítěz se přeskočí", () => {
  let g = armedGame();
  g.buzz("a0", Q, 1, 0);
  g.buzz("b0", Q, 2, 0);
  g.remove("a0");
  assert.equal(g.resolve().clientId, "b0");

  g = armedGame();
  g.buzz("a0", Q, 1, 0);
  g.remove("a0");
  assert.equal(g.resolve(), null);
  assert.equal(g.round().status, "armed");
  assert.equal(g.resolve(), null);
});

test("release: druhá šance jen pro jiné týmy", () => {
  const g = armedGame();
  g.buzz("a0", Q, 1, 0);
  g.resolve();
  assert.deepEqual(g.release(), { open: true });
  const r = g.round();
  assert.equal(r.status, "armed");
  assert.deepEqual(r.lockedTeams, [0]);
  assert.equal(r.team, null);
  assert.equal(r.by, null);
  assert.equal(g.buzz("a1", Q, 2, 0).reason, "locked");
  assert.equal(g.buzz("b0", Q, 3, 0).ok, true);
});

test("release: bez připojeného hráče jiného týmu kolo zavře", () => {
  const g = armedGame();
  g.setConnected("b0", false);
  g.setConnected("c0", false);
  g.buzz("a0", Q, 1, 0);
  g.resolve();
  assert.deepEqual(g.release(), { open: false });
  assert.equal(g.round().status, "closed");
});

test("release: tři týmy, postupně zamčené A a B, C smí", () => {
  const g = armedGame();
  g.buzz("a0", Q, 1, 0);
  g.resolve();
  g.release();
  g.buzz("b0", Q, 2, 0);
  assert.equal(g.resolve().clientId, "b0");
  assert.deepEqual(g.release(), { open: true });
  assert.deepEqual(g.round().lockedTeams, [0, 1]);
  assert.equal(g.buzz("a0", Q, 3, 0).reason, "locked");
  assert.equal(g.buzz("b0", Q, 3, 0).reason, "locked");
  assert.equal(g.buzz("c0", Q, 3, 0).ok, true);
});

test("release: mimo answering null a nic nemění", () => {
  const g = roundGame();
  assert.equal(g.release(), null);
  g.arm();
  assert.equal(g.release(), null);
  g.buzz("a0", Q, 1, 0);
  const before = g.round();
  assert.equal(g.release(), null);
  assert.deepEqual(g.round(), before);
  assert.equal(createGame().release(), null);
});

test("closeRound: výsledek jen s vítězem a platnou hodnotou", () => {
  let g = armedGame();
  g.buzz("a0", Q, 1, 0);
  g.resolve();
  g.closeRound("correct");
  let r = g.round();
  assert.equal(r.status, "closed");
  assert.equal(r.result, "correct");
  assert.equal(r.by, "A0"); // vítěz zůstává kvůli snímku

  for (const bad of ["x", true]) {
    g = armedGame();
    g.buzz("a0", Q, 1, 0);
    g.resolve();
    g.closeRound(bad);
    assert.equal(g.round().result, null, String(bad));
  }

  g = armedGame();
  g.closeRound("correct");
  r = g.round();
  assert.equal(r.status, "closed");
  assert.equal(r.result, null);
});

test("join: hráč odpovídajícího týmu nesmí měnit tým, jiný ano", () => {
  const g = armedGame();
  g.buzz("a0", Q, 1, 0);
  assert.equal(g.join("a0", "A0", 1, TEAMS).reason, "locked"); // collecting se stiskem
  g.resolve();
  assert.equal(g.join("a1", "A1", 1, TEAMS).reason, "locked"); // answering, tým 0
  assert.equal(g.join("b0", "B0", 2, TEAMS).ok, true);
});

test("remapTeams: změna indexů v answering vrátí kolo do waiting, beze změny nic", () => {
  const g = armedGame();
  g.buzz("a0", Q, 1, 0);
  g.resolve();
  g.release();
  g.buzz("b0", Q, 2, 0);
  g.resolve();
  const before = g.round();
  assert.equal(g.remapTeams(TEAMS), false);
  assert.deepEqual(g.round(), before);

  g.remapTeams([TEAMS[1], TEAMS[0], TEAMS[2]]);
  const r = g.round();
  assert.equal(r.status, "waiting");
  assert.deepEqual(r.lockedTeams, []);
  assert.equal(r.team, null);
  assert.equal(r.by, null);
});

test("round: vrací kopii bez pending", () => {
  const g = armedGame();
  g.buzz("a0", Q, 1, 0);
  g.resolve();
  g.release();
  const r = g.round();
  assert.equal("pending" in r, false);
  r.lockedTeams.push(1);
  r.status = "idle";
  assert.deepEqual(g.round().lockedTeams, [0]);
  assert.equal(g.round().status, "armed");
});

test("game-core.js nepoužívá hodiny ani časovače", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./game-core.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /Date\.now|performance\.now|setTimeout|setInterval/);
});
