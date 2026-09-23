/**
 * 転送だけをする旧コマンド（作者の裁定、2026-09-23）。
 *
 * 「ターゲットシートと3つの輪は完全統合。読者診断はそのままでいい」。
 * 0.82.0 で「ターゲット読者」（設計書6.108.6）を1つの入口にしたとき、
 * 旧3つは消さずに隠して、コマンドパレットからはこれまでどおり動かしていた。
 * そのうち**ターゲットシートと3つの輪は、押すと「ターゲット読者」の入口を
 * 開く**形に変える——同じ紙を2つの道から別々に作れると、3つの輪だけの
 * 単独の紙とシートの中の節が並び、どちらが最新か作者に分からなくなる。
 *
 * **「ターゲット読者診断」はここに入れない**（裁定のとおり、そのまま残す）。
 *
 * **命令は消さない。** 作者のキー割り当てや、ほかの拡張機能・古い手順書きが
 * 名前で呼んでいることがある。消すと「コマンドが見つかりません」になる。
 * コマンドパレットの名前は「（ターゲット読者へ）」を付けて、押すと別の入口が
 * 開くと分かる形にした（`commandForwards.test.ts` が見張る）。
 *
 * 表をここに置くのは、登録（`extension.ts`）と試験が同じものを見るため。
 * VS Code API にも AI にも依存しない。
 */
export interface CommandForward {
  /** 旧コマンド（押されたら転送する） */
  readonly from: string;
  /** 開く先。**作品の節点をそのまま渡す**（作品を選び直させない） */
  readonly to: string;
}

export const COMMAND_FORWARDS: readonly CommandForward[] = [
  { from: "novelai.openTargetSheet", to: "novelai.openTargetReader" },
  { from: "novelai.showThreeCircles", to: "novelai.openTargetReader" },
];
