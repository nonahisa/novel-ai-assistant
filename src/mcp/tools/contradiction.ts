import {
  CONTRADICTION_CATEGORIES,
  CONTRADICTION_CHECK_SCHEMA,
  CONTRADICTION_CHECK_SYSTEM_PROMPT,
  CONTRADICTION_CHECK_SYSTEM_PROMPT_STRICT,
  CONTRADICTION_CHECK_TEMPERATURE,
  CONTRADICTION_CHECK_VERSION,
  CONTRADICTION_TOM_TOOLS,
  LIGHT_CATEGORIES,
  buildContradictionCheckPrompt,
  replyToContradictionToolCall,
  type ContradictionCategory,
} from "../../prompts/contradictionCheck";
import * as nodePath from "node:path";
import {
  buildKnownAtIndex,
  parseContradictionResult,
  validateContradictions,
  type AcceptedContradiction,
  type RejectedContradiction,
} from "../../core/contradictionValidation";
// 過去の場面の抜粋と検証の段は、製品と同じ組み立てを通す（2026-09-26）
import {
  appendVerifyNote,
  buildContradictionPastSceneIndex,
  buildContradictionVerifyUserPrompt,
  describeKnownAt,
  selectContradictionPastScenes,
} from "../../core/contradictionAssembly";
import { pastSceneMaxChars, type PastSceneIndex } from "../../core/pastSceneSelect";
import { excerptSourcesOfEpisode } from "../../core/excerptSourceOf";
import type { ExcerptSource } from "../../core/mentionExcerpts";
import { parseEpisodeFileName } from "../../core/episodeParser";
import { parseEpisodeMetadata } from "../../core/metadataParser";
import { isWorkInfoFile } from "../../core/workInfoFile";
import {
  CONTRADICTION_VERIFY_SCHEMA,
  CONTRADICTION_VERIFY_SYSTEM_PROMPT,
  CONTRADICTION_VERIFY_TEMPERATURE,
  type VerifyRejectReason,
} from "../../prompts/contradictionVerify";
import {
  describeVerifyResults,
  guardNotYetRevealed,
  parseVerifyOutcome,
  undecidedOutcome,
  type VerifyOutcome,
} from "../../core/contradictionVerifyValidation";
import { askSampling } from "./sampling";
import {
  buildContradictionTermIndex,
  carryOverBodyText,
  createContradictionMaterial,
  CARRY_OVER_DEFAULT_CHAPTERS,
  CARRY_OVER_MAX_CHAPTERS,
  type CarryOverResult,
  type ContradictionMaterial,
} from "../../core/contradictionMaterial";
import type { NarratorHint } from "../../core/narrator";
// 製品と同じ判定を使う（`notice.ts` も同じ所から読む。`vscode` へは届かない）
import { contradictionSpeechCheck } from "../../ai/capability";
import {
  buildStoryDateSources,
  describeStoryDates,
  readStoryDates,
  type StoryDate,
} from "../../core/storyCalendar";
import { worldviewMaxChars } from "../../core/worldviewSelect";
import { contextSizeForPrompt, withLineNumbers, type Chunk } from "../../core/chunker";
import { MIN_CHARS_PER_TOKEN_SAMPLES, resolveTokensPerChar } from "../../core/sizeBudget";
import { bundledTuningByKey } from "../../core/bundledTuning";
// 製品と同じ出力の見込み（`vscode` へは届かない。送る直前の関所と同じ値）
import { OUTPUT_RESERVE_TOKENS } from "../../ai/contextGuard";
import { parseCharacter, type Character } from "../../models/character";
import { parseLocation, type Location } from "../../models/location";
import {
  findLocationInconsistencies,
  placeLocationInconsistencies,
  type EpisodeText,
} from "../../core/locationConsistency";
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
  describeError,
  listBodyFiles,
  orderedEpisodeBodies,
  readBody,
  readSettingsFile,
  readSettingsRecords,
  selectChunks,
} from "./shared";
import { ollamaContextLength, ollamaGenerate } from "./ollama";
import {
  runByRunner,
  temperatureFor,
  type RunOutcome,
  type RunnerKind,
  validateWith,
  timeoutMsOf,
} from "./run";
import {
  decideModelSize,
  givenOptionNames,
  UNKNOWN_MODEL_SIZE_CHOICE,
  type ModelSizeDecision,
} from "./modelSize";

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
 * 呼ぶ側が選べる。指定が無ければ製品と同じ判定で決める（作者の裁定
 * 2026-10-10。`modelSize.ts`）——`novel.run` の ollama はモデルの申告の
 * 大きさから、大きさの分からない道は製品が大きいモデルへ送る形（all）。
 * 2026-10-09 までの既定 `light`＋`loose` は、製品のどの大きさとも一致しなかった。
 */
interface Settings {
  people: Character[];
  places: Location[];
  worldItems: WorldItem[];
  material: ContradictionMaterial;
  synopsesBefore(chapter: number | null): string;
  /**
   * 話ごとのあらすじ（設計書6.10.9）。**作中の日付を読むのに要る。**
   *
   * `synopsesBefore` は「その話より前」を文面へ組んだものなので、日付を
   * 読む材料には使えない——**その話自身のあらすじ**に日付が書かれている
   * ことが多い。
   */
  synopses: ReadonlyArray<{ chapter: number | null; synopsis: string }>;
  /**
   * **どの値が何話で分かるか**の索引（設計書6.10.5）。検証の段で使う。
   * 製品と同じ `buildKnownAtIndex` で組む
   */
  knownAt: Map<string, number[]>;
  unreadable: number;
}

/**
 * 設定資料を読んで、突き合わせる材料の組み立て役を作る。
 *
 * 世界観の上限は**モデルの上限に対する割合**で決める（設計書6.27.10）。
 * 固定字数のままだと、32kのモデルでは本文を1文字も足さないうちに溢れる。
 *
 * **割合を掛けるのはモデルの読める長さ（`contextWindow`）で、送る長さ（`numCtx`）
 * ではない**（作者の裁定 2026-10-11「製品と同じ量にそろえる」）。製品は
 * `worldviewMaxChars(info.contextWindow)` で決める。送る長さで掛けると、
 * 測定の台本がプロンプトに合わせて num_ctx を詰めるほど材料が細り、
 * 製品より少ない材料で測ることになる。分からなければ undefined（頭打ち）。
 */
function loadSettings(
  folder: string,
  contextWindow: number | undefined
): Settings {
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
    worldviewMax: worldviewMaxChars(contextWindow),
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
    // **読み取りは呼ぶ側でやる**（設計書6.10.9）。ここはあらすじを渡すだけで、
    // 日付を読むのは本文と一緒に1回だけ（作品ぜんぶで1度）
    synopses,
    knownAt: buildKnownAtIndex(people.records),
    unreadable: people.unreadable + places.unreadable + worldItems.unreadable,
  };
}

/**
 * 過去の場面を引く元の本文（設計書6.74）。**製品の `loadExcerptSources` と同じ割り方**
 * （`excerptSourcesOfEpisode`）を通す——合本は話ごとに分かれ、シーンメモは伏せる。
 *
 * 製品は作品の走査（`scanner.ts`）が並べた順に読む。ここはファイル名から同じ
 * 並び（種別 → 話数 → ファイル名）を作る。**日付で名付けた話の並びは写していない**
 * （走査は日付順に話数を振り直すが、MCP はファイル名の話数しか読まない）。
 *
 * 競合マーカーの残るファイルと作品情報（`about.txt`）は外す（製品と同じ）。
 *
 * **AIで再読込（`settingsEnrich.ts`）も使う**（2026-10-01）。製品の再読込も
 * 同じ `loadExcerptSources` から抜粋を集めるので、割り方の写しを作らない。
 */
export function pastSceneSourcesOf(folder: string): ExcerptSource[] {
  const kindOrder: Record<string, number> = {
    プロローグ: 0,
    本編: 1,
    幕間: 1,
    エピローグ: 2,
    不明: 3,
  };
  const files: Array<{ filePath: string; fileName: string; text: string }> = [];
  for (const filePath of listBodyFiles(folder)) {
    let text: string;
    try {
      text = readBody(folder, filePath);
    } catch {
      // 読めないファイルで止めない（競合マーカーのあるものもここ）
      continue;
    }
    const fileName = nodePath.basename(filePath);
    if (isWorkInfoFile(fileName, text)) continue;
    files.push({ filePath, fileName, text });
  }
  const episodes = files.map((file) => {
    const parsed = parseEpisodeFileName(file.fileName);
    const meta = parseEpisodeMetadata(file.text);
    return {
      file,
      episode: {
        filePath: file.filePath,
        fileName: file.fileName,
        metaTitle: meta.title,
        // ファイル名にサブタイトルが無ければメタデータのタイトルを使う（走査と同じ）
        subtitle: parsed.subtitle ?? meta.title,
        kind: parsed.kind,
        chapterStart: parsed.chapterStart,
        chapterEnd: parsed.chapterEnd,
      },
    };
  });
  episodes.sort((left, right) => {
    const ka = kindOrder[left.episode.kind] ?? 3;
    const kb = kindOrder[right.episode.kind] ?? 3;
    if (ka !== kb) return ka - kb;
    const na = left.episode.chapterStart;
    const nb = right.episode.chapterStart;
    if (na === null && nb === null) {
      return left.file.fileName.localeCompare(right.file.fileName, "ja");
    }
    if (na === null) return 1;
    if (nb === null) return -1;
    if (na !== nb) return na - nb;
    return left.file.fileName.localeCompare(right.file.fileName, "ja");
  });
  return episodes.flatMap(({ file, episode }) =>
    excerptSourcesOfEpisode(episode, file.text)
  );
}

/**
 * 材料（過去の場面・世界観）の予算と、それを決めた読める長さ
 * （作者の裁定 2026-10-11「製品と同じ量にそろえる」）。
 *
 * **送る長さ（`numCtx`）とは別物である。** 製品は材料の予算をモデルの読める
 * 長さ（`ModelInfo.contextWindow`＝申告と設定 `novelai.ollama.numCtx` の小さいほう）
 * で決め、送る `num_ctx` はでき上がったプロンプトの長さから決める
 * （`contextSizeForPrompt`）。MCP の `numCtx` は本文の切り方と送る長さを兼ねて
 * いるので、材料までそこへ連動させると、送る長さを詰めるほど材料が細る。
 *
 * 結果に載せる——**どの長さで材料を組んだのか**が記録に無いと、製品と同じ
 * 条件で測ったのかを後から確かめられない。
 */
export interface MaterialBudget {
  /** 材料の予算を決めた読める長さ（トークン）。分からなければ null（頭打ちを使う） */
  contextWindow: number | null;
  /**
   * - `given`……呼ぶ側が `contextWindow` で渡した
   * - `ollama`……手元の Ollama にモデルの申告を訊いた（`novel.run` の ollama）
   * - `unknown`……分からない。製品が長さを知らないときと同じ頭打ち
   */
  contextWindowSource: "given" | "ollama" | "unknown";
  /** 1チャンクに渡す過去の場面の上限（字。`pastSceneMaxChars`） */
  pastSceneChars: number;
  /** 世界観の上限（字。`worldviewMaxChars`） */
  worldviewChars: number;
}

function materialBudgetOf(
  contextWindow: number | undefined,
  source: MaterialBudget["contextWindowSource"]
): MaterialBudget {
  return {
    contextWindow: contextWindow ?? null,
    contextWindowSource: contextWindow === undefined ? "unknown" : source,
    pastSceneChars: pastSceneMaxChars(contextWindow),
    worldviewChars: worldviewMaxChars(contextWindow),
  };
}

/**
 * 呼ぶ側が渡した読める長さを読む。
 *
 * **文字列でも受ける**（`carryOverOf` と同じ理由。測定の台本は
 * `--option contextWindow=262144` の値を文字列のまま渡す）。
 * **知らない値は黙って丸めない**——丸めると、打ち間違いに気づかないまま
 * 「その長さで測った」記録が残る。
 */
function contextWindowOf(choice: number | string | undefined): number | undefined {
  if (choice === undefined) return undefined;
  if (typeof choice === "string" && choice.trim() === "") return undefined;
  const value = typeof choice === "number" ? choice : Number(String(choice).trim());
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new McpToolError(
      `contextWindow は1以上の整数（トークン）です: ${String(choice)}` +
        "（モデルの読める長さ。ollama.models の contextLength、" +
        "設定 novelai.ollama.numCtx で絞っているならその値）"
    );
  }
  return value;
}

/**
 * 過去の場面の索引と、1チャンクに渡せる字数（設計書6.74）。
 *
 * **字数はモデルの読める長さに対する割合**（製品と同じ `pastSceneMaxChars(contextWindow)`。
 * 長さの決め方は `materialBudgetOf`）。
 *
 * 0.102.12 までは送る長さ（`numCtx`）で掛けていた。測定の台本はプロンプトの
 * 長さから num_ctx を詰める（24,576 など）ので、抜粋が1,720〜2,293字に細り、
 * 製品（既定で6,000字）より少ない材料で測っていた（2026-10-11 の測定で、
 * 抜粋の量で答えが変わることを確かめた）。
 *
 * **意味の近さでは引かない。** 製品は作者が「検知にもベクトル検索を使う」を
 * 入れたときだけ意味でも引く（既定は切）。MCP は既定の側に揃える。
 *
 * **組めなくても続ける**（製品と同じ）。過去の場面は補助の材料である。
 */
interface PastSceneLookup {
  index: PastSceneIndex | undefined;
  maxChars: number;
}

function pastSceneLookupOf(
  folder: string,
  chunks: readonly Chunk[],
  budget: MaterialBudget
): PastSceneLookup {
  const maxChars = budget.pastSceneChars;
  try {
    return {
      index: buildContradictionPastSceneIndex(
        pastSceneSourcesOf(folder),
        chunks.map((chunk) => chunk.chapterStart)
      ),
      maxChars,
    };
  } catch (error) {
    process.stderr.write(
      `矛盾検知：過去の場面の索引を組めませんでした: ${describeError(error)}\n`
    );
    return { index: undefined, maxChars };
  }
}

/**
 * 問う区分を決める。
 *
 * **`light`・`all` のほかに、区分名そのものを受ける**（0.70.3）。
 * 作者の案（2026-09-19）：「クラウドの高位AIは節約、手元で動くローカルLLMでは
 * **手数を意識して組む**と良さそうですね」。手元では呼び出しが電気代だけなので、
 * **7区分を減らすのではなく、1区分ずつ分けて問う**道があり得る。
 * それを**測れるようにする**ための口である。
 *
 * 受ける形は3つ——1つの名前（`"状態"`）、並び（`["人物","状態"]`）、
 * 区切り文字でつないだもの（`"人物,状態"`）。**測定の台本から
 * `--option categories=状態` と打てる**ことを優先した。
 *
 * 指定が無いときの既定は、大きさの分からない道の既定（製品が大きいモデルへ
 * 送る形＝all。`UNKNOWN_MODEL_SIZE_CHOICE`）。`novel.run` の ollama では、
 * 製品と同じ判定で決めた値が指定として渡ってくる。
 */
function categoriesOf(
  choice: string | readonly string[] | undefined
): readonly ContradictionCategory[] {
  const fallback =
    UNKNOWN_MODEL_SIZE_CHOICE.categories === "light"
      ? LIGHT_CATEGORIES
      : CONTRADICTION_CATEGORIES;
  if (choice === undefined) return fallback;
  if (choice === "all") return CONTRADICTION_CATEGORIES;
  if (choice === "light") return LIGHT_CATEGORIES;

  const names = (Array.isArray(choice) ? choice : String(choice).split(/[,、・]/))
    .map((name) => name.trim())
    .filter((name) => name !== "");
  // 空文字だけを渡されたときは、黙って既定へ倒す（打ち間違いで止めない）
  if (names.length === 0) return fallback;

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
 * 呼ぶ側が選べる。指定が無ければ製品と同じ判定で決める（`categoriesOf` と
 * 同じ。`modelSize.ts`）。ここへ指定なしのまま来るのは大きさの分からない道で、
 * 製品が大きいモデルへ送る形（ゆるめた版）にする。
 *
 * **知らない値は黙って丸めない**（`categoriesOf`・`carryOverOf` と同じ）。
 * 丸めると、打ち間違いに気づかないまま「その抑制で測った」記録が残る。
 */
function suppressionOf(choice: string | undefined): Suppression {
  const name = choice === undefined ? "" : String(choice).trim();
  // 空文字だけを渡されたときは、黙って既定へ倒す（打ち間違いで止めない）
  if (name === "") return UNKNOWN_MODEL_SIZE_CHOICE.suppression;
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
  /**
   * 全話の本文（設計書6.10.9）。**作中の日付を読むのに要る。**
   *
   * **同じものを二度読まない**——引き継ぎ・落としたことを言う・日付の
   * 読み取りが、どれも全話の本文を見る。
   */
  bodies(): ReadonlyArray<{ chapter: number | null; text: string }>;
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
    bodies: bodiesOf,
  };
}

/**
 * 作中の日付（設計書6.10.9）。**作品ぜんぶで1回だけ読む。**
 *
 * **製品と同じ材料を渡す**（6.87.6 の3）。あらすじと本文の両方に日付が
 * 書かれているので、両方を繋いでから読む。
 */
function storyDatesOf(
  settings: Settings,
  carryOver: CarryOverLookup
): StoryDate[] {
  return readStoryDates(
    buildStoryDateSources(settings.synopses, carryOver.bodies())
  );
}

/**
 * そのチャンクへ渡す日付の欄。無ければ空文字。
 *
 * **その話より後の日付は渡さない**（設計書6.10.3。`synopsesBefore` と同じ
 * 基準）。**話数の読めないチャンクでは欄を出さない**——どこまでが「まだ
 * 分かっていないこと」かを決められない。
 */
function storyDatesFor(dates: readonly StoryDate[], chapter: number | null): string {
  if (chapter === null) return "";
  return describeStoryDates(dates, chapter);
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
  /**
   * **この話の語り手**（設計書6.10.6）。名指しできなければ null。
   *
   * 地の文の一人称と、材料に載った人物の一人称が**ちょうど1人だけ**
   * 一致するときに決まる（`core/narrator.ts`）。
   *
   * **決められなかったことも黙らない**（`missedCharacters` と同じ考え方）。
   * 一人称小説では、ここが null の回だけ「地の文の『俺』が誰か」を
   * 突き合わせずに答えを出していることになる。
   */
  narrator: NarratorHint | null;
  /**
   * **作中の日付**（設計書6.10.9）。読み取れなければ空文字。
   *
   * 本文とあらすじの「十月三日」のような表記をコードで読み取り、日数の差
   * まで数えた欄そのもの。**日付の引き算はAIにさせない**——答え付きの台の
   * 仕込みは、26bでも27bでも3回とも見逃した。
   *
   * **読み取れなかったことも黙らない**（`narrator` と同じ考え方）。ここが
   * 空の回は、経過日数を突き合わせずに出した答えである。
   */
  storyDates: string;
  /**
   * **前の話の関連場面の抜粋**（設計書6.74）。無ければ空文字。
   *
   * 製品は送っていたのに、MCP は 0.89.25 まで送っていなかった（2026-09-26 に揃えた）。
   * 引き方は製品と同じ関数（`selectContradictionPastScenes`）
   */
  pastScenes: string;
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
  /**
   * モデルの読める長さ（トークン）。**材料（過去の場面・世界観）の予算を決める**
   * （製品の `ModelInfo.contextWindow` と同じ意味。`MaterialBudget`）。
   *
   * 省くと、`novel.run` の ollama ではモデルの申告を訊き、ほかの道では
   * 頭打ち（製品が長さを知らないときと同じ）にする。設定
   * `novelai.ollama.numCtx` で絞っている作者の条件を写すときは、その値を渡す。
   * 文字列でも受ける（`contextWindowOf`）
   */
  contextWindow?: number | string;
}

export function contradictionMaterial(input: ContradictionMaterialInput): {
  settingsCount: { people: number; places: number; world: number };
  unreadableSettings: number;
  referenceBudgetChars: number;
  /** 材料の予算と、それを決めた読める長さ */
  budget: MaterialBudget;
  chunks: ContradictionChunkMaterial[];
} {
  const contextWindow = contextWindowOf(input.contextWindow);
  const budget = materialBudgetOf(contextWindow, "given");
  const settings = loadSettings(input.folder, contextWindow);
  const { chunks, maxChars } = chunksOfWorkFile(
    input.folder,
    input.filePath,
    input.numCtx
  );
  const carryOver = carryOverReader(input.folder, carryOverOf(input.carryOver));
  // **チャンクごとに読み直さない**（作品ぜんぶで1回。設計書6.10.9）
  const storyDates = storyDatesOf(settings, carryOver);
  // 過去の場面の索引も作品ぜんぶで1回だけ組む（製品と同じ）
  const pastScenes = pastSceneLookupOf(input.folder, chunks, budget);

  return {
    budget,
    settingsCount: {
      people: settings.people.length,
      places: settings.places.length,
      world: settings.worldItems.length,
    },
    unreadableSettings: settings.unreadable,
    referenceBudgetChars: settings.material.referenceBudgetChars,
    chunks: selectChunks(chunks, input.chunkIndex).map((chunk) =>
      materialForChunk(
        input.filePath,
        chunk,
        maxChars,
        settings,
        carryOver,
        storyDates,
        pastScenes
      )
    ),
  };
}

function materialForChunk(
  relative: string,
  chunk: Chunk,
  maxChars: number,
  settings: Settings,
  carryOver: CarryOverLookup,
  /** 作品ぜんぶで1回だけ読んだ日付（設計書6.10.9） */
  storyDates: readonly StoryDate[],
  /** 作品ぜんぶで1回だけ組んだ過去の場面の索引（設計書6.74） */
  pastScenes: PastSceneLookup
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
    narrator: relevant.narrator,
    // **まとめたチャンクは、いちばん前の話に合わせる**（`previousSynopses`
    // と同じ基準。設計書6.10.3）
    storyDates: storyDatesFor(storyDates, chunk.chapterStart),
    // **検索語は、この本文に出た名前**（引き継いだ前の話の名前ではない。製品と同じ）
    pastScenes: selectContradictionPastScenes(
      pastScenes.index,
      chunk,
      settings.material.namesIn(chunk.text),
      pastScenes.maxChars
    ).text,
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
  /**
   * 台詞の口調の食い違いまで探させたか（P-12 1.9）。`strict` では false。
   * **false の回の「矛盾なし」は、口調を見ていない**
   */
  speechCheck: boolean;
  /** 口調を照らさなかったことの断り。照らした回は空文字 */
  speechNote: string;
  /** 材料の予算と、それを決めた読める長さ（`MaterialBudget`） */
  materialBudget: MaterialBudget;
} {
  const contextWindow = contextWindowOf(input.contextWindow);
  const budget = materialBudgetOf(contextWindow, "given");
  const settings = loadSettings(input.folder, contextWindow);
  const { chunks, maxChars } = chunksOfWorkFile(
    input.folder,
    input.filePath,
    input.numCtx
  );
  const categories = categoriesOf(input.categories);
  const suppression = suppressionOf(input.suppression);
  /*
    **口調を照らすかは、製品と同じ関数で決める**（P-12 1.9）。送る側と
    返り値の `speechCheck`・`speechNote` が同じ値を見るので、「送っていないのに
    照らしたと返す」食い違いは起きない。
  */
  const speechCheck = contradictionSpeechCheck(suppression === "strict");
  const carryOver = carryOverReader(input.folder, carryOverOf(input.carryOver));
  // **チャンクごとに読み直さない**（作品ぜんぶで1回。設計書6.10.9）
  const storyDates = storyDatesOf(settings, carryOver);
  // 過去の場面の索引も作品ぜんぶで1回だけ組む（製品と同じ）
  const pastScenes = pastSceneLookupOf(input.folder, chunks, budget);

  const prompts: ContradictionChunkPrompt[] = [];
  const skipped: Array<{ chunkId: string; reason: string }> = [];
  for (const chunk of selectChunks(chunks, input.chunkIndex)) {
    const material = materialForChunk(
      input.filePath,
      chunk,
      maxChars,
      settings,
      carryOver,
      storyDates,
      pastScenes
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
        // **前の話の関連場面**（設計書6.74）。製品と同じ関数で引いたもの。
        // 無ければ空文字で、欄そのものが出ない
        pastScenes: material.pastScenes,
        // **日付の引き算はこちらで済ませて渡す**（設計書6.10.9）。
        // 読み取れなければ空文字で、欄そのものが出ない
        storyDates: material.storyDates,
        // **地の文の「俺」が誰かを名指しする**（設計書6.10.6）。
        // 名指しできなければ undefined で、欄そのものが出ない
        narrator: material.narrator ?? undefined,
        // **口調の指示は、抑制版と一対で外す**（P-12 1.9。製品と同じ関数で決める）
        speechCheck,
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
    speechCheck,
    speechNote: speechNoteFor(speechCheck),
    materialBudget: budget,
  };
}

/**
 * 口調を照らさなかった回の断り（MCP 向け）。照らした回は空文字。
 *
 * 作者向けの文（`describeSpeechCheckSkipped`）の「20B 以上を割り当てて」は、
 * MCP では呼ぶ側が `suppression` で選んでいるので当たらない。同じ判定の結果を、
 * 呼ぶ側が取れる操作で言い直す。
 */
function speechNoteFor(speechCheck: boolean): string {
  return speechCheck
    ? ""
    : "suppression: strict では、台詞の口調の食い違いを探させていません" +
        "（小さいモデルでは誤検出が多いため。製品も抑制を残すモデルでは同じ）。" +
        "口調も見るなら suppression を loose にしてください。";
}

export interface ContradictionValidateResult {
  chunkId: string;
  chapterLabel: string;
  accepted: AcceptedContradiction[];
  rejected: RejectedContradiction[];
  /**
   * 検証の段（P-12b）で取り下げた指摘（`novel.run` の ollama／sampling だけ）。
   * **黙って消さない**——何を根拠に消したのかが残らないと、見逃しなのか
   * 検証が消しすぎたのかを切り分けられない
   */
  verifyRejected?: Array<{
    excerpt: string;
    reason: VerifyRejectReason | "理由なし";
    explanation: string;
  }>;
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
  /** 1回の呼び出しを待つ秒数（`run.ts` の `RunnerContext.timeoutSeconds`） */
  timeoutSeconds?: number;
}

export async function contradictionRun(input: ContradictionRunInput): Promise<
  RunOutcome<ContradictionChunkPrompt, ContradictionValidateResult> & {
    /** 突き合わせなかった人物。**空でも欄は出す**（黙って落とさない） */
    missed: ContradictionMissedChunk[];
    /**
     * 台詞の口調の食い違いまで探させたか（P-12 1.9）。`runner` が `claude` 以外
     * だとプロンプトは返らないので、ここにも出す（`missed` と同じ理由）
     */
    speechCheck: boolean;
    /** 口調を照らさなかったことの断り。照らした回は空文字 */
    speechNote: string;
    /**
     * 検証の段（P-12b）の結果の一言（`describeVerifyResults`。製品のログと同じ文）。
     * `claude` では検証を通していないことを断る
     */
    verifyNote: string;
    /** 観点と抑制をどう決めたか（製品と同じ判定か、指定に従ったか） */
    modelSizeDecision: ModelSizeDecision;
    /** 材料（過去の場面・世界観）の予算と、それを決めた読める長さ */
    materialBudget: MaterialBudget;
  }
> {
  /*
    **指定が無ければ、製品と同じ判定で観点と抑制を決める**（作者の裁定 2026-10-10）。
    指定はそれぞれ別に効く——観点だけを振って比べる測定の道を残す
  */
  const sized = await decideModelSize(
    input,
    givenOptionNames({ categories: input.categories, suppression: input.suppression }),
    ["categories", "suppression"]
  );
  const given = sized.decision.given;
  /*
    **材料の予算は、製品と同じくモデルの読める長さで決める**（作者の裁定
    2026-10-11「製品と同じ量にそろえる」。`MaterialBudget`）。渡されていなければ、
    手元の Ollama ではモデルの申告を訊く（製品の `showModel` と同じ欄）。
  */
  const window = await resolveContextWindow(input);
  const materialBudget = materialBudgetOf(window.contextWindow, window.source);
  const prompts = contradictionPrompt({
    ...input,
    contextWindow: window.contextWindow,
    categories: given.includes("categories") ? input.categories : sized.choice.categories,
    suppression: given.includes("suppression")
      ? input.suppression
      : sized.choice.suppression,
  });
  /*
    **材料を増やしたぶん、送る num_ctx に入らなくなっていないかを、送る前に見る**
    （CLAUDE.md 規則6）。製品は送る num_ctx をでき上がったプロンプトの長さから
    決めるが、MCP の `numCtx` は呼ぶ側が決めた値をそのまま送る。入らないまま
    送ると、Ollama は**黙って入力を切り捨てる**。
  */
  if (input.runner === "ollama") {
    assertPromptsFitNumCtx(prompts, input.numCtx, input.model, window.contextWindow);
  }

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
    地力の印・**チャンクごとに渡す過去場面の抜粋**まで混ざっている。過去場面は
    2026-09-26 から製品と同じ関数で引いて送るようになったが、材料の指紋と
    地力の印はここで組んでいない（地力はモデルの素性から決まり、MCP は知らない）。
    指紋抜きの鍵で貯めると、拡張機能と永久に当たらない鍵が積み上がるので、
    揃えられるようになるまで貯めない。
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
    /*
      **道具も製品と同じものを渡す**（設計書6.87.12 の「製品と同じ経路で測る」）。

      道具の説明はモデルの一覧に常在して、呼ばれなくても読まれる
      （unused-tool 効果）。ここで渡さないと、**製品とは違うものを測った**
      ことになる。受け答え（1往復）も製品と同じ関数を使う。
    */
    (params) =>
      ollamaGenerate({
        ...params,
        tools: CONTRADICTION_TOM_TOOLS,
        toolReply: replyToContradictionToolCall,
      })
  );
  const extras = {
    missed,
    speechCheck: prompts.speechCheck,
    speechNote: prompts.speechNote,
    modelSizeDecision: sized.decision,
    materialBudget,
  };
  if (outcome.runner === "claude") {
    // **2段のうち1段しか渡せないことを黙らない**（`factContradiction` と同じ）
    return {
      ...outcome,
      note: `${outcome.note} ${VERIFY_SKIPPED_NOTE}`,
      ...extras,
      verifyNote: VERIFY_SKIPPED_NOTE,
    };
  }

  /*
    **検証の段（P-12b、設計書6.10.5）を製品と同じく通す**（2026-09-26）。

    本文を読む段は1回で何十行も見るので、1件ずつを吟味する余裕が無い。
    製品は見つけた指摘を1件だけ見せて問い直し、取り下げたものを出さない。
    ここを通さないと、**MCP で測った誤検出の数が製品の数ではない**。
  */
  const verified = await verifyContradictionResults(input, prompts, outcome.results);
  return {
    ...outcome,
    results: verified.results,
    ...extras,
    verifyNote: verified.note,
  };
}

/**
 * 材料の予算を決める読める長さ（`MaterialBudget`）。
 *
 * 1. 呼ぶ側が `contextWindow` を渡した → それ（設定で絞っている作者の条件も写せる）
 * 2. `runner: ollama` でモデル名がある → `/api/show` の申告（製品と同じ欄）
 * 3. どちらも無い → 分からない（頭打ち。製品が長さを知らないときと同じ）
 *
 * **訊けなくても止めない**（`decideModelSize` の大きさの問い合わせと同じ構え）。
 * 繋がらなければ、本文を送る段が理由つきで断る。
 */
async function resolveContextWindow(input: ContradictionRunInput): Promise<{
  contextWindow: number | undefined;
  source: MaterialBudget["contextWindowSource"];
}> {
  const given = contextWindowOf(input.contextWindow);
  if (given !== undefined) return { contextWindow: given, source: "given" };
  if (input.runner !== "ollama" || !input.model) {
    return { contextWindow: undefined, source: "unknown" };
  }
  let declared: number | null = null;
  try {
    declared = await ollamaContextLength({ endpoint: input.endpoint, model: input.model });
  } catch {
    // 単体テストが `./ollama` を差し替えてこの関数を持たせていないときもここで受ける
    declared = null;
  }
  return declared === null || declared <= 0
    ? { contextWindow: undefined, source: "unknown" }
    : { contextWindow: declared, source: "ollama" };
}

/**
 * いちばん長いプロンプトが、送る `num_ctx` に入るか（CLAUDE.md 規則6）。
 *
 * **見積りは製品と同じ係数で行う**——同梱の字/トークンがあればそれを
 * （`resolveTokensPerChar`。製品も台帳が空なら同梱の値を、しきい値を満たす
 * 件数を添えて読む）、無ければ当て推量の0.7字/トークン。
 *
 * **断るのは入力だけで溢れるとき**（出力の分までは断らない）。`numCtx` は
 * VRAM に載る上限を探るために作者が意図して固定する道でもあり、出力の余白
 * まで求めると、その測り方ができなくなる。出力が足りなかったときは、途中で
 * 切れた答えとして検算が知らせる（`validateNoting`）。
 */
function assertPromptsFitNumCtx(
  prompts: { systemPrompt: string; chunks: readonly ContradictionChunkPrompt[] },
  numCtx: number,
  model: string | undefined,
  contextWindow: number | undefined
): void {
  const longest = prompts.chunks.reduce(
    (max, chunk) => Math.max(max, prompts.systemPrompt.length + chunk.userPrompt.length),
    0
  );
  if (longest === 0) return;
  const bundled = model ? bundledTuningByKey(`ollama/${model}`) : undefined;
  const measured =
    bundled?.charsPerToken !== undefined
      ? {
          charsPerToken: bundled.charsPerToken,
          charsPerTokenSamples: MIN_CHARS_PER_TOKEN_SAMPLES,
        }
      : undefined;
  const inputTokens = Math.ceil(longest * resolveTokensPerChar(measured));
  if (inputTokens <= numCtx) return;
  // 製品なら送る長さ（出力の見込みと1割の余裕込み）。これを案内する
  const suggested = contextSizeForPrompt({
    promptChars: longest,
    outputTokens: OUTPUT_RESERVE_TOKENS,
    contextWindow: contextWindow ?? Number.MAX_SAFE_INTEGER,
    measured,
  });
  throw new McpToolError(
    `いちばん長いプロンプト（${longest}字、見込み ${inputTokens} トークン）が ` +
      `numCtx ${numCtx} に入りません。このまま送ると、Ollama は num_ctx を超えた入力を黙って切り捨てます。` +
      `numCtx を ${suggested} 以上にしてください（製品はプロンプトの長さからこの値を決めます）。` +
      "過去の場面と世界観の量は、送る長さではなくモデルの読める長さ（contextWindow）で決めています。"
  );
}

/** `claude` の道では検証の段を通せないことの断り */
const VERIFY_SKIPPED_NOTE =
  "この道では、見つけた指摘を1件ずつ問い直す検証の段（P-12b）を通していません" +
  "（製品は通します）。製品と同じ数を測るなら runner を ollama か sampling にしてください。";

/**
 * 検証の段を回す（製品の `verify` と同じプロンプト・同じ読み方）。
 *
 * **判定できなかったら通す。** 通信の失敗や読めない答えで本物の指摘を消さない
 * （製品と同じ）。
 */
async function verifyContradictionResults(
  input: ContradictionRunInput,
  prompts: ReturnType<typeof contradictionPrompt>,
  results: readonly ContradictionValidateResult[]
): Promise<{ results: ContradictionValidateResult[]; note: string }> {
  const ask = verifyAskerOf(input);
  const temperature = temperatureFor(input, CONTRADICTION_VERIFY_TEMPERATURE);
  // 検証で使うのは `knownAt` だけだが、長さは本文を読む段と同じものを渡す
  // （値を2系統にしない）
  const settings = loadSettings(input.folder, prompts.materialBudget.contextWindow ?? undefined);
  const labelOf = new Map(
    prompts.chunks.map((chunk) => [chunk.chunkId, chunk.chapterLabel])
  );
  const verifyRejected: Array<{ reason?: VerifyRejectReason }> = [];
  let undecided = 0;
  // 却下を受け取らずに残した数（製品と同じく「検証できず」とは分けて言う）
  let overruled = 0;

  const out: ContradictionValidateResult[] = [];
  for (const result of results) {
    const chunk = chunkFromId(input.folder, result.chunkId);
    const kept: AcceptedContradiction[] = [];
    const dropped: NonNullable<ContradictionValidateResult["verifyRejected"]> = [];
    for (const issue of result.accepted) {
      let outcome: VerifyOutcome;
      try {
        const reply = await ask({
          systemPrompt: CONTRADICTION_VERIFY_SYSTEM_PROMPT,
          userPrompt: buildContradictionVerifyUserPrompt({
            chapterLabel: labelOf.get(result.chunkId) ?? result.chapterLabel,
            chunk,
            issue,
            settingKnownAt: describeKnownAt(settings.knownAt, issue.settingSays),
          }),
          schema: CONTRADICTION_VERIFY_SCHEMA,
          temperature,
        });
        // 「まだ明かされていない」の却下は話数の裏付けを確かめる（製品と同じ、
        // 2026-10-16）。MCP には逆向き（あとで判明する事実）の段が無いので、
        // 指摘はみなその話の時点の材料で見つけたものである
        outcome = guardNotYetRevealed(
          parseVerifyOutcome(reply.text),
          settings.knownAt,
          issue.settingSays,
          chunk.chapterStart
        );
      } catch (error) {
        outcome = undecidedOutcome(`検証できませんでした（${describeError(error)}）`);
      }
      if (outcome.undecided) undecided++;
      if (outcome.overruled) overruled++;
      if (!outcome.keep) {
        verifyRejected.push({ reason: outcome.reason });
        dropped.push({
          excerpt: issue.excerpt,
          reason: outcome.reason ?? "理由なし",
          explanation: outcome.explanation,
        });
        continue;
      }
      // 検証で分かったことは、作者の判断材料になる（製品と同じ）
      kept.push({ ...issue, note: appendVerifyNote(issue.note, outcome.explanation) });
    }
    out.push({ ...result, accepted: kept, verifyRejected: dropped });
  }
  return { results: out, note: describeVerifyResults(verifyRejected, undecided, overruled) };
}

/** 行き先を1つの呼び方に揃える（`runByRunner` は2段に分かれた道を回せない） */
function verifyAskerOf(
  input: ContradictionRunInput
): (params: {
  systemPrompt: string;
  userPrompt: string;
  schema: unknown;
  temperature: number;
}) => Promise<{ text: string }> {
  if (input.runner === "sampling") {
    return async (params) => {
      const reply = await askSampling({
        folder: input.folder,
        systemPrompt: params.systemPrompt,
        userPrompt: params.userPrompt,
        temperature: params.temperature,
      });
      return { text: reply.text };
    };
  }
  const model = input.model;
  if (!model) {
    throw new McpToolError("runner が ollama のときは model が要ります。");
  }
  return async (params) =>
    ollamaGenerate({
      endpoint: input.endpoint,
      model,
      systemPrompt: params.systemPrompt,
      userPrompt: params.userPrompt,
      schema: params.schema,
      numCtx: input.numCtx,
      allowRemote: input.allowRemote,
      timeoutMs: timeoutMsOf(input.timeoutSeconds),
      temperature: params.temperature,
    });
}

/**
 * 場所の位置関係の食い違いを、AIを使わずに挙げる（設計書6.93.4。
 * 設計書での名前は `contradiction.detectLocations`、口は `novel.detect` の
 * feature: contradiction）。
 *
 * **AIが要らない判断は、AIに訊かない。** 含む関係の輪・方角の非対称・
 * 距離の食い違いは、設定資料の場所の関係だけで決まる。判定は製品と同じ
 * `core/locationConsistency.ts` を通す（写しを作らない）。何も書き換えない。
 */
export function contradictionDetectLocations(input: { folder: string }) {
  const read = readSettingsRecords(
    input.folder,
    SETTINGS_SUBDIRS.locations,
    parseLocation
  );
  const found = findLocationInconsistencies(read.records);

  /*
    **本文の行は、ファイルの全文で数える。** 合本を話ごとに割った本文
    （`orderedEpisodeBodies`）で数えると、2話目以降の行番号がファイルの
    行とずれ、飛ぶ先が違う所になる
  */
  const episodes: EpisodeText[] = [];
  if (found.length > 0) {
    for (const filePath of listBodyFiles(input.folder)) {
      let text: string;
      try {
        text = readBody(input.folder, filePath);
      } catch {
        // 読めないファイル（競合マーカーのあるものも）は探さない。製品と同じ
        continue;
      }
      const fileName = nodePath.basename(filePath);
      if (isWorkInfoFile(fileName, text)) continue;
      const parsed = parseEpisodeFileName(fileName);
      episodes.push({
        filePath,
        text,
        chapterStart: parsed.chapterStart,
        chapterEnd: parsed.chapterEnd,
      });
    }
  }
  const placed = placeLocationInconsistencies(found, episodes);

  return {
    inconsistencies: found.map((inconsistency) => ({
      kind: inconsistency.kind,
      summary: inconsistency.summary,
      statements: inconsistency.statements.map((statement) => ({
        location: statement.locationName,
        relation: statement.text,
        chapters: statement.relation.chapters,
        evidence: statement.relation.evidence,
        /** 地域の欄を「中」として読み替えたもの（直す先は地域の欄） */
        fromRegion: statement.fromRegion,
      })),
    })),
    /**
     * 提案パネルへ置くときと同じ形（飛ぶ先の行・並べる2つの記述）。
     * **本文のどこにも置けなかったものは `unplaced` の件数に入る**
     */
    issues: placed.issues,
    unplaced: placed.unplaced.length,
    /** 読めなかった場所のファイル。**照合の外に置いたことを隠さない** */
    unreadable: read.unreadableFiles,
    note:
      "判定はAIを使わず、設定資料の場所の位置関係（含む・方角・距離）だけで行っています。" +
      "隣接と距離は突き合わせず、読めない方角・距離（「上流」「数日」など）は比べていません。" +
      "何も書き換えていません。",
  };
}
