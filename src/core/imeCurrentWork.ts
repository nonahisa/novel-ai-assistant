import type { DictionaryEntry, DictionaryKind } from "./imeDictionary";
import { localIsoString } from "./contestInbox";

/**
 * オリジナルIME（Setsuna）へ「いまの作品」と作品の一覧・核向けの辞書を渡す（設計書6.13.7）。
 *
 * 形の正は IME のリポジトリの計画書（`novel-ime/docs/作品ごとの辞書の切り替え_計画.md`
 * の 3.1〜3.5）。**欄の名前は計画書のとおり**——IME の核が同じ名前で読む。
 *
 * ここは純粋な部分だけ（JSON を組む・tsv を組む・いまの作品と向きを決める・書いてよいかを
 * 決める）。`vscode` も `node:` も引き込まない。書くのは `features/imeCurrentWork.ts`。
 */

/** 知らせの形の版。IME は知らない版の知らせを使わない（計画書 6章） */
export const IME_NOTICE_VERSION = 1;
/** 書き手の名前（計画書 3.2） */
export const IME_NOTICE_SENDER = "novel-ai-assistant";
/** 置き場のフォルダーの名前（IME の `stateDir`） */
export const IME_STATE_DIR_NAME = "novel-ime";
/** いまの作品（計画書 3.2） */
export const IME_CURRENT_WORK_FILE = "integration-current-work.json";
/** 作品の一覧（計画書 3.3） */
export const IME_WORKS_FILE = "integration-works.json";
/** 核向けの辞書の置き場（作品のフォルダーから。同期しない `.aiwriter/exports/` の下） */
export const IME_TSV_SEGMENTS: readonly string[] = [
  ".aiwriter",
  "exports",
  "ime",
  "novel-ime.tsv",
];
/** 核向けの辞書の1行目（計画書 3.5） */
export const IME_TSV_HEADER = "#novel-ime-dictionary v1";
/**
 * 心拍の間（計画書 3.2。窓の札と同じ5分）。IME は15分より古い知らせを
 * 「VS Code は閉じた」と扱う——閉じるときの知らせは届かないことがあるため
 */
export const IME_HEARTBEAT_MS = 5 * 60 * 1000;
/** 設定資料を書き替えたあと、辞書を書き直すまで待つ間（AIの抽出は何十件も続けて書く） */
export const IME_DICTIONARY_SETTLE_MS = 3000;
/**
 * IME が捨てる長さ（計画書 3.5。表記・読みとも64字）。こちらでも出さない
 * ——捨てられる行を書いても、件数の記録が増えるだけ
 */
export const IME_TSV_MAX_FIELD_CHARS = 64;

/**
 * 作品の番号として受け取る形。
 *
 * **IME はこの番号をファイル名に使う**（`学習\<workUid>.json`）。手で書き換えられた値に
 * `\` や `:` が混じると、IME の学習が別の場所へ書かれるので、英数字と `-`・`_` だけを
 * 番号として認める（こちらが作るのは `randomUUID()` の形）。
 */
export function isValidWorkUid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 64 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

/**
 * `config.json` の中の番号の状態。
 *
 * - `present`：使える番号がある（**変えない**）
 * - `absent`：欄が無い（連動が有効なら足してよい）
 * - `invalid`：欄はあるが形が悪い（**直さず止める**。実装ルール2。誰かが手で書いた値を
 *   こちらの番号で上書きすると、その人がどこかで使っている番号が切れる）
 */
export type WorkUidState =
  | { kind: "present"; workUid: string }
  | { kind: "absent" }
  | { kind: "invalid" };

export function workUidStateOf(rawConfig: unknown): WorkUidState {
  if (typeof rawConfig !== "object" || rawConfig === null || Array.isArray(rawConfig)) {
    return { kind: "invalid" };
  }
  const value = (rawConfig as Record<string, unknown>).workUid;
  if (value === undefined) return { kind: "absent" };
  return isValidWorkUid(value) ? { kind: "present", workUid: value } : { kind: "invalid" };
}

/**
 * IME の置き場（`stateDir`）。統合が自分で組み立てる（核を呼ばない。計画書 3.1）。
 *
 * - Windows：`%LOCALAPPDATA%\novel-ime`
 * - Mac：`~/Library/Application Support/novel-ime`
 * - それ以外（Linux・ブラウザ版）・材料が無いとき：undefined（書かない）
 */
export function imeStateDir(input: {
  platform: string | undefined;
  localAppData?: string;
  home?: string;
}): string | undefined {
  if (input.platform === "win32") {
    const base = input.localAppData?.trim();
    if (!base) return undefined;
    return `${base.replace(/[\\/]+$/, "")}\\${IME_STATE_DIR_NAME}`;
  }
  if (input.platform === "darwin") {
    const home = input.home?.trim();
    if (!home) return undefined;
    return `${home.replace(/\/+$/, "")}/Library/Application Support/${IME_STATE_DIR_NAME}`;
  }
  return undefined;
}

/** 書いてよいかを決める材料（計画書 3.1 の4つ） */
export interface ImeWriteConditions {
  /** `canRunProcesses()`（ブラウザ版でない） */
  canRunProcesses: boolean;
  /** `vscode.env.remoteName`（WSL・SSH・Codespaces なら名前が入る） */
  remoteName: string | undefined;
  /** 設定 `novelai.ime.notifyCurrentWork` */
  enabled: boolean;
  /** 置き場のフォルダーがあるか（**無ければ作らない**＝IME の無い機械では何もしない） */
  stateDirExists: boolean;
}

/**
 * 4つがそろうときだけ書く。
 *
 * リモートでは拡張機能が別の機械で動いており、そこの置き場は作者が打っている
 * 機械の IME から見えない。書いても読む相手がいない。
 */
export function shouldWriteImeNotice(conditions: ImeWriteConditions): boolean {
  return (
    conditions.canRunProcesses &&
    !conditions.remoteName &&
    conditions.enabled &&
    conditions.stateDirExists
  );
}

/**
 * 道を `/` 区切りにする（計画書の例 `C:/Users/…`）。JSON の中で `\` を `\\` と
 * 書かずに済み、Mac と Windows で同じ形になる。IME の核は両方の区切りを読める
 */
export function toSlashPath(location: string): string {
  return location.replace(/\\/g, "/");
}

/** 作品のフォルダーから、核向けの辞書の場所（区切りはフォルダーの道に合わせる） */
export function imeTsvPath(workDir: string): string {
  const separator = workDir.includes("\\") && !workDir.includes("/") ? "\\" : "/";
  return [workDir.replace(/[\\/]+$/, ""), ...IME_TSV_SEGMENTS].join(separator);
}

/** 知らせ・一覧に載せる作品1つ */
export interface ImeWorkRef {
  workUid: string;
  title: string;
  /** 作品のフォルダー（`/` 区切りにして載せる） */
  workDir: string;
  /** 核向けの辞書の場所（`/` 区切りにして載せる） */
  dictionary: string;
}

/** いまの作品の知らせ（計画書 3.2 の形。欄の並びも計画書の例のとおり） */
export interface ImeCurrentWorkNotice {
  v: number;
  sender: string;
  workUid: string | null;
  title: string | null;
  workDir: string | null;
  dictionary: string | null;
  dictionaryHash: string | null;
  window: number;
  /**
   * 前に出ている原稿エディターが縦書きなら true、横書きなら false。
   * 分からないとき（ふつうのエディターが前・作品の外）は null。
   * IME が縦書きの原稿で数字を漢数字で先に出すのに使う（IME の P-08。計画書 bf35962 の 3.2）
   */
  vertical: boolean | null;
  at: string;
}

/**
 * いまの作品の知らせを組む。
 *
 * @param input.work 作品の外・閉じたときは null（ほかの欄もすべて null）
 * @param input.dictionaryHash 辞書のファイルがまだ無ければ null（核は設定資料を直に読む）
 */
export function buildCurrentWorkNotice(input: {
  work: ImeWorkRef | null;
  dictionaryHash: string | null;
  vertical: boolean | null;
  window: number;
  now: Date;
}): ImeCurrentWorkNotice {
  const work = input.work;
  return {
    v: IME_NOTICE_VERSION,
    sender: IME_NOTICE_SENDER,
    workUid: work?.workUid ?? null,
    title: work?.title ?? null,
    workDir: work ? toSlashPath(work.workDir) : null,
    dictionary: work ? toSlashPath(work.dictionary) : null,
    // 作品が無いときにハッシュだけ残ると、核が古い辞書を当てにする
    dictionaryHash: work ? input.dictionaryHash : null,
    window: input.window,
    // 作品の外で向きだけ言っても意味が無い（計画のとおり、分からないとき null）
    vertical: work ? input.vertical : null,
    at: localIsoString(input.now),
  };
}

/** 作品の一覧（計画書 3.3。`window` は 9章の「書いた窓は別の欄」） */
export interface ImeWorksList {
  v: number;
  sender: string;
  window: number;
  works: Array<{ workUid: string; title: string; workDir: string; dictionary: string }>;
  at: string;
}

export function buildWorksList(input: {
  works: readonly ImeWorkRef[];
  window: number;
  now: Date;
}): ImeWorksList {
  // 同じ番号が2つ載ると、Setsuna の設定のアプリで選んだ作品がどちらか決まらない
  // （同じ作品を2か所に登録した・写しを登録した）。先に載ったほうを残す
  const seen = new Set<string>();
  const works: ImeWorksList["works"] = [];
  for (const work of input.works) {
    if (seen.has(work.workUid)) continue;
    seen.add(work.workUid);
    works.push({
      workUid: work.workUid,
      title: work.title,
      workDir: toSlashPath(work.workDir),
      dictionary: toSlashPath(work.dictionary),
    });
  }
  return {
    v: IME_NOTICE_VERSION,
    sender: IME_NOTICE_SENDER,
    window: input.window,
    works,
    at: localIsoString(input.now),
  };
}

/** 知らせ・一覧をファイルの中身にする（LF・末尾に改行） */
export function serializeImeJson(value: ImeCurrentWorkNotice | ImeWorksList): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * 中身が同じかを比べる鍵（`at` を除く）。打鍵やタブの切り替えのたびに同じ知らせを
 * 書き直さないため（窓の札の門と同じ考え方）。
 */
export function imeNoticeKey(value: ImeCurrentWorkNotice | ImeWorksList): string {
  const { at: _at, ...rest } = value;
  void _at;
  return JSON.stringify(rest);
}

/** 読んだ知らせのうち、閉じるときに要る所だけ（形が悪ければ undefined） */
export function noticeWindowOf(text: string): number | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return undefined;
    const window = (value as Record<string, unknown>).window;
    return typeof window === "number" ? window : undefined;
  } catch {
    return undefined;
  }
}

const TSV_BREAKING = /[\t\r\n]/;

/**
 * 核向けの辞書（計画書 3.5）。UTF-8・BOM 無し・LF・タブ区切り。
 *
 * 列は `表記 TAB 読み TAB 種類 TAB 本体の名前`（本体の名前は別名の行にだけ）。
 * 語の選び方は IME 辞書出力と同じ `buildDictionary` の結果をそのまま受け取る
 * （写しを作らない）。ここで落とすのは、**タブ・改行を含む語**（その行が壊れる）と
 * **IME が捨てる長さ**の語だけ。
 */
export function buildImeTsv(entries: readonly DictionaryEntry[]): string {
  const lines = [IME_TSV_HEADER];
  for (const entry of entries) {
    const base = entry.baseName ?? "";
    if (
      TSV_BREAKING.test(entry.surface) ||
      TSV_BREAKING.test(entry.reading) ||
      TSV_BREAKING.test(base)
    ) {
      continue;
    }
    if (
      [...entry.surface].length > IME_TSV_MAX_FIELD_CHARS ||
      [...entry.reading].length > IME_TSV_MAX_FIELD_CHARS
    ) {
      continue;
    }
    lines.push([entry.surface, entry.reading, entry.kind, base].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

/** 作者が外した語を除く（IME 辞書出力で外した語。作品ごとに globalState に覚えている） */
export function withoutExcluded(
  entries: readonly DictionaryEntry[],
  excluded: readonly string[]
): DictionaryEntry[] {
  if (excluded.length === 0) return [...entries];
  const set = new Set(excluded);
  return entries.filter((entry) => !set.has(entry.surface));
}

/** 種類の名前が計画書の5つか（`DictionaryKind` を変えたら IME と突き合わせる） */
export const IME_TSV_KINDS: readonly DictionaryKind[] = [
  "character",
  "location",
  "organization",
  "ability",
  "term",
];

/* ── いまの作品と向きを決める（計画書 3.4。決める関数はここ1つ） ── */

/** いま前に出ているもの（features が VS Code から読んで渡す） */
export type ImeObservedFront =
  /** 原稿エディターの面。向きは画面の見た目（まだ知らせていなければ入口で代える） */
  | { source: "manuscript"; filePath: string; vertical: boolean | undefined }
  /** ふつうのエディター */
  | { source: "text"; filePath: string }
  /** パネル・何も無い（`activeTextEditor` が無いときも） */
  | { source: "none" };

/** 決まった「いまの作品」と向き */
export interface ImeFront<W> {
  work: W;
  vertical: boolean | null;
}

/**
 * 何が起きたか（計画書 3.4 の表の入り口）。
 *
 * - `startup`：拡張機能が起きた。前に出ているもので決まらなければ、開いている作品が
 *   1つならそれ
 * - `front`：原稿エディターの面が前面に来た・向きを替えた・ふつうのエディターで
 *   ファイルを前に出した
 * - `focus`：窓に焦点が来た。その窓の最後の前面の作品（features が `activeTextEditor`
 *   か最後に前へ出ていた原稿エディターを渡す）
 */
export type ImeFrontEvent<W> =
  | { kind: "startup"; front: ImeObservedFront; openWorks: readonly W[] }
  | { kind: "front"; front: ImeObservedFront }
  | { kind: "focus"; front: ImeObservedFront };

/**
 * いまの作品と向きを決める。**替えないときは `previous` をそのまま返す。**
 *
 * - 作品の外のファイル・パネルへ移っただけでは替えない（直前の作品のまま。計画書 3.4）
 *   ——提案パネルを押しただけで IME の語が消えると、作者は打てなくなる
 * - 向きは原稿エディターの面だけが決める。ふつうのエディターは null（分からない）
 */
export function decideImeFront<W>(
  previous: ImeFront<W> | undefined,
  event: ImeFrontEvent<W>,
  findWork: (filePath: string) => W | undefined
): ImeFront<W> | undefined {
  const observed = event.front;
  if (observed.source === "manuscript") {
    const work = findWork(observed.filePath);
    if (work !== undefined) {
      return {
        work,
        vertical: typeof observed.vertical === "boolean" ? observed.vertical : null,
      };
    }
  } else if (observed.source === "text") {
    const work = findWork(observed.filePath);
    if (work !== undefined) return { work, vertical: null };
  }
  if (event.kind === "startup" && previous === undefined && event.openWorks.length === 1) {
    return { work: event.openWorks[0], vertical: null };
  }
  return previous;
}
