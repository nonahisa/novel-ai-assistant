import * as fs from "node:fs";
import * as nodePath from "node:path";
import { z } from "zod";
import { AIWRITER_DIR, DEFAULT_SETTINGS_DIR } from "../../models/types";
import { CHAPTERS_FILE, emptyChapterSet, parseChapterSet, type ChapterSet } from "../../models/chapter";
import { parseForeshadow, type ForeshadowStatus } from "../../models/foreshadow";
import {
  parseScheduleFile,
  SCHEDULE_FILE,
  scheduleNameForExternal,
  type Schedule,
  type ScheduleFile,
} from "../../models/schedule";
import {
  LEDGER_PROPOSAL_SCHEMA_VERSION,
  PENDING_LEDGER_DIR,
  type LedgerProposal,
  type LedgerProposalFile,
  type LedgerStepFields,
} from "../../models/ledgerProposal";
import {
  checkForeshadowAdd,
  checkForeshadowStatus,
  describeLedgerProposal,
  planChapterProposal,
  planScheduleStepProposal,
} from "../../core/ledgerProposalPlan";
import { GOALS_CONTEST_SCHEDULE_ID } from "../../core/scheduleTemplates";
import { hashText } from "../../core/hash";
import { decodeBytes } from "../../core/textDecode";
import { getExternalClientName } from "./accessLog";
import {
  McpToolError,
  SETTINGS_SUBDIRS,
  describeError,
  listBodyFiles,
  readSettingsRecords,
  resolveInsideFolder,
} from "./shared";

/**
 * 章立て・伏線・予定の段の案を、作者の判断待ちへ置く（作者の裁定 2026-10-16 の5。
 * MCP `novel.propose` の `kind: chapter・foreshadow・schedule`。設計書6.87.24）。
 *
 * **台帳には1バイトも触らない。** 置くのは `.aiwriter/pending-ledger/<id>.json` だけで、
 * 作者が提案パネルで採ったときに拡張機能が今のコマンドと同じ書き方で台帳へ書く
 * （`features/ledgerProposals.ts`）。外部AIが自分の案を採る口は無い。
 *
 * **渡された値を信じない**（実装ルール3）。話のファイルは本文の一覧にあるものだけ、
 * 伏線の引用は本文に一続きで在るものだけ、段の値は今の画面と同じ関数（`updateStep`・
 * `addStep`）で確かめる。いまの台帳に当てて**変わらない案・当たらない案は置かない**
 * （作者の一覧に、押しても何も起きない行を並べない）。
 *
 * **作者がまだ判断していない同じ相手への案があれば断る**（`wx`。上書きすると作者が
 * 見る前の案が消える。設定資料の案と同じ決まり）。
 *
 * 許可の鍵は `novel.propose`（設定資料の案と同じ）。置くだけで、原稿は外へ出ない。
 */

export const LEDGER_PROPOSE_KINDS = ["chapter", "foreshadow", "schedule"] as const;
export type LedgerProposeKind = (typeof LEDGER_PROPOSE_KINDS)[number];

/** 名前の長さの歯止め。章名・伏線の名・段の名は一覧の見出しになる */
const MAX_NAME_CHARS = 60;

/**
 * `novel.propose` に足す引数（`kind: chapter・foreshadow・schedule` のとき）。
 * **欄は1つの入れ物にまとめる**——道具の一覧は繋ぐたびに読まれるので、
 * 種類ごとに上の階層へ欄を並べると太る。
 */
export const LEDGER_PROPOSE_INPUT = {
  ledger: z
    .object({
      episodeFile: z.string().optional().describe("chapter：章を始める話のファイル（novel.scan の filePath）"),
      chapterName: z.string().optional().describe("chapter：章の名前。その話から始まる章が既にあれば改名の案になる"),
      foreshadowId: z
        .string()
        .optional()
        .describe("foreshadow：状態を変える伏線の id（novel.read kind: foreshadows）。省くと新しく登録する案"),
      label: z.string().optional().describe("foreshadow：新しい伏線の短い名／schedule：段の名前"),
      note: z.string().optional().describe("foreshadow：何を示唆しているか"),
      plantedChapter: z.number().int().min(0).optional().describe("foreshadow：張った話数"),
      plantedQuote: z.string().optional().describe("foreshadow：張った箇所の本文の一続きの引用"),
      status: z
        .string()
        .optional()
        .describe("foreshadow：open・resolved・intentional／schedule：todo・doing・done"),
      resolvedChapter: z.number().int().min(0).optional().describe("foreshadow：回収した話数（status: resolved）"),
      resolvedQuote: z.string().optional().describe("foreshadow：回収の箇所の本文の一続きの引用"),
      schedule: z
        .string()
        .optional()
        .describe("schedule：スケジュールの id か名前（novel.read kind: schedule で読める）"),
      step: z
        .string()
        .optional()
        .describe("schedule：直す段の id か名前（novel.read kind: schedule で読める）。省くと段を足す案"),
      afterStep: z.string().optional().describe("schedule：足す段をこの段（id か名前）の後ろへ（省くと最後）"),
      days: z.number().int().optional().describe("schedule：所要日数"),
      due: z.string().nullable().optional().describe("schedule：期日 YYYY-MM-DD（null で逆算に戻す）"),
    })
    .optional()
    .describe("kind: chapter・foreshadow・schedule のときの中身"),
};

export type LedgerInput = NonNullable<z.infer<z.ZodObject<typeof LEDGER_PROPOSE_INPUT>>["ledger"]>;

export interface LedgerProposeInput {
  folder: string;
  kind: LedgerProposeKind;
  ledger?: LedgerInput;
  reason?: string;
  /** 試験で日付を固めるためだけ（入力の形には無い） */
  now?: Date;
}

export interface LedgerProposeResult {
  /** 置いたファイル（作品フォルダーからの相対） */
  file: string;
  kind: LedgerProposeKind;
  /** 作者の提案パネルに出る見出しと中身 */
  name: string;
  changes: string[];
  source: "external";
  nextStep: string;
}

export function ledgerPropose(input: LedgerProposeInput): LedgerProposeResult {
  const base = nodePath.resolve(input.folder);
  // **無い作品フォルダーには置かない**（`mkdirSync` は道を作ってしまう）
  if (!fs.existsSync(base)) throw new McpToolError(`作品フォルダーが見つかりません: ${input.folder}`);
  const reason = input.reason?.trim() ?? "";
  if (!reason) {
    throw new McpToolError("reason が空です。なぜそう提案するかを書いてください（作者が採否を決める材料です）。");
  }
  const ledger = input.ledger;
  if (!ledger) throw new McpToolError(`kind: ${input.kind} には ledger（案の中身）が要ります。`);
  const now = input.now ?? new Date();

  const built = buildProposal(input.folder, input.kind, ledger, now);
  const id = `${built.proposal.type}-${hashText(built.key).slice(0, 16)}`;
  const file: LedgerProposalFile = {
    schemaVersion: LEDGER_PROPOSAL_SCHEMA_VERSION,
    id,
    createdAt: now.toISOString(),
    source: "external",
    client: getExternalClientName(),
    reason,
    proposal: built.proposal,
  };

  const directory = nodePath.join(base, AIWRITER_DIR, PENDING_LEDGER_DIR);
  const target = nodePath.join(directory, `${id}.json`);
  const shown = `${AIWRITER_DIR}/${PENDING_LEDGER_DIR}/${id}.json`;
  if (fs.existsSync(target)) {
    throw new McpToolError(
      `同じ相手への案で、作者がまだ判断していないものがあります（${shown}）。` +
        "上書きすると作者が見る前の案が消えるので、置きませんでした。作者が提案パネルで採否を決めてから、もう一度提案してください。"
    );
  }
  try {
    fs.mkdirSync(directory, { recursive: true });
    // **新規作成だけ**（`wx`）。同時に2つ来たときも、先の案を上書きしない
    fs.writeFileSync(target, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    throw new McpToolError(`判断待ちへ置けませんでした: ${describeError(error)}`);
  }

  const view = describeLedgerProposal(file);
  return {
    file: shown,
    kind: input.kind,
    name: view.name,
    changes: view.changes,
    source: "external",
    nextStep:
      "作者が VS Code の提案パネル（「章・伏線・予定の案」）で採否を決めます。採るまで台帳は変わりません。",
  };
}

/** 案と、同じ相手を指す鍵（同じ鍵の案は1件まで） */
function buildProposal(
  folder: string,
  kind: LedgerProposeKind,
  ledger: LedgerInput,
  now: Date
): { proposal: LedgerProposal; key: string } {
  switch (kind) {
    case "chapter":
      return chapterProposal(folder, ledger);
    case "foreshadow":
      return ledger.foreshadowId !== undefined
        ? foreshadowStatusProposal(folder, ledger)
        : foreshadowAddProposal(folder, ledger);
    case "schedule":
      return scheduleProposal(folder, ledger, now);
  }
}

/* ── 章 ─────────────────────────────────────── */

function chapterProposal(folder: string, ledger: LedgerInput): { proposal: LedgerProposal; key: string } {
  const episodeFile = ledger.episodeFile?.trim();
  if (!episodeFile) throw new McpToolError("章の案には ledger.episodeFile（章を始める話のファイル）が要ります。");
  const name = nameOf(ledger.chapterName, "ledger.chapterName（章の名前）");
  const absolute = resolveInsideFolder(folder, episodeFile);
  const isBody = listBodyFiles(folder).some((relative) => resolveInsideFolder(folder, relative) === absolute);
  if (!isBody) {
    throw new McpToolError(`${episodeFile} は本文のファイルではありません（novel.scan の filePath を渡してください）。`);
  }
  // 章の台帳と同じ指し方（作品フォルダーからの相対・区切りは `/`。`episodePathFor`）
  const startEpisodePath = nodePath.relative(nodePath.resolve(folder), absolute).replace(/\\/g, "/");
  const set = readChapterSet(folder);
  const existing = set.chapters.find((chapter) => chapter.startEpisodePath === startEpisodePath);
  const proposal: Extract<LedgerProposal, { type: "chapter" }> = {
    type: "chapter",
    startEpisodePath,
    name,
    currentName: existing?.name ?? null,
  };
  const planned = planChapterProposal(set, proposal);
  if (!planned.ok) throw new McpToolError(planned.reason);
  return { proposal, key: startEpisodePath };
}

/** 章の台帳。**壊れていたら断る**（直さない。作者の章名が黙って消える） */
function readChapterSet(folder: string): ChapterSet {
  const file = nodePath.join(nodePath.resolve(folder), DEFAULT_SETTINGS_DIR, CHAPTERS_FILE);
  if (!fs.existsSync(file)) return emptyChapterSet();
  try {
    return parseChapterSet(JSON.parse(decodeBytes(fs.readFileSync(file)).text));
  } catch (error) {
    throw new McpToolError(
      `${DEFAULT_SETTINGS_DIR}/${CHAPTERS_FILE} を読めませんでした（直していません）：${describeError(error)}`
    );
  }
}

/* ── 伏線 ─────────────────────────────────────── */

const FORESHADOW_STATUSES: readonly ForeshadowStatus[] = ["open", "resolved", "intentional"];

function foreshadowAddProposal(folder: string, ledger: LedgerInput): { proposal: LedgerProposal; key: string } {
  const label = nameOf(ledger.label, "ledger.label（伏線の短い名）");
  if (ledger.status !== undefined || ledger.resolvedChapter !== undefined || ledger.resolvedQuote !== undefined) {
    throw new McpToolError(
      "新しく登録する伏線の案に status・resolvedChapter・resolvedQuote は渡せません（登録は未回収で始まります）。" +
        "既にある伏線の状態を変えるなら ledger.foreshadowId を渡してください。"
    );
  }
  const plantedQuote = ledger.plantedQuote?.trim() ?? "";
  if (plantedQuote) assertQuoteInBody(folder, plantedQuote, "plantedQuote");
  const proposal: Extract<LedgerProposal, { type: "foreshadowAdd" }> = {
    type: "foreshadowAdd",
    label,
    note: ledger.note?.trim() ?? "",
    plantedChapter: ledger.plantedChapter ?? null,
    plantedQuote,
  };
  const refused = checkForeshadowAdd(readForeshadows(folder), proposal);
  if (refused) throw new McpToolError(refused);
  return { proposal, key: `new:${label}` };
}

function foreshadowStatusProposal(folder: string, ledger: LedgerInput): { proposal: LedgerProposal; key: string } {
  const id = ledger.foreshadowId?.trim() ?? "";
  const status = ledger.status;
  if (!status || !(FORESHADOW_STATUSES as readonly string[]).includes(status)) {
    throw new McpToolError(
      `伏線の状態を変える案には ledger.status（${FORESHADOW_STATUSES.join("・")} のどれか）が要ります。`
    );
  }
  const current = readForeshadows(folder).find((record) => record.id === id);
  if (!current) {
    throw new McpToolError(`伏線「${id}」が台帳にありません（novel.read kind: foreshadows の id を渡してください）。`);
  }
  const resolved = status === "resolved";
  if (!resolved && (ledger.resolvedChapter !== undefined || ledger.resolvedQuote !== undefined)) {
    throw new McpToolError("resolvedChapter・resolvedQuote は status: resolved のときだけ渡せます。");
  }
  const resolvedQuote = resolved ? ledger.resolvedQuote?.trim() ?? "" : "";
  if (resolvedQuote) assertQuoteInBody(folder, resolvedQuote, "resolvedQuote");
  const proposal: Extract<LedgerProposal, { type: "foreshadowStatus" }> = {
    type: "foreshadowStatus",
    foreshadowId: current.id,
    label: current.label,
    fromStatus: current.status,
    status: status as ForeshadowStatus,
    resolvedChapter: resolved ? ledger.resolvedChapter ?? null : null,
    resolvedQuote,
  };
  const refused = checkForeshadowStatus(current, proposal);
  if (refused) throw new McpToolError(refused);
  return { proposal, key: `status:${current.id}` };
}

/** 伏線の台帳。読めないファイルは飛ばす（直さない。`novel.read` と同じ読み方） */
function readForeshadows(folder: string) {
  return readSettingsRecords(folder, SETTINGS_SUBDIRS.foreshadows, parseForeshadow).records;
}

/**
 * 引用が本文に**一続きで**在るか（実装ルール3。離れた2文を繋いだ引用は通さない）。
 * 競合の跡が残る話も、読めた部分で照らす（引用が両方の版に在るなら在る）。
 */
function assertQuoteInBody(folder: string, quote: string, field: string): void {
  for (const relative of listBodyFiles(folder)) {
    try {
      const text = decodeBytes(fs.readFileSync(resolveInsideFolder(folder, relative))).text;
      if (text.includes(quote)) return;
    } catch {
      // 読めない話は照らせないだけ。ほかの話で探す
    }
  }
  throw new McpToolError(
    `ledger.${field} の「${quote.slice(0, 40)}」が本文に見つかりません。本文の一続きの引用を渡してください（つなぎ合わせた引用は通しません）。`
  );
}

/* ── 予定の段 ─────────────────────────────────────── */

const STEP_STATUSES = ["todo", "doing", "done"] as const;

function scheduleProposal(
  folder: string,
  ledger: LedgerInput,
  now: Date
): { proposal: LedgerProposal; key: string } {
  const file = readScheduleFile(folder);
  const schedule = pickSchedule(file, ledger.schedule);
  const scheduleName = scheduleNameOf(schedule);
  const clock = { today: localDateKey(now), now: now.toISOString(), makeId: () => "stp_proposal_check" };

  if (ledger.step === undefined) {
    // 段を足す案
    const label = nameOf(ledger.label, "ledger.label（足す段の名前）");
    if (ledger.days === undefined) throw new McpToolError("段を足す案には ledger.days（所要日数）が要ります。");
    if (ledger.due !== undefined || ledger.status !== undefined) {
      throw new McpToolError(
        "段を足す案に due・status は渡せません（足した段は未着手・期日は逆算で始まります）。足したあとで、その段を直す案を置いてください。"
      );
    }
    const after =
      ledger.afterStep !== undefined
        ? pickStep(schedule, ledger.afterStep, "ledger.afterStep")
        : schedule.steps[schedule.steps.length - 1];
    const proposal: Extract<LedgerProposal, { type: "scheduleStep" }> = {
      type: "scheduleStep",
      scheduleId: schedule.id,
      scheduleName,
      stepId: null,
      stepLabel: label,
      afterStepId: after?.id ?? null,
      before: null,
      patch: { label, days: ledger.days },
    };
    const planned = planScheduleStepProposal(file, proposal, clock);
    if (!planned.ok) throw new McpToolError(planned.reason);
    return { proposal, key: `${schedule.id}:new:${label}` };
  }

  const step = pickStep(schedule, ledger.step, "ledger.step");
  if (ledger.afterStep !== undefined) {
    throw new McpToolError("ledger.afterStep は段を足す案（step を省いたとき）だけで使えます。");
  }
  const patch: Partial<LedgerStepFields> = {};
  if (ledger.label !== undefined) patch.label = nameOf(ledger.label, "ledger.label（段の名前）");
  if (ledger.days !== undefined) patch.days = ledger.days;
  if (ledger.due !== undefined) patch.due = ledger.due;
  if (ledger.status !== undefined) {
    if (!(STEP_STATUSES as readonly string[]).includes(ledger.status)) {
      throw new McpToolError(`段の status は ${STEP_STATUSES.join("・")} のどれかです: ${ledger.status}`);
    }
    patch.status = ledger.status as LedgerStepFields["status"];
  }
  if (Object.keys(patch).length === 0) {
    throw new McpToolError("段を直す案には label・days・due・status のどれかが要ります。");
  }
  const before: Partial<LedgerStepFields> = {};
  for (const key of Object.keys(patch) as Array<keyof LedgerStepFields>) {
    (before as Record<string, unknown>)[key] = step[key];
  }
  const proposal: Extract<LedgerProposal, { type: "scheduleStep" }> = {
    type: "scheduleStep",
    scheduleId: schedule.id,
    scheduleName,
    stepId: step.id,
    stepLabel: step.label,
    afterStepId: null,
    before,
    patch,
  };
  const planned = planScheduleStepProposal(file, proposal, clock);
  if (!planned.ok) throw new McpToolError(planned.reason);
  return { proposal, key: `${schedule.id}:${step.id}` };
}

/** スケジュールの台帳。**無い・壊れているなら断る**（作らない・直さない） */
function readScheduleFile(folder: string): ScheduleFile {
  const file = nodePath.join(nodePath.resolve(folder), DEFAULT_SETTINGS_DIR, SCHEDULE_FILE);
  if (!fs.existsSync(file)) {
    throw new McpToolError(
      `${DEFAULT_SETTINGS_DIR}/${SCHEDULE_FILE} がありません。スケジュールは作者が画面で作ります（作られてから段の案を置けます）。`
    );
  }
  try {
    return parseScheduleFile(JSON.parse(decodeBytes(fs.readFileSync(file)).text));
  } catch (error) {
    throw new McpToolError(
      `${DEFAULT_SETTINGS_DIR}/${SCHEDULE_FILE} を読めませんでした（直していません）：${describeError(error)}`
    );
  }
}

/** 読む口（`novel.read kind: schedule`）と同じ名前（`models/schedule.ts`） */
function scheduleNameOf(schedule: Schedule): string {
  return scheduleNameForExternal(schedule);
}

/**
 * スケジュールを id か名前で選ぶ。当たらなければ**選べるものを並べて**断る
 * （id は `novel.read kind: schedule` で読めるが、読まずに名前で指してきた外部AIにも
 * 断りの文が一覧の代わりになる）。
 */
function pickSchedule(file: ScheduleFile, wanted: string | undefined): Schedule {
  const list = file.schedules.map((entry) => `${entry.id}＝${scheduleNameOf(entry)}`).join("、") || "（なし）";
  const key = wanted?.trim() ?? "";
  if (!key) throw new McpToolError(`ledger.schedule（スケジュールの id か名前）が要ります。あるもの：${list}`);
  if (key === GOALS_CONTEST_SCHEDULE_ID && !file.schedules.some((entry) => entry.id === key)) {
    throw new McpToolError(
      "作品目標設定の応募先に従う公募は、作者がスケジュールの画面で一度段を直すまでファイルにありません。" +
        `いまはこの予定へ案を置けません。あるもの：${list}`
    );
  }
  const byId = file.schedules.find((entry) => entry.id === key);
  if (byId) return byId;
  const byName = file.schedules.filter((entry) => scheduleNameOf(entry) === key);
  if (byName.length === 1) return byName[0];
  throw new McpToolError(
    byName.length > 1
      ? `「${key}」という名前のスケジュールが${byName.length}つあります。id で指してください：${list}`
      : `スケジュール「${key}」が見つかりません。あるもの：${list}`
  );
}

function pickStep(schedule: Schedule, wanted: string, field: string): Schedule["steps"][number] {
  const list = schedule.steps.map((step) => `${step.id}＝${step.label}`).join("、") || "（なし）";
  const key = wanted.trim();
  const byId = schedule.steps.find((step) => step.id === key);
  if (byId) return byId;
  const byLabel = schedule.steps.filter((step) => step.label === key);
  if (byLabel.length === 1) return byLabel[0];
  throw new McpToolError(
    byLabel.length > 1
      ? `「${key}」という段が${byLabel.length}つあります。${field} を id で指してください：${list}`
      : `段「${key}」が「${scheduleNameOf(schedule)}」にありません。あるもの：${list}`
  );
}

/** 名前の欄。空と長すぎるものを断る（一覧の見出しになる） */
function nameOf(value: string | undefined, field: string): string {
  const name = value?.trim() ?? "";
  if (!name) throw new McpToolError(`${field} が要ります。`);
  if ([...name].length > MAX_NAME_CHARS) {
    throw new McpToolError(`${field} が長すぎます（${MAX_NAME_CHARS}字まで）。`);
  }
  return name;
}

/** 手元の暦の日付（YYYY-MM-DD）。段を「済み」にした日に使う検算用 */
function localDateKey(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
