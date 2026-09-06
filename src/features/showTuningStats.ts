import type { AIRegistry } from "../ai/registry";
import { allModelTuning } from "../core/modelTuning";
import {
  TUNING_STATS_TITLE,
  buildTuningStatsMarkdown,
  tuningStatsEntries,
} from "../core/tuningStats";
import { openGeneratedMarkdown } from "../views/openDocument";

/**
 * AIチューニングで測った値を、1枚の表にして開く（作者の要望、2026-09-06
 * 「速度が一番早いモデルがわかる統計の一覧が出ると嬉しい」）。
 *
 * **測り直さない。** 台帳（`core/modelTuning.ts`）に入っている値を並べる
 * だけなので、AIは1回も呼ばず、有料AIでも料金は出ない。
 *
 * 表の組み立ては `core/tuningStats.ts`（純粋関数）にあり、ここは
 * 「台帳を読む・AIの表示名を当てる・開く」だけを持つ。
 *
 * ## 置き場は拡張機能の保管庫
 *
 * 使い方（`openManual.ts`）と同じで、**作品フォルダーへは書き出さない。**
 * 測ったのはモデルの性質であって作品の性質ではないので、作者の作品と
 * 一緒にGitHubへ持ち歩かせる理由が無い。
 */
export async function showTuningStats(registry: AIRegistry): Promise<void> {
  /*
    プロバイダIDを表示名へ直す。

    **表示名を知っているのはプロバイダ自身だけ**なので、ここに
    「ollama → Ollama」の写しを作らない（増えたときに片方だけ古くなる）。
    見つからない鍵はIDのまま出す——ブラウザ版では手元のAIが一覧に出ない
    （`listProviders`）が、測った記録そのものは残っているので、
    行ごと消すより「ollama」と出るほうが親切である。
  */
  // 鍵は台帳から来る**ただの文字列**なので、`ProviderId` では引けない
  // （作者が手で書いた覚え書きが混ざっていることもある）
  const labels = new Map<string, string>(
    registry
      .listProviders()
      .map((provider) => [provider.id, provider.displayName])
  );

  const markdown = buildTuningStatsMarkdown(
    tuningStatsEntries(allModelTuning(), (id) => labels.get(id) ?? id)
  );

  // どの画面で読むかは作者の割り当てに任せる（`openGeneratedMarkdown`）
  await openGeneratedMarkdown(TUNING_STATS_TITLE, markdown);
}
