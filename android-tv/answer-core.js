// Čistá logika kola „každý hráč odpovídá na mobilu“ bez závislosti na DOM a bez časovačů (jde otestovat v Node:
// answer-core.test.js). Vystaví se vždy jako root.KvizAnswerCore; na jiných modulech nezávisí.
// Dvoje hodiny: rx, sentAt a openAt jsou hodiny pluginu (jen pro výpočet času odpovědi), now a deadlineAt hodiny JS
// (jen konec příjmu a zbývající čas). Nikdy se navzájem neporovnávají; mobil čas neposílá, takže ho nejde podvrhnout.
// Rozhraní: KEYS, TIMING, points(base, elapsedMs, limitMs) a createAnswers() s metodami open, setOpenAt, answer,
// close, cancel, running, allAnswered, count, round. Závazné znění: .claude-work/2026-11-17-odpovedi-na-mobilu/kontrakt.md § 4.
(function (root) {
  "use strict";

  var KEYS = ["a", "b", "c"];
  var TIMING = { limitMs: 30000, revealDelayMs: 1500 };
  var STATUS = { idle: "idle", open: "open", closed: "closed", result: "result" };
  var CLOSE_REASONS = ["time", "all", "reveal"];
  var MS_PER_SECOND = 1000;

  function isPositiveFinite(value) {
    return Number.isFinite(value) && value > 0;
  }

  // Základ + bonus za rychlost po celých sekundách; bez platného času jen základ.
  function points(base, elapsedMs, limitMs) {
    if (!Number.isSafeInteger(base) || base <= 0) return 0;
    if (!Number.isFinite(elapsedMs) || !isPositiveFinite(limitMs)) return base;
    var seconds = Math.floor(Math.min(Math.max(elapsedMs, 0), limitMs) / MS_PER_SECOND);
    var limitSeconds = limitMs / MS_PER_SECOND;
    return base + Math.round(base * (limitSeconds - seconds) / limitSeconds);
  }

  function hasTeam(player) {
    return player !== null && typeof player === "object" && Number.isInteger(player.team) && player.team >= 0;
  }

  function createAnswers() {
    var state = { round: 0, q: null, status: STATUS.idle, limitMs: TIMING.limitMs, deadlineAt: null, openAt: null, closeReason: null, votes: [], result: null };
    var voteOrder = 0; // pořadí zápisu hlasů, rozhoduje při shodném rx

    function findVote(clientId) {
      for (var i = 0; i < state.votes.length; i++) {
        if (state.votes[i].clientId === clientId) return state.votes[i];
      }
      return null;
    }

    // Vždy nové kolo s vyšším číslem; hlasy, openAt i výsledek předchozího kola zmizí.
    function open(q, limitMs, now) {
      state.round += 1;
      state.q = q;
      state.status = STATUS.open;
      state.limitMs = isPositiveFinite(limitMs) ? limitMs : TIMING.limitMs;
      state.deadlineAt = Number.isFinite(now) ? now + state.limitMs : null;
      state.openAt = null;
      state.closeReason = null;
      state.votes = [];
      state.result = null;
      return state.round;
    }

    // Čas odeslání otázky z hodin pluginu; platí nejdřívější odeslání aktuálního kola.
    function setOpenAt(round, sentAt) {
      if (round !== state.round || !running() || !Number.isFinite(sentAt)) return false;
      if (state.openAt !== null && sentAt >= state.openAt) return false;
      state.openAt = sentAt;
      return true;
    }

    // Pořadí kontrol je závazné (kontrakt), určuje důvod, který hráč uvidí. Tým se u hlasu neukládá.
    function answer(clientId, round, key, rx, now, player) {
      if (!hasTeam(player)) return { ok: false, reason: "nojoin" };
      if (state.status !== STATUS.open) return { ok: false, reason: "closed" };
      if (round !== state.round) return { ok: false, reason: "late" };
      if (Number.isFinite(state.deadlineAt) && Number.isFinite(now) && now >= state.deadlineAt) return { ok: false, reason: "closed" };
      if (KEYS.indexOf(key) === -1) return { ok: false, reason: "invalid" };
      // První odpověď platí; další by si mohla „vylepšit“ čas nebo změnit volbu.
      if (findVote(clientId) !== null) return { ok: false, reason: "locked" };
      state.votes.push({ clientId: clientId, key: key, rx: Number.isFinite(rx) ? rx : Infinity, order: voteOrder++ });
      return { ok: true };
    }

    function close(reason) {
      if (state.status !== STATUS.open) return false;
      state.status = STATUS.closed;
      state.closeReason = CLOSE_REASONS.indexOf(reason) !== -1 ? reason : "reveal";
      return true;
    }

    // Číslo kola zůstává, aby pozdní odpověď na zrušené kolo nepadla do dalšího.
    function cancel() {
      state.status = STATUS.idle;
      state.votes = [];
      state.result = null;
      state.openAt = null;
    }

    function running() {
      return state.status === STATUS.open || state.status === STATUS.closed;
    }

    function allAnswered(clientIds) {
      if (!Array.isArray(clientIds) || clientIds.length === 0) return false;
      return clientIds.every(function (clientId) {
        return findVote(clientId) !== null;
      });
    }

    function count() {
      return state.votes.length;
    }

    // Kopie bez openAt a hlasů – hlasy a časy jednotlivých hráčů ven nesmí.
    function round() {
      return {
        round: state.round,
        q: state.q,
        status: state.status,
        limitMs: state.limitMs,
        deadlineAt: state.deadlineAt,
        closeReason: state.closeReason,
        count: state.votes.length
      };
    }

    return {
      open: open,
      setOpenAt: setOpenAt,
      answer: answer,
      close: close,
      cancel: cancel,
      running: running,
      allAnswered: allAnswered,
      count: count,
      round: round
    };
  }

  root.KvizAnswerCore = { KEYS: KEYS, TIMING: TIMING, points: points, createAnswers: createAnswers };
})(globalThis);
