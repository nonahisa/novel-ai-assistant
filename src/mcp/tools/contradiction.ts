import { z } from "zod";
import {
  CONTRADICTION_CATEGORIES,
  CONTRADICTION_CHECK_SCHEMA,
  CONTRADICTION_CHECK_SYSTEM_PROMPT,
  CONTRADICTION_CHECK_VERSION,
  LIGHT_CATEGORIES,
  buildContradictionCheckPrompt,
  type ContradictionCategory,
} from "../../prompts/contradictionCheck";
import {
  parseContradictionResult,
  validateContradictions,
  type AcceptedContradiction,
  type RejectedContradiction,
} from "../../core/contradictionValidation";
import {
  buildContradictionTermIndex,
  createContradictionMaterial,
  type ContradictionMaterial,
} from "../../core/contradictionMaterial";
import { worldviewMaxChars } from "../../core/worldviewSelect";
import { withLineNumbers, type Chunk } from "../../core/chunker";
import { parseCharacter, type Character } from "../../models/character";
import { parseLocation, type Location } from "../../models/location";
import { parseWorldItem, type WorldItem } from "../../models/world";
import { parseSynopsisSet } from "../../models/synopsis";
import {
  CHUNK_INPUT,
  FOLDER_INPUT,
  McpToolError,
  OLLAMA_INPUT,
  RUNNER_INPUT,
  SETTINGS_SUBDIRS,
  SYNOPSES_FILE,
  chapterLabelOf,
  chunkFromId,
  chunkIdOf,
  chunksOfWorkFile,
  readSettingsFile,
  readSettingsRecords,
  selectChunks,
} from "./shared";
import { ollamaGenerate } from "./ollama";
import {
  chunkIdInput,
  claudeNote,
  responseInput,
  runChunks,
  type RunOutcome,
} from "./run";

/**
 * 矛盾検知（P-12）を外から呼ぶ（設計書6.87.8 の4）。
 *
 * **材料の組み立てを迂回しない**（6.87.6 の3）。`createContradictionMaterial` は
 * 「その話の時点で分かっていることだけ」を返す（設計書6.10.3）——資料は作品
 * 全体から作られているので、そのまま渡すと**あとの話で明かされる事実**と
 * 食い違って見え、AIがそれを矛盾として挙げる。
 *
 * **材料の無いチャンクはAIへ送らない**（製品と同じ）。照らし合わせる相手が
 * 無いまま問うと、本文だけを見て矛盾を作り出す。
 */

const VALIDATE_WITH = "contradiction.validate";

/**
 * 観点の絞り方。
 *
 * 製品はモデルの地力（`capabilityProfile`）から自動で決めるが、**MCP は
 * 相手のモデルの素性を知らない**ので、呼ぶ側に選ばせる。既定は `light`
 * （小さいモデルで観点を広げると、1回の負荷が上がって検出漏れが増える）。
 */
const CATEGORIES_INPUT = {
  categories: z
    .enum(["light", "all"])
    .optional()
    .describe(
      `見る観点。light＝${LIGHT_CATEGORIES.join("・")}（既定。小さいモデル向け）／all＝${CONTRADICTION_CATEGORIES.join("・")}`
    ),
};

export const CONTRADICTION_MATERIAL_INPUT = { ...FOLDER_INPUT, ...CHUNK_INPUT };
export const CONTRADICTION_PROMPT_INPUT = {
  ...FOLDER_INPUT,
  ...CHUNK_INPUT,
  ...CATEGORIES_INPUT,
};
export const CONTRADICTION_VALIDATE_INPUT = {
  ...FOLDER_INPUT,
  chunkId: chunkIdInput(),
  response: responseInput(),
};
export const CONTRADICTION_RUN_INPUT = {
  ...FOLDER_INPUT,
  ...CHUNK_INPUT,
  ...CATEGORIES_INPUT,
  ...RUNNER_INPUT,
  ...OLLAMA_INPUT,
};

interface Settings {
  people: Character[];
  places: Location[];
  worldItems: WorldItem[];
  material: ContradictionMaterial;
  synopsesBefore(chapter: number | null): string;
  unreadable: number;
}

/**
 * 設定資料を読んで、突き合わせる材料の組み立て役を作る。
 *
 * 世界観の上限は**モデルの上限に対する割合**で決める（設計書6.27.10）。
 * 固定字数のままだと、32kのモデルでは本文を1文字も足さないうちに溢れる。
 */
function loadSettings(folder: string, numCtx: number): Settings {
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
  const worldItems = readSettingsRecords(
    folder,
    SETTINGS_SUBDIRS.world,
    parseWorldItem
  );

  const index = buildContradictionTermIndex({
    people: people.records,
    places: places.records,
  });
  const material = createContradictionMaterial({
    people: people.records,
    places: places.records,
    worldItems: worldItems.records,
    index,
    worldviewMax: worldviewMaxChars(numCtx),
  });

  let synopses: Array<{ chapter: number | null; synopsis: string }> = [];
  const rawSynopses = readSettingsFile(folder, SYNOPSES_FILE);
  if (rawSynopses !== undefined) {
    try {
      synopses = parseSynopsisSet(rawSynopses).episodes.map((item) => ({
        chapter: item.chapter,
        synopsis: item.synopsis,
      }));
    } catch {
      synopses = [];
    }
  }

  return {
    people: people.records,
    places: places.records,
    worldItems: worldItems.records,
    material,
    synopsesBefore(chapter) {
      if (chapter === null) return "";
      // **その話より前だけを渡す。** 後の話を渡すと、まだ書かれていない
      // 展開と食い違うことを「矛盾」と言い出す
      return synopses
        .filter((item) => item.chapter !== null && item.chapter < chapter)
        .slice(-12)
        .map((item) => `第${item.chapter}話: ${item.synopsis}`)
        .join("\n");
    },
    unreadable: people.unreadable + places.unreadable + worldItems.unreadable,
  };
}

function categoriesOf(
  choice: "light" | "all" | undefined
): readonly ContradictionCategory[] {
  return choice === "all" ? CONTRADICTION_CATEGORIES : LIGHT_CATEGORIES;
}

export interface ContradictionChunkMaterial {
  chunkId: string;
  index: number;
  chapterLabel: string;
  chars: number;
  /** 本文に出てくる人物の設定だけ（その話の時点まで） */
  characterDetails: string;
  /** 本文に出てくる場所の設定だけ */
  locationDetails: string;
  worldviewSummary: string;
  previousSynopses: string;
  /** 照らし合わせる相手があるか。**無ければAIへ送らない** */
  hasAnything: boolean;
  /** 本文に現れた、索引にある語（本文の表記そのまま） */
  names: string[];
}

export interface ContradictionMaterialInput {
  folder: string;
  filePath: string;
  numCtx: number;
  chunkIndex?: number;
}

export function contradictionMaterial(input: ContradictionMaterialInput): {
  settingsCount: { people: number; places: number; world: number };
  unreadableSettings: number;
  referenceBudgetChars: number;
  chunks: ContradictionChunkMaterial[];
} {
  const settings = loadSettings(input.folder, input.numCtx);
  const { chunks, maxChars } = chunksOfWorkFile(
    input.folder,
    input.filePath,
    input.numCtx
  );

  return {
    settingsCount: {
      people: settings.people.length,
      places: settings.places.length,
      world: settings.worldItems.length,
    },
    unreadableSettings: settings.unreadable,
    referenceBudgetChars: settings.material.referenceBudgetChars,
    chunks: selectChunks(chunks, input.chunkIndex).map((chunk) =>
      materialForChunk(input.filePath, chunk, maxChars, settings)
    ),
  };
}

function materialForChunk(
  relative: string,
  chunk: Chunk,
  maxChars: number,
  settings: Settings
): ContradictionChunkMaterial {
  const relevant = settings.material.relevantFor(chunk.text, chunk.chapterStart);
  return {
    chunkId: chunkIdOf(relative, chunk, maxChars),
    index: chunk.index,
    chapterLabel: chapterLabelOf(chunk),
    chars: chunk.text.length,
    characterDetails: relevant.characters,
    locationDetails: relevant.locations,
    worldviewSummary: relevant.worldview,
    previousSynopses: settings.synopsesBefore(chunk.chapterStart),
    hasAnything: relevant.hasAnything,
    names: settings.material.namesIn(chunk.text),
  };
}

export interface ContradictionChunkPrompt {
  chunkId: string;
  index: number;
  chapterLabel: string;
  chars: number;
  userPrompt: string;
}

export interface ContradictionPromptInput extends ContradictionMaterialInput {
  categories?: "light" | "all";
}

export function contradictionPrompt(input: ContradictionPromptInput): {
  promptVersion: string;
  systemPrompt: string;
  schema: unknown;
  categories: readonly ContradictionCategory[];
  validateWith: string;
  chunks: ContradictionChunkPrompt[];
  /** 材料が無くて飛ばしたチャンク。**黙って落とさない** */
  skipped: Array<{ chunkId: string; reason: string }>;
} {
  const settings = loadSettings(input.folder, input.numCtx);
  const { chunks, maxChars } = chunksOfWorkFile(
    input.folder,
    input.filePath,
    input.numCtx
  );
  const categories = categoriesOf(input.categories);

  const prompts: ContradictionChunkPrompt[] = [];
  const skipped: Array<{ chunkId: string; reason: string }> = [];
  for (const chunk of selectChunks(chunks, input.chunkIndex)) {
    const material = materialForChunk(input.filePath, chunk, maxChars, settings);
    if (!material.hasAnything) {
      // **材料なしで問わない。** 照らし合わせる相手が無いと、
      // 本文だけを見て矛盾を作り出す
      skipped.push({
        chunkId: material.chunkId,
        reason: "この本文に出てくる設定資料がありません（突き合わせる相手なし）",
      });
      continue;
    }
    prompts.push({
      chunkId: material.chunkId,
      index: chunk.index,
      chapterLabel: material.chapterLabel,
      chars: chunk.text.length,
      userPrompt: buildContradictionCheckPrompt({
        chapterLabel: material.chapterLabel,
        chunkTextWithLineNumbers: withLineNumbers(chunk),
        characterDetails: material.characterDetails,
        locationDetails: material.locationDetails,
        worldviewSummary: material.worldviewSummary,
        previousSynopses: material.previousSynopses,
        categories,
      }),
    });
  }

  return {
    promptVersion: CONTRADICTION_CHECK_VERSION,
    systemPrompt: CONTRADICTION_CHECK_SYSTEM_PROMPT,
    schema: CONTRADICTION_CHECK_SCHEMA,
    categories,
    validateWith: VALIDATE_WITH,
    chunks: prompts,
    skipped,
  };
}

export interface ContradictionValidateResult {
  chunkId: string;
  chapterLabel: string;
  accepted: AcceptedContradiction[];
  rejected: RejectedContradiction[];
}

export function contradictionValidate(input: {
  folder: string;
  chunkId: string;
  response: string;
}): ContradictionValidateResult {
  const chunk = chunkFromId(input.folder, input.chunkId);
  return validateAgainst(input.chunkId, chunk, input.response);
}

function validateAgainst(
  chunkId: string,
  chunk: Chunk,
  response: string
): ContradictionValidateResult {
  // 解析も製品のもの（前後に説明やコードフェンスが付くモデルがある）
  const parsed = parseContradictionResult(response);
  if (!parsed) {
    throw new McpToolError(
      "応答をJSONとして読めませんでした（矛盾検知のスキーマに沿っていません）。"
    );
  }
  const result = validateContradictions(parsed, chunk);
  return {
    chunkId,
    chapterLabel: chapterLabelOf(chunk),
    accepted: result.accepted,
    rejected: result.rejected,
  };
}

export interface ContradictionRunInput extends ContradictionPromptInput {
  runner: "ollama" | "claude";
  endpoint?: string;
  model?: string;
  allowRemote?: boolean;
}

export async function contradictionRun(
  input: ContradictionRunInput
): Promise<RunOutcome<ContradictionChunkPrompt, ContradictionValidateResult>> {
  // **省略を既定で埋めない**（設計書6.87.8 の5）。手元へ投げるのと
  // Anthropic へ本文を渡すのとでは、作者にとっての意味がまるで違う
  if (input.runner !== "ollama" && input.runner !== "claude") {
    throw new McpToolError(
      "runner を ollama（手元で検算まで通す）か claude（プロンプトだけ返す）で指定してください。既定はありません。"
    );
  }
  const prompts = contradictionPrompt(input);
  if (input.runner === "claude") {
    return {
      runner: "claude",
      note: claudeNote(VALIDATE_WITH),
      systemPrompt: prompts.systemPrompt,
      schema: prompts.schema,
      validateWith: VALIDATE_WITH,
      chunks: prompts.chunks,
    };
  }

  const model = input.model;
  if (!model) {
    throw new McpToolError("runner が ollama のときは model が要ります。");
  }

  return runChunks(model, prompts.chunks, async (item) => {
    const response = await ollamaGenerate({
      endpoint: input.endpoint,
      model,
      systemPrompt: prompts.systemPrompt,
      userPrompt: item.userPrompt,
      schema: prompts.schema,
      numCtx: input.numCtx,
      allowRemote: input.allowRemote,
    });
    return validateAgainst(
      item.chunkId,
      chunkFromId(input.folder, item.chunkId),
      response.text
    );
  });
}
