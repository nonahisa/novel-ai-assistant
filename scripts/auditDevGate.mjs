/**
 * 開発用の道具も含めた `npm audit` の門（「高い」以上で止める）。`npm run audit` の後半。
 *
 * 前半の `npm audit --omit=dev --audit-level=moderate`（配布物に入る部品）は今までどおりで、
 * ここは触らない。ここで足したのは、**直した版がまだ出ていない知らせを、期限つきで1件ずつ通す**ことだけ。
 *
 * - 数えるのは**根の知らせ**（`via` に知らせの中身が書いてある項目）だけ。連れの項目（`via` が名前だけ）は、
 *   根を通せば一緒に通る。severity だけで数えると、根が1件でも依存しているもの全部が落ちる
 * - 通してよい知らせ（`ALLOWED`）以外の「高い」以上が1件でもあれば落とす
 * - 期限を過ぎた許しは無効にする（直しが出たら上げて、許しを消す。黙って許し続けない）
 *
 * 2026-11-18：picomatch の GHSA-fc5q-39xc-vjpf（ReDoS。範囲 <=4.0.7、最新が 4.0.7 で直した版が無い）。
 * vitest・vite・@vscode/test-web・@vscode/vsce が使う開発用の道具で、配布物（VSIX）には入らない。
 * npm の勧める `--force` は vitest を 3.1.4 へ下げる案で、取らない。
 * 作者の決定（2026-11-18「期限つきでこの1件だけ通す」）。**picomatch の直した版が出たら、期限の前でも
 * 上げて、この許しを消す**（設計書のリリースゲートの節）。
 */
import { execSync } from "node:child_process";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

/** 通してよい知らせ。理由と期限を必ず書く */
export const ALLOWED = [
  {
    id: "GHSA-fc5q-39xc-vjpf",
    packageName: "picomatch",
    reason: "開発用の道具（vitest・vite・test-web・vsce）だけが使う。直した版がまだ無い（4.0.7 が最新）",
    until: "2026-12-18",
  },
];

const BLOCKING = new Set(["high", "critical"]);

/**
 * `npm audit --json` の中身から、止める知らせを返す。空なら通る。
 * @param {{ vulnerabilities?: Record<string, { via?: Array<string | { url?: string; severity?: string; title?: string }> }> }} report
 * @param {Date} now
 * @param {typeof ALLOWED} allowed
 * @returns {string[]}
 */
export function blockingAdvisories(report, now, allowed = ALLOWED) {
  const today = now.toISOString().slice(0, 10);
  const live = new Set(allowed.filter((entry) => today <= entry.until).map((entry) => `${entry.packageName}|${entry.id}`));
  const blocking = [];
  for (const [name, vulnerability] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      if (typeof via === "string") continue;
      if (!BLOCKING.has(via.severity ?? "")) continue;
      const id = (via.url ?? "").split("/").pop() ?? "";
      if (live.has(`${name}|${id}`)) continue;
      blocking.push(`${name}: ${id || via.title || "(名前の無い知らせ)"}（${via.severity}）`);
    }
  }
  return blocking;
}

function main() {
  let raw;
  try {
    raw = execSync("npm audit --json", { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    // 知らせがあると npm audit は 0 以外で終わる。中身は標準出力にある
    raw = /** @type {{ stdout?: string }} */ (error).stdout ?? "";
  }
  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    console.error("npm audit の結果を読めませんでした。");
    console.error(raw.slice(0, 2000));
    process.exit(1);
  }
  const blocking = blockingAdvisories(report, new Date());
  const today = new Date().toISOString().slice(0, 10);
  for (const entry of ALLOWED) {
    const state = today <= entry.until ? `${entry.until} まで通す` : "期限切れ（通さない）";
    console.log(`許している知らせ：${entry.packageName} ${entry.id}（${state}）— ${entry.reason}`);
  }
  if (blocking.length > 0) {
    console.error(`開発用の道具も含めて「高い」以上の知らせが ${blocking.length} 件あります：`);
    for (const line of blocking) console.error(`- ${line}`);
    process.exit(1);
  }
  console.log("開発用の道具も含めて、「高い」以上の知らせはありません（許している知らせを除く）。");
}

const isDirectRun = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (isDirectRun) main();
