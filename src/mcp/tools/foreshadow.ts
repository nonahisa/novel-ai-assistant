import { targetsFor, toBrief } from "../../core/foreshadowTargets";
import {
  FORESHADOW_DETECT_SCHEMA,
  FORESHADOW_DETECT_SYSTEM_PROMPT,
  FORESHADOW_DETECT_TEMPERATURE,
  FORESHADOW_DETECT_VERSION,
  buildForeshadowDetectPrompt,
} from "../../prompts/foreshadowDetect";
import {
  FORESHADOW_RESOLVE_SCHEMA,
  FORESHADOW_RESOLVE_SYSTEM_PROMPT,
  FORESHADOW_RESOLVE_TEMPERATURE,
  FORESHADOW_RESOLVE_VERSION,
  buildForeshadowResolvePrompt,
} from "../../prompts/foreshadowResolve";
import {
  parseForeshadowDetectResult,
  parseForeshadowResolveResult,
  validateForeshadowCandidates,
  validateForeshadowResolutions,
  type AcceptedForeshadowCandidate,
  type AcceptedForeshadowResolution,
  type KnownForeshadow,
  type RejectedForeshadow,
  type RejectedResolution,
} from "../../core/foreshadowValidation";
import { type Chunk } from "../../core/chunker";
import { parseForeshadow, type Foreshadow } from "../../models/foreshadow";
import {
  McpToolError,
  SETTINGS_SUBDIRS,
  chapterLabelOf,
  chunkFromId,
  chunkIdOf,
  chunksOfWorkFile,
  readSettingsRecords,
  selectChunks,
} from "./shared";
import { ollamaGenerate } from "./ollama";
import {
  runByRunner,
  type RunOutcome,
  type RunnerKind,
  validateWith,
} from "./run";

/**
 * 伏線（P-25 配置の検知／P-26 回収の確認）を外から呼ぶ（設計書6.87.8 の4）。
 *
 * **台帳を書き換えない。** 読んで、候補を出すところまで（6.87.7）。
 * 台帳へ入れるかどうかは作者が決める。
 *
 * **重なりを落とすのはコード側**（`validateForeshadowCandidates`）。AIに
 * 「既存と同じか」を判断させると、別の伏線を1つに畳んでくる（設計書6.35.2）。
 */

const DETECT_VALIDATE_WITH = validateWith("foreshadow");

/** 既に台帳にある名前を、1回にいくつまで渡すか（`checkForeshadows.ts` と同じ） */
const KNOWN_LABEL_LIMIT = 60;

export type ForeshadowMode = "detect" | "resolve";

function loadLedger(folder: string): {
  records: Foreshadow[];
  unreadable: number;
} {
  return readSettingsRecords(
    folder,
    SETTINGS_SUBDIRS.foreshadows,
    parseForeshadow
  );
}

/**
 * このチャンクに掛ける伏線を選ぶ。
 *
 * **張った話より後の本文だけに掛ける。** 張った話そのもの、あるいは
 * それより前の本文へ掛けると、張った箇所を「回収」と言い出す。
 *
 * 規則は `core/foreshadowTargets.ts` の1か所にあり、拡張機能
 * （`features/checkForeshadows.ts`）と同じ関数を呼ぶ（写しを作らない）。
 */
// `targetsFor`・`toBrief` は core/foreshadowTargets.ts（拡張機能と MCP で共有）

export interface ForeshadowChunkPrompt {
  chunkId: string;
  index: number;
  chapterLabel: string;
  chars: number;
  userPrompt: string;
  /** `resolve` のとき、このチャンクへ掛けた伏線のid */
  targetIds?: string[];
}

export interface ForeshadowPromptInput {
  folder: string;
  filePath: string;
  numCtx: number;
  chunkIndex?: number;
  mode?: ForeshadowMode;
}

export interface ForeshadowPromptResult {
  mode: ForeshadowMode;
  promptVersion: string;
  systemPrompt: string;
  schema: unknown;
  /** 製品がこのプロンプトで使う温度（`prompts/*.ts`）。**写しを持たない** */
  temperature: number;
  validateWith: string;
  /** 台帳の件数（未回収／全体） */
  ledger: { open: number; total: number; unreadable: number };
  chunks: ForeshadowChunkPrompt[];
  skipped: Array<{ chunkId: string; reason: string }>;
}

export function foreshadowPrompt(
  input: ForeshadowPromptInput
): ForeshadowPromptResult {
  const mode: ForeshadowMode = input.mode ?? "detect";
  const ledger = loadLedger(input.folder);
  const open = ledger.records.filter((record) => record.status === "open");
  const { chunks, maxChars } = chunksOfWorkFile(
    input.folder,
    input.filePath,
    input.numCtx
  );
  const targets = selectChunks(chunks, input.chunkIndex);

  const prompts: ForeshadowChunkPrompt[] = [];
  const skipped: Array<{ chunkId: string; reason: string }> = [];

  for (const chunk of targets) {
    const chunkId = chunkIdOf(input.filePath, chunk, maxChars);
    const chapterLabel = chapterLabelOf(chunk);

    if (mode === "detect") {
      // **既に台帳にある名前を渡して、同じものを二度出させない**
      // （設計書6.35.2）。コード側でも重なりは落とすが、そちらは
      // 「出てきたものを捨てる」ので送る量は減らない
      const knownLabels = ledger.records
        .map((record) => record.label.trim())
        .filter(Boolean)
        .slice(-KNOWN_LABEL_LIMIT);
      prompts.push({
        chunkId,
        index: chunk.index,
        chapterLabel,
        chars: chunk.text.length,
        userPrompt: buildForeshadowDetectPrompt({
          chapterLabel,
          chunkText: chunk.text,
          knownLabels,
        }),
      });
      continue;
    }

    const applicable = targetsFor(open, chunk);
    if (applicable.length === 0) {
      skipped.push({
        chunkId,
        reason:
          open.length === 0
            ? "台帳に未回収の伏線がありません"
            : "この本文より後で張られた伏線しかありません",
      });
      continue;
    }
    prompts.push({
      chunkId,
      index: chunk.index,
      chapterLabel,
      chars: chunk.text.length,
      targetIds: applicable.map((record) => record.id),
      userPrompt: buildForeshadowResolvePrompt({
        chapterLabel,
        chunkText: chunk.text,
        foreshadows: applicable.map(toBrief),
      }),
    });
  }

  return {
    mode,
    promptVersion:
      mode === "detect" ? FORESHADOW_DETECT_VERSION : FORESHADOW_RESOLVE_VERSION,
    systemPrompt:
      mode === "detect"
        ? FORESHADOW_DETECT_SYSTEM_PROMPT
        : FORESHADOW_RESOLVE_SYSTEM_PROMPT,
    schema:
      mode === "detect" ? FORESHADOW_DETECT_SCHEMA : FORESHADOW_RESOLVE_SCHEMA,
    // **版・プロンプトと同じように、温度も mode で分ける。** いまは両方 0.0 だが、
    // 片方だけ変えたときに気づけない形にはしない
    temperature:
      mode === "detect"
        ? FORESHADOW_DETECT_TEMPERATURE
        : FORESHADOW_RESOLVE_TEMPERATURE,
    validateWith: DETECT_VALIDATE_WITH,
    ledger: {
      open: open.length,
      total: ledger.records.length,
      unreadable: ledger.unreadable,
    },
    chunks: prompts,
    skipped,
  };
}

export interface ForeshadowValidateResult {
  mode: ForeshadowMode;
  chunkId: string;
  chapterLabel: string;
  accepted: AcceptedForeshadowCandidate[] | AcceptedForeshadowResolution[];
  rejected: RejectedForeshadow[] | RejectedResolution[];
}

export function foreshadowValidate(input: {
  folder: string;
  chunkId: string;
  response: string;
  mode?: ForeshadowMode;
}): ForeshadowValidateResult {
  const chunk = chunkFromId(input.folder, input.chunkId);
  return validateAgainst(
    input.folder,
    input.mode ?? "detect",
    input.chunkId,
    chunk,
    input.response
  );
}

function validateAgainst(
  folder: string,
  mode: ForeshadowMode,
  chunkId: string,
  chunk: Chunk,
  response: string
): ForeshadowValidateResult {
  const ledger = loadLedger(folder);

  if (mode === "detect") {
    const parsed = parseForeshadowDetectResult(response);
    if (!parsed) {
      throw new McpToolError(
        "応答を読み取れませんでした（伏線の検知のスキーマに沿っていません。JSONの形か、項目が合っていません）。"
      );
    }
    const known: KnownForeshadow[] = ledger.records.map((record) => ({
      label: record.label,
      plantedQuote: record.plantedQuote,
    }));
    const result = validateForeshadowCandidates(parsed, chunk, known);
    return {
      mode,
      chunkId,
      chapterLabel: chapterLabelOf(chunk),
      accepted: result.accepted,
      rejected: result.rejected,
    };
  }

  const parsed = parseForeshadowResolveResult(response);
  if (!parsed) {
    throw new McpToolError(
      "応答を読み取れませんでした（伏線の回収のスキーマに沿っていません。JSONの形か、項目が合っていません）。"
    );
  }
  // **返ってきた id が台帳に実在するかを見る**（設計書6.35）。一覧に無い
  // 番号を返してくるので、それで台帳を書き換えては困る
  const open = ledger.records
    .filter((record) => record.status === "open")
    .map((record) => ({ id: record.id, plantedQuote: record.plantedQuote }));
  const result = validateForeshadowResolutions(parsed, chunk, open);
  return {
    mode,
    chunkId,
    chapterLabel: chapterLabelOf(chunk),
    accepted: result.accepted,
    rejected: result.rejected,
  };
}

export interface ForeshadowRunInput extends ForeshadowPromptInput {
  runner: RunnerKind;
  endpoint?: string;
  model?: string;
  allowRemote?: boolean;
  temperature?: number;
}

export async function foreshadowRun(
  input: ForeshadowRunInput
): Promise<RunOutcome<ForeshadowChunkPrompt, ForeshadowValidateResult>> {
  // **省略を既定で埋めない**（設計書6.87.8 の5）。手元へ投げるのと
  // Anthropic へ本文を渡すのとでは、作者にとっての意味がまるで違う
  const prompts = foreshadowPrompt(input);

  // 行き先ごとの分岐は `runByRunner` が持つ（設計書6.87.12）
  return runByRunner(
    input,
    prompts,
    DETECT_VALIDATE_WITH,
    (chunkId, responseText) =>
      validateAgainst(
        input.folder,
        // **検知と回収で検算が変わる。** `mode` をそのまま引き継ぐ
        prompts.mode,
        chunkId,
        chunkFromId(input.folder, chunkId),
        responseText
      ),
    ollamaGenerate
  );
}
