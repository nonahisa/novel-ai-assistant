import * as vscode from "vscode";
import type { WorkRegistry } from "../core/workRegistry";

/**
 * 操作メニュー。
 *
 * コマンドパレットからしか呼べない操作は、名前を知らないと探せないため、
 * 作者は存在に気づけない。かといって右クリックメニューに全部載せると
 * 項目が増えて選びにくくなる。そこで、押せる操作の一覧として独立したビューに出す。
 *
 * **3階層にする（分類 → 小分類 → 操作）。** 操作が34件になり、2階層では
 * 1つの分類に10項目以上が並んでしまう。作者が「何をしたいか」から辿れるよう、
 * 機能の実装単位ではなく**作業の目的**で分ける（設計書6.17）。
 */

/** 件数を出す種類。何の件数かで出し分ける */
export type ActionCounter = "pendingUpdates" | "staleImeDictionary";

export interface ActionItem {
  kind: "action";
  /** 実行するコマンドID */
  command: string;
  label: string;
  /** 一覧で label の右に薄字で出る補足 */
  description?: string;
  /** codicon の名前 */
  icon: string;
  /** 押したときに作品を必要とする操作か */
  requiresWork: boolean;
  /** ホバーで出す説明。何が起きるかを1文で伝える */
  detail: string;
  /**
   * AIを呼ぶ操作か。末尾に「AI」の印を出す。
   *
   * クラウドのAIは実行のたびに課金される。押す前に見分けられないと、
   * 作者は料金の発生する操作を知らずに押すことになる。
   */
  usesAI?: boolean;
  /** 末尾に件数を出す。0件のときは出さない */
  counter?: ActionCounter;
}

export interface ActionSection {
  kind: "section";
  label: string;
  icon: string;
  items: ActionItem[];
  /**
   * 末尾に件数を出す。0件のときは出さない。
   *
   * **分類と操作の両方に出していても、その間の小分類に出さないと
   * 意味がない。** 分類（資料管理）を開いた作者に見えるのは小分類の
   * 行だけで、そこに印が無いと、どれを開けば件数の元があるのか分からない
   * （実機で発覚、2026-08-14）。
   */
  counter?: ActionCounter;
}

export interface ActionGroup {
  kind: "group";
  label: string;
  icon: string;
  entries: Array<ActionItem | ActionSection>;
  /** 分類を閉じたままでも気づけるよう、中身の件数をここにも出す */
  counter?: ActionCounter;
}

/**
 * 操作メニューの中身。**この配列が画面の順序そのもの**である。
 *
 * 「AIを使う」ものには usesAI を立てる。文言ではなく印で示すのは、
 * 一覧を眺めたときに料金の発生する操作だけが浮き上がるようにするため。
 */
export const ACTION_TREE: readonly ActionGroup[] = [
  {
    kind: "group",
    label: "執筆データ",
    icon: "graph",
    entries: [
      {
        kind: "action",
        command: "novelai.showWritingStats",
        label: "執筆統計を表示",
        icon: "graph-line",
        requiresWork: true,
        detail:
          "日次・週次・月次・年次の執筆量をグラフで見ます。" +
          "目標を設定していれば達成率も出ます。" +
          "話ごとの文字数一覧（長さの偏り）も同じ画面で見られます。",
      },
      {
        kind: "action",
        command: "novelai.showAllWorksWritingStats",
        label: "全作品の執筆統計を表示",
        icon: "graph-scatter",
        requiresWork: true,
        detail:
          "登録している全作品を合わせた執筆量を見ます。" +
          "目標（1日・1月）は作品を問わず共有なので、達成率はこちらが正確です。",
      },
      {
        kind: "action",
        command: "novelai.showWorkStats",
        label: "作品の文字数を表示",
        icon: "symbol-numeric",
        requiresWork: true,
        detail: "文字数と原稿用紙の枚数を作品全体で集計します。",
      },
    ],
  },

  {
    kind: "group",
    label: "作品管理",
    icon: "repo",
    entries: [
      {
        kind: "section",
        label: "GitHubで作品管理",
        icon: "github",
        items: [
          {
            kind: "action",
            command: "novelai.gitSync",
            label: "同期",
            icon: "sync",
            requiresWork: true,
            detail:
              "別の環境の変更が未取得か、この環境の変更が未送信かを確認します。" +
              "取り込みと送信もここから行えます。",
          },
          {
            kind: "action",
            command: "novelai.resolveConflicts",
            label: "競合解決",
            icon: "git-merge",
            requiresWork: true,
            detail:
              "同じ話を2つの環境で書いてしまったとき、両方を並べて見比べ、" +
              "どちらを残すかを選びます。迷ったら両方残せます。",
          },
          {
            kind: "action",
            command: "novelai.gitRestore",
            label: "復元",
            icon: "history",
            requiresWork: true,
            detail:
              "GitHubに送った過去の版から、原稿を今の場所へ戻します。" +
              "戻す前に今の内容を退避するので、やり直せます。",
          },
        ],
      },
      {
        kind: "section",
        label: "新作開始",
        icon: "new-folder",
        items: [
          {
            kind: "action",
            command: "novelai.createWorkWithPlot",
            label: "プロットから開始",
            icon: "list-tree",
            requiresWork: false,
            detail:
              "作品フォルダーを作り、設定/plot.md に" +
              "ログライン・テーマ・世界観・あらすじの見出しを用意して開きます。",
          },
          {
            kind: "action",
            command: "novelai.createWorkFromManuscript",
            label: "本文から開始",
            icon: "edit",
            requiresWork: false,
            detail:
              "作品フォルダーを作り、第1話のファイルを作って開きます。" +
              "プロットは作りません（あとから「プロットをつくる」で足せます）。",
          },
        ],
      },
      {
        kind: "section",
        label: "既存作追加",
        icon: "folder-opened",
        items: [
          {
            kind: "action",
            command: "novelai.addWork",
            label: "フォルダから追加",
            icon: "folder-opened",
            requiresWork: false,
            detail:
              "すでに原稿があるフォルダーを作品として登録します。" +
              "投稿サイトからダウンロードしたファイルを入れたフォルダーでも構いません。",
          },
          {
            kind: "action",
            command: "novelai.addWorkFromGithub",
            label: "GitHubから追加",
            icon: "cloud-download",
            requiresWork: false,
            detail:
              "別の環境で書いている作品を、GitHubから取り寄せて登録します。" +
              "新しいPCで続きを書き始めるときに使います。",
          },
        ],
      },
    ],
  },

  {
    kind: "group",
    label: "執筆AI支援",
    icon: "sparkle",
    // IME辞書が古いままだと、抽出した語が変換に出ない。
    // 閉じたままでも気づけるよう、分類にも出す（6.17.1）
    counter: "staleImeDictionary",
    entries: [
      {
        kind: "action",
        command: "novelai.openChat",
        label: "AIに相談する",
        icon: "comment-discussion",
        // 作品のファイルを開いていないと材料が無く、
        // 「作品のファイルを開いてください」としか答えられない
        requiresWork: true,
        usesAI: true,
        detail:
          "いま開いているファイルについて、日本語で相談できます。" +
          "本文でもプロットでも設定資料でも構いません。" +
          "**範囲を選んでから聞くと、そこについての相談として扱います。**" +
          "返事には次の一手の選択肢が付き、押すだけで話を進められます。" +
          "プロット・紹介文・各話あらすじは、内容を確かめてボタンを押すと書き込めます" +
          "（**押すまで何も書き換わりません。小説の本文は対象外です**）。",
      },
      {
        kind: "action",
        command: "novelai.createPlot",
        label: "プロットをつくる",
        icon: "list-tree",
        requiresWork: true,
        detail:
          "設定/plot.md を開きます。まだ無ければ、ログライン・テーマ・世界観・" +
          "あらすじなどの見出しを用意して作ります。" +
          "書きかけのプロットがあれば、そのまま開くだけです。",
      },
      {
        kind: "action",
        command: "novelai.generatePlot",
        label: "本文からプロットを起こす",
        icon: "sparkle",
        requiresWork: true,
        usesAI: true,
        detail:
          "既に書いた本文から、ログライン・テーマ・世界観・あらすじなどを" +
          "組み立て直して プロットへ書き込みます。" +
          "**作者が既に書いた項目は、確認せずに書き換えません**（空の項目だけ埋め、" +
          "書かれている項目は置き換えるかを選べます）。" +
          "各話あらすじを材料にするため、先にあらすじを作っておいてください。",
      },
      {
        kind: "section",
        label: "校正・校閲",
        icon: "search-fuzzy",
        items: [
          {
            kind: "action",
            command: "novelai.checkTypos",
            label: "誤字脱字を検知",
            icon: "search-fuzzy",
            requiresWork: true,
            usesAI: true,
            detail:
              "誤変換・脱字・衍字など、明らかな入力ミスだけをAIで検知します。" +
              "指摘は下段の「AI指摘」パネルに出て、内容を確認してから" +
              "1件ずつ適用・無視を選べます。自動では書き換えません。",
          },
          {
            kind: "action",
            command: "novelai.checkNotation",
            label: "表記ゆれを検知",
            icon: "symbol-text",
            requiresWork: true,
            detail:
              "「良い／よい」のように、同じ語が2通りの書き方で使われている箇所を" +
              "作品全体から探します。どちらに揃えるかは組ごとに作者が選びます。" +
              "AIは使いません。",
          },
        ],
      },
      {
        kind: "section",
        label: "広報支援",
        icon: "megaphone",
        items: [
          {
            kind: "action",
            command: "novelai.generateCatchphrases",
            label: "キャッチコピー案を作る",
            icon: "megaphone",
            requiresWork: true,
            usesAI: true,
            detail:
              "方向性の違う3案（謎・引き型／感情・関係性型／世界観・スケール型）を" +
              "30字以内で出します。選ぶ・手直しする・別の案を出す、から選べます。" +
              "採用しなかった案は覚えておき、次は違う案を出します。",
          },
          {
            kind: "action",
            command: "novelai.generateWorkBlurb",
            label: "作品紹介文を生成",
            icon: "book",
            requiresWork: true,
            usesAI: true,
            detail:
              "プロット・冒頭の本文・各話あらすじから、投稿サイトに載せる紹介文" +
              "（300〜400字）の案を作ります。見てから採用を決められます。",
          },
          {
            kind: "action",
            command: "novelai.generateSynopses",
            label: "各話あらすじを生成",
            icon: "list-ordered",
            requiresWork: true,
            usesAI: true,
            detail:
              "話ごとに150字以内のあらすじを作ります。" +
              "ファイル名が数字だけの話には、15字以内のサブタイトル案も出します。" +
              "本文を変えていない話は作り直しません。",
          },
        ],
      },
      {
        kind: "section",
        label: "その他支援",
        icon: "export",
        // 分類と操作の両方に出しても、その間の小分類に無いと辿れない（6.17.1）
        counter: "staleImeDictionary",
        items: [
          {
            kind: "action",
            command: "novelai.generateSettingsDocs",
            label: "設定資料集を出力",
            description: "AIを使わない",
            icon: "export",
            requiresWork: true,
            detail:
              "抽出済みのJSONから、読むための設定資料集を種別ごとに書き出します" +
              "（人物・場所・能力・組織・世界観・各話あらすじ）。" +
              "JSONを手直ししたあとや、まとめ・更新の反映後に使います。AIは呼びません。",
          },
          {
            kind: "action",
            command: "novelai.exportImeDictionary",
            label: "IME辞書を出力",
            description: "AIを使わない",
            icon: "symbol-keyword",
            requiresWork: true,
            // 書き出したあと取り込むのは作者の手作業で、自動化する手段が
            // どのIMEにも無い（6.13.5）。設定資料を増やしても書き出し直すまで
            // 変換に出ないので、古くなったことを知らせる
            counter: "staleImeDictionary",
            detail:
              "登場人物・場所・能力・組織と、作品の造語を、" +
              "IMEのユーザー辞書に取り込める形で書き出します。" +
              "取り込むと、変換候補に作品の固有名詞が出るようになります。",
          },
        ],
      },
    ],
  },

  {
    kind: "group",
    label: "資料管理",
    icon: "library",
    // 承認待ちの更新は、分類を開かないと気づけない。閉じたままでも見えるようにする
    counter: "pendingUpdates",
    entries: [
      {
        kind: "section",
        label: "資料抽出",
        icon: "wand",
        // 「更新分を反映」がこの中にある。分類を開いた作者が、
        // どの小分類を開けばよいか印だけで辿れるようにする
        counter: "pendingUpdates",
        items: [
          {
            kind: "action",
            command: "novelai.extractSettings",
            label: "まとめて抽出",
            icon: "sparkle",
            requiresWork: true,
            usesAI: true,
            detail:
              "本文をAIで読み、登場人物・場所・スキル・組織・世界観を" +
              "まとめて取り出して保存します。続けて設定資料集も作ります。" +
              "種別ごとに実行するより一度で済むので、最初はこれを使ってください。",
          },
          // 種別ごとの抽出。AIへの問い合わせは絞らない（1回の応答に全種別が
          // 入っている）が、応答はチャンク単位でキャッシュされるため、
          // 2種類目からはAIを呼ばずに保存だけを行う。料金も待ち時間も増えない
          {
            kind: "action",
            command: "novelai.extractCharactersOnly",
            label: "人物を抽出",
            icon: "person",
            requiresWork: true,
            usesAI: true,
            detail:
              "本文をAIで読み、登場人物だけを取り出して保存します。" +
              "既にいる人物への変更は、その場では書き換えず「更新分を反映」へ回します。" +
              "「まとめて抽出」を済ませていれば、AIは呼び直されません。",
          },
          {
            kind: "action",
            command: "novelai.extractLocationsOnly",
            label: "場所を抽出",
            icon: "location",
            requiresWork: true,
            usesAI: true,
            detail:
              "本文をAIで読み、場所だけを取り出して保存します。" +
              "「まとめて抽出」を済ませていれば、AIは呼び直されません。",
          },
          {
            kind: "action",
            command: "novelai.extractAbilitiesOnly",
            label: "スキルを抽出",
            icon: "zap",
            requiresWork: true,
            usesAI: true,
            detail:
              "本文をAIで読み、能力（スキル・魔法など、作品での呼び方に合わせます）" +
              "だけを取り出して保存します。" +
              "「まとめて抽出」を済ませていれば、AIは呼び直されません。",
          },
          {
            kind: "action",
            command: "novelai.extractOrganizationsOnly",
            label: "組織を抽出",
            icon: "organization",
            requiresWork: true,
            usesAI: true,
            detail:
              "本文をAIで読み、組織だけを取り出して保存します。" +
              "人物の所属からも組織を拾います。" +
              "「まとめて抽出」を済ませていれば、AIは呼び直されません。",
          },
          {
            kind: "action",
            command: "novelai.extractWorldOnly",
            label: "世界観を抽出",
            icon: "globe",
            requiresWork: true,
            usesAI: true,
            detail:
              "本文をAIで読み、世界観だけを取り出して保存します。" +
              "「まとめて抽出」を済ませていれば、AIは呼び直されません。",
          },
          {
            kind: "action",
            command: "novelai.unifyCharacters",
            label: "重複をまとめる",
            icon: "merge",
            requiresWork: true,
            detail:
              "「リン」と「リンセップ・アウクト」のように、" +
              "同じ人物が別々に登録されてしまった組をまとめます。" +
              "どちらの名前を残すかは作者が選びます。",
          },
          {
            kind: "action",
            command: "novelai.manageCustomFields",
            label: "一覧に項目を増やす",
            icon: "list-selection",
            requiresWork: true,
            detail:
              "「誕生日」「身長」のように、作品に必要な項目を人物設定へ足します。" +
              "足した項目は全員の設定資料に並びます。外しても入力済みの内容は消えません。",
          },
          {
            kind: "action",
            command: "novelai.applyPendingUpdates",
            label: "更新分を反映",
            description: "承認制",
            icon: "check-all",
            requiresWork: true,
            counter: "pendingUpdates",
            detail:
              "抽出で見つかった既存人物への更新を、内容を確認してから反映します。" +
              "確認せずに書き換えることはありません。",
          },
        ],
      },
      {
        kind: "section",
        label: "設定資料閲覧",
        icon: "book",
        items: [
          {
            kind: "action",
            command: "novelai.openSettingsPanel",
            label: "設定資料集を閲覧",
            icon: "book",
            requiresWork: true,
            detail:
              "抽出した登場人物・能力・場所・組織・世界観を一覧で見ます。" +
              "その場で書き換えたり、AIに項目を埋めさせたり、相談したりできます。",
          },
          {
            kind: "action",
            command: "novelai.openSynopsisDocs",
            label: "紹介文・あらすじを閲覧",
            icon: "preview",
            requiresWork: true,
            detail:
              "作品紹介文（synopsis.md）と各話あらすじ（synopses.md）を" +
              "プレビューで開きます。まだ無ければ、作る操作を案内します。",
          },
        ],
      },
    ],
  },

  {
    kind: "group",
    label: "拡張機能の設定",
    icon: "settings-gear",
    entries: [
      {
        kind: "action",
        command: "novelai.openExtensionSettings",
        label: "設定管理を開く",
        icon: "settings",
        requiresWork: false,
        detail:
          "文字数の数え方、執筆目標、AIの応答待ち時間などの設定を開きます。" +
          "この拡張機能の設定だけを絞り込んで表示します。",
      },
      {
        kind: "section",
        label: "AI",
        icon: "hubot",
        items: [
          {
            kind: "action",
            command: "novelai.setupAI",
            label: "AI設定",
            icon: "settings-gear",
            requiresWork: false,
            detail:
              "使用するAI（Ollama・Gemini・ChatGPT・Claude）とモデルを選びます。",
          },
          {
            kind: "action",
            command: "novelai.testAI",
            label: "AI接続の確認",
            icon: "plug",
            requiresWork: false,
            detail:
              "設定したAIに接続できるかを確かめます。" +
              "抽出が失敗するときは、まずここを見てください。",
          },
          {
            kind: "action",
            command: "novelai.selectOllamaExecutable",
            label: "Ollamaの実行ファイル位置を指定",
            icon: "folder-opened",
            requiresWork: false,
            detail:
              "Ollamaを自動で見つけられない場合に、ollama.exe の場所を指定します。",
          },
        ],
      },
      {
        kind: "section",
        label: "セットアップを開始",
        icon: "rocket",
        items: [
          {
            kind: "action",
            command: "novelai.setupOllama",
            label: "Ollamaのセットアップ",
            icon: "cloud-download",
            requiresWork: false,
            detail:
              "無料でオフラインでも使えるOllamaを、導入から使える状態まで案内します。" +
              "入っているか・起動しているか・モデルがあるかを順に確かめ、" +
              "足りないものだけを案内します。",
          },
          {
            kind: "action",
            command: "novelai.setupGithub",
            label: "GitHubのセットアップ",
            icon: "github",
            requiresWork: true,
            detail:
              "作品をGitHubで同期できるようにします。" +
              "リポジトリの作成から最初の送信までを順に案内します。" +
              "**新しく作るリポジトリは非公開に固定します。**",
          },
        ],
      },
      {
        kind: "section",
        label: "相談で使う検索",
        icon: "search-fuzzy",
        items: [
          {
            kind: "action",
            command: "novelai.setupVectorSearch",
            label: "意味検索（ベクトルDB）の準備",
            icon: "search-fuzzy",
            requiresWork: false,
            detail:
              "相談のときに、質問に近い場面を本文・設定資料・あらすじから探して渡します。" +
              "**入れなくても、質問を使って探すようになります**（語句一致）。" +
              "入れると言い換えでの質問にも当たりやすくなりますが、" +
              "モデルの取得（約1.2GB）と作品ごとの索引づくりが要ります。" +
              "非力な機械では入れないままで構いません。",
          },
          {
            kind: "action",
            command: "novelai.buildVectorIndex",
            label: "検索用の索引を作る・更新する",
            icon: "database",
            requiresWork: true,
            detail:
              "作品の本文・設定資料・あらすじから索引を作ります。" +
              "**変わっていない場面は作り直しません。** " +
              "手元のOllamaで行うので料金はかかりません。",
          },
          {
            kind: "action",
            command: "novelai.clearVectorIndex",
            label: "検索用の索引を削除する",
            icon: "trash",
            requiresWork: true,
            detail:
              "索引を消して置き場所を空けます。消しても本文・設定資料は変わりません。",
          },
        ],
      },
    ],
  },

  {
    kind: "group",
    label: "ヘルプ",
    icon: "question",
    entries: [
      {
        kind: "action",
        command: "novelai.showLog",
        label: "ログを開く",
        icon: "output",
        requiresWork: false,
        detail:
          "AIが返したエラーの詳細を記録しています。" +
          "抽出が失敗して理由が分からないときに開いてください。",
      },
    ],
  },
];

// 「設定情報を表示」（novelai.showSettingsForTerm）はここに置かない。
// 本文にカーソルを置いた状態で実行する操作なので、操作メニューから押しても
// 対象が定まらず動かない。本文の右クリックメニューにだけ出す。
// 取り込み（gitPull）と送信（gitPush）も置かない。「同期」の中から選べる。

/**
 * 表示する分類を選ぶ。
 *
 * 作品が1つも登録されていないと、作品を要する操作は押しても
 * 「作品が登録されていません」と言われるだけなので出さない。
 * 押せないボタンを並べても、作者には理由が分からない。
 * 中身が空になった小分類・分類も出さない。
 */
export function visibleGroups(hasWork: boolean): ActionGroup[] {
  return ACTION_TREE.map((group) => ({
    ...group,
    entries: group.entries
      .map((entry) =>
        entry.kind === "section"
          ? { ...entry, items: entry.items.filter((item) => hasWork || !item.requiresWork) }
          : entry
      )
      .filter((entry) =>
        entry.kind === "section"
          ? entry.items.length > 0
          : hasWork || !entry.requiresWork
      ),
  })).filter((group) => group.entries.length > 0);
}

/** 木の中の操作をすべて取り出す（テストと整合性の確認用） */
export function allActions(): ActionItem[] {
  return ACTION_TREE.flatMap((group) =>
    group.entries.flatMap((entry) =>
      entry.kind === "section" ? entry.items : [entry]
    )
  );
}

/** ツリーの節点 */
export type ActionNode =
  | { type: "group"; group: ActionGroup }
  | { type: "section"; section: ActionSection; groupLabel: string }
  | { type: "action"; item: ActionItem };

/** 開閉状態を覚えるための鍵。分類は名前、小分類は「分類/小分類」 */
export function nodeKey(node: ActionNode): string {
  if (node.type === "group") return node.group.label;
  if (node.type === "section") return `${node.groupLabel}/${node.section.label}`;
  return node.item.command;
}

/**
 * 開閉状態の保存先。
 *
 * VS Code の globalState をそのまま受け取らず細い口にするのは、
 * この判断をテストできるようにするため。
 */
export interface GroupStateStore {
  get(): string[];
  set(groups: string[]): void;
}

/** 保存された値のうち、いまも存在する分類・小分類だけを残す */
export function restoreExpandedGroups(saved: string[]): Set<string> {
  const known = new Set<string>();
  for (const group of ACTION_TREE) {
    known.add(group.label);
    for (const entry of group.entries) {
      if (entry.kind === "section") known.add(`${group.label}/${entry.label}`);
    }
  }
  // 分類名を変えたり減らしたりしたときに、古い名前が残らないようにする
  return new Set(saved.filter((key) => known.has(key)));
}

/** 件数を答える口。ツリーが数え方そのものに依存しないよう関数で受け取る */
export type ActionCounts = (counter: ActionCounter) => number;

export class ActionListProvider implements vscode.TreeDataProvider<ActionNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    ActionNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /**
   * 開いている分類・小分類。
   *
   * **既定はすべて閉じる。** 全部開くと40項目近くが縦に並び、
   * 作品一覧の場所が押し出される。分類名を読んでから開くほうが探しやすい。
   * 一度開いた状態は次回に引き継ぐ（`setExpanded`）。
   */
  private readonly expanded: Set<string>;

  constructor(
    private readonly registry: WorkRegistry,
    private readonly store?: GroupStateStore,
    private readonly counts?: ActionCounts
  ) {
    this.expanded = restoreExpandedGroups(store?.get() ?? []);
    // 最初の作品を登録した時点で、作品向けの操作を出せるようになる
    registry.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  /** 画面で開閉したときに呼ぶ。次回起動時もこの状態で開く */
  setExpanded(key: string, open: boolean): void {
    if (open) {
      this.expanded.add(key);
    } else {
      this.expanded.delete(key);
    }
    this.store?.set([...this.expanded]);
  }

  /** テストと復元の確認用 */
  expandedGroups(): string[] {
    return [...this.expanded];
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: ActionNode): vscode.TreeItem {
    if (node.type === "group" || node.type === "section") {
      const key = nodeKey(node);
      const label = node.type === "group" ? node.group.label : node.section.label;
      const icon = node.type === "group" ? node.group.icon : node.section.icon;
      const item = new vscode.TreeItem(
        label,
        this.expanded.has(key)
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
      );
      item.contextValue = node.type === "group" ? "actionGroup" : "actionSection";
      item.iconPath = new vscode.ThemeIcon(icon);
      // 件数の印（FileDecorationProvider）を出すための目印
      item.resourceUri = actionResourceUri(node);
      return item;
    }

    const { item: action } = node;
    const item = new vscode.TreeItem(
      action.label,
      vscode.TreeItemCollapsibleState.None
    );
    item.description = action.description ?? "";
    item.iconPath = new vscode.ThemeIcon(action.icon);
    item.tooltip = new vscode.MarkdownString(
      [
        action.usesAI ? "**AIを使います**（クラウドのAIは実行のたびに課金されます）\n" : "",
        action.detail,
        this.countOf(action.counter) > 0
          ? `\n\n未反映: ${this.countOf(action.counter)} 件`
          : "",
      ].join("")
    );
    // 「AI」と件数の印を出すための目印
    item.resourceUri = actionResourceUri(node);
    // 引数を渡さないので、作品が複数あれば実行時に選択を求められる
    item.command = { command: action.command, title: action.label };
    return item;
  }

  private countOf(counter: ActionCounter | undefined): number {
    return counter && this.counts ? this.counts(counter) : 0;
  }

  getChildren(node?: ActionNode): ActionNode[] {
    const hasWork = this.registry.list().length > 0;
    const groups = visibleGroups(hasWork);

    if (!node) {
      return groups.map((group) => ({ type: "group" as const, group }));
    }
    if (node.type === "group") {
      return node.group.entries.map((entry) =>
        entry.kind === "section"
          ? {
              type: "section" as const,
              section: entry,
              groupLabel: node.group.label,
            }
          : { type: "action" as const, item: entry }
      );
    }
    if (node.type === "section") {
      return node.section.items.map((item) => ({
        type: "action" as const,
        item,
      }));
    }
    return [];
  }
}

/** 印を付けるための架空のURI。実在するファイルは指さない */
export const ACTION_SCHEME = "novelai-action";

export function actionResourceUri(node: ActionNode): vscode.Uri {
  return vscode.Uri.from({
    scheme: ACTION_SCHEME,
    // パスにそのまま入れると、日本語や記号でURIが壊れる
    path: `/${encodeURIComponent(nodeKey(node))}`,
  });
}

/** URIから元の鍵へ戻す */
export function actionKeyFromUri(uri: vscode.Uri): string | undefined {
  if (uri.scheme !== ACTION_SCHEME) return undefined;
  try {
    return decodeURIComponent(uri.path.replace(/^\//, ""));
  } catch {
    return undefined;
  }
}
