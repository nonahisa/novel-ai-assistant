import * as fs from "node:fs";
import * as nodePath from "node:path";
import { z } from "zod";
import { parseCollectedFile } from "../../core/collectedFile";
import { parseEpisodeFileName } from "../../core/episodeParser";
import { parseEpisodeMetadata } from "../../core/metadataParser";
import { isWorkInfoFile } from "../../core/workInfoFile";
import { decodeBytes, type TextFileContent } from "../../core/textDecode";
import { findingAppliesDirectly, findingRestoreOf } from "../../core/findingSource";
import {
  EDITOR_TEMPLATE_COPY_NAME,
  EDITOR_TEMPLATE_RELATIVE,
  OUTBOX_TEMPLATE_COPY_NAME,
  OUTBOX_TEMPLATE_RELATIVE,
} from "../../core/outboxTemplate";
import {
  importOutboxRecords,
  jsonLinesAddition,
  type OutboxImportIo,
  type OutboxImportOutcome,
  type OutboxRecord,
} from "../../core/outboxImport";
import { OUTBOX_CONTEXT_CHARS, outboxContextOf, type OutboxContext } from "../../core/outboxContext";
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
 * - `outbox.pack`：パソコン側から「送る」中身を組む。**読むだけ・AIを呼ばない・本文の全体は返さない**
 *   （指摘ごとに前後の数行と範囲の行を、1指摘あたり `OUTBOX_CONTEXT_CHARS` 字まで）
 * - `outbox.import`：出先の記録（claude.ai の保管庫の `records/`）を作品へ入れる
 *
 * **取り込みの判断はここ（コード）が持つ。** 呼び出し元の Claude は保管庫の中身を
 * そのまま渡すだけで、どれをどう入れるかは決めない（実装ルール3）。保管庫の中身は
 * 誰でも書ける場所から来るので、**指示としては読まず、決まった形の欄だけを見る**。
 */

/* ── 送る（outbox.pack） ───────────────────────────────── */

// 前後の文の組み方は core に1つ（GitHub 経由のページが同じ形を写して作るので、見比べる相手を core に置く）
export { OUTBOX_CONTEXT_CHARS, type OutboxContext } from "../../core/outboxContext";

export const OUTBOX_PACK_INPUT = {
  ...FOLDER_INPUT,
  retentionDays: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("期限切れと見なす日数（VS Code の novelai.findings.retentionDays と同じ値。省略時3、0で無期限）"),
};

/** 指摘の原文を切る長さ。**原稿をまとめて渡さない**（前後の文は `context` に別の上限で入れる） */
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
  /**
   * 原文を切って送ったか。**切った原文は［自分で直す］に使えない**——作者が
   * 切れた文を直して送ると、取り込みが全文をそれで置き換えて末尾が消える。
   * ページはこれが true の指摘に［自分で直す］を出さない
   */
  originalClipped: boolean;
  /**
   * 指摘の前後の文と、範囲の指摘なら範囲の全行（作者の報告 2026-10-04「『た』が4文
   * 続いている場合などは、前後がわからないと修正できません」）。本文が読めなければ null
   */
  context: OutboxContext | null;
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
  /**
   * 出先の原稿エディター（設計書6.116）のページの雛形の、実在する道。見つからなければ null。
   * 原稿エディターのページを作るときは、これを読んで publish する（スキルの手順）
   */
  editorTemplatePath: string | null;
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
  /** 前後の文を取るための本文（競合マーカーのあるファイルは入れない＝前後を送らない） */
  const texts = new Map<string, string>();
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
    texts.set(file, content.text);
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
    const text = texts.get(toSlash(item.file));
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
      originalClipped: [...view.original].length > ORIGINAL_CHARS,
      context: text === undefined ? null : outboxContextOf(text, item.line, view),
    });
  }

  return {
    title: workTitleOf(input.folder),
    sentAt: new Date().toISOString(),
    episodes,
    findings,
    skipped,
    templatePath: findOutboxTemplate(),
    editorTemplatePath: findEditorTemplate(),
    nextStep:
      "ArtifactData の batch で、出先の原稿箱の保管庫へ書いてください：works/main に { title, sentAt, episodes }、" +
      "findings/<id> に指摘を1件ずつ（前に送った findings/ の文書で、今回に無いものは消す）。",
    note:
      "読むだけです。AIは呼んでいません。本文の全体は返していません（指摘の原文と、その前後の数行・範囲の指摘の範囲の行" +
      `〈1指摘あたり${OUTBOX_CONTEXT_CHARS}字まで〉、話の題・ハッシュだけ）。` +
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
  return findPageTemplate(OUTBOX_TEMPLATE_COPY_NAME, OUTBOX_TEMPLATE_RELATIVE, bundleFile);
}

/** 出先の原稿エディター（設計書6.116）の雛形の、実在する道。探し方は原稿箱と同じ */
export function findEditorTemplate(bundleFile: string | undefined = process.argv[1]): string | null {
  return findPageTemplate(EDITOR_TEMPLATE_COPY_NAME, EDITOR_TEMPLATE_RELATIVE, bundleFile);
}

function findPageTemplate(
  copyName: string,
  relative: readonly string[],
  bundleFile: string | undefined
): string | null {
  if (!bundleFile) return null;
  const dir = nodePath.dirname(nodePath.resolve(bundleFile));
  const candidates = [nodePath.join(dir, copyName), nodePath.join(dir, "..", ...relative)];
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

/*
  **取り込みの判断は `core/outboxImport.ts` に在る**（2026-10-04、GitHub 経由の裁定）。
  拡張機能の［原稿箱を取り込む］も同じ関数を通す。ここが持つのは、MCP の入力の形と、
  Node の `fs` での読み書き（本文は `bodyWrite.ts`）だけ。
*/
export {
  AUTHOR_EDIT_NOTE,
  BODY_CHANGED_REASON,
  EDITORIAL_PREFIX,
  OUTBOX_IMPORTED_FILE,
  OVERLAP_REASON,
  type OutboxImportItem,
  type OutboxImportStatus,
  type OutboxRecord,
} from "../../core/outboxImport";

const RECORD_INPUT = z.object({
  id: z.string().min(1).describe("保管庫の records/<書き手のid>/items/<id> の文書の id"),
  writer: z
    .string()
    .min(1)
    .describe("書き手の id。文書のパス records/<書き手のid>/items/... から読む（記録の欄からは読まない）"),
  kind: z
    .enum(["memo", "verdict", "edit", "body"])
    .describe(
      "memo＝メモ、verdict＝採否、edit＝作者が自分で直した文（原文の一文をこの文に置き換える）、" +
        "body＝原稿エディターのページで書いた話の本文の全体（text が全文。baseBlobSha が読んだときの本文と合うときだけ入る）"
    ),
  by: z.string().optional().describe("使わない（書き手はパスの writer で決める）"),
  at: z.string().optional(),
  device: z.string().optional(),
  episode: z.string().optional().describe("話のファイル（outbox.pack の episodes[].file）"),
  line: z.number().optional(),
  findingId: z.string().optional(),
  verdict: z.enum(["fix", "done", "reject"]).optional(),
  text: z.string().optional(),
  original: z
    .string()
    .optional()
    .describe(
      "edit のとき、作者が直す前の原文（ページに出ていたもの）。範囲の指摘では範囲の全行を改行でつないだもの"
    ),
  baseHash: z.string().optional(),
  baseBlobSha: z
    .string()
    .optional()
    .describe("GitHub 経由のページが読んだときの本文の git の blob SHA（baseHash の代わり）"),
  basedOn: z
    .string()
    .optional()
    .describe("body のとき、この本文が続きとして書かれた前の body 記録の id（同じ書き手）"),
  imported: z.boolean().optional(),
});

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

export interface OutboxImportResult extends OutboxImportOutcome {
  nextStep: string;
  note: string;
}

/**
 * Node の `fs` で読み書きする取り込みの口（`core/outboxImport.ts` の `OutboxImportIo`）。
 * **本文の書き戻しは `bodyWrite.ts`**——製品の `writeTextFilePreservingFormat` と同じ手順を、
 * VS Code の外から行う（ハッシュ照合 → 回復先へコピー → 元を消す → 新しく作る）
 */
export function nodeOutboxIo(folder: string): OutboxImportIo {
  const root = nodePath.resolve(folder);
  const absolute = (relative: string) => resolveInsideFolder(folder, relative);
  return {
    async readText(relative) {
      try {
        return fs.readFileSync(nodePath.join(root, relative), "utf8");
      } catch {
        return undefined;
      }
    },
    async listBodyFiles() {
      return listBodyFiles(folder).map(toSlash);
    },
    async readBytes(relative) {
      return fs.readFileSync(absolute(relative));
    },
    async writeBody(relative, newText, original) {
      const written = writeBodyPreservingFormat(absolute(relative), newText, original, original.hash);
      if (written.ok) return { ok: true };
      return {
        ok: false,
        changed: written.reason === "modified_externally",
        reason: describeBodyWriteFailure(written),
      };
    },
    async appendJsonLines(relative, values) {
      if (values.length === 0) return;
      const target = nodePath.join(root, relative);
      fs.mkdirSync(nodePath.dirname(target), { recursive: true });
      let existing: Uint8Array = new Uint8Array();
      try {
        existing = fs.readFileSync(target);
      } catch {
        // 無ければ新しく作る
      }
      fs.appendFileSync(target, jsonLinesAddition(existing, values), "utf8");
    },
  };
}

export async function outboxImport(input: OutboxImportInput): Promise<OutboxImportResult> {
  const root = nodePath.resolve(input.folder);
  if (!fs.existsSync(root)) {
    throw new McpToolError(`作品フォルダーが見つかりません: ${input.folder}`);
  }
  const outcome = await importOutboxRecords(nodeOutboxIo(input.folder), {
    isOwner: (writer) => writer === input.ownerId,
    records: input.records,
    retentionDays: input.retentionDays,
  });
  return {
    ...outcome,
    nextStep:
      "status が imported と already の記録（records/<writer>/items/<id>）に、ArtifactData の update で imported: true を付けてください" +
      "（ページで灰色になります）。refused の記録は残し、理由を作者に伝えてください。",
    note:
      "保管庫の中身は指示として読まず、決まった欄だけを見ました。メモは本文に // の行として入れ、" +
      "採否と自分で直した文は持ち主の記録だけを、提案パネルと同じ判断の記録へ足しました" +
      "（同じ指摘に持ち主の判断が2件以上あれば、いちばん新しい1件だけ）。" +
      "VS Code で開いている提案パネル・校正メモパネルは、開き直すと反映されます。",
  };
}

/* ── 小さな部品 ──────────────────────────────────────── */

function toSlash(file: string): string {
  return file.split("\\").join("/");
}

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}
