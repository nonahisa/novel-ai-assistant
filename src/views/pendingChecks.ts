// このファイルは自動生成です。手で書き換えないでください。
// 作り直す: npm run checks:menu
// 元の文書: docs/実機確認リスト.md


/** 実機でまだ確かめていない機能の、1かたまり */
export interface PendingCheckSection {
  /** 確認リストの番号（"A-15"）。無い節は空文字 */
  id: string;
  /** 節の名前 */
  title: string;
  /** その節で確かめる操作。無い節（環境が要るものなど）は空 */
  commands: string[];
  /** まだ確かめていない項目の数 */
  count: number;
}

/**
 * まだ確かめていないもの。**docs/実機確認リスト.md から機械的に作る**
 *
 * **項目の文章はここに入れない**（作者の指定、2026-08-26）。
 * 確認リストには作者の作品名のような外へ出すつもりのない言葉が入るので、
 * 配布物に混ぜない。文章は `src/dev/pendingCheckItems.ts`（配布物に入らない）にある。
 */
export const PENDING_CHECKS: readonly PendingCheckSection[] = [
  {
    id: "A-1",
    title: "誤字脱字・推敲の適用",
    commands: ["novelai.checkTypos", "novelai.checkProofread"],
    count: 8,
  },
  {
    id: "A-3",
    title: "編集部の提案を採る",
    commands: ["novelai.reviewProposals"],
    count: 2,
  },
  {
    id: "A-4",
    title: ".txt → .md の変換",
    commands: ["novelai.convertToMarkdown"],
    count: 8,
  },
  {
    id: "A-5",
    title: "編集部へ渡す",
    commands: ["novelai.shareWithEditor"],
    count: 7,
  },
  {
    id: "A-6",
    title: "編集部の提案を取り込む",
    commands: ["novelai.collectEditorProposals"],
    count: 4,
  },
  {
    id: "A-8",
    title: "書庫へまとめ直す",
    commands: ["novelai.mergeIntoLibrary"],
    count: 12,
  },
  {
    id: "A-9",
    title: "傍点と、MD化での記法の取り込み",
    commands: ["novelai.convertToMarkdown", "novelai.openVertical"],
    count: 15,
  },
  {
    id: "A-10",
    title: "設定資料からルビを振る",
    commands: ["novelai.openSettingsPanel"],
    count: 15,
  },
  {
    id: "A-11",
    title: "矛盾検知のまとめ送信",
    commands: ["novelai.checkContradictions"],
    count: 18,
  },
  {
    id: "A-12",
    title: "チャンクの大きさの設定",
    commands: ["novelai.openExtensionSettings"],
    count: 5,
  },
  {
    id: "A-13",
    title: "縦書きの原稿エディタ",
    commands: ["novelai.openVertical"],
    count: 51,
  },
  {
    id: "A-14",
    title: "設定資料の名前の書き換え",
    commands: ["novelai.openSettingsPanel"],
    count: 11,
  },
  {
    id: "A-15",
    title: "作品をすべて同期",
    commands: ["novelai.syncAllWorks"],
    count: 16,
  },
  {
    id: "A-16",
    title: "紹介の80字と、変化の関与度",
    commands: ["novelai.openSettingsPanel", "novelai.extractSettings"],
    count: 8,
  },
  {
    id: "A-17",
    title: "分かれた分を合わせる",
    commands: ["novelai.resolveDivergence"],
    count: 11,
  },
  {
    id: "B-1",
    title: "ルビのプレビュー",
    commands: ["novelai.convertToMarkdown"],
    count: 3,
  },
  {
    id: "B-2",
    title: "書庫の一括登録",
    commands: ["novelai.addWork"],
    count: 6,
  },
  {
    id: "B-3",
    title: "提案パネルが開くか",
    commands: ["novelai.reviewProposals"],
    count: 25,
  },
  {
    id: "B-4",
    title: "編集履歴の色分け",
    commands: ["novelai.showEditHistory"],
    count: 3,
  },
  {
    id: "B-5",
    title: "はじめて開いたときのAI選択",
    commands: ["novelai.setupAI"],
    count: 3,
  },
  {
    id: "C",
    title: "GitHubへはじめて同期する",
    commands: ["novelai.setupGithub"],
    count: 5,
  },
  {
    id: "",
    title: "まとめて1つの置き場にする",
    commands: ["novelai.setupGithub"],
    count: 9,
  },
  {
    id: "D",
    title: "対話でプロットを作る",
    commands: ["novelai.plotInterview"],
    count: 9,
  },
  {
    id: "E",
    title: "編集部と一緒に使う",
    commands: ["novelai.shareWithEditor", "novelai.switchMode"],
    count: 9,
  },
  {
    id: "F-1",
    title: "ファイルの開き方",
    commands: ["novelai.createPlot"],
    count: 5,
  },
  {
    id: "F-2",
    title: "操作メニュー",
    commands: [],
    count: 1,
  },
  {
    id: "F-3",
    title: "誤字脱字の対象範囲",
    commands: ["novelai.checkTypos"],
    count: 1,
  },
  {
    id: "F-4",
    title: "直さない語",
    commands: ["novelai.manageKeepWords"],
    count: 3,
  },
  {
    id: "F-5",
    title: "独り言",
    commands: [],
    count: 1,
  },
  {
    id: "F-6",
    title: "取り込み時の改行の注意",
    commands: ["novelai.gitSync"],
    count: 2,
  },
  {
    id: "F-7",
    title: "文字数の数え方",
    commands: ["novelai.showWorkStats"],
    count: 6,
  },
  {
    id: "F-8",
    title: "「1話ぶん」の印",
    commands: ["novelai.showWorkStats"],
    count: 1,
  },
  {
    id: "F-9",
    title: "操作メニューの色",
    commands: [],
    count: 2,
  },
  {
    id: "F-10",
    title: "設定資料の名前を別名から選ぶ",
    commands: ["novelai.openSettingsPanel"],
    count: 7,
  },
  {
    id: "F-11",
    title: "作品一覧の同期の印",
    commands: [],
    count: 7,
  },
  {
    id: "F-12",
    title: "動作を診断を、手元では隠した",
    commands: [],
    count: 3,
  },
  {
    id: "F-13",
    title: "1つにまとめられた人物を、別人に分ける",
    commands: ["novelai.openSettingsPanel"],
    count: 19,
  },
  {
    id: "F-14",
    title: "AIを切り替えたときの相談パネルの表示",
    commands: ["novelai.setupAI"],
    count: 3,
  },
  {
    id: "F-15",
    title: "作品選択の残件数",
    commands: ["novelai.unifyCharacters"],
    count: 7,
  },
  {
    id: "",
    title: "LM Studio",
    commands: ["novelai.setupAI", "novelai.testAI"],
    count: 9,
  },
  {
    id: "",
    title: "さくらのAI Engine は動いた",
    commands: ["novelai.testAI"],
    count: 2,
  },
  {
    id: "H",
    title: "ブラウザ版（vscode.dev / github.dev）",
    commands: ["novelai.diagnoseWeb"],
    count: 12,
  },
];

/** 残っている項目の総数 */
export const PENDING_CHECK_TOTAL = 354;
