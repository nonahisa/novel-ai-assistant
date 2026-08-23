import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import { AIRegistry, ensureConfigured } from "../ai/registry";
import { AIError, recoveryForAIError } from "../ai/types";
import { scanWork } from "../core/scanner";
import { readTextFile } from "../core/textFile";
import {
  describeChunkScope,
  locateChunkLine,
  mergeAdjacentChunks,
  splitIntoChunks,
  splitMergedChunk,
  withLineNumbers,
  type Chunk,
} from "../core/chunker";
import { ChunkCache } from "../core/chunkCache";
import { describeChunkSettings, readChunkSettings } from "./chunkSettings";
import { CharacterStore } from "../core/characterStore";
import {
  createAbilityStore,
  createLocationStore,
  createOrganizationStore,
  createWorldStore,
} from "../core/abilityStore";
import { SynopsisStore } from "../core/synopsisStore";
import {
  TermIndex,
  expandNameVariants,
  type TermEntry,
} from "../core/termIndex";
import {
  describeCharacter,
  describeLocation,
  describeWorldItem,
} from "../core/settingsSummary";
import { formatChapterLabel } from "../core/episodeLabel";
import { readWorkFormat } from "../core/workFormatStore";
import {
  buildContradictionCheckPrompt,
  CONTRADICTION_CATEGORIES,
  CONTRADICTION_CHECK_SCHEMA,
  CONTRADICTION_CHECK_SYSTEM_PROMPT,
  CONTRADICTION_CHECK_VERSION,
  LIGHT_CATEGORIES,
  type ContradictionCategory,
} from "../prompts/contradictionCheck";
import {
  contradictionKey,
  parseContradictionResult,
  sortContradictions,
  validateContradictions,
  type AcceptedContradiction,
} from "../core/contradictionValidation";
import { withCancellableProgress } from "../views/progress";
import { confirmProviderReachable } from "./aiConnectivity";
import { logFailure, logStep, useLogFile } from "../core/logger";
import { hashText } from "../core/textFile";

/**
 * 矛盾検知（P-12、設計書6.10.1）。
 *
 * 既に作った設定資料を「正」として本文と突き合わせる。ただし
 * **設定側が古い・誤っていることがある**（抽出はAIがやっており、
 * 作者が直していない項目も多い）。したがって、
 *
 * - **何も自動で直さない。** 誤字脱字と違い、どちらが正しいかは作者にしか決められない
 * - 指摘は「設定ではこう／本文ではこう」を並べるだけにする
 * - 解決の道を2つ出す（本文を直す／設定を直す）
 *
 * **設定が無い作品では実行しない。** 照らし合わせる相手が無いのに
 * AIへ投げると、本文だけを見て「矛盾していそうなこと」を作り出す。
 */

/**
 * 「まとめたせいで入り切らなかった。分けて試し直す」の印。
 *
 * **`undefined`（この本文は飛ばす）と区別する。** 同じ値にすると、
 * 切り詰められたチャンクが黙って捨てられる。
 */
const RETRY_SMALLER = Symbol("retry-smaller");

export interface ContradictionRunResult {
  issues: AcceptedContradiction[];
  /** 本文に無い引用など、弾いた件数 */
  rejectedCount: number;
  /** 応答が読めなかったチャンク数 */
  failedChunks: number;
  cancelled: boolean;
  /** 処理したチャンク数 */
  processedChunks: number;
}

export interface CheckContradictionsOptions {
  /** 話を絞る。指定しなければ作品全体 */
  filePaths?: string[];
}

export async function checkContradictions(
  work: WorkEntry,
  registry: AIRegistry,
  options: CheckContradictionsOptions = {}
): Promise<ContradictionRunResult | undefined> {
  useLogFile(work.folderPath);

  const resolved = await ensureConfigured(registry);
  if (!resolved) return undefined;

  const material = await collectSettings(work);
  if (!material) return undefined;

  const tasks = await collectChunks(work, registry, options);
  if (!tasks) return undefined;
  const { chunks, chapterLabelByFile, chunkNote } = tasks;
  if (chunks.length === 0) {
    vscode.window.showWarningMessage("検知できる本文がありませんでした。");
    return undefined;
  }

  // **設定が変われば、同じ本文でも答えが変わる。**
  // 材料のハッシュをキャッシュの鍵へ入れないと、設定を直したのに
  // 古い指摘が出続ける
  const cache = new ChunkCache(work);
  await cache.load();
  const cacheKeyBase = {
    feature: "contradiction_check",
    promptVersion: `${CONTRADICTION_CHECK_VERSION}:${material.fingerprint}`,
    model: resolved.model,
  };

  const pending = chunks.filter((chunk) => !cache.get(chunk.hash, cacheKeyBase));
  if (pending.length > 0) {
    if (!(await confirmProviderReachable(resolved.provider, "矛盾検知"))) {
      return undefined;
    }
    const confirm = await vscode.window.showInformationMessage(
      `${work.title} の矛盾を検知します。`,
      {
        modal: true,
        detail: [
          `${chunks.length}チャンク中 ${pending.length}件を処理します` +
            `（処理済み ${chunks.length - pending.length}件はスキップ）。`,
          `材料: 人物${material.characterCount}人 / 場所${material.locationCount}件 / ` +
            `世界観${material.worldCount}件`,
          "",
          "この機能は本文を書き換えません。 設定と食い違う箇所を並べるだけで、",
          "どちらを直すかは作者が決めます（設定側が古いこともあります）。",
          resolved.provider.isPaid
            ? `\n${resolved.provider.displayName} はチャンクごとに課金されます。`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      },
      "実行"
    );
    if (confirm !== "実行") return undefined;
  }

  logStep(
    `矛盾検知を開始: ${work.title} / ${resolved.provider.displayName} / ` +
      `${resolved.model} / ${chunks.length}チャンク / ${chunkNote} / ` +
      `v${CONTRADICTION_CHECK_VERSION}`
  );

  // 小さいモデルでは観点を絞る。1回の負荷を下げないと検出漏れが増える
  const categories: readonly ContradictionCategory[] =
    resolved.provider.id === "ollama" ? LIGHT_CATEGORIES : CONTRADICTION_CATEGORIES;

  // 下の入れ子の関数では、上の `if (!resolved) return` による絞り込みが
  // 効かない（あとから書き換わりうるとみなされる）。ここで束ねておく
  const provider = resolved.provider;
  const model = resolved.model;
  const settings = material;

  const issues: AcceptedContradiction[] = [];
  let rejectedCount = 0;
  let failedChunks = 0;
  let cancelled = false;
  let processedChunks = 0;

  await withCancellableProgress("矛盾を検知しています", async (progress, token) => {
    const controller = new AbortController();
    token.onCancellationRequested(() => {
      cancelled = true;
      controller.abort();
    });

    // **まとめたチャンクは、切り詰められたら分けて試し直す**（設計書6.23）。
    // 部分的なJSONは読めないので、まとめたせいで入り切らなかったのなら
    // 元の大きさで出し直すほうがよい。処理中に増えるので配列で持つ
    const queue = [...chunks];
    let total = queue.length;
    let done = 0;

    for (let cursor = 0; cursor < queue.length; cursor++) {
      if (token.isCancellationRequested) break;
      const chunk = queue[cursor];

      const cached = cache.get(chunk.hash, cacheKeyBase);
      const raw = cached ?? (await ask(chunk));
      done++;
      progress.report({
        message: `${done}/${total}`,
        increment: 100 / total,
      });

      if (raw === RETRY_SMALLER) {
        const parts = splitMergedChunk(chunk);
        if (parts.length > 1) {
          queue.splice(cursor + 1, 0, ...parts);
          total += parts.length;
          logStep(
            `切り詰められたため ${parts.length} 話に分けて試し直します: ${chunk.hash}`
          );
        } else {
          failedChunks++;
        }
        continue;
      }
      if (raw === undefined) continue;

      const validated = validateContradictions(raw, chunk);
      rejectedCount += validated.rejected.length;

      // **どのファイルの何行目かを、ここで確定させる。** まとめたチャンクでは
      // AIが返す行番号がまとめた本文の通し番号になっており、そのまま使うと
      // 別の話のファイルの、まったく違う行を指すことになる
      for (const issue of validated.accepted) {
        const at = locateChunkLine(chunk, issue.line);
        if (!at) {
          // 戻せない行は捨てる。どこの話か決められない
          rejectedCount++;
          continue;
        }
        issues.push({ ...issue, filePath: at.filePath, line: at.line });
      }
      processedChunks++;
    }

    async function ask(chunk: Chunk): Promise<unknown | undefined> {
      const relevant = settings.relevantFor(chunk.text);
      // **照らし合わせる相手が無いチャンクは飛ばす。**
      // 材料なしで問うと、本文だけを見て矛盾を作り出す
      if (!relevant.hasAnything) return undefined;

      try {
        const response = await provider.generate({
          systemPrompt: CONTRADICTION_CHECK_SYSTEM_PROMPT,
          userPrompt: buildContradictionCheckPrompt({
            // **まとめたチャンクは、話が1つとは限らない。**
            // 1つ目の話の名前だけを渡すと、2話目以降の本文を
            // 1話目だと言って読ませることになる
            chapterLabel: describeChunkScope(chunk, (filePath) =>
              chapterLabelByFile.get(filePath)
            ),
            chunkTextWithLineNumbers: withLineNumbers(chunk),
            characterDetails: relevant.characters,
            locationDetails: relevant.locations,
            worldviewSummary: settings.worldview,
            previousSynopses: settings.synopsesBefore(chunk.chapterStart),
            categories,
          }),
          model,
          // 事実の突き合わせなので揺らさない
          temperature: 0.0,
          jsonSchema: CONTRADICTION_CHECK_SCHEMA as unknown as object,
          disableThinking: true,
          signal: controller.signal,
        });

        if (response.truncated || !response.text.trim()) {
          // まとめたせいで入り切らなかったのなら、元の大きさなら通る見込みが
          // ある。**捨てるより試すほうがよい**（部分的なJSONは解析できない）
          logFailure("矛盾検知", {
            チャンク: chunk.hash,
            理由: "応答が上限で切り詰められました",
          });
          return RETRY_SMALLER;
        }

        const parsed = parseContradictionResult(response.text);
        if (!parsed) {
          failedChunks++;
          logFailure("矛盾検知", {
            チャンク: chunk.hash,
            理由: "応答を読み取れません",
            応答: response.text.slice(0, 300),
          });
          return undefined;
        }
        await cache.set(chunk.hash, cacheKeyBase, parsed);
        return parsed;
      } catch (error) {
        if (error instanceof AIError && error.kind === "aborted") return undefined;
        failedChunks++;
        logFailure("矛盾検知", {
          チャンク: chunk.hash,
          詳細:
            error instanceof AIError
              ? `${error.message} ${recoveryForAIError(error)}`
              : error instanceof Error
                ? error.message
                : String(error),
        });
        return undefined;
      }
    }
  });

  await cache.save();

  return {
    issues: sortContradictions(dedupe(issues)),
    rejectedCount,
    failedChunks,
    cancelled,
    processedChunks,
  };
}

/** 同じ箇所の同じ指摘が、重なったチャンクから二重に出ることがある */
function dedupe(items: AcceptedContradiction[]): AcceptedContradiction[] {
  const seen = new Set<string>();
  const out: AcceptedContradiction[] = [];
  for (const item of items) {
    const key = contradictionKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

interface SettingsMaterial {
  characterCount: number;
  locationCount: number;
  worldCount: number;
  worldview: string;
  /** 設定の中身のハッシュ。変われば検知をやり直す */
  fingerprint: string;
  relevantFor(text: string): {
    characters: string;
    locations: string;
    hasAnything: boolean;
  };
  synopsesBefore(chapter: number | null): string;
}

/**
 * 突き合わせる設定を集める。
 *
 * **本文に出てくるものだけを渡す。** 全部渡すと入力が膨らむうえ、
 * 出てこない人物の設定まで見て「登場していない」を矛盾にしてくる。
 */
async function collectSettings(
  work: WorkEntry
): Promise<SettingsMaterial | undefined> {
  const [characters, locations, abilities, organizations, world] =
    await Promise.all([
      new CharacterStore(work).loadAll(),
      createLocationStore(work).loadAll(),
      createAbilityStore(work).loadAll(),
      createOrganizationStore(work).loadAll(),
      createWorldStore(work).loadAll(),
    ]);

  const people = characters.characters.filter((character) => !character.isMob);
  const places = locations.records;
  const worldItems = world.records;

  if (people.length === 0 && places.length === 0 && worldItems.length === 0) {
    const answer = await vscode.window.showWarningMessage(
      "突き合わせる設定資料がまだありません。",
      {
        modal: true,
        detail:
          "矛盾検知は、作った設定資料と本文を照らし合わせる機能です。" +
          "設定が無いまま実行すると、AIは本文だけを見て" +
          "「矛盾していそうなこと」を作り出します。\n\n" +
          "先に「設定資料をまとめて抽出」を実行してください。",
      },
      "設定資料を抽出する"
    );
    if (answer === "設定資料を抽出する") {
      await vscode.commands.executeCommand("novelai.extractSettings", {
        type: "work",
        work,
      });
    }
    return undefined;
  }

  // 本文に出てくるものを探すための索引。用語ハイライトと同じ作り
  const entries: TermEntry[] = [];
  for (const character of people) {
    for (const text of expandNameVariants([character.name, ...character.aliases])) {
      entries.push({
        text,
        kind: "character",
        id: character.id,
        canonicalName: character.name,
      });
    }
  }
  for (const place of places) {
    for (const text of [place.name, ...place.aliases]) {
      entries.push({
        text,
        kind: "location",
        id: place.id,
        canonicalName: place.name,
      });
    }
  }
  const index = new TermIndex(entries);

  const characterById = new Map(people.map((item) => [item.id, item]));
  const locationById = new Map(places.map((item) => [item.id, item]));
  const abilitySystem = abilities.records;

  const worldview = worldItems
    .map((item) => describeWorldItem(item))
    .join("\n\n");

  // 設定が変われば同じ本文でも答えが変わる。**更新時刻ではなく中身**で見る
  // （抽出は中身が同じでも updatedAt を書き換えるため）
  const fingerprint = hashText(
    JSON.stringify([
      people.map((c) => [c.id, c.updatedAt, describeCharacter(c, [])]),
      places.map((l) => [l.id, describeLocation(l)]),
      worldItems.map((w) => [w.id, describeWorldItem(w)]),
    ])
  ).slice(0, 16);

  let synopses: Array<{ chapter: number | null; synopsis: string }> = [];
  try {
    synopses = (await new SynopsisStore(work).load()).episodes.map((item) => ({
      chapter: item.chapter,
      synopsis: item.synopsis,
    }));
  } catch {
    // あらすじが無くても矛盾検知はできる。時系列の確認が弱くなるだけ
  }

  return {
    characterCount: people.length,
    locationCount: places.length,
    worldCount: worldItems.length,
    worldview,
    fingerprint,
    relevantFor(text) {
      const seenCharacters = new Set<string>();
      const seenLocations = new Set<string>();
      for (const match of index.find(text)) {
        if (match.entry.kind === "character") seenCharacters.add(match.entry.id);
        if (match.entry.kind === "location") seenLocations.add(match.entry.id);
      }

      const characterText = [...seenCharacters]
        .map((id) => characterById.get(id))
        .filter((item) => item !== undefined)
        .map((item) => describeCharacter(item, []))
        .join("\n\n");
      const locationText = [...seenLocations]
        .map((id) => locationById.get(id))
        .filter((item) => item !== undefined)
        .map((item) => describeLocation(item))
        .join("\n\n");

      return {
        characters: characterText,
        locations: locationText,
        // 世界観は誰が出ていても効くので、それだけでも材料になる
        hasAnything: Boolean(characterText || locationText || worldview),
      };
    },
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
  };
  // 能力・組織はまだ渡していない（引継ぎ書に残した）
  void abilitySystem;
  void organizations;
}

/** 本文をチャンクに分ける。誤字脱字検知と同じ手順 */
async function collectChunks(
  work: WorkEntry,
  registry: AIRegistry,
  options: CheckContradictionsOptions
): Promise<
  | {
      chunks: Chunk[];
      chapterLabelByFile: Map<string, string>;
      /** 何を根拠に大きさを決めたか。ログに残す（設計書6.23） */
      chunkNote: string;
    }
  | undefined
> {
  const scan = await scanWork(work);
  const format = await readWorkFormat(work);
  const targets = options.filePaths
    ? scan.episodes.filter((episode) =>
        options.filePaths!.some(
          (filePath) =>
            path.resolve(filePath).toLowerCase() ===
            path.resolve(episode.filePath).toLowerCase()
        )
      )
    : scan.episodes;

  const info = await registry.resolveModelInfo();
  // コンテキスト長が取れないモデルでは、誤字脱字検知と同じ既定へ落とす
  const chunkSettings = readChunkSettings(info?.contextWindow ?? 8192);
  const maxChars = chunkSettings.chunk.chars;

  const chunks: Chunk[] = [];
  const chapterLabelByFile = new Map<string, string>();

  for (const episode of targets) {
    if (episode.hasConflictMarkers) continue;
    let text: string;
    try {
      text = (await readTextFile(episode.filePath)).text;
    } catch {
      continue;
    }

    const label = formatChapterLabel(episode, format) || episode.fileName;
    for (const chunk of splitIntoChunks(
      episode.filePath,
      text,
      episode.chapterStart,
      episode.chapterEnd,
      { maxChars }
    )) {
      chunks.push(chunk);
    }
    chapterLabelByFile.set(episode.filePath, label);
  }

  // **1話ずつ送ると、指示のほうが本文より大きい**（設計書6.23）。
  // 矛盾検知は設定資料も一緒に送るので、1回あたりの指示はさらに重い。
  // 隣どうしをまとめて呼び出し回数を減らす。返ってきた行番号は
  // `locateChunkLine` で元のファイルへ戻す
  const merged =
    chunkSettings.mergeChars > 0
      ? mergeAdjacentChunks(chunks, { maxChars: chunkSettings.mergeChars })
      : chunks;

  return {
    chunks: merged,
    chapterLabelByFile,
    chunkNote: describeChunkSettings(chunkSettings),
  };
}
