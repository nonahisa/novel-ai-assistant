import {
  ACTION_TREE,
  commandsHiddenForMode,
  findAction,
  isItemVisibleInRuntime,
  menuEntries,
  shownEntries,
  type ActionItem,
} from "./actionTree";
import { entranceOf } from "./actionEntrance";
import { activeModeForGuide, isCommandAllowed, type WorkMode } from "./editorMode";
import { processCommandsUsableHere } from "./processAvailability";
import {
  EDITOR_END_WORK_COMMAND,
  EDITOR_JOIN_COMMAND,
  EDITOR_MENU_BACK_COMMAND,
  EDITOR_MENU_HELP,
  EDITOR_MENU_LABELS,
  EDITOR_STEP_DEFS,
  EDITOR_WORK_COMMAND,
  STEP_DEFS,
  type EditorMenuEntry,
} from "./stepDefs";
import type { MenuEntry } from "./menuMentions";

/**
 * 使い方の答えに添える「メニューの場所の図」（設計書6.118。作者の依頼、2026-11-05）。
 *
 * 作者の言葉：「光るのとメニューを開くだけではわかりにくいので、メニュー構造の模式図を
 * 出す等できればいいなと思いました」。
 *
 * ## 図はコードが作る。AIには書かせない
 *
 * 道順をAIに書かせると、無い分類や古い名前を混ぜる（実装ルール3）。ここでは
 * 詳細メニュー（`ACTION_TREE`）・簡単ステップメニュー（`STEP_DEFS`）・編集者メニュー
 * （`EDITOR_STEP_DEFS`）の定義そのものを歩いて組む。画面と同じ定義を読むので、
 * メニューを組み替えた日に図だけ古くなることがない。
 *
 * ## 最初の一押しから毎回全部
 *
 * 作者はスマホで読むことがあり、上の答えへ戻れない（2026-11-05 の作者の指摘）。
 * 図は毎回、左の端のアイコンから書く。前の図を指して省かない。
 *
 * ## 関数は1か所
 *
 * 相談パネルと MCP の両方がここを呼ぶ。`menuMentions.ts` と同じ理由で、写しを作ると
 * 「相談では図が出るのに外からは古い図が出る」という食い違いが起きる。
 *
 * VS Code に依らない（MCP の束からも読む）。
 */

/** 最初の一押し。左の端（アクティビティバー）にある、この拡張機能のアイコン */
export const MENU_PATH_START =
  "左の端の統合小説執筆環境のアイコン（キーボードと万年筆）";

/** 区画（横の枠に並ぶビュー）の名前。`package.json` の `views` の `name` と同じ字 */
export const MENU_SECTION_NAMES = {
  editorMenu: "編集者メニュー",
  steps: "簡単ステップメニュー",
  actions: "詳細メニュー",
} as const;

/** 道がどこを通るか。`entrance` はメニューの外の入口（原稿エディターの中など） */
export type MenuPathPlace = keyof typeof MENU_SECTION_NAMES | "entrance";

export interface MenuPath {
  readonly place: MenuPathPlace;
  /**
   * 区画から目標までの名前（区画の名前を含む）。最初の一押し（`MENU_PATH_START`）は含めない。
   * 入口（`entrance`）のときは空
   */
  readonly trail: readonly string[];
  /** 目標と同じ階層に並ぶ名前（画面の順。目標を含む）。入口のときは空 */
  readonly siblings: readonly string[];
  /** メニューの外の入口の案内（`entrance` のときだけ） */
  readonly entrance?: string;
}

/**
 * 編集者メニューの1項目を、詳細メニューの操作と同じ形にする。
 *
 * 文字列（コマンドID）なら詳細メニューから引き、詳細メニューに無い操作（置いた提案の一覧など）は
 * 定義が持つ名前と説明で作る。画面（`views/editorMenu.ts`）・図・相談の手順書きが同じものを使う。
 */
export function resolveEditorEntry(entry: EditorMenuEntry): ActionItem | undefined {
  if (typeof entry === "string") return findAction(entry);
  return {
    kind: "action",
    command: entry.command,
    label: entry.label,
    icon: entry.icon,
    requiresWork: entry.requiresWork,
    detail: entry.detail,
  };
}

/**
 * 編集者メニューにしか無い操作（定義が名前と説明を持つもの）を引く。詳細メニューにある操作は
 * undefined（そちらは `findAction` で引く）
 */
export function findEditorMenuOnlyAction(command: string): ActionItem | undefined {
  for (const entry of [...EDITOR_STEP_DEFS.flatMap((def) => def.entries), ...EDITOR_MENU_HELP]) {
    if (typeof entry !== "string" && entry.command === command) return resolveEditorEntry(entry);
  }
  return undefined;
}

/**
 * その操作に行ける道を、画面に出ているものだけ全部返す。
 *
 * 並びは「そのモードで作者が普段たどる道」が先：作者モードは簡単ステップメニュー →
 * 詳細メニュー、編集者モードは編集者メニュー → 詳細メニュー。どのメニューにも出ない操作だけ、
 * メニューの外の入口（`actionEntrance.ts` の `entranceOf`）を返す。
 *
 * **画面に出ないものは除く**（ブラウザ版で隠す操作・モードで出さない操作・詳細メニューから
 * 外した操作）。判定は画面と同じ関数を通す（`shownEntries`・`commandsHiddenForMode`）。
 * 作品の種類・形式で段を畳む絞り（`filterSteps`）は作品ごとに違うので、図には反映しない。
 */
export function menuPathsOf(
  command: string,
  mode: WorkMode = activeModeForGuide(),
  runtimeAllowsProcesses: boolean = processCommandsUsableHere()
): MenuPath[] {
  const paths: MenuPath[] = [
    ...(mode === "editor"
      ? editorMenuPaths(command)
      : stepMenuPaths(command, runtimeAllowsProcesses)),
    ...actionMenuPaths(command, mode, runtimeAllowsProcesses),
  ];
  if (paths.length > 0) return paths;

  const action = findAction(command);
  if (!action || !isItemVisibleInRuntime(action, runtimeAllowsProcesses)) return [];
  const entrance = entranceOf(action, mode);
  return entrance
    ? [{ place: "entrance", trail: [], siblings: [], entrance: entrance.text }]
    : [];
}

/** 道を1行で書く（最初の一押しから目標まで） */
export function menuPathLine(path: MenuPath): string {
  if (path.place === "entrance") return `入口：${path.entrance ?? ""}`;
  return [MENU_PATH_START, ...path.trail].join(" → ");
}

/** 目標の行の印。図の中で「どれを押すか」を目で拾えるようにする */
export const MENU_PATH_TARGET_MARK = "▶";

/**
 * 道を小さな木にする。祖先は1段ずつ字下げし、目標の階層では兄弟を全部並べて目標に印を付ける。
 *
 * 字下げは全角の空白にする。相談パネルは等幅で出すが、MCP の呼び手（チャットの画面）は
 * 等幅とは限らないので、半角の空白だと段がずれて読めない。
 */
export function menuPathTree(path: MenuPath): string {
  if (path.place === "entrance") return menuPathLine(path);
  const lines = [MENU_PATH_START];
  const ancestors = path.trail.slice(0, -1);
  const target = path.trail[path.trail.length - 1] ?? "";
  ancestors.forEach((name, depth) => {
    lines.push(`${"　".repeat(depth)}└ ${name}`);
  });
  const indent = "　".repeat(ancestors.length);
  for (const sibling of path.siblings) {
    lines.push(
      sibling === target
        ? `${indent}${MENU_PATH_TARGET_MARK} ${sibling}（ここ）`
        : `${indent}・ ${sibling}`
    );
  }
  return lines.join("\n");
}

/**
 * 操作1つぶんの図の文字列（小さな木）。行ける道が無ければ空文字。
 *
 * 1本目の道は木だけにする（作者の裁定 2026-11-07「木だけ」）。木にも最初の一押しから目標まで
 * 全部入るので、1行の道も並べると、相談や Discord の答えで同じ道が二重（本文の手順と合わせて
 * 三重）に出ていた。
 *
 * 道が2本以上あるときは、1本目だけを木にし、残りは「ほかの道」として1行ずつ添える
 * （木を何本も並べると長くなり、どれを見ればよいか分からなくなる）。
 *
 * 編集者モードで、編集者には押せない操作（詳細メニューに灰色で並ぶもの）は、その旨を添える。
 */
export function renderMenuPathText(
  command: string,
  mode: WorkMode = activeModeForGuide(),
  runtimeAllowsProcesses: boolean = processCommandsUsableHere()
): string {
  const paths = menuPathsOf(command, mode, runtimeAllowsProcesses);
  const [first, ...rest] = paths;
  if (!first) return "";
  // 入口（メニューの外）は木にしようが無いので、案内の1行だけ（menuPathTree が1行の案内を返す）
  const lines = [menuPathTree(first)];
  for (const other of rest) lines.push(`ほかの道：${menuPathLine(other)}`);
  if (!isCommandAllowed(command, mode)) {
    lines.push("（編集者モードでは押せません。作者の環境で使う操作です）");
  }
  return lines.join("\n");
}

/**
 * 手順書きの段に添える、短い場所（区画から目標まで）。最初の一押しは手順書きの見出しに1回だけ書く。
 *
 * 相談へ毎回送る材料なので、段ごとにアイコンから書くと字数が膨らむ（手順書きは1本600字の目安）。
 * 作者に見せる答えでは、プロンプトの指示で毎回最初の一押しから書かせる（設計書6.118）。
 */
export function shortMenuPath(
  command: string,
  mode: WorkMode = activeModeForGuide(),
  runtimeAllowsProcesses: boolean = processCommandsUsableHere()
): string | undefined {
  const first = menuPathsOf(command, mode, runtimeAllowsProcesses)[0];
  if (!first) return undefined;
  if (first.place === "entrance") return first.entrance;
  // 目標の名前は段の頭に出ているので、場所は親まででよい
  return first.trail.slice(0, -1).join(" → ");
}

/**
 * 相談の答えから名指しを拾うときの照合先（`menuMentions.ts`）。
 *
 * 詳細メニューの全項目に加えて、**編集者モードでは編集者メニューにしか無い項目**
 * （置いた提案の一覧・提案パネルを開く など）と、押すとそのまま走る手順の行の名前
 * （「6. 校閲を終えて作者へ返す」）も入れる。入れないと、編集者に案内した項目が光らない。
 */
export function guideMenuEntries(mode: WorkMode = activeModeForGuide()): MenuEntry[] {
  const entries: MenuEntry[] = menuEntries();
  if (mode !== "editor") return entries;
  const known = new Set(entries.map((entry) => `${entry.label}\u0000${entry.command}`));
  const push = (label: string, command: string): void => {
    const key = `${label}\u0000${command}`;
    if (known.has(key)) return;
    known.add(key);
    entries.push({ label, command });
  };
  for (const def of EDITOR_STEP_DEFS) {
    const resolved = def.entries
      .map((entry) => resolveEditorEntry(entry))
      .filter((item): item is ActionItem => item !== undefined);
    if (resolved.length === 1) push(def.label, resolved[0].command);
    for (const item of resolved) push(item.label, item.command);
  }
  for (const entry of EDITOR_MENU_HELP) {
    const item = resolveEditorEntry(entry);
    if (item) push(item.label, item.command);
  }
  push(EDITOR_MENU_LABELS.back, EDITOR_MENU_BACK_COMMAND);
  push(EDITOR_MENU_LABELS.addWork, EDITOR_JOIN_COMMAND);
  push(EDITOR_MENU_LABELS.endWork, EDITOR_END_WORK_COMMAND);
  return entries;
}

/** 光らせる札1枚ぶん。名指しされた項目と、その場所の図（`renderMenuPathText`） */
export interface MenuPathCard extends MenuEntry {
  /** 場所の図。行ける道が無ければ省く */
  readonly path?: string;
}

/**
 * 名指しされた項目に、場所の図を添える（相談パネルの札と MCP の返事が同じものを使う）。
 */
export function withMenuPaths(
  entries: readonly MenuEntry[],
  mode: WorkMode = activeModeForGuide(),
  runtimeAllowsProcesses: boolean = processCommandsUsableHere()
): MenuPathCard[] {
  return entries.map((entry) => {
    const path = renderMenuPathText(entry.command, mode, runtimeAllowsProcesses);
    return path ? { ...entry, path } : { ...entry };
  });
}

/** 編集者メニューの一番上の階層に並ぶ名前（参加している作品がある状態。状態の行は除く） */
function editorMenuTopLabels(): string[] {
  return [
    EDITOR_MENU_LABELS.work,
    EDITOR_MENU_LABELS.endWork,
    EDITOR_MENU_LABELS.addWork,
    ...EDITOR_STEP_DEFS.map((def) => def.label),
    EDITOR_MENU_LABELS.help,
    EDITOR_MENU_LABELS.back,
  ];
}

/** 編集者メニュー（`views/editorMenu.ts` の `getChildren` と同じ並び）の中の道 */
function editorMenuPaths(command: string): MenuPath[] {
  const section = MENU_SECTION_NAMES.editorMenu;
  const top = editorMenuTopLabels();
  const paths: MenuPath[] = [];
  const atTop = (label: string): void => {
    paths.push({ place: "editorMenu", trail: [section, label], siblings: top });
  };

  if (command === EDITOR_WORK_COMMAND) atTop(EDITOR_MENU_LABELS.work);
  if (command === EDITOR_END_WORK_COMMAND) atTop(EDITOR_MENU_LABELS.endWork);
  // 参加している作品がまだ無いときは「参加のリンクを貼る」が一番上に出るが、図は
  // 作品がある状態で描く（作品が無いときの行は、その1つしか無いので迷わない）
  if (command === EDITOR_JOIN_COMMAND) atTop(EDITOR_MENU_LABELS.addWork);

  for (const def of EDITOR_STEP_DEFS) {
    const items = def.entries
      .map((entry) => resolveEditorEntry(entry))
      .filter((item): item is ActionItem => item !== undefined);
    if (items.length === 1) {
      // 1つだけの手順は、行そのものを押して走らせる（`stepItem`）
      if (items[0].command === command) atTop(def.label);
      continue;
    }
    if (items.some((item) => item.command === command)) {
      const target = items.find((item) => item.command === command);
      paths.push({
        place: "editorMenu",
        trail: [section, def.label, target?.label ?? ""],
        siblings: items.map((item) => item.label),
      });
    }
  }

  const help = EDITOR_MENU_HELP.map((entry) => resolveEditorEntry(entry)).filter(
    (item): item is ActionItem => item !== undefined
  );
  const helpTarget = help.find((item) => item.command === command);
  if (helpTarget) {
    paths.push({
      place: "editorMenu",
      trail: [section, EDITOR_MENU_LABELS.help, helpTarget.label],
      siblings: help.map((item) => item.label),
    });
  }
  if (command === EDITOR_MENU_BACK_COMMAND) atTop(EDITOR_MENU_LABELS.back);
  return paths;
}

/** 簡単ステップメニュー（作者モードだけ。`views/stepMenu.ts` の `STEP_MENU` と同じ定義）の中の道 */
function stepMenuPaths(command: string, runtimeAllowsProcesses: boolean): MenuPath[] {
  const section = MENU_SECTION_NAMES.steps;
  const visible = (id: string): ActionItem | undefined => {
    const item = findAction(id);
    return item && isItemVisibleInRuntime(item, runtimeAllowsProcesses) ? item : undefined;
  };
  const paths: MenuPath[] = [];
  for (const def of STEP_DEFS) {
    // 段の直下に並ぶもの（操作・小分類・準備中の枠）。画面と同じく、中身が全部隠れた小分類は畳む
    const direct: string[] = [];
    for (const entry of def.entries) {
      if (typeof entry === "string") {
        const item = visible(entry);
        if (item) direct.push(item.label);
      } else if (entry.kind === "placeholder") {
        direct.push(entry.label);
      } else if (entry.commands.some((id) => visible(id))) {
        direct.push(entry.label);
      }
    }
    for (const entry of def.entries) {
      if (typeof entry === "string") {
        const item = entry === command ? visible(entry) : undefined;
        if (item) paths.push({ place: "steps", trail: [section, def.label, item.label], siblings: direct });
        continue;
      }
      if (entry.kind !== "section" || !entry.commands.includes(command)) continue;
      const target = visible(command);
      if (!target) continue;
      const items = entry.commands
        .map((id) => visible(id))
        .filter((item): item is ActionItem => item !== undefined);
      paths.push({
        place: "steps",
        trail: [section, def.label, entry.label, target.label],
        siblings: items.map((item) => item.label),
      });
    }
  }
  return paths;
}

/** 詳細メニュー（`views/actionList.ts` と同じ絞り方）の中の道 */
function actionMenuPaths(
  command: string,
  mode: WorkMode,
  runtimeAllowsProcesses: boolean
): MenuPath[] {
  const section = MENU_SECTION_NAMES.actions;
  const hidden = commandsHiddenForMode(mode);
  const paths: MenuPath[] = [];
  for (const group of ACTION_TREE) {
    const entries = shownEntries(group.entries, runtimeAllowsProcesses, hidden);
    // 見出しを挟まず、中の1つの操作をそのまま最上位に出す分類（`standalone`）
    if (group.standalone) {
      const only = entries[0];
      if (only?.kind === "action" && only.command === command) {
        paths.push({ place: "actions", trail: [section, only.label], siblings: [only.label] });
      }
      continue;
    }
    const groupLevel = entries.map((entry) => entry.label);
    for (const entry of entries) {
      if (entry.kind === "action") {
        if (entry.command === command) {
          paths.push({ place: "actions", trail: [section, group.label, entry.label], siblings: groupLevel });
        }
        continue;
      }
      const items = shownEntries(entry.items, runtimeAllowsProcesses, hidden);
      const target = items.find((item) => item.command === command);
      if (!target) continue;
      paths.push({
        place: "actions",
        trail: [section, group.label, entry.label, target.label],
        siblings: items.map((item) => item.label),
      });
    }
  }
  return paths;
}
