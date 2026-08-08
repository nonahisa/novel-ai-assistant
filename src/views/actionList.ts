import * as vscode from "vscode";
import type { WorkRegistry } from "../core/workRegistry";

/**
 * よく使う操作をサイドバーに並べるビュー。
 *
 * コマンドパレットからしか呼べない操作は、
 * 名前を知らないと探せないため、作者は存在に気づけない。
 * かといって右クリックメニューに全部載せると項目が増えて選びにくくなる。
 * そこで、押せる操作の一覧として独立したビューに出す。
 */

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
}

const ACTIONS: readonly CommandAction[] = [
  {
    command: "novelai.openSettingsPanel",
    label: "設定資料を開く",
    description: "",
    icon: "book",
    requiresWork: true,
    detail:
      "抽出した登場人物・能力・場所を一覧で見ます。" +
      "その場で書き換えたり、AIに掘り下げさせたり、質問したりできます。",
  },
  {
    command: "novelai.extractSettings",
    label: "設定資料を抽出",
    description: "AIを使う",
    icon: "sparkle",
    requiresWork: true,
    detail:
      "本文をAIで解析し、登場人物・能力・場所を取り出して保存します。" +
      "続けて設定資料のMarkdownも作ります。",
  },
  {
    command: "novelai.generateSettingsDocs",
    label: "設定資料を作り直す",
    description: "AIを使わない",
    icon: "sync",
    requiresWork: true,
    detail:
      "抽出済みのJSONから設定資料のMarkdownだけを作り直します。" +
      "JSONを手直ししたあとに使います。AIは呼びません。",
  },
  {
    command: "novelai.showWorkStats",
    label: "作品の文字数を表示",
    description: "",
    icon: "graph",
    requiresWork: true,
    detail: "文字数と原稿用紙の枚数を作品全体で集計します。",
  },
  {
    command: "novelai.setupAI",
    label: "AIの設定",
    description: "",
    icon: "settings-gear",
    requiresWork: false,
    detail: "使用するAI（Ollama / Claude）とモデルを選びます。",
  },
  {
    command: "novelai.testAI",
    label: "AIの接続を確認",
    description: "",
    icon: "plug",
    requiresWork: false,
    detail:
      "設定したAIに接続できるかを確かめます。" +
      "抽出が失敗するときは、まずここを見てください。",
  },
  {
    command: "novelai.selectOllamaExecutable",
    label: "Ollamaの実行ファイルを選択",
    description: "",
    icon: "folder-opened",
    requiresWork: false,
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

export class ActionListProvider
  implements vscode.TreeDataProvider<CommandAction>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    CommandAction | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly registry: WorkRegistry) {
    // 最初の作品を登録した時点で、作品向けの操作を出せるようになる
    registry.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(action: CommandAction): vscode.TreeItem {
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

  getChildren(action?: CommandAction): CommandAction[] {
    // 入れ子にしない。1階層で全部見えたほうが探しやすい
    if (action) return [];
    return visibleActions(this.registry.list().length > 0);
  }
}
