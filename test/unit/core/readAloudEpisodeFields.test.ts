import { describe, expect, it } from "vitest";
import { buildReadingPlan } from "../../../src/core/readAloud";
import { episodeReadableRanges, parseEpisodeMetadata } from "../../../src/core/metadataParser";

/**
 * 読み上げと音声の書き出しで、題と本文だけを読む（2026-11-08 作者の答え。設計書6.42・6.42.4）。
 *
 * 作者の実機では、カクヨム形式の頭の欄（【公開状態】下書き・【作成日時】…・【文字数】5,529文字）を
 * 本文として読んでいた。**光らせる位置は画面の字の位置のまま**でなければならないので、
 * 字を切り取らずに、文に分けたあとで範囲の外の文を落とす。
 */

const KAKUYOMU = [
  "【タイトル】",
  "第一話　はじまり",
  "",
  "【公開状態】",
  "下書き",
  "",
  "【作成日時】",
  "2026-11-01 10:00:00（+09:00）",
  "",
  "【公開日時】",
  "",
  "",
  "【更新日時】",
  "2026-11-08 09:00:00（+09:00）",
  "",
  "【文字数】",
  "5,529文字",
  "",
  "【前書き】",
  "読んでくださってありがとうございます。",
  "",
  "【本文（3行）】",
  "朝が来た。灯は窓を開けた。",
  "「行こう」と蓮は言った。",
  "",
  "【後書き】",
  "次回もお楽しみに。",
  "",
  "【リアクション】",
  "応援 3",
].join("\n");

function speeches(text: string): string[] {
  return buildReadingPlan(text, "site").map((s) => s.speech);
}

describe("カクヨム形式の頭の欄・前書き・後書きを読まない", () => {
  it("題（中身だけ）と本文の文だけが計画に残る", () => {
    expect(speeches(KAKUYOMU)).toEqual([
      "第一話　はじまり",
      "朝が来た。",
      "灯は窓を開けた。",
      "「行こう」と蓮は言った。",
    ]);
  });

  it("頭の欄・前書き・後書きの字は、どの文にも入らない", () => {
    const all = speeches(KAKUYOMU).join("");
    for (const word of ["タイトル", "公開状態", "下書き", "作成日時", "文字数", "5,529", "ありがとう", "お楽しみ", "応援"]) {
      expect(all, word).not.toContain(word);
    }
  });

  it("残った文の位置は、画面の字の位置のまま", () => {
    for (const sentence of buildReadingPlan(KAKUYOMU, "site")) {
      expect(KAKUYOMU.slice(sentence.start, sentence.end)).toBe(sentence.speech);
    }
    // 行番号も画面のまま（本文の1行目はファイルの23行目）
    const body = buildReadingPlan(KAKUYOMU, "site").find((s) => s.speech === "朝が来た。");
    expect(body?.line).toBe(23);
  });

  it("人物の声の計画（台詞で切る）でも同じだけ外れる。台詞の番号は全文での番号のまま", () => {
    const plan = buildReadingPlan(KAKUYOMU, "site", [], { splitDialogue: true });
    expect(plan.map((s) => s.speech)).toEqual([
      "第一話　はじまり",
      "朝が来た。",
      "灯は窓を開けた。",
      "「行こう」",
      "と蓮は言った。",
    ]);
    expect(plan.find((s) => s.kind === "dialogue")?.dialogue).toBe(0);
  });

  it("改行が CRLF のままでも、位置は渡した字の位置", () => {
    const crlf = KAKUYOMU.replace(/\n/g, "\r\n");
    const ranges = episodeReadableRanges(crlf);
    expect(ranges).not.toBeNull();
    expect(crlf.slice(ranges![0].start, ranges![0].end)).toBe("第一話　はじまり");
    expect(crlf.slice(ranges![1].start, ranges![1].end)).toContain("朝が来た。灯は窓を開けた。");
    expect(crlf.slice(ranges![1].start, ranges![1].end)).not.toContain("お楽しみ");
  });

  it("題の欄が空なら、本文だけを読む", () => {
    const text = KAKUYOMU.replace("第一話　はじまり", "");
    expect(speeches(text)[0]).toBe("朝が来た。");
  });

  it("バックアップの頭書き（【エピソードタイトル】）でも、題と本文だけ", () => {
    const text = ["-------- エピソード1開始 --------", "【エピソードタイトル】", "１話　転生", "", "【本文】", "目が覚めた。"].join("\n");
    expect(speeches(text)).toEqual(["１話　転生", "目が覚めた。"]);
  });

  it("本文の範囲は parseEpisodeMetadata の本文と同じところ", () => {
    const ranges = episodeReadableRanges(KAKUYOMU)!;
    const body = KAKUYOMU.slice(ranges[1].start, ranges[1].end);
    expect(body.replace(/^\n+|\n+$/g, "")).toBe(parseEpisodeMetadata(KAKUYOMU).body);
  });
});

describe("頭の欄の無い原稿は、今までどおり全部を読む", () => {
  it("ふつうの原稿は範囲を持たない（1文字も飛ばさない）", () => {
    const text = "朝が来た。\n看板には\n【立入禁止】\nと書かれていた。";
    expect(episodeReadableRanges(text)).toBeNull();
    expect(speeches(text)).toEqual(["朝が来た。", "看板には", "【立入禁止】", "と書かれていた。"]);
  });

  it("【】で始まっても【本文】が無ければ、全部を読む", () => {
    const text = "【第一章】\n朝が来た。";
    expect(episodeReadableRanges(text)).toBeNull();
    expect(speeches(text)).toEqual(["【第一章】", "朝が来た。"]);
  });

  it("合本（区切りが2つ以上）は切らずに全部を読む", () => {
    const text = [
      "-------- エピソード1開始 --------",
      "【エピソードタイトル】",
      "１話",
      "【本文】",
      "一つ目。",
      "-------- エピソード2開始 --------",
      "【エピソードタイトル】",
      "２話",
      "【本文】",
      "二つ目。",
    ].join("\n");
    expect(episodeReadableRanges(text)).toBeNull();
    expect(speeches(text)).toContain("【エピソードタイトル】");
  });
});

/**
 * ノートPCの実機確認（2026-11-09。開発ホスト 0.144.2・AivisSpeech）：.md の第1話で、頭の欄
 * （タイトル・公開状態・公開済・日時の数字）まで読んだ。気になる所は、拡張子が .md（記法は curly）・
 * CRLF・行数つきの【本文（24行）】・日時の全角括弧。その形を写して、OS の声の道と人物の声の道
 * （台詞でも切る）の両方で、題と本文だけになるかを見る。
 */
describe("ノートPCの .md の第1話の頭の形（0.147.1）", () => {
  const LINES = [
    "【タイトル】",
    "第1話　気がついたら幽霊に",
    "",
    "【公開状態】",
    "公開済",
    "",
    "【作成日時】",
    "2023-12-05 23:49:38（+09:00）",
    "",
    "【公開日時】",
    "2023-12-05 23:49:38（+09:00）",
    "",
    "【更新日時】",
    "2023-12-05 23:49:38（+09:00）",
    "",
    "【文字数】",
    "517文字",
    "",
    "【本文（24行）】",
    "「おや、太志じゃないか。死んでしまうとは情けないね」",
    "",
    "　なぜか体育倉庫で目を覚まし、学校を出て帰宅する途中、近所のおばあさんに声をかけられた。",
  ];
  const EXPECTED_HEAD = "第1話　気がついたら幽霊に";

  for (const [eol, label] of [
    ["\r\n", "CRLF（ファイルのまま）"],
    ["\n", "LF（原稿エディターへ届く字）"],
  ] as const) {
    const text = LINES.join(eol);
    for (const voiced of [false, true]) {
      it(`${label}・${voiced ? "人物の声" : "OS の声"}：題と本文の文だけを読む`, () => {
        const plan = buildReadingPlan(text, "curly", [], voiced ? { splitDialogue: true } : {});
        const spoken = plan.map((s) => s.speech);
        expect(spoken[0]).toBe(EXPECTED_HEAD);
        expect(spoken[1]).toContain("おや、太志じゃないか");
        const joined = spoken.join("");
        for (const field of ["タイトル", "公開状態", "公開済", "作成日時", "2023", "文字数", "517", "本文（24行）"]) {
          expect(joined).not.toContain(field);
        }
      });
    }
    it(`${label}：頭の欄を知っている見出しとして拾う`, () => {
      const meta = parseEpisodeMetadata(text);
      expect(meta.hasMetadata).toBe(true);
      expect(meta.title).toBe(EXPECTED_HEAD);
      expect(meta.publishState).toBe("公開済");
      expect(meta.declaredCharCount).toBe(517);
      expect(episodeReadableRanges(text)).toHaveLength(2);
    });
  }
});
