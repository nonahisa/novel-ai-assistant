import { describe, expect, test } from "vitest";
import { parseEpisodeMetadata } from "../../src/core/metadataParser";
import { countChars } from "../../src/core/charCount";
import { countParagraphs } from "../../src/core/epubXhtml";

describe("投稿サイトのメタデータ", () => {
  test("カクヨム形式のヘッダーと本文を分離する", () => {
    const parsed = parseEpisodeMetadata(
      "【タイトル】\n再会\n\n【文字数】\n1,826文字\n\n【更新日時】\n2026-08-05\n\n【本文（1行）】\n本文です。"
    );

    expect(parsed.hasMetadata).toBe(true);
    expect(parsed.title).toBe("再会");
    expect(parsed.declaredCharCount).toBe(1826);
    expect(parsed.updatedAt).toBe("2026-08-05");
    expect(parsed.body).toBe("本文です。");
  });

  test("通常の本文はそのまま返す", () => {
    const parsed = parseEpisodeMetadata("第一章\n本文");
    expect(parsed.hasMetadata).toBe(false);
    expect(parsed.body).toBe("第一章\n本文");
  });
});

/**
 * バックアップの頭書き（設計書6.65.15の段D。作者の指定）。
 *
 * 作者の原稿には、投稿サイトのダウンロードツールが付けた頭書きが
 * 残っていることがある。**本文の前に置かれた区切りと見出しは、読むときに
 * 省く**——原稿は書き換えない。切り出しは `parseEpisodeMetadata` の1か所で
 * 行い、EPUBの組版も文字数も段落番号も、同じ関数を通る。
 */
describe("バックアップの頭書き（設計書6.65.15の段D）", () => {
  /** 実データで観察された形（区切り行＋【エピソードタイトル】＋【本文】） */
  const BACKUP = [
    "-------- エピソード1開始 --------",
    "【エピソードタイトル】",
    "１話　転生",
    "",
    "【本文】",
    "　朝が来た。",
    "",
    "　鐘が鳴る。",
  ].join("\n");

  test("区切り行つきの頭書きを読み、本文だけを返す", () => {
    const parsed = parseEpisodeMetadata(BACKUP);

    expect(parsed.hasMetadata).toBe(true);
    expect(parsed.title).toBe("１話　転生");
    expect(parsed.body).toBe("　朝が来た。\n\n　鐘が鳴る。");
  });

  /** 番号を持たない区切り（`---- エピソード開始 ----`）も同じに読む */
  test("番号の無い区切り行でも本文だけになる", () => {
    const parsed = parseEpisodeMetadata(
      "---- エピソード開始 ----\n【エピソードタイトル】\n転生\n\n【本文】\n　朝が来た。"
    );

    expect(parsed.hasMetadata).toBe(true);
    expect(parsed.title).toBe("転生");
    expect(parsed.body).toBe("　朝が来た。");
  });

  /**
   * **頭書きの無い原稿は1バイトも変わらない**（回帰の固定）。
   * 切り出しを広げたせいで、ふつうの原稿の先頭が削れては困る。
   */
  test("頭書きの無い本文は1文字も変わらない", () => {
    const plain = "　朝が来た。\n\n「おはよう」\n\n──鐘が鳴る。\n";
    expect(parseEpisodeMetadata(plain).body).toBe(plain);
    expect(parseEpisodeMetadata(plain).hasMetadata).toBe(false);
  });

  /** 区切りの形をした行が本文の途中にあっても、頭書きとは読まない */
  test("本文の途中の罫線は切り出しに使わない", () => {
    const text = "　朝が来た。\n\n-------- エピソード2開始 --------\n\n　鐘が鳴る。";
    expect(parseEpisodeMetadata(text).body).toBe(text);
  });

  /**
   * **合本はここでは触らない**（`parseCollectedFile` が正。設計書6.65.15）。
   * 区切りが2つ以上あるファイルは話ごとに分ける道があり、こちらが
   * 半端に切ると「1話目だけの本」と「全部入りの文字数」が混ざる。
   */
  test("区切りが2つ以上ある合本は、そのまま返す", () => {
    const collected = [
      "------- エピソード1開始 -------",
      "【エピソードタイトル】",
      "１話",
      "",
      "【本文】",
      "　朝。",
      "",
      "------- エピソード2開始 -------",
      "【エピソードタイトル】",
      "２話",
      "",
      "【本文】",
      "　昼。",
    ].join("\n");

    const parsed = parseEpisodeMetadata(collected);
    expect(parsed.hasMetadata).toBe(false);
    expect(parsed.body).toBe(collected);
  });

  /**
   * **数え方と見え方を揃える**（作者の指定）。作品一覧の文字数は
   * `parseEpisodeMetadata` を通した本文を数えており、EPUBの組版も同じ
   * 本文を組む。頭書きが字数に混ざっていないことをここで固定する。
   */
  test("文字数は、頭書きを除いた本文と同じになる", () => {
    const body = parseEpisodeMetadata(BACKUP).body;
    expect(countChars(body).net).toBe(countChars("　朝が来た。\n\n　鐘が鳴る。").net);
    // 頭書きを混ぜたままだと、この字数にはならない
    expect(countChars(BACKUP).net).toBeGreaterThan(countChars(body).net);
  });

  /**
   * **段落番号は切り出したあとで数える**（設計書6.65.10）。頭書きを
   * 段落に数えると、指定した位置と挿絵の入る位置が丸ごとずれる。
   */
  test("段落は、頭書きを除いた本文で数える", () => {
    expect(countParagraphs(parseEpisodeMetadata(BACKUP).body)).toBe(2);
  });
});

/**
 * 本文の後ろに付く見出し（本体の裁定、2026-09-04）。
 *
 * ダウンロードファイルは本文の後ろに【後書き】【リアクション】を続ける。
 * **これは作者が書いた物語ではない**ので、本にも字数にも入れない——合本
 * （`collectedFile.ts`）は既にそうしており、単話だけ取り込んでいた非対称を
 * 解消する。切るのは**行頭の【見出し】の形をした、知っている見出しだけ**で、
 * 本文に出てくる「後書き」という語は巻き込まない。
 */
describe("本文の後ろの見出し（設計書6.65.15の段D）", () => {
  const WITH_AFTER = [
    "-------- エピソード1開始 --------",
    "【エピソードタイトル】",
    "１話　転生",
    "",
    "【本文】",
    "　朝が来た。",
    "",
    "　鐘が鳴る。",
    "",
    "【後書き】",
    "　お読みいただきありがとうございます。",
    "",
    "【リアクション】",
    "いいね: 19件",
  ].join("\n");

  test("後書き・リアクションは本文に入らない", () => {
    const parsed = parseEpisodeMetadata(WITH_AFTER);

    expect(parsed.title).toBe("１話　転生");
    expect(parsed.body).toBe("　朝が来た。\n\n　鐘が鳴る。");
    expect(parsed.body).not.toContain("後書き");
    expect(parsed.body).not.toContain("いいね");
  });

  /** **字数は下がる。** 作者の物語でない文章が混ざっていた状態が直る */
  test("字数が、本文だけの字数まで下がる", () => {
    const body = parseEpisodeMetadata(WITH_AFTER).body;

    expect(countChars(body).net).toBe(
      countChars("　朝が来た。\n\n　鐘が鳴る。").net
    );
    expect(countChars(body).net).toBeLessThan(countChars(WITH_AFTER).net);
  });

  test("段落も本文の分だけになる（挿絵の位置がずれない）", () => {
    expect(countParagraphs(parseEpisodeMetadata(WITH_AFTER).body)).toBe(2);
  });

  /** カクヨム形式（本文が最後）は、いままでどおり最後まで本文 */
  test("後書きの無いファイルは1文字も変わらない", () => {
    const kakuyomu =
      "【タイトル】\n再会\n\n【本文（2行）】\n　朝が来た。\n\n　鐘が鳴る。\n";
    expect(parseEpisodeMetadata(kakuyomu).body).toBe(
      "　朝が来た。\n\n　鐘が鳴る。\n"
    );
  });

  /**
   * **本文の中の【】を見出しにしない。** 「看板には【立入禁止】と
   * 書かれていた」のような行で本文が終わってしまう作りにはしない
   * （合本側と同じ「知っている見出しだけ」の判断）。
   */
  test("本文の中の【】や「後書き」という語は巻き込まない", () => {
    const text = [
      "【タイトル】",
      "再会",
      "",
      "【本文】",
      "　看板には【立入禁止】と書かれていた。",
      "",
      "　後書きを読むのが好きだ。",
      "",
      "【後書き】",
      "　ありがとうございました。",
    ].join("\n");

    const body = parseEpisodeMetadata(text).body;
    expect(body).toBe(
      "　看板には【立入禁止】と書かれていた。\n\n　後書きを読むのが好きだ。"
    );
  });
});
