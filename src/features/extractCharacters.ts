import * as vscode from "vscode";
import * as path from "path";
import { WorkEntry } from "../models/types";
import { Character } from "../models/character";
import { AIRegistry, ensureConfigured } from "../ai/registry";
import { AIError, type ProviderId } from "../ai/types";
import { scanWork } from "../core/scanner";
import { readTextFile } from "../core/textFile";
import { parseEpisodeMetadata } from "../core/metadataParser";
import { decideChunkSize, splitIntoChunks, Chunk } from "../core/chunker";
import { CharacterStore } from "../core/characterStore";
import { mergeExtractedCharacters } from "../core/characterMerge";
import {
  BASE_SYSTEM_PROMPT,
  CHARACTER_EXTRACT_SCHEMA,
  CHARACTER_EXTRACT_VERSION,
  CharacterExtractResult,
  ExtractedCharacter,
  buildCharacterExtractPrompt,
} from "../prompts/characterExtract";
import { ChunkCache } from "../core/chunkCache";

export async function extractCharacters(
  work: WorkEntry,
  registry: AIRegistry
): Promise<void> {
  const resolved = await ensureConfigured(registry);
  if (!resolved) return;

  const modelInfo = await registry.resolveModelInfo();
  const contextWindow = modelInfo?.contextWindow ?? 8192;
  const configuredChunkChars = vscode.workspace
    .getConfiguration("novelai")
    .get<number>("chunkChars", 0);
  const chunkChars =
    Number.isInteger(configuredChunkChars) && configuredChunkChars >= 1
      ? configuredChunkChars
      : decideChunkSize(contextWindow);

  // 実際に使うコンテキスト長。モデルの上限をそのまま使うと
  // メモリを大量に消費するため、必要分だけ確保する
  const configuredNumCtx = vscode.workspace
    .getConfiguration("novelai")
    .get<number>("ollama.numCtx", 0);
  const numCtx =
    configuredNumCtx > 0
      ? configuredNumCtx
      : Math.min(contextWindow, 16384);

  const scan = await scanWork(work);
  if (scan.episodes.length === 0) {
    vscode.window.showWarningMessage("本文ファイルが見つかりません。");
    return;
  }

  // 競合マーカーを含むファイルはAI処理をブロックする
  const conflicted: string[] = [];
  const chunks: Chunk[] = [];

  for (const ep of scan.episodes) {
    const file = await readTextFile(ep.filePath);
    if (file.hasConflictMarkers) {
      conflicted.push(ep.fileName);
      continue;
    }
    const meta = parseEpisodeMetadata(file.text);
    const body = meta.body;
    if (!body.trim()) continue;

    chunks.push(
      ...splitIntoChunks(
        ep.filePath,
        body,
        ep.chapterStart,
        ep.chapterEnd,
        { maxChars: chunkChars }
      )
    );
  }

  if (conflicted.length > 0) {
    const proceed = await vscode.window.showWarningMessage(
      `未解決の競合が ${conflicted.length} 件あります（${conflicted
        .slice(0, 3)
        .join(", ")}${conflicted.length > 3 ? " ほか" : ""}）。` +
        "これらのファイルは処理対象から除外されます。",
      "除外して続行",
      "中止"
    );
    if (proceed !== "除外して続行") return;
  }

  if (chunks.length === 0) {
    vscode.window.showWarningMessage("処理できる本文がありません。");
    return;
  }

  const store = new CharacterStore(work);
  const loaded = await store.loadAll();

  if (loaded.errors.length > 0) {
    const msg = loaded.errors
      .map((e) => `${e.file}: ${e.message}`)
      .join("\n");
    const answer = await vscode.window.showErrorMessage(
      `読み込めない設定ファイルがあります。上書きを避けるため処理を中止します。\n${msg}`,
      "詳細を表示",
      "閉じる"
    );
    if (answer === "詳細を表示") {
      const doc = await vscode.workspace.openTextDocument({
        content: msg,
        language: "text",
      });
      await vscode.window.showTextDocument(doc);
    }
    return;
  }

  const cache = new ChunkCache(work);
  await cache.load();

  const cacheKeyBase = {
    feature: "character_extract",
    promptVersion: CHARACTER_EXTRACT_VERSION,
    model: resolved.model,
  };

  // 未処理チャンクの件数を先に出して確認を取る
  const pending = chunks.filter(
    (c) => !cache.get(c.hash, cacheKeyBase)
  );

  if (pending.length === 0) {
    vscode.window.showInformationMessage(
      "すべてのチャンクが処理済みです。キャッシュから人物設定を再反映します。"
    );
  } else {
    const estimateMinutes = Math.ceil((pending.length * 20) / 60);
    const configuredMaxOutputTokens = vscode.workspace
      .getConfiguration("novelai")
      .get<number>("claude.maxOutputTokens", 8192);
    const costNotice = buildExtractionCostNotice(
      resolved.provider.id,
      pending,
      buildKnownCharacterNames(loaded.characters, []),
      configuredMaxOutputTokens
    );
    const confirm = await vscode.window.showInformationMessage(
      `${chunks.length} チャンク中 ${pending.length} 件を処理します` +
        `（処理済み ${chunks.length - pending.length} 件はスキップ）。\n` +
        `モデル: ${resolved.model} / 目安 ${estimateMinutes} 分程度\n` +
        costNotice,
      "実行",
      "中止"
    );
    if (confirm !== "実行") return;
  }

  const extractedAll: Array<{
    data: ExtractedCharacter;
    chapters: number[];
  }> = [];
  const failures: Array<{ chunk: Chunk; message: string }> = [];
  let cancelled = false;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "登場人物を抽出しています",
      cancellable: true,
    },
    async (progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => {
        cancelled = true;
        controller.abort();
      });

      let done = 0;

      for (const chunk of chunks) {
        if (token.isCancellationRequested) break;

        const cached = cache.get(chunk.hash, cacheKeyBase);
        if (cached) {
          collect(extractedAll, cached as CharacterExtractResult, chunk);
          done++;
          continue;
        }

        const label = describeChunk(chunk);
        progress.report({
          message: `${done + 1}/${chunks.length}  ${label}`,
          increment: 100 / chunks.length,
        });

        // 既知の人物名を渡して同一人物判定を助ける
        const knownNames = buildKnownCharacterNames(
          loaded.characters,
          extractedAll
        );

        try {
          const res = await resolved.provider.generate({
            systemPrompt: BASE_SYSTEM_PROMPT,
            userPrompt: buildCharacterExtractPrompt({
              chunkText: chunk.text,
              chapterLabel: label,
              knownCharacterNames: knownNames.slice(0, 100),
            }),
            model: resolved.model,
            temperature: 0.2,
            numCtx,
            jsonSchema: CHARACTER_EXTRACT_SCHEMA as unknown as object,
            disableThinking: true,
            signal: controller.signal,
          });

          const parsed = parseResult(res.text);
          if (!parsed) {
            failures.push({
              chunk,
              message: "応答をJSONとして解析できませんでした",
            });
          } else {
            collect(extractedAll, parsed, chunk);
            await cache.set(chunk.hash, cacheKeyBase, parsed);
          }
        } catch (e) {
          if (e instanceof AIError && e.kind === "aborted") break;
          failures.push({
            chunk,
            message: e instanceof Error ? e.message : String(e),
          });
          // 1チャンクの失敗で全体を止めない
        }

        done++;
      }

      await cache.save();
    }
  );

  if (cancelled) {
    vscode.window.showInformationMessage(
      "登場人物の抽出を中止しました。完了済みの処理は次回再利用されます。"
    );
    return;
  }

  if (extractedAll.length === 0) {
    vscode.window.showWarningMessage(
      "登場人物を抽出できませんでした。" +
        (failures.length > 0 ? `（${failures.length} 件のエラー）` : "")
    );
    return;
  }

  const merged = mergeExtractedCharacters(loaded.characters, extractedAll);

  // 一人称「僕」や「（主）」のような自称だけの name は、AIの誤抽出である
  // 可能性が高い一方、稀に本当にそう呼ばれている人物のこともあるため、
  // 機械的に捨てず作者の承認を求める。新規追加分のみが対象
  // （既存人物への話数追記は自動保存のままでよい）。
  const addedSet = new Set(merged.added);
  const needsApproval = merged.characters.filter(
    (c) => addedSet.has(c.name) && INVALID_NAME_PATTERN.test(c.name)
  );

  let rejected: string[] = [];
  if (needsApproval.length > 0) {
    const picked = await vscode.window.showQuickPick(
      needsApproval.map((c) => ({
        label: c.name,
        description: c.role ?? undefined,
        detail:
          c.evidence?.slice(0, 100) ??
          "本文中の具体的な名前ではなく、自称や代名詞のような表現がnameになっています。",
        picked: false,
        character: c,
      })),
      {
        title: `${needsApproval.length}件の人物名が自称・代名詞のような形になっています。登録するものを選んでください`,
        canPickMany: true,
        ignoreFocusOut: true,
      }
    );
    // キャンセル時は安全側に倒し、すべて除外する
    const approvedNames = new Set((picked ?? []).map((p) => p.character.name));
    rejected = needsApproval
      .filter((c) => !approvedNames.has(c.name))
      .map((c) => c.name);
  }

  const finalCharacters = merged.characters.filter(
    (c) => !rejected.includes(c.name)
  );
  const changedCharacters = selectChangedCharacters(
    merged.characters,
    merged.changedIds,
    rejected
  );
  await store.saveAll(changedCharacters);

  const acceptedAddedCount = merged.added.filter(
    (name) => !rejected.includes(name)
  ).length;

  const parts = [
    `登場人物 ${finalCharacters.length} 名`,
    acceptedAddedCount > 0 ? `新規 ${acceptedAddedCount} 名` : null,
    merged.updated.length > 0 ? `更新 ${merged.updated.length} 名` : null,
    merged.conflicts.length > 0
      ? `要確認 ${merged.conflicts.length} 件`
      : null,
    rejected.length > 0 ? `未承認のため除外 ${rejected.length} 件` : null,
    failures.length > 0 ? `失敗 ${failures.length} チャンク` : null,
  ].filter(Boolean);

  const action = await vscode.window.showInformationMessage(
    parts.join(" / "),
    "一覧を開く"
  );
  if (action === "一覧を開く") {
    const store2 = new CharacterStore(work);
    const dir = await store2.ensureDir();
    await vscode.commands.executeCommand(
      "revealInExplorer",
      vscode.Uri.file(dir)
    );
  }
}

/** 実行前に、プロバイダごとの料金上の影響を明示する。 */
export function buildExtractionCostNotice(
  providerId: ProviderId,
  pendingChunks: Chunk[],
  knownCharacterNames: string[],
  configuredMaxOutputTokens: number
): string {
  if (providerId === "ollama") {
    return "料金: 無料・ローカル実行（API課金なし）";
  }
  if (providerId !== "claude") return "";

  // UTF-8の各バイトを1トークンとして数え、実際より少なく見せにくい
  // 上限寄りの概算にする。単価は変わりうるため金額には換算しない。
  const names = knownCharacterNames.slice(0, 100);
  const estimatedInputTokens = pendingChunks.reduce((total, chunk) => {
    const userPrompt = buildCharacterExtractPrompt({
      chunkText: chunk.text,
      chapterLabel: describeChunk(chunk),
      knownCharacterNames: names,
    });
    return (
      total +
      new TextEncoder().encode(BASE_SYSTEM_PROMPT).length +
      new TextEncoder().encode(userPrompt).length
    );
  }, 0);
  const perCall =
    Number.isInteger(configuredMaxOutputTokens) &&
    configuredMaxOutputTokens >= 1024
      ? configuredMaxOutputTokens
      : 8192;
  const totalOutputTokens = perCall * pendingChunks.length;

  return [
    "【課金対象トークン量の目安（上限寄り）】",
    `入力: 約 ${estimatedInputTokens.toLocaleString("ja-JP")} トークン` +
      "（実際に送る予定のチャンクと指示文をUTF-8バイト数で保守的に概算）",
    `出力: 最大 ${totalOutputTokens.toLocaleString("ja-JP")} トークン` +
      `（設定上限 ${perCall.toLocaleString("ja-JP")} × ${pendingChunks.length} 回）`,
    "Claude APIは実行すると課金が発生します。実際の金額はモデル、実使用量、" +
      "Anthropicの現行料金によって変わります。",
  ].join("\n");
}

/** 次のチャンクへ渡す既知名。直前までに得た別名も含める */
export function buildKnownCharacterNames(
  existing: Array<{ name: string; aliases: string[] }>,
  extracted: Array<{ data: ExtractedCharacter }>
): string[] {
  const names = [
    ...existing.flatMap((character) => [character.name, ...character.aliases]),
    ...extracted.flatMap((item) => [
      item.data.name,
      ...(Array.isArray(item.data.aliases) ? item.data.aliases : []),
    ]),
  ]
    .map((name) => name.trim())
    .filter(Boolean);
  return [...new Set(names)];
}

/** 変更された人物のうち、作者が除外しなかったものだけを書き戻す */
export function selectChangedCharacters(
  characters: Character[],
  changedIds: string[],
  rejectedNames: string[]
): Character[] {
  const changed = new Set(changedIds);
  const rejected = new Set(rejectedNames);
  return characters.filter(
    (character) => changed.has(character.id) && !rejected.has(character.name)
  );
}

// AIが「値なし」の代わりに返しがちな文字列（"null"等）や、一人称・代名詞
// だけの自称（「（主）」等）。空文字と違い trim() では弾けない。
// 完全に無効な値だけでなく「本当にそう呼ばれている可能性」も残る自称も
// 含むため、ここでは捨てずに extractCharacters() 側で作者の承認を求める
export const INVALID_NAME_PATTERN =
  /^(null|undefined|不明|なし|n\/?a|none|[（(]?主[）)]?|主人公)$/i;
// characterFileName() のファイル名切り詰め長と合わせた。これを超える場合は
// 文章まるごとが name に入ってしまっている疑いが強い
const MAX_NAME_LENGTH = 30;

export function collect(
  out: Array<{ data: ExtractedCharacter; chapters: number[] }>,
  result: CharacterExtractResult,
  chunk: Chunk
): void {
  const chapters: number[] = [];
  if (chunk.chapterStart !== null) {
    const end = chunk.chapterEnd ?? chunk.chapterStart;
    for (let n = chunk.chapterStart; n <= end; n++) chapters.push(n);
  }
  const rawCharacters: unknown = result.characters;
  if (!Array.isArray(rawCharacters)) return;

  for (const raw of rawCharacters) {
    const character = normalizeExtractedCharacter(raw);
    if (!character) continue;
    if (!evidenceIsGrounded(character.evidence, chunk.text)) continue;
    out.push({ data: character, chapters });
  }
}

/** AI応答を後段が安全に扱える形へ正規化する */
export function normalizeExtractedCharacter(
  raw: unknown
): ExtractedCharacter | null {
  if (!isRecord(raw)) return null;
  const name = cleanRequiredString(raw.name);
  if (!name || name.length > MAX_NAME_LENGTH) return null;

  const character: ExtractedCharacter = {
    name,
    aliases: cleanStringArray(raw.aliases).filter((alias) => alias !== name),
  };

  if (typeof raw.isMob === "boolean") {
    character.isMob = raw.isMob;
  }

  copyNullableString(character, raw, "role");
  copyNullableString(character, raw, "personality");
  copyNullableString(character, raw, "appearance");
  copyNullableString(character, raw, "firstPerson");
  copyNullableString(character, raw, "defaultSecondPerson");
  copyNullableString(character, raw, "evidence");

  if ("addressTerms" in raw) {
    character.addressTerms = Array.isArray(raw.addressTerms)
      ? raw.addressTerms.flatMap((item) => {
          if (!isRecord(item)) return [];
          const targetName = cleanRequiredString(item.targetName);
          const term = cleanRequiredString(item.term);
          if (!targetName || !term) return [];
          return [
            {
              targetName,
              term,
              category: cleanNullableString(item.category),
              context: cleanNullableString(item.context),
              evidence: cleanNullableString(item.evidence),
            },
          ];
        })
      : [];
  }

  if ("relations" in raw) {
    character.relations = Array.isArray(raw.relations)
      ? raw.relations.flatMap((item) => {
          if (!isRecord(item)) return [];
          const relationName = cleanRequiredString(item.name);
          const relation = cleanRequiredString(item.relation);
          return relationName && relation
            ? [{ name: relationName, relation }]
            : [];
        })
      : [];
  }

  return character;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanRequiredString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned || null;
}

function cleanNullableString(value: unknown): string | null {
  return cleanRequiredString(value);
}

function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const strings = value
    .map(cleanRequiredString)
    .filter((item): item is string => item !== null);
  return [...new Set(strings)];
}

function copyNullableString<K extends keyof ExtractedCharacter>(
  target: ExtractedCharacter,
  source: Record<string, unknown>,
  key: K
): void {
  if (!(key in source)) return;
  target[key] = cleanNullableString(source[key]) as ExtractedCharacter[K];
}

/**
 * evidence が本文中に実在するか確認する。
 * 複数の引用が句点・改行区切りで1つの文字列に連結されていることがあるため、
 * いずれか1断片でも本文中に見つかれば根拠ありとする。
 * evidence が無い・短すぎて判定できない場合はAIが単に書かなかっただけの
 * 可能性が高いため、取りこぼしを避けて素通りさせる。
 */
function evidenceIsGrounded(
  evidence: string | null | undefined,
  chunkText: string
): boolean {
  if (!evidence || !evidence.trim()) return true;
  const segments = evidence
    .split(/[\n。]/)
    .map((s) => s.replace(/^[「『"'…\s]+|[」』"'…\s]+$/g, ""))
    .filter((s) => s.length >= 4);
  if (segments.length === 0) return true;
  return segments.some((s) => chunkText.includes(s));
}

/**
 * 応答をJSONとして解析する。
 * 構造化出力を指定していても、モデルによっては前後に文字が付くことがある。
 */
export function parseResult(text: string): CharacterExtractResult | null {
  const attempts = [
    text,
    text.replace(/^[\s\S]*?```(?:json)?\s*/i, "").replace(/```[\s\S]*$/, ""),
    extractBraces(text),
  ];

  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed && Array.isArray(parsed.characters)) {
        return parsed as CharacterExtractResult;
      }
    } catch {
      // 次の候補を試す
    }
  }
  return null;
}

function extractBraces(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

function describeChunk(chunk: Chunk): string {
  const name = path.basename(chunk.filePath);
  if (chunk.chapterStart === null) return name;
  const ch =
    chunk.chapterEnd !== null && chunk.chapterEnd !== chunk.chapterStart
      ? `第${chunk.chapterStart}〜${chunk.chapterEnd}話`
      : `第${chunk.chapterStart}話`;
  return chunk.index > 0 ? `${ch}(${chunk.index + 1})` : ch;
}
