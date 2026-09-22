/**
 * 「新作をひと通り仕上げる」の、段の並びと文面だけを持つ部品。
 *
 * 作者の指示（2026-09-19）「初心者が初めて使うところを魅せたい。可能な
 * ことをすべて一気に行ってほしい」。取り込んだばかりの作品に対して、
 * **AIでできることを順に全部走らせ、最後に1枚にまとめて見せる**操作である。
 *
 * ## 校正のまとめ実行（設計書6.80）と同じ決まりで作る
 *
 * - **処理を持たない。** 各段は既にあるコマンドをそのまま呼ぶ。確認・
 *   見積もり・札・通知は各機能のものを通す。写すと、片方だけ直したときに
 *   「メニューからは動くのにまとめ実行では違う」が起きる
 * - **札を取らない**（AIの順番待ちの札は各機能が取る。まとめ側でも取ると
 *   自分が自分を待つ）
 * - **1つずつ、順に走らせる。** 中止したら残りは走らせない
 * - **中止ボタンを持たない**（2つ並ぶため。中止は実行中の機能のもの1つへ）
 * - **失敗しても残りは走らせる**
 *
 * ## 直すものの一式は、写さずに `proofreadingSuite.ts` から引く
 *
 * 誤字脱字・表記ゆれ・推敲・冒頭診断・逸脱・矛盾・伏線の並びは、既に
 * `PROOFREADING_CHECKS` が唯一の置き場として持っている。ここへ書き写すと、
 * **校正へ機能を足したときにこちらだけ古くなる**——しかも例外は出ないので、
 * 作者からは「一気に走らせたのに、その検知だけ動いていない」としか見えない。
 *
 * ## 順番は前提（`prerequisites.ts`）が決めている
 *
 * 作るものが先、直すものが後である。設定資料が無いと矛盾検知は走らないし、
 * 各話あらすじが無いとプロット逆算は走らない。
 *
 * VS Code APIに依存しない（`vscode` を import しない）。
 */

import {
  PROOFREADING_CHECKS,
  describeSuiteRunTime,
  type ProofreadingCheckId,
  type SuiteEstimate,
} from "./proofreadingSuite";
import { prerequisiteInfo, type Prerequisite } from "./prerequisites";

/** まとめの入口。`package.json` と詳細メニューが同じIDを使う */
export const FINISH_NEW_WORK_COMMAND = "novelai.finishNewWork";

export type FinishStepId =
  | "settings"
  | "synopsis"
  | "plot"
  | "blurb"
  | "catchphrase"
  | ProofreadingCheckId
  | "chapters";

export interface FinishStep {
  readonly id: FinishStepId;
  /** 進み具合と結果の1枚に出す名前 */
  readonly label: string;
  /** 実際に走らせるコマンド。処理はここでは持たない */
  readonly command: string;
  /** AIへ送るか（確認の文面がここで変わる） */
  readonly usesAI: boolean;
  /**
   * この段が作るもの。**既にあるなら、その段は飛ばす。**
   *
   * 作り直すと作者のデータを上書きしかねない（実装ルール2）。各機能も
   * 上書きはしない作りだが、**そもそも走らせなければ確実である**し、
   * 待ち時間もAIの料金も節約できる。
   */
  readonly produces?: Prerequisite;
  /**
   * 提案パネルの分類名。**持たない段は件数を数えない**——パネルへ出ない
   * 結果を「0件」と報告すると、指摘が無かったように読める。
   */
  readonly category?: string;
  /**
   * 本文を丸ごと読む段か。
   *
   * **確認に出すチャンク数の掛け算がここで決まる。** 紹介文・キャッチ
   * コピー・冒頭診断・章立ては1回（または数回）の呼び出しで終わるので、
   * 「段の数 × チャンク数」に混ぜると送る量を大きく偽ることになる。
   */
  readonly scansWholeText: boolean;
}

/**
 * 章立ての提案の分類名。
 *
 * **実物は `features/proposeChapters.ts` の `CHAPTER_PROPOSAL_CATEGORY`**
 * である。あちらは `vscode` を import しているので `core` からは読めず、
 * ここでは同じ文字列を持つしかない。**噛み合っていることは
 * `test/unit/finishNewWork.test.ts` が実物と突き合わせて見張る**
 * （ずれると件数が黙って0件になる）。
 */
const CHAPTER_CATEGORY = "章立て";

/**
 * 走らせる段と、その順番。
 *
 * **作るものが先、直すものが後**（`prerequisites.ts` が決めている順）。
 * 1〜3は互いに前提でつながっている——設定資料が無いと矛盾検知が走らず、
 * 各話あらすじが無いとプロット逆算が走らず、プロットが無いと逸脱検知が
 * 走らない。
 *
 * **名前とコマンドは、引けるものは引く。** 設定資料とあらすじは前提の台帳
 * （`PREREQUISITES`）が「作る操作」として既に持っているので、そこから取る。
 */
export const FINISH_STEPS: readonly FinishStep[] = [
  {
    id: "settings",
    label: prerequisiteInfo("settings").makeLabel,
    command: prerequisiteInfo("settings").makeCommand,
    usesAI: true,
    produces: "settings",
    scansWholeText: true,
  },
  {
    id: "synopsis",
    label: prerequisiteInfo("synopsis").makeLabel,
    command: prerequisiteInfo("synopsis").makeCommand,
    usesAI: true,
    produces: "synopsis",
    scansWholeText: true,
  },
  {
    /*
      **前提の台帳が指す「プロットを作る」ではない。** あちらは
      設定/plot.md を開くだけの操作で、AIは何も書かない。一気に仕上げる
      道でやりたいのは、**既にある本文からプロットを逆算すること**である
      （`novelai.generatePlot`）。前提として数えるものは同じなので、
      `produces` は "plot" のままでよい。
    */
    id: "plot",
    label: "本文からプロットを逆算",
    command: "novelai.generatePlot",
    usesAI: true,
    produces: "plot",
    scansWholeText: true,
  },
  {
    id: "blurb",
    label: "作品紹介文",
    command: "novelai.generateWorkBlurb",
    usesAI: true,
    scansWholeText: false,
  },
  {
    id: "catchphrase",
    label: "キャッチコピー案",
    command: "novelai.generateCatchphrases",
    usesAI: true,
    scansWholeText: false,
  },
  /*
    直すもの一式。**写さずに引く**（この節の冒頭の説明のとおり）。

    冒頭診断もこの並びの中にいる。**取り出して前へ置かない**——取り出す
    ということは、7件のうち6件だけを名指しで並べ直すことであり、それは
    写しを作るのと同じである。並び自体も「軽いものから重いものへ」と
    理由があって決まっている（設計書6.80）。
  */
  ...PROOFREADING_CHECKS.map(
    (check): FinishStep => ({
      id: check.id,
      label: check.label,
      command: check.command,
      usesAI: check.usesAI,
      ...(check.category ? { category: check.category } : {}),
      // 冒頭診断は第1話の冒頭だけ、表記ゆれはAIを使わない。
      // 残りは本文を丸ごと読む
      scansWholeText: check.usesAI && check.id !== "opening",
    })
  ),
  {
    /*
      **最後に置く。** 章立ては「どこで区切るか」の提案なので、話の中身が
      あらすじやプロットとして整理されたあとのほうが当たる。
    */
    id: "chapters",
    label: "章立てを提案させる",
    command: "novelai.proposeChapters",
    usesAI: true,
    category: CHAPTER_CATEGORY,
    scansWholeText: false,
  },
];

/**
 * 飛ばす判断のために、先に見ておく前提。
 *
 * **段の表から数える。** 書き並べると、段を足したときに見落とす。
 */
export const FINISH_PREREQUISITES: readonly Prerequisite[] = [
  ...new Set(
    FINISH_STEPS.map((step) => step.produces).filter(
      (kind): kind is Prerequisite => kind !== undefined
    )
  ),
];

/** 走らせる段と、飛ばす段（理由つき） */
export interface FinishPlanEntry {
  readonly step: FinishStep;
  /**
   * 飛ばす理由（「設定資料が既にあるため」）。走らせる段では持たない。
   *
   * 結果の1枚の括弧へそのまま入るので、**文末を作らない**（「〜ため」で切る）。
   */
  readonly skipReason?: string;
}

/**
 * 何を走らせ、何を飛ばすかを決める。
 *
 * **既にあるものは作り直さない**（実装ルール2）。取り込んだ作品に設定資料が
 * 既にあるなら、抽出をもう一度走らせる理由は無い——待たせるだけでなく、
 * 作者が手で直した資料を上書きする危険を増やす。
 *
 * @param present いま揃っている前提
 */
export function planFinish(
  present: Iterable<Prerequisite>
): readonly FinishPlanEntry[] {
  const have = new Set(present);
  return FINISH_STEPS.map((step) => {
    if (step.produces && have.has(step.produces)) {
      return {
        step,
        skipReason: `${prerequisiteInfo(step.produces).label}が既にあるため`,
      };
    }
    return { step };
  });
}

/** 実際に走らせる段だけ */
export function stepsToRun(
  plan: readonly FinishPlanEntry[]
): readonly FinishStep[] {
  return plan
    .filter((entry) => entry.skipReason === undefined)
    .map((entry) => entry.step);
}

export interface FinishConfirmInput {
  readonly workTitle: string;
  /** 何を走らせ、何を飛ばすか（`planFinish` の結果） */
  readonly plan: readonly FinishPlanEntry[];
  /** 見積もり。取れなければ省く（量の話をしない） */
  readonly estimate?: SuiteEstimate;
}

/**
 * **先に出す確認**（実装ルール：確認は処理量とコストを示してから）。
 *
 * 何段走るか・どれくらいの量を送るか・クラウドAIなら課金されることを
 * 1枚で示す。**押した覚えのないまま長い処理が始まるのが、いちばん困る。**
 *
 * @returns 出す確認。走らせる段が1つも無ければ `undefined`
 */
export function buildFinishConfirm(
  input: FinishConfirmInput
): { message: string; detail: string } | undefined {
  const running = stepsToRun(input.plan);
  if (running.length === 0) return undefined;

  const skipped = input.plan.filter((entry) => entry.skipReason !== undefined);
  const lines: string[] = [
    `走らせる段（この順）：${running.map((step) => step.label).join("・")}`,
  ];

  if (skipped.length > 0) {
    // **飛ばすことを先に言う。** 終わってから「作られていない」と気づくと、
    // 作者は壊れたのかと疑う
    lines.push(
      `飛ばす段：${skipped
        .map((entry) => `${entry.step.label}（${entry.skipReason}）`)
        .join("・")}`
    );
  }

  const estimate = input.estimate;
  if (estimate) {
    lines.push(
      `本文 ${withCommas(estimate.totalChars)}字 / ${estimate.chunkCount}チャンク`
    );
    if (estimate.providerNames.length > 0) {
      lines.push(`使うAI：${estimate.providerNames.join("・")}`);
    }
  }
  lines.push("");

  const scanning = running.filter((step) => step.scansWholeText);
  const others = running.filter((step) => step.usesAI && !step.scansWholeText);

  if (estimate && scanning.length > 0) {
    const total = scanning.length * estimate.chunkCount;
    // **かけ算を見せる**（設計書6.80と同じ理由）。「12チャンク」とだけ
    // 書くと1段ぶんだと読まれる。段の数だけ本文を送り直すことが、
    // ここでいちばん重い
    //
    // **「最大」とは言わない**（2026-09-19の実機）。この数は本文の量だけを
    // 割ったもので、指示や設定資料のぶんは入っていない。抽出が進むと
    // 【既知の登場人物】などが肥えて1チャンクが上限に入らなくなり、
    // 送る直前に分け直されて数が増える。上限のつもりで出した数が実際には
    // 下回りようのない数だった、というのがいちばん不親切である
    lines.push(
      `本文を丸ごと読む段が${scanning.length}つあります` +
        `（およそ ${scanning.length}×${estimate.chunkCount}＝${total}チャンク。` +
        "処理済みのチャンクは飛ばし、指示や設定資料が増えたぶんは" +
        "分かれて数が増えることがあります）。"
    );
    if (estimate.isPaid) {
      lines.push("チャンクごとに課金されます。");
    } else {
      // 無料のAI（Ollama・LM Studio）では料金の話をしない。
      // 作者が知りたいのは「どれくらい待つか」だけである
      // 目安の出し方は校正のまとめ実行と同じ関数（速さの実測があれば
      // 送る量と速さから、無ければ決め打ち。設計書6.8.19）
      lines.push(
        `${describeSuiteRunTime(total, estimate)}。処理済みのぶんだけ短くなります。`
      );
    }
  } else if (scanning.length > 0) {
    // 見積もりが取れない（モデルの詳細を引けない）ときでも、確認は出す
    lines.push(
      `本文を丸ごと読む段が${scanning.length}つあります` +
        "（送る量は、実行時にモデルの大きさから決まります）。"
    );
    if (estimate?.isPaid) lines.push("チャンクごとに課金されます。");
  }
  if (others.length > 0) {
    lines.push(`残りの${others.length}段は、1回ずつの短い呼び出しです。`);
  }

  lines.push("");
  /*
    **どこで確認が出るかを先に言う。** 校正の段だけは確認を省く（ここで
    1回聞いたぶん）が、資料やあらすじを作る段は、それぞれの機能が持つ
    確認をそのまま通す——飛ばすと、上書きの判断まで黙って通ることになる。
    言っておかないと、作者は画面の前を離れられない。
  */
  lines.push(
    "資料・あらすじ・プロットなどを作る段では、それぞれの確認が出ます。" +
      "校正の段では確認は出しません。"
  );
  /*
    **ここはダイアログの文言なので、Markdownの記号を混ぜない**
    （`test/unit/plainTextUi.test.ts`）。VS Code の確認はプレーンテキストで、
    強調の記号はそのまま画面に出る。結果の紙のほうは Markdown として
    読まれるので、そちらは `core/finishReportDoc.ts` に分けてある。
  */
  lines.push(
    "本文は1文字も書き換えません。指摘は「提案」パネルに溜まります。" +
      "途中で中止すると、残りは走りません。"
  );

  return {
    message: `${input.workTitle} を、ひと通り仕上げます（${running.length}段）。`,
    detail: lines.join("\n"),
  };
}

/** 走らせ終わった1段 */
export interface FinishStepResult {
  readonly label: string;
  /** 分類を持つ段だけ。そのあと提案パネルに残っていた件数 */
  readonly count?: number;
  /** 走ろうとして失敗した（件数は持たない。結果が出ていないため） */
  readonly failed?: boolean;
  /** 走らせなかった（既にある・前提が足りない） */
  readonly skipped?: boolean;
  /** 飛ばした短い理由（括弧に入る） */
  readonly reason?: string;
  /** 結果の1枚の末尾へ持ち越す一言 */
  readonly notes?: readonly string[];
}

export interface FinishRunSummary {
  readonly workTitle: string;
  readonly done: readonly FinishStepResult[];
  /** 中止で走らせなかった段の名前。完走したら空 */
  readonly remaining: readonly string[];
}

/**
 * 1段も走らなかったときの知らせ。
 *
 * **黙って終わらない。** 1段目で中止すると結果の表が空になるので、紙を
 * 開く代わりにこの1行を出す（押したのに何も起きなかった、を作らない）。
 */
export function describeFinishHalted(summary: FinishRunSummary): string {
  if (summary.remaining.length === 0) {
    return "ひと通り仕上げる：走らせる段がありませんでした。";
  }
  return (
    "ひと通り仕上げる：1段も実行せずに止まりました" +
    `（残り：${summary.remaining.join("・")}）。`
  );
}

/** 進み具合の文字（「2/13：各話あらすじ」） */
export function describeFinishStep(
  done: number,
  total: number,
  label: string
): string {
  return `${done}/${total}：${label}`;
}

/**
 * 3桁ごとに区切る。
 *
 * `toLocaleString()` は環境の地域設定で区切りが変わるので使わない
 * （試験の期待値が端末によって変わる）。
 */
function withCommas(value: number): string {
  const digits = String(Math.trunc(Math.abs(value)));
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return value < 0 ? `-${out}` : out;
}
