import { beforeAll, describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import type { WorkEntry } from "../../src/models/types";
import { buildRetrievalCorpus, type RetrievalItem } from "../../src/core/retrievalCorpus";
import { loadExcerptSources } from "../../src/core/manuscriptSources";
import { VectorIndex } from "../../src/core/vectorIndex";
import { buildPastScenes, PastSceneIndex, pastSceneMaxChars } from "../../src/core/pastSceneSelect";
import { bestSimilarity, findSimilarPairs, passagesWithin } from "../../src/core/semanticRank";
import { narrowTargetsByMeaning, foreshadowQueryText } from "../../src/core/foreshadowRelevance";
import { CharacterStore } from "../../src/core/characterStore";
import { createForeshadowStore } from "../../src/core/foreshadowStore";
import { OllamaEmbeddingProvider } from "../../src/ai/ollamaEmbedding";
import {
  embedTexts,
  loadStoredVectors,
  prepareRetrieval,
  search,
  searchScenesByMeaning,
} from "../../src/features/vectorSearch";
import { dropNeighbors, sceneLabel, snippet } from "../../src/features/sceneSearch";
import { SIMILAR_SCENE_LIMIT, SIMILAR_SCENE_MIN } from "../../src/features/similarScenes";
import { liveWorkPath, SKIP_REASON } from "./support/liveEnv";

/**
 * ベクトル検索の4つの使い道を、手元の作品で当ててみる（設計書6.19.10）。
 *
 * **製品と同じ部品を通す**（`prepareRetrieval`・`search`・`loadStoredVectors`・
 * `PastSceneIndex`・`findSimilarPairs`・`narrowTargetsByMeaning`）。
 * VS Code のファイル操作だけを Node の fs で代える。
 *
 * **作者の作品フォルダーを直接指さない。** 索引が本文に追いついていなければ
 * 作り足して保存する（`.aiwriter/cache/vector/`）ので、写しを指すこと。
 *
 *   $env:NOVELAI_LIVE_WORK = "<作品の写し>"
 *   $env:NOVELAI_LIVE_QUERIES = "問い1|問い2"   # 任意（場面検索で試す言葉）
 *   npx vitest run --config vitest.live.config.mts test/live/semanticUses.test.ts
 */

const workPath = liveWorkPath();
const work: WorkEntry | undefined = workPath
  ? {
      id: "live",
      title: nodePath.basename(workPath),
      folderPath: workPath,
      registeredAt: new Date(0).toISOString(),
    }
  : undefined;

function useNodeFs(): void {
  const target = vscode.workspace as unknown as {
    fs: Record<string, unknown>;
    getConfiguration: () => { get: <T>(key: string, fallback: T) => T };
  };
  const p = (uri: { fsPath: string }): string => uri.fsPath;
  target.fs.readFile = async (uri: { fsPath: string }) =>
    new Uint8Array(fs.readFileSync(p(uri)));
  target.fs.writeFile = async (uri: { fsPath: string }, bytes: Uint8Array) =>
    fs.writeFileSync(p(uri), bytes);
  target.fs.stat = async (uri: { fsPath: string }) => {
    const stat = fs.statSync(p(uri));
    return {
      type: stat.isDirectory() ? 2 : 1,
      size: stat.size,
      mtime: stat.mtimeMs,
      ctime: stat.ctimeMs,
    };
  };
  target.fs.readDirectory = async (uri: { fsPath: string }) =>
    fs
      .readdirSync(p(uri), { withFileTypes: true })
      .map((entry) => [entry.name, entry.isDirectory() ? 2 : 1]);
  target.fs.createDirectory = async (uri: { fsPath: string }) =>
    fs.mkdirSync(p(uri), { recursive: true });
  target.fs.delete = async (uri: { fsPath: string }) =>
    fs.rmSync(p(uri), { force: true, recursive: true });
  target.fs.rename = async (from: { fsPath: string }, to: { fsPath: string }) =>
    fs.renameSync(p(from), p(to));
  target.fs.copy = async (from: { fsPath: string }, to: { fsPath: string }) =>
    fs.copyFileSync(p(from), p(to));
  // 製品の設定：ベクトル検索を入・検知にも使う・相談の自動更新は切（写しを勝手に書かない）
  const settings: Record<string, unknown> = {
    "vectorSearch.enabled": true,
    "vectorSearch.useInChecks": true,
    "vectorSearch.autoUpdate": false,
  };
  target.getConfiguration = () => ({
    get: <T>(key: string, fallback: T): T =>
      key in settings ? (settings[key] as T) : fallback,
  });
}

function percentile(sorted: readonly number[], rate: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * rate))];
}

describe.skipIf(!work)(`ベクトル検索の使い道（${SKIP_REASON}）`, () => {
  let items: RetrievalItem[] = [];

  beforeAll(async () => {
    useNodeFs();
    const corpus = await buildRetrievalCorpus(work!);
    items = corpus.items.filter((item) => item.source === "本文");
    // 索引が本文に追いついていなければ作り足す（製品の索引づくりと同じ埋め込み）
    const provider = new OllamaEmbeddingProvider();
    const index = await VectorIndex.load(work!, provider.model);
    index.setModel(provider.model);
    const missing = [
      ...new Map(
        corpus.items.filter((item) => !index.has(item.hash)).map((item) => [item.hash, item])
      ).values(),
    ];
    console.log(`索引: 既存${index.size}件 / 足りない${missing.length}件 / 材料${corpus.items.length}件`);
    for (let i = 0; i < missing.length; i += 16) {
      const batch = missing.slice(i, i + 16);
      const vectors = await provider.embed(batch.map((item) => item.text));
      batch.forEach((item, j) => index.set(item.hash, vectors[j]));
    }
    if (missing.length > 0) {
      index.retainOnly(corpus.items.map((item) => item.hash));
      await index.save(work!);
    }
  }, 900_000);

  test("4. 似た場面：近さの分布と、上位の組", async () => {
    const opened = await loadStoredVectors(work!, items.map((item) => item.hash));
    expect("lookup" in opened).toBe(true);
    if (!("lookup" in opened)) return;
    const comparable = items.filter((item) => item.text.replace(/\s+/g, "").length >= 80);
    // 製品と同じ下限・件数で、かかる時間
    const productStarted = Date.now();
    const product = await findSimilarPairs(
      comparable.map((item) => ({
        id: item.id,
        hash: item.hash,
        group: item.label,
        position: item.part?.index ?? 1,
      })),
      opened.lookup,
      { minScore: SIMILAR_SCENE_MIN, limit: SIMILAR_SCENE_LIMIT }
    );
    console.log(
      `似た場面（製品の設定：近さ${SIMILAR_SCENE_MIN}以上・${SIMILAR_SCENE_LIMIT}組まで）: ` +
        `${product.length}組・${((Date.now() - productStarted) / 1000).toFixed(1)}秒`
    );
    const started = Date.now();
    const all = await findSimilarPairs(
      comparable.map((item) => ({
        id: item.id,
        hash: item.hash,
        group: item.label,
        position: item.part?.index ?? 1,
      })),
      opened.lookup,
      { minScore: 0, limit: 100000 }
    );
    const seconds = (Date.now() - started) / 1000;
    const scores = all.map((pair) => pair.score).sort((a, b) => a - b);
    console.log(
      `似た場面: ${comparable.length}場面・${seconds.toFixed(1)}秒 / 組${scores.length}（畳んだ後）` +
        ` / 中央${percentile(scores, 0.5).toFixed(3)} 90%${percentile(scores, 0.9).toFixed(3)}` +
        ` 99%${percentile(scores, 0.99).toFixed(3)} 99.9%${percentile(scores, 0.999).toFixed(3)}` +
        ` 最大${scores[scores.length - 1]?.toFixed(3)}`
    );
    for (const threshold of [0.8, 0.85, 0.9]) {
      console.log(`  近さ${threshold}以上: ${scores.filter((score) => score >= threshold).length}組`);
    }
    const byId = new Map(items.map((item) => [item.id, item]));
    for (const pair of all.slice(0, 12)) {
      const a = byId.get(pair.a)!;
      const b = byId.get(pair.b)!;
      console.log(
        `  ${pair.score.toFixed(3)} ${sceneLabel(a)} ↔ ${sceneLabel(b)}\n` +
          `     「${snippet(a.text, 60)}」\n     「${snippet(b.text, 60)}」`
      );
    }
  }, 600_000);

  test("1. 場面検索：言葉で探す", async () => {
    const queries = (process.env.NOVELAI_LIVE_QUERIES ?? "").split("|").filter(Boolean);
    if (queries.length === 0) return;
    const context = await prepareRetrieval(work!);
    console.log(`場面検索: 意味検索 ${context.vector ? "使える" : `使えない(${context.vectorUnavailable})`}`);
    for (const query of queries) {
      const hits = dropNeighbors(
        await search(context, query, {
          maxChars: Number.MAX_SAFE_INTEGER,
          perMethod: 15,
          sources: ["本文"],
        })
      ).slice(0, 6);
      console.log(`「${query}」`);
      for (const hit of hits) {
        console.log(`  [${hit.foundBy}] ${sceneLabel(hit.item)}「${snippet(hit.item.text, 50)}」`);
      }
    }
  }, 300_000);

  test("2. 矛盾検知の過去の場面：名前だけ／名前＋意味", async () => {
    const sources = (await loadExcerptSources(work!)).sources;
    const scenes = buildPastScenes(sources);
    const opened = await loadStoredVectors(work!, scenes.map((scene) => scene.hash));
    if (!("lookup" in opened)) return;
    const characters = (await new CharacterStore(work!).loadAll()).characters;
    const names = characters.flatMap((character) => [character.name, ...character.aliases]);
    const plain = new PastSceneIndex(scenes);
    const withMeaning = new PastSceneIndex(scenes, { lookup: opened.lookup });
    const budget = pastSceneMaxChars(131072);
    let named = 0;
    let meant = 0;
    const nearest: number[] = [];
    for (const source of sources) {
      if (typeof source.chapter !== "number") continue;
      const terms = names.filter((name) => name.length >= 2 && source.text.includes(name));
      const options = { chapter: source.chapter, terms, maxChars: budget, chunkText: source.text };
      const before = plain.selectWithDetail(options);
      const after = withMeaning.selectWithDetail(options);
      named += after.byName;
      meant += after.byMeaning;
      // 前の話のうち、いちばん近い場面の近さ（下限を決める材料）
      const queries = scenes
        .filter((scene) => passagesWithin(source.text, [scene]).length > 0)
        .map((scene) => opened.lookup(scene.hash))
        .filter((vector): vector is Float32Array => vector !== undefined);
      for (const scene of scenes.filter((scene) => scene.chapter < source.chapter!)) {
        const vector = opened.lookup(scene.hash);
        if (!vector) continue;
        const score = queries.length > 0 ? bestSimilarity(queries, vector) : undefined;
        if (score !== undefined) nearest.push(score);
      }
      if (after.byMeaning > 0) {
        const added = after.text
          .split("\n\n")
          .filter((block) => !before.text.includes(block))
          .map((block) => block.split("\n")[0]);
        console.log(`  第${source.chapter}話: 名前${after.byName}件＋意味${after.byMeaning}件 追加=${added.join(" ")}`);
      }
    }
    nearest.sort((a, b) => a - b);
    console.log(
      `過去の場面: 名前で${named}件・意味で${meant}件 / ` +
        `チャンクの場面と前の場面の近さ 中央${percentile(nearest, 0.5).toFixed(3)}` +
        ` 90%${percentile(nearest, 0.9).toFixed(3)} 99%${percentile(nearest, 0.99).toFixed(3)}`
    );
  }, 300_000);

  test("2. 伏線の回収：回収済みの伏線が、絞っても残るか（見逃しを測る）", async () => {
    if (!fs.existsSync(nodePath.join(workPath!, "設定", "foreshadows"))) {
      console.log("伏線の記録がありません");
      return;
    }
    const records = (await createForeshadowStore(work!).loadAll()).records;
    const resolved = records.filter(
      (record) => record.status === "resolved" && typeof record.resolvedChapter === "number"
    );
    if (resolved.length === 0) {
      console.log("回収済みの伏線がありません");
      return;
    }
    const sources = (await loadExcerptSources(work!)).sources;
    const opened = await loadStoredVectors(work!, items.map((item) => item.hash));
    if (!("lookup" in opened)) return;
    const embedded = await embedTexts(resolved.map(foreshadowQueryText));
    expect(embedded).toBeDefined();
    const vectors = new Map(resolved.map((record, at) => [record.id, embedded![at]]));
    const hashById = new Map(items.map((item) => [item.id, item.hash]));
    // 1話を1か所として扱う（回収の確認は話をまたいでまとめない）
    const entries = sources
      .filter((source) => typeof source.chapter === "number")
      .map((source) => ({
        key: String(source.chapter),
        chapter: source.chapter as number,
        targets: resolved.filter(
          (record) => record.plantedChapter === null || (source.chapter as number) >= record.plantedChapter
        ),
        vectors: passagesWithin(source.text, items)
          .map((id) => opened.lookup(hashById.get(id) ?? ""))
          .filter((vector): vector is Float32Array => vector !== undefined),
      }));
    for (const record of resolved) {
      const eligible = entries.filter((entry) => entry.targets.some((target) => target.id === record.id));
      const ranked = eligible
        .map((entry) => ({ chapter: entry.chapter, score: bestSimilarity(entry.vectors, vectors.get(record.id)!) ?? -1 }))
        .sort((a, b) => b.score - a.score);
      const rank = ranked.findIndex((entry) => entry.chapter === record.resolvedChapter) + 1;
      console.log(
        `  「${record.label}」張=${record.plantedChapter} 回収=${record.resolvedChapter} → ` +
          `近さ${rank}位／候補${eligible.length}話`
      );
    }
    for (const keep of [1, 3, 5]) {
      // 製品と同じく、張った話は枠の外で残す
      const narrowed = narrowTargetsByMeaning(
        entries,
        vectors,
        keep,
        (record, key) => record.plantedChapter !== null && Number(key) === record.plantedChapter
      );
      const kept = resolved.filter((record) =>
        narrowed.some(
          (entry) => entry.key === String(record.resolvedChapter) && entry.targets.some((t) => t.id === record.id)
        )
      ).length;
      const pairs = narrowed.reduce((sum, entry) => sum + entry.targets.length, 0);
      const before = entries.reduce((sum, entry) => sum + entry.targets.length, 0);
      console.log(`  上位${keep}か所: 回収の箇所が残った ${kept}/${resolved.length}・組 ${before}→${pairs}`);
    }
  }, 300_000);

  test("3. 執筆再開：最新話のあらすじを単話プロットの代わりにして、前の場面を引く", async () => {
    const synopses = JSON.parse(
      fs.readFileSync(nodePath.join(workPath!, "設定", "chapter_synopses.json"), "utf8")
    ) as { episodes: Array<{ chapter: number | null; synopsis: string }> };
    const latest = synopses.episodes
      .filter((episode) => typeof episode.chapter === "number" && episode.synopsis.trim())
      .sort((a, b) => (b.chapter ?? 0) - (a.chapter ?? 0))[0];
    if (!latest) return;
    const context = await prepareRetrieval(work!);
    for (const minScore of [0, 0.45, 0.5]) {
      const hits = await searchScenesByMeaning(context, latest.synopsis, {
        limit: 5,
        beforeChapter: latest.chapter!,
        onePerEpisode: true,
        minScore,
      });
      console.log(
        `第${latest.chapter}話のあらすじで（下限${minScore}）: ` +
          hits.map((hit) => `${hit.item.label}(${hit.score.toFixed(2)})`).join(" / ")
      );
    }
  }, 300_000);
});
