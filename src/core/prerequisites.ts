/**
 * 操作が動くために先に要るもの（前提）。
 *
 * 作者の要望（2026-09-18）「各機能には設定資料ファイルの有無等依存関係が
 * ありますが、相談チャットで順路を教えたりできますか」「代替で実行できる
 * ようにもしてください」に対する土台である。
 *
 * ## なぜデータにするか
 *
 * これまで前提は**説明文（`detail`）の中の一文**でしか書かれておらず、
 * 117操作のうち4つにしか無かった。しかも相談へ渡すときの切り詰め
 * （1文目と「〜ません」で終わる文だけ残す。`featureGuide.ts` の `shorten`）
 * で落ちていたので、**AIは前提を一度も知らないまま答えていた。**
 *
 * 文章のままでは、画面で判定することも、相談へ確実に届けることもできない。
 * だから種類として持つ。
 *
 * ## ここに `vscode` を持ち込まない
 *
 * 揃っているかを実際に見るのはファイルを読む仕事なので `features/` が行う。
 * ここに置くのは「何が要るか」「足りないのはどれか」という**純粋な判断**
 * だけにして、外（MCP・テスト）からそのまま測れるようにしておく。
 */

/**
 * 前提の種類。**まずこの4つだけ**にする。
 *
 * 推測で増やさない——`detail` に根拠が書いてあるものだけを足す。
 * 当て推量で「これも要るはず」を並べると、実際には動く操作の前で
 * 作者の手が止まる。
 */
export type Prerequisite = "settings" | "synopsis" | "plot" | "episodePlot";

/**
 * 前提が無いとき、その操作がどうなるか（作者の裁定 2026-09-18）。
 *
 * - `blocking`：**そもそも走らない。** 機能の側が「先に○○を作ってください」
 *   と断って終わる
 * - `degrades`：走るが、出来が落ちる
 *
 * **なぜ別に持つのか。** 前の版は、足りないときに必ず「このまま実行する」
 * を出していた。ところが `blocking` の操作では、押した先で機能の側が
 * **同じ案内をもう一度出して終わる**だけになる。動かないものを勧めるのは
 * この作品でいちばんやってはいけないことなので、走らないと分かっている
 * 道は最初から並べない。
 */
export type PrerequisiteSeverity = "blocking" | "degrades";

interface PrerequisiteBase {
  readonly kind: Prerequisite;
  /** 作者に見せる名前。画面・相談・マニュアルで同じ言い方をする */
  readonly label: string;
  /** それを作る操作のコマンドID */
  readonly makeCommand: string;
  /**
   * その操作を、案内の文の中で呼ぶときの名前。
   *
   * かつては画面の名前と分けていた（小分類「資料抽出」の中の
   * 「まとめて抽出」を、案内では「設定資料をまとめて抽出」と呼んだ）。
   * 2026-09-23 のメニューの組み直しで、メニュー・コマンドパレット・
   * 案内の名前を1つに揃えた（「一括抽出」）。**案内だけ別の名前だと、
   * 作者がメニューで探せない。**
   */
  readonly makeLabel: string;
}

/**
 * 前提の表書き。
 *
 * **`withoutWarning` を持てるのは `degrades` だけ**にしてある。走らない
 * 前提に「このまま進むとこうなります」を書ける形にしておくと、いつか
 * 誰かが画面へ出してしまう。型で持てなくしておけば、その道は塞がる。
 */
export type PrerequisiteInfo = PrerequisiteBase &
  (
    | { readonly severity: "blocking" }
    | {
        readonly severity: "degrades";
        /**
         * 前提が無いまま進んだときに何が起きるか。作者に見せる一文。
         *
         * **言葉は `detail` に既にあるものを使う。** 同じことを別の言い方で
         * 書くと、ホバーで読んだ説明と画面の断りが食い違って見える。
         */
        readonly withoutWarning: string;
      }
  );

/** 「無くても走る」前提だけを指す型（画面の組み立てで使う） */
export type DegradingPrerequisiteInfo = Extract<
  PrerequisiteInfo,
  { severity: "degrades" }
>;

/**
 * 前提の台帳。
 *
 * 作る操作を**コマンドIDで指す**のは、この作品の決まり（`stepMenu.ts` と
 * 同じ）。名前を書き写すと、操作の名前を変えたときにここだけ古くなる。
 *
 * **`severity` は推測で決めない。** 4つとも機能の側のコードを読んで、
 * 前提が無いときに本当に走るのかを確かめて付けた（下のコメントが根拠）。
 * いまは4つとも `blocking` である——**この作品には、前提が無くても走る
 * 操作がまだ1つも無い。**
 */
export const PREREQUISITES: Readonly<Record<Prerequisite, PrerequisiteInfo>> = {
  settings: {
    kind: "settings",
    label: "設定資料",
    makeCommand: "novelai.extractSettings",
    // メニューの名前と同じ「一括抽出」（2026-09-23 の組み直しで、
    // コマンドパレットの名前も同じになった）。案内の文だけ別の名前だと、
    // 作者がメニューで探せない
    makeLabel: "一括抽出",
    // `checkContradictions.ts` の `collectSettings`：人物・場所・世界観が
    // どれも無いと、案内を出して `undefined` を返し、そこで終わる
    severity: "blocking",
  },
  synopsis: {
    kind: "synopsis",
    label: "各話あらすじ",
    makeCommand: "novelai.generateSynopses",
    makeLabel: "各話あらすじ",
    // `generatePlot.ts` の `collectMaterial`：あらすじが0件なら
    // 「各話あらすじを作る／中止」を出して `undefined` を返す。
    // 冒頭だけで中盤以降を推測させないための、意図した打ち切りである
    severity: "blocking",
  },
  plot: {
    kind: "plot",
    label: "プロット",
    makeCommand: "novelai.createPlot",
    makeLabel: "プロット自力作成",
    // `checkDeviations.ts` の `loadPlot`：プロットが無ければ案内を出して
    // `undefined` を返す
    severity: "blocking",
  },
  episodePlot: {
    kind: "episodePlot",
    label: "単話プロット",
    makeCommand: "novelai.createEpisodePlot",
    makeLabel: "単話プロット作成",
    // `checkEpisodePlot.ts` の話選び：単話プロットが1つも無ければ
    // 「単話プロットがまだ1つもありません。」を出して終わる
    severity: "blocking",
  },
};

/** 前提の表書き。知らない種類は渡ってこない（型で縛ってある） */
export function prerequisiteInfo(kind: Prerequisite): PrerequisiteInfo {
  return PREREQUISITES[kind];
}

/**
 * 足りない前提を返す。
 *
 * @param needs その操作が要るもの。無指定は「前提なし」
 * @param present いま揃っているもの
 */
export function missingPrerequisites(
  needs: readonly Prerequisite[] | undefined,
  present: Iterable<Prerequisite>
): readonly Prerequisite[] {
  if (!needs || needs.length === 0) return [];
  const have = new Set(present);
  return needs.filter((kind) => !have.has(kind));
}

/**
 * 代わりの道。
 *
 * 前提が無くても同じ目的にたどり着ける操作が別にあるなら、名前を出すだけ
 * でなく**その場で実行できるようにする**（作者の指示の核心）。
 *
 * @param command 代わりに走らせる操作のコマンドID
 * @param why なぜ代われるのか。作者に見せる一文
 */
export interface PrerequisiteAlternative {
  readonly command: string;
  readonly why: string;
}

/** 1つの操作に付く前提と、代わりの道 */
export interface ActionPrerequisite {
  readonly needs: readonly Prerequisite[];
  readonly insteadOf?: PrerequisiteAlternative;
}

/**
 * どの操作に何が要るか。**唯一の表**（0.67.3）。
 *
 * **もとは `views/actionList.ts` の項目の中に直に書いてあった。** 画面
 * （`ActionItem.needs`）はいまもそこから読むが、**外部AIの口（MCPの束）は
 * `actionList.ts` を読めない**——あれは `vscode` を import しているので、
 * 束に混ぜると読み込んだ瞬間に落ちる（`mcpReach.test.ts`）。
 *
 * かといってMCP側に写しの表を置くと、**片方だけが古くなる**。画面では
 * 止まるのにMCPでは通る、あるいはその逆が起きて、しかも**どちらが正しいのか
 * 分からない**。だから表はここに1つだけ置き、画面もMCPもここを読む。
 *
 * **推測で増やさない**（6.94.2）。入っているのは、操作の説明文（`detail`）に
 * 前提が文章として書いてある4件だけである。
 */
export const ACTION_PREREQUISITES: Readonly<
  Record<string, ActionPrerequisite>
> = {
  // 根拠は説明文の「各話あらすじを材料にするため、先にあらすじを…」
  "novelai.generatePlot": { needs: ["synopsis"] },
  // 根拠は説明文の「先にプロットを書いておいてください」
  "novelai.checkDeviations": { needs: ["plot"] },
  // 根拠は説明文の「先に『単話プロット作成』で展開を書いて…」
  "novelai.checkEpisodePlot": { needs: ["episodePlot"] },
  "novelai.checkContradictions": {
    // 根拠は説明文の「設定資料が無ければ、押す前に知らせて話どうしだけ
    // 走らせる」（1つ目の道＝設定との照合が、設定資料を要る）
    needs: ["settings"],
    // **代わりの道が実際にある唯一の組**（設計書6.88）。「矛盾検知
    // （事実の照合）」は、説明文に「設定資料が無くても使える」とある。
    //
    // 文言は作者の裁定 A7（2026-09-23）のとおり：設定資料が無ければ、
    // 押す前に「設定との食い違いは見られない。話どうしの照合だけ走る」と
    // 知らせる。関門（`features/prerequisiteGate.ts`）がこの一文を出す
    insteadOf: {
      command: "novelai.checkFactContradictions",
      why: "設定資料が無いので、設定との食い違いは見られません。話どうしの照合だけ走ります。",
    },
  },
};

/**
 * その操作の前提。無ければ空（`ActionItem` へ展開して使う）。
 *
 * **戻り値を `ActionItem` の形に合わせてある**——`{ ...prerequisiteOf(command) }`
 * と書けば、前提の無い操作では何も足されない。
 */
export function prerequisiteOf(command: string): {
  needs?: readonly Prerequisite[];
  insteadOf?: PrerequisiteAlternative;
} {
  const found = ACTION_PREREQUISITES[command];
  if (!found) return {};
  return found.insteadOf
    ? { needs: found.needs, insteadOf: found.insteadOf }
    : { needs: found.needs };
}

/**
 * 相談とマニュアルへ出す、前提の1行。
 *
 * **切り詰めに頼らない**のが肝心である。`featureGuide.ts` の `shorten` は
 * 1文目と「〜ません」で終わる文しか残さないので、説明文の途中に書いた
 * 前提は必ず落ちる。ここで組んだ1行を、切り詰めたあとに足す。
 *
 * @param alternativeLabel 代わりの道の操作名。無ければ省く
 */
export function prerequisiteNote(input: {
  needs: readonly Prerequisite[] | undefined;
  alternativeLabel?: string;
}): string {
  const needs = input.needs ?? [];
  if (needs.length === 0) return "";

  const names = needs
    .map((kind) => `「${prerequisiteInfo(kind).label}」`)
    .join("と");
  const head = `先に${names}が要ります。`;
  return input.alternativeLabel
    ? `${head}無いときは「${input.alternativeLabel}」で代われます。`
    : head;
}
