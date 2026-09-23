import { beforeEach, describe, expect, test } from "vitest";
import { runWriterDiagnosis } from "../../../src/features/writerDiagnosis";
import { WriterProfileStore } from "../../../src/core/writerProfileStore";
import { AdvicePolicyStore } from "../../../src/core/advicePolicyStore";
import { AuthorReaderTypeStore } from "../../../src/core/authorReaderTypeStore";
import { ADVICE_QUESTIONS } from "../../../src/core/advicePolicy";
import { WRITER_QUESTIONS } from "../../../src/core/writerStyle";
import {
  AUTHOR_READER_QUESTIONS,
  type AuthorReaderProfile,
} from "../../../src/core/authorReaderType";
import {
  sharedAdviceIndex,
  sharedReaderIndex,
} from "../../../src/core/sharedDiagnosisQuestion";
import { window } from "../support/vscodeStub";

/**
 * 作家タイプ診断に入口をまとめた（作者の裁定、2026-09-23）。
 *
 * 押すと「書き方（5問）／助言の受け方（9問）／読者としての好み（9問）／
 * 全部やる」から選ぶ。似た1問（助言の受け方 Z3 と読者としての好み A3）は
 * 答えを共有し、片方で答えたらもう片方ではその答えを選んだ状態（いちばん上）
 * で出す。
 *
 * 画面（QuickPick）が実際に出ることは実機に残るが、**何が並ぶか・どの問いで
 * 何が選ばれた状態になるか・何が保存されるか**はここで確かめる。
 */

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

type Item = Record<string, unknown>;
interface Asked {
  title: string;
  items: Item[];
}

let asked: Asked[] = [];

/**
 * 画面に出た問いを1つずつ受け、`answer` が返した行を選ぶ。
 * `undefined` を返すと Esc を押した体になる。
 */
function answerWith(answer: (ask: Asked, index: number) => Item | undefined): void {
  Object.assign(window, {
    showQuickPick: async (items: Item[], options?: { title?: string }) => {
      const ask = { title: options?.title ?? "", items };
      asked.push(ask);
      return answer(ask, asked.length - 1);
    },
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
  });
}

function deps() {
  const writer = new WriterProfileStore(memento() as never);
  const advice = new AdvicePolicyStore(memento() as never);
  const reader = new AuthorReaderTypeStore(memento() as never);
  return {
    stores: { writer, advice, reader },
    deps: {
      profiles: writer,
      hasWork: () => false,
      adviceDefault: {
        get: () => advice.getDefault(),
        set: (profile: Parameters<AdvicePolicyStore["setDefault"]>[0]) =>
          advice.setDefault(profile),
      },
      authorReader: {
        get: () => reader.get(),
        set: (profile: AuthorReaderProfile) => reader.set(profile),
      },
    },
  };
}

/** 選択肢のうち、指定の `choice` を持つ行 */
function pickChoice(ask: Asked, choice: string): Item | undefined {
  return ask.items.find((item) => item.choice === choice);
}

beforeEach(() => {
  asked = [];
});

describe("押したときに選ぶもの", () => {
  test("書き方・助言の受け方・読者としての好み・全部やる が、問いの数つきで並ぶ", async () => {
    const { deps: d } = deps();
    answerWith(() => undefined);

    await runWriterDiagnosis(d);

    expect(asked).toHaveLength(1);
    expect(asked[0].title).toBe("作家タイプ診断");
    const labels = asked[0].items.map((item) => String(item.label));
    expect(labels[0]).toContain(`書き方（${WRITER_QUESTIONS.length}問）`);
    expect(labels[1]).toContain(`助言の受け方（${ADVICE_QUESTIONS.length}問）`);
    expect(labels[2]).toContain(
      `読者としての好み（${AUTHOR_READER_QUESTIONS.length}問）`
    );
    expect(labels[3]).toContain("全部やる");
    // 書き方の答えがまだ無いので、「はじめの案内をもう一度」「消す」は出ない
    expect(labels.some((label) => label.includes("もう一度"))).toBe(false);
    // 出口は見える形で置く
    expect(labels[labels.length - 1]).toContain("取りやめる");
  });
});

describe("全部やる", () => {
  /**
   * **似た1問は、助言の受け方で答えたものを選んだ状態で出す**。
   * 読者としての好みの A3 で、いちばん上の行が Z3 で選んだ答えになる。
   */
  test("読者としての好みの似た1問は、助言の受け方の答えがいちばん上に来る", async () => {
    const { deps: d, stores } = deps();
    const adviceAt = sharedAdviceIndex();
    const readerAt = sharedReaderIndex();
    // 1:選ぶ画面 → 5問 → 9問 → 読者の9問（A3 の次でやめる）
    const firstAdvice = 1 + WRITER_QUESTIONS.length;
    const firstReader = firstAdvice + ADVICE_QUESTIONS.length;

    answerWith((ask, index) => {
      if (index === 0) return pickChoice(ask, "all");
      if (index === firstAdvice + adviceAt) {
        // Z3 で「かなり読む」（2点）を選ぶ
        return ask.items.find((item) => item.value === 2);
      }
      if (index === firstReader + readerAt + 1) return undefined; // Esc
      return ask.items[0];
    });

    await runWriterDiagnosis(d);

    const sharedAsk = asked[firstReader + readerAt];
    expect(sharedAsk.title).toContain(`${readerAt + 1}/`);
    // いちばん上の行が、助言の受け方で選んだ答え（2 = かなり読んでいる）
    expect(sharedAsk.items[0].value).toBe(2);
    expect(String(sharedAsk.items[0].description)).toContain(
      "「助言の受け方」で答えたもの"
    );
    // ほかの問いは並びを変えない
    expect(asked[firstReader].items[0].value).toBe(0);

    // 書き方と助言の受け方は保存済み。読者の好みは途中でやめたので保存しない
    expect(stores.writer.get()).toBeDefined();
    expect(stores.advice.getDefault()?.answers[adviceAt]).toBe(2);
    expect(stores.reader.get()).toBeUndefined();
  });
});

describe("1つだけ答える", () => {
  test("助言の受け方だけ：読者としての好みの答えのほうが新しければ、それを選んだ状態で出す", async () => {
    const { deps: d, stores } = deps();
    const readerAnswers = [1, 1, 0, 1, 1, 1, 1, 1, 1];
    await stores.reader.set({
      scores: { familiarity: 3, posture: 3, craving: 3 },
      answers: readerAnswers,
      source: "diagnosis",
      updatedAt: "2026-09-20T00:00:00.000Z",
    } as AuthorReaderProfile);
    const adviceAt = sharedAdviceIndex();

    answerWith((ask, index) => {
      if (index === 0) return pickChoice(ask, "advice");
      return ask.items[0];
    });

    await runWriterDiagnosis(d);

    // 1:選ぶ画面 → 助言の9問だけ（書き方も読者も聞かない）
    expect(asked).toHaveLength(1 + ADVICE_QUESTIONS.length);
    const sharedAsk = asked[1 + adviceAt];
    expect(sharedAsk.items[0].value).toBe(0);
    expect(String(sharedAsk.items[0].description)).toContain(
      "「読者としての好み」で答えたもの"
    );
    // いちばん上を選んで進んだので、写した答えがそのまま保存される
    expect(stores.advice.getDefault()?.answers[adviceAt]).toBe(0);
    // 書き方は聞いていない
    expect(stores.writer.get()).toBeUndefined();
  });

  test("読者としての好みだけ：助言の受け方の答えが無ければ、並びを変えない", async () => {
    const { deps: d, stores } = deps();
    const readerAt = sharedReaderIndex();

    answerWith((ask, index) => {
      if (index === 0) return pickChoice(ask, "reader");
      return ask.items[0];
    });

    await runWriterDiagnosis(d);

    expect(asked).toHaveLength(1 + AUTHOR_READER_QUESTIONS.length);
    const sharedAsk = asked[1 + readerAt];
    expect(sharedAsk.items.slice(0, 3).map((item) => item.value)).toEqual([0, 1, 2]);
    expect(stores.reader.get()?.answers).toHaveLength(
      AUTHOR_READER_QUESTIONS.length
    );
  });
});
