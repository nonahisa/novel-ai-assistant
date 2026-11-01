/**
 * 「設定資料集出力」で選ぶ種類（作者の判断 2026-11-02）。
 *
 * ## なぜ選ばせるか
 *
 * これまでは「設定資料集出力」（全部）とは別に、種類ごとの「人物一覧を生成」
 * 「場所一覧を生成」「能力一覧を生成」「世界観一覧を生成」がパレットに並び、
 * どれを押せばよいか分からなかった。しかも**組織だけ入口が無かった**。
 * 入口を「設定資料集出力」1つにし、押してから種類を選ぶ。
 *
 * **先頭は「すべて」**——VS Code の選ぶ画面は先頭が選ばれた状態で開くので、
 * Enter だけで今までどおり全部を書き出せる。
 *
 * 種類ごとの4つの命令は残す（ID を呼ぶ所があっても壊れない）。パレットからは外した。
 *
 * VS Code API に依存しない。`kinds` は `features/generateSettingsDocs.ts` の
 * `SettingsDocKind` と同じ値。
 */

export type SettingsDocChoiceKind =
  | "characters"
  | "abilities"
  | "organizations"
  | "locations"
  | "world"
  | "synopses";

export interface SettingsDocChoice {
  readonly label: string;
  readonly description: string;
  /** 書き出す種類。undefined は全部 */
  readonly kinds?: readonly SettingsDocChoiceKind[];
}

export const SETTINGS_DOC_CHOICES: readonly SettingsDocChoice[] = [
  {
    label: "すべて",
    description: "人物・場所・能力・組織・世界観・各話あらすじ",
  },
  { label: "人物", description: "characters.md", kinds: ["characters"] },
  { label: "場所", description: "locations.md", kinds: ["locations"] },
  { label: "能力", description: "abilities.md", kinds: ["abilities"] },
  { label: "組織", description: "organizations.md", kinds: ["organizations"] },
  { label: "世界観", description: "world.md", kinds: ["world"] },
  { label: "各話あらすじ", description: "synopsis.md", kinds: ["synopses"] },
];
