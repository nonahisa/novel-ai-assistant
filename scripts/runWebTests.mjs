// ブラウザ版（vscode.dev / github.dev 向けの束）を、実際に動かして確かめる。
//
//   npm run test:web
//
// `@vscode/test-web` が手元のChromiumにブラウザのVS Codeを立ち上げ、
// この拡張機能を読み込んで `dist/web-tests.js` の `run()` を呼ぶ
// （設計書5.8.13）。**`check` には入れていない**——Chromiumと、
// VS Codeのweb版の取り寄せ（初回だけ）が要るためである。
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-web";
import { startWebviewProbe } from "./webviewProbe.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * **`ELECTRON_RUN_AS_NODE` を外す。** VS Codeの統合ターミナルから走らせると
 * 親から引き継ぎ、Playwrightが起動するChromiumが即終了する
 * （`scripts/runIntegrationTests.mjs` と同じ理由。実際に踏んでいる）。
 * 他の `VSCODE_*` も、親のウィンドウへ繋ぎに行かせないために落とす。
 */
for (const name of Object.keys(process.env)) {
  if (name === "ELECTRON_RUN_AS_NODE" || name.startsWith("VSCODE_")) {
    delete process.env[name];
  }
}

/**
 * ブラウザの中のコンソールに出てはいけない言葉。
 *
 * **ビルドが通っただけでは「動く」ではない**（CLAUDE.md の繰り返し起きた失敗6）。
 * Node専用のものが束に残っていると、ブラウザでは読み込んだ瞬間に
 * この形で落ちる。検査が1件も失敗しなくても、ここで止める。
 *
 * ブラウザのVS Codeのコンソールは `codeAutomationLog` を通して
 * こちら（Node）の `console` へ流れてくるので、包んで見張れる。
 */
const FORBIDDEN = [
  "require is not defined",
  "process is not defined",
  "module is not defined",
  "__dirname is not defined",
  "Buffer is not defined",
  // パネル（WebView）が開けなかった形跡。**中身そのものは覗く口
  // （`webviewProbe.mjs`）で確かめる**——ここは、VS Code が記録へ流した分の念押し
  "Could not register service worker",
  "Error loading webview",
];

/** 作り物の作品。**検査の前後で1バイトも変わっていないこと**を確かめる */
const fixtureFolder = path.join(root, "test", "fixtures", "web-work");

/**
 * 作り物の作品の、ファイルごとの指紋。
 *
 * `@vscode/test-web` の仮想ファイルシステムは、書き込みをブラウザのメモリに
 * 置くだけで、手元のファイルへは返さない（0.0.81 で確かめた——サーバーには
 * 読み取りの口しか無く、`fs-provider` の `writeFile` はメモリの表を書き換える
 * だけ）。検査は本文を書き換えるので、**その前提が版上げで崩れても
 * 気づけるように**、前後で突き合わせる。
 */
function fingerprintFixture() {
  const result = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const digest = createHash("sha256").update(fs.readFileSync(full)).digest("hex");
        result.set(path.relative(fixtureFolder, full), digest);
      }
    }
  };
  walk(fixtureFolder);
  return result;
}

function fixtureDifferences(before, after) {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((name) => before.get(name) !== after.get(name)).sort();
}

const fixtureBefore = fingerprintFixture();

/**
 * パネルの中身を覗く口（`webviewProbe.mjs`）。見えない Chromium を
 * DevTools の口つきで起こし、検査からは `fetch` で尋ねる。
 *
 * 口の番号は `scripts/buildWebTests.mjs` が検査の束へ埋める値と揃える。
 * **`VSCODE_` で始まる名前にしない**——上で `VSCODE_*` を全部落としている
 */
const cdpPort = Number(process.env.NOVELAI_WEB_CDP_PORT ?? 9339);
const probePort = Number(process.env.NOVELAI_WEB_PROBE_PORT ?? 3112);
const probe = startWebviewProbe({ cdpPort, listenPort: probePort });

const captured = [];
const original = {};
for (const level of ["log", "info", "warn", "error", "debug"]) {
  original[level] = console[level].bind(console);
  console[level] = (...args) => {
    captured.push(args.map((a) => String(a)).join(" "));
    original[level](...args);
  };
}

function restoreConsole() {
  for (const [level, fn] of Object.entries(original)) console[level] = fn;
}

let failure;
try {
  await runTests({
    browserType: "chromium",
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, "dist", "web-tests.js"),
    // **作者の原稿は使わない。** 2〜3話だけの作り物を、ブラウザの
    // 仮想ファイルシステム（`vscode-test-web://mount`）として見せる。
    // 書き換えはメモリ上だけで、この材料は変わらない（前後の指紋で確かめる）
    folderPath: fixtureFolder,
    headless: true,
    browserOptions: [`--remote-debugging-port=${cdpPort}`],
    // 既定は insiders（毎日変わる）。**安定版に寄せる**——
    // 何で緑になったのかが分からない検査は、後から追えない
    quality: process.env.VSCODE_WEB_QUALITY ?? "stable",
    // 3000番は開発用サーバーとぶつかりやすい
    port: Number(process.env.VSCODE_WEB_PORT ?? 3111),
  });
} catch (error) {
  failure = error;
}

restoreConsole();
await probe.close();

const fixtureChanged = fixtureDifferences(fixtureBefore, fingerprintFixture());

const offending = captured.filter((line) =>
  FORBIDDEN.some((word) => line.includes(word))
);

if (failure) {
  console.error(failure instanceof Error ? failure.message : String(failure));
}
if (offending.length > 0) {
  console.error(
    `ブラウザのコンソールに、Node専用のものを掴んだ形跡か、パネルを開けなかった形跡があります（${offending.length}件）:`
  );
  for (const line of offending.slice(0, 20)) console.error(`  ${line}`);
}

if (fixtureChanged.length > 0) {
  console.error(
    `作り物の作品（test/fixtures/web-work）が書き換わりました: ${fixtureChanged.join(", ")}`
  );
}

if (failure || offending.length > 0 || fixtureChanged.length > 0) process.exit(1);
console.log("ブラウザ版の検査は、すべて通りました。");
