// 開発のセッション用の「意味の検索」の部品（製品の src/ には入れない）。
// 呼び出しの口は search.mjs。ここは試し（test/unit/cross/devSearch.test.ts）から呼べるように、
// 判定の部品を export で出しておく。
//
// 決めごと（案：dev-rag-plan-2026-11-18）
// - 全文を WINDOW_SIZE 字の窓（重なり WINDOW_OVERLAP 字）に切り、窓の頭に見出しの道（文書）か
//   「ファイルの道｜export の名前」（コード）を付けて埋め込む
// - 鍵は「モデル名＋埋め込む文の SHA-256」。同じ鍵のベクトルは埋め直さない
// - 字数は JS の文字列の長さ（UTF-16）で数える。サロゲートペアは稀で、窓の境が1字ずれても検索の質に響かないため

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, rmSync, renameSync, existsSync,
} from 'node:fs';
import { join, basename, dirname, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';

export const MODEL = 'bge-m3:latest';
export const OLLAMA = 'http://127.0.0.1:11434';
export const NUM_CTX = 8192;
export const WINDOW_SIZE = 2000;
export const WINDOW_OVERLAP = 400;
export const TOP_K = 10;
export const REFRESH_LIMIT = 300;
export const EMBED_BATCH = 16;
export const LOCK_STALE_MS = 90 * 60 * 1000;
export const QUERY_LOCK_WAIT_MS = 60 * 1000;
export const REBUILD_LOCK_POLL_MS = 30 * 1000;

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const keyOf = (model, text) => sha256(`${model}\n${text}`);

// ---------- 場所 ----------

/** 台本の位置から、このワークツリーの最上位フォルダーを返す */
export function repoRoot(fromDir) {
  return resolve(fromDir, '..', '..');
}

/** ワークツリーでも本体と同じ名前になるよう、共通の .git の親の名前を使う */
export function repoName(root) {
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
    return basename(dirname(resolve(root, common)));
  } catch {
    return basename(root);
  }
}

export function indexDir(root, localAppData = process.env.LOCALAPPDATA) {
  const base = localAppData || join(tmpdir(), 'localappdata');
  return join(base, 'novelai-dev-rag', repoName(root));
}

export const lockPath = (temp = process.env.TEMP || tmpdir()) => join(temp, 'novelai-ollama.lock');

// ---------- 窓 ----------

/** 長さ len の文を size 字の窓に切る（次の窓の頭は size - overlap 字先）。返すのは [開始, 終了) の組 */
export function windowRanges(len, size = WINDOW_SIZE, overlap = WINDOW_OVERLAP) {
  const out = [];
  if (len <= 0) return out;
  const step = Math.max(1, size - overlap);
  for (let s = 0; ; s += step) {
    const e = Math.min(len, s + size);
    out.push([s, e]);
    if (e >= len) break;
  }
  return out;
}

/** 本文 text（セクションの頭が全体の startLine 行目）を窓へ切り、各窓の行の範囲を付ける */
export function sectionWindows(text, startLine, label, rel, size = WINDOW_SIZE, overlap = WINDOW_OVERLAP) {
  const wins = [];
  for (const [s, e] of windowRanges(text.length, size, overlap)) {
    const body = text.slice(s, e);
    if (body.trim() === '') continue;
    const startL = startLine + countNewlines(text, 0, s);
    // 終わりの行：最後の字が載っている行（末尾の改行だけの窓は1つ前の行にする）
    const lastCharAt = Math.max(s, e - 1 - (text[e - 1] === '\n' ? 1 : 0));
    const endL = startLine + countNewlines(text, 0, lastCharAt);
    const embedText = `${label.head}\n${body}`;
    wins.push({
      path: rel,
      startLine: startL,
      endLine: Math.max(startL, endL),
      hp: label.hp,
      embedText,
    });
  }
  return wins;
}

function countNewlines(text, from, to) {
  let n = 0;
  for (let i = from; i < to; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** 文書を見出し（# から ####）ごとのセクションに分け、窓へ切る。コードの囲み（```）の中の # は見出しにしない */
export function docWindows(rel, rawText, size = WINDOW_SIZE, overlap = WINDOW_OVERLAP) {
  const text = rawText.replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const stack = [];
  const sections = [];
  let cur = { path: [], startIdx: 0 };
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence && /^(#{1,4}) (.+?)\s*$/.exec(line);
    if (m) {
      sections.push({ path: cur.path, startIdx: cur.startIdx, endIdx: i });
      const level = m[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title: m[2] });
      cur = { path: stack.map((x) => x.title), startIdx: i };
    }
  });
  sections.push({ path: cur.path, startIdx: cur.startIdx, endIdx: lines.length });
  const wins = [];
  for (const sec of sections) {
    if (sec.endIdx <= sec.startIdx) continue;
    const body = lines.slice(sec.startIdx, sec.endIdx).join('\n');
    const hp = sec.path.join(' > ') || '(冒頭)';
    wins.push(...sectionWindows(body, sec.startIdx + 1, { head: `${rel}｜${hp}`, hp }, rel, size, overlap));
  }
  return wins;
}

export function exportNames(text) {
  const names = [];
  const re = /^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:const|let|function\*?|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/gm;
  let m;
  while ((m = re.exec(text))) names.push(m[1]);
  return names;
}

/** コードは1ファイルを頭から窓へ切る。頭に付けるのは「ファイルの道｜export の名前（12個まで）」 */
export function codeWindows(rel, rawText, size = WINDOW_SIZE, overlap = WINDOW_OVERLAP) {
  const text = rawText.replace(/\r\n/g, '\n');
  const hp = exportNames(text).slice(0, 12).join(', ');
  return sectionWindows(text, 1, { head: `${rel}｜${hp}`, hp }, rel, size, overlap);
}

// ---------- 探す範囲 ----------

function walk(dir, accept, skipDir, acc) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules' || skipDir(p)) continue;
      walk(p, accept, skipDir, acc);
    } else if (accept(name)) {
      acc.push(p);
    }
  }
  return acc;
}

/** 探す範囲のファイル（最上位からの相対の道・/ 区切り）。並びは決まった順 */
export function listFiles(root) {
  const rel = (p) => relative(root, p).split('\\').join('/');
  const docsSkip = (p) => {
    const r = rel(p);
    return r === 'docs/下書き' || r === 'docs/superpowers';
  };
  const out = [];
  out.push(...walk(join(root, 'docs'), (n) => n.endsWith('.md'), docsSkip, []).map(rel));
  if (existsSync(join(root, 'CLAUDE.md'))) out.push('CLAUDE.md');
  out.push(...walk(join(root, '.claude', 'skills'), (n) => n.endsWith('.md'), () => false, []).map(rel));
  out.push(...walk(join(root, 'src'), (n) => n.endsWith('.ts') && !n.endsWith('.d.ts'), () => false, []).map(rel));
  return [...new Set(out)].sort();
}

/** 全ファイルを読み、窓の一覧を作る（埋め込みはしない）。key は埋め込む文から決まる */
export function collectWindows(root, model = MODEL) {
  const all = [];
  for (const rel of listFiles(root)) {
    const text = readFileSync(join(root, rel), 'utf8');
    const wins = rel.endsWith('.ts') ? codeWindows(rel, text) : docWindows(rel, text);
    for (const w of wins) all.push({ ...w, key: keyOf(model, w.embedText) });
  }
  return all;
}

// ---------- 索引の置き場 ----------
// index.json：窓の目録（本文は持たない）。vectors.f32：窓と同じ順で dim 個ずつ並べた Float32

export function loadIndex(dir, model = MODEL) {
  const jsonPath = join(dir, 'index.json');
  const vecPath = join(dir, 'vectors.f32');
  if (!existsSync(jsonPath) || !existsSync(vecPath)) return null;
  try {
    const meta = JSON.parse(readFileSync(jsonPath, 'utf8'));
    if (meta.model !== model || !Array.isArray(meta.windows)) return null;
    const buf = readFileSync(vecPath);
    const vectors = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    if (vectors.length !== meta.windows.length * meta.dim) return null; // 書きかけ
    return { model: meta.model, dim: meta.dim, windows: meta.windows, vectors };
  } catch {
    return null;
  }
}

export function saveIndex(dir, { model, dim, windows, vectors }) {
  mkdirSync(dir, { recursive: true });
  const meta = {
    model,
    dim,
    builtAt: new Date().toISOString(),
    // 本文（embedText）は持たない。鍵だけで変わったかを見分ける
    windows: windows.map((w) => ({ key: w.key, path: w.path, startLine: w.startLine, endLine: w.endLine, hp: w.hp })),
  };
  const vecTmp = join(dir, 'vectors.f32.tmp');
  const jsonTmp = join(dir, 'index.json.tmp');
  writeFileSync(vecTmp, Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength));
  writeFileSync(jsonTmp, JSON.stringify(meta), 'utf8');
  renameSync(vecTmp, join(dir, 'vectors.f32'));
  renameSync(jsonTmp, join(dir, 'index.json'));
}

// ---------- 変わった窓の見分け ----------

/** 古い索引に鍵がある窓は埋め直さない。要るもの（missing）と、上限を超えるか（tooMany）を返す */
export function planRefresh(current, oldKeys, limit = REFRESH_LIMIT) {
  const missing = current.filter((w) => !oldKeys.has(w.key));
  return { missing, tooMany: missing.length > limit };
}

export function normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/**
 * 現在の窓（current）に、古い索引のベクトルと新しく埋めたベクトルを当てて、新しい索引を作る。
 * embed(texts) は texts と同じ数のベクトルを返す関数（試しでは偽物を渡す）。
 * onProgress(済み, 全体) と onCheckpoint(索引) は任意。onCheckpoint には「ここまでに埋まった窓だけ」の索引を渡す
 * @param {{ current: any[], old: any, embed: (texts: string[]) => Promise<number[][]>, model?: string, batch?: number, onProgress?: (done: number, total: number) => void, onCheckpoint?: (index: any) => void, checkpointEvery?: number }} opts
 */
export async function refreshIndex({ current, old, embed, model = MODEL, batch = EMBED_BATCH, onProgress, onCheckpoint, checkpointEvery = 20 }) {
  const byKey = new Map();
  let dim = old ? old.dim : 0;
  if (old) {
    old.windows.forEach((w, i) => byKey.set(w.key, old.vectors.subarray(i * old.dim, (i + 1) * old.dim)));
  }
  const missing = [];
  const seen = new Set();
  for (const w of current) {
    if (!byKey.has(w.key) && !seen.has(w.key)) { missing.push(w); seen.add(w.key); }
  }
  const build = () => {
    const wins = current.filter((w) => byKey.has(w.key));
    const vectors = new Float32Array(wins.length * dim);
    wins.forEach((w, i) => vectors.set(byKey.get(w.key), i * dim));
    return { model, dim, windows: wins, vectors };
  };
  let done = 0;
  let batches = 0;
  for (let i = 0; i < missing.length; i += batch) {
    const chunk = missing.slice(i, i + batch);
    const vecs = await embed(chunk.map((w) => w.embedText));
    if (vecs.length !== chunk.length) throw new Error(`埋め込みの数が合いません（${vecs.length}／${chunk.length}）`);
    chunk.forEach((w, j) => {
      const nv = normalize(vecs[j]);
      if (dim === 0) dim = nv.length;
      if (nv.length !== dim) throw new Error('埋め込みの次元がそろいません');
      byKey.set(w.key, nv);
    });
    done += chunk.length;
    batches++;
    if (onProgress) onProgress(done, missing.length);
    if (onCheckpoint && batches % checkpointEvery === 0) onCheckpoint(build());
  }
  return { index: build(), embedded: missing.length };
}

// ---------- 並べ方 ----------

/**
 * 節ごとに1行にまとめた上位 k 件。節は「文書＝見出しの道（#### まで）、コード＝ファイル」で、
 * その節でいちばん点の高い窓を節の代表にする（測りの retrieve.mjs と同じ。同じ節の窓が並んで種類が減るのを避ける）
 */
export function rankTop(windows, vectors, dim, qvec, k = TOP_K) {
  const best = new Map();
  for (let i = 0; i < windows.length; i++) {
    let s = 0;
    const o = i * dim;
    for (let d = 0; d < dim; d++) s += vectors[o + d] * qvec[d];
    const w = windows[i];
    const g = JSON.stringify([w.path, w.hp]);
    const cur = best.get(g);
    if (!cur || s > cur.score) best.set(g, { ...w, score: s });
  }
  return [...best.values()].sort((x, y) => y.score - x.score).slice(0, k);
}

export function formatResult(r) {
  return `${r.path}:${r.startLine}-${r.endLine}｜${r.hp}｜${r.score.toFixed(3)}`;
}

// ---------- ロック（スキル ai-bench の共通の札と同じ形） ----------

/** ロックのフォルダーが作られてからの経過が基準より古ければ、放置とみなす */
export function isLockStale(ageMs, staleMs = LOCK_STALE_MS) {
  return ageMs > staleMs;
}

export function lockOwner(dir) {
  try {
    return readFileSync(join(dir, 'owner.txt'), 'utf8').split('\n')[0] || '持ち主不明';
  } catch {
    return '持ち主不明';
  }
}

/**
 * ロックを1回だけ取りにいく。取れたら { ok: true }、使用中なら { ok: false, owner }。
 * 放置（古い）なら外してから取り直す。ほかのモデルは外さない
 */
export function tryTakeLock(dir, who, now = Date.now()) {
  for (let n = 0; n < 3; n++) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, 'owner.txt'), `${who}\nmodel ${MODEL}\n${new Date(now).toISOString()}\n`, 'utf8');
      return { ok: true };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age;
      try { age = now - statSync(dir).mtimeMs; } catch { continue; } // 取り合いで消えた。もう一度
      if (isLockStale(age)) {
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      return { ok: false, owner: lockOwner(dir) };
    }
  }
  return { ok: false, owner: '持ち主不明' };
}

export function releaseLock(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** 取れるまで待つ。maxWaitMs が Infinity なら pollMs おきに待ち続ける。取れなければ { ok: false, owner } */
export async function takeLockWaiting(dir, who, { maxWaitMs, pollMs, onWait = () => {}, sleepFn = sleep } = {}) {
  const t0 = Date.now();
  for (;;) {
    const r = tryTakeLock(dir, who);
    if (r.ok) return r;
    const waited = Date.now() - t0;
    if (waited + pollMs > maxWaitMs) return r;
    onWait(r.owner);
    await sleepFn(pollMs);
  }
}

// ---------- Ollama ----------

export class OllamaUnavailable extends Error {}

export async function ollamaEmbed(texts, { model = MODEL, base = OLLAMA } = {}) {
  let res;
  try {
    res = await fetch(`${base}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: texts, truncate: true, keep_alive: '10m', options: { num_ctx: NUM_CTX } }),
    });
  } catch (e) {
    throw new OllamaUnavailable(`Ollama に届きません（${base}）`);
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200).replace(/\s+/g, ' ');
    throw new OllamaUnavailable(`Ollama の埋め込みが HTTP ${res.status} で失敗しました：${body}`);
  }
  const json = await res.json();
  return json.embeddings;
}
