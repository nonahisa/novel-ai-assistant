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
  episodeRelativePath,
  loadReadingDictionary,
  saveReadingDictionary,
  type LoadedReadingDictionary,
} from "../core/readingDictionaryStore";
import {
  adoptImeWordProposal,
  dismissImeWord,
  imeWordProposals,
  type ImeWordProposal,
} from "../core/imeWordReading";
import {
  loadImeReadingDismissals,
  loadImeWordReadings,
  updateImeReadingDismissals,
} from "../core/imeWordReadingStore";
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
  /** IMEで打った読みの提案の数（設計書6.42.2） */
  imeSuggestions?: number;
}

/**
 * その話の、いま一覧に出すIMEの読みの提案（設計書6.42.2）。
 *
 * 句は確定した時点では決めず、ここで**いまの本文から**求める（本文を直しても、
 * 一覧を開いた時点の本文で句が決まる）。控え・見送りの印が読めなければ投げる
 * （呼ぶ側が、提案なしで続けるか止めるかを決める）
 */
async function imeProposalsFor(
  target: ReadingDictionaryTarget,
  dictionary: readonly ReadingEntry[]
): Promise<ImeWordProposal[]> {
  const words = await loadImeWordReadings(target.work);
  const dismissals = await loadImeReadingDismissals(target.work);
  return imeWordProposals({
    entries: words.file.entries,
    dismissals: dismissals.file,
    dictionary,
    episode: episodeRelativePath(target.work, target.episodePath),
    text: target.text,
  });
}

/**
 * 読み上げに当てる範囲を求める。**失敗しても投げない**——辞書が読めない
 * からといって読み上げそのものを止めると、声で確かめる道具が使えなくなる。
 *
 * IMEの読みの提案は**読み上げに使わない**（採るまでは提案のまま）。数だけ数える。
 * 控えが読めなくても数を0にするだけで、辞書の範囲は返す
 */
export async function readingDictionarySummary(
  target: ReadingDictionaryTarget
): Promise<ReadingDictionarySummary> {
  try {
    const { file } = await loadReadingDictionary(target.work, target.episodePath);
    const result = readingSpansFor(target.text, file.entries);
    let imeSuggestions = 0;
    try {
      imeSuggestions = (await imeProposalsFor(target, file.entries)).length;
    } catch (error) {
      useLogFile(target.work.folderPath);
      logStep(
        `IMEの読みの提案を数えられませんでした（${
          error instanceof Error ? error.message : String(error)
        }）`
      );
    }
    return {
      spans: result.spans,
      active: file.entries.filter((entry) => !entry.removed).length,
      missing: result.missing.length,
      imeSuggestions,
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
 * IMEで打った読みの提案（設計書6.42.2）も先頭に並べ、選ぶと［採る］／［見送る］。
 * 決めたあと一覧へ戻るときは、題にいましたことと残りの件数を出す。**最後の1件を
 * 片づけたら一覧へ戻らずに閉じて知らせる**——毎回同じ一覧へ戻ると、全部片づけても
 * 終わったのか分からなかった（作者の指摘、2026-10-25 夜）。最初から提案が無い
 * （辞書の項目を見に来た）ときは今までどおり一覧を出す。
 *
 * 変えたら true（呼び手が画面の様子を出し直す）。
 */
export async function manageReadingDictionary(
  target: ReadingDictionaryTarget
): Promise<boolean> {
  let changed = false;
  let imeWarned = false;
  // 直前に片づけた提案の一言（「「港」を読みの辞書に入れました。」）。次の一覧の題に
  // 1度だけ出す。辞書の項目を直したあとまで残すと、何の話か分からなくなる
  let lastDecision: string | undefined;
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
    // IMEの読みの提案（設計書6.42.2）。控えが読めなくても辞書の一覧は出す
    // （知らせは1度だけ。周回のたびに出さない）
    let proposals: ImeWordProposal[] = [];
    try {
      proposals = await imeProposalsFor(target, loaded.file.entries);
    } catch (error) {
      if (!imeWarned) {
        imeWarned = true;
        void warnWithLog(error instanceof Error ? error.message : String(error));
      }
    }
    const decided = lastDecision;
    lastDecision = undefined;
    if (decided !== undefined && proposals.length === 0) {
      notifyDone(`${decided}IMEの読みの提案はすべて片づきました。`);
      return changed;
    }

    const picked = await vscode.window.showQuickPick(
      [
        // 提案を先頭に置く（採るまで読み上げに使わないので、目に入る所へ）
        ...proposals.map((proposal) => ({
          label: `${proposal.word} → ${proposal.reading}（IMEで打った読み）`,
          description: `「${proposal.quote}」`,
          detail: proposal.aiReading ? `AIの読み：${proposal.aiReading}` : undefined,
          proposal,
        })),
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
        title:
          decided !== undefined
            ? `${decided}IMEの読みの提案：残り${proposals.length}件`
            : proposals.length > 0
            ? `読みの辞書（${live.length}件・IMEの読みの提案${proposals.length}件）`
            : `読みの辞書（${live.length}件）`,
        placeHolder:
          live.length === 0 && proposals.length === 0
            ? "まだ1件もありません。［読みを確かめる（AI）］で作れます"
            : proposals.length > 0
              ? "提案は選ぶと［採る］／［見送る］を選べます。辞書の項目は選ぶと直せます"
              : "直したい項目を選んでください",
        ignoreFocusOut: true,
      }
    );
    if (!picked || isCancelItem(picked)) return changed;
    if ("proposal" in picked) {
      const result = await decideImeProposal(target, loaded, picked.proposal);
      if (result === "failed") return changed;
      if (result === "adopted") {
        changed = true;
        lastDecision = `「${picked.proposal.word}」を読みの辞書に入れました。`;
      } else if (result === "dismissed") {
        changed = true;
        lastDecision = `「${picked.proposal.word}」の提案を見送りました。`;
      }
      continue;
    }
    if (!("entry" in picked)) return changed;

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

/**
 * IMEの読みの提案を1件、［採る］か［見送る］（作者の選択 Q3：まとめて採る道は
 * 出さない。1件ずつ句を見て決める）。
 *
 * - ［採る］：その話の辞書へ作者の項目として書く。同じ語・同じ句のAIの項目は
 *   置き換える。**読み込んだときのハッシュを渡す**（同期で別の機械の直しが
 *   入っていたら書かずに止める）
 * - ［見送る］：見送りの印（同期する）を足す。次から同じ（話・語・読み）は出ない
 *
 * @returns 採ったら adopted、見送ったら dismissed、戻ったら kept、書けなかったら failed
 */
async function decideImeProposal(
  target: ReadingDictionaryTarget,
  loaded: LoadedReadingDictionary,
  proposal: ImeWordProposal
): Promise<"adopted" | "dismissed" | "kept" | "failed"> {
  const action = await vscode.window.showQuickPick(
    [
      {
        label: "採る",
        description: "この句の読みとして辞書に入れます（AIで作り直しても残ります）",
        action: "adopt" as const,
      },
      {
        label: "見送る",
        description: "辞書に入れず、この提案を次から出しません",
        action: "dismiss" as const,
      },
      cancelItem("戻る"),
    ],
    {
      title:
        `${proposal.word} → ${proposal.reading}（「${proposal.quote}」）` +
        (proposal.aiReading ? `　AIの読み：${proposal.aiReading}` : ""),
      ignoreFocusOut: true,
    }
  );
  if (!action || isCancelItem(action) || !("action" in action)) return "kept";
  try {
    if (action.action === "adopt") {
      await saveReadingDictionary(
        target.work,
        target.episodePath,
        { ...loaded.file, entries: adoptImeWordProposal(loaded.file.entries, proposal) },
        loaded.hash
      );
    } else {
      const episode = episodeRelativePath(target.work, target.episodePath);
      await updateImeReadingDismissals(target.work, (file) =>
        dismissImeWord(
          file,
          { episode, word: proposal.word, reading: proposal.reading },
          new Date().toISOString()
        )
      );
      return "dismissed";
    }
    return "adopted";
  } catch (error) {
    void warnWithLog(error instanceof Error ? error.message : String(error));
    return "failed";
  }
}
