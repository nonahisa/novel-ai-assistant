import * as path from "./pathText";
import { PLOT_FILE, SUPPORTED_EXTENSIONS } from "../models/types";
import { AI_INSTRUCTION_TARGETS } from "./aiInstructions";
import { SYNOPSIS_FILE } from "./synopsisDoc";
import { TARGET_SHEET_FILE } from "./targetSheetDoc";
import { isConflictSideFile } from "./conflictFile";

/**
 * 本文の置き場の決め方と、何を原稿として拾うか（`vscode` を使わない部分）。
 *
 * **判定はここ1か所だけに置く。** 以前は走査（`scanner.ts`）・新しい話
 * （`extension.ts`・`startWork.ts`）・Word の取り込み・Markdown への変換・
 * MCP の本文一覧（`mcp/tools/shared.ts`）が、それぞれ「本文フォルダーが
 * あればそこ、無ければ直下」を写して持っていた。写しのままだと、1つを
 * 直しても残りが古い判定のまま動く。
 *
 * **読み方は呼び手が持ち、決め方はここが持つ。** 拡張機能は読み口
 * （`fileRead.ts`。ブラウザ版では非同期しか無い）で、MCP は Node の同期の
 * `fs` で読む。決め方を「次に何を見たいか」を順に差し出す形
 * （`manuscriptDirSteps`）で書き、同期と非同期の両方の走らせ役から
 * 同じものを通す。**`vscode` を持ち込まない**（MCP の束に入るため。
 * `mcpReach.test.ts` が見張る）。
 */

/** 本文の置き場を決めるのに要る場所（`workPaths()` の一部） */
export interface ManuscriptPaths {
  readonly root: string;
  readonly manuscript: string;
  readonly settings: string;
}

/** 場所の種類。`missing` は「見つからない」（それ以外の失敗は投げてもらう） */
export type EntryKind = "file" | "directory" | "other";
export type Listing = ReadonlyArray<readonly [name: string, kind: EntryKind]>;

/**
 * 決め方が呼び手へ頼む、1回ぶんの読み。
 *
 * - `kind`：その場所の種類。**見つからなければ `missing`**。それ以外の
 *   失敗は呼び手が投げる（読めない事情を握りつぶして直下へ切り替えない）
 * - `list`：フォルダーの中身。**読めなければ `undefined`**（一括読みでも
 *   飛ばされるので、同じく「無い」とみなす）
 */
export type ManuscriptDirStep =
  | { readonly op: "kind"; readonly path: string }
  | { readonly op: "list"; readonly path: string };
type StepAnswer = EntryKind | "missing" | Listing | undefined;
type Steps<T> = Generator<ManuscriptDirStep, T, StepAnswer>;

/** 同期で読む手段（MCP。Node の `fs`） */
export interface SyncManuscriptIo {
  kind(location: string): EntryKind | "missing";
  list(location: string): Listing | undefined;
}

/** 非同期で読む手段（拡張機能。読み口 `fileRead.ts`） */
export interface AsyncManuscriptIo {
  kind(location: string): Promise<EntryKind | "missing">;
  list(location: string): Promise<Listing | undefined>;
}

/** 潜る深さの上限。**一括読み（`fileRead.ts` の `DEFAULT_TREE_DEPTH`）と揃える** */
export const MANUSCRIPT_TREE_DEPTH = 5;

/**
 * 本文として歩くフォルダーを決める（同期で読む呼び手のため）。
 *
 * 決め方は `manuscriptDirSteps` を見ること。
 */
export function resolveManuscriptDirSync(
  p: ManuscriptPaths,
  io: SyncManuscriptIo
): string {
  const steps = manuscriptDirSteps(p);
  let next = steps.next();
  while (!next.done) {
    const step = next.value;
    next = steps.next(step.op === "kind" ? io.kind(step.path) : io.list(step.path));
  }
  return next.value;
}

/**
 * 本文として歩くフォルダーを決める（非同期で読む呼び手のため）。
 *
 * 決め方は `manuscriptDirSteps` を見ること。
 */
export async function resolveManuscriptDirAsync(
  p: ManuscriptPaths,
  io: AsyncManuscriptIo
): Promise<string> {
  const steps = manuscriptDirSteps(p);
  let next = steps.next();
  while (!next.done) {
    const step = next.value;
    next = steps.next(
      step.op === "kind" ? await io.kind(step.path) : await io.list(step.path)
    );
  }
  return next.value;
}

/**
 * 本文として歩くフォルダーの決め方。
 *
 * - 本文フォルダーが無い（または同じ名前のファイル）→ 作品の直下
 * - 本文フォルダーの中に原稿が1件でもある → 本文フォルダー（これまでどおり）
 * - **本文フォルダーはあるが空で、直下に原稿がある → 作品の直下**
 * - どちらにも原稿が無い → 本文フォルダー（登録したばかりの作品。新しい話は
 *   本文フォルダーへ置きたい）
 *
 * **3つめの場合を足した理由**（机のPCで第1話が見えなかった件）。作品の
 * 設定が `manuscriptDir: 本文` なのに原稿が直下にあり、登録した機械にだけ
 * 空の `本文/` が残っていた。**git は空のフォルダーを運ばない**ので、別の
 * 機械ではフォルダーが無く直下を歩いて見えていた。同じ作品が機械ごとに
 * 「0話」と「全話」に分かれると、同期そのものを信用できなくなる。
 * 空のフォルダーを「無いのと同じ」と扱えば、どの機械でも同じ結果になる。
 *
 * **空のフォルダーを消したり作ったりはしない**（作者のファイルに触らない）。
 *
 * 下見は名前だけを見て、**原稿を1件見つけたところでやめる**。本文を
 * 読むのは呼び手（走査の一括読み）で、ここでは読まない。
 */
function* manuscriptDirSteps(p: ManuscriptPaths): Steps<string> {
  // **フォルダーのときだけ本文フォルダーを見る。** 同じ名前のファイルが
  // あっても、その中は歩けない
  if ((yield* kindOf(p.manuscript)) !== "directory") return p.root;

  // 本文フォルダーを作品の根にした形（`manuscriptDir: "."`）。選ぶものが無い
  if (sameFolder(p.manuscript, p.root)) return p.manuscript;

  const accept = acceptManuscriptEntry(p.settings);
  if (yield* containsManuscript(p.manuscript, accept, () => true)) {
    return p.manuscript;
  }
  // **直下の README や AI への指示書は原稿に数えない**（走査と同じ外し方）。
  // これを理由に直下へ切り替えると、登録したばかりの作品で新しい話が
  // 本文フォルダーの外へ置かれる
  const rootHasManuscript = yield* containsManuscript(
    p.root,
    accept,
    (filePath) => !isKnownNonManuscript(filePath, p.root, p.settings)
  );
  return rootHasManuscript ? p.root : p.manuscript;
}

function* kindOf(location: string): Steps<EntryKind | "missing"> {
  return (yield { op: "kind", path: location }) as EntryKind | "missing";
}

function* listOf(location: string): Steps<Listing | undefined> {
  return (yield { op: "list", path: location }) as Listing | undefined;
}

/**
 * フォルダーの下に、原稿として拾うファイルが1件でもあるか。
 *
 * **一括読み（`readTextTree`）と同じ歩き方をする**——`.` で始まる名前は
 * 飛ばし、選り分けは同じ `accept`、深さも同じ上限。ここで「ある」と
 * 言ったのに一括読みが0件を返す、という食い違いを作らないため。
 *
 * 同じ階層のファイルを先に見てから中のフォルダーへ入る（ふつうの作品は
 * 1回の読みで答えが出る）。
 */
function* containsManuscript(
  dir: string,
  accept: ManuscriptAccept,
  countsAsManuscript: (filePath: string) => boolean,
  depth = 0
): Steps<boolean> {
  if (depth > MANUSCRIPT_TREE_DEPTH) return false;
  const entries = yield* listOf(dir);
  if (entries === undefined) return false;
  const visible = entries.filter(([name]) => !name.startsWith("."));
  for (const [name, kind] of visible) {
    if (kind !== "file") continue;
    const full = path.join(dir, name);
    if (accept(name, "file", full) && countsAsManuscript(full)) return true;
  }
  for (const [name, kind] of visible) {
    if (kind !== "directory") continue;
    const full = path.join(dir, name);
    if (!accept(name, "directory", full)) continue;
    if (yield* containsManuscript(full, accept, countsAsManuscript, depth + 1)) {
      return true;
    }
  }
  return false;
}

function sameFolder(a: string, b: string): boolean {
  return path.normalizeForComparison(a) === path.normalizeForComparison(b);
}

/**
 * 名前で選り分ける。フォルダーなら「中へ入るか」、ファイルなら「拾うか」。
 * （`fileRead.ts` の `TreeAccept` と同じ形。`vscode` を持ち込まないために
 * ここで書く）
 */
export type ManuscriptAccept = (
  name: string,
  kind: "file" | "directory",
  fullPath: string
) => boolean;

/**
 * 原稿として拾うフォルダー・ファイルか（`reader.readTextTree` へ渡す）。
 *
 * **歩き方は読み口が持ち、何を拾うかはここが決める**（設計書6.107）。
 * `.` で始まる名前と深さの上限は読み口の側で落ちる。
 */
const SKIP_DIRS = new Set([
  ".aiwriter",
  ".git",
  "node_modules",
  "exports",
  // **名前でも外したままにする。** 設定フォルダーを別の名前にした作品に
  // 「設定」という名前のフォルダーが残っていても、これまで数えていなかった
  // （外すのをやめると、その作品の話数が増える）
  "設定",
]);

/**
 * 原稿として拾う選り分けを、作品の設定フォルダーの場所から作る。
 *
 * **設定フォルダーは場所で外す**（0.81.1）。`config.json` の `settingsDir` で
 * 名前を変えられるのに、名前の決め打ち（`設定`）でしか外していなかったため、
 * 別の名前にした作品では人物・世界観・メモの .md がすべて話に数えられた
 * （ノートPCの実機確認、2026-09-23）。
 */
export function acceptManuscriptEntry(settingsDir: string): ManuscriptAccept {
  const settingsKey = path.normalizeForComparison(settingsDir);
  return (name, kind, fullPath) => {
    if (kind === "directory") {
      if (SKIP_DIRS.has(name)) return false;
      return path.normalizeForComparison(fullPath) !== settingsKey;
    }
    // 競合を「両方を残す」で解決したときの退避ファイルは原稿ではない。
    // 拾うと同じ話数の本文が2つある状態になる
    if (isConflictSideFile(name)) return false;
    const ext = path.extname(name).toLowerCase();
    return (SUPPORTED_EXTENSIONS as readonly string[]).includes(ext);
  };
}

/** `filePath` が `dir` の直下にあるか（章フォルダーの中は含めない） */
function isDirectChild(dir: string, filePath: string): boolean {
  return (
    path.normalizeForComparison(path.dirname(filePath)) ===
    path.normalizeForComparison(dir)
  );
}

/**
 * リポジトリの決まりもののファイル（`README.md`・`LICENSE.txt`・`CHANGELOG.md`）。
 *
 * GitHub で作品を管理すると作品の根に置かれる。**名前の頭だけで決める**
 * （`README_ja.md`・`LICENSE-CC.txt` のような変わり種も同じもの）。
 */
const REPOSITORY_FILE = /^(?:readme|license|licence|changelog)(?:[._-]|$)/i;

/**
 * AIへの指示書のうち、作品の根に置かれるもの（`AGENTS.md`・`GEMINI.md`）。
 *
 * **置き先の表（`AI_INSTRUCTION_TARGETS`）から作る。** 名前を写すと、
 * 置き先が増えたときにここだけ取り残される。フォルダーの中に置くもの
 * （`.claude/skills/…`・`.aiwriter/…`）は、`.` 始まりで元から歩かない。
 */
const ROOT_INSTRUCTION_FILES = new Set(
  AI_INSTRUCTION_TARGETS.map((target) => target.instructionPath)
    .filter((instructionPath) => !/[\\/]/.test(instructionPath))
    .map((name) => name.toLowerCase())
);

/**
 * 設定フォルダーの直下にこの拡張機能が作るファイル（プロット・紹介文・
 * ターゲットシート）。**定数から作る**（名前を写さない）。
 *
 * 設定フォルダーはふつう丸ごと歩かない（`acceptManuscriptEntry`）ので、これが
 * 効くのは**設定フォルダーを本文と同じ場所にした作品**（`settingsDir` を
 * 「.」や本文フォルダーにした形）だけである。
 */
const SETTINGS_GENERATED_FILES = new Set(
  [PLOT_FILE, SYNOPSIS_FILE, TARGET_SHEET_FILE].map((name) =>
    name.toLowerCase()
  )
);

/**
 * はっきり原稿でないと分かるファイルか（0.81.1）。
 *
 * **話数が読めないことを理由には外さない。** 作者の作品には、話数の名前と
 * 並んで `続き.txt`（本文）を根に置いたものがある。外すのは
 * 「作者の原稿ではありえない名前」の短い一覧だけで、「メモ」「about」
 * 「あとがき」「番外編」「続き」は**外さない**（原稿かもしれない）。
 *
 * - 作品の根を歩いたとき、根の直下の README・LICENSE・CHANGELOG と AIへの指示書
 * - 設定フォルダーの直下の、この拡張機能が作るファイル
 *
 * 本文フォルダーの中と章フォルダーの中は、名前で外さない。作者が
 * 「ここが原稿」と決めた場所である。
 *
 * @param rootDir 作品の根を歩いているときだけ、その根。本文フォルダーを歩くときは undefined
 */
export function isKnownNonManuscript(
  filePath: string,
  rootDir: string | undefined,
  settingsDir: string
): boolean {
  const name = path.basename(filePath);
  const lower = name.toLowerCase();
  if (rootDir !== undefined && isDirectChild(rootDir, filePath)) {
    if (REPOSITORY_FILE.test(name)) return true;
    if (ROOT_INSTRUCTION_FILES.has(lower)) return true;
  }
  return (
    SETTINGS_GENERATED_FILES.has(lower) && isDirectChild(settingsDir, filePath)
  );
}
