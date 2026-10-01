import * as vscode from "vscode";
import { logFailure } from "../core/logger";
import type { WorkRegistry } from "../core/workRegistry";
import { currentMode } from "../core/actorContext";
import { canRunProcesses } from "../core/runtime";
import type { WorkKindKey } from "../models/types";
import { commandsHiddenForWorks } from "../core/workTypeVisibility";
import {
  ACTION_TREE,
  disabledHint,
  isActionEnabled,
  REQUIRES_WORK_HINT,
  shownEntries,
  visibleGroups,
  type ActionCounter,
  type ActionGroup,
  type ActionItem,
  type ActionSection,
} from "../core/actionTree";

/*
  **操作の木（`ACTION_TREE`）と、`vscode` の要らない判断は `core/actionTree.ts` に
  置いた**（2026-10-01。残課題 R6）。外から呼ぶ相談（MCP）が製品と同じ
  「使い方の束」を組むには木が要るが、このファイルは画面（`TreeDataProvider`）の
  ために `vscode` を引くので、MCP の束からは読めなかった（設計書6.87.3）。

  **ここから丸ごと出し直す。** 画面側・試験の読み込み先（`views/actionList`）を
  変えずに済ませるためで、写しではない（中身は core の1か所だけ）。
*/
export * from "../core/actionTree";

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

  /** 前回描いたときに種類で隠した操作（変わったときだけ描き直すため） */
  private hiddenSignature = "";

  constructor(
    private readonly registry: WorkRegistry,
    private readonly store?: GroupStateStore,
    private readonly counts?: ActionCounts,
    /**
     * 登録した作品の種類（設計書6.109.7）。**分かっている分だけ**を返し、
     * まだ分からない作品は undefined にする（分からなければ隠さない）。
     *
     * 描画は同期なので、読み終えた結果を持っている側（作品一覧の走査）から
     * 借りる。ここで設定ファイルを読みに行くと、起動直後の混んだ読み口へ
     * 作品の数だけ要求を足すことになる（設計書6.107）。
     */
    private readonly workKinds?: () => readonly (WorkKindKey | undefined)[]
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
   * 作品の種類が分かった・変わったときに呼ぶ（設計書6.109.7）。
   *
   * **隠す操作の並びが変わったときだけ描き直す。** 作品一覧は作品を
   * 1つ読むたびに知らせてくるので、毎回描き直すと起動直後に
   * 詳細メニューが作品の数だけちらつく。
   */
  refreshKinds(): void {
    const signature = [...this.hiddenByKind()].sort().join("|");
    if (signature === this.hiddenSignature) return;
    this.hiddenSignature = signature;
    this._onDidChangeTreeData.fire();
  }

  /** いま種類で隠す操作。作品の種類を知る口が無ければ何も隠さない */
  private hiddenByKind(): ReadonlySet<string> {
    if (!this.workKinds) return new Set();
    return commandsHiddenForWorks(this.workKinds());
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
            "「作品一覧」の「フォルダー登録」または「新規作品を作成」から登録。\n\n",
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
    const hidden = this.hiddenByKind();
    for (const group of groups) {
      for (const entry of shownEntries(group.entries, runtimeAllowsProcesses, hidden)) {
        if (entry.kind === "action") {
          if (entry.command === node.item.command) {
            // 見出しを挟まない分類の操作は、それ自体が最上位にある
            return group.standalone ? undefined : { type: "group", group };
          }
          continue;
        }
        const inSection = shownEntries(entry.items, runtimeAllowsProcesses, hidden).some(
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
    const hidden = this.hiddenByKind();
    for (const group of visibleGroups(this.registry.list().length > 0)) {
      for (const entry of shownEntries(group.entries, runtimeAllowsProcesses, hidden)) {
        if (entry.kind === "action") {
          if (entry.command === command) return { type: "action", item: entry };
          continue;
        }
        const found = shownEntries(entry.items, runtimeAllowsProcesses, hidden).find(
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
    const hidden = this.hiddenByKind();

    if (!node) {
      const runtimeAllowsProcesses = canRunProcesses();
      return groups.flatMap((group): ActionNode[] => {
        if (!group.standalone) {
          // 種類で中身が全部隠れた分類は、見出しごと出さない（設計書6.109.7）。
          // **種類で隠すものが無いときは、いままでどおり必ず出す**
          if (
            hidden.size > 0 &&
            shownEntries(group.entries, runtimeAllowsProcesses, hidden).length === 0
          ) {
            return [];
          }
          return [{ type: "group", group }];
        }
        // **見出しを挟まず、操作をそのまま出す**（`ActionGroup.standalone`）
        return shownEntries(group.entries, runtimeAllowsProcesses, hidden).flatMap(
          (entry): ActionNode[] =>
            entry.kind === "action" ? [{ type: "action", item: entry }] : []
        );
      });
    }
    if (node.type === "group") {
      return shownEntries(node.group.entries, canRunProcesses(), hidden).map((entry) =>
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
      return shownEntries(node.section.items, canRunProcesses(), hidden).map((item) => ({
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
