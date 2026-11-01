/**
 * 作品の右クリックの「投稿と読者の反応…」（作者の判断 2026-11-02）。
 *
 * ## なぜまとめたか
 *
 * 作品の右クリックの品書きには、執筆・資料の操作と並んで投稿まわりが6つ
 * （新話投稿・投稿サイト設定・ランキング記録・読者反応2つ・連載状態切替）並び、
 * 縦に長くて目当ての行を探しにくかった。**入口を1つにし、押すと中の6つを選ぶ。**
 *
 * 6つの命令は残す。コマンドパレット・詳細メニュー・相談・知らせのボタンは
 * それぞれの ID で今までどおり呼ぶ。
 *
 * 名前は各命令の題（package.json の `title`）と同じにする。違う名前で並べると、
 * パレットや詳細メニューで同じ操作を探せなくなる（`postingMenu.test.ts` が見る）。
 *
 * VS Code API に依存しない。
 */

export const POSTING_MENU_COMMAND = "novelai.postingAndReaders";

export interface PostingMenuEntry {
  readonly command: string;
  readonly label: string;
  /** 選ぶ画面の説明欄。何が起きるかを短く */
  readonly description: string;
}

/** 並びは、まとめる前の右クリックの順（作者が見慣れた順）のまま */
export const POSTING_MENU_ENTRIES: readonly PostingMenuEntry[] = [
  {
    command: "novelai.postNewEpisode",
    label: "新話投稿",
    description: "未投稿の話を、変換→コピー→投稿ページ→記録の順に案内",
  },
  {
    command: "novelai.configurePostingSites",
    label: "投稿サイト設定",
    description: "この作品を出すサイトの追加・変更・取り外し",
  },
  {
    command: "novelai.recordRanking",
    label: "ランキング記録",
    description: "投稿サイトで見た順位を書き留める",
  },
  {
    command: "novelai.importReaderStats",
    label: "読者反応自動取込",
    description: "ヘルパーが読んだPV・評価などを取り込む",
  },
  {
    command: "novelai.recordReaderStats",
    label: "読者反応手動入力",
    description: "サイトで見たPV・評価・いいねを書き留める",
  },
  {
    command: "novelai.setWorkCompletion",
    label: "連載状態切替",
    description: "連載中／完結を切り替える",
  },
];
