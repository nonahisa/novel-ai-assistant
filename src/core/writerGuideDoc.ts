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
  /** 6.86 の助言方針。まだ決めていなければ省く */
  advicePolicy?: { label: string; summary: string };
}): string {
  const { style, goal, advice } = input;

  const parts: string[] = [
    `# ${WRITER_GUIDE_TITLE}`,
    "",
    "診断のお答えから、いまのあなたに役に立ちそうな順で並べた紙です。",
    "**押す前に、なぜそれを勧めているのかが読めるように書いてあります。**",
    "この紙は拡張機能の保管庫に置いてあり、作品フォルダーにも GitHub にも入りません。",
    "",
    "## あなたの執筆スタイル",
    "",
    ...diagnosisNarrative(style).map((line) => `${line}\n`),
    `（${describeWriterStyle(style)}）`,
  ];

  if (input.advicePolicy) {
    parts.push(
      "",
      "### 相談のときの言い方",
      "",
      `AIへの相談は「**${input.advicePolicy.label}**」として応じます。` +
        input.advicePolicy.summary,
      "",
      "こちらは9問の別の診断（「相談の助言方針を決める」）で決まっています。" +
        "相談を重ねるうちに少しずつ動きます。"
    );
  }

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
    "- 案内が合わないと感じたら、**「作家のタイプ診断」から答え直せます**" +
      `（いまの答えは「${WRITER_PLAN_TYPES[style.plan].label}」ほか）`
  );

  return parts.join("\n");
}
