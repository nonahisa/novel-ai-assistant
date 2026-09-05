import { describe, expect, test } from "vitest";
import {
  buildPostingEnvelope,
  parsePostingEnvelope,
  pasteHelperSites,
  POSTING_ENVELOPE_VERSION,
  supportsPasteHelper,
} from "../../src/core/postingEnvelope";

/**
 * 貼り込み係へ渡すJSON封筒（設計書6.79.3）。
 *
 * **この封筒はブラウザ拡張との約束事**なので、形を変えると向こう側が
 * 黙って動かなくなる。組み立てと読み取りを対で置き、往復で確かめる。
 *
 * **拡張機能はここでもHTTPを発しない。** 作るのはクリップボードへ入れる
 * 文字列だけである（6.79.2の1）。
 */

const body = ["「引くな」と彼は言った。", "", "そして——歩き出した。"].join("\n");

describe("封筒を組み立てる", () => {
  test("形式版数・サイト・題名・本文が入る", () => {
    const json = buildPostingEnvelope({
      site: "kakuyomu",
      workId: "1177354054892",
      title: "第13話 邂逅",
      body,
    });

    expect(JSON.parse(json)).toEqual({
      "novelai-post": POSTING_ENVELOPE_VERSION,
      site: "kakuyomu",
      workId: "1177354054892",
      title: "第13話 邂逅",
      body,
    });
  });

  /**
   * **空の欄は作らない**（台帳の作品情報と同じ流儀）。作品IDを入れていない
   * 作品で `"workId":""` を渡すと、向こう側は「IDが空の作品」と読む。
   */
  test("作品IDが無ければ、欄ごと書かない", () => {
    const json = buildPostingEnvelope({ site: "narou", title: "序章", body });
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect("workId" in parsed).toBe(false);
  });

  test("空白だけの作品IDも、欄ごと書かない", () => {
    const json = buildPostingEnvelope({
      site: "narou",
      workId: "   ",
      title: "序章",
      body,
    });
    expect("workId" in (JSON.parse(json) as Record<string, unknown>)).toBe(
      false
    );
  });

  /**
   * **手組みしない**（JSON.stringifyだけを使う）。引用符・改行・波括弧を
   * 含む本文で壊れないことが、この約束を守っている証拠になる。
   */
  test("引用符・改行・波括弧を含む本文でも壊れない", () => {
    const tricky =
      '彼は「{漢字|かんじ}」と書いた。\r\n次の行\\バックスラッシュ"二重引用符"';
    const envelope = parsePostingEnvelope(
      buildPostingEnvelope({ site: "alphapolis", title: "第1話", body: tricky })
    );
    expect(envelope?.body).toBe(tricky);
  });
});

describe("封筒を読む", () => {
  test("組み立てたものを、そのまま読み戻せる", () => {
    const json = buildPostingEnvelope({
      site: "narou",
      workId: "n1234ab",
      title: "第13話 邂逅",
      body,
    });

    expect(parsePostingEnvelope(json)).toEqual({
      "novelai-post": POSTING_ENVELOPE_VERSION,
      site: "narou",
      workId: "n1234ab",
      title: "第13話 邂逅",
      body,
    });
  });

  test("前後に空白が付いていても読める（クリップボード経由のため）", () => {
    const json = buildPostingEnvelope({ site: "narou", title: "序章", body });
    expect(parsePostingEnvelope(`\n  ${json}  \n`)?.site).toBe("narou");
  });

  /**
   * **知らない版数は読まない**（6.79.3）。読めない封筒を「たぶん大丈夫」と
   * 通すと、欄の意味が変わったときに違う欄へ貼り込むことになる。
   */
  test("形式版数が違えば拒む", () => {
    const json = JSON.stringify({
      "novelai-post": 2,
      site: "narou",
      title: "序章",
      body,
    });
    expect(parsePostingEnvelope(json)).toBeNull();
  });

  test("形式版数が無ければ拒む（ただのJSONを封筒と読まない）", () => {
    expect(
      parsePostingEnvelope(JSON.stringify({ site: "narou", title: "序章", body }))
    ).toBeNull();
  });

  test("壊れたJSON・封筒でないものは拒む", () => {
    expect(parsePostingEnvelope("")).toBeNull();
    expect(parsePostingEnvelope("これは本文です")).toBeNull();
    expect(parsePostingEnvelope('{"novelai-post":1,')).toBeNull();
    // 配列や数値も「封筒ではない」
    expect(parsePostingEnvelope("[1,2,3]")).toBeNull();
    expect(parsePostingEnvelope("null")).toBeNull();
  });

  test("知らないサイト・欠けた欄は拒む", () => {
    const base = {
      "novelai-post": POSTING_ENVELOPE_VERSION,
      site: "narou",
      title: "序章",
      body,
    };
    expect(
      parsePostingEnvelope(JSON.stringify({ ...base, site: "pixiv" }))
    ).toBeNull();
    expect(
      parsePostingEnvelope(JSON.stringify({ ...base, body: undefined }))
    ).toBeNull();
    expect(
      parsePostingEnvelope(JSON.stringify({ ...base, title: 13 }))
    ).toBeNull();
  });
});

/**
 * 対象サイト（設計書6.79.8の「対応サイトの順」）。
 *
 * **noteは出さない**——規約の原文を人の目で確かめるまで後回しである
 * （6.79.1）。ここが唯一の判断の置き場で、画面はこれを引く。
 */
describe("貼り込み係に渡せるサイト", () => {
  test("カクヨム・アルファポリス・なろうだけ", () => {
    expect(supportsPasteHelper("kakuyomu")).toBe(true);
    expect(supportsPasteHelper("alphapolis")).toBe(true);
    expect(supportsPasteHelper("narou")).toBe(true);
    expect(supportsPasteHelper("note")).toBe(false);
    expect([...pasteHelperSites()]).not.toContain("note");
  });
});
