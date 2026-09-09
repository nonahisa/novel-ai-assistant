import { describe, expect, test } from "vitest";
import {
  decideChatter,
  IDLE_THRESHOLD_MS,
  type ChatterState,
} from "../../src/core/chatter";

/**
 * AIの独り言。
 *
 * **間違えると作者の邪魔にしかならない機能である。**
 * 「言うべきことがあるか」より「黙るべきときに黙るか」を重点的に見る。
 */
function state(overrides: Partial<ChatterState> = {}): ChatterState {
  return {
    writtenToday: 0,
    dailyGoal: 0,
    streak: 0,
    pendingUpdates: 0,
    mergeCandidates: 0,
    idleMs: 0,
    saidToday: new Set(),
    ...overrides,
  };
}

const idle = IDLE_THRESHOLD_MS + 1;

describe("黙るべきとき", () => {
  test("何も無ければ黙る", () => {
    expect(decideChatter(state())).toBeUndefined();
  });

  test("同じことを2度言わない", () => {
    const first = decideChatter(state({ writtenToday: 1_200 }));
    expect(first?.text).toContain("1,000文字");

    const again = decideChatter(
      state({ writtenToday: 1_200, saidToday: new Set([first!.key]) })
    );
    expect(again).toBeUndefined();
  });

  test("書いている最中は手伝いを申し出ない", () => {
    // 手が止まっていないところへ「やりましょうか？」は割り込みになる
    const busy = state({ pendingUpdates: 5, idleMs: 0 });

    expect(decideChatter(busy)).toBeUndefined();
  });

  test("手が空いていても、用が無ければ申し出ない", () => {
    // 用も無いのに話しかけると、次から読まれなくなる
    expect(decideChatter(state({ idleMs: idle }))).toBeUndefined();
  });

  test("目標が未設定なら達成を祝わない", () => {
    // 0字の目標を「達成」と言われても意味がない
    expect(decideChatter(state({ writtenToday: 500, dailyGoal: 0 }))).toBeUndefined();
  });

  test("一度に1つしか言わない", () => {
    // まとめて出すと、独り言ではなくお知らせの一覧になる
    const many = state({
      writtenToday: 5_000,
      dailyGoal: 1_000,
      streak: 10,
      pendingUpdates: 3,
      mergeCandidates: 2,
      idleMs: idle,
    });

    expect(decideChatter(many)).toBeDefined();
    // 返り値は単数。配列ではないことを型と併せて固定する
    expect(Array.isArray(decideChatter(many))).toBe(false);
  });
});

describe("祝う", () => {
  test("目標を達成したら、いちばんに祝う", () => {
    // 達成した直後に「抽出やっておきましょうか？」では興が削がれる
    const done = state({
      writtenToday: 2_000,
      dailyGoal: 1_000,
      pendingUpdates: 5,
      idleMs: idle,
    });

    expect(decideChatter(done)?.kind).toBe("goalReached");
  });

  test("節目は、越えたうちのいちばん大きいものだけ言う", () => {
    // 一気に5,000字書いた人へ、1,000・3,000・5,000と3回続けて言わない
    const result = decideChatter(state({ writtenToday: 5_200 }));

    expect(result?.text).toContain("5,000文字");
    expect(result?.key).toBe("milestone:5000");
  });

  test("節目に届いていなければ言わない", () => {
    expect(decideChatter(state({ writtenToday: 999 }))).toBeUndefined();
  });

  test("連続して書いた日数は3日から言う", () => {
    expect(decideChatter(state({ streak: 2 }))).toBeUndefined();
    expect(decideChatter(state({ streak: 3 }))?.kind).toBe("streak");
  });
});

describe("手伝いを申し出る", () => {
  test("承認待ちがあれば、設定資料集を開く口を添える", () => {
    const result = decideChatter(state({ pendingUpdates: 4, idleMs: idle }));

    expect(result?.text).toContain("4件");
    expect(result?.run?.kind).toBe("openSettingsPanel");
  });

  test("重複があれば、まとめる口を添える", () => {
    const result = decideChatter(state({ mergeCandidates: 2, idleMs: idle }));

    expect(result?.run?.kind).toBe("unifyCharacters");
  });

  test("未抽出の話があれば、抽出を申し出る", () => {
    const result = decideChatter(
      state({ unextractedEpisodes: 3, idleMs: idle })
    );

    expect(result?.text).toContain("資料抽出やっておきましょうか");
    expect(result?.run?.kind).toBe("extractSettings");
  });

  test("未抽出の話数が分からなければ抽出を申し出ない", () => {
    // 数えられていないのに「やっておきましょうか」は当てずっぽうになる
    expect(
      decideChatter(state({ unextractedEpisodes: undefined, idleMs: idle }))
    ).toBeUndefined();
  });

  test("誤字脱字は最後に回す", () => {
    // 書いた直後に言うと、粗探しをされているように読める
    const both = state({
      pendingUpdates: 1,
      openManuscriptPath: "C:/works/001.txt",
      writtenToday: 500,
      idleMs: idle,
    });

    expect(decideChatter(both)?.kind).toBe("pendingUpdates");

    const onlyTypos = state({
      openManuscriptPath: "C:/works/001.txt",
      writtenToday: 500,
      idleMs: idle,
    });
    expect(decideChatter(onlyTypos)?.kind).toBe("idleTypos");
  });

  test("その日まだ書いていなければ、誤字脱字を持ち出さない", () => {
    // 開いただけの話を「書き終えたところ」と言わない
    expect(
      decideChatter(
        state({
          openManuscriptPath: "C:/works/001.txt",
          writtenToday: 0,
          idleMs: idle,
        })
      )
    ).toBeUndefined();
  });
});

/**
 * 本文を読んで言う一言（設計書6.21.4、P-34）。
 *
 * ここが返すのは**文面ではなく「取りに行く」印**である。文面はAIに
 * 読ませないと決まらないので、`chatter.ts` は「言ってよいか」までを決める。
 */
describe("本文の感想", () => {
  const wrote = {
    openManuscriptPath: "C:/works/001.txt",
    writtenToday: 500,
    idleMs: idle,
  };

  test("ほかに言うことが無いときだけ取りに行く", () => {
    // **祝いも申し出も、データに基づく確かな発言である。**
    // AIの感想は当たり外れがあるので、確かなものを差し置いて出さない
    expect(decideChatter(state({ ...wrote, pendingUpdates: 1 }))?.kind).toBe(
      "pendingUpdates"
    );
    expect(decideChatter(state(wrote))?.kind).toBe("idleTypos");

    const last = decideChatter(
      state({ ...wrote, saidToday: new Set(["idleTypos"]) })
    );
    expect(last?.kind).toBe("commentRequest");
  });

  test("印には、読ませる本文が入っている", () => {
    const result = decideChatter(
      state({ ...wrote, saidToday: new Set(["idleTypos"]) })
    );

    expect(result).toMatchObject({
      kind: "commentRequest",
      manuscriptPath: "C:/works/001.txt",
    });
  });

  test("同じ話については1日1回まで", () => {
    // 鍵に話を含める。別の話を保存したら、その話については言ってよい
    const first = decideChatter(
      state({ ...wrote, saidToday: new Set(["idleTypos"]) })
    );
    const said = new Set(["idleTypos", first!.key]);

    expect(decideChatter(state({ ...wrote, saidToday: said }))).toBeUndefined();
    expect(
      decideChatter(
        state({
          ...wrote,
          openManuscriptPath: "C:/works/002.txt",
          saidToday: said,
        })
      )?.kind
    ).toBe("commentRequest");
  });

  test("書いている最中は取りに行かない", () => {
    // 手が止まっていないところへ感想を差し込むのは、ただの割り込みである
    expect(
      decideChatter(
        state({ ...wrote, idleMs: 0, saidToday: new Set(["idleTypos"]) })
      )
    ).toBeUndefined();
  });

  test("保存した本文が分からなければ取りに行かない", () => {
    expect(
      decideChatter(
        state({
          writtenToday: 500,
          idleMs: idle,
          saidToday: new Set(["idleTypos"]),
        })
      )
    ).toBeUndefined();
  });
});
