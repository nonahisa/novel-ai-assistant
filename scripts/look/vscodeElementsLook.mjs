// 見比べの写真を撮る（作者の決定 2026-11-15「vscode-elements を足す」「見た目を比べさせて」）。
//
// **VS Code の窓は出さない。** 作者がこの PC を使っているかもしれず、ほかの検査も走っているので、
// 画面を出さない（headless の）Edge で、見本の HTML を開いて撮る。VS Code の色は、VS Code の
// 既定のテーマ（Dark Modern・Light Modern）の定義から `--vscode-*` の変数に直して当てる
// （VS Code が画面へ渡すのと同じ名前。テーマの定義に無い色だけ、VS Code の既定値に近い値で補う）。
//
// 撮るもの（左が今の形、右が置き換えた形。暗い色・明るい色の両方）
//   ① 日本語を打つ欄：手書きの textarea ／ vscode-textarea
//   ② ボタンのアイコン：アイコン無し ／ codicon のアイコン有り
//   ③ 執筆統計：今の画面（HEAD の writingStatsPanelHtml.ts）／ 見やすくした画面（作業中のもの）
//
// 使い方（PowerShell）：
//   npm run build
//   node scripts/look/vscodeElementsLook.mjs <出力フォルダー>
//
// **配布物には入れない**（`.vscodeignore` が `scripts/**` を外す）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const esbuild = require(path.join(root, "node_modules", "esbuild"));
const { chromium } = require(path.join(root, "node_modules", "playwright-core"));

const outDir = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), "vsel_look"));
fs.mkdirSync(outDir, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "vsel_look_"));

/** 作り物の在りか。画面の CSP の `cspSource` に当たる */
const ORIGIN = "https://vsel-look.test";
const NONCE = "vselLookNonce";

// ── VS Code の色 ──

function findThemeDir() {
  const base = path.join(root, ".vscode-test");
  const candidates = [base, path.resolve(root, "..", "..", "..", ".vscode-test")];
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    const stack = [dir];
    while (stack.length > 0) {
      const current = stack.pop();
      const themes = path.join(current, "resources", "app", "extensions", "theme-defaults", "themes");
      if (fs.existsSync(path.join(themes, "dark_modern.json"))) return themes;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (entry.isDirectory() && current.split(path.sep).length - dir.split(path.sep).length < 3) {
          stack.push(path.join(current, entry.name));
        }
      }
    }
  }
  throw new Error("VS Code の既定のテーマの定義（.vscode-test）が見つかりません");
}

/** JSON にコメントと末尾のカンマがある（VS Code のテーマの定義の形） */
function readJsonc(file) {
  const text = fs.readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"])\/\/[^\n]*/g, "$1")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(text);
}

function themeColors(themesDir, name) {
  const json = readJsonc(path.join(themesDir, name));
  const inherited = json.include ? themeColors(themesDir, json.include.replace(/^\.\//, "")) : {};
  return { ...inherited, ...(json.colors ?? {}) };
}

/** テーマの定義に無い色（VS Code の既定値に近い値） */
const FALLBACK = {
  dark: {
    "charts.blue": "#3794ff", "charts.red": "#f14c4c", "charts.green": "#89d185",
    "charts.orange": "#d18616", "charts.yellow": "#cca700", "charts.purple": "#b180d7",
    "testing.iconPassed": "#73c991", "editorWarning.foreground": "#cca700",
    "list.hoverBackground": "#2a2d2e", "toolbar.hoverBackground": "#5a5d5e50",
    "icon.foreground": "#cccccc", "disabledForeground": "#cccccc80", "errorForeground": "#f85149",
    "panelTitle.activeBorder": "#0078d4", "sideBarTitle.foreground": "#cccccc",
    "editorWidget.background": "#202020", "textBlockQuote.background": "#2b2b2b",
  },
  light: {
    "charts.blue": "#1a85ff", "charts.red": "#e51400", "charts.green": "#388a34",
    "charts.orange": "#d18616", "charts.yellow": "#bf8803", "charts.purple": "#652d90",
    "testing.iconPassed": "#388a34", "editorWarning.foreground": "#bf8803",
    "list.hoverBackground": "#f2f2f2", "toolbar.hoverBackground": "#b8b8b850",
    "icon.foreground": "#3b3b3b", "disabledForeground": "#61616180", "errorForeground": "#f85149",
    "panelTitle.activeBorder": "#005fb8", "sideBarTitle.foreground": "#3b3b3b",
    "editorWidget.background": "#f8f8f8", "textBlockQuote.background": "#f8f8f8",
  },
};

function cssVariables(kind, themesDir) {
  const colors = { ...FALLBACK[kind], ...themeColors(themesDir, kind === "dark" ? "dark_modern.json" : "light_modern.json") };
  // 設定の欄の色は、VS Code の既定では入力欄の色を引き継ぐ（テーマの定義には書かれていない）
  for (const part of ["Background", "Border", "Foreground"]) {
    const key = `settings.textInput${part}`;
    const source = colors[`input.${part.toLowerCase()}`];
    if (!(key in colors) && source) colors[key] = source;
  }
  const vars = {};
  for (const [key, value] of Object.entries(colors)) vars[`--vscode-${key.replace(/\./g, "-")}`] = value;
  vars["--vscode-font-family"] = "\"Segoe WPC\", \"Segoe UI\", \"Yu Gothic UI\", \"Meiryo UI\", sans-serif";
  vars["--vscode-font-size"] = "13px";
  vars["--vscode-font-weight"] = "normal";
  vars["--vscode-editor-font-family"] = "Consolas, \"Courier New\", monospace";
  return vars;
}

// ── 束 ──

/** 見本の便と HTML を作る部品を束ねる。before は HEAD の画面、after は作業中の画面 */
async function loadSample(which) {
  const outfile = path.join(work, `vsel_sample_${which}.mjs`);
  const target = path.join(root, "src", "views", "writingStatsPanelHtml.ts").replace(/\\/g, "/");
  const before = which === "before"
    ? execFileSync("git", ["-C", root, "show", "HEAD:src/views/writingStatsPanelHtml.ts"], { encoding: "utf8" })
    : undefined;
  await esbuild.build({
    entryPoints: [path.join(root, "scripts", "look", "writingStatsSample.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "silent",
    alias: { path: "path-browserify" },
    external: ["vscode"],
    plugins: before
      ? [{
          name: "vsel-before",
          setup(build) {
            build.onLoad({ filter: /writingStatsPanelHtml\.ts$/ }, (args) =>
              args.path.replace(/\\/g, "/") === target
                ? { contents: before, loader: "ts", resolveDir: path.dirname(args.path) }
                : undefined
            );
          },
        }]
      : [],
  });
  return import(pathToFileURL(outfile).href);
}

/** 写真だけに使う部品（textarea・アイコン）。配る束には入れない */
async function buildLookElements() {
  const entry = path.join(work, "vsel_look_entry.js");
  const pkg = path.join(root, "node_modules", "@vscode-elements", "elements", "dist").replace(/\\/g, "/");
  fs.writeFileSync(entry, [
    `import "${pkg}/vscode-button/index.js";`,
    `import "${pkg}/vscode-textarea/index.js";`,
    `import "${pkg}/vscode-icon/index.js";`,
  ].join("\n"));
  const outfile = path.join(work, "vsel_look_elements.js");
  await esbuild.build({ entryPoints: [entry], bundle: true, format: "iife", platform: "browser", minify: true, outfile, logLevel: "silent" });
  return fs.readFileSync(outfile);
}

// ── 見本の頁 ──

/** VS Code が画面へ渡すのと同じ形で、色の変数を html の style に入れる（CSSOM なので CSP に止められない） */
function hostPrelude(vars, kind, data) {
  return `<script nonce="${NONCE}">
(() => {
  const vars = ${JSON.stringify(vars)};
  for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(k, v);
  document.documentElement.classList.add(${JSON.stringify(kind === "dark" ? "vscode-dark" : "vscode-light")});
  window.__posted = [];
  window.__violations = [];
  document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(e.violatedDirective + ' ' + e.blockedURI));
  window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState: () => {} });
  window.__statsData = ${data ? JSON.stringify(data) : "null"};
})();
</script>`;
}

function injectPrelude(html, prelude) {
  // CSP の meta の直後に入れる（CSP より前に置くと、CSP の効かない台本になってしまう）
  return html.replace(/(<meta http-equiv="Content-Security-Policy"[\s\S]*?>)/, `$1\n${prelude}`);
}

function inputPage(vars, kind, replaced) {
  // vscode-textarea は右下のつまみを data: の絵で描く。置き換えるなら img-src data: が要る
  const csp = `default-src 'none'; style-src ${ORIGIN} 'nonce-${NONCE}'; script-src 'nonce-${NONCE}'; font-src ${ORIGIN}; img-src data:;`;
  const text = "第3話の冒頭、主人公が駅で待つ場面は説明が多すぎないでしょうか。雨の音を先に書いたほうが入りやすい気がします。";
  const field = replaced
    ? `<vscode-textarea id="input" rows="3" resize="vertical" placeholder="聞きたいことを書いてください（Ctrl+Enterで送信）" value="${text}"></vscode-textarea>`
    : `<textarea id="input" placeholder="聞きたいことを書いてください（Ctrl+Enterで送信）">${text}</textarea>`;
  const buttons = replaced
    ? `<vscode-button secondary>最初から</vscode-button><vscode-button>送る</vscode-button>`
    : `<button class="action secondary">最初から</button><button class="action">送る</button>`;
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
${hostPrelude(vars, kind)}
<style nonce="${NONCE}">
body { margin: 0; padding: 16px; width: 420px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-sideBar-background, var(--vscode-editor-background)); }
.log { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 10px; line-height: 1.6; }
#composer { border-top: 1px solid var(--vscode-panel-border); padding-top: 8px; }
textarea { width: 100%; box-sizing: border-box; resize: vertical; height: 72px; padding: 6px 8px; font-family: inherit; font-size: inherit;
  color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; }
textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
vscode-textarea { width: 100%; }
.row { display: flex; gap: 6px; justify-content: flex-end; margin-top: 6px; }
button { border: none; border-radius: 2px; padding: 4px 12px; font: inherit; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
</style>
${replaced ? `<script nonce="${NONCE}" src="${ORIGIN}/look-elements.js"></script>` : ""}
</head><body>
<div class="log">相談の入力欄（見本の文）</div>
<div id="composer">${field}<div class="row">${buttons}</div></div>
</body></html>`;
}

const ICON_BUTTONS = [
  { label: "日ごと", icon: "calendar" },
  { label: "週ごと", icon: "graph" },
  { label: "月ごと", icon: "graph-line" },
  { label: "年ごと", icon: "history" },
];

function iconPage(vars, kind, withIcons, fontSrc) {
  const csp = `default-src 'none'; style-src ${ORIGIN} 'nonce-${NONCE}'; script-src 'nonce-${NONCE}'; font-src ${fontSrc};`;
  const row = ICON_BUTTONS.map((b, i) =>
    `<vscode-button${i === 0 ? "" : " secondary"}${withIcons ? ` icon="${b.icon}"` : ""}>${b.label}</vscode-button>`
  ).join("");
  const actions = withIcons
    ? `<vscode-button secondary icon="cloud-download">なろうAPIによる作品情報取得</vscode-button><vscode-button secondary icon="sparkle">AIに助言をもらう</vscode-button>`
    : `<vscode-button secondary>なろうAPIによる作品情報取得</vscode-button><vscode-button secondary>AIに助言をもらう</vscode-button>`;
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
${hostPrelude(vars, kind)}
${withIcons ? `<link rel="stylesheet" id="vscode-codicon-stylesheet" href="${ORIGIN}/codicon.css">` : ""}
<style nonce="${NONCE}">
body { margin: 0; padding: 16px; width: 480px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
.controls, .actions { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 14px; }
.actions { gap: 8px; }
h3 { font-size: 12px; font-weight: 600; color: var(--vscode-descriptionForeground); margin: 0 0 8px; }
</style>
<script nonce="${NONCE}" src="${ORIGIN}/look-elements.js"></script>
</head><body>
<h3>執筆の推移</h3><div class="controls">${row}</div>
<h3>サイトの反応</h3><div class="actions">${actions}</div>
</body></html>`;
}

// ── 撮る ──

async function main() {
  const themesDir = findThemeDir();
  const before = await loadSample("before");
  const after = await loadSample("after");
  const lookElements = await buildLookElements();
  const elementsBundle = fs.readFileSync(path.join(root, "dist", "webview-elements.js"));
  const codiconDir = path.join(root, "node_modules", "@vscode", "codicons", "dist");
  const pages = new Map();

  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ deviceScaleFactor: 2 });
  await context.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    const name = url.pathname.slice(1);
    if (pages.has(name)) return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: pages.get(name) });
    if (name === "webview-elements.js") return route.fulfill({ status: 200, contentType: "text/javascript", body: elementsBundle });
    if (name === "look-elements.js") return route.fulfill({ status: 200, contentType: "text/javascript", body: lookElements });
    if (name === "codicon.css") return route.fulfill({ status: 200, contentType: "text/css", body: fs.readFileSync(path.join(codiconDir, "codicon.css")) });
    if (name.startsWith("codicon.ttf")) return route.fulfill({ status: 200, contentType: "font/ttf", body: fs.readFileSync(path.join(codiconDir, "codicon.ttf")) });
    return route.fulfill({ status: 404, body: "" });
  });

  const report = {};

  async function shoot(name, html, width, prepare) {
    pages.set(name, html);
    const page = await context.newPage();
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(String(e)));
    // 高さは小さく始める（撮るのは中身の高さ。窓の高さで下に空きができないように）
    await page.setViewportSize({ width, height: 300 });
    await page.goto(`${ORIGIN}/${name}`);
    await page.waitForLoadState("networkidle");
    if (prepare) await prepare(page);
    await page.waitForTimeout(300);
    const violations = await page.evaluate(() => window.__violations ?? []);
    const body = await page.evaluate(() => {
      const r = document.body.getBoundingClientRect();
      return { h: Math.ceil(Math.max(document.documentElement.scrollHeight, r.height)) };
    });
    await page.setViewportSize({ width, height: Math.min(body.h, 4000) });
    const png = await page.screenshot({ fullPage: true });
    // 1枚ずつも見たいとき（見づらい所の洗い出し）は VSEL_PARTS=1 で、出力フォルダーの下へ残す
    if (process.env.VSEL_PARTS === "1") {
      fs.mkdirSync(path.join(outDir, "vsel_parts"), { recursive: true });
      fs.writeFileSync(path.join(outDir, "vsel_parts", name.replace(/\.html$/, ".png")), png);
    }
    report[name] = { errors, violations };
    await page.close();
    return png;
  }

  /** 左右に並べ、上に「今」「置き換え」と書いた1枚にする */
  async function compose(fileName, kind, rows, labels = ["今", "置き換え"]) {
    const vars = cssVariables(kind, themesDir);
    const bg = vars["--vscode-editor-background"];
    const fg = vars["--vscode-foreground"];
    const border = vars["--vscode-panel-border"] ?? "#808080";
    const cells = rows.map(([left, right, caption]) => `
      ${caption ? `<div class="cap">${caption}</div>` : ""}
      <div class="pair"><div><div class="lab">${labels[0]}</div><img src="data:image/png;base64,${left.toString("base64")}"></div>
      <div><div class="lab">${labels[1]}</div><img src="data:image/png;base64,${right.toString("base64")}"></div></div>`).join("");
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      body { margin: 0; padding: 16px; background: ${bg}; color: ${fg}; font-family: "Yu Gothic UI", "Meiryo UI", sans-serif; }
      .pair { display: flex; gap: 24px; align-items: flex-start; margin-bottom: 20px; }
      .pair > div { border: 1px solid ${border}; }
      .lab { font-size: 13px; padding: 4px 8px; border-bottom: 1px solid ${border}; }
      .cap { font-size: 14px; font-weight: 600; margin: 4px 0 8px; }
      img { display: block; zoom: 0.5; }
    </style></head><body>${cells}</body></html>`;
    // 小さな窓から始め、中身の大きさに合わせる（既定の 1280×720 だと右と下に空きが残る）
    const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 320, height: 200 } });
    await page.setContent(html);
    await page.waitForTimeout(200);
    const size = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }));
    await page.setViewportSize({ width: size.w, height: Math.min(size.h, 8000) });
    await page.screenshot({ path: path.join(outDir, fileName), fullPage: true });
    await page.close();
  }

  const statsPrepare = (tab) => async (page) => {
    await page.evaluate(() => window.postMessage({ type: "stats", data: window.__statsData }, "*"));
    await page.waitForTimeout(200);
    if (tab) await page.click(`.tab[data-page="${tab}"]`);
  };

  for (const kind of ["dark", "light"]) {
    const vars = cssVariables(kind, themesDir);
    const themeName = kind === "dark" ? "暗い色" : "明るい色";

    // ① 日本語を打つ欄
    const inputNow = await shoot(`input-now-${kind}.html`, inputPage(vars, kind, false), 452);
    const inputNew = await shoot(`input-new-${kind}.html`, inputPage(vars, kind, true), 452);
    await compose(`①日本語の欄_${themeName}.png`, kind, [[inputNow, inputNew]]);

    // ② ボタンのアイコン（codicon の字形は font-src に在りかが要る）
    const iconNone = await shoot(`icon-none-${kind}.html`, iconPage(vars, kind, false, "'none'"), 512);
    const iconWith = await shoot(`icon-with-${kind}.html`, iconPage(vars, kind, true, ORIGIN), 512);
    await compose(`②ボタンのアイコン_${themeName}.png`, kind, [[iconNone, iconWith]], ["アイコン無し", "アイコン有り"]);
    if (kind === "dark") {
      // font-src を 'none' のままにすると、字形が読めずに四角が並ぶ（試しに撮る）
      await shoot(`icon-blocked-${kind}.html`, iconPage(vars, kind, true, "'none'"), 512);
    }

    // ③ 執筆統計（概要・執筆の推移・カクヨムの反応）
    const data = after.sampleStatsData();
    const rows = [];
    for (const [tab, caption, width] of [["overview", "概要", 760], ["trend", "執筆の推移", 760], ["site-kakuyomu", "カクヨムの反応", 760], ["overview", "概要（狭い窓 380px）", 380], ["site-kakuyomu", "カクヨムの反応（狭い窓 380px）", 380]]) {
      const nowHtml = injectPrelude(before.sampleStatsHtml({ nonce: NONCE, cspSource: ORIGIN }), hostPrelude(vars, kind, data));
      const newHtml = injectPrelude(
        after.sampleStatsHtml({ nonce: NONCE, cspSource: ORIGIN, elementsScriptUri: `${ORIGIN}/webview-elements.js` }),
        hostPrelude(vars, kind, data)
      );
      const left = await shoot(`stats-now-${tab}-${width}-${kind}.html`, nowHtml, width, statsPrepare(tab === "overview" ? null : tab));
      const right = await shoot(`stats-new-${tab}-${width}-${kind}.html`, newHtml, width, statsPrepare(tab === "overview" ? null : tab));
      rows.push([left, right, caption]);
    }
    await compose(`③執筆統計_${themeName}.png`, kind, rows, ["今", "見やすくした形"]);
  }

  // ── 動きの確かめ（VS Code の画面の自動テストを流せないときの代わり。置き換えた画面で） ──
  const checks = await checkBehavior(context, pages, after, cssVariables("dark", themesDir));
  for (const [name, ok] of Object.entries(checks)) console.log(`${ok === true ? "通った" : "落ちた"}：${name}${ok === true ? "" : ` ${JSON.stringify(ok)}`}`);

  await browser.close();
  fs.writeFileSync(path.join(outDir, "vsel_report.json"), JSON.stringify({ pages: report, checks }, null, 2));
  for (const [name, { errors, violations }] of Object.entries(report)) {
    if (errors.length > 0 || violations.length > 0) console.log(name, JSON.stringify({ errors, violations }));
  }
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`撮りました：${outDir}`);
}

/**
 * 置き換えた執筆統計で、押したときの動きが今と同じかを確かめる。
 * 返す値は「確かめたこと → true か、落ちた様子」。
 */
async function checkBehavior(context, pages, after, vars) {
  const results = {};
  const open = async (name, narouApi) => {
    const data = { ...after.sampleStatsData(), narouApi };
    const html = injectPrelude(
      after.sampleStatsHtml({ nonce: NONCE, cspSource: ORIGIN, elementsScriptUri: `${ORIGIN}/webview-elements.js` }),
      hostPrelude(vars, "dark", data)
    );
    pages.set(name, html);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto(`${ORIGIN}/${name}`);
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => window.postMessage({ type: "stats", data: window.__statsData }, "*"));
    await page.waitForTimeout(200);
    return { page, errors };
  };

  const notAgreed = { status: "ready", ncode: "n0000aa", opened: true, agreed: false, agreedAt: null, intervalMinutes: 60 };
  const { page, errors } = await open("check-a.html", notAgreed);
  results["部品が登録される（vscode-button・vscode-collapsible）"] = await page.evaluate(() =>
    Boolean(customElements.get("vscode-button") && customElements.get("vscode-collapsible"))
  ) || "登録されていない";

  await page.click('.tab[data-page="trend"]');
  await page.click('[data-granularity="weekly"]');
  results["粒度を押すと切り替わる（週次）"] = await page.evaluate(() =>
    document.querySelector('[data-granularity="weekly"]').classList.contains("active") &&
    !document.querySelector('[data-granularity="weekly"]').hasAttribute("secondary")
  ) || "週次が選ばれていない";

  await page.focus('[data-granularity="monthly"]');
  await page.keyboard.press("Enter");
  results["Enter でも押せる（月次）"] = await page.evaluate(() =>
    document.querySelector('[data-granularity="monthly"]').classList.contains("active")
  ) || "Enter で切り替わらない";
  await page.focus('[data-granularity="daily"]');
  await page.keyboard.press(" ");
  results["空白でも押せる（日次）"] = await page.evaluate(() =>
    document.querySelector('[data-granularity="daily"]').classList.contains("active")
  ) || "空白で切り替わらない";

  await page.click('.tab[data-page="site-narou"]');
  const narouBefore = await page.evaluate(() => {
    const el = document.querySelector("#page-site-narou [data-narou-fetch]");
    if (!el) return "取得のボタンが無い";
    el.click();
    return { disabled: el.disabled, posted: window.__posted.filter((m) => m.type === "narouFetch").length };
  });
  results["同意の前は取得のボタンが押せず、押しても頼まない"] =
    narouBefore && narouBefore.disabled === true && narouBefore.posted === 0 ? true : narouBefore;

  await page.click('.tab[data-page="site-kakuyomu"]');
  const fold = await page.evaluate(() => {
    // 「これまでの記録」（表が入っている折りたたみ）で見る
    const box = document.querySelector('#page-site-kakuyomu vscode-collapsible.fold[heading^="これまでの記録"]');
    if (!box) return "折りたたみが無い";
    return { open: box.open, rowsWhileClosed: box.querySelectorAll("tr").length };
  });
  await page.click('#page-site-kakuyomu vscode-collapsible.fold[heading^="これまでの記録"]');
  const opened = await page.evaluate(() =>
    document.querySelector('#page-site-kakuyomu vscode-collapsible.fold[heading^="これまでの記録"]').open
  );
  results["折りたたみは閉じて始まり、押すと開く。閉じていても中の表に届く"] =
    typeof fold === "object" && fold.open === false && fold.rowsWhileClosed > 0 && opened === true ? true : { fold, opened };
  results["台本の誤り・CSP の違反が無い"] =
    errors.length === 0 && (await page.evaluate(() => window.__violations.length)) === 0 ? true : { errors };
  await page.close();

  const agreed = { ...notAgreed, agreed: true, agreedAt: "2026-11-15T00:00:00.000Z" };
  const second = await open("check-b.html", agreed);
  await second.page.click('.tab[data-page="site-narou"]');
  await second.page.click("#page-site-narou [data-narou-fetch]");
  const posted = await second.page.evaluate(() => window.__posted.filter((m) => m.type === "narouFetch").length);
  results["同意のあとは押すと1回だけ頼む"] = posted === 1 ? true : { posted };
  await second.page.close();
  return results;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
