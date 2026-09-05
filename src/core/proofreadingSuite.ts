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
   * AIへ本文を送るか。
   *
   * **確認の文面がここで変わる**（設計書6.80）。送る量も料金も発生しない
   * 機能（表記ゆれ）だけを選んだときは、確認そのものを出さない。判定を
   * 呼び出し側へ写すと、機能を足したときに片方だけ古くなる。
   */
  readonly usesAI: boolean;
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
    usesAI: false,
    category: "表記ゆれ",
  },
  {
    id: "typos",
    label: "誤字脱字",
    command: "novelai.checkTypos",
    detail: "誤変換・脱字など、明らかな入力ミスをAIで探します。",
    usesAI: true,
    category: "誤字脱字",
  },
  {
    id: "proofread",
    label: "推敲",
    command: "novelai.checkProofread",
    detail: "読みにくい箇所だけをAIで指摘します。",
    usesAI: true,
    category: "推敲",
  },
  {
    // 結果は文書として開く。提案パネルへは出ないので分類を持たない
    id: "opening",
    label: "冒頭診断",
    command: "novelai.checkOpening",
    detail: "第1話の冒頭だけを見て、伝わり方と引きを診断します。",
    usesAI: true,
  },
  {
    id: "deviations",
    label: "プロット逸脱",
    command: "novelai.checkDeviations",
    detail: "プロットと本文を照らし、外れた展開や停滞を探します。",
    usesAI: true,
    category: "プロット逸脱",
  },
  {
    id: "contradictions",
    label: "矛盾",
    command: "novelai.checkContradictions",
    detail: "設定資料と本文の食い違いを探します。",
    usesAI: true,
    category: "矛盾",
  },
  {
    id: "foreshadows",
    label: "伏線の検知",
    command: "novelai.checkForeshadows",
    detail: "後の展開を示唆している記述を探し、登録の候補にします。",
    usesAI: true,
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
 * 校正の各コマンドが、まとめ実行へ返す答え（設計書6.80）。
 *
 * **「止める」と「失敗した」を分ける**（0.33.7のレビュー）。0.33.6では
 * 結果を出さずに終わったものを一律で中止扱いにしていたが、**AIの失敗や
 * 応答の読み取り失敗は、次の検知を止める理由にならない**——レート上限も
 * 解析の失敗も、次の機能では起きないことのほうが多い。
 *
 * - `cancelled` … 作者が止めた・確認で取りやめた・前提が無い
 *   （AI未設定・作品未選択・本文なし）。**残りも走らせない**（同じ理由で
 *   また止まる）
 * - `failed` … 走ろうとして失敗した（AIエラー・応答を読めない・保存できない）。
 *   **次へ進み**、内訳に「◯◯は失敗しました」と出す
 * - `completed` … 走り切った
 */
export type CheckOutcomeKind = "completed" | "cancelled" | "failed";

export interface CheckCommandOutcome {
  readonly kind: CheckOutcomeKind;
  /**
   * まとめの知らせへ持ち越す一言（設計書6.80）。
   *
   * **確認を1回にした代わりに、機能ごとの警告を出す場が無くなった。**
   * 「突き合わせる設定資料がまだありません」は作者が次に何をするかを
   * 決める情報なので、黙って失敗にせず理由ごと持ち帰る。
   */
  readonly notes?: readonly string[];
}

/** 結果を出さずに終わった（まとめ実行はここで止まる） */
export const CHECK_CANCELLED: CheckCommandOutcome = { kind: "cancelled" };

/** 走り切った（まとめ実行は次へ進む） */
export const CHECK_COMPLETED: CheckCommandOutcome = { kind: "completed" };

/** 走ろうとして失敗した（まとめ実行は次へ進み、内訳に失敗と書く） */
export const CHECK_FAILED: CheckCommandOutcome = { kind: "failed" };

/**
 * 理由つきの失敗。
 *
 * 前提が無くて走れなかったとき（設定資料が無い・プロットが無い）に使う。
 * **中止（`cancelled`）にしない**——残りの検知はその前提を要らないので、
 * ここで列を止めると関係のない機能まで走らずに終わる。
 */
export function checkFailed(...notes: string[]): CheckCommandOutcome {
  return { kind: "failed", notes };
}

/** コマンドが持ち帰った一言。持っていなければ空 */
export function outcomeNotesOf(outcome: unknown): string[] {
  if (typeof outcome !== "object" || outcome === null) return [];
  const notes = (outcome as { notes?: unknown }).notes;
  if (!Array.isArray(notes)) return [];
  return notes.filter((note): note is string => typeof note === "string");
}

/**
 * 各検知のコマンドが受け取る、任意の第2引数（設計書6.80）。
 *
 * **メニューからの単独実行では渡らない。** 渡らなければ、これまでどおり
 * 機能ごとの確認が出る——単独で押した作者は、その1回ぶんの量と料金を
 * まだ知らされていない。
 */
export interface CheckRunOptions {
  readonly suite?: SuiteFeatureContext;
}

/**
 * まとめ実行から呼ばれていることを伝える印。
 *
 * `noteMissing` は**コマンドの登録側（`extension.ts`）が足す**。
 * まとめ実行が送るのは `{ confirmed: true }` だけなので、コマンドの
 * 境界をまたぐのは素の値だけである。
 */
export interface SuiteFeatureContext {
  /** まとめ実行が、量と料金の確認を先に1回だけ取ってある */
  readonly confirmed: true;
  /**
   * 前提が無くて走れなかった理由を伝える口。
   *
   * **戻り値の型を増やさないための逃げ道である。** 各検知の戻り値は
   * それぞれ10項目近くあり、「前提が無い」ためだけに空の結果を組み立てると、
   * 呼び出し側が「走って0件だった」と読み違える。
   */
  readonly noteMissing?: (reason: string) => void;
}

/**
 * 各検知の関数が受ける、まとめ実行まわりの任意項目（設計書6.80）。
 *
 * **5つの機能で同じものを持つので、置き場は1つにする。** 写しを作ると、
 * 片方だけ意味が変わったときに「まとめ実行なのに確認が出る機能」ができる。
 */
export interface SuiteAwareOptions {
  /**
   * まとめ実行から呼ばれている。
   *
   * 量と料金の確認は**まとめ実行が最初に1回だけ**取ってあるので、
   * 機能ごとの「続けますか」は出さない。**飛ばした中身は捨てず、
   * `logStep` へ残すこと**——逸脱検知の「小さめのモデルではほとんど
   * 働きません」のような断りは、その確認の中にしか書かれていない。
   */
  suiteConfirmed?: boolean;
  /**
   * 前提が無くて走れなかった理由の伝え先（まとめ実行のときだけ渡る）。
   *
   * 単独実行では作者へ警告のダイアログを出せばよいが、まとめ実行では
   * 出す場が無い。理由を持ち帰って、最後のまとめへ一言として並べる。
   */
  noteMissing?: (reason: string) => void;
}

/** まとめ実行が確認を済ませているか（コマンドの第2引数を読む） */
export function isSuiteConfirmed(options: unknown): boolean {
  return suiteContextOf(options) !== undefined;
}

/** コマンドの第2引数から、まとめ実行の印を取り出す */
export function suiteContextOf(
  options: unknown
): SuiteFeatureContext | undefined {
  if (typeof options !== "object" || options === null) return undefined;
  const suite = (options as { suite?: unknown }).suite;
  if (typeof suite !== "object" || suite === null) return undefined;
  return (suite as { confirmed?: unknown }).confirmed === true
    ? (suite as SuiteFeatureContext)
    : undefined;
}

/**
 * 1チャンクにかかるおおよその秒数。
 *
 * 誤字脱字検知が前から使っている見込み（`checkTypos.ts` の `estimateMinutes`）
 * と同じ値である。**新しい換算を作らない**——ここだけ別の数字にすると、
 * 単独で走らせたときとまとめ実行で目安が食い違う。
 */
const SECONDS_PER_CHUNK = 15;

/** まとめ実行の確認に出す、送る量とAIの見積もり */
export interface SuiteEstimate {
  /** 本文の総文字数 */
  readonly totalChars: number;
  /** 1機能あたりのチャンク数 */
  readonly chunkCount: number;
  /** 使うAIの名前（機能別に割り当てていれば複数になる） */
  readonly providerNames: readonly string[];
  /** 1つでも有料なら真 */
  readonly isPaid: boolean;
}

export interface SuiteConfirmInput {
  readonly workTitle: string;
  /** 走らせる機能の名前（走る順） */
  readonly labels: readonly string[];
  /** そのうち、AIへ本文を送るものの数 */
  readonly aiCheckCount: number;
  /** 見積もり。取れなければ省く（量の話をしない） */
  readonly estimate?: SuiteEstimate;
}

/**
 * まとめ実行の、**最初に1回だけ**出す確認（設計書6.80）。
 *
 * ## なぜ1回にするのか
 *
 * 7つの機能を順に呼ぶと、各機能の確認が7回出ていた。1回目に「実行」を
 * 押した作者は、残り6回も同じ意味で押す——押し続けるうちに中身を
 * 読まなくなるので、**確認としては働かなくなる。** 量と料金を1枚に
 * まとめて、選んだ直後に1度だけ問う。
 *
 * @returns 出す確認。AIを使う機能が1つも無ければ `undefined`（表記ゆれ
 *   だけを選んだときは、送る量も料金も発生しないので聞く意味が無い）
 */
export function buildSuiteConfirm(
  input: SuiteConfirmInput
): { message: string; detail: string } | undefined {
  if (input.aiCheckCount === 0) return undefined;

  const estimate = input.estimate;
  const lines: string[] = [
    `走らせるもの（この順）：${input.labels.join("・")}`,
  ];

  if (estimate) {
    lines.push(
      `本文 ${withCommas(estimate.totalChars)}字 / ${estimate.chunkCount}チャンク`
    );
  }
  if (estimate && estimate.providerNames.length > 0) {
    lines.push(`使うAI：${estimate.providerNames.join("・")}`);
  }
  lines.push("");

  const n = input.aiCheckCount;
  if (estimate) {
    const total = n * estimate.chunkCount;
    // **かけ算を見せる。** 「36チャンク」とだけ書くと、1機能ぶんだと
    // 読まれる。機能の数だけ本文を送り直すことが、ここでいちばん重い
    lines.push(
      `選んだ${n}機能それぞれが本文をチャンクごとに送ります` +
        `（最大 ${n}×${estimate.chunkCount}＝${total}チャンク。` +
        "処理済みのチャンクは飛ばします）。"
    );
    if (estimate.isPaid) {
      lines.push("チャンクごとに課金されます。");
    } else {
      // 無料のAI（Ollama・LM Studio）では料金の話をしない。
      // 作者が知りたいのは「どれくらい待つか」だけである
      lines.push(
        `目安 ${Math.ceil((total * SECONDS_PER_CHUNK) / 60)}分程度（処理済みのぶんだけ短くなります）。`
      );
    }
  } else {
    // 見積もりが取れない（モデルの詳細を引けない）ときでも、確認そのものは
    // 出す。押した覚えのないまま走り始めるのがいちばん困る
    lines.push(`選んだ${n}機能それぞれが、本文をAIへ送ります。`);
    if (estimate === undefined) {
      lines.push("送る量は、実行時にモデルの大きさから決まります。");
    }
  }

  lines.push("");
  // **このあと聞かれない、と先に言う。** 言わないと、作者は機能ごとの
  // 確認を待って画面の前を離れられない
  lines.push(
    "このあと機能ごとの確認は出しません。 本文は書き換えません。" +
      "途中で中止すると、残りは走りません。"
  );

  return {
    message: `${input.workTitle} の校正をまとめて実行します。`,
    detail: lines.join("\n"),
  };
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

/**
 * コマンドが返した印を読む。
 *
 * **何も返さないコマンドは、走り切ったものとして扱う。** 戻り値を持たない
 * 入口から呼ばれたときに、まとめ実行が勝手に止まってはいけない。
 */
export function outcomeKindOf(outcome: unknown): CheckOutcomeKind {
  if (typeof outcome !== "object" || outcome === null) return "completed";
  const kind = (outcome as { kind?: unknown }).kind;
  return kind === "cancelled" || kind === "failed" ? kind : "completed";
}

/** 作者が止めた（＝残りも走らせない）か。**失敗はここに入らない** */
export function isCancelledOutcome(outcome: unknown): boolean {
  return outcomeKindOf(outcome) === "cancelled";
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
  /**
   * 走ろうとして失敗した。
   *
   * **件数は持たない**——結果が出ていないので、パネルに残っている数を
   * その機能の成果として並べると、前の実行の残りを今回の結果と読ませる。
   */
  readonly failed?: boolean;
  /**
   * まとめの末尾へ持ち越す一言（前提が無くて走れなかった理由など）。
   *
   * **「失敗しました」だけでは、作者はAIが落ちたのだと思う。** 走れなかった
   * 理由が「設定資料がまだ無い」なら、そう書けば次の一手が分かる。
   */
  readonly notes?: readonly string[];
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
  if (summary.done.length === 0) {
    // 走らせるものを選んだのに1件も走らなかったのなら、**黙らない**
    // （1件目で止まると通知がゼロだった。0.33.7のレビュー）
    if (summary.remaining.length === 0) return "";
    return (
      "校正をまとめて実行：1件も実行せずに止まりました" +
      `（残り：${summary.remaining.join("・")}）。`
    );
  }

  const head =
    summary.remaining.length > 0
      ? `校正をまとめて実行：ここまで実行しました（残り：${summary.remaining.join(
          "・"
        )}）。`
      : "校正をまとめて実行しました。";

  const parts = summary.done.map((step) =>
    step.failed
      ? `${step.label}は失敗しました`
      : step.count === undefined
        ? `${step.label}（結果は別の文書に出しました）`
        : `${step.label}${step.count}件`
  );

  // 件数を持つ機能が1つも無いときは、パネルの話をしない
  const counted = summary.done.filter(
    (step) => !step.failed && step.count !== undefined
  );
  const total = counted.reduce((sum, step) => sum + (step.count ?? 0), 0);
  const tail =
    counted.length === 0
      ? ""
      : total > 0
        ? "提案パネルで確認できます。"
        : "手を付ける指摘は残っていません。";

  // 走れなかった理由は最後に並べる。件数の内訳に混ぜると、どれが結果で
  // どれが断りなのか読み分けられなくなる
  const notes = summary.done.flatMap((step) => step.notes ?? []).join("");

  return `${head}${parts.join("・")}。${tail}${notes}`;
}
