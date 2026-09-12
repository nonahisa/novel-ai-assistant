// ブラウザ版（vscode.dev / github.dev 向けの束）を、実際に動かして確かめる。
//
//   npm run test:web
//
// `@vscode/test-web` が手元のChromiumにブラウザのVS Codeを立ち上げ、
// この拡張機能を読み込んで `dist/web-tests.js` の `run()` を呼ぶ
// （設計書5.8.13）。**`check` には入れていない**——Chromiumと、
// VS Codeのweb版の取り寄せ（初回だけ）が要るためである。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-web";

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
];

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
    // 書き換えはメモリ上だけで、この材料は変わらない
    folderPath: path.join(root, "test", "fixtures", "web-work"),
    headless: true,
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

const offending = captured.filter((line) =>
  FORBIDDEN.some((word) => line.includes(word))
);

if (failure) {
  console.error(failure instanceof Error ? failure.message : String(failure));
}
if (offending.length > 0) {
  console.error(
    `ブラウザのコンソールに、Node専用のものを掴んだ形跡があります（${offending.length}件）:`
  );
  for (const line of offending.slice(0, 20)) console.error(`  ${line}`);
}

if (failure || offending.length > 0) process.exit(1);
console.log("ブラウザ版の検査は、すべて通りました。");
