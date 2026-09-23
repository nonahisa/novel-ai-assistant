import { z } from "zod";
import {
  WORK_CHAT_SCHEMA,
  WORK_CHAT_TEMPERATURE,
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
import {
  readAdviceProfile,
  readWriterProfile,
  updateAdviceProfile,
  updateWriterProfile,
} from "../adviceProfileMirror";
// **指紋は `core/hash.ts` から取る**（`core/textFile.ts` の `hashText` は
// `vscode` を引くので、外から呼ぶ束には持ち込めない。設計書6.87.3）
import { hashText } from "../../core/hash";
import {
  buildWriterStyle,
  describeWriterStyleChange,
  WRITER_REVISE_LABELS,
  WRITER_REVISE_STREAK_NEEDED,
} from "../../core/writerStyle";
import { parseCharacter } from "../../models/character";
import { parseLocation } from "../../models/location";
import {
  McpToolError,
  SETTINGS_SUBDIRS,
  readBody,
  readReaderProfile,
  readSettingsRecords,
} from "./shared";
import { ollamaGenerate } from "./ollama";
import { askSampling } from "./sampling";
import {
  assertRunner,
  claudeNote,
  temperatureFor,
  type RunnerKind,
  validateWith,
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
 * **3つの診断のうち、作品フォルダーから読めるのは1つだけである**（0.64.2に
 * 調べた。残り2つは拡張機能の控えから読む）。
 *
 * | 診断 | どこに在るか | MCPから |
 * |---|---|---|
 * | ターゲット読者（P-38） | 作品の `設定/読者像.json` | **読める**（製品と同じファイル） |
 * | 助言方針（P-21） | `globalState`（機械ごと） | **控えを読む**（下記）／答えを渡してもらう |
 * | 執筆スタイル（P-39） | `globalState`（機械ごと） | **控えを読む**（2026-09-23。助言方針と同じ道）／答えを渡してもらう |
 *
 * `globalState` は VS Code の持ち物で、作品フォルダーの外にある。
 * **MCPが読むのは渡された `folder` の配下だけ**（設計書6.87.8の守り③）なので、
 * そこを覗きにいくことはしない。
 *
 * **助言方針だけは、控えを読む**（0.71.x。設計書6.86.7）。答えを渡してもらう
 * 形だと、**9問の点数までは組み立てられても「いまの調子」（受容度・自信度）が
 * 永久に渡らない**——あれは作者に聞かずに相談から推定する値なので、
 * 渡す口そのものが無い。拡張機能が `globalStorageUri` の下（作品フォルダーの
 * 外。作者の目にも Git にも触れない）へ書き出した控えを
 * `mcp/adviceProfileMirror.ts` が読む。**渡された答えのほうが優先**で、
 * 控えも無ければこれまでどおり1字も送らない。
 *
 * **執筆スタイルも控えを読む**（2026-09-23）。以前は明示したときだけ乗り、
 * 相談で読み取った直す時期（`writerStyleSignals`）も書き戻さなかった。
 * 置き場は同じ保管庫の `writer-profile.json`（`core/writerProfileMirror.ts`）。
 *
 * **代わりに「作者が診断で答えたもの」を受け取る。** 内部の保存の形ではなく
 * 答えそのものを受け取り、**製品の関数**（`scoreAnswers`・`buildWriterStyle`）で
 * 組み立てる。写しを置かずに済むうえ、**測るのにいちばん使いやすい**——
 * 「即興派だと答えが変わるか」を、答えを差し替えるだけで試せる。
 *
 * **渡さなければ、その軸は1字も送らない。** これは製品の決まりそのもので
 * （設計書6.90.1）、未診断の作者はまさにその状態である。
 */

const VALIDATE_WITH = validateWith("chat");

/** 相談で渡す材料の上限。**長い作品で本文が押し出されないように** */
const REFERENCE_LIMIT = 60;

/** 本文の抜粋の上限（字）。製品の相談も、開いている画面の一部だけを渡す */
const EXCERPT_LIMIT = 4000;

/*
  **形の定義はここ1か所。** 束ねた道具（`features.ts`）は `options` の中身を
  `z.unknown()` で受けるので、奥へ入れる前にこの形で確かめ直す
  ——写しを持つと、片方だけ緩んだときに**製品では通らない形が MCP では通る。**
*/
export const CHAT_HISTORY_SCHEMA = z.array(
  z.object({
    role: z.enum(["author", "assistant"]),
    text: z.string(),
  })
);

export const CHAT_ADVICE_ANSWERS_SCHEMA = z
  .array(z.number().int().min(0).max(2))
  .length(9);

export const CHAT_WRITER_STYLE_SCHEMA = z.object({
  situation: z.string(),
  plan: z.string(),
  revise: z.string(),
  material: z.string(),
  outlet: z.string(),
});

/** 相談へ足した診断の内訳。**何を送ったのかを、呼ぶ側が読めるように** */
export interface ChatDiagnosisReport {
  advicePolicy: boolean;
  /**
   * 助言方針をどこから取ったか。
   *
   * **中身は返さない**（タイプの方針は systemPrompt に在るが、
   * 受容度・自信度は作者にも見せないと決めたものである。6.86.2）。
   * ここで言うのは出どころだけ——測るときに「渡した答えが効いたのか、
   * 控えが効いたのか」を取り違えないために要る。
   */
  advicePolicySource?: "input" | "mirror";
  writerStyle: boolean;
  /** 執筆スタイルをどこから取ったか（渡された答えか、拡張機能の控えか） */
  writerStyleSource?: "input" | "mirror";
  readerType: boolean;
  /** 送らなかった軸と、その理由 */
  omitted: string[];
}

export interface ChatPromptResult {
  promptVersion: string;
  systemPrompt: string;
  schema: unknown;
  /** 製品が相談で使う温度（`prompts/workChat.ts`）。**写しを持たない** */
  temperature: number;
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
    // **明示が最優先。** 控えがあっても上書きしない——答えを差し替えて
    // 測る道（「即興派だと答えが変わるか」）を潰さないため
    const profile: AdviceProfile = {
      scores: scoreAnswers(input.adviceAnswers),
      answers: [...input.adviceAnswers],
      updatedAt: now.toISOString(),
    };
    blocks.push(buildAdvicePolicyPrompt(profile, now));
    report.advicePolicy = true;
    report.advicePolicySource = "input";
  } else {
    // **渡されなければ、拡張機能が書き出した控えを見る**（設計書6.86.7）。
    // ここで初めて「いまの調子」（受容度・自信度）が外からの相談にも効く
    const stored = readAdviceProfile(folder);
    if (stored) {
      blocks.push(buildAdvicePolicyPrompt(stored, now));
      report.advicePolicy = true;
      report.advicePolicySource = "mirror";
    } else {
      // **黙って省かない。** 診断していないのか、控えが届いていないのかは
      // ここでは見分けられないので、両方の直し方を並べる
      omitted.push(
        "助言方針（adviceAnswers を渡すか、拡張機能で診断すると足します）"
      );
    }
  }

  if (input.writerStyle) {
    const style = buildWriterStyle(input.writerStyle);
    if (style) {
      blocks.push(
        buildWriterStylePrompt({ style, updatedAt: now.toISOString() })
      );
      report.writerStyle = true;
      report.writerStyleSource = "input";
    } else {
      // **知らない値は受け取らない**（`buildWriterStyle` の約束）。
      // 黙って既定へ倒さず、足さなかったことを言う
      omitted.push("執筆スタイル（選択肢に無い値が混ざっていました）");
    }
  } else {
    // **渡されなければ、拡張機能が書き出した控えを見る**（2026-09-23。
    // 助言方針と同じ道）。以前は明示したときしか乗らなかった
    const stored = readWriterProfile();
    if (stored) {
      blocks.push(buildWriterStylePrompt(stored));
      report.writerStyle = true;
      report.writerStyleSource = "mirror";
    } else {
      omitted.push(
        "執筆スタイル（writerStyle を渡すか、拡張機能で作家タイプ診断をすると足します）"
      );
    }
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
    temperature: WORK_CHAT_TEMPERATURE,
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
  /**
   * 助言方針の控えを書き戻したときの一言。
   *
   * **黙って隠さない**（作者の機械の記録を、外からの相談が静かに書き換える
   * ことになるため）。**ただし中身は言わない**——受容度・自信度は
   * 作者にも操作ログにも出さないと決めたもの（6.86.2、`advicePolicyLogLines`）で、
   * MCP の返事から漏れては意味がない。
   */
  adviceProfileNote?: string;
  /**
   * 執筆スタイル（直す時期）の控えを書き戻したときの一言。
   *
   * **こちらは中身を言う。** 直す時期は作者自身が5問で答えた値で、
   * 作者に見せている（受容度・自信度とは扱いが違う）。黙って書き換えると、
   * 案内の並びが変わった理由が作者に分からない（設計書6.90.1「変わったら
   * 必ず見せる」）。
   */
  writerStyleNote?: string;
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
 *
 * **`profileSignals` はここで拾う**（0.71.x。設計書6.86.7）。製品は
 * `workChatPanel.updateAdvicePolicy` で拾っており、ここが拾わないと
 * **外部AI経由の相談だけ、調子の推定が永久に更新されない。**
 * 値の形を絞るのは `parseWorkChatAnswer`（`parseProfileSignals`）、
 * 点数の動かし方は `applyProfileSignals` で、どちらも製品と同じものを通る。
 */
export function chatValidate(input: {
  response: string;
  /** 控えの書き戻し先。**省くと書き戻さない**（読み解くだけ） */
  folder?: string;
}): ChatValidateResult {
  const answer = parseWorkChatAnswer(input.response);
  const result: ChatValidateResult = {
    answer,
    proposals: {
      edit: answer.edit !== undefined && answer.edit !== null,
      run: answer.run !== undefined && answer.run !== null,
      reloadRecord:
        answer.reloadRecord !== undefined && answer.reloadRecord !== null,
    },
  };

  if (input.folder && answer.profileSignals) {
    /*
      方針がどこにも無ければ何も起きない（"absent"）。診断していない作者の
      値を、推定で生やさないため（製品の `updateAdvicePolicy` と同じ）。

      **応答の指紋を渡す。** 外部AIは `novel.validate` を撃ち直せるので、
      渡さないと同じ答えで ±0.5 が2回効き、**「段階が1つ動くまでおおよそ
      10回の相談が要る」という歯止めが撃ち直しで迂回できる。**
    */
    const outcome = updateAdviceProfile(
      input.folder,
      answer.profileSignals,
      hashText(input.response)
    );
    if (outcome === "updated") {
      result.adviceProfileNote =
        "助言方針の推定を更新しました（内訳は出しません）。";
    } else if (outcome === "duplicate") {
      // **黙って無視しない。** 撃ち直したことを伝えないと、効かなかったのが
      // 二重取りの歯止めなのか、別の失敗なのかが呼ぶ側に分からない
      result.adviceProfileNote =
        "この答えの推定は反映済みです（同じ答えは二度効かせません）。";
    }
  }

  /*
    **直す時期の読み取り（`writerStyleSignals`）も書き戻す**（2026-09-23）。
    製品は `workChatPanel.updateWriterStyle` で拾っており、ここが拾わないと
    外部AI経由の相談だけ、作者の語った直し方が永久に反映されない。

    歯止めは製品と同じ（2回続けて同じに読めたときだけ動く）。**変わったら
    必ず見せる**——助言方針と違い、執筆スタイルは作者に見せている値なので、
    何が何へ変わったか・どう戻すかまで返す（`describeWriterStyleChange`）。
  */
  if (input.folder && answer.writerStyleSignals) {
    const update = updateWriterProfile(
      answer.writerStyleSignals,
      hashText(input.response)
    );
    if (update.outcome === "updated") {
      result.writerStyleNote = describeWriterStyleChange(
        update.before,
        update.after
      );
    } else if (update.outcome === "counted" && update.after.reviseStreak) {
      const streak = update.after.reviseStreak;
      result.writerStyleNote =
        `直す時期を「${WRITER_REVISE_LABELS[streak.value]}」と読み取りました` +
        `（${streak.count}回目。${WRITER_REVISE_STREAK_NEEDED}回続けて読み取れたら反映します）。`;
    } else if (update.outcome === "duplicate") {
      result.writerStyleNote =
        "この答えの直す時期の読み取りは反映済みです（同じ答えは二度効かせません）。";
    }
  }

  return result;
}

export interface ChatRunInput extends ChatPromptInput {
  runner: RunnerKind;
  endpoint?: string;
  model?: string;
  allowRemote?: boolean;
  temperature?: number;
  numCtx?: number;
}

export type ChatRunResult =
  | {
      runner: "claude";
      note: string;
      systemPrompt: string;
      userPrompt: string;
      schema: unknown;
      temperature: number;
      validateWith: string;
      diagnoses: ChatDiagnosisReport;
    }
  | {
      runner: "ollama";
      model: string;
      temperature: number;
      diagnoses: ChatDiagnosisReport;
      result: ChatValidateResult;
    }
  | {
      /** 呼び出し元に考えてもらった（設計書6.87.12） */
      runner: "sampling";
      /** 答えたモデル。**こちらでは選べない** */
      model: string;
      temperature: number;
      diagnoses: ChatDiagnosisReport;
      result: ChatValidateResult;
    };

export async function chatRun(input: ChatRunInput): Promise<ChatRunResult> {
  // **省略を既定で埋めない**（設計書6.87.8 の5）
  assertRunner(input.runner);
  const prompt = chatPrompt(input);
  // **明示が無ければ製品と同じ**（6.87.16）。決め方は `run.ts` に1つだけ
  const temperature = temperatureFor(input, prompt.temperature);

  if (input.runner === "claude") {
    return {
      runner: "claude",
      note: claudeNote(VALIDATE_WITH),
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt,
      schema: prompt.schema,
      temperature,
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
      temperature,
    });
    return {
      runner: "sampling",
      model: reply.model,
      temperature,
      diagnoses: prompt.diagnoses,
      result: chatValidate({ folder: input.folder, response: reply.text }),
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
    temperature,
    allowRemote: input.allowRemote,
  });

  return {
    runner: "ollama",
    model,
    temperature,
    diagnoses: prompt.diagnoses,
    result: chatValidate({ folder: input.folder, response: response.text }),
  };
}
