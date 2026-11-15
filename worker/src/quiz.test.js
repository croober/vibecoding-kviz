import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRequest, buildUserPrompt, buildResult, shuffleAnswers, stripImageFields, QUIZ_SCHEMA, MAX_QUESTIONS, MIN_QUESTIONS } from "./quiz.js";

const question = (correct = "b") => ({
  topic: "t", question: "q?", difficulty: "lehká", explanation: "e", correct,
  answers: { a: "první", b: "druhá", c: "třetí" },
});

test("parseRequest: bez tématu a bez náhodného tématu je chyba", () => {
  assert.ok(parseRequest({}).error);
  assert.ok(parseRequest({ topic: "   " }).error);
});

test("parseRequest: počet se ořízne na 3–100, výchozí 10, neznámá úroveň = mix", () => {
  assert.equal(parseRequest({ topic: "a", count: 1 }).count, MIN_QUESTIONS);
  assert.equal(parseRequest({ topic: "a", count: 9999 }).count, MAX_QUESTIONS);
  assert.equal(parseRequest({ topic: "a" }).count, 10);
  assert.equal(parseRequest({ topic: "a", level: "nesmysl" }).level, "mix");
  assert.equal(parseRequest({ topic: "a", level: "tezka" }).level, "tezka");
});

test("parseRequest: více témat se rozdělí a deduplikuje", () => {
  assert.deepEqual(parseRequest({ topic: "sport, vesmír;sport\nfilm" }).topics, ["sport", "vesmír", "film"]);
});

test("parseRequest: náhodné téma projde i bez tématu, avoidTopics se omezí", () => {
  const p = parseRequest({ randomTopic: true, avoidTopics: Array.from({ length: 50 }, (_, i) => `t${i}`) });
  assert.equal(p.error, undefined);
  assert.equal(p.avoidTopics.length, 30);
});

test("buildUserPrompt: obsahuje téma, počet, úroveň a upřesnění", () => {
  const p = parseRequest({ topic: "vesmír", count: 5, level: "hardcore", instructions: "pro děti" });
  const text = buildUserPrompt(p);
  assert.match(text, /Téma: vesmír/);
  assert.match(text, /Počet otázek: 5/);
  assert.match(text, /„hardcore“/);
  assert.match(text, /pro děti/);
});

test("buildUserPrompt: náhodné téma použije zadanou oblast a vyloučená témata", () => {
  const p = parseRequest({ randomTopic: true, avoidTopics: ["káva"] });
  const text = buildUserPrompt(p, "mořský život");
  assert.match(text, /„mořský život“/);
  assert.match(text, /káva/);
});

test("shuffleAnswers: správná odpověď zůstane stejným textem", () => {
  for (let i = 0; i < 50; i++) {
    const r = shuffleAnswers(question("b"));
    assert.equal(r.answers[r.correct], "druhá");
    assert.deepEqual(Object.values(r.answers).sort(), ["druhá", "první", "třetí"]);
  }
});

test("buildResult: ořízne na počet a u zadaného tématu vrátí jeho název", () => {
  const params = parseRequest({ topic: "a, b", count: 3 });
  const data = { quizTopic: "ignorováno", questions: Array.from({ length: 6 }, () => question()) };
  const r = buildResult(data, params);
  assert.equal(r.questions.length, 3);
  assert.equal(r.topic, "a, b");
  assert.equal(r.level, "mix");
});

test("buildResult: u náhodného tématu bere quizTopic z odpovědi modelu", () => {
  const params = parseRequest({ randomTopic: true, count: 3, level: "lehka" });
  const r = buildResult({ quizTopic: "Delfíni", questions: [question(), question(), question()] }, params);
  assert.equal(r.topic, "Delfíni");
});

test("parseRequest: režim obrázků je none/some/all, neznámá hodnota = none, upřesnění až 3000 znaků", () => {
  assert.equal(parseRequest({ topic: "a" }).images, "none");
  assert.equal(parseRequest({ topic: "a", images: "all" }).images, "all");
  assert.equal(parseRequest({ topic: "a", images: "hodne" }).images, "none");
  assert.equal(parseRequest({ topic: "a", instructions: "x".repeat(5000) }).instructions.length, 3000);
});

test("buildUserPrompt: bez obrázků zakáže imageWiki, s obrázky je požaduje", () => {
  assert.match(buildUserPrompt(parseRequest({ topic: "a" })), /Obrázkové otázky nepoužívej/);
  const all = buildUserPrompt(parseRequest({ topic: "a", images: "all" }));
  assert.match(all, /imageWiki napiš PŘESNÝ název/);
  assert.match(all, /všechny otázky, u kterých to jde/);
  assert.match(buildUserPrompt(parseRequest({ topic: "a", images: "some" })), /třetina až polovina/);
});

test("stripImageFields: smaže pomocná pole modelu", () => {
  const qs = [{ ...question(), imageWiki: "Eiffel Tower", questionNoImage: "q?" }];
  stripImageFields(qs);
  assert.equal("imageWiki" in qs[0], false);
  assert.equal("questionNoImage" in qs[0], false);
});

test("QUIZ_SCHEMA vyžaduje imageWiki a questionNoImage", () => {
  const req = QUIZ_SCHEMA.properties.questions.items.required;
  assert.ok(req.includes("imageWiki") && req.includes("questionNoImage"));
});
