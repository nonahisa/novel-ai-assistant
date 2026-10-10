import { describe, expect, test } from "vitest";
import {
  runTutorialFlow,
  stepNeedsWork,
  TUTORIAL_WORK_COMMANDS,
  type TutorialAfterStep,
  type TutorialFlowGoal,
  type TutorialFlowPorts,
  type TutorialStepChoice,
} from "../../../src/core/tutorialFlow";
import { CHECK_CANCELLED } from "../../../src/core/proofreadingSuite";
import type { TutorialStepInput } from "../../../src/core/tutorialStepList";

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
  hasWork?: boolean;
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
  const ports: TutorialFlowPorts<TutorialFlowGoal, Work> = {
    askGoal: async () => {
      calls.push("askGoal");
      return goals.shift();
    },
    openGuide: async () => {
      calls.push("openGuide");
    },
    hasWork: () => script.hasWork ?? true,
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

describe("作品を受けるコマンドの一覧", () => {
  test("執筆を再開は作品を受ける。縦書き・作品の追加は受けない", () => {
    expect(stepNeedsWork("novelai.resumeWriting")).toBe(true);
    expect(stepNeedsWork("novelai.openVertical")).toBe(false);
    expect(stepNeedsWork("novelai.addWork")).toBe(false);
    expect(TUTORIAL_WORK_COMMANDS.size).toBeGreaterThan(0);
  });
});
