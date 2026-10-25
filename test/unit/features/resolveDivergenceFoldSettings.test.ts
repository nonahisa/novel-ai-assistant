import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { git } from "../support/gitTemplate";
import {
  root,
  write,
  deps,
  status,
  useRepository,
  人物ファイル,
  人物,
  分岐を作る,
  こちらを選ぶ,
  やめる,
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
  describeFoldFailureNotice,
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
 * このファイルは設定資料の規則と、作者が途中でやめたとき・両方とも残したとき・
 * 選ぶ画面へ進まない指定のとき。本文・追記型の記録・履歴は
 * `resolveDivergenceFoldFiles.test.ts`。
 */
describe("設定資料と本文の自動合流：設定資料と、途中でやめたとき", { timeout: 30_000 }, () => {
  useRepository();

  function 合わせる(walk?: ConflictWalker) {
    return foldDivergence(
      deps(),
      { root, label: "短編", upstream: "origin/main" },
      walk ? { walk } : {}
    );
  }

  test("作者が書いた部分が同じなら、更新時刻の新しいほうへ揃える", async () => {
    分岐を作る(
      [[人物ファイル, 人物({ summary: "もとの紹介", updatedAt: "2026-09-01T00:00:00.000Z" })]],
      [[人物ファイル, 人物({ summary: "むこうの紹介", updatedAt: "2026-09-05T00:00:00.000Z" })]],
      [[人物ファイル, 人物({ summary: "こちらの紹介", updatedAt: "2026-09-03T00:00:00.000Z" })]]
    );

    const result = await 合わせる();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.settingsAutoResolved).toHaveLength(1);
    expect(result.settingsAutoResolved[0].side).toBe("theirs");
    // 新しいほう（別環境）の紹介文が残り、記録まで済んでいる
    expect(fs.readFileSync(nodePath.join(root, 人物ファイル), "utf8")).toContain(
      "むこうの紹介"
    );
    expect(status()).not.toContain("behind");
    expect(git(root, "status", "--porcelain").trim()).toBe("");
  });

  test("両方で作者メモを変えたら、作者に選ばせる", async () => {
    // **ここを緩めると、作者が手で書いた値をAIの読みが押し流す**
    分岐を作る(
      [[人物ファイル, 人物({ summary: "もと", updatedAt: "2026-09-01T00:00:00.000Z" })]],
      [
        [
          人物ファイル,
          人物({
            summary: "もと",
            authorNotes: "むこうのメモ",
            updatedAt: "2026-09-05T00:00:00.000Z",
          }),
        ],
      ],
      [
        [
          人物ファイル,
          人物({
            summary: "もと",
            authorNotes: "こちらのメモ",
            updatedAt: "2026-09-03T00:00:00.000Z",
          }),
        ],
      ]
    );

    const result = await 合わせる(こちらを選ぶ);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 規則では決めていない。**作者が選んだものとして数える**
    expect(result.settingsAutoResolved).toHaveLength(0);
    expect(result.manuscriptConflicts).toEqual([人物ファイル]);
    expect(fs.readFileSync(nodePath.join(root, 人物ファイル), "utf8")).toContain(
      "こちらのメモ"
    );
    expect(status()).not.toContain("behind");
  });

  test("同じ資料の別々の項目が変わっただけなら、両方を合わせて訊かない（案3）", async () => {
    分岐を作る(
      [[人物ファイル, 人物({ summary: "もと", updatedAt: "2026-09-01T00:00:00.000Z" })]],
      [[人物ファイル, 人物({ summary: "むこうの紹介", updatedAt: "2026-09-05T00:00:00.000Z" })]],
      [
        [
          人物ファイル,
          人物({ summary: "もと", authorNotes: "こちらのメモ", updatedAt: "2026-09-03T00:00:00.000Z" }),
        ],
      ]
    );
    const walked: string[][] = [];

    const result = await 合わせる(async (input) => {
      walked.push(input.files);
      return { resolved: [], bulkResolved: [], aborted: true };
    });

    expect(walked).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.settingsAutoResolved.map((one) => one.side)).toEqual(["merged"]);
    const merged = JSON.parse(
      fs.readFileSync(nodePath.join(root, 人物ファイル), "utf8")
    ) as Record<string, unknown>;
    expect(merged.summary).toBe("むこうの紹介");
    expect(merged.authorNotes).toBe("こちらのメモ");
    expect(git(root, "status", "--porcelain").trim()).toBe("");
  });

  test("確認の窓で選んだ選び方を、見比べへそのまま渡す（案2）", async () => {
    分岐を作る(
      [[人物ファイル, 人物({ summary: "もと", updatedAt: "2026-09-01T00:00:00.000Z" })]],
      [[人物ファイル, 人物({ summary: "もと", authorNotes: "むこうのメモ", updatedAt: "2026-09-05T00:00:00.000Z" })]],
      [[人物ファイル, 人物({ summary: "もと", authorNotes: "こちらのメモ", updatedAt: "2026-09-03T00:00:00.000Z" })]]
    );
    const starts: unknown[] = [];

    await foldDivergence(
      deps(),
      { root, label: "短編", upstream: "origin/main" },
      {
        start: "newest",
        walk: async (input) => {
          starts.push(input.start);
          return こちらを選ぶ(input);
        },
      }
    );

    expect(starts).toEqual(["newest"]);
  });

  test("作者が途中でやめたら、全部戻す", async () => {
    分岐を作る(
      [["短編/本文/第5話.txt", "もとの本文。\n"]],
      [["短編/本文/第5話.txt", "むこうの直し。\n"]],
      [["短編/本文/第5話.txt", "こちらの直し。\n"]]
    );

    const result = await 合わせる(やめる);

    expect(result.ok).toBe(false);
    // 作業ツリーは元どおり。**半分だけ入れ替わった状態を作らない**
    expect(git(root, "status", "--porcelain").trim()).toBe("");
    expect(
      fs.readFileSync(nodePath.join(root, "短編/本文/第5話.txt"), "utf8")
    ).toBe("こちらの直し。\n");
    expect(status()).toContain("ahead");
    expect(status()).toContain("behind");
  });

  /*
    選ぶ画面を閉じたあと、続きへ戻る入口が分からない（作者、2026-10-13 夜
    「窓が消えてから再度窓を開けない」）。全部戻す作りは保ったまま、
    知らせで次の一手を1つ示す。失敗（エラー）の窓にはしない——作者がやめただけ
  */
  test("作者が途中でやめたら、やめたと分かる印を付け、知らせで続け方を1つ示す", async () => {
    分岐を作る(
      [["短編/本文/第5話.txt", "もとの本文。\n"]],
      [["短編/本文/第5話.txt", "むこうの直し。\n"]],
      [["短編/本文/第5話.txt", "こちらの直し。\n"]]
    );

    const result = await 合わせる(やめる);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stoppedByAuthor).toBe(true);
    const notice = describeFoldFailureNotice("短編", result);
    expect(notice.kind).toBe("stopped");
    expect(notice.message).toBe("そろえるのを途中でやめました。原稿は元のままです。");
    expect(notice.detail).toContain(
      "続けるには、作品一覧で作品を右クリックし、「GitHubと同期」→「両方の書き換えを合わせる」をもう一度押してください。"
    );
    expect(notice.detail).toContain("第5話.txt");
    expect(`${notice.message}${notice.detail}`).not.toContain("そろえられませんでした");
  });

  test("見比べの画面を用意できずにやめたときは、作者がやめたことにしない", async () => {
    分岐を作る(
      [["短編/本文/第5話.txt", "もとの本文。\n"]],
      [["短編/本文/第5話.txt", "むこうの直し。\n"]],
      [["短編/本文/第5話.txt", "こちらの直し。\n"]]
    );

    const result = await 合わせる(async () => ({
      resolved: [],
      bulkResolved: [],
      aborted: true,
      unavailable: true,
    }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stoppedByAuthor).toBeFalsy();
    expect(describeFoldFailureNotice("短編", result).kind).toBe("failed");
  });

  /*
    「両方とも残す」の別ファイル（作者の裁定、2026-10-11「一緒に送る」）。

    それまでは別ファイルを作るだけで記録に入れず、そろえた記録にも
    GitHubにも乗らなかった（もう1台では写しが見えない）。
    **足すのは記録の直前**——選んだ直後に足すと、途中でやめたときの
    `merge --abort` が索引ごと戻し、別ファイルが消えうる。
  */
  const 写し = "短編/本文/第5話.conflict-2026-10-11-0045.txt";
  /** 作者の代わりに「両方とも残す」を選ぶ。別ファイルを作り、索引には足さない */
  function 両方とも残す(aborted: boolean): ConflictWalker {
    return async ({ root: cwd, files }) => {
      write(cwd, 写し, "むこうの直し。\n");
      if (!aborted) {
        for (const file of files) {
          git(cwd, "checkout", "--ours", "--", file);
          git(cwd, "add", "--", file);
        }
      }
      return {
        resolved: aborted ? [] : [...files],
        bulkResolved: [],
        sideFiles: [写し],
        aborted,
      };
    };
  }

  test("両方とも残した別ファイルは、そろえた記録に入る（GitHubへ一緒に送る）", async () => {
    分岐を作る(
      [["短編/本文/第5話.txt", "もとの本文。\n"]],
      [["短編/本文/第5話.txt", "むこうの直し。\n"]],
      [["短編/本文/第5話.txt", "こちらの直し。\n"]]
    );

    const result = await 合わせる(両方とも残す(false));

    expect(result.ok).toBe(true);
    // 合流の記録は `show --name-only` では何も出さないので、こちら側の親と比べる
    expect(
      git(root, "-c", "core.quotepath=false", "diff", "--name-only", "HEAD^1", "HEAD")
    ).toContain(
      "第5話.conflict-2026-10-11-0045.txt"
    );
    // 記録しそびれた物が無い
    expect(git(root, "status", "--porcelain").trim()).toBe("");
  });

  test("途中でやめても、作った別ファイルは作業フォルダーに残る", async () => {
    分岐を作る(
      [["短編/本文/第5話.txt", "もとの本文。\n"]],
      [["短編/本文/第5話.txt", "むこうの直し。\n"]],
      [["短編/本文/第5話.txt", "こちらの直し。\n"]]
    );

    const result = await 合わせる(両方とも残す(true));

    expect(result.ok).toBe(false);
    // 原稿は元どおり、写しは消えずに残る（記録には入っていない）
    expect(
      fs.readFileSync(nodePath.join(root, "短編/本文/第5話.txt"), "utf8")
    ).toBe("こちらの直し。\n");
    expect(fs.readFileSync(nodePath.join(root, 写し), "utf8")).toBe(
      "むこうの直し。\n"
    );
    expect(git(root, "status", "--porcelain").trim()).toMatch(/^\?\?/);
  });

  test("（裏づけ）合流の途中で索引へ足した新しいファイルは、やめると消える", async () => {
    // 足す位置を記録の直前まで遅らせた理由。`merge --abort` は索引に載った
    // ものを作業ツリーごと戻すので、選んだ直後に足すと写しが消える
    分岐を作る(
      [["短編/本文/第5話.txt", "もとの本文。\n"]],
      [["短編/本文/第5話.txt", "むこうの直し。\n"]],
      [["短編/本文/第5話.txt", "こちらの直し。\n"]]
    );
    try {
      git(root, "merge", "--no-commit", "--no-ff", "origin/main");
    } catch {
      // 衝突で止まるのが正しい
    }
    write(root, 写し, "むこうの直し。\n");
    git(root, "add", "--", 写し);
    git(root, "merge", "--abort");

    expect(fs.existsSync(nodePath.join(root, 写し))).toBe(false);
  });

  test("選ぶ画面へ進まない指定なら、画面を開かずに戻し、使わなかった枝を消す", async () => {
    // 開いたときの点検が使う（設計書6.15.1。作者が何も押していない）
    分岐を作る(
      [["短編/本文/第5話.txt", "もとの本文。\n"]],
      [["短編/本文/第5話.txt", "むこうの直し。\n"]],
      [["短編/本文/第5話.txt", "こちらの直し。\n"]]
    );
    let walked = false;
    const result = await foldDivergence(
      deps(),
      { root, label: "短編", upstream: "origin/main" },
      {
        authorChoice: "stop",
        walk: async () => {
          walked = true;
          return { resolved: [], bulkResolved: [], aborted: true };
        },
      }
    );

    expect(walked).toBe(false);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.authored).toEqual(["短編/本文/第5話.txt"]);
    expect(git(root, "status", "--porcelain").trim()).toBe("");
    expect(
      fs.readFileSync(nodePath.join(root, "短編/本文/第5話.txt"), "utf8")
    ).toBe("こちらの直し。\n");
    // 先頭が動いていないので、退避の枝は要らない（開くたびに増やさない）
    expect(git(root, "branch", "--list", "backup/*").trim()).toBe("");
  });

  test("選ぶ画面へ進まない指定でも、書きかけは自動保存の記録に残り、使わなかった枝は増やさない", async () => {
    // 2026-10-25 夜の裁定で「記録 → 枝 → 合わせる」の順になった。枝は自動保存の
    // 記録と同じ位置にできるので、やめて戻した直後は先頭と同じ位置にあり、消える。
    // 書きかけは先頭の記録（合わせる前の自動保存）に入っているので失われない
    分岐を作る(
      [["短編/本文/第5話.txt", "もとの本文。\n"]],
      [["短編/本文/第5話.txt", "むこうの直し。\n"]],
      [["短編/本文/第5話.txt", "こちらの直し。\n"]]
    );
    write(root, "短編/本文/第9話.txt", "書きかけ。\n");

    const result = await foldDivergence(
      deps(),
      { root, label: "短編", upstream: "origin/main" },
      { authorChoice: "stop" }
    );

    expect(result.ok).toBe(false);
    expect(
      fs.readFileSync(nodePath.join(root, "短編/本文/第9話.txt"), "utf8")
    ).toBe("書きかけ。\n");
    expect(git(root, "status", "--porcelain").trim()).toBe("");
    expect(git(root, "log", "-1", "--format=%s")).toContain("合わせる前の自動保存");
    expect(git(root, "show", "HEAD:短編/本文/第9話.txt")).toBe("書きかけ。\n");
    expect(git(root, "branch", "--list", "backup/*").trim()).toBe("");
  });
});
