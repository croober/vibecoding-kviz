// Kontrola rozjetí: worker/src/quiz.js a index.js jsou kopií logiky ze ../../server.js.
// Test vytáhne konstanty a sestavení promptu ze server.js a porovná je s Workerem. Když selže,
// buď se server.js změnil (sjednoť Worker), nebo se změnil formát souboru (uprav tenhle test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SYSTEM, QUIZ_SCHEMA, RANDOM_AREAS, LEVELS, MIN_QUESTIONS, MAX_QUESTIONS, IMAGE_MODES,
  parseRequest, buildUserPrompt,
} from "./quiz.js";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const serverSrc = read("../../server.js");
const workerSrc = read("./index.js") + "\n" + read("./quiz.js");

const evalLiteral = (code) => new Function(`"use strict"; return (${code});`)();
const must = (src, re, what) => {
  const m = src.match(re);
  if (!m) throw new Error(`server.js: nenalezeno ${what} (změnil se formát souboru?)`);
  return m[1];
};

// objekt/pole od "const NAME = " po odpovídající závorku (bez řetězců se závorkami)
function literalAfter(src, name) {
  const start = src.indexOf(`const ${name} = `);
  if (start < 0) throw new Error(`server.js: nenalezeno ${name} (změnil se formát souboru?)`);
  const open = src.slice(start).search(/[{[]/) + start;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if ("{[".includes(src[i])) depth++;
    if ("}]".includes(src[i]) && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`server.js: neukončené ${name}`);
}

// text zadání pro model, jak ho sestaví server.js (kód od parsování těla po `try {` spuštěný nad vstupem)
function serverPrompt(src, body, consts) {
  const from = src.indexOf("const topic = String(req.body?.topic");
  const to = src.indexOf("  try {", from);
  if (from < 0 || to < 0) throw new Error("server.js: nenalezeno sestavení promptu (změnil se formát souboru?)");
  const content = must(src, /content: (`[^`]*`)/, "content zprávy pro model");
  const names = Object.keys(consts);
  const fn = new Function("req", "res", ...names, `${src.slice(from, to)}; return ${content};`);
  const res = { status: () => ({ json: (j) => ({ error: j.error }) }) };
  return fn({ body }, res, ...names.map((n) => consts[n]));
}

function diffs(src) {
  const out = [];
  const same = (what, a, b) => { try { assert.deepEqual(a, b); } catch { out.push(what); } };

  same("SYSTEM", evalLiteral(must(src, /const SYSTEM = (`[\s\S]*?`);/, "SYSTEM")), SYSTEM);
  same("RANDOM_AREAS", evalLiteral(literalAfter(src, "RANDOM_AREAS")), RANDOM_AREAS);
  same("LEVELS", evalLiteral(literalAfter(src, "LEVELS")), LEVELS);
  same("QUIZ_SCHEMA", evalLiteral(literalAfter(src, "QUIZ_SCHEMA")), QUIZ_SCHEMA);
  same("IMAGE_MODES", evalLiteral(literalAfter(src, "IMAGE_MODES")), IMAGE_MODES);
  same("MIN_QUESTIONS", Number(must(src, /const MIN_QUESTIONS = (\d+);/, "MIN_QUESTIONS")), MIN_QUESTIONS);
  same("MAX_QUESTIONS", Number(must(src, /const MAX_QUESTIONS = (\d+);/, "MAX_QUESTIONS")), MAX_QUESTIONS);

  // limity délek vstupu
  const big = "x".repeat(10_000);
  const p = parseRequest({ topic: big, instructions: big, avoidTopics: Array(100).fill(big) });
  same("limit tématu", Number(must(src, /const topic = String\(req\.body\?\.topic[^\n]*slice\(0, (\d+)\)/, "limit tématu")), p.topic.length);
  same("limit upřesnění", Number(must(src, /const instructions = String\(req\.body\?\.instructions[^\n]*slice\(0, (\d+)\)/, "limit upřesnění")), p.instructions.length);
  same("počet nedávných témat", Number(must(src, /\.filter\(Boolean\)\.slice\(0, (\d+)\);/, "počet nedávných témat")), p.avoidTopics.length);

  // sestavení promptu pro různé vstupy (oblast náhodného tématu se dosadí pevná)
  const consts = {
    LEVELS: evalLiteral(literalAfter(src, "LEVELS")),
    MIN_QUESTIONS: Number(must(src, /const MIN_QUESTIONS = (\d+);/, "MIN_QUESTIONS")),
    MAX_QUESTIONS: Number(must(src, /const MAX_QUESTIONS = (\d+);/, "MAX_QUESTIONS")),
    IMAGE_MODES: evalLiteral(literalAfter(src, "IMAGE_MODES")),
    pickArea: () => "TESTOVACÍ OBLAST",
  };
  const bodies = [
    { topic: "vesmír" },
    { topic: "sport, film\nhudba", count: 5, level: "hardcore", instructions: "pro děti\nbez politiky", images: "all" },
    { randomTopic: true, avoidTopics: ["káva", "čaj"], images: "some", level: "tezka", count: 12 },
    { randomTopic: true },
    { topic: "x", level: "mix", images: "none", instructions: "  jen krátké odpovědi  " },
  ];
  for (const body of bodies) {
    const fromServer = serverPrompt(src, body, consts);
    const fromWorker = buildUserPrompt(parseRequest(body), "TESTOVACÍ OBLAST");
    same(`prompt pro ${JSON.stringify(body)}`, fromServer, fromWorker);
  }

  // parametry volání Claude a hlášky, které klient zobrazuje
  for (const snippet of ["max_tokens: 64000", 'betas: ["server-side-fallback-2026-07-01"]', 'fallbacks: "default"', 'effort: "medium"']) {
    if (!src.includes(snippet)) out.push(`server.js už neobsahuje: ${snippet}`);
    else if (!workerSrc.includes(snippet)) out.push(`Worker neobsahuje: ${snippet}`);
  }
  for (const msg of src.matchAll(/error: "([^"]+)"/g)) {
    if (!workerSrc.includes(msg[1])) out.push(`Worker nemá hlášku ze server.js: ${msg[1]}`);
  }
  return out;
}

test("Worker je v souladu se server.js (prompt, schéma, limity, hlášky)", () => {
  assert.deepEqual(diffs(serverSrc), [], "Worker se rozešel se server.js, sjednoť worker/src/quiz.js a index.js");
});

test("detektor rozjetí skutečně zachytí změnu v server.js", () => {
  const mutated = serverSrc.replace("Jsi autor kvízů", "Jsi někdo jiný");
  assert.notEqual(mutated, serverSrc);
  assert.ok(diffs(mutated).includes("SYSTEM"));
  const mutatedPrompt = serverSrc.replace("Počet otázek:", "Kolik otázek:");
  assert.ok(diffs(mutatedPrompt).some((d) => d.startsWith("prompt")));
  const mutatedMsg = serverSrc.replace("Překročen limit API.", "Moc požadavků.");
  assert.ok(diffs(mutatedMsg).some((d) => d.startsWith("Worker nemá hlášku")));
});
