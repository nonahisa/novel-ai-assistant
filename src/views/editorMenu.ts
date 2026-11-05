import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import type { WorkRegistry } from "../core/workRegistry";
import { abbreviateTitle, isAbbreviated } from "../core/abbreviateTitle";
import { processCommandsUsableHere } from "../core/processAvailability";
import {
  EDITOR_END_WORK_COMMAND,
  EDITOR_JOIN_COMMAND,
  EDITOR_MENU_BACK_COMMAND,
  EDITOR_MENU_HELP,
  EDITOR_MENU_LABELS,
  EDITOR_STEP_DEFS,
  EDITOR_WORK_COMMAND,
  type EditorStepDef,
  type EditorStepKey,
} from "../core/stepDefs";
import { resolveEditorEntry } from "../core/menuPath";
import {
  describeEditorStatus,
  judgeEditorProgress,
  type EditorProgress,
  type EditorProgressFacts,
  type EditorStatusLine,
  type EditorStepMark,
} from "../core/editorProgress";
import {
  disabledHint,
  explainDisabled,
  REQUIRES_WORK_HINT,
  type ActionItem,
} from "../core/actionTree";
import { resolveSelectedWork } from "./stepMenu";

/**
 * 編集者メニュー（作者の指示 2026-11-05 夜。設計書5.6.6）。
 *
 * 編集者モードでだけ、横の枠の一番上に出す（`package.json` の `novelai.editorMenu`。
 * `when` は `config.novelai.mode == 'editor'`）。簡単ステップメニューは編集者モードでは出さない。
 *
 * 上から：作品（押すと切り替え）・この作品の編集を終える・作品を足す・状態の行・
 * 手順1〜7（左に「済み／次はここ／まだ」の印）・ヘルプ・作者モードへ戻る。
 *
 * **簡単ステップメニューを作り替えずに、別のビューにした。** ビューの並びは `package.json` の
 * 順で決まり、簡単ステップメニューは2番目（作品一覧の下）にある。作者モードの並びを変えずに
 * 「一番上」に置くには、別のビューを先頭に足して、モードで出し分けるのが壊れにくい。
 */

/*
  コマンドと行の名前、詳細メニューに無い操作の解き方は core に置いてある（使い方の答えに添える
  場所の図も同じものを引くため。設計書6.118）。ここからも同じ名前で読めるように出し直す
*/
export { EDITOR_END_WORK_COMMAND, EDITOR_JOIN_COMMAND, EDITOR_WORK_COMMAND, resolveEditorEntry };

/** 作品を選んでいないときに押せない理由 */
export const EDITOR_SELECT_HINT = "一番上で作品を選ぶと使えます";

/** 作品がまだ無いときに押せない理由 */
export const EDITOR_JOIN_HINT = "参加のリンクを貼ると使えます";

export type EditorMenuNode =
  | { type: "join" }
  | { type: "work" }
  | { type: "endWork" }
  | { type: "addWork" }
  | { type: "status"; line: EditorStatusLine }
  | { type: "step"; def: EditorStepDef }
  | { type: "action"; item: ActionItem; parent: string }
  | { type: "help" }
  | { type: "back" };

/** 選んだ作品の覚え（簡単ステップメニューと同じ「選択作品」を分け合う） */
export interface EditorWorkSelection {
  get(): string | undefined;
  set(id: string | undefined): void;
}

/** 作品の事実を読む口（`features/editorMenuFacts.ts`。試験で差し替える） */
export type EditorFactsLoader = (
  work: WorkEntry
) => Promise<{ facts: EditorProgressFacts; rangeText?: string }>;

interface Loaded {
  progress: EditorProgress;
  lines: EditorStatusLine[];
}

/** 印の見せ方。**分からないものは「まだ」**（作者の指示） */
export function markView(mark: EditorStepMark): { icon: string; color?: string; word: string } {
  if (mark === "done") return { icon: "pass-filled", color: "testing.iconPassed", word: "✓ 済み" };
  if (mark === "next") return { icon: "arrow-circle-right", color: "charts.blue", word: "▶ 次はここ" };
  return { icon: "circle-large-outline", word: "・ まだ" };
}

export class EditorMenuProvider implements vscode.TreeDataProvider<EditorMenuNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    EditorMenuNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** 作品ごとの読み込み結果。`refresh` で捨てる */
  private readonly loaded = new Map<string, Loaded>();
  private readonly loading = new Map<string, Promise<void>>();

  constructor(
    private readonly registry: WorkRegistry,
    private readonly selection: EditorWorkSelection,
    private readonly loadFacts: EditorFactsLoader,
    /**
     * 編集者メニューに出す作品へ絞る（参加した作品だけ。自分の作品は出さない。設計書5.6.6）。
     * 写しの印を読むので非同期。試験で差し替える。渡さなければ絞らない
     */
    private readonly filterWorks: (works: readonly WorkEntry[]) => Promise<WorkEntry[]> = async (works) => [...works]
  ) {
    registry.onDidChange(() => this.refresh());
  }

  /**
   * 絞った作品の控え。根の `getChildren` が読み直す（`getTreeItem` は同期で答えるので、控えを読む）。
   * 読む前は登録簿のまま
   */
  private works: WorkEntry[] | undefined;

  /** 参加した作品（編集者メニューに出す作品）。作品の切り替えの選択肢もこれを使う */
  async editorWorks(): Promise<WorkEntry[]> {
    this.works = await this.filterWorks(this.registry.list()).catch(() => [...this.registry.list()]);
    return this.works;
  }

  private listed(): WorkEntry[] {
    return this.works ?? [...this.registry.list()];
  }

  selectedWork(): WorkEntry | undefined {
    return resolveSelectedWork(this.listed(), this.selection.get());
  }

  /** 台帳・同期の状態・モードが変わったら呼ぶ。読み直してから描き直す */
  refresh(): void {
    this.loaded.clear();
    this.loading.clear();
    this._onDidChangeTreeData.fire();
  }

  /** いまの進み具合（試験と案内で使う）。読み終えていなければ undefined */
  progressOf(workId: string): EditorProgress | undefined {
    return this.loaded.get(workId)?.progress;
  }

  /**
   * 選んだ作品の事実を読む。**読み終えても知らせ（fire）は出さない**——根の `getChildren` が
   * 待ってから答える（簡単ステップメニューの `loadSelectedFormat` と同じ理由。読み終えて
   * 「並べ直して」と知らせると、本体の描画と重なって木が止まった）
   */
  private load(work: WorkEntry): Promise<void> {
    if (this.loaded.has(work.id)) return Promise.resolve();
    const pending = this.loading.get(work.id);
    if (pending) return pending;
    const run = this.loadFacts(work)
      .then(({ facts, rangeText }) => {
        if (this.loading.get(work.id) !== run) return;
        const progress = judgeEditorProgress(facts);
        this.loaded.set(work.id, {
          progress,
          lines: describeEditorStatus(facts, progress, rangeText),
        });
      })
      .catch(() => {
        // 読めなければ、何も済んでいない扱いで並べる（分からないものは済みにしない）
        if (this.loading.get(work.id) !== run) return;
        const facts: EditorProgressFacts = {
          myLocks: [],
          myProposals: [],
          seenDecisions: new Set(),
        };
        const progress = judgeEditorProgress(facts);
        this.loaded.set(work.id, { progress, lines: describeEditorStatus(facts, progress, undefined) });
      })
      .finally(() => {
        if (this.loading.get(work.id) === run) this.loading.delete(work.id);
      });
    this.loading.set(work.id, run);
    return run;
  }

  /**
   * コマンドIDから、編集者メニューの行を引く（相談・案内・外部AIが光らせるとき。設計書6.118）。
   *
   * 中の操作が1つだけの手順は**手順の行そのもの**（押すとそのまま走る）、複数ある手順は
   * その中の行を返す。無ければ undefined（光らせる側が詳細メニューへ回る）。
   * 同期で答える——`TreeView.reveal` の前に呼ばれるので、読み込みを待たない。
   */
  findActionNode(command: string): EditorMenuNode | undefined {
    for (const def of EDITOR_STEP_DEFS) {
      const items = def.entries
        .map((entry) => resolveEditorEntry(entry))
        .filter((item): item is ActionItem => item !== undefined);
      if (items.length === 1) {
        if (items[0].command === command) return { type: "step", def };
        continue;
      }
      const item = items.find((one) => one.command === command);
      if (item) return { type: "action", item, parent: def.key };
    }
    const help = EDITOR_MENU_HELP.map((entry) => resolveEditorEntry(entry)).find(
      (item) => item?.command === command
    );
    if (help) return { type: "action", item: help, parent: "help" };
    if (command === EDITOR_MENU_BACK_COMMAND) return { type: "back" };
    if (command === EDITOR_END_WORK_COMMAND && this.selectedWork()) return { type: "endWork" };
    if (command === EDITOR_JOIN_COMMAND) {
      return this.listed().length === 0 ? { type: "join" } : { type: "addWork" };
    }
    if (command === EDITOR_WORK_COMMAND && this.listed().length > 0) return { type: "work" };
    return undefined;
  }

  /** `TreeView.reveal` が祖先をたどるのに使う。手順の中の行とヘルプの中の行だけが親を持つ */
  getParent(node: EditorMenuNode): EditorMenuNode | undefined {
    if (node.type !== "action") return undefined;
    if (node.parent === "help") return { type: "help" };
    const def = EDITOR_STEP_DEFS.find((one) => one.key === node.parent);
    return def ? { type: "step", def } : undefined;
  }

  async getChildren(node?: EditorMenuNode): Promise<EditorMenuNode[]> {
    if (!node) {
      const works = await this.editorWorks();
      const work = this.selectedWork();
      if (work) await this.load(work);
      const steps = EDITOR_STEP_DEFS.map((def) => ({ type: "step" as const, def }));
      const tail: EditorMenuNode[] = [{ type: "help" }, { type: "back" }];
      // 作品がまだ無いときは「参加のリンクを貼る」だけを一番上に出す（作者の指示）
      if (works.length === 0) return [{ type: "join" }, ...steps, ...tail];
      const status = work
        ? (this.loaded.get(work.id)?.lines ?? []).map((line) => ({ type: "status" as const, line }))
        : [];
      return [
        { type: "work" },
        ...(work ? [{ type: "endWork" as const }] : []),
        { type: "addWork" },
        ...status,
        ...steps,
        ...tail,
      ];
    }
    if (node.type === "step" && node.def.entries.length > 1) {
      return node.def.entries
        .map((entry) => resolveEditorEntry(entry))
        .filter((item): item is ActionItem => item !== undefined)
        .map((item) => ({ type: "action" as const, item, parent: node.def.key }));
    }
    if (node.type === "help") {
      return EDITOR_MENU_HELP.map((entry) => resolveEditorEntry(entry))
        .filter((item): item is ActionItem => item !== undefined)
        .map((item) => ({ type: "action" as const, item, parent: "help" }));
    }
    return [];
  }

  getTreeItem(node: EditorMenuNode): vscode.TreeItem {
    switch (node.type) {
      case "join":
        return this.joinItem();
      case "work":
        return this.workItem();
      case "endWork":
        return this.endWorkItem();
      case "addWork":
        return this.addWorkItem();
      case "status":
        return statusItem(node.line);
      case "step":
        return this.stepItem(node.def);
      case "action":
        return this.actionItem(node.item, node.parent);
      case "help": {
        const item = new vscode.TreeItem(EDITOR_MENU_LABELS.help, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = "editorMenu/help";
        item.iconPath = new vscode.ThemeIcon("question");
        item.tooltip = new vscode.MarkdownString(
          "うまく動かないときに開く場所\n\n・困ったときは記録を作者へ渡すと、原因を探しやすい"
        );
        return item;
      }
      case "back": {
        const item = new vscode.TreeItem(EDITOR_MENU_LABELS.back, vscode.TreeItemCollapsibleState.None);
        item.id = "editorMenu/back";
        item.iconPath = new vscode.ThemeIcon("arrow-swap");
        item.tooltip = new vscode.MarkdownString(
          "この環境を、自分の作品を書く使い方へ戻す\n\n・いつでも編集者モードへ切り替え直せる"
        );
        item.command = { command: EDITOR_MENU_BACK_COMMAND, title: EDITOR_MENU_LABELS.back };
        return item;
      }
    }
  }

  private joinItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(EDITOR_MENU_LABELS.join, vscode.TreeItemCollapsibleState.None);
    item.id = "editorMenu/join";
    item.iconPath = new vscode.ThemeIcon("link");
    item.description = "作者から届いたリンク";
    item.tooltip = new vscode.MarkdownString(
      "作者から届いたリンクを貼って、作品を受け取る\n\n・招待の受諾・取り寄せ・登録まで1回で済む"
    );
    item.command = { command: EDITOR_JOIN_COMMAND, title: EDITOR_MENU_LABELS.join };
    return item;
  }

  private workItem(): vscode.TreeItem {
    const works = this.listed();
    const work = this.selectedWork();
    const label = work ? `作品：${abbreviateTitle(work.title)}` : EDITOR_MENU_LABELS.work;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = "editorMenu/work";
    item.iconPath = new vscode.ThemeIcon("book");
    item.description = works.length > 1 ? `切り替え（${works.length}作品）` : "";
    item.tooltip = new vscode.MarkdownString(
      (work && isAbbreviated(work.title) ? `**${work.title}**\n\n` : "") +
        "下の手順と状態は、ここで選んだ作品に効く\n\n" +
        "・押すと、参加している作品から選び直せる"
    );
    item.command = { command: EDITOR_WORK_COMMAND, title: "校閲する作品を選ぶ" };
    return item;
  }

  private endWorkItem(): vscode.TreeItem {
    const work = this.selectedWork();
    const item = new vscode.TreeItem(EDITOR_MENU_LABELS.endWork, vscode.TreeItemCollapsibleState.None);
    item.id = "editorMenu/endWork";
    item.iconPath = new vscode.ThemeIcon("close");
    item.tooltip = new vscode.MarkdownString(
      "この作品の登録を解除する\n\n・取り寄せたフォルダーはそのまま残る\n\n" +
        "・提案を返していなければ、先に「6. 校閲を終えて作者へ返す」"
    );
    if (work) {
      item.command = {
        command: EDITOR_END_WORK_COMMAND,
        title: EDITOR_MENU_LABELS.endWork,
        arguments: [{ type: "work", work }],
      };
    }
    return item;
  }

  private addWorkItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(
      EDITOR_MENU_LABELS.addWork,
      vscode.TreeItemCollapsibleState.None
    );
    item.id = "editorMenu/addWork";
    item.iconPath = new vscode.ThemeIcon("add");
    item.tooltip = new vscode.MarkdownString(
      "別の作品のリンクが届いたときに貼る\n\n・参加している作品が増え、一番上で切り替えられる"
    );
    item.command = { command: EDITOR_JOIN_COMMAND, title: EDITOR_MENU_LABELS.addWork };
    return item;
  }

  private markOf(key: EditorStepKey): { mark: EditorStepMark; note: string } {
    const work = this.selectedWork();
    const progress = work ? this.loaded.get(work.id)?.progress : undefined;
    return {
      mark: progress?.marks[key] ?? "todo",
      note: progress?.notes[key] ?? "",
    };
  }

  /** 押せない理由。作品が無いのか、選んでいないのかを分ける */
  private hintFor(item: ActionItem): string | undefined {
    const works = this.listed();
    const selected = this.selectedWork();
    const runtime = processCommandsUsableHere();
    const hint = disabledHint(item, selected !== undefined, "editor", runtime);
    // 「作品を登録すると使えます」は作者の言い方。編集者は参加で作品を受け取る
    if (hint === REQUIRES_WORK_HINT) {
      return works.length === 0 ? EDITOR_JOIN_HINT : EDITOR_SELECT_HINT;
    }
    return hint;
  }

  private commandFor(item: ActionItem): vscode.Command | undefined {
    const selected = this.selectedWork();
    if (this.hintFor(item) !== undefined) return undefined;
    return {
      command: item.command,
      title: item.label,
      // **作品を要する操作にだけ渡す**（簡単ステップメニューと同じ。開いている話に効く操作へ
      // 作品を渡すと、対象がすり替わる）
      arguments: item.requiresWork && selected ? [{ type: "work", work: selected }] : [],
    };
  }

  private stepItem(def: EditorStepDef): vscode.TreeItem {
    const { mark, note } = this.markOf(def.key);
    const view = markView(mark);
    const single = def.entries.length === 1 ? resolveEditorEntry(def.entries[0]) : undefined;
    const item = new vscode.TreeItem(
      def.label,
      single
        ? vscode.TreeItemCollapsibleState.None
        : mark === "next"
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
    );
    // 印が変わっても開閉の覚えが消えないよう、手順ごとに決まった id を付ける
    item.id = `editorMenu/step/${def.key}`;
    item.iconPath = view.color
      ? new vscode.ThemeIcon(view.icon, new vscode.ThemeColor(view.color))
      : new vscode.ThemeIcon(view.icon);
    item.description = note ? `${view.word}・${note}` : view.word;
    const hint = single ? this.hintFor(single) : undefined;
    item.tooltip = new vscode.MarkdownString(
      [
        hint && single ? `**${hint}。** ${nextStepFor(single, hint)}\n\n` : "",
        single?.usesAI ? "**AIを使う**（クラウドのAIは実行のたびに課金）\n\n" : "",
        def.detail,
      ].join("")
    );
    if (single) {
      const command = this.commandFor(single);
      if (command) item.command = { ...command, title: def.label };
      else if (hint) item.description = `${view.word}・${hint}`;
    }
    return item;
  }

  private actionItem(action: ActionItem, parent: string): vscode.TreeItem {
    const item = new vscode.TreeItem(action.label, vscode.TreeItemCollapsibleState.None);
    item.id = `editorMenu/${parent}/${action.command}`;
    const hint = this.hintFor(action);
    item.description = hint ?? action.description ?? "";
    item.iconPath = hint
      ? new vscode.ThemeIcon(action.icon, new vscode.ThemeColor("disabledForeground"))
      : new vscode.ThemeIcon(action.icon);
    item.tooltip = new vscode.MarkdownString(
      [
        hint ? `**${hint}。** ${nextStepFor(action, hint)}\n\n` : "",
        action.usesAI ? "**AIを使う**（クラウドのAIは実行のたびに課金）\n\n" : "",
        action.detail,
      ].join("")
    );
    const command = this.commandFor(action);
    if (command) item.command = command;
    return item;
  }
}

function statusItem(line: EditorStatusLine): vscode.TreeItem {
  const item = new vscode.TreeItem(`${line.label}：${line.value}`, vscode.TreeItemCollapsibleState.None);
  item.id = `editorMenu/status/${line.label}`;
  item.iconPath = new vscode.ThemeIcon(line.icon, new vscode.ThemeColor("descriptionForeground"));
  // 幅が狭いと切れるので、全文をホバーにも出す
  item.tooltip = `${line.label}：${line.value}`;
  item.contextValue = "editorMenuStatus";
  return item;
}

function nextStepFor(action: ActionItem, hint: string): string {
  if (hint === EDITOR_SELECT_HINT) return "一番上の作品の行を押して、校閲する作品を選ぶ。";
  if (hint === EDITOR_JOIN_HINT) return "一番上の「参加のリンクを貼る」から作品を受け取る。";
  return explainDisabled(action, hint);
}
