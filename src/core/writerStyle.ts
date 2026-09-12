/**
 * 作家のタイプ診断——執筆スタイルと、はじめの案内（設計書6.90）。
 *
 * 作者の依頼（2026-09-13）：「使用開始時に6.86をベースに執筆のスタイルも
 * 聞いてください。診断後、その中ですでに書いている作品があると判明した
 * 場合は既存作品の登録法を説明するなど、作者の意思に沿ったチュートリアルを
 * 行ってください」。
 *
 * ## 6.86（相談の助言方針）との分担
 *
 * | | 6.86 相談の助言方針 | 6.90 執筆スタイル（ここ） |
 * |---|---|---|
 * | 何を測るか | 人柄（読者志向・自己投影度・嗜好志向） | **やり方**（段取り・直す時期・資料・出す場所） |
 * | 点数にするか | する（0〜6・推定で動く） | **しない**（答えがそのまま事実） |
 * | 何が変わるか | AIの助言の言い方 | **はじめに案内する操作** |
 * | どこに持つか | 作品ごと | **作者ごと**（作品をまたぐ癖である） |
 *
 * **点数にしないのは、やり方に良し悪しが無いからである。** 「決めずに書く」は
 * 「決めてから書く」より低い点ではない。点にすると順序が生まれ、順序が
 * 生まれると「上を目指すもの」に見える。ここで欲しいのは**勧める操作を
 * 選ぶための事実**だけなので、選んだ答えをそのまま持つ。
 *
 * **呼び名を付けるのは段取りの軸だけ**（設計派・折衷派・即興派）。4軸すべてに
 * 名前を付けると 3×3×3×4＝108 通りになり、名前が何も言わなくなる。
 *
 * ## ここは純粋な部品である
 *
 * VS Code にも AI にも依存しない。画面（`features/writerDiagnosis.ts`）は
 * ここが返した結果を出すだけで、**勧める操作を選ぶ規則を写し持たない**。
 */

/** いまの状況。**点数にしない**——案内を分けるための事実である */
export type WriterSituation =
  /** パソコンの中に、書きかけ・書き上げた原稿のファイルがある */
  | "have_files"
  /** 投稿サイトに載せている作品がある */
  | "posted"
  /** これから書き始める */
  | "starting"
  /** 人の作品を編集・校閲する側で使う */
  | "editing";

/** 段取り——書き始める前にどこまで決めるか。**呼び名を付けるのはここだけ** */
export type WriterPlanType = "designer" | "hybrid" | "improviser";

/** 直す時期 */
export type WriterReviseTiming = "inline" | "per_episode" | "after_all";

/** 設定資料の持ち方 */
export type WriterMaterialHabit = "in_head" | "memo" | "documented";

/** 書いたものを出す場所 */
export type WriterOutlet = "serial" | "stock" | "publish" | "undecided";

/** 診断で決まる執筆スタイル */
export interface WriterStyle {
  situation: WriterSituation;
  plan: WriterPlanType;
  revise: WriterReviseTiming;
  material: WriterMaterialHabit;
  outlet: WriterOutlet;
}

/** 質問の1つ */
export interface WriterQuestion {
  /** S0・S1 のような呼び名。答えの並びを人が読み解くときの手掛かり */
  id: string;
  key: keyof WriterStyle;
  text: string;
  choices: readonly WriterChoice[];
}

export interface WriterChoice {
  value: string;
  label: string;
  /** 選ぶときの手掛かり。画面の説明欄に出す */
  detail: string;
}

/**
 * 執筆スタイルの質問（5問）。
 *
 * **6.86 と同じで、ふだんの行動を聞く。** 「あなたは計画的ですか」と聞くと、
 * なりたい姿のほうを答えてしまう。
 *
 * **1問目だけは性格ではなく状況を聞く。** ここが案内の分かれ目になる——
 * すでに原稿があるのに「新しい作品を作りましょう」と案内したら、
 * 作者は自分の原稿をどうすればよいのか分からないまま置いていかれる。
 */
export const WRITER_QUESTIONS: readonly WriterQuestion[] = [
  {
    id: "S0",
    key: "situation",
    text: "いま、書いているものはありますか",
    choices: [
      {
        value: "have_files",
        label: "パソコンの中に原稿のファイルがある",
        detail: "書きかけでも、書き上げたものでも",
      },
      {
        value: "posted",
        label: "投稿サイトに載せている作品がある",
        detail: "カクヨム・小説家になろうなど",
      },
      {
        value: "starting",
        label: "これから書き始める",
        detail: "まだ原稿はない",
      },
      {
        value: "editing",
        label: "人の作品を編集・校閲する",
        detail: "書くのではなく、見る側で使う",
      },
    ],
  },
  {
    id: "S1",
    key: "plan",
    text: "書き始める前に、どこまで決めますか",
    choices: [
      {
        value: "designer",
        label: "最後まで決めてから書く",
        detail: "結末も、途中の山場も決まっている",
      },
      {
        value: "hybrid",
        label: "大筋だけ決めて書く",
        detail: "行き先は決まっているが、道は書きながら",
      },
      {
        value: "improviser",
        label: "決めずに書きながら考える",
        detail: "書いてみないと分からない",
      },
    ],
  },
  {
    id: "S2",
    key: "revise",
    text: "書いたものを直すのは、いつですか",
    choices: [
      {
        value: "inline",
        label: "書きながら、その場で直す",
        detail: "気になったところで止まる",
      },
      {
        value: "per_episode",
        label: "1話を書き終えるごとに直す",
        detail: "区切りで見直してから次へ",
      },
      {
        value: "after_all",
        label: "全部書き終えてから直す",
        detail: "まず最後まで書く",
      },
    ],
  },
  {
    id: "S3",
    key: "material",
    text: "登場人物や世界の設定は、どこにありますか",
    choices: [
      {
        value: "in_head",
        label: "頭の中にある",
        detail: "書き出してはいない",
      },
      {
        value: "memo",
        label: "メモに書いている",
        detail: "散らばっているが、あることはある",
      },
      {
        value: "documented",
        label: "資料としてまとめている",
        detail: "見返せる形になっている",
      },
    ],
  },
  {
    id: "S4",
    key: "outlet",
    text: "書いたものは、どこへ出しますか",
    choices: [
      {
        value: "serial",
        label: "投稿サイトに連載する",
        detail: "書けたぶんから載せる",
      },
      {
        value: "stock",
        label: "書き溜めてから出す",
        detail: "まとまってから公開する",
      },
      {
        value: "publish",
        label: "公募や出版を考えている",
        detail: "紙・電子書籍の形にしたい",
      },
      {
        value: "undecided",
        label: "まだ決めていない",
        detail: "いまは書くことだけ",
      },
    ],
  },
];

/** 段取りの呼び名と、その人に何が役に立つか */
export interface WriterPlanInfo {
  label: string;
  /**
   * **足りないものではなく、役に立つものを書く**（6.86.3 と同じ考え方）。
   * 診断は品定めではない。
   */
  summary: string;
}

export const WRITER_PLAN_TYPES: Record<WriterPlanType, WriterPlanInfo> = {
  designer: {
    label: "設計派",
    summary:
      "先に組み上げてから書く人です。プロットと設定資料を土台にできるので、" +
      "書いたものが筋から外れていないかを機械に見張らせる使い方が向きます。",
  },
  hybrid: {
    label: "折衷派",
    summary:
      "行き先だけ決めて、道は書きながら選ぶ人です。大筋と本文のあいだを" +
      "行き来するので、書いたものからプロットを起こし直す使い方が向きます。",
  },
  improviser: {
    label: "即興派",
    summary:
      "書いてみて分かる人です。先に決めさせる道具は邪魔になるので、" +
      "書いたあとから設定資料や年表を起こす使い方が向きます。",
  },
};

export const WRITER_SITUATION_LABELS: Record<WriterSituation, string> = {
  have_files: "原稿のファイルがある",
  posted: "投稿サイトに載せている",
  starting: "これから書き始める",
  editing: "編集・校閲で使う",
};

export const WRITER_REVISE_LABELS: Record<WriterReviseTiming, string> = {
  inline: "書きながら直す",
  per_episode: "1話ごとに直す",
  after_all: "書き終えてから直す",
};

export const WRITER_MATERIAL_LABELS: Record<WriterMaterialHabit, string> = {
  in_head: "設定は頭の中",
  memo: "設定はメモに",
  documented: "設定は資料に",
};

export const WRITER_OUTLET_LABELS: Record<WriterOutlet, string> = {
  serial: "投稿サイトに連載",
  stock: "書き溜めてから",
  publish: "公募・出版",
  undecided: "出し先は未定",
};

/**
 * 答え（キー→選んだ値）から、執筆スタイルを組み立てる。
 *
 * **知らない値は受け取らない。** 保存したものを読み直す道でもここを通すので、
 * 古い版の値や手で書き換えた値が混ざったら `undefined` を返して、
 * 呼び出し側に「聞き直す」を選ばせる。
 */
export function buildWriterStyle(
  raw: Readonly<Record<string, unknown>>
): WriterStyle | undefined {
  const picked: Record<string, string> = {};
  for (const question of WRITER_QUESTIONS) {
    const value = raw[question.key];
    if (typeof value !== "string") return undefined;
    if (!question.choices.some((choice) => choice.value === value)) {
      return undefined;
    }
    picked[question.key] = value;
  }
  return {
    situation: picked.situation as WriterSituation,
    plan: picked.plan as WriterPlanType,
    revise: picked.revise as WriterReviseTiming,
    material: picked.material as WriterMaterialHabit,
    outlet: picked.outlet as WriterOutlet,
  };
}

/** スタイルを1行で言う。結果の画面と操作ログで同じ言い方を使う */
export function describeWriterStyle(style: WriterStyle): string {
  return [
    WRITER_PLAN_TYPES[style.plan].label,
    WRITER_REVISE_LABELS[style.revise],
    WRITER_MATERIAL_LABELS[style.material],
    WRITER_OUTLET_LABELS[style.outlet],
  ].join("／");
}

/* ───────────────────────────────────────────────────────────────
   はじめの案内（チュートリアル）

   **選択肢をいきなり出さない**（作者の指摘、2026-09-13）。
   「おそらく今はなぜその選択肢がでているかわからないと思います」。

   順番はこうする。

     1. 診断で何が分かったかを、言葉で返す（diagnosisNarrative）
     2. いま何をしたいかを聞く（tutorialGoals。**操作ではなく目的**を並べる）
     3. 選んだ目的に対して助言を1つ返す（tutorialAdvice）
     4. そのうえで操作を出す。**1つずつに「なぜ出ているか」を付ける**

   操作の一覧から始めると、作者は「押していいのか」から考えることになる。
   先に「あなたはこう答えた → だからこれを勧める」を渡しておけば、
   選択肢は答え合わせになる。
   ─────────────────────────────────────────────────────────────── */

/** いま何をしたいか。**操作名ではなく、作者の言葉で書く** */
export type TutorialGoal =
  /** 手元の原稿を、この拡張機能で扱えるようにしたい */
  | "bring_in"
  /** 新しく書き始めたい */
  | "start_new"
  /** 続きを書きたい */
  | "keep_writing"
  /** 書いたものを直したい */
  | "polish"
  /** 書いたものを出したい */
  | "publish"
  /** 人の作品を見る側で使いたい */
  | "review";

export interface TutorialGoalInfo {
  goal: TutorialGoal;
  label: string;
  /** **なぜこれが出ているか。** 診断の答えを根拠に書く */
  why: string;
}

/** 案内する操作の1つ */
export interface TutorialStep {
  /** 実際に走らせるコマンド。押せばその操作が始まる */
  command: string;
  label: string;
  /** **なぜこれを勧めるのか。** 診断の答えを根拠に書く */
  why: string;
}

export interface TutorialAdvice {
  /** 操作を出す前に読ませる一言。ここで筋を通す */
  advice: string;
  steps: TutorialStep[];
  /** いまはまだできないこと（作品を登録してから）。押せる形では出さない */
  later: string[];
}

/**
 * 診断で何が分かったかを、作者の言葉で返す。
 *
 * **品定めをしない。** 「あなたはこう答えた」「だからこう見ている」の2段で、
 * 足りないものは言わない（6.86.3 と同じ考え方）。
 */
export function diagnosisNarrative(style: WriterStyle): string[] {
  const plan = WRITER_PLAN_TYPES[style.plan];
  const lines = [
    `あなたは「${plan.label}」です。${plan.summary}`,
    `直すのは「${WRITER_REVISE_LABELS[style.revise]}」、` +
      `設定は「${WRITER_MATERIAL_LABELS[style.material]}」、` +
      `出し先は「${WRITER_OUTLET_LABELS[style.outlet]}」と答えていただきました。`,
  ];

  switch (style.situation) {
    case "have_files":
      lines.push(
        "すでに原稿のファイルをお持ちとのことでした。" +
          "この拡張機能は、いまあるファイルをそのまま扱います" +
          "——形式を変えたり、どこかへ移したりはしません。" +
          "まず、そのフォルダーを作品として登録するところから始めます。"
      );
      break;
    case "posted":
      lines.push(
        "投稿サイトに載せている作品があるとのことでした。" +
          "カクヨム・小説家になろうからダウンロードしたファイルは、" +
          "そのまま読めます（話数もヘッダーから拾います）。" +
          "まず、そのフォルダーを作品として登録するところから始めます。"
      );
      break;
    case "starting":
      lines.push(
        "これから書き始めるとのことでした。" +
          "始め方は2つあります——プロットから始めるか、本文から書き始めるか。" +
          "あとからどちらへも移れるので、いま決め込まなくて構いません。"
      );
      break;
    case "editing":
      lines.push(
        "人の作品を見る側で使うとのことでした。" +
          "編集者モードでは本文を書き換えません——直した案は提案として置き、" +
          "採るかどうかは作者が決めます。"
      );
      break;
  }
  return lines;
}

/**
 * いま何をしたいかの選択肢。**診断の答えで並べ替える。**
 *
 * @param hasWork 作品をもう登録しているか。**登録前にしかできないこと・
 *   登録後にしかできないことがあるので、押せないものを並べない**
 */
export function tutorialGoals(
  style: WriterStyle,
  hasWork: boolean
): TutorialGoalInfo[] {
  const goals: TutorialGoalInfo[] = [];

  if (style.situation === "editing") {
    goals.push({
      goal: "review",
      label: "人の作品を見る側で使う",
      why: "「編集・校閲で使う」と答えていただいたためです",
    });
  }

  if (!hasWork) {
    if (style.situation === "have_files" || style.situation === "posted") {
      goals.push({
        goal: "bring_in",
        label: "いまある原稿を、この拡張機能で扱えるようにする",
        why:
          style.situation === "posted"
            ? "投稿サイトに作品があると答えていただいたためです"
            : "原稿のファイルがあると答えていただいたためです",
      });
    }
    if (style.situation === "starting") {
      goals.push({
        goal: "start_new",
        label: "新しく書き始める",
        why: "これから書き始めると答えていただいたためです",
      });
    }
  } else {
    goals.push({
      goal: "keep_writing",
      label: "続きを書く",
      why: "作品はもう登録されています",
    });
    goals.push({
      goal: "polish",
      label: "書いたものを直す",
      why: `直すのは「${WRITER_REVISE_LABELS[style.revise]}」と答えていただいたためです`,
    });
    if (style.outlet !== "undecided") {
      goals.push({
        goal: "publish",
        label: "書いたものを出す",
        why: `出し先を「${WRITER_OUTLET_LABELS[style.outlet]}」と答えていただいたためです`,
      });
    }
  }

  // **どの答えでも、始め方が1つも出ない状態を作らない**
  if (goals.length === 0) {
    goals.push({
      goal: hasWork ? "keep_writing" : "start_new",
      label: hasWork ? "続きを書く" : "新しく書き始める",
      why: "ほかに当てはまるものが無かったためです",
    });
  }
  return goals;
}

/**
 * 選んだ目的に対する助言と、そのあとの操作。
 *
 * **助言を先に返す。** 操作だけを渡すと、作者は「なぜこれなのか」を
 * 自分で埋めることになる。
 */
export function tutorialAdvice(
  style: WriterStyle,
  goal: TutorialGoal
): TutorialAdvice {
  switch (goal) {
    case "bring_in":
      return bringInAdvice(style);
    case "start_new":
      return startNewAdvice(style);
    case "keep_writing":
      return keepWritingAdvice(style);
    case "polish":
      return polishAdvice(style);
    case "publish":
      return publishAdvice(style);
    case "review":
      return reviewAdvice();
  }
}

function bringInAdvice(style: WriterStyle): TutorialAdvice {
  const steps: TutorialStep[] = [
    {
      command: "novelai.addWork",
      label: "フォルダから作品を追加する",
      why:
        "原稿の入っているフォルダーを選ぶだけです。中のファイルは動かしません" +
        "——文字コードも改行もそのまま、他のエディタからも今までどおり開けます",
    },
    {
      command: "novelai.addWorkFromGithub",
      label: "GitHub にある作品を取り寄せる",
      why: "別のパソコンで書いたものが GitHub にあるなら、こちらです",
    },
  ];
  if (style.situation === "posted") {
    steps.push({
      command: "novelai.importRuby",
      label: "投稿サイトのルビを取り込む",
      why:
        "カクヨム・なろうの記法を、この拡張機能の書き方へ読み替えます。" +
        "件数を先に出すので、見てから決められます",
    });
  }
  return {
    advice:
      "まず1つ、作品を登録します。" +
      "登録は「このフォルダーを作品として見る」と決めるだけで、" +
      "原稿には何も起きません（コピーも変換もしません）。" +
      "登録すると、話数・文字数が自動で数えられるようになります。",
    steps,
    later: [
      "登録したあと、設定資料の抽出や校正が使えるようになります",
      ...(style.material === "in_head"
        ? [
            "設定が頭の中にあるとのことなので、登録後の「資料をまとめて抽出」が" +
              "いちばん効きます（本文から登場人物・場所・能力を起こします）",
          ]
        : []),
    ],
  };
}

function startNewAdvice(style: WriterStyle): TutorialAdvice {
  const plotFirst = style.plan !== "improviser";
  const steps: TutorialStep[] = plotFirst
    ? [
        {
          command: "novelai.createWorkWithPlot",
          label: "プロットから始める",
          why:
            `${WRITER_PLAN_TYPES[style.plan].label}と答えていただいたためです。` +
            "設定/plot.md を用意して、そこから書き始めます",
        },
        {
          command: "novelai.createWorkFromManuscript",
          label: "本文から書き始める",
          why: "決めるより先に書きたい日は、こちらでも構いません",
        },
      ]
    : [
        {
          command: "novelai.createWorkFromManuscript",
          label: "本文から書き始める",
          why:
            "即興派と答えていただいたためです。" +
            "本文/001.txt をすぐ作って、書き始められます",
        },
        {
          command: "novelai.createWorkWithPlot",
          label: "プロットから始める",
          why: "先に骨組みが欲しくなったら、こちらへも移れます",
        },
      ];
  return {
    advice: plotFirst
      ? "プロットから始めることをお勧めします。" +
        "先に決めてから書く方なので、設定/plot.md を土台にすると、" +
        "あとで「書いたものが筋から外れていないか」を機械に見張らせられます。" +
        "ただしあとからどちらへも移れますので、決め込まなくて構いません。"
      : "本文から書き始めることをお勧めします。" +
        "書いてみて分かる方なので、先に決めさせる画面は邪魔になります。" +
        "設定資料や年表は、書いたあとから本文を読んで起こせます" +
        "——先に用意しなくて大丈夫です。",
    steps,
    later: [
      "書き始めたあと、保存するたびに執筆量が自動で記録されます",
      ...(style.plan === "improviser"
        ? ["書き進めてから「資料をまとめて抽出」を回すと、設定資料ができます"]
        : ["書き進めてから「プロット逸脱の検知」で、筋との差を見られます"]),
    ],
  };
}

function keepWritingAdvice(style: WriterStyle): TutorialAdvice {
  const steps: TutorialStep[] = [
    {
      command: "novelai.resumeWriting",
      label: "執筆を再開する（前回どこまで書いたか）",
      why: "前の話の終わりと、次に書くことの候補をまとめて出します",
    },
  ];
  if (style.plan !== "improviser") {
    steps.push({
      command: "novelai.createEpisodePlot",
      label: "次の1話のプロットを作る",
      why: `${WRITER_PLAN_TYPES[style.plan].label}と答えていただいたためです`,
    });
  } else {
    steps.push({
      command: "novelai.openSceneMemos",
      label: "シーンメモを開く",
      why:
        "即興派と答えていただいたためです。書きながら置いた付箋を" +
        "一覧して、話をまたいで飛べます",
    });
  }
  if (style.material === "in_head" || style.material === "memo") {
    steps.push({
      command: "novelai.extractSettings",
      label: "本文から設定資料をまとめて抽出する",
      why:
        `設定は「${WRITER_MATERIAL_LABELS[style.material]}」と答えていただいたためです。` +
        "本文から登場人物・場所・能力・組織・世界観を起こします（AIを使います）",
    });
  }
  return {
    advice:
      "まず「執筆を再開する」から見てください。" +
      "前の話がどこで終わったか、次に書くことの候補、" +
      "張ったままの伏線が1枚にまとまって出ます。" +
      "書き始める前に思い出す手間が、ここで済みます。",
    steps,
    later: [],
  };
}

function polishAdvice(style: WriterStyle): TutorialAdvice {
  const suite: TutorialStep = {
    command: "novelai.runProofreadingSuite",
    label: "校正・校閲をまとめて回す",
    why:
      "誤字脱字・表記ゆれ・推敲・矛盾を続けて回します。" +
      "指摘は1件ずつ確認して適用するので、勝手に直りません",
  };
  const typos: TutorialStep = {
    command: "novelai.checkTypos",
    label: "誤字脱字を検知する",
    why: "1話ぶんなら、これだけで足ります",
  };
  const steps: TutorialStep[] =
    style.revise === "after_all" ? [suite, typos] : [typos, suite];

  if (style.revise === "inline") {
    steps.push({
      command: "novelai.openVertical",
      label: "原稿エディタ（縦書き）で開く",
      why:
        "書きながら直す方なので、書いている画面の中で用語の色分けと" +
        "設定の食い違いが見えるほうが早いはずです",
    });
  }
  return {
    advice:
      style.revise === "after_all"
        ? "まとめて回すことをお勧めします。" +
          "全部書き終えてから直す方なので、1つずつ呼ぶより、" +
          "誤字脱字から矛盾まで続けて回したほうが手数が減ります。" +
          "処理量を先に出すので、重ければそこで止められます。"
        : "1つずつ呼ぶことをお勧めします。" +
          "区切りごとに直す方なので、まとめて回すと指摘が溜まりすぎます。" +
          "誤字脱字から始めると、直す判断がいちばん軽く済みます。",
    steps,
    later: [
      "どの指摘も、適用するのはあなたです。AIが本文を書き換えることはありません",
    ],
  };
}

function publishAdvice(style: WriterStyle): TutorialAdvice {
  if (style.outlet === "publish") {
    return {
      advice:
        "公募・出版をお考えとのことなので、紙の形に組むところから見てください。" +
        "PDF は原稿用紙の体裁で出せます。電子書籍（EPUB）は表紙・目次・奥付まで" +
        "この中で作れます。",
      steps: [
        {
          command: "novelai.exportPdf",
          label: "印刷用の PDF を出す",
          why: "公募・出版と答えていただいたためです",
        },
        {
          command: "novelai.openEpubEditor",
          label: "EPUB エディターを開く",
          why: "電子書籍にするなら、表紙・目次・挿絵・奥付をここで組みます",
        },
      ],
      later: [],
    };
  }
  const steps: TutorialStep[] = [
    {
      command: "novelai.copyForPosting",
      label: "投稿サイト用に変換してコピーする",
      why:
        "ルビ・傍点をサイトごとの記法へ読み替えて、クリップボードへ入れます。" +
        "原稿は書き換えません",
    },
    {
      command: "novelai.configurePostingSites",
      label: "投稿先を決める",
      why: "先に決めておくと、変換のたびに聞かれなくなります",
    },
  ];
  if (style.outlet === "serial") {
    steps.push({
      command: "novelai.generateAnnouncement",
      label: "更新告知文を作る",
      why: "連載すると答えていただいたためです（AIを使います）",
    });
  }
  return {
    advice:
      "投稿サイト用の変換から見てください。" +
      "ルビと傍点をサイトごとの書き方へ読み替えて、コピーするだけの形にします。" +
      "原稿そのものは書き換えません——クリップボードへ入れるだけです。",
    steps,
    later: [],
  };
}

function reviewAdvice(): TutorialAdvice {
  return {
    advice:
      "まず編集者モードに切り替えてください。" +
      "このモードでは本文を書き換えられません——直した案は提案として置き、" +
      "採るかどうかは作者が決めます。取り違えて原稿を直してしまう事故が起きません。",
    steps: [
      {
        command: "novelai.switchMode",
        label: "作者／編集者を切り替える",
        why: "見る側で使うと答えていただいたためです",
      },
      {
        command: "novelai.addWorkFromGithub",
        label: "GitHub から作品を取り寄せる",
        why: "作者が共有したリポジトリを、こちらへ持ってきます",
      },
      {
        command: "novelai.reviewProposals",
        label: "提案の確認と校閲ロック",
        why: "見ているあいだ、作者に「いま校閲中」と伝わります",
      },
    ],
    later: [],
  };
}
