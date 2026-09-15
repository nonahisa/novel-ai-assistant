import { z } from "zod";
import {
  WORK_CHAT_SCHEMA,
  WORK_CHAT_VERSION,
  buildWorkChatPrompt,
  buildWorkChatSystemPrompt,
  parseWorkChatAnswer,
  type WorkChatAnswer,
  type WorkChatTurn,
} from "../../prompts/workChat";
import { buildAdvicePolicyPrompt } from "../../prompts/advicePolicy";
import { buildWriterStylePrompt } from "../../prompts/writerStyle";
import { buildReaderTypePrompt } from "../../prompts/readerTarget";
import { scoreAnswers, type AdviceProfile } from "../../core/advicePolicy";
import { buildWriterStyle } from "../../core/writerStyle";
import { parseReaderProfile } from "../../core/readerProfileParse";
import { READER_PROFILE_FILE } from "../../models/readerProfile";
import type { ReaderProfile } from "../../models/readerProfile";
import { parseCharacter } from "../../models/character";
import { parseLocation } from "../../models/location";
import {
  FOLDER_INPUT,
  McpToolError,
  OLLAMA_INPUT,
  RUNNER_INPUT,
  SETTINGS_SUBDIRS,
  readBody,
  readSettingsFile,
  readSettingsRecords,
} from "./shared";
import { ollamaGenerate } from "./ollama";
import { askSampling } from "./sampling";
import {
  assertRunner,
  claudeNote,
  responseInput,
  type RunnerKind,
} from "./run";

/**
 * AIへの相談（P-21、設計書6.19）を外から呼ぶ。
 *
 * **チャンクが無いのが、ほかの3機能と違うところ。** 推敲・誤字脱字・矛盾は
 * 本文を切って回すが、相談は「1つの問いに1つの答え」である。だから
 * `chunkId` の往復も要らない。
 *
 * ---
 *
 * **3つの診断のうち、読めるのは1つだけである**（0.64.2に調べた）。
 *
 * | 診断 | どこに在るか | MCPから |
 * |---|---|---|
 * | ターゲット読者（P-38） | 作品の `設定/読者像.json` | **読める**（製品と同じファイル） |
 * | 助言方針（P-21） | `globalState`（機械ごと） | 読めない → **答えを渡してもらう** |
 * | 執筆スタイル（P-39） | `globalState`（機械ごと） | 同上 |
 *
 * `globalState` は VS Code の持ち物で、作品フォルダーの外にある。
 * **MCPが読むのは渡された `folder` の配下だけ**（設計書6.87.8の守り③）なので、
 * そこを覗きにいくことはしない。
 *
 * **代わりに「作者が診断で答えたもの」を受け取る。** 内部の保存の形ではなく
 * 答えそのものを受け取り、**製品の関数**（`scoreAnswers`・`buildWriterStyle`）で
 * 組み立てる。写しを置かずに済むうえ、**測るのにいちばん使いやすい**——
 * 「即興派だと答えが変わるか」を、答えを差し替えるだけで試せる。
 *
 * **渡さなければ、その軸は1字も送らない。** これは製品の決まりそのもので
 * （設計書6.90.1）、未診断の作者はまさにその状態である。
 */

const VALIDATE_WITH = "chat.validate";

/** 相談で渡す材料の上限。**長い作品で本文が押し出されないように** */
const REFERENCE_LIMIT = 60;

/** 本文の抜粋の上限（字）。製品の相談も、開いている画面の一部だけを渡す */
const EXCERPT_LIMIT = 4000;

const ADVICE_ANSWERS_INPUT = z
  .array(z.number().int().min(0).max(2))
  .length(9)
  .optional()
  .describe(
    "助言方針の診断（9問）の答え。各0/1/2。" +
      "省くと、その軸は1字も送りません（未診断の作者と同じ扱い）。" +
      "globalState にあるため、MCPからは読めません"
  );

const WRITER_STYLE_INPUT = z
  .object({
    situation: z.string(),
    plan: z.string(),
    revise: z.string(),
    material: z.string(),
    outlet: z.string(),
  })
  .optional()
  .describe(
    "執筆スタイルの診断の答え（5問）。相談へ渡すのは段取り（plan）と" +
      "直す時期（revise）だけです。省くと1字も送りません"
  );

export const CHAT_PROMPT_INPUT = {
  ...FOLDER_INPUT,
  question: z.string().min(1).describe("作者からの問い"),
  filePath: z
    .string()
    .optional()
    .describe(
      "いま開いている想定の本文（作品フォルダーからの相対パス）。渡すと抜粋を材料に添えます"
    ),
  history: z
    .array(
      z.object({
        role: z.enum(["author", "assistant"]),
        text: z.string(),
      })
    )
    .optional()
    .describe("これまでのやり取り。古いものから順に"),
  adviceAnswers: ADVICE_ANSWERS_INPUT,
  writerStyle: WRITER_STYLE_INPUT,
  featureIndex: z
    .boolean()
    .optional()
    .describe(
      "操作の目次をシステムの指示へ入れるか（既定は入れない）。" +
        "作品の相談を測るときは入れないほうが、答えが操作の話へ逸れません"
    ),
};

export const CHAT_VALIDATE_INPUT = {
  response: responseInput(),
};

export const CHAT_RUN_INPUT = {
  ...CHAT_PROMPT_INPUT,
  ...RUNNER_INPUT,
  ...OLLAMA_INPUT,
};

/** 相談へ足した診断の内訳。**何を送ったのかを、呼ぶ側が読めるように** */
export interface ChatDiagnosisReport {
  advicePolicy: boolean;
  writerStyle: boolean;
  readerType: boolean;
  /** 送らなかった軸と、その理由 */
  omitted: string[];
}

export interface ChatPromptResult {
  promptVersion: string;
  systemPrompt: string;
  schema: unknown;
  validateWith: string;
  userPrompt: string;
  /** 材料として添えた語（登場人物・場所の名前） */
  reference: string[];
  diagnoses: ChatDiagnosisReport;
}

export interface ChatPromptInput {
  folder: string;
  question: string;
  filePath?: string;
  history?: WorkChatTurn[];
  adviceAnswers?: number[];
  writerStyle?: Record<string, unknown>;
  featureIndex?: boolean;
}

/**
 * 作品の `設定/読者像.json` を読む。
 *
 * **壊れていたら足さない（止めない）。** 相談そのものは診断が無くても
 * できる。読めない台帳のせいで問いに答えられなくなるほうが困る。
 */
function readReaderProfile(folder: string): ReaderProfile | undefined {
  const raw = readSettingsFile(folder, READER_PROFILE_FILE);
  if (raw === undefined) return undefined;
  try {
    return parseReaderProfile(raw);
  } catch {
    return undefined;
  }
}

/**
 * 診断の3つを、製品と同じ順で組み立てる。
 *
 * **順も製品のまま**（`features/workChatPanel.ts` の `buildSystemPrompt`）
 * ——助言方針 → 執筆スタイル → ターゲット読者。順を変えると、
 * 同じ材料でも答えが変わりうる。
 */
function buildDiagnosisBlocks(
  folder: string,
  input: ChatPromptInput,
  now: Date
): { blocks: string[]; report: ChatDiagnosisReport } {
  const blocks: string[] = [];
  const omitted: string[] = [];
  const report: ChatDiagnosisReport = {
    advicePolicy: false,
    writerStyle: false,
    readerType: false,
    omitted,
  };

  if (input.adviceAnswers) {
    const profile: AdviceProfile = {
      scores: scoreAnswers(input.adviceAnswers),
      answers: [...input.adviceAnswers],
      updatedAt: now.toISOString(),
    };
    blocks.push(buildAdvicePolicyPrompt(profile, now));
    report.advicePolicy = true;
  } else {
    omitted.push("助言方針（adviceAnswers を渡すと足します）");
  }

  if (input.writerStyle) {
    const style = buildWriterStyle(input.writerStyle);
    if (style) {
      blocks.push(
        buildWriterStylePrompt({ style, updatedAt: now.toISOString() })
      );
      report.writerStyle = true;
    } else {
      // **知らない値は受け取らない**（`buildWriterStyle` の約束）。
      // 黙って既定へ倒さず、足さなかったことを言う
      omitted.push("執筆スタイル（選択肢に無い値が混ざっていました）");
    }
  } else {
    omitted.push("執筆スタイル（writerStyle を渡すと足します）");
  }

  const readerProfile = readReaderProfile(folder);
  const readerBlock = buildReaderTypePrompt(readerProfile);
  if (readerBlock) {
    blocks.push(readerBlock);
    report.readerType = true;
  } else {
    omitted.push("ターゲット読者（設定/読者像.json に宣言がありません）");
  }

  return { blocks, report };
}

/**
 * 材料（登場人物・場所の名前）。
 *
 * **製品の相談は、開いている画面に応じて材料を詰める。** ここは外から
 * 呼ぶ口なので、**作品に居る人物と場所の名前**という、いちばん外さない
 * ところに絞る。意味検索（RAG）は使わない——あれは索引を作ってあることが
 * 前提で、索引は作品フォルダーの外に在る。
 */
function collectReference(folder: string): string[] {
  const people = readSettingsRecords(
    folder,
    SETTINGS_SUBDIRS.characters,
    parseCharacter
  );
  const places = readSettingsRecords(
    folder,
    SETTINGS_SUBDIRS.locations,
    parseLocation
  );
  return [
    ...people.records.map((record) => `登場人物: ${record.name}`),
    ...places.records.map((record) => `場所: ${record.name}`),
  ].slice(0, REFERENCE_LIMIT);
}

export function chatPrompt(input: ChatPromptInput): ChatPromptResult {
  const now = new Date();
  const { blocks, report } = buildDiagnosisBlocks(input.folder, input, now);

  // **目次は既定で入れない。** 入れると「操作の話」へ寄りやすく、
  // 作品の相談の出来ばえを測るのに邪魔になる（製品は画面から渡す）
  const base = buildWorkChatSystemPrompt({
    featureIndex: input.featureIndex === true,
  });
  const systemPrompt =
    blocks.length === 0 ? base : `${base}\n\n${blocks.join("\n\n")}`;

  let excerpt = "";
  let truncated = false;
  if (input.filePath) {
    const text = readBody(input.folder, input.filePath);
    truncated = text.length > EXCERPT_LIMIT;
    excerpt = truncated ? text.slice(0, EXCERPT_LIMIT) : text;
  }

  const reference = collectReference(input.folder);

  return {
    promptVersion: WORK_CHAT_VERSION,
    systemPrompt,
    schema: WORK_CHAT_SCHEMA,
    validateWith: VALIDATE_WITH,
    userPrompt: buildWorkChatPrompt({
      workTitle: input.folder.split(/[\\/]/).filter(Boolean).pop() ?? "",
      contextKind: input.filePath ? "manuscript" : "outside",
      contextLabel: input.filePath ?? "作品のファイル以外",
      excerpt,
      excerptTruncated: truncated,
      fromSelection: false,
      reference,
      history: input.history ?? [],
      question: input.question,
    }),
    reference,
    diagnoses: report,
  };
}

export interface ChatValidateResult {
  answer: WorkChatAnswer;
  /**
   * 書き込みや実行の提案が入っていたか。
   *
   * **MCPは実行しない**（設計書6.87.7「原稿を書き換える操作を外へ出さない」）。
   * 入っていたことだけを知らせる——提案の中身は `answer` にそのまま在る。
   */
  proposals: { edit: boolean; run: boolean; reloadRecord: boolean };
}

/**
 * 応答を読み解く。
 *
 * **JSONとして読めなくても止めない。** 製品の `parseWorkChatAnswer` は、
 * 読めなかったときに**本文をそのまま `reply` にする**——相談は
 * 「形が合っているか」より「作者に答えが届くか」が大事な機能で、
 * AIが素の文で返したからといって答えを捨てない作りになっている。
 *
 * **ここで自前の門番を足さない。** 足すと「製品では読める応答が
 * MCPでは捨てられる」という差ができ、測ったものが製品の姿でなくなる
 * （設計書6.87.6 の3と同じ理由）。
 */
export function chatValidate(input: { response: string }): ChatValidateResult {
  const answer = parseWorkChatAnswer(input.response);
  return {
    answer,
    proposals: {
      edit: answer.edit !== undefined && answer.edit !== null,
      run: answer.run !== undefined && answer.run !== null,
      reloadRecord:
        answer.reloadRecord !== undefined && answer.reloadRecord !== null,
    },
  };
}

export interface ChatRunInput extends ChatPromptInput {
  runner: RunnerKind;
  endpoint?: string;
  model?: string;
  allowRemote?: boolean;
  numCtx?: number;
}

export type ChatRunResult =
  | {
      runner: "claude";
      note: string;
      systemPrompt: string;
      userPrompt: string;
      schema: unknown;
      validateWith: string;
      diagnoses: ChatDiagnosisReport;
    }
  | {
      runner: "ollama";
      model: string;
      diagnoses: ChatDiagnosisReport;
      result: ChatValidateResult;
    }
  | {
      /** 呼び出し元に考えてもらった（設計書6.87.12） */
      runner: "sampling";
      /** 答えたモデル。**こちらでは選べない** */
      model: string;
      diagnoses: ChatDiagnosisReport;
      result: ChatValidateResult;
    };

export async function chatRun(input: ChatRunInput): Promise<ChatRunResult> {
  // **省略を既定で埋めない**（設計書6.87.8 の5）
  assertRunner(input.runner);
  const prompt = chatPrompt(input);

  if (input.runner === "claude") {
    return {
      runner: "claude",
      note: claudeNote(VALIDATE_WITH),
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt,
      schema: prompt.schema,
      validateWith: VALIDATE_WITH,
      diagnoses: prompt.diagnoses,
    };
  }

  if (input.runner === "sampling") {
    // **呼び出し元に考えてもらい、検算まで通す**（設計書6.87.12）
    const reply = await askSampling({
      folder: input.folder,
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt,
    });
    return {
      runner: "sampling",
      model: reply.model,
      diagnoses: prompt.diagnoses,
      result: chatValidate({ response: reply.text }),
    };
  }

  const model = input.model;
  if (!model) {
    throw new McpToolError("runner が ollama のときは model が要ります。");
  }
  const response = await ollamaGenerate({
    endpoint: input.endpoint,
    model,
    systemPrompt: prompt.systemPrompt,
    userPrompt: prompt.userPrompt,
    schema: prompt.schema,
    numCtx: input.numCtx ?? 16384,
    allowRemote: input.allowRemote,
  });

  return {
    runner: "ollama",
    model,
    diagnoses: prompt.diagnoses,
    result: chatValidate({ response: response.text }),
  };
}
