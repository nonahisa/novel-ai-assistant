import { describe, expect, test } from "vitest";
import {
  buildFactVerifyIssue,
  buildKnownCharacterTable,
  describeCandidateTypes,
  describeFactRun,
  describeFactSide,
  factExtractCacheKey,
  FACT_CONTRADICTION_CATEGORY,
  isRecordFact,
  linesAround,
} from "../../src/core/factContradiction";
import { STORY_FACT_EXTRACT_VERSION } from "../../src/prompts/storyFactExtract";
import type { ContradictionCandidate } from "../../src/core/contradictionMatch";
import type { StoryFact } from "../../src/models/storyFact";
import { emptyCharacter } from "../../src/models/character";

/**
 * 矛盾検知（事実の照合）の第4段（設計書6.88）。
 *
 * ここで見るのは、**AIもファイルも触らない部分**だけである——機械が挙げた
 * 候補を1件ずつの検証（6.10.5）へ写すところ、完了報告の文、キャッシュの鍵。
 * この3つは実データで何度も直すことになるので、外から測れる形にしてある。
 */

function fact(overrides: Partial<StoryFact> & { id: string }): StoryFact {
  return {
    id: overrides.id,
    chapter: 3,
    lineRange: [12, 12],
    subject: "char_001",
    predicate: "髪の色",
    value: "銀髪",
    kind: "static",
    storyTime: null,
    modality: "narration",
    pov: null,
    speaker: null,
    topic: null,
    ...overrides,
  };
}

function candidate(
  overrides: Partial<ContradictionCandidate> = {}
): ContradictionCandidate {
  return {
    type: "設定",
    subject: "char_001",
    predicate: "髪の色",
    left: "f1",
    right: "f2",
    confidence: "high",
    fingerprint: "fp1",
    reason: "第3話に『銀髪』、第7話に『黒髪』。あいだに変化の記録が無い",
    ...overrides,
  };
}

describe("候補を、1件ずつの検証へ写す", () => {
  test("前側を「設定では」、後側を「本文では」に置く", () => {
    const issue = buildFactVerifyIssue({
      candidate: candidate(),
      left: fact({ id: "f1", chapter: 3, value: "銀髪" }),
      right: fact({ id: "f2", chapter: 7, lineRange: [40, 40], value: "黒髪" }),
      rightLineText: "  黒髪が風に揺れた。",
    });

    // 引用は**本文の行そのもの**（言い換えると「引用が本文と違う」で落ちる）
    expect(issue.excerpt).toBe("黒髪が風に揺れた。");
    expect(issue.settingSays).toContain("第3話 12行目");
    expect(issue.settingSays).toContain("髪の色＝銀髪");
    expect(issue.textSays).toContain("第7話 40行目");
    expect(issue.textSays).toContain("髪の色＝黒髪");
  });

  test("観点には、候補の型をそのまま渡す", () => {
    // 型ごとに検出率と誤検知率を測る（6.88.7）ので、丸めない
    for (const type of ["設定", "時系列", "状態", "知識"] as const) {
      const issue = buildFactVerifyIssue({
        candidate: candidate({ type }),
        left: fact({ id: "f1" }),
        right: fact({ id: "f2" }),
      });
      expect(issue.category).toBe(type);
    }
  });

  test("補足には、機械が挙げた理由と確信度が入る", () => {
    const issue = buildFactVerifyIssue({
      candidate: candidate({ confidence: "low" }),
      left: fact({ id: "f1" }),
      right: fact({ id: "f2" }),
    });

    expect(issue.note).toContain("あいだに変化の記録が無い");
    expect(issue.note).toContain("確信度: 低");
  });

  test("地の文か台詞かを添える", () => {
    // 人物は嘘をつくし勘違いもする（6.88.3）。同じ強さで見せない
    const issue = buildFactVerifyIssue({
      candidate: candidate(),
      left: fact({ id: "f1" }),
      right: fact({
        id: "f2",
        modality: "dialogue",
        speaker: "char_002",
        value: "黒髪",
      }),
    });

    expect(issue.settingSays).toContain("地の文");
    expect(issue.textSays).toContain("台詞");
  });

  describe("設定資料から組んだ側", () => {
    const record = fact({
      id: "fact:char_001:appearance:1",
      chapter: 1,
      lineRange: [0, 0],
      value: "銀髪",
    });

    test("資料由来かどうかは id で見分ける", () => {
      expect(isRecordFact(record)).toBe(true);
      expect(isRecordFact(fact({ id: "fact:3:12:1" }))).toBe(false);
    });

    test("「設定資料では『値』」と書き、本文の場所を名乗らせない", () => {
      // 資料の事実は話の先頭（0行目）に置いてあるだけで、そこに本文は無い。
      // 「第1話 0行目」と書くと、作者はありもしない行を見に行く
      const text = describeFactSide(record);

      expect(text).toBe("設定資料では『髪の色＝銀髪』");
      expect(text).not.toContain("行目");
    });

    test("後側が資料由来なら、引用も資料の書き方にする", () => {
      const issue = buildFactVerifyIssue({
        candidate: candidate(),
        left: fact({ id: "f1", chapter: 7, value: "黒髪" }),
        right: record,
        // 本文の行が渡っても、資料由来の側には使わない
        rightLineText: "まったく関係のない行",
      });

      expect(issue.excerpt).toBe("設定資料では『髪の色＝銀髪』");
      expect(issue.textSays).toBe("設定資料では『髪の色＝銀髪』");
    });
  });

  test("本文の行が読めなければ、事実の書き方をそのまま引用にする", () => {
    const issue = buildFactVerifyIssue({
      candidate: candidate(),
      left: fact({ id: "f1" }),
      right: fact({ id: "f2", chapter: 7, lineRange: [40, 40], value: "黒髪" }),
    });

    expect(issue.excerpt).toContain("髪の色＝黒髪");
  });
});

describe("前後の行", () => {
  const text = ["1行目", "2行目", "3行目", "4行目", "5行目", "6行目"].join("\n");

  test("行番号付きで、前後を同じ幅だけ切り出す", () => {
    expect(linesAround(text, 3, 1)).toBe("2: 2行目\n3: 3行目\n4: 4行目");
  });

  test("端では、あるぶんだけ出す（外を作らない）", () => {
    expect(linesAround(text, 1, 2)).toBe("1: 1行目\n2: 2行目\n3: 3行目");
    expect(linesAround(text, 6, 2)).toBe("4: 4行目\n5: 5行目\n6: 6行目");
  });

  test("先頭の行番号をずらせる（チャンクの途中から切るため）", () => {
    // 矛盾検知（P-12）は `chunk.startLine + 1` を渡す。振り方が
    // 2か所で食い違うと、片方だけ1行ずれる
    expect(linesAround(text, 11, 1, 10)).toBe("10: 1行目\n11: 2行目\n12: 3行目");
  });
});

describe("分類名", () => {
  test("P-12 の「矛盾」とは別のタブに出す", () => {
    // 作者の裁定で両方をしばらく並行させる（6.88.9）。同じタブへ混ぜると
    // どちらの道が何を見つけたのかを見比べられない
    expect(FACT_CONTRADICTION_CATEGORY).toBe("矛盾（事実の照合）");
    expect(FACT_CONTRADICTION_CATEGORY).not.toBe("矛盾");
  });

  test("候補は型ごとに数える", () => {
    const note = describeCandidateTypes([
      candidate({ type: "設定" }),
      candidate({ type: "状態" }),
      candidate({ type: "状態" }),
    ]);

    // 多い順。同数なら名前で並べて、実行ごとに順が揺れないようにする
    expect(note).toBe("状態 2件、設定 1件");
  });

  test("0件なら何も言わない（うまくいった回のログを汚さない）", () => {
    expect(describeCandidateTypes([])).toBe("");
  });
});

describe("キャッシュの鍵", () => {
  test("版・プロバイダ・モデルで分ける", () => {
    const key = factExtractCacheKey({ providerId: "ollama", model: "gemma4" });

    expect(key).toEqual({
      feature: "story_fact_extract",
      promptVersion: STORY_FACT_EXTRACT_VERSION,
      providerId: "ollama",
      model: "gemma4",
    });
  });

  test("既知の topic は鍵に入らない", () => {
    /*
      topic はチャンクを処理するたびに増える。鍵へ混ぜると2回目以降は
      毎回ぜんぶ再送になり、キャッシュがまったく効かなくなる。
      **鍵の材料は4つだけ**であることを、形ごと固定して見る。
    */
    const key = factExtractCacheKey({ providerId: "ollama", model: "gemma4" });

    expect(Object.keys(key).sort()).toEqual([
      "feature",
      "model",
      "promptVersion",
      "providerId",
    ]);
  });
});

describe("完了報告", () => {
  const base = {
    chunksDone: 3,
    chunksTotal: 3,
    skippedChunks: 0,
    failedChunks: 0,
    acceptedFacts: 40,
    recordFacts: 0,
    rejectedFacts: 0,
    rejectionNote: "",
    candidates: 0,
    candidateNote: "",
    kept: 0,
    verifyNote: "",
    cancelled: false,
  };

  test("候補が0件なら、判定の件数は出さない", () => {
    // 「採用0件」と書くと、AIが見たうえで全部落としたように読める
    const line = describeFactRun(base);

    expect(line).toBe("矛盾検知（事実の照合）を終了: 3/3（事実 40件 / 候補 0件）");
    expect(line).not.toContain("採用");
  });

  test("どの工程で減ったのかを、内訳ごと残す", () => {
    const line = describeFactRun({
      ...base,
      skippedChunks: 2,
      failedChunks: 1,
      recordFacts: 6,
      rejectedFacts: 5,
      rejectionNote: "中身の無い値 3件、発言者の無い台詞 2件",
      candidates: 4,
      candidateNote: "設定 3件、知識 1件",
      kept: 2,
      verifyNote: "検証で 2件を取り下げ（作中の変化 2件）",
    });

    expect(line).toContain("事実 40件");
    expect(line).toContain("設定資料から 6件");
    expect(line).toContain("弾いた 5件（中身の無い値 3件、発言者の無い台詞 2件）");
    expect(line).toContain("候補 4件（設定 3件、知識 1件）");
    expect(line).toContain("採用 2件");
    expect(line).toContain("検証で 2件を取り下げ（作中の変化 2件）");
    expect(line).toContain("読み取れなかった 1件");
    expect(line).toContain("処理済み 2件はスキップ");
  });

  test("中止されたことを黙らない", () => {
    expect(describeFactRun({ ...base, chunksDone: 1, cancelled: true })).toContain(
      "中止された"
    );
  });
});

describe("人物の対応表", () => {
  function person(id: string, name: string, aliases: string[] = []) {
    return { ...emptyCharacter(id, name), aliases };
  }

  test("名前と別名の両方から id を引ける", () => {
    const table = buildKnownCharacterTable([
      person("char_001", "文佳", ["密倉さん", "文佳ちゃん"]),
    ]);

    expect(table.ids.has("char_001")).toBe(true);
    expect(table.names.get("文佳")).toBe("char_001");
    expect(table.names.get("文佳ちゃん")).toBe("char_001");
    expect(table.entries[0]).toEqual({
      id: "char_001",
      name: "文佳",
      aliases: ["密倉さん", "文佳ちゃん"],
    });
  });

  test("2人が同じ表記を名乗っていたら、その表記は表から落とす", () => {
    // どちらか決められないものを片方へ寄せると、別人の事実が1人に混ざる。
    // 落としても事実は消えない（本文の表記のまま通る）
    const table = buildKnownCharacterTable([
      person("char_001", "文佳", ["先生"]),
      person("char_002", "太志", ["先生"]),
    ]);

    expect(table.names.has("先生")).toBe(false);
    expect(table.names.get("文佳")).toBe("char_001");
    expect(table.names.get("太志")).toBe("char_002");
  });

  test("名前と同じ別名・空の別名は並べない", () => {
    const table = buildKnownCharacterTable([
      person("char_001", "文佳", ["文佳", "  ", "密倉さん", "密倉さん"]),
    ]);

    expect(table.entries[0].aliases).toEqual(["密倉さん"]);
  });
});
