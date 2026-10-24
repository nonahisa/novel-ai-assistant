/**
 * 「はじめの案内」の操作の一覧を組む（設計書6.90.7）。
 *
 * 画面（QuickPick）から切り離した純粋な関数にしてある。「操作から戻った段が
 * 一覧に残るか」「印が付くか」を、VS Code なしで見張るため。
 */

/** 段に付く印。「済んだ」とは書かない——戻ってきても、やり終えたとは限らない */
export type TutorialStepMark = "opened" | "skipped";

export interface TutorialStepInput {
  command: string;
  label: string;
  why: string;
}

export type TutorialListItemKind = "step" | "later" | "back" | "finish";

export interface TutorialListItem {
  kind: TutorialListItemKind;
  label: string;
  description?: string;
  detail?: string;
  /** kind が "step" のときだけ */
  step?: TutorialStepInput;
}

export interface TutorialStepList {
  items: TutorialListItem[];
  /** 全部の段に印が付いたか（段が0個のときは false） */
  allMarked: boolean;
}

export const MARK_DESCRIPTION: Record<TutorialStepMark, string> = {
  opened: "$(check) 開いた",
  skipped: "$(debug-step-over) 飛ばした",
};

export function buildTutorialStepItems(input: {
  steps: readonly TutorialStepInput[];
  /** まだできないこと（作品を登録してから）。「いまはまだできません」と添える */
  later: readonly string[];
  /**
   * 開けるけれど、いまは出さないもの（`TutorialAdvice.withheld`。0.52.0）。
   * **`later` と混ぜない**——混ぜると「できません」が添えられ、開ける執筆統計を
   * 使えないものとして伝えてしまう（2026-10-24 に一覧の側で混ざっていた）
   */
  withheld?: readonly string[];
  marks: ReadonlyMap<string, TutorialStepMark>;
}): TutorialStepList {
  const items: TutorialListItem[] = [];

  input.steps.forEach((step, index) => {
    const mark = input.marks.get(step.command);
    items.push({
      kind: "step",
      label: `${index + 1}. ${step.label}`,
      description: mark ? MARK_DESCRIPTION[mark] : undefined,
      detail: step.why,
      step,
    });
  });

  for (const line of input.later) {
    items.push({
      kind: "later",
      label: "$(info) " + line,
      // 押せないものを押せる顔で出さない
      detail: "いまはまだできません（説明だけ）",
    });
  }
  for (const line of input.withheld ?? []) {
    items.push({
      // 押しても何も起きない行なので、扱いは「説明だけ」の行と同じ
      kind: "later",
      label: "$(info) いまは出していません：" + line,
      // 開き方は文の中に書いてある。「できません」とは書かない
      detail: "説明だけ（この案内では並べていません）",
    });
  }

  items.push({
    kind: "back",
    label: "$(arrow-left) やりたいことを選び直す",
    detail: "紙を読んで、別のほうが近いと思ったら",
  });
  items.push({
    kind: "finish",
    label: "$(close) 案内を終える",
    detail: "Esc でも終えられます。印はこの案内を閉じると消えます",
  });

  const allMarked =
    input.steps.length > 0 &&
    input.steps.every((step) => input.marks.has(step.command));
  return { items, allMarked };
}
