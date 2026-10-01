/**
 * 外から呼べる機能（`FeatureName`）と、前提（設計書6.94）を結ぶ。
 *
 * 作者の指示（2026-09-18）の後半——「**外部AIでも同様です**」——がここである。
 * 画面の側は 0.67.2 で入った（`features/prerequisiteGate.ts`）が、外部AIは
 * 前提を知らないまま機能を呼び、材料の無いまま答えを受け取っていた。
 *
 * ## 写しの表を作らない
 *
 * 「どの機能に何が要るか」は `core/prerequisites.ts` の `ACTION_PREREQUISITES`
 * が持つ。ここが持つのは **feature と画面の操作を結ぶ対応表だけ**である。
 * 前提そのものをここへ書き写すと、画面とMCPで食い違い、しかも**どちらが
 * 正しいのか分からなくなる。**
 *
 * ## 外部AIは作品を書き換えない（6.87.7）
 *
 * だから「足りないものを作る操作」は、**名前を伝えるだけ**にする。外部AIが
 * `feature: settings` を呼んでも、返るのは抽出の**案**であって、`設定/` へは
 * 1文字も書かれない——前提は揃わないままである。断り文句で「作者が画面で
 * 行います」と言い切るのは、そう書かないと外部AIが自分で作ろうとするからである。
 *
 * ## 代わりの道は、勝手に実行しない
 *
 * 画面の関門は、作者が選べばその場で代わりの機能を走らせる（6.94.4）。
 * **外部AIに対しては名前を返すだけにする。** 呼んだのとは違う機能が黙って
 * 走ると、呼び出し元は**別のものを測った結果を、頼んだものの結果として
 * 受け取る**。選び直すのは呼んだ側の仕事である。
 */

import { FEATURE_LABELS, FEATURE_NAMES, type FeatureName } from "./mcpFeatures";
import {
  ACTION_PREREQUISITES,
  missingPrerequisites,
  prerequisiteInfo,
  type Prerequisite,
} from "./prerequisites";

/**
 * feature と、画面の同じ操作のコマンドID。
 *
 * **全部は載せない。** 前提の絡む機能と、その代わりの道だけである——
 * 使いもしない対応を並べると、名前を変えたときに直す場所が増えるだけで、
 * 合っているかを確かめる手立ても無い。
 *
 * 載っていない feature は「前提なし」として扱われる。足りなければ
 * `test/unit/mcp/mcpPrerequisites.test.ts` が、表に載っているのに結べない
 * コマンドを見つけて止める。
 */
export const FEATURE_COMMANDS: Readonly<Partial<Record<FeatureName, string>>> =
  {
    contradiction: "novelai.checkContradictions",
    // 代わりの道。前提は無いが、`insteadOf` から引くために要る
    factContradiction: "novelai.checkFactContradictions",
    deviation: "novelai.checkDeviations",
    episodePlot: "novelai.checkEpisodePlot",
    // 「本文からプロットを逆算」＝プロット逆算（P-02）
    plotReverse: "novelai.generatePlot",
  };

/** コマンドIDから feature を引く（代わりの道の名前を出すために要る） */
export function featureOfCommand(command: string): FeatureName | undefined {
  return FEATURE_NAMES.find((name) => FEATURE_COMMANDS[name] === command);
}

/** その feature に要るもの。無ければ空 */
export function featureNeeds(
  feature: FeatureName
): readonly Prerequisite[] {
  const command = FEATURE_COMMANDS[feature];
  if (!command) return [];
  return ACTION_PREREQUISITES[command]?.needs ?? [];
}

/** 代わりの道。**外部AIがそのまま呼べる feature** に限る */
export interface FeatureAlternative {
  readonly feature: FeatureName;
  readonly label: string;
  readonly why: string;
}

/**
 * その feature の代わりの道。
 *
 * 画面の `insteadOf` はコマンドIDを指すので、**外部AIから呼べる feature が
 * ある組だけ**を返す。画面にしか無い操作を「代わりに呼べます」と案内すると、
 * 呼べない名前を渡すことになる。
 */
export function featureAlternative(
  feature: FeatureName
): FeatureAlternative | undefined {
  const command = FEATURE_COMMANDS[feature];
  if (!command) return undefined;
  const insteadOf = ACTION_PREREQUISITES[command]?.insteadOf;
  if (!insteadOf) return undefined;
  const alternative = featureOfCommand(insteadOf.command);
  if (!alternative) return undefined;
  return {
    feature: alternative,
    label: FEATURE_LABELS[alternative],
    why: insteadOf.why,
  };
}

/** 足りない前提。`present` に無いものを返す */
export function missingFeaturePrerequisites(
  feature: FeatureName,
  present: Iterable<Prerequisite>
): readonly Prerequisite[] {
  return missingPrerequisites(featureNeeds(feature), present);
}

/**
 * 前提ごとの、いまの姿（`novel.scan` が返すもの）。
 *
 * **「揃っているか」だけでは足りない。** 外部AIが次に何をすればよいかを
 * 決められるように、**作者に見せる名前**と、**それが無いと通せない
 * feature**まで返す。どちらも表から引くので、写しにはならない。
 */
export interface PrerequisiteStatus {
  readonly kind: Prerequisite;
  /** 作者に見せる名前。画面・相談・マニュアルと同じ言い方 */
  readonly label: string;
  readonly ready: boolean;
  /** それを作る操作の名前。**作者が画面で行う**（外部AIは実行できない） */
  readonly makeLabel: string;
  /** これが無いと通せない feature */
  readonly blocks: readonly FeatureName[];
  /**
   * 揃っていない理由（`ready: false` のときだけ。言えるものだけ）。
   *
   * **ファイルはあるのに揃っていない、があり得る**——単話プロットは
   * ひな形のままでは揃っていない（`novel.prompt` が断る）。「無い」とだけ
   * 返すと、ファイルを見た外部AIが「あるのに」と迷う。
   */
  readonly reason?: string;
}

/** 前提ごとの、揃っていない理由。言えるものだけ入れる */
export type PrerequisiteReasons = Readonly<Partial<Record<Prerequisite, string>>>;

/**
 * 前提の種類の並び（`novel.scan` の返り順）。
 *
 * **作る順に並べてある**——設定資料とあらすじが先で、それを材料にする
 * プロットが次、話ごとの単話プロットが最後。
 */
export const PREREQUISITE_KINDS: readonly Prerequisite[] = [
  "settings",
  "synopsis",
  "plot",
  "episodePlot",
];

/** その前提を要る feature。表から引く（写しを作らない） */
export function featuresNeeding(kind: Prerequisite): readonly FeatureName[] {
  return FEATURE_NAMES.filter((name) => featureNeeds(name).includes(kind));
}

/** いま揃っているものから、4種類ぶんの姿を組む */
export function prerequisiteStatuses(
  present: Iterable<Prerequisite>,
  reasons: PrerequisiteReasons = {}
): readonly PrerequisiteStatus[] {
  const have = new Set(present);
  return PREREQUISITE_KINDS.map((kind) => {
    const info = prerequisiteInfo(kind);
    const ready = have.has(kind);
    const reason = ready ? undefined : reasons[kind];
    return {
      kind,
      label: info.label,
      ready,
      makeLabel: info.makeLabel,
      blocks: featuresNeeding(kind),
      // 揃っているものに理由は付けない（古い理由が残って見えないように）
      ...(reason ? { reason } : {}),
    };
  });
}

/**
 * 前提を作る手助けとして、外部AIが呼べる feature（2026-10-01、不具合17）。
 *
 * **案を返すだけで、置くのは作者である**（6.87.7）。プロット逆算は
 * `設定/plot.md` を書き換えず、下書きを返して終わる——だから次の一手は
 * 「下書きを作り、作者に見せ、作者が承認してから置く」になる。
 *
 * **画面の関門（`features/prerequisiteGate.ts`）には無い道である。** 画面は
 * プロットが無ければ「プロット自力作成」だけを出す。作る操作の名前は
 * `PREREQUISITES.makeLabel` から引き（画面と同じ表）、ここが持つのは
 * 「外部AIが下書きを手伝える feature」の対応だけにする。
 *
 * **載せないもの。** 設定資料・各話あらすじは、外部AIの出した案を作者が
 * 置く道が一括では無い（あらすじは置き場へ届ける口が無い。設定資料は
 * 1記録ずつ `novel.propose` で承認待ちへ置けるが、作品まるごとを
 * 外から回すより、作者が「一括抽出」を1回押すほうが速く確か）。
 * 単話プロットは作者の構想そのものなので、AIに起こさせない。
 */
const PREREQUISITE_DRAFT_FEATURES: Readonly<
  Partial<Record<Prerequisite, FeatureName>>
> = {
  plot: "plotReverse",
};

/**
 * 断ったあとの、次の一手（機械の読める形。`novel.prompt`／`novel.run` の
 * 断りに添えて返す）。
 *
 * **1つだけ返す**（CLAUDE.md の実装ルール5「種別ごとに次の操作を1つ示す」）。
 * 代わりの feature（`featureAlternative`）は別の欄で返す——あちらは
 * 「前提を作らずに別の機能で済ます」道で、こちらは「前提を作る」道である。
 */
export interface PrerequisiteNextStep {
  /** どの前提を作る一手か */
  readonly prerequisite: Prerequisite;
  /**
   * 外部AIがそのまま呼べる feature（下書きを作るだけのもの）。
   * 無ければ作者の画面の操作しか無い
   */
  readonly feature?: FeatureName;
  /** 何をするかの一文。**作者が行う／作者が承認する**ことを必ず書く */
  readonly action: string;
}

/**
 * その前提を作る、次の一手。
 *
 * @param present いま揃っている前提。下書きを作る feature 自身の前提を
 *   見るのに使う——**揃っていない feature を勧めると、呼んだ先でまた断られる**
 *   （プロット逆算は各話あらすじが要る）
 */
export function prerequisiteNextStep(
  kind: Prerequisite,
  present: Iterable<Prerequisite>
): PrerequisiteNextStep {
  const info = prerequisiteInfo(kind);
  const byAuthor = `作者が画面の「${info.makeLabel}」で${info.label}を作る`;
  const draft = PREREQUISITE_DRAFT_FEATURES[kind];
  if (draft) {
    const draftMissing = missingFeaturePrerequisites(draft, present);
    if (draftMissing.length === 0) {
      return {
        prerequisite: kind,
        feature: draft,
        action:
          `${FEATURE_LABELS[draft]}（feature: ${draft}）で${info.label}の下書きを作り、作者に見せる。` +
          "置くのは作者が承認してから（外部AIは作品を書き換えません）。" +
          `${byAuthor}こともできます。`,
      };
    }
    // 下書きの道が閉じているわけを添える。黙って省くと、外部AIは
    // その feature を試して、もう一度断られる
    const names = draftMissing
      .map((missing) => `「${prerequisiteInfo(missing).label}」`)
      .join("と");
    return {
      prerequisite: kind,
      action:
        `${byAuthor}（外部AIは作品を書き換えません）。` +
        `${FEATURE_LABELS[draft]}（feature: ${draft}）で下書きを作るには、先に${names}が要ります。`,
    };
  }
  return {
    prerequisite: kind,
    action: `${byAuthor}（外部AIは作品を書き換えません）。`,
  };
}

/**
 * 断りの次の一手を決めるために、揃っているかを見ておく前提。
 *
 * feature 自身の前提に、**下書きを作る feature の前提**を足したもの。
 * 呼ぶ側（MCP）はファイルを読んで揃っているかを見るので、何を見るかを
 * ここで決めておく（見る対象を MCP 側に書き写さない）。
 */
export function prerequisitesToInspect(
  feature: FeatureName
): readonly Prerequisite[] {
  const needs = featureNeeds(feature);
  const drafts = needs.flatMap((kind) => {
    const draft = PREREQUISITE_DRAFT_FEATURES[kind];
    return draft ? featureNeeds(draft) : [];
  });
  return [...new Set([...needs, ...drafts])];
}

/**
 * 断りに添える、機械の読める中身。外部AIが続けて呼べるように返す。
 *
 * 文章（`featurePrerequisiteRefusal`）と**同じものを別の形で**持つ。
 * 文章だけだと、外部AIは「次に何を呼べばよいか」を日本語から拾うことになる。
 */
export interface FeaturePrerequisiteDetail {
  readonly refusal: "prerequisite";
  readonly feature: FeatureName;
  readonly missing: readonly Prerequisite[];
  readonly nextStep: PrerequisiteNextStep;
  readonly alternative?: { readonly feature: FeatureName };
}

export function featurePrerequisiteDetail(input: {
  readonly feature: FeatureName;
  readonly missing: readonly Prerequisite[];
  readonly present: Iterable<Prerequisite>;
}): FeaturePrerequisiteDetail {
  const alternative = featureAlternative(input.feature);
  return {
    refusal: "prerequisite",
    feature: input.feature,
    missing: input.missing,
    // 足りないものが複数あっても、一手は最初の1つ（画面の関門と同じ。
    // 作者が順に片づけられる）
    nextStep: prerequisiteNextStep(input.missing[0], input.present),
    ...(alternative ? { alternative: { feature: alternative.feature } } : {}),
  };
}

/** 次の一手の1行（断りの文の中に置く） */
export function nextStepLine(step: PrerequisiteNextStep): string {
  return `次にやること：${step.action}`;
}

/**
 * 関門を抜けたあと、**機能の中で**前提の欠けが分かったときの一手。
 *
 * 関門は「1つでも書かれていれば揃っている」と粗く見る（6.94.6）。だから
 * ほかの話の単話プロットは書けていて、選んだ話だけがひな形のまま、という
 * 断りは機能の中で起きる。その断りにも同じ一手を添える——関門の断りにだけ
 * 一手があると、外部AIは2度目の断りで行き止まる。
 *
 * 揃っている前提は分からないので空として扱う（下書きの feature は勧めない
 * 側へ倒す。呼べないものを勧めない）。
 */
export function inlinePrerequisiteRefusal(
  feature: FeatureName,
  kind: Prerequisite
): { readonly line: string; readonly detail: FeaturePrerequisiteDetail } {
  const detail = featurePrerequisiteDetail({
    feature,
    missing: [kind],
    present: [],
  });
  return { line: nextStepLine(detail.nextStep), detail };
}

/**
 * 前提が足りないときの断り文句（外部AI向け）。
 *
 * **3つを必ず言う**（作者の指示）。①足りないもの ②それを作る操作の名前と、
 * **それは作者が画面で行うこと** ③代わりの feature があればその名前。
 *
 * **代わりの道は勧めるだけで、走らせない。** 呼び直すのは呼んだ側である。
 */
export function featurePrerequisiteRefusal(input: {
  readonly feature: FeatureName;
  readonly missing: readonly Prerequisite[];
  /** 揃っていない理由（言えるものだけ）。`novel.scan` と同じ文を出す */
  readonly reasons?: PrerequisiteReasons;
  /**
   * いま揃っている前提（`prerequisitesToInspect` の分だけ見ればよい）。
   * 次の一手で下書きの feature を勧めてよいかを決める。省くと「揃っていない」
   * 側へ倒す——呼べない feature を勧めるより、作者の操作を示すほうが安全
   */
  readonly present?: Iterable<Prerequisite>;
}): string {
  const infos = input.missing.map(prerequisiteInfo);
  const names = infos.map((info) => `「${info.label}」`).join("と");
  const makes = infos.map((info) => `「${info.makeLabel}」`).join("と");
  const lines = [
    `${FEATURE_LABELS[input.feature]}（feature: ${input.feature}）には${names}が要りますが、` +
      "この作品にはまだありません。",
    /*
      **ファイルがあるのに断られる場合は、理由を添える**（単話プロットが
      ひな形のまま等）。「まだありません」だけだと、ファイルを見た外部AIは
      「あるのに」と迷う
    */
    ...input.missing.flatMap((kind) => {
      const reason = input.reasons?.[kind];
      return reason ? [`${prerequisiteInfo(kind).label}：${reason}`] : [];
    }),
    /*
      **強調の記号を使わない**（`plainTextUi.test.ts`）。読むのは外部AIだが、
      この文はそのまま作者へ転記されることがある。地の文で言い切る
    */
    `作るのは${makes}で、この操作は作者が画面で行います` +
      "（外部AIは作品を書き換えません）。",
    /*
      **次の一手を1つ**（2026-10-01、不具合17。実装ルール5）。上の行は
      「何が要るか」までで、外部AIは次に何を呼べばよいかを決められなかった
    */
    nextStepLine(
      featurePrerequisiteDetail({
        feature: input.feature,
        missing: input.missing,
        present: input.present ?? [],
      }).nextStep
    ),
  ];

  const alternative = featureAlternative(input.feature);
  if (alternative) {
    lines.push(
      // 呼び名を先に、feature を後ろに置く。呼び名のほうに括弧が入ることが
      // あるので（「矛盾検知（事実の照合）」）、逆にすると括弧が入れ子になる
      `代わりに「${alternative.label}」（feature: ${alternative.feature}）が使えます——` +
        `${alternative.why}使うなら、そちらを呼び直してください` +
        "（こちらでは実行しません）。"
    );
  }

  lines.push("いま何が揃っているかは novel.scan が返します。");
  return lines.join("\n");
}
