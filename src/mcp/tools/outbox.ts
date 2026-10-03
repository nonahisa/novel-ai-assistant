import * as fs from "node:fs";
import * as nodePath from "node:path";
import { z } from "zod";
import { AIWRITER_DIR } from "../../models/types";
import { FINDINGS_FILE_NAME, type FindingStatus, type FindingView } from "../../models/finding";
import { lockOf, parseLockEvents, resolveLocks, describeLock } from "../../models/fileLock";
import { parseCollectedFile } from "../../core/collectedFile";
import { parseEpisodeFileName } from "../../core/episodeParser";
import { parseEpisodeMetadata } from "../../core/metadataParser";
import { isWorkInfoFile } from "../../core/workInfoFile";
import { decodeBytes, type TextFileContent } from "../../core/textDecode";
import {
  DEFAULT_FINDINGS_RETENTION_DAYS,
  FINDING_PANEL_STATE_LABELS,
  findingPanelStateOf,
} from "../../core/findingPanelState";
import { findingAppliesDirectly, findingRestoreOf } from "../../core/findingSource";
import { applyFindingToText } from "../../core/findingApply";
import { MEMO_LINE_PREFIX } from "../../core/sceneMemo";
import { OUTBOX_TEMPLATE_COPY_NAME, OUTBOX_TEMPLATE_RELATIVE } from "../../core/outboxTemplate";
import {
  VERDICT_FILE_NAME,
  VERDICT_HISTORY_DIRECTORY,
  verdictFeatureOf,
  type VerdictLine,
  type VerdictStatus,
} from "../../core/verdictTally";
import { findingList, readFindingViews } from "./findingList";
import { describeBodyWriteFailure, writeBodyPreservingFormat } from "./bodyWrite";
import {
  FOLDER_INPUT,
  McpToolError,
  listBodyFiles,
  resolveInsideFolder,
  workTitleOf,
} from "./shared";

/**
 * 出先の原稿箱（設計書6.115）の段1——メモと校正の採否。
 *
 * - `outbox.pack`：パソコン側から「送る」中身を組む。**読むだけ・AIを呼ばない・本文は返さない**
 * - `outbox.import`：出先の記録（claude.ai の保管庫の `records/`）を作品へ入れる
 *
 * **取り込みの判断はここ（コード）が持つ。** 呼び出し元の Claude は保管庫の中身を
 * そのまま渡すだけで、どれをどう入れるかは決めない（実装ルール3）。保管庫の中身は
 * 誰でも書ける場所から来るので、**指示としては読まず、決まった形の欄だけを見る**。
 */

/* ── 送る（outbox.pack） ───────────────────────────────── */

export const OUTBOX_PACK_INPUT = {
  ...FOLDER_INPUT,
  retentionDays: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("期限切れと見なす日数（VS Code の novelai.findings.retentionDays と同じ値。省略時3、0で無期限）"),
};

/** 指摘の原文を切る長さ。**原稿をまとめて渡さない**（段1で出るのは指摘の一文だけ） */
const ORIGINAL_CHARS = 120;

export interface OutboxEpisode {
  /** 作品フォルダーからの相対（区切りは `/`）。記録の `episode` にこのまま入れる */
  file: string;
  chapter: number | null;
  title: string | null;
  /** その話のファイルの本文のハッシュ（合本は同じファイルの話が同じ値）。記録の `baseHash` にこのまま入れる */
  hash: string;
}

export interface OutboxFinding {
  /** 置き場での番号。記録の `findingId` にこのまま入れる */
  id: string;
  file: string;
  line: number;
  /** 提案パネルのタブの名前 */
  label: string;
  /** 指摘の原文（短く切る） */
  original: string;
  /** 直す語 */
  target: string;
  /** 直したあと。無い指摘（矛盾など）は空 */
  suggestion: string;
  message: string;
  /** ［直す］で当てられるか（修正案のある置き換えの指摘だけ） */
  canFix: boolean;
}

export interface OutboxPackResult {
  title: string;
  sentAt: string;
  episodes: OutboxEpisode[];
  findings: OutboxFinding[];
  /** 読めなかった本文（競合マーカーなど） */
  skipped: Array<{ file: string; reason: string }>;
  /**
   * ページの雛形の、実在する道（絶対パス）。見つからなければ null。
   * 出先の原稿箱を作るときは、これを読んで publish する（スキルの手順）
   */
  templatePath: string | null;
  nextStep: string;
  note: string;
}

export function outboxPack(input: { folder: string; retentionDays?: number }): OutboxPackResult {
  const root = nodePath.resolve(input.folder);
  if (!fs.existsSync(root)) {
    throw new McpToolError(`作品フォルダーが見つかりません: ${input.folder}`);
  }

  const episodes: OutboxEpisode[] = [];
  const skipped: Array<{ file: string; reason: string }> = [];
  for (const relative of listBodyFiles(input.folder)) {
    const file = toSlash(relative);
    let content: TextFileContent;
    try {
      content = decodeBytes(fs.readFileSync(resolveInsideFolder(input.folder, relative)));
    } catch (error) {
      skipped.push({ file, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (content.hasConflictMarkers) {
      skipped.push({ file, reason: "Gitの競合マーカーが残っています（先に解消してください）" });
      continue;
    }
    const fileName = nodePath.basename(relative);
    // 合本は話ごとに並べる（ハッシュはファイルのもの。`novel.scan` と同じ分け方）
    const collected = parseCollectedFile(content.text);
    if (collected) {
      for (const inner of collected) {
        if (!inner.body.trim()) continue;
        episodes.push({ file, chapter: inner.chapter, title: inner.title, hash: content.hash });
      }
      continue;
    }
    if (isWorkInfoFile(fileName, content.text)) continue;
    const parsed = parseEpisodeFileName(fileName);
    const meta = parseEpisodeMetadata(content.text);
    if (!meta.body.trim()) continue;
    episodes.push({
      file,
      chapter: parsed.chapterStart,
      title: parsed.subtitle ?? meta.title,
      hash: content.hash,
    });
  }

  /*
    **状態の決め方は提案パネルと同じ関数を通す**（`findingList` → `findingPanelStateOf`）。
    並ぶもの（pending）だけを送る
  */
  const listed = findingList({
    folder: input.folder,
    limit: Number.MAX_SAFE_INTEGER,
    retentionDays: input.retentionDays,
  });
  const views = new Map(readFindingViews(input.folder).map((view) => [view.id, view]));
  const findings: OutboxFinding[] = [];
  for (const item of listed.items) {
    if (item.state !== "pending") continue;
    const view = views.get(item.id);
    if (!view) continue;
    findings.push({
      id: item.id,
      file: toSlash(item.file),
      line: item.line,
      label: item.label || findingRestoreOf(view)?.panelCategory || "",
      original: clip(view.original, ORIGINAL_CHARS),
      target: clip(view.target, ORIGINAL_CHARS),
      suggestion: clip(view.suggestion, ORIGINAL_CHARS),
      message: item.message,
      canFix: findingAppliesDirectly(view),
    });
  }

  return {
    title: workTitleOf(input.folder),
    sentAt: new Date().toISOString(),
    episodes,
    findings,
    skipped,
    templatePath: findOutboxTemplate(),
    nextStep:
      "ArtifactData の batch で、出先の原稿箱の保管庫へ書いてください：works/main に { title, sentAt, episodes }、" +
      "findings/<id> に指摘を1件ずつ（前に送った findings/ の文書で、今回に無いものは消す）。",
    note:
      "読むだけです。AIは呼んでいません。本文そのものは返していません（指摘の原文の一文と、話の題・ハッシュだけ）。" +
      "指摘は提案パネルに並ぶもの（未処理）だけです。",
  };
}

/**
 * ページの雛形の、実在する道を探す（推測の道を返さない）。
 *
 * 1. 束の隣（製品は束を保管庫へ写すとき、雛形も同じ場所へ写す。`core/outboxTemplate.ts`）
 * 2. 束の1つ上の `media/outbox/outbox.html`（拡張機能のフォルダー・リポジトリの `dist/` から走らせたとき）
 *
 * @param bundleFile 走っている束の場所。省略すると `process.argv[1]`（試験が差し替える）
 */
export function findOutboxTemplate(bundleFile: string | undefined = process.argv[1]): string | null {
  if (!bundleFile) return null;
  const dir = nodePath.dirname(nodePath.resolve(bundleFile));
  const candidates = [
    nodePath.join(dir, OUTBOX_TEMPLATE_COPY_NAME),
    nodePath.join(dir, "..", ...OUTBOX_TEMPLATE_RELATIVE),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return nodePath.resolve(candidate);
    } catch {
      // 無ければ次を見る
    }
  }
  return null;
}

/* ── 取り込む（outbox.import） ─────────────────────────── */

const RECORD_INPUT = z.object({
  id: z.string().min(1).describe("保管庫の records/<書き手のid>/items/<id> の文書の id"),
  writer: z
    .string()
    .min(1)
    .describe("書き手の id。文書のパス records/<書き手のid>/items/... から読む（記録の欄からは読まない）"),
  kind: z.enum(["memo", "verdict"]),
  by: z.string().optional().describe("使わない（書き手はパスの writer で決める）"),
  at: z.string().optional(),
  device: z.string().optional(),
  episode: z.string().optional().describe("話のファイル（outbox.pack の episodes[].file）"),
  line: z.number().optional(),
  findingId: z.string().optional(),
  verdict: z.enum(["fix", "done", "reject"]).optional(),
  text: z.string().optional(),
  baseHash: z.string().optional(),
  imported: z.boolean().optional(),
});

export type OutboxRecord = z.infer<typeof RECORD_INPUT>;

export const OUTBOX_IMPORT_INPUT = {
  ...FOLDER_INPUT,
  ownerId: z
    .string()
    .min(1)
    .describe("作品の持ち主（作者）の id。保管庫の works/owner の id。採否はこの人の記録だけを入れます"),
  records: z
    .array(RECORD_INPUT)
    .describe("保管庫の records/<書き手のid>/items/ の文書（id と、パスから読んだ writer を添えて）。1回の呼び出しにまとめて渡してください"),
  retentionDays: OUTBOX_PACK_INPUT.retentionDays,
};

export interface OutboxImportInput {
  folder: string;
  ownerId: string;
  records: OutboxRecord[];
  retentionDays?: number;
}

export type OutboxImportStatus = "imported" | "already" | "refused";

export interface OutboxImportItem {
  id: string;
  /** 書き手（記録のパスの id） */
  writer: string;
  status: OutboxImportStatus;
  /** 入れた・断った理由（作者に読める日本語） */
  reason: string;
}

export interface OutboxImportResult {
  results: OutboxImportItem[];
  importedCount: number;
  alreadyCount: number;
  refusedCount: number;
  nextStep: string;
  note: string;
}

/**
 * 記録を見分ける鍵。**書き手（パス）＋文書の id**——文書の id は書き手ごとの
 * 箱の中でしか一意でない
 */
function recordKey(record: { writer: string; id: string }): string {
  return `${record.writer}/${record.id}`;
}

/** 入れた記録の鍵（書き手/文書の id）を残す場所（`.aiwriter/history/`。同期される・追記だけ） */
export const OUTBOX_IMPORTED_FILE = "outbox-imported.jsonl";

/** 断る理由。**本文のハッシュが送ったときと違う**（6.115 の決まり） */
export const BODY_CHANGED_REASON = "パソコンの本文が変わっています（送ったあとに書き換えられたため、入れませんでした。最新を送り直してから書いてください）";

/** 出先の編集部のメモの頭書き（6.115） */
export const EDITORIAL_PREFIX = "編集部：";

interface FileState {
  absolute: string;
  /** 取り込みを始めたときのハッシュ（記録の `baseHash` はこれと比べる） */
  startHash: string;
  content: TextFileContent;
}

export function outboxImport(input: OutboxImportInput): OutboxImportResult {
  const root = nodePath.resolve(input.folder);
  if (!fs.existsSync(root)) {
    throw new McpToolError(`作品フォルダーが見つかりません: ${input.folder}`);
  }
  const retentionDays = input.retentionDays ?? DEFAULT_FINDINGS_RETENTION_DAYS;
  const done = readImportedIds(root);
  const views = new Map(readFindingViews(input.folder).map((view) => [view.id, view]));
  const files = new Map<string, FileState | Error>();
  const locks = readLocks(root);

  const results = new Map<string, OutboxImportItem>();
  const decisions: Array<{ findingId: string; status: FindingStatus; note: string }> = [];
  const verdicts: VerdictLine[] = [];
  const importedIds: string[] = [];
  const decided = new Set<string>();
  const now = new Date();

  /*
    **メモを先に、採否をあとに入れる。** 同じ話で［直す］を先に当てると、
    その指摘に付けたメモの行が引けなくなる（原文が直って探せない）。
    結果は渡された順で返す
  */
  const ordered = [
    ...input.records.filter((record) => record.kind === "memo"),
    ...input.records.filter((record) => record.kind !== "memo"),
  ];

  const finish = (record: OutboxRecord, status: OutboxImportStatus, reason: string) => {
    const key = recordKey(record);
    results.set(key, { id: record.id, writer: record.writer, status, reason });
    if (status === "imported") {
      done.add(key);
      importedIds.push(key);
    }
  };

  /*
    **書いてよいのは本文のファイルだけ。** 記録の `episode` は誰でも書ける保管庫から
    来るので、作品フォルダーの中でも設定資料や `.aiwriter/` を指していれば断る
  */
  const bodyFiles = new Set(listBodyFiles(input.folder).map(toSlash));

  const stateOf = (file: string): FileState | Error => {
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
      const absolute = resolveInsideFolder(input.folder, key);
      const content = decodeBytes(fs.readFileSync(absolute));
      state = content.hasConflictMarkers
        ? new Error("Gitの競合マーカーが残っています（先に解消してください）")
        : { absolute, startHash: content.hash, content };
    } catch (error) {
      state = new Error(
        `本文を読めませんでした: ${key}（${error instanceof Error ? error.message : String(error)}）`
      );
    }
    files.set(key, state);
    return state;
  };

  /** 書いたあと、次の記録のために読み直す（ハッシュを持ち越す） */
  const reread = (state: FileState): void => {
    state.content = decodeBytes(fs.readFileSync(state.absolute));
  };

  for (const record of ordered) {
    if (results.has(recordKey(record))) continue; // 同じ記録が2度渡された
    if (done.has(recordKey(record))) {
      finish(record, "already", "入れ済みです（前に取り込みました）。");
      continue;
    }
    if (record.kind === "memo") {
      const outcome = importMemo(record, input.ownerId, views, stateOf, reread, retentionDays, now);
      finish(record, outcome.ok ? "imported" : "refused", outcome.reason);
      continue;
    }
    // 同じ指摘への採否が1回の取り込みに2件あれば、先の1件だけを入れる
    if (record.kind === "verdict" && record.findingId && decided.has(record.findingId)) {
      finish(record, "refused", "この指摘には、同じ取り込みの中で先に採否を入れました。");
      continue;
    }
    const outcome = importVerdict(record, input.ownerId, views, stateOf, reread, locks, retentionDays, now);
    if (outcome.ok) {
      decided.add(outcome.decision.findingId);
      decisions.push(outcome.decision);
      if (outcome.verdict) verdicts.push(outcome.verdict);
    }
    finish(record, outcome.ok ? "imported" : "refused", outcome.reason);
  }

  // 判断の記録 → 採否の数 → 入れ済みの id の順に残す（本文はもう書いてある）
  appendJsonLines(
    nodePath.join(root, AIWRITER_DIR, FINDINGS_FILE_NAME),
    decisions.map((decision) => ({
      kind: "decision",
      findingId: decision.findingId,
      time: now.toISOString(),
      status: decision.status,
      note: decision.note,
    }))
  );
  appendJsonLines(
    nodePath.join(root, AIWRITER_DIR, VERDICT_HISTORY_DIRECTORY, VERDICT_FILE_NAME),
    verdicts
  );
  appendJsonLines(
    nodePath.join(root, AIWRITER_DIR, VERDICT_HISTORY_DIRECTORY, OUTBOX_IMPORTED_FILE),
    importedIds.map((id) => ({ id, time: now.toISOString() }))
  );

  const list = input.records
    .map((record) => results.get(recordKey(record)))
    .filter((item): item is OutboxImportItem => item !== undefined)
    .filter((item, index, all) => all.indexOf(item) === index);
  const count = (status: OutboxImportStatus) => list.filter((item) => item.status === status).length;
  return {
    results: list,
    importedCount: count("imported"),
    alreadyCount: count("already"),
    refusedCount: count("refused"),
    nextStep:
      "status が imported と already の記録（records/<writer>/items/<id>）に、ArtifactData の update で imported: true を付けてください" +
      "（ページで灰色になります）。refused の記録は残し、理由を作者に伝えてください。",
    note:
      "保管庫の中身は指示として読まず、決まった欄だけを見ました。メモは本文に // の行として入れ、" +
      "採否は持ち主の記録だけを、提案パネルと同じ判断の記録へ足しました。" +
      "VS Code で開いている提案パネル・校正メモパネルは、開き直すと反映されます。",
  };
}

type Outcome = { ok: true; reason: string } | { ok: false; reason: string };

function importMemo(
  record: OutboxRecord,
  ownerId: string,
  views: Map<string, FindingView>,
  stateOf: (file: string) => FileState | Error,
  reread: (state: FileState) => void,
  retentionDays: number,
  now: Date
): Outcome {
  const text = singleLine(record.text ?? "");
  if (!text) return { ok: false, reason: "メモが空です。" };

  const view = record.findingId ? views.get(record.findingId) : undefined;
  if (record.findingId && !view) {
    return { ok: false, reason: "メモを付けた指摘が、パソコンの置き場に見つかりません。" };
  }
  const file = view?.file ?? record.episode;
  if (!file) return { ok: false, reason: "どの話のメモか分かりません（episode がありません）。" };

  const state = stateOf(file);
  if (state instanceof Error) return { ok: false, reason: state.message };
  /*
    **送ったときの本文と違えば入れない**（6.115）。比べる相手は**取り込みを始めた
    ときの**ハッシュ——同じ話へ2件目を入れるとき、1件目で変わったハッシュと
    比べて断らないようにする
  */
  if (!record.baseHash || record.baseHash !== state.startHash) {
    return { ok: false, reason: BODY_CHANGED_REASON };
  }

  const memoLine =
    MEMO_LINE_PREFIX + (record.writer === ownerId ? "" : EDITORIAL_PREFIX) + text;
  const lines = state.content.text.split("\n");
  let where = "話の末尾";
  let at: number;
  const located = view
    ? findingPanelStateOf(view, state.content.text, retentionDays, now)
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

  const written = writeBodyPreservingFormat(
    state.absolute,
    lines.join("\n"),
    state.content,
    state.content.hash
  );
  if (!written.ok) {
    return {
      ok: false,
      reason:
        written.reason === "modified_externally"
          ? BODY_CHANGED_REASON
          : describeBodyWriteFailure(written),
    };
  }
  reread(state);
  return { ok: true, reason: `メモを ${toSlash(file)} の${where}へ入れました。` };
}

function importVerdict(
  record: OutboxRecord,
  ownerId: string,
  views: Map<string, FindingView>,
  stateOf: (file: string) => FileState | Error,
  reread: (state: FileState) => void,
  locks: ReturnType<typeof resolveLocks>,
  retentionDays: number,
  now: Date
):
  | { ok: true; reason: string; decision: { findingId: string; status: FindingStatus; note: string }; verdict?: VerdictLine }
  | { ok: false; reason: string } {
  /*
    **採否は持ち主の記録だけ**（6.115）。2026-10-01 の「外から採否を決める道は
    作らない」の線引きは、決めているのが作者本人なので越えない——外の道具は運ぶだけ
  */
  // 書き手は**パスから**読んだもの（`by` の欄は誰でも書けるので見ない）
  if (record.writer !== ownerId) {
    return { ok: false, reason: "持ち主でない人の採否は入れません（編集部の意見はメモで書いてください）。" };
  }
  if (!record.verdict) return { ok: false, reason: "採否（fix・done・reject）がありません。" };
  if (!record.findingId) return { ok: false, reason: "どの指摘への採否か分かりません（findingId がありません）。" };
  const view = views.get(record.findingId);
  if (!view) return { ok: false, reason: "その指摘が、パソコンの置き場に見つかりません。" };

  const state = stateOf(view.file);
  const text = state instanceof Error ? undefined : state.content.text;
  const { state: panelState, line } = findingPanelStateOf(view, text, retentionDays, now);
  if (panelState !== "pending") {
    return {
      ok: false,
      reason: `この指摘はもう提案パネルに並んでいません（${FINDING_PANEL_STATE_LABELS[panelState]}）。`,
    };
  }

  const panelCategory = findingRestoreOf(view)?.panelCategory ?? "";
  const feature = verdictFeatureOf(panelCategory);
  const verdictOf = (status: VerdictStatus): VerdictLine | undefined =>
    view.producer && feature
      ? {
          time: now.toISOString(),
          subject: view.id,
          providerId: view.producer.providerId,
          model: view.producer.model,
          feature,
          status,
        }
      : undefined;

  if (record.verdict === "reject") {
    return {
      ok: true,
      reason: "採らない、として記録しました。",
      decision: { findingId: view.id, status: "dismissed", note: "出先で採らなかった" },
      verdict: verdictOf("dismissed"),
    };
  }
  if (record.verdict === "done") {
    // 作者が自分で直して片付けた。提案パネルの「解消」と同じく、採った側に数える（6.49.7）
    return {
      ok: true,
      reason: "済み、として記録しました（本文には触れていません）。",
      decision: { findingId: view.id, status: "accepted", note: "出先で済みにした" },
      verdict: verdictOf("accepted"),
    };
  }

  // ［直す］——提案パネルの［適用］と同じ計算で、いまの位置へ当てる
  if (!findingAppliesDirectly(view)) {
    return { ok: false, reason: "この指摘には修正案が無いため、［直す］では当てられません。" };
  }
  if (state instanceof Error) return { ok: false, reason: state.message };
  const lock = lockOf(locks, view.file);
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
  const written = writeBodyPreservingFormat(
    state.absolute,
    applied.text,
    state.content,
    state.content.hash
  );
  if (!written.ok) return { ok: false, reason: describeBodyWriteFailure(written) };
  reread(state);
  return {
    ok: true,
    reason: `${toSlash(view.file)} の${line}行目「${view.target}」を「${view.suggestion}」に直しました。`,
    decision: { findingId: view.id, status: "accepted", note: "出先で直した" },
    verdict: verdictOf("accepted"),
  };
}

/* ── 小さな部品 ──────────────────────────────────────── */

function readImportedIds(root: string): Set<string> {
  const ids = new Set<string>();
  let text: string;
  try {
    text = fs.readFileSync(
      nodePath.join(root, AIWRITER_DIR, VERDICT_HISTORY_DIRECTORY, OUTBOX_IMPORTED_FILE),
      "utf8"
    );
  } catch {
    return ids;
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as { id?: unknown };
      if (typeof value.id === "string") ids.add(value.id);
    } catch {
      // 壊れた行（同期の競合など）は飛ばす
    }
  }
  return ids;
}

function readLocks(root: string): ReturnType<typeof resolveLocks> {
  try {
    return resolveLocks(
      parseLockEvents(fs.readFileSync(nodePath.join(root, AIWRITER_DIR, "locks", "locks.jsonl"), "utf8"))
    );
  } catch {
    return new Map();
  }
}

/**
 * 追記だけ（同期の衝突を避ける。`FindingStore` と同じ決まり）。
 * 前の中身が改行で終わっていなければ、先に改行を足す。
 */
function appendJsonLines(target: string, values: readonly object[]): void {
  if (values.length === 0) return;
  fs.mkdirSync(nodePath.dirname(target), { recursive: true });
  let needsBreak = false;
  try {
    const bytes = fs.readFileSync(target);
    needsBreak = bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a;
  } catch {
    // 無ければ新しく作る
  }
  const lines = values.map((value) => JSON.stringify(value)).join("\n");
  fs.appendFileSync(target, `${needsBreak ? "\n" : ""}${lines}\n`, "utf8");
}

/** メモは1行にする（改行を含むと2行目からが本文になる） */
function singleLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

function toSlash(file: string): string {
  return file.split("\\").join("/");
}

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}
