import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { AIRegistry, ensureConfigured } from "../ai/registry";
import {
  resolveOutputLimitForSend,
  resolveOutputTokensForPlanning,
} from "../ai/outputLimit";
import { AIError } from "../ai/types";
import { confirmPaidUsage, confirmProviderReachable } from "./aiConnectivity";
import { withCancellableProgress } from "../views/progress";
import { askText, cancelItem, isCancelItem } from "../views/dialogs";
import {
  buildReadingDictionaryPrompt,
  READING_DICTIONARY_CHUNK_CHARS,
  READING_DICTIONARY_SCHEMA,
  READING_DICTIONARY_SYSTEM_PROMPT,
  READING_DICTIONARY_VERSION,
} from "../prompts/readingDictionary";
import {
  checkAuthorReading,
  editReading,
  mergeReadingEntries,
  normalizeAuthorReading,
  parseReadingDictionaryResult,
  readingChunksOf,
  readingEntryKey,
  readingSpansFor,
  removeReading,
  validateReadingItems,
  type ReadingEntry,
  type ReadingSpan,
} from "../core/readingDictionary";
import {
  loadReadingDictionary,
  saveReadingDictionary,
} from "../core/readingDictionaryStore";
import { ChunkCache, type CacheKeyBase } from "../core/chunkCache";
import { hashText } from "../core/hash";
import {
  logFailure,
  logStep,
  responseExcerptForLog,
  useLogFile,
} from "../core/logger";
import { reportAIError } from "./reportAIError";
import { notifyDone, warnWithLog } from "../views/notify";

/**
 * 読み上げの読みの辞書（P-50、設計書6.42.1）。
 *
 * 原稿エディタの読み上げの列にある［読みを確かめる（AI）］から呼ぶ。
 * AIに、その話の中で**読みが2通り以上ある語**を「句」と「その場所の読み」で
 * 挙げさせ、検算を通ったものを話ごとの辞書へしまう。次の［▶ 読む］から、
 * 声へ渡す写しだけが辞書の読みに差し替わる（本文は1字も変えない）。
 *
 * ## 実行の札は取らない（設計書6.76）
 *
 * 1話を数回に分けて送るだけで、作者が読み上げの前に押す操作である。
 * 誤字脱字の10分の裏で押したときに待たされる作りにしない（口述の整文と同じ）。
 *
 * ## 手元のAIなら確認なしで走る
 *
 * 作者の裁定（2026-10-18）。手元のAI（Ollama・LM Studio）は費用が掛からず、
 * 読み上げの前に押すたびに確認が出ると使わなくなる。**有料のAIでだけ**、
 * 送る量と呼び出し回数を示して確かめる（CLAUDE.md の実装スタイル）。
 */

/** 原稿エディタから渡す、確かめる話 */
export interface ReadingDictionaryTarget {
  work: WorkEntry;
  /** 話のファイル（辞書の置き場を決める） */
  episodePath: string;
  /** いま画面が持っている本文（LF区切り。句はこの中から探す） */
  text: string;
}

/** 読み上げに当てる範囲と、一覧の様子 */
export interface ReadingDictionarySummary {
  spans: ReadingSpan[];
  /** 使っている項目の数（消した項目は数えない） */
  active: number;
  /** 句が本文に見当たらない項目の数 */
  missing: number;
  /** 辞書が読めなかったときの理由（読み上げは辞書なしで続ける） */
  problem?: string;
}

/**
 * 読み上げに当てる範囲を求める。**失敗しても投げない**——辞書が読めない
 * からといって読み上げそのものを止めると、声で確かめる道具が使えなくなる。
 */
export async function readingDictionarySummary(
  target: ReadingDictionaryTarget
): Promise<ReadingDictionarySummary> {
  try {
    const { file } = await loadReadingDictionary(target.work, target.episodePath);
    const result = readingSpansFor(target.text, file.entries);
    return {
      spans: result.spans,
      active: file.entries.filter((entry) => !entry.removed).length,
      missing: result.missing.length,
    };
  } catch (error) {
    return {
      spans: [],
      active: 0,
      missing: 0,
      problem: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 区切り1つぶんの控え（チャンクキャッシュへしまう形）。
 *
 * **検算する前のAIの答え（項目の並び）をしまう。** 検算を後から締めたとき
 * （2026-10-19、読みの長さの上限）、検算済みの項目をしまっていると、古い
 * 検算で通った項目が控えから出続ける。答えをしまい、使うたびにいまの検算に通す。
 */
interface CachedChunk {
  items: unknown[];
}

function isCachedChunk(value: unknown): value is CachedChunk {
  if (typeof value !== "object" || value === null) return false;
  return Array.isArray((value as Record<string, unknown>).items);
}

/**
 * AIで辞書を作る（作り直す）。
 *
 * 1. 本文を行の切れ目で区切る（シーンメモは送らない）
 * 2. 区切りごとに、**内容ハッシュ＋プロバイダID＋モデル名＋プロンプト版**で
 *    控えを引く（CLAUDE.md 実装ルール4）。当たった区切りは送らない
 * 3. 送った区切りの答えを検算し、通ったものだけ控えへ入れる
 * 4. ぜんぶ揃ったときだけ辞書へ混ぜる。**作者が直した・消した項目は残る**
 *
 * 1つでも区切りが失敗したら辞書は書き換えない（AIの項目を、揃っていない
 * 答えで入れ替えると、失敗した区切りの項目が消える）。成功した区切りは
 * 控えに入っているので、押し直すと失敗した所だけを送る。
 */
export async function runReadingDictionary(
  target: ReadingDictionaryTarget,
  registry: AIRegistry
): Promise<void> {
  const { work } = target;
  useLogFile(work.folderPath);

  const chunks = readingChunksOf(target.text, READING_DICTIONARY_CHUNK_CHARS);
  if (chunks.length === 0) {
    notifyDone("読みを確かめる本文がありません");
    return;
  }

  // 新しく設けた割当（`readingDictionary`）。割り当てていなければ既定のAI
  const resolved = await ensureConfigured(registry, "readingDictionary");
  if (!resolved) return;

  // **繋がるかを、費用の確認より先に確かめる**（設計書6.51）
  if (
    !(await confirmProviderReachable(
      resolved.provider,
      "読みの確かめ",
      resolved.model
    ))
  ) {
    return;
  }

  // 辞書が壊れていたら、AIを呼ぶ前に止める（呼んでから書けないと分かっても遅い）
  let loaded;
  try {
    loaded = await loadReadingDictionary(work, target.episodePath);
  } catch (error) {
    void warnWithLog(error instanceof Error ? error.message : String(error));
    return;
  }

  const base: CacheKeyBase = {
    feature: "readingDictionary",
    promptVersion: READING_DICTIONARY_VERSION,
    providerId: resolved.provider.id,
    model: resolved.model,
  };
  const cache = new ChunkCache(work);
  await cache.load();
  const hashes = chunks.map((chunk) => hashText(chunk.text));
  const pending = chunks
    .map((chunk, index) => ({ chunk, hash: hashes[index] }))
    .filter(({ hash }) => !isCachedChunk(cache.get(hash, base)));

  if (pending.length > 0 && resolved.provider.isPaid) {
    const chars = pending.reduce((sum, { chunk }) => sum + chunk.text.length, 0);
    const ok = await confirmPaidUsage(resolved.provider, {
      actionLabel: "読みの確かめ",
      model: resolved.model,
      calls: pending.length,
      sends:
        `この話の本文 ${chars.toLocaleString("ja-JP")}字` +
        "（前回から変わっていない所は送りません）",
      remember: { id: "ai.paid.readingDictionary" },
      work,
    });
    if (!ok) return;
  }

  const plannedOutputTokens = resolveOutputTokensForPlanning(
    resolved.provider.id,
    resolved.model,
    "readingDictionary"
  );
  const outputLimit = resolveOutputLimitForSend(
    resolved.provider.id,
    resolved.model,
    "readingDictionary"
  );

  let failed = 0;
  let cancelled = false;
  if (pending.length > 0) {
    await withCancellableProgress(
      "読み上げの読みを確かめています",
      async (progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        logStep(
          `読みの確かめを開始: ${work.title} / ${pending.length}区切り / ` +
            `${resolved.provider.displayName} / ${resolved.model} / ` +
            `v${READING_DICTIONARY_VERSION}`
        );
        for (let i = 0; i < pending.length; i++) {
          if (token.isCancellationRequested) {
            cancelled = true;
            return;
          }
          progress.report({
            message: `${i + 1}/${pending.length}`,
            increment: 100 / pending.length,
          });
          const { chunk, hash } = pending[i];
          try {
            const response = await resolved.provider.generate({
              systemPrompt: READING_DICTIONARY_SYSTEM_PROMPT,
              userPrompt: buildReadingDictionaryPrompt({ text: chunk.text }),
              model: resolved.model,
              // **揺らさない。** 読みは1つに決まるもので、多様さは要らない
              temperature: 0,
              maxOutputTokens: outputLimit.tokens,
              plannedOutputTokens,
              jsonSchema: READING_DICTIONARY_SCHEMA as unknown as object,
              disableThinking: true,
              signal: controller.signal,
              meta: { feature: "readingDictionary", workFolder: work.folderPath },
            });
            const items = parseReadingDictionaryResult(response.text);
            if (!items) {
              failed++;
              logFailure("読みの確かめ", {
                理由: response.truncated
                  ? "応答が出力上限で切り詰められました"
                  : "応答を読み取れません",
                応答: responseExcerptForLog(response.text),
              });
              continue;
            }
            // 検算は控えから取り出すときに行う（下。控えの説明を参照）
            await cache.set(hash, base, { items } satisfies CachedChunk);
          } catch (error) {
            if (error instanceof AIError && error.kind === "aborted") {
              cancelled = true;
              return;
            }
            failed++;
            reportAIError("読みの確かめ", error, resolved.provider.id);
          }
        }
      }
    );
    await cache.save();
  }

  if (cancelled) {
    notifyDone(
      "読みの確かめを中止しました。辞書は書き換えていません（済んだ所は、次に押したときに送りません）。"
    );
    return;
  }
  if (failed > 0) {
    void warnWithLog(
      `読みの確かめで${failed}か所が失敗しました。辞書は書き換えていません。` +
        "もう一度押すと、失敗した所だけを送り直します。"
    );
    return;
  }

  const fresh: ReadingEntry[] = [];
  let dropped = 0;
  chunks.forEach((chunk, index) => {
    const cached = cache.get(hashes[index], base);
    if (!isCachedChunk(cached)) return;
    // **AIを信用しない**（CLAUDE.md 実装ルール3）。句は送った区切りの中に在るはず
    const checked = validateReadingItems(chunk.text, cached.items);
    if (checked.dropped.length > 0) {
      logStep(
        `読みの確かめ：検算で${checked.dropped.length}件を捨てました（` +
          checked.dropped
            .map((d) => `${d.reason}: ${JSON.stringify(d.item)}`)
            .join(" / ") +
          "）"
      );
    }
    fresh.push(...checked.entries);
    dropped += checked.dropped.length;
  });
  const entries = mergeReadingEntries(loaded.file.entries, fresh);
  try {
    await saveReadingDictionary(
      work,
      target.episodePath,
      {
        ...loaded.file,
        entries,
        lastRun: {
          providerId: resolved.provider.id,
          model: resolved.model,
          promptVersion: READING_DICTIONARY_VERSION,
          at: new Date().toISOString(),
          dropped,
        },
      },
      loaded.hash
    );
  } catch (error) {
    void warnWithLog(error instanceof Error ? error.message : String(error));
    return;
  }

  const active = entries.filter((entry) => !entry.removed).length;
  logStep(
    `読みの確かめが終わりました: 辞書${active}件（AIの答え${fresh.length}件・検算で捨てた${dropped}件・` +
      `送った区切り${pending.length}/${chunks.length}）`
  );
  notifyDone(
    active === 0
      ? "読み違えやすい語は見つかりませんでした。"
      : `読み違えやすい語を${active}件、辞書に入れました。次の［▶ 読む］から使います。`
  );
}

/**
 * 辞書の一覧を見る・読みを直す・項目を消す（設計書6.42.1）。
 *
 * **直した項目・消した項目は作者のものになる**（`source: "author"`）。
 * AIで作り直しても、上書きされない。
 *
 * 変えたら true（呼び手が画面の様子を出し直す）。
 */
export async function manageReadingDictionary(
  target: ReadingDictionaryTarget
): Promise<boolean> {
  let changed = false;
  for (;;) {
    let loaded;
    try {
      loaded = await loadReadingDictionary(target.work, target.episodePath);
    } catch (error) {
      void vscode.window.showErrorMessage(
        error instanceof Error ? error.message : String(error)
      );
      return changed;
    }
    const live = loaded.file.entries.filter((entry) => !entry.removed);
    const missing = new Set(
      readingSpansFor(target.text, live).missing.map(readingEntryKey)
    );

    const picked = await vscode.window.showQuickPick(
      [
        ...live.map((entry) => ({
          label: `${entry.word} → ${entry.reading}`,
          description: `「${entry.quote}」`,
          detail:
            [
              missing.has(readingEntryKey(entry)) ? "本文に見当たりません" : "",
              entry.source === "author" ? "直した読み" : "",
            ]
              .filter(Boolean)
              .join("・") || undefined,
          entry,
        })),
        cancelItem("閉じる"),
      ],
      {
        title: `読みの辞書（${live.length}件）`,
        placeHolder:
          live.length === 0
            ? "まだ1件もありません。［読みを確かめる（AI）］で作れます"
            : "直したい項目を選んでください",
        ignoreFocusOut: true,
      }
    );
    if (!picked || isCancelItem(picked) || !("entry" in picked)) return changed;

    const entry = picked.entry;
    const action = await vscode.window.showQuickPick(
      [
        { label: "読みを直す", action: "edit" as const },
        { label: "この項目を消す", description: "AIで作り直しても戻りません", action: "remove" as const },
        cancelItem("戻る"),
      ],
      { title: `${entry.word}（「${entry.quote}」）`, ignoreFocusOut: true }
    );
    if (!action || isCancelItem(action) || !("action" in action)) continue;

    let next: ReadingEntry[];
    if (action.action === "edit") {
      const typed = await askText({
        title: `「${entry.quote}」の ${entry.word} の読み`,
        prompt: "ひらがなで入れてください（カタカナはひらがなに直します）",
        value: entry.reading,
        validateInput: (value) => checkAuthorReading(value),
      });
      if (typed === undefined) continue;
      next = editReading(
        loaded.file.entries,
        readingEntryKey(entry),
        normalizeAuthorReading(typed)
      );
    } else {
      next = removeReading(loaded.file.entries, readingEntryKey(entry));
    }
    try {
      await saveReadingDictionary(
        target.work,
        target.episodePath,
        { ...loaded.file, entries: next },
        loaded.hash
      );
      changed = true;
    } catch (error) {
      void warnWithLog(error instanceof Error ? error.message : String(error));
      return changed;
    }
  }
}
