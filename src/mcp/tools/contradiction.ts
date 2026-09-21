import {
  CONTRADICTION_CATEGORIES,
  CONTRADICTION_CHECK_SCHEMA,
  CONTRADICTION_CHECK_SYSTEM_PROMPT,
  CONTRADICTION_CHECK_SYSTEM_PROMPT_STRICT,
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
  carryOverBodyText,
  createContradictionMaterial,
  CARRY_OVER_DEFAULT_CHAPTERS,
  CARRY_OVER_MAX_CHAPTERS,
  type CarryOverResult,
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
  orderedEpisodeBodies,
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

/**
 * 前の話を何話ぶん引き継ぐか（設計書6.10.6）。
 *
 * **既定は製品と同じ2話**（`CARRY_OVER_DEFAULT_CHAPTERS`。0.73.3）。
 * 0.70.5 では0＝引き継がないだったが、測ってから作者が既定にした
 * （6.102「測ってから言う」）。**MCP の既定を製品と揃えておかないと、
 * `novel.prompt` で覗いたものと画面が実際に送るものが別物になる**
 * ——外部AIに「製品と同じ経路で測る」と言えなくなる。引き継がない動きは
 * `carryOver: 0` と明示して指す。
 *
 * **文字列でも受ける。** 測定の台本（`scripts/measure.mjs`）は
 * `--option carryOver=2` の値を**文字列のまま**渡す——数だけを受けると、
 * 台本から一度も指定できない口になる。
 *
 * **知らない値は黙って丸めない**（`categoriesOf` と同じ）。丸めると、
 * 打ち間違いに気づかないまま「その話数で測った」記録が残る。
 */
function carryOverOf(choice: number | string | undefined): number {
  if (choice === undefined) return CARRY_OVER_DEFAULT_CHAPTERS;
  const value = typeof choice === "number" ? choice : Number(String(choice).trim());
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new McpToolError(
      `carryOver は0以上の整数です: ${String(choice)}` +
        `（0＝引き継がない、${CARRY_OVER_MAX_CHAPTERS}まで）`
    );
  }
  if (value > CARRY_OVER_MAX_CHAPTERS) {
    throw new McpToolError(
      `carryOver は${CARRY_OVER_MAX_CHAPTERS}話までです: ${value}` +
        "（材料が膨らみすぎるため）"
    );
  }
  return value;
}

/**
 * 抑制の強さ（設計書6.10.8）。`loose`＝ゆるめた 1.6 の既定、
 * `strict`＝1.5 までの抑制を残した版。
 */
type Suppression = "loose" | "strict";

/**
 * 抑制の強さを決める。
 *
 * **MCP の既定はゆるめた版である。** 製品はモデルの大きさから自動で決める
 * （`ai/capability.ts`）が、**MCP は外部AIが自分でモデルを選ぶ**ので、
 * こちらから大きさを当てにいかない。呼ぶ側に選ばせる。
 *
 * **知らない値は黙って丸めない**（`categoriesOf`・`carryOverOf` と同じ）。
 * 丸めると、打ち間違いに気づかないまま「その抑制で測った」記録が残る。
 */
function suppressionOf(choice: string | undefined): Suppression {
  if (choice === undefined) return "loose";
  const name = String(choice).trim();
  // 空文字だけを渡されたときは、黙って既定へ倒す（打ち間違いで止めない）
  if (name === "") return "loose";
  if (name === "loose" || name === "strict") return name;
  throw new McpToolError(
    `知らない抑制の強さです: ${name}` +
      "（選べるのは loose＝疑わしい箇所も挙げさせる・strict＝確信の持てないものは挙げさせない）"
  );
}

/**
 * 選んだ抑制を、版に出す（`promptVersionWithCarryOver` と同じ作法）。
 *
 * **測り直す人が、どちらで測ったのか分かるようにする。** 同じ 1.6 でも
 * 送っている原則1が違うので、版が同じままだと記録を並べたときに
 * 見分けられない。
 *
 * **ゆるめた側には印を付けない**——新しい既定なので、`1.6` はゆるめた版を
 * 指す（キャッシュの鍵の印を `capabilityCacheTag` がそう決めているのと同じ）。
 */
function promptVersionWithSuppression(
  promptVersion: string,
  suppression: Suppression
): string {
  return suppression === "strict" ? `${promptVersion}:strict` : promptVersion;
}

/** 空の引き継ぎ。**同じ形を返す**（呼ぶ側に分岐を増やさない） */
const NO_CARRY_OVER: CarryOverResult = { chapters: [], text: "" };

/** 前の話の本文の引き方（材料へ載せる用と、落としたことを言う用） */
interface CarryOverLookup {
  /** 材料へ載せるために引き継ぐ本文。`carryOver` が0なら空 */
  carried(chapter: number | null): CarryOverResult;
  /**
   * **直前の1話の本文**（設計書6.10.6の「落としたことを言う」）。
   *
   * **材料には入らない。** 落とした人物を数えるためだけに見るので、
   * `carryOver` の指定に関わらず**必ず1話ぶん**を引く。
   */
  previous(chapter: number | null): string;
}

/**
 * チャンクの話数から、前の話の本文を引く役を作る。
 *
 * 本文の並べ方は既存の作法（`orderedEpisodeBodies`）に合わせる——**写しを
 * 作らない**。合本（1ファイルに何話も）は中の話ごとに分かれて返るので、
 * 「前の話」も合本の中から採れる。
 *
 * **本文は遅れて1回だけ読む。** 引き継ぎ（`carryOver`）と落とした人物の
 * 検出が同じものを見るので、別々に読むと話数ぶんのファイルを二度読む。
 */
function carryOverReader(folder: string, chapters: number): CarryOverLookup {
  let bodies: Array<{ chapter: number | null; text: string }> | undefined;
  const bodiesOf = () => {
    if (bodies === undefined) {
      bodies = orderedEpisodeBodies(folder).map((episode) => ({
        chapter: episode.chapter,
        text: episode.body,
      }));
    }
    return bodies;
  };
  return {
    carried(chapter) {
      if (chapters <= 0) return NO_CARRY_OVER;
      return carryOverBodyText({ bodies: bodiesOf(), chapter, chapters });
    },
    previous(chapter) {
      return carryOverBodyText({ bodies: bodiesOf(), chapter, chapters: 1 })
        .text;
    },
  };
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
  /**
   * 人物を探すために引き継いだ話数（設計書6.10.6）。`carryOver` が0なら空。
   *
   * **足したことを黙らない。** どの話を引き継いだのかが見えないと、
   * 「載るようになった人物」がどこから来たのか測りようがない。
   */
  carriedOverChapters: number[];
  /**
   * 直前の話には名前が出ているのに、この材料に載らなかった人物
   * （設計書6.10.6「落としたことを言う」）。
   *
   * **落としたことを黙らない**（`skipped` と同じ考え方）。材料が落ちても
   * 結果は「矛盾なし」と出るので、**突き合わせていないのか、突き合わせて
   * 問題が無かったのか**が呼ぶ側に区別できない。
   */
  missedCharacters: string[];
}

export interface ContradictionMaterialInput {
  folder: string;
  filePath: string;
  numCtx: number;
  chunkIndex?: number;
  /**
   * 前の話を何話ぶん引き継ぐか（設計書6.10.6）。既定0＝引き継がない。
   * 文字列でも受ける（`carryOverOf`）
   */
  carryOver?: number | string;
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
  const carryOver = carryOverReader(input.folder, carryOverOf(input.carryOver));

  return {
    settingsCount: {
      people: settings.people.length,
      places: settings.places.length,
      world: settings.worldItems.length,
    },
    unreadableSettings: settings.unreadable,
    referenceBudgetChars: settings.material.referenceBudgetChars,
    chunks: selectChunks(chunks, input.chunkIndex).map((chunk) =>
      materialForChunk(input.filePath, chunk, maxChars, settings, carryOver)
    ),
  };
}

function materialForChunk(
  relative: string,
  chunk: Chunk,
  maxChars: number,
  settings: Settings,
  carryOver: CarryOverLookup
): ContradictionChunkMaterial {
  // **引き継ぐのは人物を索引で見つけるためだけ**（設計書6.10.6）。
  // この本文そのものはプロンプトへ入らない
  const carried = carryOver.carried(chunk.chapterStart);
  const relevant = settings.material.relevantFor(
    chunk.text,
    chunk.chapterStart,
    {
      carryOverText: carried.text,
      // **落としたことを言うためだけに見る**（6.10.6）。材料は変わらない
      previousBodyText: carryOver.previous(chunk.chapterStart),
    }
  );
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
    // **検索語は引き継がない**（設計書6.74）。過去の場面を引く語は
    // 「この本文に出た名前」であって、前の話に出た名前ではない
    names: settings.material.namesIn(chunk.text),
    carriedOverChapters: carried.chapters,
    missedCharacters: relevant.missedCharacters,
  };
}

export interface ContradictionChunkPrompt {
  chunkId: string;
  index: number;
  chapterLabel: string;
  chars: number;
  userPrompt: string;
  /**
   * 人物を探すために引き継いだ話数（設計書6.10.6）。`carryOver` が0なら空。
   *
   * **`run` の記録にも残す。** どの回が引き継ぎありだったのかが、
   * あとから測り直す人に分からなくなる
   */
  carriedOverChapters: number[];
  /**
   * 直前の話には名前が出ているのに、この材料に載らなかった人物
   * （設計書6.10.6「落としたことを言う」）。
   *
   * **穴は塞がない。** ここが空でない回は、その人物を**突き合わせずに**
   * 出した答えである——外部AIが「矛盾なし」をそのまま受け取らないよう、
   * プロンプトと一緒に返す。
   */
  missedCharacters: string[];
}

export interface ContradictionPromptInput extends ContradictionMaterialInput {
  /** `light`（既定）・`all`・区分名（1つ／並び／区切り文字つなぎ）。`categoriesOf` */
  categories?: string | readonly string[];
  /**
   * 抑制の強さ（設計書6.10.8）。`loose`（既定）・`strict`。`suppressionOf`
   *
   * **文字列で受ける**（`carryOver` と同じ理由）。測定の台本
   * （`scripts/measure.mjs`）は `--option suppression=strict` の値を
   * 文字列のまま渡す。
   */
  suppression?: string;
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
  const suppression = suppressionOf(input.suppression);
  const carryOver = carryOverReader(input.folder, carryOverOf(input.carryOver));

  const prompts: ContradictionChunkPrompt[] = [];
  const skipped: Array<{ chunkId: string; reason: string }> = [];
  for (const chunk of selectChunks(chunks, input.chunkIndex)) {
    const material = materialForChunk(
      input.filePath,
      chunk,
      maxChars,
      settings,
      carryOver
    );
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
      carriedOverChapters: material.carriedOverChapters,
      missedCharacters: material.missedCharacters,
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
    promptVersion: promptVersionWithSuppression(
      CONTRADICTION_CHECK_VERSION,
      suppression
    ),
    systemPrompt:
      suppression === "strict"
        ? CONTRADICTION_CHECK_SYSTEM_PROMPT_STRICT
        : CONTRADICTION_CHECK_SYSTEM_PROMPT,
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

/**
 * 突き合わせずに済ませたところ（設計書6.10.6「落としたことを言う」）。
 *
 * **`skipped` と同じ考え方で、`run` の結果にも出す。** `runner: claude` なら
 * プロンプトに付いて返るが、`ollama`・`sampling` は検算した結果しか返さない
 * ので、ここに出さないと**落ちたことが外部AIに一切届かない**。
 */
export interface ContradictionMissedChunk {
  chunkId: string;
  chapterLabel: string;
  /** 直前の話には名前が出ているのに、材料へ載らなかった人物 */
  missedCharacters: string[];
}

export interface ContradictionRunInput extends ContradictionPromptInput {
  runner: RunnerKind;
  endpoint?: string;
  model?: string;
  allowRemote?: boolean;
  temperature?: number;
}

export async function contradictionRun(input: ContradictionRunInput): Promise<
  RunOutcome<ContradictionChunkPrompt, ContradictionValidateResult> & {
    /** 突き合わせなかった人物。**空でも欄は出す**（黙って落とさない） */
    missed: ContradictionMissedChunk[];
  }
> {
  const prompts = contradictionPrompt(input);

  /*
    **落としたことを言う**（設計書6.10.6）。

    材料が落ちても結果は「矛盾なし」と出るので、受け取った側には
    **突き合わせていないのか、突き合わせて問題が無かったのか**が区別
    できない。AIを呼ぶ前に決まっている話なので、ここで数えて返す。
  */
  const missed: ContradictionMissedChunk[] = prompts.chunks
    .filter((chunk) => chunk.missedCharacters.length > 0)
    .map((chunk) => ({
      chunkId: chunk.chunkId,
      chapterLabel: chunk.chapterLabel,
      missedCharacters: chunk.missedCharacters,
    }));

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
  const outcome = await runByRunner(
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
  return { ...outcome, missed };
}
