import {
  adviceLevel,
  ADVICE_AXIS_LABELS,
  ADVICE_LEVEL_LABELS,
  adviceAxesOf,
  ADVICE_TYPES,
  formatAdviceScore,
  resolveAdviceType,
  type AdviceProfile,
  type AdviceScores,
} from "./advicePolicy";
import {
  diagnosisNarrative,
  describeWriterStyle,
  WRITER_PLAN_TYPES,
  type TutorialAdvice,
  type TutorialGoalInfo,
  type WriterStyle,
} from "./writerStyle";

/** 画面に出すときの名前。タブの見出しにもなる */
export const WRITER_GUIDE_TITLE = "はじめの案内";

/**
 * はじめの案内の紙を組み立てる（設計書6.90）。
 *
 * **選択肢の前に、これを開く**（作者の指摘、2026-09-13
 * 「すぐに選択肢を表示するのではなく、作者が何をしたいか聞き取って、
 * アドバイスしてから選択肢を表示してください。おそらく今はなぜその選択肢が
 * でているかわからないと思います」）。
 *
 * 紙にする理由は2つ。
 *
 * 1. **選択肢の一覧では、理由を書く場所が1行しかない。** なぜその操作を
 *    勧めているのかは、1行では書けない
 * 2. **あとで読み返せる。** はじめて使う日に全部は覚えられない
 *
 * ここは純粋な部品である。VS Code に触らないので、そのまま単体テストできる
 * （`openManual.ts` の `buildUserManual` と同じ作り）。
 */
export function buildWriterGuide(input: {
  style: WriterStyle;
  goal: TutorialGoalInfo;
  advice: TutorialAdvice;
  /**
   * 6.86 の助言方針。まだ9問に答えていなければ省く。
   *
   * **点数ごと受け取る**（0.52.1）。名前と説明だけだと、3軸の目盛りを
   * 出せない——**タイプ診断の紙で、いちばん見たいのはそこ**である。
   */
  advicePolicy?: AdviceProfile;
}): string {
  const { style, goal, advice } = input;
  const type = input.advicePolicy
    ? ADVICE_TYPES[resolveAdviceType(input.advicePolicy.scores)]
    : undefined;

  const parts: string[] = [`# ${WRITER_GUIDE_TITLE}`, ""];

  /*
    **タイプを、いちばん上に置く**（作者の指摘、2026-09-13
    「タイプ診断なのに、スタイルが一番上に来ています」）。

    名乗っているのはタイプ診断である。最初に目に入るのが
    「折衷派／直すのは1話ごと／…」では、何の診断なのか分からない。
    **名前・一行・目盛り**の順で置く——この3つが揃っていると、
    そこだけ切り取っても読める。
  */
  if (type) {
    parts.push(
      `## あなたは **${type.label}**`,
      "",
      `> ${type.summary}`,
      "",
      ...axisTable(input.advicePolicy!.scores),
      "",
      ...whyThisName(input.advicePolicy!.scores),
      "",
      "3つの軸は9問から決まります。**上下に良し悪しはありません**——どの帯にいるかで、効く助言が変わるだけです。相談を重ねるうちに、少しずつ動きます。",
      "",
      "### このタイプだと、何が変わりますか",
      "",
      "- **AIへの相談**：このタイプ向けの言い方だけを渡します（ほかの10タイプの文は送りません。混ぜると、どちらとも取れる助言になります）",
      "- **下の案内**：5問のほうのお答えに合わせて並べています",
      "- **診断した日**：" + input.advicePolicy!.updatedAt.slice(0, 10) +
        "（30日ほど経ったら、答え直すと合いやすくなります）",
      ""
    );
  } else {
    // **9問に答えていなければ、段取りの呼び名を主役にする。**
    // 答えていないタイプを名乗らせない（6.86.3）
    parts.push(
      `## あなたは **${WRITER_PLAN_TYPES[style.plan].label}**`,
      "",
      `> ${WRITER_PLAN_TYPES[style.plan].summary}`,
      "",
      "**もう9問お答えいただくと、11タイプのどれかが決まります。**" +
        "「作家タイプ診断」から続けて答えられます。",
      ""
    );
  }

  parts.push(
    "## 書き方",
    "",
    ...diagnosisNarrative(style).map((line) => `${line}\n`),
    `（${describeWriterStyle(style)}）`,
    "",
    "この紙は拡張機能の保管庫に置いてあり、作品フォルダーにも GitHub にも入りません。"
  );

  parts.push(
    "",
    `## いま「${goal.label}」を選ばれました`,
    "",
    `この選択肢が出ていたのは、${goal.why}。`,
    "",
    advice.advice,
    "",
    "## このあと、できること",
    "",
    "**順番に意味があります。** 上から見ていただくのがいちばん早いはずです。"
  );

  advice.steps.forEach((step, index) => {
    parts.push(
      "",
      `### ${index + 1}. ${step.label}`,
      "",
      `${step.why}。`
    );
  });

  if (advice.later.length > 0) {
    parts.push("", "## いまはまだ、できないこと", "");
    for (const line of advice.later) {
      parts.push(`- ${line}`);
    }
  }

  /*
    **「できない」と「いま出さない」を分ける**（0.52.0）。
    執筆統計を「できないこと」に並べると、使えないものとして伝わる。
    実際は開けるので、**出さないと決めた理由のほうを書く**。
  */
  if (advice.withheld && advice.withheld.length > 0) {
    parts.push("", "## いまは出していないもの", "");
    for (const line of advice.withheld) {
      parts.push(`- ${line}`);
    }
  }

  parts.push(
    "",
    "---",
    "",
    "## 覚えておいていただきたいこと",
    "",
    "- **AIが原稿を書き換えることはありません。** 指摘はすべて提案で、" +
      "適用するのはあなたです",
    "- **原稿はただのテキスト／Markdown ファイルのままです。** " +
      "文字コードも改行も変えず、他のエディタからも今までどおり開けます",
    "- 案内が合わないと感じたら、**「作家タイプ診断」から答え直せます**" +
      `（いまの答えは「${WRITER_PLAN_TYPES[style.plan].label}」ほか）`
  );

  parts.push(...otherTypes(style, type?.label));

  return parts.join("\n");
}

/**
 * **ほかのタイプも並べる**（作者の指定、2026-09-13
 * 「説明文ですが、最後に他のタイプの一覧を出してください」）。
 *
 * **自分のぶんだけ見せられても、当たっているのか分からない。** 隣に何が
 * あるかを読めば、作者は「こちらのほうが近い」と気づける。診断は決めつけでは
 * なく出発点なので（6.86.5）、**そこから動かす手掛かり**を渡しておく。
 *
 * **紙のいちばん後ろに置く。** 先に読ませるのは、その人に効く話のほうである。
 */
function otherTypes(
  style: WriterStyle,
  adviceLabel: string | undefined
): string[] {
  const mark = (own: boolean): string => (own ? "**← いまのあなた**" : "");

  const lines = [
    "",
    "---",
    "",
    "## ほかのタイプ",
    "",
    "当たっていないと感じたら、答え直してください。**診断は決めつけではなく、出発点です。**",
    "",
    "### 書き始める前に、どこまで決めるか（5問で決まります）",
    "",
  ];

  for (const [id, info] of Object.entries(WRITER_PLAN_TYPES)) {
    lines.push(`- **${info.label}**${mark(id === style.plan)}　${info.summary}`);
  }

  lines.push(
    "",
    "### 相談のときの言い分け（9問で決まる11タイプ）",
    "",
    adviceLabel
      ? "AIへの相談は、このタイプ向けの言い方だけを渡します（全部は送りません）。"
      : "**まだ9問には答えていません。** 「作家タイプ診断」から続けて答えられます。",
    ""
  );

  for (const info of Object.values(ADVICE_TYPES)) {
    lines.push(
      `- **${info.label}**${mark(info.label === adviceLabel)}　${info.summary}`
    );
  }

  return lines;
}

/**
 * 3つの軸を、目盛りの表にする（0.52.1）。
 *
 * **タイプ診断の紙で、いちばん見たいのはここである。** 名前だけ出されても
 * 「なぜそう出たのか」が分からず、当たっているかを確かめようがない。
 *
 * **上下に良し悪しを付けない。** 6 が満点ではなく、どの帯にいるかを示す
 * だけである（`ADVICE_TYPES` の説明書きと同じ考え方——足りないものではなく、
 * 役に立つものを書く）。そのため**両端に何があるか**を並べて、
 * 端から端までが同じ重さに見えるようにしてある。
 */
function axisTable(scores: AdviceScores): string[] {
  /** 両端の言い換え（6.86.1 の表と同じ言葉を使う。写しを作らない側に寄せる） */
  const ends: Record<keyof AdviceScores, [string, string]> = {
    reader: ["読者は視界にない", "読者基準で判断する"],
    self: ["自分を出す意識が薄い", "作品＝自分"],
    taste: ["題材は目的の手段", "題材そのものが目的"],
  };

  const rows = (Object.keys(ends) as Array<keyof AdviceScores>).map((axis) => {
    const score = scores[axis];
    const filled = Math.max(0, Math.min(6, Math.round(score)));
    const bar = "●".repeat(filled) + "○".repeat(6 - filled);
    const level = ADVICE_LEVEL_LABELS[adviceLevel(score)];
    return (
      `| ${ADVICE_AXIS_LABELS[axis]} | ${bar} | ${formatAdviceScore(score)}／6（${level}） | ` +
      `${ends[axis][0]} ←→ ${ends[axis][1]} |`
    );
  });

  return [
    "| 軸 | | 点 | 端から端まで |",
    "|---|---|---|---|",
    ...rows,
  ];
}

/**
 * **なぜその名前になったか**（0.52.1。作者の指摘「タイプに関する説明が手薄です」）。
 *
 * 名前だけ出されても、当たっているかを確かめようがない。
 * **どの軸が主で、どれが副か**——ここが読めれば、作者は自分で
 * 「合っている」「これは違う」と言える。
 */
function whyThisName(scores: AdviceScores): string[] {
  const { main, sub } = adviceAxesOf(scores);
  if (!main) {
    return [
      "3つの軸が**同じ帯にそろっている**ので、どれか一つを主とは呼びません。この名前は、そのそろい方から来ています。",
    ];
  }
  const mainLabel = ADVICE_AXIS_LABELS[main];
  const subLabel = sub ? ADVICE_AXIS_LABELS[sub] : undefined;
  return [
    subLabel
      ? `この名前は、**${mainLabel}**（主）と **${subLabel}**（副）の` +
        "組み合わせから来ています。"
      : `この名前は、**${mainLabel}**がただ一つ抜けていることから来ています。` +
        "ほかの2つは、いまのところ助言の向きを変えていません。"
  ];
}
