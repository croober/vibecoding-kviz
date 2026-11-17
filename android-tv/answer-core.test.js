import { test } from "node:test";
import assert from "node:assert/strict";
// klasický skript pro prohlížeč; v Node se vystaví přes globalThis
import "./answer-core.js";

const { KEYS, TIMING, points, createAnswers } = globalThis.KvizAnswerCore;

const PLAYER = { clientId: "a", team: 0 };
const LIMIT = 30000;

// Otevřené kolo s hodinami JS od 1000 (deadlineAt = 31000).
function openRound() {
  const answers = createAnswers();
  const round = answers.open(2, LIMIT, 1000);
  return { answers, round };
}

test("konstanty podle kontraktu", () => {
  assert.deepEqual(KEYS, ["a", "b", "c"]);
  assert.deepEqual(TIMING, { limitMs: 30000, revealDelayMs: 1500 });
});

test("points: příklady se základem 1", () => {
  assert.equal(points(1, 0, LIMIT), 2);
  assert.equal(points(1, 15999, LIMIT), 2);
  assert.equal(points(1, 16000, LIMIT), 1);
  assert.equal(points(1, 30000, LIMIT), 1);
  assert.equal(points(1, 45000, LIMIT), 1);
  assert.equal(points(1, null, LIMIT), 1);
});

test("points: příklady se základem 3", () => {
  assert.equal(points(3, 0, LIMIT), 6);
  assert.equal(points(3, 10000, LIMIT), 5);
  assert.equal(points(3, 29000, LIMIT), 3);
});

test("points: záporný čas jako nula, neplatný limit bez bonusu", () => {
  assert.equal(points(1, -5000, LIMIT), 2);
  assert.equal(points(1, 0, 0), 1);
  assert.equal(points(1, 0, Infinity), 1);
  assert.equal(points(1, Infinity, LIMIT), 1);
});

test("points: neplatný základ dá 0", () => {
  assert.equal(points(0, 0, LIMIT), 0);
  assert.equal(points(1.5, 0, LIMIT), 0);
  assert.equal(points(-1, 0, LIMIT), 0);
  assert.equal(points("1", 0, LIMIT), 0);
});

test("open: čísla kol rostou a každé otevření maže hlasy i openAt", () => {
  const answers = createAnswers();
  assert.equal(answers.open(0, LIMIT, 0), 1);
  assert.equal(answers.setOpenAt(1, 500), true);
  assert.deepEqual(answers.answer("a", 1, "a", 600, 10, PLAYER), { ok: true });
  assert.equal(answers.open(1, LIMIT, 0), 2);
  assert.equal(answers.count(), 0);
  // openAt smazané: pozdější sentAt se znovu přijme
  assert.equal(answers.setOpenAt(2, 900), true);
  assert.equal(answers.open(2, LIMIT, 0), 3);
  assert.equal(answers.round().status, "open");
  assert.equal(answers.round().closeReason, null);
});

test("open: neplatný limit nahradí výchozí, bez hodin JS bez deadlineAt", () => {
  const answers = createAnswers();
  answers.open(0, -1, 100);
  assert.equal(answers.round().limitMs, TIMING.limitMs);
  assert.equal(answers.round().deadlineAt, 100 + TIMING.limitMs);
  answers.open(0, 5000, Infinity);
  assert.equal(answers.round().limitMs, 5000);
  assert.equal(answers.round().deadlineAt, null);
});

test("cancel: číslo kola nesníží a smaže hlasy", () => {
  const { answers } = openRound();
  answers.answer("a", 1, "b", 10, 10, PLAYER);
  answers.cancel();
  assert.equal(answers.running(), false);
  assert.equal(answers.count(), 0);
  assert.equal(answers.round().status, "idle");
  assert.equal(answers.round().round, 1);
  assert.equal(answers.open(0, LIMIT, 0), 2);
});

test("answer: hráč bez týmu → nojoin i v zavřeném kole", () => {
  const answers = createAnswers();
  assert.deepEqual(answers.answer("a", 0, "a", 0, 0, null), { ok: false, reason: "nojoin" });
  assert.deepEqual(answers.answer("a", 0, "a", 0, 0, { team: null }), { ok: false, reason: "nojoin" });
  assert.deepEqual(answers.answer("a", 0, "a", 0, 0, { team: -1 }), { ok: false, reason: "nojoin" });
  assert.deepEqual(answers.answer("a", 0, "a", 0, 0, { team: 1.5 }), { ok: false, reason: "nojoin" });
  const { answers: opened } = openRound();
  assert.deepEqual(opened.answer("a", 1, "a", 0, 10, undefined), { ok: false, reason: "nojoin" });
});

test("answer: kolo neotevřené nebo zavřené → closed (před late i invalid)", () => {
  const answers = createAnswers();
  assert.deepEqual(answers.answer("a", 99, "x", 0, 0, PLAYER), { ok: false, reason: "closed" });
  answers.open(0, LIMIT, 0);
  answers.close("all");
  assert.deepEqual(answers.answer("a", 99, "x", 0, 10, PLAYER), { ok: false, reason: "closed" });
});

test("answer: starý round v otevřeném kole → late (před uzávěrkou i invalid)", () => {
  const { answers, round } = openRound();
  answers.open(3, LIMIT, 1000);
  assert.deepEqual(answers.answer("a", round, "x", 0, 99999, PLAYER), { ok: false, reason: "late" });
  assert.deepEqual(answers.answer("a", "2", "a", 0, 10, PLAYER), { ok: false, reason: "late" });
});

test("answer: now >= deadlineAt → closed, i když stav je open", () => {
  const { answers, round } = openRound();
  assert.deepEqual(answers.answer("a", round, "x", 0, 31000, PLAYER), { ok: false, reason: "closed" });
  assert.deepEqual(answers.answer("a", round, "a", 0, 40000, PLAYER), { ok: false, reason: "closed" });
  assert.equal(answers.round().status, "open");
  assert.deepEqual(answers.answer("a", round, "a", 0, 30999, PLAYER), { ok: true });
});

test("answer: nekonečné now se při open nekontroluje", () => {
  const { answers, round } = openRound();
  assert.deepEqual(answers.answer("a", round, "a", 0, Infinity, PLAYER), { ok: true });
  assert.deepEqual(answers.answer("b", round, "a", 0, NaN, { team: 1 }), { ok: true });
});

test("answer: neznámý klíč → invalid", () => {
  const { answers, round } = openRound();
  assert.deepEqual(answers.answer("a", round, "d", 0, 10, PLAYER), { ok: false, reason: "invalid" });
  assert.deepEqual(answers.answer("a", round, undefined, 0, 10, PLAYER), { ok: false, reason: "invalid" });
  assert.equal(answers.count(), 0);
});

test("answer: druhý hlas téhož hráče → locked a první hlas zůstává", () => {
  const { answers, round } = openRound();
  assert.deepEqual(answers.answer("a", round, "a", 100, 10, PLAYER), { ok: true });
  assert.deepEqual(answers.answer("a", round, "b", 50, 20, PLAYER), { ok: false, reason: "locked" });
  assert.deepEqual(answers.answer("a", round, "x", 50, 20, PLAYER), { ok: false, reason: "invalid" });
  assert.equal(answers.count(), 1);
  assert.equal(answers.allAnswered(["a"]), true);
});

test("answer: neplatné rx hlas nezablokuje", () => {
  const { answers, round } = openRound();
  assert.deepEqual(answers.answer("a", round, "a", "100", 10, PLAYER), { ok: true });
  assert.deepEqual(answers.answer("b", round, "c", undefined, 10, { team: 1 }), { ok: true });
  assert.equal(answers.count(), 2);
});

test("setOpenAt: jen aktuální kolo a konečné číslo, drží nejmenší hodnotu", () => {
  const { answers, round } = openRound();
  assert.equal(answers.setOpenAt(round + 1, 500), false);
  assert.equal(answers.setOpenAt(round, Infinity), false);
  assert.equal(answers.setOpenAt(round, "500"), false);
  assert.equal(answers.setOpenAt(round, 500), true);
  assert.equal(answers.setOpenAt(round, 700), false);
  assert.equal(answers.setOpenAt(round, 500), false);
  assert.equal(answers.setOpenAt(round, 400), true);
  answers.close("time");
  assert.equal(answers.setOpenAt(round, 300), true);
});

test("setOpenAt: po cancel nebo pro jiné kolo → false", () => {
  const { answers, round } = openRound();
  answers.cancel();
  assert.equal(answers.setOpenAt(round, 500), false);
  answers.open(0, LIMIT, 0);
  assert.equal(answers.setOpenAt(round, 500), false);
  assert.equal(answers.setOpenAt(round + 1, 500), true);
});

test("close: jen z open, neznámý důvod → reveal", () => {
  const answers = createAnswers();
  assert.equal(answers.close("time"), false);
  answers.open(0, LIMIT, 0);
  assert.equal(answers.close("nesmysl"), true);
  assert.equal(answers.round().closeReason, "reveal");
  assert.equal(answers.close("time"), false);
  assert.equal(answers.running(), true);
  answers.open(0, LIMIT, 0);
  answers.close("all");
  assert.equal(answers.round().closeReason, "all");
});

test("running: idle ne, open a closed ano", () => {
  const answers = createAnswers();
  assert.equal(answers.running(), false);
  answers.open(0, LIMIT, 0);
  assert.equal(answers.running(), true);
  answers.close("time");
  assert.equal(answers.running(), true);
});

test("allAnswered: prázdné pole false, jinak až po hlasech všech", () => {
  const { answers, round } = openRound();
  assert.equal(answers.allAnswered([]), false);
  assert.equal(answers.allAnswered(null), false);
  assert.equal(answers.allAnswered(["a", "b"]), false);
  answers.answer("a", round, "a", 0, 10, PLAYER);
  assert.equal(answers.allAnswered(["a", "b"]), false);
  answers.answer("b", round, "b", 0, 10, { team: 1 });
  assert.equal(answers.allAnswered(["a", "b"]), true);
  answers.open(0, LIMIT, 0);
  assert.equal(answers.allAnswered(["a", "b"]), false);
});

test("round: kopie bez openAt a hlasů, úprava kopie stav nezmění", () => {
  const { answers, round } = openRound();
  answers.setOpenAt(round, 500);
  answers.answer("a", round, "a", 600, 10, PLAYER);
  const copy = answers.round();
  assert.deepEqual(copy, { round: 1, q: 2, status: "open", limitMs: LIMIT, deadlineAt: 31000, closeReason: null, count: 1 });
  copy.status = "idle";
  copy.round = 99;
  copy.count = 0;
  assert.equal(answers.round().status, "open");
  assert.equal(answers.round().round, 1);
  assert.equal(answers.count(), 1);
});

test("stav na začátku: idle, kolo 0", () => {
  assert.deepEqual(createAnswers().round(), { round: 0, q: null, status: "idle", limitMs: LIMIT, deadlineAt: null, closeReason: null, count: 0 });
});
