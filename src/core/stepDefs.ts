import { keysForHost } from "./keyLabels";

/**
 * 簡単ステップメニューの**定義**（どの段にどの操作を並べるか）。
 *
 * 画面（`views/stepMenu.ts`）から切り出した（2026-10-01。残課題 R6）。
 * 相談の目次は「その操作の入口はどこか」を、簡単ステップメニューが
 * 参照しているかで導く（`core/actionEntrance.ts`）。画面のファイルは
 * `vscode` を引くので、外から呼ぶ相談（MCP）の束からは読めなかった
 * （設計書6.87.3）。**定義はここ1か所**で、画面はここを読む。
 */

/** 準備中の項目。まだコマンドが無い段階を、消さずに置いて予定だと伝える */
export interface StepPlaceholder {
  kind: "placeholder";
  label: string;
  icon: string;
  /** ホバーで出す説明。**いま何で代われるか**まで書く */
  detail: string;
}

/** 小分類の定義。中身はコマンドIDの参照だけを持つ */
export interface StepSectionDef {
  kind: "section";
  label: string;
  icon: string;
  commands: readonly string[];
}

/** 段階の中身。文字列はコマンドIDの参照 */
export type StepEntryDef = string | StepSectionDef | StepPlaceholder;

export interface StepDef {
  label: string;
  icon: string;
  /** ホバーで出す説明。**何をする段階か**を書く */
  detail: string;
  entries: readonly StepEntryDef[];
}

/**
 * 簡単ステップメニューの中身。**この配列が画面の順序そのもの**である。
 *
 * 並べるのは「その段階でよく通る操作」だけにする。全操作は詳細メニューにある。
 *
 * 末尾の「ヘルプ」だけは番号を持たない。作品づくりの流れの中の一段階では
 * なく、**どの段階からでも寄る場所**だからである（番号を振ると
 * 「8番目にやること」に見える）。
 */
export const STEP_DEFS: readonly StepDef[] = [
  {
    label: "1. 作品登録",
    icon: "folder-opened",
    detail:
      "書く作品を、この拡張機能に覚えさせる段階\n\n" +
      "・これから書く作品\n\n" +
      "・すでに原稿があるフォルダー\n\n" +
      "・別のPCで書いている作品",
    /*
      **作品の入口を、ここへ寄せる**（設計書6.97.4）。詳細メニューの
      「新規執筆開始／既存原稿登録／クラウド取得」（2026-09-23 に改名）と
      同じ5つを並べる（既存原稿登録の「未登録作品検索」「Word 原稿変換」は
      ステップには置かない）。

      新規作成の2つは、以前は「2. 新作構想」と「3. 作品執筆」に散っていた。
      だが**作品を作るのは登録そのもの**であり、構想を練る前・書き始める前に
      通る段である。ここへ移したぶん、あちらからは外す——同じ操作が
      2か所に出ると、初めての人はどちらを押せばよいか決められない。

      **バックアップからの取り込みは、「すでにある原稿」の先頭に置く**
      （0.70.1）。0.68.5 で入れてから、この一覧にも作品一覧の案内文にも
      載せ忘れていて、作者が実機で探して見つけられなかった（2026-09-19）。
      投稿サイトで書いてきた人にとっては、**フォルダーを自分で作って
      から登録する道より近い**——選ぶのはダウンロードしたファイル1つで、
      展開も作品フォルダーの用意も向こうがやる（設計書6.99）。
    */
    entries: [
      "novelai.createWorkWithPlot",
      "novelai.createWorkFromManuscript",
      "novelai.importWorkFromZip",
      "novelai.addWork",
      "novelai.addWorkFromGithub",
    ],
  },
  {
    label: "2. 新作構想",
    icon: "list-tree",
    detail:
      "何を書くかを決める段階\n\n" +
      "・ログライン・テーマ・世界観・あらすじをプロットに書き留める",
    entries: [
      // 新規作成（プロットから開始）は「1. 作品登録」へ移した（設計書6.97.4）
      "novelai.createPlot",
      // プロットを書く場（設計書6.4.8）。目次と話の見取り図を横に並べる
      "novelai.openPlotMode",
      "novelai.plotInterview",
      "novelai.setPlotBasics",
      "novelai.generatePlot",
      // 名付けの段階で使う（設計書6.37.5）。響きの重なりは、
      // 増えてから直すより、付けるときに気づくほうが安い
      "novelai.checkNames",
    ],
  },
  {
    label: "3. 作品執筆",
    icon: "edit",
    detail:
      "本文を書き進める段階\n\n" +
      "・執筆の場\n\n" +
      "・資料生成\n\n" +
      "・入力補助",
    entries: [
      {
        kind: "section",
        label: "執筆の場",
        icon: "book",
        commands: [
          // **先頭は「再開用資料」**（設計書6.36.4）。
          // 続きを書く日に最初に押すもので、AIを呼ばずにその場で出る
          "novelai.resumeWriting",
          "novelai.createEpisodePlot",
          // 本文の付箋を横に並べる画面（設計書6.40.4）。書きながら見るもの
          "novelai.openSceneMemos",
          // 新規作成（本文から開始）は「1. 作品登録」へ移した（設計書6.97.4）
          //
          // **「縦書きで開く」はここへ置かない**（作者の実機報告、2026-09-19）。
          // あれは `activeManuscriptUri()` を見る操作で、本文を開いていないと
          // 「本文を開いてから」と断る。**この一覧は「次に何をするか」なので、
          // 開いていない人が押して必ず断られる操作を並べてはいけない。**
          // 同じことは原稿エディタの上のバーの「縦書き」でできて、しかも
          // 切り替えた向きは原稿ごとに覚える。詳細メニュー（全操作の一覧）と
          // 本文の右クリックには残してある。
          // 大きく開くほう。**横のパネルは本文の右クリックだけにある**（0.29.23）
          "novelai.openChatPanel",
          "novelai.showWritingStats",
          // 書いたものを別の軸（作中の時間）で見直す画面（設計書6.39）
          "novelai.openChronicle",
        ],
      },
      {
        kind: "section",
        label: "資料生成",
        icon: "wand",
        commands: [
          "novelai.extractSettings",
          "novelai.unifyCharacters",
          "novelai.applyPendingUpdates",
          "novelai.openSettingsPanel",
          "novelai.generateSettingsDocs",
        ],
      },
      {
        kind: "section",
        // 名前は「入力補助」（作者の裁定、2026-09-23。旧「入力を楽に」）
        label: "入力補助",
        icon: "symbol-keyword",
        // **ルビ付与・傍点付与は置かない**（作者の裁定、2026-09-23 問8 A）。
        // 原稿エディターの上のバーと右クリックに同じ道があり、「不要」との
        // 書き込みは詳細メニューだけでなくここにも当たる
        commands: ["novelai.convertToMarkdown", "novelai.exportImeDictionary"],
      },
    ],
  },
  {
    label: "4. 自己校正",
    icon: "search-fuzzy",
    // **説明文に強調の記号を使わない。** この段階の説明は
    // `plainTextUi.test.ts` が見張る範囲にあり、Markdownとして読まれる先
    // （ホバー）以外へ回ったときに記号がそのまま画面に出る
    detail:
      "書いた本文を、人に見せる前に自分で見直す段階\n\n" +
      "・指摘を1件ずつ見て決める\n\n" +
      "本文は勝手に書き換わらない。",
    entries: [
      // まとめて走らせる入口を先頭に置く（設計書6.80）
      "novelai.runProofreadingSuite",
      "novelai.checkTypos",
      "novelai.manageKeepWords",
      "novelai.checkNotation",
      "novelai.checkProofread",
      "novelai.checkOpening",
      // 「ターゲット読者」（設計書6.108.6）。冒頭診断の隣——詳細メニューの
      // 「読者診断」と同じ並び。診断・シート・3つの輪はこの1つに統合した
      "novelai.openTargetReader",
      "novelai.checkDeviations",
      // 矛盾検知は入口1つ（設定との照合と話どうしの照合を、押してから選ぶ。
      // 作者の裁定、2026-09-23）
      "novelai.checkContradictions",
      // 伏線は矛盾の次に置く。矛盾検知の指摘から
      // 「伏線として登録」で飛んでくるため（設計書6.35.4）
      //
      // **並びは詳細メニューと同じ**（作者の裁定、2026-09-23）：
      // 検知 → 手動追加 → 状態変更 → 回収確認 → 一覧。
      // 手で足す入口は2026-09-12 の裁定で置いた——伏線は検知で拾うより
      // 書いた本人が「これは伏線」と足すのが入口として自然で、詳細メニューにしか
      // 無いと、ステップから入った人には「登録は AI 任せ」に見える
      "novelai.checkForeshadows",
      "novelai.addForeshadow",
      "novelai.setForeshadowStatus",
      "novelai.checkForeshadowResolution",
      "novelai.openForeshadows",
    ],
  },
  {
    label: "5. 投稿脱稿",
    icon: "rocket",
    detail:
      "投稿サイトへ出す段階\n\n" +
      "・あらすじ・紹介文・キャッチコピーを整える\n\n" +
      "・本文を投稿サイトの形に直す",
    entries: [
      "novelai.generateSynopses",
      "novelai.generateWorkBlurb",
      "novelai.generateCatchphrases",
      "novelai.openSynopsisDocs",
      "novelai.copyForPosting",
      // 「編集者へ渡す」は6段へ移した（作者の判断 2026-11-01）。編集者と組む操作を1段に集める
      /*
        **「WEB投稿支援（準備中）」の枠を、実物に置き換えた**（作者の裁定、
        2026-09-23 問14 A）。予定していた「ブラウザで投稿を助ける」は、
        新話投稿（変換→コピー→投稿ページ→記録の案内。ヘルパーへ渡す形でも
        コピーできる）と、ヘルパーが読んだ数字の取り込みで、別の道から
        でき上がっていた。
      */
      "novelai.postNewEpisode",
      "novelai.importReaderStats",
    ],
  },
  {
    label: "6. 編集者校正・校閲",
    icon: "organization",
    detail:
      "編集者と一緒に仕上げる段階\n\n" +
      "・編集者へ渡し、届いた提案を1件ずつ決める\n\n" +
      "編集者は本文を書き換えず、提案として置く。",
    /*
      **作者が押す操作だけを並べる**（作者の判断 2026-11-01）。以前は「校閲開始／終了」
      「校閲を終えて返す」も並び、作者が押しても編集者モードの操作だと断られた。
      編集者の流れは編集者モードの並び（下の `EDITOR_STEP_DEFS`）にある。

      並びは作者の作業の順（渡す → 提案を見る → 解除 → 履歴）。切替と参加は、
      自分が編集者として人の作品を見る日のための入口なので、流れの後ろに置く
    */
    entries: [
      "novelai.shareWithEditor",
      // 取込と確認を1つにした（作者の判断 2026-11-01）。受け取って未決を並べる
      "novelai.viewEditorProposals",
      "novelai.revokeEditorAccess",
      "novelai.showEditHistory",
      "novelai.switchMode",
      "novelai.joinAsEditor",
    ],
  },
  {
    label: "7. 電子出版等",
    icon: "package",
    detail:
      "書き上げた作品を、紙や電子書籍の形にして出す段階\n\n" +
      "・PDF（印刷用）とEPUB（電子書籍）\n\n" +
      "・本の見た目はEPUBエディターで確かめながら決める",
    // **「EPUB出力（予定）」の枠は外した**（作者の指定、2026-09-03）。
    // 設計書6.65が実装できたので、枠ではなく実物を載せる
    // **「EPUBへ書き出す」はここに置かない**（作者の指定、2026-09-04）。
    // 書き出しボタンはEPUBエディターの中にあり、外にも同じ入口があると
    // 「どちらから出すのが正しいのか」が分からない
    entries: ["novelai.exportPdf", "novelai.openEpubEditor"],
  },
  {
    // **番号を付けない**（作者の指定、2026-08-29）。流れの中の一段階ではなく、
    // どの段階からでも寄る場所である。アイコンは詳細メニューの「ヘルプ」と
    // 同じ question にして、同じものだと分かるようにする
    label: "ヘルプ",
    icon: "question",
    detail:
      "使い方が分からないとき、うまく動かないときに開く場所\n\n" +
      "・作品を選んでいなくても使える",
    // 並びは詳細メニューの「ヘルプ」分類に合わせる（使い方 → 場面別案内 →
    // ログ → 版）。「動作診断」は詳細メニューにも出さず（作者の書き込み「削除で」、
    // 2026-09-23）コマンドパレットからだけ呼ぶ操作なので、ここには置かない
    entries: [
      "novelai.openManual",
      // 場面別案内も置く。簡単ステップメニューを使う作者のほうが、
      // 「何から押せばよいか」を案内してほしい場面が多い
      "novelai.openSceneGuide",
      "novelai.showLog",
      "novelai.openChatLog",
      "novelai.showVersion",
    ],
  },
];

/**
 * 編集者メニューの手順の見分け（`core/editorProgress.ts` が「済み／次はここ／まだ」を決める鍵）。
 * 画面の名前を変えても、進み具合の決まりが付いて来るように、名前とは別に持つ
 */
export type EditorStepKey =
  | "receive"
  | "range"
  | "detect"
  | "propose"
  | "review"
  | "return"
  | "decisions";

/**
 * 編集者メニューに並べる操作1つ。
 *
 * 文字列（コマンドID）なら、名前と説明は詳細メニュー（`ACTION_TREE`）から引く。
 * 詳細メニューに無い操作（「ここにメモを足す」・提案パネル・編集者メニューだけの操作）は、
 * ここで名前と説明を持つ（`stepMenuEditorMode.test.ts` が、どちらかで引けるかを見張る）
 */
export interface EditorMenuEntryDef {
  command: string;
  label: string;
  icon: string;
  detail: string;
  requiresWork: boolean;
}

export type EditorMenuEntry = string | EditorMenuEntryDef;

export interface EditorStepDef {
  key: EditorStepKey;
  label: string;
  icon: string;
  /** ホバーで出す説明。**何をする手順か**を書く */
  detail: string;
  /** 1つだけなら、手順の行そのものを押して走らせる。2つ以上なら、開くと並ぶ */
  entries: readonly EditorMenuEntry[];
}

/**
 * 編集者メニュー（作者の指示 2026-11-05 夜「編集者用のメニューは専用のものを表示するように
 * して、上から順番に処理したら終わるようにしたほうがよさそうです」。設計書5.6.6）。
 *
 * 編集者モードでは、横の枠の一番上に専用のメニュー（`views/editorMenu.ts`）を出し、
 * 簡単ステップメニューは出さない。手順は上から順に7つで、各行の左に進み具合の印が付く。
 *
 * - **編集者モードで押せる操作だけを並べる**（`editorMode.ts` の許可の一覧。
 *   食い違いは `stepMenuEditorMode.test.ts` が見張る）
 * - **押すだけで済む手順は、行そのものを押す。** 開いてから押す一手を省く
 */
export const EDITOR_STEP_DEFS: readonly EditorStepDef[] = [
  {
    key: "receive",
    label: "1. 作者の最新の原稿を受け取る",
    icon: "cloud-download",
    detail:
      "作者が直した原稿を、GitHubから受け取る手順\n\n" +
      "・校閲を始める前に押す\n\n" +
      "・受け取るだけで、こちらから作者へは何も送らない\n\n" +
      "・作者へ送るのは「6. 校閲を終えて作者へ返す」",
    // 編集者モードの「保存・同期」は受け取るだけ（作者の判断 2026-11-01）
    entries: ["novelai.saveAndSync"],
  },
  {
    key: "range",
    label: "2. 校閲する話を選ぶ",
    icon: "lock",
    detail:
      "これから見る話を選び、「校閲中」として作者に知らせる手順\n\n" +
      "・始めの話と終わりの話を選ぶ\n\n" +
      "・選んだ話を作者が直そうとすると、知らせが出る",
    entries: ["novelai.toggleReviewLock"],
  },
  {
    key: "detect",
    label: "3. 機械に探させる",
    icon: "search-fuzzy",
    detail:
      "直したほうがよさそうな所を、機械に探させる手順\n\n" +
      "・表記ゆれ検知は AI を使わないので、AI の設定が無くても使える\n\n" +
      "・誤字脱字検知と推敲は AI を使う\n\n" +
      "・見つかったものは提案パネルの［適用］で提案として置く。本文は書き換わらない",
    entries: [
      "novelai.checkNotation",
      "novelai.checkTypos",
      "novelai.checkProofread",
      "novelai.manageKeepWords",
    ],
  },
  {
    key: "propose",
    label: "4. 直しを提案する・メモ（意見）を書く",
    icon: "edit",
    detail:
      "読んで気づいたことを、自分の言葉で作者へ伝える手順\n\n" +
      "・直したい所を本文で選んでから押す\n\n" +
      keysForHost("・本文を選んで右クリックしても出せる\n\n") +
      "本文は書き換わらない。作者が採るかどうかを決める。",
    entries: [
      "novelai.proposeEditByHand",
      {
        command: "novelai.addSceneMemo",
        label: "ここにメモ（意見）を足す",
        icon: "note",
        requiresWork: false,
        detail:
          "本文のいまの行への意見を、提案として置く\n\n" +
          "・直す案は書かず、思ったことだけを作者へ伝える\n\n" +
          keysForHost("・本文で行を選んでから押す。右クリックの「ここにメモを足す」と同じ\n\n") +
          "本文に行は足さない。",
      },
    ],
  },
  {
    key: "review",
    label: "5. 置いた提案を見直す",
    icon: "inbox",
    detail:
      "置いた提案を、作者へ返す前に見直す手順\n\n" +
      "・置いた提案の一覧から、本文のその場所へ飛べる\n\n" +
      "・検知の結果で、まだ置いていないものは提案パネルにある",
    entries: [
      {
        command: "novelai.listPlacedProposals",
        label: "置いた提案の一覧",
        icon: "list-flat",
        requiresWork: true,
        detail:
          "この作品に置いた提案を、新しい順に並べる\n\n" +
          "・選ぶと、本文のその場所を開く\n\n" +
          "・作者が決めたものには、採用・見送り・読まれたの印が付く",
      },
      {
        command: "novelai.openProposals",
        label: "提案パネルを開く",
        icon: "checklist",
        requiresWork: false,
        detail:
          "検知の結果が並ぶパネルを開く\n\n" +
          "・［適用］を押すと、提案として置く（本文は書き換わらない）",
      },
      "novelai.reviewProposals",
      "novelai.showEditHistory",
    ],
  },
  {
    key: "return",
    label: "6. 校閲を終えて作者へ返す",
    icon: "check-all",
    detail:
      "選んだ話の「校閲中」を外し、置いた提案を作者へ届ける手順\n\n" +
      "・送るのは提案・校閲中の印・編集履歴だけ\n\n" +
      "・本文に保存していない変更があれば、送らずに止まる",
    entries: ["novelai.finishReviewAndReturn"],
  },
  {
    key: "decisions",
    label: "7. 作者の採否を見る",
    icon: "feedback",
    detail:
      "作者が提案を採ったか見送ったかを見る手順\n\n" +
      "・作者が決めると、受け取ったときに届く\n\n" +
      "・選ぶと、本文のその場所を開く",
    entries: [
      {
        command: "novelai.viewAuthorDecisions",
        label: "7. 作者の採否を見る",
        icon: "feedback",
        requiresWork: true,
        detail: "作者が決めた採否（採用・見送り・読まれた）を、新しい順に並べる",
      },
    ],
  },
];

/**
 * 編集者メニューの下に小さく置くもの（作者の指示 2026-11-05 夜「下に小さく『ヘルプ』
 * 『作者モードへ戻る』」）。手順ではないので番号も進み具合の印も付けない
 */
export const EDITOR_MENU_HELP: readonly EditorMenuEntry[] = [
  "novelai.showLog",
  "novelai.exportIssueReport",
  "novelai.showVersion",
];

/** 作者モードへ戻る口（入ったら出られない、を起こさない。`EDITOR_ALLOWED` にもある） */
export const EDITOR_MENU_BACK_COMMAND = "novelai.switchMode";

/*
  **編集者メニューの手順の外の行**（作品・作品を足す・編集を終える・ヘルプ・戻る）の
  コマンドと名前。画面（`views/editorMenu.ts`）と、使い方の答えに添える場所の図
  （`core/menuPath.ts`。設計書6.118）が同じものを引く。画面のファイルは `vscode` を引くので、
  図を組む側（MCP の束からも読む）が読めるよう、ここへ置く。
*/

/** 作品の行を押したときに走るコマンド（作品の切り替え） */
export const EDITOR_WORK_COMMAND = "novelai.chooseEditorWork";

/** 作品の登録を外す（「この作品の編集を終える」）。中身は詳細メニューと同じ命令 */
export const EDITOR_END_WORK_COMMAND = "novelai.removeWork";

/** 参加のリンクを貼る（作品を足す） */
export const EDITOR_JOIN_COMMAND = "novelai.joinAsEditor";

/** 編集者メニューの手順の外の行の名前（画面の字そのもの） */
export const EDITOR_MENU_LABELS = {
  /** 作品をまだ選んでいないときの作品の行（選ぶと「作品：題名」になる） */
  work: "作品を選ぶ",
  endWork: "この作品の編集を終える",
  /** 参加している作品があるときの足す行 */
  addWork: "作品を足す（参加のリンクを貼る）",
  /** 参加している作品がまだ無いときに一番上に出る行 */
  join: "参加のリンクを貼る",
  help: "ヘルプ",
  back: "作者モードへ戻る",
} as const;

/**
 * 編集者メニューの手順の行の名前（「6. 校閲を終えて作者へ返す」など）。
 *
 * 知らせの文で手順を名指すときはここから引く。文に書き写すと、手順の名前や番号を
 * 変えた日に文だけが古くなる（`syncEntryNames.ts` と同じ考え）
 */
export function editorStepLabel(key: EditorStepKey): string {
  const def = EDITOR_STEP_DEFS.find((one) => one.key === key);
  if (!def) throw new Error(`編集者メニューに手順 ${key} がありません`);
  return def.label;
}

/** 編集者メニューが参照しているコマンドID（テストで実在と許可を確かめる） */
export const EDITOR_STEP_REFERENCED_COMMANDS: readonly string[] = [
  ...EDITOR_STEP_DEFS.flatMap((def) => def.entries),
  ...EDITOR_MENU_HELP,
].map((entry) => (typeof entry === "string" ? entry : entry.command))
  .concat(EDITOR_MENU_BACK_COMMAND);

/** 定義が参照しているコマンドIDをすべて挙げる（テストで実在を確かめる） */
function referencedCommands(defs: readonly StepDef[]): string[] {
  const commands: string[] = [];
  for (const def of defs) {
    for (const entry of def.entries) {
      if (typeof entry === "string") {
        commands.push(entry);
      } else if (entry.kind === "section") {
        commands.push(...entry.commands);
      }
    }
  }
  return commands;
}

/** 簡単ステップメニューが参照しているコマンドID */
export const STEP_REFERENCED_COMMANDS: readonly string[] =
  referencedCommands(STEP_DEFS);
