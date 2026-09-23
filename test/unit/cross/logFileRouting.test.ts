import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 機能側で記録を書くなら、作品のログファイルへ向けてから書く
 * （49 の指摘、2026-09-08）。`useLogFile` を通さないと出力チャンネルにしか
 * 出ず、VS Code を閉じると消える——「変換中の本文を捨てた」「外部の資料を
 * 守った」「飛び先が無い」の手がかりが3つとも残っていなかった。
 *
 * ## 見張るのは「記録の関数を呼ぶファイル」であって、`logLine` の字面ではない
 *
 * 前は `logLine(` の字面だけを見ていた。**`logStep(` と `logFailure(` は
 * 素通りしていた**（実機の指摘、2026-09-11）。どちらも中身は `logLine` で、
 * 書き先の扱いは同じである。16ファイルが網を抜けており、いちばん多かったのは
 * **失敗の記録**——作者が不具合を報告するときに、いちばん要る手がかりだった。
 *
 * そこで**取り込み文（import）から関数名を拾う**ことにした。`core/logger` へ
 * 記録の口が増えたときも、その名前で呼んでいれば自動で網に入る。
 *
 * ## 作品が定まらないものは、除外リストではなく目印で許す
 *
 * 除外リストは「直したのに載ったまま」になりやすく、なぜ外してあるのかが
 * 一覧を見ても分からない。**理由をファイル自身に書かせる**——先頭に
 * `// ログの書き先：…` の1行を置く。いまあるのは2通り。
 *
 * - **作品が定まらない**：AIの環境を整える案内など、作品を選ぶ前に通るもの
 * - **呼ぶ側が向ける**：作品を受け取らない共通の口（AIの失敗の報告など）
 *
 * プロバイダ（`src/ai`）と `src/core` は、呼ぶ側の機能が先に向けているので対象外。
 */
const FEATURES = resolve(__dirname, "../../src/features");

/** `core/logger` から取り込んでいる名前 */
function loggerImports(source: string): string[] {
  const found: string[] = [];
  const pattern = /import\s*\{([^}]*)\}\s*from\s*"\.\.\/core\/logger"/g;
  for (const matched of source.matchAll(pattern)) {
    for (const entry of matched[1].split(",")) {
      // `logLine as write` のような別名も、呼ぶ名前のほうを見る
      const name = entry.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) found.push(name);
    }
  }
  return found;
}

/** 記録を書く関数（`core/logger` の口）。増えたらここへ足す */
const WRITERS = ["logLine", "logStep", "logFailure"];

describe("機能のログは作品のログファイルへ向ける", () => {
  const sources = readdirSync(FEATURES)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({
      name,
      source: readFileSync(resolve(FEATURES, name), "utf8"),
    }));

  test("記録の関数を呼ぶ features は、useLogFile か logForDocument を通す", () => {
    const offenders: string[] = [];
    for (const { name, source } of sources) {
      const imported = loggerImports(source);
      const writes = WRITERS.filter(
        (writer) => imported.includes(writer) && source.includes(`${writer}(`)
      );
      if (writes.length === 0) continue;
      if (source.includes("useLogFile(") || source.includes("logForDocument(")) {
        continue;
      }
      // 作品が定まらないものは、理由をファイルに書いて許す
      if (source.includes("// ログの書き先：")) continue;
      offenders.push(`${name}（${writes.join("・")}）`);
    }
    expect(offenders).toEqual([]);
  });

  test("目印を置いたファイルは、記録の関数を実際に呼んでいる", () => {
    // 使わなくなったのに目印だけ残る、を防ぐ
    const stale: string[] = [];
    for (const { name, source } of sources) {
      if (!source.includes("// ログの書き先：")) continue;
      const imported = loggerImports(source);
      const writes = WRITERS.filter((writer) => imported.includes(writer));
      if (writes.length === 0) stale.push(name);
    }
    expect(stale).toEqual([]);
  });

  test("目印には理由が書いてある（見出しだけで終わらせない）", () => {
    const empty: string[] = [];
    for (const { name, source } of sources) {
      for (const line of source.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("// ログの書き先：")) continue;
        if (trimmed.replace("// ログの書き先：", "").trim().length === 0) {
          empty.push(name);
        }
      }
    }
    expect(empty).toEqual([]);
  });
});
