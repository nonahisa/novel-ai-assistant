import { describe, expect, test } from "vitest";
import {
  currentStep,
  describeStep,
  describeTourEnd,
  isTourFinished,
  observeCommand,
  startTour,
  startTourByKey,
  type TourState,
} from "../../../src/core/guidedTour";
import {
  PROCEDURES,
  type Procedure,
  type ProcedureActionInfo,
} from "../../../src/core/procedures";
import { findAction, prerequisiteNoteOf } from "../../../src/views/actionList";

/**
 * 画面で指しながら案内する仕組みの、進み方の判断（設計書6.104）。
 *
 * ここで守るのは5つ。
 *
 * 1. 順に押せば順に進み、最後まで押せば**終わる**
 * 2. 先の段を押したら**そこまで飛ばして進む**（案内だけ取り残されない）
 * 3. 手順に無い操作を押しても**案内は消えず、進みもしない**
 * 4. 済んだ段を押し直しても**後戻りしない**
 * 5. 名前を引けない段は**落とす**。1段も残らなければ**始めない**
 */

/** 製品と同じ引き方（`featureGuide.ts` の `procedureActionLookup` と同じ材料） */
const lookup = (command: string): ProcedureActionInfo | undefined => {
  const action = findAction(command);
  if (!action) return undefined;
  const needs = prerequisiteNoteOf(action);
  return {
    label: action.label,
    ...(action.note ? { note: action.note } : {}),
    ...(needs ? { prerequisiteNote: needs } : {}),
  };
};

/** 試験用の手順書き。**製品の一覧に触れずに、段の並びだけを確かめる** */
const sample: Procedure = {
  key: "test",
  title: "ためしの手順",
  whenToRead: "ためすとき",
  steps: [
    { command: "novelai.addWork", why: "あ", check: "い" },
    { command: "novelai.extractSettings", why: "う", check: "え" },
    { command: "novelai.unifyCharacters", why: "お", check: "か" },
  ],
};

function start(): TourState {
  const state = startTour(sample, lookup);
  expect(state).toBeDefined();
  return state as TourState;
}

describe("案内の進み方", () => {
  test("順に押すと順に進み、最後で終わる", () => {
    let state = start();
    expect(state.index).toBe(0);
    expect(currentStep(state)?.command).toBe("novelai.addWork");

    const first = observeCommand(state, "novelai.addWork");
    expect(first.kind).toBe("advanced");
    state = first.state;
    expect(currentStep(state)?.command).toBe("novelai.extractSettings");

    const second = observeCommand(state, "novelai.extractSettings");
    expect(second.kind).toBe("advanced");
    state = second.state;

    const third = observeCommand(state, "novelai.unifyCharacters");
    expect(third.kind).toBe("finished");
    state = third.state;
    expect(isTourFinished(state)).toBe(true);
    expect(currentStep(state)).toBeUndefined();
  });

  test("先の段を押したら、そこまで飛ばして進む", () => {
    const state = start();
    const jumped = observeCommand(state, "novelai.unifyCharacters");
    // 3つ目を押したのだから、案内も3つ目まで済んだものとして終わる
    expect(jumped.kind).toBe("finished");
    expect(jumped.state.index).toBe(3);
  });

  test("途中の段へ飛んだときは、その次から案内が続く", () => {
    const state = start();
    const jumped = observeCommand(state, "novelai.extractSettings");
    expect(jumped.kind).toBe("advanced");
    expect(currentStep(jumped.state)?.command).toBe("novelai.unifyCharacters");
  });
});

describe("案内の途中で別のことをしたとき", () => {
  test("手順に無い操作では進まず、案内も消えない", () => {
    const state = start();
    const stray = observeCommand(state, "novelai.openSettingsPanel");
    expect(stray.kind).toBe("ignored");
    // 段はそのまま。**案内そのものが残る**ことが大事（消すと、どこまで
    // やったかを失う）
    expect(currentStep(stray.state)?.command).toBe("novelai.addWork");
    expect(stray.state.index).toBe(0);
    // 寄り道は数えておく（勝手に畳む材料にはしない）
    expect(stray.state.strayCount).toBe(1);
  });

  test("済んだ段を押し直しても後戻りしない。寄り道にも数えない", () => {
    const state = observeCommand(start(), "novelai.addWork").state;
    expect(state.index).toBe(1);

    const again = observeCommand(state, "novelai.addWork");
    expect(again.kind).toBe("ignored");
    expect(again.state.index).toBe(1);
    // やり直しであって寄り道ではない
    expect(again.state.strayCount).toBe(0);
  });

  test("終わった案内は、何を押しても動かない", () => {
    let state = start();
    for (const step of sample.steps) {
      state = observeCommand(state, step.command).state;
    }
    const after = observeCommand(state, "novelai.addWork");
    expect(after.kind).toBe("ignored");
    expect(after.state.index).toBe(3);
  });
});

describe("案内の始めと終わり", () => {
  test("名前を引けない段は落とす", () => {
    const state = startTour(
      {
        ...sample,
        steps: [
          { command: "novelai.存在しない操作", why: "あ", check: "い" },
          ...sample.steps,
        ],
      },
      lookup
    );
    expect(state?.steps.map((step) => step.command)).toEqual(
      sample.steps.map((step) => step.command)
    );
  });

  test("1段も引けなければ、案内を始めない", () => {
    expect(
      startTour(
        {
          ...sample,
          steps: [{ command: "novelai.存在しない操作", why: "あ", check: "い" }],
        },
        lookup
      )
    ).toBeUndefined();
  });

  test("鍵から始められる。知らない鍵では始めない", () => {
    expect(startTourByKey("polish", lookup)?.title).toBe("推敲して仕上げる");
    expect(startTourByKey("そんな手順は無い", lookup)).toBeUndefined();
  });

  test("やめたときは、どこまで進んだかを言う", () => {
    const state = observeCommand(start(), "novelai.addWork").state;
    expect(describeTourEnd(state, "stopped")).toContain("3つのうち1つ目まで");
    // 1つも進んでいなければ、番号を出さない（言うことが無い）
    expect(describeTourEnd(start(), "stopped")).toBe(
      "「ためしの手順」の案内をやめました。"
    );
    expect(describeTourEnd(state, "finished")).toContain("3つすべて");
  });
});

describe("画面へ出す形", () => {
  test("いま何番目かと、押す操作の名前が入る", () => {
    const view = describeStep(start());
    expect(view?.position).toBe("3つのうち1つ目");
    expect(view?.number).toBe(1);
    expect(view?.total).toBe(3);
    expect(view?.command).toBe("novelai.addWork");
    // 名前は `ACTION_TREE` から引いたもの。写しではない
    expect(view?.label).toContain(findAction("novelai.addWork")?.label ?? "");
    expect(view?.why).toBe("あ");
    expect(view?.check).toBe("い");
  });

  test("終わった案内には出す段が無い", () => {
    let state = start();
    for (const step of sample.steps) {
      state = observeCommand(state, step.command).state;
    }
    expect(describeStep(state)).toBeUndefined();
  });
});

describe("製品の手順書きが、そのまま案内にできる", () => {
  test("5本とも、段が1つ以上残る", () => {
    for (const procedure of PROCEDURES) {
      const state = startTour(procedure, lookup);
      expect(
        state,
        `${procedure.title} の段がすべて落ちた（案内を始められない）`
      ).toBeDefined();
      expect(state?.steps.length).toBeGreaterThan(0);
    }
  });

  test("「推敲して仕上げる」は3段のまま（誘い文句の「3手順」の根拠）", () => {
    /*
      相談の答えの下に出る誘いは「画面で案内してもらう：推敲して仕上げる
      （3手順）」である（設計書6.104）。**この数は段の数をそのまま出して
      いる**ので、段が1つ落ちると文言も黙って変わる——落ちる理由は
      「その操作がこの環境の画面に出ない（browserOnly）」など、手順書きを
      直していなくても起こる。**数を名指しで留めておく。**
    */
    const state = startTourByKey("polish", lookup);
    expect(state?.title).toBe("推敲して仕上げる");
    expect(
      state?.steps.length,
      "段が落ちている（誘い文句の手順数がずれる）"
    ).toBe(3);
  });
});
