import { describe, expect, test } from "vitest";
import {
  buildContradictionCheckPrompt,
  CONTRADICTION_CATEGORIES,
  CONTRADICTION_CHECK_SCHEMA,
  CONTRADICTION_CHECK_SYSTEM_PROMPT,
  LIGHT_CATEGORIES,
} from "../../src/prompts/contradictionCheck";
import { buildProposalPanelHtml } from "../../src/views/proposalPanelHtml";
import {
  contradictionMaterial,
  contradictionPrompt,
} from "../../src/mcp/tools/contradiction";

/**
 * 矛盾検知のプロンプトと画面（設計書6.10.1）。
 *
 * **設定側が古い可能性を常に残す**のがこの機能の要である。
 * 断定させると、作者は正しい設定を本文に合わせて壊すことになる。
 */
function input(overrides: Partial<Parameters<typeof buildContradictionCheckPrompt>[0]> = {}) {
  return {
    chapterLabel: "第7話",
    chunkTextWithLineNumbers: "12: 「わたくしが参りますわ」",
    characterDetails: "月島 灯：一人称は「僕」",
    locationDetails: "",
    worldviewSummary: "",
    previousSynopses: "",
    categories: CONTRADICTION_CATEGORIES,
    ...overrides,
  };
}

describe("プロンプト", () => {
  test("断定させない", () => {
    const prompt = buildContradictionCheckPrompt(input());

    expect(prompt).toContain("設定側が誤っている可能性も考慮");
    expect(prompt).toContain("断定形にしないこと");
  });

  test("意図した変化と未回収の伏線を、矛盾と呼ばせない", () => {
    const prompt = buildContradictionCheckPrompt(input());

    expect(prompt).toContain("意図的に描かれた変化");
    expect(prompt).toContain("未回収の伏線は矛盾ではありません");
  });

  test("設定が示されていないことは指摘させない", () => {
    // 照らし合わせる相手が無いものは矛盾とは言えない
    expect(buildContradictionCheckPrompt(input())).toContain(
      "照らし合わせる相手が無いものは矛盾とは言えません"
    );
  });

  test("材料が無い欄は「登録されていません」と書く", () => {
    // 空欄のまま渡すと、モデルは何かを埋めようとする
    const prompt = buildContradictionCheckPrompt(
      input({ locationDetails: "", worldviewSummary: "" })
    );

    expect(prompt).toContain("（登録されていません）");
  });

  test("見る観点を絞れる", () => {
    // 小さいモデルでは1回の負荷を下げないと検出漏れが増える
    const prompt = buildContradictionCheckPrompt(
      input({ categories: LIGHT_CATEGORIES })
    );

    expect(prompt).toContain("1. 人物：");
    expect(prompt).toContain("3. 時系列：");
    expect(prompt).not.toContain("世界法則：");
  });

  test("分類の選択肢を、値の見本として書かない", () => {
    // **実データで、モデルは見本をそのまま写して返した**
    // （`"category": "人物|状態|時系列"`）。3件すべてがこの形になり、
    // 検証が unknown_category で全部捨てて**見逃し0/3**になった
    const prompt = buildContradictionCheckPrompt(
      input({ categories: LIGHT_CATEGORIES })
    );

    expect(prompt).not.toContain('"category": "人物|状態|時系列"');
    expect(prompt).toContain('"category": "人物"');
  });

  test("選べる分類は、値とは別の行で示す", () => {
    const prompt = buildContradictionCheckPrompt(
      input({ categories: LIGHT_CATEGORIES })
    );

    expect(prompt).toContain("1つだけ**を入れてください：人物、状態、時系列");
  });

  test("引用は本文から写させる", () => {
    // 設定側の文を引いて「本文にこうある」と言うのを防ぐ
    expect(buildContradictionCheckPrompt(input())).toContain("本文からそのまま写す");
  });

  test("システムプロンプトで、迷っても挙げさせる（1.6）", () => {
    // **2026-09-20 に向きを変えた**（作者の裁定。設計書6.10.8）。
    // 黙らせていたころは、作者の作品10話で1件も指摘が出なかった。
    // **判断は作者が行う**ので、疑わしいものは挙げさせる
    expect(CONTRADICTION_CHECK_SYSTEM_PROMPT).toContain(
      "確信が持てなくても、疑わしい箇所は挙げること"
    );
    expect(CONTRADICTION_CHECK_SYSTEM_PROMPT).toContain(
      "どちらが正しいかを決めるのは作者である"
    );
  });
});

describe("過去の場面の抜粋（設計書6.74）", () => {
  /**
   * **抜粋が無いときの文面を、1文字も変えない。**
   *
   * これは既に実データで測ってある機能（P-12）への追加である。
   * 名前が1つも出ないチャンク（＝抜粋が0件）では、送る内容が
   * これまでと完全に同じでなければならない。ここが変わると、
   * 「関連が無ければ従来どおり」という約束そのものが崩れる。
   *
   * 下の期待値は 0.32.3（version 1.4）時点の出力をそのまま写したもの。
   * **意図して文面を変えたときだけ**、理由を添えて書き換えること。
   */
  const GOLDEN_WITHOUT_PAST_SCENES = `以下の小説本文が、確立された設定と矛盾していないか検証してください。

【対象本文】（第7話）
12: 「わたくしが参りますわ」

【登場人物設定】（本文に登場する人物のみ）
月島 灯：一人称は「僕」

【場所設定】（本文に登場する場所のみ）
（登録されていません）

【世界観設定】
（登録されていません）

【これまでの経緯】（時系列の整合性確認用）
（登録されていません）


【検証項目】
1. 人物：一人称、口調、性格、外見、能力が設定と食い違わないか
2. 状態：既に死亡・離脱した人物が登場していないか、負傷や状態変化が引き継がれているか
3. 時系列：季節、時刻、経過日数、人物の年齢が矛盾していないか

【判断の注意】
- 作中で意図的に描かれた変化（成長による口調の変化、設定の秘密が明かされる等）を
  矛盾と誤認しないこと。判断がつかない場合は confidence を low とし、
  「意図的な変化の可能性」を note に記載すること。
- 未回収の伏線は矛盾ではありません。
- **設定側が誤っている可能性も考慮し、指摘は断定形にしないこと。**
- 上に設定が示されていない事柄については、何も指摘しないこと。
  照らし合わせる相手が無いものは矛盾とは言えません。
- **いま見ているのは 第7話 です。** ここから先の話で
  明かされることを、この話の矛盾として挙げないこと。
  「この時点ではまだ分かっていないはずのこと」は矛盾ではありません。
  読者がこの話まで読んだ時点で知っている事柄だけを突き合わせてください。
- **人物の身の上が先へ進むのは、矛盾ではありません**（在学→退学、
  無職→就職、生存→死亡など）。あとの話の状態を、前の話へ当てはめないこと。

【出力形式】JSONのみ
category には次のどれか**1つだけ**を入れてください：人物、状態、時系列

{
  "contradictions": [
    {
      "line": 42,
      "excerpt": "該当箇所の引用（本文からそのまま写す。40字以内）",
      "category": "人物",
      "settingSays": "設定ではどうなっているか",
      "textSays": "本文ではどうなっているか",
      "note": "補足（意図的な変化の可能性など）。無ければ空文字",
      "severity": "high|medium|low",
      "confidence": "high|medium|low"
    }
  ]
}`;

  test("抜粋が無ければ、送る内容は従来と1文字も変わらない", () => {
    expect(
      buildContradictionCheckPrompt(input({ categories: LIGHT_CATEGORIES }))
    ).toBe(GOLDEN_WITHOUT_PAST_SCENES);
  });

  test("空文字を渡しても、欄そのものを出さない", () => {
    // 「（登録されていません）」も出さない。無いなら黙っている
    const prompt = buildContradictionCheckPrompt(
      input({ categories: LIGHT_CATEGORIES, pastScenes: "   " })
    );

    expect(prompt).toBe(GOLDEN_WITHOUT_PAST_SCENES);
  });

  test("抜粋があれば、出典つきで欄を足す", () => {
    const prompt = buildContradictionCheckPrompt(
      input({ pastScenes: "【第3話 再会】\n左腕の傷は、まだ癒えていなかった。" })
    );

    expect(prompt).toContain("【過去の場面の抜粋】（第7話 より前の話の本文です）");
    expect(prompt).toContain("左腕の傷は、まだ癒えていなかった。");
  });

  test("設定資料と食い違ったとき、新しいほうを正としない", () => {
    // 抜粋は本文の写しで、設定資料はAIが作ったもの。
    // どちらが正しいかは作者にしか決められない
    const prompt = buildContradictionCheckPrompt(
      input({ pastScenes: "【第3話】本文" })
    );

    expect(prompt).toContain(
      "話数の順で新しいほうが正とは限りません"
    );
    expect(prompt).toContain("逐語引用");
  });

  test("「示されていない事柄は指摘しない」の外へ、抜粋を出さない", () => {
    // 【判断の注意】は「上に設定が示されていない事柄は指摘するな」と言う。
    // 抜粋は設定資料ではないので、断らないと**抜粋との食い違いを
    // 全部黙る**読み方ができてしまう
    const prompt = buildContradictionCheckPrompt(
      input({ pastScenes: "【第3話】本文" })
    );

    expect(prompt).toContain("「示されている設定」には、**この抜粋も含みます。**");
  });

  test("引用は対象本文から写させる（抜粋から写させない）", () => {
    // `excerpt` は対象本文に実在するかをコード側で照合しており、
    // 抜粋から写すとその指摘は丸ごと捨てられる
    const prompt = buildContradictionCheckPrompt(
      input({ pastScenes: "【第3話】本文" })
    );

    expect(prompt).toContain("対象本文（第7話）から写した文だけ");
  });
});

describe("出力の形", () => {
  test("すべての項目を必須にする", () => {
    // 任意項目にすると、小さいモデルは埋めずに落とす
    const properties = Object.keys(
      CONTRADICTION_CHECK_SCHEMA.properties.contradictions.items.properties
    );

    expect(
      CONTRADICTION_CHECK_SCHEMA.properties.contradictions.items.required
    ).toEqual(properties);
  });

  test("置き換え案を持たない", () => {
    // どちらが正しいかは作者にしか決められない
    const properties = Object.keys(
      CONTRADICTION_CHECK_SCHEMA.properties.contradictions.items.properties
    );

    expect(properties).not.toContain("suggestion");
    expect(properties).toContain("settingSays");
    expect(properties).toContain("textSays");
  });
});

describe("画面", () => {
  const HTML = buildProposalPanelHtml("test-nonce", "vscode-resource:");

  function script(): string {
    const found = HTML.match(/<script nonce="test-nonce">([\s\S]*?)<\/script>/);
    expect(found, "スクリプトが見つからない").toBeTruthy();
    return found![1];
  }

  test("スクリプトがJavaScriptとして読める", () => {
    expect(() => new Function(script())).not.toThrow();
  });

  test("矛盾には適用ボタンを出さない", () => {
    const code = script();
    const render = code.slice(
      code.indexOf("function renderContradiction"),
      code.indexOf("function renderItem")
    );

    expect(render).not.toContain("data-action=\"apply\"");
    expect(render).toContain("設定資料を見る");
    expect(render).toContain("本文を見る");
  });

  test("設定と本文を並べて見せる", () => {
    const code = script();

    expect(code).toContain("設定では");
    expect(code).toContain("本文では");
  });

  test("矛盾では「まとめて適用」を隠す", () => {
    expect(script()).toContain("message.canApplyAll === false");
  });
});

/*
  矛盾の区分を、名前で直に指せるか（0.70.3）。

  作者の案（2026-09-19）：「クラウドの高位AIは節約、手元で動くローカルLLMでは
  **手数を意識して組む**と良さそうですね」。手元では呼び出しが電気代だけなので、
  **7区分を減らすのではなく、1区分ずつ分けて問う**道があり得る。
  その測り比べをするための口である。**既定（light）は変えていない。**
*/
describe("矛盾の区分を、名前で指す", () => {
  const folder = "test/fixtures/seeded/contradiction";
  const file = "本文/004_ギプスが外れた日.txt";

  function categoriesFor(categories?: string | readonly string[]) {
    return contradictionPrompt({ folder, filePath: file, numCtx: 16384, categories })
      .categories;
  }

  test("指定しなければ、これまでどおり light の3つ", () => {
    expect(categoriesFor()).toEqual(["人物", "状態", "時系列"]);
  });

  test("light と all は、これまでどおり", () => {
    expect(categoriesFor("light")).toEqual(["人物", "状態", "時系列"]);
    expect(categoriesFor("all")).toHaveLength(7);
  });

  test("区分名を1つだけ指せる", () => {
    expect(categoriesFor("状態")).toEqual(["状態"]);
  });

  test("並びでも、区切り文字つなぎでも指せる", () => {
    expect(categoriesFor(["人物", "時系列"])).toEqual(["人物", "時系列"]);
    expect(categoriesFor("人物,時系列")).toEqual(["人物", "時系列"]);
    expect(categoriesFor("人物、時系列")).toEqual(["人物", "時系列"]);
  });

  /*
    **打った順で並びが変わらない。** 変わると、同じ組み合わせなのに
    検証項目の並びが違い、測り比べられなくなる。
  */
  test("並びは表の順に揃う（打った順ではない）", () => {
    expect(categoriesFor("時系列,人物")).toEqual(["人物", "時系列"]);
  });

  /*
    **知らない名前は黙って捨てない。** 捨てると、打ち間違いに気づかないまま
    「その区分を測った」ことになる。
  */
  test("知らない名前は、選べるものを並べて断る", () => {
    expect(() => categoriesFor("状態,天気")).toThrow(/天気/);
    expect(() => categoriesFor("状態,天気")).toThrow(/世界法則/);
  });

  test("空を渡されたら、黙って既定へ倒す", () => {
    expect(categoriesFor("")).toEqual(["人物", "状態", "時系列"]);
    expect(categoriesFor("  ,  ")).toEqual(["人物", "状態", "時系列"]);
  });

  /*
    **1区分だけを問うと、検証項目もその1つだけになる。**
    「手数を分ける」ことに意味があるのは、注意の向け先が絞られるからである。
  */
  test("1区分だけを問うと、検証項目もその1つだけになる", () => {
    const built = contradictionPrompt({
      folder,
      filePath: file,
      numCtx: 16384,
      categories: "状態",
    });
    const user = String(
      (built.chunks[0] as unknown as Record<string, unknown>).userPrompt ?? ""
    );
    expect(user).toContain("負傷や状態変化が引き継がれているか");
    expect(user).not.toContain("一人称、口調、性格、外見");
  });
});

/*
  前の話に出た人物を引き継ぐ（設計書6.10.6）。

  答え付きの台（`seeded/contradiction`）の**第4話は、本文に主人公の名前が
  1度も出ない**（地の文は全部「俺」）。そのため主人公の設定が材料に1つも
  載らず、仕込んだ「左足を折ったのに右足のギプスが外れた」を5モデル15回で
  一度も拾えなかった。

  **既定は引き継がない。** 効くと分かってから既定を決めるので（6.102）、
  ここでは「指定しなければこれまでどおり」も一緒に見張る。
*/
describe("前の話に出た人物を引き継ぐ（設計書6.10.6）", () => {
  const folder = "test/fixtures/seeded/contradiction";
  /** 主人公の名前が1度も出ない話 */
  const fourth = "本文/004_ギプスが外れた日.txt";

  function materialFor(carryOver?: number | string) {
    return contradictionMaterial({
      folder,
      filePath: fourth,
      numCtx: 16384,
      carryOver,
    }).chunks[0];
  }

  test("指定しなければ、第4話には主人公が載らないまま（これまでどおり）", () => {
    const chunk = materialFor();

    expect(chunk.characterDetails).not.toContain("相沢 春人");
    expect(chunk.carriedOverChapters).toEqual([]);
    // 0 と指定したときも、指定しないときと同じ
    expect(materialFor(0)).toEqual(chunk);
  });

  test("carryOver: 2 で、第4話にも主人公の設定が載る", () => {
    const chunk = materialFor(2);

    expect(chunk.characterDetails).toContain("相沢 春人");
    expect(chunk.carriedOverChapters).toEqual([2, 3]);
  });

  test("文字列で渡しても同じ（測定の台本は文字列で渡す）", () => {
    // `scripts/measure.mjs` の `--option carryOver=2` は文字列のまま届く
    expect(materialFor("2")).toEqual(materialFor(2));
  });

  test("引き継いだ本文そのものは、プロンプトへ入らない", () => {
    const built = contradictionPrompt({
      folder,
      filePath: fourth,
      numCtx: 16384,
      carryOver: 2,
    });
    const user = built.chunks[0].userPrompt;

    expect(user).toContain("相沢 春人");
    expect(built.chunks[0].carriedOverChapters).toEqual([2, 3]);
    // 第3話の書き出し（第4話の本文には無い）が混ざっていないこと
    expect(user).not.toContain("窓口の椅子は");
  });

  test("過去の場面を引く語（names）は、引き継がない", () => {
    // 検索語は「この本文に出た名前」であって、前の話に出た名前ではない
    expect(materialFor(2).names).toEqual(materialFor().names);
  });

  /*
    **知らない値は黙って丸めない。** 丸めると、打ち間違いに気づかないまま
    「その話数で測った」記録が残る（区分の指定と同じ考え方）。
  */
  test("知らない値・大きすぎる値は断る", () => {
    expect(() => materialFor(-1)).toThrow(/carryOver/);
    expect(() => materialFor(1.5)).toThrow(/整数/);
    expect(() => materialFor("たくさん")).toThrow(/carryOver/);
    expect(() => materialFor(99)).toThrow(/5話まで/);
  });

  test("第1話には引き継ぐものが無い（断っても落ちない）", () => {
    const first = contradictionMaterial({
      folder,
      filePath: "本文/001_九月の終わりの坂.txt",
      numCtx: 16384,
      carryOver: 2,
    }).chunks[0];

    expect(first.carriedOverChapters).toEqual([]);
  });
});
