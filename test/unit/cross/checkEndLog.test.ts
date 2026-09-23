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
 *
 * **2026-09-08、検知すべてへ広げた**（作者の指示「手で確かめている項目のうち、
 * 機械にできるものを統合テストへ移してください」）。ログの形を見るのは
 * 画面を撮らずに済む確認の代表で、実機ではログを `tail` するだけになる。
 */
describe("チャンクを回す検知は、開始と終了を対で残す", () => {
  /**
   * 推敲とプロット逸脱は、**開始しか残っていなかった**（実機確認 2026-09-06）。
   * 「いつ・何チャンクを・何件で終えたか」が後から追えず、完走したのに
   * 気づけず待ち続けたので、ここへ足した。
   *
   * 2026-09-08に足したもの：表記ゆれ（ログが1行も無かった）、伏線の2つ
   * （件数だけで n/N が無かった）、名前の候補・単話プロットの2つ（開始だけ）。
   *
   * `via` は、終了ログを共通の関数で書いている機能のための逃げ道である。
   * 見出しの言葉は呼び出し側から渡ってくるので、**呼び出しが在ることと、
   * 共通の関数がその形で書いていること**の2つを見る。
   */
  const FEATURES: Array<{ file: string; label: string; via?: string }> = [
    { file: "checkTypos.ts", label: "誤字脱字検知" },
    { file: "checkContradictions.ts", label: "矛盾検知" },
    { file: "checkProofread.ts", label: "推敲" },
    { file: "checkDeviations.ts", label: "プロット逸脱検知" },
    // AIを呼ばない検知。それでも同じ形で残す（読む側が形を覚え直さずに済む）
    { file: "checkNotation.ts", label: "表記ゆれ検知" },
    { file: "checkForeshadows.ts", label: "伏線の検知" },
    { file: "checkForeshadows.ts", label: "伏線の回収の確認" },
    { file: "nameCheck.ts", label: "名前の候補" },
    {
      file: "checkEpisodePlot.ts",
      label: "単話プロットの検査",
      via: "logEpisodePlotEnd",
    },
    {
      file: "checkEpisodePlot.ts",
      label: "単話プロットと本文の照合",
      via: "logEpisodePlotEnd",
    },
  ];

  for (const { file, label, via } of FEATURES) {
    const source = readFileSync(
      resolve(__dirname, "../../src/features", file),
      "utf8"
    );

    test(`${file} は「${label}を開始」と「${label}を終了」を両方残す`, () => {
      expect(source).toContain(`${label}を開始`);
      if (via) {
        // 終了ログは共通の関数が書く。ここでは呼んでいることを見る
        // （引数が改行で折られていることがあるので、間の空白は許す）
        expect(source).toMatch(new RegExp(`${via}\\(\\s*"${label}"`));
      } else {
        expect(source).toContain(`${label}を終了`);
      }
    });

    test(`${file} の「${label}」の終了ログは、処理した数と失敗の数を含む`, () => {
      // 「終わった」だけでは、途中で諦めたのかが読み取れない
      // 文中の説明ではなく、実際に書き出す行（テンプレート文字列）を見る
      const head = via
        ? source.indexOf("`${label}を終了")
        : source.indexOf("`" + `${label}を終了`);
      expect(head, `${label} の終了ログが見つからない`).toBeGreaterThanOrEqual(0);
      const end = source.slice(head);
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

  /**
   * 推敲も、中止と打ち切りで別々に抜ける道を持つ（`fatalFailure` で
   * 残りのチャンクを試さない）。**どちらで終えたかが読めないと、
   * 「指摘0件」が本当に0件なのか途中で諦めたのかを見分けられない。**
   */
  test("推敲の終了ログは、中止と打ち切りを書き分ける", () => {
    const source = readFileSync(
      resolve(__dirname, "../../src/features/checkProofread.ts"),
      "utf8"
    );
    const end = source.slice(source.indexOf("`推敲を終了"));
    const line = end.slice(0, end.indexOf(");"));
    expect(line).toContain("cancelled");
    expect(line).toContain("fatalFailure");
  });

  /**
   * 伏線も、待っても直らない失敗を掴んだら残りを試さずに抜ける。
   * **どこまで見たか（n/N）が無いと、0件の意味が読めない。**
   */
  test("伏線の終了ログは、中止と打ち切りを書き分ける", () => {
    const source = readFileSync(
      resolve(__dirname, "../../src/features/checkForeshadows.ts"),
      "utf8"
    );
    for (const label of ["伏線の検知", "伏線の回収の確認"]) {
      const end = source.slice(source.indexOf("`" + `${label}を終了`));
      const line = end.slice(0, end.indexOf(");"));
      expect(line, label).toContain("cancelled");
      expect(line, label).toContain("fatalFailure");
    }
  });

  /**
   * 表記ゆれは**抜ける道が7つある**（本文が無い・競合で中止・組が0・
   * Escで閉じた…）。終了ログを出口ごとに置くと必ずどれかが漏れるので、
   * 入口で1回だけ書く形にしてある。**その形を崩さない。**
   */
  test("表記ゆれは、途中で抜けても終了ログが残る", () => {
    const source = readFileSync(
      resolve(__dirname, "../../src/features/checkNotation.ts"),
      "utf8"
    );

    // 中身は別の関数（runNotationCheck）にあり、公開されている入口は
    // その戻り値を受けてから必ずログを書く
    expect(source).toContain("const result = await runNotationCheck(work, tally)");
    const end = source.slice(source.indexOf("`表記ゆれ検知を終了"));
    const line = end.slice(0, end.indexOf(");"));
    // 取りやめ（undefined）も、中止も、途中で閉じたのも書き分ける
    expect(line).toContain("取りやめ");
    expect(line).toContain("中止された");
    expect(line).toContain("途中で閉じた");
  });
});
