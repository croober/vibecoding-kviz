// Čistá logika generátoru kvízů (bez závislosti na Workers API, jde otestovat v Node).
// Kopie částí ../../server.js (RANDOM_AREAS, LEVELS, QUIZ_SCHEMA, SYSTEM, míchání, sestavení promptu).
// Při změně promptu nebo schématu v server.js to tady sjednotit.

export const MIN_QUESTIONS = 3;
export const MAX_QUESTIONS = 100;
// obrázkové otázky: žádné / některé / všechny
export const IMAGE_MODES = ["none", "some", "all"];
// náhodné téma: oblast losuje server – se stále stejným promptem by model volil pořád totéž (např. kávu)
export const RANDOM_AREAS = [
  "starověké civilizace", "středověk", "novověké dějiny", "české dějiny", "objevitelé a cestovatelé", "archeologie",
  "savci", "ptáci", "hmyz a pavoukovci", "mořský život", "rostliny a houby", "pravěk a dinosauři",
  "vesmír a astronomie", "fyzika", "chemie", "matematika", "geologie a nerosty", "počasí a klima",
  "lidské tělo", "medicína", "vynálezy", "počítače a internet", "doprava a dopravní prostředky", "architektura a stavby",
  "malířství a sochařství", "klasická hudba", "populární hudba", "film", "seriály", "divadlo a opera",
  "literatura", "pohádky a pověsti", "komiksy a animované filmy", "videohry", "deskové a společenské hry",
  "mytologie", "náboženství a svátky", "tradice a zvyky", "jazyky a slova", "písmo a knihy",
  "kuchyně světa", "nápoje", "sladkosti a pečení", "móda a odívání", "řemesla",
  "olympijské hry", "netradiční sporty", "státy a vlajky", "města a metropole", "řeky, hory a ostrovy",
  "peníze a ekonomika", "rekordy a kuriozity", "kriminalistika a detektivky", "piráti a námořnictví", "rytíři a hrady",
];
export const pickArea = () => RANDOM_AREAS[Math.floor(Math.random() * RANDOM_AREAS.length)];
export const LEVELS = { lehka: "lehká", stredni: "střední", tezka: "těžká", hardcore: "hardcore", mix: "mix" };

export const QUIZ_SCHEMA = {
  type: "object",
  properties: {
    quizTopic: { type: "string" }, // název tématu kvízu (u náhodného tématu ho volí Claude)
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          topic: { type: "string" },
          question: { type: "string" },
          difficulty: { type: "string", enum: ["lehká", "střední", "těžká", "hardcore"] },
          answers: {
            type: "object",
            properties: { a: { type: "string" }, b: { type: "string" }, c: { type: "string" } },
            required: ["a", "b", "c"],
            additionalProperties: false,
          },
          correct: { type: "string", enum: ["a", "b", "c"] },
          explanation: { type: "string" },
          // obrázková otázka: název článku na anglické Wikipedii (jinak "") a verze otázky bez obrázku
          imageWiki: { type: "string" },
          questionNoImage: { type: "string" },
        },
        required: ["topic", "question", "difficulty", "answers", "correct", "explanation", "imageWiki", "questionNoImage"],
        additionalProperties: false,
      },
    },
  },
  required: ["quizTopic", "questions"],
  additionalProperties: false,
};

export const SYSTEM = `Jsi autor kvízů pro týmové hospodské a školní kvízy. Píšeš česky, spisovně a srozumitelně.
Každá otázka má přesně tři odpovědi (a, b, c), z nichž je právě jedna jednoznačně správná.
Špatné odpovědi jsou věrohodné, ale prokazatelně nesprávné. Odpovědi jsou stručné (ideálně do 8 slov).
Vysvětlení má 1–3 věty a říká, proč je správná odpověď správná (případně zajímavost navíc).
Uváděj jen fakta, kterými si jsi jistý. Otázky se neopakují a pokrývají různé stránky tématu.
Úrovně: lehká = zná většina lidí; střední = vyžaduje obecný přehled; těžká = pro znalce tématu;
hardcore = pro kvízové mazáky a experty: méně známá a detailní fakta (přesná data, čísla, jména, souvislosti),
špatné odpovědi jsou velmi blízko té správné (stejné období, obor nebo řád čísel). I tady jen ověřená fakta, žádné chytáky ani sporné otázky.`;

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function shuffleAnswers(q) {
  const keys = ["a", "b", "c"];
  const items = keys.map((k) => ({ text: q.answers[k], correct: k === q.correct }));
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  const answers = {};
  let correct = "a";
  items.forEach((it, i) => {
    answers[keys[i]] = it.text;
    if (it.correct) correct = keys[i];
  });
  return { ...q, answers, correct };
}

// vstup z těla požadavku → parametry, nebo { error } (stejná pravidla jako POST /api/generate v server.js)
export function parseRequest(body) {
  const topic = String(body?.topic || "").trim().slice(0, 300);
  const randomTopic = body?.randomTopic === true;
  const instructions = String(body?.instructions || "").trim().slice(0, 3000);
  // nedávná témata z archivu – u náhodného tématu se nemají opakovat
  const avoidTopics = (Array.isArray(body?.avoidTopics) ? body.avoidTopics : [])
    .map((t) => String(t).trim().slice(0, 80)).filter(Boolean).slice(0, 30);
  const count = Math.min(MAX_QUESTIONS, Math.max(MIN_QUESTIONS, parseInt(body?.count, 10) || 10));
  const level = LEVELS[body?.level] ? body.level : "mix";
  const images = IMAGE_MODES.includes(body?.images) ? body.images : "none";
  if (!topic && !randomTopic) return { error: "Zadej téma kvízu nebo zapni náhodné téma." };
  const topics = [...new Set(topic.split(/[,;\n]+/).map((t) => t.trim()).filter(Boolean))];
  return { topic, randomTopic, instructions, avoidTopics, count, level, images, topics };
}

// text zadání pro model; oblast pro náhodné téma losuje volající (area), ať je funkce deterministická
export function buildUserPrompt({ randomTopic, instructions, avoidTopics, count, level, images = "none", topics }, area = pickArea()) {
  const levelText =
    level === "mix"
      ? "Namíchej obtížnosti: přibližně třetina lehkých, třetina středních a třetina těžkých. Obtížnost hardcore v mixu nepoužívej."
      : `Všechny otázky mají obtížnost „${LEVELS[level]}“.`;
  const topicText = randomTopic
    ? `Téma si vyber sám v oblasti „${area}“: zvol v ní jedno konkrétnější, zajímavé téma vhodné pro týmový kvíz (klidně netradiční), ale dost široké na ${count} různých otázek.` +
      (avoidTopics.length ? ` Nevybírej žádné z těchto nedávných témat ani jejich obměny: ${avoidTopics.join("; ")}.` : "") +
      " Krátký český název tématu napiš do pole quizTopic a do pole topic u každé otázky."
    : topics.length > 1
      ? `Témata: ${topics.join(", ")}
Rozděl otázky mezi témata co nejrovnoměrněji a promíchej je. Do pole topic napiš, ke kterému tématu otázka patří (přesně jeho název ze seznamu). Do pole quizTopic napiš témata oddělená čárkou.`
      : `Téma: ${topics[0]}
Do pole topic i quizTopic napiš krátký název tématu.`;
  // upřesnění od moderátora (styl otázek, odpovědí, cílová skupina…)
  const extraText = instructions
    ? `

Upřesnění od moderátora kvízu (dodrž ho, pokud není v rozporu s formátem tří odpovědí a jedné správné; bod „Zakázáno“ je závazný pro otázky, odpovědi i vysvětlení):
${instructions}`
    : "";
  const imageText = images === "none"
    ? `

Obrázkové otázky nepoužívej: pole imageWiki a questionNoImage nech prázdná.`
    : `

Obrázkové otázky: ${images === "all" ? "všechny otázky, u kterých to jde" : "přibližně třetina až polovina otázek"} se ptá na obrázek, který tým uvidí na plátně.
U obrázkové otázky:
- do imageWiki napiš PŘESNÝ název existujícího článku na anglické Wikipedii, jehož hlavní obrázek ukazuje to, na co se ptáš (stavba, zvíře, rostlina, umělecké dílo, vlajka, známá osobnost, předmět…); vybírej články, které určitě mají výstižnou fotku nebo obrázek;
- otázka se odkazuje na obrázek („Jak se jmenuje stavba na obrázku?“, „Kdo namaloval obraz na obrázku?“) a sama v textu odpověď neprozrazuje;
- do questionNoImage napiš rovnocennou otázku bez obrázku se stejnými odpověďmi (použije se, když obrázek nepůjde zobrazit).
U ostatních otázek nech imageWiki i questionNoImage prázdné.`;
  return `${topicText}
Počet otázek: ${count}
${levelText}${extraText}${imageText}`;
}

// bez obrázkových otázek se pomocná pole modelu před odesláním klientovi smažou
export function stripImageFields(questions) {
  for (const q of questions) { delete q.imageWiki; delete q.questionNoImage; }
}

// JSON od modelu → odpověď API (oříznutí na počet, zamíchání odpovědí, u mixu i pořadí otázek)
export function buildResult(data, { randomTopic, count, level, topics }) {
  let questions = data.questions.slice(0, count).map(shuffleAnswers);
  if (level === "mix") questions = shuffle(questions); // mix: obtížnosti náhodně promíchané, ne popořadě
  const topic = randomTopic ? String(data.quizTopic || "Náhodné téma").slice(0, 120) : topics.join(", ");
  return { topic, level, questions };
}
