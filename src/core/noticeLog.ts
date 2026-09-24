import { AIWRITER_DIR } from "../models/types";

/**
 * 拡張機能が出した知らせの記録（MCP の道具 `notices.recent`。作者の承認、2026-09-24）。
 *
 * **なぜ要るか。** 実機確認リストには「〜と知らせが出るか」が多いが、右下の
 * 通知はすぐ消え、別の知らせに押し流される。画面を撮るしか確かめようが
 * なかった。そこで**拡張機能が出した知らせを保管庫へ書き留め、MCP が読む**
 * （窓の札 `core/windowCard.ts` と同じ形。MCP は読むだけ）。
 *
 * **ここは形と判定だけ。** VS Code にも Node にも依存しないので、書く側
 * （`features/noticeRecorder.ts`）と読む側（`mcp/tools/notices.ts`）が
 * 同じものを見る——写しを作ると、片方だけ直る日が来る。
 *
 * **置き場は窓ごとに1ファイル**（`<pid>-<起動時刻>.json`）。1つのファイルを
 * 窓どうしで書き換え合うと、後から書いた窓が先の窓の記録を消す。
 * 起動時刻を名前に入れるのは、プロセス番号が使い回されたとき、
 * 閉じた窓の記録を新しい窓が上書きしないようにするため。
 */

/** 記録の置き場（保管庫からの相対）。窓ごとに1ファイル */
export const NOTICE_LOG_DIRECTORY = [AIWRITER_DIR, "notices"] as const;

/** 記録の形の版。読めない版は「壊れた記録」として扱う（直しにいかない） */
export const NOTICE_LOG_SCHEMA = 1;

/**
 * 残す件数の上限（窓ごと。読むときも、全部の窓を合わせてこの件数まで）。
 *
 * **500件にしたのは、1日の実機確認で出る知らせを丸ごと収めて余る量。**
 * 知らせ1件はせいぜい数百バイトなので、上限いっぱいでも数百KBに収まる。
 */
export const NOTICE_LOG_MAX_ENTRIES = 500;

/**
 * 残す期間。これより古い知らせは記録から落とす。
 *
 * **7日にしたのは、平日に溜めた確認を休みの日にまとめて見る**進め方
 * （作者は平日日中は不在）でも、前の週末の分まで遡れるようにするため。
 */
export const NOTICE_LOG_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/**
 * 知らせの文を記録へ残す長さの上限（字）。
 *
 * **知らせの文そのものは残してよいが、長い文は切る。** 知らせに原稿の
 * 一部（選んだ語・抜き出した行など）が混ざることがあり、長く残すほど
 * 本文が保管庫へ溜まる。どの知らせか見分けるには先頭200字で足りる。
 */
export const NOTICE_TEXT_MAX_CHARS = 200;

/** 読むときの既定の件数（`limit` を省いたとき） */
export const NOTICE_DEFAULT_LIMIT = 50;

export type NoticeSeverity = "info" | "warning" | "error";

export interface NoticeAnswer {
  /** 閉じられた（ボタンが押された）時刻（ISO） */
  at: string;
  /**
   * 押されたボタンの名前。**閉じるだけで何も押されなかったときは `null`**
   * （モーダルの「キャンセル」もここ）。
   */
  choice: string | null;
}

export interface NoticeEntry {
  /** 窓の中の通し番号（1から） */
  seq: number;
  /** 知らせを出した時刻（ISO） */
  at: string;
  severity: NoticeSeverity;
  /** 画面の中央に出る知らせ（`modal: true`）か */
  modal: boolean;
  /** 知らせの文（伏せ字と長さの切り詰めを済ませたもの） */
  message: string;
  /** モーダルの下段の説明（`detail`）。無ければ `null` */
  detail: string | null;
  /** ボタンの名前（出した順） */
  items: string[];
  /** 文・説明・ボタンのどれかを切り詰めたか */
  truncated: boolean;
  /**
   * 閉じられたときの返事。**まだ閉じられていなければ `null`**
   * （通知が右下に残っている・窓が先に閉じた）。
   */
  answer: NoticeAnswer | null;
}

export interface NoticeLogFile {
  schema: number;
  /** 拡張機能ホストのプロセス番号（窓の札の `pid` と同じ） */
  pid: number;
  /** 機械の名前（`shortMachineName`）。取れなければ `null` */
  machineName: string | null;
  /** 拡張機能の版 */
  extensionVersion: string;
  /** この窓で拡張機能が起動した時刻（ISO） */
  startedAt: string;
  /** 最後に書き直した時刻（ISO） */
  updatedAt: string;
  notices: NoticeEntry[];
}

/** 秘密を伏せる関数（拡張機能側は `core/logger.ts` の `redactSecrets` を渡す） */
export type RedactFunction = (text: string) => string;

/**
 * 記録へ残す文に直す：**先に伏せてから切る。**
 *
 * 逆にすると、切った境目でキーの形が崩れて伏せ字の判定をすり抜け、
 * キーの頭だけが残ることがある。切るのは字（コードポイント）単位で、
 * 絵文字や一部の漢字（サロゲートペア）を半分に割らない。
 */
export function clipNoticeText(
  text: string,
  redact: RedactFunction
): { text: string; truncated: boolean } {
  const redacted = redact(text);
  const chars = Array.from(redacted);
  if (chars.length <= NOTICE_TEXT_MAX_CHARS) {
    return { text: redacted, truncated: false };
  }
  return {
    text: `${chars.slice(0, NOTICE_TEXT_MAX_CHARS).join("")}…`,
    truncated: true,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * ボタン（`MessageItem`）か。VS Code は文字列か `{ title }` を受ける。
 */
function itemTitle(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isObject(value) && typeof value.title === "string") return value.title;
  return undefined;
}

/**
 * `showInformationMessage(message, ...rest)` の引数から、記録に残す中身を取る。
 *
 * VS Code の受け方は2通りある：`(message, ...items)` と
 * `(message, options, ...items)`。**2つ目が `title` を持たない物なら
 * options** とみなす（VS Code 自身も「2つ目を options かボタンか」で
 * 見分けている）。見分けられない引数は、ボタンとして数えずに捨てる
 * ——記録のために知らせを止める理由は無い。
 */
export function describeNoticeCall(
  severity: NoticeSeverity,
  args: readonly unknown[],
  redact: RedactFunction
): Omit<NoticeEntry, "seq" | "at" | "answer"> {
  let truncated = false;
  const clip = (text: string): string => {
    const result = clipNoticeText(text, redact);
    if (result.truncated) truncated = true;
    return result.text;
  };

  const message = clip(typeof args[0] === "string" ? args[0] : String(args[0] ?? ""));
  let rest = args.slice(1);
  let modal = false;
  let detail: string | null = null;
  const first = rest[0];
  if (isObject(first) && typeof first.title !== "string") {
    modal = first.modal === true;
    detail = typeof first.detail === "string" ? clip(first.detail) : null;
    rest = rest.slice(1);
  }
  const items: string[] = [];
  for (const item of rest) {
    const title = itemTitle(item);
    if (title !== undefined) items.push(clip(title));
  }
  return { severity, modal, message, detail, items, truncated };
}

/**
 * 返ってきた値から、押されたボタンの名前を取る（閉じただけなら `null`）。
 * 名前も伏せて切る——ボタンの名前に作品名などが入ることがある。
 */
export function answerChoice(value: unknown, redact: RedactFunction): string | null {
  const title = itemTitle(value);
  return title === undefined ? null : clipNoticeText(title, redact).text;
}

/**
 * 上限（件数・期間）を超えたものを落とす。**新しいものを残す。**
 *
 * 読めない時刻の知らせは落とす——いつのものか分からないものを
 * 「直近」として並べると、実機確認の判断を誤らせる。
 */
export function pruneNotices(
  notices: readonly NoticeEntry[],
  now: Date
): NoticeEntry[] {
  const cutoff = now.getTime() - NOTICE_LOG_MAX_AGE_MS;
  const kept = notices.filter((notice) => {
    const at = Date.parse(notice.at);
    return !Number.isNaN(at) && at >= cutoff;
  });
  return kept.slice(Math.max(0, kept.length - NOTICE_LOG_MAX_ENTRIES));
}

/** 記録のファイル名。**プロセス番号と起動時刻で決める**（使い回された番号で上書きしない） */
export function noticeLogFileName(pid: number, startedAt: Date): string {
  return `${pid}-${startedAt.getTime()}.json`;
}

export function serializeNoticeLog(file: NoticeLogFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

const SEVERITIES: readonly NoticeSeverity[] = ["info", "warning", "error"];

function parseAnswer(value: unknown): NoticeAnswer | null | undefined {
  if (value === null) return null;
  if (!isObject(value)) return undefined;
  if (typeof value.at !== "string") return undefined;
  if (value.choice !== null && typeof value.choice !== "string") return undefined;
  return { at: value.at, choice: value.choice };
}

function parseEntry(value: unknown): NoticeEntry | undefined {
  if (!isObject(value)) return undefined;
  if (typeof value.seq !== "number" || !Number.isInteger(value.seq)) return undefined;
  if (typeof value.at !== "string") return undefined;
  if (!SEVERITIES.includes(value.severity as NoticeSeverity)) return undefined;
  if (typeof value.modal !== "boolean") return undefined;
  if (typeof value.message !== "string") return undefined;
  if (value.detail !== null && typeof value.detail !== "string") return undefined;
  if (!isStringArray(value.items)) return undefined;
  if (typeof value.truncated !== "boolean") return undefined;
  const answer = parseAnswer(value.answer);
  if (answer === undefined) return undefined;
  return {
    seq: value.seq,
    at: value.at,
    severity: value.severity as NoticeSeverity,
    modal: value.modal,
    message: value.message,
    detail: value.detail,
    items: value.items,
    truncated: value.truncated,
    answer,
  };
}

/**
 * 記録を読む。**形が合わなければ `undefined`**（直しにいかない）。
 *
 * 知らせ1件が壊れていたら、**その1件だけを落として残りは読む**。
 * ファイルごと捨てると、1件のために1窓ぶんの知らせが消える。
 */
export function parseNoticeLog(text: string): NoticeLogFile | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(raw)) return undefined;
  if (raw.schema !== NOTICE_LOG_SCHEMA) return undefined;
  if (typeof raw.pid !== "number" || !Number.isInteger(raw.pid)) return undefined;
  if (raw.machineName !== null && typeof raw.machineName !== "string") return undefined;
  if (
    typeof raw.extensionVersion !== "string" ||
    typeof raw.startedAt !== "string" ||
    typeof raw.updatedAt !== "string" ||
    !Array.isArray(raw.notices)
  ) {
    return undefined;
  }
  const notices: NoticeEntry[] = [];
  for (const item of raw.notices) {
    const entry = parseEntry(item);
    if (entry) notices.push(entry);
  }
  return {
    schema: NOTICE_LOG_SCHEMA,
    pid: raw.pid,
    machineName: raw.machineName,
    extensionVersion: raw.extensionVersion,
    startedAt: raw.startedAt,
    updatedAt: raw.updatedAt,
    notices,
  };
}

/**
 * もう読まれることのない記録か（最後に書き直してから保管期間を過ぎた）。
 * 拡張機能が起動したときに、閉じた窓の記録を片づけるのに使う。
 * **読めない時刻は片づけない**——判断できないものを消さない。
 */
export function isNoticeLogExpired(file: NoticeLogFile, now: Date): boolean {
  const at = Date.parse(file.updatedAt);
  if (Number.isNaN(at)) return false;
  return now.getTime() - at > NOTICE_LOG_MAX_AGE_MS;
}

export interface NoticeQuery {
  /** この時刻より後の知らせだけ（ISO）。読めなければ断る（呼ぶ側で） */
  since?: string;
  /** 件数の上限。既定は `NOTICE_DEFAULT_LIMIT`、最大 `NOTICE_LOG_MAX_ENTRIES` */
  limit?: number;
  /** 文・説明・ボタンの名前に、この文字を含むものだけ */
  contains?: string;
  /** この窓（拡張機能ホストのプロセス番号）の知らせだけ */
  pid?: number;
}

export interface NoticeView extends NoticeEntry {
  pid: number;
  machineName: string | null;
  extensionVersion: string;
}

/**
 * 記録を絞り込んで、**新しい順**に並べる。
 *
 * `matched` は件数の上限で切る前の数——「50件出たが、本当は何件あったか」が
 * 分からないと、絞り込みを狭めるべきかどうか決められない。
 */
export function selectNotices(
  files: readonly NoticeLogFile[],
  query: NoticeQuery,
  now: Date
): { notices: NoticeView[]; matched: number } {
  const since = query.since === undefined ? undefined : Date.parse(query.since);
  const needle = query.contains?.trim() ? query.contains.trim() : undefined;
  const limit = Math.min(
    NOTICE_LOG_MAX_ENTRIES,
    Math.max(1, Math.floor(query.limit ?? NOTICE_DEFAULT_LIMIT))
  );

  const views: NoticeView[] = [];
  for (const file of files) {
    if (query.pid !== undefined && file.pid !== query.pid) continue;
    // 書く側が落とし損ねた古い知らせも、読む側で同じ上限を当てる
    for (const notice of pruneNotices(file.notices, now)) {
      if (since !== undefined && !Number.isNaN(since) && Date.parse(notice.at) <= since) {
        continue;
      }
      if (
        needle !== undefined &&
        !notice.message.includes(needle) &&
        !(notice.detail ?? "").includes(needle) &&
        !notice.items.some((item) => item.includes(needle))
      ) {
        continue;
      }
      views.push({
        ...notice,
        pid: file.pid,
        machineName: file.machineName,
        extensionVersion: file.extensionVersion,
      });
    }
  }
  views.sort(
    (a, b) =>
      Date.parse(b.at) - Date.parse(a.at) || a.pid - b.pid || b.seq - a.seq
  );
  return { notices: views.slice(0, limit), matched: views.length };
}
