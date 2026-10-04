import { AIWRITER_DIR } from "../models/types";
import type { OutboxImportOutcome, OutboxRecord } from "./outboxImport";

/**
 * 原稿箱の受け取り箱（設計書6.115「GitHub 経由」）。
 *
 * 出先のページ（claude.ai）は、押したもの（採否・メモ・自分で直した文）を GitHub の
 * 作品のリポジトリへ `<作品>/.aiwriter/inbox/<時刻>-<端末>.json` として**新しいファイルで**
 * 置く。既存のファイルを書き換えないので、同期の衝突が起きない。パソコンの拡張機能が
 * それを読んで取り込み（`core/outboxImport.ts`）、済んだ箱を `done/` へ移す。
 *
 * ここはその**箱の形（ページと拡張機能の約束）**と、読み方・数え方だけを持つ。
 * `vscode` にも `fs` にも触らない。
 *
 * **箱の中身は指示として読まない。** GitHub に書けるのは書く権限のある人だけで、
 * 編集部とは共有しない裁定（2026-10-03）なので、記録は**すべて持ち主の判断**として
 * 扱う——それでも外から来たものなので、決まった形の欄だけを読む。
 */

/** 受け取り箱（作品フォルダーからの相対） */
export const OUTBOX_INBOX_DIR = `${AIWRITER_DIR}/inbox`;

/** 取り込んだ箱の移し先の名前（`inbox/` の下） */
export const OUTBOX_INBOX_DONE = "done";

/** 箱の印。ページはこの値を `format` に入れる */
export const OUTBOX_INBOX_FORMAT = "novelai-outbox-inbox";

/** 箱の形の版。形を変えたら上げ、読めない版は取り込まずに止める */
export const OUTBOX_INBOX_VERSION = 1;

/**
 * 書き手の印が無い箱の書き手。取り込みの鍵（`書き手/記録のid`）の頭に入る
 */
export const OUTBOX_INBOX_DEFAULT_WRITER = "inbox";

/** ページが置く箱の形 */
export interface OutboxInboxFile {
  format: typeof OUTBOX_INBOX_FORMAT;
  version: number;
  /** 送った時刻（ISO 8601） */
  sentAt: string;
  /** 端末の呼び名（タブレット・スマホ・パソコン） */
  device: string;
  /** 送った人（claude.ai の id）。取り込みの鍵に使うだけで、持ち主かどうかは見ない */
  writer: string;
  records: OutboxRecord[];
}

export type ParsedInbox =
  | {
      ok: true;
      sentAt: string;
      device: string;
      writer: string;
      records: OutboxRecord[];
      /** 形が合わず読まなかった記録の数 */
      skipped: number;
    }
  | { ok: false; reason: string };

const KINDS = new Set(["memo", "verdict", "edit"]);
const VERDICTS = new Set(["fix", "done", "reject"]);

/**
 * 箱を1つ読む。**壊れた箱は直さずに止める**（実装ルール2）——呼び手は
 * その箱を `inbox/` に残し、作者に理由を見せる。
 *
 * 記録の書き手は**箱の `writer`** にそろえる（記録の欄の `writer` は見ない）。
 */
export function parseInboxFile(text: string): ParsedInbox {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    return {
      ok: false,
      reason: `JSON として読めません（${error instanceof Error ? error.message : String(error)}）`,
    };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "箱の形ではありません（JSON のオブジェクトではない）" };
  }
  const box = value as Record<string, unknown>;
  if (box.format !== OUTBOX_INBOX_FORMAT) {
    return { ok: false, reason: `箱の印（format: ${OUTBOX_INBOX_FORMAT}）がありません` };
  }
  if (box.version !== OUTBOX_INBOX_VERSION) {
    return {
      ok: false,
      reason: `この拡張機能が読めない版の箱です（version: ${String(box.version)}）。拡張機能を新しくしてください`,
    };
  }
  if (!Array.isArray(box.records)) {
    return { ok: false, reason: "記録（records）がありません" };
  }
  const writer = safeWriter(str(box.writer));
  const records: OutboxRecord[] = [];
  let skipped = 0;
  for (const raw of box.records) {
    const record = toRecord(raw, writer);
    if (record) records.push(record);
    else skipped += 1;
  }
  return { ok: true, sentAt: str(box.sentAt), device: str(box.device), writer, records, skipped };
}

function toRecord(raw: unknown, writer: string): OutboxRecord | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  const id = str(value.id);
  const kind = str(value.kind);
  if (!id || !KINDS.has(kind)) return undefined;
  const record: OutboxRecord = { id, writer, kind: kind as OutboxRecord["kind"] };
  for (const key of ["at", "device", "episode", "findingId", "text", "original", "baseHash", "baseBlobSha"] as const) {
    const field = value[key];
    if (typeof field === "string") record[key] = field;
  }
  if (typeof value.line === "number" && Number.isFinite(value.line)) record.line = value.line;
  if (typeof value.verdict === "string" && VERDICTS.has(value.verdict)) {
    record.verdict = value.verdict as OutboxRecord["verdict"];
  }
  return record;
}

/** 鍵（`書き手/id`）に使えない文字の書き手は、決まった名前にそろえる */
function safeWriter(writer: string): string {
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(writer) ? writer : OUTBOX_INBOX_DEFAULT_WRITER;
}

/**
 * 取り込み待ちの箱か（`done/` の中は除く）。道は作品フォルダーからでも、
 * リポジトリの根からでもよい（書庫では `<作品>/.aiwriter/inbox/...` になる）
 */
export function isPendingInboxPath(file: string): boolean {
  return /(^|\/)\.aiwriter\/inbox\/[^/]+\.json$/i.test(file.split("\\").join("/"));
}

/** 受け取り箱の中の名前のうち、取り込み待ちの箱（`.json` のファイル） */
export function pendingInboxNames(names: readonly string[]): string[] {
  return names
    .filter((name) => /\.json$/i.test(name) && !name.startsWith("."))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * `done/` へ移すときの名前。同じ名前がもう在れば、`-2`・`-3`…を足す
 * （**既存のファイルを上書きしない**。実装ルール2）
 */
export function doneNameFor(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let index = 2; ; index += 1) {
    const candidate = `${stem}-${index}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** 取り込みの結果を、知らせの一文にする */
export function describeInboxImport(
  outcome: Pick<OutboxImportOutcome, "importedCount" | "alreadyCount" | "refusedCount">,
  brokenCount: number
): string {
  const parts = [`${outcome.importedCount}件を入れました`];
  if (outcome.refusedCount > 0) parts.push(`${outcome.refusedCount}件は入れませんでした`);
  if (outcome.alreadyCount > 0) parts.push(`${outcome.alreadyCount}件は前に入れ済みでした`);
  if (brokenCount > 0) parts.push(`読めない箱が${brokenCount}つあります（受け取り箱に残しました）`);
  return `原稿箱から${parts.join("。")}。`;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
