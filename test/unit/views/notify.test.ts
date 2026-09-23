import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  DONE_MESSAGE_TIMEOUT_MS,
  confirmRun,
  errorWithLog,
  notifyDone,
  pickWithMemory,
  warnWithLog,
  whenNoticePicked,
  withWorkTitle,
} from "../../../src/views/notify";
import {
  lastQuickPick,
  resetLastQuickPick,
  statusBarMessages,
  window,
  workspace,
} from "../support/vscodeStub";
import * as logger from "../../../src/core/logger";
import { answerConfirms } from "../support/confirmPicker";

/**
 * 知らせの行き先（作者の裁定 2026-09-06、`src/views/notify.ts`）。
 *
 * **確認はモーダル、その場限りの完了はステータスバー。**
 * 通知センターに読み捨ての報告が積み上がると、返事を待っている
 * 確認カードが下へ押し出されて見えなくなる。
 */
describe("その場限りの完了", () => {
  beforeEach(() => {
    statusBarMessages.length = 0;
  });

  test("ステータスバーへ出す。印を頭に付け、数秒で消す", () => {
    notifyDone("Ollamaを起動しました。");
    expect(statusBarMessages).toEqual([
      { text: "$(check) Ollamaを起動しました。", timeout: DONE_MESSAGE_TIMEOUT_MS },
    ]);
  });

  test("同じ文言を操作ログにも残す（ステータスバーは消えるため）", () => {
    const logStep = vi.spyOn(logger, "logStep").mockImplementation(() => {});
    try {
      notifyDone("索引を削除しました。");
      expect(logStep).toHaveBeenCalledWith("索引を削除しました。");
    } finally {
      logStep.mockRestore();
    }
  });

  test("通知センターへは出さない", async () => {
    const shown = vi.fn(async () => undefined);
    const original = window.showInformationMessage;
    window.showInformationMessage = shown;
    try {
      notifyDone("切り替えました。");
      expect(shown).not.toHaveBeenCalled();
    } finally {
      window.showInformationMessage = original;
    }
  });
});

/*
  確認は画面上部の選択窓で訊く（作者の裁定 A4、2026-09-23）。窓の並びそのもの
  （実行が先頭・内容の行・取りやめ）は `confirmInTopPicker.test.ts` が見る。
*/
describe("実行前の確認", () => {
  test("選択窓で出し、実行を選べば true", async () => {
    const picker = answerConfirms("実行");
    try {
      expect(await confirmRun("19話をAIで確認します。")).toBe(true);
      expect(picker.shown).toHaveLength(1);
      expect(picker.shown[0].title).toBe("19話をAIで確認します。");
      expect(picker.shown[0].buttons).toEqual(["実行"]);
    } finally {
      picker.restore();
    }
  });

  test("Escで閉じられたら false", async () => {
    const picker = answerConfirms(undefined);
    try {
      expect(await confirmRun("19話をAIで確認します。")).toBe(false);
    } finally {
      picker.restore();
    }
  });

  test("押すボタンの名前は呼び出し側が決められる", async () => {
    const picker = answerConfirms("まとめる");
    try {
      expect(await confirmRun("2人をまとめます。", "まとめる")).toBe(true);
      expect(picker.shown[0].buttons[0]).toBe("まとめる");
    } finally {
      picker.restore();
    }
  });

  /*
    **作品名を渡せば、文の1行目に出す**（ノートPCの実機、2026-09-23）。
    詳細メニューの抽出が、作品一覧で誤って選ばれていた作者の本物の作品で
    確認画面まで進み、件数の違いでやっと気づいた。選択窓では1行目が窓の題になる。
  */
  test("作品名を渡すと、確認の文の1行目（窓の題）に出る", async () => {
    const picker = answerConfirms(undefined);
    try {
      await confirmRun("15 チャンク中 15 件を処理します。", "実行", {
        work: { title: "こちら冒険者ギルド生活保護課!!" },
      });
      expect(picker.shown[0].text).toBe(
        "作品：こちら冒険者ギルド生活保護課!!\n15 チャンク中 15 件を処理します。"
      );
      expect(picker.shown[0].title).toBe("作品：こちら冒険者ギルド生活保護課!!");
    } finally {
      picker.restore();
    }
  });

  test("作品名を渡さなければ、文は1文字も変わらない", async () => {
    expect(withWorkTitle("19話をAIで確認します。")).toBe(
      "19話をAIで確認します。"
    );
  });
});

describe("終わりの知らせのボタンを待たない", () => {
  test("押されるのを待たずに戻り、押されたら処理が走る", async () => {
    let press: (label: string | undefined) => void = () => undefined;
    const shown = new Promise<string | undefined>((resolve) => {
      press = resolve;
    });
    const act = vi.fn(async () => undefined);

    // 戻り値が無い（void）＝待たせようがない
    expect(whenNoticePicked(shown, act, { label: "試し" })).toBeUndefined();
    expect(act).not.toHaveBeenCalled();

    press("開く");
    await vi.waitFor(() => expect(act).toHaveBeenCalledWith("開く"));
  });

  test("押したあとの処理が転んだら、握りつぶさずに記録して知らせる", async () => {
    const logFailure = vi
      .spyOn(logger, "logFailure")
      .mockImplementation(() => {});
    const useLogFile = vi
      .spyOn(logger, "useLogFile")
      .mockImplementation(() => {});
    const warned: unknown[] = [];
    const original = window.showWarningMessage;
    window.showWarningMessage = async (message) => {
      warned.push(message);
      return undefined;
    };
    try {
      whenNoticePicked(
        Promise.resolve("開く"),
        async () => {
          throw new Error("開けなかった");
        },
        { label: "試し", workFolder: "C:/works/試し" }
      );
      await vi.waitFor(() => expect(warned).toHaveLength(1));
      expect(useLogFile).toHaveBeenCalledWith("C:/works/試し");
      expect(logFailure).toHaveBeenCalledWith("試し：知らせのボタン", {
        理由: "開けなかった",
      });
    } finally {
      window.showWarningMessage = original;
      logFailure.mockRestore();
      useLogFile.mockRestore();
    }
  });
});

describe("ログへの入口つきの警告", () => {
  test("押されたときだけログを開く", async () => {
    const showLog = vi.spyOn(logger, "showLog").mockImplementation(() => {});
    const original = window.showWarningMessage;
    window.showWarningMessage = async () => "ログを見る";
    try {
      await warnWithLog("応答を読み取れませんでした。");
      expect(showLog).toHaveBeenCalledTimes(1);
    } finally {
      window.showWarningMessage = original;
      showLog.mockRestore();
    }
  });

  test("押されなければ開かない", async () => {
    const showLog = vi.spyOn(logger, "showLog").mockImplementation(() => {});
    const original = window.showWarningMessage;
    window.showWarningMessage = async () => undefined;
    try {
      await warnWithLog("応答を読み取れませんでした。");
      expect(showLog).not.toHaveBeenCalled();
    } finally {
      window.showWarningMessage = original;
      showLog.mockRestore();
    }
  });

  test("ボタンの名前は呼び出し側が渡す（既存の文言を変えないため）", async () => {
    const showLog = vi.spyOn(logger, "showLog").mockImplementation(() => {});
    const calls: unknown[][] = [];
    const original = window.showWarningMessage;
    window.showWarningMessage = async (message, ...items) => {
      calls.push([message, ...items]);
      return "ログを表示";
    };
    try {
      await warnWithLog("送れませんでした。", "ログを表示");
      expect(calls).toEqual([["送れませんでした。", "ログを表示"]]);
      expect(showLog).toHaveBeenCalledTimes(1);
    } finally {
      window.showWarningMessage = original;
      showLog.mockRestore();
    }
  });

  test("エラー版は、出す先だけが違う", async () => {
    const showLog = vi.spyOn(logger, "showLog").mockImplementation(() => {});
    const calls: unknown[][] = [];
    const original = window.showErrorMessage;
    window.showErrorMessage = async (message, ...items) => {
      calls.push([message, ...items]);
      return "ログを見る";
    };
    try {
      await errorWithLog("取り込めませんでした。");
      expect(calls).toEqual([["取り込めませんでした。", "ログを見る"]]);
      expect(showLog).toHaveBeenCalledTimes(1);
    } finally {
      window.showErrorMessage = original;
      showLog.mockRestore();
    }
  });
});

/**
 * 取り消しにくい操作は、警告の顔で確かめる（0.35.4）。
 *
 * 0.35.3 で `confirmRun` へ移したとき、人物をまとめる・GitHubへ送信する
 * ような**取り消しにくい操作まで情報アイコン**になった。もとは
 * `showWarningMessage` で出しており、見た目で身構えられていた。
 *
 * 確認が画面上部の選択窓へ移ってから（A4、2026-09-23）は、**実行の項目に
 * 警告の印を付ける**ことが「警告の顔」の代わりである。
 */
describe("確認の顔つき", () => {
  test("既定は情報の顔（実行に警告の印が付かない）", async () => {
    const picker = answerConfirms("実行");
    try {
      expect(await confirmRun("19話をAIで確認します。")).toBe(true);
      expect(picker.shown).toHaveLength(1);
      expect(picker.shown[0].warning).toBe(false);
    } finally {
      picker.restore();
    }
  });

  test("kind: \"warning\" なら、実行に警告の印を付ける", async () => {
    const picker = answerConfirms("まとめる");
    try {
      expect(
        await confirmRun("2人をまとめます。", "まとめる", { kind: "warning" })
      ).toBe(true);
      expect(picker.shown).toHaveLength(1);
      expect(picker.shown[0].warning).toBe(true);
      expect(picker.shown[0].buttons).toEqual(["まとめる"]);
    } finally {
      picker.restore();
    }
  });

  test("警告の顔でも、選ばなければ false", async () => {
    const picker = answerConfirms(undefined);
    try {
      expect(
        await confirmRun("送信します。", "送信する", { kind: "warning" })
      ).toBe(false);
    } finally {
      picker.restore();
    }
  });

  test("kind: \"info\" を明示しても、情報の顔のまま", async () => {
    const picker = answerConfirms("実行");
    try {
      expect(await confirmRun("確かめます。", "実行", { kind: "info" })).toBe(
        true
      );
      expect(picker.shown[0].warning).toBe(false);
    } finally {
      picker.restore();
    }
  });
});

/**
 * 「以降は訊かない」の覚え書きを差し替える。
 *
 * 本物は `vscode.workspace.getConfiguration("novelai").get("confirm.remembered")`
 * で読み、`.update(...)` で書く（`core/confirmMemoryStore.ts`）。テストは
 * それぞれを差し替えて、初期状態と書き込まれた中身を覗く。
 */
function stubConfirmMemory(initial: Record<string, string>): {
  updates: Array<Record<string, string>>;
  restore: () => void;
} {
  const SECTION = "novelai";
  const updates: Array<Record<string, string>> = [];
  const original = workspace.getConfiguration;
  workspace.getConfiguration = ((section?: string) => {
    if (section !== SECTION) return original();
    return {
      get: (_key: string) => initial,
      update: async (_key: string, value: Record<string, string>) => {
        updates.push(value);
      },
    };
  }) as typeof workspace.getConfiguration;
  return {
    updates,
    restore: () => {
      workspace.getConfiguration = original;
    },
  };
}

/**
 * `confirmRun` に `rememberId` を渡したときの動き。
 *
 * 記憶する側（`rememberConfirmAnswer` が書く）と読み出す側
 * （`rememberedAnswer`）はそれぞれ単体テストがあるが、**`confirmRun`
 * 自身が「覚えがあれば窓を出さずに通す」ところを確かめるテストが
 * 無かった**（既存の「実行前の確認」「確認の顔つき」はどれも
 * `rememberId` を渡していない）。
 */
describe("confirmRun：rememberId を渡したとき", () => {
  test("覚えがまだ無ければ、これまでどおり窓を出す", async () => {
    const memory = stubConfirmMemory({});
    const picker = answerConfirms("実行");
    try {
      const result = await confirmRun("19話をAIで確認します。", "実行", {
        remember: { id: "ai.run.checkTypos" },
      });
      expect(result).toBe(true);
      expect(picker.shown).toHaveLength(1);
      expect(picker.shown[0].buttons).toEqual(["実行", "実行（以降は訊かない）"]);
    } finally {
      picker.restore();
      memory.restore();
    }
  });

  test("「以降は訊かない」を選べば、覚えて実行する", async () => {
    const memory = stubConfirmMemory({});
    const picker = answerConfirms("実行（以降は訊かない）");
    try {
      const result = await confirmRun("19話をAIで確認します。", "実行", {
        remember: { id: "ai.run.checkTypos" },
      });
      expect(result).toBe(true);
      expect(memory.updates.at(-1)).toMatchObject({ "ai.run.checkTypos": "実行" });
    } finally {
      picker.restore();
      memory.restore();
    }
  });

  test("「以降は訊かない」を覚えていれば、窓を出さずに実行したことにする（proceed相当）", async () => {
    const memory = stubConfirmMemory({ "ai.run.checkTypos": "実行" });
    const picker = answerConfirms("実行");
    try {
      const result = await confirmRun("19話をAIで確認します。", "実行", {
        remember: { id: "ai.run.checkTypos" },
      });
      expect(result).toBe(true);
      // 窓を出していれば1件積まれるはず。出さずに通したことの証
      expect(picker.shown).toEqual([]);
    } finally {
      picker.restore();
      memory.restore();
    }
  });
});

/**
 * 「はじめの10話だけ試す」は覚えない（`noRemember`、設計書6.8.7）。
 *
 * 覚えると、以後すべての実行が黙って10話だけになり、見ていない話が
 * 「指摘なし」として通る——**試したつもりが本番になる。** ここは
 * `pickWithMemory`（`views/notify.ts` の272行・322行）を実際に動かして
 * 確かめる（実機確認リストの項目を、機械で確かめられる形にする）。
 */
describe("pickWithMemory：noRemember の項目は覚えない", () => {
  const items = [
    {
      label: "$(beaker) はじめの10話だけ（試す）",
      value: "first" as const,
      noRemember: true,
    },
    { label: "$(book) 作品全体", value: "all" as const },
  ];

  beforeEach(() => {
    resetLastQuickPick();
  });

  test("noRemember の項目を選ぶと、ピンが入っていても覚え書きへ書かない", async () => {
    const memory = stubConfirmMemory({});
    try {
      const promise = pickWithMemory({
        items,
        title: "どこまで見ますか",
        remember: { id: "scope.typoCheck" },
      });

      // ピンを入れてから選ぶ（「以降はこの選択で進む」を入れた体にする）
      expect(lastQuickPick).toBeDefined();
      lastQuickPick!.triggerButton();
      lastQuickPick!.accept(
        lastQuickPick!.items.find((item) => item.value === "first")!
      );

      expect(await promise).toBe("first");
      // ピンを入れて選んだのに、覚え書きへは1件も書かれない
      expect(memory.updates).toEqual([]);
    } finally {
      memory.restore();
    }
  });

  test("noRemember でない項目なら、ピンを入れて選ぶとこれまでどおり覚える", async () => {
    // 上のテストが効きすぎて、覚える道そのものを塞いでいないことの裏
    const memory = stubConfirmMemory({});
    try {
      const promise = pickWithMemory({
        items,
        title: "どこまで見ますか",
        remember: { id: "scope.typoCheck" },
      });

      lastQuickPick!.triggerButton();
      lastQuickPick!.accept(
        lastQuickPick!.items.find((item) => item.value === "all")!
      );

      expect(await promise).toBe("all");
      expect(memory.updates).toEqual([{ "scope.typoCheck": "all" }]);
    } finally {
      memory.restore();
    }
  });

  test("覚え書きに noRemember の項目の値が残っていても、素通りさせずに訊き直す", async () => {
    // 272行：古い記録（覚えられた時期があった場合）が残っていたケース
    const memory = stubConfirmMemory({ "scope.typoCheck": "first" });
    try {
      const promise = pickWithMemory({
        items,
        title: "どこまで見ますか",
        remember: { id: "scope.typoCheck" },
      });

      // 素通りしていれば選択画面は作られない。ここで作られていることが、
      // 訊き直していることの証になる
      expect(lastQuickPick).toBeDefined();
      lastQuickPick!.accept(
        lastQuickPick!.items.find((item) => item.value === "all")!
      );

      expect(await promise).toBe("all");
    } finally {
      memory.restore();
    }
  });
});
