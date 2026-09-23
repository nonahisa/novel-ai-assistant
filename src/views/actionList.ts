import * as vscode from "vscode";
import { logFailure } from "../core/logger";
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
import {
  prerequisiteNote,
  prerequisiteOf,
  type Prerequisite,
  type PrerequisiteAlternative,
} from "../core/prerequisites";
// 上限の値は**定数から引く**（説明文に書き写すと、変えたときに画面だけ古くなる）
import { MAX_ISSUES_PER_1000_CHARS } from "../prompts/proofread";

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
  /**
   * 名前のうしろに付いていた括弧の補足（作者の裁定、2026-09-06）。
   *
   * **ビューは幅が狭い。** 「AIチューニング（測って設定を合わせる）」の
   * ように名前へ説明を足すと、途中で切れて肝心の名前のほうが読めない。
   *
   * **消すのではなく、置き場所を変える。** ここへ移した文は、
   * ツールチップと、相談へ送る束（`featureGuide.ts`）の両方に出る。
   * `package.json` の `title` は変えない——コマンドパレットは名前だけで
   * 探す場所なので、そこでは補足が付いていたほうが見つけやすい。
   */
  note?: string;
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
  /**
   * この操作が動くために先に要るもの（設計書6.94／`core/prerequisites.ts`）。
   *
   * **文章ではなくデータで持つ。** 前提はこれまで `detail` の中の一文に
   * しか書かれておらず、117操作のうち4つだけだった。しかも相談へ渡す
   * ときの切り詰めで落ちていたので、AIは前提を知らないまま答えていた。
   *
   * **推測で増やさない。** `detail` に根拠が書いてあるものだけを足す。
   * 当て推量で並べると、実際には動く操作の前で作者の手が止まる。
   */
  needs?: readonly Prerequisite[];
  /**
   * 前提が無くても同じ目的にたどり着ける、代わりの操作。
   *
   * 作者の指示（2026-09-18）「代替で実行できるようにもしてください」。
   * **名前を出すだけで終わらせない**——足りないと分かった場面から、
   * その場で代わりの操作へ移れるようにする。
   */
  insteadOf?: PrerequisiteAlternative;
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
  /** ホバーで出す説明。分類そのものの但し書きを添えるのに使う */
  tooltip?: string;
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
      // **全作品を先頭に置く**（作者の指定、2026-08-16）。
      // 目標（1日・1月）は作品を問わず共有する値なので、達成率はこちらが正しい。
      // 作品ごとの画面を先に出すと、他の作品へ書いた分が入らない数字を
      // 先に見ることになる
      {
        kind: "action",
        command: "novelai.showAllWorksWritingStats",
        label: "全作品の執筆統計",
        icon: "graph-scatter",
        requiresWork: true,
        detail:
          "全作品を合わせた執筆量のグラフ\n\n" +
          "・目標（1日・1月）は作品を問わず共有\n\n" +
          "・達成率はこちらが正確",
      },
      {
        kind: "action",
        command: "novelai.showWritingStats",
        label: "執筆統計",
        icon: "graph-line",
        requiresWork: true,
        detail:
          "日次・週次・月次・年次の執筆量のグラフ\n\n" +
          "・目標を決めていれば達成率も\n\n" +
          "・話ごとの文字数一覧（長さの偏り）も同じ画面",
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
          "話数順と時系列順で並べた、話ごとの出来事\n\n" +
          "・人物・変化・能力・呼称・伏線・あらすじを1枚に\n\n" +
          "AIは呼ばない。",
      },
      {
        kind: "action",
        command: "novelai.editTimeline",
        label: "時期・系統を編集",
        icon: "calendar",
        requiresWork: true,
        detail:
          "作中の時期と、本編以外の筋の登録\n\n" +
          "・時期は「十年前・火事の夜」など\n\n" +
          "・筋はIF編・夢・劇中劇\n\n" +
          "・年表を時系列順に並べるのに使う",
      },
      {
        kind: "action",
        command: "novelai.showEditHistory",
        label: "編集履歴",
        icon: "history",
        requiresWork: true,
        detail:
          "誰が何を直したかの一覧\n\n" +
          "・作者・編集者・AIの3つに色分け\n\n" +
          "・編集部と一緒に書くときに使う\n\n" +
          "この画面から履歴は変えられない。",
      },
    ],
  },

  {
    kind: "group",
    label: "作品管理",
    icon: "repo",
    entries: [
      // **小分類には入れない。** 置き場（GitHub）でも始め方でもなく、
      // 登録済みの作品そのものを直す操作なので、分類の直下に置く。
      // 右クリック（作品を右クリック →「作品名を変更」）と同じ操作
      {
        kind: "action",
        command: "novelai.renameWork",
        label: "作品名を変更",
        icon: "edit",
        requiresWork: true,
        detail:
          "作品の呼び名の変更\n\n" +
          "・一覧の表示名と `.aiwriter/config.json` の題\n\n" +
          "・プロットの先頭の見出し\n\n" +
          "・自分で書き換えた見出しは触らない\n\n" +
          "フォルダー名は変えない。",
      },
      // **小分類には入れない**（作品名の変更と同じ理由）。置き場でも始め方でも
      // なく、登録済みの作品そのものの決めごとなので、分類の直下に置く
      {
        kind: "action",
        command: "novelai.setSeries",
        label: "シリーズとしてつなぐ",
        icon: "link",
        requiresWork: true,
        detail:
          "同じ世界・同じ人物を書いている作品どうしを結ぶ\n\n" +
          "・つなげるのは同じフォルダーに並んでいる作品だけ\n\n" +
          "・借りるのは人物・場所・能力・組織の名前と読み仮名だけ\n\n" +
          "・用語の色分け・ルビ・IME辞書・表記ゆれの材料に足す\n\n" +
          "・抽出で同じ名前が出ても候補として並べるだけ\n\n" +
          "中身は読まず、相手の資料も書き換えない。",
      },
      /*
        **作品の入口を3つに畳む**（設計書6.97.4）。作者の言葉
        （2026-09-19）「メニュー構造も自然とそうなるようにできればよい」。

        以前は「新作開始」「既存作追加」の2つで、始め方（プロット／本文）と
        置き場（フォルダー／GitHub）という**別の軸**が混ざっていた。
        分け直す線は**作者が何をしたいか**である——これから書くのか、
        もう書いてあるものを入れるのか、別の環境から取り寄せるのか。

        **どれも行き先は書庫になる**（6.97.2）。そこは画面では訊かず、
        `features/newWorkHome.ts` が黙って決めて一行で伝える。

        **コマンドIDは変えていない。** 変えると、作者のキーバインド・
        手順書き（`core/procedures.ts`）・相談の案内が一斉にずれる。
      */
      {
        kind: "section",
        label: "新しく書き始める",
        icon: "new-folder",
        items: [
          {
            kind: "action",
            command: "novelai.createWorkWithPlot",
            label: "プロットから開始",
            icon: "list-tree",
            requiresWork: false,
            detail:
              "作品フォルダーを作り、設定/plot.md を用意して開く\n\n" +
              "・ログライン・テーマ・世界観・あらすじの見出しつき\n\n" +
              "・これまでの作品と同じフォルダーの中に作る",
          },
          {
            kind: "action",
            command: "novelai.createWorkFromManuscript",
            label: "本文から開始",
            icon: "edit",
            requiresWork: false,
            detail:
              "作品フォルダーと第1話のファイルを作って開く\n\n" +
              "・プロットは作らない（あとから「プロットを作る」で足せる）\n\n" +
              "・これまでの作品と同じフォルダーの中に作る",
          },
        ],
      },
      {
        kind: "section",
        label: "すでにある原稿を入れる",
        icon: "folder-opened",
        items: [
          // **書庫の中にある作品は、選ばせずに拾う**（設計書6.97.4）。
          // OSのフォルダー選びを開くと、目的のフォルダーへ辿り着くまでに
          // 何度も潜ることになる（2026-09-19、実機で6回）。別の機械で
          // `git pull` したあとも、ファイルはあるのに登録だけが無い状態になる。
          // **既定の道にしたいので、「フォルダから追加」より上に置く**
          {
            kind: "action",
            command: "novelai.collectUnregisteredWorks",
            label: "未登録の作品を探す",
            icon: "library",
            requiresWork: false,
            detail:
              "書庫の中の、まだ登録していない作品の一覧\n\n" +
              "・フォルダーを選ぶ画面は開かない\n\n" +
              "・書庫の場所は登録済みの作品から分かる\n\n" +
              "・選んだものだけを登録\n\n" +
              "・下書き置き場はチェックを外せば登録されない",
          },
          {
            kind: "action",
            command: "novelai.addWork",
            label: "フォルダから追加",
            icon: "folder-opened",
            requiresWork: false,
            detail:
              "すでに原稿があるフォルダーを作品として登録\n\n" +
              "・投稿サイトから落としたファイルの入ったフォルダーも可\n\n" +
              "・中に作品が並んでいるフォルダー（書庫）ならまとめて登録",
          },
          // **ZIPのまま渡せる道**（設計書6.98）。投稿サイトのバックアップは
          // ZIPで降ってくるので、展開してからフォルダーを選ぶ手間が
          // 「初めて使う人」の最初の壁になっていた
          {
            kind: "action",
            command: "novelai.importWorkFromZip",
            label: "バックアップから取り込む",
            icon: "file-zip",
            requiresWork: false,
            detail:
              "投稿サイトから落としたZIPをそのまま作品にする\n\n" +
              "・展開・作品フォルダーの用意・登録までを一度に\n\n" +
              "・作品名は about.txt のタイトルから（次の画面で直せる）\n\n" +
              "・キャッチコピー・紹介文・ジャンル・タグは資料の下書きに",
          },
        ],
      },
      {
        kind: "section",
        label: "別の環境から取り寄せる",
        icon: "cloud-download",
        items: [
          {
            kind: "action",
            command: "novelai.addWorkFromGithub",
            label: "GitHubから追加",
            icon: "cloud-download",
            requiresWork: false,
            detail:
              "別の環境で書いている作品をGitHubから取り寄せて登録\n\n" +
              "・新しいPCで続きを書き始めるときに使う\n\n" +
              "・複数の作品が入ったリポジトリならまとめて登録",
          },
        ],
      },
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
            label: "GitHubに置く",
            note: "はじめて",
            icon: "repo-push",
            requiresWork: true,
            detail:
              "リポジトリの作成から最初の送信までの案内\n\n" +
              "・同じフォルダーに並んでいる作品はまとめて1つの置き場へ\n\n" +
              "・この作品だけを分けることもできる\n\n" +
              "新しく作るリポジトリは非公開に固定。",
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
              "別々の場所の作品を1つの書庫（フォルダー）へ写す\n\n" +
              "・そのあと「GitHubに置く」で書庫まるごとを1リポジトリに\n\n" +
              "元のフォルダーは消さない。",
          },
          // **「送った」と言い切れる口を1つ持つ**（設計書6.15.1。作者の指示、
          // 2026-09-21）。機械を行き来する前に、これだけ押せばよい
          {
            kind: "action",
            command: "novelai.saveAndSync",
            label: "保存して同期",
            icon: "save-all",
            requiresWork: false,
            detail:
              "開いている原稿を保存してから、記録してGitHubへ送る\n\n" +
              "・別の機械で書く前は、これだけ押せば済む\n\n" +
              "・「作品をすべて同期」と違い、未保存があっても止まらない",
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
              "登録しているすべての作品をまとめて同期\n\n" +
              "・置き場（リポジトリ）ごとに 記録 → 取り込み → 送信\n\n" +
              "・何が起きるかを一覧で見せてから1回だけ確認\n\n" +
              "・1か所が通らなくても残りは続ける",
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
              "別のPCとこちらで分かれてしまった変更を合わせる\n\n" +
              "・同じファイルが両方で書き換えられていないかを先に調べる\n\n" +
              "・合わせる前に退避の枝を作るので、あとから戻せる\n\n" +
              "原稿が両方で書き換えられていたら手を引く。GitHubへは送らない。",
          },
          {
            kind: "action",
            command: "novelai.gitSync",
            label: "同期",
            icon: "sync",
            requiresWork: true,
            detail:
              "未取得の変更・未送信の変更の確認\n\n" +
              "・取り込みと送信もここから\n\n" +
              "・同じ置き場に入っている作品はまとめて扱う",
          },
          {
            kind: "action",
            command: "novelai.resolveConflicts",
            label: "競合解決",
            icon: "git-merge",
            requiresWork: true,
            detail:
              "同じ話を2つの環境で書いたときの選び直し\n\n" +
              "・両方を並べて見比べる\n\n" +
              "・迷ったら両方残せる",
          },
          {
            kind: "action",
            command: "novelai.gitRestore",
            label: "復元",
            icon: "history",
            requiresWork: true,
            detail:
              "GitHubに送った過去の版から原稿を今の場所へ戻す\n\n" +
              "・戻す前に今の内容を退避するので、やり直せる",
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
              "この作品だけの非公開リポジトリを作って送る\n\n" +
              "・送るのは本文と設定資料\n\n" +
              "・ほかの作品は渡らない\n\n" +
              "編集部が書けるのは提案だけ。本文は書き換わらない。",
          },
          {
            kind: "action",
            command: "novelai.collectEditorProposals",
            label: "編集部の提案を取り込む",
            icon: "repo-pull",
            requiresWork: true,
            detail:
              "編集部が書いた提案を取り寄せて提案パネルへ並べる\n\n" +
              "・採るかどうかは1件ずつ作者が決める\n\n" +
              "本文には触らない。",
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
      /*
        **分類の先頭に置く**（作者の指示、2026-09-19「初心者が初めて使う
        ところを魅せたい」）。

        小分類の中には入れられない。この操作は資料の抽出（資料管理）・
        あらすじ・プロット・広報支援・校正・校閲を**またいで**走らせるので、
        どれか1つの小分類へ入れると、そこだけの操作に見える。取り込んだ
        ばかりの作品を前にした人が最初に目を落とすのは分類の先頭なので、
        AI支援の入口としてここへ出す。
      */
      {
        kind: "action",
        command: "novelai.finishNewWork",
        label: "新作をひと通り仕上げる",
        icon: "rocket",
        requiresWork: true,
        usesAI: true,
        /*
          **`needs` は付けない。** 前提（設定資料・あらすじ・プロット）は、
          この操作自身が順に作っていく。関門を立てると、作りに行く操作の
          前で「先に作ってください」と止められることになる。
        */
        detail:
          "AIでできることを順に全部走らせる\n\n" +
          "・設定資料の抽出・各話あらすじ・プロットの逆算\n\n" +
          "・紹介文・キャッチコピー・校正一式・章立ての提案\n\n" +
          "・既にあるもの（設定資料・あらすじ・プロット）の段は飛ばす\n\n" +
          "・走らせる段と送る量は始める前に1回だけ確認\n\n" +
          "・終わったら結果を1枚の文書にまとめて開く\n\n" +
          "・途中で中止すると残りは走らない\n\n" +
          "本文は1文字も書き換えない（指摘は「提案」パネルへ）。",
      },
      {
        kind: "action",
        command: "novelai.openChatPanel",
        // **見出しと中身を合わせる**（作者の報告、2026-08-31）。
        // 「AIに相談する」とだけ書いてあったので、押すと本文の領域に
        // 大きく開くことが読めなかった——`package.json` のコマンド名は
        // はじめから「AIに相談する（大きく開く）」で、こちらだけがずれていた
        label: "AIに相談",
        note: "大きく開く",
        icon: "comment-discussion",
        // **詳細メニューには出さない**（作者の指定、2026-09-03。
        // 横のパネルの「メインに表示」ボタンが入口。簡単ステップメニューには残る）。
        // **消さずに隠す**——`stepMenu.ts` がこの項目をコマンドIDで引いている
        hiddenFromActionList: true,
        // 作品のファイルを開いていないと材料が無く、
        // 「作品のファイルを開いてください」としか答えられない
        requiresWork: true,
        usesAI: true,
        detail:
          "開いているファイルについてAIに相談（本文の領域に大きく開く）\n\n" +
          "・本文・プロット・設定資料のどれでも\n\n" +
          "・返事に付く選択肢を押して次へ\n\n" +
          "・誤字脱字の検知、資料の抽出もその場から\n\n" +
          "・会話はMarkdownのメモに保存\n\n" +
          "・プロット／紹介文／各話あらすじは、確認して押すと書き込み\n\n" +
          "・横の小さいパネルは本文の右クリックから\n\n" +
          "原稿は書き換えない。",
      },
      // 「横のパネルへ移動」の項目はここにも「…」メニューにも**置かない**
      // （作者の指定、2026-09-03「使い道がありません」。0.29.8で足したものの
      // 取り消し）。横の細いパネル（novelai.openChat）自体は残る——
      // 入口は**本文の右クリックだけ**。範囲を選んで聞く使い方はそちらで足りる
      // 相談の助言方針（設計書6.86）。相談の近くに置く——ここを決めると
      // 変わるのは相談の答え方だけで、単独では何も起きない
      {
        kind: "action",
        command: "novelai.setAdvicePolicy",
        label: "相談の助言方針",
        note: "診断",
        icon: "person",
        requiresWork: true,
        // 質問に答えるだけ。AIは呼ばない（会話ログからの推定はしない）
        usesAI: false,
        detail:
          "9つの質問で決める、AIの助言の入り方\n\n" +
          "・読者志向・自分志向・嗜好志向の3つを測る\n\n" +
          "・11のタイプのどれかに決まる\n\n" +
          "・決めるのは出発点。あとは相談での発言から推定で動く\n\n" +
          "・いつでもやり直せる。消せば素の状態\n\n" +
          "答えは作者の手元にだけ残る。GitHubには送らない。",
      },
      // 作者自身の読者タイプ（設計書6.101）。**助言方針の隣に置く**——
      // どちらも作者ごとの答えで、AIを呼ばず、単独では何も書き換えない。
      // 作品ごとの「ターゲット読者診断」とは別物なので、並べない
      {
        kind: "action",
        command: "novelai.setAuthorReaderType",
        label: "あなた自身の読者タイプ",
        note: "診断",
        icon: "book",
        requiresWork: true,
        // 質問に答えるだけ。AIは呼ばない
        usesAI: false,
        detail:
          "9つの質問で測る、あなた自身が読者として求めるもの\n\n" +
          "・作品の宛先ではなく、あなたが読むときの話\n\n" +
          "・その作品のターゲット読者との違いが出る\n\n" +
          "・上下はない。効く相手が違うだけ\n\n" +
          "・いつでもやり直せる。消せる\n\n" +
          "答えは作者の手元にだけ残る。作品にもGitHubにも入らない。",
      },
      {
        kind: "action",
        command: "novelai.chooseChatWork",
        label: "相談する作品を選ぶ",
        icon: "book",
        requiresWork: true,
        detail:
          "相談の相手にする作品の指定\n\n" +
          "・作品のファイルを開いていないときに使う\n\n" +
          "・ファイルを開いていれば、そちらが優先",
      },
      {
        kind: "action",
        command: "novelai.createPlot",
        label: "プロットを作る",
        icon: "list-tree",
        requiresWork: true,
        detail:
          "設定/plot.md を開く\n\n" +
          "・無ければ書き出しを用意して作る\n\n" +
          "・見出しも順番も自由（決まった欄を埋める形ではない）\n\n" +
          "・書きかけがあれば、そのまま開くだけ",
      },
      // **プロットを書く場（設計書6.4.8）。** 「つくる」の次に置く——
      // 作ったプロットを育てるときは、たいていこちらから入る
      {
        kind: "action",
        command: "novelai.openPlotMode",
        label: "プロットモード",
        description: "AIを使わない",
        icon: "book",
        requiresWork: true,
        detail:
          "左に 設定/plot.md、右に作業パネル\n\n" +
          "・節の目次（押すとその行へ移る）\n\n" +
          "・まだ立てていない見出しの候補\n\n" +
          "・話の並び（単話プロットの有無・文字数・章名・あらすじの冒頭）\n\n" +
          "・書くのは左のエディタ",
      },
      {
        kind: "action",
        command: "novelai.plotInterview",
        label: "対話でプロットを作る",
        icon: "comment-discussion",
        requiresWork: true,
        usesAI: true,
        detail:
          "まだ書けていない項目をAIが1つずつ尋ねる\n\n" +
          "・答えを整えてプロットへ書く案が出る\n\n" +
          "・決まっていない項目は飛ばせる\n\n" +
          "筋書きはAIが作らない。作者の中にあるものを引き出す。",
      },
      {
        kind: "action",
        command: "novelai.generatePlot",
        label: "本文からプロットを逆算",
        icon: "sparkle",
        requiresWork: true,
        usesAI: true,
        // 前提は説明文の最後の一文（「各話あらすじを材料にするため…」）が
        // 根拠。文はそのまま残す——画面のホバーで読めるほうが親切である。
        // 中身は `core/prerequisites.ts` の表（外部AIの口と共用する）
        ...prerequisiteOf("novelai.generatePlot"),
        detail:
          "本文からログライン・テーマ・世界観・あらすじを組み直す\n\n" +
          "・空の項目だけ埋める\n\n" +
          "・書かれている項目は置き換えるかを選べる\n\n" +
          "・材料は各話あらすじ。先にあらすじを作っておく\n\n" +
          "作者が既に書いた項目を、確認せずに書き換えない。",
      },
      {
        kind: "section",
        label: "校正・校閲",
        icon: "search-fuzzy",
        items: [
          // **分類の先頭に置く**（設計書6.80）。1つずつ押して回るのが
          // ここでの常なので、まとめて走らせる入口を最初に見せる
          {
            kind: "action",
            command: "novelai.runProofreadingSuite",
            label: "校正をまとめて実行",
            icon: "checklist",
            requiresWork: true,
            usesAI: true,
            detail:
              "この分類の検知を、選んだものだけ順に実行\n\n" +
              "・表記ゆれ・誤字脱字・推敲・冒頭診断・プロット逸脱・矛盾・伏線\n\n" +
              "・走らせるものは毎回選べる（前回の選択を覚えている）\n\n" +
              "・順番は軽いものから重いものへ固定\n\n" +
              "・結果は右の列の「提案」パネルへ\n\n" +
              "・途中で中止すると残りは走らない\n\n" +
              "本文は書き換えない。",
          },
          {
            kind: "action",
            command: "novelai.checkTypos",
            label: "誤字脱字を検知",
            icon: "search-fuzzy",
            requiresWork: true,
            usesAI: true,
            detail:
              "誤変換・脱字・衍字など、明らかな入力ミスの検知\n\n" +
              "・指摘は右の列の「提案」パネルへ\n\n" +
              "・内容を確認してから1件ずつ適用・無視を選ぶ\n\n" +
              "自動では書き換えない。",
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
              "誤字脱字と推敲で指摘しない語の登録\n\n" +
              "・方言・口癖・独自の言い回し（「はよ」「あらへん」など）\n\n" +
              "・固有名詞は登録しなくても守られる\n\n" +
              "・控えは 設定/keep_words.json",
          },
          {
            kind: "action",
            command: "novelai.checkNotation",
            label: "表記ゆれを検知",
            icon: "symbol-text",
            requiresWork: true,
            detail:
              "同じ語が2通りで書かれている箇所を作品全体から探す\n\n" +
              "・「良い／よい」など\n\n" +
              "・どちらに揃えるかは組ごとに作者が選ぶ\n\n" +
              "AIは呼ばない。",
          },
          {
            kind: "action",
            command: "novelai.checkProofread",
            label: "推敲",
            icon: "edit",
            requiresWork: true,
            usesAI: true,
            detail:
              "読みにくい箇所だけの指摘\n\n" +
              "・冗長な言い回し・同じ語の繰り返し\n\n" +
              "・係り受けの曖昧さ・長すぎる文\n\n" +
              "・読みに詰まる漢字・語尾の単調さ\n\n" +
              // **上限の値を書き写さない**（2026-09-18 に 3 → 5 へ変えた）
              `・1000字あたり${MAX_ISSUES_PER_1000_CHARS}件まで\n\n` +
              "語彙・文体・描写の増減、書き方の癖には触れない。",
          },
          {
            kind: "action",
            command: "novelai.checkOpening",
            label: "冒頭を診断",
            icon: "telescope",
            requiresWork: true,
            usesAI: true,
            detail:
              "第1話の冒頭（約3,000字）だけの診断\n\n" +
              "・いつ・どこで・誰が・何を・なぜ・どのように が伝わるか\n\n" +
              "・続きを読みたくなる引きがあるか\n\n" +
              "本文は書き換えない。",
          },
          // ターゲット読者診断は、冒頭診断の隣に置く（設計書6.91）。
          // どちらも**読者にどう見えるか**を見る道具で、作者が見るのは
          // 同じ場所（冒頭）である
          {
            kind: "action",
            command: "novelai.runReaderTargetDiagnosis",
            label: "ターゲット読者診断",
            icon: "person",
            requiresWork: true,
            usesAI: true,
            detail:
              "この作品が誰に向いているかを2つの側から出す\n\n" +
              "・「向けているつもり」はいくつか答える（AIなし）\n\n" +
              "・「書けているもの」は冒頭とプロットをAIが読む\n\n" +
              "・値打ちはその差\n\n" +
              "・3つの軸（読み慣れ・読む姿勢・求めるもの）で11通り\n\n" +
              "・作品ごとに持てる\n\n" +
              "本文は書き換えない。",
          },
          // ターゲットシートは、ターゲット読者診断のすぐ下に置く
          // （設計書6.108）。**診断の点数をそのまま使う紙**なので、
          // 診断から遠いところにあると、先に何を押すのか分からない
          {
            kind: "action",
            command: "novelai.openTargetSheet",
            label: "ターゲットシート",
            icon: "target",
            requiresWork: true,
            detail:
              "狙っている読者層と、書けているものの実態を1枚に\n\n" +
              "・11の読者層それぞれとの一致度\n\n" +
              "・読者層を広げる・絞る の向かう先\n\n" +
              "・先に「ターゲット読者診断」が要る\n\n" +
              "・「狙い」の欄は作者が書く（作り直しても残る）\n\n" +
              "・作り直すたびに控えが残り、推移として並ぶ\n\n" +
              "AIは呼ばない。本文は書き換えない。",
          },
          // 3つの輪は、ターゲット読者診断の隣に置く（設計書6.101）。
          // どちらも**作品ごと**で、**読者から見た姿**を扱う。あちらが
          // 宛先を決める道具で、こちらはその宛先と実績・嗜好を並べる1枚
          {
            kind: "action",
            command: "novelai.showThreeCircles",
            label: "3つの輪",
            icon: "circle-outline",
            requiresWork: true,
            detail:
              "書けたもの・書きたいもの・読者が読みたいものを1枚に\n\n" +
              "・重なっているところと離れているところが見える\n\n" +
              "・材料は原稿と作品の記録から数える\n\n" +
              "・品定めではない。上下はなく、効く相手が違うだけ\n\n" +
              "AIは呼ばない。本文も記録も書き換えない。",
          },
          {
            kind: "action",
            command: "novelai.checkDeviations",
            label: "プロットからの逸脱",
            icon: "compass",
            requiresWork: true,
            usesAI: true,
            // 根拠は説明文の「先にプロットを書いておいてください」
            ...prerequisiteOf("novelai.checkDeviations"),
            detail:
              "プロットに無い展開・前へ進んでいない箇所の検知\n\n" +
              "・先にプロットが要る（「プロットを作る」か「本文からプロットを逆算」）\n\n" +
              "・プロットのほうが古いこともある\n\n" +
              "・伏線や人物の掘り下げは逸脱として扱わない\n\n" +
              "本文は書き換えない。",
          },
          // 単話プロットの判定は、作品全体の逸脱の隣に置く（設計書6.36.3）。
          // 物差しが「作品全体のプロット」か「その話の箇条書き」かの違いで、
          // 作者が見るのは同じ場面である
          {
            kind: "action",
            command: "novelai.checkEpisodePlot",
            label: "単話プロットを検査",
            icon: "check-all",
            requiresWork: true,
            usesAI: true,
            // 根拠は説明文の「先に『単話プロットを作る』で展開を書いて…」
            ...prerequisiteOf("novelai.checkEpisodePlot"),
            detail:
              "単話プロット（視点・目標・展開）の検査\n\n" +
              "・目標に向かっていない展開、停滞・重複を指摘\n\n" +
              "・本文を書いたあとなら箇条書きと本文の食い違いも\n\n" +
              "・どちらを掛けるかは実行時に選ぶ\n\n" +
              "・先に「単話プロットを作る」で展開を書いておく\n\n" +
              "本文もプロットも書き換えない。直し方も書かせない。",
          },
          {
            kind: "action",
            command: "novelai.checkContradictions",
            label: "矛盾を検知",
            icon: "warning",
            requiresWork: true,
            usesAI: true,
            // 前提（設定資料）と、代わりの道（下の「矛盾検知（事実の照合）」）。
            // **代わりの道が実際にある唯一の組**（設計書6.88）。
            // 中身は `core/prerequisites.ts` の表（外部AIの口と共用する）
            ...prerequisiteOf("novelai.checkContradictions"),
            detail:
              "設定資料と本文が食い違っている箇所の検知\n\n" +
              "・「設定ではこう／本文ではこう」を並べるだけ\n\n" +
              "・どちらを直すかは作者が決める（設定側が古いこともある）\n\n" +
              "・先に設定資料を抽出しておく\n\n" +
              "本文は書き換えない。",
          },
          // **矛盾検知の2つ目の道**（設計書6.88）。作者の裁定で
          // 「矛盾を検知」としばらく並行させるので、隣に並べて見比べられるようにする
          {
            kind: "action",
            command: "novelai.checkFactContradictions",
            label: "矛盾検知",
            // 「矛盾を検知」の隣に並ぶので、どちらの道かを補足で分ける。
            // **括弧は名前に入れない**（ビューは幅が狭い。actionList.test.ts）
            note: "事実の照合",
            icon: "warning",
            requiresWork: true,
            usesAI: true,
            detail:
              "本文から取り出した事実どうしの照合\n\n" +
              "・AIには「何が書いてあるか」だけを取り出させる\n\n" +
              "・食い違いの判定は拡張機能が機械的に行う\n\n" +
              "・候補だけを、もう一度AIが1件ずつ確かめる\n\n" +
              "・設定資料が無くても使える\n\n" +
              "本文は書き換えない。",
          },
          // 伏線は矛盾の隣に置く（設計書6.35.4）。矛盾検知の指摘から
          // 「伏線として登録」で飛んでくるので、行き先が近いほうが辿れる
          {
            kind: "action",
            command: "novelai.checkForeshadows",
            label: "伏線を検知",
            icon: "eye",
            requiresWork: true,
            usesAI: true,
            detail:
              "後の展開を予告・示唆している記述の検知\n\n" +
              "・謎めいた言及・意味ありげな小道具・説明されない違和感\n\n" +
              "・候補は右の列の「提案」パネルへ\n\n" +
              "・登録するものを1件ずつ選ぶ\n\n" +
              "・登録済みの伏線と重なる候補は出さない\n\n" +
              "伏線の記録へは何も自動で入らない。",
          },
          {
            kind: "action",
            command: "novelai.checkForeshadowResolution",
            label: "伏線の回収を確かめる",
            icon: "check-all",
            requiresWork: true,
            usesAI: true,
            detail:
              "未回収の伏線が、その後の話で回収されたかの確認\n\n" +
              "・回収済みの印も提案\n\n" +
              "・「提案」パネルの「伏線の回収」で1件ずつ決める\n\n" +
              "・未回収が無ければAIは呼ばない",
          },
          {
            kind: "action",
            command: "novelai.openForeshadows",
            label: "伏線の一覧",
            icon: "list-unordered",
            requiresWork: true,
            detail:
              "登録した伏線の一覧\n\n" +
              "・未回収のものが上\n\n" +
              "・「第◯話で張った」「第◯話で回収」と引用が並ぶ\n\n" +
              "AIは呼ばない。",
          },
          {
            kind: "action",
            command: "novelai.addForeshadow",
            label: "伏線を手で追加",
            icon: "add",
            requiresWork: true,
            detail:
              "短い名・何を示唆しているか・張った話数を入れて登録\n\n" +
              "・話数は空のままでよい\n\n" +
              "AIは呼ばない。",
          },
          {
            kind: "action",
            command: "novelai.setForeshadowStatus",
            label: "伏線の状態を変える",
            icon: "checklist",
            requiresWork: true,
            detail:
              "伏線を「回収済み」「意図して開けたまま」「未回収」に変える\n\n" +
              "・「意図して開けたまま」はここからしか選べない\n\n" +
              "AIは呼ばない。",
          },
          /*
            **検知の並びのすぐ後ろ、伏線の一覧の下に置く**（設計書6.96.4）。

            片づける相手は、この分類の検知が挙げた指摘そのものである。
            「作品ごとの設定」へ置くと、日数の設定と同じ棚に見えて
            **押すと消える操作**だと伝わらない。1日に何度も押すものでは
            ないので、毎日通る検知の下で構わない。
          */
          {
            kind: "action",
            command: "novelai.pruneFindings",
            label: "古い指摘を片づける",
            description: "AIを使わない",
            icon: "trash",
            requiresWork: true,
            detail:
              "保存日数（既定3日）を過ぎたAIの指摘を置き場から消す\n\n" +
              "・期限を過ぎた指摘は一覧から隠れているだけで、消えていない\n\n" +
              "・何件消えるかを見せて、確認してから消す\n\n" +
              "・消すと元に戻せない\n\n" +
              "本文にも設定資料にも触らない。",
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
              "開いているファイルを「校閲中」として押さえる\n\n" +
              "・作者が直そうとすると、誰がいつから見ているかが出る\n\n" +
              "・ファイル単位。他の話は今までどおり書ける\n\n" +
              "・終わったらもう一度押して外す",
          },
          {
            kind: "action",
            command: "novelai.reviewProposals",
            label: "編集部からの提案",
            icon: "inbox",
            requiresWork: true,
            detail:
              "編集部が出した直しの提案を1件ずつ確認\n\n" +
              "・採るか見送るかを決める\n\n" +
              "・本文に入るのは採ると決めたものだけ\n\n" +
              "編集部は本文を書き換えない。",
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
            label: "キャッチコピー案",
            icon: "megaphone",
            requiresWork: true,
            usesAI: true,
            detail:
              "方向性の違う3案を30字以内で\n\n" +
              "・謎・引き型／感情・関係性型／世界観・スケール型\n\n" +
              "・選ぶ・手直しする・別の案を出す から選べる\n\n" +
              "・採らなかった案は覚えて、次は違う案を出す",
          },
          {
            kind: "action",
            command: "novelai.generateWorkBlurb",
            label: "作品紹介文",
            icon: "book",
            requiresWork: true,
            usesAI: true,
            detail:
              "投稿サイトに載せる紹介文（300〜400字）の案\n\n" +
              "・材料はプロット・冒頭の本文・各話あらすじ\n\n" +
              "・見てから採用を決める",
          },
          {
            kind: "action",
            command: "novelai.generateAnnouncement",
            label: "更新告知文を作る",
            icon: "megaphone",
            requiresWork: true,
            usesAI: true,
            detail:
              "選んだ話の、ネタバレしない告知文\n\n" +
              "・X用・活動報告用・後書き用の3種\n\n" +
              "・ハッシュタグとURLは設定から付く\n\n" +
              "貼るのは作者。投稿サイトへは書き込まない。",
          },
          {
            kind: "action",
            command: "novelai.generateSynopses",
            label: "各話あらすじ",
            icon: "list-ordered",
            requiresWork: true,
            usesAI: true,
            detail:
              "話ごとの150字以内のあらすじ\n\n" +
              "・ファイル名が数字だけの話には15字以内のサブタイトル案も\n\n" +
              "・本文を変えていない話は作り直さない",
          },
        ],
      },
      /*
        **「その他支援」を2つに割った**（0.33.8、設計書6.17）。

        きっかけは相談へ渡す説明の束である。小分類ひとまとまりがそのまま
        1つの束になるので（`features/featureGuide.ts`）、20項目まで育った
        「その他支援」は1,499字——上限1,500の**1字下**だった。次の1操作で
        落ちる状態で、そこで上限を上げれば「送る量が機能数に比例する」
        行き止まり（設計書6.27）へ戻る。**上限ではなく小分類を割った。**

        **線は、作者が押す場面で引いた。** 原稿を書き、整えている最中に
        押す操作（ここ）と、書き上がったものを外へ出す操作（下の
        「投稿・書き出し」）は、同じ日でも違う時間に押す。「その他」に
        積んでいたのは分ける理由が無かったからではなく、**分ける手が
        入っていなかっただけ**である。

        **並び順は変えていない。** 割っただけなので、作者が覚えている
        上下の関係はそのまま残る。
      */
      {
        kind: "section",
        label: "原稿づくり",
        icon: "edit",
        items: [
          // **書き始めの2つを先頭に置く**（設計書6.36.4）。ここは
          // 「最新話を書く」への導線（縦書きで開く）と同じ小分類で、
          // 資料生成や新作開始の並びではない——どちらも、
          // **今日の続きを書き始めるとき**に通る操作である
          {
            kind: "action",
            command: "novelai.resumeWriting",
            label: "執筆を再開",
            description: "AIを使わない",
            icon: "debug-continue",
            requiresWork: true,
            detail:
              "前回どこまで書いたかを1枚にまとめて開く\n\n" +
              "・前話までのあらすじ・未回収の伏線・単話プロット\n\n" +
              "・押した瞬間に出る\n\n" +
              "AIは呼ばない。原稿は書き換えない。",
          },
          {
            kind: "action",
            command: "novelai.createEpisodePlot",
            label: "単話プロットを作る",
            description: "AIを使わない",
            icon: "checklist",
            requiresWork: true,
            detail:
              "その話の「視点・目標・展開」を書く雛形\n\n" +
              "・置き場は 設定/episode-plots/第N話.md\n\n" +
              "・既にあるものは上書きせず、そのまま開く\n\n" +
              "筋書きはAIに作らせない。書くのは作者。",
          },
          // **構成を組み立てる操作なので、書き始めの並びに置く**（設計書6.66.4）。
          // 原稿の誤りを探す「校正・校閲」でも、読者に見せる文章を作る
          // 「広報支援」でもなく、作者が作品の形を決めるための操作である
          {
            kind: "action",
            command: "novelai.proposeChapters",
            label: "章立てを提案させる",
            icon: "list-tree",
            requiresWork: true,
            usesAI: true,
            detail:
              "どこで章に区切るかと、その章の名前の案\n\n" +
              "・材料は話のサブタイトルと各話あらすじ\n\n" +
              "・案は提案パネルへ。承認した章だけが章立てに入る\n\n" +
              "本文は送らない。原稿は書き換わらない。",
          },
          // 章立ての提案のすぐ後に置く。どちらも作品の章の形を決める操作で、
          // こちらは原稿に残っている見出しをそのまま使う（AIを呼ばない）
          {
            kind: "action",
            command: "novelai.chaptersFromHeadings",
            label: "話の見出しから章を立てる",
            description: "AIを使わない",
            icon: "list-tree",
            requiresWork: true,
            detail:
              "話の頭に残っている【第1章】のような見出しを章立てにする\n\n" +
              "・なろうの合本を話ごとに分けた作品向け\n\n" +
              "・章立てが空の作品だけ。立てる前に一覧で確かめる\n\n" +
              "AIは呼ばない。原稿は書き換わらない。",
          },
          // **書き始めの並びに置く**（設計書6.40.4）。前回の付箋を見ながら
          // 続きを書くための画面で、資料生成や新作開始の仲間ではない
          {
            kind: "action",
            command: "novelai.openSceneMemos",
            // **「横に」まで書く**（コマンドパレットの名前と同じ）。
            // 開く場所が分かるので、原稿を隠されると思って避けられない
            label: "シーンメモを横に開く",
            description: "AIを使わない",
            icon: "note",
            requiresWork: true,
            detail:
              "本文の中の付箋（行頭が // の行）を原稿の横に一覧\n\n" +
              "・「次へ」「戻る」で話をまたいで飛べる\n\n" +
              "・メモは投稿用・PDF・文字数にもAIにも渡らない\n\n" +
              "AIは呼ばない。",
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
              "本文の .txt を .md に変える\n\n" +
              "・ルビやプレビューが使えるようになる\n\n" +
              "・直すのは名前と、投稿サイトの書き方のルビ・傍点だけ\n\n" +
              "・字そのもの・文字コード・改行はそのまま\n\n" +
              "・作品ぜんぶか、開いている1件かを選べる\n\n" +
              "直す前の本文は控えが残る。",
          },
          // **改行コードの食い違いは、外のツールで表に出る**（設計書5.4.2）。
          // MD化の隣に置く——どちらも「原稿の中身ではなく、入れ物の形を
          // 揃える」操作で、作者が押したときだけ動く
          {
            kind: "action",
            command: "novelai.unifyEol",
            label: "改行コードを揃える",
            description: "AIを使わない",
            icon: "list-selection",
            requiresWork: true,
            detail:
              "多数派と違う改行コード（LF / CRLF）をまとめて揃える\n\n" +
              "・他のツールで開いたときの全行変更・行ずれを防ぐ\n\n" +
              "・押したときだけ変える。保存や同期では揃えない\n\n" +
              "本文は1文字も変えない（文字コードも末尾の改行もそのまま）。",
          },
          // **Word で書いてきた作者の入口**（設計書6.85）。.txt のMD化の
          // 隣に置く——やりたいことは同じ「原稿をこの拡張機能で扱える形に
          // する」であり、元の形が違うだけである
          {
            kind: "action",
            command: "novelai.convertDocxToMarkdown",
            label: "Word 原稿の変換",
            note: "docx をまとめて変換",
            description: "AIを使わない",
            icon: "file-code",
            // 作品の外にある .docx も変換できる（登録前の原稿がふつう）
            requiresWork: false,
            detail:
              "フォルダーの中の Word 文書（.docx）をまとめて .md に\n\n" +
              "・ルビは {漢字|かんじ}、傍点は {{強調}} として持ち帰る\n\n" +
              "・元の .docx はそのまま残る\n\n" +
              "・同じ名前の .md があれば上書きしない\n\n" +
              "・画像・表・脚注・コメントは入らない（件数は知らせる）\n\n" +
              "・古い形式の .doc は不可。Word で .docx に保存し直す",
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
              "開いている本文を縦書きの画面で開き直す\n\n" +
              "・ルビと傍点が振り仮名・圏点として出る\n\n" +
              "・用語が色分けされ、右クリックから設定資料へ\n\n" +
              "・横書きへの切り替えと投稿サイト用のコピーも同じ画面",
          },
          // **耳で聞くと、目では気づかないものが見つかる**（設計書6.42）。
          // 原稿エディタを開く操作の直後に置く——読み上げはあの画面の中の
          // 機能で、資料生成や新作開始の仲間ではない
          {
            kind: "action",
            command: "novelai.readManuscriptAloud",
            label: "原稿を読み上げる",
            note: "音読推敲",
            description: "AIを使わない",
            icon: "unmute",
            usesAI: false,
            requiresWork: true,
            detail:
              "原稿エディタを開いて、読み上げの列を出す\n\n" +
              "・読んでいる文を光らせながら進む\n\n" +
              "・「引っかかった」でシーンメモを残す（そこで一時停止）\n\n" +
              "・OSの声で読む。料金はかからない\n\n" +
              "原稿は外へ出ない。メモの1行以外は書き換えない。",
          },
          // **声で書いた分を、本文の形へ直す**（設計書6.83）。読み上げの
          // 隣に置く——どちらも原稿エディタの中の機能で、耳と口で書くための
          // 道具である（資料生成や新作開始の仲間ではない）
          {
            kind: "action",
            command: "novelai.dictationClean",
            // 開いているファイルに対して働くので、作品の登録は要らない
            requiresWork: false,
            label: "口述した文を整える",
            icon: "mic",
            usesAI: true,
            detail:
              "声で入れた文に句読点と改行を入れて整える\n\n" +
              "・同音異義の誤変換を直す\n\n" +
              "・文頭の「えーと」のような言いよどみを取る\n\n" +
              "・対象は選んだところ（原稿エディタなら下段の「口述」→「整える」）\n\n" +
              "・Ctrl+Z で元に戻せる\n\n" +
              "・声を文字にするのはOSの音声入力\n\n" +
              "・Windows：Win+H／macOS：fnキー2回\n\n" +
              "言葉は足さない・削らない・言い換えない。",
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
              "選んだ文字にルビ（振り仮名）を付ける\n\n" +
              "・漢字の直後なら、選ばなくても拾う\n\n" +
              "・使えるのは Markdown（.md）のファイルだけ\n\n" +
              "・プレビュー（Ctrl+Shift+V）で振り仮名として出る",
          },
          {
            kind: "action",
            command: "novelai.addEmphasis",
            requiresWork: false,
            hiddenFromActionList: true,
            label: "傍点を付ける",
            icon: "three-bars",
            detail:
              "選んだ文字に傍点（強調の点）を付ける\n\n" +
              "・範囲を選んでから押す\n\n" +
              "・使えるのは Markdown（.md）のファイルだけ",
          },
        ],
      },
      /*
        **書き上がったものを外へ出す操作**（0.33.8）。投稿・印刷・電子書籍・
        設定資料の受け渡し・IME辞書。上の「原稿づくり」から割った片割れで、
        並び順は割る前のままである。

        **投稿サイトのルビを取り込む**だけは向きが逆（外から入れる）が、
        投稿サイトとのやり取りという場面は同じなので、こちらへ置く。
      */
      {
        kind: "section",
        label: "投稿・書き出し",
        icon: "export",
        // 分類と操作の両方に出しても、その間の小分類に無いと辿れない（6.17.1）。
        // **印は「IME辞書を出力」が入っているこちらへ付ける**——割ったときに
        // 置き去りにすると、閉じたままの小分類で古びていることに気づけない
        counter: "staleImeDictionary",
        items: [
          {
            kind: "action",
            command: "novelai.copyForPosting",
            // 開いているファイルに対して働くので、作品の登録は要らない
            requiresWork: false,
            label: "投稿サイト用に変換してコピー",
            icon: "clippy",
            detail:
              "ルビを ｜漢字《かんじ》 に直してクリップボードへ\n\n" +
              "・なろう・カクヨム・アルファポリス・ネオページに貼れる\n\n" +
              "・傍点が入っているときだけ貼り付け先を訊く\n\n" +
              "原稿は書き換えない。",
          },
          // **投稿の入口は「投稿サイト用にコピー」の隣に置く**（設計書6.68）。
          // 1話ぶんの貼り付け作業を、変換・コピー・ページを開く・記録まで
          // ひと続きにしたもの——同じ場面で使う操作なので、隣に並べる
          {
            kind: "action",
            command: "novelai.postNewEpisode",
            label: "新話を投稿",
            description: "AIを使わない",
            icon: "rocket",
            requiresWork: true,
            detail:
              "未投稿の話の、変換→コピー→投稿ページ→記録の案内\n\n" +
              "・なろう・カクヨム・アルファポリス・note\n\n" +
              "・「ヘルパーへ渡す形でコピー」も選べる\n\n" +
              "・統合小説執筆環境ヘルパーはブラウザ拡張。投稿画面の欄を埋める\n\n" +
              "・送信は作者が行う\n\n" +
              "この拡張機能が投稿サイトへ書き込むことはない。原稿も書き換えない。",
          },
          {
            kind: "action",
            command: "novelai.configurePostingSites",
            label: "投稿サイトの設定",
            description: "AIを使わない",
            icon: "settings-gear",
            requiresWork: true,
            detail:
              "この作品を出すサイトの追加・変更・取り外し\n\n" +
              "・投稿ページのURLの変更\n\n" +
              "・「どの話まで投稿済みか」の引き直し\n\n" +
              "・作品ID・作品ページのURL・ジャンル（どれも空でよい）\n\n" +
              "サイトを外しても、これまでの投稿の記録は消えない。",
          },
          // **設定の隣に置く**（設計書6.68.5）。作品情報を入れる画面と、
          // そこで見た順位を書き足す操作は、同じ場面で使う
          {
            kind: "action",
            command: "novelai.recordRanking",
            label: "ランキングを記録",
            description: "AIを使わない",
            icon: "graph",
            requiresWork: true,
            detail:
              "投稿サイトで見た順位の書き留め\n\n" +
              "・訊くのはサイト→種別→順位の3つ\n\n" +
              "・履歴は執筆量パネルの「サイトの記録」\n\n" +
              "サイトから自動で取ってくることはない。",
          },
          // **順位の隣に置く**（設計書6.79.7）。どちらも「投稿したあとに
          // サイトで見た数字を書き留める」操作で、使う場面が同じである
          {
            kind: "action",
            command: "novelai.importReaderStats",
            label: "読者の反応を取り込む",
            description: "AIを使わない",
            icon: "clippy",
            requiresWork: true,
            // 「〜ない」で終わる断りは、相談へ渡す束にも残る（`featureGuide` の
            // `shorten`）。**しないことの断りは、言い切りの文で書く**
            detail:
              "ヘルパーが読んだPV・評価などを投稿の記録へ書き足す\n\n" +
              "・統合小説執筆環境ヘルパーはブラウザ拡張。クリップボード経由で受け取る\n\n" +
              "・対応はカクヨムとアルファポリスだけ（ほかは手入力）\n\n" +
              "この拡張機能が投稿サイトへ通信することはない。",
          },
          {
            kind: "action",
            command: "novelai.recordReaderStats",
            label: "読者の反応を手入力",
            description: "AIを使わない",
            icon: "heart",
            requiresWork: true,
            detail:
              "サイトで見たPV・評価・いいねの書き留め\n\n" +
              "・訊くのはサイト→範囲→粒度→数値の順\n\n" +
              "・読めた数字だけでよい\n\n" +
              "・履歴は執筆量パネルの「サイトの記録」\n\n" +
              "サイトから自動で取ってくることはない。",
          },
          {
            kind: "action",
            command: "novelai.importRuby",
            // 開いているファイルに対して働くので、作品の登録は要らない
            requiresWork: false,
            label: "投稿サイトのルビを取り込む",
            icon: "arrow-down",
            detail:
              "｜漢字《かんじ》 を ｛漢字｜かんじ｝ の形へ直す\n\n" +
              "・すでに投稿した原稿を持ち込んだときに使う\n\n" +
              "・何件変わるかを先に見せる",
          },
          {
            kind: "action",
            command: "novelai.generateSettingsDocs",
            label: "設定資料集を出力",
            description: "AIを使わない",
            icon: "export",
            requiresWork: true,
            detail:
              "抽出済みのJSONから、読むための設定資料集を書き出す\n\n" +
              "・種別は人物・場所・能力・組織・世界観・各話あらすじ\n\n" +
              "・JSONの手直しや、まとめ・更新の反映のあとに使う\n\n" +
              "AIは呼ばない。",
          },
          {
            kind: "action",
            command: "novelai.exportSettingsForAudience",
            label: "提供先を選んで書き出す",
            description: "AIを使わない",
            icon: "mail",
            requiresWork: true,
            detail:
              "渡す相手に合わせて項目を絞った設定資料を1ファイルに\n\n" +
              "・編集部向け／イラスト・デザイン発注向け／紹介向け\n\n" +
              "・「第N話までの情報だけ」も選べる\n\n" +
              "・含めた項目と含めなかった項目はファイルの冒頭に\n\n" +
              "AIは呼ばない。",
          },
          {
            kind: "action",
            command: "novelai.exportPdf",
            label: "PDF出力",
            note: "印刷用",
            description: "AIを使わない",
            icon: "file-pdf",
            requiresWork: true,
            detail:
              "本文を印刷用に組版してブラウザで開く\n\n" +
              "・ブラウザの印刷で「PDFに保存」を選ぶとPDFに\n\n" +
              "・縦書き（文庫・A5）と横書き（A4）\n\n" +
              "・ルビ・傍点も組む\n\n" +
              "原稿は書き換えない。AIは呼ばない。",
          },
          // **エディターが上、書き出しが下**（作者の指定、2026-09-04）。
          // 「本を編んでから出す」という作業の順に合わせる
          {
            kind: "action",
            command: "novelai.openEpubEditor",
            label: "EPUBエディター",
            note: "試作",
            description: "AIを使わない",
            icon: "book",
            requiresWork: true,
            detail:
              "本の見た目を確かめながら決める画面\n\n" +
              "・書誌情報・組み方・目次・奥付・表紙・挿絵・登場人物一覧・書体\n\n" +
              "・左を変えると、右のプレビューが書き出しと同じ組版で追従\n\n" +
              "・表紙と裏表紙は、元イラストに題名や作者名を重ねて焼ける\n\n" +
              "・挿絵とページ分割は段落を選んで置く\n\n" +
              "・保存先は `設定/書籍/book.json`。そのまま書き出せる\n\n" +
              "原稿は書き換えない。AIは呼ばない。",
          },
          {
            kind: "action",
            command: "novelai.exportEpub",
            label: "EPUBを書き出す",
            note: "試作",
            description: "AIを使わない",
            icon: "book",
            requiresWork: true,
            // **エディター内の書き出しボタンに一本化**（作者の指定、
            // 2026-09-04）。コマンド自体はエディターから使うので木には残す
            hiddenFromActionList: true,
            // 「まだ土台の段階です」と書いていたら、相談の束選びが
            // 「この段落は…」という本文の相談に当たってしまった
            // （二文字組みの「の段」で拾われる）。言い回しで避ける
            detail:
              "本文をEPUB3に組んで `.aiwriter/exports/` へ書き出す\n\n" +
              "・Kindle・honto などのリーダーで開ける\n\n" +
              "・縦書き・横書き、ルビ・傍点、目次、奥付\n\n" +
              "・表紙と裏表紙（題名を重ねて焼いた画像も使える）\n\n" +
              "・話の途中の挿絵とページ分割、登場人物一覧、同梱する書体\n\n" +
              "・書誌情報や挿絵の位置は `設定/書籍/book.json`\n\n" +
              "・EPUBエディターで編める。無ければ作品名で組む\n\n" +
              "原稿は書き換えない。AIは呼ばない。",
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
              "作品の固有名詞と造語を、IMEのユーザー辞書の形で書き出す\n\n" +
              "・人物・場所・能力・組織と造語\n\n" +
              "・取り込むと変換候補に出るようになる",
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
              "本文から人物・場所・スキル・組織・世界観をまとめて抽出\n\n" +
              "・続けて設定資料集も作る\n\n" +
              "・種別ごとに実行するより一度で済む。最初はこれ",
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
              "本文から登場人物だけを取り出して保存\n\n" +
              "・既にいる人物への変更は「更新分を反映」へ回す\n\n" +
              "・「まとめて抽出」済みならAIは呼び直さない",
          },
          {
            kind: "action",
            command: "novelai.extractLocationsOnly",
            label: "場所を抽出",
            icon: "location",
            requiresWork: true,
            usesAI: true,
            detail:
              "本文から場所だけを取り出して保存\n\n" +
              "・「まとめて抽出」済みならAIは呼び直さない",
          },
          {
            kind: "action",
            command: "novelai.extractAbilitiesOnly",
            label: "スキルを抽出",
            icon: "zap",
            requiresWork: true,
            usesAI: true,
            detail:
              "本文から能力だけを取り出して保存\n\n" +
              "・呼び方は作品に合わせる（スキル・魔法など）\n\n" +
              "・「まとめて抽出」済みならAIは呼び直さない",
          },
          {
            kind: "action",
            command: "novelai.extractOrganizationsOnly",
            label: "組織を抽出",
            icon: "organization",
            requiresWork: true,
            usesAI: true,
            detail:
              "本文から組織だけを取り出して保存\n\n" +
              "・人物の所属からも拾う\n\n" +
              "・「まとめて抽出」済みならAIは呼び直さない",
          },
          {
            kind: "action",
            command: "novelai.extractWorldOnly",
            label: "世界観を抽出",
            icon: "globe",
            requiresWork: true,
            usesAI: true,
            detail:
              "本文から世界観だけを取り出して保存\n\n" +
              "・「まとめて抽出」済みならAIは呼び直さない",
          },
          {
            kind: "action",
            command: "novelai.unifyCharacters",
            label: "重複をまとめる",
            icon: "merge",
            requiresWork: true,
            counter: "mergeCandidates",
            detail:
              "同じ人物が別々に登録されてしまった組をまとめる\n\n" +
              "・「リン」と「リンセップ・アウクト」など\n\n" +
              "・どちらの名前を残すかは作者が選ぶ",
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
              "抽出で見つかった既存人物への更新の反映\n\n" +
              "内容を確認するまで書き換えない。",
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
              "抽出した登場人物・能力・場所・組織・世界観の一覧\n\n" +
              "・その場で書き換えられる\n\n" +
              "・AIに項目を埋めさせる、相談する もできる",
          },
          {
            kind: "action",
            command: "novelai.openRelationGraph",
            label: "人物相関図",
            icon: "type-hierarchy",
            requiresWork: true,
            // 材料は抽出済みの関係・呼称・所属で、AIは呼ばない
            detail:
              "登場人物のつながりの図\n\n" +
              "・作品全体を円で見る図と、1人を中心に見る図\n\n" +
              "・人物詳細の「相関図」からは、その人を中心に開く\n\n" +
              "・材料は抽出済みの関係・呼称・所属だけ\n\n" +
              "AIは呼ばない。",
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
              "作品紹介文と各話あらすじのプレビュー\n\n" +
              "・synopsis.md と synopses.md\n\n" +
              "・感情曲線（各話の盛り上がりの推移）もこの中\n\n" +
              "・まだ無ければ、作る操作を案内",
          },
          {
            kind: "action",
            command: "novelai.checkNames",
            label: "名前の点検",
            icon: "symbol-key",
            requiresWork: true,
            // 判定そのものはAIを使わない。画面の中の「候補を出す」だけがAI
            detail:
              "響きの重なっている名前の洗い出し\n\n" +
              "・「ミナ」と「ミナモト」、「アリア」と「アリサ」など\n\n" +
              "・判定は読みと表記の規則だけ\n\n" +
              "・人物ごとの登場箇所を見て、その行へ飛べる\n\n" +
              "・AIを使うのは画面の中の「候補を出す」だけ",
          },
          {
            kind: "action",
            command: "novelai.renameCharacter",
            label: "名前を付け替える",
            icon: "replace-all",
            requiresWork: true,
            detail:
              "登場人物の名前を、姓・名・別名までまとめて付け替え\n\n" +
              "・対応表を確かめてから走る\n\n" +
              "・本文の置き換えは提案パネルへ（1件ずつも、まとめても）\n\n" +
              "押しただけでは本文は変わらない。",
          },
          {
            kind: "action",
            command: "novelai.addWorkMemo",
            label: "メモを追加",
            icon: "note",
            requiresWork: true,
            detail:
              "この作品のためのメモを1つ作る\n\n" +
              "・置き場は `設定/メモ/題名.md`\n\n" +
              "・作品一覧の「メモ」の枝から開ける\n\n" +
              "・創作メモ集からは右クリックの「このメモを作品へ移管」で移せる\n\n" +
              "話数・文字数・あらすじ・投稿・校正のどれにも入らない。",
          },
          {
            kind: "action",
            command: "novelai.applyRenameToRecords",
            label: "名前の付け替えを資料にも反映",
            icon: "references",
            requiresWork: true,
            detail:
              "直前の付け替えを設定資料・プロット・あらすじ・伏線の記録にも\n\n" +
              "・本文の適用が終わってから実行\n\n" +
              "作者メモと資料用の補足には触らない。",
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
        label: "作者／編集者の切り替え",
        icon: "person",
        requiresWork: false,
        // **詳細メニューには出さない**（作者の指示、2026-08-31）。
        // 設定管理の `novelai.mode` から切り替える。
        // 簡単ステップメニューの「編集部校正・校閲」からは今までどおり使う
        hiddenFromActionList: true,
        detail:
          "この環境を「編集者」として使う状態への切り替え\n\n" +
          "・編集者は本文の校正・校閲だけを行える\n\n" +
          "・編集部の方と一緒に書くときに使う\n\n" +
          "・いつでも作者へ戻せる\n\n" +
          "編集者モードでは、本文を書き換えず提案として置く。",
      },
      {
        kind: "action",
        command: "novelai.openExtensionSettings",
        label: "設定管理",
        icon: "settings",
        requiresWork: false,
        detail:
          "文字数の数え方・執筆目標・AIの応答待ち時間などの設定\n\n" +
          "・この拡張機能の設定だけを絞り込んで出す",
      },
      /*
        **設定管理へしまう**（作者の指定、2026-09-13。設計書6.56.3）。

        「訊かないことにした確認を見直す」は、押す機会がめったに無い
        後始末である。表に出しておくと、日々使う操作の中に混ざって
        目が滑る（4つの設定を移したときと同じ判断）。

        **消さずに、しまう。** コマンドパレットからは今までどおり呼べ、
        設定管理の `novelai.confirm.remembered` の説明からも押せる。
      */
      {
        kind: "action",
        command: "novelai.manageConfirmSkips",
        hiddenFromActionList: true,
        label: "訊かない確認の見直し",
        icon: "question",
        requiresWork: false,
        detail: "「以降は訊かない」にした確認を、また訊くように戻す",
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

          /*
            **「執筆データ」から移した**（0.66.2。作者の実機確認、2026-09-16
            「どこに表示されるかわからなかった」）。執筆統計や年表と並んでいて、
            **安全の設定を探している人の目には入らなかった。**

            **許可は作品ごとに決めるもの**なので、ここが置き場所として正しい。
          */
          {
            kind: "action",
            command: "novelai.toggleExternalAccess",
            label: "外部AIの許可と取り消し",
            icon: "shield",
            requiresWork: true,
            note: "MCPサーバー経由",
            detail:
              "外部のAIにこの作品を読ませるかの設定\n\n" +
              "・相手は Claude Code など\n\n" +
              "・既定は拒否。許可するまで外からは1文字も読めない\n\n" +
              "・許可は接続元ごと・道具ごと。使おうとしたときに画面で訊く\n\n" +
              "・いま許可しているものを見て取り消せる\n\n" +
              "・読まれた記録は「編集履歴」で確認",
          },
          /*
            **許可の隣に置く**（設計書6.87.15 柱5）。指示書を置くことと、
            外から読ませてよいと決めることは**別々**で、どちらも作品ごとに
            決める。並べておかないと、指示書を置いただけで「読めるように
            なった」と読まれる。
          */
          {
            kind: "action",
            command: "novelai.writeAiInstructions",
            label: "AI用の指示書を作品に置く",
            icon: "book",
            requiresWork: true,
            note: "Claude Code・Codex・Gemini CLI ほか",
            detail:
              "外部のAI向けの決まりを書いた指示書を作品フォルダーへ置く\n\n" +
              "・相手は複数選べる（中身は同じ。置き先と頭の数行だけが違う）\n\n" +
              "・MCPサーバーの登録（`.mcp.json` など）も一緒に書く\n\n" +
              "・既にあるファイルは、退避を訊いてから置き換える\n\n" +
              "・読ませるかは「外部AIの許可と取り消し」で決める\n\n" +
              "置いただけでは、外部AIはまだ1文字も読めない。",
          },
          {
            kind: "action",
            command: "novelai.setWorkGoals",
            label: "この作品の目標",
            icon: "target",
            requiresWork: true,
            detail:
              "作品ごとの目標の設定\n\n" +
              "・1記事あたりの目標文字数（文字数一覧の「長い・短い」の基準に）\n\n" +
              "・応募先の締切日・作品の文字量・日間目標\n\n" +
              "・入れると執筆量パネルに「あと何日・あと何字・1日あたり何字」\n\n" +
              "・設定の1日・1月の目標は全作品で共有",
          },
          {
            kind: "action",
            command: "novelai.setPlotBasics",
            label: "形式とジャンル",
            icon: "tag",
            requiresWork: true,
            detail:
              "短編・短編集・長編・大長編・SNS記事とジャンルの選択\n\n" +
              "・選んだ内容はプロットへ書く\n\n" +
              "・ジャンルにはどこの投稿先のものかを添える\n\n" +
              "・なろう20・カクヨム12・アルファポリス16・ネオページ59\n\n" +
              "・投稿先は複数選べる\n\n" +
              "プロットの他の部分には触らない。",
          },
          {
            kind: "action",
            command: "novelai.manageCustomFields",
            label: "一覧に項目を増やす",
            icon: "list-selection",
            requiresWork: true,
            detail:
              "人物設定に、作品に必要な項目を足す\n\n" +
              "・「誕生日」「身長」など\n\n" +
              "・足した項目は全員の設定資料に並ぶ\n\n" +
              "外しても入力済みの内容は消えない。",
          },
          {
            kind: "action",
            command: "novelai.configureAnnouncement",
            label: "告知の設定",
            note: "ハッシュタグ・URL",
            icon: "gear",
            requiresWork: true,
            detail:
              "更新告知に付けるハッシュタグと作品ページのURL\n\n" +
              "・作品ごとに覚える（告知のたびに入れ直さない）",
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
              "使うAIとモデルの選択\n\n" +
              "・Ollama・Gemini・ChatGPT・Claude から選ぶ",
          },
          {
            kind: "action",
            // **詳細メニューには出さない**（設定管理へ移した。設計書6.56.3）
            hiddenFromActionList: true,
            command: "novelai.assignFeatureAI",
            label: "機能ごとのAI割当",
            icon: "list-selection",
            requiresWork: false,
            detail:
              "機能ごとに使うAIを分ける\n\n" +
              "・割り当てない機能は、AI設定で選んだ既定のAIを使う\n\n" +
              "・いちばん重い設定資料の抽出は手元の無料AI（Ollama）で実用になる",
          },
          {
            kind: "action",
            command: "novelai.testAI",
            label: "AI接続の確認",
            icon: "plug",
            requiresWork: false,
            detail:
              "設定したAIに接続できるかの確認\n\n" +
              "・抽出が失敗するときは、まずここ",
          },
          {
            kind: "action",
            command: "novelai.measureContext",
            label: "AIチューニング",
            note: "測って設定を合わせる",
            icon: "symbol-ruler",
            requiresWork: false,
            usesAI: true,
            detail:
              "そのモデルが実際に読める長さと、必要な待ち時間の実測\n\n" +
              // **押してから選ぶ**（作者の依頼、2026-09-13）。読める長さは
              // 数分、書ける長さは遅いモデルで1時間以上かかる
              "・押すと「読める長さだけ」「書ける長さだけ」「両方」から選ぶ\n\n" +
              "・読める長さだけなら数分\n\n" +
              "・測った値は、いま選んでいるモデルの設定として覚える\n\n" +
              "・有料AIでは実行前に見込みを出す",
          },
          {
            kind: "action",
            command: "novelai.showTuningStats",
            label: "AIチューニングの実測一覧",
            icon: "graph",
            requiresWork: false,
            // **AIの印は付けない。** 測った値を並べるだけで、AIを呼ばない
            // （有料AIでも料金は出ない）
            detail:
              "AIチューニングで測った値の、モデルごとの一覧\n\n" +
              "・出力の速い順に並ぶ\n\n" +
              "測り直さない。AIは呼ばない。",
          },
          {
            kind: "action",
            command: "novelai.forgetTuning",
            label: "AIチューニングの記録を消す",
            icon: "trash",
            requiresWork: false,
            // 記録を消すだけで、AIは呼ばない
            usesAI: false,
            detail:
              "測った記録をモデルごとに消す\n\n" +
              "・同梱の値は消せない（測り直すと上書きされる）",
          },
          {
            kind: "action",
            // **詳細メニューには出さない**（設定管理へ移した。設計書6.56.3）
            hiddenFromActionList: true,
            command: "novelai.selectOllamaExecutable",
            label: "Ollamaの実行ファイル",
            icon: "folder-opened",
            requiresWork: false,
            detail:
              "ollama.exe の場所の指定\n\n" +
              "・Ollamaを自動で見つけられないときに使う",
          },
          // 流し受信の入切は、0.43.x で配布版の設定
          // `novelai.ollama.streaming` になった。開発ビルド限定の
          // 切り替えボタンは 0.45.0 で撤去（設計書6.63.1）
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
            label: "セットアップ",
            note: "必要なものを入れる",
            icon: "checklist",
            requiresWork: false,
            detail:
              "足りないものを一覧で見せて、選んだものを入れる\n\n" +
              "・Ollama本体・会話モデル・埋め込みモデル・Git・GitHub CLI\n\n" +
              "・それぞれ何のために要るのかも並べる\n\n" +
              "・入れる前に、何を・どれだけ取得するかを必ず確認\n\n" +
              "拡張機能を入れただけでは、AIを使う機能は動かない。",
          },
          {
            kind: "action",
            // **詳細メニューには出さない**（設定管理へ移した。設計書6.56.3）
            hiddenFromActionList: true,
            command: "novelai.setupOllama",
            label: "Ollamaの導入",
            icon: "cloud-download",
            requiresWork: false,
            detail:
              "無料でオフラインでも使えるOllamaの導入案内\n\n" +
              "・入っているか・起動しているか・モデルがあるかを順に確認\n\n" +
              "・足りないものだけを案内",
          },
          {
            kind: "action",
            // **詳細メニューには出さない**（設定管理へ移した。設計書6.56.3）
            hiddenFromActionList: true,
            command: "novelai.setupLmStudio",
            label: "LM Studioの導入",
            icon: "cloud-download",
            requiresWork: false,
            detail:
              "鍵も課金も要らない、もう1つの手元のAIの導入案内\n\n" +
              "・起動・サーバーの開始・モデルの読み込みはLM Studioの画面で\n\n" +
              "・手順を案内して、できたところで確かめ直す",
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
            label: "意味検索の準備",
            note: "ベクトルDB",
            icon: "search-fuzzy",
            requiresWork: false,
            detail:
              "質問に近い場面を本文・設定資料・あらすじから探して渡す仕組み\n\n" +
              "・入れなくても語句一致で探す\n\n" +
              "・入れると言い換えでの質問にも当たりやすくなる\n\n" +
              "・モデルの取得（約1.2GB）と作品ごとの索引づくりが要る\n\n" +
              "・非力な機械では入れないままでよい",
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
              "作品の本文・設定資料・あらすじから索引を作る\n\n" +
              "・変わっていない場面は作り直さない\n\n" +
              "・手元のOllamaで行う。料金はかからない",
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
              "この作品の索引を消す\n\n" +
              "・相談は語句一致に戻る（言い換えで見つけにくくなる）\n\n" +
              "・消すのは置き場所が足りないときと、索引が壊れたとき\n\n" +
              "・いつでも作り直せる\n\n" +
              "本文・設定資料・あらすじは何も変わらない。",
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
      /*
        **いちばん上は診断。** はじめて開いた人が知りたいのは
        「全部の機能」ではなく「自分は何から始めればよいか」である
        （設計書6.90）。マニュアルは、その次に読むものでよい。
      */
      {
        kind: "action",
        command: "novelai.runWriterDiagnosis",
        label: "作家タイプ診断",
        note: "はじめの案内",
        icon: "compass",
        requiresWork: false,
        detail:
          "いくつか答えると、書き方に合わせて次にすることを案内\n\n" +
          "・いまある原稿の取り込み方・書き始め方・直し方・出し方\n\n" +
          "・なぜそれを勧めるのかも添える\n\n" +
          "AIは呼ばない。",
      },
      // **マニュアルはその次。** 何ができるのかを一望したい人が来る
      {
        kind: "action",
        command: "novelai.openManual",
        label: "使い方",
        note: "マニュアル",
        icon: "book",
        requiresWork: false,
        detail:
          "この拡張機能でできることを1つの文書にまとめて開く\n\n" +
          "・作品づくりの流れ・全部の操作・画面の説明\n\n" +
          "・いま入っている版から作る\n\n" +
          "保存はしない（閉じてよい）。",
      },
      {
        kind: "action",
        command: "novelai.showLog",
        label: "ログを開く",
        icon: "output",
        requiresWork: false,
        detail:
          "AIが返したエラーの詳細の記録\n\n" +
          "・抽出が失敗して理由が分からないときに開く",
      },
      {
        kind: "action",
        command: "novelai.openChatLog",
        label: "相談のログ",
        icon: "comment-discussion",
        requiresWork: true,
        detail:
          "AIとの相談のやり取りの記録\n\n" +
          "・何を材料にAIが何を答えたかを後から確かめられる\n\n" +
          "・渡した場面・検索語・所要時間つき\n\n" +
          "・原稿の一部を含む\n\n" +
          "・残さないなら設定 `novelai.chatLog.enabled` を切る\n\n" +
          "GitHubへは送らない。",
      },
      {
        kind: "action",
        command: "novelai.diagnoseWeb",
        label: "動作を診断",
        note: "ブラウザ版の確認用",
        icon: "pulse",
        requiresWork: false,
        // **手元のVS Codeでは出さない**（作者の指定、2026-08-26）。
        // ブラウザ版で保存できないときの切り分けに作ったもので、手元では
        // 出番が無い。手元で要るときはコマンドパレットから呼べる
        browserOnly: true,
        detail:
          "いまの環境でファイルに何ができるかを実際に試す\n\n" +
          "・フォルダーを作る・書く・読む・移す・消す\n\n" +
          "・使い捨ての場所で試して、終わったら消す\n\n" +
          "・ブラウザ版で保存できないときの原因調べに使う\n\n" +
          "原稿には触らない。",
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
          "この拡張機能の版と、いまの環境の表示\n\n" +
          "・VS Codeの版・選んでいるAI・意味検索の入切\n\n" +
          "・そのまま貼り付けられる形でコピーできる\n\n" +
          "・変更履歴もここから開ける",
      },
    ],
  },
];

// 0.45.0 まで、この下に「テスト中」の分類を機械的に足していた
// （`docs/実機確認リスト.md` から作った写し）。統合テストと機械の確認が
// 育ち、F5の道具ごと撤去した（作者の指示、2026-09-10。設計書6.26）。

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
  return "「作品一覧」の「フォルダから作品を追加」または「新規作品を作成」から登録。";
}

/** 木の中の操作をすべて取り出す（テストと整合性の確認用） */
export function allActions(): ActionItem[] {
  return ACTION_TREE.flatMap((group) =>
    group.entries.flatMap((entry) =>
      entry.kind === "section" ? entry.items : [entry]
    )
  );
}

/** コマンドIDから操作を引く。木に無ければ undefined */
export function findAction(command: string): ActionItem | undefined {
  return allActions().find((item) => item.command === command);
}

/**
 * ラベルとコマンドIDだけの一覧（設計書6.104。0.75.6）。
 *
 * AI の答えの中で名指しされた項目を拾う（`core/menuMentions.ts`）ときの
 * 照合先である。**この木だけで足りる**——簡単ステップメニューは操作の実体を
 * 持たず、コマンドIDでここを参照している（`stepMenu.ts` の `actionIndex`）ので、
 * **どちらのメニューに出る項目も、すべてここに居る。**
 */
export function menuEntries(): { label: string; command: string }[] {
  return allActions().map((item) => ({
    label: item.label,
    command: item.command,
  }));
}

/**
 * 前提の1行（相談・マニュアル・画面で同じ文を使う）。
 *
 * **代わりの道の名前は、木から引く。** ここで書き写すと、あちらの名前を
 * 変えたときにこの1行だけが古くなる（`stepMenu.ts` と同じ考え方）。
 */
export function prerequisiteNoteOf(item: ActionItem): string {
  const alternative = item.insteadOf
    ? findAction(item.insteadOf.command)
    : undefined;
  return prerequisiteNote({
    needs: item.needs,
    // 名前から外した補足（「事実の照合」）も戻す。名前だけでは
    // 「矛盾検知」が2つ並んで見分けられない
    ...(alternative
      ? {
          alternativeLabel: alternative.note
            ? `${alternative.label}（${alternative.note}）`
            : alternative.label,
        }
      : {}),
  });
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

  /**
   * **1項目で例外が出ても、メニュー全体を欠けさせない**（実機確認 A-21）。
   *
   * まっさらな環境で作品を11件登録した直後、詳細メニューの4グループと
   * ヘルプの3項目が消え、開き直すまで戻らなかった（2026-09-08）。
   * 読むだけでは投げる箇所が見つからないので、項目ごとに捕まえて
   * **どの項目が何で落ちたかをログに残し**、その項目は素の表示で出す。
   * 次に起きたときは、ログが原因を指す。
   */
  getTreeItem(node: ActionNode): vscode.TreeItem {
    try {
      return this.buildTreeItem(node);
    } catch (error) {
      logFailure("詳細メニューの項目", {
        項目: nodeKey(node),
        理由: error instanceof Error ? error.stack ?? error.message : String(error),
      });
      const label =
        node.type === "group"
          ? node.group.label
          : node.type === "section"
            ? node.section.label
            : node.item.label;
      return new vscode.TreeItem(
        label,
        node.type === "action"
          ? vscode.TreeItemCollapsibleState.None
          : vscode.TreeItemCollapsibleState.Collapsed
      );
    }
  }

  private buildTreeItem(node: ActionNode): vscode.TreeItem {
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
      // **tooltip は必ず設定する。** 未設定のまま resourceUri だけを付けると、
      // VS Code は resourceUri のパスを既定のツールチップとして表示する。
      // 目印の鍵は encodeURIComponent 済みなので、
      // 「%E8%B3%87%E6%96%99…」という読めない文字列が画面に漏れていた
      // （作者の実機報告、2026-09-05）。説明を持たない分類・小分類には、
      // せめて表示名を入れておく
      item.tooltip = groupTooltip
        ? new vscode.MarkdownString(groupTooltip)
        : label;
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
            "「作品一覧」の「フォルダから作品を追加」または「新規作品を作成」から登録。\n\n",
        // **名前から外した補足は、ここで返す**（設計書6.17）。
        // ビューの幅に収めるために短くしただけで、説明は捨てていない
        action.note ? `**${action.note}**\n\n` : "",
        // **段落で切る。** 説明文が二段組み（要約の1行＋箇条書き）になったので、
        // 改行1つだとMarkdownが要約の行とつないでしまう
        action.usesAI ? "**AIを使う**（クラウドのAIは実行のたびに課金）\n\n" : "",
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

  /**
   * 親をたどる（設計書6.104）。
   *
   * **`TreeView.reveal()` を使うために要る。** VS Code は最上位から順に
   * 開きながら目当ての行へたどり着くので、親を答えられないツリーでは
   * 分類の中の操作を光らせられない。
   *
   * 親は**画面に並んでいるものから探す**（`listChildren` と同じ絞り方）。
   * 隠れている項目を親として返すと、開けない行を開こうとして空振りする。
   */
  getParent(node: ActionNode): ActionNode | undefined {
    if (node.type === "group") return undefined;

    const groups = visibleGroups(this.registry.list().length > 0);
    if (node.type === "section") {
      const group = groups.find((entry) => entry.label === node.groupLabel);
      return group ? { type: "group", group } : undefined;
    }

    const runtimeAllowsProcesses = canRunProcesses();
    for (const group of groups) {
      for (const entry of shownEntries(group.entries, runtimeAllowsProcesses)) {
        if (entry.kind === "action") {
          if (entry.command === node.item.command) {
            return { type: "group", group };
          }
          continue;
        }
        const inSection = shownEntries(entry.items, runtimeAllowsProcesses).some(
          (item) => item.command === node.item.command
        );
        if (inSection) {
          return { type: "section", section: entry, groupLabel: group.label };
        }
      }
    }
    return undefined;
  }

  /**
   * コマンドIDから、画面に並んでいる操作の節点を引く。
   *
   * **見つからなければ undefined。** 案内（設計書6.104）は、光らせられ
   * なかったことを黙って成功にしないために、ここで分かる必要がある。
   */
  findActionNode(command: string): ActionNode | undefined {
    const runtimeAllowsProcesses = canRunProcesses();
    for (const group of visibleGroups(this.registry.list().length > 0)) {
      for (const entry of shownEntries(group.entries, runtimeAllowsProcesses)) {
        if (entry.kind === "action") {
          if (entry.command === command) return { type: "action", item: entry };
          continue;
        }
        const found = shownEntries(entry.items, runtimeAllowsProcesses).find(
          (item) => item.command === command
        );
        if (found) return { type: "action", item: found };
      }
    }
    return undefined;
  }

  getChildren(node?: ActionNode): ActionNode[] {
    try {
      return this.listChildren(node);
    } catch (error) {
      // 分類の中身を作れなくても、分類そのものは残す（A-21。上と同じ理由）
      logFailure("詳細メニューの中身", {
        項目: node ? nodeKey(node) : "（最上位）",
        理由: error instanceof Error ? error.stack ?? error.message : String(error),
      });
      return [];
    }
  }

  private listChildren(node?: ActionNode): ActionNode[] {
    const hasWork = this.registry.list().length > 0;
    const groups = visibleGroups(hasWork);

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

/**
 * 簡単ステップメニュー用の鍵の頭。
 *
 * 詳細メニューの鍵は区画が1つ（`/操作名`）なので、頭を1つ足すだけで
 * 衝突しなくなる。`nodeKey` が返すのは分類名・「分類/小分類」・コマンドIDで、
 * どれもこの語そのものにはならない。
 */
const WORK_SCOPE_PREFIX = "work";

/**
 * 印の宛先。**どの範囲の件数を出すかが、鍵で決まる。**
 *
 * 詳細メニューは作品を選ばずに見るので**全作品合計**を出し、
 * 簡単ステップメニューは最上段で作品を選ぶ画面なので
 * **選んだ作品だけ**を出す（設計書6.29）。同じ鍵を使うと同じ数字が出て、
 * 選択作品の件数に見えてしまう（作者の実機報告、2026-09-05）。
 */
export type ActionDecorationTarget =
  | { scope: "all"; key: string }
  /** `workId` が undefined なのは、作品をまだ選んでいないとき */
  | { scope: "work"; key: string; workId: string | undefined };

export function actionResourceUri(node: ActionNode): vscode.Uri {
  return vscode.Uri.from({
    scheme: ACTION_SCHEME,
    // パスにそのまま入れると、日本語や記号でURIが壊れる
    path: `/${encodeURIComponent(nodeKey(node))}`,
  });
}

/**
 * 簡単ステップメニュー用の目印。**作品IDを鍵に混ぜる。**
 *
 * 作品を選んでいないときはIDを入れない。件数は出さないが、
 * 「AI」の印は作品に関わらないので、目印そのものは付ける。
 */
export function stepActionResourceUri(
  node: ActionNode,
  workId: string | undefined
): vscode.Uri {
  const key = encodeURIComponent(nodeKey(node));
  return vscode.Uri.from({
    scheme: ACTION_SCHEME,
    path:
      workId === undefined
        ? `/${WORK_SCOPE_PREFIX}/${key}`
        : `/${WORK_SCOPE_PREFIX}/${encodeURIComponent(workId)}/${key}`,
  });
}

/** URIから元の鍵と、件数の範囲へ戻す */
export function actionTargetFromUri(
  uri: vscode.Uri
): ActionDecorationTarget | undefined {
  if (uri.scheme !== ACTION_SCHEME) return undefined;
  // 鍵は encodeURIComponent 済みなので、区画の中に `/` は現れない
  const parts = uri.path.replace(/^\//, "").split("/");
  try {
    if (parts[0] === WORK_SCOPE_PREFIX) {
      if (parts.length === 2) {
        return {
          scope: "work",
          key: decodeURIComponent(parts[1]),
          workId: undefined,
        };
      }
      if (parts.length === 3) {
        return {
          scope: "work",
          key: decodeURIComponent(parts[2]),
          workId: decodeURIComponent(parts[1]),
        };
      }
      return undefined;
    }
    if (parts.length !== 1) return undefined;
    return { scope: "all", key: decodeURIComponent(parts[0]) };
  } catch {
    return undefined;
  }
}
