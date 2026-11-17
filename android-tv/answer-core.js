// Čistá logika kola „každý hráč odpovídá na mobilu“ bez závislosti na DOM a bez časovačů (jde otestovat v Node:
// answer-core.test.js). Vystaví se vždy jako root.KvizAnswerCore; na jiných modulech nezávisí.
// Dvoje hodiny: rx, sentAt a openAt jsou hodiny pluginu (jen pro výpočet času odpovědi), now a deadlineAt hodiny JS
// (jen konec příjmu a zbývající čas). Nikdy se navzájem neporovnávají; mobil čas neposílá, takže ho nejde podvrhnout.
// Rozhraní: KEYS, TIMING, points(base, elapsedMs, limitMs) a createAnswers() s metodami open, setOpenAt, answer,
// close, cancel, running, allAnswered, count, tally, result, round, viewFor. Závazné znění: .claude-work/2026-11-17-odpovedi-na-mobilu/kontrakt.md
// § 4 a § 6.
(function (root) {
  "use strict";

  var KEYS = ["a", "b", "c"];
  var TIMING = { limitMs: 30000, revealDelayMs: 1500 };
  var STATUS = { idle: "idle", open: "open", closed: "closed", result: "result" };
  var CLOSE_REASONS = ["time", "all", "reveal"];
  var MS_PER_SECOND = 1000;
  var MAX_TEAMS = 4;

  function isPositiveFinite(value) {
    return Number.isFinite(value) && value > 0;
  }

  function isObject(value) {
    return value !== null && typeof value === "object";
  }

  function toText(value) {
    return value === undefined || value === null ? "" : String(value);
  }

  function toCount(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  // Tým do snímku: jen tři textová pole, nic dalšího (např. body) se nepřenáší.
  function viewTeam(team) {
    var source = isObject(team) ? team : {};
    return { name: toText(source.name), emoji: toText(source.emoji), color: toText(source.color) };
  }

  // Texty odpovědí: jen řetězce pod klíči a/b/c, cokoli jiného se nahradí prázdným textem.
  function viewAnswers(answers) {
    var source = isObject(answers) ? answers : {};
    var view = {};
    KEYS.forEach(function (key) {
      view[key] = typeof source[key] === "string" ? source[key] : "";
    });
    return view;
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
    var state = { round: 0, q: null, status: STATUS.idle, limitMs: TIMING.limitMs, deadlineAt: null, openAt: null, closeReason: null, votes: [], result: null, scored: false };
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
      state.scored = false;
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
      state.scored = false;
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

    // Hlasy započítaných hráčů (ze soupisky, s týmem) seskupené po týmech: počty a nejdřívější hlas pro každý klíč.
    function groupVotes(roster) {
      var teamOf = Object.create(null); // bez prototypu, aby se započítalo i clientId "__proto__"
      (Array.isArray(roster) ? roster : []).forEach(function (player) {
        if (hasTeam(player)) teamOf[player.clientId] = player.team;
      });
      var groups = {};
      var total = { a: 0, b: 0, c: 0 };
      state.votes.forEach(function (vote) {
        if (!Object.prototype.hasOwnProperty.call(teamOf, vote.clientId)) return;
        var team = teamOf[vote.clientId];
        var group = groups[team] || (groups[team] = { votes: { a: 0, b: 0, c: 0 }, first: {} });
        group.votes[vote.key] += 1;
        total[vote.key] += 1;
        if (!group.first[vote.key] || isEarlier(vote, group.first[vote.key])) group.first[vote.key] = vote;
      });
      return { total: total, groups: groups };
    }

    function isEarlier(a, b) {
      return a.rx < b.rx || (a.rx === b.rx && a.order < b.order);
    }

    // Odpověď týmu = nejvíc hlasů; při shodě počtu ta s nejdřívějším hlasem (rx, pak pořadí zápisu), ne podle abecedy,
    // aby tým nebyl zvýhodněn pořadím tlačítek.
    function teamAnswer(group) {
      return KEYS.filter(function (key) { return group.votes[key] > 0; }).reduce(function (best, key) {
        if (best === null) return key;
        if (group.votes[key] !== group.votes[best]) return group.votes[key] > group.votes[best] ? key : best;
        return isEarlier(group.first[key], group.first[best]) ? key : best;
      }, null);
    }

    // Vyhodnocení smí proběhnout jen jednou za kolo, jinak by se týmu body přičetly dvakrát: hlídá to stav i příznak scored.
    function tally(roster, correct, base) {
      if (!running() || state.scored) return null;
      if (KEYS.indexOf(correct) === -1) return null;
      var grouped = groupVotes(roster);
      var teams = Object.keys(grouped.groups).map(Number).sort(function (x, y) { return x - y; }).map(function (team) {
        var group = grouped.groups[team];
        var answer = teamAnswer(group);
        var fastest = group.first[answer];
        var elapsedMs = state.openAt !== null && Number.isFinite(fastest.rx) ? Math.max(fastest.rx - state.openAt, 0) : null;
        var isCorrect = answer === correct;
        return {
          team: team,
          answer: answer,
          votes: { a: group.votes.a, b: group.votes.b, c: group.votes.c },
          elapsedMs: elapsedMs,
          correct: isCorrect,
          points: isCorrect ? points(base, elapsedMs, state.limitMs) : 0
        };
      });
      state.result = { round: state.round, correct: correct, votes: grouped.total, teams: teams };
      state.status = STATUS.result;
      state.scored = true;
      return result();
    }

    // Kopie výsledku, aby volající nemohl změnit uložený stav.
    function result() {
      if (state.result === null) return null;
      return {
        round: state.result.round,
        correct: state.result.correct,
        votes: { a: state.result.votes.a, b: state.result.votes.b, c: state.result.votes.c },
        teams: state.result.teams.map(function (t) {
          return { team: t.team, answer: t.answer, votes: { a: t.votes.a, b: t.votes.b, c: t.votes.c }, elapsedMs: t.elapsedMs, correct: t.correct, points: t.points };
        })
      };
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

    // Pořadí pravidel je závazné (kontrakt § 6). Výsledek se ukáže až po odhalení otázky na TV.
    function viewPhase(input) {
      if (!input.enabled) return "off";
      if (input.view !== "quiz" || input.locked) return "lobby";
      if (state.q !== input.index) return "wait";
      if (state.status === STATUS.open) return "answer";
      if (state.status === STATUS.closed) return "closed";
      if (state.status === STATUS.result && input.revealed === true) return "result";
      return "wait";
    }

    function remainingMs(phase, now) {
      if (phase !== "answer") return 0;
      if (!Number.isFinite(state.deadlineAt) || !Number.isFinite(now)) return state.limitMs;
      return Math.max(0, Math.round(state.deadlineAt - now));
    }

    // Výsledek pro hráče: správná odpověď, celkové rozložení hlasů a jen výsledek jeho týmu (bez časů).
    function viewResult(player) {
      var team = null;
      if (hasTeam(player)) {
        state.result.teams.forEach(function (t) {
          if (t.team === player.team) team = { answer: t.answer, correct: t.correct, points: t.points };
        });
      }
      var votes = state.result.votes;
      return { correct: state.result.correct, votes: { a: votes.a, b: votes.b, c: votes.c }, team: team };
    }

    function viewAsk(clientId, input, phase, player) {
      var source = input.ask;
      if (!isObject(source) || typeof source.question !== "string") return null;
      var vote = findVote(clientId);
      return {
        round: state.round,
        question: source.question,
        answers: viewAnswers(source.answers),
        image: Boolean(source.image),
        limitMs: state.limitMs,
        remainingMs: remainingMs(phase, input.now),
        mine: vote !== null ? vote.key : null,
        answered: state.votes.length,
        expected: toCount(input.expected),
        result: phase === "result" && state.result !== null ? viewResult(player) : null
      };
    }

    // Snímek pro mobil hráče v režimu odpovědí, skládaný pole po poli; ctx ani hráč se nekopírují.
    // Správná odpověď nesmí na mobil před odhalením. Hlídají to tři pojistky:
    // (1) KvizLinkCore.questionView pustí correct jen u odhalené otázky,
    // (2) tady se correct bere jen z uloženého výsledku kola (tally) a jen ve fázi result, tj. po odhalení na TV,
    // (3) KvizLinkCore.PLAYER_STATE_KEYS propustí ze snímku jen vyjmenované klíče.
    // ctx.ask.correct se proto nikdy nekopíruje: kdyby ho vstup omylem nesl, první pojistka by tím padla.
    function viewFor(clientId, ctx, player) {
      var input = isObject(ctx) ? ctx : { enabled: false };
      var phase = viewPhase(input);
      var live = phase !== "off" && phase !== "lobby";
      var withAsk = phase === "answer" || phase === "closed" || phase === "result";

      var view = {};
      if (Number.isSafeInteger(input.rev)) view.rev = input.rev;
      view.phase = phase;
      view.mode = "answers";
      view.me = phase !== "off" && isObject(player) ? { name: toText(player.name), team: hasTeam(player) ? player.team : null } : null;
      view.teams = phase !== "off" && Array.isArray(input.teams) ? input.teams.slice(0, MAX_TEAMS).map(viewTeam) : [];
      view.quiz = live ? { index: toCount(input.index), total: toCount(input.total) } : null;
      view.ask = withAsk ? viewAsk(clientId, input, phase, player) : null;
      return view;
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
      tally: tally,
      result: result,
      round: round,
      viewFor: viewFor
    };
  }

  root.KvizAnswerCore = { KEYS: KEYS, TIMING: TIMING, points: points, createAnswers: createAnswers };
})(globalThis);
