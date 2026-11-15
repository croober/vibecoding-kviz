// Backend kvízu na Cloudflare Workers: POST /api/generate + statika z ../public (binding ASSETS).
// Odpovídá server.js (stejná cesta, hlavička X-Access-Token, tvar odpovědí a chyb); logika promptu je v quiz.js.
import Anthropic from "@anthropic-ai/sdk";
import { createHash, timingSafeEqual } from "node:crypto";
import { QUIZ_SCHEMA, SYSTEM, parseRequest, buildUserPrompt, buildResult, stripImageFields } from "./quiz.js";
// obrázkové otázky: modul ze serveru se používá přímo (bez kopie); proxy /api/img je tady vlastní, protože ta v images.js je pro Express
import { attachImages, IMAGE_HOSTS } from "../../images.js";

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });

// omezení počtu požadavků z jedné IP; bez nastaveného bindingu (např. testy) se nic neomezuje
const clientKey = (request) => request.headers.get("cf-connecting-ip") || "neznama-ip";
async function rateLimited(limiter, request) {
  if (!limiter) return null;
  const { success } = await limiter.limit({ key: clientKey(request) });
  if (success) return null;
  return json({ error: "Příliš mnoho pokusů. Zkus to za chvíli.", code: "rate" }, 429, { "Retry-After": "60" });
}

// porovnání hashů v konstantním čase (bez úniku délky / prefixu)
const sha = (v) => createHash("sha256").update(String(v)).digest();
const safeEqual = (a, b) => timingSafeEqual(sha(a), sha(b));

// basic auth pro celý web i API (jen když je nastaven BASIC_AUTH_USER) – jako dnes proxy v Coolify
function basicAuthFailed(request, env) {
  if (!env.BASIC_AUTH_USER) return null;
  const auth = request.headers.get("authorization") || "";
  if (auth.startsWith("Basic ")) {
    let decoded = "";
    try {
      decoded = new TextDecoder().decode(Uint8Array.from(atob(auth.slice(6).trim()), (c) => c.charCodeAt(0)));
    } catch {
      /* neplatné base64 = neplatné přihlášení */
    }
    if (safeEqual(decoded, `${env.BASIC_AUTH_USER}:${env.BASIC_AUTH_PASS || ""}`)) return null;
  }
  return new Response("Přihlášení je vyžadováno.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Kviz", charset="UTF-8"' },
  });
}

// token v hlavičce X-Access-Token (Authorization patří basic auth); bez tokenu v 401 NESMÍ být WWW-Authenticate,
// jinak by prohlížeč znovu otevřel přihlašovací okno
function tokenFailed(request, env) {
  if (!env.ACCESS_TOKEN) return json({ error: "Generování není povolené: na serveru chybí ACCESS_TOKEN." }, 503);
  const token = (request.headers.get("x-access-token") || "").trim();
  if (!token || !safeEqual(token, env.ACCESS_TOKEN)) {
    return json({ error: "Neplatný nebo chybějící přístupový token.", code: "token" }, 401);
  }
  return null;
}

async function generate(request, env) {
  const denied = tokenFailed(request, env);
  if (denied) return denied;
  // až po ověření tokenu: omezení chrání hlavně náklady na volání Claude
  const limited = await rateLimited(env.GENERATE_LIMITER, request);
  if (limited) return limited;

  const body = await request.json().catch(() => ({}));
  const params = parseRequest(body);
  if (params.error) return json({ error: params.error }, 400);

  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const model = env.CLAUDE_MODEL || "claude-sonnet-5-5";
    const stream = client.beta.messages.stream({
      model,
      max_tokens: 64000, // až 100 otázek i s vysvětlením
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: QUIZ_SCHEMA },
      },
      system: SYSTEM,
      messages: [{ role: "user", content: buildUserPrompt(params) }],
    });
    const msg = await stream.finalMessage();

    if (msg.stop_reason === "refusal") {
      return json({ error: "K tomuto tématu se otázky nepodařilo vytvořit. Zkus jiné téma." }, 422);
    }
    if (msg.stop_reason === "max_tokens") {
      return json({ error: "Odpověď byla příliš dlouhá. Zkus menší počet otázek." }, 502);
    }

    const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const data = JSON.parse(text);
    data.questions = data.questions.slice(0, params.count);
    if (params.images === "none") stripImageFields(data.questions);
    else await attachImages(client, model, data.questions);
    return json(buildResult(data, params));
  } catch (err) {
    console.error(err);
    if (err instanceof Anthropic.AuthenticationError || /authentication method/i.test(err?.message)) {
      return json({ error: "Chybí nebo je neplatný ANTHROPIC_API_KEY." }, 500);
    }
    if (err instanceof Anthropic.RateLimitError) {
      return json({ error: "Překročen limit API. Zkus to za chvíli." }, 429);
    }
    if (err instanceof Anthropic.APIError) {
      return json({ error: `Chyba při generování otázek (${err.status ?? "?"}). Zkus to znovu.` }, 502);
    }
    return json({ error: "Generování selhalo. Zkus to znovu." }, 500);
  }
}

// GET /api/img?u=<base64url> – proxy jen pro obrázky z Wikimedia (URL obrázku by prozradila odpověď); jako v images.js
async function imageProxy(request) {
  let src;
  try {
    src = new URL(Buffer.from(new URL(request.url).searchParams.get("u") || "", "base64url").toString());
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  if (src.protocol !== "https:" || !IMAGE_HOSTS.includes(src.hostname)) return new Response("Bad Request", { status: 400 });
  try {
    const up = await fetch(src, { headers: { "User-Agent": "kviz-app/1.0 (quiz generator)" }, signal: AbortSignal.timeout(15_000) });
    const type = up.headers.get("content-type") || "";
    if (!up.ok || !type.startsWith("image/")) return new Response("Bad Gateway", { status: 502 });
    return new Response(up.body, { headers: { "Content-Type": type, "Cache-Control": "public, max-age=604800, immutable" } });
  } catch {
    return new Response("Bad Gateway", { status: 502 });
  }
}

export default {
  async fetch(request, env) {
    // před kontrolou hesla: hádání hesla (i správný pokus) se počítá do limitu z jedné IP
    const limited = await rateLimited(env.AUTH_LIMITER, request);
    if (limited) return limited;
    const denied = basicAuthFailed(request, env);
    if (denied) return denied;

    const { pathname } = new URL(request.url);
    if (pathname === "/api/generate") {
      if (request.method !== "POST") return json({ error: "Použij POST." }, 405, { Allow: "POST" });
      return generate(request, env);
    }
    if (pathname === "/api/img") {
      if (request.method !== "GET") return json({ error: "Použij GET." }, 405, { Allow: "GET" });
      return imageProxy(request);
    }
    return env.ASSETS.fetch(request);
  },
};
