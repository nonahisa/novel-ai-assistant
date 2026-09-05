import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 操作ログ（`.aiwriter/logs/actions.log`）は、始めたら必ず終わりを残す。
 *
 * **実機で欠けていた**（2026-09-05）。誤字脱字検知には
 * 「誤字脱字検知を終了: 1/1（失敗 0件）」が出るのに、矛盾検知は
 * 「矛盾検知を開始: …」のあと検証の取り下げ行で途切れており、
 * ログだけを見ると**終わったのか途中で落ちたのか分からなかった**。
 *
 * 開始と終了を対にする決まりを、ここで機械に見張らせる。
 */
describe("チャンクを回す検知は、開始と終了を対で残す", () => {
  const FEATURES: Array<{ file: string; label: string }> = [
    { file: "checkTypos.ts", label: "誤字脱字検知" },
    { file: "checkContradictions.ts", label: "矛盾検知" },
  ];

  for (const { file, label } of FEATURES) {
    const source = readFileSync(
      resolve(__dirname, "../../src/features", file),
      "utf8"
    );

    test(`${file} は「${label}を開始」と「${label}を終了」を両方残す`, () => {
      expect(source).toContain(`${label}を開始`);
      expect(source).toContain(`${label}を終了`);
    });

    test(`${file} の終了ログは、処理した数と失敗の数を含む`, () => {
      // 「終わった」だけでは、途中で諦めたのかが読み取れない
      // 文中の説明ではなく、実際に書き出す行（テンプレート文字列）を見る
      const end = source.slice(source.indexOf("`" + `${label}を終了`));
      const line = end.slice(0, end.indexOf(");"));
      expect(line).toContain("失敗");
      expect(line).toContain("/");
    });
  }

  /**
   * 中止・打ち切りでも終了行が出ること。**関数の外へ抜ける道が
   * 終了ログより前にあると、そこだけ黙って終わる。**
   */
  test("矛盾検知の終了ログは、中止と打ち切りを書き分ける", () => {
    const source = readFileSync(
      resolve(__dirname, "../../src/features/checkContradictions.ts"),
      "utf8"
    );
    const end = source.slice(source.indexOf("`矛盾検知を終了"));
    const line = end.slice(0, end.indexOf(");"));
    expect(line).toContain("cancelled");
    expect(line).toContain("fatalFailure");
  });
});
