import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import type { WorkRegistry } from "../core/workRegistry";
import { currentMode } from "../core/actorContext";
import type { WorkMode } from "../core/editorMode";
import { canRunProcesses } from "../core/runtime";
import { abbreviateTitle, isAbbreviated } from "../core/abbreviateTitle";
import type { WorkFormatKey } from "../core/workFormat";
import { readWorkFormat } from "../core/workFormatStore";
import type { WorkKindKey } from "../core/workKind";
import { readWorkKind } from "../core/workKindStore";
import {
  isCommandVisibleForColumn,
  isCommandVisibleForKind,
  workTypeColumn,
  type WorkTypeColumn,
} from "../core/workTypeVisibility";
import {
  allActions,
  disabledHint,
  explainDisabled,
  isActionEnabled,
  stepActionResourceUri,
  REQUIRES_WORK_HINT,
  type ActionCounter,
  type ActionItem,
  type GroupStateStore,
} from "./actionList";
// 段の定義は core に置いた（相談の目次が入口を導くのに使うため。`core/stepDefs.ts`）
import {
  STEP_DEFS,
  type StepDef,
  type StepPlaceholder,
} from "../core/stepDefs";
export * from "../core/stepDefs";

/**
 * 簡単ステップメニュー（作者の依頼、2026-08-27。名前は2026-08-29に改名）。
 *
 * 詳細メニュー（`actionList.ts`）は**何ができるか**で並べてある。
 * 一方、初めて使う人が知りたいのは**どの順でやるか**である。
 * そこで「1. 作品登録 → 2. 新作構想 → 3. 作品執筆 → 4. 自己校正 →
 * 5. 投稿脱稿 → 6. 編集部校正・校閲 → 7. 電子出版等」という
 * 作品づくりの流れに沿って、主な操作だけを並べ直したビューを別に持つ。
 *
 * ## 操作の実体は持たない。コマンドIDを参照するだけにする
 *
 * ラベル・説明・AIの印・作品が要るかは、**すべて `ACTION_TREE` にあるもの**を
 * `allActions()` から引いて使う。ここで同じものを書くと、片方だけ直したときに
 * 「詳細メニューでは直っているのに簡単ステップメニューは古い」が起きる。
 * しかも、どちらが正しいのかは画面を見比べるまで分からない。
 *
 * 参照が切れた（コマンドを改名した）ときは `STEP_MENU_MISSING_COMMANDS` に残り、
 * `test/unit/views/stepMenu.test.ts` が落ちる。
 *
 * ## 最上段で選んだ作品にだけ効く
 *
 * 詳細メニューは引数を渡さないので、作品が複数あると押すたびに選択を訊かれる。
 * 簡単ステップメニューは**最上段で一度選んでおく**形にして、そのあとは訊かない。
 * 選んだ作品は `command.arguments` に載せて渡す（`resolveWork` が受ける形）。
 *
 * 作品を選んでいないときは、**消さずに押せなくして理由を出す**——
 * 詳細メニューや編集者モードと同じ考え方である。
 *
 * ただし**作品を要さない操作は、未選択でも押せる**。最下段の「ヘルプ」が
 * それで、作品を選ぶ前でも読める（判定は `requiresWork` 任せなので、
 * ここに例外は書かない）。
 */

/** 参照を解いたあとの小分類 */
export interface StepSection {
  kind: "section";
  label: string;
  icon: string;
  items: ActionItem[];
}

/** 参照を解いたあとの段階 */
export interface Step {
  kind: "step";
  label: string;
  icon: string;
  detail: string;
  entries: Array<ActionItem | StepSection | StepPlaceholder>;
}

/** コマンドIDから操作の実体を引く索引。**実体は詳細メニューにしか無い** */
export function actionIndex(): Map<string, ActionItem> {
  return new Map(allActions().map((item) => [item.command, item]));
}

/**
 * 参照（コマンドID）を実体へ解く。
 *
 * 見つからない参照は**落として先へ進む**。1行欠けるだけで済むのに、
 * ここで投げるとメニュー全体が出なくなり、しかも原因が画面に出ない。
 * 代わりに `missing` へ残して、テストで開発時に気づけるようにする。
 */
export function resolveSteps(
  defs: readonly StepDef[],
  index: ReadonlyMap<string, ActionItem>
): { steps: Step[]; missing: string[] } {
  const missing: string[] = [];
  const lookup = (command: string): ActionItem | undefined => {
    const found = index.get(command);
    if (!found) missing.push(command);
    return found;
  };

  const steps = defs.map((def) => {
    const entries: Array<ActionItem | StepSection | StepPlaceholder> = [];
    for (const entry of def.entries) {
      if (typeof entry === "string") {
        const item = lookup(entry);
        if (item) entries.push(item);
        continue;
      }
      if (entry.kind === "placeholder") {
        entries.push(entry);
        continue;
      }
      entries.push({
        kind: "section",
        label: entry.label,
        icon: entry.icon,
        items: entry.commands
          .map((command) => lookup(command))
          .filter((item): item is ActionItem => item !== undefined),
      });
    }
    return {
      kind: "step" as const,
      label: def.label,
      icon: def.icon,
      detail: def.detail,
      entries,
    };
  });

  return { steps, missing };
}

/**
 * 選んだ作品のタイプに合う段だけを残す（設計書6.70.1）。
 *
 * **判断は表（`core/workTypeVisibility.ts`）に任せる。** ここで
 * 「メモ集なら伏線は出さない」と書き始めると、右クリック側の判断と
 * 二重になり、片方だけ直したときに食い違う。
 *
 * 中身が全部消えた小分類は見出しごと畳み、entries が空になった段は
 * 段ごと出さない（詳細メニューの `shownEntries` と同じ考え方——
 * 開いても何も無い行は、片づけたつもりで分かりにくくしているだけ）。
 *
 * @param column タイプの列。**undefined なら形式では絞らない**
 *   （タイプを決めていない作品と、作品を選んでいないとき）
 * @param kind 作品の種類（設計書6.109.7）。**undefined なら種類では絞らない**。
 *   形式と種類の**両方が「見せる」と言ったときだけ**残す
 */
export function filterSteps(
  steps: readonly Step[],
  column: WorkTypeColumn | undefined,
  kind?: WorkKindKey
): Step[] {
  if (!column && !kind) return [...steps];

  const visible = (command: string): boolean =>
    (!column || isCommandVisibleForColumn(command, column)) &&
    isCommandVisibleForKind(command, kind);

  const filtered: Step[] = [];
  for (const step of steps) {
    const entries: Step["entries"] = [];
    for (const entry of step.entries) {
      if (entry.kind === "action") {
        if (visible(entry.command)) entries.push(entry);
        continue;
      }
      if (entry.kind === "placeholder") {
        entries.push(entry);
        continue;
      }
      const items = entry.items.filter((item) => visible(item.command));
      if (items.length > 0) entries.push({ ...entry, items });
    }
    if (entries.length > 0) filtered.push({ ...step, entries });
  }
  return filtered;
}

const resolved = resolveSteps(STEP_DEFS, actionIndex());

/** 画面に出す簡単ステップメニュー */
export const STEP_MENU: readonly Step[] = resolved.steps;

/**
 * 実体が見つからなかった参照。
 *
 * **空でなければならない。** コマンドを改名して参照が切れると、
 * 画面からは操作が1つ消えるだけで気づけないので、テストで止める。
 */
export const STEP_MENU_MISSING_COMMANDS: readonly string[] = resolved.missing;


/** 最上段の作品選択窓を押したときに走るコマンド */
export const STEP_WORK_COMMAND = "novelai.chooseStepWork";

/** 作品が1つも登録されていないときの、最上段の表示 */
export const STEP_NO_WORK_LABEL = "未登録";
export const STEP_NO_WORK_HINT = "作品登録（ステップ1）から";

/**
 * 作品は登録されているが、まだ選んでいないときの、最上段の表示。
 * 名前は「作品選択」（作者の裁定、2026-09-23。旧「作品を選ぶ」）
 */
export const STEP_CHOOSE_WORK_LABEL = "作品選択";

/**
 * 作品を選んでいないために押せないときの理由。
 *
 * **`REQUIRES_WORK_HINT`（作品を登録すると使えます）とは分ける。**
 * 登録は済んでいるのに「登録してください」と出ると、作者は何をすれば
 * よいのか分からないまま登録済みの作品を登録し直そうとする。
 */
export const STEP_SELECT_HINT = "最上段で作品を選ぶと使えます";

/** 準備中の項目に出す薄字 */
const PLACEHOLDER_DESCRIPTION = "予定";

/**
 * いま対象になっている作品。**表示のたびに導く。**
 *
 * 覚えているのはIDだけなので、作品が登録から消えていれば未選択へ戻す。
 * 1件しか無ければ選ぶ手間を取らせない。
 */
export function resolveSelectedWork(
  works: readonly WorkEntry[],
  savedId: string | undefined
): WorkEntry | undefined {
  if (works.length === 0) return undefined;
  if (works.length === 1) return works[0];
  return works.find((work) => work.id === savedId);
}

/**
 * 最上段に出す文言。
 *
 * **題は省略する**（作者の裁定、2026-09-06。設計書6.70）。作品名は
 * 作者が付けたものなので長さに上限が無く、この1行が幅を使い切ると、
 * 下に並ぶ操作より先に読めない行ができる。作品一覧・QuickPick は
 * 既に `abbreviateTitle` を通しているので、そちらに揃える。
 *
 * **切ったときは `fullTitle` を返す。** 呼ぶ側がホバーへ全文を出す
 * ——省略は表示だけの話で、読めなくしてよいという話ではない。
 */
export function describeSelector(
  selected: WorkEntry | undefined,
  hasAnyWork: boolean
): { label: string; description: string; fullTitle?: string } {
  if (!hasAnyWork) {
    return { label: STEP_NO_WORK_LABEL, description: STEP_NO_WORK_HINT };
  }
  // 「選択作品：」の文言と、押して選び直す形は作者の指定（2026-08-28）
  if (selected) {
    return {
      label: `選択作品：${abbreviateTitle(selected.title)}`,
      description: "",
      ...(isAbbreviated(selected.title)
        ? { fullTitle: selected.title }
        : {}),
    };
  }
  return { label: STEP_CHOOSE_WORK_LABEL, description: "" };
}

/**
 * ビューの見出し（「簡単ステップメニュー」の右の薄字）に出す文字。
 *
 * **選んだ作品名はここに出さない**（作者の撤回、2026-08-28。
 * 「右側に作品名はやっぱり入れなくて良いです」——最上段の
 * 「選択作品：〜」の行が代わりを務める）。残すのは、下の操作が
 * 使えない状態の注意（未登録・未選択）だけ。
 */
export function stepViewDescription(
  selected: WorkEntry | undefined,
  hasAnyWork: boolean
): string {
  if (!hasAnyWork) return STEP_NO_WORK_LABEL;
  if (selected) return "";
  return STEP_CHOOSE_WORK_LABEL;
}

/**
 * 押せない理由。**作品が「無い」のか「選ばれていない」のかを分ける。**
 *
 * 判定そのものは詳細メニューの `disabledHint` を使い回し、
 * `hasWork` には**選ばれているか**を渡す（登録の有無ではない）。
 */
export function stepDisabledHint(
  item: ActionItem,
  works: { hasAnyWork: boolean; hasSelectedWork: boolean },
  mode: WorkMode = "author",
  runtimeAllowsProcesses = true
): string | undefined {
  const hint = disabledHint(
    item,
    works.hasSelectedWork,
    mode,
    runtimeAllowsProcesses
  );
  if (hint === REQUIRES_WORK_HINT && works.hasAnyWork) return STEP_SELECT_HINT;
  return hint;
}

/**
 * コマンドへ「この作品で」と渡す入れ物。
 *
 * `extension.ts` の `WorkRef` と同じ形。**型をimportしない**のは、
 * `views` から `extension` を参照すると循環するため。受け手（`resolveWork`）は
 * 種別と作品しか見ないので、この形だけで通る。
 */
interface StepWorkRef {
  type: "work";
  work: WorkEntry;
}

/** ツリーの節点 */
export type StepNode =
  | { type: "selector" }
  | { type: "step"; step: Step }
  | { type: "section"; section: StepSection; stepLabel: string }
  | { type: "action"; item: ActionItem }
  | { type: "placeholder"; placeholder: StepPlaceholder; stepLabel: string };

/** 開閉状態を覚えるための鍵。段階は名前、小分類は「段階/小分類」 */
export function stepNodeKey(node: StepNode): string {
  switch (node.type) {
    case "step":
      return node.step.label;
    case "section":
      return `${node.stepLabel}/${node.section.label}`;
    case "action":
      return node.item.command;
    case "placeholder":
      return `${node.stepLabel}/${node.placeholder.label}`;
    default:
      return "selector";
  }
}

/** 保存された値のうち、いまも存在する段階・小分類だけを残す */
export function restoreExpandedSteps(saved: string[]): Set<string> {
  const known = new Set<string>();
  for (const step of STEP_MENU) {
    known.add(step.label);
    for (const entry of step.entries) {
      if (entry.kind === "section") known.add(`${step.label}/${entry.label}`);
    }
  }
  // 段階の名前を変えたり減らしたりしたときに、古い名前が残らないようにする
  return new Set(saved.filter((key) => known.has(key)));
}

/**
 * 選んだ作品の保存先。
 *
 * `GroupStateStore` と同じく、VS Code の globalState をそのまま受け取らず
 * 細い口にする（この判断をテストできるようにするため）。
 */
export interface StepWorkStore {
  get(): string | undefined;
  set(id: string | undefined): void;
}

/**
 * 件数を答える口。**作品を渡す。**
 *
 * 詳細メニューの `ActionCounts` とは分ける。あちらは作品を選ばずに見るので
 * 全作品合計でよいが、こちらは最上段で作品を選ぶ画面なので、
 * 選んだ作品の件数でなければ意味が食い違う（作者の実機報告、2026-09-05。
 * 選択作品は重複0なのに「24」と出ていた）。
 */
export type StepActionCounts = (
  counter: ActionCounter,
  workId: string
) => number;

export class StepMenuProvider implements vscode.TreeDataProvider<StepNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    StepNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /**
   * 開いている段階・小分類。
   *
   * **既定はすべて閉じる。** 7段階を全部開くと40行近くが縦に並び、
   * 上に置いた作品一覧が押し出される（詳細メニューと同じ理由）。
   */
  private readonly expanded: Set<string>;

  /**
   * 作品ごとのタイプ（設計書6.70.1）。
   *
   * **描画は同期なので、読めた結果をここへ置く。** まだ読んでいない
   * あいだは絞らない（全部出す）ので、遅れて絞り込まれることはあっても、
   * 出るはずの操作が最初から見えない状態にはならない。
   */
  private readonly formats = new Map<string, WorkFormatKey | undefined>();

  /**
   * 作品ごとの種類（設計書6.109.7）。形式と同じ時に読み、同じ時に捨てる。
   * **読めていないあいだは絞らない**（形式と同じ理由）。
   */
  private readonly kinds = new Map<string, WorkKindKey | undefined>();

  constructor(
    private readonly registry: WorkRegistry,
    private readonly workStore?: StepWorkStore,
    private readonly groupStore?: GroupStateStore,
    private readonly counts?: StepActionCounts,
    /**
     * 作品のタイプを読む口。試験で差し替えるために関数で受け取る
     * （プロットを読む処理そのものは `workFormatStore` の1か所だけ）。
     */
    private readonly loadFormat: (
      work: WorkEntry
    ) => Promise<WorkFormatKey | undefined> = readWorkFormat,
    /** 作品の種類を読む口（設計書6.109.7）。形式と同じく試験で差し替える */
    private readonly loadKind: (
      work: WorkEntry
    ) => Promise<WorkKindKey | undefined> = readWorkKind
  ) {
    this.expanded = restoreExpandedSteps(groupStore?.get() ?? []);
    // 作品が増減すると、最上段の表示も押せる操作も変わる
    registry.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  /**
   * 選んでいる作品のタイプを読み込む。読めたら表示を作り直す。
   *
   * **描画の途中では待てない**（`getTreeItem` も `getChildren` も同期の
   * 形で答える）ので、読み込みは背後で走らせ、結果が出てから並べ直す。
   * 作品を選び直したときと、ツリーを描くときに呼ぶ。
   */
  async loadSelectedFormat(): Promise<void> {
    const work = this.selectedWork();
    if (!work || this.formats.has(work.id)) return;
    let format: WorkFormatKey | undefined;
    try {
      format = await this.loadFormat(work);
    } catch {
      // 読めなければ「決めていない」と同じ扱い。絞らずに全部出す
      format = undefined;
    }
    let kind: WorkKindKey | undefined;
    try {
      kind = await this.loadKind(work);
    } catch {
      // 種類も、読めなければ絞らない
      kind = undefined;
    }
    // **形式と種類を同じ時に置く。** 形式だけ先に置くと、その間の描画で
    // 種類の絞り込みが抜けた並びが一瞬出る
    this.kinds.set(work.id, kind);
    this.formats.set(work.id, format);
    this._onDidChangeTreeData.fire();
  }

  /**
   * いま並べる段。**作品を選んでいなければ絞らない。**
   *
   * 何に効くか決まっていないのに項目を消すと、初めて使う人には
   * 「入れたのに機能が足りない」に見える。
   */
  visibleSteps(): readonly Step[] {
    const work = this.selectedWork();
    if (!work) return STEP_MENU;
    if (!this.formats.has(work.id)) {
      // まだ読んでいない。背後で読ませて、いまは全部出す
      void this.loadSelectedFormat();
      return STEP_MENU;
    }
    return filterSteps(
      STEP_MENU,
      workTypeColumn(this.formats.get(work.id)),
      this.kinds.get(work.id)
    );
  }

  /** 画面で開閉したときに呼ぶ。次回起動時もこの状態で開く */
  setExpanded(key: string, open: boolean): void {
    if (open) {
      this.expanded.add(key);
    } else {
      this.expanded.delete(key);
    }
    this.groupStore?.set([...this.expanded]);
  }

  /** テストと復元の確認用 */
  expandedGroups(): string[] {
    return [...this.expanded];
  }

  /** いま対象になっている作品。保存IDが実在しなければ未選択として扱う */
  selectedWork(): WorkEntry | undefined {
    return resolveSelectedWork(this.registry.list(), this.workStore?.get());
  }

  /** 最上段で選び直したときに呼ぶ */
  selectWork(id: string | undefined): void {
    this.workStore?.set(id);
    this.refresh();
  }

  /**
   * 覚えたタイプを捨てる。**プロットの `## 形式` が書き換わったときに呼ぶ。**
   *
   * 呼ばないと、タイプを変えたのにステップの並びが前のままになる
   * （作品一覧が `invalidateWorkFormat` で読み直すのと同じ理由）。
   */
  invalidateFormats(workId?: string): void {
    // 種類（設計書6.109.7）も一緒に捨てる。「作品の種類」で変えたときと、
    // 設定ファイルを手で直して保存したときもここを通る
    if (workId) {
      this.formats.delete(workId);
      this.kinds.delete(workId);
    } else {
      this.formats.clear();
      this.kinds.clear();
    }
    this.refresh();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: StepNode): vscode.TreeItem {
    if (node.type === "selector") return this.selectorItem();
    if (node.type === "step" || node.type === "section") {
      return this.headingItem(node);
    }
    if (node.type === "placeholder") return placeholderItem(node.placeholder);
    return this.actionItem(node.item);
  }

  /**
   * 親をたどる（設計書6.104）。
   *
   * **`TreeView.reveal()` を使うために要る**（詳細メニューと同じ理由）。
   * 探すのは `visibleSteps()` の中だけ——作品のタイプで消えている段を
   * 親として返すと、画面に無い行を開こうとして空振りする。
   */
  getParent(node: StepNode): StepNode | undefined {
    if (node.type === "selector" || node.type === "step") return undefined;
    if (node.type === "section" || node.type === "placeholder") {
      const step = this.visibleSteps().find(
        (entry) => entry.label === node.stepLabel
      );
      return step ? { type: "step", step } : undefined;
    }

    for (const step of this.visibleSteps()) {
      for (const entry of step.entries) {
        if (entry.kind === "action") {
          if (entry.command === node.item.command) return { type: "step", step };
          continue;
        }
        if (entry.kind !== "section") continue;
        if (entry.items.some((item) => item.command === node.item.command)) {
          return { type: "section", section: entry, stepLabel: step.label };
        }
      }
    }
    return undefined;
  }

  /**
   * コマンドIDから、いま並んでいる操作の節点を引く。
   *
   * **無ければ undefined。** 簡単ステップメニューに置いていない操作
   * （投稿の「新話を投稿」など）があるので、案内（設計書6.104）は
   * ここで空振りを知って詳細メニューへ回る。
   */
  findActionNode(command: string): StepNode | undefined {
    for (const step of this.visibleSteps()) {
      for (const entry of step.entries) {
        if (entry.kind === "action") {
          if (entry.command === command) return { type: "action", item: entry };
          continue;
        }
        if (entry.kind !== "section") continue;
        const found = entry.items.find((item) => item.command === command);
        if (found) return { type: "action", item: found };
      }
    }
    return undefined;
  }

  getChildren(node?: StepNode): StepNode[] {
    if (!node) {
      // **最上段は作品選択窓。** 下に並ぶものが何に効くのかを、
      // 押す前に見えるようにする
      return [
        { type: "selector" },
        ...this.visibleSteps().map((step) => ({ type: "step" as const, step })),
      ];
    }
    if (node.type === "step") {
      return node.step.entries.map((entry) => stepChild(entry, node.step.label));
    }
    if (node.type === "section") {
      return node.section.items.map((item) => ({
        type: "action" as const,
        item,
      }));
    }
    return [];
  }

  private selectorItem(): vscode.TreeItem {
    const works = this.registry.list();
    const selected = this.selectedWork();
    const view = describeSelector(selected, works.length > 0);

    const item = new vscode.TreeItem(
      view.label,
      vscode.TreeItemCollapsibleState.None
    );
    item.description = view.description;
    item.contextValue = "stepWorkSelector";
    item.iconPath =
      works.length === 0
        ? new vscode.ThemeIcon(
            "book",
            new vscode.ThemeColor("disabledForeground")
          )
        : // ✓は出さない（作者の指定、2026-08-28）。押すと選び直せる行
          // なので、選択肢が下りてくる印（∨）にする
          new vscode.ThemeIcon("chevron-down");
    item.tooltip = new vscode.MarkdownString(
      works.length === 0
        ? // 1行目は `package.json` の `viewsWelcome` と同じ字面にしておく。
          // 片方だけ言い換えると、2つの画面が同じ状態を別の言葉で言い出す
          "まだ作品が登録されていません。\n\n" +
          "・「1. 作品登録」から登録すると、下の操作が使える"
        : // 切った題の全文はここに出す（切りっぱなしにしない）
          (view.fullTitle ? `**${view.fullTitle}**\n\n` : "") +
            "下に並ぶ操作は、ここで選んだ作品にだけ効く\n\n" +
            "・押すと、登録している作品から選び直せる"
    );
    // 作品が無いときは押しても選ぶものが無い。押せなくして理由を description に出す
    if (works.length > 0) {
      item.command = {
        command: STEP_WORK_COMMAND,
        title: "簡単ステップメニューの作品を選ぶ",
      };
    }
    return item;
  }

  private headingItem(
    node: Extract<StepNode, { type: "step" | "section" }>
  ): vscode.TreeItem {
    const key = stepNodeKey(node);
    const label = node.type === "step" ? node.step.label : node.section.label;
    const icon = node.type === "step" ? node.step.icon : node.section.icon;
    const item = new vscode.TreeItem(
      label,
      this.expanded.has(key)
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
    );
    item.contextValue = node.type === "step" ? "stepGroup" : "stepSection";
    item.iconPath = new vscode.ThemeIcon(icon);

    // **見出しには resourceUri を付けない。** 末尾の印を出す仕組み
    // （`actionDecorations.ts`）は詳細メニューの鍵しか知らないので、
    // ここで架空のURIを渡しても何も出ない。代わりに件数はホバーへ出す
    const entries =
      node.type === "step" ? node.step.entries : [...node.section.items];
    const pending = this.countIn(entries);
    const detail = node.type === "step" ? node.step.detail : "";
    item.tooltip = new vscode.MarkdownString(
      [detail, pending > 0 ? `\n\n未反映: ${pending} 件` : ""].join("")
    );
    return item;
  }

  private actionItem(action: ActionItem): vscode.TreeItem {
    const works = this.registry.list();
    const selected = this.selectedWork();
    const mode = currentMode();
    const runtimeAllowsProcesses = canRunProcesses();
    // **作品が「選ばれているか」で判定する。** 登録の有無ではない
    const enabled = isActionEnabled(
      action,
      selected !== undefined,
      mode,
      runtimeAllowsProcesses
    );
    const hint = stepDisabledHint(
      action,
      {
        hasAnyWork: works.length > 0,
        hasSelectedWork: selected !== undefined,
      },
      mode,
      runtimeAllowsProcesses
    );

    const item = new vscode.TreeItem(
      action.label,
      vscode.TreeItemCollapsibleState.None
    );
    item.description = enabled ? (action.description ?? "") : (hint ?? "");
    item.iconPath = enabled
      ? new vscode.ThemeIcon(action.icon)
      : // 色を落として、押せるものと見分けられるようにする
        new vscode.ThemeIcon(
          action.icon,
          new vscode.ThemeColor("disabledForeground")
        );

    const count = this.countOf(action.counter);
    item.tooltip = new vscode.MarkdownString(
      [
        enabled ? "" : `**${hint}。** ${nextStepFor(action, hint)}\n\n`,
        // **段落で切る**（詳細メニューと同じ理由。説明文が二段組みになった）
        action.usesAI
          ? "**AIを使う**（クラウドのAIは実行のたびに課金）\n\n"
          : "",
        action.detail,
        count > 0 ? `\n\n未反映: ${count} 件` : "",
      ].join("")
    );
    // 「AI」と件数の印は、詳細メニューと同じ仕組みで出す（新しい仕組みは作らない）。
    // ただし**目印には選んだ作品を混ぜる**——同じ鍵にすると、詳細メニュー用の
    // 全作品合計がそのまま出る（作者の実機報告、2026-09-05）
    item.resourceUri = stepActionResourceUri(
      { type: "action", item: action },
      selected?.id
    );

    if (enabled) {
      item.command = {
        command: action.command,
        title: action.label,
        // **作品を要する操作にだけ渡す。** 開いているファイルに効く操作
        // （ルビ・傍点など）へ作品を渡すと、対象がすり替わる
        arguments:
          action.requiresWork && selected ? [workRef(selected)] : [],
      };
    }
    // **押せないものは command を持たせない**（詳細メニューと同じ）
    return item;
  }

  private countOf(counter: ActionCounter | undefined): number {
    if (!counter || !this.counts) return 0;
    // **作品を選んでいないときは数えない**（設計書6.29）。
    // どの作品の数字か分からないものを出すと、選択中の作品の件数に見える
    const work = this.selectedWork();
    return work ? this.counts(counter, work.id) : 0;
  }

  /** 段階・小分類を閉じたままでも、溜まっていることが分かるようにする */
  private countIn(
    entries: ReadonlyArray<ActionItem | StepSection | StepPlaceholder>
  ): number {
    let total = 0;
    for (const entry of entries) {
      if (entry.kind === "action") {
        total += this.countOf(entry.counter);
      } else if (entry.kind === "section") {
        for (const item of entry.items) total += this.countOf(item.counter);
      }
    }
    return total;
  }
}

function stepChild(
  entry: ActionItem | StepSection | StepPlaceholder,
  stepLabel: string
): StepNode {
  if (entry.kind === "section") {
    return { type: "section", section: entry, stepLabel };
  }
  if (entry.kind === "placeholder") {
    return { type: "placeholder", placeholder: entry, stepLabel };
  }
  return { type: "action", item: entry };
}

function placeholderItem(placeholder: StepPlaceholder): vscode.TreeItem {
  const item = new vscode.TreeItem(
    placeholder.label,
    vscode.TreeItemCollapsibleState.None
  );
  item.description = PLACEHOLDER_DESCRIPTION;
  item.contextValue = "stepPlaceholder";
  item.iconPath = new vscode.ThemeIcon(
    placeholder.icon,
    new vscode.ThemeColor("disabledForeground")
  );
  item.tooltip = new vscode.MarkdownString(placeholder.detail);
  // **command は持たせない。** 押しても何も起きないことを、押す前に伝える
  return item;
}

/** 押せない理由に、次に取れる手を添える */
function nextStepFor(action: ActionItem, hint: string | undefined): string {
  if (hint === STEP_SELECT_HINT) {
    return "最上段の作品選択を押して、対象の作品を選ぶ。";
  }
  return explainDisabled(action, hint);
}

function workRef(work: WorkEntry): StepWorkRef {
  return { type: "work", work };
}
