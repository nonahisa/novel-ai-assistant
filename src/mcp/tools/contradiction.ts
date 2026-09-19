import {
  CONTRADICTION_CATEGORIES,
  CONTRADICTION_CHECK_SCHEMA,
  CONTRADICTION_CHECK_SYSTEM_PROMPT,
  CONTRADICTION_CHECK_TEMPERATURE,
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
  McpToolError,
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
  runByRunner,
  type RunOutcome,
  type RunnerKind,
  validateWith,
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

const VALIDATE_WITH = validateWith("contradiction");

/**
 * 観点の絞り方。
 *
 * 製品はモデルの地力（`capabilityProfile`）から自動で決めるが、**MCP は
 * 相手のモデルの素性を知らない**ので、呼ぶ側に選ばせる。既定は `light`
 * （小さいモデルで観点を広げると、1回の負荷が上がって検出漏れが増える）。
 */
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

/**
 * 問う区分を決める。
 *
 * **`light`・`all` のほかに、区分名そのものを受ける**（0.70.3）。
 * 作者の案（2026-09-19）：「クラウドの高位AIは節約、手元で動くローカルLLMでは
 * **手数を意識して組む**と良さそうですね」。手元では呼び出しが電気代だけなので、
 * **7区分を減らすのではなく、1区分ずつ分けて問う**道があり得る。
 * それを**測れるようにする**ための口である（既定は `light` のまま変えない）。
 *
 * 受ける形は3つ——1つの名前（`"状態"`）、並び（`["人物","状態"]`）、
 * 区切り文字でつないだもの（`"人物,状態"`）。**測定の台本から
 * `--option categories=状態` と打てる**ことを優先した。
 */
function categoriesOf(
  choice: string | readonly string[] | undefined
): readonly ContradictionCategory[] {
  if (choice === undefined) return LIGHT_CATEGORIES;
  if (choice === "all") return CONTRADICTION_CATEGORIES;
  if (choice === "light") return LIGHT_CATEGORIES;

  const names = (Array.isArray(choice) ? choice : String(choice).split(/[,、・]/))
    .map((name) => name.trim())
    .filter((name) => name !== "");
  // 空文字だけを渡されたときは、黙って既定へ倒す（打ち間違いで止めない）
  if (names.length === 0) return LIGHT_CATEGORIES;

  const unknown = names.filter(
    (name) => !CONTRADICTION_CATEGORIES.includes(name as ContradictionCategory)
  );
  if (unknown.length > 0) {
    // **知らない名前は黙って捨てない。** 捨てると、打ち間違いに気づかないまま
    // 「その区分を測った」ことになる
    throw new McpToolError(
      `知らない矛盾の区分です: ${unknown.join("・")}` +
        `（選べるのは ${CONTRADICTION_CATEGORIES.join("・")}、` +
        `まとめて指す light・all）`
    );
  }

  // **並びは表の順に揃える。** 打った順で検証項目の並びが変わると、
  // 同じ組み合わせなのに違う結果が出て、測り比べられなくなる
  return CONTRADICTION_CATEGORIES.filter((name) => names.includes(name));
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
  /** `light`（既定）・`all`・区分名（1つ／並び／区切り文字つなぎ）。`categoriesOf` */
  categories?: string | readonly string[];
}

export function contradictionPrompt(input: ContradictionPromptInput): {
  promptVersion: string;
  systemPrompt: string;
  schema: unknown;
  /** 製品がこのプロンプトで使う温度（`prompts/*.ts`）。**写しを持たない** */
  temperature: number;
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
    temperature: CONTRADICTION_CHECK_TEMPERATURE,
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
      "応答を読み取れませんでした（矛盾検知のスキーマに沿っていません。JSONの形か、項目が合っていません）。"
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
  runner: RunnerKind;
  endpoint?: string;
  model?: string;
  allowRemote?: boolean;
  temperature?: number;
}

export async function contradictionRun(
  input: ContradictionRunInput
): Promise<RunOutcome<ContradictionChunkPrompt, ContradictionValidateResult>> {
  const prompts = contradictionPrompt(input);

  /*
    **ここはチャンクキャッシュを渡さない**（設計書6.87.17）。

    製品（`features/checkContradictions.ts`）の鍵には、材料の指紋・モデルの
    地力の印・**チャンクごとに渡す過去場面の抜粋**まで混ざっている。こちらは
    過去場面を送っていないので**プロンプトそのものが製品と違う**——同じ鍵で
    貯めると、製品が「過去場面つきで出した答え」と取り違える。指紋抜きの鍵で
    貯めれば取り違えはしないが、今度は拡張機能と永久に当たらない鍵が積み上がる。
    どちらも良くないので、揃えられるようになるまで貯めない。
  */
  // 行き先ごとの分岐は `runByRunner` が持つ（設計書6.87.12）
  return runByRunner(
    input,
    prompts,
    VALIDATE_WITH,
    (chunkId, responseText) =>
      validateAgainst(
        chunkId,
        chunkFromId(input.folder, chunkId),
        responseText
      ),
    ollamaGenerate
  );
}
