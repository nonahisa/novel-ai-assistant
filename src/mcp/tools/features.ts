import { z } from "zod";
import {
  CHUNKED_FEATURES,
  DETECT_FEATURES,
  FEATURE_LABELS,
  FEATURE_NAMES,
  FILE_TARGET_FEATURES,
  MATERIAL_FEATURES,
  featureListText,
  type FeatureName,
} from "../../core/mcpFeatures";
import {
  FOLDER_INPUT,
  McpToolError,
  OLLAMA_INPUT,
  RUNNER_INPUT,
} from "./shared";
import { assertRunner, responseInput, type RunnerKind } from "./run";
import { typoPrompt, typoRun, typoValidate } from "./typo";
import { proofreadPrompt, proofreadRun, proofreadValidate } from "./proofread";
import {
  NOTATION_GROUP_SCHEMA,
  notationDetect,
  notationPrompt,
  notationRun,
  notationValidate,
} from "./notation";
import {
  contradictionMaterial,
  contradictionPrompt,
  contradictionRun,
  contradictionValidate,
} from "./contradiction";
import {
  factContradictionPrompt,
  factContradictionRun,
  factContradictionValidate,
} from "./factContradiction";
import {
  foreshadowPrompt,
  foreshadowRun,
  foreshadowValidate,
  type ForeshadowMode,
} from "./foreshadow";
import {
  deviationPrompt,
  deviationRun,
  deviationValidate,
  episodePlotPrompt,
  episodePlotRun,
  episodePlotValidate,
  synopsisPrompt,
  synopsisRun,
  synopsisValidate,
} from "./episode";
import { settingsPrompt, settingsRun, settingsValidate } from "./settings";
import {
  plotReversePrompt,
  plotReverseRun,
  plotReverseValidate,
} from "./plot";
import { chapterPrompt, chapterRun, chapterValidate } from "./chapter";
import {
  blurbPrompt,
  blurbRun,
  blurbValidate,
  catchphrasePrompt,
  catchphraseRun,
  catchphraseValidate,
} from "./blurb";
import { openingPrompt, openingRun, openingValidate } from "./opening";
import {
  NAME_ORIGIN_SCHEMA,
  nameCollisions,
  namePrompt,
  nameRun,
  nameValidate,
} from "./name";
import {
  CHAT_ADVICE_ANSWERS_SCHEMA,
  CHAT_HISTORY_SCHEMA,
  CHAT_WRITER_STYLE_SCHEMA,
  chatPrompt,
  chatRun,
  chatValidate,
} from "./chat";

/**
 * 束ねた道具の中身（設計書6.87.15 の柱1。0.66.7）。
 *
 * **入口を束ねただけで、仕事は今までどおり。** `tools/*.ts` のハンドラは
 * 1文字も書き換えていない——ここは受け取った引数を、**それぞれのハンドラが
 * 今まで受け取っていた形に組み直して渡すだけ**である。プロンプトも検算も
 * 変わらないので、測った数字も変わらない（変わったら束ね方が間違っている）。
 *
 * **入力の形を厳密にしすぎない。** feature ごとに `oneOf` で分けると、
 * 一覧が束ねる前より大きくなる（束ねた目的は一覧を小さくすることだった）。
 * **共通の形＋`options`** にして、**検証はここで行う**——`assertRunner` が
 * 「runner は省略できません」と断るのと同じ考えである。
 *
 * **足りない引数は、名前を挙げて断る。** 黙って既定値を入れると、
 * 呼んだ側は**別のものを測ったことに気づけない**。
 */

/* ── 入力の形 ─────────────────────────────────────────── */

/**
 * 数の上限。**形を小さく保つためであって、作品の大きさを決めるものではない。**
 *
 * どれも「人が書く小説では、まずここまで行かない」ところに置いてある。
 * 上限そのものに意味は無いので、足りなくなったら上げてよい。
 */
const MAX_CHAPTER = 100_000;
const MAX_CHUNK_INDEX = 100_000;
const MAX_NUM_CTX = 10_000_000;

/**
 * どの機能か。
 *
 * **名前の意味を書くのは `novel.run` の1本だけ**にしてある（`options` と
 * 同じ理由）。16の呼び名を3本に写すと、それだけで千字に届く——一覧は
 * 1度にぜんぶ届くので、隣の道具を指すほうが確かである。
 */
const FEATURE_INPUT = {
  feature: z
    .enum(FEATURE_NAMES)
    .describe("どの機能か。名前の意味は novel.run の feature にあります"),
};

const FEATURE_INPUT_WITH_LABELS = {
  feature: z
    .enum(FEATURE_NAMES)
    .describe(`どの機能か。${featureListText(FEATURE_NAMES)}`),
};

/**
 * どこを見るか。
 *
 * **feature によって要るものが違う**ので、形の上では全部 optional にして、
 * 足りなければハンドラが名前を挙げて断る（`oneOf` で分けると一覧が肥大する）。
 *
 * **説明は短くする。** ここは4本の道具に写るので、1字がおよそ4字になる。
 */
const TARGET_INPUT = {
  filePath: z
    .string()
    .optional()
    .describe(
      `その話の本文（novel.scan が返す相対パス）。${FILE_TARGET_FEATURES.join("・")} で要ります`
    ),
  /*
    **上限を書いておく。** 書かないと、入力の形に
    `maximum: 9007199254740991`（安全な整数の上限）が並ぶ——AIが毎回読む
    一覧に、意味のない16桁が10個ほど載ることになる。
  */
  chapter: z
    .number()
    .int()
    .min(1)
    .max(MAX_CHAPTER)
    .optional()
    .describe("合本のときに、どの話かを指す話数（synopsis・deviation）"),
  chunkIndex: z
    .number()
    .int()
    .min(0)
    .max(MAX_CHUNK_INDEX)
    .optional()
    .describe("そのチャンクだけを対象にする。省略すると全チャンク"),
  numCtx: z
    .number()
    .int()
    .min(1)
    .max(MAX_NUM_CTX)
    .optional()
    .describe(
      `モデルのコンテキスト長。切って回す ${CHUNKED_FEATURES.join("・")} では省略できません`
    ),
};

/**
 * feature ごとの追加の指定。
 *
 * **中身を書くのは `novel.run` の1本だけ**にしてある。ほかの道具は
 * そこを指す——**同じ表が4本に写ると、それだけで2千字になる**（束ねた
 * 目的は、AI が繋いだ瞬間に読む量を減らすことだった）。一覧は1度に
 * ぜんぶ届くので、隣の道具を指すのは**写しを持つより確かである。**
 */
const OPTIONS_TABLE =
  "feature ごとの追加の指定（※は要るもの）。" +
  "foreshadow: mode（detect＝配置を拾う〈既定〉／resolve＝回収を見る）。" +
  "contradiction: categories（light〈既定〉／all）。" +
  "notation: group※（novel.detect が返した組の1件）・limit（detect の上限）。" +
  "synopsis: needsSubtitle。" +
  "episodePlot: plotPath※（単話プロットの相対パス）・chapterLabel。" +
  "chat: question※・history・adviceAnswers・writerStyle・featureIndex。" +
  "name: characterName※（いまの名前）・origin。" +
  "chapter: nameOnly。" +
  "catchphrase: blurb・rejected。";

const OPTIONS_SEE_RUN =
  "feature ごとの追加の指定。中身は novel.run の options と同じです。";

function optionsInput(describe: string) {
  return { options: z.record(z.string(), z.unknown()).optional().describe(describe) };
}

export const NOVEL_PROMPT_INPUT = {
  ...FOLDER_INPUT,
  ...FEATURE_INPUT,
  ...TARGET_INPUT,
  ...optionsInput(OPTIONS_SEE_RUN),
};

export const NOVEL_VALIDATE_INPUT = {
  ...FOLDER_INPUT,
  ...FEATURE_INPUT,
  chunkId: z
    .string()
    .optional()
    .describe(
      `novel.prompt か novel.run が返した chunkId。${CHUNKED_FEATURES.join("・")} で要ります`
    ),
  response: responseInput(),
  /*
    **検算には、どの本文かが要る feature がある**（synopsis・deviation）。
    `chunkIndex`・`numCtx` は要らない——検算は `chunkId` から切り直すので、
    切り方はそちらに入っている。
  */
  filePath: TARGET_INPUT.filePath,
  chapter: TARGET_INPUT.chapter,
  ...optionsInput(OPTIONS_SEE_RUN),
};

export const NOVEL_RUN_INPUT = {
  ...FOLDER_INPUT,
  ...FEATURE_INPUT_WITH_LABELS,
  ...RUNNER_INPUT,
  ...OLLAMA_INPUT,
  ...TARGET_INPUT,
  ...optionsInput(OPTIONS_TABLE),
};

export const NOVEL_DETECT_INPUT = {
  ...FOLDER_INPUT,
  feature: z
    .enum(DETECT_FEATURES)
    .describe(`どの機能か。${featureListText(DETECT_FEATURES)}`),
  ...optionsInput("notation のとき limit（返す組の上限。既定は50）を渡せます。"),
};

export const NOVEL_MATERIAL_INPUT = {
  ...FOLDER_INPUT,
  feature: z
    .enum(MATERIAL_FEATURES)
    .describe(`どの機能か。${featureListText(MATERIAL_FEATURES)}`),
  filePath: z.string().optional().describe("その話の本文（相対パス。要ります）"),
  chunkIndex: TARGET_INPUT.chunkIndex,
  numCtx: z
    .number()
    .int()
    .min(1)
    .max(MAX_NUM_CTX)
    .optional()
    .describe("モデルのコンテキスト長（要ります）"),
};

/** 束ねた道具が受け取る引数。**形は1つ**（feature ごとに分けない） */
export interface FeatureCallInput {
  folder: string;
  feature: FeatureName;
  filePath?: string;
  chapter?: number;
  chunkIndex?: number;
  numCtx?: number;
  chunkId?: string;
  response?: string;
  runner?: RunnerKind;
  endpoint?: string;
  model?: string;
  allowRemote?: boolean;
  options?: Record<string, unknown>;
}

/* ── 足りない引数の断り方 ───────────────────────────────── */

/** どの機能の話かを、断り文句の頭に付ける（作者も外部AIもこれを読む） */
function who(input: FeatureCallInput): string {
  return `${FEATURE_LABELS[input.feature]}（feature: ${input.feature}）`;
}

function needFilePath(input: FeatureCallInput): string {
  const value = input.filePath?.trim();
  if (value) return value;
  throw new McpToolError(
    `${who(input)} には filePath が要ります（novel.scan が返す相対パスを渡してください）。`
  );
}

function needNumCtx(input: FeatureCallInput): number {
  if (input.numCtx !== undefined) return input.numCtx;
  throw new McpToolError(
    `${who(input)} には numCtx が要ります（本文を切る大きさをここから決めます。手元のモデルの読める長さは ollama.models で分かります）。`
  );
}

function needChunkId(input: FeatureCallInput): string {
  const value = input.chunkId?.trim();
  if (value) return value;
  throw new McpToolError(
    `${who(input)} の検算には chunkId が要ります（novel.prompt か novel.run が返したものをそのまま渡してください）。`
  );
}

function needResponse(input: FeatureCallInput): string {
  if (typeof input.response === "string") return input.response;
  throw new McpToolError(`${who(input)} の検算には response が要ります。`);
}

function needRunner(input: FeatureCallInput): RunnerKind {
  // **断り文句は `run.ts` に1つだけ**（選択肢を増やしたときに写しが古くなる）
  assertRunner(input.runner);
  return input.runner;
}

/**
 * `options` の1つを読む。
 *
 * **形が違えば断る。** `z.unknown()` で受けているので、ここを通さずに
 * ハンドラへ渡すと**型が合っているふりをしたまま**奥へ入る。
 */
function option<T>(
  input: FeatureCallInput,
  name: string,
  schema: z.ZodType<T>
): T | undefined {
  const raw = input.options?.[name];
  if (raw === undefined || raw === null) return undefined;
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new McpToolError(
    `${who(input)} の options.${name} の形が違います: ${parsed.error.issues
      .map((issue) => issue.message)
      .join("・")}`
  );
}

function needOption<T>(
  input: FeatureCallInput,
  name: string,
  schema: z.ZodType<T>
): T {
  const value = option(input, name, schema);
  if (value !== undefined) return value;
  throw new McpToolError(
    `${who(input)} には options.${name} が要ります。`
  );
}

/* ── ハンドラへ渡す形に組み直す ─────────────────────────── */

/** チャンクに切る機能の共通の引数 */
function chunkArgs(input: FeatureCallInput): {
  folder: string;
  filePath: string;
  numCtx: number;
  chunkIndex?: number;
} {
  return {
    folder: input.folder,
    filePath: needFilePath(input),
    numCtx: needNumCtx(input),
    chunkIndex: input.chunkIndex,
  };
}

/**
 * 事実の照合の引数。**`filePath` は任意である。**
 *
 * ほかのチャンク機能と違い、省略すると作品ぜんたいを見る——6.88 の値打ちは
 * **話をまたいで事実を追う**ところにあり、1話ずつ絞るとその型は拾えない。
 */
function factArgs(input: FeatureCallInput): {
  folder: string;
  filePath?: string;
  numCtx: number;
  chunkIndex?: number;
} {
  return {
    folder: input.folder,
    filePath: input.filePath,
    numCtx: needNumCtx(input),
    chunkIndex: input.chunkIndex,
  };
}

/** 話を丸ごと1回で見る機能の共通の引数 */
function episodeArgs(input: FeatureCallInput): {
  folder: string;
  filePath: string;
  chapter?: number;
} {
  return {
    folder: input.folder,
    filePath: needFilePath(input),
    chapter: input.chapter,
  };
}

/**
 * 行き先の指定。**既定で埋めない**（設計書6.87.8 の5）。
 *
 * `folder` はここに入れない——**どの feature も自分の引数として既に渡している**
 * （考えさせる許可を確かめるために要る）。二重に入れると、あとから片方を
 * 変えたときにどちらが効くのかが読めなくなる。
 */
function runnerArgs(input: FeatureCallInput): {
  runner: RunnerKind;
  endpoint?: string;
  model?: string;
  allowRemote?: boolean;
  numCtx?: number;
} {
  return {
    runner: needRunner(input),
    endpoint: input.endpoint,
    model: input.model,
    allowRemote: input.allowRemote,
    numCtx: input.numCtx,
  };
}

/* ── feature ごとの配線 ─────────────────────────────────── */

interface FeatureEntry {
  prompt: (input: FeatureCallInput) => unknown;
  validate: (input: FeatureCallInput) => unknown;
  run: (input: FeatureCallInput) => Promise<unknown>;
  /** AIを使わずに探す（`novel.detect`） */
  detect?: (input: FeatureCallInput) => unknown;
  /** AIへ渡す材料だけを組む（`novel.material`） */
  material?: (input: FeatureCallInput) => unknown;
}

const CATEGORIES_SCHEMA = z.enum(["light", "all"]);
const MODE_SCHEMA: z.ZodType<ForeshadowMode> = z.enum(["detect", "resolve"]);

/**
 * **`Record<FeatureName, …>` にしてある。** feature を増やしたのに
 * 配線を忘れると、型検査で止まる（実行してみるまで気づかない形にしない）。
 */
const FEATURES: Record<FeatureName, FeatureEntry> = {
  typo: {
    prompt: (input) => typoPrompt(chunkArgs(input)),
    validate: (input) =>
      typoValidate({
        folder: input.folder,
        chunkId: needChunkId(input),
        response: needResponse(input),
      }),
    run: (input) => typoRun({ ...chunkArgs(input), ...runnerArgs(input) }),
  },
  proofread: {
    prompt: (input) => proofreadPrompt(chunkArgs(input)),
    validate: (input) =>
      proofreadValidate({
        folder: input.folder,
        chunkId: needChunkId(input),
        response: needResponse(input),
      }),
    run: (input) => proofreadRun({ ...chunkArgs(input), ...runnerArgs(input) }),
  },
  notation: {
    detect: (input) => notationDetect({
      folder: input.folder,
      limit: option(input, "limit", z.number().int().min(1).max(200)),
    }),
    prompt: (input) =>
      notationPrompt({
        folder: input.folder,
        group: needOption(input, "group", NOTATION_GROUP_SCHEMA),
      }),
    validate: (input) =>
      notationValidate({
        folder: input.folder,
        group: needOption(input, "group", NOTATION_GROUP_SCHEMA),
        response: needResponse(input),
      }),
    run: (input) =>
      notationRun({
        folder: input.folder,
        group: needOption(input, "group", NOTATION_GROUP_SCHEMA),
        ...runnerArgs(input),
      }),
  },
  contradiction: {
    material: (input) => contradictionMaterial(chunkArgs(input)),
    prompt: (input) =>
      contradictionPrompt({
        ...chunkArgs(input),
        categories: option(input, "categories", CATEGORIES_SCHEMA),
      }),
    validate: (input) =>
      contradictionValidate({
        folder: input.folder,
        chunkId: needChunkId(input),
        response: needResponse(input),
      }),
    run: (input) =>
      contradictionRun({
        ...chunkArgs(input),
        categories: option(input, "categories", CATEGORIES_SCHEMA),
        ...runnerArgs(input),
      }),
  },
  factContradiction: {
    prompt: (input) => factContradictionPrompt(factArgs(input)),
    validate: (input) =>
      factContradictionValidate({
        folder: input.folder,
        chunkId: needChunkId(input),
        response: needResponse(input),
      }),
    run: (input) =>
      factContradictionRun({ ...factArgs(input), ...runnerArgs(input) }),
  },
  foreshadow: {
    prompt: (input) =>
      foreshadowPrompt({
        ...chunkArgs(input),
        mode: option(input, "mode", MODE_SCHEMA),
      }),
    validate: (input) =>
      foreshadowValidate({
        folder: input.folder,
        chunkId: needChunkId(input),
        response: needResponse(input),
        mode: option(input, "mode", MODE_SCHEMA),
      }),
    run: (input) =>
      foreshadowRun({
        ...chunkArgs(input),
        mode: option(input, "mode", MODE_SCHEMA),
        ...runnerArgs(input),
      }),
  },
  deviation: {
    prompt: (input) => deviationPrompt(episodeArgs(input)),
    validate: (input) =>
      deviationValidate({ ...episodeArgs(input), response: needResponse(input) }),
    run: (input) => deviationRun({ ...episodeArgs(input), ...runnerArgs(input) }),
  },
  episodePlot: {
    prompt: (input) => episodePlotPrompt(episodePlotArgs(input)),
    validate: (input) =>
      episodePlotValidate({
        ...episodePlotArgs(input),
        response: needResponse(input),
      }),
    run: (input) =>
      episodePlotRun({ ...episodePlotArgs(input), ...runnerArgs(input) }),
  },
  settings: {
    prompt: (input) => settingsPrompt(chunkArgs(input)),
    validate: (input) =>
      settingsValidate({
        folder: input.folder,
        chunkId: needChunkId(input),
        response: needResponse(input),
      }),
    run: (input) => settingsRun({ ...chunkArgs(input), ...runnerArgs(input) }),
  },
  synopsis: {
    prompt: (input) =>
      synopsisPrompt({
        ...episodeArgs(input),
        needsSubtitle: option(input, "needsSubtitle", z.boolean()),
      }),
    validate: (input) =>
      synopsisValidate({ ...episodeArgs(input), response: needResponse(input) }),
    run: (input) =>
      synopsisRun({
        ...episodeArgs(input),
        needsSubtitle: option(input, "needsSubtitle", z.boolean()),
        ...runnerArgs(input),
      }),
  },
  plotReverse: {
    prompt: (input) => plotReversePrompt({ folder: input.folder }),
    validate: (input) => plotReverseValidate({ response: needResponse(input) }),
    run: (input) => plotReverseRun({ folder: input.folder, ...runnerArgs(input) }),
  },
  chapter: {
    prompt: (input) => chapterPrompt(chapterArgs(input)),
    validate: (input) =>
      chapterValidate({ ...chapterArgs(input), response: needResponse(input) }),
    run: (input) => chapterRun({ ...chapterArgs(input), ...runnerArgs(input) }),
  },
  blurb: {
    prompt: (input) => blurbPrompt({ folder: input.folder }),
    validate: (input) => blurbValidate({ response: needResponse(input) }),
    run: (input) => blurbRun({ folder: input.folder, ...runnerArgs(input) }),
  },
  catchphrase: {
    prompt: (input) => catchphrasePrompt(catchphraseArgs(input)),
    validate: (input) =>
      catchphraseValidate({ response: needResponse(input) }),
    run: (input) =>
      catchphraseRun({ ...catchphraseArgs(input), ...runnerArgs(input) }),
  },
  opening: {
    prompt: (input) => openingPrompt({ folder: input.folder }),
    validate: (input) => openingValidate({ response: needResponse(input) }),
    run: (input) => openingRun({ folder: input.folder, ...runnerArgs(input) }),
  },
  name: {
    detect: (input) => nameCollisions({ folder: input.folder }),
    prompt: (input) => namePrompt(nameArgs(input)),
    validate: (input) =>
      nameValidate({ ...nameArgs(input), response: needResponse(input) }),
    run: (input) => nameRun({ ...nameArgs(input), ...runnerArgs(input) }),
  },
  chat: {
    prompt: (input) => chatPrompt(chatArgs(input)),
    validate: (input) => chatValidate({ response: needResponse(input) }),
    run: (input) => chatRun({ ...chatArgs(input), ...runnerArgs(input) }),
  },
};

function episodePlotArgs(input: FeatureCallInput): {
  folder: string;
  plotPath: string;
  chapterLabel?: string;
} {
  return {
    folder: input.folder,
    plotPath: needOption(input, "plotPath", z.string().min(1)),
    chapterLabel: option(input, "chapterLabel", z.string()),
  };
}

function chapterArgs(input: FeatureCallInput): {
  folder: string;
  nameOnly?: number;
} {
  return {
    folder: input.folder,
    nameOnly: option(input, "nameOnly", z.number().int().positive()),
  };
}

function catchphraseArgs(input: FeatureCallInput): {
  folder: string;
  blurb?: string;
  rejected?: string[];
} {
  return {
    folder: input.folder,
    blurb: option(input, "blurb", z.string()),
    rejected: option(input, "rejected", z.array(z.string())),
  };
}

function nameArgs(input: FeatureCallInput): {
  folder: string;
  characterName: string;
  origin?: string;
} {
  return {
    folder: input.folder,
    characterName: needOption(input, "characterName", z.string().min(1)),
    origin: option(input, "origin", NAME_ORIGIN_SCHEMA),
  };
}

function chatArgs(input: FeatureCallInput): {
  folder: string;
  question: string;
  filePath?: string;
  history?: z.infer<typeof CHAT_HISTORY_SCHEMA>;
  adviceAnswers?: number[];
  writerStyle?: Record<string, unknown>;
  featureIndex?: boolean;
} {
  return {
    folder: input.folder,
    question: needOption(input, "question", z.string().min(1)),
    // **相談だけは filePath が任意**（渡すと抜粋を材料に添える）
    filePath: input.filePath,
    history: option(input, "history", CHAT_HISTORY_SCHEMA),
    adviceAnswers: option(input, "adviceAnswers", CHAT_ADVICE_ANSWERS_SCHEMA),
    writerStyle: option(input, "writerStyle", CHAT_WRITER_STYLE_SCHEMA),
    featureIndex: option(input, "featureIndex", z.boolean()),
  };
}

/* ── 転送層から呼ばれる入口 ─────────────────────────────── */

export function novelPrompt(input: FeatureCallInput): unknown {
  return FEATURES[input.feature].prompt(input);
}

export function novelValidate(input: FeatureCallInput): unknown {
  return FEATURES[input.feature].validate(input);
}

/**
 * **`async` にしてある。** 引数が足りないときの断りは同期に起きるので、
 * そのままでは「例外」と「返り値の失敗」が混ざる——受け取る側が
 * 2通りの受け止め方をしなくて済むように、ここで揃える。
 */
export async function novelRun(input: FeatureCallInput): Promise<unknown> {
  return FEATURES[input.feature].run(input);
}

export function novelDetect(input: FeatureCallInput): unknown {
  const detect = FEATURES[input.feature].detect;
  if (!detect) {
    throw new McpToolError(
      `${who(input)} は novel.detect では扱えません（AIを使わずに探せるのは ${DETECT_FEATURES.join("・")} だけです）。`
    );
  }
  return detect(input);
}

export function novelMaterial(input: FeatureCallInput): unknown {
  const material = FEATURES[input.feature].material;
  if (!material) {
    throw new McpToolError(
      `${who(input)} には novel.material がありません（材料を組めるのは ${MATERIAL_FEATURES.join("・")} だけです）。`
    );
  }
  return material(input);
}
