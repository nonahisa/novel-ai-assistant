import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  acquireRun,
  currentRunLabel,
  pendingRunCount,
} from "../../../src/core/aiSequence";
import {
  isSuiteHoldingRun,
  PROOFREADING_CHECKS,
} from "../../../src/core/proofreadingSuite";

/**
 * **まとめ実行のあいだに、あとから押した一括処理が割り込まない**
 * （設計書6.76・6.80）。
 *
 * 作者の報告（2026-09-13）：「校正をまとめて実行と、資料生成のまとめて抽出を
 * 時間差で実行したところ、途中で差し込まれたように見えます」。
 *
 * それまで、まとめ実行は**実行の札を取らず、各機能に順に取らせていた**。
 * 機能と機能のあいだで札がいったん空くので、あとから押した「まとめて抽出」が
 * そこへ入り、7工程のまとめ実行が3工程目（推敲）で止まって待った。
 * 実機の画面には「推敲しています:「設定資料の抽出」の完了を待っています…」
 * と出ていた。**作者は時間差で押したのだから、あとのものは後ろに並ぶはずである。**
 */

const SRC = resolve(__dirname, "../../../src");
const read = (path: string) => readFileSync(resolve(SRC, path), "utf8");

describe("札は、まとめ実行が丸ごと持つ", () => {
  test("**まとめ実行が札を取る**", () => {
    const source = read("features/proofreadingSuite.ts");
    expect(source).toContain('from "./aiTurn"');
    expect(source).toContain('label: "校正一括実行"');
  });

  test("**各機能へ「札はこちらが持っている」と伝える**", () => {
    const source = read("features/proofreadingSuite.ts");
    expect(source).toContain("holdsRun: true");
  });

  test("印を読み取れる", () => {
    expect(isSuiteHoldingRun({ suite: { confirmed: true, holdsRun: true } })).toBe(
      true
    );
    // まとめ実行以外から呼ばれたら、機能側が自分で取る
    expect(isSuiteHoldingRun({ suite: { confirmed: true } })).toBe(false);
    expect(isSuiteHoldingRun(undefined)).toBe(false);
    expect(isSuiteHoldingRun({})).toBe(false);
  });
});

/**
 * **これが落ちたら、まとめ実行は止まったまま進まない。**
 *
 * まとめ実行が札を持ったまま機能を呼ぶので、機能側がもう一度取ろうとすると
 * **自分の持つ札を自分で待つ**ことになる。列は空かないので、永久に進まない。
 * 型では止められない（`alreadyHeld` は省ける）ので、ここで見る。
 */
describe("まとめ実行の中の機能は、札を取り直さない", () => {
  /** その機能の実体があるファイル。コマンドIDから引く */
  const FEATURE_OF: Record<string, string | null> = {
    "novelai.checkNotation": null, // AIを使わない
    "novelai.checkTypos": "features/checkTypos.ts",
    "novelai.checkProofread": "features/checkProofread.ts",
    "novelai.checkOpening": null, // 1回きりの呼び出しで、札を取らない
    "novelai.checkDeviations": "features/checkDeviations.ts",
    "novelai.checkContradictions": "features/checkContradictions.ts",
    "novelai.checkForeshadows": "features/checkForeshadows.ts",
  };

  test("まとめ実行の7工程が、この表と噛み合っている", () => {
    // 工程が増えたらここが落ちる。落ちたら、その機能が札を取るかを
    // 確かめてから表へ足すこと
    expect(PROOFREADING_CHECKS.map((check) => check.command).sort()).toEqual(
      Object.keys(FEATURE_OF).sort()
    );
  });

  test("**札を取る機能は、すべて `alreadyHeld` を渡している**", () => {
    const missing: string[] = [];
    for (const [command, file] of Object.entries(FEATURE_OF)) {
      if (!file) continue;
      const source = read(file);
      // 札を取る書き方をしているのに、印を渡していない
      const takes = /withAiTurn(Progress)?\(/.test(source);
      if (takes && !source.includes("alreadyHeld: options.suiteHoldsRun")) {
        missing.push(command);
      }
    }
    expect(
      missing,
      "まとめ実行が札を持っているので、機能側は取らないこと（取ると止まる）"
    ).toEqual([]);
  });

  test("札を取らないと書いた機能は、本当に取っていない", () => {
    for (const [command, file] of Object.entries(FEATURE_OF)) {
      if (file) continue;
      const source = read(
        command === "novelai.checkNotation"
          ? "features/checkNotation.ts"
          : "features/checkOpening.ts"
      );
      expect(source, command).not.toContain("withAiTurn");
    }
  });

  test("コマンドの登録側が、印を機能まで届けている", () => {
    const source = read("extension.ts");
    expect(source).toContain("isSuiteHoldingRun");
    // 読み取るところと渡すところの数が合っていること。片方だけ足すと、
    // 「持っているつもりで誰も取らない」か「二重に取って止まる」になる
    const read_ = source.split("isSuiteHoldingRun(options)").length - 1;
    const passed = source.split("suiteHoldsRun").length - 1;
    expect(read_).toBeGreaterThan(0);
    // `suiteHoldsRun` は読み取り（代入）と受け渡しの両方に出るので、
    // 読み取りの数より多い
    expect(passed).toBeGreaterThan(read_);
  });
});

/**
 * **待ち行列そのものは、押した順を守る。**
 *
 * まとめ実行が札を持っているあいだ、あとから押した一括処理は後ろに並ぶ。
 */
describe("押した順に並ぶ", () => {
  test("**先に取った側が離すまで、あとの人は待つ**", async () => {
    const releaseSuite = await acquireRun("校正をまとめて実行");
    expect(currentRunLabel()).toBe("校正をまとめて実行");

    let extractStarted = false;
    const extract = acquireRun("設定資料の抽出").then((release) => {
      extractStarted = true;
      return release;
    });

    // 札が空くまで、あとの人は始まらない
    await Promise.resolve();
    expect(extractStarted).toBe(false);
    expect(pendingRunCount()).toBe(1);

    releaseSuite();
    const releaseExtract = await extract;
    expect(extractStarted).toBe(true);
    expect(currentRunLabel()).toBe("設定資料の抽出");
    releaseExtract();

    expect(currentRunLabel()).toBeUndefined();
  });

  test("待っている人の名乗りで、何を待っているかが言える", async () => {
    // 実機の画面には「「◯◯」の完了を待っています…」と出る。
    // まとめ実行が札を持つようになったので、工程名ではなく
    // 「校正をまとめて実行」と出る——待ちの理由として、そちらが正しい
    const release = await acquireRun("校正をまとめて実行");
    expect(currentRunLabel()).toBe("校正をまとめて実行");
    release();
  });
});
