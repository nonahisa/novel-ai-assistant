import { describe, expect, test } from "vitest";
import {
  ANNOUNCE_SCHEMA,
  ANNOUNCE_VERSION,
  buildAnnouncePrompt,
  type AnnouncePromptInput,
} from "../../src/prompts/announce";
import { parseAnnounceResponse } from "../../src/features/generateAnnouncement";

function input(over: Partial<AnnouncePromptInput> = {}): AnnouncePromptInput {
  return {
    workTitle: "図書塔の魔女",
    episodeLabel: "第3話「灯を継ぐ」",
    blurb: "名前を忘れた魔女の物語。",
    previousSynopsis: "第2話では、塔の門が開いた。",
    bodyExcerpt: "本文の抜粋。",
    pastAnnouncements: ["前に出した告知の本文。"],
    ...over,
  };
}

describe("更新告知のプロンプト（P-30）", () => {
  const prompt = buildAnnouncePrompt(input());

  test("X用の字数の上限を伝える", () => {
    expect(prompt).toContain("100字以内");
  });

  test("ハッシュタグとURLは書かせない", () => {
    // こちらで付けるので、書かれていると二重になる
    expect(prompt).toContain("ハッシュタグ・URLは書かない");
  });

  test("次回予告を禁じる", () => {
    // 次の話の本文は渡していない。書けばAIの作り話になる
    expect(prompt).toContain("次回予告は書かない");
  });

  test("前に出した告知を渡す", () => {
    expect(prompt).toContain("前に出した告知");
    expect(prompt).toContain("前に出した告知の本文。");
  });

  test("ネタバレと中身の無い煽りを禁じる", () => {
    expect(prompt).toContain("結末・正体・どんでん返しは書かないこと");
    expect(prompt).toContain("煽り文句");
  });

  test("材料はそのまま入る", () => {
    expect(prompt).toContain("図書塔の魔女");
    expect(prompt).toContain("第3話「灯を継ぐ」");
    expect(prompt).toContain("名前を忘れた魔女の物語。");
    expect(prompt).toContain("本文の抜粋。");
  });

  test("前の話のあらすじが無ければ、その節ごと出さない", () => {
    // **「（まだありません）」と書くと、その言葉ごと写して返ってくる。**
    // 節を落とせば写しようがない
    const without = buildAnnouncePrompt(input({ previousSynopsis: "" }));

    expect(without).not.toContain("【前の話のあらすじ】");
    expect(prompt).toContain("【前の話のあらすじ】");
  });

  test("前に出した告知が無ければ、無いと伝える", () => {
    // こちらは節を残す。「避けるべきものが無い」ことを伝える必要がある
    const without = buildAnnouncePrompt(input({ pastAnnouncements: [] }));

    expect(without).toContain("【前に出した告知】");
    expect(without).toContain("（まだありません）");
  });
});

describe("更新告知のスキーマ", () => {
  test("3種と点検用の欄をすべて必須にする", () => {
    expect(ANNOUNCE_SCHEMA.required).toEqual([
      "xPost",
      "activityReport",
      "afterword",
      "spoilerCheck",
      "confidence",
    ]);
  });

  test("余計な欄を許さない", () => {
    // 形を強制できるプロバイダでは、これでパース失敗がほぼ無くなる
    expect(ANNOUNCE_SCHEMA.additionalProperties).toBe(false);
  });

  test("版は文書と揃えて 1.0", () => {
    // プロンプトを直したら上げること。**この機能はチャンクキャッシュを
    // 通らない**（1回呼びで、話ごとに材料が変わる）ので、版が効くのは
    // プロンプト設計書のP-30と実装を対応させるためである
    expect(ANNOUNCE_VERSION).toBe("1.0");
  });
});

describe("応答の読み取り", () => {
  test("コード柵で包まれていても読める", () => {
    // 「JSONだけを返せ」と指示しても、柵を付けてくるモデルがある
    const parsed = parseAnnounceResponse(
      '```json\n{"xPost":"本文","activityReport":"報告",' +
        '"afterword":"後書き","spoilerCheck":null,"confidence":"high"}\n```'
    );

    expect(parsed?.xPost).toBe("本文");
    expect(parsed?.afterword).toBe("後書き");
    expect(parsed?.confidence).toBe("high");
  });

  test("一部が空でも、残っているものは捨てない", () => {
    // 1つでもあれば作者が書き足せる。黙って全部捨てるほうが損である
    const parsed = parseAnnounceResponse(
      '{"xPost":"","activityReport":"報告だけ返ってきた","afterword":""}'
    );

    expect(parsed?.activityReport).toBe("報告だけ返ってきた");
    expect(parsed?.xPost).toBe("");
    // 欄ごと無い場合の既定。低い側に倒す
    expect(parsed?.confidence).toBe("low");
  });

  test("3つとも空なら、読み取れなかったものとして扱う", () => {
    expect(
      parseAnnounceResponse('{"xPost":"","activityReport":"","afterword":""}')
    ).toBeNull();
  });

  test("配列やJSONでないものは読み取れないとする", () => {
    expect(parseAnnounceResponse('["本文"]')).toBeNull();
    expect(parseAnnounceResponse("本文だけを返してきた")).toBeNull();
  });
});
