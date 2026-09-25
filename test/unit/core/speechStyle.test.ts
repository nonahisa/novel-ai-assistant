import { describe, expect, test } from "vitest";
import type { Chunk } from "../../../src/core/chunker";
import { validateCharacterExtractResult } from "../../../src/core/characterExtractionValidation";
import { mergeExtractedCharacters } from "../../../src/core/characterMerge";
import { unifyCharacters } from "../../../src/core/characterUnify";
import { renumberCharacter } from "../../../src/core/episodeRenumber";
import { factsRevealedAfter, recordAsOf } from "../../../src/core/settingsAsOf";
import { applyCharacterEdits } from "../../../src/core/settingsEdit";
import { describeCharacter } from "../../../src/core/settingsSummary";
import { buildCharacterMarkdown } from "../../../src/core/settingsMarkdown";
import { CHARACTER_AS_OF_FIELDS } from "../../../src/core/contradictionMaterial";
import { diffCharacter } from "../../../src/core/characterDiff";
import { buildExportMarkdown } from "../../../src/core/settingsExportProfiles";
import { emptyAbilitySystem } from "../../../src/models/ability";
import {
  SPEECH_STYLE_EXAMPLE,
  SPEECH_STYLE_MAX_CHARS,
  isSpeechStyleEcho,
  speechQuoteProblem,
} from "../../../src/core/speechStyle";
import {
  emptyCharacter,
  parseCharacter,
  type Character,
} from "../../../src/models/character";
import type {
  CharacterExtractResult,
  ExtractedCharacter,
} from "../../../src/prompts/characterExtract";

/**
 * 人物の口調（作者の裁定、2026-09-25 昼。縛りの洗い出し8番）。
 *
 * 矛盾検知は口調の食い違いを見るのに、照らす資料が無かった。
 * 抽出で口調を読み取り、**根拠の台詞が本文の台詞の中に実在するときだけ**
 * 受け取り、性格と同じく話ごとに面として積む。
 */

const BODY = [
  "ミナトは荷物を下ろした。",
  "「おっす、今日もよろしくっす」",
  "ミナトはぶっきらぼうに言った。",
  "「先輩、それ違うっすよ」",
].join("\n");

function chunkOf(text: string, chapter = 1): Chunk {
  return {
    filePath: "001.txt",
    index: 0,
    text,
    startLine: 0,
    hash: `speech-${chapter}`,
    chapterStart: chapter,
    chapterEnd: chapter,
  };
}

function minato(extra: Partial<ExtractedCharacter>): CharacterExtractResult {
  return {
    characters: [
      {
        name: "ミナト",
        entityType: "person",
        evidence: "ミナトは荷物を下ろした。",
        ...extra,
      },
    ],
  };
}

describe("口調の値が指示の写しか（失敗3番：指示の言葉が答えとして返る）", () => {
  test.each([
    [SPEECH_STYLE_EXAMPLE],
    [`${SPEECH_STYLE_EXAMPLE}。`],
    ["一人称・語尾・口癖"],
    ["一人称、語尾、口癖、敬語を使うかどうか、方言"],
    ["語尾・方言など"],
  ])("「%s」は写しとして落とす", (value) => {
    expect(isSpeechStyleEcho(value)).toBe(true);
  });

  test.each([
    ["一人称は「俺」。語尾に「〜っす」を付ける"],
    ["丁寧語で話し、相手を「様」付けで呼ぶ"],
    ["関西弁。語尾に「〜やで」"],
    ["口数が少なく、短く言い切る"],
  ])("本物の口調「%s」は落とさない", (value) => {
    expect(isSpeechStyleEcho(value)).toBe(false);
  });

  test("例の口癖が、本文に無いのに口調へ混ざっていたら写しと見る", () => {
    // 実測（gemma4:e4b）：台詞が「おっにく～♪」の人物に
    // 「語尾に「〜だもん」「〜だよ」などを使い…」が返ってきた
    const value = "語尾に「〜だもん」「〜だよ」などを使い、明るく砕けた話し方";
    expect(isSpeechStyleEcho(value, "「おっにく～♪」")).toBe(true);
    // 本文の台詞に本当にあるなら、写しではない
    expect(isSpeechStyleEcho(value, "「だって好きなんだもん」")).toBe(false);
  });
});

describe("根拠の台詞が本文の台詞の中に実在するか", () => {
  test("台詞の中にあれば通す（「」ごとでも、中身だけでも）", () => {
    expect(speechQuoteProblem("「先輩、それ違うっすよ」", BODY)).toBeNull();
    expect(speechQuoteProblem("それ違うっすよ", BODY)).toBeNull();
    // 2つの台詞をつないで写してきても、どちらかが台詞にあれば通す
    expect(
      speechQuoteProblem("「おっす、今日もよろしくっす」「作り話の台詞だよ」", BODY)
    ).toBeNull();
  });

  test("（）でくくった心の声・念話の台詞も台詞として見る", () => {
    // 実データ：幽霊の少女の台詞がすべて（…）で書かれていた
    const text = "文佳は眉を寄せた。\n（ちょっと！　それは違うってば！）";
    expect(speechQuoteProblem("（それは違うってば！）", text)).toBeNull();
  });

  test("地の文にしか無ければ not_dialogue", () => {
    expect(speechQuoteProblem("ぶっきらぼうに言った", BODY)).toBe("not_dialogue");
  });

  test("本文のどこにも無ければ quote_not_found", () => {
    expect(speechQuoteProblem("「まったく、困ったもんだぜ」", BODY)).toBe(
      "quote_not_found"
    );
  });

  test("引用が無い・短すぎれば no_quote（「うん」はどこにでも含まれる）", () => {
    expect(speechQuoteProblem(null, BODY)).toBe("no_quote");
    expect(speechQuoteProblem("", BODY)).toBe("no_quote");
    expect(speechQuoteProblem("「うん」", "「うん、そうだね」")).toBe("no_quote");
  });
});

describe("抽出の検算は、口調だけを外して人物は残す", () => {
  test("台詞の中の引用があれば、口調と引用を残す", () => {
    const result = validateCharacterExtractResult(
      minato({
        speechStyle: "語尾に「〜っす」を付ける砕けた話し方",
        speechEvidence: "「先輩、それ違うっすよ」",
      }),
      chunkOf(BODY)
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].data.speechStyle).toBe(
      "語尾に「〜っす」を付ける砕けた話し方"
    );
    expect(result.accepted[0].data.speechEvidence).toBe("「先輩、それ違うっすよ」");
    expect(result.droppedSpeechStyles).toEqual([]);
  });

  test.each<[string, string | null, string]>([
    ["地の文を根拠にした口調", "ぶっきらぼうに言った", "not_dialogue"],
    ["本文に無い台詞を根拠にした口調", "「まったくだぜ」", "quote_not_found"],
    ["根拠の無い口調", null, "no_quote"],
  ])("%s は外して記録する（人物は残る）", (_, quote, reason) => {
    const result = validateCharacterExtractResult(
      minato({ speechStyle: "ぶっきらぼう", speechEvidence: quote }),
      chunkOf(BODY)
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].data.speechStyle).toBeUndefined();
    expect(result.accepted[0].data.speechEvidence).toBeUndefined();
    expect(result.droppedSpeechStyles).toEqual([
      {
        characterName: "ミナト",
        speechStyle: "ぶっきらぼう",
        speechEvidence: quote,
        reason,
      },
    ]);
  });

  test("人物の引用が名前だけでも、口調の台詞が本文にあれば人物を残し、根拠を台詞に替える", () => {
    // 実測（gemma4:26b）：口調の欄を足したあと、人物の引用が「太志」のような
    // 名前だけや言い換えで返り、人物ごと「根拠なし」で落ちる回が増えた
    const result = validateCharacterExtractResult(
      minato({
        evidence: "ミナト",
        speechStyle: "語尾に「〜っす」",
        speechEvidence: "「先輩、それ違うっすよ」",
      }),
      chunkOf(BODY)
    );
    expect(result.rejected).toEqual([]);
    expect(result.accepted[0].data.evidence).toBe("「先輩、それ違うっすよ」");
  });

  test("口調の台詞も本文に無ければ、これまでどおり根拠なしで落とす", () => {
    const result = validateCharacterExtractResult(
      minato({
        evidence: "ミナト",
        speechStyle: "語尾に「〜っす」",
        speechEvidence: "「作り話の台詞っすよ」",
      }),
      chunkOf(BODY)
    );
    expect(result.rejected).toEqual([{ name: "ミナト", reason: "ungrounded" }]);
  });

  test("例の写しは、台詞が本文にあっても外す", () => {
    const result = validateCharacterExtractResult(
      minato({
        speechStyle: SPEECH_STYLE_EXAMPLE,
        speechEvidence: "「先輩、それ違うっすよ」",
      }),
      chunkOf(BODY)
    );
    expect(result.accepted[0].data.speechStyle).toBeUndefined();
    expect(result.droppedSpeechStyles[0].reason).toBe("instruction_echo");
  });

  test("「記述なし」のような不在文は、記録せず黙って空にする", () => {
    const result = validateCharacterExtractResult(
      minato({ speechStyle: "（本文から読み取れない）", speechEvidence: null }),
      chunkOf(BODY)
    );
    expect(result.accepted[0].data.speechStyle).toBeUndefined();
    expect(result.droppedSpeechStyles).toEqual([]);
  });

  test("長すぎる口調は上限で切る（捨てない）", () => {
    const long = `${"語尾に「〜っす」を付け、".repeat(8)}砕けた話し方`;
    const result = validateCharacterExtractResult(
      minato({ speechStyle: long, speechEvidence: "「先輩、それ違うっすよ」" }),
      chunkOf(BODY)
    );
    const kept = result.accepted[0].data.speechStyle ?? "";
    expect([...kept].length).toBeLessThanOrEqual(SPEECH_STYLE_MAX_CHARS);
    expect(kept.length).toBeGreaterThan(0);
  });
});

describe("口調は話ごとに面として積む（上書きで消さない）", () => {
  const first = {
    data: {
      name: "ミナト",
      speechStyle: "語尾に「〜っす」を付ける",
      speechEvidence: "「先輩、それ違うっすよ」",
      evidence: "ミナトは荷物を下ろした。",
    },
    chapters: [1],
  };
  const fifth = {
    data: {
      name: "ミナト",
      speechStyle: "目上の客には丁寧語になる",
      speechEvidence: "「かしこまりました、お持ちします」",
      evidence: "ミナトは頭を下げた。",
    },
    chapters: [5],
  };

  test("違う話で見えた別の面は、両方残る", () => {
    const merged = mergeExtractedCharacters([], [first, fifth]);
    const person = merged.characters[0];
    expect(person.speechStyle).toBe(
      "語尾に「〜っす」を付ける／目上の客には丁寧語になる"
    );
    expect(person.speechStyleFacets).toEqual([
      {
        value: "語尾に「〜っす」を付ける",
        chapters: [1],
        evidence: "「先輩、それ違うっすよ」",
      },
      {
        value: "目上の客には丁寧語になる",
        chapters: [5],
        evidence: "「かしこまりました、お持ちします」",
      },
    ]);
    // 「作中の変化」にも「食い違い」にもしない
    expect(person.changes.filter((change) => change.field === "speechStyle")).toEqual([]);
    expect(merged.conflicts).toEqual([]);
  });

  test("同じ面がまた見えたら、話数だけ足す", () => {
    const again = { ...first, chapters: [3] };
    const merged = mergeExtractedCharacters([], [first, again]);
    expect(merged.characters[0].speechStyleFacets).toEqual([
      {
        value: "語尾に「〜っす」を付ける",
        chapters: [1, 3],
        evidence: "「先輩、それ違うっすよ」",
      },
    ]);
  });

  test("作者が確定させた人物（autoGenerated: false）の口調は変えない", () => {
    const authored: Character = {
      ...emptyCharacter("char_001", "ミナト"),
      speechStyle: "作者が書いた口調",
      autoGenerated: false,
    };
    const merged = mergeExtractedCharacters([authored], [fifth]);
    const person = merged.characters[0];
    expect(person.speechStyle).toBe("作者が書いた口調");
    expect(person.speechStyleFacets).toEqual([]);
    // 登場話数の追記だけは行う（規則2）
    expect(person.appearedChapters).toEqual([5]);
  });

  test("面の外で書かれた口調の文章は消さず、その後ろへ足す", () => {
    const existing: Character = {
      ...emptyCharacter("char_001", "ミナト"),
      speechStyle: "早口",
    };
    const merged = mergeExtractedCharacters([existing], [fifth]);
    const person = merged.characters[0];
    expect(person.speechStyle).toBe("早口／目上の客には丁寧語になる");
    // 前からあった値は「それ以前」の面になる
    expect(person.speechStyleFacets[0]).toEqual({
      value: "早口",
      chapters: [],
      evidence: null,
    });
  });
});

describe("口調の欄が無い古い資料も読める（後方互換）", () => {
  test("欄が無ければ空として読む", () => {
    const character = parseCharacter({ id: "char_001", name: "ミナト" });
    expect(character.speechStyle).toBeNull();
    expect(character.speechStyleFacets).toEqual([]);
  });

  test("面を持つ資料はそのまま読める", () => {
    const character = parseCharacter({
      id: "char_001",
      name: "ミナト",
      speechStyle: "語尾に「〜っす」",
      speechStyleFacets: [
        { value: "語尾に「〜っす」", chapters: [1], evidence: "「違うっすよ」" },
      ],
    });
    expect(character.speechStyleFacets[0].chapters).toEqual([1]);
  });

  test("壊れた面は直さず止める", () => {
    expect(() =>
      parseCharacter({
        id: "char_001",
        name: "ミナト",
        speechStyleFacets: [{ value: "", chapters: "1" }],
      })
    ).toThrow(/speechStyleFacets/);
    expect(() =>
      parseCharacter({ id: "char_001", name: "ミナト", speechStyle: 3 })
    ).toThrow(/speechStyle/);
  });
});

describe("矛盾検知の材料に口調を載せる", () => {
  const person: Character = {
    ...emptyCharacter("char_001", "ミナト"),
    speechStyle: "語尾に「〜っす」を付ける／目上の客には丁寧語になる",
    speechStyleFacets: [
      { value: "語尾に「〜っす」を付ける", chapters: [1], evidence: null },
      { value: "目上の客には丁寧語になる", chapters: [5], evidence: null },
    ],
  };

  test("巻き戻しの対象に口調が入っている", () => {
    expect(CHARACTER_AS_OF_FIELDS).toContain("speechStyle");
  });

  test("人物の説明に「口調」の行が出る", () => {
    expect(describeCharacter(person)).toContain(
      "口調: 語尾に「〜っす」を付ける／目上の客には丁寧語になる"
    );
    // 古い資料（欄が無い）では行を出さない
    expect(describeCharacter(emptyCharacter("char_002", "ハル"))).not.toContain(
      "口調"
    );
  });

  test("第3話の時点では、第5話で初めて見えた面を載せない", () => {
    const rolled = recordAsOf(person, CHARACTER_AS_OF_FIELDS, 3);
    expect(rolled.speechStyle).toBe("語尾に「〜っす」を付ける");
  });

  test("あとの話で見えた面は「あとで分かる事実」に出る", () => {
    expect(factsRevealedAfter(person, CHARACTER_AS_OF_FIELDS, 3)).toContainEqual({
      field: "speechStyle",
      value: "目上の客には丁寧語になる",
      chapter: 5,
    });
  });
});

describe("口調の欄を扱うほかの道", () => {
  test("作者がパネルで直せる（直した人物は作者の確定になる）", () => {
    const edited = applyCharacterEdits(emptyCharacter("char_001", "ミナト"), {
      speechStyle: "  関西弁  ",
    });
    expect(edited.speechStyle).toBe("関西弁");
    expect(edited.autoGenerated).toBe(false);
  });

  test("設定資料集に「口調」の行が出る", () => {
    const markdown = buildCharacterMarkdown(
      [{ ...emptyCharacter("char_001", "ミナト"), speechStyle: "関西弁" }],
      { workTitle: "試し" }
    );
    expect(markdown).toContain("- **口調**: 関西弁");
  });

  test("提供先別の書き出し：編集部向けには口調が載り、第3話までなら第5話の面は載らない", () => {
    const person: Character = {
      ...emptyCharacter("char_001", "ミナト"),
      speechStyle: "語尾に「〜っす」／目上には丁寧語",
      speechStyleFacets: [
        { value: "語尾に「〜っす」", chapters: [1], evidence: null },
        { value: "目上には丁寧語", chapters: [5], evidence: null },
      ],
      appearedChapters: [1, 5],
    };
    const data = {
      characters: [person],
      locations: [],
      abilities: [],
      abilitySystem: emptyAbilitySystem(),
      organizations: [],
      world: [],
    };
    const options = { workTitle: "試し", at: new Date(2026, 8, 25) };
    expect(
      buildExportMarkdown("editorial", data, { ...options, chapter: null })
    ).toContain("- **口調**: 語尾に「〜っす」／目上には丁寧語");
    expect(
      buildExportMarkdown("editorial", data, { ...options, chapter: 3 })
    ).toContain("- **口調**: 語尾に「〜っす」\n");
    // イラスト発注向けには出さない（外見に関わることだけ）。冒頭の
    // 「含めなかった項目」には名前が挙がるので、行の形で見る
    expect(
      buildExportMarkdown("illustration", data, { ...options, chapter: null })
    ).not.toContain("- **口調**");
  });

  test("承認待ちの差分に口調の変化が出る", () => {
    const before = emptyCharacter("char_001", "ミナト");
    const after = { ...before, speechStyle: "関西弁" };
    const diff = diffCharacter(before, after);
    expect(diff.changes.map((change) => change.label)).toContain("口調");
  });

  test("2人をまとめると、口調の面は両方から引き継ぐ", () => {
    const keep: Character = {
      ...emptyCharacter("char_001", "ミナト"),
      speechStyle: "語尾に「〜っす」",
      speechStyleFacets: [{ value: "語尾に「〜っす」", chapters: [1], evidence: null }],
    };
    const absorb: Character = {
      ...emptyCharacter("char_002", "湊"),
      speechStyle: "早口",
      speechStyleFacets: [{ value: "早口", chapters: [4], evidence: null }],
    };
    const { unified } = unifyCharacters(keep, absorb);
    expect(unified.speechStyle).toBe("語尾に「〜っす」");
    expect(unified.speechStyleFacets.map((facet) => facet.value)).toEqual([
      "語尾に「〜っす」",
      "早口",
    ]);
  });

  test("話を挿したら、口調の面の話数も付け替わる", () => {
    const person: Character = {
      ...emptyCharacter("char_001", "ミナト"),
      speechStyleFacets: [{ value: "早口", chapters: [2, 4], evidence: null }],
    };
    const result = renumberCharacter(person, {
      moved: new Map([
        [2, 3],
        [4, 5],
      ]),
    });
    expect(result.character.speechStyleFacets[0].chapters).toEqual([3, 5]);
  });
});
