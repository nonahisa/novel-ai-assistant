import * as vscode from "vscode";
import type { WorkRegistry } from "../core/workRegistry";
import {
  describeBlocked,
  EDITOR_BLOCKED_HINT,
  isCommandAllowed,
  type WorkMode,
} from "../core/editorMode";
import { currentMode } from "../core/actorContext";
import {
  describeProcessesBlocked,
  isCommandAvailableInRuntime,
  PROCESSES_BLOCKED_HINT,
} from "../core/processAvailability";
import { canRunProcesses } from "../core/runtime";
import { buildPendingCheckGroup } from "./pendingCheckMenu";
import { PENDING_CHECKS } from "./pendingChecks";

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
export type ActionCounter =
  | "pendingUpdates"
  | "staleImeDictionary"
  /** 同一人物とみられる組の数。まとめないと資料が二重になる */
  | "mergeCandidates";

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
  /**
   * ブラウザ版のVS Codeでだけ出す操作か。
   *
   * **この作品の原則は「消さずに押せなくして理由を出す」である**
   * （`processAvailability.ts`、編集者モード）。ここはその例外にあたる。
   *
   * 押せなくする理由は「この環境では動かない」だが、こちらは逆で、
   * **手元のVS Codeでも動く。ただし出番が無い**。動くものを灰色で並べても
   * 「なぜ押せないのか」を説明できず、メニューが1行ぶん長くなるだけである。
   *
   * **コマンドは登録したままにする。** 手元で必要になったとき
   * （「登録したのに一覧が空」の切り分けなど）は、コマンドパレットから呼べる。
   */
  browserOnly?: boolean;
  /**
   * 開発ビルドでだけ出す操作か（実機確認を回す道具）。
   *
   * **配布物には定義ごと入らない。** 本番ビルドでは `__DEV_HELPERS__` が
   * false に畳まれ、この項目を並べている枝ごと落ちる。
   */
  devOnly?: boolean;
  /**
   * 詳細メニューには並べないが、**実体はここに置いたままにする**操作か
   * （設計書6.56.3）。
   *
   * 作者の指示で詳細メニューから外した操作のうち、**簡単ステップメニューは
   * 使い続けるもの**がここに当たる（ルビ・傍点・作者／編集者の切り替え）。
   *
   * **消してしまうと、写しが生まれる。** 簡単ステップメニューはコマンドIDで
   * 参照して、見出しと説明をこの木から引く仕組みである（`stepMenu.ts`）。
   * ここから消すと、あちらが自前の見出しを持つことになり、
   * **2か所を直さないと食い違う**状態へ戻ってしまう。
   *
   * 「消さずに出さない」は、この作品で繰り返し採っている形である
   * （`processAvailability.ts` の「押せなくして理由を出す」、
   * `browserOnly` の「動くが出番が無い」）。
   */
  hiddenFromActionList?: boolean;
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
  /** ホバーで出す説明。組み立てた分類で「ここに出せないもの」を伝えるのに使う */
  tooltip?: string;
  /**
   * 他の分類から機械的に組み立てた分類か（「テスト中」）。
   *
   * **中身は写しである。** 同じコマンドが2か所に並ぶので、
   * 「全操作」を数えるところ（`allActions`）とAIへ渡す機能の一覧では飛ばす。
   * 飛ばさないと、コマンドIDが重複し、AIは同じ機能を2回案内する。
   */
  generated?: boolean;
}

/**
 * 操作メニューの中身。**この配列が画面の順序そのもの**である。
 *
 * 「AIを使う」ものには usesAI を立てる。文言ではなく印で示すのは、
 * 一覧を眺めたときに料金の発生する操作だけが浮き上がるようにするため。
 */
const BASE_ACTION_TREE: readonly ActionGroup[] = [
  {
    kind: "group",
    label: "執筆データ",
    icon: "graph",
    entries: [
      // **全作品を先頭に置く**（作者の指定、2026-08-16）。
      // 目標（1日・1月）は作品を問わず共有する値なので、達成率はこちらが正しい。
      // 作品ごとの画面を先に出すと、他の作品へ書いた分が入らない数字を
      // 先に見ることになる
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
        command: "novelai.showWritingStats",
        label: "執筆統計を表示",
        icon: "graph-line",
        requiresWork: true,
        detail:
          "日次・週次・月次・年次の執筆量をグラフで見ます。" +
          "目標を設定していれば達成率も出ます。" +
          "話ごとの文字数一覧（長さの偏り）も同じ画面で見られます。",
      },
      // 年表は執筆統計の隣に置く。どちらも「書いたものを別の軸で
      //見直す」画面で、AIを呼ばずにその場で出る（設計書6.39）
      {
        kind: "action",
        command: "novelai.openChronicle",
        label: "年表",
        icon: "list-ordered",
        requiresWork: true,
        detail:
          "話数順と時系列順で、話ごとの出来事を並べます。" +
          "登場人物・変化・能力・呼称・伏線・あらすじを1枚にまとめた画面です。" +
          "AIは使いません（材料はすべて既にある記録です）。",
      },
      {
        kind: "action",
        command: "novelai.editTimeline",
        label: "時期・系統を編集する",
        icon: "calendar",
        requiresWork: true,
        detail:
          "作中の時期（「十年前・火事の夜」など）と、本編以外の筋" +
          "（IF編・夢・劇中劇）を作ります。年表を時系列順で並べるのに使います。",
      },
      {
        kind: "action",
        command: "novelai.showEditHistory",
        label: "編集履歴を見る",
        icon: "history",
        requiresWork: true,
        detail:
          "誰が何を直したかを、作者・編集者・AIの3つに色分けして並べます。" +
          "編集部と一緒に書いているとき、相手の直しを見落とさないための画面です。" +
          "この画面から履歴は変えられません。",
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
          // **GitHubへ載せる入口を、ここに置く**（設計書5.7.9）。
          // 以前は「拡張機能の設定 → セットアップを開始」の中にあり、
          // 作者が作品管理の下を探して見つけられなかった（2026-08-22）
          {
            kind: "action",
            command: "novelai.setupGithub",
            label: "GitHubに置く（はじめて）",
            icon: "repo-push",
            requiresWork: true,
            detail:
              "リポジトリの作成から最初の送信までを順に案内します。" +
              "**同じフォルダーに並んでいる作品は、まとめて1つの置き場に入ります**" +
              "（この作品だけを分けることもできます）。" +
              "**新しく作るリポジトリは非公開に固定します。**",
          },
          // **散らばった作品を1つの書庫へ寄せる道**（設計書5.7.10）。
          // すでに作品ごとに分けて置いている作者のための入口で、
          // GitHubへ載せる前に通ることが多いので、その隣に置く
          {
            kind: "action",
            command: "novelai.mergeIntoLibrary",
            label: "作品を書庫にまとめる",
            icon: "library",
            requiresWork: false,
            detail:
              "別々の場所に置いてある作品を、1つの書庫（フォルダー）へ写してまとめます。" +
              "**元のフォルダーは消しません。**" +
              "まとめたあと「GitHubに置く（はじめて）」で、書庫まるごとを1つのリポジトリにできます。",
          },
          // **作品が増えるほど、1つずつ押すのがつらくなる**（設計書5.5.14）。
          // 置き場ごとにまとめて、記録 → 取り込み → 送信をひと息で行う
          {
            kind: "action",
            command: "novelai.syncAllWorks",
            label: "作品をすべて同期",
            icon: "sync",
            requiresWork: false,
            detail:
              "登録しているすべての作品を、まとめて同期します。" +
              "**置き場（リポジトリ）ごとに、記録 → 取り込み → 送信**の順で行います。" +
              "**何が起きるかを一覧で見せてから、1回だけ確認します。**" +
              "1か所が通らなくても、残りは続けます。",
          },
          // 別のPCとこちらの両方で書くと分岐する（設計書5.5.16）。
          // gitが畳めるかを先に調べ、**作者のものが衝突していたら手を引く**
          {
            kind: "action",
            command: "novelai.resolveDivergence",
            label: "分かれた分を合わせる",
            icon: "git-merge",
            requiresWork: false,
            detail:
              "別のPCとこちらの両方で書き進めて**分かれてしまった**ときに使います。" +
              "**同じファイルが両方で書き換えられていないかを先に調べ**、" +
              "書き換えられていなければ、そのまま合わせます。" +
              "**原稿が両方で書き換えられていたときは、合わせずに手を引きます**" +
              "（どちらを残すかは書いたご本人にしか分からないためです）。" +
              "合わせる前に退避の枝を作るので、あとから戻せます。" +
              "**GitHubへの送信はしません。**",
          },
          {
            kind: "action",
            command: "novelai.gitSync",
            label: "同期",
            icon: "sync",
            requiresWork: true,
            detail:
              "別の環境の変更が未取得か、この環境の変更が未送信かを確認します。" +
              "取り込みと送信もここから行えます。" +
              "**同じ置き場に入っている作品は、まとめて取り込み・送信します。**",
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
      {
        kind: "section",
        label: "編集部とやり取り",
        icon: "organization",
        items: [
          {
            kind: "action",
            command: "novelai.shareWithEditor",
            label: "編集部へ渡す",
            icon: "repo-push",
            requiresWork: true,
            detail:
              "この作品だけを入れた非公開リポジトリを作り、本文と設定資料を送ります。" +
              "ほかの作品は渡りません。編集部が書けるのは提案だけで、本文は書き換わりません。",
          },
          {
            kind: "action",
            command: "novelai.collectEditorProposals",
            label: "編集部の提案を取り込む",
            icon: "repo-pull",
            requiresWork: true,
            detail:
              "編集部が書いた提案を取り寄せて、提案パネルへ並べます。" +
              "本文には触りません。採るかどうかは1件ずつ作者が決めます。",
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
        command: "novelai.openChatPanel",
        // **見出しと中身を合わせる**（作者の報告、2026-08-31）。
        // 「AIに相談する」とだけ書いてあったので、押すと本文の領域に
        // 大きく開くことが読めなかった——`package.json` のコマンド名は
        // はじめから「AIに相談する（大きく開く）」で、こちらだけがずれていた
        label: "AIに相談する（大きく開く）",
        icon: "comment-discussion",
        // 作品のファイルを開いていないと材料が無く、
        // 「作品のファイルを開いてください」としか答えられない
        requiresWork: true,
        usesAI: true,
        detail:
          "いま開いているファイルについて、日本語で相談できます。" +
          "**本文の領域に大きく開きます。**" +
          "本文でもプロットでも設定資料でも構いません。" +
          "返事には次の一手の選択肢が付き、押すだけで話を進められます。" +
          "「できること」から、誤字脱字の検知や資料の抽出をその場で始められます。" +
          "会話はMarkdownのメモとして残せます。" +
          "プロット・紹介文・各話あらすじは、内容を確かめてボタンを押すと書き込めます" +
          "（**押すまで何も書き換わりません。小説の本文は対象外です**）。" +
          "**本文の右クリックからは、横の小さいパネルでも聞けます**" +
          "（範囲を選んで聞くときは、そちらのほうが本文が隠れません）。",
      },
      {
        kind: "action",
        command: "novelai.openChat",
        label: "横のパネルへ移動",
        icon: "layout-sidebar-left",
        requiresWork: true,
        usesAI: true,
        // **大きい画面と両方を残す**（作者の指定、2026-08-28）。
        // 範囲を選んで聞くときは本文が見えている必要があり、
        // 大きい画面では隠れてしまう
        //
        // **「開く」ではなく「移動」と書く**（作者の報告、2026-08-31）。
        // このパネルは左に出しっぱなしなので、押しても**もう開いている**
        // ことがほとんどで、「クリックしても動作しません」と見えていた。
        // していることは「そこへ行く」であって「開く」ではない
        detail:
          "同じ相談を、左の細いパネルで行います（**既に開いているときは、" +
          "そこへ移動するだけです**）。" +
          "**範囲を選んでから聞くと、そこについての相談として扱います。**" +
          "本文を見ながら聞きたいときは、こちらを使ってください。" +
          "会話は大きい画面と共通なので、どちらで聞いても続きから話せます。",
      },
      {
        kind: "action",
        command: "novelai.chooseChatWork",
        label: "相談する作品を選ぶ",
        icon: "book",
        requiresWork: true,
        detail:
          "**作品のファイルを開いていないときに**、どの作品について相談するかを決めます。" +
          "ファイルを開いていれば、そちらが優先されます。",
      },
      {
        kind: "action",
        command: "novelai.createPlot",
        label: "プロットをつくる",
        icon: "list-tree",
        requiresWork: true,
        detail:
          "設定/plot.md を開きます。まだ無ければ、書き出しを用意して作ります。" +
          "**見出しも順番も自由に決められます**（決まった欄を埋める形ではありません）。" +
          "書きかけのプロットがあれば、そのまま開くだけです。",
      },
      {
        kind: "action",
        command: "novelai.plotInterview",
        label: "対話でプロットを作る",
        icon: "comment-discussion",
        requiresWork: true,
        usesAI: true,
        detail:
          "まだ書けていない項目を、AIが1つずつ尋ねます。答えを整えて" +
          "プロットへ書く案を出すので、押せば入ります。" +
          "**AIが筋書きを作るのではありません。** 作者の中にあるものを引き出します。" +
          "決まっていない項目は飛ばせます。",
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
              "指摘は下段の「提案」パネルに出て、内容を確認してから" +
              "1件ずつ適用・無視を選べます。自動では書き換えません。",
          },
          {
            kind: "action",
            command: "novelai.manageKeepWords",
            // **誤字脱字検知のすぐ下に置く**（作者の指示、2026-09-01）。
            // 指摘を見て「これは直さなくていい」と思った、その場で足す
            // ものなので、設定として離れた場所に置くと辿り着けない
            label: "指摘対象外を管理",
            icon: "circle-slash",
            requiresWork: true,
            detail:
              "方言・口癖・独自の言い回しを登録すると、誤字脱字と推敲で" +
              "指摘されなくなります。固有名詞は自動で守られますが、" +
              "「はよ」「あらへん」のような話し方は固有名詞ではないので" +
              "ここへ足してください。設定/keep_words.json に控えます。",
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
          {
            kind: "action",
            command: "novelai.checkProofread",
            label: "推敲する",
            icon: "edit",
            requiresWork: true,
            usesAI: true,
            detail:
              "**読みにくい箇所だけ**を指摘します。見るのは6つ" +
              "（冗長な言い回し・同じ語の繰り返し・係り受けの曖昧さ・長すぎる文・" +
              "読みに詰まる漢字・語尾の単調さ）。" +
              "**語彙や文体、描写の増減には触れません。**" +
              "体言止めや短文の連続といった書き方の癖も、直す対象にしません。" +
              "指摘は1000字あたり3件までに絞ります。",
          },
          {
            kind: "action",
            command: "novelai.checkOpening",
            label: "冒頭を診断",
            icon: "telescope",
            requiresWork: true,
            usesAI: true,
            detail:
              "**第1話の冒頭（約3,000字）だけ**を見て、" +
              "いつ・どこで・誰が・何を・なぜ・どのように、が読者に伝わるかと、" +
              "続きを読みたくなる引きがあるかを診断します。" +
              "WEB小説は冒頭で読み続けるかが決まります。本文は書き換えません。",
          },
          {
            kind: "action",
            command: "novelai.checkDeviations",
            label: "プロットからの逸脱を検知",
            icon: "compass",
            requiresWork: true,
            usesAI: true,
            detail:
              "書いたプロットと本文を照らし合わせ、**プロットに無い展開**や" +
              "**物語が前へ進んでいない箇所**を探します。" +
              "**本文は書き換えません。プロットのほうが古いこともあります。**" +
              "先にプロットを書いておいてください（「プロットをつくる」または" +
              "「本文からプロットを起こす」）。" +
              "**伏線や人物の掘り下げは逸脱として扱いません。**",
          },
          {
            kind: "action",
            command: "novelai.checkContradictions",
            label: "矛盾を検知",
            icon: "warning",
            requiresWork: true,
            usesAI: true,
            detail:
              "設定資料と本文が食い違っている箇所を探します。" +
              "**本文は書き換えません。**「設定ではこう／本文ではこう」を並べるだけで、" +
              "どちらを直すかは作者が決めます（**設定側が古いこともあります**）。" +
              "先に設定資料を抽出しておいてください。照らし合わせる相手が無いと、" +
              "AIは本文だけを見て矛盾を作り出します。",
          },
          // 伏線は矛盾の隣に置く（設計書6.35.4）。矛盾検知の指摘から
          // 「伏線として登録」で飛んでくるので、行き先が近いほうが辿れる
          {
            kind: "action",
            command: "novelai.checkForeshadows",
            label: "伏線を検知する",
            icon: "eye",
            requiresWork: true,
            usesAI: true,
            detail:
              "後の展開を予告・示唆している記述（謎めいた言及・意味ありげな小道具・" +
              "説明されない違和感）をAIで探します。" +
              "**台帳へは何も自動で入りません。**候補は下段の「提案」パネルに" +
              "「伏線の候補」として並び、**登録するものを1件ずつ選びます。**" +
              "既に登録済みの伏線と重なる候補は出しません。",
          },
          {
            kind: "action",
            command: "novelai.checkForeshadowResolution",
            label: "伏線の回収を確かめる",
            icon: "check-all",
            requiresWork: true,
            usesAI: true,
            detail:
              "未回収の伏線が、その後の話で回収されたかをAIで見ます。" +
              "**回収済みの印も提案です。**「提案」パネルの「伏線の回収」で" +
              "1件ずつ確かめて決めてください（誤って回収済みになると、" +
              "安心して回収を忘れます）。未回収が無ければAIは呼びません。",
          },
          {
            kind: "action",
            command: "novelai.openForeshadows",
            label: "伏線の一覧を開く",
            icon: "list-unordered",
            requiresWork: true,
            detail:
              "登録した伏線を、**未回収のものを上にして**一覧にします。" +
              "「第◯話で張った」「第◯話で回収」と引用が並びます。" +
              "**AIは使いません。**",
          },
          {
            kind: "action",
            command: "novelai.addForeshadow",
            label: "伏線を手で追加",
            icon: "add",
            requiresWork: true,
            detail:
              "短い名・何を示唆しているか・張った話数を入れて、伏線を登録します。" +
              "話数が分からなければ空のままで構いません。**AIは使いません。**",
          },
          {
            kind: "action",
            command: "novelai.setForeshadowStatus",
            label: "伏線の状態を変える",
            icon: "checklist",
            requiresWork: true,
            detail:
              "伏線を「回収済み」「意図して開けたまま」「未回収」に変えます。" +
              "**「意図して開けたまま」はここからしか選べません**——" +
              "回収を忘れたのか、開けたままにすると決めたのかは、" +
              "作者にしか決められないためです。**AIは使いません。**",
          },
          // **編集部とのやり取りは、いちばん下に置く**（作者の指示、2026-08-22）。
          // 上に並ぶのは作者が1人で回す作業で、こちらは相手のいる作業である。
          // 毎日通るのは上のほうなので、下に置いても埋もれない
          {
            kind: "action",
            command: "novelai.toggleReviewLock",
            label: "校閲を始める／終える",
            icon: "lock",
            requiresWork: true,
            detail:
              "いま開いているファイルを「校閲中」として押さえます。" +
              "作者側でそのファイルを直そうとすると、誰がいつから見ているかが出ます。" +
              "**ファイル単位です**ので、他の話は今までどおり書けます。" +
              "終わったらもう一度押して外してください。",
          },
          {
            kind: "action",
            command: "novelai.reviewProposals",
            label: "編集部からの提案を見る",
            icon: "inbox",
            requiresWork: true,
            detail:
              "編集部が出した直しの提案を、1件ずつ確認して採るか見送るかを決めます。" +
              "**編集部は本文を書き換えません。** 届くのは提案だけで、" +
              "本文に入るのはあなたが採ると決めたものだけです。",
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
            command: "novelai.generateAnnouncement",
            label: "更新告知文を作る",
            icon: "megaphone",
            requiresWork: true,
            usesAI: true,
            detail:
              "話を選ぶと、その本文からネタバレしない告知文をX用・活動報告用・" +
              "後書き用の3種作ります。ハッシュタグとURLは設定から付け、" +
              "貼るのは作者です（投稿サイトへは書き込みません）。",
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
          // **書き始めの2つを先頭に置く**（設計書6.36.4）。ここは
          // 「最新話を書く」への導線（縦書きで開く）と同じ小分類で、
          // 資料生成や新作開始の並びではない——どちらも、
          // **今日の続きを書き始めるとき**に通る操作である
          {
            kind: "action",
            command: "novelai.resumeWriting",
            label: "執筆を再開する",
            description: "AIを使わない",
            icon: "debug-continue",
            requiresWork: true,
            detail:
              "前回どこまで書いたか・前話までのあらすじ・未回収の伏線・単話プロットを1枚にまとめて開きます。" +
              "**AIは呼びません。** 押した瞬間に出ます。**原稿は書き換えません。**",
          },
          {
            kind: "action",
            command: "novelai.createEpisodePlot",
            label: "単話プロットを作る",
            description: "AIを使わない",
            icon: "checklist",
            requiresWork: true,
            detail:
              "その話の「視点・この話の目標・展開」を書く雛形を " +
              "設定/episode-plots/第N話.md に作って開きます。" +
              "**筋書きはAIに作らせません。** 書くのは作者です。" +
              "**既にあるものは上書きしません。** そのまま開きます。",
          },
          // **書き始めの並びに置く**（設計書6.40.4）。前回の付箋を見ながら
          // 続きを書くための画面で、資料生成や新作開始の仲間ではない
          {
            kind: "action",
            command: "novelai.openSceneMemos",
            label: "シーンメモを開く",
            description: "AIを使わない",
            icon: "note",
            requiresWork: true,
            detail:
              "本文の中に置いた付箋（行頭が // の行）を、原稿の横に一覧で出します。" +
              "「次へ」「戻る」で話をまたいで飛べます。" +
              "**AIは呼びません。** 材料は本文の中のメモだけです。" +
              "メモは**読者向けの出力（投稿用・PDF・文字数）にもAIにも渡りません。**",
          },
          // **MD化したい理由はルビだけではない**（プレビューで読みたい、
          // 見出しを使いたい）。以前は「ルビを振る」を押したときにだけ
          // 現れる救済の道で、作者から「どこから操作すればいいのでしょうか？」
          // と訊かれた（2026-08-22）。ルビの手前に置く
          {
            kind: "action",
            command: "novelai.convertToMarkdown",
            label: "本文を .md にする",
            icon: "markdown",
            requiresWork: true,
            detail:
              "本文の .txt を .md に変えます。ルビやプレビューが使えるようになります。" +
              "**中身は1文字も変えません。名前だけを変えます**" +
              "（文字コードも改行もそのまま。戻すときは名前を .txt に戻すだけです）。" +
              "この作品の本文をまとめて変えるか、開いている1件だけかを選べます。",
          },
          // **VS Code の Markdown 編集画面では、こちらの機能が効かない**
          // （設計書6.25）。用語の色分けもルビの表示も出ないので、
          // 読み書きする面そのものを用意した。ルビの手前に置く
          {
            kind: "action",
            command: "novelai.openVertical",
            // 開いているファイルに対して働くので、作品の登録は要らない
            requiresWork: false,
            label: "縦書きで開く",
            icon: "book",
            detail:
              "開いている本文を、縦書きで読み書きできる画面で開き直します。" +
              "**ルビと傍点が振り仮名・圏点として出て、用語が色分けされます**" +
              "（右クリックからその設定資料を開けます）。" +
              "横書きへの切り替えと、投稿サイト用のコピーもこの画面にあります。",
          },
          // **耳で聞くと、目では気づかないものが見つかる**（設計書6.42）。
          // 原稿エディタを開く操作の直後に置く——読み上げはあの画面の中の
          // 機能で、資料生成や新作開始の仲間ではない
          {
            kind: "action",
            command: "novelai.readManuscriptAloud",
            label: "原稿を読み上げる（音読推敲）",
            description: "AIを使わない",
            icon: "unmute",
            usesAI: false,
            requiresWork: true,
            detail:
              "原稿エディタを開いて、読み上げの列を出します。" +
              "**OSの声で読むので、料金はかかりませんし、原稿も外へ出ません。**" +
              "読んでいる文を光らせながら進み、引っかかったところは" +
              "「引っかかった」でシーンメモを残せます（そこで一時停止します）。" +
              "**原稿はメモの1行以外、何も書き換えません。**",
          },
          {
            kind: "action",
            command: "novelai.addRuby",
            // 開いているファイルに対して働くので、作品の登録は要らない
            requiresWork: false,
            // **詳細メニューには出さない**（作者の指示、2026-08-31）。
            // 簡単ステップメニューの「入力を楽に」からは今までどおり使う
            hiddenFromActionList: true,
            label: "ルビを振る",
            icon: "text-size",
            detail:
              "選んだ文字にルビ（振り仮名）を付けます。漢字の直後なら、" +
              "選ばなくても拾います。Markdown（.md）のファイルだけで使えます。" +
              "プレビュー（Ctrl+Shift+V）で振り仮名として表示されます。",
          },
          {
            kind: "action",
            command: "novelai.addEmphasis",
            requiresWork: false,
            hiddenFromActionList: true,
            label: "傍点を付ける",
            icon: "three-bars",
            detail:
              "選んだ文字に傍点（強調の点）を付けます。**範囲を選んでから押してください**" +
              "（どこを強調するかは、機械には決められません）。" +
              "Markdown（.md）のファイルだけで使えます。",
          },
          {
            kind: "action",
            command: "novelai.copyForPosting",
            // 開いているファイルに対して働くので、作品の登録は要らない
            requiresWork: false,
            label: "投稿サイト用に変換してコピー",
            icon: "clippy",
            detail:
              "ルビを ｜漢字《かんじ》 の形に直して、クリップボードへ入れます。" +
              "なろう・カクヨム・アルファポリス・ネオページのいずれでも、そのまま貼り付けられます。" +
              "**傍点が入っているときだけ、貼り付け先を訊きます**" +
              "（傍点はサイトによって書き方が違うためです）。" +
              "**原稿は書き換えません。**",
          },
          {
            kind: "action",
            command: "novelai.importRuby",
            // 開いているファイルに対して働くので、作品の登録は要らない
            requiresWork: false,
            label: "投稿サイトのルビを取り込む",
            icon: "arrow-down",
            detail:
              "すでに投稿した原稿を持ち込んだときに使います。｜漢字《かんじ》 を " +
              "｛漢字｜かんじ｝ の形へ直します。何件変わるかを先に見せます。",
          },
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
            command: "novelai.exportPdf",
            label: "PDF出力（印刷用）",
            description: "AIを使わない",
            icon: "file-pdf",
            requiresWork: true,
            detail:
              "本文を印刷用に組版してブラウザで開きます。" +
              "ブラウザの印刷で「PDFに保存」を選ぶとPDFになります。" +
              "縦書き（文庫・A5）と横書き（A4）が選べ、ルビ・傍点も組みます。" +
              "**原稿は書き換えません。** AIは呼びません。",
          },
          {
            kind: "action",
            command: "novelai.exportEpub",
            label: "EPUBを書き出す（試作）",
            description: "AIを使わない",
            icon: "book",
            requiresWork: true,
            detail:
              "本文をEPUB3の電子書籍に組んで `.aiwriter/exports/` へ書き出します" +
              "（Kindle・honto などのリーダーで開けます）。" +
              "縦書き・横書き、ルビ・傍点、目次、奥付を組みます。" +
              // 「まだ土台の段階です」と書いていたら、相談の束選びが
              // 「この段落は…」という本文の相談に当たってしまった
              // （二文字組みの「の段」で拾われる）。言い回しで避ける
              "**いまは土台までです**——表紙は画像1枚をそのまま使い、" +
              "挿絵や登場人物一覧はまだ入りません。" +
              "書誌情報は `設定/書籍/book.json` に書きます（無ければ作品名で組みます）。" +
              "**原稿は書き換えません。** AIは呼びません。",
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
            counter: "mergeCandidates",
            detail:
              "「リン」と「リンセップ・アウクト」のように、" +
              "同じ人物が別々に登録されてしまった組をまとめます。" +
              "どちらの名前を残すかは作者が選びます。",
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
            command: "novelai.openRelationGraph",
            label: "人物相関図",
            icon: "type-hierarchy",
            requiresWork: true,
            // 材料は抽出済みの関係・呼称・所属で、AIは呼ばない
            detail:
              "登場人物のつながりを図にします。作品全体を円で見る図と、" +
              "1人を中心に見る図の2種類があります（設定資料の人物詳細に" +
              "ある「相関図」からは、その人を中心に開きます）。" +
              "AIは使いません。抽出済みの関係・呼称・所属だけで描きます。",
          },
          {
            kind: "action",
            command: "novelai.openSynopsisDocs",
            label: "紹介文・あらすじを閲覧",
            icon: "preview",
            requiresWork: true,
            // **感情曲線（盛り上がりの推移）はこの文書の中の一節**であって、
            // 独立した項目ではない。言葉がメニューのどこにも無く
            // 「盛り上がり曲線がどこにあるか分からない」（作者、2026-08-27）
            // となったので、ここに書いて検索で当たるようにする
            detail:
              "作品紹介文（synopsis.md）と各話あらすじ（synopses.md）を" +
              "プレビューで開きます。**感情曲線（各話の盛り上がりの推移）も" +
              "この中**に載ります（あらすじを生成すると作られます）。" +
              "まだ無ければ、作る操作を案内します。",
          },
          {
            kind: "action",
            command: "novelai.checkNames",
            label: "名前の点検",
            icon: "symbol-key",
            requiresWork: true,
            // 判定そのものはAIを使わない。画面の中の「候補を出す」だけがAI
            detail:
              "**響きの重なっている名前**を洗い出します（「ミナ」と「ミナモト」、" +
              "「アリア」と「アリサ」など）。判定はAIを使わず、読みと表記の" +
              "規則だけで行います。人物ごとの登場箇所も見られ、その行へ飛べます。" +
              "画面の中の「候補を出す」だけがAIを使います。",
          },
          {
            kind: "action",
            command: "novelai.renameCharacter",
            label: "名前を付け替える",
            icon: "replace-all",
            requiresWork: true,
            detail:
              "登場人物の名前を、**姓・名・別名までまとめて**付け替えます。" +
              "対応表を確かめてから走り、本文の置き換えは提案パネルに並びます" +
              "（1件ずつ適用も、まとめて適用もできます）。" +
              "**押しただけでは本文は変わりません。**",
          },
          {
            kind: "action",
            command: "novelai.applyRenameToRecords",
            label: "名前の付け替えを資料にも反映",
            icon: "references",
            requiresWork: true,
            detail:
              "直前の付け替えを、設定資料・プロット・あらすじ・伏線台帳にも" +
              "当てます。**本文の適用が終わってから**実行してください。" +
              "作者メモと資料用の補足には触れません。",
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
        command: "novelai.switchMode",
        label: "作者／編集者を切り替える",
        icon: "person",
        requiresWork: false,
        // **詳細メニューには出さない**（作者の指示、2026-08-31）。
        // 設定管理の `novelai.mode` から切り替える。
        // 簡単ステップメニューの「編集部校正・校閲」からは今までどおり使う
        hiddenFromActionList: true,
        detail:
          "この環境を「編集者」として使うと、**本文の校正・校閲だけ**を行える" +
          "状態になります。編集部の方と一緒に書くときに使います。" +
          "**編集者モードでは、本文を書き換えず提案として置きます。** " +
          "いつでも作者へ戻せます。",
      },
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
        /*
          **一度決めれば、しばらく変えないもの**をここへ集める（設計書6.56）。

          作者の指摘「表に出ている状態のものが多くあります。たくさんあり
          すぎて目が滑ります」（2026-08-31）。これらは執筆のたびに押すもの
          ではないのに、毎日使う操作と同じ高さに並んでいた——「この作品の
          目標を決める」は執筆データに、「形式とジャンルを決める」は
          執筆AI支援に、というふうに**設定だけが散らばっていた**ので、
          探すときも見つけにくかった。

          **消さずに、しまう。** 使う場所から遠くなるが、どれも
          「決めたらしばらく触らない」ものなので、一段深くても困らない。
        */
        kind: "section",
        label: "作品ごとの設定",
        icon: "settings-gear",
        items: [
          {
            kind: "action",
            command: "novelai.setWorkGoals",
            label: "この作品の目標を決める",
            icon: "target",
            requiresWork: true,
            detail:
              "**作品ごと**の目標です（設定の1日・1月の目標は全作品で共有です）。" +
              "1記事あたりの目標文字数を決めると、文字数一覧の「長い・短い」を" +
              "平均ではなく目標と比べます。" +
              "応募先の**締切日・作品の文字量・日間目標**を入れると、" +
              "執筆量パネルに「あと何日・あと何字・1日あたり何字」が出ます。",
          },
          {
            kind: "action",
            command: "novelai.setPlotBasics",
            label: "形式とジャンルを決める",
            icon: "tag",
            requiresWork: true,
            detail:
              "短編・短編集・長編・大長編・SNS記事のどれかと、ジャンルを選んで" +
              "プロットへ書きます。**ジャンルは投稿先ごとに体系が違う**ため" +
              "（小説家になろう20・カクヨム12・アルファポリス16・ネオページ59）、" +
              "どこのジャンルかを添えて書きます。複数の投稿先を選べます。" +
              "プロットの他の部分には触れません。",
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
            command: "novelai.configureAnnouncement",
            label: "告知の設定（ハッシュタグ・URL）",
            icon: "gear",
            requiresWork: true,
            detail:
              "更新告知に付けるハッシュタグと作品ページのURLを決めます。" +
              "作品ごとに覚えるので、告知を作るたびに入れ直す必要はありません。",
          },
        ],
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
            // **詳細メニューには出さない**（設定管理へ移した。設計書6.56.3）
            hiddenFromActionList: true,
            command: "novelai.assignFeatureAI",
            label: "機能ごとにAIを割り当てる",
            icon: "list-selection",
            requiresWork: false,
            detail:
              "機能ごとに使うAIを分けられます。" +
              "いちばん重い設定資料の抽出は、手元の無料AI（Ollama）で実用になっています（実測）。" +
              "割り当てない機能は、AI設定で選んだ既定のAIを使います。",
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
            command: "novelai.measureContext",
            label: "AIチューニング（測って設定を合わせる）",
            icon: "symbol-ruler",
            requiresWork: false,
            usesAI: true,
            detail:
              "そのモデルが実際に読める長さと、必要な待ち時間を測ります（AIを使います）。" +
              "**測った値は、いま選んでいるモデルの設定として覚えます**" +
              "——モデルを切り替えれば、そのモデルの値に変わります。" +
              "有料AIでは実行前に見込みを出します。",
          },
          {
            kind: "action",
            // **詳細メニューには出さない**（設定管理へ移した。設計書6.56.3）
            hiddenFromActionList: true,
            command: "novelai.selectOllamaExecutable",
            label: "Ollamaの実行ファイル位置を指定",
            icon: "folder-opened",
            requiresWork: false,
            detail:
              "Ollamaを自動で見つけられない場合に、ollama.exe の場所を指定します。",
          },
          /*
            **開発ビルドでだけ並べる**（作者の依頼、2026-09-03）。

            `devOnly` は「配布物には定義ごと入らない」印なので、項目そのものを
            `__DEV_HELPERS__` の枝の中に置く。本番ビルドでは条件が false に
            畳まれ、**この配列に1件も入らない**——押しても何も起きない
            ボタンが残らない（コマンドの実体も `src/dev/` ごと落ちる）。

            入切の実体は `src/dev/streamToggle.ts`。実験の入口が
            `.vscode/launch.json` の環境変数しか無く、試すまでが遠すぎた。
          */
          ...(__DEV_HELPERS__
            ? [
                {
                  kind: "action" as const,
                  command: "novelai.dev.toggleOllamaStream",
                  label: "Ollamaのストリーミング受信を切り替える（実験）",
                  icon: "beaker",
                  requiresWork: false,
                  devOnly: true,
                  detail:
                    "**開発ホスト（F5）限定の実験です**（設計書6.63.1）。" +
                    "Ollamaの応答を、生成が終わってからまとめて受け取るのではなく" +
                    "**流しながら**受け取ります。" +
                    "**切り替えはこのウィンドウの間だけで、保存しません**" +
                    "——開き直すと、配布と同じ道（まとめて受け取る）へ戻ります。" +
                    "効いているかは、ログに「流して受信」が出るかで分かります。",
                },
              ]
            : []),
        ],
      },
      {
        kind: "section",
        label: "セットアップを開始",
        icon: "rocket",
        items: [
          {
            kind: "action",
            // **詳細メニューには出さない**（設定管理へ移した。設計書6.56.3）
            hiddenFromActionList: true,
            command: "novelai.runFullSetup",
            label: "セットアップ（必要なものを入れる）",
            icon: "checklist",
            requiresWork: false,
            detail:
              "**この拡張機能を入れただけでは、AIを使う機能は動きません。** " +
              "何が足りていて、それぞれ何のために要るのかを一覧で見せ、" +
              "選んだものを入れます（Ollama本体・会話モデル・埋め込みモデル・Git・GitHub CLI）。" +
              "**入れる前に、何を・どれだけ取得するかを必ず確認します。**",
          },
          {
            kind: "action",
            // **詳細メニューには出さない**（設定管理へ移した。設計書6.56.3）
            hiddenFromActionList: true,
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
            // **詳細メニューには出さない**（設定管理へ移した。設計書6.56.3）
            hiddenFromActionList: true,
            command: "novelai.setupLmStudio",
            label: "LM Studioのセットアップ",
            icon: "cloud-download",
            requiresWork: false,
            detail:
              "**鍵も課金も要らない、もう1つの手元のAI**です。導入から使える状態まで案内します。" +
              "**起動とサーバーの開始、モデルの読み込みはLM Studioの画面での操作**になるので、" +
              "手順を案内して、できたところで確かめ直します。",
          },
        ],
      },
      {
        kind: "section",
        // **「相談で使う検索」では、何が起きるのか分からない**
        // （作者の指摘、2026-08-19）。検索は手段であって、
        // 作者が得たいのは**相談の答えがよくなること**である
        label: "AI相談の強化",
        icon: "search-fuzzy",
        items: [
          {
            kind: "action",
            // **詳細メニューには出さない**（設定管理へ移した。設計書6.56.3）
            hiddenFromActionList: true,
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
            // **詳細メニューには出さない**（設定管理へ移した。設計書6.56.3）
            hiddenFromActionList: true,
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
            // **詳細メニューには出さない**（設定管理へ移した。設計書6.56.3）
            hiddenFromActionList: true,
            command: "novelai.clearVectorIndex",
            // 名前は「作る・更新する」と対にしておく。
            // 片方だけ言い回しを変えると、並べたときに対応が見えない
            label: "検索用の索引を削除する",
            icon: "trash",
            requiresWork: true,
            // **「置き場所を空けます」では、押す判断ができない**
            // （作者の指摘、2026-08-19）。作者が知りたいのは
            // 「消すと何が悪くなるか」と「元へ戻せるか」である
            detail:
              "この作品の索引を消します。" +
              "**相談は語句一致に戻ります**（言い換えで聞いたときに見つけにくくなります）。" +
              "**本文・設定資料・あらすじは何も変わりません。** " +
              "消すのは、置き場所が足りないときと、索引が壊れて作り直したいときです。" +
              "**いつでも作り直せます。**",
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
      // **一番上に置く。** 何ができるのかが分からない状態でヘルプを開く人が
      // 最初に見るものである（ログを読みたい人は目的があって来る）
      {
        kind: "action",
        command: "novelai.openManual",
        label: "使い方（マニュアル）",
        icon: "book",
        requiresWork: false,
        detail:
          "この拡張機能でできることを、1つの文書にまとめて開きます。" +
          "作品づくりの流れ・全部の操作・画面の説明が入ります。" +
          "**いま入っている版から作るので、説明が古びません。**" +
          "**保存はしません**（閉じて構いません）。",
      },
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
      {
        kind: "action",
        command: "novelai.openChatLog",
        label: "相談のログを開く",
        icon: "comment-discussion",
        requiresWork: true,
        detail:
          "AIとの相談のやり取りを残しています。**何を材料にAIが何を答えたか**を" +
          "後から確かめられます（渡した場面・検索語・所要時間つき）。" +
          "**原稿の一部を含みます。** GitHubへは送られません。" +
          "残したくない場合は設定 `novelai.chatLog.enabled` を切ってください。",
      },
      {
        kind: "action",
        command: "novelai.diagnoseWeb",
        label: "動作を診断",
        icon: "pulse",
        requiresWork: false,
        // **手元のVS Codeでは出さない**（作者の指定、2026-08-26）。
        // ブラウザ版で保存できないときの切り分けに作ったもので、手元では
        // 出番が無い。手元で要るときはコマンドパレットから呼べる
        browserOnly: true,
        detail:
          "いまの環境で、ファイルに何ができるかを実際に試して並べます" +
          "（フォルダーを作る・書く・読む・移す・消す）。" +
          "**原稿には触れません。** 使い捨ての場所で試して、終わったら消します。" +
          "ブラウザ版で保存できないときに、原因を突き止めるために使います。",
      },
      // **一番下に置く**（作者の指定、2026-08-16）。
      // 版を見るのは不具合を伝えるときだけで、日々の作業では使わない
      {
        kind: "action",
        command: "novelai.showVersion",
        label: "バージョンを確認",
        icon: "info",
        requiresWork: false,
        detail:
          "この拡張機能の版と、いまの環境（VS Codeの版・選んでいるAI・" +
          "意味検索の入切）を表示します。**そのまま貼り付けられる形でコピーできます。**" +
          "不具合を伝えるときに添えてください。変更履歴もここから開けます。",
      },
    ],
  },
];

/**
 * 画面に出す操作メニュー。**土台に「テスト中」を足したもの**。
 *
 * 作者の依頼（2026-08-26）：「操作メニューの最下段に『テスト中』を新設し、
 * その下に操作メニューと同じメニュー構造でテストが終わっていない機能を
 * 並べてください」。
 *
 * **中身は `docs/実機確認リスト.md` から自動生成する**（`pendingChecks.ts`）。
 * 文書を手で写すと必ず片方が古くなる。
 *
 * 残りが1件も無くなれば、この分類は自然に消える。
 */
export const ACTION_TREE: readonly ActionGroup[] = (() => {
  const testing = buildPendingCheckGroup(BASE_ACTION_TREE, PENDING_CHECKS);
  return testing ? [...BASE_ACTION_TREE, testing] : BASE_ACTION_TREE;
})();

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
/**
 * 作品が無いときに、作品を必要とする操作をどう扱うか。
 *
 * **消さずに出して、押せなくする**（作者の指示、2026-08-17）。
 *
 * 以前は消していた。そのため作品を登録していない状態では、
 * 6つある分類のうち**3つが丸ごと消え**（執筆データ・執筆AI支援・資料管理）、
 * 残る操作は13件だけだった。**初めて使う人には、そもそも何ができる
 * 拡張機能なのかが分からない。**
 *
 * 押せない項目には理由を添える。**「使えない」だけでは、どうすれば
 * 使えるのかが分からない。**
 */
export const REQUIRES_WORK_HINT = "作品を登録すると使えます";

/**
 * その操作を、いまの環境の操作メニューに出すか。
 *
 * **出す・出さないをここだけで決める。** 画面（`getChildren`）とAIへ渡す
 * 機能の一覧（`featureGuide`）の両方が通るので、片方だけ直して
 * 「メニューに無い操作をAIが案内する」形にしない。
 */
export function isItemVisibleInRuntime(
  item: ActionItem,
  runtimeAllowsProcesses: boolean
): boolean {
  // 外部プロセスを起動できる＝手元のVS Code
  return !item.browserOnly || !runtimeAllowsProcesses;
}

/**
 * 詳細メニューの**画面に**並べる項目か（設計書6.56.3）。
 *
 * **`isItemVisibleInRuntime` と分けてある。** あちらは「この環境で
 * 動くか」で、AIへ渡す機能の一覧（`featureGuide`）や実機確認リストの
 * 突き合わせも通る。`hiddenFromActionList` は**画面に出すかどうかだけ**の
 * 話なので、そちらまで巻き込むと「メニューに無い操作」として
 * 案内からも確認リストからも消え、**存在ごと見えなくなる**
 * （実際、まとめて消したときに4つの検査が落ちた）。
 */
export function isItemShownInActionList(
  item: ActionItem,
  runtimeAllowsProcesses: boolean
): boolean {
  if (item.hiddenFromActionList) return false;
  return isItemVisibleInRuntime(item, runtimeAllowsProcesses);
}

/** 分類・小分類の中身を、いまの環境に合わせて絞る */
export function visibleEntries<T extends ActionItem | ActionSection>(
  entries: readonly T[],
  runtimeAllowsProcesses: boolean
): T[] {
  return entries.filter(
    (entry) =>
      entry.kind !== "action" ||
      isItemVisibleInRuntime(entry, runtimeAllowsProcesses)
  );
}

/**
 * 分類・小分類の中身から、**詳細メニューの画面に並べるもの**だけを取る。
 *
 * `visibleEntries` との違いは `hiddenFromActionList` を見るかどうかだけで、
 * 使い分けは `isItemShownInActionList` の説明にある。
 */
export function shownEntries<T extends ActionItem | ActionSection>(
  entries: readonly T[],
  runtimeAllowsProcesses: boolean
): T[] {
  return entries.filter((entry) => {
    if (entry.kind === "action") {
      return isItemShownInActionList(entry, runtimeAllowsProcesses);
    }
    // **中身が全部隠れた小分類は、見出しごと畳む。** 開いても何も無い行を
    // 残すと、片づけたはずのメニューがかえって分かりにくくなる
    return entry.items.some((item) =>
      isItemShownInActionList(item, runtimeAllowsProcesses)
    );
  });
}

/**
 * いま出す分類。**作品の有無で中身は変わらない。**
 *
 * 押せるかどうかは `isActionEnabled` で決める。
 */
export function visibleGroups(_hasWork: boolean = true): readonly ActionGroup[] {
  return ACTION_TREE;
}

/**
 * その操作をいま押せるか。
 *
 * **編集者モードでは、本文の校正・校閲だけを押せる**（設計書5.6）。
 * 消さずに押せなくするのは、既存の「作品を登録すると使えます」と同じ考えで、
 * **何ができないのかが見えないと、編集部は壊れていると思う**ためである。
 */
export function isActionEnabled(
  item: ActionItem,
  hasWork: boolean,
  mode: WorkMode = "author",
  /** 外部プロセス（git・Ollama）を起動できる環境か。既定はできる扱い（手元） */
  runtimeAllowsProcesses = true
): boolean {
  if (!isCommandAllowed(item.command, mode)) return false;
  if (!isCommandAvailableInRuntime(item.command, runtimeAllowsProcesses)) {
    return false;
  }
  return hasWork || !item.requiresWork;
}

/** 押せない理由。**「使えない」だけでは、どうすればよいか分からない** */
export function disabledHint(
  item: ActionItem,
  hasWork: boolean,
  mode: WorkMode = "author",
  runtimeAllowsProcesses = true
): string | undefined {
  if (!isCommandAllowed(item.command, mode)) return EDITOR_BLOCKED_HINT;
  if (!isCommandAvailableInRuntime(item.command, runtimeAllowsProcesses)) {
    return PROCESSES_BLOCKED_HINT;
  }
  if (!hasWork && item.requiresWork) return REQUIRES_WORK_HINT;
  return undefined;
}

/**
 * 押せない理由に、次に取れる手を添える。
 *
 * **理由だけでは動けない。** 作品が無いなら登録の道を、
 * 編集者モードなら「作者の環境で」を、ブラウザ版なら代わりの道を言う。
 */
export function explainDisabled(
  item: ActionItem,
  hint: string | undefined
): string {
  if (hint === EDITOR_BLOCKED_HINT) return describeBlocked(item.command);
  if (hint === PROCESSES_BLOCKED_HINT) {
    return describeProcessesBlocked(item.command);
  }
  return "「作品一覧」の「フォルダから作品を追加」または「新規作品を作成」から登録してください。";
}

/** 木の中の操作をすべて取り出す（テストと整合性の確認用） */
export function allActions(): ActionItem[] {
  // **写しの分類（「テスト中」）は数えない。** 同じコマンドが2度出てくる
  return ACTION_TREE.filter((group) => !group.generated).flatMap((group) =>
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
    private readonly counts?: ActionCounts,
    /**
     * 「テスト中」の分類を出すか（作者の指示、2026-08-29）。
     *
     * **F5（開発ホスト）のときだけ真。** ストアから入れた読者に
     * 開発用の確認一覧を見せても、押せるものが増えるだけで意味がない。
     * extension.ts が `ExtensionMode.Development` を渡す。
     */
    private readonly showTesting: boolean = true
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
      // **ここに出せないものを黙って落とさない**（「テスト中」で使う）
      const groupTooltip = node.type === "group" ? node.group.tooltip : undefined;
      if (groupTooltip) item.tooltip = new vscode.MarkdownString(groupTooltip);
      item.iconPath = new vscode.ThemeIcon(icon);
      // 件数の印（FileDecorationProvider）を出すための目印
      item.resourceUri = actionResourceUri(node);
      return item;
    }

    const { item: action } = node;
    const hasWork = this.registry.list().length > 0;
    const mode = currentMode();
    const runtimeAllowsProcesses = canRunProcesses();
    const enabled = isActionEnabled(action, hasWork, mode, runtimeAllowsProcesses);
    const hint = disabledHint(action, hasWork, mode, runtimeAllowsProcesses);

    const item = new vscode.TreeItem(
      action.label,
      vscode.TreeItemCollapsibleState.None
    );
    // **押せない理由を、その場に出す。** 「使えない」だけでは、
    // どうすれば使えるのかが分からない
    item.description = enabled ? (action.description ?? "") : (hint ?? "");
    item.iconPath = enabled
      ? new vscode.ThemeIcon(action.icon)
      : // 色を落として、押せるものと見分けられるようにする
        new vscode.ThemeIcon(
          action.icon,
          new vscode.ThemeColor("disabledForeground")
        );
    item.tooltip = new vscode.MarkdownString(
      [
        enabled
          ? ""
          : `**${REQUIRES_WORK_HINT}。** ` +
            "「作品一覧」の「フォルダから作品を追加」または「新規作品を作成」から登録してください。\n\n",
        action.usesAI ? "**AIを使います**（クラウドのAIは実行のたびに課金されます）\n" : "",
        action.detail,
        this.countOf(action.counter) > 0
          ? `\n\n未反映: ${this.countOf(action.counter)} 件`
          : "",
      ].join("")
    );
    // 「AI」と件数の印を出すための目印
    item.resourceUri = actionResourceUri(node);
    if (enabled) {
      // 引数を渡さないので、作品が複数あれば実行時に選択を求められる
      item.command = { command: action.command, title: action.label };
    }
    // **押せないものは command を持たせない。** 押しても何も起きない
    // ことより、押したら「作品を選んでください」と訊かれて何も選べない
    // ほうが分かりにくい
    return item;
  }

  private countOf(counter: ActionCounter | undefined): number {
    return counter && this.counts ? this.counts(counter) : 0;
  }

  getChildren(node?: ActionNode): ActionNode[] {
    const hasWork = this.registry.list().length > 0;
    // 写しの分類（テスト中）は開発ホストだけに出す（作者の指示、2026-08-29）
    const groups = visibleGroups(hasWork).filter(
      (group) => !group.generated || this.showTesting
    );

    if (!node) {
      return groups.map((group) => ({ type: "group" as const, group }));
    }
    if (node.type === "group") {
      return shownEntries(node.group.entries, canRunProcesses()).map((entry) =>
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
      return shownEntries(node.section.items, canRunProcesses()).map((item) => ({
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
