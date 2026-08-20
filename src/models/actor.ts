/**
 * 誰がその操作をしたか（設計書5.6）。
 *
 * **作者・編集者・AIの3つで足りる**（2026-08-19、作者の判断）。
 *
 * この3つを分ける理由は、**作者から見た意味がまったく違う**からである。
 *
 * - 自分の直しは、覚えている
 * - 編集部の直しは、**意図があって入っている**。うっかり捨ててはいけない
 * - AIの直しは、**自分が承諾した**もの。承諾した覚えがあるはずである
 *
 * 履歴の画面でこの3つを色分けするのは、見た目のためではない。
 * **並んでいるものが同じ見え方をしていたら、編集部の直しを自分の直しと
 * 取り違える。**
 */

export type ActorKind = "author" | "editor" | "ai";

export const ACTOR_KINDS: ActorKind[] = ["author", "editor", "ai"];

export interface ActorStyle {
  kind: ActorKind;
  label: string;
  /** 履歴の画面で使う色。**3つが並んだときに見分けられることを優先する** */
  color: string;
  description: string;
}

/**
 * 色は**明るさと色相の両方**を離す。
 *
 * 色相だけで分けると、色覚特性によっては見分けられない。
 * 記号（●▲■）も併せて出すので、色が分からなくても区別できる。
 */
export const ACTOR_STYLES: Record<ActorKind, ActorStyle> = {
  author: {
    kind: "author",
    label: "作者",
    color: "#2f6fb0",
    description: "あなたご自身の操作",
  },
  editor: {
    kind: "editor",
    label: "編集者",
    color: "#c2543a",
    description: "編集部の操作（編集者モードの環境から）",
  },
  ai: {
    kind: "ai",
    label: "AI",
    color: "#6a8f3d",
    description: "AIの提案のうち、あなたが承諾して反映したもの",
  },
};

/** 履歴の画面で色と一緒に出す印。**色が分からなくても区別できるように** */
export const ACTOR_MARKS: Record<ActorKind, string> = {
  author: "●",
  editor: "▲",
  ai: "■",
};

export function actorLabel(kind: ActorKind): string {
  return ACTOR_STYLES[kind]?.label ?? "不明";
}

/** 読めない値は「作者」にしない。**取り違えるより「不明」のほうがよい** */
export function parseActorKind(value: unknown): ActorKind | undefined {
  return typeof value === "string" && ACTOR_KINDS.includes(value as ActorKind)
    ? (value as ActorKind)
    : undefined;
}
