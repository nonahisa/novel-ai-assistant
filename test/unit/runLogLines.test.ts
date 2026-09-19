import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  describeExtractionCancelled,
  describeExtractionLog,
  describeRunCancelledStep,
  describeRunEnd,
  describeRunStart,
  describeRunStep,
  describeTuningLog,
} from "../../src/core/runLog";

/**
 * 長い処理の「終わった」と「何が残ったか」を、画面以外にも残す
 * （作者の裁定、2026-09-19）。
 *
 * 実機で、AIチューニングが終わって反映待ちで止まっていたのに、誰も
 * 気づかないまま10分以上が過ぎた。**終わったことは知らせ（通知）にしか
 * 出ず、消えたら何も残らなかった**ためである。12分かけて測った結果も、
 * 反映しなかったことも、どこにも残っていなかった。
 *
 * ここで見張るのは3つ。
 *
 * - 各処理が終わったときに、**期待する1行が記録へ出る**こと
 * - **飛ばした段が「できました」と書かれない**こと（出ないことの確認）
 * - 「反映なし」「飛ばした」「失敗した」に**理由が付く**こと
 *
 * 最後の1つがいちばん大事である。「できました」だけのログは、今回の
 * 困りごと（なぜ止まっていたのかが分からない）を解かない。
 */

describe("段ごとの1行", () => {
  test("走り切った段は、件数まで書く", () => {
    expect(
      describeRunStep({
        runLabel: "校正をまとめて実行",
        done: 2,
        total: 4,
        step: { label: "推敲", count: 12 },
      })
    ).toBe("校正をまとめて実行 2/4 推敲 → できました（指摘 12件）");
  });

  test("件数を持たない段は、結果の行き先を書く", () => {
    // あらすじ・紹介文・冒頭診断は提案パネルへ出ない。0件と書くと
    // 「指摘が無かった」と読めてしまう
    expect(
      describeRunStep({
        runLabel: "新しい作品を、ひと通り仕上げる",
        done: 3,
        total: 12,
        step: { label: "作品紹介文を生成" },
      })
    ).toBe(
      "新しい作品を、ひと通り仕上げる 3/12 作品紹介文を生成 → " +
        "できました（結果は別の文書に出しました）"
    );
  });

  test("飛ばした段は理由を書き、「できました」とは書かない", () => {
    const line = describeRunStep({
      runLabel: "新しい作品を、ひと通り仕上げる",
      done: 5,
      total: 12,
      step: { label: "プロット逆算", skipped: true, reason: "プロットが既にあるため" },
    });

    expect(line).toBe(
      "新しい作品を、ひと通り仕上げる 5/12 プロット逆算 → " +
        "飛ばしました（プロットが既にあるため）"
    );
    // **出ないことの確認。** 飛ばした段が「できました」と記録されると、
    // あとから読んだ作者は作られたものと思い込む
    expect(line).not.toContain("できました");
  });

  test("理由の無い「飛ばしました」は、そうと分かるように書く", () => {
    // 黙って飛ばしたのと同じ行にしない。理由が落ちていること自体が
    // 手がかりになる
    expect(
      describeRunStep({
        runLabel: "校正をまとめて実行",
        done: 1,
        total: 2,
        step: { label: "プロット逸脱", skipped: true },
      })
    ).toBe("校正をまとめて実行 1/2 プロット逸脱 → 飛ばしました（理由は記録されていません）");
  });

  test("失敗した段は理由を書き、「できました」とは書かない", () => {
    const line = describeRunStep({
      runLabel: "校正をまとめて実行",
      done: 3,
      total: 4,
      step: { label: "矛盾検知", failed: true, notes: ["AIへ接続できませんでした。"] },
    });

    expect(line).toBe(
      "校正をまとめて実行 3/4 矛盾検知 → 失敗しました（AIへ接続できませんでした。）"
    );
    expect(line).not.toContain("できました");
  });

  test("中止した段は「失敗」と書かない", () => {
    // 止めたのは作者である。不具合を疑わせる語を使うと、ログを読み返した
    // ときに原因探しが始まる
    const line = describeRunCancelledStep({
      runLabel: "校正をまとめて実行",
      done: 2,
      total: 4,
      label: "推敲",
    });

    expect(line).toBe(
      "校正をまとめて実行 2/4 推敲 → 中止しました（ここで止めたので、残りは走らせません）"
    );
    expect(line).not.toContain("失敗");
  });
});

describe("始まりと終わりの1行", () => {
  test("始まりには作品名と段数を書く", () => {
    expect(
      describeRunStart({
        runLabel: "校正をまとめて実行",
        workTitle: "試しの作品",
        total: 4,
      })
    ).toBe("校正をまとめて実行 開始 試しの作品 4段");
  });

  test("終わりには、できた段と飛ばした段と失敗した段を数える", () => {
    expect(
      describeRunEnd({
        runLabel: "校正をまとめて実行",
        done: [
          { label: "誤字脱字", count: 3 },
          { label: "推敲", count: 0 },
          { label: "プロット逸脱", skipped: true, reason: "プロットが無いため" },
          { label: "矛盾検知", failed: true },
        ],
        remaining: ["伏線"],
      })
    ).toBe(
      "校正をまとめて実行 終了 → できました 2段 / 飛ばしました 1段 / " +
        "失敗 1段 / 中止で走らせず 1段"
    );
  });

  test("0件の内訳は並べない（本当に失敗した回を目で拾えなくなる）", () => {
    const line = describeRunEnd({
      runLabel: "校正をまとめて実行",
      done: [{ label: "誤字脱字", count: 3 }],
      remaining: [],
    });

    expect(line).toBe("校正をまとめて実行 終了 → できました 1段");
    // 出ないことの確認
    expect(line).not.toContain("失敗 0段");
    expect(line).not.toContain("飛ばしました 0段");
  });

  test("1段も走らなかったときは、そう書く", () => {
    expect(
      describeRunEnd({
        runLabel: "校正をまとめて実行",
        done: [],
        remaining: ["誤字脱字", "推敲"],
      })
    ).toBe("校正をまとめて実行 終了 → 1段も実行せずに止まりました（残り：誤字脱字・推敲）");
  });
});

describe("AIチューニングの1行", () => {
  test("測った値と、記録したことを両方書く", () => {
    expect(
      describeTuningLog({
        modelKey: "sakura/gpt-oss-120b",
        measuredChars: 138714,
        measuredTokens: 111444,
        recorded: true,
        recordsContextLength: true,
        hitCeiling: false,
        cancelled: false,
      })
    ).toBe(
      "AIチューニング sakura/gpt-oss-120b 読める長さ 138,714字（111,444トークン）\n" +
        "  → 記録しました（読める長さと待ち時間）"
    );
  });

  test("読める長さを台帳へ書かないAIは、その理由まで書く", () => {
    // Ollama・LM Studio は申告値を API から取れるので書かない。
    // 黙ると、作者には「測ったのに反映されない」としか見えない
    const line = describeTuningLog({
      modelKey: "ollama/gemma4:26b",
      measuredChars: 138714,
      measuredTokens: 111444,
      recorded: true,
      recordsContextLength: false,
      hitCeiling: false,
      cancelled: false,
    });

    expect(line).toContain("読める長さ 138,714字（111,444トークン）");
    expect(line).toContain("読める長さはAIの申告値を使うため記録しません");
  });

  test("反映しなかった回は、測った値も判断の材料も残す", () => {
    const line = describeTuningLog({
      modelKey: "sakura/gpt-oss-120b",
      measuredChars: 4000,
      measuredTokens: 3200,
      recorded: false,
      recordsContextLength: true,
      hitCeiling: false,
      stoppedBy: "rate_limit_floor",
      previousChars: 186435,
      cancelled: false,
    });

    expect(line).toBe(
      "AIチューニング sakura/gpt-oss-120b 読める長さ 4,000字（3,200トークン）\n" +
        "  → 記録なし（設定へ反映していません）。" +
        "打ち切り：AIの分あたりの上限 / 前の記録：186,435字"
    );
    // 出ないことの確認。反映していない回を「記録しました」と読ませない
    expect(line).not.toContain("記録しました");
  });

  test("一度も通らなかった回は、覚える値が無いことを書く", () => {
    expect(
      describeTuningLog({
        modelKey: "ollama/gemma4:26b",
        measuredChars: 0,
        measuredTokens: 0,
        recorded: false,
        recordsContextLength: false,
        hitCeiling: false,
        cancelled: false,
      })
    ).toBe(
      "AIチューニング ollama/gemma4:26b 読める長さは測れませんでした\n" +
        "  → 記録なし（一度も通らなかったため、覚える値がありません）"
    );
  });

  test("天井まで通った回と、中止した回は、そうと分かるように書く", () => {
    const line = describeTuningLog({
      modelKey: "ollama/gemma4:26b",
      measuredChars: 362191,
      measuredTokens: 290000,
      recorded: true,
      recordsContextLength: false,
      hitCeiling: true,
      cancelled: true,
    });

    expect(line).toContain("途中で中止");
    expect(line).toContain("天井まで通ったため、これ以上は試していない");
  });
});

describe("設定資料の抽出の1行", () => {
  test("件数の内訳を書く", () => {
    expect(
      describeExtractionLog({
        added: 8,
        updated: 7,
        rejected: 4,
        conflicts: 0,
        folded: 2,
        failedChunks: 1,
        saved: 8,
        pendingUpdates: 7,
        cacheWarnings: 0,
      })
    ).toBe(
      "設定資料の抽出 → 新規 8名 / 更新 7名 / 除外 4件 / 競合 0件 / " +
        "作中の変化として記録 2件 / 失敗 1チャンク / 保存 8名 / 承認待ち 7名"
    );
  });

  test("1件も増えなかった回は、その手がかりを添える", () => {
    // 「新規0名・更新0名」だけでは、除外や失敗のせいなのか、本当に
    // 増えるものが無かったのかを区別できない
    const line = describeExtractionLog({
      added: 0,
      updated: 0,
      rejected: 4,
      conflicts: 2,
      folded: 0,
      failedChunks: 3,
      saved: 0,
      pendingUpdates: 0,
      cacheWarnings: 0,
    });

    expect(line).toContain(
      "資料は増えていません（除外 4件 / 失敗 3チャンク / 競合 2件）"
    );
  });

  test("増えた回には、増えなかった理由を書かない", () => {
    const line = describeExtractionLog({
      added: 1,
      updated: 0,
      rejected: 0,
      conflicts: 0,
      folded: 0,
      failedChunks: 0,
      saved: 1,
      pendingUpdates: 0,
      cacheWarnings: 0,
    });

    // 出ないことの確認
    expect(line).not.toContain("資料は増えていません");
  });

  test("中止した回は、資料を書き換えていないことまで書く", () => {
    expect(describeExtractionCancelled()).toContain("資料は書き換えていません");
  });
});

/**
 * ここから下は「本当に記録へ出るか」を見る。
 *
 * **`logStep` は見張りの網を抜けることがある**（`logFileRouting.test.ts` は
 * 呼んでいるかどうかしか見ない）。文面が正しくても、呼ばれていなければ
 * 今回の困りごとは解けないので、実際に走らせて確かめる。
 */

const logged = vi.hoisted(() => ({
  steps: [] as string[],
  /** `useLogFile` に渡った書き先。作品のログへ向けているかを見る */
  targets: [] as (string | undefined)[],
}));

vi.mock("../../src/core/logger", () => ({
  logStep: (message: string) => logged.steps.push(message),
  logLine: (message: string) => logged.steps.push(message),
  logFailure: () => undefined,
  showLog: () => undefined,
  useLogFile: (folderPath: string | undefined) => logged.targets.push(folderPath),
}));

vi.mock("../../src/views/progress", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withProgress: async (
    _title: string,
    task: (progress: { report: (value: unknown) => void }) => Promise<unknown>
  ) => await task({ report: () => undefined }),
}));

vi.mock("../../src/views/openDocument", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  openGeneratedMarkdown: async () => undefined,
}));

const present = vi.hoisted(() => ({ value: [] as string[] }));
vi.mock("../../src/features/prerequisiteGate", () => ({
  collectPresentPrerequisites: async () => new Set(present.value),
}));

const outcomes = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

const { commands, window } = await import("./support/vscodeStub");
const { runFinishNewWork } = await import("../../src/features/finishNewWork");
const { FINISH_PREREQUISITES, FINISH_STEPS } = await import(
  "../../src/core/finishNewWork"
);
const { runProofreadingSuite } = await import(
  "../../src/features/proofreadingSuite"
);
const { checkSkipped, sortToRunOrder } = await import(
  "../../src/core/proofreadingSuite"
);

const work = {
  id: "w1",
  title: "試しの作品",
  folderPath: "C:/tmp/work",
} as import("../../src/models/types").WorkEntry;

beforeEach(() => {
  logged.steps = [];
  logged.targets = [];
  present.value = [];
  outcomes.value = {};
  Object.assign(commands, {
    executeCommand: async (command: string) => outcomes.value[command],
  });
  window.showInformationMessage = (async () => "実行") as
    typeof window.showInformationMessage;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ひと通り仕上げるは、段ごとに記録へ残す", () => {
  test("始まりと、段ごとと、終わりの行が出る", async () => {
    await runFinishNewWork(work, { remainingIn: () => 0 });

    const total = FINISH_STEPS.length;
    expect(logged.steps[0]).toBe(
      `新しい作品を、ひと通り仕上げる 開始 試しの作品 ${total}段`
    );
    expect(
      logged.steps.some((line) =>
        line.startsWith(
          `新しい作品を、ひと通り仕上げる 1/${total} ${FINISH_STEPS[0].label} → できました`
        )
      )
    ).toBe(true);
    expect(logged.steps.at(-1)).toBe(
      `新しい作品を、ひと通り仕上げる 終了 → できました ${total}段`
    );
    // **作品のログへ向けている**（向けないと出力パネルにしか残らない）
    expect(logged.targets).toContain(work.folderPath);
  });

  test("走らせる前に飛ばした段は、理由つきで残り「できました」とは書かれない", async () => {
    // 1段目の前提を「既にある」にすると、その段は走らせずに飛ばす
    present.value = [...FINISH_PREREQUISITES];

    await runFinishNewWork(work, { remainingIn: () => 0 });

    // 終わりの行（「飛ばしました 3段」）は数の話なので、段の行だけを拾う
    const skipped = logged.steps.filter((line) =>
      line.includes(" → 飛ばしました")
    );
    expect(skipped.length).toBeGreaterThan(0);
    for (const line of skipped) {
      // 出ないことの確認
      expect(line).not.toContain("できました");
      // 理由が括弧で付いている（「飛ばしました。」で終わらない）
      expect(line).toMatch(/飛ばしました（.+）$/);
    }
  });

  test("機能が「前提が足りない」と返した段も、理由つきで残る", async () => {
    const step = FINISH_STEPS[0];
    outcomes.value[step.command] = checkSkipped("設定資料がまだ無いため");

    await runFinishNewWork(work, { remainingIn: () => 0 });

    expect(logged.steps).toContain(
      `新しい作品を、ひと通り仕上げる 1/${FINISH_STEPS.length} ${step.label} → ` +
        "飛ばしました（設定資料がまだ無いため）"
    );
  });

  test("例外で落ちた段は、理由まで残る", async () => {
    const step = FINISH_STEPS[0];
    Object.assign(commands, {
      executeCommand: async (command: string) => {
        if (command === step.command) throw new Error("AIへ接続できません");
        return undefined;
      },
    });

    await runFinishNewWork(work, { remainingIn: () => 0 });

    expect(logged.steps).toContain(
      `新しい作品を、ひと通り仕上げる 1/${FINISH_STEPS.length} ${step.label} → ` +
        "失敗しました（AIへ接続できません）"
    );
  });
});

describe("校正のまとめ実行も、段ごとに記録へ残す", () => {
  /** 選んだものを走らせる。戻り値は `outcomes.value` で差し替える */
  async function runSuite(ids: string[]): Promise<void> {
    const stub = window as unknown as Record<string, unknown>;
    stub.showQuickPick = async (items: { id: string }[]) =>
      items.filter((item) => ids.includes(item.id));
    stub.withProgress = async (
      _options: unknown,
      task: (progress: unknown, token: unknown) => Promise<unknown>
    ) => task({ report: () => undefined }, undefined);

    await runProofreadingSuite(work, {
      memento: {
        get: <T,>(_key: string, fallback: T): T => fallback,
        update: async () => undefined,
      },
      remainingIn: () => 3,
    });
  }

  test("始まりと、段ごとと、終わりの行が出る", async () => {
    const checks = sortToRunOrder(["typos", "proofread"]);

    await runSuite(["typos", "proofread"]);

    expect(logged.steps[0]).toBe("校正をまとめて実行 開始 試しの作品 2段");
    expect(logged.steps).toContain(
      `校正をまとめて実行 1/2 ${checks[0].label} → できました（指摘 3件）`
    );
    expect(logged.steps.at(-1)).toBe("校正をまとめて実行 終了 → できました 2段");
    expect(logged.targets).toContain(work.folderPath);
  });

  test("前提が足りずに飛ばした機能は、理由つきで残り「できました」とは書かれない", async () => {
    const checks = sortToRunOrder(["deviations"]);
    outcomes.value[checks[0].command] = checkSkipped("プロットがまだ無いため");

    await runSuite(["deviations"]);

    const line = logged.steps.find((entry) => entry.includes(" → 飛ばしました"));
    expect(line).toBe(
      `校正をまとめて実行 1/1 ${checks[0].label} → 飛ばしました（プロットがまだ無いため）`
    );
    // 出ないことの確認
    expect(line).not.toContain("できました");
  });

});
