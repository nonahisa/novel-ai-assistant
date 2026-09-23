import { describe, expect, test } from "vitest";
import {
  READER_GAP_THRESHOLD,
  READER_TYPES,
  resolveReaderType,
} from "../../src/core/readerTarget";
import type { ReaderProfile, ReaderScores } from "../../src/models/readerProfile";
import { authorReaderProfileFromAnswers } from "../../src/core/authorReaderType";
import type { AuthorReaderProfile } from "../../src/core/authorReaderType";
import { compareAuthorReader } from "../../src/core/authorReaderGap";
import { buildReaderGuide } from "../../src/core/readerTargetDoc";

/**
 * **作者自身の読者タイプと、その作品のターゲット読者のズレ**
 * （設計書6.101、実装の順「2」）。
 *
 * **既にある `readerGaps` とは別のズレである。** あちらは同じ作品の中の
 * 「作者の宣言 vs 本文の実像」で、こちらは「作者自身の読み方 vs
 * この作品の宛先」。流用はしないが、**作法は揃える**——
 * 2点未満は言わないことと、どちらが正しいとも言わないこと。
 *
 * ここで守るのは4つ。
 *
 * 1. **材料が無いときは黙る**（推測で埋めない）
 * 2. **重なっているときも言う**（珍しくて値打ちのある状態）
 * 3. **上下を作らない**——「あなたの読み癖は的外れ」と読まれたら終わり
 * 4. **決めつけない**——「こう読む人だから、こう書きがち」へ踏み込まない
 */

function scores(
  familiarity: number,
  posture: number,
  craving: number
): ReaderScores {
  return { familiarity, posture, craving };
}

/** 作者側のプロフィール（点数を直に置く） */
function author(value: ReaderScores): AuthorReaderProfile {
  return {
    ...authorReaderProfileFromAnswers(
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      new Date("2026-09-19T00:00:00.000Z")
    ),
    scores: value,
  };
}

/** 作品側の台帳（宣言だけ／実像だけ を作り分ける） */
function work(
  value: ReaderScores,
  kind: "declared" | "actual" = "declared"
): ReaderProfile {
  const updatedAt = "2026-09-19T00:00:00.000Z";
  return kind === "declared"
    ? { schemaVersion: "1", declared: { scores: value, answers: [], updatedAt } }
    : {
        schemaVersion: "1",
        actual: {
          scores: value,
          evidence: [],
          basis: "冒頭",
          model: "test",
          updatedAt,
        },
      };
}

/** 考察層（読み慣れが主・読む姿勢が副） */
const LORE_DEEP = scores(6, 4, 0);
/** すきま層（どの軸も低い） */
const LIGHT = scores(0, 0, 0);

describe("材料が無いときは黙る", () => {
  test("作者の読者タイプが未診断なら、何も言わない", () => {
    expect(compareAuthorReader(undefined, work(LIGHT))).toBeUndefined();
  });

  test("作品のターゲットが未診断なら、何も言わない", () => {
    expect(compareAuthorReader(author(LORE_DEEP), undefined)).toBeUndefined();
    // 台帳はあるが、宣言も実像も入っていない
    expect(
      compareAuthorReader(author(LORE_DEEP), { schemaVersion: "1" })
    ).toBeUndefined();
  });

  test("両方あっても、差が2点未満なら言わない（6.91と同じ作法）", () => {
    // 名前は違うが、どの軸も選択肢1つぶんしか離れていない。
    // ここを「ズレています」と言うと、当たらない指摘で信用を失う
    const a = scores(4, 4, 2);
    const w = scores(5, 4, 2);
    expect(resolveReaderType(a)).not.toBe(resolveReaderType(w));
    expect(READER_GAP_THRESHOLD).toBe(2);
    expect(compareAuthorReader(author(a), work(w))).toBeUndefined();
  });
});

describe("ズレているとき", () => {
  const result = compareAuthorReader(author(LORE_DEEP), work(LIGHT));

  test("両方の層の名前と、効くこと・離れるところが出る", () => {
    expect(result?.kind).toBe("gap");
    const text = result?.lines.join("\n") ?? "";

    const mine = READER_TYPES[resolveReaderType(LORE_DEEP)];
    const theirs = READER_TYPES[resolveReaderType(LIGHT)];
    expect(text).toContain(mine.label);
    expect(text).toContain(mine.works);
    expect(text).toContain(theirs.label);
    expect(text).toContain(theirs.works);
    expect(text).toContain(theirs.loses);
  });

  test("**どちらも正しい、と書いてある**", () => {
    const text = result?.lines.join("\n") ?? "";
    expect(text).toContain("どちらの読み方も正しく");
    expect(text).toContain("効く相手が違うだけ");
  });

  test("作品側の出どころ（宣言／実像）を言う", () => {
    expect(result?.workSource).toBe("declared");
    expect(result?.lines.join("\n")).toContain("向けているつもり");

    const fromBody = compareAuthorReader(
      author(LORE_DEEP),
      work(LIGHT, "actual")
    );
    expect(fromBody?.workSource).toBe("actual");
    expect(fromBody?.lines.join("\n")).toContain("書けているもの");
  });
});

describe("重なっているとき", () => {
  const result = compareAuthorReader(author(LORE_DEEP), work(LORE_DEEP));

  test("重なっていることを、値打ちとして言う", () => {
    expect(result?.kind).toBe("overlap");
    const text = result?.lines.join("\n") ?? "";
    expect(text).toContain("同じです");
    expect(text).toContain("直感");
  });

  test("その層に効くこと・離れるところも添える", () => {
    const type = READER_TYPES[resolveReaderType(LORE_DEEP)];
    const text = result?.lines.join("\n") ?? "";
    expect(text).toContain(type.works);
    expect(text).toContain(type.loses);
  });
});

describe("上下を作らない・決めつけない", () => {
  const texts = [
    compareAuthorReader(author(LORE_DEEP), work(LIGHT)),
    compareAuthorReader(author(LIGHT), work(LORE_DEEP)),
    compareAuthorReader(author(LORE_DEEP), work(LORE_DEEP)),
  ].map((result) => result?.lines.join("\n") ?? "");

  test("格付けに読める言葉を使わない", () => {
    // 「あなたの読み癖は的外れ」と読まれたら終わりである
    const banned = [
      "的外れ",
      "間違",
      "誤り",
      "劣",
      "優れ",
      "上等",
      "浅い",
      "深い読者",
      "直すべき",
      "直してください",
      "ずれています",
      "向いていません",
      "できていません",
      "足りません",
    ];
    for (const text of texts) {
      for (const word of banned) {
        expect(text, word).not.toContain(word);
      }
    }
  });

  test("**作者の書き方を決めつけない**", () => {
    // 「あなたはこう読む人だから、こう書きがちです」は一歩で決めつけになる。
    // 読み方の違いを並べるに留める
    const banned = ["書きがち", "書いてしまい", "書けていない", "偏って"];
    for (const text of texts) {
      for (const word of banned) {
        expect(text, word).not.toContain(word);
      }
    }
  });

  test("画面にそのまま出せる（Markdownの記号を混ぜない）", () => {
    // ダイアログと選択肢の説明はプレーンテキストである（`plainTextUi.test.ts`）。
    // 同じ文を紙にも使うので、記号は混ぜない
    for (const text of texts) {
      expect(text).not.toContain("**");
      expect(text).not.toContain("##");
    }
  });
});

describe("読者像の紙（設計書6.91）にも出す", () => {
  const profile = work(LIGHT);

  test("作者の読者タイプが未診断なら、節ごと出さない", () => {
    const paper = buildReaderGuide({ workTitle: "湖畔の誓い", profile });
    expect(paper).not.toContain("あなた自身の読み方");
    expect(paper).not.toContain("重なっています");
  });

  test("ズレているときは、突き合わせの節が出る", () => {
    const paper = buildReaderGuide({
      workTitle: "湖畔の誓い",
      profile,
      authorReader: author(LORE_DEEP),
    });
    expect(paper).toContain("## あなた自身の読み方と、この作品の宛先");
    expect(paper).toContain("どちらの読み方も正しく");
  });

  test("重なっているときも、節が出る", () => {
    const paper = buildReaderGuide({
      workTitle: "湖畔の誓い",
      profile,
      authorReader: author(LIGHT),
    });
    expect(paper).toContain("重なっています");
    expect(paper).toContain("直感");
  });

  test("作品の中のズレ（宣言 vs 実像）の節と、取り違えない", () => {
    // `readerGaps` は同じ作品の中の別のズレである。見出しで見分けられること
    const both: ReaderProfile = {
      ...work(LIGHT),
      actual: work(LORE_DEEP, "actual").actual,
    };
    const paper = buildReaderGuide({
      workTitle: "湖畔の誓い",
      profile: both,
      authorReader: author(LORE_DEEP),
    });
    expect(paper).toContain("## 向けているつもりと、書けているもの");
    expect(paper).toContain("## あなた自身の読み方と、この作品の宛先");
  });
});
