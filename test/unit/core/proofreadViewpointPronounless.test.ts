import { describe, expect, test } from "vitest";
import {
  validateProofreadIssues,
  type ViewpointNarrator,
} from "../../../src/core/proofreadValidation";
import type { Chunk } from "../../../src/core/chunker";

/**
 * 地の文に一人称の語（俺・僕・私…）が1つも無い一人称の場面で、
 * 推敲の「視点」の札が本物のよじれまで落としていた穴（2026-10-10 の測定）。
 *
 * 未亡人13話（地の文の「俺」が0回）に B・C と同じ形を2行仕込むと、26b は
 * 2回とも2行とも「視点」で挙げたが、`not_first_person_scene` で全部落ちた。
 * **作品全体で語り手が決まっている**ときは、一人称の語が0回の場面を
 * 語り手の一人称の場面として扱う。語り手自身の心の声の誤検出は、
 * 後ろの守り（`observable`・`no_other_mind` など）が止める。
 */

// 代名詞の無い一人称の場面（11行目から）。語り手は「俺」（アジャーノ）。
// 文は測定の台（未亡人13話の写し＋仕込み）と同じ形を、ここ用に書いたもの
const PRONOUNLESS = [
  "　今回の狙いはミノタウロスだ。",
  "　洞窟の入り口には、大きな足跡がいくつも残っている。",
  "　エルシーさんは内心、この無愛想な冒険者を誰よりも頼もしく思っていた。",
  "　エルシーさんは足跡を見下ろしながら、この冒険者はきっと次も助けてくれるだろうと思い、少しだけ胸が弾んだ。",
  "「ナイン様にお肉を持って帰らないと」",
  "　とんちんかんな疑問は放置して、周囲を見回す。",
  "　思考の海に沈んでいった。子どもの戯言に、そこまで真剣に反応しなくても良いのに。",
  "　おそらく群れだ。",
  "　打ち合わせも何もなく、二人同時に元来た道をダッシュする。",
  "　主のナイン様に肉を持って帰るという任務を忘れているらしい。",
  "　まだ洞窟内に仲間がいる可能性がある。子どもをかばってオークを大量に相手するのは御免被りたい。",
  "　特大のファイアボールが洞窟内に向かって飛ぶ。弱めと指示したつもりだったんだけど、ある意味予想通りだ。",
  "　エルシーさんは杖を握り直した。きっと次も上手くいくだろうと思い、少しだけ胸が弾んだ。",
];

const NARRATOR: ViewpointNarrator = {
  firstPerson: "俺",
  nameForms: ["アジャーノ"],
};

function chunkOf(text: string): Chunk {
  return {
    filePath: "C:/works/013.txt",
    index: 0,
    text,
    startLine: 10,
    chapterStart: 13,
    chapterEnd: 13,
    hash: "pronounless",
    segments: [],
  } as unknown as Chunk;
}

function viewpoint(
  line: number,
  original: string,
  explanation: string,
  options: { text?: string; narrator?: ViewpointNarrator | null } = {}
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
    chunkOf(options.text ?? PRONOUNLESS.join("\n")),
    [],
    options.narrator === undefined ? NARRATOR : options.narrator
  );
}

const B_LINE = 13;
const B = "エルシーさんは内心、この無愛想な冒険者を誰よりも頼もしく思っていた。";
const B_EXPLANATION = "「俺」の語りの中に、エルシーさんの「内心」が言い切られています";
const C_LINE = 14;
const C =
  "エルシーさんは足跡を見下ろしながら、この冒険者はきっと次も助けてくれるだろうと思い、少しだけ胸が弾んだ。";
const C_EXPLANATION =
  "「俺」の語りの中に、エルシーさんの「思い」や「胸が弾んだ」が書かれています";

describe("一人称の語が0回の場面（語り手が決まっている作品）", () => {
  test("B（知り得ない他人の心の断定）は通る", () => {
    const result = viewpoint(B_LINE, B, B_EXPLANATION);
    expect(result.rejected.map((entry) => entry.reason)).toEqual([]);
    expect(result.accepted.map((issue) => issue.line)).toEqual([B_LINE]);
  });

  test("C（途中の視点移り）は通る", () => {
    const result = viewpoint(C_LINE, C, C_EXPLANATION);
    expect(result.rejected.map((entry) => entry.reason)).toEqual([]);
    expect(result.accepted.map((issue) => issue.line)).toEqual([C_LINE]);
  });

  test("語り手が決まらない作品では、今までどおり落とす", () => {
    for (const narrator of [null, undefined] as const) {
      const result = validateProofreadIssues(
        {
          issues: [
            {
              line: B_LINE,
              original: B,
              suggestion: "",
              reason: "視点",
              explanation: B_EXPLANATION,
              confidence: "medium",
            },
          ],
        },
        chunkOf(PRONOUNLESS.join("\n")),
        [],
        narrator
      );
      expect(result.accepted).toEqual([]);
      expect(result.rejected.map((entry) => entry.reason)).toEqual([
        "not_first_person_scene",
      ]);
    }
  });

  test("語り手自身の心の声を「視点」で挙げたものは落とす（測定で 26b が挙げた形）", () => {
    const original =
      "思考の海に沈んでいった。子どもの戯言に、そこまで真剣に反応しなくても良いのに。";
    for (const explanation of [
      "皇子の視点（一人称）の場面で、先生の心理（真剣に反応しなくても良いのに）が書かれています",
      "皇子の視点（一人称）の地の文の中に、先生の思考（真剣に反応しなくても良いのに）が混じっています",
    ]) {
      const result = viewpoint(17, original, explanation);
      expect(result.accepted).toEqual([]);
      expect(result.rejected).toHaveLength(1);
      // 一文に「反応」があり、語り手に見える様子として落ちる。関門を通ったうえで
      // 後ろの守りが止めていることを見張る（ここが通ると②の誤検出になる）
      expect(result.rejected[0].reason).toBe("observable");
    }
  });

  test("ほかに 26b が挙げた誤検出（語り手の考え・推し量り・時制）も落とす", () => {
    const cases: Array<[number, string, string]> = [
      [18, "おそらく群れだ。", "語り手である「俺」が、他者の状況を「群れだ」と言い切っています"],
      [18, "おそらく群れだ。", "語り手（俺）の推測を、地の文で「群れだ」と言い切っています"],
      [
        19,
        "打ち合わせも何もなく、二人同時に元来た道をダッシュする。",
        "「俺」の視点ですが、動作が現在形（ダッシュする）になっています",
      ],
      [
        19,
        "打ち合わせも何もなく、二人同時に元来た道をダッシュする。",
        "「俺」の視点ですが、エルシーさんと「同時に」動いたという、二人の動作の同期が客観視されています",
      ],
      [
        16,
        "とんちんかんな疑問は放置して、周囲を見回す。",
        "エルシーの疑問を「とんちんかん」と断じるのは、語り手の主観的な評価です",
      ],
      [
        20,
        "主のナイン様に肉を持って帰るという任務を忘れているらしい。",
        "「俺」の視点なのに、エルシーさんが任務を忘れているかどうかを断定しています",
      ],
      [
        21,
        "まだ洞窟内に仲間がいる可能性がある。子どもをかばってオークを大量に相手するのは御免被りたい。",
        "「俺」の語りの中に、エルシーさんの「（子どもを）かばって」という状況判断が含まれています",
      ],
    ];
    for (const [line, original, explanation] of cases) {
      const result = viewpoint(line, original, explanation);
      expect({ original, explanation, accepted: result.accepted.length }).toEqual({
        original,
        explanation,
        accepted: 0,
      });
    }
  });

  test("説明が名指しした人物が、その段落の主語に立っていなければ落とす（語り手自身の考え）", () => {
    // 0.101.9 の測定（26b、未亡人13話＋仕込み 2回目）で、関門を緩めたあとに
    // 1件だけ通った誤検出。「つもり」が心の語に当たり、`no_other_mind` を抜けた。
    // 段落の主語は「ファイアボール」で、エルシーは出てこない——代名詞の無い場面では、
    // 主語の無い文は語り手のこと
    const result = viewpoint(
      22,
      "特大のファイアボールが洞窟内に向かって飛ぶ。弱めと指示したつもりだったんだけど、ある意味予想通りだ。",
      "「俺」の視点なのに、エルシーの魔法の威力に対する「予想通りだ」という評価が混ざっています"
    );
    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((entry) => entry.reason)).toEqual(["no_named_other"]);
  });

  test("心の語が説明の言い換えにしか無く、原文の文に無ければ落とす（見える動作）", () => {
    // 0.101.9 の測定（26b、未亡人13話＋仕込み）で通った誤検出。
    // 「腰を抜かしてへたり込む」は語り手に見える動作で、「感じて」はAIの言い換えにしか無い。
    // 同じ段落の前の文の「怒り」（オークの見える声）では通さない
    const text = [
      ...PRONOUNLESS.slice(0, 4),
      "　もう一匹のオークが怒りの声をあげ、棍棒を振り上げる。満ちる殺気に、先ほどまでオークを殴りつけていた少年が腰を抜かしてへたり込む。",
    ].join("\n");
    const result = viewpoint(
      15,
      "満ちる殺気に、先ほどまでオークを殴りつけていた少年が腰を抜かしてへたり込む。",
      "「俺」の視点なのに、少年の「殺気を感じて腰を抜かす」という感覚が地の文で書かれています",
      { text }
    );
    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((entry) => entry.reason)).toEqual(["no_other_mind"]);
  });

  test("説明が原文を「」で引いただけで、その外で主語の人物を名指ししていなければ落とす", () => {
    // 0.101.9 の測定（26b、未亡人13話 2回目）で通った誤検出。段落の主語の候補
    // 「火力も」の「火力」が、説明の引用（「最悪エルシーさんの火力もある」）にだけあった
    const text = [
      ...PRONOUNLESS.slice(0, 4),
      "　あの洞窟には大規模な群れは住めないだろう。なら気づかれたところで狩れば良いし、最悪エルシーさんの火力もあるが……。",
    ].join("\n");
    const result = viewpoint(
      15,
      "なら気づかれたところで狩れば良いし、最悪エルシーさんの火力もあるが……。",
      "「最悪エルシーさんの火力もある」は、エルシーさんの能力に対する見立てです",
      { text }
    );
    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((entry) => entry.reason)).toEqual(["no_named_other"]);
  });

  test("説明が「語り手の評価・主観・感想」と言うものは、語り手自身の心として落とす", () => {
    for (const explanation of [
      "「最悪エルシーさんの火力もある」は、エルシーさんの能力に対する語り手の評価です",
      "「ある意味予想通りだ」は、語り手の主観的な感想が地の文に混ざっています",
    ]) {
      const result = viewpoint(B_LINE, B, explanation);
      expect({ explanation, reasons: result.rejected.map((entry) => entry.reason) }).toEqual({
        explanation,
        reasons: ["narrator_own_mind"],
      });
    }
  });

  test("段落の途中で移る形（C）は、同じ段落の主語に名指しの人物がいれば通す", () => {
    const result = viewpoint(
      23,
      "きっと次も上手くいくだろうと思い、少しだけ胸が弾んだ。",
      "「俺」の語りの中に、エルシーさんの「思い」や「胸が弾んだ」が書かれています"
    );
    expect(result.rejected.map((entry) => entry.reason)).toEqual([]);
    expect(result.accepted.map((issue) => issue.line)).toEqual([23]);
  });

  test("一人称の語が数えられる場面では、名指しの人物の確かめはしない（今までどおり）", () => {
    const text = [
      "　俺は坂の途中で足を止めた。",
      "　俺の足首はまだ痛んだ。",
      "　特大のファイアボールが洞窟内に向かって飛ぶ。蓬田さんは内心、この配達員を気に入っていた。",
    ].join("\n");
    const result = viewpoint(
      13,
      "蓬田さんは内心、この配達員を気に入っていた。",
      "「俺」の語りなのに、他人の内心が言い切られています",
      { text }
    );
    expect(result.accepted.map((issue) => issue.line)).toEqual([13]);
  });

  test("別の人物の一人称が地の文に出る場面では落とす（多視点の作品の別の章）", () => {
    const text = [...PRONOUNLESS.slice(0, 4), "　私は窓の外を見た。"].join("\n");
    const result = viewpoint(B_LINE, B, B_EXPLANATION, { text });
    expect(result.rejected.map((entry) => entry.reason)).toEqual([
      "not_first_person_scene",
    ]);
  });

  test("語り手の名前が地の文の主語に2回以上立つ場面は三人称の語りなので落とす", () => {
    const text = [
      "　アジャーノは洞窟の前で立ち止まった。",
      "　アジャーノが足跡を数える。",
      ...PRONOUNLESS.slice(2, 4),
    ].join("\n");
    const result = viewpoint(B_LINE, B, B_EXPLANATION, { text });
    expect(result.rejected.map((entry) => entry.reason)).toEqual([
      "not_first_person_scene",
    ]);
  });

  test("語り手の名前が主語に1回だけなら（名前のよじれの候補）、一人称の場面のまま", () => {
    const text = ["　アジャーノは洞窟の前で立ち止まった。", ...PRONOUNLESS.slice(1, 4)].join(
      "\n"
    );
    const result = viewpoint(B_LINE, B, B_EXPLANATION, { text });
    expect(result.accepted.map((issue) => issue.line)).toEqual([B_LINE]);
  });

  test("台詞の中の名前は数えない", () => {
    const text = [
      "「アジャーノは強いね。アジャーノが来てくれてよかった」",
      ...PRONOUNLESS.slice(1, 4),
    ].join("\n");
    const result = viewpoint(B_LINE, B, B_EXPLANATION, { text });
    expect(result.accepted.map((issue) => issue.line)).toEqual([B_LINE]);
  });

  test("語り手の一人称が1回だけの場面は、今までどおり落とす（0回の場面だけを広げた）", () => {
    const text = [PRONOUNLESS[0], "　俺は足跡を数えた。", ...PRONOUNLESS.slice(2, 4)].join(
      "\n"
    );
    const result = viewpoint(B_LINE, B, B_EXPLANATION, { text });
    expect(result.rejected.map((entry) => entry.reason)).toEqual([
      "not_first_person_scene",
    ]);
  });
});
