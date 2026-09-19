import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { commands, window } from "./support/vscodeStub";
import {
  FINISH_NEW_WORK_COMMAND,
  FINISH_PREREQUISITES,
  FINISH_STEPS,
  buildFinishConfirm,
  describeFinishHalted,
  describeFinishStep,
  planFinish,
  stepsToRun,
} from "../../src/core/finishNewWork";
import { describeFinishReport } from "../../src/core/finishReportDoc";
import { PROOFREADING_CHECKS } from "../../src/core/proofreadingSuite";
import { CHAPTER_PROPOSAL_CATEGORY } from "../../src/features/proposeChapters";
import { allActions } from "../../src/views/actionList";
import type { WorkEntry } from "../../src/models/types";

/**
 * 「新しい作品を、ひと通り仕上げる」（作者の指示、2026-09-19）。
 *
 * ここで見張るのは4つ。
 *
 * - **段の並び**（作るものが先、直すものが後。前提がその順を決めている）
 * - **既にあるものは作り直さない**（飛ばした理由が紙に出る）
 * - **失敗しても残りは走り、中止したら残りは走らない**
 * - **まとめ側は処理も札も持たない**（ソースを直に見張る）
 *
 * この操作は既にあるコマンドを**コマンドIDと分類名という2本の文字列**でしか
 * 実物と結んでいない。片方だけ改名すると、例外は出ないまま
 * 「走らせたのに何も起きない」「件数がいつも0件」になる。
 */

const state = vi.hoisted(() => ({
  /** 揃っている前提（`collectPresentPrerequisites` の代わり） */
  present: [] as string[],
  /** 走らせたコマンドIDの並び */
  executed: [] as string[],
  /** コマンドへ渡された第2引数（札を取っていないことを見る） */
  options: [] as unknown[],
  /** コマンドIDごとの戻り値。無い鍵は `undefined`（＝走り切った） */
  outcomes: {} as Record<string, unknown>,
  /** 例外を投げるコマンドID */
  throws: [] as string[],
  /** 結果の1枚（Markdown） */
  report: "",
  /** 通知に出た文言 */
  notices: [] as string[],
}));

vi.mock("../../src/views/progress", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // 進捗の窓はテストでは要らない。中の処理だけをそのまま走らせる
  withProgress: async (
    _title: string,
    task: (progress: { report: (value: unknown) => void }) => Promise<unknown>
  ) => await task({ report: () => undefined }),
}));

vi.mock("../../src/views/openDocument", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  openGeneratedMarkdown: async (_kind: string, content: string) => {
    state.report = content;
  },
}));

vi.mock("../../src/features/prerequisiteGate", () => ({
  collectPresentPrerequisites: async () => new Set(state.present),
}));

const { runFinishNewWork } = await import("../../src/features/finishNewWork");

const work = {
  id: "w1",
  title: "試しの作品",
  folderPath: "C:/tmp/work",
} as WorkEntry;

interface PackageManifest {
  contributes: { commands: Array<{ command: string }> };
}

const manifest = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8")
) as PackageManifest;

const declared = new Set(
  manifest.contributes.commands.map((entry) => entry.command)
);

function sourceOf(file: string): string {
  return readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
}

/**
 * コメントを落とす。
 *
 * **「持ってはいけないもの」の見張りは、コードだけを見る。** 説明の中では
 * `holdsRun` も `withAiTurn` も**なぜ持たないのか**を書くために出てくる——
 * 文字列の有無で見ると、理由を書いた注釈のほうが引っかかる。
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

beforeEach(() => {
  state.present = [];
  state.executed = [];
  state.options = [];
  state.outcomes = {};
  state.throws = [];
  state.report = "";
  state.notices = [];

  window.showInformationMessage = (async (message: string) => {
    state.notices.push(message);
    // 確認は「実行」を押した体。取りやめの試験だけが差し替える
    return "実行";
  }) as typeof window.showInformationMessage;

  commands.executeCommand = (async (command: string, ...args: unknown[]) => {
    state.executed.push(command);
    state.options.push(args[1]);
    if (state.throws.includes(command)) throw new Error("わざと落とす");
    return state.outcomes[command];
  }) as typeof commands.executeCommand;
});

describe("段の並び", () => {
  test("作るものが先、直すものが後という順に並んでいる", () => {
    // 前提（`prerequisites.ts`）がこの順を決めている。設定資料が無いと
    // 矛盾検知は走らず、あらすじが無いとプロット逆算は走らない
    expect(FINISH_STEPS.map((step) => step.id)).toEqual([
      "settings",
      "synopsis",
      "plot",
      "blurb",
      "catchphrase",
      "notation",
      "typos",
      "proofread",
      "opening",
      "deviations",
      "contradictions",
      "foreshadows",
      "chapters",
    ]);
  });

  test("直すもの一式は、校正のまとめ実行の並びをそのまま引いている", () => {
    /*
      **写しを作らない。** ここへ並びを書き写すと、校正へ機能を足したときに
      こちらだけ古くなる——例外は出ないので、作者からは「一気に走らせたのに
      その検知だけ動いていない」としか見えない。
    */
    const checks = PROOFREADING_CHECKS.map((check) => check.command);
    const inFinish = FINISH_STEPS.map((step) => step.command);
    const from = inFinish.indexOf(checks[0]);

    expect(inFinish.slice(from, from + checks.length)).toEqual(checks);
  });

  test("冒頭診断も、校正の並びの中に居たまま走る", () => {
    // 取り出して前へ置くと、7件のうち6件だけを名指しで並べ直すことになり、
    // それは写しを作るのと同じである
    expect(FINISH_STEPS.map((step) => step.id)).toContain("opening");
  });

  test("本文を丸ごと読む段と、そうでない段を見分けている", () => {
    // 確認に出すチャンク数の掛け算がここで決まる。1回で終わる段を混ぜると、
    // 送る量を大きく偽ることになる
    const scanning = FINISH_STEPS.filter((step) => step.scansWholeText).map(
      (step) => step.id
    );

    expect(scanning).toEqual([
      "settings",
      "synopsis",
      "plot",
      "typos",
      "proofread",
      "deviations",
      "contradictions",
      "foreshadows",
    ]);
    // 表記ゆれはAIを使わない。冒頭診断は第1話の冒頭だけを送る
    expect(scanning).not.toContain("notation");
    expect(scanning).not.toContain("opening");
  });
});

describe("表が実物と噛み合っている", () => {
  test("走らせるコマンドは、すべて package.json に登録されている", () => {
    for (const step of FINISH_STEPS) {
      expect(declared, `${step.command} が package.json にない`).toContain(
        step.command
      );
    }
  });

  test("走らせるコマンドは、すべて詳細メニューに並んでいる", () => {
    // メニューから消えた機能をここだけが呼び続ける、を防ぐ
    const inMenu = new Set(allActions().map((action) => action.command));

    for (const step of FINISH_STEPS) {
      expect(inMenu, `${step.command} が詳細メニューにない`).toContain(
        step.command
      );
    }
  });

  test("入口そのものも、package.json と詳細メニューにある", () => {
    expect(declared).toContain(FINISH_NEW_WORK_COMMAND);
    expect(allActions().map((action) => action.command)).toContain(
      FINISH_NEW_WORK_COMMAND
    );
  });

  test("入口には前提（needs）を付けない", () => {
    // 前提は自分で順に作っていく操作である。関門を立てると、作りに行く
    // 操作の前で「先に作ってください」と止められる
    const entry = allActions().find(
      (action) => action.command === FINISH_NEW_WORK_COMMAND
    );

    expect(entry?.needs).toBeUndefined();
    expect(entry?.requiresWork).toBe(true);
    expect(entry?.usesAI).toBe(true);
  });

  test("章立ての分類名が、提案パネルへ渡している実物と揃っている", () => {
    // 分類名は文字列でしか結ばれていない。ずれると件数が黙って0件になる
    const chapters = FINISH_STEPS.find((step) => step.id === "chapters");

    expect(chapters?.category).toBe(CHAPTER_PROPOSAL_CATEGORY);
  });

  test("校正の段の分類名は、校正の表のものをそのまま持つ", () => {
    for (const check of PROOFREADING_CHECKS) {
      const step = FINISH_STEPS.find((entry) => entry.id === check.id);
      expect(step?.category).toBe(check.category);
    }
  });

  test("先に見る前提は、段の表から数えている", () => {
    expect([...FINISH_PREREQUISITES]).toEqual(["settings", "synopsis", "plot"]);
  });
});

describe("既にあるものは作り直さない", () => {
  test("何も無ければ、1段も飛ばさない", () => {
    expect(stepsToRun(planFinish([])).length).toBe(FINISH_STEPS.length);
  });

  test("設定資料が既にあれば、抽出の段だけを理由つきで飛ばす", () => {
    const plan = planFinish(["settings"]);
    const skipped = plan.filter((entry) => entry.skipReason !== undefined);

    expect(skipped.map((entry) => entry.step.id)).toEqual(["settings"]);
    expect(skipped[0].skipReason).toBe("設定資料が既にあるため");
    expect(stepsToRun(plan).map((step) => step.id)).not.toContain("settings");
  });

  test("3つとも揃っていれば、作る3段だけが飛ぶ", () => {
    const plan = planFinish(["settings", "synopsis", "plot"]);

    expect(
      plan.filter((entry) => entry.skipReason).map((entry) => entry.step.id)
    ).toEqual(["settings", "synopsis", "plot"]);
    // 直すもの・広報の段は残る（前提を作り直す話ではない）
    expect(stepsToRun(plan).map((step) => step.id)).toContain("typos");
  });
});

describe("先に出す確認", () => {
  const estimate = {
    totalChars: 41000,
    chunkCount: 12,
    providerNames: ["Ollama"],
    isPaid: false,
  };

  test("段数・順番・送る量・かかる時間を1枚で示す", () => {
    const confirm = buildFinishConfirm({
      workTitle: "試しの作品",
      plan: planFinish([]),
      estimate,
    });

    expect(confirm?.message).toBe(
      "試しの作品 を、ひと通り仕上げます（13段）。"
    );
    // かけ算を見せる（1段ぶんだと読まれないように）
    expect(confirm?.detail).toContain("本文 41,000字 / 12チャンク");
    // **「最大」とは言わない**（2026-09-19の実機）。本文の量だけを割った
    // 数なので、指示や資料が肥えると送る直前に分かれて増える
    expect(confirm?.detail).toContain("およそ 8×12＝96チャンク");
    expect(confirm?.detail).toContain("分かれて数が増えることがあります");
    expect(confirm?.detail).not.toContain("最大");
    expect(confirm?.detail).toContain("目安 24分程度");
    expect(confirm?.detail).toContain("残りの4段は、1回ずつの短い呼び出しです。");
    expect(confirm?.detail).toContain("使うAI：Ollama");
  });

  test("有料のAIなら、課金されることを書く", () => {
    const confirm = buildFinishConfirm({
      workTitle: "試しの作品",
      plan: planFinish([]),
      estimate: { ...estimate, isPaid: true, providerNames: ["Gemini"] },
    });

    expect(confirm?.detail).toContain("チャンクごとに課金されます。");
    // 無料のときの「目安◯分」は出さない（知りたいのは料金のほう）
    expect(confirm?.detail).not.toContain("目安");
  });

  test("飛ばす段は、始める前に名指しで伝える", () => {
    const confirm = buildFinishConfirm({
      workTitle: "試しの作品",
      plan: planFinish(["settings"]),
      estimate,
    });

    expect(confirm?.detail).toContain(
      "飛ばす段：設定資料をまとめて抽出（設定資料が既にあるため）"
    );
    expect(confirm?.message).toBe(
      "試しの作品 を、ひと通り仕上げます（12段）。"
    );
  });

  test("本文を書き換えないことと、どこで確認が出るかを先に言う", () => {
    const confirm = buildFinishConfirm({
      workTitle: "試しの作品",
      plan: planFinish([]),
      estimate,
    });

    expect(confirm?.detail).toContain("本文は1文字も書き換えません。");
    expect(confirm?.detail).toContain("校正の段では確認は出しません。");
    // **確認はプレーンテキストである。** 強調の記号はそのまま画面に出る
    expect(confirm?.detail).not.toContain("**");
  });

  test("見積もりが取れなくても、確認そのものは出す", () => {
    // 押した覚えのないまま長い処理が始まるのが、いちばん困る
    const confirm = buildFinishConfirm({
      workTitle: "試しの作品",
      plan: planFinish([]),
    });

    expect(confirm?.detail).toContain(
      "送る量は、実行時にモデルの大きさから決まります"
    );
  });

  test("走らせる段が1つも無ければ、確認を出さない", () => {
    const plan = FINISH_STEPS.map((step) => ({
      step,
      skipReason: "既にあるため",
    }));

    expect(buildFinishConfirm({ workTitle: "試しの作品", plan })).toBeUndefined();
  });
});

describe("結果の1枚", () => {
  test("段ごとに、できた・飛ばした・失敗したを並べる", () => {
    const report = describeFinishReport({
      workTitle: "試しの作品",
      done: [
        { label: "設定資料をまとめて抽出", skipped: true, reason: "設定資料が既にあるため" },
        { label: "各話あらすじを生成" },
        { label: "誤字脱字", count: 12 },
        { label: "推敲", failed: true },
        { label: "矛盾", count: 0 },
      ],
      remaining: [],
    });

    expect(report).toContain("# ひと通り仕上げました：試しの作品");
    expect(report).toContain(
      "| 設定資料をまとめて抽出 | 飛ばしました（設定資料が既にあるため） |"
    );
    expect(report).toContain("| 各話あらすじを生成 | できました |");
    expect(report).toContain("| 誤字脱字 | できました（指摘 12件） |");
    expect(report).toContain("| 推敲 | 失敗しました |");
    expect(report).toContain("合わせて 12件です。");
    expect(report).toContain("**本文は1文字も書き換えていません。**");
  });

  test("中止で走らせなかった段も、同じ表に並べる", () => {
    // 「終わりました」とだけ出すと、走らなかった段まで済んだと読める
    const report = describeFinishReport({
      workTitle: "試しの作品",
      done: [{ label: "表記ゆれ", count: 2 }],
      remaining: ["矛盾", "伏線の検知"],
    });

    expect(report).toContain("| 矛盾 | 走らせていません（途中で中止したため） |");
    expect(report).toContain(
      "| 伏線の検知 | 走らせていません（途中で中止したため） |"
    );
  });

  test("数える段が1つも走っていなければ、0件と書かない", () => {
    // 「調べたが何も無かった」と読めてしまう
    const report = describeFinishReport({
      workTitle: "試しの作品",
      done: [{ label: "作品紹介文を生成" }],
      remaining: [],
    });

    expect(report).toContain("指摘を数える段は走りませんでした。");
  });

  test("走れなかった理由は、表の外にまとめて並べる", () => {
    const report = describeFinishReport({
      workTitle: "試しの作品",
      done: [
        {
          label: "矛盾",
          skipped: true,
          reason: "設定資料がまだ無いため",
          notes: ["先に設定資料を抽出してください。"],
        },
      ],
      remaining: [],
    });

    expect(report).toContain("## 気づいたこと");
    expect(report).toContain("- 先に設定資料を抽出してください。");
  });

  test("名前に縦棒が混じっても、表が崩れない", () => {
    const report = describeFinishReport({
      workTitle: "試し",
      done: [{ label: "誤字|脱字", count: 1 }],
      remaining: [],
    });

    expect(report).toContain("| 誤字\\|脱字 | できました（指摘 1件） |");
  });

  test("1段も走らなかったときは、1行で知らせる", () => {
    expect(
      describeFinishHalted({
        workTitle: "試し",
        done: [],
        remaining: ["設定資料をまとめて抽出", "各話あらすじを生成"],
      })
    ).toBe(
      "ひと通り仕上げる：1段も実行せずに止まりました" +
        "（残り：設定資料をまとめて抽出・各話あらすじを生成）。"
    );
  });

  test("進み具合は「2/13：本文からプロットを起こす」の形で出す", () => {
    expect(describeFinishStep(2, 13, "本文からプロットを起こす")).toBe(
      "2/13：本文からプロットを起こす"
    );
  });
});

describe("入口を1回通す", () => {
  const deps = { remainingIn: () => 3 };

  test("決めた順に、既にあるコマンドをそのまま呼ぶ", async () => {
    await runFinishNewWork(work, deps);

    expect(state.executed).toEqual(FINISH_STEPS.map((step) => step.command));
  });

  test("札は取らず、確認が済んでいることだけを伝える", async () => {
    /*
      **`holdsRun` を渡さない。** まとめ側は札を持っていないので、各段が
      自分で取る。持っているつもりで渡すと、どの段も札を取らないまま走り、
      他の操作と混ざる。
    */
    await runFinishNewWork(work, deps);

    expect(state.options[0]).toEqual({ suite: { confirmed: true } });
  });

  test("既にある段は、呼ばずに飛ばして紙に書く", async () => {
    state.present = ["settings"];

    await runFinishNewWork(work, deps);

    expect(state.executed).not.toContain("novelai.extractSettings");
    expect(state.report).toContain(
      "| 設定資料をまとめて抽出 | 飛ばしました（設定資料が既にあるため） |"
    );
  });

  test("1つの段が例外を投げても、残りは走らせる", async () => {
    // AIの失敗は、次の段を止める理由にならない
    state.throws = ["novelai.generateSynopses"];

    await runFinishNewWork(work, deps);

    expect(state.executed).toEqual(FINISH_STEPS.map((step) => step.command));
    expect(state.report).toContain("| 各話あらすじを生成 | 失敗しました |");
  });

  test("前提が足りずに飛ばした段は、失敗と呼ばない", async () => {
    // 「失敗しました」を見た作者は、そこで不具合を疑って原因を探しに行く
    state.outcomes["novelai.checkDeviations"] = {
      kind: "skipped",
      reason: "プロットがまだ無いため",
      notes: ["先にプロットを書いてください。"],
    };

    await runFinishNewWork(work, deps);

    expect(state.report).toContain(
      "| プロット逸脱 | 飛ばしました（プロットがまだ無いため） |"
    );
    expect(state.report).toContain("- 先にプロットを書いてください。");
  });

  test("中止したら、残りの段は走らせない", async () => {
    state.outcomes["novelai.generatePlot"] = { kind: "cancelled" };

    await runFinishNewWork(work, deps);

    expect(state.executed).toEqual([
      "novelai.extractSettings",
      "novelai.generateSynopses",
      "novelai.generatePlot",
    ]);
    // 止めたところから先は、紙の上でも「走らせていません」と分かる
    expect(state.report).toContain(
      "| 本文からプロットを起こす | 走らせていません（途中で中止したため） |"
    );
  });

  test("確認で取りやめたら、1段も走らせない", async () => {
    window.showInformationMessage = (async () =>
      undefined) as typeof window.showInformationMessage;

    await runFinishNewWork(work, deps);

    expect(state.executed).toEqual([]);
    expect(state.report).toBe("");
  });

  test("1段目で中止したら、紙の代わりに1行で知らせる", async () => {
    state.outcomes["novelai.extractSettings"] = { kind: "cancelled" };

    await runFinishNewWork(work, deps);

    expect(state.report).toBe("");
    expect(state.notices.at(-1)).toContain("1段も実行せずに止まりました");
  });
});

describe("まとめ側が持ってはいけないもの", () => {
  const source = withoutComments(sourceOf("src/features/finishNewWork.ts"));

  test("AIの順番待ちの札を取らない", () => {
    // 取ると、各段が「自分の持つ札」を待って永久に進まない
    expect(source).not.toContain("withAiTurn");
    expect(source).not.toContain("holdsRun");
  });

  test("中止ボタンを持たない", () => {
    // 持つと、走っている機能のものと2つ並ぶ。中止は実行中の1つに寄せる
    expect(source).not.toContain("withCancellableProgress");
  });

  test("本文を書き換える口を持たない", () => {
    // 指摘はすべて提案として溜める。これは製品の土台の約束である
    expect(source).not.toContain("writeTextFilePreservingFormat");
    expect(source).not.toContain("atomicWriteFile");
  });

  test("判断は core にあり、機能側は配線だけを持つ", () => {
    // 文面や順番を機能側へ書くと、実機でしか確かめられなくなる
    expect(source).toContain('from "../core/finishNewWork"');
  });
});
