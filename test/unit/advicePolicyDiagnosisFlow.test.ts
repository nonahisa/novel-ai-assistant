import { beforeEach, describe, expect, test } from "vitest";
import { setAdvicePolicy } from "../../src/features/advicePolicyDiagnosis";
import { AdvicePolicyStore } from "../../src/core/advicePolicyStore";
import {
  ADVICE_QUESTIONS,
  type AdviceProfile,
} from "../../src/core/advicePolicy";
import type { WorkEntry } from "../../src/models/types";
import { window } from "./support/vscodeStub";

/**
 * 相談の助言方針を決める9問（設計書6.86、P-36）。実機確認リスト F-95。
 *
 * QuickPick が実際に画面へ出ることは実機に残るが、**何問出るか・題が
 * どう変わるか・答え終わったあと何が書かれるか・受容度と自信度が
 * 出ていないか**はここで確かめる。
 *
 * **受容度・自信度は見せないと決めたもの**（作者の裁定、2026-09-07）。
 * 見せるとラベルになって、それ自体が地雷になる。
 */

const work: WorkEntry = {
  id: "w_advice",
  title: "いじめられっ子",
  folderPath: "C:/書庫/いじめられっ子",
  registeredAt: "2026-09-08T00:00:00.000Z",
};

/** `vscode.Memento` の代役 */
function memento() {
  const state = new Map<string, unknown>();
  return {
    keys: () => [...state.keys()],
    get: (key: string) => state.get(key),
    update: (key: string, value: unknown) => {
      if (value === undefined) state.delete(key);
      else state.set(key, value);
      return Promise.resolve();
    },
    setKeysForSync: () => undefined,
  };
}

/** 出た問いの題 */
let titles: string[] = [];
/** 出た選択肢の label（問いごと） */
let choices: string[][] = [];
/** 出た知らせ（見出しと説明を繋いだもの） */
let shown: string[] = [];

/**
 * 9問に順番どおり答える作り物。
 * `stopAt` を渡すと、その問い（1始まり）で Esc を押した体になる。
 */
function answerAll(pick: number, stopAt?: number): void {
  let asked = 0;
  Object.assign(window, {
    showQuickPick: async (
      items: Array<Record<string, unknown>>,
      options?: { title?: string }
    ) => {
      asked += 1;
      titles.push(options?.title ?? "");
      choices.push(items.map((item) => String(item.label ?? "")));
      if (stopAt !== undefined && asked === stopAt) return undefined;
      return items[pick];
    },
  });
}

function record(): void {
  Object.assign(window, {
    showInformationMessage: async (message: string, ...rest: unknown[]) => {
      const detail = rest.find(
        (item): item is { detail?: string } =>
          typeof item === "object" && item !== null && "detail" in item
      )?.detail;
      shown.push(detail ? `${message}\n${detail}` : message);
      return undefined;
    },
  });
}

beforeEach(() => {
  titles = [];
  choices = [];
  shown = [];
  record();
  Object.assign(window, {
    showWarningMessage: async () => undefined,
  });
});

describe("はじめての診断", () => {
  test("9問が「相談の助言方針 1/9」の形で順に出る（実機確認リスト F-95 の代わり）", async () => {
    const store = new AdvicePolicyStore(memento() as never);
    answerAll(0);

    await setAdvicePolicy(work, store);

    expect(titles).toHaveLength(ADVICE_QUESTIONS.length);
    expect(titles[0]).toBe("相談の助言方針 1/9");
    expect(titles[8]).toBe("相談の助言方針 9/9");
    // どの問いにも「診断をやめる」を出す（Esc を知らない人にも出口を見せる）
    expect(choices[0].some((label) => label.includes("診断をやめる"))).toBe(true);
  });

  test("途中でやめたら、何も保存しない（実機確認リスト F-95 の代わり）", async () => {
    const state = memento();
    const store = new AdvicePolicyStore(state as never);
    answerAll(0, 3);

    await setAdvicePolicy(work, store);

    expect(state.keys()).toEqual([]);
    expect(shown).toEqual([]);
  });

  test("答え終わると、タイプ名・説明書き・3軸の段階が出る（実機確認リスト F-95 の代わり）", async () => {
    const store = new AdvicePolicyStore(memento() as never);
    // どの問いも先頭（0点）を選ぶと、3軸とも0で「目的模索型」になる
    answerAll(0);

    await setAdvicePolicy(work, store);

    expect(shown).toHaveLength(1);
    const text = shown[0];
    expect(text).toContain("いじめられっ子：助言方針を決めました——目的模索型");
    expect(text).toContain("読者志向：0（低）");
    expect(text).toContain("自己投影度：0（低）");
    expect(text).toContain("嗜好志向：0（低）");
  });

  /** 見せないと決めたものが、結果の画面から漏れていないか */
  test("受容度・自信度は出さない（実機確認リスト F-95 の代わり）", async () => {
    const store = new AdvicePolicyStore(memento() as never);
    answerAll(0);

    await setAdvicePolicy(work, store);

    expect(shown[0]).not.toContain("受容");
    expect(shown[0]).not.toContain("自信");
  });
});

describe("もう一度押したとき", () => {
  /** 診断済み（推定で読者志向が動き、履歴が1件ある）作品 */
  function diagnosed(): AdviceProfile {
    return {
      scores: { reader: 4.5, self: 3, taste: 3 },
      baseScores: { reader: 4, self: 3, taste: 3 },
      answers: [2, 1, 1, 1, 1, 1, 1, 1, 1],
      updatedAt: "2026-09-01T00:00:00.000Z",
      history: [
        {
          typeId: "seeking_purpose",
          scores: { reader: 0, self: 0, taste: 0 },
          updatedAt: "2026-08-01T00:00:00.000Z",
          source: "diagnosis",
        },
      ],
    };
  }

  test("「全部やり直す／いまの方針を見る／方針を消す／取りやめ」が並ぶ（実機確認リスト F-95 の代わり）", async () => {
    const state = memento();
    const store = new AdvicePolicyStore(state as never);
    await store.set(work.id, diagnosed());
    // 何も選ばずに閉じる
    Object.assign(window, {
      showQuickPick: async (items: Array<Record<string, unknown>>) => {
        choices.push(items.map((item) => String(item.label ?? "")));
        return undefined;
      },
    });

    await setAdvicePolicy(work, store);

    expect(choices).toHaveLength(1);
    expect(choices[0]).toEqual([
      "$(refresh) 全部やり直す",
      "$(eye) いまの方針を見る",
      "$(trash) 方針を消す",
      "$(close) 取りやめる",
    ]);
  });

  test("「いまの方針を見る」に、診断時と現在の点数と変化の履歴が出る（実機確認リスト F-95 の代わり）", async () => {
    const store = new AdvicePolicyStore(memento() as never);
    await store.set(work.id, diagnosed());
    Object.assign(window, {
      showQuickPick: async (items: Array<Record<string, unknown>>) => items[1],
    });

    await setAdvicePolicy(work, store);

    const text = shown[0];
    expect(text).toContain("いまの助言方針");
    // 動いた軸は「診断 → 現在」の形で、動いていない軸はいまの値だけ
    expect(text).toContain("読者志向：診断 4 → 現在 4.5（中）");
    expect(text).toContain("自己投影度：3（中）");
    expect(text).toContain("これまでの変化");
    expect(text).toContain("2026-08-01 目的模索型（診断）");
  });

  test("「方針を消す」で、保存したものが消える（実機確認リスト F-95 の代わり）", async () => {
    const state = memento();
    const store = new AdvicePolicyStore(state as never);
    await store.set(work.id, diagnosed());
    Object.assign(window, {
      showQuickPick: async (items: Array<Record<string, unknown>>) => items[2],
      showWarningMessage: async () => "消す",
    });

    await setAdvicePolicy(work, store);

    expect(store.get(work.id)).toBeUndefined();
    expect(shown[0]).toBe("いじめられっ子：相談の助言方針を消しました。");
  });

  test("消すのを断ったら、そのまま残る（実機確認リスト F-95 の代わり）", async () => {
    const store = new AdvicePolicyStore(memento() as never);
    await store.set(work.id, diagnosed());
    Object.assign(window, {
      showQuickPick: async (items: Array<Record<string, unknown>>) => items[2],
      showWarningMessage: async () => undefined,
    });

    await setAdvicePolicy(work, store);

    expect(store.get(work.id)).toBeDefined();
  });
});
