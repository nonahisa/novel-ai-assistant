import { describe, expect, test } from "vitest";
import {
  echoesViewpointGuide,
  explainProofreadReason,
  normalizeReason,
  validateProofreadIssues,
} from "../../../src/core/proofreadValidation";
import {
  buildProofreadPrompt,
  PROOFREAD_REASONS,
  PROOFREAD_VERSION,
  PROOFREAD_VIEWPOINT_EXAMPLE,
} from "../../../src/prompts/proofread";
import type { Chunk } from "../../../src/core/chunker";

/**
 * 推敲の7つ目の観点「視点」（P-10 1.10、2026-09-25、人称のよじれ）。
 *
 * 2026-09-24 の測定では、AIは視点のはみ出しに気づいても受け皿が無く、
 * 「係り受け」に押し込むか（B）、「長文」の札で返して検算 `not_long` に
 * 落とされていた（C）。**指示どおりに答えたのに落ちる形**を作らないことと、
 * **指示の言葉がそのまま返る形**（CLAUDE.md の失敗3）を落とすことの両方を見る。
 */

// 台（seeded/contradiction）の第1話に仕込んだ3行を含む本文。行は 11〜14 行目。
// **15行目から後は「俺」の地の文**——視点の札は一人称の場面でしか出さない
// （2026-09-25 の2回目。三人称の場面では当たりが0だった）ので、台の第1話と
// 同じく、この場面が「俺」の語りだと数えられるだけの一人称を置く
const TEXT = [
  "　最初にそれを聞いたとき、俺は損をしたのだと思った。",
  "　蓬田さんは内心、この無口な配達員を気に入っていた。",
  "　千夏は伝票を揃えながら、相沢くんはきっと来月も水筒を忘れるだろうと思い、少しだけ胸が温かくなった。",
  "「蓬田さんは本当はさびしいんだよ」",
  "　俺は坂の途中で足を止めた。",
  "　俺の足首はまだ痛んだ。",
].join("\n");

function chunkOf(text: string): Chunk {
  return {
    filePath: "C:/works/001.txt",
    index: 0,
    text,
    startLine: 10,
    chapterStart: 1,
    chapterEnd: 1,
    hash: "abc123",
    segments: [],
  } as unknown as Chunk;
}

const chunk = chunkOf(TEXT);

function validate(items: Array<Record<string, unknown>>) {
  return validateProofreadIssues({ issues: items }, chunk);
}

describe("視点の札を受ける", () => {
  test("視点の指摘は残し、修正案は必ず空にする（直すかどうかは作者が決める）", () => {
    const result = validate([
      {
        line: 12,
        original: "蓬田さんは内心、この無口な配達員を気に入っていた。",
        suggestion: "蓬田さんは、この無口な配達員を気に入っているようだった。",
        reason: "視点",
        explanation: "「俺」の語りなのに、蓬田さんの『内心』が言い切られています",
        confidence: "medium",
      },
    ]);
    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]).toMatchObject({ reason: "視点", suggestion: "" });
  });

  test("測定の B：視点の話を「係り受け」で返したら、視点へ付け替える", () => {
    const result = validate([
      {
        line: 12,
        original: "蓬田さんは内心、この無口な配達員を気に入っていた。",
        suggestion: "",
        reason: "係り受け",
        explanation: "一人称の「俺」の視点の中に、突然蓬田さんの内心が混ざり、視点が揺らぎます",
        confidence: "medium",
      },
    ]);
    expect(result.accepted.map((issue) => issue.reason)).toEqual(["視点"]);
  });

  test("「長文」の札でも、説明が視点の話なら not_long で落とさない", () => {
    const result = validate([
      {
        line: 13,
        original: "千夏は伝票を揃えながら、相沢くんはきっと来月も水筒を忘れるだろうと思い",
        suggestion: "",
        reason: "長文",
        explanation: "語り手の俺から、途中で千夏の気持ちへ視点が移っています",
        confidence: "medium",
      },
    ]);
    expect(result.rejected).toEqual([]);
    expect(result.accepted.map((issue) => issue.reason)).toEqual(["視点"]);
  });

  test("測定の C の答え（長文で、説明に視点の話が無い）は今までどおり not_long", () => {
    const result = validate([
      {
        line: 13,
        original:
          "千夏は伝票を揃えながら、相沢くんはきっと来月も水筒を忘れるだろうと思い、少しだけ胸が温かくなった。",
        suggestion: "",
        reason: "長文",
        explanation: "72字・読点2個で、千夏の動作と心情が一度に詰め込まれています",
        confidence: "medium",
      },
    ]);
    expect(result.rejected.map((entry) => entry.reason)).toEqual(["not_long"]);
  });

  test("漢字ひらき・語尾単調は、説明に「語り手」が出ても付け替えない", () => {
    const result = validate([
      {
        line: 11,
        original: "最初にそれを聞いたとき",
        suggestion: "最初にそれをきいたとき",
        reason: "漢字ひらき",
        explanation: "語り手の地の文で『聞いた（きいた）』が詰まります",
        confidence: "low",
      },
    ]);
    expect(result.accepted.map((issue) => issue.reason)).toEqual(["漢字ひらき"]);
  });

  test("説明の「唐突に」「不自然に」は、視点の札では落とさない", () => {
    const result = validate([
      {
        line: 13,
        original: "少しだけ胸が温かくなった。",
        suggestion: "",
        reason: "視点",
        explanation: "俺の語りの途中で、唐突に千夏の胸の内へ移り不自然です",
        confidence: "low",
      },
    ]);
    expect(result.rejected).toEqual([]);
  });

  test("実測の誤検出：語り手自身の独白を、長さ・語調の話として視点の札で出したものは落とす", () => {
    const base = {
      line: 11,
      original: "俺は損をしたのだと思った。",
      suggestion: "",
      reason: "視点",
      confidence: "medium",
    };
    const result = validate([
      { ...base, explanation: "「俺」の語りなのに、自分の心理描写が長いため、少し流れが止まります。" },
      { ...base, explanation: "「俺」の語りなのに、自己分析的な文章が続き、地の文のトーンが不安定になります。" },
    ]);
    expect(result.rejected.map((entry) => entry.reason)).toEqual([
      "forbidden_aspect",
      "forbidden_aspect",
    ]);
  });
});

describe("視点の札で落とすもの", () => {
  test("まるごと台詞なら、語りのずれではない（not_narration）", () => {
    const result = validate([
      {
        line: 14,
        original: "「蓬田さんは本当はさびしいんだよ」",
        suggestion: "",
        reason: "視点",
        explanation: "千夏が蓬田さんの心の中を言い切っています",
        confidence: "low",
      },
    ]);
    expect(result.rejected.map((entry) => entry.reason)).toEqual(["not_narration"]);
  });

  test("指示の文を写しただけの説明は落とす（語尾を変えた写しも）", () => {
    const base = {
      line: 12,
      original: "蓬田さんは内心、この無口な配達員を気に入っていた。",
      suggestion: "",
      reason: "視点",
      confidence: "medium",
    };
    const result = validate([
      { ...base, explanation: "語り手が知り得ない他人の心の中を、地の文が言い切っている" },
      { ...base, explanation: "語り手が知り得ない他人の心の中を地の文が言い切っています" },
      { ...base, explanation: PROOFREAD_VIEWPOINT_EXAMPLE },
    ]);
    expect(result.rejected.map((entry) => entry.reason)).toEqual([
      "guide_echo",
      "guide_echo",
      "guide_echo",
    ]);
  });

  test("本文の名前を挙げた説明は、写しとみない", () => {
    expect(
      echoesViewpointGuide("「俺」の語りなのに、蓬田さんの内心が言い切られています")
    ).toBe(false);
    // 短い説明は比べない（「視点」の二字は指示にも正しい説明にも出る）
    expect(echoesViewpointGuide("視点のずれ")).toBe(false);
  });

  test("指示の語を原文として返したら、本文に無いので落ちる", () => {
    const result = validate([
      {
        line: 12,
        original: "語り手が知り得ない他人の心の中",
        suggestion: "",
        reason: "視点",
        explanation: "蓬田さんの内心が書かれています",
        confidence: "low",
      },
    ]);
    expect(result.rejected.map((entry) => entry.reason)).toEqual([
      "original_not_found",
    ]);
  });
});

/**
 * 2026-09-25 夜の測定（作者の作品3作12話）で、通った「視点」は e4b 2件・26b 15件、
 * **すべて誤検出**だった。形は4つ——推し量り、丸括弧の心の声、語り手自身の
 * 心の声や地の文の説明、三人称の場面。ここに並べる説明と本文は、その形を
 * 写した作り例である（作者の本文は写していない）。
 */
function viewpoint(
  line: number,
  original: string,
  explanation: string,
  text: string
) {
  return validateProofreadIssues(
    {
      issues: [
        {
          line,
          original,
          suggestion: "",
          reason: "視点",
          explanation,
          confidence: "medium",
        },
      ],
    },
    chunkOf(text)
  );
}

/** 「俺」の語りの場面（1〜4行目）。5行目以降を足して使う */
const ORE_SCENE = [
  "　俺は坂の途中で足を止めた。",
  "　俺の足首はまだ痛んだ。",
  "　俺は伝票の束を抱え直した。",
  "　俺は窓口の椅子に座った。",
].join("\n");

describe("視点の札を絞る（2026-09-25 の2回目）", () => {
  test("三人称の場面では出さない（not_first_person_scene）", () => {
    const text =
      "　宰相は書類を国王の前に置いた。\n" +
      "　国王は内心、この若い宰相を疎ましく思っていた。\n" +
      "　宰相は一礼して下がった。";
    const result = viewpoint(
      12,
      "国王は内心、この若い宰相を疎ましく思っていた。",
      "宰相の語りの中に、国王の『疎ましく思っていた』という心が書かれています",
      text
    );
    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((entry) => entry.reason)).toEqual([
      "not_first_person_scene",
    ]);
  });

  test("場面の区切りの後が三人称なら、そこでは出さない。前の一人称の場面では出す", () => {
    const text =
      `${ORE_SCENE}\n` +
      "　蓬田さんは内心、この無口な配達員を気に入っていた。\n" +
      "◆◇◆◇\n" +
      "　宰相は書類を置いた。\n" +
      "　国王は内心、宰相を疎ましく思っていた。";
    const before = viewpoint(
      15,
      "蓬田さんは内心、この無口な配達員を気に入っていた。",
      "「俺」の語りなのに、蓬田さんの『気に入っていた』が言い切られています",
      text
    );
    expect(before.accepted.map((issue) => issue.line)).toEqual([15]);
    const after = viewpoint(
      18,
      "国王は内心、宰相を疎ましく思っていた。",
      "「俺」の語りなのに、国王の『疎ましく』が言い切られています",
      text
    );
    expect(after.rejected.map((entry) => entry.reason)).toEqual([
      "not_first_person_scene",
    ]);
  });

  test("推し量り（〜のか、〜らしい、〜ようだ、〜だろう）は視点のずれではない", () => {
    const text =
      `${ORE_SCENE}\n` +
      "　無意識なのか、騎士は顔の古傷をなでている。\n" +
      "　騎士は顔をあげそうになって、意思の力で押さえ込んだらしい。\n" +
      "　騎士は少しむっとしたようだ。\n" +
      "　あの洞窟には大きな群れは住めないだろう。";
    const cases: Array<[number, string]> = [
      [15, "顔の古傷をなでている。"],
      [16, "意思の力で押さえ込んだらしい。"],
      [17, "騎士は少しむっとしたようだ。"],
      [18, "大きな群れは住めないだろう。"],
    ];
    for (const [line, original] of cases) {
      const result = viewpoint(
        line,
        original,
        "「俺」の語りの中に、騎士の心の動きが書かれています",
        text
      );
      expect({ line, reasons: result.rejected.map((entry) => entry.reason) }).toEqual({
        line,
        reasons: ["narrator_guess"],
      });
    }
  });

  test("「〜だろうと思い」は人物の考えの中身であって、語り手の推し量りではない（仕込み C）", () => {
    const text =
      `${ORE_SCENE}\n` +
      "　千夏は伝票を揃えながら、相沢くんはきっと来月も水筒を忘れるだろうと思い、少しだけ胸が温かくなった。";
    const result = viewpoint(
      15,
      "少しだけ胸が温かくなった。",
      "相沢の語りの中に、千夏の「胸が温かくなった」という感覚が書かれています",
      text
    );
    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
  });

  test("丸括弧の心の声は、誰の考えか作者が示している（inner_voice）", () => {
    const text = `${ORE_SCENE}\n（あいつはもうちょい考えるべきだったかもしれへんな）\n　騎士は(なんで俺が)と思った。`;
    const first = viewpoint(
      15,
      "（あいつはもうちょい考えるべきだったかもしれへんな）",
      "地の文に括弧書きの心の声が割り込み、誰の考えか分かりません",
      text
    );
    expect(first.rejected.map((entry) => entry.reason)).toEqual(["inner_voice"]);
    const second = viewpoint(
      16,
      "なんで俺が",
      "「俺」の語りなのに、騎士の心の中が書かれています",
      text
    );
    expect(second.rejected.map((entry) => entry.reason)).toEqual(["inner_voice"]);
  });

  test("語り手自身の心の声・考え・地の文の説明は、視点のずれではない（narrator_own_mind）", () => {
    const text = `${ORE_SCENE}\n　弱めと言ったつもりだったんだけど、ある意味予想通りだ。`;
    const explanations = [
      "「俺」の心の声が、地の文に直接入り込んでいます",
      "「俺」の思考が、地の文の独白として混ざっています",
      "「俺」の視点の中に、一般的な知識の解説が地の文として入り込んでいます",
      "「俺」の視点の中に、状況を客観的に説明する地の文が混ざっています",
      "兵士の視点の中に、兵士自身の「予想通り」という内面的な感覚が書かれています",
      "「俺」の語りの中に、突如「僕」という一人称が混じっています",
      "一人称が「俺」から「おれ」に変わっています",
    ];
    for (const explanation of explanations) {
      const result = viewpoint(15, "ある意味予想通りだ。", explanation, text);
      expect({ explanation, reasons: result.rejected.map((entry) => entry.reason) }).toEqual({
        explanation,
        reasons: ["narrator_own_mind"],
      });
    }
  });

  test("ほかの人物の心も、視点の移りも言っていない説明は落とす（no_other_mind）", () => {
    const text = `${ORE_SCENE}\n　あの洞窟はおそらく群れの巣だ。\n　ナイン様は三百歳を超えても、若く見える。`;
    const first = viewpoint(
      15,
      "あの洞窟はおそらく群れの巣だ。",
      "「俺」の視点なのに、群れであるという確信が地の文で言い切られています",
      text
    );
    expect(first.rejected.map((entry) => entry.reason)).toEqual(["no_other_mind"]);
    const second = viewpoint(
      16,
      "若く見える。",
      "トゥエルの語りの中に、トゥエルが知り得ないナインの年齢への言及があります",
      text
    );
    expect(second.rejected.map((entry) => entry.reason)).toEqual(["no_other_mind"]);
  });

  test("語り手が「知らない」と断っている形は、推し量りと同じく落とす", () => {
    const text = `${ORE_SCENE}\n　ナイン様が何歳なのかは知らないが、若く見える。`;
    const result = viewpoint(
      15,
      "若く見える。",
      "「俺」の語りなのに、ナインの年齢の感覚が書かれています",
      text
    );
    expect(result.rejected.map((entry) => entry.reason)).toEqual(["narrator_guess"]);
  });

  /**
   * 推敲の比べ（2026-09-26、教科書チート）で Kimi-K2.6 が挙げた3件は、どれも
   * **語り手に見える・聞こえる様子**だった（「怒りに満ちた表情で牙を剥きだした」
   * 「さっきまでの照れた反応とは違って、ちょっと怒気がこもっている」
   * 「今は般若もかくやという顔をしている」）。顔つき・反応・声の調子は、一人称の
   * 語り手が見て書けるもので、知り得ない心ではない。作り例で写す
   */
  test("語り手に見える様子（表情・顔・反応・態度）は、知り得ない心ではない（observable）", () => {
    const text =
      `${ORE_SCENE}\n` +
      "　騎士は怒りに満ちた表情で剣を抜いた。\n" +
      "　さっきまでの照れた反応とは違って、千夏の声には怒気がこもっている。\n" +
      "　普段は大人しげだったのに、今は鬼のような顔をしている。";
    const cases: Array<[number, string, string]> = [
      [15, "怒りに満ちた表情で剣を抜いた。", "「俺」の語りなのに、騎士の「怒り」が言い切られています"],
      [16, "さっきまでの照れた反応とは違って", "「俺」の語りなのに、千夏の「照れた」心が書かれています"],
      [17, "今は鬼のような顔をしている。", "「俺」の語りなのに、千夏の怒りの心が書かれています"],
    ];
    for (const [line, original, explanation] of cases) {
      const result = viewpoint(line, original, explanation, text);
      expect({ line, reasons: result.rejected.map((entry) => entry.reason) }).toEqual({
        line,
        reasons: ["observable"],
      });
    }
  });

  test("段落の途中で視点が移る指摘は残す", () => {
    const text = `${ORE_SCENE}\n　千夏は窓の外を見て、明日は晴れると信じていた。`;
    const result = viewpoint(
      15,
      "明日は晴れると信じていた。",
      "俺の語りの途中から、千夏の視点に移っています",
      text
    );
    expect(result.rejected).toEqual([]);
  });

  test("通った視点の説明には、必ず「わざとなら、このままで構いません」を添える", () => {
    const text = `${ORE_SCENE}\n　蓬田さんは内心、この無口な配達員を気に入っていた。`;
    const result = viewpoint(
      15,
      "蓬田さんは内心、この無口な配達員を気に入っていた。",
      "「俺」の語りなのに、蓬田さんの『気に入っていた』が言い切られています",
      text
    );
    expect(result.accepted[0]?.explanation).toBe(
      "「俺」の語りなのに、蓬田さんの『気に入っていた』が言い切られています" +
        "（わざとなら、このままで構いません）"
    );
  });

  test("説明が空・札の名前だけの視点は、誰の心か確かめられないので落とす", () => {
    const text = `${ORE_SCENE}\n　蓬田さんは内心、この無口な配達員を気に入っていた。`;
    for (const explanation of ["", "視点"]) {
      const result = viewpoint(
        15,
        "蓬田さんは内心、この無口な配達員を気に入っていた。",
        explanation,
        text
      );
      expect(result.rejected.map((entry) => entry.reason)).toEqual(["no_other_mind"]);
    }
  });

  test("すでに「わざと」の断りがある説明には重ねない", () => {
    const text = `${ORE_SCENE}\n　蓬田さんは内心、この無口な配達員を気に入っていた。`;
    const result = viewpoint(
      15,
      "蓬田さんは内心、この無口な配達員を気に入っていた。",
      "「俺」の語りに蓬田さんの内心が入っています。わざとなら問題ありません",
      text
    );
    expect(result.accepted[0]?.explanation).toBe(
      "「俺」の語りに蓬田さんの内心が入っています。わざとなら問題ありません"
    );
  });
});

describe("札と指示", () => {
  test("札は7つで、視点が入っている", () => {
    expect(PROOFREAD_REASONS).toHaveLength(7);
    expect(normalizeReason("視点")).toBe("視点");
    expect(normalizeReason("視点のずれ")).toBe("視点");
    expect(explainProofreadReason("視点")).toContain("わざとなら");
  });

  test("プロンプトに視点の定義と「推し量りは違う」が入り、版は 1.11", () => {
    const prompt = buildProofreadPrompt({
      chunkTextWithLineNumbers: "1: 本文",
      narrativeStyle: "",
      maxIssues: 3,
    });
    expect(prompt).toContain("7. 視点");
    expect(prompt).toContain("視点のずれではありません");
    expect(prompt).toContain("、視点");
    expect(PROOFREAD_VERSION).toBe("1.11");
  });

  test("1.11：視点は一人称の場面の2つの形だけ。語り手自身の心の声・丸括弧は挙げない", () => {
    const prompt = buildProofreadPrompt({
      chunkTextWithLineNumbers: "1: 本文",
      narrativeStyle: "",
      maxIssues: 3,
    });
    // 1.10 の3つ目（括弧の無い心の声）は、語り手自身の心の声を拾わせていた
    expect(prompt).not.toContain("誰の考えなのか分からない");
    expect(prompt).toContain("語り手自身の心の声");
    expect(prompt).toContain("丸括弧");
  });
});
