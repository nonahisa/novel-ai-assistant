import { describe, expect, test } from "vitest";
import type { Chunk } from "../../src/core/chunker";
import {
  parseResult,
  validateCharacterExtractResult,
  type CharacterRejectionReason,
} from "../../src/core/characterExtractionValidation";
import type { CharacterExtractResult } from "../../src/prompts/characterExtract";

const sourceLine = "灯は静かに帰宅した";
const chunk: Chunk = {
  filePath: "001.txt",
  index: 0,
  text: `${sourceLine}。\n「シルさん、行こう」とエバンが呼んだ。\n衛兵Aは門を守った。`,
  startLine: 0,
  hash: "fixture",
  chapterStart: 1,
  chapterEnd: 1,
};

function validate(result: CharacterExtractResult, targetChunk = chunk) {
  return validateCharacterExtractResult(result, targetChunk);
}

describe("AI登場人物抽出結果の検証", () => {
  test.each<[
    string,
    "person" | "group" | "location" | "unknown" | undefined,
    CharacterRejectionReason,
  ]>([
    ["僕", undefined, "invalid_name"],
    ["先生", undefined, "non_person"],
    ["王都アルバ", "location", "non_person"],
    ["警官", undefined, "non_person"],
    ["灯は帰った。だから眠った", undefined, "invalid_name"],
    ["誰か", undefined, "invalid_name"],
    ["灯は帰った", undefined, "invalid_name"],
    ["「灯」", undefined, "invalid_name"],
  ])("人物でない候補 %s を %s として除外する", (name, entityType, reason) => {
    const result = validate({
      characters: [{ name, entityType, evidence: sourceLine }],
    });

    expect(result.rejected).toEqual([{ name, reason }]);
    expect(result.accepted).toEqual([]);
  });

  test.each([["兵士たち"], ["村人ら"], ["旅人一行"]])(
    "集団名詞 %s を消さずモブとして残す",
    (name) => {
      // 本文に出ている以上、消すと情報が失われる。
      // ネームドキャラと区別できる印を付けて保持する。
      const line = `${name}が広場に集まっていた`;
      const result = validate(
        { characters: [{ name, evidence: line }] },
        { ...chunk, text: line }
      );

      expect(result.rejected).toEqual([]);
      expect(result.accepted).toHaveLength(1);
      expect(result.accepted[0].data.isMob).toBe(true);
    }
  );

  test.each([
    ["星環評議会", "group" as const],
    ["銀翼族", "group" as const],
    ["先生", undefined],
    ["姉", undefined],
  ])("組織・種族・関係語 %s はモブにせず除外する", (name, entityType) => {
    // entityType: "group" は組織や種族にも使われる。
    // 「姉」「先生」は特定個人を指す参照であり、群衆ではない。
    const line = `${name}が広場にいた`;
    const result = validate(
      { characters: [{ name, entityType, evidence: line }] },
      { ...chunk, text: line }
    );

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ name, reason: "non_person" }]);
  });

  test("普通の人物にはモブの印を付けない", () => {
    const result = validate({
      characters: [{ name: "灯", entityType: "person", evidence: sourceLine }],
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].data.isMob).toBeFalsy();
  });

  test("モブでも根拠がなければ通さない", () => {
    // モブ扱いは捏造の免罪符にしない
    const result = validate({
      characters: [{ name: "兵士たち", evidence: "兵士たちは空を飛んだ" }],
    });

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([
      { name: "兵士たち", reason: "ungrounded" },
    ]);
  });

  test("本文中に名前があっても無関係なevidenceでは人物を通さない", () => {
    const result = validate({
      characters: [
        {
          name: "灯",
          entityType: "person",
          evidence: "本文にはない説明",
        },
      ],
    });

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ name: "灯", reason: "ungrounded" }]);
  });

  test("本文に一致する引用でも候補名や別名を含まなければ通さない", () => {
    const result = validate({
      characters: [
        {
          name: "月島",
          entityType: "person",
          evidence: `存在しない根拠です。\n「${sourceLine}」`,
        },
      ],
    });

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ name: "月島", reason: "ungrounded" }]);
  });

  test("候補名を含む逐語evidenceが本文にある人物だけを通す", () => {
    const result = validate({
      characters: [{ name: "灯", entityType: "person", evidence: sourceLine }],
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toEqual([]);
  });

  test("正式名がなくても正規化済みの別名が本文に一致すれば通す", () => {
    const result = validate(
      {
        characters: [
          {
            name: "黒木 玲司",
            aliases: ["  玲司さん  "],
            evidence: "玲司さん、こちらへ",
          },
        ],
      },
      {
        ...chunk,
        text: "「玲司さん、こちらへ」と灯が呼んだ。",
      }
    );

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].data.aliases).toEqual(["玲司さん"]);
    expect(result.rejected).toEqual([]);
  });

  test("自分の名前を含まない台詞が根拠でも、本文に実在すれば通す", () => {
    // 実データで主要人物が11件除外された原因。
    // 話者は自分の名前を台詞で言わないため、引用内に名前を求めると必ず落ちる。
    const line = "「なぁホンゴーさん。来月分の保護費、前借りさせてくれよ」";
    const result = validate(
      {
        characters: [
          {
            name: "カーラーン",
            entityType: "person",
            evidence: line,
          },
        ],
      },
      {
        ...chunk,
        text: `カーラーンが窓口に現れた。\n${line}`,
      }
    );

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toEqual([]);
  });

  test("全角スペースがバイト表記で返っても逐語一致とみなす", () => {
    // gemma系は全角スペースを <0xE3><0x80><0x80> のまま出力することがある
    const result = validate(
      {
        characters: [
          {
            name: "ホンゴー",
            entityType: "person",
            evidence: "「ん？<0xE3><0x80><0x80>ホンゴーか？」",
          },
        ],
      },
      {
        ...chunk,
        text: "「ん？　ホンゴーか？」と声がした。",
      }
    );

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toEqual([]);
  });

  test("引用が本文にあっても名前が本文に無ければ除外する", () => {
    // 名前の捏造は引き続き弾く（緩和で失われていないことの確認）
    const result = validate({
      characters: [
        {
          name: "存在しない人物",
          entityType: "person",
          evidence: sourceLine,
        },
      ],
    });

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([
      { name: "存在しない人物", reason: "ungrounded" },
    ]);
  });

  test("名前が本文にあっても引用が捏造なら除外する", () => {
    // 引用の捏造も引き続き弾く
    const result = validate({
      characters: [
        {
          name: "灯",
          entityType: "person",
          evidence: "灯は空を飛んで城へ向かった",
        },
      ],
    });

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ name: "灯", reason: "ungrounded" }]);
  });

  test("空白しかない引用では通さない", () => {
    const result = validate({
      characters: [
        {
          name: "灯",
          entityType: "person",
          evidence: "「　　　　」",
        },
      ],
    });

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ name: "灯", reason: "ungrounded" }]);
  });

  test("名前も引用も本文にない候補を根拠なしとして除外する", () => {
    const result = validate({
      characters: [
        {
          name: "月島",
          entityType: "person",
          evidence: "月島は塔へ向かった",
        },
      ],
    });

    expect(result.rejected).toEqual([
      { name: "月島", reason: "ungrounded" },
    ]);
    expect(result.accepted).toEqual([]);
  });

  test("名前をtrimし別名を重複なく正規化する", () => {
    const result = validate({
      characters: [
        {
          name: "  灯  ",
          aliases: ["  あかり ", "", "灯", "あかり"],
          evidence: sourceLine,
        },
      ],
    });

    expect(result.accepted[0].data).toMatchObject({
      name: "灯",
      aliases: ["あかり"],
      evidence: sourceLine,
    });
  });

  test("不正なネスト要素を捨て有効な呼称と関係だけを正規化する", () => {
    const result = validate({
      characters: [
        {
          name: "灯",
          evidence: sourceLine,
          addressTerms: [
            null,
            { targetName: "  澪 ", term: " 澪さん ", context: " 平時 " },
            { targetName: "", term: "君" },
          ],
          relations: [
            null,
            { name: " 澪 ", relation: " 友人 " },
            { name: "エバン", relation: "" },
          ],
        },
      ],
    } as unknown as CharacterExtractResult);

    expect(result.accepted[0].data.addressTerms).toEqual([
      {
        targetName: "澪",
        term: "澪さん",
        category: null,
        context: "平時",
        evidence: null,
      },
    ]);
    expect(result.accepted[0].data.relations).toEqual([
      { name: "澪", relation: "友人" },
    ]);
  });

  test("個別名のある背景人物はisMobを保持して通す", () => {
    const result = validate({
      characters: [
        {
          name: "衛兵A",
          entityType: "person",
          isMob: true,
          evidence: "衛兵Aは門を守った。",
        },
      ],
    });

    expect(result.accepted[0].data).toMatchObject({
      name: "衛兵A",
      entityType: "person",
      isMob: true,
    });
  });

  test.each(["伊達", "さくら", "こはる", "ジャンヌ・ダルク"])(
    "合理的な人物名 %s を禁止パターンと誤判定しない",
    (name) => {
      const evidence = `${name}は静かに帰宅した`;
      const result = validate(
        { characters: [{ name, evidence }] },
        { ...chunk, text: evidence }
      );

      expect(result.accepted).toHaveLength(1);
      expect(result.rejected).toEqual([]);
    }
  );

  test("漢字の達が付く役割語をモブとして残す", () => {
    const line = "兵士達が門を固めていた";
    const result = validate(
      { characters: [{ name: "兵士達", evidence: line }] },
      { ...chunk, text: line }
    );

    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].data.isMob).toBe(true);
  });

  test.each(["null", "あ".repeat(31), "灯、澪"])(
    "不正な人物名 %s を除外する",
    (name) => {
      const result = validate({
        characters: [{ name, evidence: sourceLine }],
      });

      expect(result.rejected).toEqual([{ name, reason: "invalid_name" }]);
    }
  );

  test("オブジェクトでない候補を不正な形として除外する", () => {
    const result = validate({
      characters: [42],
    } as unknown as CharacterExtractResult);

    expect(result.rejected).toEqual([
      { name: null, reason: "invalid_shape" },
    ]);
  });

  test.each([
    [Number.NaN, 1],
    [1, Number.POSITIVE_INFINITY],
    [4, 3],
  ])("不正な話数範囲 %s〜%s を展開しない", (chapterStart, chapterEnd) => {
    const result = validate(
      { characters: [{ name: "灯", evidence: sourceLine }] },
      { ...chunk, chapterStart, chapterEnd }
    );

    expect(result.accepted[0].chapters).toEqual([]);
  });

  test("正しい話数範囲を昇順に展開する", () => {
    const result = validate(
      { characters: [{ name: "灯", evidence: sourceLine }] },
      { ...chunk, chapterStart: 2, chapterEnd: 4 }
    );

    expect(result.accepted[0].chapters).toEqual([2, 3, 4]);
  });

  test("JSON解析時は後から再検証できるよう未正規化の値を保持する", () => {
    const parsed = parseResult(
      `前置き\n\`\`\`json\n${JSON.stringify({
        characters: [{ name: "  灯  ", aliases: [" 灯 "] }],
      })}\n\`\`\``
    );

    expect(parsed).toEqual({
      characters: [{ name: "  灯  ", aliases: [" 灯 "] }],
    });
  });
});
