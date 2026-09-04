import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import type { WorkRegistry } from "../core/workRegistry";
import { currentMode } from "../core/actorContext";
import type { WorkMode } from "../core/editorMode";
import { canRunProcesses } from "../core/runtime";
import type { WorkFormatKey } from "../core/workFormat";
import { readWorkFormat } from "../core/workFormatStore";
import {
  isCommandVisibleForColumn,
  workTypeColumn,
  type WorkTypeColumn,
} from "../core/workTypeVisibility";
import {
  actionResourceUri,
  allActions,
  disabledHint,
  explainDisabled,
  isActionEnabled,
  REQUIRES_WORK_HINT,
  type ActionCounter,
  type ActionCounts,
  type ActionItem,
  type GroupStateStore,
} from "./actionList";

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
 * `test/unit/stepMenu.test.ts` が落ちる。
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
const STEP_DEFS: readonly StepDef[] = [
  {
    label: "1. 作品登録",
    icon: "folder-opened",
    detail:
      "書く作品を、この拡張機能に覚えさせる段階です。" +
      "すでに原稿があるフォルダーでも、別のPCで書いている作品でも登録できます。",
    entries: ["novelai.addWork", "novelai.addWorkFromGithub"],
  },
  {
    label: "2. 新作構想",
    icon: "list-tree",
    detail:
      "何を書くかを決める段階です。" +
      "ログライン・テーマ・世界観・あらすじをプロットに書き留めます。",
    entries: [
      "novelai.createWorkWithPlot",
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
      "本文を書き進める段階です。" +
      "書く場・設定資料づくり・入力の手間を減らす操作を分けて並べています。",
    entries: [
      {
        kind: "section",
        label: "執筆の場",
        icon: "book",
        commands: [
          // **先頭は「執筆を再開する」**（設計書6.36.4）。
          // 続きを書く日に最初に押すもので、AIを呼ばずにその場で出る
          "novelai.resumeWriting",
          "novelai.createEpisodePlot",
          // 本文の付箋を横に並べる画面（設計書6.40.4）。書きながら見るもの
          "novelai.openSceneMemos",
          "novelai.createWorkFromManuscript",
          "novelai.openVertical",
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
        label: "入力を楽に",
        icon: "symbol-keyword",
        commands: [
          "novelai.convertToMarkdown",
          "novelai.addRuby",
          "novelai.addEmphasis",
          "novelai.exportImeDictionary",
        ],
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
      "書いた本文を、人に見せる前に自分で見直す段階です。" +
      "本文は勝手に書き換わりません。指摘を1件ずつ見て決めます。",
    entries: [
      "novelai.checkTypos",
      "novelai.manageKeepWords",
      "novelai.checkNotation",
      "novelai.checkProofread",
      "novelai.checkOpening",
      "novelai.checkDeviations",
      "novelai.checkContradictions",
      // 伏線は矛盾の次に置く。矛盾検知の指摘から
      // 「伏線として登録」で飛んでくるため（設計書6.35.4）
      "novelai.checkForeshadows",
      "novelai.checkForeshadowResolution",
      "novelai.openForeshadows",
      "novelai.setForeshadowStatus",
    ],
  },
  {
    label: "5. 投稿脱稿",
    icon: "rocket",
    detail:
      "投稿サイトへ出す段階です。" +
      "あらすじ・紹介文・キャッチコピーを整えて、本文を投稿サイトの形に直します。",
    entries: [
      "novelai.generateSynopses",
      "novelai.generateWorkBlurb",
      "novelai.generateCatchphrases",
      "novelai.openSynopsisDocs",
      "novelai.copyForPosting",
      "novelai.shareWithEditor",
      {
        kind: "placeholder",
        label: "WEB投稿支援（準備中）",
        icon: "globe",
        detail:
          "ブラウザ内蔵の投稿支援を予定しています。" +
          "いまは「投稿サイト用に変換してコピー」で各サイトへ貼り付けてください。",
      },
    ],
  },
  {
    label: "6. 編集部校正・校閲",
    icon: "organization",
    detail:
      "編集部と一緒に仕上げる段階です。" +
      "編集部は本文を書き換えず、提案として置きます。",
    entries: [
      "novelai.switchMode",
      "novelai.toggleReviewLock",
      "novelai.collectEditorProposals",
      "novelai.reviewProposals",
      "novelai.showEditHistory",
    ],
  },
  {
    label: "7. 電子出版等",
    icon: "package",
    detail:
      "書き上げた作品を、紙や電子書籍の形にして出す段階です。" +
      "PDF（印刷用）とEPUB（電子書籍）が作れます。" +
      "本の見た目はEPUBエディターで確かめながら決められます。",
    // **「EPUB出力（予定）」の枠は外した**（作者の指定、2026-09-03）。
    // 設計書6.65が実装できたので、枠ではなく実物を載せる
    entries: [
      "novelai.exportPdf",
      "novelai.exportEpub",
      "novelai.openEpubEditor",
    ],
  },
  {
    // **番号を付けない**（作者の指定、2026-08-29）。流れの中の一段階ではなく、
    // どの段階からでも寄る場所である。アイコンは詳細メニューの「ヘルプ」と
    // 同じ question にして、同じものだと分かるようにする
    label: "ヘルプ",
    icon: "question",
    detail:
      "使い方が分からなくなったときや、うまく動かないときに開く場所です。" +
      "作品を選んでいなくても使えます。",
    // 並びは詳細メニューの「ヘルプ」分類に合わせる（使い方 → ログ → 版）。
    // 「動作を診断」はブラウザ版だけの操作なので、ここには置かない
    entries: [
      "novelai.openManual",
      "novelai.showLog",
      "novelai.openChatLog",
      "novelai.showVersion",
    ],
  },
];

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
 * @param column タイプの列。**undefined なら絞らない**
 *   （タイプを決めていない作品と、作品を選んでいないとき）
 */
export function filterSteps(
  steps: readonly Step[],
  column: WorkTypeColumn | undefined
): Step[] {
  if (!column) return [...steps];

  const visible = (command: string): boolean =>
    isCommandVisibleForColumn(command, column);

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

/** 簡単ステップメニューが参照しているコマンドID */
export const STEP_REFERENCED_COMMANDS: readonly string[] =
  referencedCommands(STEP_DEFS);

/** 最上段の作品選択窓を押したときに走るコマンド */
export const STEP_WORK_COMMAND = "novelai.chooseStepWork";

/** 作品が1つも登録されていないときの、最上段の表示 */
export const STEP_NO_WORK_LABEL = "未登録";
export const STEP_NO_WORK_HINT = "作品登録（ステップ1）から始めてください";

/** 作品は登録されているが、まだ選んでいないときの、最上段の表示 */
export const STEP_CHOOSE_WORK_LABEL = "作品を選んでください";

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

/** 最上段に出す文言 */
export function describeSelector(
  selected: WorkEntry | undefined,
  hasAnyWork: boolean
): { label: string; description: string } {
  if (!hasAnyWork) {
    return { label: STEP_NO_WORK_LABEL, description: STEP_NO_WORK_HINT };
  }
  // 「選択作品：」の文言と、押して選び直す形は作者の指定（2026-08-28）
  if (selected) {
    return { label: `選択作品：${selected.title}`, description: "" };
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

  constructor(
    private readonly registry: WorkRegistry,
    private readonly workStore?: StepWorkStore,
    private readonly groupStore?: GroupStateStore,
    private readonly counts?: ActionCounts,
    /**
     * 作品のタイプを読む口。試験で差し替えるために関数で受け取る
     * （プロットを読む処理そのものは `workFormatStore` の1か所だけ）。
     */
    private readonly loadFormat: (
      work: WorkEntry
    ) => Promise<WorkFormatKey | undefined> = readWorkFormat
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
    return filterSteps(STEP_MENU, workTypeColumn(this.formats.get(work.id)));
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
    if (workId) {
      this.formats.delete(workId);
    } else {
      this.formats.clear();
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
        ? "**まだ作品が登録されていません。**\n\n" +
          "「1. 作品登録」から登録すると、下の操作が使えるようになります。"
        : "**下に並ぶ操作は、ここで選んだ作品にだけ効きます。**\n\n" +
          "押すと、登録している作品から選び直せます。"
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
        action.usesAI
          ? "**AIを使います**（クラウドのAIは実行のたびに課金されます）\n"
          : "",
        action.detail,
        count > 0 ? `\n\n未反映: ${count} 件` : "",
      ].join("")
    );
    // 「AI」と件数の印は、詳細メニューと同じ目印で出す（新しい仕組みは作らない）
    item.resourceUri = actionResourceUri({ type: "action", item: action });

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
    return counter && this.counts ? this.counts(counter) : 0;
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
    return "最上段の作品選択を押して、対象の作品を選んでください。";
  }
  return explainDisabled(action, hint);
}

function workRef(work: WorkEntry): StepWorkRef {
  return { type: "work", work };
}
