import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 小さいモデルの知らせを出す側（`features/smallModelNotice.ts`。設計書6.28.9）。
 *
 * 見張ること：
 * - 作品・モデルごとに、起動中1回だけ（まとめ実行で機能が続いても1回）
 * - 「今後出さない」を選んだら、手元の保管庫に覚えて以後は出さない
 * - 知らせは実行を止めない（通知が出せなくても投げない）
 */

const shown: string[] = [];
let answer: string | undefined;
const executed: string[] = [];

vi.mock("vscode", () => ({
  window: {
    showWarningMessage: vi.fn(async (message: string) => {
      shown.push(message);
      return answer;
    }),
  },
  commands: {
    executeCommand: vi.fn(async (command: string) => {
      executed.push(command);
    }),
  },
}));

vi.mock("../../../src/core/logger", () => ({ logStep: vi.fn() }));

import {
  SMALL_MODEL_NOTICE_ASSIGN,
  SMALL_MODEL_NOTICE_DISMISS,
  installSmallModelNoticeState,
  noticeSmallModelOnce,
  resetSmallModelNoticeForTests,
} from "../../../src/features/smallModelNotice";
import { SMALL_MODEL_NOTICE_STATE_KEY } from "../../../src/core/smallModelNotice";

/** globalState の作り物 */
function memento() {
  const values = new Map<string, unknown>();
  return {
    values,
    get: (key: string, defaultValue?: unknown) =>
      values.has(key) ? values.get(key) : defaultValue,
    update: async (key: string, value: unknown) => {
      values.set(key, value);
    },
  };
}

const small = {
  workFolder: "C:/作品A",
  feature: "typo",
  providerId: "ollama",
  model: "small:8b",
  parameterSize: "8.0B",
};

beforeEach(() => {
  resetSmallModelNoticeForTests();
  shown.length = 0;
  executed.length = 0;
  answer = undefined;
});

afterEach(() => {
  resetSmallModelNoticeForTests();
});

describe("小さいモデルの知らせ", () => {
  test("小さいモデルで検知を動かすと出す", async () => {
    const result = noticeSmallModelOnce(small);
    await result.settled;
    expect(result.shown).toBe(true);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain("このAIは小さいため");
    expect(shown[0]).toContain("small:8b（8.0B）");
  });

  test("同じ作品・同じモデルなら、ほかの機能でも起動中は1回だけ", async () => {
    await noticeSmallModelOnce(small).settled;
    await noticeSmallModelOnce({ ...small, feature: "proofread" }).settled;
    await noticeSmallModelOnce({ ...small, feature: "contradiction" }).settled;
    expect(shown).toHaveLength(1);
  });

  test("作品かモデルが違えば、また出す", async () => {
    await noticeSmallModelOnce(small).settled;
    await noticeSmallModelOnce({ ...small, workFolder: "C:/作品B" }).settled;
    await noticeSmallModelOnce({ ...small, model: "small:12b" }).settled;
    expect(shown).toHaveLength(3);
  });

  test("大きいモデル・大きさ不明・生成には出さない", async () => {
    await noticeSmallModelOnce({ ...small, parameterSize: "25.2B" }).settled;
    await noticeSmallModelOnce({ ...small, parameterSize: null }).settled;
    await noticeSmallModelOnce({ ...small, feature: "generate" }).settled;
    expect(shown).toEqual([]);
  });

  test("「今後出さない」は手元の保管庫に覚え、次の起動でも出さない", async () => {
    const state = memento();
    installSmallModelNoticeState(state);
    answer = SMALL_MODEL_NOTICE_DISMISS;
    await noticeSmallModelOnce(small).settled;
    expect(state.values.get(SMALL_MODEL_NOTICE_STATE_KEY)).toHaveLength(1);

    // 起動し直した（起動中の記憶は消え、保管庫だけが残る）
    resetSmallModelNoticeForTests();
    installSmallModelNoticeState(state);
    const again = noticeSmallModelOnce(small);
    await again.settled;
    expect(again.shown).toBe(false);
    expect(shown).toHaveLength(1);

    // 別の作品では出る（作品ごとに覚える）
    await noticeSmallModelOnce({ ...small, workFolder: "C:/作品B" }).settled;
    expect(shown).toHaveLength(2);
  });

  test("閉じただけなら覚えない（次の起動でまた出す）", async () => {
    const state = memento();
    installSmallModelNoticeState(state);
    await noticeSmallModelOnce(small).settled;
    expect(state.values.has(SMALL_MODEL_NOTICE_STATE_KEY)).toBe(false);
  });

  test("「機能別AI割当を開く」で割当の画面へ進む", async () => {
    answer = SMALL_MODEL_NOTICE_ASSIGN;
    await noticeSmallModelOnce(small).settled;
    expect(executed).toEqual(["novelai.assignFeatureAI"]);
  });
});
