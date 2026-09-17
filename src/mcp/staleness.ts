import fs from "node:fs";
import nodePath from "node:path";
import { SERVER_NAME, SERVER_VERSION } from "./version";

/**
 * 走っている束が古くなっていないかを見る（設計書6.87.15 の柱2の1）。
 *
 * **なぜ要るか。** MCP サーバーは `dist/mcp-server.mjs` という1ファイルの束で、
 * Claude Code が**セッションを始めた時点の束**を起こして、そのまま動かし続ける。
 * リポジトリで直して `npm run build` し直しても、**起動済みのプロセスは
 * 古い束のまま**である。2026-09-17 の実機で、古い束のまま3時間気づかなかった。
 *
 * **`SERVER_VERSION` だけでは気づけない。** あれは束に焼き込まれた写しなので、
 * 束が古ければ版の名乗りも古いまま揃ってしまう。**外（リポジトリの
 * `package.json`、束のファイルの更新時刻）と突き合わせて初めて分かる。**
 *
 * **読めないことを「古い」と決めつけない**（CLAUDE.md 規則5の考え方）。
 * 配布物に束は入らないし、走らせる場所に `package.json` があるとも限らない
 * （`version.ts` の頭の断り書き）。どちらも読めないときは `stale: false` で
 * 黙る——当てにいくと、正しい束で毎回「古い」と出る。
 *
 * `fs`・`node:path` を静的に import しているのは、**この束は Node 専用**
 * だからである（`tools/accessLog.ts`・`tools/permission.ts` と同じ）。
 * `core/` へは持ち込まない。
 */

/** 束の更新時刻と版を読み直す間隔（ミリ秒）。連打で stat を撃ち続けないため */
const CACHE_MS = 2000;

export interface BundleStalenessInput {
  /** この束が名乗る版（`SERVER_VERSION`） */
  serverVersion: string;
  /** リポジトリの `package.json` の版。読めなければ null */
  repositoryVersion: string | null;
  /** 起動したときの束の更新時刻。読めなければ null */
  startedMtimeMs: number | null;
  /** いまの束の更新時刻。読めなければ null */
  currentMtimeMs: number | null;
}

export interface BundleStalenessJudgement {
  stale: boolean;
  /** なぜ古いと見たか。古くなければ null */
  reason: string | null;
}

export interface BundleStaleness extends BundleStalenessJudgement {
  /** 束の場所。分からなければ null */
  bundlePath: string | null;
  bundleMtimeMs: number | null;
  repositoryVersion: string | null;
  serverVersion: string;
}

/**
 * 古いかどうかを決める（純粋関数）。
 *
 * 古いと見るのは次の2つだけ。
 *
 * 1. **版がずれている**——リポジトリで版を上げてビルドし直した
 * 2. **束が起動後に作り直された**——版を上げずに直したときはこちらだけが動く
 *
 * **どちらも読めないときは古くない。** 読めないことは、古いことの証拠ではない。
 */
export function judgeBundleStaleness(
  input: BundleStalenessInput
): BundleStalenessJudgement {
  if (
    input.repositoryVersion !== null &&
    input.repositoryVersion !== input.serverVersion
  ) {
    return {
      stale: true,
      reason: `束は ${input.serverVersion}、リポジトリは ${input.repositoryVersion}`,
    };
  }

  if (
    input.startedMtimeMs !== null &&
    input.currentMtimeMs !== null &&
    input.currentMtimeMs > input.startedMtimeMs
  ) {
    return {
      stale: true,
      reason: "束（dist/mcp-server.mjs）が起動後に作り直された",
    };
  }

  return { stale: false, reason: null };
}

const HEAD =
  "【束が古い】この MCP サーバーの束（dist/mcp-server.mjs）が古くなっています";
const TAIL = "。Claude Code を開き直して、新しい束で繋ぎ直してください";

/** 理由の付かない断り書き。理由が読めたときは `staleBundleLine` を使う */
export const STALE_BUNDLE_LINE = `${HEAD}${TAIL}`;

/** 全部の返事の `note` に足す1行。理由を括弧へ入れる */
export function staleBundleLine(reason: string | null): string {
  return reason ? `${HEAD}（${reason}）${TAIL}` : STALE_BUNDLE_LINE;
}

/* ── 起動時に控えるもの ───────────────────────────────── */

let bundlePath: string | null = null;
let packageJsonPath: string | null = null;
let startedMtimeMs: number | null = null;
let cached: { at: number; value: BundleStaleness } | null = null;

function mtimeOf(file: string | null): number | null {
  if (!file) return null;
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * `package.json` の版。読めない・形が違うなら null（直しにいかない）。
 *
 * **名前がこの拡張機能のものでなければ見ない。** 束を別の場所へ写して
 * 走らせたとき、隣にある `package.json` は別のパッケージのものであり、
 * その版と突き合わせると**古くもないのに「古い」と言い続ける**。
 */
function versionOf(file: string | null): string | null {
  if (!file) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (record.name !== SERVER_NAME) return null;
    const version = record.version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

/**
 * 起動したときの束の姿を控える。**サーバーの起動で1回だけ呼ぶ。**
 *
 * @param file 束の場所。省略すると `process.argv[1]`（テストが差し替えられる
 *   ように引数にしてある——`process.argv` を書き換えるテストは、
 *   並行して走る他のテストを巻き込む）
 */
export function rememberBundleAtStartup(file?: string): void {
  const candidate = file ?? process.argv[1] ?? "";
  bundlePath = candidate ? nodePath.resolve(candidate) : null;
  /*
    リポジトリの `package.json` は束の1つ上（`dist/` の親）にある。
    **無ければ null のまま。** 配布物には束が入らないし、走らせる場所に
    `package.json` がある保証も無い。
  */
  packageJsonPath = bundlePath
    ? nodePath.resolve(nodePath.dirname(bundlePath), "..", "package.json")
    : null;
  startedMtimeMs = mtimeOf(bundlePath);
  // 控え直したら、前の判定は捨てる（テストが続けて別の束を見られるように）
  cached = null;
}

/**
 * いま古いか。**呼ばれるたびに読み直す**（stat と小さな読み込みだけ）。
 *
 * ただし返事のたびに走るので、**2秒だけ使い回す**。この間に束が変わっても、
 * 次の呼び出しで気づく——気づくのが2秒遅れて困ることは無い。
 */
export function checkBundleStaleness(now: number = Date.now()): BundleStaleness {
  if (cached && now - cached.at < CACHE_MS) return cached.value;

  const repositoryVersion = versionOf(packageJsonPath);
  const currentMtimeMs = mtimeOf(bundlePath);
  const judgement = judgeBundleStaleness({
    serverVersion: SERVER_VERSION,
    repositoryVersion,
    startedMtimeMs,
    currentMtimeMs,
  });

  const value: BundleStaleness = {
    ...judgement,
    bundlePath,
    bundleMtimeMs: currentMtimeMs,
    repositoryVersion,
    serverVersion: SERVER_VERSION,
  };
  cached = { at: now, value };
  return value;
}

/**
 * 返事に断り書きを足す。
 *
 * **道具ごとに書かない**（設計書6.87.15 の柱2の1「全部の返事の `note` に1行」）。
 * 転送層で一度だけ包むので、新しい道具を足した人が忘れることがない
 * ——記録（6.87.9）や許可（6.87.10）と同じ形である。
 *
 * **既存の `note` を消さない。** 道具が書いた注意書きのほうが、その呼び出しに
 * とっては大事なことがある。断り書きを前に置いて、両方残す。
 */
export function withStaleNote(
  value: unknown,
  staleness: BundleStalenessJudgement
): unknown {
  if (!staleness.stale) return value;
  // 配列・文字列・数値はそのまま（鍵を足せる形をしていない）
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const existing = typeof record.note === "string" ? record.note : "";
  return {
    ...record,
    bundleStale: true,
    note: [staleBundleLine(staleness.reason), existing]
      .filter(Boolean)
      .join("\n"),
  };
}
