// Čistá logika mobilního ovládání bez závislosti na DOM (jde otestovat v Node: link-core.test.js).
// Vystaví se vždy jako root.KvizLinkCore (kořenový package.json má "type": "module", takže bez require/module.exports).
// Čte KvizTvCore.ACTIONS z core.js, proto se core.js musí načíst dřív. Rozhraní: kontrakt mobilního ovládání § 2 a § 4.
(function (root) {
  "use strict";

  var PROTOCOL = 1;
  var LIMITS = { text: 500, name: 16, message: 4096, players: 12, remoteKey: 64 };
  var CLIENT_ID_LENGTH = { min: 8, max: 32 };
  var TOKEN_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
  var TOKEN_LENGTH = 6;
  var TYPES = ["hello", "key", "text", "join", "buzz"];
  var ROLES = ["remote", "player"];
  var REMOTE_KEY_LENGTH = 12;
  var RESUME_LENGTH = 16;
  var MAX_TEAMS = 4;
  var VIEWS = ["setup", "loading", "quiz", "results", "archive"];
  var OVERLAYS = ["dialog", "menu", "emoji"];

  var tvActions = (root.KvizTvCore && root.KvizTvCore.ACTIONS) || [];

  // Akce z mobilu: všechny z core.js plus tlačítka, která na ovladači TV nejsou.
  var REMOTE_ACTIONS = tvActions.map(function (a) { return a.id; })
    .concat(["back", "answer1", "answer2", "answer3"]);

  function isPlainObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  function isString(v, min, max) {
    return typeof v === "string" && v.length >= min && v.length <= max;
  }

  function isSeq(v) {
    return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  }

  // Každý validátor vrátí novou zprávu jen se známými poli, nebo null.
  function readHello(m) {
    if (!isString(m.clientId, CLIENT_ID_LENGTH.min, CLIENT_ID_LENGTH.max)) return null;
    if (ROLES.indexOf(m.role) < 0) return null;
    if (m.resume !== undefined && !isString(m.resume, 1, LIMITS.message)) return null;
    if (m.name !== undefined && !isString(m.name, 0, LIMITS.name)) return null;
    if (m.remoteKey !== undefined && !isString(m.remoteKey, 1, LIMITS.remoteKey)) return null;
    var out = { v: PROTOCOL, t: "hello", clientId: m.clientId, role: m.role };
    if (m.resume !== undefined) out.resume = m.resume;
    // Hráč posílá přezdívku jen přes join (tam se čistí) a klíč ovladače nemá.
    if (m.role === "remote") {
      if (m.name !== undefined) out.name = m.name;
      if (m.remoteKey !== undefined) out.remoteKey = m.remoteKey;
    }
    return out;
  }

  function readKey(m) {
    if (typeof m.action !== "string" || REMOTE_ACTIONS.indexOf(m.action) < 0) return null;
    if (!isSeq(m.seq)) return null;
    return { v: PROTOCOL, t: "key", action: m.action, seq: m.seq };
  }

  function readText(m) {
    if (!isString(m.value, 0, LIMITS.text)) return null;
    if (m.done !== undefined && typeof m.done !== "boolean") return null;
    if (!isSeq(m.seq)) return null;
    var out = { v: PROTOCOL, t: "text", value: m.value, seq: m.seq };
    if (m.done !== undefined) out.done = m.done;
    return out;
  }

  function readJoin(m) {
    if (!isString(m.name, 1, LIMITS.name)) return null;
    if (typeof m.team !== "number" || !Number.isSafeInteger(m.team) || m.team < 0 || m.team >= MAX_TEAMS) return null;
    if (!isSeq(m.seq)) return null;
    return { v: PROTOCOL, t: "join", name: m.name, team: m.team, seq: m.seq };
  }

  function readBuzz(m) {
    if (!isSeq(m.q) || !isSeq(m.seq)) return null;
    return { v: PROTOCOL, t: "buzz", q: m.q, seq: m.seq };
  }

  var READERS = { hello: readHello, key: readKey, text: readText, join: readJoin, buzz: readBuzz };

  // Validace zprávy z mobilu (nedůvěryhodný vstup). Nikdy nevyhazuje výjimku.
  function parseMessage(raw) {
    var bad = { ok: false, code: "bad_message" };
    if (typeof raw !== "string" || raw.length > LIMITS.message) return bad;
    var m;
    try { m = JSON.parse(raw); } catch (err) { return bad; }
    if (!isPlainObject(m) || m.v !== PROTOCOL) return bad;
    if (typeof m.t !== "string" || TYPES.indexOf(m.t) < 0) return bad;
    var msg = READERS[m.t](m);
    return msg ? { ok: true, msg: msg } : bad;
  }

  // Příkaz pro TV: klávesa (init pro KeyboardEvent), Zpět, nebo odpověď 1–3; neznámá akce → null.
  function commandOf(action) {
    if (typeof action !== "string") return null;
    if (action === "back") return { kind: "back" };
    var answer = /^answer([1-3])$/.exec(action);
    if (answer) return { kind: "answer", n: Number(answer[1]) };
    for (var i = 0; i < tvActions.length; i++) {
      if (tvActions[i].id !== action) continue;
      var send = tvActions[i].send;
      return { kind: "key", init: { key: send.key, code: send.code, keyCode: send.keyCode, bubbles: true, cancelable: true } };
    }
    return null;
  }

  // Náhodný řetězec z abecedy párovacího kódu. `random` vrací 0–1.
  function randomText(length, random) {
    var text = "";
    for (var i = 0; i < length; i++) {
      var idx = Math.min(TOKEN_ALPHABET.length - 1, Math.floor(random() * TOKEN_ALPHABET.length));
      text += TOKEN_ALPHABET.charAt(idx);
    }
    return text;
  }

  // Párovací kód: 6 znaků z abecedy bez zaměnitelných znaků. `random` vrací 0–1 (výchozí Math.random).
  function newToken(random) {
    return randomText(TOKEN_LENGTH, random || Math.random);
  }

  // Klíč ovladače: 12 znaků, výchozí zdroj je kryptografický.
  function newRemoteKey(random) {
    return randomText(REMOTE_KEY_LENGTH, random || secureRandom);
  }

  // Adresa ovladače pro QR: http://<ip>:<port>/m/?t=<token>[&k=<remoteKey>]
  function buildUrl(ip, port, token, remoteKey) {
    var url = "http://" + ip + ":" + port + "/m/?t=" + encodeURIComponent(token);
    if (typeof remoteKey === "string" && remoteKey !== "") url += "&k=" + encodeURIComponent(remoteKey);
    return url;
  }

  // Adresa pro hráče (bez klíče ovladače): http://<ip>:<port>/m/player.html?t=<token>
  function buildPlayerUrl(ip, port, token) {
    return "http://" + ip + ":" + port + "/m/player.html?t=" + encodeURIComponent(token);
  }

  // Priorita site-local IPv4: 192.168.x.x, pak 10.x.x.x, pak 172.16–31.x.x; jiné adresy se přeskočí.
  function addressRank(ip) {
    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(typeof ip === "string" ? ip : "");
    if (!m) return -1;
    var o = m.slice(1).map(Number);
    if (o.some(function (n) { return n > 255; })) return -1;
    if (o[0] === 192 && o[1] === 168) return 0;
    if (o[0] === 10) return 1;
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return 2;
    return -1;
  }

  function pickAddress(addresses) {
    if (!Array.isArray(addresses)) return null;
    var best = null;
    var bestRank = Infinity;
    for (var i = 0; i < addresses.length; i++) {
      var rank = addressRank(addresses[i]);
      if (rank >= 0 && rank < bestRank) { best = addresses[i]; bestRank = rank; }
    }
    return best;
  }

  // Zdroj náhody pro tajemství `resume`: kryptografický, když ho prostředí má.
  function secureRandom() {
    var c = root.crypto;
    if (!c || typeof c.getRandomValues !== "function") return Math.random();
    return c.getRandomValues(new Uint32Array(1))[0] / 4294967296;
  }

  // Porovnání tajemství v konstantním čase vůči obsahu: cyklus projde všechny znaky bez předčasného konce,
  // aby doba odpovědi neprozradila, kde je první neshoda. Délka se prozradit smí (klíč má pevnou délku).
  function sameSecret(a, b) {
    if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  // Ovladač projde, jen když TV má nastavený klíč a zpráva nese tentýž. Bez klíče na TV se nepřipojí nikdo.
  // Krátký klíč TV (chyba v úložišti) by šel uhodnout, proto se bere jako nenastavený.
  function remoteAuthorized(msg, auth) {
    var expected = auth && auth.remoteKey;
    if (typeof expected !== "string" || expected.length < REMOTE_KEY_LENGTH) return false;
    return sameSecret(msg.remoteKey, expected);
  }

  // Které zprávy smí role poslat (kontrakt hráčů § 3). `hello` smí každá známá role.
  var PERMISSIONS = { remote: ["key", "text"], player: ["join", "buzz"] };

  function allowedFor(role, type) {
    if (typeof role !== "string" || !Object.prototype.hasOwnProperty.call(PERMISSIONS, role)) return false;
    return type === "hello" || PERMISSIONS[role].indexOf(type) >= 0;
  }

  // Registr klientů (mobilů). TV je autorita: drží identitu, `resume` a poslední přijaté `seq`.
  // Klient se po výpadku nemaže, aby na něj šlo navázat. Při zaplnění se uvolní jeden odpojený:
  // nejdřív nepřipnutý od nejnovějšího, pak připnutý od nejnovějšího; připojený nikdy. Jednorázové
  // identity útočníka tak vytlačují samy sebe, ne hráče se zhasnutým telefonem ani ovladač.
  // Klient: { clientId, resume, role, name, connId, connected, lastSeq, pinned }; `name` má jen ovladač, hráč "".
  // `pinned`: ovladač od vzniku (prošel klíčem), hráč po `pin(connId)`; příznak se už neodebírá.
  function createClients(options) {
    var opts = options || {};
    var max = opts.max > 0 ? opts.max : 16;
    var maxPlayers = opts.maxPlayers > 0 ? opts.maxPlayers : LIMITS.players;
    var random = opts.random || secureRandom;
    var clients = [];          // v pořadí vzniku
    var byConnId = {};         // connId -> klient (jen připojení)

    function find(clientId) {
      for (var i = 0; i < clients.length; i++) if (clients[i].clientId === clientId) return clients[i];
      return null;
    }

    function unbind(client) {
      if (client.connId !== null) delete byConnId[client.connId];
      client.connId = null;
      client.connected = false;
    }

    // Nejnovější odpojený klient s daným příznakem `pinned` (pole je v pořadí vzniku), nebo -1.
    function newestDisconnected(pinned) {
      for (var i = clients.length - 1; i >= 0; i--) {
        if (!clients[i].connected && clients[i].pinned === pinned) return i;
      }
      return -1;
    }

    function freeSlot() {
      if (clients.length < max) return true;
      var idx = newestDisconnected(false);
      if (idx < 0) idx = newestDisconnected(true);
      if (idx < 0) return false;
      clients.splice(idx, 1);
      return true;
    }

    // Požadované clientId může patřit někomu jinému (špatné resume) – pak TV přidělí vlastní.
    function uniqueId(wanted) {
      var id = wanted;
      while (find(id)) id = randomText(CLIENT_ID_LENGTH.min * 2, random);
      return id;
    }

    // Připojení hráči kromě `except` (ten, kdo se právě navazuje, své místo neobsazuje dvakrát).
    function connectedPlayers(except) {
      var count = 0;
      for (var i = 0; i < clients.length; i++) {
        var c = clients[i];
        if (c !== except && c.connected && c.role === "player") count++;
      }
      return count;
    }

    function create(connId, msg) {
      if (!freeSlot()) return { ok: false, code: "full" };
      var client = {
        clientId: uniqueId(msg.clientId), resume: randomText(RESUME_LENGTH, random), role: msg.role,
        name: msg.role === "remote" ? msg.name || "" : "", connId: connId, connected: true, lastSeq: -1,
        pinned: msg.role === "remote"
      };
      clients.push(client);
      byConnId[connId] = client;
      return { ok: true, client: client, created: true };
    }

    return {
      // Zpracuje ověřený `hello` podle pravidel 1–6 (kontrakt hráčů § 3); `auth = { remoteKey }` dodává TV.
      // Výsledek: { ok, client, created, replaced? } nebo { ok: false, code }.
      hello: function (connId, msg, auth) {
        if (!msg || ROLES.indexOf(msg.role) < 0) return { ok: false, code: "bad_message" };
        // Klíč se ověří dřív, než se registr jakkoli změní – odmítnutí nesmí nikoho odpojit.
        if (msg.role === "remote" && !remoteAuthorized(msg, auth)) return { ok: false, code: "forbidden" };
        // Druhý hello na témže spojení smí jen tutéž identitu i s platným `resume`; jinak by jedno spojení
        // zakládalo identity bez konce (špatné `resume` by nenavázalo zpět, jen vytvořilo nového klienta).
        var bound = byConnId[connId];
        var sameIdentity = bound && bound.clientId === msg.clientId && bound.role === msg.role && bound.resume === msg.resume;
        if (bound && !sameIdentity) return { ok: false, code: "rehello" };
        if (bound) unbind(bound);
        var found = find(msg.clientId);
        // Role se přes `resume` nepřenáší: hráč se cizím `resume` ovladače nestane ovladačem a naopak.
        var known = found && found.resume === msg.resume && found.role === msg.role ? found : null;
        if (msg.role === "player" && connectedPlayers(known) >= maxPlayers) return { ok: false, code: "full" };
        if (!known) return create(connId, msg);
        var replaced = known.connected && known.connId !== connId ? known.connId : undefined;
        unbind(known);
        known.connId = connId;
        known.connected = true;
        if (msg.role === "remote" && msg.name !== undefined) known.name = msg.name;
        byConnId[connId] = known;
        var result = { ok: true, client: known, created: false };
        if (replaced !== undefined) result.replaced = replaced;
        return result;
      },
      byConn: function (connId) { return byConnId[connId] || null; },
      // Připne klienta na spojení (volá TV po úspěšném `join`): při zaplnění registru se uvolní až po nepřipnutých.
      pin: function (connId) {
        var client = byConnId[connId];
        if (!client) return false;
        client.pinned = true;
        return true;
      },
      // Spojení skončilo: klient zůstane v registru. Spojení už nahrazené novým se nikoho nedotkne.
      drop: function (connId) {
        var client = byConnId[connId];
        if (!client) return null;
        unbind(client);
        return client;
      },
      list: function () { return clients.slice(); },
      // Zpráva se provede jen se `seq` větším než poslední přijaté; jinak (i bez hello) false.
      accept: function (connId, seq) {
        var client = byConnId[connId];
        if (!client || !(seq > client.lastSeq)) return false;
        client.lastSeq = seq;
        return true;
      }
    };
  }

  function isPositiveFinite(n) {
    return typeof n === "number" && Number.isFinite(n) && n > 0;
  }

  // Omezovač počtu zpráv jednoho spojení: nejvýš `max` povolených volání v klouzavém okně `windowMs`.
  // Čas dodává volající (testovatelné bez čekání). Chybná konfigurace nebo neplatný čas = vždy odmítnout.
  function createRateLimiter(max, windowMs) {
    var valid = isPositiveFinite(max) && isPositiveFinite(windowMs);
    var times = [];
    var last = -Infinity;
    return {
      allow: function (now) {
        if (!valid || typeof now !== "number" || !Number.isFinite(now)) return false;
        // Hodiny šly zpět: staré záznamy by jinak blokovaly spojení, dokud čas nedožene minulost.
        if (now < last) times.length = 0;
        last = now;
        var expired = 0;
        while (expired < times.length && times[expired] <= now - windowMs) expired++;
        if (expired > 0) times.splice(0, expired);
        // Zapisuje se jen přijaté volání, takže pole nikdy nepřeroste `max`.
        if (times.length >= max) return false;
        times.push(now);
        return true;
      }
    };
  }

  // Pole snímku z aktivního textového pole na TV. Hodnota hesla TV nikdy neopustí.
  function fieldView(field) {
    if (!isPlainObject(field)) return null;
    var masked = field.type === "password";
    var value = typeof field.value === "string" && !masked ? field.value.slice(0, LIMITS.text) : "";
    return {
      key: String(field.key),
      label: String(field.label),
      type: String(field.type),
      value: value,
      masked: masked,
      maxLength: Number.isSafeInteger(field.maxLength) && field.maxLength > 0 ? field.maxLength : LIMITS.text
    };
  }

  function toCount(n, max) {
    return Number.isSafeInteger(n) ? Math.max(0, Math.min(max, n)) : 0;
  }

  function quizView(quiz) {
    if (!isPlainObject(quiz)) return null;
    return { index: toCount(quiz.index, Infinity), total: toCount(quiz.total, Infinity), revealed: quiz.revealed === true };
  }

  // Snímek stavu pro roli (kontrakt § 3) jen z povolených polí; cokoli navíc ve vstupu se zahodí.
  // Neznámá role → null (role player patří do dalších etap). `rev` se přenese, když ho vstup má.
  function stateView(role, input) {
    if (role !== "remote" || !isPlainObject(input)) return null;
    var view = {};
    if (Number.isSafeInteger(input.rev)) view.rev = input.rev;
    view.view = VIEWS.indexOf(input.view) >= 0 ? input.view : "setup";
    view.locked = input.locked === true;
    view.overlay = OVERLAYS.indexOf(input.overlay) >= 0 ? input.overlay : null;
    view.teamCount = toCount(input.teamCount, MAX_TEAMS);
    view.quiz = quizView(input.quiz);
    view.field = fieldView(input.field);
    return view;
  }

  function sameValue(a, b) {
    if (a === b) return true;
    if (!isPlainObject(a) || !isPlainObject(b)) return false;
    var keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every(function (k) { return sameValue(a[k], b[k]); });
  }

  // Jsou dva snímky stejné (bez `rev`)? Volající pak neposílá stejný snímek dvakrát.
  function sameState(a, b) {
    if (!isPlainObject(a) || !isPlainObject(b)) return a === b;
    var left = Object.assign({}, a);
    var right = Object.assign({}, b);
    delete left.rev;
    delete right.rev;
    return sameValue(left, right);
  }

  root.KvizLinkCore = {
    PROTOCOL: PROTOCOL, LIMITS: LIMITS, ROLES: ROLES, REMOTE_KEY_LENGTH: REMOTE_KEY_LENGTH, TOKEN_ALPHABET: TOKEN_ALPHABET, REMOTE_ACTIONS: REMOTE_ACTIONS,
    parseMessage: parseMessage, commandOf: commandOf, newToken: newToken, newRemoteKey: newRemoteKey, buildUrl: buildUrl, buildPlayerUrl: buildPlayerUrl, pickAddress: pickAddress,
    allowedFor: allowedFor, createClients: createClients, createRateLimiter: createRateLimiter, fieldView: fieldView, stateView: stateView, sameState: sameState
  };
})(typeof window !== "undefined" ? window : globalThis);
