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

// Kolo s openAt (výchozí 1000) a hlasy [clientId, key, rx]; teamOf = clientId → tým pro answer().
function votedRound(votes, teamOf, openAt = 1000) {
  const { answers, round } = openRound();
  if (openAt !== null) answers.setOpenAt(round, openAt);
  const roster = Object.entries(teamOf).map(([clientId, team]) => ({ clientId, team }));
  for (const [clientId, key, rx] of votes) answers.answer(clientId, round, key, rx, 10, { team: teamOf[clientId] ?? 0 });
  return { answers, roster };
}

test("tally: většina hlasů týmu rozhoduje (B, B, A → B)", () => {
  const { answers, roster } = votedRound([["p1", "b", 1500], ["p2", "a", 1100], ["p3", "b", 1600]], { p1: 0, p2: 0, p3: 0 });
  const res = answers.tally(roster, "b", 100);
  assert.equal(res.teams[0].answer, "b");
  assert.deepEqual(res.teams[0].votes, { a: 1, b: 2, c: 0 });
  assert.deepEqual(res.votes, { a: 1, b: 2, c: 0 });
  assert.equal(answers.round().status, "result");
});

test("tally: shoda počtu rozhodne nejdřívější hlas (nižší rx), ne abeceda", () => {
  const { answers, roster } = votedRound([["p1", "a", 1100], ["p2", "b", 1090]], { p1: 0, p2: 0 });
  assert.equal(answers.tally(roster, "a", 100).teams[0].answer, "b");
});

test("tally: shoda počtu i rx rozhodne dřív zapsaný hlas", () => {
  const { answers, roster } = votedRound([["p1", "c", 1100], ["p2", "a", 1100]], { p1: 0, p2: 0 });
  assert.equal(answers.tally(roster, "a", 100).teams[0].answer, "c");
});

test("tally: elapsedMs z nejdřívějšího hlasu pro odpověď týmu, ne z prvního hlasu týmu", () => {
  const { answers, roster } = votedRound([["p1", "a", 1100], ["p2", "b", 3000], ["p3", "b", 2500]], { p1: 0, p2: 0, p3: 0 });
  const team = answers.tally(roster, "b", 100).teams[0];
  assert.equal(team.answer, "b");
  assert.equal(team.elapsedMs, 1500);
  assert.equal(team.points, points(100, 1500, LIMIT));
});

test("tally: bez openAt je elapsedMs null a body = základ; rx před openAt dává 0", () => {
  const noOpen = votedRound([["p1", "a", 1100]], { p1: 0 }, null);
  const t1 = noOpen.answers.tally(noOpen.roster, "a", 100).teams[0];
  assert.equal(t1.elapsedMs, null);
  assert.equal(t1.points, 100);
  const early = votedRound([["p1", "a", 500]], { p1: 0 });
  assert.equal(early.answers.tally(early.roster, "a", 100).teams[0].elapsedMs, 0);
});

test("tally: hráč mimo soupisku nebo bez týmu se nepočítá; týmy podle indexu", () => {
  const { answers } = votedRound([["p1", "a", 1100], ["ghost", "a", 1100], ["p3", "b", 1100], ["p4", "c", 1100]], { p1: 2, ghost: 0, p3: 0, p4: 0 });
  const roster = [{ clientId: "p1", team: 2 }, { clientId: "p3", team: null }, { clientId: "p4", team: 0 }];
  const res = answers.tally(roster, "a", 100);
  assert.deepEqual(res.teams.map((t) => t.team), [0, 2]);
  assert.deepEqual(res.votes, { a: 1, b: 0, c: 1 });
});

test("tally: tým bez započítaných hlasů ve výsledku chybí", () => {
  const { answers } = votedRound([["ghost", "a", 1100]], { ghost: 1 });
  const res = answers.tally([{ clientId: "p1", team: 0 }], "a", 100);
  assert.deepEqual(res.teams, []);
  assert.deepEqual(res.votes, { a: 0, b: 0, c: 0 });
});

test("tally: špatná odpověď týmu má points 0 a correct false", () => {
  const { answers, roster } = votedRound([["p1", "a", 1100]], { p1: 1 });
  const team = answers.tally(roster, "b", 100).teams[0];
  assert.equal(team.correct, false);
  assert.equal(team.points, 0);
});

test("tally: funguje i po close, druhé volání vrací null a result drží první výsledek", () => {
  const { answers, roster } = votedRound([["p1", "a", 1100]], { p1: 0 });
  answers.close("time");
  const first = answers.tally(roster, "a", 100);
  assert.ok(first);
  assert.equal(answers.tally(roster, "b", 500), null);
  assert.deepEqual(answers.result(), first);
});

test("tally: idle nebo neplatné correct vrací null a stav nemění", () => {
  const idle = createAnswers();
  assert.equal(idle.tally([], "a", 100), null);
  assert.equal(idle.round().status, "idle");
  const { answers, roster } = votedRound([["p1", "a", 1100]], { p1: 0 });
  assert.equal(answers.tally(roster, "x", 100), null);
  assert.equal(answers.round().status, "open");
  assert.equal(answers.result(), null);
  assert.ok(answers.tally(roster, "a", 100));
});

test("tally: hráč přešlý do jiného týmu se počítá k týmu ze soupisky", () => {
  const { answers } = votedRound([["p1", "a", 1100]], { p1: 0 });
  const res = answers.tally([{ clientId: "p1", team: 3 }], "a", 100);
  assert.deepEqual(res.teams.map((t) => t.team), [3]);
});

test("result: kopie, úprava nezmění uložený výsledek; bez vyhodnocení null", () => {
  const { answers, roster } = votedRound([["p1", "a", 1100]], { p1: 0 });
  assert.equal(answers.result(), null);
  answers.tally(roster, "a", 100);
  const copy = answers.result();
  copy.teams[0].points = 0;
  copy.teams[0].votes.a = 9;
  copy.votes.a = 9;
  copy.teams.push({});
  const again = answers.result();
  assert.equal(again.teams.length, 1);
  assert.equal(again.teams[0].votes.a, 1);
  assert.equal(again.votes.a, 1);
  assert.ok(again.teams[0].points > 0);
});

test("open maže výsledek předchozího kola a umožní nové vyhodnocení", () => {
  const { answers, roster } = votedRound([["p1", "a", 1100]], { p1: 0 });
  assert.ok(answers.tally(roster, "a", 100));
  assert.ok(answers.result());
  answers.open(3, LIMIT, 0);
  assert.equal(answers.result(), null);
  assert.ok(answers.tally(roster, "a", 100));
});

test("cancel maže výsledek", () => {
  const { answers, roster } = votedRound([["p1", "a", 1100]], { p1: 0 });
  answers.tally(roster, "a", 100);
  answers.cancel();
  assert.equal(answers.result(), null);
});
