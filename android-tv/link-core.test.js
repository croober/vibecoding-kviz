import { test } from "node:test";
import assert from "node:assert/strict";
// klasické skripty pro prohlížeč; v Node se vystaví přes globalThis (link-core.js čte KvizTvCore, proto core.js první)
import "./core.js";
import "./link-core.js";

const { PROTOCOL, LIMITS, TOKEN_ALPHABET, REMOTE_ACTIONS, parseMessage, commandOf, newToken, buildUrl, pickAddress, createClients, fieldView, stateView, sameState } = globalThis.KvizLinkCore;

const parse = (obj) => parseMessage(JSON.stringify({ v: PROTOCOL, ...obj }));
const BAD = { ok: false, code: "bad_message" };

test("parseMessage: platný hello, key a text", () => {
  assert.deepEqual(parse({ t: "hello", clientId: "abcd1234", role: "remote", name: "Jana" }).msg,
    { v: 1, t: "hello", clientId: "abcd1234", role: "remote", name: "Jana" });
  assert.deepEqual(parse({ t: "key", action: "up", seq: 3 }).msg, { v: 1, t: "key", action: "up", seq: 3 });
  assert.deepEqual(parse({ t: "text", value: "ahoj", done: true, seq: 4 }).msg,
    { v: 1, t: "text", value: "ahoj", done: true, seq: 4 });
});

test("parseMessage: neznámá pole se zahodí", () => {
  const r = parse({ t: "key", action: "ok", seq: 1, evil: "x", __proto__: { a: 1 } });
  assert.deepEqual(r.msg, { v: 1, t: "key", action: "ok", seq: 1 });
});

test("parseMessage: neplatný vstup vrací bad_message a nevyhazuje", () => {
  const inputs = [
    "není json", "", "{", "null", "42", "[]", '"text"', null, undefined, 42, [], {}, true,
    JSON.stringify({ v: 2, t: "key", action: "up", seq: 1 }),
    JSON.stringify({ t: "key", action: "up", seq: 1 }),
    JSON.stringify({ v: 1, t: "intent" }),
    JSON.stringify({ v: 1 }),
    JSON.stringify({ v: 1, t: "text", value: "x".repeat(LIMITS.text + 1), seq: 1 }),
    JSON.stringify({ v: 1, t: "text", value: 5, seq: 1 }),
    JSON.stringify({ v: 1, t: "text", value: "a", done: "yes", seq: 1 }),
    JSON.stringify({ v: 1, t: "key", action: "up", seq: "1" }),
    JSON.stringify({ v: 1, t: "key", action: "up", seq: 1.5 }),
    JSON.stringify({ v: 1, t: "key", action: "up" }),
    JSON.stringify({ v: 1, t: "key", action: "format_disk", seq: 1 }),
    JSON.stringify({ v: 1, t: "key", action: "constructor", seq: 1 }),
    JSON.stringify({ v: 1, t: "hello", clientId: "krátké", role: "remote" }),
    JSON.stringify({ v: 1, t: "hello", clientId: "abcd1234", role: "player" }),
    JSON.stringify({ v: 1, t: "hello", clientId: "abcd1234", role: "remote", name: "x".repeat(LIMITS.name + 1) }),
    JSON.stringify({ v: 1, t: "toString" }),
    "x".repeat(LIMITS.message + 1)
  ];
  for (const input of inputs) assert.deepEqual(parseMessage(input), BAD, String(input).slice(0, 40));
});

test("parseMessage: text na hranici limitu projde", () => {
  assert.equal(parse({ t: "text", value: "x".repeat(LIMITS.text), seq: 1 }).ok, true);
  assert.equal(parse({ t: "text", value: "", seq: 1 }).ok, true);
});

test("commandOf: klávesy z ACTIONS", () => {
  assert.equal(commandOf("up").init.key, "ArrowUp");
  assert.equal(commandOf("team1").init.code, "Digit1");
  const { init } = commandOf("ok");
  assert.equal(init.bubbles, true);
  assert.equal(init.cancelable, true);
});

test("commandOf: back, odpovědi a neznámá akce", () => {
  assert.deepEqual(commandOf("back"), { kind: "back" });
  assert.deepEqual(commandOf("answer2"), { kind: "answer", n: 2 });
  for (const a of ["answer0", "answer4", "nic", "", null, 5, undefined]) assert.equal(commandOf(a), null);
});

test("REMOTE_ACTIONS: každá akce má příkaz", () => {
  assert.ok(REMOTE_ACTIONS.includes("menu") && REMOTE_ACTIONS.includes("answer3"));
  for (const a of REMOTE_ACTIONS) assert.notEqual(commandOf(a), null, a);
});

test("commandOf: init je kopie, ne odkaz do ACTIONS", () => {
  commandOf("up").init.key = "X";
  assert.equal(commandOf("up").init.key, "ArrowUp");
});

test("newToken: 6 znaků z abecedy", () => {
  for (let i = 0; i < 50; i++) assert.match(newToken(), /^[abcdefghjkmnpqrstuvwxyz23456789]{6}$/);
  assert.equal(newToken(() => 0), "aaaaaa");
  assert.equal(newToken(() => 0.999999), TOKEN_ALPHABET.at(-1).repeat(6));
  assert.equal(newToken(() => 1), TOKEN_ALPHABET.at(-1).repeat(6));
});

test("buildUrl: adresa pro QR", () => {
  assert.equal(buildUrl("192.168.1.23", 8765, "ab12cd"), "http://192.168.1.23:8765/m/?t=ab12cd");
});

test("pickAddress: přednost 192.168, pak 10, pak 172.16–31", () => {
  assert.equal(pickAddress(["172.16.0.5", "10.0.0.2", "192.168.1.9"]), "192.168.1.9");
  assert.equal(pickAddress(["172.20.0.5", "10.0.0.2"]), "10.0.0.2");
  assert.equal(pickAddress(["8.8.8.8", "172.31.1.1"]), "172.31.1.1");
});

test("pickAddress: veřejné, neplatné a prázdné adresy", () => {
  assert.equal(pickAddress([]), null);
  assert.equal(pickAddress(null), null);
  assert.equal(pickAddress(["8.8.8.8", "172.32.0.1", "172.15.0.1", "fe80::1", "192.168.1.999", 5]), null);
});

// --- registr klientů ---

const hello = (over = {}) => ({ v: 1, t: "hello", clientId: "abcd1234", role: "remote", ...over });

test("clients.hello: nový klient dostane resume a je připojený", () => {
  const clients = createClients({ max: 4 });
  const r = clients.hello(1, hello({ name: "Jana" }));
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(r.replaced, undefined);
  assert.equal(r.client.clientId, "abcd1234");
  assert.equal(r.client.name, "Jana");
  assert.equal(r.client.connected, true);
  assert.match(r.client.resume, /^[abcdefghjkmnpqrstuvwxyz23456789]{16}$/);
  assert.equal(clients.byConn(1), r.client);
  assert.equal(clients.list().length, 1);
});

test("clients.hello: resume se generuje z dodaného random", () => {
  const clients = createClients({ random: () => 0 });
  assert.equal(clients.hello(1, hello()).client.resume, "a".repeat(16));
});

test("clients.hello: jiná role než remote se odmítne", () => {
  const clients = createClients({});
  assert.deepEqual(clients.hello(1, hello({ role: "player" })), { ok: false, code: "bad_message" });
  assert.equal(clients.list().length, 0);
});

test("clients.hello: opakované připojení se správným resume naváže a vrátí starý connId", () => {
  const clients = createClients({});
  const first = clients.hello(1, hello());
  clients.accept(1, 5);
  const again = clients.hello(2, hello({ resume: first.client.resume }));
  assert.equal(again.ok, true);
  assert.equal(again.created, false);
  assert.equal(again.replaced, 1);
  assert.equal(again.client, first.client);
  assert.equal(again.client.lastSeq, 5);
  assert.equal(clients.byConn(1), null);
  assert.equal(clients.byConn(2), first.client);
  assert.equal(clients.list().length, 1);
});

test("clients.hello: navázání po výpadku nemá replaced; pozdní drop nahrazeného spojení nové nezruší", () => {
  const clients = createClients({});
  const first = clients.hello(1, hello());
  clients.drop(1);
  assert.equal(first.client.connected, false);
  const again = clients.hello(2, hello({ resume: first.client.resume }));
  assert.equal(again.replaced, undefined);
  assert.equal(again.client.connected, true);

  const third = clients.hello(3, hello({ resume: first.client.resume }));
  assert.equal(third.replaced, 2);
  clients.drop(2);
  assert.equal(third.client.connected, true);
  assert.equal(clients.byConn(3), third.client);
});

test("clients.hello: špatné nebo chybějící resume nepřevezme cizí identitu", () => {
  const clients = createClients({});
  const owner = clients.hello(1, hello());
  for (const resume of [undefined, "špatné", "a".repeat(16)]) {
    const r = clients.hello(9, hello({ resume }));
    assert.equal(r.created, true);
    assert.notEqual(r.client, owner.client);
    assert.notEqual(r.client.clientId, "abcd1234");
    assert.notEqual(r.client.resume, owner.client.resume);
    clients.drop(9);
  }
  assert.equal(clients.byConn(1), owner.client);
  assert.equal(owner.client.connected, true);
});

test("clients.hello: plný registr vrátí full, odpojený klient se uvolní", () => {
  const clients = createClients({ max: 2 });
  clients.hello(1, hello({ clientId: "klient001" }));
  clients.hello(2, hello({ clientId: "klient002" }));
  assert.deepEqual(clients.hello(3, hello({ clientId: "klient003" })), { ok: false, code: "full" });
  clients.drop(1);
  assert.equal(clients.hello(3, hello({ clientId: "klient003" })).ok, true);
  assert.deepEqual(clients.list().map((c) => c.clientId), ["klient002", "klient003"]);
});

test("clients.hello: plný registr nebrání opakovanému připojení známého klienta", () => {
  const clients = createClients({ max: 1 });
  const first = clients.hello(1, hello());
  assert.equal(clients.hello(2, hello({ resume: first.client.resume })).ok, true);
});

test("clients.drop: klienta neodstraní, neznámé spojení vrací null", () => {
  const clients = createClients({});
  clients.hello(1, hello());
  assert.equal(clients.drop(7), null);
  const dropped = clients.drop(1);
  assert.equal(dropped.connected, false);
  assert.equal(dropped.connId, null);
  assert.equal(clients.byConn(1), null);
  assert.equal(clients.list().length, 1);
});

test("clients.accept: přijme rostoucí seq, duplicitní a starší odmítne", () => {
  const clients = createClients({});
  clients.hello(1, hello());
  assert.equal(clients.accept(1, 0), true);
  assert.equal(clients.accept(1, 1), true);
  assert.equal(clients.accept(1, 1), false);
  assert.equal(clients.accept(1, 0), false);
  assert.equal(clients.accept(1, 10), true);
  assert.equal(clients.accept(1, 9), false);
  assert.equal(clients.byConn(1).lastSeq, 10);
});

test("clients.accept: bez hello se nepřijme nic", () => {
  const clients = createClients({});
  assert.equal(clients.accept(1, 1), false);
  assert.equal(clients.byConn(1), null);
});

// --- snímek stavu ---

test("fieldView: běžné pole nese hodnotu", () => {
  assert.deepEqual(fieldView({ key: "name", label: "Název", type: "text", value: "Lvi", maxLength: 20 }),
    { key: "name", label: "Název", type: "text", value: "Lvi", masked: false, maxLength: 20 });
});

test("fieldView: heslo se nikdy neposílá", () => {
  const f = fieldView({ key: "basic", label: "Heslo", type: "password", value: "tajne-heslo", maxLength: 50 });
  assert.equal(f.value, "");
  assert.equal(f.masked, true);
  assert.ok(!JSON.stringify(f).includes("tajne-heslo"));
});

test("fieldView: neplatný vstup a chybějící maxLength", () => {
  assert.equal(fieldView(null), null);
  assert.equal(fieldView("pole"), null);
  const f = fieldView({ key: "k", label: "L", type: "text", value: 5 });
  assert.equal(f.value, "");
  assert.equal(f.maxLength, LIMITS.text);
});

const baseState = () => ({
  rev: 3, view: "quiz", locked: false, overlay: null, teamCount: 2,
  quiz: { index: 4, total: 10, revealed: true },
  field: { key: "token", label: "Token", type: "text", value: "abc", maxLength: 40 }
});

test("stateView: sestaví snímek podle kontraktu", () => {
  assert.deepEqual(stateView("remote", baseState()), {
    rev: 3, view: "quiz", locked: false, overlay: null, teamCount: 2,
    quiz: { index: 4, total: 10, revealed: true },
    field: { key: "token", label: "Token", type: "text", value: "abc", masked: false, maxLength: 40 }
  });
});

test("stateView: pole mimo kontrakt se nepropíše", () => {
  const input = {
    ...baseState(), question: "Kolik je 2+2?", answer: "b", teams: [{ name: "Lvi", score: 9 }], token: "ab12cd",
    quiz: { index: 1, total: 5, revealed: false, text: "Tajná otázka", correct: "a" },
    field: { key: "k", label: "L", type: "text", value: "v", maxLength: 9, secret: "xx" }
  };
  const out = stateView("remote", input);
  assert.deepEqual(Object.keys(out).sort(), ["field", "locked", "overlay", "quiz", "rev", "teamCount", "view"]);
  assert.deepEqual(Object.keys(out.quiz).sort(), ["index", "revealed", "total"]);
  assert.deepEqual(Object.keys(out.field).sort(), ["key", "label", "masked", "maxLength", "type", "value"]);
  const json = JSON.stringify(out);
  for (const leak of ["Kolik je", "Tajná otázka", "Lvi", "ab12cd", "secret"]) assert.ok(!json.includes(leak), leak);
});

test("stateView: hodnota hesla ve snímku nezůstane", () => {
  const input = { ...baseState(), field: { key: "basicPass", label: "Heslo", type: "password", value: "tajne-heslo", maxLength: 30 } };
  const out = stateView("remote", input);
  assert.equal(out.field.value, "");
  assert.equal(out.field.masked, true);
  assert.ok(!JSON.stringify(out).includes("tajne-heslo"));
});

test("stateView: neplatné hodnoty se opraví a neznámá role vrací null", () => {
  const out = stateView("remote", { view: "hack", overlay: "x", teamCount: 99, quiz: "ne", field: undefined, locked: "ano" });
  assert.deepEqual(out, { view: "setup", locked: false, overlay: null, teamCount: 4, quiz: null, field: null });
  assert.equal(stateView("remote", { teamCount: -3 }).teamCount, 0);
  assert.equal(stateView("player", baseState()), null);
  assert.equal(stateView("remote", null), null);
});

test("sameState: ignoruje rev, pozná změnu v hloubce", () => {
  const a = stateView("remote", baseState());
  assert.equal(sameState(a, stateView("remote", { ...baseState(), rev: 99 })), true);
  assert.equal(sameState(a, stateView("remote", { ...baseState(), overlay: "menu" })), false);
  const other = baseState();
  other.field.value = "abd";
  assert.equal(sameState(a, stateView("remote", other)), false);
  const noQuiz = { ...baseState(), quiz: null };
  assert.equal(sameState(a, stateView("remote", noQuiz)), false);
  assert.equal(sameState(stateView("remote", noQuiz), stateView("remote", { ...noQuiz, rev: 1 })), true);
  assert.equal(sameState(null, a), false);
});
