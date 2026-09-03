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
    count: 16,
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
    count: 5,
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
    count: 6,
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
    count: 16,
  },
  {
    id: "A-12",
    title: "チャンクの大きさの設定",
    commands: ["novelai.openExtensionSettings"],
    count: 7,
  },
  {
    id: "A-13",
    title: "縦書きの原稿エディタ",
    commands: ["novelai.openVertical"],
    count: 56,
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
    commands: ["novelai.showWritingStats"],
    count: 6,
  },
  {
    id: "F-8",
    title: "「1話ぶん」の印",
    commands: ["novelai.showWritingStats"],
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
    id: "F-16",
    title: "Markdownが既定の画面で開くか",
    commands: ["novelai.applyPendingUpdates", "novelai.exportImeDictionary", "novelai.runFullSetup", "novelai.diagnoseWeb"],
    count: 9,
  },
  {
    id: "F-17",
    title: "簡単ステップメニュー",
    commands: [],
    count: 9,
  },
  {
    id: "F-18",
    title: "設定資料パネルの絞り込み欄",
    commands: ["novelai.openSettingsPanel"],
    count: 1,
  },
  {
    id: "F-53",
    title: "F5限定：Ollamaの応答を流しながら受け取る実験",
    commands: ["novelai.dev.toggleOllamaStream"],
    count: 5,
  },
  {
    id: "F-54",
    title: "EPUB書き出し（試作）",
    commands: ["novelai.exportEpub"],
    count: 7,
  },
  {
    id: "F-55",
    title: "EPUBエディター（試作）",
    commands: ["novelai.openEpubEditor"],
    count: 7,
  },
  {
    id: "F-56",
    title: "表紙・裏表紙の合成",
    commands: ["novelai.openEpubEditor"],
    count: 11,
  },
  {
    id: "F-57",
    title: "挿絵とページ分割",
    commands: ["novelai.openEpubEditor"],
    count: 8,
  },
  {
    id: "F-58",
    title: "登場人物一覧と書体",
    commands: ["novelai.openEpubEditor"],
    count: 8,
  },
  {
    id: "F-59",
    title: "相談画面の切り替えと、再起動後の表示",
    commands: ["novelai.openChatPanel"],
    count: 8,
  },
  {
    id: "F-60",
    title: "章立て",
    commands: ["novelai.startChapter"],
    count: 8,
  },
  {
    id: "F-61",
    title: "話の挿入と削除",
    commands: ["novelai.insertEpisodeBefore", "novelai.removeEpisodeAndRenumber"],
    count: 6,
  },
  {
    id: "F-62",
    title: "EPUBの3つの直し",
    commands: ["novelai.openEpubEditor"],
    count: 4,
  },
  {
    id: "F-63",
    title: "未チューニングの安全既定",
    commands: ["novelai.measureContext"],
    count: 5,
  },
  {
    id: "F-64",
    title: "EPUBのブロック（段B）",
    commands: ["novelai.openEpubEditor"],
    count: 6,
  },
  {
    id: "F-65",
    title: "EPUBのブロック式画面（段C）",
    commands: ["novelai.openEpubEditor"],
    count: 8,
  },
  {
    id: "F-52",
    title: "待ち時間300秒の壁——通信部品（undici）側の上限も設定に合わせた",
    commands: ["novelai.extractSettings"],
    count: 1,
  },
  {
    id: "F-51",
    title: "詳細メニューの整理——散らばっていた「設定」を1か所へ集めた",
    commands: ["novelai.setWorkGoals", "novelai.setPlotBasics", "novelai.manageKeepWords", "novelai.manageCustomFields", "novelai.configureAnnouncement"],
    count: 9,
  },
  {
    id: "F-50",
    title: "Ollamaの起動——ポートを握ったまま応答しない古いOllamaを見分ける",
    commands: ["novelai.setupOllama"],
    count: 6,
  },
  {
    id: "F-49",
    title: "読み上げ（音読推敲）",
    commands: ["novelai.readManuscriptAloud"],
    count: 11,
  },
  {
    id: "F-48",
    title: "更新告知文を作る",
    commands: ["novelai.generateAnnouncement", "novelai.configureAnnouncement"],
    count: 10,
  },
  {
    id: "F-47",
    title: "AIチューニング（測って設定を合わせる）",
    commands: ["novelai.measureContext"],
    count: 21,
  },
  {
    id: "F-46",
    title: "本文を溢れさせない——関所と固定費の実測",
    commands: ["novelai.checkTypos", "novelai.checkContradictions", "novelai.extractSettings"],
    count: 6,
  },
  {
    id: "F-45",
    title: "シーンメモ",
    commands: ["novelai.openSceneMemos"],
    count: 9,
  },
  {
    id: "F-44",
    title: "年表——話数順と時系列順",
    commands: ["novelai.openChronicle", "novelai.editTimeline"],
    count: 7,
  },
  {
    id: "F-43",
    title: "人物相関図",
    commands: ["novelai.openRelationGraph", "novelai.openSettingsPanel"],
    count: 9,
  },
  {
    id: "F-42",
    title: "生成した文書の実ファイル化と自動掃除",
    commands: ["novelai.resumeWriting", "novelai.openManual", "novelai.checkOpening"],
    count: 4,
  },
  {
    id: "F-41",
    title: "名前の点検と付け替え",
    commands: ["novelai.checkNames", "novelai.renameCharacter", "novelai.applyRenameToRecords"],
    count: 9,
  },
  {
    id: "F-40",
    title: "レビュー指摘9件の修正",
    commands: ["novelai.setupAI", "novelai.checkTypos", "novelai.checkForeshadows", "novelai.openVertical"],
    count: 8,
  },
  {
    id: "F-39",
    title: "ダッシュの混在と、組んで書く面の隙間",
    commands: ["novelai.checkTypos", "novelai.openVertical"],
    count: 4,
  },
  {
    id: "F-38",
    title: "LM Studio の起動と、モデルの読み込み",
    commands: ["novelai.testAI", "novelai.setupLmStudio", "novelai.setupAI"],
    count: 9,
  },
  {
    id: "F-37",
    title: "矛盾検知の検証段の進み表示",
    commands: ["novelai.checkContradictions"],
    count: 2,
  },
  {
    id: "F-36",
    title: "AI相談の「使い方の説明」を目次＋束にした",
    commands: ["novelai.openChatPanel"],
    count: 7,
  },
  {
    id: "F-35",
    title: "原稿エディタの一新——文字数・前後の話・記録の細分化ほか",
    commands: ["novelai.openVertical", "novelai.resumeWriting"],
    count: 9,
  },
  {
    id: "F-34",
    title: ".txtのルビ・傍点の表示と色ズレ対策",
    commands: ["novelai.openVertical", "novelai.exportPdf"],
    count: 6,
  },
  {
    id: "F-33",
    title: "実機報告の修正・続き",
    commands: ["novelai.openVertical"],
    count: 7,
  },
  {
    id: "F-32",
    title: "実機報告の修正まとめ",
    commands: ["novelai.openVertical", "novelai.checkTypos"],
    count: 6,
  },
  {
    id: "F-31",
    title: "執筆を再開する＋単話プロットの雛形",
    commands: ["novelai.resumeWriting", "novelai.createEpisodePlot"],
    count: 5,
  },
  {
    id: "F-30",
    title: "伏線のAI検知",
    commands: ["novelai.checkForeshadows", "novelai.checkForeshadowResolution", "novelai.setForeshadowStatus"],
    count: 8,
  },
  {
    id: "F-29",
    title: "伏線の台帳",
    commands: ["novelai.openForeshadows", "novelai.addForeshadow", "novelai.checkContradictions"],
    count: 6,
  },
  {
    id: "F-28",
    title: "CRLF原稿の位置ずれと改行の書き換わり",
    commands: ["novelai.openVertical"],
    count: 5,
  },
  {
    id: "F-27",
    title: "組んで書く（実験）——ルビが組まれたまま打てる面",
    commands: ["novelai.openVertical"],
    count: 12,
  },
  {
    id: "F-26",
    title: "並べる面のカーソル追従と差分更新",
    commands: ["novelai.openVertical"],
    count: 7,
  },
  {
    id: "F-25",
    title: "PDF出力（印刷用）",
    commands: ["novelai.exportPdf"],
    count: 12,
  },
  {
    id: "F-24",
    title: "機能ごとにAIを割り当てる",
    commands: ["novelai.assignFeatureAI"],
    count: 8,
  },
  {
    id: "F-23",
    title: "AI相談の大きい画面と使い方マニュアル",
    commands: ["novelai.openChatPanel", "novelai.openManual"],
    count: 11,
  },
  {
    id: "F-22",
    title: "AIで再読込",
    commands: ["novelai.openSettingsPanel"],
    count: 9,
  },
  {
    id: "F-19",
    title: "設定資料パネルの作品情報タブ",
    commands: ["novelai.openSettingsPanel"],
    count: 3,
  },
  {
    id: "F-20",
    title: "別人に分けた記録が、再抽出で混ざらないか",
    commands: ["novelai.extractCharactersOnly", "novelai.extractSettings"],
    count: 3,
  },
  {
    id: "F-21",
    title: "創作論ベースの助言",
    commands: ["novelai.openChatPanel", "novelai.generateWorkBlurb", "novelai.generateCatchphrases", "novelai.checkProofread", "novelai.checkOpening"],
    count: 11,
  },
  {
    id: "",
    title: "LM Studio",
    commands: ["novelai.setupLmStudio", "novelai.setupAI", "novelai.testAI"],
    count: 15,
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
export const PENDING_CHECK_TOTAL = 734;
