import { redactUrlCredentials } from "./redactUrl";
import { escapeRegExp } from "./regexEscape";

/**
 * 障害報告用の記録（設計書8.5。作者の裁定 2026-10-17）。
 *
 * Discord の `/不具合を報告` の入力窓へ貼る「要約」と、添付する「詳細」を
 * テキスト1枚に組み立てる。**送る口は作らない**（作者が手で貼る）。
 *
 * ## なぜ伏せ方をここまで細かく持つか
 *
 * 記録の行には、原稿の抜粋・AIの応答・人物名・作品名・鍵・作者の
 * フォルダー名が混ざりうる。会員が読めるスレッドへ出るのは要約だけで、
 * 記録は非公開の Issue にだけ載る決まりだが、**一度貼られたものは
 * 取り返せない**。そこで「鍵の名前で拾う」「形で拾う」「最後の網（日本語が
 * 120字を超えて続く行を置き換える）」の3段で伏せる。
 *
 * **置き換えであって、ハッシュにはしない。** 字数が残れば「どのくらいの
 * 長さの応答で壊れたか」は追え、ハッシュは読み手に何も伝えない。
 *
 * `vscode`・`path`・`node:` を引かない（ブラウザ版の束・単体テストから読む）。
 * 鍵の伏せ字は `logger.ts`（vscode を引く）にあるので、関数で受け取る。
 */

/** 記録の形の版。**見出しや欄を変えたら上げる**（Discord 側が読み分ける） */
export const ISSUE_REPORT_FORMAT_VERSION = 1;
export const ISSUE_REPORT_FORMAT_LINE = `記録の形 ${ISSUE_REPORT_FORMAT_VERSION}`;

/** 報告ID の形。`NAI-YYYYMMDD-xxxx`（xxxx は英小文字と数字の4字） */
export const ISSUE_REPORT_ID_PATTERN = /^NAI-\d{8}-[a-z0-9]{4}$/;

/** 要約の上限。入力窓の1欄（4,000字）に余裕をもって収まる大きさ */
export const SUMMARY_MAX_CHARS = 3000;
/** Discord の入力窓の1欄の上限 */
export const DISCORD_FIELD_MAX_CHARS = 4000;
/** ファイル全体の上限（UTF-8 のバイト数） */
export const ISSUE_REPORT_MAX_BYTES = 1_000_000;
/**
 * 1行の中で日本語が続いてよい字数の上限（約束）。
 *
 * Discord 側のボットは「改行なしで200字を超える句読点入りの日本語」を
 * 原稿の疑いとして差し戻す。こちらはそれより手前で必ず切っておく。
 */
export const MAX_JAPANESE_RUN = 120;

/**
 * 要約の見出し。**Discord の入力窓の欄と1字も違えない**（設計書8.5.2）。
 * 欄の順もこの順。
 */
export const SUMMARY_HEADINGS = {
  environment: "## 環境",
  steps: "## 何をしたら（再現手順）",
  expected: "## 期待した動き",
  actual: "## 実際の動き",
  record: "## 記録（任意）",
} as const;

/** 記録へ入れるログ（`.aiwriter/logs/` の下） */
export const ISSUE_REPORT_LOG_FILES = ["actions.log", "ai_actions.log"] as const;
/**
 * **決して入れないログ。** 相談のやり取りは作者の原稿と考えそのもので、
 * 障害の切り分けにも要らない。渡されても読み捨てる（二重の守り）。
 */
export const NEVER_INCLUDED_LOG_FILES: readonly string[] = ["chat.md"];

/** 書き出し先（`.aiwriter/` の下）。Git 同期の対象外（`IGNORED_PATHS`） */
export const ISSUE_REPORT_DIR = "reports";

/** 範囲の選択肢。既定は24時間 */
export const ISSUE_REPORT_RANGES: ReadonlyArray<{ hours: number; label: string }> = [
  { hours: 24, label: "直近24時間" },
  { hours: 1, label: "直近1時間" },
  { hours: 72, label: "直近3日" },
  { hours: 168, label: "直近7日" },
];

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function defaultRandomBytes(count: number): Uint8Array {
  const bytes = new Uint8Array(count);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * 報告ID を作る。**書き出すたびに作る**——同じ不具合を2回書き出しても、
 * 運営側でどちらの記録かを取り違えないように。日付は作者の時計（現地時刻）。
 */
export function makeIssueReportId(
  now: Date,
  randomBytes: (count: number) => Uint8Array = defaultRandomBytes
): string {
  const date = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
  const bytes = randomBytes(4);
  let tail = "";
  for (let i = 0; i < 4; i++) {
    tail += ID_ALPHABET[(bytes[i] ?? 0) % ID_ALPHABET.length];
  }
  return `NAI-${date}-${tail}`;
}

/** 記録のファイル名。報告ID そのもの（ASCII だけにして添付で化けないように） */
export function issueReportFileName(reportId: string): string {
  return `${reportId}.md`;
}

/*
  「日本語」の範囲。CJK の約物・かな・漢字・全角の英数と記号・
  一般の句読点（…―“” など）。**テストも同じ定義で数える。**
*/
const JA_CLASS =
  "\\u2010-\\u2027\\u2030-\\u205e\\u3000-\\u303f\\u3040-\\u309f\\u30a0-\\u30ff" +
  "\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef";
/**
 * 日本語の続き。**数字や記号が3字まで挟まっても続いているものとして数える**
 * ——「彼は3つの石を」のような原稿の文が、数字で途切れたことにならないように。
 */
const JA_RUN = new RegExp(`[${JA_CLASS}]+(?:[\\x20-\\x7e]{1,3}[${JA_CLASS}]+)*`, "g");
const JA_CHAR = new RegExp(`[${JA_CLASS}]`);

/** その行で、日本語がいちばん長く続く字数 */
export function longestJapaneseRun(line: string): number {
  let longest = 0;
  for (const match of line.matchAll(JA_RUN)) {
    longest = Math.max(longest, charCount(match[0]));
  }
  return longest;
}

/** 字数（サロゲートペアを1字に数える。作者の数え方に合わせる） */
function charCount(text: string): number {
  return Array.from(text).length;
}

function bodyMark(text: string): string {
  return `〈本文 ${charCount(text)}字〉`;
}

function responseMark(text: string): string {
  return `〈応答 ${charCount(text)}字〉`;
}

/**
 * 鍵の名前から、値が「AIの応答」か「原稿の本文」かを見分ける。
 *
 * 名前は `logFailure` に渡している鍵（`応答`・`本文`・`引用` など）と、
 * 指摘の採否の記録（`target`・`suggestion`）から集めた。**迷う名前は本文の側へ倒す**。
 */
const RESPONSE_KEY = /応答|返答|答え|出力|response|raw/i;
const BODY_KEY =
  /本文|原稿|引用|抜粋|場面|送った|照合|中身|保存しようとしたもの|文脈|前後|target|suggestion|evidence|quote|excerpt|original|^text$|^before$|^after$/i;

export type FieldClass = "response" | "body" | "plain";

export function classifyKey(key: string): FieldClass {
  if (RESPONSE_KEY.test(key)) return "response";
  if (BODY_KEY.test(key)) return "body";
  return "plain";
}

/** JSON の骨組みの長さの上限。壊れ方は冒頭と末尾に出る */
const SKELETON_HEAD = 160;
const SKELETON_TAIL = 60;

/**
 * JSON の骨組み（日本語を抜いたもの）。`{"items":[{"name":"…"` の形。
 *
 * **壊れ方の解析にだけ使う**——途中で切れたのか、鍵の名前が違うのか、
 * 括弧が閉じていないのかは、日本語を抜いても読める。
 */
export function jsonSkeleton(text: string): string {
  const stripped = text
    .replace(/[^\x00-\x7f]+/g, "…")
    .replace(/…+/g, "…")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length <= SKELETON_HEAD + SKELETON_TAIL + 3) return stripped;
  return `${stripped.slice(0, SKELETON_HEAD)} … ${stripped.slice(-SKELETON_TAIL)}`;
}

/** 伏せたものの数（記録の冒頭と確認の画面に出す） */
export interface RedactionStats {
  body: number;
  response: number;
  names: number;
  secrets: number;
  paths: number;
  urls: number;
  longRuns: number;
}

export interface RedactionOptions {
  /** 作品の根（絶対パス）。この下は相対で書く */
  workRoot?: string;
  /** 拡張機能の保管庫の根。〈保管庫〉と書く */
  storageRoot?: string;
  /** 作者のホーム。`~` と書く。ブラウザ版では無い */
  homeDir?: string;
  /** 人物ごとの名前と別名（1人ぶんを1組で。同じ人物は同じ印になる） */
  characters: ReadonlyArray<readonly string[]>;
  /** いまの作品の名前（題名・フォルダー名）。〈作品〉と書く */
  workNames: readonly string[];
  /** 登録してあるほかの作品の名前。〈別の作品1〉と書く */
  otherWorkNames?: readonly string[];
  /** 人物名・作品名を伏せるか（既定は伏せる。作者が書き出すときに外せる） */
  maskNames: boolean;
  /** 鍵の伏せ字（`logger.redactSecrets`） */
  redactSecrets: (text: string) => string;
}

/** 名前の最短の字数。1字の名前を置き換えると、ありふれた字まで潰れて読めなくなる */
const MIN_NAME_CHARS = 2;
/** 鉤括弧の中身を本文の抜粋とみなす字数。操作の名前（「抽出」）は残す */
const MIN_QUOTED_BODY_CHARS = 16;
/** 1行の上限（英数字だけの長い行も、読める長さに切る） */
const MAX_LINE_CHARS = 2000;

/** 「A, B, …, Z, AA, AB …」 */
function letterLabel(index: number): string {
  let n = index;
  let label = "";
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

/**
 * 絶対パスを、区切り（`\` と `/`）と大文字小文字の違いを越えて拾う正規表現。
 * Windows のログには両方の書き方が混ざる（VS Code の Uri から作った道は `/`）。
 */
function rootPattern(root: string): RegExp | undefined {
  const segments = root.split(/[\\/]+/).filter((s) => s.length > 0);
  if (segments.length === 0) return undefined;
  const leading = /^[\\/]/.test(root) ? "[\\\\/]" : "";
  const body = segments.map(escapeRegExp).join("[\\\\/]+");
  return new RegExp(`${leading}${body}(?![^\\\\/\\s"'」』）)\\]])([\\\\/]+)?`, "giu");
}

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>」』）)\]]+/gi;
const LOCAL_HOST = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@\s]*@)?(?:localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:[/?#]|$)/i;
const GENERIC_WINDOWS_HOME = /\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'」』]+/gi;
const GENERIC_POSIX_HOME = /(?<![\w.~])\/(?:home|Users)\/[^/\s"'」』]+/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g;
const KEY_ASSIGNMENT = /\b(api[-_]?key|apikey|key|token|secret|password|x-goog-api-key|authorization)(\s*[=:]\s*)(?!〈|\*{3})([^\s"',;&]{8,})/gi;
/** 大文字・小文字・数字がそろった32字以上の塊（鍵らしきもの）。16進のハッシュは残す */
const KEY_LIKE = /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g;
const QUOTED = /([「『])([^「」『』\n]+)([」』])/g;
/** 振り仮名の記法。`《》` が出たら、直前の語（縦棒から、または空白まで）ごと拾う */
const RUBY_NOTATION = /[|｜]?[^\s《》|｜「」『』]{0,20}《[^》\n]{1,30}》/g;
const DOUBLE_QUOTED = /"([^"\n]*)"/g;
const JSON_START = /[{[]\s*"/;

/**
 * 1つの報告の中で伏せ方を通す係。**印の通し番号は報告ごと**なので、
 * 1回の書き出しで1つ作って、要約と詳細の両方に通す。
 */
export class IssueRedactor {
  readonly stats: RedactionStats = {
    body: 0,
    response: 0,
    names: 0,
    secrets: 0,
    paths: 0,
    urls: 0,
    longRuns: 0,
  };

  private readonly roots: Array<{ pattern: RegExp; replace: (sep: string | undefined) => string }> = [];
  private readonly namePattern: RegExp | undefined;
  /** 名前 → 持ち主の番号（人物）。作品は負の番号で区別する */
  private readonly owners = new Map<string, string>();
  private readonly labels = new Map<string, string>();
  private characterCount = 0;
  private otherWorkCount = 0;

  constructor(private readonly options: RedactionOptions) {
    const workRoot = options.workRoot ? rootPattern(options.workRoot) : undefined;
    if (workRoot) {
      this.roots.push({ pattern: workRoot, replace: (sep) => (sep ? "" : ".") });
    }
    const storage = options.storageRoot ? rootPattern(options.storageRoot) : undefined;
    if (storage) {
      this.roots.push({ pattern: storage, replace: (sep) => `〈保管庫〉${sep ? sep[0] : ""}` });
    }
    const home = options.homeDir ? rootPattern(options.homeDir) : undefined;
    if (home) {
      this.roots.push({ pattern: home, replace: (sep) => `~${sep ? sep[0] : ""}` });
    }

    if (options.maskNames) {
      const names: string[] = [];
      const add = (name: string, owner: string): void => {
        const trimmed = name.trim();
        if (charCount(trimmed) < MIN_NAME_CHARS) return;
        // 先に登録した持ち主を優先する（作品名と同じ人物名は作品として扱う）
        if (this.owners.has(trimmed)) return;
        this.owners.set(trimmed, owner);
        names.push(trimmed);
      };
      for (const name of options.workNames) add(name, "work");
      (options.otherWorkNames ?? []).forEach((name, index) => add(name, `other:${index}`));
      options.characters.forEach((group, index) => {
        for (const name of group) add(name, `character:${index}`);
      });
      names.sort((a, b) => charCount(b) - charCount(a));
      this.namePattern =
        names.length > 0 ? new RegExp(names.map(escapeRegExp).join("|"), "g") : undefined;
    }
  }

  /** 伏せた人物・作品の印の数（実名は返さない） */
  labelCount(): { characters: number; otherWorks: number } {
    return { characters: this.characterCount, otherWorks: this.otherWorkCount };
  }

  /**
   * 鍵つきの値（`応答: …`・`本文: …`）。鍵の名前で応答・本文と分かるものは
   * 中身を見ずに置き換える。
   */
  field(key: string, value: string): string {
    const kind = classifyKey(key);
    if (kind === "body") {
      if (value.trim() === "") return value;
      this.stats.body++;
      return bodyMark(value);
    }
    if (kind === "response") {
      if (value.trim() === "") return value;
      this.stats.response++;
      const mark = responseMark(value);
      return JSON_START.test(value) || /^\s*[{[]/.test(value)
        ? `${mark} 骨組み: ${this.light(jsonSkeleton(value))}`
        : mark;
    }
    return this.text(value);
  }

  /** 鍵の伏せ字と URL だけを通す（骨組みのように日本語を含まないもの用） */
  private light(text: string): string {
    return this.urls(this.secrets(text));
  }

  /** 自由な文1つ。伏せ方を順に通す */
  text(input: string): string {
    let result = this.secrets(input);
    result = this.paths(result);
    result = this.urls(result);
    result = this.embeddedJson(result);
    result = this.ruby(result);
    result = this.quotes(result);
    result = this.names(result);
    result = this.longRuns(result);
    // 長さの上限は1行ごと（続きの行ごと渡された値でも、後ろの行を落とさない）
    return result
      .split("\n")
      .map((line) => {
        if (charCount(line) <= MAX_LINE_CHARS) return line;
        const chars = Array.from(line);
        return `${chars.slice(0, MAX_LINE_CHARS).join("")}…（${chars.length - MAX_LINE_CHARS}字を省略）`;
      })
      .join("\n");
  }

  private secrets(input: string): string {
    let result = this.options.redactSecrets(input);
    result = redactUrlCredentials(result);
    result = result.replace(BEARER, "Bearer ***");
    result = result.replace(KEY_ASSIGNMENT, (_m, name: string, sep: string) => `${name}${sep}***`);
    result = result.replace(KEY_LIKE, "〈鍵らしき文字列〉");
    if (result !== input) this.stats.secrets++;
    return result;
  }

  private paths(input: string): string {
    let result = input;
    for (const root of this.roots) {
      result = result.replace(root.pattern, (_m, sep: string | undefined) => {
        this.stats.paths++;
        return root.replace(sep);
      });
    }
    result = result.replace(GENERIC_WINDOWS_HOME, () => {
      this.stats.paths++;
      return "~";
    });
    result = result.replace(GENERIC_POSIX_HOME, () => {
      this.stats.paths++;
      return "~";
    });
    return result;
  }

  private urls(input: string): string {
    return input.replace(URL_PATTERN, (url) => {
      this.stats.urls++;
      return LOCAL_HOST.test(url) ? "〈手元のURL〉" : "〈URL〉";
    });
  }

  /**
   * 文の途中から始まる JSON（`詳細: 読めませんでした: {"items":[…`）。
   * 日本語を含むときだけ、そこから行末までを応答として置き換える。
   */
  private embeddedJson(input: string): string {
    const start = input.search(JSON_START);
    if (start < 0) return input;
    const tail = input.slice(start);
    if (!JA_CHAR.test(tail)) return input;
    this.stats.response++;
    return `${input.slice(0, start)}${responseMark(tail)} 骨組み: ${this.light(jsonSkeleton(tail))}`;
  }

  /**
   * 振り仮名の記法（`|漢字《かんじ》`・`漢字《かんじ》`）。投稿サイトの原稿の
   * 書き方そのものなので、残っていれば原稿の断片である。前後の語ごと伏せる。
   */
  private ruby(input: string): string {
    return input.replace(RUBY_NOTATION, (whole) => {
      this.stats.body++;
      return bodyMark(whole);
    });
  }

  private quotes(input: string): string {
    const masked = input.replace(QUOTED, (whole, open: string, inner: string, close: string) => {
      if (charCount(inner) < MIN_QUOTED_BODY_CHARS) return whole;
      this.stats.body++;
      return `${open}${bodyMark(inner)}${close}`;
    });
    return masked.replace(DOUBLE_QUOTED, (whole, inner: string) => {
      if (!JA_CHAR.test(inner) || charCount(inner) < MIN_QUOTED_BODY_CHARS) return whole;
      this.stats.body++;
      return `"${bodyMark(inner)}"`;
    });
  }

  /** 1回の置き換えで済ませる——印の中の字を、別の名前として置き換え直さない */
  private names(input: string): string {
    if (!this.namePattern) return input;
    return input.replace(this.namePattern, (name) => {
      this.stats.names++;
      return this.labelFor(this.owners.get(name) ?? "work");
    });
  }

  private labelFor(owner: string): string {
    const known = this.labels.get(owner);
    if (known) return known;
    let label: string;
    if (owner === "work") {
      label = "〈作品〉";
    } else if (owner.startsWith("other:")) {
      this.otherWorkCount++;
      label = `〈別の作品${this.otherWorkCount}〉`;
    } else {
      label = `〈人物${letterLabel(this.characterCount)}〉`;
      this.characterCount++;
    }
    this.labels.set(owner, label);
    return label;
  }

  /** 最後の網。**ここを抜けた行は、日本語が120字を超えて続かない** */
  private longRuns(input: string): string {
    return input.replace(JA_RUN, (run) => {
      if (charCount(run) <= MAX_JAPANESE_RUN) return run;
      this.stats.longRuns++;
      return bodyMark(run);
    });
  }
}

// ---------------------------------------------------------------------------
// ログを読む
// ---------------------------------------------------------------------------

/** `[2026-10-17 13:40:12] …`（`formatLogTime`。現地時刻） */
const BRACKET_LINE = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\] ?(.*)$/;
const JSON_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const FAILURE_HEADER = /^--- (.*) ---$/;
/** 失敗の記録の `  鍵: 値`。鍵に引用符や括弧を含む行（JSON の続き）は鍵とみなさない */
const FIELD_LINE = /^ {2}([^\s:\n"'{}[\]][^:\n"'{}[\]]{0,39}): ?(.*)$/;
const SINGLE_FIELD = /^([^\s:：]{1,24})[:：] ?(.*)$/;

function localDate(parts: readonly string[]): Date {
  const [y, mo, d, h, mi, s] = parts.map((p) => Number(p));
  return new Date(y, mo - 1, d, h, mi, s);
}

function formatTime(date: Date): string {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  );
}

function shortTime(date: Date): string {
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** 動作の記録の1件（先頭行と、時刻の無い続きの行） */
interface PlainRecord {
  time: Date;
  stamp: string;
  first: string;
  rest: string[];
}

/**
 * 時刻つきの行で区切る。**時刻の無い行は直前の行に付いていく**
 * （`logFailure` の記録は複数行で、時刻は先頭行にしかない。`logRetention.ts` と同じ扱い）。
 * 最初の時刻より前の行は、いつのものか分からないので入れない。
 */
function parsePlainLog(text: string): PlainRecord[] {
  const records: PlainRecord[] = [];
  let current: PlainRecord | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const matched = BRACKET_LINE.exec(line);
    if (matched) {
      current = {
        time: localDate(matched.slice(1, 7)),
        stamp: `[${matched[1]}-${matched[2]}-${matched[3]} ${matched[4]}:${matched[5]}:${matched[6]}]`,
        first: matched[7],
        rest: [],
      };
      records.push(current);
      continue;
    }
    if (current && line !== "") current.rest.push(line);
  }
  return records;
}

/** 失敗の記録から拾ったもの（要約の材料） */
interface FailureSighting {
  time: Date;
  context: string;
  kind: string;
  stage?: string;
  ai?: string;
}

const KIND_KEYS = ["種別", "kind"];
const AI_KEYS = ["使用中のAI", "モデル"];
const STAGE_KEYS = ["段階", "段", "止まった所", "チャンク", "ファイル", "話", "場所", "面"];

/** 1件の動作の記録を伏せて、行に戻す。失敗の記録なら要約の材料も返す */
function redactPlainRecord(
  record: PlainRecord,
  redactor: IssueRedactor
): { lines: string[]; failure?: FailureSighting } {
  const header = FAILURE_HEADER.exec(record.first);
  if (header) {
    const context = redactor.text(header[1]);
    const lines = [`${record.stamp} --- ${context} ---`];
    const fields = new Map<string, string>();
    // 鍵ごとに値を集める（続きの行は直前の鍵の値に付いていく）
    const entries: Array<{ key: string | undefined; value: string[] }> = [];
    for (const line of record.rest) {
      const field = FIELD_LINE.exec(line);
      if (field) entries.push({ key: field[1], value: [field[2]] });
      else if (entries.length > 0) entries[entries.length - 1].value.push(line);
      else entries.push({ key: undefined, value: [line] });
    }
    for (const entry of entries) {
      if (entry.key === undefined) {
        lines.push(...entry.value.map((v) => redactor.text(v)));
        continue;
      }
      const kind = classifyKey(entry.key);
      if (kind === "plain") {
        // 続きの行ごと1回で伏せる（改行で割れた JSON を取りこぼさない）
        const [head, ...tail] = redactor.text(entry.value.join("\n")).split("\n");
        fields.set(entry.key, head);
        lines.push(`  ${entry.key}: ${head}`);
        lines.push(...tail);
      } else {
        // 応答・本文は続きの行ごとまとめて1つの印にする（行をまたいだ本文を残さない）
        lines.push(`  ${entry.key}: ${redactor.field(entry.key, entry.value.join("\n"))}`);
      }
    }
    const pick = (keys: readonly string[]): string | undefined => {
      for (const key of keys) {
        const value = fields.get(key);
        if (value) return value;
      }
      return undefined;
    };
    return {
      lines,
      failure: {
        time: record.time,
        context,
        kind: pick(KIND_KEYS) ?? "（種別なし）",
        stage: pick(STAGE_KEYS),
        ai: pick(AI_KEYS),
      },
    };
  }

  const single = SINGLE_FIELD.exec(record.first);
  if (single && classifyKey(single[1]) !== "plain") {
    const value = [single[2], ...record.rest].join("\n");
    return { lines: [`${record.stamp} ${single[1]}: ${redactor.field(single[1], value)}`] };
  }
  // 続きの行ごと1回で伏せる（改行で割れた JSON を行ごとに見ると、2行目以降の
  // 短い抜粋が JSON と気づかれずに残る）
  const [head, ...tail] = redactor.text([record.first, ...record.rest].join("\n")).split("\n");
  return { lines: [`${record.stamp} ${head}`.trimEnd(), ...tail] };
}

function redactJsonValue(key: string, value: unknown, redactor: IssueRedactor): unknown {
  if (typeof value === "string") {
    if (key === "timestamp") return value;
    return redactor.field(key, value);
  }
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(key, item, redactor));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactJsonValue(k, v, redactor);
    return out;
  }
  return value;
}

/** JSONL の記録（指摘の採否）。1行1件で、時刻は `timestamp` */
function redactJsonlLog(
  text: string,
  from: Date,
  to: Date,
  redactor: IssueRedactor
): string[] {
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // 読めない行は、いつのものか分からないので入れない
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const stamp = (parsed as Record<string, unknown>).timestamp;
    const matched = typeof stamp === "string" ? JSON_TIMESTAMP.exec(stamp) : null;
    if (!matched) continue;
    const time = localDate(matched.slice(1, 7));
    if (time < from || time > to) continue;
    lines.push(JSON.stringify(redactJsonValue("", parsed, redactor)));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 組み立てる
// ---------------------------------------------------------------------------

export interface IssueReportAi {
  /** 「既定」または機能の名前 */
  label: string;
  provider: string;
  model: string;
  /** 手元で動くAIか（URL は書かない。手元かクラウドかだけを残す） */
  local: boolean;
}

export interface IssueReportEnvironment {
  extensionVersion: string;
  vscodeVersion: string;
  /** OS の名前。ブラウザ版では undefined */
  os: string | undefined;
  browser: boolean;
  ais: readonly IssueReportAi[];
}

export interface IssueReportLog {
  /** 詳細の見出し（「動作の記録（作品）」など） */
  label: string;
  /** `.aiwriter/logs/` の下のファイル名。形の読み分けに使う */
  fileName: string;
  text: string;
}

export interface IssueReportInput {
  now: Date;
  reportId: string;
  rangeHours: number;
  rangeLabel: string;
  environment: IssueReportEnvironment;
  logs: readonly IssueReportLog[];
  redaction: RedactionOptions;
}

export interface IssueReport {
  reportId: string;
  fileName: string;
  /** 前半（入力窓へ貼る分）。［要約をコピー］で写すのはこれ */
  summary: string;
  /** ファイル全体 */
  document: string;
  stats: RedactionStats;
  /** 伏せた人物・別の作品の印の数 */
  labels: { characters: number; otherWorks: number };
  /** 記録に入れた行の数（ログごと） */
  lineCounts: Array<{ label: string; lines: number; dropped: number }>;
  /** 拾った失敗の件数（同じものを数え直さない） */
  failureCount: number;
}

interface FailureGroup {
  context: string;
  kind: string;
  count: number;
  first: Date;
  last: Date;
  stage?: string;
  ai?: string;
}

function groupFailures(sightings: readonly FailureSighting[]): FailureGroup[] {
  const groups = new Map<string, FailureGroup>();
  for (const s of sightings) {
    const key = JSON.stringify([s.context, s.kind]);
    const group = groups.get(key);
    if (!group) {
      groups.set(key, {
        context: s.context,
        kind: s.kind,
        count: 1,
        first: s.time,
        last: s.time,
        stage: s.stage,
        ai: s.ai,
      });
      continue;
    }
    group.count++;
    if (s.time < group.first) group.first = s.time;
    if (s.time >= group.last) {
      group.last = s.time;
      group.stage = s.stage ?? group.stage;
      group.ai = s.ai ?? group.ai;
    }
  }
  // 新しい順。要約が溢れたら古いほうから落とす
  return [...groups.values()].sort((a, b) => b.last.getTime() - a.last.getTime());
}

function failureLine(group: FailureGroup): string {
  const parts = [
    `- ${shortTime(group.last)} ${group.context}`,
    `種別 ${group.kind}`,
    ...(group.stage ? [`段 ${group.stage}`] : []),
    `${group.count}回${group.count > 1 ? `（最初 ${shortTime(group.first)}）` : ""}`,
    ...(group.ai ? [`AI ${group.ai}`] : []),
  ];
  return parts.join("｜");
}

function environmentSection(input: IssueReportInput, redactor: IssueRedactor): string[] {
  const env = input.environment;
  const ais =
    env.ais.length > 0
      ? env.ais.map(
          (ai) =>
            `AI（${ai.label}）: ${redactor.text(`${ai.provider} / ${ai.model}`)}（${ai.local ? "手元" : "クラウド"}）`
        )
      : ["AI: 未設定"];
  return [
    SUMMARY_HEADINGS.environment,
    `報告ID: ${input.reportId}`,
    ISSUE_REPORT_FORMAT_LINE,
    `拡張機能: ${env.extensionVersion}`,
    `VS Code: ${env.vscodeVersion}`,
    `OS: ${env.os ?? "ブラウザ版"}`,
    `ブラウザ版: ${env.browser ? "はい" : "いいえ"}`,
    ...ais,
  ];
}

/** 作者が書く欄の案内。**案内の一文だけ**にして、消し忘れても害が無い形にする */
const AUTHOR_SECTIONS: ReadonlyArray<{ heading: string; hint: string }> = [
  {
    heading: SUMMARY_HEADINGS.steps,
    hint: "（ここに、押した操作を順に書いてください。例：詳細メニュー › ヘルプ › ログ表示 を押した）",
  },
  {
    heading: SUMMARY_HEADINGS.expected,
    hint: "（ここに、どうなるはずだったかを書いてください）",
  },
  {
    heading: SUMMARY_HEADINGS.actual,
    hint: "（ここに、実際に起きたことを書いてください。出た通知の文はそのまま写せます）",
  },
];

function summaryText(
  input: IssueReportInput,
  environmentLines: readonly string[],
  groups: readonly FailureGroup[],
  from: Date,
  shown: number
): string {
  const failureTotal = groups.reduce((sum, g) => sum + g.count, 0);
  const record = [
    SUMMARY_HEADINGS.record,
    `報告ID ${input.reportId} の記録ファイル（${issueReportFileName(input.reportId)}）を添付`,
    `範囲: ${formatTime(from)} 〜 ${formatTime(input.now)}（${input.rangeLabel}）`,
    groups.length > 0
      ? `失敗: ${groups.length}種類・計${failureTotal}回（新しい順）`
      : "失敗: 記録なし",
    ...groups.slice(0, shown).map(failureLine),
    ...(shown < groups.length
      ? [`- ほか${groups.length - shown}種類は添付の記録に`]
      : []),
  ];
  const lines = [
    ...environmentLines,
    "",
    ...AUTHOR_SECTIONS.flatMap((s) => [s.heading, s.hint, ""]),
    ...record,
  ];
  return guardShape(lines).join("\n");
}

/** 詳細のログ1つぶんを、上限の中で新しい行から残す */
function fitNewest(lines: readonly string[], budgetBytes: number): { kept: string[]; dropped: number } {
  const encoder = new TextEncoder();
  let used = 0;
  let start = lines.length;
  while (start > 0) {
    const size = encoder.encode(lines[start - 1]).byteLength + 1;
    if (used + size > budgetBytes) break;
    used += size;
    start--;
  }
  return { kept: lines.slice(start), dropped: start };
}

/*
  **行の並びの形の見張り**（設計書8.5.4）。

  Discord 側のボットは、貼られた文に「原稿の形」があると差し戻す（長い段落・
  会話文だけの行・振り仮名の記法・句点で終わる行の塊）。伏せたあとの行でも、
  製品の案内や記録の行が並び方によってその形に見えることがある。

  **ボットの規則を写さず、それより厳しい製品自身の決まりで避ける**——ボットの
  数字が変わるたびに製品を出し直さなくて済むように。規則の写しはテストにだけ置く。
*/
/** 句点などで終わる行（製品の見方。ボットより広く取る） */
const PROSE_END = /[。！？!?」』…]$/;
/** 句点で終わる日本語の行が、何行続いたら区切りの行を挟むか */
const PROSE_RUN_BREAK = 5;
/** 日本語が多いとみなす割合（製品の見方。ボットより低く取る） */
const JAPANESE_HEAVY_RATIO = 0.5;
/** 日本語の多い行の長さの上限（空白を除く。これを超えたら伏せ直す） */
const JAPANESE_HEAVY_LINE_CHARS = 180;
/** 区切りの行。日本語も句点も持たないので、塊を必ず切る */
export const PROSE_BREAK_LINE = "--";
const WHOLE_LINE_DIALOGUE = /^[「『].*[」』]$/;

function japaneseRatio(text: string): number {
  const chars = Array.from(text.replace(/\s/g, ""));
  if (chars.length === 0) return 0;
  return chars.filter((ch) => JA_CHAR.test(ch)).length / chars.length;
}

/**
 * 行の並びを、原稿の形に見えないように整える。
 *
 * - 行の頭から終わりまでが鉤括弧の行（会話文だけの行）は〈本文 n字〉にする
 * - 日本語の多い長い行は、10字以上の日本語の続きを伏せ直す
 * - 句点で終わる日本語の行が続いたら、区切りの行（`--`）を挟む。**空行では切らない**
 *   （空行は塊を切らないとみなす側に倒す）
 */
export function guardShape(lines: readonly string[]): string[] {
  const out: string[] = [];
  let proseRun = 0;
  for (const original of lines) {
    let line = original;
    const trimmed = line.trim();
    if (WHOLE_LINE_DIALOGUE.test(trimmed)) {
      line = `${line.slice(0, line.length - line.trimStart().length)}${bodyMark(trimmed)}`;
    }
    const compact = line.replace(/\s/g, "");
    if (
      charCount(compact) > JAPANESE_HEAVY_LINE_CHARS &&
      japaneseRatio(compact) >= JAPANESE_HEAVY_RATIO
    ) {
      line = line.replace(JA_RUN, (run) => (charCount(run) >= 10 ? bodyMark(run) : run));
    }
    const nowTrimmed = line.trim();
    if (nowTrimmed === "") {
      out.push(line);
      continue;
    }
    const prose = PROSE_END.test(nowTrimmed) && japaneseRatio(nowTrimmed) >= JAPANESE_HEAVY_RATIO;
    if (!prose) {
      proseRun = 0;
      out.push(line);
      continue;
    }
    if (proseRun >= PROSE_RUN_BREAK) {
      out.push(PROSE_BREAK_LINE);
      proseRun = 0;
    }
    proseRun++;
    out.push(line);
  }
  return out;
}

/**
 * 記録を組み立てる。
 *
 * 前半の「要約」は入力窓の欄にそのまま貼れる形（見出しは `SUMMARY_HEADINGS`）、
 * 後半の「詳細」はログの該当行。**相談のログは渡されても入れない。**
 */
export function buildIssueReport(input: IssueReportInput): IssueReport {
  const redactor = new IssueRedactor(input.redaction);
  const from = new Date(input.now.getTime() - input.rangeHours * 3_600_000);
  const fileName = issueReportFileName(input.reportId);

  const sightings: FailureSighting[] = [];
  const sections: Array<{ label: string; lines: string[] }> = [];
  for (const log of input.logs) {
    if (NEVER_INCLUDED_LOG_FILES.includes(log.fileName)) continue;
    // 指摘の採否は JSONL（1行1件）。動作の記録とは形が違う
    if (log.fileName === "ai_actions.log" || log.text.trimStart().startsWith("{\"timestamp\"")) {
      sections.push({ label: log.label, lines: guardShape(redactJsonlLog(log.text, from, input.now, redactor)) });
      continue;
    }
    const lines: string[] = [];
    for (const record of parsePlainLog(log.text)) {
      if (record.time < from || record.time > input.now) continue;
      const result = redactPlainRecord(record, redactor);
      lines.push(...result.lines);
      if (result.failure) sightings.push(result.failure);
    }
    sections.push({ label: log.label, lines: guardShape(lines) });
  }

  const groups = groupFailures(sightings);
  // 環境の行は1回だけ伏せる（縮め直すたびに伏せた数を数え直さない）
  const environmentLines = environmentSection(input, redactor);
  let shown = groups.length;
  let summary = summaryText(input, environmentLines, groups, from, shown);
  while (charCount(summary) > SUMMARY_MAX_CHARS && shown > 0) {
    shown--;
    summary = summaryText(input, environmentLines, groups, from, shown);
  }

  const stats = redactor.stats;
  const labels = redactor.labelCount();
  const header = [
    `# 障害報告用の記録 ${input.reportId}`,
    "",
    // 案内の行は句点で終わらせない（原稿の形に見せない。`guardShape` と同じ理由）
    "- 前半の「要約」：Discord の /不具合を報告 の入力窓へ、欄ごとに貼る",
    "- このファイル：同じ報告に添付する（後半が詳細）",
    "- 相談のやり取りは入れていない",
    "",
    "---",
    "",
    "# 要約",
    "",
  ].join("\n");

  const masked = [
    "### 伏せたもの",
    `- 原稿の本文と抜粋: ${stats.body + stats.longRuns}か所 → 〈本文 n字〉`,
    `- AIの応答: ${stats.response}か所 → 〈応答 n字〉（JSONは日本語を抜いた骨組みだけ）`,
    input.redaction.maskNames
      ? `- 人物名・作品名: ${stats.names}か所 → 〈人物A〉〈作品〉など` +
        (labels.characters > 0 ? `（人物${labels.characters}人）` : "")
      : "- 人物名・作品名: 伏せていません（書き出すときに外しました）",
    `- 鍵らしき文字列: ${stats.secrets}行`,
    `- 作者のフォルダー: ${stats.paths}か所 → 作品の根からの相対・~・〈保管庫〉`,
    `- URL: ${stats.urls}か所 → 〈URL〉〈手元のURL〉`,
  ];

  const detailHead = ["", "---", "", "# 詳細", "", ...masked, ""].join("\n");
  const encoder = new TextEncoder();
  // 見出しと囲みの分の余白を残して、ログの行に使える量を決める
  const overhead =
    encoder.encode(header + summary + detailHead).byteLength + 512 * (sections.length + 1);
  let budget = ISSUE_REPORT_MAX_BYTES - overhead;

  // 小さいログから順に、残りを等分して割り当てる（1つの長いログが全部を取らないように）
  const order = sections
    .map((section, index) => ({
      index,
      size: section.lines.reduce((sum, line) => sum + encoder.encode(line).byteLength + 1, 0),
    }))
    .sort((a, b) => a.size - b.size);
  const fitted: Array<{ kept: string[]; dropped: number }> = sections.map(() => ({ kept: [], dropped: 0 }));
  order.forEach((entry, position) => {
    const share = Math.max(0, Math.floor(budget / (order.length - position)));
    const result = fitNewest(sections[entry.index].lines, share);
    fitted[entry.index] = result;
    budget -= result.kept.reduce((sum, line) => sum + encoder.encode(line).byteLength + 1, 0);
  });

  const bodyParts: string[] = [];
  sections.forEach((section, index) => {
    const { kept, dropped } = fitted[index];
    bodyParts.push(`### ${section.label}`);
    bodyParts.push("");
    if (dropped > 0) {
      bodyParts.push(`（大きさの上限のため、古い${dropped}行を省きました）`);
      bodyParts.push("");
    }
    if (kept.length === 0) {
      bodyParts.push("（この範囲の記録はありません）");
    } else {
      bodyParts.push("~~~text", ...kept, "~~~");
    }
    bodyParts.push("");
  });

  const document = `${header}${summary}\n${detailHead}\n${bodyParts.join("\n")}`;

  return {
    reportId: input.reportId,
    fileName,
    summary,
    document,
    stats: { ...stats },
    labels,
    lineCounts: sections.map((section, index) => ({
      label: section.label,
      lines: fitted[index].kept.length,
      dropped: fitted[index].dropped,
    })),
    failureCount: sightings.length,
  };
}
