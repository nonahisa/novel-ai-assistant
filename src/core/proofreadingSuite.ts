/**
 * 校正のまとめ実行（設計書6.80）の、順番と控えと文面だけを持つ部品。
 *
 * ## 順番と分類名は、ここが唯一の置き場である
 *
 * まとめ実行は「既にあるコマンドを順に呼び、そのあと提案パネルの残り件数を
 * 読む」だけの機能である。つまり**コマンドIDと分類名という2本の文字列**でしか
 * 実物と結ばれていない。写しを作ると、片方だけ改名したときに
 * **件数がいつも0件と出る**——例外は出ないので、作者からは「指摘が
 * 無かった」としか見えない。噛み合っていることは
 * `test/unit/proofreadingSuite.test.ts` が実物と突き合わせて見張る。
 *
 * VS Code APIに依存しない。
 */

export type ProofreadingCheckId =
  | "notation"
  | "typos"
  | "proofread"
  | "opening"
  | "deviations"
  | "contradictions"
  | "foreshadows";

export interface ProofreadingCheck {
  readonly id: ProofreadingCheckId;
  /** 選択画面と完了の知らせに出す短い名前 */
  readonly label: string;
  /** 実際に走らせるコマンド。処理はここでは持たない */
  readonly command: string;
  /** 選択画面に添える1行の説明 */
  readonly detail: string;
  /**
   * 提案パネルの分類名。**持たないものは結果がパネルに出ない**
   * （冒頭診断は文書として開く）ので、件数を数えない。
   */
  readonly category?: string;
}

/** まとめ実行の入口。`package.json` と詳細メニューが同じIDを使う */
export const PROOFREADING_SUITE_COMMAND = "novelai.runProofreadingSuite";

/** 前回の選択の控え（`globalState`）の鍵 */
export const PROOFREADING_SUITE_SELECTION_KEY =
  "novelai.proofreadingSuite.selection";

/**
 * 走らせる機能と、その順番。
 *
 * **軽いものから重いものへ並べる**（設計書6.80）。表記ゆれは機械判定で
 * すぐ終わり、伏線は全話をAIで読む。先に軽い結果が届くほうが、待ちながら
 * 読み始められる。**選んだ順では走らせない。**
 */
export const PROOFREADING_CHECKS: readonly ProofreadingCheck[] = [
  {
    id: "notation",
    label: "表記ゆれ",
    command: "novelai.checkNotation",
    detail: "同じ語が2通りで書かれている箇所を探します（AIを使いません）。",
    category: "表記ゆれ",
  },
  {
    id: "typos",
    label: "誤字脱字",
    command: "novelai.checkTypos",
    detail: "誤変換・脱字など、明らかな入力ミスをAIで探します。",
    category: "誤字脱字",
  },
  {
    id: "proofread",
    label: "推敲",
    command: "novelai.checkProofread",
    detail: "読みにくい箇所だけをAIで指摘します。",
    category: "推敲",
  },
  {
    // 結果は文書として開く。提案パネルへは出ないので分類を持たない
    id: "opening",
    label: "冒頭診断",
    command: "novelai.checkOpening",
    detail: "第1話の冒頭だけを見て、伝わり方と引きを診断します。",
  },
  {
    id: "deviations",
    label: "プロット逸脱",
    command: "novelai.checkDeviations",
    detail: "プロットと本文を照らし、外れた展開や停滞を探します。",
    category: "プロット逸脱",
  },
  {
    id: "contradictions",
    label: "矛盾",
    command: "novelai.checkContradictions",
    detail: "設定資料と本文の食い違いを探します。",
    category: "矛盾",
  },
  {
    id: "foreshadows",
    label: "伏線の検知",
    command: "novelai.checkForeshadows",
    detail: "後の展開を示唆している記述を探し、登録の候補にします。",
    category: "伏線の候補",
  },
];

/**
 * はじめて開いたときに選ばれているもの（設計書6.80）。
 *
 * 冒頭診断・逸脱・伏線を外してあるのは、**前提が要る**ためである
 * （プロットや設定資料が無いと、走らせても指摘が出ないか的外れになる）。
 */
export const DEFAULT_PROOFREADING_CHECK_IDS: readonly ProofreadingCheckId[] = [
  "notation",
  "typos",
  "proofread",
  "contradictions",
];

/**
 * 選ばれたidを、走らせる順に並べ直す。
 *
 * 知らないid（古い控え）は捨て、同じidが2つあっても1度しか走らせない。
 */
export function sortToRunOrder(
  ids: Iterable<string>
): readonly ProofreadingCheck[] {
  const chosen = new Set(ids);
  return PROOFREADING_CHECKS.filter((check) => chosen.has(check.id));
}

/** 控えへ書く形（走らせる順のid配列） */
export function serializeSelection(
  checks: Iterable<{ readonly id: ProofreadingCheckId }>
): ProofreadingCheckId[] {
  return sortToRunOrder([...checks].map((check) => check.id)).map(
    (check) => check.id
  );
}

/**
 * 控えを読む。
 *
 * **読めないものは既定に戻す。** 空のまま進めると、選択画面に何も
 * 選ばれていない状態で開き、作者は毎回1件ずつ選び直すことになる。
 */
export function parseStoredSelection(
  stored: unknown
): readonly ProofreadingCheckId[] {
  if (!Array.isArray(stored)) return DEFAULT_PROOFREADING_CHECK_IDS;
  const known = sortToRunOrder(
    stored.filter((value): value is string => typeof value === "string")
  ).map((check) => check.id);
  return known.length > 0 ? known : DEFAULT_PROOFREADING_CHECK_IDS;
}

/**
 * 校正の各コマンドが、まとめ実行へ返す答え。
 *
 * **`cancelled` は「結果を出さずに終わった」の印である**——作者が中止した、
 * 確認で取りやめた、前提（AIの設定・未保存の本文）が揃わなかった、の
 * どれでも立てる。理由を分けないのは、**どれであっても次を走らせる意味が
 * 無い**ためである（同じ理由でまた止まる）。
 *
 * 戻り値を足しただけで、コマンド自身の振る舞いは何も変えていない。
 */
export interface CheckCommandOutcome {
  readonly cancelled: boolean;
}

/** 結果を出さずに終わった（まとめ実行はここで止まる） */
export const CHECK_CANCELLED: CheckCommandOutcome = { cancelled: true };

/** 走り切った（まとめ実行は次へ進む） */
export const CHECK_COMPLETED: CheckCommandOutcome = { cancelled: false };

/**
 * コマンドが返した「中止した」の印。
 *
 * **何も返さないコマンドは、走り切ったものとして扱う。** 戻り値を持たない
 * 入口から呼ばれたときに、まとめ実行が勝手に止まってはいけない。
 */
export function isCancelledOutcome(outcome: unknown): boolean {
  return (
    typeof outcome === "object" &&
    outcome !== null &&
    (outcome as { cancelled?: unknown }).cancelled === true
  );
}

/** 進み具合の文字（「2/4：推敲」） */
export function describeStep(
  done: number,
  total: number,
  label: string
): string {
  return `${done}/${total}：${label}`;
}

/** 走らせ終わった1件と、そのあと提案パネルに残っていた件数 */
export interface SuiteStepResult {
  readonly label: string;
  /** 分類を持たない機能（冒頭診断）は数えない */
  readonly count?: number;
}

export interface SuiteRunSummary {
  readonly done: readonly SuiteStepResult[];
  /** 中止で走らせなかったものの表示名。完走したら空 */
  readonly remaining: readonly string[];
}

/**
 * 終わったときの1通知（設計書6.80）。
 *
 * **走らなかったものを黙らない。** 「終わりました」とだけ出すと、
 * 中止で飛ばした機能まで済んだと読める。
 */
export function describeSuiteResult(summary: SuiteRunSummary): string {
  // 1つも走らないうちに取りやめたときは、報告することが無い
  if (summary.done.length === 0) return "";

  const head =
    summary.remaining.length > 0
      ? `校正をまとめて実行：ここまで実行しました（残り：${summary.remaining.join(
          "・"
        )}）。`
      : "校正をまとめて実行しました。";

  const parts = summary.done.map((step) =>
    step.count === undefined
      ? `${step.label}（結果は別の文書に出しました）`
      : `${step.label}${step.count}件`
  );

  // 件数を持つ機能が1つも無いときは、パネルの話をしない
  const counted = summary.done.filter((step) => step.count !== undefined);
  const total = counted.reduce((sum, step) => sum + (step.count ?? 0), 0);
  const tail =
    counted.length === 0
      ? ""
      : total > 0
        ? "提案パネルで確認できます。"
        : "手を付ける指摘は残っていません。";

  return `${head}${parts.join("・")}。${tail}`;
}
