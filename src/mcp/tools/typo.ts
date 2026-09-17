import {
  TYPO_CHECK_SCHEMA,
  TYPO_CHECK_SYSTEM_PROMPT,
  TYPO_CHECK_VERSION,
  TYPO_DICTIONARY_LIMIT,
  buildTypoCheckPrompt,
} from "../../prompts/typoCheck";
import {
  parseTypoCheckResult,
  validateTypoIssues,
  type AcceptedTypoIssue,
  type RejectedTypoIssue,
} from "../../core/typoCheckValidation";
import { withLineNumbers, type Chunk } from "../../core/chunker";
import { parseCharacter } from "../../models/character";
import { parseAbility } from "../../models/ability";
import { parseLocation } from "../../models/location";
import { parseOrganization } from "../../models/organization";
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
import { collectStyle, type WorkStyle } from "./proofread";
import { ollamaGenerate } from "./ollama";
import {
  runByRunner,
  type RunOutcome,
  type RunnerKind,
  validateWith,
} from "./run";

/**
 * 誤字脱字の検知（P-08）を外から呼ぶ（設計書6.87.8 の4）。
 *
 * **第1弾の3機能に続く4本目**（0.64.1）。作者の指定「まずはテストに利用
 * できる部分を優先したい」に対して、**いちばん測り直したいのがここ**で
 * ある——実データでの測定は「64件中62件が素通り」から始まり、
 * 何度も直してきた（CLAUDE.md「この作品で繰り返し起きた失敗」2番）。
 * それを**外から、モデルを差し替えて測れる**ようにする。
 *
 * **並びは製品のまま**（6.87.6 の3）。`features/checkTypos.ts` と同じ順で、
 * 固有名詞の辞書 → 作品の書き方 → `buildTypoCheckPrompt` → 応答を
 * `parseTypoCheckResult` → `validateTypoIssues` で検算する。
 *
 * **2つの辞書を、どちらも渡す。**
 *
 * - **固有名詞**（人物・能力・場所・組織の name と aliases）……
 *   プロンプトにも検算にも渡す。指示に従わないモデルがあるので、
 *   コード側でも `target` の完全一致を弾く
 * - **直さない語**（`設定/keep_words.json`）……方言・口癖は固有名詞では
 *   ないので、人物や場所をいくら抽出しても入ってこない（実データで確認）
 *
 * **作品の書き方（`styleNote`）も省かない。** 渡さずに測ると、文語体の
 * 作品で漢字ひらきの指摘が乱発する（設計書6.8.14）。組み立ては推敲と
 * 同じものを使う（`collectStyle`）——**写しを置かない。**
 */

const VALIDATE_WITH = validateWith("typo");

/**
 * 固有名詞の辞書（人物・能力・場所・組織の name と aliases）。
 *
 * **製品（`features/checkTypos.ts`）と同じ4種・同じ順で集める。**
 * 壊れているファイルは `readSettingsRecords` が飛ばす——勝手に直して
 * 書き戻すことはしない（そもそもMCPは書かない）。
 */
export function collectProtectedNames(folder: string): string[] {
  const people = readSettingsRecords(
    folder,
    SETTINGS_SUBDIRS.characters,
    parseCharacter
  );
  const abilities = readSettingsRecords(
    folder,
    SETTINGS_SUBDIRS.abilities,
    parseAbility
  );
  const places = readSettingsRecords(
    folder,
    SETTINGS_SUBDIRS.locations,
    parseLocation
  );
  const organizations = readSettingsRecords(
    folder,
    SETTINGS_SUBDIRS.organizations,
    parseOrganization
  );

  return [
    ...people.records.flatMap((record) => [record.name, ...record.aliases]),
    ...abilities.records.flatMap((record) => [record.name, ...record.aliases]),
    ...places.records.flatMap((record) => [record.name, ...record.aliases]),
    ...organizations.records.flatMap((record) => [
      record.name,
      ...record.aliases,
    ]),
  ]
    .map((name) => name.trim())
    .filter(Boolean);
}

/** プロンプトと検算の両方が要る材料。**1回だけ集める** */
interface TypoContext {
  protectedNames: string[];
  style: WorkStyle;
}

function collectContext(folder: string): TypoContext {
  return {
    protectedNames: collectProtectedNames(folder),
    style: collectStyle(folder),
  };
}

export interface TypoChunkPrompt {
  chunkId: string;
  index: number;
  chapterLabel: string;
  chars: number;
  userPrompt: string;
}

export interface TypoPromptResult {
  promptVersion: string;
  systemPrompt: string;
  schema: unknown;
  /** AIへ渡す作品の書き方。**空のまま投げない**（設計書6.8.14） */
  styleNote: string;
  /** 辞書に載せた固有名詞の件数（上限で切ったかを、呼ぶ側が読めるように） */
  dictionaryCount: number;
  dictionaryLimit: number;
  validateWith: string;
  chunks: TypoChunkPrompt[];
}

export interface TypoPromptInput {
  folder: string;
  filePath: string;
  numCtx: number;
  chunkIndex?: number;
}

export function typoPrompt(input: TypoPromptInput): TypoPromptResult {
  const context = collectContext(input.folder);
  const { chunks, maxChars } = chunksOfWorkFile(
    input.folder,
    input.filePath,
    input.numCtx
  );

  return {
    promptVersion: TYPO_CHECK_VERSION,
    systemPrompt: TYPO_CHECK_SYSTEM_PROMPT,
    schema: TYPO_CHECK_SCHEMA,
    styleNote: context.style.styleNote,
    dictionaryCount: Math.min(
      context.protectedNames.length,
      TYPO_DICTIONARY_LIMIT
    ),
    dictionaryLimit: TYPO_DICTIONARY_LIMIT,
    validateWith: VALIDATE_WITH,
    chunks: selectChunks(chunks, input.chunkIndex).map((chunk) =>
      promptForChunk(input.filePath, chunk, maxChars, context)
    ),
  };
}

function promptForChunk(
  relative: string,
  chunk: Chunk,
  maxChars: number,
  context: TypoContext
): TypoChunkPrompt {
  return {
    chunkId: chunkIdOf(relative, chunk, maxChars),
    index: chunk.index,
    chapterLabel: chapterLabelOf(chunk),
    chars: chunk.text.length,
    userPrompt: buildTypoCheckPrompt({
      chunkTextWithLineNumbers: withLineNumbers(chunk),
      // **製品と同じところで切る**（`TYPO_DICTIONARY_LIMIT`）。
      // 辞書は作品が育つほど伸びるので、切らないと本文が押し出される
      properNounDictionary: context.protectedNames.slice(
        0,
        TYPO_DICTIONARY_LIMIT
      ),
      styleNote: context.style.styleNote,
    }),
  };
}

export interface TypoValidateResult {
  chunkId: string;
  chapterLabel: string;
  accepted: AcceptedTypoIssue[];
  rejected: RejectedTypoIssue[];
}

export function typoValidate(input: {
  folder: string;
  chunkId: string;
  response: string;
}): TypoValidateResult {
  const chunk = chunkFromId(input.folder, input.chunkId);
  return validateAgainst(
    input.chunkId,
    chunk,
    input.response,
    collectContext(input.folder)
  );
}

/**
 * 応答を検算する。
 *
 * **解析も製品のもの**（`parseTypoCheckResult`）。構造化出力でも前後に
 * 説明やコードフェンスが付くモデルがあるので、ここを自前で書くと
 * 「製品では通る応答が MCP では捨てられる」という差ができる。
 */
function validateAgainst(
  chunkId: string,
  chunk: Chunk,
  response: string,
  context: TypoContext
): TypoValidateResult {
  const parsed = parseTypoCheckResult(response);
  if (!parsed) {
    throw new McpToolError(
      "応答を読み取れませんでした（誤字脱字のスキーマに沿っていません。JSONの形か、項目が合っていません）。"
    );
  }
  const result = validateTypoIssues(
    parsed,
    chunk,
    // **切らずに全部渡す。** プロンプトは長さの都合で上限まで載せるが、
    // 検算は長さの都合が無い——201件目の固有名詞を誤字と言われたとき、
    // 辞書を切っていると弾けない
    context.protectedNames,
    context.style.keepWords
  );
  return {
    chunkId,
    chapterLabel: chapterLabelOf(chunk),
    accepted: result.accepted,
    rejected: result.rejected,
  };
}

export interface TypoRunInput extends TypoPromptInput {
  runner: RunnerKind;
  endpoint?: string;
  model?: string;
  allowRemote?: boolean;
}

export async function typoRun(
  input: TypoRunInput
): Promise<RunOutcome<TypoChunkPrompt, TypoValidateResult>> {
  const prompts = typoPrompt(input);
  // **材料は1回だけ集める。** チャンクごとに集め直すと、辞書と作法を
  // チャンクの数だけ読むことになる
  const context = collectContext(input.folder);

  /*
    **行き先ごとの分岐は `runByRunner` が持つ**（設計書6.87.12）。
    同じ分岐が8つの道具に写されていたので、1か所へ寄せた。
    ここが渡すのは「この道具の検算」だけである。
  */
  return runByRunner(
    input,
    prompts,
    VALIDATE_WITH,
    (chunkId, responseText) =>
      validateAgainst(
        chunkId,
        chunkFromId(input.folder, chunkId),
        responseText,
        context
      ),
    ollamaGenerate
  );
}
