// Příprava webu pro Android TV: zkopíruje public/ do www-android/, nahradí CDN lokálními kopiemi,
// přidá mobilní ovládací stránku (mobile/) a knihovnu QR (vendor/qrcode.js)
// a vloží TV nadstavbu (TV skripty včetně link-core.js, tv.css, tv-config.js). Složka public/ se nemění.
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "public");
const out = join(root, "www-android");
const nm = (...p) => join(root, "node_modules", ...p);
const fail = (msg) => { console.error(`prepare: ${msg}`); process.exit(1); };

rmSync(out, { recursive: true, force: true });
cpSync(src, out, { recursive: true });
mkdirSync(join(out, "vendor", "phosphor"), { recursive: true });
mkdirSync(join(out, "vendor", "fonts"), { recursive: true });

// ikony Phosphor (regular) – styl i fonty
const phosphor = nm("@phosphor-icons", "web", "src", "regular");
for (const f of ["style.css", "Phosphor.woff2", "Phosphor.woff", "Phosphor.ttf"]) {
  cpSync(join(phosphor, f), join(out, "vendor", "phosphor", f));
}

// písma: názvy rodin stejné jako ve style.css ("Inter", "Bricolage Grotesque")
const fonts = [];
const interDir = nm("@fontsource", "inter", "files");
for (const subset of ["latin", "latin-ext"]) {
  for (const w of [400, 500, 600, 700]) {
    const f = `inter-${subset}-${w}-normal.woff2`;
    cpSync(join(interDir, f), join(out, "vendor", "fonts", f));
    fonts.push(`@font-face{font-family:"Inter";font-style:normal;font-display:swap;font-weight:${w};src:url(./${f}) format("woff2");}`);
  }
}
const bricDir = nm("@fontsource-variable", "bricolage-grotesque", "files");
for (const f of readdirSync(bricDir).filter((n) => /^bricolage-grotesque-latin(-ext)?-wght-normal\.woff2$/.test(n))) {
  cpSync(join(bricDir, f), join(out, "vendor", "fonts", f));
  fonts.push(`@font-face{font-family:"Bricolage Grotesque";font-style:normal;font-display:swap;font-weight:200 800;src:url(./${f}) format("woff2");}`);
}
if (fonts.length < 10) fail("nenalezena všechna písma v node_modules (npm install?)");
writeFileSync(join(out, "vendor", "fonts", "fonts.css"), fonts.join("\n") + "\n");

// ovládací stránka pro mobil (servíruje ji TV server) – celá složka android-tv/mobile/
const mobileSrc = join(root, "android-tv", "mobile");
if (!existsSync(mobileSrc)) fail("chybí android-tv/mobile/");
cpSync(mobileSrc, join(out, "mobile"), { recursive: true });

// knihovna pro QR kód: lokálně, televize nesmí záviset na CDN; soubor podle pole main v package.json balíčku
const qrDir = nm("qrcode-generator");
const qrPkgPath = join(qrDir, "package.json");
if (!existsSync(qrPkgPath)) fail("chybí qrcode-generator (npm install?)");
const qrMain = JSON.parse(readFileSync(qrPkgPath, "utf8")).main;
if (!qrMain || !existsSync(join(qrDir, qrMain))) fail("chybí qrcode-generator (npm install?)");
cpSync(join(qrDir, qrMain), join(out, "vendor", "qrcode.js"));

// TV nadstavba a konfigurace (tv-config.json je mimo git, viz tv-config.example.json)
// TV nadstavba: skripty se vkládají v tomto pořadí za app.js (core.js je čistá logika bez DOM)
const TV_SCRIPTS = ["core.js", "link-core.js", "game-core.js", "tv-server.js", "tv-sound.js", "tv-keys.js", "tv-remote.js", "tv-setup.js", "tv-link.js", "tv-game.js", "tv-lobby.js"];
for (const f of [...TV_SCRIPTS, "tv.css"]) cpSync(join(root, "android-tv", f), join(out, f));
const cfgPath = join(root, "android-tv", "tv-config.json");
const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {};
if (!existsSync(cfgPath)) console.warn("prepare: chybí android-tv/tv-config.json, APK poběží bez adresy serveru");
// číslo sestavení: minuty od 1. 1. 2025, vždy roste, takže Android bere nové APK jako aktualizaci; ukáže se v menu Ovládání TV
const build = Math.floor((Date.now() - Date.UTC(2025, 0, 1)) / 60000);
writeFileSync(join(root, "android", "version.properties"), `versionCode=${build}\n`);
writeFileSync(join(out, "tv-config.js"), `window.KVIZ_TV_CONFIG = ${JSON.stringify(cfg)};\nwindow.KVIZ_TV_BUILD = ${build};\n`);

// úprava index.html
let html = readFileSync(join(out, "index.html"), "utf8");
const replace = (re, to, what) => {
  if (!re.test(html)) fail(`v index.html nenalezeno: ${what}`);
  html = html.replace(re, to);
};
replace(/[ \t]*<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">\r?\n/, "", "preconnect googleapis");
replace(/[ \t]*<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin>\r?\n/, "", "preconnect gstatic");
replace(/[ \t]*<link href="https:\/\/fonts\.googleapis\.com[^>]*>\r?\n/, '  <link rel="stylesheet" href="vendor/fonts/fonts.css">\n', "Google Fonts");
replace(/<link rel="stylesheet" href="https:\/\/unpkg\.com\/@phosphor-icons[^>]*>/, '<link rel="stylesheet" href="vendor/phosphor/style.css">', "Phosphor ikony");
replace(/(<link rel="stylesheet" href="style\.css">)/, '$1\n  <link rel="stylesheet" href="tv.css">', "style.css");
// výchozí šířka rozvržení 1440 px: televize hlásí hustotu 2× (WebView by měl jen 960 px); zbytek řeší MainActivity (široký viewport), velikost jde změnit v menu Ovládání TV
replace(/<meta name="viewport"[^>]*>/, '<meta name="viewport" content="width=1440, user-scalable=no">', "meta viewport");
const tvTags = ['  <script src="vendor/qrcode.js"></script>', ...TV_SCRIPTS.map((f) => `  <script src="${f}"></script>`)].join("\n");
replace(/(<script src="app\.js"><\/script>)/, `<script src="tv-config.js"></script>\n  $1\n${tvTags}`, "app.js");
if (/https?:\/\/(?!www\.w3\.org)/.test(html.replace(/<link rel="icon"[^>]*>/, ""))) {
  console.warn("prepare: v index.html zůstal externí odkaz, zkontroluj offline provoz");
}
writeFileSync(join(out, "index.html"), html);
console.log("prepare: www-android připraveno");
