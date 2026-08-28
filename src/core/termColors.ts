import type { TermKind } from "./termIndex";

/**
 * 用語の種類ごとの色。**定義はこのファイルだけ。**
 *
 * 同じ色分けを3か所が使う。
 *
 * - `views/termHighlight.ts`：普通のエディタの装飾
 * - `features/manuscriptEditor.ts`：原稿エディタ（画面へ変数として渡す）
 * - `views/settingsPanelHtml.ts`：設定資料パネルのタブ
 *
 * 以前は原稿エディタ側に「termHighlight.ts と同じ色を使う」という
 * **注釈だけ**を置いて16進を写していた。写しは片方だけが直る日が来るので、
 * **画面ごとに違う色にしない**という決まりをコードで担保する。
 *
 * ここに VS Code API を持ち込まないこと（`core` は API に依存しない）。
 * 明暗どちらを使うかは、それぞれの画面が自分の流儀で決める——
 * 拡張機能側はテーマの種別から、WebView 側は body の class から。
 */
export interface TermColorPair {
  light: string;
  dark: string;
}

export const TERM_COLORS: Record<TermKind, TermColorPair> = {
  // 人名は青。最も数が多く、既定色として馴染みがある
  character: { light: "#1a5fb4", dark: "#7cb7ff" },
  // 地名は緑。人名と混ざらない色相を選ぶ
  location: { light: "#1c7c3c", dark: "#7ee08a" },
  // 能力は紫。地の文で目立ちすぎない明度にする
  ability: { light: "#7a3ea3", dark: "#d3a4f5" },
  // 組織は橙。人名・地名・能力のどれとも混ざらない色相にする
  organization: { light: "#9a5b00", dark: "#e8b06a" },
};

/** 色分けのある種類（並びも画面で揃える） */
export const TERM_COLOR_KINDS = Object.keys(TERM_COLORS) as TermKind[];
