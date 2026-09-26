import { z } from "zod";
import * as nodePath from "node:path";
import {
  NOTATION_ADVICE_SYSTEM_PROMPT,
  NOTATION_ADVICE_TEMPERATURE,
  NOTATION_ADVICE_VERSION,
  buildNotationAdvicePrompt,
  buildNotationAdviceSchema,
  notationAdviceChoices,
  type NotationAdviceGroup,
} from "../../prompts/notationAdvice";
import { parseNotationAdvice } from "../../core/notationAdviceValidation";
import {
  detectNotationVariants,
  dialogueOnlySurfaces,
  foldSubsumedGroups,
  type NotationSource,
} from "../../core/notationVariants";
import { parseEpisodeFileName } from "../../core/episodeParser";
import { episodeBodySources } from "../../core/episodeChunks";
import { parseCharacter } from "../../models/character";
import { parseAbility } from "../../models/ability";
import { parseLocation } from "../../models/location";
import { parseOrganization } from "../../models/organization";
import {
  McpToolError,
  SETTINGS_SUBDIRS,
  listBodyFiles,
  readBody,
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
 * 表記ゆれ（P-10の一部、設計書6.9）を外から呼ぶ（6.87.8 の4）。
 *
 * **ほかの機能といちばん違うのは、AIが探すのではないところ。**
 * 揺れている組を見つけるのは**コードの仕事**（`detectNotationVariants`）で、
 * AIに聞くのは「どちらへ揃えるのがよいか」だけである。
 *
 * だから道具が3つではなく**4つ**になる。
 *
 * | 道具 | 何をするか | AIを使うか |
 * |---|---|---|
 * | `novel.detect` | 作品ぜんたいから揺れている組を探す | **使わない**（コードだけ） |
 * | `novel.prompt` | 1つの組について、揃え先を問うプロンプトを組む | — |
 * | `novel.validate` | 応答を製品の解析へ通す | — |
 * | `novel.run` | 1つの組を通す | 使う |
 *
 * **2つ以上の表記が実際に本文へ出ている組だけを返す**（`detectNotationVariants`）。
 * 片方しか無い語を「揺れ」と呼ぶと、作者の選んだ表記を直せと言うことになる。
 */

const VALIDATE_WITH = validateWith("notation");

/**
 * 1つの組。`novel.detect`（feature: notation）が返したものを、そのまま渡す。
 *
 * **形の定義はここ1か所。** 束ねた道具（`features.ts`）は `options.group` を
 * `z.unknown()` で受けるので、奥へ入れる前にこの形で確かめ直す。
 */
export const NOTATION_GROUP_SCHEMA = z
  .object({
    label: z.string(),
    forms: z
      .array(
        z.object({
          surface: z.string(),
          count: z.number().int(),
          excerpts: z.array(z.string()),
        })
      )
      .min(2),
  })
  .describe(
    "揺れている組。novel.detect（feature: notation）が返した groups の1件をそのまま渡します"
  );

const DEFAULT_LIMIT = 50;

/** 1つの表記につき、出現例を何件添えるか */
const EXCERPT_LIMIT = 3;

/** 作品ぜんたいの本文を、検出へ渡せる形で集める */
function collectSources(folder: string): NotationSource[] {
  const sources: NotationSource[] = [];
  for (const relative of listBodyFiles(folder)) {
    let text: string;
    try {
      text = readBody(folder, relative);
    } catch {
      // 競合マーカーのあるファイル・読めないファイルは材料から外す。
      // **ここで止めない**——1つ読めなくても、ほかの揺れは探せる
      continue;
    }
    const parsed = parseEpisodeFileName(nodePath.basename(relative));
    for (const source of episodeBodySources(relative, text, {
      chapterStart: parsed.chapterStart,
      chapterEnd: parsed.chapterEnd,
    })) {
      sources.push({
        filePath: relative,
        body: source.body,
        // **頭書きを剥がしたぶんを戻す。** 戻さないと、指摘の行番号が
        // 元ファイルとずれる（誤字脱字で踏んだのと同じ落とし穴）
        startLine: source.lineOffset + 1,
      });
    }
  }
  return sources;
}

/** 登録済みの固有名詞。**これが無いと、人物名の揺れを拾えない** */
function collectProperNouns(folder: string): string[] {
  const of = <T extends { name: string; aliases: string[] }>(
    subdir: string,
    parse: (raw: unknown) => T
  ): string[] =>
    readSettingsRecords(folder, subdir, parse).records.flatMap((record) => [
      record.name,
      ...record.aliases,
    ]);

  return [
    ...of(SETTINGS_SUBDIRS.characters, parseCharacter),
    ...of(SETTINGS_SUBDIRS.abilities, parseAbility),
    ...of(SETTINGS_SUBDIRS.locations, parseLocation),
    ...of(SETTINGS_SUBDIRS.organizations, parseOrganization),
  ]
    .map((name) => name.trim())
    .filter(Boolean);
}

export function notationDetect(input: { folder: string; limit?: number }) {
  const groups = foldSubsumedGroups(
    detectNotationVariants(collectSources(input.folder), {
      properNouns: collectProperNouns(input.folder),
    })
  );

  return {
    note:
      "揺れを探したのはコードで、AIは使っていません。" +
      "どちらへ揃えるかを問うときは novel.prompt / novel.run（feature: notation）へ、" +
      "この groups の1件をそのまま渡してください。",
    total: groups.length,
    groups: groups.slice(0, input.limit ?? DEFAULT_LIMIT).map((group) => {
      // 台詞の中にしか出ない書き方（J11）。製品の一覧と同じ手がかりを渡す
      const dialogueOnly = new Set(dialogueOnlySurfaces(group));
      return {
        kind: group.kind,
        key: group.key,
        label: group.label,
        forms: group.forms.map((form) => ({
          surface: form.surface,
          count: form.occurrences.length,
          ...(dialogueOnly.has(form.surface) ? { dialogueOnly: true } : {}),
          // **出現例は少しだけ。** 全部渡すと、組が多い作品で
          // 返りが本文より大きくなる
          excerpts: form.occurrences
            .slice(0, EXCERPT_LIMIT)
            .map((occurrence) => occurrence.lineText.trim()),
        })),
      };
    }),
  };
}

export interface NotationPromptInput {
  folder: string;
  group: NotationAdviceGroup;
}

export function notationPrompt(input: NotationPromptInput) {
  if (input.group.forms.length < 2) {
    // **1つしか無いものは「揺れ」ではない。** 問えば、作者が選んだ
    // 表記を直せと言うことになる
    throw new McpToolError(
      "表記が1つしかありません。揺れている組（2つ以上）を渡してください。"
    );
  }
  return {
    promptVersion: NOTATION_ADVICE_VERSION,
    systemPrompt: NOTATION_ADVICE_SYSTEM_PROMPT,
    // **スキーマは組ごとに作る**（選べる表記をその場で列挙するため）
    schema: buildNotationAdviceSchema(input.group),
    temperature: NOTATION_ADVICE_TEMPERATURE,
    validateWith: VALIDATE_WITH,
    label: input.group.label,
    userPrompt: buildNotationAdvicePrompt({
      workTitle: nodePath.basename(input.folder),
      group: input.group,
    }),
  };
}

export function notationValidate(input: {
  /** 記録のためだけに要る（設計書6.87.9）。検算には使わない */
  folder?: string;
  group: NotationAdviceGroup;
  response: string;
}) {
  // 選べるのは表記そのもの、数字・英字の幅の組なら「半角」「全角」（製品と同じ一覧）
  const advice = parseNotationAdvice(input.response, notationAdviceChoices(input.group));
  if (!advice) {
    // **本文に無い表記を選ばれたら受け取らない。** 揃え先は
    // 「いま出ている表記のどれか」でなければ、置き換えられない
    throw new McpToolError(
      "応答から揃え先を読み取れませんでした（渡した表記のどれか、数字・英字の幅の組なら「半角」「全角」を選ばせてください）。"
    );
  }
  return { label: input.group.label, advice };
}

export interface NotationRunInput extends NotationPromptInput {
  runner: RunnerKind;
  endpoint?: string;
  model?: string;
  allowRemote?: boolean;
  temperature?: number;
  numCtx?: number;
}

export async function notationRun(input: NotationRunInput) {
  // **省略を既定で埋めない**（設計書6.87.8 の5）
  assertRunner(input.runner);
  const prompt = notationPrompt(input);
  // **明示が無ければ製品と同じ**（6.87.16）。決め方は `run.ts` に1つだけ
  const temperature = temperatureFor(input, prompt.temperature);
  if (input.runner === "claude") {
    return {
      runner: "claude" as const,
      note: claudeNote(VALIDATE_WITH),
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt,
      schema: prompt.schema,
      temperature,
      validateWith: VALIDATE_WITH,
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
      runner: "sampling" as const,
      model: reply.model,
      temperature,
      result: notationValidate({
        folder: input.folder,
        group: input.group,
        response: reply.text,
      }),
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
    numCtx: input.numCtx ?? 8192,
    temperature,
    allowRemote: input.allowRemote,
  });
  return {
    runner: "ollama" as const,
    model,
    temperature,
    result: notationValidate({
      folder: input.folder,
      group: input.group,
      response: response.text,
    }),
  };
}
