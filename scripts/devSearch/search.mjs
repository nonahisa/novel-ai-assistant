// 開発のセッション用の意味の検索（grep と並べて使う）。製品には入れない。
//
// 使い方
//   node scripts/devSearch/search.mjs "問い"     上位10件を「道:始まりの行-終わりの行｜見出しの道｜点数」で出す（本文は出さない）
//   node scripts/devSearch/search.mjs --rebuild  索引を全部作り直す（進み具合を出す）
//
// 手元の Ollama（bge-m3）で埋め込む。Ollama は共通のロック（%TEMP%\novelai-ollama.lock）を取ってから使い、
// ほかのモデルは外さない（製品のセッションや別の測定の邪魔にならないように）。
// 使えないときは grep を勧める1行を出して、終了コード0で終わる（開発のセッションを止めない）。

import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  MODEL, TOP_K, REFRESH_LIMIT, QUERY_LOCK_WAIT_MS, REBUILD_LOCK_POLL_MS,
  repoRoot, indexDir, lockPath, collectWindows, loadIndex, saveIndex, planRefresh, refreshIndex,
  rankTop, formatResult, normalize, takeLockWaiting, releaseLock, ollamaEmbed, OllamaUnavailable,
} from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REBUILD_HINT = '作り直しが要ります：node scripts/devSearch/search.mjs --rebuild を裏で';

let heldLock = null;
function release() {
  if (heldLock) { releaseLock(heldLock); heldLock = null; }
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { release(); process.exit(130); });
}

async function main() {
  const args = process.argv.slice(2);
  const rebuild = args.includes('--rebuild');
  const query = args.filter((a) => !a.startsWith('--')).join(' ').trim();
  if (!rebuild && !query) {
    console.log('使い方：node scripts/devSearch/search.mjs "問い"　または　--rebuild');
    return;
  }

  const root = repoRoot(HERE);
  const dir = indexDir(root);
  const old = loadIndex(dir);
  if (!old && !rebuild) {
    console.log(`索引がまだありません。${REBUILD_HINT}`);
    return;
  }

  const current = collectWindows(root);
  const plan = planRefresh(current, new Set(old ? old.windows.map((w) => w.key) : []), REFRESH_LIMIT);
  // 変わった窓が多いときは、問いの前に作り直さず、古い索引のまま答える（最後に案内を出す）
  const useOldOnly = !rebuild && plan.tooMany;
  const needRefresh = rebuild || (!useOldOnly && plan.missing.length > 0);

  const lockDir = lockPath();
  const who = rebuild ? 'devSearch search.mjs --rebuild（開発用の意味の検索）' : 'devSearch search.mjs（開発用の意味の検索）';
  const lock = await takeLockWaiting(lockDir, who, rebuild
    ? { maxWaitMs: Infinity, pollMs: REBUILD_LOCK_POLL_MS, onWait: (o) => console.log(`ロック使用中（${o}）。${REBUILD_LOCK_POLL_MS / 1000}秒待つ`) }
    : { maxWaitMs: QUERY_LOCK_WAIT_MS, pollMs: 5000 });
  if (!lock.ok) {
    console.log(`いまは RAG が使えません（ロック：${lock.owner}）。grep で探してください`);
    return;
  }
  heldLock = lockDir;

  try {
    let index = old;
    if (needRefresh) {
      const t0 = Date.now();
      console.log(`窓 ${current.length}・埋め直し ${plan.missing.length}${rebuild ? '（--rebuild）' : ''}`);
      const r = await refreshIndex({
        current,
        old,
        embed: (texts) => ollamaEmbed(texts),
        onProgress: (done, total) => {
          if (rebuild && (done === total || done % (16 * 10) === 0)) {
            const sec = (Date.now() - t0) / 1000;
            console.log(`${done}/${total} 済み・${sec.toFixed(0)}秒・残りの見込み ${((sec / done) * (total - done) / 60).toFixed(1)}分`);
          }
        },
        // 途中で止まっても、そこまでの分を残す
        onCheckpoint: (partial) => saveIndex(dir, partial),
      });
      index = r.index;
      saveIndex(dir, index);
      if (rebuild) {
        const sec = (Date.now() - t0) / 1000;
        console.log(`索引を作りました：窓 ${index.windows.length}・${sec.toFixed(0)}秒・${dir}`);
      }
    }
    if (!query) return;

    const [qv] = await ollamaEmbed([query]);
    const top = rankTop(index.windows, index.vectors, index.dim, normalize(qv), TOP_K);
    for (const t of top) console.log(formatResult(t));
    if (useOldOnly) {
      console.log(`（変わった窓が ${plan.missing.length} 件あり、古い索引のまま答えました。行の番号がずれていることがあります）`);
      console.log(REBUILD_HINT);
    }
  } finally {
    release();
  }
}

main().catch((e) => {
  release();
  if (e instanceof OllamaUnavailable) {
    console.log(`${e.message}。いまは RAG が使えません。grep で探してください（モデル ${MODEL}）`);
    return; // 終了コードは0のまま
  }
  console.error(`RAG の実行に失敗しました：${e && e.message ? e.message : e}。grep で探してください`);
  process.exitCode = 0;
});
