import { AIWRITER_DIR } from "../models/types";
import {
  FINDINGS_FILE_NAME,
  OUTBOX_DECISION_NOTES,
  findingId,
  parseFindingLines,
  resolveFindings,
  type Finding,
  type FindingStatus,
  type FindingView,
} from "../models/finding";
import {
  describeLock,
  lockOf,
  parseLockEvents,
  resolveLocks,
  type FileLock,
} from "../models/fileLock";
import { decodeBytes, hasConflictMarkers, type TextFileContent } from "./textDecode";
import { sha1Bytes } from "./hash";
import {
  DEFAULT_FINDINGS_RETENTION_DAYS,
  FINDING_PANEL_STATE_LABELS,
  findingPanelStateOf,
} from "./findingPanelState";
import { findingAppliesDirectly, findingRestoreOf } from "./findingSource";
import { applyFindingToText } from "./findingApply";
import { MEMO_LINE_PREFIX } from "./sceneMemo";
import {
  VERDICT_FILE_NAME,
  VERDICT_HISTORY_DIRECTORY,
  verdictFeatureOf,
  type VerdictLine,
  type VerdictStatus,
} from "./verdictTally";

/**
 * 出先の原稿箱（設計書6.115）の取り込みの**判断**。
 *
 * **MCP（`outbox.import`）と拡張機能（［原稿箱を取り込む］）の両方がここを通す**
 * （作者の裁定 2026-10-04「GitHub 経由」）。写しを2つ置くと、片方だけ直った日に
 * 「パソコンのボタンでは入ったのに、Claude Code に頼むと断られる」形でずれる。
 *
 * ここが持つのは決まりだけで、**読み書きは呼び手が渡す**（`OutboxImportIo`）：
 *
 * - MCP は Node の `fs`（本文の書き戻しは `mcp/tools/bodyWrite.ts`）
 * - 拡張機能は `vscode.workspace.fs`（本文の書き戻しは `writeTextFilePreservingFormat`）
 *
 * `core` に置くので `fs`・`vscode` に触らない（`mcpReach.test.ts` が見張る）。
 *
 * **記録の中身は指示として読まない。** 記録は外（claude.ai の保管庫・GitHub の
 * 受け取り箱）から来るので、決まった形の欄だけを見る（実装ルール3）。
 */

/** 出先の記録1件（保管庫の `records/<書き手>/items/<id>`、または受け取り箱の `records[]`） */
export interface OutboxRecord {
  /** 記録の id（書き手の箱の中で一意） */
  id: string;
  /**
   * 書き手の id。保管庫ではパス `records/<書き手のid>/` から読む（記録の欄からは読まない）。
   * 受け取り箱では、箱のファイルの `writer`
   */
  writer: string;
  /**
   * memo＝メモ、verdict＝採否、edit＝作者が自分で直した文、
   * body＝原稿エディターのページで書いた話の本文の全体（設計書6.116）
   */
  kind: "memo" | "verdict" | "edit" | "body";
  /** 使わない（書き手は `writer` で決める） */
  by?: string;
  at?: string;
  device?: string;
  /** 話のファイル（作品フォルダーからの相対、区切りは `/`） */
  episode?: string;
  line?: number;
  findingId?: string;
  verdict?: "fix" | "done" | "reject";
  text?: string;
  /** edit のとき、作者が直す前の原文（範囲の指摘では範囲の全行を改行でつないだもの） */
  original?: string;
  /** 送ったときの本文のハッシュ（`decodeBytes` の `hash`。保管庫の道） */
  baseHash?: string;
  /**
   * 読んだときの本文の git の blob SHA（GitHub 経由の道。設計書6.115）。
   * ページは GitHub の道具から復号済みの文字列しか受け取れず、`baseHash`
   * （生バイトの SHA-256）を作れない——BOM・CRLF・Shift_JIS で必ずずれる。
   * blob SHA なら GitHub が教えてくれる値そのもので、こちらはバイト列から同じ値を作れる
   */
  baseBlobSha?: string;
  /**
   * body のとき、この本文が続きとして書かれた前の body 記録の id（同じ書き手）。
   * ページは送ったあと取り込まれる前の本文を重ねて見せ、その上に続きを書かせる——
   * そのときの `baseBlobSha` は送る前の古い本文のままなので、前の記録を入れたあとの
   * 本文と比べる手がかりが要る（設計書6.116）
   */
  basedOn?: string;
  imported?: boolean;
}

/** 本文の書き戻しの結果（呼び手が製品／MCP の書き戻しの結果をここへ写す） */
export type OutboxBodyWriteOutcome =
  | { ok: true }
  | {
      ok: false;
      /** 読んだあとに外で書き換えられた（理由は「本文が変わった」に揃える） */
      changed: boolean;
      /** 作者に読める理由 */
      reason: string;
    };

/**
 * 取り込みの読み書き。**道はすべて作品フォルダーからの相対で、区切りは `/`。**
 */
export interface OutboxImportIo {
  /** `.aiwriter/` の下のテキスト（置き場・ロック・入れ済み）を読む。無ければ undefined */
  readText(relative: string): Promise<string | undefined>;
  /** 本文のファイルの一覧。**書いてよいのはここに在るものだけ** */
  listBodyFiles(): Promise<string[]>;
  /** 本文のバイト列を読む。読めなければ投げる */
  readBytes(relative: string): Promise<Uint8Array>;
  /**
   * 本文を書き戻す。**`original.hash`（読み込み時のハッシュ）と違えば書かない**こと。
   * 拡張機能は `writeTextFilePreservingFormat`、MCP は `writeBodyPreservingFormat`
   */
  writeBody(
    relative: string,
    newText: string,
    original: TextFileContent
  ): Promise<OutboxBodyWriteOutcome>;
  /** 追記だけ（同期の衝突を避ける。`FindingStore` と同じ決まり） */
  appendJsonLines(relative: string, values: readonly object[]): Promise<void>;
}

export interface OutboxImportOptions {
  /**
   * 書き手が作品の持ち主か。採否と自分で直した文は、持ち主の記録だけを入れる。
   * MCP は保管庫の `works/owner` と比べ、受け取り箱は**すべて持ち主**
   * （GitHub に書けるのは書く権限のある人だけで、編集部とは共有しない裁定。6.115）
   */
  isOwner: (writer: string) => boolean;
  records: readonly OutboxRecord[];
  /** 期限切れと見なす日数（省略時3、0で無期限） */
  retentionDays?: number;
  /** 試験のために外から渡す */
  now?: Date;
}

export type OutboxImportStatus = "imported" | "already" | "refused";

export interface OutboxImportItem {
  id: string;
  /** 書き手 */
  writer: string;
  status: OutboxImportStatus;
  /** 入れた・断った理由（作者に読める日本語） */
  reason: string;
  /**
   * body を「本文が変わった」で断ったときの、パソコンのいまの本文の blob SHA。
   * ページは GitHub から読み直した本文がこの値と同じかを見て、送った本文との
   * 違いを並べる（同期の前なら、まだ古い本文しか読めない）
   */
  currentBlobSha?: string;
}

export interface OutboxImportOutcome {
  results: OutboxImportItem[];
  importedCount: number;
  alreadyCount: number;
  refusedCount: number;
}

/** 入れた記録の鍵（書き手/文書の id）を残す場所（`.aiwriter/history/`。同期される・追記だけ） */
export const OUTBOX_IMPORTED_FILE = "outbox-imported.jsonl";

/** 断る理由。**本文のハッシュが送ったときと違う**（6.115 の決まり） */
export const BODY_CHANGED_REASON =
  "パソコンの本文が変わっています（送ったあとに書き換えられたため、入れませんでした。最新を送り直してから書いてください）";

/** 出先の編集部のメモの頭書き（6.115） */
export const EDITORIAL_PREFIX = "編集部：";

/**
 * ［自分で直す］で足す行の覚え書き。**置き換えた文が作者の文であることの印**——
 * 判断の行（`decision`）の `note` と、足した指摘の行の `message` の頭に入れる。
 * 置き場の行は決まった欄しか読まれない（`models/finding.ts`）ので、新しい欄では
 * なく既存の欄で分かるようにした
 */
export const AUTHOR_EDIT_NOTE = OUTBOX_DECISION_NOTES.authorEdit;

/** 断る理由。同じ指摘に持ち主の判断が2件以上あり、これより新しいものがある */
export const OVERLAP_REASON =
  "重なり：同じ指摘に、これより新しい判断があります（いちばん新しい1件だけを入れました）。";

const FINDINGS_PATH = `${AIWRITER_DIR}/${FINDINGS_FILE_NAME}`;
const VERDICTS_PATH = `${AIWRITER_DIR}/${VERDICT_HISTORY_DIRECTORY}/${VERDICT_FILE_NAME}`;
const IMPORTED_PATH = `${AIWRITER_DIR}/${VERDICT_HISTORY_DIRECTORY}/${OUTBOX_IMPORTED_FILE}`;
const LOCKS_PATH = `${AIWRITER_DIR}/locks/locks.jsonl`;

/**
 * 記録を見分ける鍵。**書き手（パス）＋文書の id**——文書の id は書き手ごとの
 * 箱の中でしか一意でない
 */
export function outboxRecordKey(record: { writer: string; id: string }): string {
  return `${record.writer}/${record.id}`;
}

/**
 * git の blob SHA（`git hash-object` と同じ値）。GitHub の道具が返す `sha` と比べる。
 * 区切りの NUL はエスケープで書く（生の制御文字を置くと git がこのファイルをバイナリ扱いする）
 */
export function gitBlobSha(bytes: Uint8Array): string {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\u0000`);
  const joined = new Uint8Array(header.byteLength + bytes.byteLength);
  joined.set(header, 0);
  joined.set(bytes, header.byteLength);
  return sha1Bytes(joined);
}

/**
 * 本文のバイト列から、GitHub 側の blob SHA になりうる値を作る。
 * そのままのバイト列と、CRLF を LF にしたもの——`core.autocrlf` が効いている機械では
 * 手元が CRLF、リポジトリが LF になる（この拡張機能は止めるよう案内している。5.5.1）
 */
function blobShaCandidates(bytes: Uint8Array): Set<string> {
  const candidates = new Set<string>([gitBlobSha(bytes)]);
  if (bytes.includes(0x0d)) {
    const lf: number[] = [];
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] === 0x0d && bytes[index + 1] === 0x0a) continue;
      lf.push(bytes[index]);
    }
    candidates.add(gitBlobSha(Uint8Array.from(lf)));
  }
  return candidates;
}

/**
 * 入れ済みの body 記録の、書いたあとの本文の blob SHA（鍵 → SHA）。
 * 続きの印（`basedOn`）の先を入れたあとの本文が、いまも同じかを確かめるため
 */
export function parseImportedBodyShas(text: string | undefined): Map<string, string> {
  const shas = new Map<string, string>();
  if (!text) return shas;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as { id?: unknown; blobSha?: unknown };
      if (typeof value.id === "string" && typeof value.blobSha === "string") shas.set(value.id, value.blobSha);
    } catch {
      // 壊れた行は飛ばす
    }
  }
  return shas;
}

/** 入れ済みの鍵の行を読む。壊れた行（同期の競合など）は飛ばす */
export function parseImportedKeys(text: string | undefined): Set<string> {
  const ids = new Set<string>();
  if (!text) return ids;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as { id?: unknown };
      if (typeof value.id === "string") ids.add(value.id);
    } catch {
      // 壊れた行は飛ばす
    }
  }
  return ids;
}

interface FileState {
  relative: string;
  /** 取り込みを始めたときのハッシュ（記録の `baseHash` はこれと比べる） */
  startHash: string;
  /** 取り込みを始めたときの blob SHA の候補（記録の `baseBlobSha` はこれと比べる） */
  startBlobShas: Set<string>;
  /**
   * いまの（この回で書いたあとの）blob SHA の候補。**body はこちらと比べる**——
   * 本文の全体を置き換えるので、同じ回で先に書いた分を、古い本文から書いた
   * 別の本文で黙って消さないため
   */
  currentBlobShas: Set<string>;
  /** いまのバイト列そのままの blob SHA（断るときにページへ返す） */
  currentBlobSha: string;
  content: TextFileContent;
}

type StateOf = (file: string) => Promise<FileState | Error>;
type Reread = (state: FileState) => Promise<void>;
type Locks = Map<string, FileLock>;

interface Context {
  isOwner: (writer: string) => boolean;
  views: Map<string, FindingView>;
  stateOf: StateOf;
  reread: Reread;
  locks: Locks;
  retentionDays: number;
  now: Date;
  io: OutboxImportIo;
  /** 入れた body 記録の鍵 → 書いたあとの blob SHA（前の回の分と、この回の分） */
  bodyShas: Map<string, string>;
}

/**
 * 記録を作品へ入れる。結果は**渡した順**で返す。
 *
 * - メモは本文に `//` の行として（送ったときの本文と違えば断る）
 * - 採否と自分で直した文は持ち主の記録だけを、提案パネルと同じ判断の記録へ
 * - 同じ指摘に持ち主の判断が2件以上あれば、いちばん新しい1件だけ
 * - 同じ記録は2度入れない（`.aiwriter/history/outbox-imported.jsonl`）
 */
export async function importOutboxRecords(
  io: OutboxImportIo,
  options: OutboxImportOptions
): Promise<OutboxImportOutcome> {
  const retentionDays = options.retentionDays ?? DEFAULT_FINDINGS_RETENTION_DAYS;
  const now = options.now ?? new Date();
  const importedText = await io.readText(IMPORTED_PATH);
  const done = parseImportedKeys(importedText);
  const bodyShas = parseImportedBodyShas(importedText);
  const views = new Map(
    resolveFindings(parseFindingLines((await io.readText(FINDINGS_PATH)) ?? "")).map(
      (view) => [view.id, view]
    )
  );
  const locks = readLocks(await io.readText(LOCKS_PATH));
  const files = new Map<string, FileState | Error>();

  /*
    **書いてよいのは本文のファイルだけ。** 記録の `episode` は外から来るので、
    作品フォルダーの中でも設定資料や `.aiwriter/` を指していれば断る
  */
  const bodyFiles = new Set((await io.listBodyFiles()).map(toSlash));

  const stateOf: StateOf = async (file) => {
    const key = toSlash(file);
    const cached = files.get(key);
    if (cached) return cached;
    let state: FileState | Error;
    if (!bodyFiles.has(key)) {
      state = new Error(`本文のファイルではありません: ${key}`);
      files.set(key, state);
      return state;
    }
    try {
      const bytes = await io.readBytes(key);
      const content = decodeBytes(bytes);
      state = content.hasConflictMarkers
        ? new Error("Gitの競合マーカーが残っています（先に解消してください）")
        : {
            relative: key,
            startHash: content.hash,
            startBlobShas: blobShaCandidates(bytes),
            currentBlobShas: blobShaCandidates(bytes),
            currentBlobSha: gitBlobSha(bytes),
            content,
          };
    } catch (error) {
      state = new Error(
        `本文を読めませんでした: ${key}（${error instanceof Error ? error.message : String(error)}）`
      );
    }
    files.set(key, state);
    return state;
  };

  /** 書いたあと、次の記録のために読み直す（ハッシュを持ち越す） */
  const reread: Reread = async (state) => {
    const bytes = await io.readBytes(state.relative);
    state.content = decodeBytes(bytes);
    state.currentBlobShas = blobShaCandidates(bytes);
    state.currentBlobSha = gitBlobSha(bytes);
  };

  const context: Context = {
    isOwner: options.isOwner,
    views,
    stateOf,
    reread,
    locks,
    retentionDays,
    now,
    io,
    bodyShas,
  };

  const results = new Map<string, OutboxImportItem>();
  const decisions: Array<{ findingId: string; status: FindingStatus; note: string }> = [];
  const verdicts: VerdictLine[] = [];
  /** ［自分で直す］で足す指摘の行（提案パネルの［戻す］と同じ形で戻せるように） */
  const authorFindings: Finding[] = [];
  const importedIds: Array<{ id: string; blobSha?: string }> = [];
  const decided = new Set<string>();

  /*
    **本文の全体を先に、メモをその次に、採否をあとに入れる。**
    - 本文の全体（body）は送った時点の全文で置き換えるので、先にメモを入れると
      そのメモの行を消してしまう。メモと［直す］は、いまの本文で位置を探し直す
    - body どうしは時刻の順（続きの印 `basedOn` は前の記録を入れたあとの本文に続ける）
    - 同じ話で［直す］を先に当てると、その指摘に付けたメモの行が引けなくなる
      （原文が直って探せない）
    結果は渡された順で返す
  */
  const bodies = options.records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => record.kind === "body")
    .sort((a, b) => timeOf(a.record) - timeOf(b.record) || a.index - b.index)
    .map(({ record }) => record);
  const ordered = [
    ...bodies,
    ...options.records.filter((record) => record.kind === "memo"),
    ...options.records.filter((record) => record.kind === "verdict" || record.kind === "edit"),
  ];

  const finish = (
    record: OutboxRecord,
    status: OutboxImportStatus,
    reason: string,
    extra: { blobSha?: string; currentBlobSha?: string } = {}
  ) => {
    const key = outboxRecordKey(record);
    const item: OutboxImportItem = { id: record.id, writer: record.writer, status, reason };
    if (extra.currentBlobSha) item.currentBlobSha = extra.currentBlobSha;
    results.set(key, item);
    if (status === "imported") {
      done.add(key);
      importedIds.push(extra.blobSha ? { id: key, blobSha: extra.blobSha } : { id: key });
      if (extra.blobSha) bodyShas.set(key, extra.blobSha);
    }
  };

  /*
    **同じ指摘に持ち主の判断（採否・自分で直した文）が2件以上あれば、いちばん新しい
    1件だけを当てる**（作者の報告 2026-10-04：［採らない］を押しても見た目が変わらず、
    同じ指摘に4回押していた）。決め直したのなら新しいほうが作者の意思である。
    入れ済みの記録は数えない（2度目は「入れ済み」で返すだけなので）
  */
  const latestDecision = new Map<string, { record: OutboxRecord; time: number; index: number }>();
  options.records.forEach((record, index) => {
    if (record.kind === "memo" || record.kind === "body") return;
    if (!options.isOwner(record.writer) || !record.findingId) return;
    if (done.has(outboxRecordKey(record))) return;
    const time = Date.parse(record.at ?? "");
    const at = Number.isNaN(time) ? -Infinity : time;
    const current = latestDecision.get(record.findingId);
    // 時刻が同じ（または読めない）なら、あとに渡されたほうを新しいとみなす
    if (!current || at > current.time || (at === current.time && index > current.index)) {
      latestDecision.set(record.findingId, { record, time: at, index });
    }
  });

  for (const record of ordered) {
    if (results.has(outboxRecordKey(record))) continue; // 同じ記録が2度渡された
    if (done.has(outboxRecordKey(record))) {
      finish(record, "already", "入れ済みです（前に取り込みました）。");
      continue;
    }
    if (record.kind === "body") {
      const outcome = await importBody(record, context);
      finish(record, outcome.ok ? "imported" : "refused", outcome.reason, {
        blobSha: outcome.ok ? outcome.blobSha : undefined,
        currentBlobSha: outcome.ok ? undefined : outcome.currentBlobSha,
      });
      continue;
    }
    if (record.kind === "memo") {
      const outcome = await importMemo(record, context);
      finish(record, outcome.ok ? "imported" : "refused", outcome.reason);
      continue;
    }
    const latest = record.findingId ? latestDecision.get(record.findingId) : undefined;
    // 鍵（書き手/文書の id）で比べる。同じ記録が2度渡されたとき、片方を重なりにしない
    if (latest && outboxRecordKey(latest.record) !== outboxRecordKey(record)) {
      finish(record, "refused", OVERLAP_REASON);
      continue;
    }
    // 念のための歯止め（持ち主でない記録など、上の振り分けに乗らないもの）
    if (record.findingId && decided.has(record.findingId)) {
      finish(record, "refused", "この指摘には、同じ取り込みの中で先に判断を入れました。");
      continue;
    }
    const outcome: DecisionOutcome =
      record.kind === "edit" ? await importEdit(record, context) : await importVerdict(record, context);
    if (outcome.ok) {
      decided.add(outcome.decision.findingId);
      decisions.push(outcome.decision);
      if (outcome.verdict) verdicts.push(outcome.verdict);
      if (outcome.authorFinding) {
        authorFindings.push(outcome.authorFinding);
        decisions.push({
          findingId: outcome.authorFinding.id,
          status: "accepted",
          note: AUTHOR_EDIT_NOTE,
        });
      }
    }
    finish(record, outcome.ok ? "imported" : "refused", outcome.reason);
  }

  /*
    判断の記録 → 採否の数 → 入れ済みの id の順に残す（本文はもう書いてある）。
    自分で直した文は、指摘の行を先に足してから、その判断を足す
  */
  await io.appendJsonLines(FINDINGS_PATH, [
    ...authorFindings.map((item) => ({ kind: "finding", ...item })),
    ...decisions.map((decision) => ({
      kind: "decision",
      findingId: decision.findingId,
      time: now.toISOString(),
      status: decision.status,
      note: decision.note,
    })),
  ]);
  await io.appendJsonLines(VERDICTS_PATH, verdicts);
  await io.appendJsonLines(
    IMPORTED_PATH,
    importedIds.map((item) =>
      item.blobSha
        ? { id: item.id, time: now.toISOString(), blobSha: item.blobSha }
        : { id: item.id, time: now.toISOString() }
    )
  );

  const list = options.records
    .map((record) => results.get(outboxRecordKey(record)))
    .filter((item): item is OutboxImportItem => item !== undefined)
    .filter((item, index, all) => all.indexOf(item) === index);
  const count = (status: OutboxImportStatus) => list.filter((item) => item.status === status).length;
  return {
    results: list,
    importedCount: count("imported"),
    alreadyCount: count("already"),
    refusedCount: count("refused"),
  };
}

type Outcome = { ok: true; reason: string } | { ok: false; reason: string };

/** 採否・自分で直した文の結果（`authorFinding` は自分で直した文のときだけ） */
type DecisionOutcome =
  | {
      ok: true;
      reason: string;
      decision: { findingId: string; status: FindingStatus; note: string };
      verdict?: VerdictLine;
      authorFinding?: Finding;
    }
  | { ok: false; reason: string };

/**
 * 送ったときの本文と同じか。比べる相手は**取り込みを始めたときの**値——同じ話へ
 * 2件目を入れるとき、1件目で変わった値と比べて断らないようにする。
 * `baseHash`（保管庫の道）か `baseBlobSha`（GitHub 経由の道）のどちらかが合えばよい
 */
function sameBaseAsSent(record: OutboxRecord, state: FileState): boolean {
  if (record.baseHash && record.baseHash === state.startHash) return true;
  if (record.baseBlobSha && state.startBlobShas.has(record.baseBlobSha.toLowerCase())) return true;
  return false;
}

type BodyOutcome =
  | { ok: true; reason: string; blobSha: string }
  | { ok: false; reason: string; currentBlobSha?: string };

/**
 * 原稿エディターのページ（設計書6.116）で書いた、話の本文の全体を入れる。
 *
 * - **持ち主の記録だけ**（採否と同じ）。書いてよいのは本文のファイルだけ（`stateOf`）
 * - **いまの本文が、送ったときに読んだ本文と同じときだけ**入れる（blob SHA。続きの印
 *   `basedOn` があれば、その記録を入れたあとの本文とも比べる）。比べる相手は
 *   **いまの本文**——同じ回で先に入れた本文を、古い本文から別に書いた本文で消さない
 * - 違えば入れずに、どこから違うかと、いまの本文の blob SHA を返す（ページが違いを並べる）
 * - 書き戻しは呼び手の `writeBody`（製品は `writeTextFilePreservingFormat`）。全文の
 *   置き換えでも、文字コード・改行を保ち、変わった所だけをバイト列へ当てる
 * - 競合の印を含む本文（いまの本文・送った本文のどちらでも）には書かない
 */
async function importBody(record: OutboxRecord, context: Context): Promise<BodyOutcome> {
  if (!context.isOwner(record.writer)) {
    return { ok: false, reason: "持ち主でない人の本文は入れません。" };
  }
  if (!record.episode) return { ok: false, reason: "どの話の本文か分かりません（episode がありません）。" };
  // ページの欄から CRLF・BOM 付きで届いても、本文の空間（LF）にそろえる。書き戻しで元の形へ戻す
  const text = toLf((record.text ?? "").replace(/^﻿/, ""));
  if (!text.trim()) return { ok: false, reason: "送られた本文が空です（話がまるごと消えるため、入れませんでした）。" };
  if (hasConflictMarkers(text)) {
    return { ok: false, reason: "送られた本文に Git の競合の印（<<<<<<< など）があるため、入れませんでした。" };
  }

  const state = await context.stateOf(record.episode);
  if (state instanceof Error) return { ok: false, reason: state.message };
  const lock = lockOf(context.locks, state.relative);
  if (lock && lock.holderKind === "editor") {
    return { ok: false, reason: `${describeLock(lock)} 校閲が終わってから送り直してください。` };
  }

  const base = record.baseBlobSha?.toLowerCase();
  const chained = record.basedOn
    ? context.bodyShas.get(outboxRecordKey({ writer: record.writer, id: record.basedOn }))
    : undefined;
  const same =
    (base !== undefined && state.currentBlobShas.has(base)) ||
    (record.baseHash !== undefined && record.baseHash === state.content.hash) ||
    (chained !== undefined && state.currentBlobShas.has(chained));
  if (!same) {
    return {
      ok: false,
      reason: `${BODY_CHANGED_REASON}${describeBodyDifference(state.content.text, text)}`,
      currentBlobSha: state.currentBlobSha,
    };
  }

  if (text === state.content.text) {
    return {
      ok: true,
      reason: `${toSlash(state.relative)} は、送られた本文と同じでした（書き換えはありません）。`,
      blobSha: state.currentBlobSha,
    };
  }
  const written = await context.io.writeBody(state.relative, text, state.content);
  if (!written.ok) {
    return {
      ok: false,
      reason: written.changed ? BODY_CHANGED_REASON : written.reason,
      currentBlobSha: state.currentBlobSha,
    };
  }
  await context.reread(state);
  return {
    ok: true,
    reason: `${toSlash(state.relative)} を、出先で書いた本文にしました（${describeBodyChange(text)}）。`,
    blobSha: state.currentBlobSha,
  };
}

/**
 * パソコンの本文と送られた本文の、最初に違う行（作者が違いを探す手がかり）。
 * 送ったときの本文はパソコンに無いので、いまの本文と送られた本文を比べる
 */
export function describeBodyDifference(current: string, sent: string): string {
  const a = current.split("\n");
  const b = sent.split("\n");
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at += 1;
  const lines = (list: string[]) => (list[list.length - 1] === "" ? list.length - 1 : list.length);
  return `パソコンの本文と送られた本文は、${at + 1}行目から違います（パソコン ${lines(a)}行・送られた本文 ${lines(b)}行）。`;
}

function describeBodyChange(text: string): string {
  const lines = text.split("\n");
  return `${lines[lines.length - 1] === "" ? lines.length - 1 : lines.length}行`;
}

function timeOf(record: OutboxRecord): number {
  const time = Date.parse(record.at ?? "");
  return Number.isNaN(time) ? -Infinity : time;
}

async function importMemo(record: OutboxRecord, context: Context): Promise<Outcome> {
  const text = singleLine(record.text ?? "");
  if (!text) return { ok: false, reason: "メモが空です。" };

  const view = record.findingId ? context.views.get(record.findingId) : undefined;
  if (record.findingId && !view) {
    return { ok: false, reason: "メモを付けた指摘が、パソコンの置き場に見つかりません。" };
  }
  const file = view?.file ?? record.episode;
  if (!file) return { ok: false, reason: "どの話のメモか分かりません（episode がありません）。" };

  const state = await context.stateOf(file);
  if (state instanceof Error) return { ok: false, reason: state.message };
  // **送ったときの本文と違えば入れない**（6.115）
  if (!sameBaseAsSent(record, state)) {
    return { ok: false, reason: BODY_CHANGED_REASON };
  }

  const memoLine =
    MEMO_LINE_PREFIX + (context.isOwner(record.writer) ? "" : EDITORIAL_PREFIX) + text;
  const lines = state.content.text.split("\n");
  let where = "話の末尾";
  let at: number;
  const located = view
    ? findingPanelStateOf(view, state.content.text, context.retentionDays, context.now)
    : undefined;
  if (view && located && located.state === "pending") {
    // 指摘に付けたメモは、その指摘の行の上（6.115）
    at = located.line - 1;
    where = `${located.line}行目の上`;
  } else {
    // 末尾。本文が改行で終わっていれば、最後の空の要素の手前へ
    at = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
    if (view) where = "話の末尾（指摘の行が見つからなかったため）";
  }
  lines.splice(at, 0, memoLine);

  const written = await context.io.writeBody(state.relative, lines.join("\n"), state.content);
  if (!written.ok) {
    return { ok: false, reason: written.changed ? BODY_CHANGED_REASON : written.reason };
  }
  await context.reread(state);
  return { ok: true, reason: `メモを ${toSlash(file)} の${where}へ入れました。` };
}

async function importVerdict(record: OutboxRecord, context: Context): Promise<DecisionOutcome> {
  /*
    **採否は持ち主の記録だけ**（6.115）。2026-10-01 の「外から採否を決める道は
    作らない」の線引きは、決めているのが作者本人なので越えない——外の道具は運ぶだけ
  */
  // 書き手は**パスから**読んだもの（`by` の欄は誰でも書けるので見ない）
  if (!context.isOwner(record.writer)) {
    return { ok: false, reason: "持ち主でない人の採否は入れません（編集部の意見はメモで書いてください）。" };
  }
  if (!record.verdict) return { ok: false, reason: "採否（fix・done・reject）がありません。" };
  if (!record.findingId) return { ok: false, reason: "どの指摘への採否か分かりません（findingId がありません）。" };
  const view = context.views.get(record.findingId);
  if (!view) return { ok: false, reason: "その指摘が、パソコンの置き場に見つかりません。" };

  const state = await context.stateOf(view.file);
  const text = state instanceof Error ? undefined : state.content.text;
  const { state: panelState, line } = findingPanelStateOf(view, text, context.retentionDays, context.now);
  if (panelState !== "pending") {
    return {
      ok: false,
      reason: `この指摘はもう提案パネルに並んでいません（${FINDING_PANEL_STATE_LABELS[panelState]}）。`,
    };
  }

  const verdictOf = (status: VerdictStatus): VerdictLine | undefined => producerVerdict(view, status, context.now);

  if (record.verdict === "reject") {
    return {
      ok: true,
      reason: "採らない、として記録しました。",
      decision: { findingId: view.id, status: "dismissed", note: OUTBOX_DECISION_NOTES.reject },
      verdict: verdictOf("dismissed"),
    };
  }
  if (record.verdict === "done") {
    // 作者が自分で直して片付けた。提案パネルの「解消」と同じく、採った側に数える（6.49.7）
    return {
      ok: true,
      reason: "済み、として記録しました（本文には触れていません）。",
      decision: { findingId: view.id, status: "accepted", note: OUTBOX_DECISION_NOTES.done },
      verdict: verdictOf("accepted"),
    };
  }

  // ［直す］——提案パネルの［適用］と同じ計算で、いまの位置へ当てる
  if (!findingAppliesDirectly(view)) {
    return { ok: false, reason: "この指摘には修正案が無いため、［直す］では当てられません。" };
  }
  if (state instanceof Error) return { ok: false, reason: state.message };
  const lock = lockOf(context.locks, view.file);
  if (lock && lock.holderKind === "editor") {
    // パネルは確認の窓を出すが、外からは確かめられないので断る
    return { ok: false, reason: `${describeLock(lock)} 校閲が終わってから、提案パネルで当ててください。` };
  }
  const applied = applyFindingToText(state.content.text, {
    line,
    original: view.original,
    target: view.target,
    suggestion: view.suggestion,
  });
  if (applied.kind !== "applied") {
    return { ok: false, reason: "本文が変更されているため、この指摘の位置を特定できませんでした。" };
  }
  const written = await context.io.writeBody(state.relative, applied.text, state.content);
  if (!written.ok) return { ok: false, reason: written.changed ? BODY_CHANGED_REASON : written.reason };
  await context.reread(state);
  return {
    ok: true,
    reason: `${toSlash(view.file)} の${line}行目「${view.target}」を「${view.suggestion}」に直しました。`,
    decision: { findingId: view.id, status: "accepted", note: OUTBOX_DECISION_NOTES.fix },
    verdict: verdictOf("accepted"),
  };
}

/**
 * ［自分で直す］——作者が出先で書いた文を、指摘の原文の一文と置き換える
 * （作者の裁定 2026-10-04「取り込みでそのまま当てる」）。
 *
 * - **入れるのは、原文の一文がいまの本文に一字違わず1か所だけあるときだけ。**
 *   無ければ（パソコンで書き換えた）・2か所以上あれば（どれか決められない）断る。
 *   ［直す］と同じく `baseHash` では止めない——一字違わぬ照合がその代わりになる
 * - **範囲の直し**（`original` が複数行。作者の報告 2026-10-04）：範囲の全行が一字違わず
 *   1か所、行の頭から行の終わりまであり、指摘の原文を含むときだけ、範囲をまるごと作者の文
 *   （改行を含んでよい）に置き換える
 * - 当てる計算は［直す］・提案パネルの［適用］と同じ `applyFindingToText`
 *   （原文の全体を「直す語」、作者の文を「直したあと」として渡す）
 * - 記録は2つ。元の指摘には「採った」（［済み］と同じく採った側に数える）、
 *   **作者の文の置き換えを1件の指摘の行として足し、それにも「採った」**。
 *   提案パネルの［戻す］（`locateAppliedSuggestion`）は行の原文・直す語・
 *   直したあとから戻す位置を決めるので、AI の指摘の行のままでは戻せない
 */
async function importEdit(record: OutboxRecord, context: Context): Promise<DecisionOutcome> {
  // 採否と同じく、持ち主の記録だけ（書き手はパスから読んだもの）
  if (!context.isOwner(record.writer)) {
    return { ok: false, reason: "持ち主でない人の直しは入れません（編集部の意見はメモで書いてください）。" };
  }
  if (!record.findingId) return { ok: false, reason: "どの指摘への直しか分かりません（findingId がありません）。" };
  /*
    本文は LF の空間で持つ（`decodeBytes`）。ページの欄から CRLF で届いても、ここで LF に
    揃えて比べ、書き戻しで本文の改行の形へ戻す
  */
  const text = toLf(record.text ?? "");
  const original = toLf(record.original ?? "");
  /*
    **範囲の直し**（作者の報告 2026-10-04）：原文が複数行なら、ページが送った範囲の全行。
    改行を含む直し（行を足す・減らす）を許す。1行の直しは今までどおり行の中だけ
  */
  const block = original.includes("\n");
  if (!text.trim()) return { ok: false, reason: "直した文が空です。" };
  // 1行の直しは行の中の置き換えだけを入れる（提案パネルの［戻す］も行の中で戻す）
  if (!block && text.includes("\n")) {
    return { ok: false, reason: "直した文に改行が入っています。1行の中の直しだけを入れられます。" };
  }
  const view = context.views.get(record.findingId);
  if (!view) return { ok: false, reason: "その指摘が、パソコンの置き場に見つかりません。" };
  if (block) {
    /*
      **範囲は、その指摘の原文を含んでいること。** 指摘と関係のない範囲の置き換えを、
      この道から入れさせない（ページは指摘の行を含む範囲だけを送る）
    */
    if (!original.includes(view.original)) {
      return {
        ok: false,
        reason: "出先に出ていた範囲に、指摘の原文が入っていません（この指摘への直しとしては入れられません）。",
      };
    }
  } else if (original !== view.original) {
    /*
      **作者が直した元の文と、置き場の原文が同じであること。** 送るときに長い原文は
      切っているので、切れた文を直した記録で全文を置き換えると末尾が消える
    */
    return {
      ok: false,
      reason: "出先に出ていた原文が、パソコンの置き場の原文と違います（長い原文は切って送るため、出先では直せません）。",
    };
  }
  if (text === original) return { ok: false, reason: "直した文が元の文と同じです。" };

  const what = block ? "範囲の文" : "原文の一文";
  const state = await context.stateOf(view.file);
  if (state instanceof Error) return { ok: false, reason: state.message };
  const before = state.content.text;
  const found = occurrences(before, original);
  if (found.length === 0) {
    return {
      ok: false,
      reason: `${what}が、パソコンの本文に見つかりません（送ったあとに書き換えられたため、入れませんでした）。`,
    };
  }
  if (found.length > 1) {
    return {
      ok: false,
      reason: `${what}が、パソコンの本文に2か所以上あります（どこを直すか決められないため、入れませんでした）。`,
    };
  }
  const at = found[0];
  const end = at + original.length;
  /*
    **範囲は行の頭から行の終わりまで。** ページは行の単位で送るので、行の途中で
    当たったなら、それは送った範囲ではない（別の行の一部にたまたま一致した）
  */
  if (block && ((at > 0 && before[at - 1] !== "\n") || (end < before.length && before[end] !== "\n"))) {
    return {
      ok: false,
      reason: "範囲の文が、パソコンの本文では行の途中から始まるか、行の途中で終わっています（入れませんでした）。",
    };
  }
  const lock = lockOf(context.locks, view.file);
  if (lock && lock.holderKind === "editor") {
    return { ok: false, reason: `${describeLock(lock)} 校閲が終わってから直してください。` };
  }
  const panelState = findingPanelStateOf(view, before, context.retentionDays, context.now).state;
  if (panelState !== "pending") {
    return {
      ok: false,
      reason: `この指摘はもう提案パネルに並んでいません（${FINDING_PANEL_STATE_LABELS[panelState]}）。`,
    };
  }

  const line = before.slice(0, at).split("\n").length;
  let next: string;
  if (block) {
    // 範囲の全行を作者の文へ。行の数は変わってよい（文を足す・減らす）
    next = before.slice(0, at) + text + before.slice(end);
  } else {
    const applied = applyFindingToText(before, {
      line,
      original: view.original,
      target: view.original,
      suggestion: text,
    });
    if (applied.kind !== "applied") {
      // 原文が行をまたぐ（改行を含む）ときはここへ来る。当て推量で置かない
      return { ok: false, reason: "原文の一文が1行に収まっていないため、入れられませんでした。" };
    }
    next = applied.text;
  }
  const written = await context.io.writeBody(state.relative, next, state.content);
  if (!written.ok) return { ok: false, reason: written.changed ? BODY_CHANGED_REASON : written.reason };
  await context.reread(state);

  const lines = before.split("\n");
  const lastLine = line + original.split("\n").length - 1;
  /*
    足す指摘の行は、置き換えた文の全体（範囲なら範囲の全行）を原文・直す語に持つ。
    提案パネルの［戻す］（`locateAppliedSuggestion`）は行の中で戻すので、**作者の文が
    1行に収まれば**範囲の直しも戻せる。作者の文が複数行だと「当てたもの」に並ばない
    （戻す位置を行で探せない）——そのときは回復先（`.novelai-recovery`）に直前の本文が残る
  */
  const authorFinding: Finding = {
    id: findingId(view.file, original, original, text, view.category, view.label),
    time: context.now.toISOString(),
    file: view.file,
    hintLine: line,
    original,
    target: original,
    suggestion: text,
    before: neighborLine(lines, line, -1),
    after: neighborLine(lines, lastLine, +1),
    message: view.message ? `${AUTHOR_EDIT_NOTE}（元の指摘：${view.message}）` : AUTHOR_EDIT_NOTE,
    category: view.category,
    label: view.label,
    // producer は持たせない——作者の文を AI の手柄として数えないため
  };

  return {
    ok: true,
    reason: block
      ? `${toSlash(view.file)} の${line}〜${lastLine}行目を、出先で書いた文に置き換えました。`
      : `${toSlash(view.file)} の${line}行目の一文を、出先で書いた文に置き換えました。`,
    // 元の指摘は［済み］と同じく「採った」（作者が問題を認めて自分で直した。6.49.7）
    decision: { findingId: view.id, status: "accepted", note: OUTBOX_DECISION_NOTES.editOriginal },
    verdict: producerVerdict(view, "accepted", context.now),
    authorFinding,
  };
}

/* ── 小さな部品 ──────────────────────────────────────── */

/** 出したAIが分かる指摘だけ、採否の数（6.49.7）に1行足す */
function producerVerdict(view: FindingView, status: VerdictStatus, now: Date): VerdictLine | undefined {
  const feature = verdictFeatureOf(findingRestoreOf(view)?.panelCategory ?? "");
  return view.producer && feature
    ? {
        time: now.toISOString(),
        subject: view.id,
        providerId: view.producer.providerId,
        model: view.producer.model,
        feature,
        status,
      }
    : undefined;
}

function readLocks(text: string | undefined): Locks {
  if (!text) return new Map();
  try {
    return resolveLocks(parseLockEvents(text));
  } catch {
    return new Map();
  }
}

/** 本文の中の出現位置をすべて拾う（重なる並びも取りこぼさない） */
function occurrences(text: string, needle: string): number[] {
  const found: number[] = [];
  if (!needle) return found;
  for (let from = text.indexOf(needle); from !== -1; from = text.indexOf(needle, from + 1)) {
    found.push(from);
  }
  return found;
}

/**
 * その行の前（-1）か後ろ（+1）の、中身のある1行。足した指摘の行を、開き直したときに
 * 探し直す手がかり（`core/findingSource.ts` の `neighborOf` と同じ考え方）
 */
function neighborLine(lines: readonly string[], line: number, step: -1 | 1): string {
  for (let at = line - 1 + step; at >= 0 && at < lines.length; at += step) {
    if (lines[at].trim().length > 0) return lines[at];
  }
  return "";
}

/** メモは1行にする（改行を含むと2行目からが本文になる） */
function singleLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

/** 改行を LF にそろえる（本文を持つ空間。`core/eolSpace.ts` と同じ考え方） */
function toLf(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function toSlash(file: string): string {
  return file.split("\\").join("/");
}

/** JSON の追記の中身（前の中身が改行で終わっていなければ、先に改行を足す） */
export function jsonLinesAddition(existing: Uint8Array, values: readonly object[]): string {
  const needsBreak = existing.length > 0 && existing[existing.length - 1] !== 0x0a;
  const lines = values.map((value) => JSON.stringify(value)).join("\n");
  return `${needsBreak ? "\n" : ""}${lines}\n`;
}
