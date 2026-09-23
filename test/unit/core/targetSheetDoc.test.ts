import { describe, expect, test } from "vitest";
import {
  AUTHOR_BLOCK_BEGIN,
  AUTHOR_BLOCK_END,
  buildTargetSheetDoc,
  DEFAULT_AUTHOR_BLOCK,
  extractAuthorBlock,
  isTargetSheetDoc,
  readAimTypes,
  TARGET_SHEET_FILE,
} from "../../../src/core/targetSheetDoc";
import { targetSheetFor } from "../../../src/core/targetSheet";
import type { ReaderProfile, ReaderScores } from "../../../src/models/readerProfile";
import {
  targetSheetCircles,
  type TargetSheetCircles,
} from "../../../src/core/targetSheetCircles";
import {
  TITLE_FIT_SCHEMA_VERSION,
  type TitleFitRecord,
} from "../../../src/core/titleFit";

/**
 * ターゲットシートの紙（設計書6.108.2）。
 *
 * **いちばん守るべきは、作者の欄が作り直しで消えないこと**である
 * （実装ルール2）。ここが壊れると、作者が書いた狙いと理由が黙って
 * 失われる——しかも気づくのは、次に紙を開いたときである。
 */

const SCORES: ReaderScores = { familiarity: 6, posture: 3, craving: 0 };
const AT = new Date("2026-09-21T23:40:00");

function build(authorBlock?: string, scores?: ReaderScores): string {
  return buildTargetSheetDoc({
    workTitle: "テスト作品",
    sheet: targetSheetFor({
      aim: authorBlock ? readAimTypes(authorBlock) : [],
      scores,
    }),
    authorBlock,
    source: scores ? "actual" : undefined,
    generatedAt: AT,
  });
}

describe("作者の欄", () => {
  test("初めて作った紙にも、欄のひな形が入っている", () => {
    const doc = build(undefined, SCORES);
    expect(doc).toContain(AUTHOR_BLOCK_BEGIN);
    expect(doc).toContain(AUTHOR_BLOCK_END);
    expect(extractAuthorBlock(doc)).toBe(DEFAULT_AUTHOR_BLOCK);
  });

  test("作り直しても、作者が書いた欄がそのまま残る", () => {
    const written = "狙い：考察層、没入層\n\n理由：伏線を拾う人に読んでほしい";
    const first = build(written, SCORES);
    // 1枚目から取り出したものを、そのまま2枚目へ運ぶ（実際の手順と同じ）
    const carried = extractAuthorBlock(first);
    expect(carried).toBe(written);

    const second = build(carried, SCORES);
    expect(extractAuthorBlock(second)).toBe(written);
    expect(second).toContain("伏線を拾う人に読んでほしい");
  });

  test("欄が空でも、ひな形を押し付けない", () => {
    // 空文字（作者が消した）と undefined（欄そのものが無い）は別物である
    const doc = build("", SCORES);
    expect(extractAuthorBlock(doc)).toBe("");
  });

  test("印の無い紙からは取り出さない（作者の手書きを上書きしない）", () => {
    expect(extractAuthorBlock("# わたしのターゲット\n\n考察層")).toBeUndefined();
    expect(isTargetSheetDoc("# わたしのターゲット")).toBe(false);
    expect(isTargetSheetDoc(build(undefined, SCORES))).toBe(true);
  });

  test("ファイル名は 設定/ターゲットシート.md", () => {
    expect(TARGET_SHEET_FILE).toBe("ターゲットシート.md");
  });
});

describe("狙いの行の読み取り", () => {
  test("1行目の「狙い：」から、層の名前を読む", () => {
    expect(readAimTypes("狙い：考察層、没入層\n理由：なんとなく")).toEqual([
      "lore_deep",
      "deep_pure",
    ]);
  });

  test("区切りは読点でも中黒でもスラッシュでもよい", () => {
    expect(readAimTypes("狙い：考察層・没入層")).toEqual([
      "lore_deep",
      "deep_pure",
    ]);
    expect(readAimTypes("狙い: 考察層 / 没入層")).toEqual([
      "lore_deep",
      "deep_pure",
    ]);
  });

  test("読めない名前は飛ばし、読めたぶんだけ採る", () => {
    expect(readAimTypes("狙い：考察層、よくわからない層")).toEqual([
      "lore_deep",
    ]);
  });

  test("3つ以上書かれていても2つまで", () => {
    expect(readAimTypes("狙い：考察層、没入層、回遊層")).toEqual([
      "lore_deep",
      "deep_pure",
    ]);
  });

  test("狙いの行が無ければ、狙い無し（推測で当てない）", () => {
    expect(readAimTypes("理由：まだ決めていない")).toEqual([]);
    expect(readAimTypes(DEFAULT_AUTHOR_BLOCK)).toEqual([]);
    // 本文に層の名前が出てきても、狙いの行でなければ拾わない
    expect(readAimTypes("理由：考察層のような人に")).toEqual([]);
  });
});

describe("紙の中身", () => {
  test("点数が無ければ、実態の欄は空で、そう書いてある", () => {
    const doc = build(undefined, undefined);
    expect(doc).toContain("## 実態");
    expect(doc).toContain("まだ測っていません");
    // 数字をでっち上げない
    expect(doc).not.toContain("| 100 |");
  });

  test("11層ぶんの一致度が、いちばん高い層を太字にして並ぶ", () => {
    const doc = build("狙い：考察層", SCORES);
    expect(doc).toContain("**考察層**");
    expect(doc).toContain("| 読者層 | 一致度 | どんな読者か |");
    // 11行ある（見出しと区切りを除く）
    const rows = doc
      .split("\n")
      .filter((line) => /^\| .+ \| \d+ \| /.test(line));
    expect(rows.length).toBe(11);
  });

  test("狙いが書かれていなければ、そう言う（黙って空欄にしない）", () => {
    const doc = build(DEFAULT_AUTHOR_BLOCK, SCORES);
    expect(doc).toContain("狙いが書かれていません");
  });

  test("向かう先は、広げると絞るの2つ", () => {
    const doc = build("狙い：刺激層", SCORES);
    expect(doc).toContain("### 広げる（拡大）");
    expect(doc).toContain("### 絞る（収束）");
  });

  test("助言の欄は、次の版だと書いてある", () => {
    expect(build(undefined, SCORES)).toContain("助言は次の版で入ります");
  });
});

/**
 * 統合した1枚（設計書6.108.6）。
 *
 * 「ターゲット読者」の3段（狙い→書き方の判断→本文の実像）が、この1枚へ
 * 落ちる。ターゲット読者診断の紙・3つの輪の紙に分かれていたものを、
 * **作者が1か所で見られるように**並べる。
 */
describe("統合した1枚", () => {
  const DECLARED: ReaderScores = { familiarity: 0, posture: 0, craving: 0 };

  function buildFull(input: {
    authorBlock?: string;
    profile?: ReaderProfile;
    circles?: TargetSheetCircles;
    titleFit?: TitleFitRecord;
  }): string {
    const scores = input.profile?.actual?.scores ?? input.profile?.declared?.scores;
    return buildTargetSheetDoc({
      workTitle: "テスト作品",
      sheet: targetSheetFor({
        aim: input.authorBlock ? readAimTypes(input.authorBlock) : [],
        scores,
      }),
      authorBlock: input.authorBlock,
      source: input.profile?.actual ? "actual" : scores ? "declared" : undefined,
      profile: input.profile,
      circles: input.circles,
      titleFit: input.titleFit,
      generatedAt: AT,
    });
  }

  const PROFILE: ReaderProfile = {
    schemaVersion: "1",
    declared: {
      scores: DECLARED,
      answers: [0, 0, 0, 0, 0, 0, 0, 0, 0],
      updatedAt: "2026-09-23T00:00:00.000Z",
    },
    actual: {
      scores: SCORES,
      evidence: [{ axis: "familiarity", quote: "説明する暇はなかった", from: "冒頭" }],
      basis: "冒頭",
      model: "test",
      updatedAt: "2026-09-23T00:00:00.000Z",
    },
  };

  test("書き方の判断と本文の実像のずれが出る（2段目と3段目の突き合わせ）", () => {
    const doc = buildFull({ authorBlock: "狙い：考察層", profile: PROFILE });
    expect(doc).toContain("## 書き方の判断と本文の実像");
    expect(doc).toContain("読み慣れ：向けているつもりは0／書けているものは6");
  });

  test("2段目がまだなら、そう言う（黙って飛ばさない）", () => {
    const doc = buildFull({
      authorBlock: "狙い：考察層",
      profile: { schemaVersion: "1", actual: PROFILE.actual },
    });
    expect(doc).toContain("書き方の判断（2段目）にまだ答えていません");
  });

  test("本文の実像の根拠（本文からの引用）が載る", () => {
    const doc = buildFull({ authorBlock: "狙い：考察層", profile: PROFILE });
    expect(doc).toContain("「説明する暇はなかった」");
  });

  test("3つの輪の節が入り、足りない輪はその埋め方を言う", () => {
    const circles = targetSheetCircles({
      aim: ["lore_deep"],
      actual: PROFILE.actual,
    });
    const doc = buildFull({
      authorBlock: "狙い：考察層",
      profile: PROFILE,
      circles,
    });
    expect(doc).toContain("## 3つの輪");
    expect(doc).toContain("あなた自身の読者タイプ");
  });

  test("適合度をまだ測っていなければ、測り方を言う", () => {
    const doc = buildFull({ authorBlock: "狙い：考察層", profile: PROFILE });
    expect(doc).toContain("## タイトルとサブタイトルの適合度");
    expect(doc).toContain("まだ測っていません");
    expect(doc).toContain("「ターゲット読者」");
  });

  test("適合度を測っていれば、題ごとの点と一言、低い順の直す候補が並ぶ", () => {
    const titleFit: TitleFitRecord = {
      schemaVersion: TITLE_FIT_SCHEMA_VERSION,
      measuredAt: "2026-09-23T10:00:00.000Z",
      readerType: "lore_deep",
      basis: "aim",
      model: "gemma",
      items: [
        { id: "title", kind: "title", label: "作品タイトル", text: "鉛の海", score: 70, comment: "重さが届く" },
        { id: "e1", kind: "episode", label: "第1話", text: "目覚め", score: 30, comment: "ありふれている" },
      ],
      unmeasured: 0,
    };
    const doc = buildFull({ authorBlock: "狙い：考察層", profile: PROFILE, titleFit });
    expect(doc).toContain("| 作品タイトル | 鉛の海 | 70 | 重さが届く |");
    expect(doc).toContain("| 第1話 | 目覚め | 30 | ありふれている |");
    expect(doc).toContain("考察層");
    expect(doc).toContain("直す候補");
    // 数字は目安であることを断る
    expect(doc).toContain("目安");
  });

  test("狙いだけの紙でも作れ、実態の欄は「ターゲット読者」の段を案内する", () => {
    const doc = buildFull({ authorBlock: "狙い：考察層" });
    expect(doc).toContain("まだ測っていません");
    expect(doc).not.toContain("ターゲット読者診断");
  });
});
