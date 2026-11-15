// Čistá herní logika hráčů a bzučáku bez závislosti na DOM a bez časovačů (jde otestovat v Node: game-core.test.js).
// Vystaví se vždy jako root.KvizGameCore. Čas dostává od volajícího jako parametr; na jiných modulech nezávisí.
// Rozhraní: LIMITS, TIMING, cleanName(raw) → řetězec | null a createGame({ maxPlayers }) se soupiskou hráčů
// (join, remove, setConnected, players, remapTeams). Tým se předává jako reference { name, emoji, color }.
(function (root) {
  "use strict";

  var LIMITS = { name: 16, players: 12, teams: 4 };
  var TIMING = { armDelayMs: 1000, windowMs: 60, earlyPenaltyMs: 1500 };

  // Řídicí znaky (bez tabulátoru a zalomení řádku, ty se mění na mezeru níže), neviditelné a směrové znaky a ostatní
  // „ignorovatelné“ znaky Unicode (např. U+3164); výběr varianty emoji U+FE0F zůstává.
  var STRIP_RE = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]|(?!\uFE0F)\p{Default_Ignorable_Code_Point}/gu;

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

    function find(clientId) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].clientId === clientId) return list[i];
      }
      return null;
    }

    // Odpovídá právě tým tohoto hráče? Naplní list kola.
    function teamBusy(player) {
      return false;
    }

    // Vrátí rozehrané kolo do čekání po změně týmů. Naplní list kola.
    function resetRoundAfterRemap() {}

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
        var index = -1;
        for (var i = 0; i < teams.length; i++) {
          if (sameRef(teams[i], p.teamRef)) { index = i; break; }
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

    return { join: join, remove: remove, setConnected: setConnected, players: players, remapTeams: remapTeams };
  }

  root.KvizGameCore = { LIMITS: LIMITS, TIMING: TIMING, cleanName: cleanName, createGame: createGame };
})(typeof window !== "undefined" ? window : globalThis);
