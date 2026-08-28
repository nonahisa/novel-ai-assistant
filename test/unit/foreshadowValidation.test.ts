import { describe, expect, test } from "vitest";
import {
  locateQuoteInChunk,
  openForeshadowsFingerprint,
  parseForeshadowDetectResult,
  parseForeshadowResolveResult,
  validateForeshadowCandidates,
  validateForeshadowResolutions,
} from "../../src/core/foreshadowValidation";
import type { Chunk } from "../../src/core/chunker";

/**
 * 伏線の検知（P-25 / P-26）の検証（設計書6.35.2・6.35.3）。
 *
 * **AIの出力を信用しない。** ここで押さえるのは4つ。
 *   1. 引用が本文に**逐語で**在るか（言い換えは通さない）
 *   2. 指示の言葉が中身として返っていないか
 *   3. 既に台帳にあるものと重なっていないか（**まとめはコードで行う**）
 *   4. 回収の `id` が実在するか（一覧に無い番号で台帳を書き換えない）
 */

const BODY =
  "銀の懐中時計を、彼はしまい込んだ。\n" +
  "「これは、まだ話せない」\n" +
  "灯は黙って頷いた。";

const chunk: Chunk = {
  filePath: "C:/works/003.txt",
  index: 0,
  text: BODY,
  startLine: 0,
  chapterStart: 3,
  chapterEnd: 3,
  hash: "hash-003",
};

/** 2話ぶんをまとめたチャンク（引用がどちらの話に在るかを分ける） */
const merged: Chunk = {
  filePath: "C:/works/003.txt",
  index: 0,
  text: `${BODY}\n＝＝＝\n第5話の本文。錠前が静かに外れた。`,
  startLine: 0,
  chapterStart: 3,
  chapterEnd: 5,
  hash: "hash-merged",
  segments: [
    {
      filePath: "C:/works/003.txt",
      chapterStart: 3,
      chapterEnd: 3,
      start: 0,
      end: BODY.length,
      startLine: 0,
    },
    {
      filePath: "C:/works/005.txt",
      chapterStart: 5,
      chapterEnd: 5,
      start: BODY.length,
      end: BODY.length + 30,
      startLine: 0,
    },
  ],
};

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    label: "銀の懐中時計",
    note: "まだ話せない事情があることを示している",
    quote: "銀の懐中時計を、彼はしまい込んだ",
    ...overrides,
  };
}

function detect(items: unknown[], known: Array<{ label: string; plantedQuote: string }> = [], target = chunk) {
  return validateForeshadowCandidates({ foreshadows: items }, target, known);
}

describe("応答の読み取り", () => {
  test("コードフェンス付きでも読める", () => {
    const parsed = parseForeshadowDetectResult(
      '```json\n{"foreshadows":[{"label":"鍵"}]}\n```'
    );

    expect(parsed?.foreshadows).toHaveLength(1);
  });

  test("前置きが付いていても読める", () => {
    const parsed = parseForeshadowResolveResult(
      'はい、確認しました。\n{"resolutions":[]}'
    );

    expect(parsed?.resolutions).toEqual([]);
  });

  test("読めなければ null", () => {
    expect(parseForeshadowDetectResult("見つかりませんでした")).toBeNull();
    expect(parseForeshadowResolveResult("{}")).toBeNull();
  });
});

describe("配置の候補（P-25）", () => {
  test("本文に逐語で在る引用は通す", () => {
    const result = detect([candidate()]);

    expect(result.rejected).toHaveLength(0);
    expect(result.accepted[0]).toMatchObject({
      label: "銀の懐中時計",
      quote: "銀の懐中時計を、彼はしまい込んだ",
      filePath: "C:/works/003.txt",
      chapter: 3,
      chunkHash: "hash-003",
    });
  });

  test("言い換えた引用は捨てる", () => {
    // **本文に無い箇所を「引用」してくる。** 実在しない引用では、
    // その候補が何を指しているのか作者に確かめようがない
    const result = detect([
      candidate({ quote: "彼は銀の時計をポケットへ入れた" }),
    ]);

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("quote_not_found");
  });

  test("空白やバイト表記の揺れは吸収する", () => {
    // gemma系は全角スペースをバイト表記のまま返すことがある
    const result = detect([
      candidate({ quote: "銀の懐中時計を、<0xE3><0x80><0x80>彼はしまい込んだ" }),
    ]);

    expect(result.accepted).toHaveLength(1);
  });

  test("指示の言葉が返ってきたら弾く", () => {
    // 「該当なし」も、プロンプトの出力例に書いた言い換えも、中身ではない
    const result = detect([
      candidate({ label: "該当なし" }),
      candidate({ label: "一覧の見出しにする名前" }),
      candidate({ quote: "本文からそのまま写した引用" }),
    ]);

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected.map((entry) => entry.reason)).toEqual([
      "placeholder",
      "placeholder",
      "placeholder",
    ]);
  });

  test("示唆が中身の無い言葉なら、空にして候補は残す", () => {
    // 引用は実在するので、候補そのものは作者に見せる価値がある
    const result = detect([candidate({ note: "特になし" })]);

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].note).toBe("");
  });

  test("長すぎる名前は切り詰める（候補ごと捨てない）", () => {
    const result = detect([candidate({ label: "あ".repeat(30) })]);

    expect(result.accepted[0].label).toBe(`${"あ".repeat(15)}…`);
  });

  test("名前や引用が無ければ形が違う", () => {
    const result = detect([
      { note: "示唆だけ" },
      { label: "鍵", quote: 42 },
      "文字列",
    ]);

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected.map((entry) => entry.reason)).toEqual([
      "shape",
      "shape",
      "shape",
    ]);
  });

  describe("既存の台帳との重なり", () => {
    test("同じ引用は出さない", () => {
      const result = detect(
        [candidate()],
        [{ label: "懐中時計のこと", plantedQuote: "銀の懐中時計を、彼はしまい込んだ" }]
      );

      expect(result.accepted).toHaveLength(0);
      expect(result.rejected[0].reason).toBe("duplicate");
    });

    test("同じ名前も出さない", () => {
      const result = detect(
        [candidate()],
        [{ label: "銀の懐中時計", plantedQuote: "別の箇所の引用" }]
      );

      expect(result.rejected[0].reason).toBe("duplicate");
    });

    test("同じ応答の中で二度出たら、2件目を落とす", () => {
      const result = detect([candidate(), candidate()]);

      expect(result.accepted).toHaveLength(1);
      expect(result.rejected[0].reason).toBe("duplicate");
    });
  });

  test("まとめたチャンクでは、引用が在る話の話数を付ける", () => {
    // チャンク全体の話数を付けると、第5話にしか無い記述が
    // 「第3話で張った」になる
    const result = detect(
      [candidate({ label: "外れた錠前", quote: "錠前が静かに外れた" })],
      [],
      merged
    );

    expect(result.accepted[0]).toMatchObject({
      filePath: "C:/works/005.txt",
      chapter: 5,
    });
  });
});

describe("回収の候補（P-26）", () => {
  function resolve(
    items: unknown[],
    open = [{ id: "foreshadow_001", plantedQuote: "動かない時計" }]
  ) {
    return validateForeshadowResolutions({ resolutions: items }, chunk, open);
  }

  test("一覧にある伏線で、引用が実在すれば通す", () => {
    const result = resolve([
      {
        id: "foreshadow_001",
        quote: "「これは、まだ話せない」",
        note: "話せない事情が明かされた",
      },
    ]);

    expect(result.rejected).toHaveLength(0);
    expect(result.accepted[0]).toMatchObject({
      id: "foreshadow_001",
      chapter: 3,
      filePath: "C:/works/003.txt",
    });
  });

  test("一覧に無い番号は捨てる", () => {
    // **番号を作ってくる。** 実在しない伏線を回収済みにはできない
    const result = resolve([
      { id: "foreshadow_999", quote: "「これは、まだ話せない」", note: "" },
    ]);

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("unknown_id");
  });

  test("回収の根拠が本文に無ければ捨てる", () => {
    // 誤って回収済みの印が付くと、作者は安心して回収を忘れる
    const result = resolve([
      { id: "foreshadow_001", quote: "彼は時計の秘密を打ち明けた", note: "" },
    ]);

    expect(result.rejected[0].reason).toBe("quote_not_found");
  });

  test("張った箇所そのものを回収と言い張ったら弾く", () => {
    // 同じ話も回収検知の対象にしたので（0.24.10）、張った文が
    // 同じチャンクに居る。それを回収と誤認されると台帳が誤って閉じる
    const result = resolve(
      [
        {
          id: "foreshadow_001",
          quote: "「これは、まだ話せない」",
          note: "",
        },
      ],
      [{ id: "foreshadow_001", plantedQuote: "「これは、まだ話せない」" }]
    );

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("planted_echo");
  });

  test("指示の言葉が返ってきたら弾く", () => {
    const result = resolve([
      { id: "foreshadow_001", quote: "回収している箇所の引用", note: "" },
    ]);

    expect(result.rejected[0].reason).toBe("placeholder");
  });

  test("同じ伏線を二度回収したことにしない", () => {
    const result = resolve([
      { id: "foreshadow_001", quote: "「これは、まだ話せない」", note: "" },
      { id: "foreshadow_001", quote: "灯は黙って頷いた", note: "" },
    ]);

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected[0].reason).toBe("duplicate");
  });
});

describe("引用の位置", () => {
  test("内訳をまたぐ引用は、話数を付けずに通す", () => {
    // チャンク全体には在るので捏造ではない。**推測で話数を埋めない**
    const at = locateQuoteInChunk(merged, "灯は黙って頷いた。\n＝＝＝\n第5話の本文");

    expect(at).toEqual({ filePath: "C:/works/003.txt", chapter: null });
  });

  test("どこにも無ければ undefined", () => {
    expect(locateQuoteInChunk(chunk, "存在しない一文")).toBeUndefined();
  });

  test("空の引用は通さない", () => {
    // 正規化で空になる引用は、どんな本文にも「含まれる」ことになってしまう
    expect(locateQuoteInChunk(chunk, "　 ")).toBeUndefined();
  });
});

describe("未回収の集合の指紋", () => {
  const record = {
    id: "foreshadow_001",
    updatedAt: "2026-08-28T00:00:00.000Z",
    label: "銀の懐中時計",
    note: "",
    plantedQuote: "銀の懐中時計を、彼はしまい込んだ",
    plantedChapter: 3,
  };

  test("同じ集合なら同じ", () => {
    expect(openForeshadowsFingerprint([record])).toBe(
      openForeshadowsFingerprint([{ ...record }])
    );
  });

  test("1件増えれば変わる", () => {
    // **台帳が変われば判定も変わる。** 変わらないと、伏線を足したのに
    // 前回の結果が返り続ける
    expect(openForeshadowsFingerprint([record])).not.toBe(
      openForeshadowsFingerprint([record, { ...record, id: "foreshadow_002" }])
    );
  });

  test("更新時刻が変われば変わる", () => {
    expect(openForeshadowsFingerprint([record])).not.toBe(
      openForeshadowsFingerprint([
        { ...record, updatedAt: "2026-08-29T00:00:00.000Z" },
      ])
    );
  });

  test("時刻が同じでも、中身を手で直せば変わる", () => {
    // 作者がJSONを直接編集して時刻を書き換えなかった場合でも拾う
    expect(openForeshadowsFingerprint([record])).not.toBe(
      openForeshadowsFingerprint([{ ...record, note: "書き足した示唆" }])
    );
  });
});
