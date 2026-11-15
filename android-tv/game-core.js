// Čistá herní logika hráčů a bzučáku bez závislosti na DOM a bez časovačů (jde otestovat v Node: game-core.test.js).
// Vystaví se vždy jako root.KvizGameCore. Čas dostává od volajícího jako parametr; na jiných modulech nezávisí.
// Rozhraní: LIMITS, TIMING, cleanName(raw) → řetězec | null a createGame({ maxPlayers }) se soupiskou hráčů
// (join, remove, setConnected, players, remapTeams) a kolem bzučáku (openRound, arm, setPaused, buzz, resolve,
// release, closeRound, round). Tým se předává jako reference { name, emoji, color }.
(function (root) {
  "use strict";

  var LIMITS = { name: 16, players: 12, teams: 4 };
  var TIMING = { armDelayMs: 1000, windowMs: 60, earlyPenaltyMs: 1500 };
  var STATUS = { idle: "idle", waiting: "waiting", armed: "armed", collecting: "collecting", answering: "answering", closed: "closed" };
  var RESULTS = ["correct", "wrong"];

  // Řídicí znaky (bez tabulátoru a zalomení řádku, ty se mění na mezeru níže), neviditelné a směrové znaky a ostatní
  // „ignorovatelné“ znaky Unicode (např. U+3164). Výběr varianty emoji U+FE0F zůstává jen hned za piktogramem;
  // jinde by dal neviditelné jméno nebo „Pepa“ s neviditelným znakem navíc (obešel by příponu jedinečnosti).
  var STRIP_RE = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]|(?!\uFE0F)\p{Default_Ignorable_Code_Point}|(?<!\p{Extended_Pictographic})\uFE0F/gu;

  // Vyčistí přezdívku od cizího hosta; null = nepoužitelná. Jediné místo, kde se syrový text zpracovává.
  function cleanName(raw) {
    if (typeof raw !== "string") return null;
    var text = raw.toWellFormed().normalize("NFC").replace(STRIP_RE, "").replace(/\s+/g, " ").trim();
    text = Array.from(text).slice(0, LIMITS.name).join("").trim();
    return text === "" ? null : text;
  }

  function copyRef(team) {
    return { name: String(team.name), emoji: String(team.emoji), color: String(team.color) };
  }

  function sameRef(a, b) {
    return a.name === b.name && a.emoji === b.emoji && a.color === b.color;
  }

  function isValidTeam(team, teams) {
    return Array.isArray(teams) && Number.isInteger(team) && team >= 0 && team < teams.length;
  }

  // Přezdívka, která není mezi obsazenými (bez ohledu na velikost písmen); jinak s příponou " 2", " 3", …
  function uniqueName(base, taken) {
    if (!taken[base.toLowerCase()]) return base;
    for (var n = 2; ; n++) {
      var suffix = " " + n;
      var head = Array.from(base).slice(0, LIMITS.name - suffix.length).join("").trimEnd();
      var candidate = head + suffix;
      if (!taken[candidate.toLowerCase()]) return candidate;
    }
  }

  function createGame(options) {
    var requested = options && options.maxPlayers;
    var maxPlayers = Number.isInteger(requested) && requested > 0 ? requested : LIMITS.players;
    var list = []; // hráči v pořadí zápisu: { clientId, name, team, teamRef, connected, penaltyUntil }
    var knownTeamCount = null;
    // team = index týmu vítěze, by = jeho přezdívka; pending = stisky čekající na resolve(): { clientId, rx, seq }
    var state = { q: null, status: STATUS.idle, paused: false, team: null, by: null, byClientId: null, lockedTeams: [], pending: [], result: null };
    var buzzSeq = 0; // pořadí zápisu stisků, rozhoduje při shodném rx

    function find(clientId) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].clientId === clientId) return list[i];
      }
      return null;
    }

    function findPending(clientId) {
      for (var i = 0; i < state.pending.length; i++) {
        if (state.pending[i].clientId === clientId) return state.pending[i];
      }
      return null;
    }

    function clearWinner() {
      state.team = null;
      state.by = null;
      state.byClientId = null;
    }

    // Odpovídá právě tým tohoto hráče (nebo hráč čeká na vyhodnocení svého stisku)? Pak nesmí měnit tým.
    function teamBusy(player) {
      if (state.status === STATUS.answering) return player.team !== null && player.team === state.team;
      if (state.status === STATUS.collecting) return findPending(player.clientId) !== null;
      return false;
    }

    // Vrátí rozehrané kolo do čekání po změně týmů: zámky i vítěz by ukazovaly na jiné týmy (volající znovu odjistí).
    function resetRoundAfterRemap() {
      if (state.status !== STATUS.armed && state.status !== STATUS.collecting && state.status !== STATUS.answering) return;
      state.status = STATUS.waiting;
      state.lockedTeams = [];
      state.pending = [];
      state.result = null;
      clearWinner();
    }

    // Uvolní místo nejdéle zapsaným odpojeným hráčem; false, když žádný odpojený není.
    function freeSlot() {
      for (var i = 0; i < list.length; i++) {
        if (!list[i].connected) {
          list.splice(i, 1);
          return true;
        }
      }
      return false;
    }

    function join(clientId, rawName, team, teams) {
      var base = cleanName(rawName);
      if (base === null || !isValidTeam(team, teams)) return { ok: false, reason: "invalid" };
      // Týmy se změnily dřív, než volající zavolal remapTeams: nejdřív dohledat stávající hráče, jinak by pozdější
      // remapTeams změnu počtu nepoznal a hráč by přešel do cizího týmu na svém indexu.
      if (knownTeamCount !== null && knownTeamCount !== teams.length) remapTeams(teams);
      var player = find(clientId);
      if (player && teamBusy(player)) return { ok: false, reason: "locked" };
      if (!player && list.length >= maxPlayers && !freeSlot()) return { ok: false, reason: "full" };

      var taken = Object.create(null); // přezdívka může být i „__proto__“ nebo „constructor“
      list.forEach(function (p) {
        if (p !== player) taken[p.name.toLowerCase()] = true;
      });
      var name = uniqueName(base, taken);
      if (player) {
        player.name = name;
        player.team = team;
        player.teamRef = copyRef(teams[team]);
      } else {
        player = { clientId: clientId, name: name, team: team, teamRef: copyRef(teams[team]), connected: true, penaltyUntil: 0 };
        list.push(player);
      }
      knownTeamCount = teams.length;
      return { ok: true, player: { clientId: player.clientId, name: player.name, team: player.team } };
    }

    function remove(clientId) {
      var player = find(clientId);
      if (!player) return false;
      list.splice(list.indexOf(player), 1);
      return true;
    }

    function setConnected(clientId, on) {
      var player = find(clientId);
      if (!player) return false;
      player.connected = !!on;
      return true;
    }

    function players() {
      return list.map(function (p) {
        return { clientId: p.clientId, name: p.name, team: p.team, connected: p.connected };
      });
    }

    // Po změně týmů na TV dohledá každému hráči jeho tým podle reference (název, emoji, barva).
    function remapTeams(teams) {
      var changed = false;
      var indexChanged = false;
      list.forEach(function (p) {
        if (p.team === null) return;
        // Nejdřív vlastní index, aby hráč při dvou stejných týmech nepřešel do prvního z nich.
        var index = p.team < teams.length && sameRef(teams[p.team], p.teamRef) ? p.team : -1;
        for (var i = 0; index === -1 && i < teams.length; i++) {
          if (sameRef(teams[i], p.teamRef)) index = i;
        }
        // Úprava týmu (název, emoji, barva) nemění jejich počet; při jiném počtu by index ukazoval na cizí tým.
        if (index === -1 && knownTeamCount === teams.length && p.team < teams.length) index = p.team;
        if (index === -1) {
          p.team = null;
          p.teamRef = null;
          changed = true;
          indexChanged = true;
          return;
        }
        var ref = copyRef(teams[index]);
        if (!sameRef(ref, p.teamRef)) changed = true;
        if (index !== p.team) { changed = true; indexChanged = true; }
        p.team = index;
        p.teamRef = ref;
      });
      var countChanged = knownTeamCount !== null && knownTeamCount !== teams.length;
      knownTeamCount = teams.length;
      if (countChanged) changed = true;
      if (indexChanged || countChanged) resetRoundAfterRemap();
      return changed;
    }

    // Nové kolo pro otázku q: bez vítěze, zámků, čekajících stisků i trestů. Pozastavení trvá.
    function openRound(q) {
      state.q = q;
      state.status = STATUS.waiting;
      state.lockedTeams = [];
      state.pending = [];
      state.result = null;
      clearWinner();
      list.forEach(function (p) {
        p.penaltyUntil = 0;
      });
    }

    function arm() {
      if (state.status !== STATUS.waiting) return false;
      state.status = STATUS.armed;
      return true;
    }

    function setPaused(on) {
      state.paused = !!on;
    }

    // Stisk bzučáku. rx = čas příjmu z pluginu (jen pro pořadí), now = hodiny JS (jen pro trest); nikdy se neporovnávají.
    // Pořadí kontrol je závazné (kontrakt), určuje důvod, který hráč uvidí.
    function buzz(clientId, q, rx, now) {
      var player = find(clientId);
      if (!player || player.team === null) return { ok: false, reason: "nojoin" };
      if (state.status === STATUS.idle || state.status === STATUS.closed || state.paused) return { ok: false, reason: "closed" };
      if (q !== state.q || state.status === STATUS.answering) return { ok: false, reason: "late" };
      if (state.lockedTeams.indexOf(player.team) !== -1) return { ok: false, reason: "locked" };
      if (now < player.penaltyUntil) return { ok: false, reason: "locked" };
      if (state.status === STATUS.waiting) {
        player.penaltyUntil = now + TIMING.earlyPenaltyMs;
        return { ok: false, reason: "early" };
      }
      var first = state.status === STATUS.armed;
      // Opakovaný stisk se ignoruje, aby si hráč nemohl dodatečně „vylepšit“ čas.
      if (findPending(clientId) === null) {
        state.pending.push({ clientId: clientId, rx: Number.isFinite(rx) ? rx : Infinity, seq: buzzSeq++ });
      }
      state.status = STATUS.collecting;
      return { ok: true, first: first };
    }

    // Vybere vítěze z čekajících stisků: nejnižší rx, při shodě dřívější zápis. Hráče bez týmu nebo odebrané přeskočí.
    function resolve() {
      if (state.status !== STATUS.collecting) return null;
      var ordered = state.pending.slice().sort(function (a, b) {
        return a.rx === b.rx ? a.seq - b.seq : a.rx - b.rx;
      });
      state.pending = [];
      for (var i = 0; i < ordered.length; i++) {
        var player = find(ordered[i].clientId);
        if (!player || player.team === null) continue;
        state.status = STATUS.answering;
        state.team = player.team;
        state.by = player.name;
        state.byClientId = player.clientId;
        return { clientId: player.clientId, name: player.name, team: player.team };
      }
      state.status = STATUS.armed;
      return null;
    }

    // Tým vítěze odpověděl špatně: zamkne se a druhou šanci dostanou ostatní týmy s připojeným hráčem.
    function release() {
      if (state.status !== STATUS.answering) return null;
      if (state.lockedTeams.indexOf(state.team) === -1) state.lockedTeams.push(state.team);
      clearWinner();
      var open = list.some(function (p) {
        return p.connected && p.team !== null && state.lockedTeams.indexOf(p.team) === -1;
      });
      state.status = open ? STATUS.armed : STATUS.closed;
      return { open: open };
    }

    // Vítěz zůstává kvůli snímku pro mobil; výsledek se uloží jen u kola s vítězem.
    function closeRound(result) {
      state.status = STATUS.closed;
      state.pending = [];
      state.result = state.byClientId !== null && RESULTS.indexOf(result) !== -1 ? result : null;
    }

    function round() {
      return {
        q: state.q,
        status: state.status,
        paused: state.paused,
        team: state.team,
        by: state.by,
        byClientId: state.byClientId,
        lockedTeams: state.lockedTeams.slice(),
        result: state.result
      };
    }

    return {
      join: join,
      remove: remove,
      setConnected: setConnected,
      players: players,
      remapTeams: remapTeams,
      openRound: openRound,
      arm: arm,
      setPaused: setPaused,
      buzz: buzz,
      resolve: resolve,
      release: release,
      closeRound: closeRound,
      round: round
    };
  }

  root.KvizGameCore = { LIMITS: LIMITS, TIMING: TIMING, cleanName: cleanName, createGame: createGame };
})(typeof window !== "undefined" ? window : globalThis);
