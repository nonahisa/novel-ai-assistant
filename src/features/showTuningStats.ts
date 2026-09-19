import type { AIRegistry } from "../ai/registry";
import type { AIProvider } from "../ai/types";
import { allModelTuning, modelTuningKey } from "../core/modelTuning";
import type { ModelExperts } from "../core/modelExperts";
import {
  TUNING_STATS_TITLE,
  buildTuningStatsMarkdown,
  splitTuningKey,
  tuningStatsEntries,
} from "../core/tuningStats";
import { openGeneratedMarkdown } from "../views/openDocument";

/**
 * AIチューニングで測った値を、1枚の表にして開く（作者の要望、2026-09-06
 * 「速度が一番早いモデルがわかる統計の一覧が出ると嬉しい」）。
 *
 * **測り直さない。** 台帳（`core/modelTuning.ts`）に入っている値を並べる
 * だけなので、生成は1回も頼まず、有料AIでも料金は出ない。
 *
 * **部品の使い方（`core/modelExperts.ts`）だけは、そのつど訊く**（作者の
 * 指示、2026-09-19）。台帳には無い値で、モデルの性質なので書き写さない
 * （CLAUDE.md 規則6）。訊く先は手元で無料に動く Ollama だけなので、
 * 上の「料金は出ない」は変わらない。
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

  const table = allModelTuning();
  const experts = await readExpertsFor(registry, table.keys());

  const markdown = buildTuningStatsMarkdown(
    tuningStatsEntries(
      table,
      (id) => labels.get(id) ?? id,
      (providerId, model) => experts.get(modelTuningKey(providerId, model))
    )
  );

  // どの画面で読むかは作者の割り当てに任せる（`openGeneratedMarkdown`）
  await openGeneratedMarkdown(TUNING_STATS_TITLE, markdown);
}

/**
 * 台帳の行に、部品の内訳（`core/modelExperts.ts`）を添える。
 *
 * **台帳へは書き写さない**（CLAUDE.md 規則6）。部品の数はモデルの性質で
 * あって作者が測った値ではないので、答えられるAIにそのつど訊く。
 *
 * **訊くのは、答える口を持つプロバイダだけ**（`describeExperts` を実装して
 * いるもの＝いまは Ollama だけ）。手元で無料に動くものなので、この画面が
 * 「AIに生成を頼まない・料金が出ない」ことは変わらない。
 *
 * **並行で訊く。** モデルが10個あれば10回の往復になるが、順に待つと
 * 一覧が開くまでが目に見えて遅くなる。訊けなかったぶんは欄が空のままになる
 * だけで、一覧そのものは必ず開く。
 */
async function readExpertsFor(
  registry: AIRegistry,
  keys: Iterable<string>
): Promise<Map<string, ModelExperts>> {
  const askable = registry
    .listProviders()
    .filter(
      (provider): provider is AIProvider & Required<Pick<AIProvider, "describeExperts">> =>
        typeof provider.describeExperts === "function"
    );
  if (askable.length === 0) return new Map();

  const asked: Array<Promise<[string, ModelExperts | undefined]>> = [];
  for (const key of keys) {
    const { providerId, model } = splitTuningKey(key);
    if (model.length === 0) continue;
    const provider = askable.find((candidate) => candidate.id === providerId);
    if (!provider) continue;
    asked.push(
      provider
        .describeExperts(model)
        // **一覧を落とさない。** 1つのモデルで失敗しても、ほかの行は出す
        .catch(() => undefined)
        .then((experts) => [key, experts] as [string, ModelExperts | undefined])
    );
  }

  const found = new Map<string, ModelExperts>();
  for (const [key, experts] of await Promise.all(asked)) {
    if (experts) found.set(key, experts);
  }
  return found;
}
