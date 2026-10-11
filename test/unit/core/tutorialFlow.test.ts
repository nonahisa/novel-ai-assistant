import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import {
  runTutorialFlow,
  stepNeedsWork,
  TUTORIAL_WORK_COMMANDS,
  TutorialNoticeGate,
  type TutorialAfterStep,
  type TutorialFlowGoal,
  type TutorialFlowPorts,
  type TutorialStepChoice,
} from "../../../src/core/tutorialFlow";
import { CHECK_CANCELLED } from "../../../src/core/proofreadingSuite";
import {
  buildTutorialStepItems,
  type TutorialStepInput,
  type TutorialStepMark,
} from "../../../src/core/tutorialStepList";

/**
 * はじめの案内の流れ（設計書6.90.7）。
 *
 * 作者の報告（2026-10-10）：「続きを書く」→「執筆を再開」→作品を選ぶ→
 * また一覧→「執筆を再開」→作品を選ぶ……が終わらない。紙は毎回できていたが、
 * 直後に段の一覧が前へ出るので見えず、作品を選ぶ画面と一覧の行き来に見えた。
 *
 * ここでは画面を偽の受け口に置き換えて、**何がどの順で出るか**を見張る。
 */

const resume: TutorialStepInput = {
  command: "novelai.resumeWriting",
  label: "執筆を再開",
  why: "前の話の終わりを出します",
};
const plot: TutorialStepInput = {
  command: "novelai.generatePlot",
  label: "プロット逆算",
  why: "筋を起こし直します",
};
const vertical: TutorialStepInput = {
  command: "novelai.openVertical",
  label: "縦書きで見る",
  why: "組んだ姿を見ます",
};

interface Work {
  id: string;
}

interface Script {
  goals?: Array<TutorialFlowGoal | undefined>;
  steps?: TutorialStepChoice[];
  works?: Array<Work | undefined>;
  after?: TutorialAfterStep[];
  /** 作品が無いのに作品を受ける段を押したときの知らせで、押されたもの */
  needsWork?: TutorialAfterStep[];
  /** 案内の途中で作品が登録される場面は、関数で答えを変える */
  hasWork?: boolean | (() => boolean);
  runResult?: unknown;
}

/** 台本どおりに答える偽の画面。呼ばれた順を `calls` に積む */
function fakePorts(script: Script) {
  const calls: string[] = [];
  const ran: Array<{ command: string; work: Work | undefined }> = [];
  const goals = [...(script.goals ?? [])];
  const steps = [...(script.steps ?? [])];
  const works = [...(script.works ?? [])];
  const after = [...(script.after ?? [])];
  const needsWork = [...(script.needsWork ?? [])];
  const ports: TutorialFlowPorts<TutorialFlowGoal, Work> = {
    askGoal: async () => {
      calls.push("askGoal");
      return goals.shift();
    },
    openGuide: async () => {
      calls.push("openGuide");
    },
    hasWork: () =>
      typeof script.hasWork === "function"
        ? script.hasWork()
        : (script.hasWork ?? true),
    pickWork: async () => {
      calls.push("pickWork");
      return works.shift();
    },
    askStep: async () => {
      calls.push("askStep");
      return steps.shift();
    },
    runStep: async (step, work) => {
      calls.push(`run:${step.command}`);
      ran.push({ command: step.command, work });
      return script.runResult;
    },
    notifyOpened: async (step) => {
      calls.push(`notify:${step.command}`);
      return after.shift();
    },
    notifyNeedsWork: async (step) => {
      calls.push(`needsWork:${step.command}`);
      return needsWork.shift();
    },
    log: () => undefined,
  };
  return { ports, calls, ran };
}

const goal = (stepsOf: TutorialStepInput[]): TutorialFlowGoal => ({
  label: "続きを書く",
  steps: stepsOf,
});

describe("作品は案内の中で一度だけ決める", () => {
  test("作品が1つなら（pickWork が黙って返す）、段にその作品を渡す", async () => {
    const work = { id: "w1" };
    const { ports, ran, calls } = fakePorts({
      goals: [goal([resume])],
      works: [work],
      steps: [{ step: resume, action: "open" }],
      after: [undefined],
    });

    await runTutorialFlow(ports);

    expect(ran).toEqual([{ command: "novelai.resumeWriting", work }]);
    expect(calls.filter((c) => c === "pickWork")).toHaveLength(1);
  });

  test("段を2つ続けて押しても、作品は1回しか訊かない", async () => {
    const work = { id: "w2" };
    const { ports, ran, calls } = fakePorts({
      goals: [goal([resume, plot])],
      works: [work],
      steps: [
        { step: resume, action: "open" },
        { step: plot, action: "open" },
      ],
      after: ["back", undefined],
    });

    await runTutorialFlow(ports);

    expect(calls.filter((c) => c === "pickWork")).toHaveLength(1);
    expect(ran.map((r) => r.work)).toEqual([work, work]);
  });

  test("目的を選び直しても、作品は訊き直さない", async () => {
    const work = { id: "w3" };
    const { ports, calls } = fakePorts({
      goals: [goal([resume]), goal([plot])],
      works: [work],
      steps: ["back", { step: plot, action: "open" }],
      after: [undefined],
    });

    await runTutorialFlow(ports);

    expect(calls.filter((c) => c === "pickWork")).toHaveLength(1);
  });

  test("作品を要しない段だけなら、作品を訊かず、引数なしで動かす", async () => {
    const { ports, ran, calls } = fakePorts({
      goals: [goal([vertical])],
      steps: [{ step: vertical, action: "open" }],
      after: [undefined],
    });

    await runTutorialFlow(ports);

    expect(calls).not.toContain("pickWork");
    expect(ran).toEqual([{ command: "novelai.openVertical", work: undefined }]);
  });

  test("作品を要する段でも、作品が1つも無ければ訊かない（各機能の案内に任せる）", async () => {
    const { ports, calls } = fakePorts({
      hasWork: false,
      goals: [goal([resume])],
      steps: [undefined],
    });

    await runTutorialFlow(ports);

    expect(calls).not.toContain("pickWork");
  });
});

/**
 * 作品が1つも無いときに、作品を受ける段を押した（2026-10-11 作者の指示）。
 *
 * 以前は段を引数なしで動かし、機能の側が「作品が登録されていません。」
 * （ボタン無し）を出して何も開かないのに、案内は「「〇〇」を開きました。」と
 * 知らせていた。作者は何をすればよいか分からず、そこで行き詰まる。
 */
const review: TutorialStepInput = {
  command: "novelai.reviewProposals",
  label: "提案を確認",
  why: "編集部の提案を見ます",
};

describe("作品が無いときは、段を動かさず作品の登録へ案内する", () => {
  test("作品を受ける段を押しても動かさず、「開きました」とも言わない", async () => {
    const { ports, calls } = fakePorts({
      hasWork: false,
      goals: [goal([review])],
      steps: [{ step: review, action: "open" }, undefined],
      needsWork: ["back"],
    });

    await runTutorialFlow(ports);

    expect(calls.some((c) => c.startsWith("run:"))).toBe(false);
    expect(calls.some((c) => c.startsWith("notify:"))).toBe(false);
    expect(calls).toContain("needsWork:novelai.reviewProposals");
    // ［はじめの案内に戻る］で同じ一覧へ戻る
    expect(calls.filter((c) => c === "askStep")).toHaveLength(2);
  });

  test("知らせを閉じたら案内を終える（一覧を勝手に出し直さない）", async () => {
    const { ports, calls } = fakePorts({
      hasWork: false,
      goals: [goal([review])],
      steps: [{ step: review, action: "open" }],
      needsWork: [undefined],
    });

    await runTutorialFlow(ports);

    expect(calls.at(-1)).toBe("needsWork:novelai.reviewProposals");
    expect(calls.filter((c) => c === "askStep")).toHaveLength(1);
  });

  test("作品を受けない段（作品の追加など）は、作品が無くてもそのまま動かす", async () => {
    const add: TutorialStepInput = {
      command: "novelai.addWork",
      label: "フォルダーから作品を追加",
      why: "原稿のフォルダーを登録します",
    };
    const { ports, ran, calls } = fakePorts({
      hasWork: false,
      goals: [goal([add])],
      steps: [{ step: add, action: "open" }],
      after: [undefined],
    });

    await runTutorialFlow(ports);

    expect(ran).toEqual([{ command: "novelai.addWork", work: undefined }]);
    expect(calls.some((c) => c.startsWith("needsWork:"))).toBe(false);
  });

  test("案内の途中で作品を登録したら、次に作品を受ける段を押したときに一度だけ決める", async () => {
    let registered = false;
    const work = { id: "new" };
    const add: TutorialStepInput = {
      command: "novelai.addWork",
      label: "フォルダーから作品を追加",
      why: "原稿のフォルダーを登録します",
    };
    const { ports, ran, calls } = fakePorts({
      hasWork: () => registered,
      goals: [goal([add, review])],
      steps: [
        { step: add, action: "open" },
        { step: review, action: "open" },
      ],
      works: [work],
      after: ["back", undefined],
    });
    const runStep = ports.runStep;
    ports.runStep = async (step, picked) => {
      if (step.command === "novelai.addWork") registered = true;
      return runStep(step, picked);
    };

    await runTutorialFlow(ports);

    expect(calls.filter((c) => c === "pickWork")).toHaveLength(1);
    expect(ran.at(-1)).toEqual({ command: "novelai.reviewProposals", work });
    expect(calls.some((c) => c.startsWith("needsWork:"))).toBe(false);
  });
});

/**
 * 古い知らせが残る（2026-10-11 作者の指示）。
 *
 * 段のあとの知らせ（［はじめの案内に戻る］［終える］）は、しばらくすると右下から
 * 消えて通知センター（ベル）へ移る。待っている案内は終わっていないので、作者が
 * ヘルプから案内をもう一度始めると、古い知らせが新しい案内と並んで残り、押すと
 * 古い一覧まで戻ってきた。新しい案内を始めたら、古い案内の待ちは解いて終える。
 */
describe("案内は1つだけ動かす（TutorialNoticeGate）", () => {
  test("新しい案内を始めると、古い案内の知らせの待ちは「閉じた」として解ける", async () => {
    const gate = new TutorialNoticeGate();
    const first = gate.begin();
    // 作者が押さないまま残っている知らせ
    const never = new Promise<string | undefined>(() => undefined);
    const waiting = first.wait(never);

    const second = gate.begin();

    await expect(waiting).resolves.toBeUndefined();
    expect(first.superseded).toBe(true);
    expect(second.superseded).toBe(false);
  });

  test("新しい案内が始まったあとで古い知らせを押しても、古い一覧へは戻らない", async () => {
    const gate = new TutorialNoticeGate();
    const first = gate.begin();
    gate.begin();
    // 古い知らせの［はじめの案内に戻る］が、あとから押された
    await expect(first.wait(Promise.resolve("back"))).resolves.toBeUndefined();
  });

  test("いまの案内の知らせは、押されたものをそのまま返す", async () => {
    const gate = new TutorialNoticeGate();
    const session = gate.begin();
    await expect(session.wait(Promise.resolve("back"))).resolves.toBe("back");
  });

  test("知らせの待ちが解けた古い案内は、一覧を出さずに終わる", async () => {
    const gate = new TutorialNoticeGate();
    const first = gate.begin();
    const { ports, calls } = fakePorts({
      goals: [goal([resume])],
      works: [{ id: "w" }],
      steps: [{ step: resume, action: "open" }],
    });
    ports.notifyOpened = async (step) => {
      calls.push(`notify:${step.command}`);
      const pending = first.wait(new Promise<TutorialAfterStep>(() => undefined));
      // 知らせが出ているあいだに、ヘルプから案内がもう一度始まった
      gate.begin();
      return pending;
    };

    await runTutorialFlow(ports);

    expect(calls.at(-1)).toBe("notify:novelai.resumeWriting");
    expect(calls.filter((c) => c === "askStep")).toHaveLength(1);
  });
});

describe("作品の選択を取りやめたら、案内を終える（永久ループの入口）", () => {
  test("Esc で閉じたら、段も一覧も出さずに終わる", async () => {
    const { ports, calls } = fakePorts({
      goals: [goal([resume])],
      works: [undefined],
    });

    await runTutorialFlow(ports);

    expect(calls).toEqual(["askGoal", "pickWork"]);
  });
});

describe("段を動かしたら、一覧をすぐ出し直さない", () => {
  test("知らせを出し、閉じたら（戻るを押さなければ）終える", async () => {
    const { ports, calls } = fakePorts({
      goals: [goal([resume])],
      works: [{ id: "w" }],
      steps: [{ step: resume, action: "open" }],
      after: [undefined],
    });

    await runTutorialFlow(ports);

    expect(calls).toEqual([
      "askGoal",
      "pickWork",
      "openGuide",
      "askStep",
      "run:novelai.resumeWriting",
      "notify:novelai.resumeWriting",
    ]);
  });

  test("［はじめの案内に戻る］のときだけ一覧へ戻る", async () => {
    const { ports, calls } = fakePorts({
      goals: [goal([resume])],
      works: [{ id: "w" }],
      steps: [{ step: resume, action: "open" }, undefined],
      after: ["back"],
    });

    await runTutorialFlow(ports);

    expect(calls.slice(-3)).toEqual([
      "run:novelai.resumeWriting",
      "notify:novelai.resumeWriting",
      "askStep",
    ]);
  });

  test("［終える］なら一覧を出さない", async () => {
    const { ports, calls } = fakePorts({
      goals: [goal([resume])],
      works: [{ id: "w" }],
      steps: [{ step: resume, action: "open" }],
      after: ["finish"],
    });

    await runTutorialFlow(ports);

    expect(calls.filter((c) => c === "askStep")).toHaveLength(1);
  });

  test("段の中で取りやめたら、開いたとは知らせず一覧へ戻る", async () => {
    const { ports, calls } = fakePorts({
      goals: [goal([plot])],
      works: [{ id: "w" }],
      steps: [{ step: plot, action: "open" }, undefined],
      runResult: CHECK_CANCELLED,
    });

    await runTutorialFlow(ports);

    expect(calls.some((c) => c.startsWith("notify:"))).toBe(false);
    expect(calls.filter((c) => c === "askStep")).toHaveLength(2);
  });
});

describe("飛ばす", () => {
  test("今までどおり一覧へ戻り、段は動かさない", async () => {
    const { ports, calls } = fakePorts({
      goals: [goal([resume])],
      works: [{ id: "w" }],
      steps: [{ step: resume, action: "skip" }, undefined],
    });

    await runTutorialFlow(ports);

    expect(calls.filter((c) => c === "askStep")).toHaveLength(2);
    expect(calls.some((c) => c.startsWith("run:"))).toBe(false);
  });
});

/**
 * 段の印（実機確認リスト 0.99.20「段の行を選ぶと操作が開き、戻ると同じ一覧に『開いた』の印」
 * 「チェックのボタンで『飛ばした』の印」「全部の段に印が付くと説明文が変わる・もう一度開くと
 * 印は消えている」。2026-10-11 作者の指示「機械でできる実機確認」）。
 *
 * 一覧の行の組み立て（印の文・`allMarked`）は `tutorialStepList.test.ts` が見ている。
 * ここでは**流れが一覧へ渡す印**——開いた段・飛ばした段が、戻った一覧に付いているか、
 * 案内を開き直すと消えているか——を見る。
 */
describe("段の印は、戻った一覧に付き、開き直すと消える", () => {
  /** 一覧を出すたびに、そのとき渡された印を写し取る偽の画面 */
  function markRecorder(script: { steps: TutorialStepChoice[]; after?: TutorialAfterStep[] }) {
    const seen: Array<Map<string, TutorialStepMark>> = [];
    const ran: string[] = [];
    const steps = [...script.steps];
    const after = [...(script.after ?? [])];
    let goalAsked = false;
    const ports: TutorialFlowPorts<TutorialFlowGoal, Work> = {
      askGoal: async () => {
        // 目的は1回だけ選ぶ。一覧から「選び直す」で戻ったら、そこで終える
        if (goalAsked) return undefined;
        goalAsked = true;
        return goal([resume, plot]);
      },
      openGuide: async () => undefined,
      hasWork: () => true,
      pickWork: async () => ({ id: "w" }),
      askStep: async (_goal, marks) => {
        seen.push(new Map(marks));
        return steps.shift();
      },
      runStep: async (step) => {
        ran.push(step.command);
        return undefined;
      },
      notifyOpened: async () => after.shift(),
      log: () => undefined,
    };
    return { ports, seen, ran };
  }

  test("開いた段は、［はじめの案内に戻る］で戻った一覧に「開いた」の印が付いて、次の段を選べる", async () => {
    const { ports, seen, ran } = markRecorder({
      steps: [{ step: resume, action: "open" }, { step: plot, action: "open" }],
      after: ["back", "finish"],
    });

    await runTutorialFlow(ports);

    expect(ran).toEqual(["novelai.resumeWriting", "novelai.generatePlot"]);
    expect(seen[0].size).toBe(0);
    expect(seen[1].get("novelai.resumeWriting")).toBe("opened");
    // 戻った一覧で次の段（プロット逆算）を選べて、それも動いた
    expect(seen[1].has("novelai.generatePlot")).toBe(false);
  });

  test("飛ばした段は、操作を起こさずに「飛ばした」の印が付いて一覧に戻る", async () => {
    const { ports, seen, ran } = markRecorder({
      steps: [{ step: resume, action: "skip" }, undefined],
    });

    await runTutorialFlow(ports);

    expect(ran).toEqual([]);
    expect(seen).toHaveLength(2);
    expect(seen[1].get("novelai.resumeWriting")).toBe("skipped");
  });

  test("全部の段に印が付くと一覧は「全部」と言い、Esc（選ばずに閉じる）で終わり、開き直すと印は消えている", async () => {
    const first = markRecorder({
      steps: [
        { step: resume, action: "open" },
        { step: plot, action: "skip" },
        // 全部に印が付いた一覧を Esc で閉じる
        undefined,
      ],
      after: ["back"],
    });
    await runTutorialFlow(first.ports);

    const last = first.seen[first.seen.length - 1];
    expect(
      buildTutorialStepItems({ steps: [resume, plot], later: [], marks: last }).allMarked
    ).toBe(true);
    // 一覧の説明文は、全部に印が付いたときだけ「全部の段に印が付きました」に変わる
    const panel = readFileSync("src/features/writerDiagnosis.ts", "utf8");
    expect(panel).toMatch(
      /list\.allMarked\s*\?\s*"全部の段に印が付きました。終えるときは「案内を終える」を選んでください"/
    );

    // もう一度案内を開くと、最初の一覧に印は無い（印は案内を開いている間だけ持つ）
    const again = markRecorder({ steps: [undefined] });
    await runTutorialFlow(again.ports);
    expect(again.seen[0].size).toBe(0);
  });
});

describe("作品を受けるコマンドの一覧", () => {
  test("執筆を再開は作品を受ける。縦書き・作品の追加は受けない", () => {
    expect(stepNeedsWork("novelai.resumeWriting")).toBe(true);
    expect(stepNeedsWork("novelai.openVertical")).toBe(false);
    expect(stepNeedsWork("novelai.addWork")).toBe(false);
    expect(TUTORIAL_WORK_COMMANDS.size).toBeGreaterThan(0);
  });
});
