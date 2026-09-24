import { describe, expect, test } from "vitest";
import type { Chunk } from "../../../src/core/chunker";
import {
  isSentenceShapedRelation,
  isSpeculativeRelation,
  parseResult,
  validateCharacterExtractResult,
  type CharacterRejectionReason,
} from "../../../src/core/characterExtractionValidation";
import type { CharacterExtractResult } from "../../../src/prompts/characterExtract";

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
    ["僕", undefined, "pronoun_name"],
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

  test.each([["僕"], ["あんた"], ["お前"], ["彼女"], ["　僕 "], ["君"]])(
    "代名詞だけの名前 %s を弾く",
    (name) => {
      // プロンプトで禁じても返ってくる（qwen3:8b でも gemma4:26b でも
      // 「僕」という人物が作られた。実機確認A-18）。
      // 空白と敬称を落としてから照合するので、書かれ方の揺れも拾う
      const line = `${name.trim()}は静かに帰宅した`;
      const result = validate(
        { characters: [{ name, evidence: line }] },
        { ...chunk, text: line }
      );

      expect(result.rejected).toEqual([
        { name: name.trim(), reason: "pronoun_name" },
      ]);
      expect(result.accepted).toEqual([]);
    }
  );

  test.each([
    ["主人公"],
    ["ヒロイン"],
    ["語り手"],
    ["　主人公 "],
  ])("説明的な名前 %s を弾く", (name) => {
    // 呼び名ではなく説明である。プロンプトで禁じても返ってくる
    // （gemma4:26b で「主人公」「密倉の母親」が作られた。実機確認A-18）
    const line = `${name.trim()}が縁側で笑った`;
    const result = validate(
      { characters: [{ name, evidence: line }] },
      { ...chunk, text: line }
    );

    expect(result.rejected).toEqual([
      { name: name.trim(), reason: "descriptive_name" },
    ]);
    expect(result.accepted).toEqual([]);
  });

  test.each([["母親"], ["母"], ["父親"]])(
    "関係語だけの %s は従来どおり non_person で弾く（理由を変えない）",
    (name) => {
      const line = `${name}が縁側で笑った`;
      const result = validate(
        { characters: [{ name, evidence: line }] },
        { ...chunk, text: line }
      );

      expect(result.rejected).toEqual([{ name, reason: "non_person" }]);
    }
  );

  test.each([["三門の母"], ["密倉の母親"], ["隣のお姉さん"], ["木ノ下ミカ"]])(
    "「〇〇の母」のような呼び方 %s は残す（作者の裁定）",
    (name) => {
      // 名前を持たない人物の唯一の呼び名になりうる（2026-09-08「「〇〇の母」は必要です」）。
      // 実在のレコードと重なれば「重複をまとめる」の候補に出るので、作者が画面で片づける
      const line = `${name}が縁側で笑った`;
      const result = validate(
        { characters: [{ name, evidence: line }] },
        { ...chunk, text: line }
      );

      expect(result.rejected).toEqual([]);
      expect(result.accepted).toHaveLength(1);
    }
  );

  test.each([["おばあさん"], ["お母さん"], ["三門の母"]])(
    "家族関係語の呼び名 %s は弾かない（その呼び方しかされない人物がいる）",
    (name) => {
      // この作品の実データでは「おばあさん」が関係25件を持つ主要人物である。
      // 弾くと、抽出のたびにその人物が資料から消える
      const line = `${name}が縁側で笑った`;
      const result = validate(
        { characters: [{ name, evidence: line }] },
        { ...chunk, text: line }
      );

      expect(result.rejected).toEqual([]);
      expect(result.accepted).toHaveLength(1);
    }
  );

  test("代名詞は別名からも落とす", () => {
    // 別名に「僕」が入ると、それだけで別レコードどうしが
    // 「同じ呼び名を持つ」ことになる（設計書6.5.9）
    const line = "灯は静かに帰宅した";
    const result = validate({
      characters: [{ name: "灯", aliases: ["僕", "あかり"], evidence: line }],
    });

    expect(result.accepted[0].data.aliases).toEqual(["あかり"]);
  });

  test("説明的な名前も別名から落とす", () => {
    // 別名に「主人公」が入ると、それだけで別レコードどうしが
    // 「同じ呼び名を持つ」ことになり、統合の根拠にされてしまう
    const line = "灯は静かに帰宅した";
    const result = validate({
      characters: [
        {
          name: "灯",
          aliases: ["主人公", "あかり"],
          evidence: line,
        },
      ],
    });

    expect(result.accepted[0].data.aliases).toEqual(["あかり"]);
  });

  test("自分の身内を指す別名を落とす", () => {
    // 実データで、息子のレコードに母親の呼び名が別名として入った
    // （gemma4:26b、2026-09-10）。あとで「三門の母」から引くと息子に当たる。
    // **〇〇が自分の名前に含まれるときだけ**落とす——「密倉の母」は
    // 誰の別名なのかが形からは決められないので残す（設計書6.5.9）
    const line = "三門太志と密倉の母が並んでいた";
    const result = validate(
      {
        characters: [
          {
            name: "三門太志",
            aliases: [
              "三門くん",
              "三門の母",
              "母さん",
              "太志の母",
              "密倉の母",
              "あかり",
            ],
            evidence: line,
          },
        ],
      },
      { ...chunk, text: line }
    );

    expect(result.accepted[0].data.aliases).toEqual([
      "三門くん",
      "母さん",
      "密倉の母",
      "あかり",
    ]);
    // 黙って捨てず、完了報告に出せる形で残す
    expect(result.droppedRelativeAliases).toEqual([
      { characterName: "三門太志", alias: "三門の母" },
      { characterName: "三門太志", alias: "太志の母" },
    ]);
  });

  test("母親のレコードの「三門の母」は別名として残す", () => {
    // 同じ呼び名でも、付いている先が違えば正しい別名である
    const line = "圭織は三門の母として知られていた";
    const result = validate(
      {
        characters: [
          { name: "圭織", aliases: ["三門の母"], evidence: line },
        ],
      },
      { ...chunk, text: line }
    );

    expect(result.accepted[0].data.aliases).toEqual(["三門の母"]);
    expect(result.droppedRelativeAliases).toEqual([]);
  });

  test("「ノ」の入った名前でも「の」で切って身内の別名を落とす", () => {
    // 区切りはひらがなの「の」だけ。「ノ」は名前の一部（木ノ下）
    const line = "木ノ下と木ノ下の妹が来た";
    const result = validate(
      {
        characters: [
          { name: "木ノ下", aliases: ["木ノ下の妹"], evidence: line },
        ],
      },
      { ...chunk, text: line }
    );

    expect(result.accepted[0].data.aliases).toEqual([]);
    expect(result.droppedRelativeAliases).toEqual([
      { characterName: "木ノ下", alias: "木ノ下の妹" },
    ]);
  });

  test("名前自体が「〇〇の関係語」のレコードでは、同じ形の別名を落とさない", () => {
    // 「三門の母」というレコードは作者の裁定で残している（設計書6.5.9）。
    // その人物の別名「三門の母親」は本人の言い換えでありうるのに、
    // 〇〇が必ず自分の名前に含まれてしまうので、この形は見送る
    const line = "三門の母は三門の母親として紹介された";
    const result = validate(
      {
        characters: [
          { name: "三門の母", aliases: ["三門の母親"], evidence: line },
        ],
      },
      { ...chunk, text: line }
    );

    expect(result.accepted[0].data.aliases).toEqual(["三門の母親"]);
    expect(result.droppedRelativeAliases).toEqual([]);
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

describe("2人以上が名乗る姓を別名から落とす", () => {
  // 作者の報告（2026-09-12）「苗字で存在が混ざってそうです」。
  // 「中神」を名乗る人物が4人いるのに、姓だけの「中神」「中神くん」が
  // そのうち1人の別名に付いていた。別名は用語ハイライト・IME辞書・
  // 矛盾検知の手がかりになるので、別人の台詞をこの人物のものとして数える
  const familyLine = "中神鷹人は兄の中神隼人と、妻の中神亜紀に会った";
  const familyChunk: Chunk = { ...chunk, text: familyLine };

  function findAliases(
    result: ReturnType<typeof validate>,
    name: string
  ): string[] | undefined {
    return result.accepted.find((entry) => entry.data.name === name)?.data
      .aliases;
  }

  test("姓を共有する人物が2人以上いれば、姓だけの別名を落とす", () => {
    const result = validate(
      {
        characters: [
          {
            name: "中神 鷹人",
            aliases: ["ヨウト", "ヨウトさん", "中神くん", "中神"],
            evidence: familyLine,
          },
          { name: "中神隼人", evidence: familyLine },
          { name: "中神亜紀", evidence: familyLine },
        ],
      },
      familyChunk
    );

    // 本人しか指さない呼び名は残す
    expect(findAliases(result, "中神 鷹人")).toEqual(["ヨウト", "ヨウトさん"]);
    // 黙って消さない。どの人物のどの別名を落としたのかを報告に出す
    expect(result.droppedSharedFamilyNameAliases).toEqual([
      { characterName: "中神 鷹人", alias: "中神くん" },
      { characterName: "中神 鷹人", alias: "中神" },
    ]);
  });

  test("その姓を名乗るのが1人だけなら落とさない", () => {
    const line = "中神鷹人は一人で歩いた";
    const result = validate(
      {
        characters: [
          {
            name: "中神 鷹人",
            aliases: ["中神", "中神くん"],
            evidence: line,
          },
        ],
      },
      { ...chunk, text: line }
    );

    expect(findAliases(result, "中神 鷹人")).toEqual(["中神", "中神くん"]);
    expect(result.droppedSharedFamilyNameAliases).toEqual([]);
  });

  test("姓だけでなく名も含む別名は落とさない", () => {
    const result = validate(
      {
        characters: [
          {
            name: "中神 鷹人",
            aliases: ["中神鷹人"],
            evidence: familyLine,
          },
          { name: "中神隼人", evidence: familyLine },
        ],
      },
      familyChunk
    );

    expect(findAliases(result, "中神 鷹人")).toEqual(["中神鷹人"]);
    expect(result.droppedSharedFamilyNameAliases).toEqual([]);
  });

  test("名前そのものが姓と同じレコードの別名は触らない", () => {
    const line = "中神は中神隼人と中神亜紀を見送った";
    const result = validate(
      {
        characters: [
          { name: "中神", aliases: ["中神さん"], evidence: line },
          { name: "中神隼人", evidence: line },
          { name: "中神亜紀", evidence: line },
        ],
      },
      { ...chunk, text: line }
    );

    expect(findAliases(result, "中神")).toEqual(["中神さん"]);
    expect(result.droppedSharedFamilyNameAliases).toEqual([]);
  });

  test("作者が手で書いたレコード（autoGenerated: false）の別名は落とさない", () => {
    const result = validateCharacterExtractResult(
      {
        characters: [
          {
            name: "中神 鷹人",
            aliases: ["中神"],
            evidence: familyLine,
          },
          { name: "中神隼人", evidence: familyLine },
        ],
      },
      familyChunk,
      { authorEditedNames: ["中神 鷹人"] }
    );

    expect(
      result.accepted.find((entry) => entry.data.name === "中神 鷹人")?.data
        .aliases
    ).toEqual(["中神"]);
    expect(result.droppedSharedFamilyNameAliases).toEqual([]);
  });
});

describe("関係の相手も、その姓を名乗る人として数える（本体の検収 2026-09-12）", () => {
  /*
    作者の画面では「中神 鷹人」のレコードに「中神隼人＝兄」「中神亜紀＝妻」が
    並んでいたが、**その2人のレコードが同じ抽出結果に立っているとは限らない**
    （後の話で作られる／別のチャンクに出る）。レコードの名前だけを数えると、
    実データで発火しない。
  */
  const line = "中神鷹人は兄の中神隼人と、妻の中神亜紀に会った";
  const relChunk: Chunk = { ...chunk, text: line };

  test("**相手のレコードが無くても、同じ姓が2人いれば別名から落とす**", () => {
    const result = validate(
      {
        characters: [
          {
            name: "中神 鷹人",
            aliases: ["ヨウト", "中神", "中神くん"],
            relations: [
              { name: "中神隼人", relation: "兄" },
              { name: "中神亜紀", relation: "妻" },
            ],
            evidence: line,
          },
        ],
      },
      relChunk
    );

    const kept = result.accepted.find((e) => e.data.name === "中神 鷹人");
    expect(kept?.data.aliases).toEqual(["ヨウト"]);
    expect(result.droppedSharedFamilyNameAliases).toHaveLength(2);
  });

  test("役割語の相手は数えない（姓が取れないので、1人のままになる）", () => {
    const result = validate(
      {
        characters: [
          {
            name: "中神 鷹人",
            aliases: ["中神"],
            relations: [{ name: "母親", relation: "母" }],
            evidence: line,
          },
        ],
      },
      relChunk
    );

    const kept = result.accepted.find((e) => e.data.name === "中神 鷹人");
    expect(kept?.data.aliases).toContain("中神");
  });
});

describe("関係ではないもの（推測・断り）を関係から落とす", () => {
  /*
    2026-09-19の測定（gemma4:26b、`docs/measurements/`）で、AI自身が
    「明記されていない」と断りながら関係を書いてきた。プロンプトP-04aは
    既に「推測で書かないこと」と禁じているので、**指示ではなくコードで落とす**。
  */
  const line = "リーナ・ヴェイルはヨナと並んで歩いた";
  const relChunk: Chunk = { ...chunk, text: line };

  test("実データで出た「関係性は明記されていないが〜」を関係から外す", () => {
    const result = validate(
      {
        characters: [
          {
            name: "リーナ・ヴェイル",
            relations: [
              {
                name: "ヨナ",
                relation: "（関係性は明記されていないが、親密な様子が見られる）",
              },
            ],
            evidence: line,
          },
        ],
      },
      relChunk
    );

    expect(result.accepted[0].data.relations).toEqual([]);
    expect(result.droppedRelations).toEqual([
      {
        characterName: "リーナ・ヴェイル",
        partner: "ヨナ",
        relation: "（関係性は明記されていないが、親密な様子が見られる）",
        reason: "not_a_relation",
      },
    ]);
  });

  test("落とすのは推測のものだけで、同じ人物の本当の関係は残る", () => {
    const result = validate(
      {
        characters: [
          {
            name: "リーナ・ヴェイル",
            relations: [
              { name: "ヨナ", relation: "（関係性は明記されていない）" },
              { name: "ヨナ", relation: "幼なじみ" },
            ],
            evidence: line,
          },
        ],
      },
      relChunk
    );

    expect(result.accepted[0].data.relations).toEqual([
      { name: "ヨナ", relation: "幼なじみ" },
    ]);
    expect(result.droppedRelations).toHaveLength(1);
  });

  test.each([
    ["（関係性は明記されていないが、親密な様子が見られる）"],
    // 2026-09-19の測定で実際に返ってきた2通り。**同じ断りが言い換えられる**
    ["（関係性は不明だが、リーナがヨナの名を呼ぶなど親密な様子が見える）"],
    ["本文に書かれていない"],
    ["記載がない"],
    ["血縁関係の描写はありません"],
    ["敵かもしれない"],
    ["親友だと思われる"],
    ["恋人である可能性がある"],
    ["兄弟のようだ"],
    ["姉妹のように見える"],
    ["推測では従兄弟"],
    ["おそらく上司"],
    ["恋人だという噂"],
    ["血縁かどうかは断定できない"],
    ["仲が良さそう"],
    ["険悪そうに見える"],
    ["仲が良さそうな関係"],
    ["不明"],
    ["なし"],
    ["（記述なし）"],
  ])("推測・断りの関係「%s」は落とす", (relation) => {
    expect(isSpeculativeRelation(relation)).toBe(true);
  });

  test.each([
    ["兄"],
    ["母"],
    ["妹"],
    ["幼なじみ"],
    ["かつての婚約者"],
    ["元恋人"],
    ["上官"],
    ["仇"],
    ["師匠"],
    ["弟子"],
    ["同僚"],
    ["双子の妹"],
    ["相談役"],
    // 不明なのは関係ではなく安否である。ここを落とすと本当の繋がりが消える
    ["生死不明の兄"],
    ["行方不明の妹"],
    ["そうだん相手"],
    ["仲が良い"],
    // **ここを落とすと人物の同一性の仕組みが壊れる**（設計書6.95）。
    // 別人判定（`SHARED_BODY_RELATION`）はこの語を手がかりにしている
    ["憑依している"],
    ["入れ替わっている"],
    ["その名を騙っている"],
    ["転生した先"],
  ])("本当の関係「%s」は残す", (relation) => {
    expect(isSpeculativeRelation(relation)).toBe(false);
  });

  test("相手の名前は、姓の検算の証拠として先に使われる（落とす順番）", () => {
    // 関係の言い方が推測でも、**相手の名前は本文の呼び名**である。
    // 先に関係ごと捨てると「中神が2人いる」証拠まで消え、姓の別名が残ってしまう
    const familyLine = "中神鷹人は中神隼人と並んで歩いた";
    const result = validate(
      {
        characters: [
          {
            name: "中神 鷹人",
            aliases: ["ヨウト", "中神"],
            relations: [
              { name: "中神隼人", relation: "兄かもしれない" },
            ],
            evidence: familyLine,
          },
        ],
      },
      { ...chunk, text: familyLine }
    );

    const kept = result.accepted.find((e) => e.data.name === "中神 鷹人");
    expect(kept?.data.aliases).toEqual(["ヨウト"]);
    expect(result.droppedSharedFamilyNameAliases).toHaveLength(1);
    expect(result.droppedRelations).toHaveLength(1);
  });
});

describe("関係の欄に文が入っていたら、構造で落とす", () => {
  /*
    **言い回しの表は追いかけっこになる。** 2026-09-19に同じ条件で2回測ったら、
    AIは同じ断りを「明記されていないが」と「不明だが」の2通りで書いてきた。
    関係の欄に入るべきは「兄」「幼なじみ」のような**短い語**であって文ではない
    ので、**文になっていること自体**を理由に落とす（作者の裁定、2026-09-19）。

    線は推測ではなく実測で引いた。作者の設定資料13作品・157ファイルにある
    本物の関係 508件を数えた結果：
      - 長さ 最短1字／中央3字／p90 10字／p95 15字／p99 25字／最大34字
      - 句読点（、。）を含む値は 15件（2.9%）。いずれも「同級生（引用）」の形で、
        **括弧の外に関係語がある**
      - **丸ごと括弧で囲まれた値は 508件中1件だけ**（「（間接的な関わり）」9字）で、
        その1件に句読点は無い
    この508件は、下の3つの線のどれにも当たらない（誤爆0件を確かめたうえで引いた）。
  */
  const line = "リーナ・ヴェイルはヨナと並んで歩いた";
  const relChunk: Chunk = { ...chunk, text: line };

  test.each([
    // 2026-09-19の測定で実際に返ってきた2通り。どちらも丸ごと括弧＋句読点
    ["（関係性は明記されていないが、親密な様子が見られる）"],
    ["（関係性は不明だが、リーナがヨナの名を呼ぶなど親密な様子が見える）"],
    // 言い回しの表に無い断り方をされても、形で落ちる
    ["（互いの名を呼び合う程度の間柄にとどまり、それ以上の情報は与えられていない）"],
    ["（並んで歩く場面があるだけで、二人がどういう間柄なのかは書かれていません）"],
    // 丸ごと括弧で、句読点は無いが中身が15字以上（実測の唯一例は中身7字）
    ["（二人の間柄について読み取れる材料が本文中に見当たらず）"],
    // 括弧が無くても、40字を超えれば文である（実測の最大は34字）
    [
      "本文中では二人の間柄について特に説明されておらず、ただ並んで歩いていたと書かれているだけである",
    ],
  ])("文の形をした関係「%s」は落とす", (relation) => {
    expect(isSentenceShapedRelation(relation)).toBe(true);
  });

  test.each([
    // **別人判定の手がかり（設計書6.95）。長くても括弧つきでも落とさない**
    ["憑依している"],
    ["入れ替わっている"],
    ["その名を騙っている"],
    ["転生した先"],
    // 実データにある、長めだが本物の関係（引用が括弧で付いた形）。
    // **括弧の外に関係語がある**ので、関係として読める
    ["憑依されている（文佳の身体に憑依されたということだ）"],
    ["身体を共有している（太志くん、あれ祓える？）"],
    ["案内役（霊媒師のばあさんと、背筋がピンと伸びた羽織袴姿の老人だった）"],
    ["直属の上司（斉藤さんが会長に頭を下げながら、声をかける）"],
    ["将来の伴侶・婚約者（王女としての義務を共にする）"],
    // 実データにある、句読点を含む本物の関係（p99 25字の内側）
    ["前世でのいじめ被害仲間、自殺未遂を助けた相手"],
    ["保護者的な霊能者、恩人"],
    ["友人。かつて自分の代わりにイジメられた"],
    ["指導している少女、依頼者的立場"],
    // 実データで唯一の「丸ごと括弧」。句読点が無く、中身も7字
    ["（間接的な関わり）"],
    ["（過去の）友人"],
    // 実データにある、長めで括弧も句読点も無い関係
    ["娘として同居していないが世話をされている母"],
    ["パーティを組むことになっている"],
    // ふつうの短い関係語
    ["兄"],
    ["幼なじみ"],
    ["かつての婚約者"],
    ["生死不明の兄"],
  ])("本物の関係「%s」は構造では落とさない", (relation) => {
    expect(isSentenceShapedRelation(relation)).toBe(false);
  });

  test("構造で落としたものは、言い回しで落としたものと理由を分けて記録する", () => {
    const result = validate(
      {
        characters: [
          {
            name: "リーナ・ヴェイル",
            relations: [
              // 言い回しの表に無い断り方。構造でだけ落ちる
              {
                name: "ヨナ",
                relation:
                  "（互いの名を呼び合う程度の間柄にとどまり、それ以上の情報は与えられていない）",
              },
              // 言い回しの表が拾う
              { name: "ヨナ", relation: "親友だと思われる" },
              { name: "ヨナ", relation: "幼なじみ" },
            ],
            evidence: line,
          },
        ],
      },
      relChunk
    );

    expect(result.accepted[0].data.relations).toEqual([
      { name: "ヨナ", relation: "幼なじみ" },
    ]);
    expect(result.droppedRelations.map((entry) => entry.reason)).toEqual([
      "sentence_shaped",
      "not_a_relation",
    ]);
  });

  test("言い回しと構造の両方に当たるものは、言い回しの理由で1件だけ落ちる", () => {
    // 記録の理由が測るたびに揺れると、既存の測定結果と突き合わせられない。
    // **先に言い回しを見る**と決めてあることを、ここで固定する
    const result = validate(
      {
        characters: [
          {
            name: "リーナ・ヴェイル",
            relations: [
              {
                name: "ヨナ",
                relation: "（関係性は明記されていないが、親密な様子が見られる）",
              },
            ],
            evidence: line,
          },
        ],
      },
      relChunk
    );

    expect(result.droppedRelations).toEqual([
      {
        characterName: "リーナ・ヴェイル",
        partner: "ヨナ",
        relation: "（関係性は明記されていないが、親密な様子が見られる）",
        reason: "not_a_relation",
      },
    ]);
  });

  test("体を共有している相手の関係は、構造でも落とさない（別人判定が壊れる）", () => {
    // 落とすと `cleanSharedBodyAliases` の手がかりが消え、
    // 憑依した側とされた側が同一人物として1つのレコードにまとまる
    const bodyLine = "三門太志は密倉文佳の身体に憑依していた";
    const result = validate(
      {
        characters: [
          {
            name: "三門太志",
            relations: [
              {
                name: "密倉文佳",
                relation:
                  "憑依している（本文では太志の意識が文佳の身体の中にあると書かれており、二人は別人である）",
              },
            ],
            evidence: bodyLine,
          },
        ],
      },
      { ...chunk, text: bodyLine }
    );

    expect(result.droppedRelations).toEqual([]);
    const kept = result.accepted.find((entry) => entry.data.name === "三門太志");
    // 別人判定（`cleanSharedBodyAliases`）が手がかりにする語が、
    // 44字の括弧つきでも関係として残っている
    expect(kept?.data.relations).toEqual([
      {
        name: "密倉文佳",
        relation:
          "憑依している（本文では太志の意識が文佳の身体の中にあると書かれており、二人は別人である）",
      },
    ]);
  });
});

describe("名前が決められずに捨てたレコードの中身", () => {
  // 一人称の作品では、語り手が自分の名前を名乗らないことがある。
  // AIは外見や性格まで読み取っていても「僕」「語り手」としか呼べず、
  // レコードごと捨てられる。**捨てること自体は正しい**（設計書6.5.9）が、
  // 件数しか残らないと作者には「認識してそうなのに増えない」としか見えない
  test("代名詞の名前で捨てたレコードは、中身を持ち回す", () => {
    const line = "僕は背が高いと言われる";
    const result = validate(
      {
        characters: [
          {
            name: "僕",
            summary: "語り手の少年",
            role: "主人公",
            appearance: "背が高い。右目の下に小さなほくろ",
            gender: "男性",
            personality: "皮肉屋",
            evidence: line,
          },
        ],
      },
      { ...chunk, text: line }
    );

    expect(result.rejected).toEqual([
      {
        name: "僕",
        reason: "pronoun_name",
        // 誰のことか見当が付く分だけ（性格などは入れない——報告が長くなる）
        details: {
          summary: "語り手の少年",
          role: "主人公",
          appearance: "背が高い。右目の下に小さなほくろ",
          gender: "男性",
        },
      },
    ]);
    expect(result.accepted).toEqual([]);
  });

  test("説明的な名前で捨てたレコードも、中身を持ち回す", () => {
    const line = "語り手は縁側で笑った";
    const result = validate(
      {
        characters: [
          { name: "語り手", appearance: "痩せている", evidence: line },
        ],
      },
      { ...chunk, text: line }
    );

    expect(result.rejected).toEqual([
      {
        name: "語り手",
        reason: "descriptive_name",
        details: { appearance: "痩せている" },
      },
    ]);
  });

  test("本文に根拠が無くて捨てたものには、中身を付けない", () => {
    // 語り手の可能性があるのは名前を決められなかった2つだけである。
    // 全部に付けると報告が騒がしくなり、肝心の行が読まれなくなる
    const result = validate({
      characters: [
        {
          name: "谷村修一",
          summary: "旅の商人",
          appearance: "痩せている",
          evidence: "谷村がやってきた",
        },
      ],
    });

    expect(result.rejected).toEqual([
      { name: "谷村修一", reason: "ungrounded" },
    ]);
  });

  test("中身が空欄や不在文だけなら、details を付けない", () => {
    const line = "僕は歩いた";
    const result = validate(
      {
        characters: [
          {
            name: "僕",
            summary: "（本文からは読み取れない）",
            appearance: null,
            evidence: line,
          },
        ],
      },
      { ...chunk, text: line }
    );

    expect(result.rejected).toEqual([{ name: "僕", reason: "pronoun_name" }]);
  });
});

describe("既知の人物の名前は、その話の本文に無くても落とさない（2026-09-24 の裁定）", () => {
  /*
    指示は「既知の人物と同じなら既知の名前を name に」。一方で検算は
    「その名前がその話の本文に無ければ ungrounded」だった。試験台
    （seeded/contradiction）の第4話には「相沢」が一度も出ない（語り手の「俺」）。
    指示どおり既知のフルネームで返すと落ち、実測43件の大半が正解の人物だった。
    **本文に実在すべきは根拠の引用のほう**なので、引用の照合は残す。
  */
  const episode4: Chunk = {
    filePath: "004_右足.txt",
    index: 0,
    text:
      "　丘のいちばん上で、蓬田さんが縁側から手を上げた。\n" +
      "　蓬田さんは自分の杖の先で、縁側の板を軽く叩いた。",
    startLine: 0,
    hash: "episode4",
    chapterStart: 4,
    chapterEnd: 4,
  };
  const known = ["相沢 春人", "春人", "蓬田 吾一", "蓬田さん", "吾一"];

  test("既知のフルネームで返った人物を、引用が本文にあれば通す", () => {
    const result = validateCharacterExtractResult(
      {
        characters: [
          {
            name: "相沢春人",
            entityType: "person",
            evidence: "丘のいちばん上で、蓬田さんが縁側から手を上げた",
          },
          {
            name: "蓬田 吾一",
            entityType: "person",
            evidence: "蓬田さんは自分の杖の先で、縁側の板を軽く叩いた",
          },
        ],
      },
      episode4,
      { knownNames: known, knownRecordNames: known }
    );

    expect(result.rejected).toEqual([]);
    expect(result.accepted.map((item) => item.data.name)).toEqual([
      "相沢春人",
      "蓬田 吾一",
    ]);
  });

  test("既知の名前でも、引用が本文に無ければ今までどおり落とす", () => {
    const result = validateCharacterExtractResult(
      {
        characters: [
          {
            name: "相沢 春人",
            entityType: "person",
            evidence: "相沢は右足を引きずって坂を上った",
          },
        ],
      },
      episode4,
      { knownNames: known, knownRecordNames: known }
    );

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([
      { name: "相沢 春人", reason: "ungrounded" },
    ]);
  });

  test("既知でない名前は、本文に無ければ今までどおり落とす（名前の捏造）", () => {
    const result = validateCharacterExtractResult(
      {
        characters: [
          {
            name: "月島 蓮",
            entityType: "person",
            evidence: "丘のいちばん上で、蓬田さんが縁側から手を上げた",
          },
        ],
      },
      episode4,
      { knownNames: known, knownRecordNames: known }
    );

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ name: "月島 蓮", reason: "ungrounded" }]);
  });

  test("別名だけが既知と一致しても、名前の照合は省かない", () => {
    // 作り話の人物に既知の人の別名を貼っただけで通ると、名寄せで
    // 既知の人物へ混ざる。**省くのは name そのものが既知のときだけ**
    const result = validateCharacterExtractResult(
      {
        characters: [
          {
            name: "月島 蓮",
            aliases: ["春人"],
            entityType: "person",
            evidence: "丘のいちばん上で、蓬田さんが縁側から手を上げた",
          },
        ],
      },
      episode4,
      { knownNames: known, knownRecordNames: known }
    );

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ name: "月島 蓮", reason: "ungrounded" }]);
  });
});
