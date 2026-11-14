import { describe, expect, test } from "vitest";
import {
  isPushRejected,
  noReasonText,
  pickGitFailureReason,
} from "../../../src/core/gitFailureReason";
import { afterCommit } from "../../../src/core/syncAllPlan";

/**
 * git の失敗の文から、画面に出す理由の行を選ぶ（設計書5.5.21）。
 *
 * 2026-11-14 の作者の実機：「確認用コピー：記録できませんでした」の下に
 * LF→CRLF の warning が理由として並び、本当の失敗が読めなかった。
 */

const crlfWarning =
  "warning: in the working copy of '作品/本文/001.txt', LF will be replaced by CRLF the next time Git touches it";

describe("理由の行の選び方", () => {
  test("warning が先に出ても、エラーの行を理由にする", () => {
    const stderr = [
      crlfWarning,
      crlfWarning.replace("001", "002"),
      "remote: error: GH001: Large files detected. You may want to try Git Large File Storage - https://git-lfs.github.com.",
      "remote: error: File 素材/big.zip is 722.00 MB; this exceeds GitHub's file size limit of 100.00 MB",
      "To https://github.com/example/library.git",
      " ! [remote rejected] main -> main (pre-receive hook declined)",
      "error: failed to push some refs to 'https://github.com/example/library.git'",
    ].join("\n");
    const reason = pickGitFailureReason(stderr) ?? "";
    expect(reason).not.toContain("LF will be replaced");
    expect(reason).toContain("GH001");
    expect(reason).toContain("File 素材/big.zip is 722.00 MB");
    expect(reason).toContain("! [remote rejected] main -> main");
    // 言い換えない（断りの文はそのまま）
    expect(reason).toContain("this exceeds GitHub's file size limit of 100.00 MB");
  });

  test("hint の行も理由から外す", () => {
    const reason = pickGitFailureReason(
      "hint: Updates were rejected because the remote contains work\nfatal: something broke"
    );
    expect(reason).toBe("fatal: something broke");
  });

  test("warning と hint しか無ければ理由は無い（空の理由を出さない）", () => {
    expect(pickGitFailureReason(`${crlfWarning}\nhint: x`)).toBeUndefined();
    expect(pickGitFailureReason("")).toBeUndefined();
  });

  test("エラーの印が無い行だけなら、その行を出す", () => {
    expect(pickGitFailureReason(`${crlfWarning}\nIndex creation failed`)).toBe(
      "Index creation failed"
    );
  });
});

describe("断られたかの見分け", () => {
  test("送り先の決まりで拒まれた行（remote rejected）があれば断られた", () => {
    expect(isPushRejected(" ! [remote rejected] main -> main (pre-receive hook declined)")).toBe(true);
  });

  test("別の機械が先に送っていただけ（rejected・fetch first）は、断られたとは言わない", () => {
    expect(isPushRejected(" ! [rejected]        main -> main (fetch first)")).toBe(false);
  });

  test("回線が無いだけなら断られたとは言わない", () => {
    expect(
      isPushRejected(
        "fatal: unable to access 'https://github.com/': Could not resolve host: github.com"
      )
    ).toBe(false);
  });
});

describe("記録の失敗の文", () => {
  test("warning しか無いときは、終了コードとログの在りかを言う（warning を並べない）", () => {
    const next = afterCommit({ ok: false, detail: `${crlfWarning}\n${crlfWarning}`, code: -1 });
    expect(next.stop).toBe(true);
    const error = next.stop ? next.error : "";
    expect(error).not.toContain("LF will be replaced");
    expect(error).toContain(noReasonText(-1));
  });

  test("エラーの行があれば、それを理由にする", () => {
    const next = afterCommit({
      ok: false,
      detail: `${crlfWarning}\nerror: open("a.txt"): Permission denied\nfatal: adding files failed`,
      code: 128,
    });
    const error = next.stop ? next.error : "";
    expect(error).toContain("fatal: adding files failed");
    expect(error).not.toContain("LF will be replaced");
  });
});
