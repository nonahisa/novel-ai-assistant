import { describe, expect, test } from "vitest";
import {
  buildContradictionCheckPrompt,
  CONTRADICTION_CATEGORIES,
  CONTRADICTION_CHECK_SCHEMA,
  CONTRADICTION_CHECK_SYSTEM_PROMPT,
  CONTRADICTION_CHECK_SYSTEM_PROMPT_STRICT,
  LIGHT_CATEGORIES,
} from "../../../src/prompts/contradictionCheck";
import { buildProposalPanelHtml } from "../../../src/views/proposalPanelHtml";
import {
  contradictionMaterial,
  contradictionPrompt,
  contradictionRun,
} from "../../../src/mcp/tools/contradiction";

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

/*
  抑制を残した版（設計書6.10.8）。**小さいモデルへ送る。**

  実測では `gemma4:e4b` が 0/4 のまま誤検出だけ増え、`12b` は罠に掛かった。
  ゆるめて得をしたのは 26b 以上だけだったので、それ未満には 1.5 の抑制を残す。
*/
describe("抑制を残した版（6.10.8）", () => {
  test("原則1だけが違う", () => {
    // **2つを別々に書き下ろすと、片方を直したときにもう片方が取り残される。**
    // 実装は `.replace()` で導いているので、ここでは「差が原則1の行だけ」で
    // あることを、行ごとに突き合わせて確かめる
    const loose = CONTRADICTION_CHECK_SYSTEM_PROMPT.split("\n");
    const strict = CONTRADICTION_CHECK_SYSTEM_PROMPT_STRICT.split("\n");

    // ゆるめた版の原則1は2行、抑制版は1行
    expect(loose.slice(0, 3)).toEqual(strict.slice(0, 3));
    expect(loose[3]).not.toBe(strict[3]);
    // 原則2以降（＝原則1の次の行から末尾まで）は1文字も違わない
    expect(loose.slice(5)).toEqual(strict.slice(4));
  });

  test("抑制版は 1.5 の文言に戻っている", () => {
    expect(CONTRADICTION_CHECK_SYSTEM_PROMPT_STRICT).toContain(
      "確信が持てないものは指摘しないこと"
    );
    expect(CONTRADICTION_CHECK_SYSTEM_PROMPT_STRICT).toContain(
      "見逃しよりも誤検出の方が作者の作業を妨げる"
    );
    // ゆるめた側の言い回しは残っていない
    expect(CONTRADICTION_CHECK_SYSTEM_PROMPT_STRICT).not.toContain(
      "疑わしい箇所は挙げること"
    );
    expect(CONTRADICTION_CHECK_SYSTEM_PROMPT_STRICT).not.toContain(
      "どちらが正しいかを決めるのは作者である"
    );
  });

  test("導けていれば、2つは必ず違う", () => {
    // `.replace()` が空振りすると、黙って同じ文字列になる
    expect(CONTRADICTION_CHECK_SYSTEM_PROMPT_STRICT).not.toBe(
      CONTRADICTION_CHECK_SYSTEM_PROMPT
    );
  });
});

/*
  MCP から抑制を選ぶ（設計書6.10.8）。

  **既定はゆるめた版である。** 製品はモデルの大きさから自動で決めるが、
  MCP は外部AIが自分でモデルを選ぶので、こちらから大きさを当てにいかない。
*/
describe("MCP の options.suppression", () => {
  const folder = "test/fixtures/seeded/contradiction";
  const file = "本文/004_ギプスが外れた日.txt";

  function promptFor(suppression?: string) {
    return contradictionPrompt({
      folder,
      filePath: file,
      numCtx: 16384,
      suppression,
    });
  }

  test("既定はゆるめた版（版に印は付かない）", () => {
    const built = promptFor();

    expect(built.systemPrompt).toBe(CONTRADICTION_CHECK_SYSTEM_PROMPT);
    expect(built.promptVersion).toBe("1.7");
    // 空文字は打ち間違いとみなさず、既定へ倒す
    expect(promptFor("")).toEqual(built);
  });

  test("strict で抑制版になり、版にも出る", () => {
    // **測り直す人が、どちらで測ったのか分かるように**版へ出す
    const built = promptFor("strict");

    expect(built.systemPrompt).toBe(CONTRADICTION_CHECK_SYSTEM_PROMPT_STRICT);
    expect(built.promptVersion).toBe("1.7:strict");
  });

  test("loose と明示しても、既定と同じ", () => {
    expect(promptFor("loose")).toEqual(promptFor());
  });

  test("知らない値は断る", () => {
    // 丸めると、打ち間違いに気づかないまま「その抑制で測った」記録が残る
    expect(() => promptFor("ゆるめ")).toThrow(/抑制/);
    expect(() => promptFor("strictly")).toThrow(/loose/);
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

**3つの段を、この順に埋めてください。** 先の2つは**読み取るための段**で、
**そこでは矛盾かどうかの判断をしません。**

**1. perspective_taking (Theory of Mind)**
Step into the other person's position before you answer: what are they feeling right now,
what do they actually know, and what would I need if I were exactly them?
**The surface words are rarely the whole message.** What the narration never mentions is
still true of them — their body, what they carry, where they are, what carried over from
earlier episodes. Do this for every person in the material above.

- who：その人物の名前（材料に載っている正式名称）
- asThem：**その人物になりきって、いまの自分の身の上を一人称で言う**（「俺は〜」「私は〜」）。
  体の具合・身につけているもの・どこに居るか・前の話から続いていることを、
  **材料の言葉を写すのではなく、その人の口から出る言葉に言い直してください。**

**2. joint_attention**
Attend to the SAME thing the writer is attending to, and speak about that object —
**not about the room, not about yourself.** Sharing attention is how two people show they
are in the same moment. Here the other person is **the writer of this text**.

- attendingTo：**書き手がこの場面で指し示しているもの**（出来事・物・人の身の上）。
  **書き手の言葉のまま**書く。多くとも3つまで
- readerKnows：**そのものについて、読者がこの話までに知っていること**を、上の材料から書く。
  材料に何も無ければ「まだ知らない」と書く

**3. contradictions——1 と 2 で読み取ったことと、対象本文の記述が食い違うものだけ。**

{
  "perspective_taking": [
    { "who": "人物の名前", "asThem": "その人物になりきった一人称の言葉" }
  ],
  "joint_attention": [
    {
      "attendingTo": "書き手が見せようとしている対象",
      "readerKnows": "それについて読者がここまでに知っていること"
    }
  ],
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

/*
  **地の文の「俺」が誰かを名指しする**（設計書6.10.6）。

  材料に載せるだけでは、地の文の「俺」と設定の「相沢 春人」が同じ人物だと
  AIが確信しきれない——引き継ぎで語り手の設定が載るようになっても（80%→99%）、
  答え付きの台での当たりは 2/4 のままだった。

  **名指しできる回にしか欄を出さない。** 版（1.6）を据え置いたので、
  **渡さないときの文面が1文字でも変わると、同じ鍵に別の材料で得た答えが入る。**
*/
describe("この話の語り手（設計書6.10.6）", () => {
  const narrator = { firstPerson: "俺", name: "相沢 春人" };

  /** 渡したときに増える欄。**この文字列を丸ごと取り除けば、元と同じになる** */
  const NARRATOR_SECTION = `
【この話の語り手】
地の文は一人称「俺」で書かれています。上の設定で一人称が「俺」の人物は「相沢 春人」だけです。

- **地の文の「俺」は「相沢 春人」だと考えて突き合わせてください。** 本文に名前が
  出てこなくても、地の文が語り手自身について述べたこと（外見・負傷・年齢・
  持ち物・居場所など）には、照らし合わせる相手があります。
- **地の文の一人称が、途中で別の語に変わっていたら、それも食い違いです。**
  ただし視点が交代する場面や、別人の手記・作中作として書かれている場合は除きます。
- **会話文の中の一人称は、語り手のものとは限りません**（別の人物が喋っています）。
  一人称の食い違いは地の文だけで見てください。
`;

  test("渡さなければ、欄そのものを出さない", () => {
    const prompt = buildContradictionCheckPrompt(
      input({ categories: LIGHT_CATEGORIES })
    );

    expect(prompt).not.toContain("【この話の語り手】");
    // 「（登録されていません）」も出さない。無いなら黙っている
    expect(prompt).not.toContain("語り手");
  });

  test("渡したときに増えるのは、この欄だけ", () => {
    // **ほかが1文字でも変われば、版を据え置いたキャッシュが壊れる**
    const without = buildContradictionCheckPrompt(
      input({ categories: LIGHT_CATEGORIES })
    );
    const withNarrator = buildContradictionCheckPrompt(
      input({ categories: LIGHT_CATEGORIES, narrator })
    );

    expect(withNarrator).toContain(NARRATOR_SECTION);
    expect(withNarrator.replace(NARRATOR_SECTION, "")).toBe(without);
  });

  test("名前と一人称は、渡されたものを埋める", () => {
    const prompt = buildContradictionCheckPrompt(
      input({ narrator: { firstPerson: "僕", name: "月島 灯" } })
    );

    expect(prompt).toContain(
      "地の文は一人称「僕」で書かれています。上の設定で一人称が「僕」の人物は「月島 灯」だけです。"
    );
    expect(prompt).toContain(
      "**地の文の「僕」は「月島 灯」だと考えて突き合わせてください。**"
    );
  });

  test("名前が出てこなくても突き合わせる相手があると言う", () => {
    // 一人称小説では、語り手は自分の名前を言わない。**名前が出ないことを
    // 理由に黙られる**のが、この機能で塞ぎたかった穴である
    const prompt = buildContradictionCheckPrompt(input({ narrator }));

    expect(prompt).toContain("本文に名前が");
    expect(prompt).toContain("照らし合わせる相手があります");
  });

  test("一人称が途中で変わることも、食い違いだと言う", () => {
    const prompt = buildContradictionCheckPrompt(input({ narrator }));

    expect(prompt).toContain("途中で別の語に変わっていたら、それも食い違いです");
    // ただし視点交代・作中作は除く（除外を書かないと誤検出が増える）
    expect(prompt).toContain("視点が交代する場面");
  });

  test("会話文の一人称を、語り手のものと数えさせない", () => {
    // 登場人物はそれぞれ違う一人称を使う。混ぜて見ると誤検出になる
    const prompt = buildContradictionCheckPrompt(input({ narrator }));

    expect(prompt).toContain("会話文の中の一人称は、語り手のものとは限りません");
    expect(prompt).toContain("一人称の食い違いは地の文だけで見てください");
  });

  test("【これまでの経緯】より後、【検証項目】より前に置く", () => {
    // 設定（人物・場所・世界観）を読んだあとでなければ、「上の設定で
    // 一人称が『俺』の人物は…」が指す先が無い
    const prompt = buildContradictionCheckPrompt(input({ narrator }));

    expect(prompt.indexOf("【これまでの経緯】")).toBeLessThan(
      prompt.indexOf("【この話の語り手】")
    );
    expect(prompt.indexOf("【この話の語り手】")).toBeLessThan(
      prompt.indexOf("【検証項目】")
    );
  });
});

/*
  **作中の日付を、コードで数えて渡す**（設計書6.10.9）。

  「十月三日に折ったのに、十二月八日の話で『ちょうど二週間が過ぎた』」という
  仕込みは、26bでも27bでも3回とも見逃した。**引き算をAIにさせない。**

  **版（1.6）を据え置いたので、渡さないときの文面が1文字でも変わると、
  同じ鍵に別の材料で得た答えが入る。**
*/
describe("作中の日付（設計書6.10.9）", () => {
  const storyDates = `【作中の日付】（本文とあらすじに書かれた表記から、機械が読み取って数えたものです）
第2話: 十月三日
この話（第5話）: 十二月八日（第2話から66日）

- 年は書かれていないので、**話の順に進むものとして数えています。** 回想や時間の前後がある作品では、この数えが合っていないことがあります。
- 読み取れなかった話（「九月の終わり」のような書き方）は並んでいません。
- **本文に「◯日が過ぎた」「◯週間ぶり」のような経過の記述があれば、上の日数と食い違っていないかを見てください。**
- 読み取った日付そのものが誤っている可能性もあります。断定せず、「日付ではこう、本文ではこう」と並べてください。`;

  /** 渡したときに増える欄。**この文字列を丸ごと取り除けば、元と同じになる** */
  const STORY_DATES_SECTION = `
${storyDates}
`;

  test("渡さなければ、欄そのものを出さない", () => {
    const prompt = buildContradictionCheckPrompt(
      input({ categories: LIGHT_CATEGORIES })
    );

    expect(prompt).not.toContain("【作中の日付】");
    // 空文字を渡したときも同じ（読み取れなかった作品）
    expect(
      buildContradictionCheckPrompt(
        input({ categories: LIGHT_CATEGORIES, storyDates: "" })
      )
    ).toBe(prompt);
  });

  test("渡したときに増えるのは、この欄だけ", () => {
    // **ほかが1文字でも変われば、版を据え置いたキャッシュが壊れる**
    const without = buildContradictionCheckPrompt(
      input({ categories: LIGHT_CATEGORIES })
    );
    const withDates = buildContradictionCheckPrompt(
      input({ categories: LIGHT_CATEGORIES, storyDates })
    );

    expect(withDates).toContain(STORY_DATES_SECTION);
    expect(withDates.replace(STORY_DATES_SECTION, "")).toBe(without);
  });

  test("【これまでの経緯】より後、【この話の語り手】より前に置く", () => {
    // あらすじを読んだあとに日付が並び、そのあとで語り手を名指しする
    const prompt = buildContradictionCheckPrompt(
      input({ storyDates, narrator: { firstPerson: "俺", name: "相沢 春人" } })
    );

    expect(prompt.indexOf("【これまでの経緯】")).toBeLessThan(
      prompt.indexOf("【作中の日付】")
    );
    expect(prompt.indexOf("【作中の日付】")).toBeLessThan(
      prompt.indexOf("【この話の語り手】")
    );
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

  **測ってから、0.73.3 で既定にした**（作者の裁定）。既定は2話ぶん——
  作者の219話で主人公が材料に載るチャンクが 80%→99% になり、代償は
  プロンプト＋16%、罠4件の台で誤検出は3回とも0だった。**MCP の既定も
  製品と揃える**（揃えないと、`novel.prompt` で覗いたものと実際に送る
  ものが別物になる）。引き継がない動きは `carryOver: 0` で指せる。
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

  test("指定しなければ、既定の2話ぶんを引き継ぐ", () => {
    const chunk = materialFor();

    expect(chunk.characterDetails).toContain("相沢 春人");
    expect(chunk.carriedOverChapters).toEqual([2, 3]);
    // 2 と指定したときと、指定しないときは同じ
    expect(materialFor(2)).toEqual(chunk);
  });

  test("0 と指定すれば、第4話には主人公が載らないまま（以前の動き）", () => {
    const chunk = materialFor(0);

    expect(chunk.characterDetails).not.toContain("相沢 春人");
    expect(chunk.carriedOverChapters).toEqual([]);
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
    expect(materialFor(2).names).toEqual(materialFor(0).names);
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

/*
  **作中の日付を、材料としても返す**（設計書6.10.9）。

  答え付きの台の第5話には「十月三日に折ったのに、ちょうど二週間が過ぎた」
  という仕込みがあり、26bでも27bでも3回とも見逃した。**日付の引き算は
  コードでやって渡す**——外部AIが自分で数えなくても済むようにする。

  **読み取れなかったことも黙らない**（`missedCharacters` と同じ考え方）。
*/
describe("作中の日付を材料に載せる（設計書6.10.9）", () => {
  const folder = "test/fixtures/seeded/contradiction";

  function datesIn(file: string): string {
    return contradictionMaterial({
      folder,
      filePath: `本文/${file}`,
      numCtx: 16384,
    }).chunks[0].storyDates;
  }

  test("第5話では、折った日からの日数を数えて渡す", () => {
    const dates = datesIn("005_初雪の窓口.txt");

    expect(dates).toContain("第2話: 十月三日");
    // 本文は「ちょうど二週間」と言うが、数えれば66日である
    expect(dates).toContain("この話（第5話）: 十二月八日（第2話から66日）");
  });

  test("読み取れたものが1件しかない話では、欄を出さない", () => {
    // 第1話は「九月の終わり」で、月日がそろっていない
    expect(datesIn("001_九月の終わりの坂.txt")).toBe("");
    // 第2話は自分の日付だけ（差を出す相手がいない）
    expect(datesIn("002_十月三日の坂.txt")).toBe("");
  });

  test("プロンプトにも同じ欄が入る", () => {
    const built = contradictionPrompt({
      folder,
      filePath: "本文/005_初雪の窓口.txt",
      numCtx: 16384,
    });

    expect(built.chunks[0].userPrompt).toContain("【作中の日付】");
    expect(built.chunks[0].userPrompt).toContain(
      "この話（第5話）: 十二月八日（第2話から66日）"
    );
  });
});

/*
  **落としたことを言う**（設計書6.10.6）。

  材料に載るのは**本文に名前が出た人物だけ**なので、一人称で語る話では
  主人公の設定が1つも載らない。それでも結果は「矛盾なし」と出るため、
  作者には**突き合わせていないのか、突き合わせて問題が無かったのか**が
  区別できない。**穴は塞がない。塞がずに、落としたことを言う。**

  答え付きの台（`seeded/contradiction`）の第4話がまさにその形で、
  地の文が全部「俺」のため主人公「相沢 春人」だけが落ちる。

  **この台は、引き継ぎ（既定2話）で穴が塞がる形である。** だから既定では
  黙り、`carryOver: 0` と指されたときだけ落ちたと言う——**塞げた回まで
  「見ていません」と言ったら、断りそのものが信用されなくなる。**
*/
describe("落とした人物を言う（設計書6.10.6）", () => {
  const folder = "test/fixtures/seeded/contradiction";

  function missedIn(file: string, carryOver?: number): string[] {
    return contradictionMaterial({
      folder,
      filePath: `本文/${file}`,
      numCtx: 16384,
      carryOver,
    }).chunks[0].missedCharacters;
  }

  test("引き継がない指定（0）なら、第4話では主人公が落ちたと言う", () => {
    // 第4話には主人公の名前が1度も出ない（地の文は全部「俺」）
    expect(missedIn("004_ギプスが外れた日.txt", 0)).toEqual(["相沢 春人"]);
  });

  /*
    **材料に載らなかった人物を全部挙げてはいけない。** 登場人物が40人いれば
    1話に出るのは数人なので、毎回37人が並んで騒がしくなる。挙げるのは
    「その話に登場すると記録されているのに、材料へ載らなかった人」だけである。
  */
  test("名前が本文に出ている話では、何も言わない", () => {
    expect(missedIn("003_窓口の椅子.txt", 0)).toEqual([]);
    expect(missedIn("005_初雪の窓口.txt", 0)).toEqual([]);
  });

  test("第1話でも、名前が出ていれば何も言わない", () => {
    expect(missedIn("001_九月の終わりの坂.txt", 0)).toEqual([]);
  });

  /*
    **引き継ぎ（`carryOver`）が効いている回では空になる。** 引き継いだ人物は
    材料に載るので、落ちていない——「穴を塞いだ」と「落としたと言う」が
    二重に出ないことを見張る。**既定（2話）でも同じ**であることを、
    指定なしでも確かめる。
  */
  test("carryOver を効かせると、第4話でも空になる", () => {
    expect(missedIn("004_ギプスが外れた日.txt", 1)).toEqual([]);
    expect(missedIn("004_ギプスが外れた日.txt", 2)).toEqual([]);
    expect(missedIn("004_ギプスが外れた日.txt")).toEqual([]);
  });

  test("prompt の返り値に出る", () => {
    const built = contradictionPrompt({
      folder,
      filePath: "本文/004_ギプスが外れた日.txt",
      numCtx: 16384,
      carryOver: 0,
    });

    expect(built.chunks[0].missedCharacters).toEqual(["相沢 春人"]);
  });

  /*
    **外部AIにも同じことを伝える**（`skipped` と同じ考え方）。`run` の結果に
    出さないと、`ollama`・`sampling` は検算した結果しか返さないので、
    落ちたことが呼んだ側へ一切届かない。
  */
  test("run の結果にも出る（黙って落とさない）", async () => {
    // `claude` はプロンプトを返すだけなので、AIを呼ばずに確かめられる
    const outcome = await contradictionRun({
      folder,
      filePath: "本文/004_ギプスが外れた日.txt",
      numCtx: 16384,
      runner: "claude",
      carryOver: 0,
    });

    expect(outcome.missed).toEqual([
      {
        chunkId: outcome.missed[0]?.chunkId ?? "",
        chapterLabel: "第4話",
        missedCharacters: ["相沢 春人"],
      },
    ]);
    expect(outcome.missed[0].chunkId).toContain("004_ギプスが外れた日");
  });

  test("落ちていない話では、run の結果も空", async () => {
    const outcome = await contradictionRun({
      folder,
      filePath: "本文/003_窓口の椅子.txt",
      numCtx: 16384,
      runner: "claude",
    });

    expect(outcome.missed).toEqual([]);
  });

  /*
    **既定（2話引き継ぐ）では、この台は1話も落ちない。** 引き継ぎで塞げた
    ことを、断りが出ないことで確かめる——毎回出る断りは読まれなくなる。
  */
  test("既定では、台の5話すべてで何も言わない", async () => {
    for (const file of [
      "001_九月の終わりの坂.txt",
      "002_十月三日の坂.txt",
      "003_窓口の椅子.txt",
      "004_ギプスが外れた日.txt",
      "005_初雪の窓口.txt",
    ]) {
      const outcome = await contradictionRun({
        folder,
        filePath: `本文/${file}`,
        numCtx: 16384,
        runner: "claude",
      });

      expect(outcome.missed).toEqual([]);
    }
  });
});
