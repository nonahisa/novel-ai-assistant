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
import type { TargetSheetWrittenRecord } from "../../../src/core/targetSheetWritten";
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

  test("紙の印は、いまの入口（「ターゲット読者」）を指す", () => {
    // 旧「ターゲットシート」の命令は「ターゲット読者」へ転送する形にした
    // （2026-09-23）。紙の上で古い名前を案内すると、詳細メニューで見つからない
    const doc = build(undefined, SCORES);
    expect(doc).toContain("「ターゲット読者」で作り直されます");
    expect(doc).not.toContain("「ターゲットシート」で作り直されます");
  });

  test("古い印の紙も、この紙が作ったものとして扱う（作り直せなくならない）", () => {
    // 0.82.2 までの紙は古い印を持つ。印を変えただけで「作者の手書き」に
    // 見えると、作り直しを断るようになってしまう
    const old = [
      "# ターゲットシート",
      "",
      "<!-- このファイルは「ターゲットシート」で作り直されます。 -->",
    ].join("\n");
    expect(isTargetSheetDoc(old)).toBe(true);
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
    written?: TargetSheetWrittenRecord;
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
      written: input.written,
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

  test("3つの輪の節は、別の紙へ案内しない（シートの中に一本化した）", () => {
    // 作者の裁定（2026-09-23）「ターゲットシートと3つの輪は完全統合」。
    // 単独の3つの輪の紙を作る道はやめたので、そこへ案内すると押す先が無い
    const circles = targetSheetCircles({
      aim: ["lore_deep"],
      actual: PROFILE.actual,
    });
    const doc = buildFull({
      authorBlock: "狙い：考察層",
      profile: PROFILE,
      circles,
    });
    expect(doc).not.toContain("3つの輪の紙");
  });

  /*
    実績と近づける道（作者の裁定、2026-09-23）。単独の3つの輪の紙を
    取り除いたときに、どこにも出なくなっていたものをシートへ移した。
  */

  /** 見出しから次の同じ深さの見出しまでを切り出す */
  function section(doc: string, heading: string): string {
    const lines = doc.split("\n");
    const start = lines.findIndex((line) => line === `## ${heading}`);
    expect(start, `節が無い: ${heading}`).toBeGreaterThanOrEqual(0);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => line.startsWith("## "));
    return (end === -1 ? rest : rest.slice(0, end)).join("\n");
  }

  /** 3本とも離れている輪（作者は考察層寄り・狙いはすきま層・実像は開拓層寄り） */
  function apartCircles(): TargetSheetCircles {
    return targetSheetCircles({
      authorReader: { scores: { familiarity: 6, posture: 4, craving: 0 } },
      aim: ["light"],
      actual: {
        scores: { familiarity: 6, posture: 0, craving: 6 },
        evidence: [],
        basis: "冒頭",
        model: "test",
        updatedAt: "2026-09-23T00:00:00.000Z",
      },
    });
  }

  const FILLED: TargetSheetWrittenRecord = {
    facts: {
      episodes: 19,
      chars: 41000,
      days: { active: 32, streak: 5 },
    },
    reactions: [
      { site: "小説家になろう", metrics: "PV 1,234／ブックマーク 89", readAt: "2026-09-19" },
    ],
  };

  test("実績の節は3つの輪の下にあり、数えられたことだけを並べる", () => {
    const doc = buildFull({
      authorBlock: "狙い：すきま層",
      profile: PROFILE,
      circles: apartCircles(),
      written: FILLED,
    });

    const circlesAt = doc.indexOf("## 3つの輪");
    expect(circlesAt).toBeGreaterThanOrEqual(0);
    expect(doc.indexOf("## 近づける道")).toBeGreaterThan(circlesAt);
    expect(doc.indexOf("## 書けたものの実績")).toBeGreaterThan(
      doc.indexOf("## 近づける道")
    );

    const written = section(doc, "書けたものの実績");
    expect(written).toContain("- 書き切ったのは19話、合計41,000字。");
    expect(written).toContain("- 書いた日は32日。いまは5日続いています。");
    expect(written).toContain(
      "- 小説家になろう：PV 1,234／ブックマーク 89（2026-09-19 時点）"
    );
    // 限界の宣告にしない（作者の裁定、2026-09-19）
    expect(written).toContain("ここに無いものが書けない、という意味ではありません");
    expect(doc).not.toContain("書けるもの");
  });

  test("記録が無ければ「まだ記録がありません」と断る（0話・0字を並べない）", () => {
    const written = section(
      buildFull({
        authorBlock: "狙い：考察層",
        written: { facts: {}, reactions: [] },
      }),
      "書けたものの実績"
    );

    expect(written).toContain("まだ記録がありません。本文が増えると");
    expect(written).toContain("まだ記録がありません。投稿サイトの数字を");
    expect(written).not.toContain("0話");
    expect(written).not.toContain("0字");
    expect(written.split("\n").filter((line) => line.startsWith("- "))).toEqual([]);
  });

  test("反応の台帳を読めなかったときは、「まだ記録がありません」と言わない", () => {
    const written = section(
      buildFull({ authorBlock: "狙い：考察層", written: { facts: {} } }),
      "書けたものの実績"
    );
    const reactions = written.slice(written.indexOf("### 届いている反応"));

    expect(reactions).toContain("投稿の記録を読めませんでした");
    expect(reactions).not.toContain("まだ記録がありません");
  });

  test("実績を渡さなければ、節ごと出さない（古い呼び出し元のため）", () => {
    expect(buildFull({ authorBlock: "狙い：考察層" })).not.toContain(
      "## 書けたものの実績"
    );
  });

  test("近づける道は、どれを動かすかを作者に任せる形で並ぶ", () => {
    const bridge = section(
      buildFull({ authorBlock: "狙い：すきま層", circles: apartCircles() }),
      "近づける道"
    );

    expect(bridge).toContain("いま突き合わせられた3本は、どれも離れています");
    expect(bridge).toContain("- **読んでもらいたい読者を動かす（狙いを寄せる）**");
    expect(bridge).toContain("- **書けているものを動かす（書ける範囲を広げる）**");
    expect(bridge).toContain("- **書きたいものを動かす（題材を選び直す）**");
    expect(bridge).toContain("どれも動かさない、という選び方もあります");
    expect(bridge).not.toContain("重なっていません");
  });

  test("離れていない輪があれば、近づける道は出さない", () => {
    const circles = targetSheetCircles({
      aim: ["lore_deep"],
      actual: PROFILE.actual,
    });
    expect(
      buildFull({ authorBlock: "狙い：考察層", profile: PROFILE, circles })
    ).not.toContain("## 近づける道");
  });

  test("実績と近づける道を足しても、作者の欄はそのまま運ばれる", () => {
    const block = "狙い：すきま層\n\n理由：軽く読める話に\nメモ：第2部で見直す";
    const doc = buildFull({
      authorBlock: block,
      circles: apartCircles(),
      written: FILLED,
    });
    expect(extractAuthorBlock(doc)).toBe(block);
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

  /*
    助言の構え（プロンプト設計書1.9、作者の方針 2026-09-24）。
    「無理に助言を言わなくてもいい。ほめることができる場所は、省略せずきちんとほめて」。
    前は点の高低に関わらず、低い順の5つを必ず「直す候補」に挙げていた。
  */
  function fitOf(items: Array<[string, string, number, string]>): TitleFitRecord {
    return {
      schemaVersion: TITLE_FIT_SCHEMA_VERSION,
      measuredAt: "2026-09-23T10:00:00.000Z",
      readerType: "lore_deep",
      basis: "aim",
      model: "gemma",
      items: items.map(([id, text, score, comment], index) => ({
        id,
        kind: index === 0 ? "title" : "episode",
        label: index === 0 ? "作品タイトル" : `第${index}話`,
        text,
        score,
        comment,
      })),
      unmeasured: 0,
    };
  }

  test("どの題もよく届いていれば「直す候補は見当たりません」と書き、届いている題を並べる（1.9）", () => {
    const doc = buildFull({
      authorBlock: "狙い：考察層",
      profile: PROFILE,
      titleFit: fitOf([
        ["title", "鉛の海", 88, "重さが届く"],
        ["e1", "目覚め", 75, "謎の入口になっている"],
      ]),
    });
    expect(doc).toContain("直す候補は見当たりません");
    expect(doc).toContain("よく届いている題");
    expect(doc).toContain("謎の入口になっている");
    // 届いている題を、直す候補の欄より先に出す
    expect(doc.indexOf("よく届いている題")).toBeLessThan(doc.indexOf("直す候補"));
  });

  test("よく届いている題は直す候補に入れない（点の高い題まで直させない）", () => {
    const doc = buildFull({
      authorBlock: "狙い：考察層",
      profile: PROFILE,
      titleFit: fitOf([
        ["title", "鉛の海", 90, "重さが届く"],
        ["e1", "目覚め", 30, "ありふれている"],
      ]),
    });
    const candidates = doc.slice(doc.indexOf("### 直す候補"));
    expect(candidates).toContain("目覚め");
    expect(candidates).not.toContain("鉛の海");
    expect(doc).not.toContain("直す候補は見当たりません");
  });

  test("狙いだけの紙でも作れ、実態の欄は「ターゲット読者」の段を案内する", () => {
    const doc = buildFull({ authorBlock: "狙い：考察層" });
    expect(doc).toContain("まだ測っていません");
    expect(doc).not.toContain("ターゲット読者診断");
  });
});
