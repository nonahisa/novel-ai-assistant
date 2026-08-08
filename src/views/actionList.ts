import * as vscode from "vscode";
import type { WorkRegistry } from "../core/workRegistry";

/**
 * 操作メニュー。
 *
 * コマンドパレットからしか呼べない操作は、
 * 名前を知らないと探せないため、作者は存在に気づけない。
 * かといって右クリックメニューに全部載せると項目が増えて選びにくくなる。
 * そこで、押せる操作の一覧として独立したビューに出す。
 *
 * 数が増えてきたので分類でまとめる。作者が「何をしたいか」から辿れるよう、
 * 機能の実装単位ではなく**作業の流れ**で分ける。
 */

/** 分類。この順に表示する */
export type ActionGroup = "資料" | "整える" | "書き出す" | "AI設定" | "困ったとき";

export const ACTION_GROUPS: ActionGroup[] = [
  "資料",
  "整える",
  "書き出す",
  "AI設定",
  "困ったとき",
];

export interface CommandAction {
  /** 実行するコマンドID */
  command: string;
  label: string;
  /** 一覧で label の右に薄字で出る補足 */
  description: string;
  /** codicon の名前 */
  icon: string;
  /** 押したときに作品を必要とする操作か */
  requiresWork: boolean;
  /** ホバーで出す説明。何が起きるかを1文で伝える */
  detail: string;
  group: ActionGroup;
}

const ACTIONS: readonly CommandAction[] = [
  // ── 資料を見る・作る
  {
    command: "novelai.openSettingsPanel",
    label: "設定資料を開く",
    description: "",
    icon: "book",
    requiresWork: true,
    group: "資料",
    detail:
      "抽出した登場人物・能力・場所を一覧で見ます。" +
      "その場で書き換えたり、AIに項目を埋めさせたり、相談したりできます。",
  },
  {
    command: "novelai.showSettingsForTerm",
    label: "カーソル位置の設定を表示",
    description: "",
    icon: "book",
    requiresWork: true,
    group: "資料",
    detail:
      "本文中の人名などにカーソルを置いて実行すると、その設定を右側に開きます。" +
      "以後は本文をクリックするたび、その用語の設定へ切り替わります。",
  },
  {
    command: "novelai.extractSettings",
    label: "設定資料を抽出",
    description: "AIを使う",
    icon: "sparkle",
    requiresWork: true,
    group: "資料",
    detail:
      "本文をAIで解析し、登場人物・能力・場所を取り出して保存します。" +
      "続けて設定資料集も作ります。",
  },

  // ── 抽出した結果を整える
  {
    command: "novelai.applyPendingUpdates",
    label: "更新分を反映",
    description: "承認制",
    icon: "check-all",
    requiresWork: true,
    group: "整える",
    detail:
      "抽出で見つかった既存人物への更新を、内容を確認してから反映します。" +
      "確認せずに書き換えることはありません。",
  },
  {
    command: "novelai.unifyCharacters",
    label: "同一人物をまとめる",
    description: "",
    icon: "merge",
    requiresWork: true,
    group: "整える",
    detail:
      "「リン」と「リンセップ・アウクト」のように、" +
      "同じ人物が別々に登録されてしまった組をまとめます。" +
      "どちらの名前を残すかは作者が選びます。",
  },

  // ── 外に出す
  {
    command: "novelai.generateSettingsDocs",
    label: "設定資料集を出力",
    description: "AIを使わない",
    icon: "book",
    requiresWork: true,
    group: "書き出す",
    detail:
      "抽出済みのJSONから、読むための設定資料集" +
      "（characters.md・abilities.md・locations.md）を書き出します。" +
      "JSONを手直ししたあとや、まとめ・更新の反映後に使います。AIは呼びません。",
  },
  {
    command: "novelai.exportImeDictionary",
    label: "IME辞書を出力",
    description: "AIを使わない",
    icon: "symbol-keyword",
    requiresWork: true,
    group: "書き出す",
    detail:
      "登場人物・場所・能力の名前を、IMEのユーザー辞書に取り込める形で書き出します。" +
      "取り込むと、変換候補に作品の固有名詞が出るようになります。",
  },
  {
    command: "novelai.showWorkStats",
    label: "作品の文字数を表示",
    description: "",
    icon: "graph",
    requiresWork: true,
    group: "書き出す",
    detail: "文字数と原稿用紙の枚数を作品全体で集計します。",
  },

  // ── AIの設定
  {
    command: "novelai.setupAI",
    label: "AIの設定",
    description: "",
    icon: "settings-gear",
    requiresWork: false,
    group: "AI設定",
    detail: "使用するAI（Ollama・Gemini・ChatGPT・Claude）とモデルを選びます。",
  },
  {
    command: "novelai.testAI",
    label: "AIの接続を確認",
    description: "",
    icon: "plug",
    requiresWork: false,
    group: "AI設定",
    detail:
      "設定したAIに接続できるかを確かめます。" +
      "抽出が失敗するときは、まずここを見てください。",
  },

  // ── 困ったとき
  {
    command: "novelai.showLog",
    label: "ログを表示",
    description: "",
    icon: "output",
    requiresWork: false,
    group: "困ったとき",
    detail:
      "AIが返したエラーの詳細を記録しています。" +
      "抽出が失敗して理由が分からないときに開いてください。",
  },
  {
    command: "novelai.selectOllamaExecutable",
    label: "Ollamaの実行ファイルを選択",
    description: "",
    icon: "folder-opened",
    requiresWork: false,
    group: "困ったとき",
    detail:
      "Ollamaを自動で見つけられない場合に、ollama.exe の場所を指定します。",
  },
];

/**
 * 一覧に出す操作を選ぶ。
 *
 * 作品が1つも登録されていないと、作品を要する操作は押しても
 * 「作品が登録されていません」と言われるだけなので出さない。
 * 押せないボタンを並べても、作者には理由が分からない。
 */
export function visibleActions(hasWork: boolean): CommandAction[] {
  return ACTIONS.filter((action) => hasWork || !action.requiresWork);
}

/** 分類ごとにまとめる。中身が無い分類は出さない */
export function groupedActions(
  hasWork: boolean
): Array<{ group: ActionGroup; actions: CommandAction[] }> {
  const visible = visibleActions(hasWork);
  return ACTION_GROUPS.map((group) => ({
    group,
    actions: visible.filter((action) => action.group === group),
  })).filter((entry) => entry.actions.length > 0);
}

/** ツリーの節点。分類の見出しか、操作そのもの */
type ActionNode =
  | { type: "group"; group: ActionGroup }
  | { type: "action"; action: CommandAction };

export class ActionListProvider implements vscode.TreeDataProvider<ActionNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    ActionNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly registry: WorkRegistry) {
    // 最初の作品を登録した時点で、作品向けの操作を出せるようになる
    registry.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(node: ActionNode): vscode.TreeItem {
    if (node.type === "group") {
      const item = new vscode.TreeItem(
        node.group,
        // 既定で開いておく。畳まれていると探しにくい
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.contextValue = "actionGroup";
      return item;
    }

    const { action } = node;
    const item = new vscode.TreeItem(
      action.label,
      vscode.TreeItemCollapsibleState.None
    );
    item.description = action.description;
    item.iconPath = new vscode.ThemeIcon(action.icon);
    item.tooltip = action.detail;
    // 引数を渡さないので、作品が複数あれば実行時に選択を求められる
    item.command = { command: action.command, title: action.label };
    return item;
  }

  getChildren(node?: ActionNode): ActionNode[] {
    const hasWork = this.registry.list().length > 0;

    if (!node) {
      return groupedActions(hasWork).map((entry) => ({
        type: "group" as const,
        group: entry.group,
      }));
    }
    if (node.type === "group") {
      return visibleActions(hasWork)
        .filter((action) => action.group === node.group)
        .map((action) => ({ type: "action" as const, action }));
    }
    return [];
  }
}
