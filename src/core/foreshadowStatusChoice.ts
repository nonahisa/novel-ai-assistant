import type { ForeshadowStatus } from "../models/foreshadow";

/**
 * 伏線の状態を変えるときの選択肢（設計書6.35.1）。
 *
 * **いまの状態を、選ぶ画面に出す**（作者の指摘、2026-09-06）。
 * 回収済みの伏線を選んでも「回収済みにする」が先頭に来るため、
 * **いまどちらなのかは一覧まで戻らないと分からなかった。**
 *
 * そこで2つを守る。
 *
 * 1. いまの状態と同じ選択肢に「（いま：回収済み）」を添える
 * 2. **その選択肢を先頭に出さない。** QuickPick は開いた瞬間に先頭が
 *    選ばれているので、Enter を押しただけで「いまと同じ状態にする」が
 *    通ってしまう。押しても変わらない操作を、いちばん押しやすい場所に
 *    置かない
 *
 * VS Code APIに依存しない（QuickPickの項目へは、呼ぶ側が詰め替える）。
 */

/** 状態の短い言い方（「（いま：〜）」の中に入る） */
export const FORESHADOW_STATUS_NAME: Record<ForeshadowStatus, string> = {
  open: "未回収",
  resolved: "回収済み",
  intentional: "意図して開けたまま",
};

export interface ForeshadowStatusChoice {
  readonly status: ForeshadowStatus;
  readonly label: string;
  readonly detail: string;
  /** いまの状態のときだけ付く「（いま：回収済み）」 */
  readonly description?: string;
  /** いまの状態と同じ選択肢か */
  readonly current: boolean;
}

/**
 * 並べる順（いまの状態を抜いたときの、既定の並び）。
 *
 * **「回収済みにする」を先に置く。** いちばんよく使うのはこれで、
 * 「意図して開けたまま」は作者にしか決められない特別な指定である。
 */
const CHOICES: ReadonlyArray<Omit<ForeshadowStatusChoice, "current">> = [
  {
    status: "resolved",
    label: "回収済みにする",
    detail: "作中で説明・成就したもの",
  },
  {
    status: "intentional",
    label: "意図して開けたまま（回収しない）",
    detail: "回収を忘れたのではなく、開けたままにすると決めたもの",
  },
  {
    status: "open",
    label: "未回収に戻す",
    detail: "まだ回収していないものとして、一覧の上へ戻す",
  },
];

/**
 * いまの状態を踏まえた選択肢を作る。
 *
 * @param current いまの状態
 * @returns 並べる順。**いまの状態と同じものは末尾**に回る
 */
export function foreshadowStatusChoices(
  current: ForeshadowStatus
): ForeshadowStatusChoice[] {
  const marked = CHOICES.map((choice) =>
    choice.status === current
      ? {
          ...choice,
          description: `（いま：${FORESHADOW_STATUS_NAME[current]}）`,
          current: true,
        }
      : { ...choice, current: false }
  );
  // **消さずに末尾へ回す。** 回収済みのものを「回収した話数」だけ
  // 入れ直したいことがあるので、選べなくはしない
  return [
    ...marked.filter((choice) => !choice.current),
    ...marked.filter((choice) => choice.current),
  ];
}
