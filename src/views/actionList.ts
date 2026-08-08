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
    command: "novelai.showSettingsForTerm",
    label: "カーソル位置の設定を表示",
    description: "",
    icon: "book",
    requiresWork: true,
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
    detail:
      "本文をAIで解析し、登場人物・能力・場所を取り出して保存します。" +
      "続けて設定資料のMarkdownも作ります。",
  },
  {
    command: "novelai.generateSettingsDocs",
    label: "設定資料集を出力する",
    description: "AIを使わない",
    icon: "book",
    requiresWork: true,
    detail:
      "抽出済みのJSONから、読むための設定資料集（characters.md・abilities.md・locations.md）を書き出します。" +
      "JSONを手直ししたあとや、まとめ・更新の反映後に使います。AIは呼びません。",
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
    command: "novelai.applyPendingUpdates",
    label: "更新分を反映",
    description: "承認制",
    icon: "check-all",
    requiresWork: true,
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
    detail:
      "「リン」と「リンセップ・アウクト」のように、" +
      "同じ人物が別々に登録されてしまった組をまとめます。" +
      "どちらの名前を残すかは作者が選びます。",
  },
  {
    command: "novelai.exportImeDictionary",
    label: "IME辞書を書き出す",
    description: "AIを使わない",
    icon: "symbol-keyword",
    requiresWork: true,
    detail:
      "登場人物・場所・能力の名前を、IMEのユーザー辞書に取り込める形で書き出します。" +
      "取り込むと、変換候補に作品の固有名詞が出るようになります。",
  },
  {
    command: "novelai.showLog",
    label: "ログを表示",
    description: "",
    icon: "output",
    requiresWork: false,
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
