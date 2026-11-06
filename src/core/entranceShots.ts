/**
 * 「入口」の画面ショットの一覧（2026-11-06）。Discord のボットが使い方の答えに添える画像と、
 * その画像で赤く囲んだもの。
 *
 * **撮る側（`test/e2e/manual/menuEntrance.shots.ts`）とボットへ渡す側（`guideExport()`）の
 * 両方がここを読む。** 別々に書くと、撮り直して囲みを変えた日に、ボットだけが古い説明を
 * 添え続ける。
 *
 * `vscode`・`node:` に依らない（`guideExport.ts` から読まれ、ボットが束ねるため）。
 */
export interface EntranceShot {
  /** 画像の場所（リポジトリの根からの相対。区切りは `/`） */
  readonly file: string;
  /** その1枚で開いて見せるメニュー（左の列の見出しと同じ字） */
  readonly menu: string;
  /** 赤い楕円で囲んだもの（囲みは1枚に2つまで。`redRing.ts` の決まり） */
  readonly rings: readonly string[];
}

export const ENTRANCE_SHOTS: readonly EntranceShot[] = [
  {
    file: "media/promo/menu-entrance.png",
    menu: "簡単ステップメニュー",
    rings: ["左の「統合小説執筆環境」のアイコン", "「簡単ステップメニュー」の見出し"],
  },
  {
    file: "media/promo/menu-entrance-detail.png",
    menu: "詳細メニュー",
    rings: ["左の「統合小説執筆環境」のアイコン", "「詳細メニュー」の見出し"],
  },
];
