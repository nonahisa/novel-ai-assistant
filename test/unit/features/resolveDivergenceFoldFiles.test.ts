import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { git } from "../support/gitTemplate";
import {
  root,
  pushFromOtherMachine,
  commitHere,
  deps,
  status,
  useRepository,
  分岐を作る,
  こちらを選ぶ,
  resetScreen,
  type ConflictWalker,
} from "../support/divergenceHarness";

/**
 * 分岐を合わせる（設計書5.5.16）を、**本物のgitリポジトリで動かす**。
 *
 * この作品で繰り返した失敗は「単体テストが通っても実データで動かない」である。
 * 作り物の返事だけで確かめると、**gitの実際の振る舞い**（何が衝突と数えられ、
 * `--no-commit` のあと何がステージに載るか）を確かめたことにならない。
 *
 * vscode だけを差し替えて、gitとファイルは本物を使う。
 *
 * **1つのファイルを3つに分けてある**（2026-10-17。並列に走らせるため。
 * 前準備と代役は `support/divergenceHarness.ts` に共通で置いた）。
 */

vi.mock("vscode", async () => (await import("../support/divergenceHarness")).vscodeStub);

const {
  foldDivergence,
} = await import("../../../src/features/resolveDivergence");

beforeEach(() => {
  resetScreen();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * 同期の中で自動で合流する（設計書5.5.18）。
 *
 * 作者の指示（2026-09-10）：「設定資料ファイルは作者が書き換えた部分が
 * 変わっていなければ、時系列的に新しいほうに自動で合わせてください。
 * 本文も同じ個所の衝突がなければ、自動で合流させる」。
 *
 * **確認の画面を挟まない `foldDivergence` を直に動かす。** 作者に選ばせる
 * ところだけ差し替えて、規則の分岐が本物のgitでどう決まるかを見る。
 *
 * このファイルは本文・追記型の記録・履歴・承認待ちの提案。設定資料と、途中で
 * やめたときは `resolveDivergenceFoldSettings.test.ts`。
 */
describe("設定資料と本文の自動合流：本文・追記型の記録・履歴・承認待ち", { timeout: 30_000 }, () => {
  useRepository();

  function 合わせる(walk?: ConflictWalker) {
    return foldDivergence(
      deps(),
      { root, label: "短編", upstream: "origin/main" },
      walk ? { walk } : {}
    );
  }

  test("本文の同じ行を両方で書き換えたら、作者に選ばせる", async () => {
    分岐を作る(
      [["短編/本文/第6話.txt", "もとの一行。\n"]],
      [["短編/本文/第6話.txt", "むこうの一行。\n"]],
      [["短編/本文/第6話.txt", "こちらの一行。\n"]]
    );

    const result = await 合わせる(こちらを選ぶ);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manuscriptConflicts).toEqual(["短編/本文/第6話.txt"]);
  });

  test("本文の別の場所なら、そのまま合流する", async () => {
    // **git が合流できるものは、作者に訊かない**（作者の指示、2026-09-10）
    分岐を作る(
      [["短編/本文/第7話.txt", ["一行目", "二行目", "三行目", "四行目", "五行目"].join("\n") + "\n"]],
      [["短編/本文/第7話.txt", ["一行目（むこう）", "二行目", "三行目", "四行目", "五行目"].join("\n") + "\n"]],
      [["短編/本文/第7話.txt", ["一行目", "二行目", "三行目", "四行目", "五行目（こちら）"].join("\n") + "\n"]]
    );

    // **選ばせる関数は呼ばれてはならない**
    let 呼ばれた = false;
    const result = await 合わせる(async () => {
      呼ばれた = true;
      return { resolved: [], bulkResolved: [], aborted: true };
    });

    expect(呼ばれた).toBe(false);
    expect(result.ok).toBe(true);
    const 本文 = fs.readFileSync(
      nodePath.join(root, "短編/本文/第7話.txt"),
      "utf8"
    );
    expect(本文).toContain("一行目（むこう）");
    expect(本文).toContain("五行目（こちら）");
  });

  /**
   * 追記型（履歴・提案・ロック）は、作者に訊かずに両方の行を残す（2026-09-11）。
   *
   * 作者の手元で13作品ぶんの分岐が起き、これらが1件ずつの見比べに混ざって
   * 抜けられなくなった。**どちらを残すかを訊かれても、答えは「両方」しか無い**
   * （`core/editHistory.ts`）。
   */
  test("追記型の記録がぶつかったら、両方の行を残して確定する", async () => {
    const 履歴 = "短編/.aiwriter/history/edits.jsonl";
    const もと = '{"time":"2026-09-01T00:00:00.000Z","action":"土台"}\n';
    分岐を作る(
      [[履歴, もと]],
      [[履歴, もと + '{"time":"2026-09-05T00:00:00.000Z","action":"むこうで直した"}\n']],
      [[履歴, もと + '{"time":"2026-09-03T00:00:00.000Z","action":"こちらで直した"}\n']]
    );

    // **選ばせる関数は呼ばれてはならない**
    let 呼ばれた = false;
    const result = await 合わせる(async () => {
      呼ばれた = true;
      return { resolved: [], bulkResolved: [], aborted: true };
    });

    expect(呼ばれた).toBe(false);
    expect(result.ok).toBe(true);
    const 中身 = fs.readFileSync(nodePath.join(root, 履歴), "utf8");
    expect(中身).toContain("むこうで直した");
    expect(中身).toContain("こちらで直した");
    // 土台の1行は両側にあるが、**同じ行は1つに畳む**
    expect(中身.trim().split("\n")).toHaveLength(3);
    // 競合マーカーは持ち込まない
    expect(中身).not.toContain("<<<<<<<");
    expect(status()).not.toContain("behind");
    expect(git(root, "status", "--porcelain").trim()).toBe("");
  });

  test("追記型の片方の版が無ければ、ある側の行を残す", async () => {
    // 追加と削除がぶつかった形。**消さずに、残っている側を採る**
    const ロック = "短編/.aiwriter/locks/locks.jsonl";
    const もと = '{"file":"第1話.txt","by":"編集部"}\n';
    commitHere([[ロック, もと]], "土台");
    git(root, "push", "-q", "origin", "main");
    pushFromOtherMachine([], [ロック]);
    commitHere(
      [[ロック, もと + '{"file":"第2話.txt","by":"編集部"}\n']],
      "こちらで足した"
    );
    git(root, "fetch", "-q");

    let 呼ばれた = false;
    const result = await 合わせる(async () => {
      呼ばれた = true;
      return { resolved: [], bulkResolved: [], aborted: true };
    });

    expect(呼ばれた).toBe(false);
    expect(result.ok).toBe(true);
    const 中身 = fs.readFileSync(nodePath.join(root, ロック), "utf8");
    expect(中身).toContain("第1話.txt");
    expect(中身).toContain("第2話.txt");
    expect(status()).not.toContain("behind");
  });

  /**
   * `history/` の下の記録は、編集履歴に限らずすべて書き足すだけである
   * （MCPの利用とノックの `external.jsonl`、AIの指摘への判断 `ai-verdicts.jsonl`）。
   *
   * 作者の手元で、2台がそれぞれ `external.jsonl` へ1行ずつ足して分かれ、
   * 開くたびに「競合マーカーが残っていました」で戻され続けた（2026-09-28）。
   * **開いたときの点検と同じ指定**（選ぶ画面へ進まない・自動）で確かめる。
   */
  test.each([
    "短編/.aiwriter/history/external.jsonl",
    "短編/.aiwriter/history/ai-verdicts.jsonl",
  ])("history の記録（%s）が両方で書き足されても、両方の行を残して合わせる", async (記録) => {
    const もと = '{"at":"2026-09-01T00:00:00.000Z","tool":"土台"}\n';
    分岐を作る(
      [[記録, もと]],
      [[記録, もと + '{"at":"2026-09-05T00:00:00.000Z","tool":"むこうの機械"}\n']],
      [[記録, もと + '{"at":"2026-09-03T00:00:00.000Z","tool":"こちらの機械"}\n']]
    );

    const result = await foldDivergence(
      deps(),
      { root, label: "短編", upstream: "origin/main" },
      { authorChoice: "stop", automatic: true }
    );

    expect(result).toMatchObject({ ok: true });
    const 中身 = fs.readFileSync(nodePath.join(root, 記録), "utf8");
    expect(中身).toContain("むこうの機械");
    expect(中身).toContain("こちらの機械");
    expect(中身.trim().split("\n")).toHaveLength(3);
    expect(中身).not.toContain("<<<<<<<");
    expect(status()).not.toContain("behind");
    expect(git(root, "status", "--porcelain").trim()).toBe("");
  });

  test("競合の印ごと記録された history の記録が届いたら、印の行だけ落として両方の行を残す", async () => {
    // 以前に別の道具で合わせたとき、印が残ったまま記録されて届く形。
    // 衝突にはならないので、上の片づけを通らず検査で止まっていた
    const 記録 = "短編/.aiwriter/history/external.jsonl";
    const もと = '{"tool":"土台"}\n';
    const 印つき = [
      '{"tool":"土台"}',
      "<<<<<<< HEAD",
      '{"tool":"むこうの機械"}',
      "=======",
      '{"tool":"こちらの機械"}',
      ">>>>>>> origin/main",
      "",
    ].join("\n");
    分岐を作る([[記録, もと]], [[記録, 印つき]], [["短編/本文/第2話.txt", "こちら。\n"]]);

    const result = await foldDivergence(
      deps(),
      { root, label: "短編", upstream: "origin/main" },
      { authorChoice: "stop", automatic: true }
    );

    expect(result).toMatchObject({ ok: true });
    const 中身 = fs.readFileSync(nodePath.join(root, 記録), "utf8");
    expect(中身).toBe(
      '{"tool":"土台"}\n{"tool":"むこうの機械"}\n{"tool":"こちらの機械"}\n'
    );
    expect(git(root, "status", "--porcelain").trim()).toBe("");
  });

  test("競合の印つきで届いた本文は、これまでどおり止めて戻す（検査を緩めない）", async () => {
    const 本文 = "短編/本文/第3話.txt";
    const 印つき = ["<<<<<<< HEAD", "むこう。", "=======", "こちら。", ">>>>>>> x", ""].join("\n");
    分岐を作る([[本文, "もと。\n"]], [[本文, 印つき]], [["短編/本文/第2話.txt", "こちら。\n"]]);

    const result = await foldDivergence(
      deps(),
      { root, label: "短編", upstream: "origin/main" },
      { authorChoice: "stop", automatic: true }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("競合マーカー");
    expect(fs.readFileSync(nodePath.join(root, 本文), "utf8")).toBe("もと。\n");
    expect(status()).toContain("behind");
  });

  test("承認待ちの提案がぶつかったら、この端末の側を残す", async () => {
    // AIの提案で、まだ資料になっていない。**作り直せるので訊かない**（5.5.18）
    const 提案 = "短編/.aiwriter/pending-characters/char_001.json";
    分岐を作る(
      [[提案, '{"name":"もと"}\n']],
      [[提案, '{"name":"むこう"}\n']],
      [[提案, '{"name":"こちら"}\n']]
    );

    let 呼ばれた = false;
    const result = await 合わせる(async () => {
      呼ばれた = true;
      return { resolved: [], bulkResolved: [], aborted: true };
    });

    expect(呼ばれた).toBe(false);
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(nodePath.join(root, 提案), "utf8")).toBe(
      '{"name":"こちら"}\n'
    );
  });
});
