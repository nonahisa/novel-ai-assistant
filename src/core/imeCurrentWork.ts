import type { DictionaryEntry, DictionaryKind } from "./imeDictionary";
import { localIsoString } from "./contestInbox";
import { sha256Text } from "./hash";
import { compareFrequent, type FrequentWord } from "./imeFrequent";

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
 * **IME はこの番号をファイル名に使う**（`学習\<workUid>.json`）。`: / \ * ? " < > |` は
 * IME が `_` に替えるので、替えた結果がほかの作品と重ならないよう、**英数字と `-` だけ**を
 * 番号と認める（計画書 3.6）。長さは8字以上・100字未満（ファイルの名前になる）。
 */
export function isValidWorkUid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length < 100 &&
    /^[A-Za-z0-9-]+$/.test(value)
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
 * 試しの作品の印（フォルダーの名前の頭）。IME の核は、番号がこれで始まる作品の学習を
 * ほかの機械へ運ばない（計画書 3.6。`record::is_test_work`）
 */
export const TEST_WORK_PREFIX = "test-";
/** ふつうの作品の番号の頭（`createdAt` から作った印） */
export const WORK_UID_PREFIX = "c-";

/** 番号の頭。フォルダーの名前が `test-` で始まる作品は `test-`（乱数のときも同じ） */
export function workUidPrefixFor(folderName: string): string {
  return folderName.startsWith(TEST_WORK_PREFIX) ? TEST_WORK_PREFIX : WORK_UID_PREFIX;
}

/**
 * 種から作品の番号を作る（頭 ＋ SHA-256 の16進の先頭32字）。
 *
 * **2台で同じ値になるように、乱数ではなく作品の中の値から決める**（作者の決定
 * 2026-11-17「A：作品の createdAt から作る」。計画書 3.6 を IME が 9b4e445 で改めた）。
 * 2台が同期の前にそれぞれ番号を足しても同じ行になるので、同期でぶつからない。
 * 古いバージョンが欄を落としても、次の起動で同じ番号ができ直す。
 * ハッシュは自前の `hash.ts`（ブラウザ版にも `node:crypto` を持ち込まない）。
 */
export function deriveWorkUid(seed: string, prefix: string = WORK_UID_PREFIX): string {
  return `${prefix}${sha256Text(seed).slice(0, 32)}`;
}

/** 番号を決める作品1つ（`existing` は config.json に既にある番号） */
export interface WorkUidCandidate {
  /** 呼び手が結果を引くための鍵（登録簿の作品ID など。決め方には使わない） */
  key: string;
  /** config.json の `createdAt` を UTC にそろえたもの（`createdAtOf`）。読めなければ undefined */
  createdAt: string | undefined;
  title: string;
  /** 作品のフォルダーの名前（`test-` の見分けと、名前と同じ字にしない確かめに使う） */
  folderName: string;
  existing?: string;
}

/**
 * 番号の無い作品に番号を決める（既にある番号は変えない。同期で届いた値も含む）。
 *
 * 1. `createdAt` から作る
 * 2. それがほかの作品の番号（既にあるもの・ここで先に決めたもの）と重なれば、
 *    `createdAt` と作品名から作る（作品のフォルダーを写すと `createdAt` が重なる）
 * 3. それでも重なるとき・`createdAt` が無い／日時として読めないときだけ乱数
 *
 * **どちらの機械でも同じ順で決まるよう、`createdAt` → 作品名の順に並べてから決める**
 * （フォルダーの場所は機械ごとに違うので順に使わない）。
 *
 * @param random 乱数（`randomUUID()` の形。頭は付けずに渡す）
 * @returns 鍵 → 番号（既にある作品は、その番号のまま入る）
 */
export function planWorkUids(
  candidates: readonly WorkUidCandidate[],
  random: () => string
): Map<string, string> {
  const result = new Map<string, string>();
  const taken = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.existing !== undefined) {
      result.set(candidate.key, candidate.existing);
      taken.add(candidate.existing);
    }
  }
  const pending = candidates
    .filter((candidate) => candidate.existing === undefined)
    .sort(
      (a, b) =>
        compareText(a.createdAt ?? "", b.createdAt ?? "") || compareText(a.title, b.title)
    );
  for (const candidate of pending) {
    const prefix = workUidPrefixFor(candidate.folderName);
    const createdAt = candidate.createdAt;
    const tries = createdAt
      ? [
          deriveWorkUid(createdAt, prefix),
          deriveWorkUid(JSON.stringify([createdAt, candidate.title]), prefix),
        ]
      : [];
    // 作品の題やフォルダーの名前と同じ字にしない（IME は名前と番号を別の鍵として扱う）
    const usable = (uid: string): boolean =>
      !taken.has(uid) &&
      isValidWorkUid(uid) &&
      uid !== candidate.title &&
      uid !== candidate.folderName;
    let workUid = tries.find(usable);
    // 乱数が重なることは事実上無いが、渡された乱数が使えない形でも回り続けないよう回数を切る
    for (let attempt = 0; workUid === undefined && attempt < 16; attempt++) {
      const drawn = `${prefix}${random().replace(/[^A-Za-z0-9-]/g, "")}`;
      if (usable(drawn)) workUid = drawn;
    }
    if (workUid === undefined) {
      throw new Error("作品の番号を決められませんでした（乱数が使える形になりません）");
    }
    result.set(candidate.key, workUid);
    taken.add(workUid);
  }
  return result;
}

/** 機械の言語設定に依らない比べ方（`localeCompare` は機械で順が変わりうる） */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * config.json の `createdAt` を UTC の形（`toISOString()`）にそろえて返す。
 *
 * 時間帯の書き方（`+09:00` と `Z`）が機械で違っても同じ番号になるように、そろえてから
 * ハッシュにかける（計画書 3.6）。無い・日時として読めないときは undefined（乱数にする）。
 */
export function createdAtOf(rawConfig: unknown): string | undefined {
  if (typeof rawConfig !== "object" || rawConfig === null) return undefined;
  const value = (rawConfig as Record<string, unknown>).createdAt;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const time = new Date(value.trim());
  return Number.isNaN(time.getTime()) ? undefined : time.toISOString();
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
export function buildImeTsv(
  entries: readonly DictionaryEntry[],
  frequent: readonly FrequentWord[] = []
): string {
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
  // 本文でよく使う語は設定資料の語のあと（ファイルの末尾）。種類は frequent、4列目は空、
  // 5列目に回数。DictionaryKind には入れない（設定資料パネルや3つのIMEの書き出しへ出さないため）
  for (const word of [...frequent].sort(compareFrequent)) {
    if (TSV_BREAKING.test(word.surface) || TSV_BREAKING.test(word.reading)) continue;
    if (
      [...word.surface].length > IME_TSV_MAX_FIELD_CHARS ||
      [...word.reading].length > IME_TSV_MAX_FIELD_CHARS
    ) {
      continue;
    }
    lines.push([word.surface, word.reading, "frequent", "", String(word.count)].join("\t"));
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
