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
}

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
  present: Iterable<Prerequisite>
): readonly PrerequisiteStatus[] {
  const have = new Set(present);
  return PREREQUISITE_KINDS.map((kind) => {
    const info = prerequisiteInfo(kind);
    return {
      kind,
      label: info.label,
      ready: have.has(kind),
      makeLabel: info.makeLabel,
      blocks: featuresNeeding(kind),
    };
  });
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
}): string {
  const infos = input.missing.map(prerequisiteInfo);
  const names = infos.map((info) => `「${info.label}」`).join("と");
  const makes = infos.map((info) => `「${info.makeLabel}」`).join("と");
  const lines = [
    `${FEATURE_LABELS[input.feature]}（feature: ${input.feature}）には${names}が要りますが、` +
      "この作品にはまだありません。",
    /*
      **強調の記号を使わない**（`plainTextUi.test.ts`）。読むのは外部AIだが、
      この文はそのまま作者へ転記されることがある。地の文で言い切る
    */
    `作るのは${makes}で、この操作は作者が画面で行います` +
      "（外部AIは作品を書き換えません）。",
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
