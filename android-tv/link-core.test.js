import { test } from "node:test";
import assert from "node:assert/strict";
// klasické skripty pro prohlížeč; v Node se vystaví přes globalThis (link-core.js čte KvizTvCore, proto core.js první)
import "./core.js";
import "./link-core.js";

const { PROTOCOL, LIMITS, REMOTE_KEY_LENGTH, allowedFor, newRemoteKey, buildPlayerUrl, TOKEN_ALPHABET, REMOTE_ACTIONS, parseMessage, commandOf, newToken, buildUrl, pickAddress, createClients, createRateLimiter, fieldView, stateView, sameState, PLAYER_STATE_KEYS, playerStateView, ANSWER_KEYS, questionView } = globalThis.KvizLinkCore;

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
    JSON.stringify({ v: 1, t: "hello", clientId: "abcd1234", role: "admin" }),
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

test("buildUrl: klíč ovladače", () => {
  assert.equal(buildUrl("192.168.1.23", 8765, "ab12cd", "k".repeat(12)), "http://192.168.1.23:8765/m/?t=ab12cd&k=kkkkkkkkkkkk");
  assert.equal(buildUrl("192.168.1.23", 8765, "ab12cd", ""), "http://192.168.1.23:8765/m/?t=ab12cd");
});

test("buildPlayerUrl: adresa pro hráče", () => {
  assert.equal(buildPlayerUrl("192.168.1.23", 8765, "ab12cd"), "http://192.168.1.23:8765/m/player.html?t=ab12cd");
});

test("newRemoteKey: 12 znaků z abecedy", () => {
  assert.equal(REMOTE_KEY_LENGTH, 12);
  assert.equal(newRemoteKey(() => 0), "a".repeat(12));
  for (let i = 0; i < 50; i++) assert.match(newRemoteKey(), /^[abcdefghjkmnpqrstuvwxyz23456789]{12}$/);
});

test("parseMessage: join a buzz", () => {
  assert.deepEqual(parse({ t: "join", name: "Pepa", team: 2, seq: 1 }).msg, { v: 1, t: "join", name: "Pepa", team: 2, seq: 1 });
  assert.deepEqual(parse({ t: "buzz", q: 0, seq: 2 }).msg, { v: 1, t: "buzz", q: 0, seq: 2 });
});

test("parseMessage: join s neplatnými poli vrací bad_message", () => {
  const ok = { t: "join", name: "Pepa", team: 1, seq: 1 };
  const variants = [
    { team: 4 }, { team: -1 }, { team: 1.5 }, { team: "1" }, { team: undefined },
    { name: "" }, { name: "x".repeat(17) }, { name: 5 }, { name: undefined },
    { seq: undefined }, { seq: -1 }
  ];
  for (const v of variants) assert.deepEqual(parse({ ...ok, ...v }), BAD, JSON.stringify(v));
});

test("parseMessage: buzz s neplatnými poli vrací bad_message", () => {
  const ok = { t: "buzz", q: 0, seq: 1 };
  const variants = [{ q: -1 }, { q: 1.5 }, { q: "0" }, { q: undefined }, { seq: undefined }];
  for (const v of variants) assert.deepEqual(parse({ ...ok, ...v }), BAD, JSON.stringify(v));
});

test("parseMessage: join a buzz zahodí neznámá pole včetně __proto__ a role", () => {
  const raw = (o) => parseMessage(JSON.stringify({ v: 1, ...o }).replace("{", "{\"__proto__\":{\"a\":1},"));
  const join = raw({ t: "join", name: "Pepa", team: 0, seq: 1, role: "remote", evil: 1 }).msg;
  assert.deepEqual(join, { v: 1, t: "join", name: "Pepa", team: 0, seq: 1 });
  assert.equal(join.a, undefined);
  assert.deepEqual(raw({ t: "buzz", q: 3, seq: 1, role: "remote", evil: 1 }).msg, { v: 1, t: "buzz", q: 3, seq: 1 });
});

test("parseMessage: hello s rolí player a role mimo ROLES", () => {
  assert.equal(parse({ t: "hello", clientId: "abcd1234", role: "player" }).ok, true);
  for (const role of ["admin", "", null, undefined]) {
    assert.deepEqual(parse({ t: "hello", clientId: "abcd1234", role }), BAD, String(role));
  }
});

test("parseMessage: hello hráče nepřenáší name ani remoteKey", () => {
  const r = parse({ t: "hello", clientId: "abcd1234", role: "player", name: "X", remoteKey: "abc" });
  assert.deepEqual(r.msg, { v: 1, t: "hello", clientId: "abcd1234", role: "player" });
  assert.deepEqual(parse({ t: "hello", clientId: "abcd1234", role: "player", remoteKey: 5 }), BAD);
});

test("parseMessage: hello ovladače s remoteKey", () => {
  const h = (remoteKey) => parse({ t: "hello", clientId: "abcd1234", role: "remote", remoteKey });
  for (const k of ["", "k".repeat(65), 5]) assert.deepEqual(h(k), BAD, String(k).length + "");
  assert.equal(h("k".repeat(12)).msg.remoteKey, "k".repeat(12));
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

const REMOTE_KEY = "k2m4p6r8t9wx";
const AUTH = { remoteKey: REMOTE_KEY };
const hello = (over = {}) => ({ v: 1, t: "hello", clientId: "abcd1234", role: "remote", remoteKey: REMOTE_KEY, ...over });
const FORBIDDEN = { ok: false, code: "forbidden" };
const FULL = { ok: false, code: "full" };

test("clients.hello: nový klient dostane resume a je připojený", () => {
  const clients = createClients({ max: 4 });
  const r = clients.hello(1, hello({ name: "Jana" }), AUTH);
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
  assert.equal(clients.hello(1, hello(), AUTH).client.resume, "a".repeat(16));
});

test("clients.hello: role player projde, role mimo ROLES se odmítne", () => {
  const clients = createClients({});
  for (const role of ["admin", "", undefined, "constructor"]) {
    assert.deepEqual(clients.hello(1, hello({ role }), AUTH), BAD, String(role));
  }
  assert.deepEqual(clients.hello(1, null, AUTH), BAD);
  assert.equal(clients.list().length, 0);
  const r = clients.hello(1, hello({ role: "player" }), AUTH);
  assert.equal(r.ok, true);
  assert.equal(r.client.role, "player");
});

test("clients.hello: opakované připojení se správným resume naváže a vrátí starý connId", () => {
  const clients = createClients({});
  const first = clients.hello(1, hello(), AUTH);
  clients.accept(1, 5);
  const again = clients.hello(2, hello({ resume: first.client.resume }), AUTH);
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
  const first = clients.hello(1, hello(), AUTH);
  clients.drop(1);
  assert.equal(first.client.connected, false);
  const again = clients.hello(2, hello({ resume: first.client.resume }), AUTH);
  assert.equal(again.replaced, undefined);
  assert.equal(again.client.connected, true);

  const third = clients.hello(3, hello({ resume: first.client.resume }), AUTH);
  assert.equal(third.replaced, 2);
  clients.drop(2);
  assert.equal(third.client.connected, true);
  assert.equal(clients.byConn(3), third.client);
});

test("clients.hello: špatné nebo chybějící resume nepřevezme cizí identitu", () => {
  const clients = createClients({});
  const owner = clients.hello(1, hello(), AUTH);
  for (const resume of [undefined, "špatné", "a".repeat(16)]) {
    const r = clients.hello(9, hello({ resume }), AUTH);
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
  clients.hello(1, hello({ clientId: "klient001" }), AUTH);
  clients.hello(2, hello({ clientId: "klient002" }), AUTH);
  assert.deepEqual(clients.hello(3, hello({ clientId: "klient003" }), AUTH), { ok: false, code: "full" });
  clients.drop(1);
  assert.equal(clients.hello(3, hello({ clientId: "klient003" }), AUTH).ok, true);
  assert.deepEqual(clients.list().map((c) => c.clientId), ["klient002", "klient003"]);
});

test("clients.hello: plný registr nebrání opakovanému připojení známého klienta", () => {
  const clients = createClients({ max: 1 });
  const first = clients.hello(1, hello(), AUTH);
  assert.equal(clients.hello(2, hello({ resume: first.client.resume }), AUTH).ok, true);
});

test("clients.drop: klienta neodstraní, neznámé spojení vrací null", () => {
  const clients = createClients({});
  clients.hello(1, hello(), AUTH);
  assert.equal(clients.drop(7), null);
  const dropped = clients.drop(1);
  assert.equal(dropped.connected, false);
  assert.equal(dropped.connId, null);
  assert.equal(clients.byConn(1), null);
  assert.equal(clients.list().length, 1);
});

test("clients.accept: přijme rostoucí seq, duplicitní a starší odmítne", () => {
  const clients = createClients({});
  clients.hello(1, hello(), AUTH);
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

// --- práva ovladače a hráče ---

const player = (over = {}) => hello({ role: "player", remoteKey: undefined, ...over });
const playerId = (n) => "hrac" + String(n).padStart(4, "0");

test("clients.hello: ovladač se správným klíčem projde, s jiným dostane forbidden", () => {
  const clients = createClients({});
  const wrongKeys = [undefined, REMOTE_KEY.slice(0, -1), REMOTE_KEY + "x", REMOTE_KEY.slice(0, -1) + "y", "x" + REMOTE_KEY.slice(1)];
  for (const remoteKey of wrongKeys) {
    assert.deepEqual(clients.hello(1, hello({ remoteKey }), AUTH), FORBIDDEN, String(remoteKey));
  }
  assert.equal(clients.list().length, 0);
  const r = clients.hello(1, hello(), AUTH);
  assert.equal(r.ok, true);
  assert.equal(r.client.role, "remote");
});

test("clients.hello: bez nastaveného klíče na TV se ovladač nepřipojí nikdy", () => {
  const clients = createClients({});
  for (const auth of [undefined, null, {}, { remoteKey: "" }, { remoteKey: null }, { remoteKey: 5 }]) {
    assert.deepEqual(clients.hello(1, hello(), auth), FORBIDDEN, JSON.stringify(auth));
    assert.deepEqual(clients.hello(1, hello({ remoteKey: "" }), auth), FORBIDDEN, JSON.stringify(auth));
  }
  assert.equal(clients.list().length, 0);
});

test("clients.hello: útočník s cizím clientId a resume, ale bez klíče, ovladač nepřevezme", () => {
  const clients = createClients({});
  const owner = clients.hello(1, hello(), AUTH).client;
  const stolen = { clientId: owner.clientId, resume: owner.resume };
  for (const remoteKey of [undefined, "a".repeat(12)]) {
    const r = clients.hello(9, hello({ ...stolen, remoteKey }), AUTH);
    assert.deepEqual(r, FORBIDDEN);
    assert.equal(r.replaced, undefined);
  }
  assert.equal(clients.byConn(1), owner);
  assert.equal(clients.byConn(9), null);
  assert.equal(owner.connected, true);
  assert.equal(owner.connId, 1);
  assert.equal(clients.list().length, 1);
});

test("clients.hello: hráč se nepovýší na ovladač z téhož ani z jiného spojení", () => {
  const clients = createClients({});
  const me = clients.hello(1, player({ clientId: "hrac0001" }), AUTH).client;
  const promote = hello({ clientId: me.clientId, resume: me.resume, remoteKey: undefined });
  for (const connId of [1, 2]) assert.deepEqual(clients.hello(connId, promote, AUTH), FORBIDDEN, String(connId));
  assert.equal(clients.byConn(1), me);
  assert.equal(clients.byConn(1).role, "player");
  assert.equal(clients.byConn(2), null);
  assert.ok(clients.list().every((c) => c.role === "player"));
});

test("clients.hello: role se nepřenáší přes resume ovladače", () => {
  const clients = createClients({});
  const remote = clients.hello(1, hello(), AUTH).client;
  const r = clients.hello(2, player({ clientId: remote.clientId, resume: remote.resume }), AUTH);
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.notEqual(r.client, remote);
  assert.notEqual(r.client.clientId, remote.clientId);
  assert.equal(r.client.role, "player");
  assert.equal(remote.connected, true);
  assert.equal(remote.role, "remote");
  assert.equal(clients.byConn(1), remote);
});

test("clients.hello: odmítnuté hello nezruší dosavadní vazbu spojení", () => {
  const clients = createClients({});
  const remote = clients.hello(1, hello(), AUTH).client;
  assert.deepEqual(clients.hello(1, hello({ remoteKey: "a".repeat(12) }), AUTH), FORBIDDEN);
  assert.equal(clients.byConn(1), remote);
  assert.equal(remote.connected, true);
  const me = clients.hello(2, player({ clientId: "hrac0001" }), AUTH).client;
  assert.deepEqual(clients.hello(2, hello({ clientId: "hrac0001", resume: me.resume, remoteKey: undefined }), AUTH), FORBIDDEN);
  assert.equal(clients.byConn(2), me);
});

test("clients.hello: hráč projde bez klíče i se špatným a nemá jméno", () => {
  const clients = createClients({});
  const a = clients.hello(1, player({ clientId: "hrac0001", name: "Pepa" }), undefined);
  const b = clients.hello(2, player({ clientId: "hrac0002", name: "Jana", remoteKey: "a".repeat(12) }), AUTH);
  for (const r of [a, b]) {
    assert.equal(r.ok, true);
    assert.equal(r.client.role, "player");
    assert.equal(r.client.name, "");
  }
  const again = clients.hello(3, player({ clientId: "hrac0001", resume: a.client.resume, name: "Pepa" }), AUTH);
  assert.equal(again.created, false);
  assert.equal(again.client.name, "");
});

test("clients.hello: limit hráčů vrací full, ovladače se netýká", () => {
  const clients = createClients({ maxPlayers: 2 });
  assert.equal(clients.hello(1, player({ clientId: playerId(1) }), AUTH).ok, true);
  assert.equal(clients.hello(2, player({ clientId: playerId(2) }), AUTH).ok, true);
  assert.deepEqual(clients.hello(3, player({ clientId: playerId(3) }), AUTH), FULL);
  assert.equal(clients.hello(4, hello(), AUTH).ok, true);
  clients.drop(1);
  assert.equal(clients.hello(3, player({ clientId: playerId(3) }), AUTH).ok, true);
});

test("clients.hello: navazující hráč dostane full, jen když místo neobsazuje sám", () => {
  const clients = createClients({ maxPlayers: 2 });
  const first = clients.hello(1, player({ clientId: playerId(1) }), AUTH).client;
  clients.hello(2, player({ clientId: playerId(2) }), AUTH);
  // výměna spojení: hráč 1 je sám jedním z připojených
  const swap = clients.hello(5, player({ clientId: first.clientId, resume: first.resume }), AUTH);
  assert.equal(swap.ok, true);
  assert.equal(swap.replaced, 1);
  // po výpadku obsadí jeho místo jiný hráč → navázání narazí na limit
  clients.drop(5);
  clients.hello(3, player({ clientId: playerId(3) }), AUTH);
  assert.deepEqual(clients.hello(6, player({ clientId: first.clientId, resume: first.resume }), AUTH), FULL);
  assert.equal(first.connected, false);
});

test("clients.hello: výchozí limit 12 hráčů při max 16", () => {
  const clients = createClients({ max: 16 });
  assert.equal(LIMITS.players, 12);
  for (let i = 1; i <= 12; i++) assert.equal(clients.hello(i, player({ clientId: playerId(i) }), AUTH).ok, true, String(i));
  assert.deepEqual(clients.hello(13, player({ clientId: playerId(13) }), AUTH), FULL);
  assert.equal(clients.hello(14, hello(), AUTH).ok, true);
});

// --- délka klíče TV, druhé hello, připnutí a uvolňování místa (fáze 3, list 1) ---

const REHELLO = { ok: false, code: "rehello" };
const ids = (clients) => clients.list().map((c) => c.clientId);

test("clients.hello: krátký klíč TV se bere jako nenastavený, i když ho zpráva nese", () => {
  assert.equal(REMOTE_KEY.length, REMOTE_KEY_LENGTH);
  const clients = createClients({});
  for (const len of [1, 6, REMOTE_KEY_LENGTH - 1]) {
    const key = REMOTE_KEY.slice(0, len);
    assert.deepEqual(clients.hello(1, hello({ remoteKey: key }), { remoteKey: key }), FORBIDDEN, String(len));
  }
  assert.equal(clients.list().length, 0);
  assert.equal(clients.hello(1, hello(), AUTH).ok, true);
});

test("clients.hello: druhé hello s jiným clientId na témže spojení vrací rehello a registr nemění", () => {
  const clients = createClients({});
  const me = clients.hello(1, player({ clientId: playerId(1) }), AUTH).client;
  assert.deepEqual(clients.hello(1, player({ clientId: playerId(2) }), AUTH), REHELLO);
  assert.equal(clients.byConn(1), me);
  assert.equal(me.connected, true);
  assert.equal(clients.list().length, 1);
  // i ovladač na spojení hráče s jiným clientId a platným klíčem
  assert.deepEqual(clients.hello(1, hello(), AUTH), REHELLO);
  assert.equal(clients.list().length, 1);
});

test("clients.hello: druhé hello se stejným clientId a jinou rolí vrací rehello, role se nezmění", () => {
  const clients = createClients({});
  const me = clients.hello(1, player({ clientId: playerId(1) }), AUTH).client;
  assert.deepEqual(clients.hello(1, hello({ clientId: playerId(1), resume: me.resume }), AUTH), REHELLO);
  assert.equal(clients.byConn(1), me);
  assert.equal(me.role, "player");
  assert.equal(clients.list().length, 1);
});

test("clients.hello: druhé hello se stejnou identitou a resume projde jako dřív", () => {
  const clients = createClients({});
  const me = clients.hello(1, player({ clientId: playerId(1) }), AUTH).client;
  const again = clients.hello(1, player({ clientId: playerId(1), resume: me.resume }), AUTH);
  assert.equal(again.ok, true);
  assert.equal(again.created, false);
  assert.equal(again.replaced, undefined);
  assert.equal(again.client, me);
  assert.equal(clients.byConn(1), me);
  assert.equal(clients.list().length, 1);
});

test("clients.hello: na navázaném spojení se klíč ověří dřív než identita (forbidden, ne rehello)", () => {
  const clients = createClients({});
  const me = clients.hello(1, player({ clientId: playerId(1) }), AUTH).client;
  assert.deepEqual(clients.hello(1, hello({ remoteKey: undefined }), AUTH), FORBIDDEN);
  assert.equal(clients.byConn(1), me);
  // ovladač na vlastním spojení se špatným klíčem i špatným resume
  const remote = clients.hello(2, hello(), AUTH).client;
  assert.deepEqual(clients.hello(2, hello({ remoteKey: "a".repeat(12), resume: "špatné" }), AUTH), FORBIDDEN);
  assert.equal(clients.byConn(2), remote);
});

test("clients.hello: druhé hello se stejným clientId a rolí, ale jiným nebo chybějícím resume vrací rehello", () => {
  const clients = createClients({});
  const me = clients.hello(1, player({ clientId: playerId(1) }), AUTH).client;
  const remote = clients.hello(2, hello(), AUTH).client;
  for (const resume of [undefined, "špatné", "a".repeat(16)]) {
    assert.deepEqual(clients.hello(1, player({ clientId: playerId(1), resume }), AUTH), REHELLO, "hráč " + resume);
    assert.deepEqual(clients.hello(2, hello({ resume }), AUTH), REHELLO, "ovladač " + resume);
  }
  assert.equal(clients.byConn(1), me);
  assert.equal(clients.byConn(2), remote);
  assert.equal(clients.list().length, 2);
  // s platným resume projde ovladač i hráč jako dřív
  for (const [connId, msg, client] of [[1, player({ clientId: playerId(1), resume: me.resume }), me], [2, hello({ resume: remote.resume }), remote]]) {
    const r = clients.hello(connId, msg, AUTH);
    assert.equal(r.ok, true);
    assert.equal(r.created, false);
    assert.equal(r.client, client);
  }
  assert.equal(clients.list().length, 2);
});

test("clients.pin: neznámé spojení false, ovladač zůstane připnutý, příznak přežije drop a navázání", () => {
  const clients = createClients({});
  assert.equal(clients.pin(99), false);
  const remote = clients.hello(1, hello(), AUTH).client;
  assert.equal(remote.pinned, true);
  assert.equal(clients.pin(1), true);
  assert.equal(remote.pinned, true);

  const me = clients.hello(2, player({ clientId: playerId(1) }), AUTH).client;
  assert.equal(me.pinned, false);
  assert.equal(clients.pin(2), true);
  assert.equal(me.pinned, true);
  clients.drop(2);
  assert.equal(clients.pin(2), false);
  assert.equal(me.pinned, true);
  const again = clients.hello(3, player({ clientId: playerId(1), resume: me.resume }), AUTH);
  assert.equal(again.client, me);
  assert.equal(again.client.pinned, true);
});

test("clients.hello: plný registr uvolní nejdřív nepřipnuté od nejnovějšího, připnuté až nakonec", () => {
  const clients = createClients({ max: 4 });
  clients.hello(1, player({ clientId: playerId(1) }), AUTH);   // A – připnutý, nejstarší
  clients.pin(1);
  clients.drop(1);
  clients.hello(2, player({ clientId: playerId(2) }), AUTH);   // B
  clients.drop(2);
  clients.hello(3, player({ clientId: playerId(3) }), AUTH);   // C – nejnovější
  clients.drop(3);
  clients.hello(4, player({ clientId: playerId(4) }), AUTH);   // připojený

  assert.equal(clients.hello(5, player({ clientId: playerId(5) }), AUTH).ok, true);
  assert.deepEqual(ids(clients), [playerId(1), playerId(2), playerId(4), playerId(5)]);
  assert.equal(clients.hello(6, player({ clientId: playerId(6) }), AUTH).ok, true);
  assert.deepEqual(ids(clients), [playerId(1), playerId(4), playerId(5), playerId(6)]);
  clients.drop(5);
  assert.equal(clients.hello(7, player({ clientId: playerId(7) }), AUTH).ok, true);
  assert.deepEqual(ids(clients), [playerId(1), playerId(4), playerId(6), playerId(7)]);
  // nepřipnutý odpojený už není → přijde na řadu připnutý
  assert.equal(clients.hello(8, player({ clientId: playerId(8) }), AUTH).ok, true);
  assert.deepEqual(ids(clients), [playerId(4), playerId(6), playerId(7), playerId(8)]);
});

test("clients.hello: připnutý hráč přežije i staršího nepřipnutého (rozhoduje pin, ne role ani stáří)", () => {
  const clients = createClients({ max: 3 });
  clients.hello(1, player({ clientId: playerId(1) }), AUTH);   // P1 – nepřipnutý, starší
  clients.drop(1);
  const p2 = clients.hello(2, player({ clientId: playerId(2) }), AUTH).client;   // P2 – připnutý, novější
  clients.pin(2);
  clients.drop(2);
  clients.hello(3, player({ clientId: playerId(3) }), AUTH);   // P3 – připojený
  assert.equal(clients.hello(4, player({ clientId: playerId(4) }), AUTH).ok, true);
  assert.deepEqual(ids(clients), [playerId(2), playerId(3), playerId(4)]);
  clients.drop(4);
  const again = clients.hello(5, player({ clientId: playerId(2), resume: p2.resume }), AUTH);
  assert.equal(again.ok, true);
  assert.equal(again.created, false);
  assert.equal(again.client, p2);
});

test("clients.hello: mezi připnutými se uvolní nejnovější odpojený", () => {
  const clients = createClients({ max: 4 });
  for (const n of [1, 2]) {
    clients.hello(n, player({ clientId: playerId(n) }), AUTH);
    clients.pin(n);
    clients.drop(n);
  }
  clients.hello(3, player({ clientId: playerId(3) }), AUTH);
  clients.hello(4, player({ clientId: playerId(4) }), AUTH);
  assert.equal(clients.hello(5, player({ clientId: playerId(5) }), AUTH).ok, true);
  assert.deepEqual(ids(clients), [playerId(1), playerId(3), playerId(4), playerId(5)]);
});

test("clients.hello: odpojený ovladač přežije, když je v registru nepřipnutý odpojený hráč", () => {
  const clients = createClients({ max: 3 });
  clients.hello(1, player({ clientId: playerId(1) }), AUTH);   // starší než ovladač
  clients.drop(1);
  const remote = clients.hello(2, hello(), AUTH).client;
  clients.drop(2);
  clients.hello(3, player({ clientId: playerId(3) }), AUTH);
  assert.equal(clients.hello(4, player({ clientId: playerId(4) }), AUTH).ok, true);
  assert.ok(clients.list().includes(remote));
  assert.ok(!ids(clients).includes(playerId(1)));
});

test("clients.hello: připojený klient se neuvolní nikdy, plný registr připojených vrací full", () => {
  const clients = createClients({ max: 2 });
  clients.hello(1, player({ clientId: playerId(1) }), AUTH);
  clients.hello(2, player({ clientId: playerId(2) }), AUTH);
  clients.pin(2);
  assert.deepEqual(clients.hello(3, player({ clientId: playerId(3) }), AUTH), FULL);
  assert.deepEqual(ids(clients), [playerId(1), playerId(2)]);
});

test("clients.hello: útok jednorázovými identitami nevytlačí připnuté hráče ani ovladač", () => {
  const clients = createClients({ max: 16 });
  const kept = [];
  for (const n of [1, 2, 3]) {                                   // připnutí hráči, nejstarší záznamy
    kept.push(clients.hello(n, player({ clientId: playerId(n) }), AUTH).client);
    clients.pin(n);
    clients.drop(n);
  }
  kept.push(clients.hello(4, hello(), AUTH).client);             // ovladač
  clients.drop(4);
  for (let n = 11; n <= 18; n++) clients.hello(n, player({ clientId: playerId(n) }), AUTH);
  for (let n = 21; n <= 24; n++) {
    clients.hello(n, player({ clientId: playerId(n) }), AUTH);
    clients.drop(n);
  }
  assert.equal(clients.list().length, 16);

  for (let i = 0; i < 40; i++) {
    const connId = 100 + i;
    const r = clients.hello(connId, player({ clientId: "utok" + String(i).padStart(4, "0") }), AUTH);
    assert.equal(r.ok, true, String(i));
    clients.drop(connId);
  }

  assert.equal(clients.list().length, 16);
  for (const c of kept) assert.ok(clients.list().includes(c), c.clientId);
  kept.forEach((c, i) => {
    const msg = c.role === "remote" ? hello({ resume: c.resume }) : player({ clientId: c.clientId, resume: c.resume });
    const r = clients.hello(200 + i, msg, AUTH);
    assert.equal(r.ok, true, c.clientId);
    assert.equal(r.created, false, c.clientId);
    assert.equal(r.client, c);
  });
});

test("clients.list: pinned je jediné nové pole a je boolean", () => {
  const clients = createClients({});
  clients.hello(1, hello(), AUTH);
  clients.hello(2, player({ clientId: playerId(1) }), AUTH);
  for (const c of clients.list()) {
    assert.deepEqual(Object.keys(c).sort(), ["clientId", "connId", "connected", "lastSeq", "name", "pinned", "resume", "role"]);
    assert.equal(typeof c.pinned, "boolean");
  }
});

test("allowedFor: co smí která role poslat", () => {
  for (const t of ["key", "text", "hello"]) assert.equal(allowedFor("remote", t), true, "remote " + t);
  for (const t of ["join", "buzz", "answer", "hello"]) assert.equal(allowedFor("player", t), true, "player " + t);
  const denied = [
    ["player", "key"], ["player", "text"], ["remote", "join"], ["remote", "buzz"], ["remote", "answer"],
    ["admin", "hello"], ["constructor", "hello"], ["__proto__", "key"], [undefined, "hello"],
    ["remote", "intent"], ["player", "toString"], ["remote", undefined], ["player", undefined]
  ];
  for (const [role, type] of denied) assert.equal(allowedFor(role, type), false, role + " " + type);
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

test("playerStateView: propustí jen povolené klíče a vrátí nový objekt", () => {
  const input = {
    rev: 2, phase: "open", me: { name: "Eva" }, teams: [], quiz: { index: 1 }, buzz: null, mode: "answers", ask: null,
    correct: "a", answers: ["x"], remoteKey: "k2m4p6r8t9wx", t: "state"
  };
  const out = playerStateView(input);
  assert.notEqual(out, input);
  assert.deepEqual(Object.keys(out), PLAYER_STATE_KEYS);
  assert.ok(!JSON.stringify(out).includes("k2m4p6r8t9wx"));
  assert.ok("correct" in input && "remoteKey" in input);
});

test("playerStateView: chybějící klíče se nedoplňují, neplatný vstup vrací null", () => {
  assert.deepEqual(playerStateView({ phase: "off" }), { phase: "off" });
  assert.deepEqual(playerStateView({}), {});
  assert.equal(playerStateView(null), null);
  assert.equal(playerStateView([]), null);
  assert.equal(playerStateView("state"), null);
});

test("playerStateView: propustí mode a ask, correct a remoteKey na nejvyšší úrovni zahodí", () => {
  const ask = { round: 3, question: { question: "Q", answers: { a: "1", b: "2", c: "3" }, image: false, correct: null } };
  const out = playerStateView({ phase: "open", mode: "answers", ask, correct: "b", remoteKey: "k2m4p6r8t9wx" });
  assert.deepEqual(out, { phase: "open", mode: "answers", ask });
  assert.ok(!("correct" in out) && !("remoteKey" in out));
});

// --- zpráva answer a otázka pro hráče ---

test("parseMessage: answer projde a nese jen známá pole", () => {
  assert.deepEqual(ANSWER_KEYS, ["a", "b", "c"]);
  assert.deepEqual(parse({ t: "answer", round: 3, key: "b", seq: 5 }),
    { ok: true, msg: { v: 1, t: "answer", round: 3, key: "b", seq: 5 } });
  const r = parse({ t: "answer", round: 3, key: "b", seq: 5, elapsed: 12, rx: 99, q: 4, role: "remote", correct: "a" });
  assert.deepEqual(r, { ok: true, msg: { v: 1, t: "answer", round: 3, key: "b", seq: 5 } });
  assert.deepEqual(parse({ t: "answer", round: 0, key: "a", seq: 0 }).msg.round, 0);
});

test("parseMessage: answer s neplatnými poli vrací bad_message", () => {
  const ok = { t: "answer", round: 3, key: "b", seq: 5 };
  const bad = [
    { round: -1 }, { round: 1.5 }, { round: "3" }, { round: undefined }, { round: null },
    { key: "d" }, { key: "A" }, { key: 1 }, { key: undefined }, { key: "" }, { key: ["a"] },
    { seq: undefined }, { seq: -1 }, { seq: "5" }
  ];
  for (const over of bad) assert.deepEqual(parse({ ...ok, ...over }), BAD, JSON.stringify(over));
});

const SECRET_QUESTION = () => ({
  question: "Které město je hlavní?", answers: { a: "Praha", b: "Brno", c: "Ostrava" },
  correct: "a", explanation: "TAJNE-VYSVETLENI", picked: "c", difficulty: "TAJNA-OBTIZNOST", topic: "TAJNE-TEMA",
  image: { src: "/api/img?u=TAJNY-SRC", page: "https://cs.wikipedia.org/wiki/TAJNA-STRANKA", credit: "TAJNY-AUTOR" }
});

test("questionView: neodhalená otázka nepustí správnou odpověď, vysvětlení ani údaje o obrázku", () => {
  const input = SECRET_QUESTION();
  const out = questionView(input);
  assert.deepEqual(Object.keys(out).sort(), ["answers", "correct", "image", "question"]);
  assert.deepEqual(out, {
    question: "Které město je hlavní?", answers: { a: "Praha", b: "Brno", c: "Ostrava" }, image: true, correct: null
  });
  assert.deepEqual(Object.keys(out.answers), ["a", "b", "c"]);
  assert.notEqual(out.answers, input.answers);
  const json = JSON.stringify(out);
  for (const leak of ["TAJNE-VYSVETLENI", "TAJNY-SRC", "TAJNA-STRANKA", "TAJNY-AUTOR", "TAJNA-OBTIZNOST", "TAJNE-TEMA", "picked", "explanation"]) {
    assert.ok(!json.includes(leak), leak);
  }
});

test("questionView: správná odpověď až při revealed === true a platném klíči", () => {
  assert.equal(questionView({ ...SECRET_QUESTION(), revealed: true }).correct, "a");
  assert.equal(questionView({ ...SECRET_QUESTION(), revealed: true, correct: "c" }).correct, "c");
  for (const revealed of ["true", 1, {}, false, undefined]) {
    assert.equal(questionView({ ...SECRET_QUESTION(), revealed }).correct, null, String(revealed));
  }
  for (const correct of ["x", "A", 0, null, ["a"]]) {
    assert.equal(questionView({ ...SECRET_QUESTION(), revealed: true, correct }).correct, null, String(correct));
  }
  const revealed = JSON.stringify(questionView({ ...SECRET_QUESTION(), revealed: true }));
  for (const leak of ["TAJNE-VYSVETLENI", "TAJNY-SRC", "TAJNA-STRANKA", "TAJNY-AUTOR"]) assert.ok(!revealed.includes(leak), leak);
});

test("questionView: image je jen boolean", () => {
  const base = SECRET_QUESTION();
  assert.equal(questionView({ ...base, image: undefined }).image, false);
  assert.equal(questionView({ ...base, image: "/api/img?u=x" }).image, false);
  assert.equal(questionView({ ...base, image: null }).image, false);
  assert.equal(questionView(base).image, true);
});

test("questionView: zkracování v kódových bodech a ne-řetězcové odpovědi", () => {
  const out = questionView({ question: "q".repeat(600), answers: { a: "x".repeat(250), b: 42, c: null } });
  assert.equal(out.question.length, LIMITS.question);
  assert.equal(out.answers.a.length, LIMITS.answer);
  assert.equal(out.answers.b, "");
  assert.equal(out.answers.c, "");
  // Emoji (2 kódové jednotky UTF-16) na hranici se nerozpůlí.
  const emoji = questionView({ question: "q".repeat(499) + "😀😀", answers: { a: "x".repeat(199) + "😀😀" } });
  assert.equal(Array.from(emoji.question).length, LIMITS.question);
  assert.ok(emoji.question.endsWith("😀"));
  assert.ok(emoji.answers.a.endsWith("😀"));
  assert.ok(!/[\uD800-\uDBFF]$/.test(emoji.question) && !/[\uD800-\uDBFF]$/.test(emoji.answers.a));
  assert.equal(questionView({ question: "😀".repeat(600), answers: {} }).question, "😀".repeat(500));
});

test("questionView: neplatný vstup vrací null", () => {
  for (const q of [null, undefined, [], "otázka", 5, {}, { question: "Q" }, { answers: { a: "1" } },
    { question: 5, answers: {} }, { question: "Q", answers: ["1", "2", "3"] }, { question: "Q", answers: "abc" }]) {
    assert.equal(questionView(q), null, JSON.stringify(q));
  }
});

test("clients.forget: odpojený i připojený klient zmizí a stejné clientId se zakládá znovu", () => {
  const clients = createClients({});
  const gone = clients.hello(1, player({ clientId: playerId(1) }), AUTH).client;
  const other = clients.hello(2, player({ clientId: playerId(2) }), AUTH).client;
  clients.drop(1);
  assert.equal(clients.forget(playerId(1)), gone);
  assert.deepEqual(ids(clients), [playerId(2)]);

  assert.equal(clients.forget(playerId(2)), other);
  assert.deepEqual(ids(clients), []);
  assert.equal(clients.byConn(2), null);

  const again = clients.hello(3, player({ clientId: playerId(1), resume: gone.resume }), AUTH);
  assert.equal(again.ok, true);
  assert.equal(again.created, true);
  assert.notEqual(again.client, gone);
});

test("clients.forget: neznámé clientId vrací null a registr nechá beze změny", () => {
  const clients = createClients({});
  clients.hello(1, player({ clientId: playerId(1) }), AUTH);
  assert.equal(clients.forget(playerId(9)), null);
  assert.deepEqual(ids(clients), [playerId(1)]);
});

test("createRateLimiter: 30 volání projde, 31. v čase 30 ne", () => {
  const rl = createRateLimiter(30, 1000);
  for (let t = 0; t < 30; t++) assert.equal(rl.allow(t), true);
  assert.equal(rl.allow(30), false);
});

test("createRateLimiter: odmítnutá volání se nezapočítají", () => {
  const rl = createRateLimiter(30, 1000);
  for (let i = 0; i < 30; i++) assert.equal(rl.allow(0), true);
  for (let i = 0; i < 100; i++) assert.equal(rl.allow(500), false);
  assert.equal(rl.allow(1000), true);
});

test("createRateLimiter: okno je klouzavé a hranice patří do nového okna", () => {
  const rl = createRateLimiter(30, 1000);
  for (let i = 0; i < 30; i++) rl.allow(0);
  assert.equal(rl.allow(999), false);
  assert.equal(rl.allow(1000), true);
});

test("createRateLimiter: po 10 000 voláních projde jen max za okno (zápis jen při přijetí)", () => {
  const rl = createRateLimiter(3, 1000);
  let allowed = 0;
  for (let i = 0; i < 10000; i++) if (rl.allow(i)) allowed++;
  assert.equal(allowed, 30);
  assert.equal(rl.allow(100000), true);
});

test("createRateLimiter: čas jdoucí zpět nezpůsobí trvalé odmítání", () => {
  const rl = createRateLimiter(1, 1000);
  assert.equal(rl.allow(5000), true);
  assert.equal(rl.allow(5001), false);
  assert.equal(rl.allow(10), true);
  assert.equal(rl.allow(11), false);
});

test("createRateLimiter: neplatný čas vrací false a nevyhazuje", () => {
  const rl = createRateLimiter(30, 1000);
  for (const bad of [NaN, undefined, "5", null, Infinity, -Infinity, {}]) assert.equal(rl.allow(bad), false);
  assert.equal(rl.allow(0), true);
});

test("createRateLimiter: chybná konfigurace odmítá vše", () => {
  const configs = [[0, 1000], [-1, 1000], [30, 0], [30, -5], [NaN, NaN], [Infinity, 1000], [30, Infinity], ["30", 1000], []];
  for (const args of configs) {
    const rl = createRateLimiter(...args);
    assert.equal(rl.allow(0), false);
    assert.equal(rl.allow(5000), false);
  }
});

test("createRateLimiter: dva omezovače se neovlivňují", () => {
  const a = createRateLimiter(1, 1000);
  const b = createRateLimiter(1, 1000);
  assert.equal(a.allow(0), true);
  assert.equal(a.allow(1), false);
  assert.equal(b.allow(1), true);
});
