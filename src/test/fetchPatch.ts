import * as assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as vscode from "vscode";
import { localFetch, timeoutDispatcher } from "../ai/fetchTimeouts";
import { isFetchTimeout } from "../ai/httpClient";

/**
 * **VS Code の通信の差し替えを、実物の拡張機能ホストの中で確かめる**（設計書6.63）。
 *
 * 新しい VS Code（1.138 で確認）は拡張機能の中の `globalThis.fetch` を
 * `@vscode/proxy-agent` の `createFetchPatch` で差し替え、渡した
 * `init.dispatcher`（＝こちらの待ち時間）を捨てる。手元のAIが300秒で
 * 切れていた原因で、直しは `localFetch`（npm の undici の fetch を直接呼ぶ）。
 *
 * 単体テスト（`localFetchBypassesPatch.test.ts`）は差し替えを**真似た偽物**で
 * 見ている。偽物は「VS Code がこう振る舞うはず」という理解の写しなので、
 * 実物の振る舞いが変わっても気づけない。ここでは**実物**を相手にする。
 *
 * ## 見ること
 *
 * 4秒黙る模擬サーバーへ、待ち時間0.2秒の待ち受け役を付けて投げる。
 *
 * - **`localFetch` は黙り終える前に切れる**（待ち受け役が届いて効いている。
 *   undici の時計の刻みのため、実際に切れるのは約1秒後）
 * - 比べとして **`globalThis.fetch` に同じ待ち受け役を渡す**。差し替えのある
 *   VS Code では捨てられて**切れずに返る**——これが「差し替えを実物で
 *   見ている」ことの証拠。**ここで切れてしまうなら、この試験は差し替えを
 *   見ていない**（`localFetch` が切れても、何も守っていない）ので落とす
 *
 * ## 1.90（対応の下限）では
 *
 * - 差し替えが無い。`globalThis.fetch` に渡した待ち受け役は効くので切れる
 * - undici 7 は Node 20.18.1 以上を求めると申告しているが、1.90 の
 *   Node 20.9.0 でも読めて待ち受け役を作れた（2026-09-23 の実測）。
 *   読めない環境では `localFetch` は `globalThis.fetch` へ落ちる（待ち受け役も
 *   作れない）。そのときは「落ちても通信そのものは成り立つ」ことだけ見る
 */

/**
 * 模擬サーバーが応答の頭を返すまで黙る長さ。
 *
 * **単体テストの1.5秒では短すぎる。** undici はヘッダー待ちの時計に
 * 「速い時計」（`timers.setFastTimeout`。刻みが約1秒）を使うので、0.2秒を
 * 頼んでも実際に切れるのは約1秒後になる（1.90 の実測で 1014ms）。
 * 1.5秒では「切れた」と「黙り終えて返った」の差が0.5秒しかなく、
 * 読み違える
 */
const SILENT_MS = 4000;
/** こちらの待ち時間。黙る長さより十分短くして、切れるかを見る */
const WAIT_MS = 200;
/**
 * 「待ち時間どおりに切れた」とみなす上限。速い時計の刻み（約1秒）と
 * 拡張機能ホストの立ち上がり直後の重さを見込み、黙る長さ（4秒）より
 * 十分短いところに置く
 */
const CUT_WITHIN_MS = 2500;
/** 差し替えが待ち受け役を捨てたうえで、万一返らないときの保険 */
const SAFETY_MS = 15_000;
/**
 * 差し替えを確かめた版（ノートPCの実測、2026-09-23）。これ以上の版で
 * 差し替えが見えなければ、VS Code が振る舞いを変えたことになる
 */
const PATCH_CONFIRMED_SINCE = [1, 138] as const;

export interface FetchOutcome {
  /** `cut`：待ち時間で切れた／`ok`：応答が返った／`error`：それ以外の失敗 */
  kind: "cut" | "ok" | "error";
  ms: number;
  detail: string;
}

export interface FetchPatchReport {
  vscodeVersion: string;
  nodeVersion: string;
  /** npm の undici が読めて、待ち受け役を作れたか */
  dispatcherAvailable: boolean;
  local: FetchOutcome;
  /** 待ち受け役を作れなかったときは比べられない */
  global?: FetchOutcome;
}

/** 実物の差し替えに対して2つの道を投げ、結果を返す（判定は `assertFetchPatch`） */
export async function probeFetchPatch(): Promise<FetchPatchReport> {
  const server = http.createServer((_req, res) => {
    // 応答の頭を返すまで黙る（CPUだけの機械で長い本文を読む Ollama の真似）
    const timer = setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    }, SILENT_MS);
    // 切られたら黙ったまま待たない（後始末を速くする）
    res.on("close", () => clearTimeout(timer));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/slow`;
  try {
    const dispatcher = await timeoutDispatcher(WAIT_MS);
    const local = await measure(() =>
      localFetch(url, { signal: AbortSignal.timeout(SAFETY_MS) }, WAIT_MS)
    );
    const global = dispatcher
      ? await measure(() =>
          globalThis.fetch(url, {
            signal: AbortSignal.timeout(SAFETY_MS),
            dispatcher,
          } as RequestInit)
        )
      : undefined;
    return {
      vscodeVersion: vscode.version,
      nodeVersion: process.versions.node,
      dispatcherAvailable: dispatcher !== undefined,
      local,
      global,
    };
  } finally {
    // 捨てられた待ち受け役の側で繋ぎっぱなしの接続が残っても待たない
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function measure(run: () => Promise<Response>): Promise<FetchOutcome> {
  const started = Date.now();
  try {
    const response = await run();
    // 本文まで読み切る（頭だけ返って本文で止まる形も「返った」に数えない）
    const text = await response.text();
    return { kind: "ok", ms: Date.now() - started, detail: `${response.status} ${text}` };
  } catch (error) {
    const ms = Date.now() - started;
    const code = (error as { cause?: { code?: unknown } })?.cause?.code;
    const detail = `${error instanceof Error ? error.message : String(error)}${
      code ? ` (${String(code)})` : ""
    }`;
    return { kind: isFetchTimeout(error) ? "cut" : "error", ms, detail };
  }
}

/** `1.138.0-insider` のような版を [major, minor] で比べる */
function atLeast(version: string, min: readonly [number, number]): boolean {
  const [major, minor] = version.split(/[.-]/).map((part) => Number(part));
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  return major > min[0] || (major === min[0] && minor >= min[1]);
}

export function describeFetchPatch(report: FetchPatchReport): string {
  const show = (o: FetchOutcome | undefined) =>
    o ? `${o.kind} ${o.ms}ms ${o.detail}` : "（待ち受け役を作れず、比べない）";
  return [
    `VS Code ${report.vscodeVersion} / Node ${report.nodeVersion} / undici の待ち受け役 ${
      report.dispatcherAvailable ? "あり" : "なし"
    }`,
    `  localFetch        : ${show(report.local)}`,
    `  globalThis.fetch  : ${show(report.global)}`,
  ].join("\n");
}

export function assertFetchPatch(report: FetchPatchReport): void {
  const summary = describeFetchPatch(report);
  if (!report.dispatcherAvailable) {
    // undici が読めない（1.90 の Node 20.9 系）。手元の道は globalThis.fetch へ
    // 落ちるので、300秒の壁は残るが通信は成り立つ——それだけを見る
    assert.equal(report.local.kind, "ok", `待ち受け役なしで通信が成り立たない\n${summary}`);
    assert.ok(
      !atLeast(report.vscodeVersion, PATCH_CONFIRMED_SINCE),
      `差し替えのある版で undici が読めない（手元のAIが300秒で切れる形に戻る）\n${summary}`
    );
    return;
  }

  assert.equal(
    report.local.kind,
    "cut",
    `localFetch に渡した待ち時間が効いていない\n${summary}`
  );
  assert.ok(
    report.local.ms < CUT_WITHIN_MS,
    `localFetch が待ち時間どおりに切れていない（${report.local.ms}ms）\n${summary}`
  );

  const global = report.global;
  assert.ok(global, `比べの結果が無い\n${summary}`);
  if (atLeast(report.vscodeVersion, PATCH_CONFIRMED_SINCE)) {
    // **ここが「差し替えを実物で見ている」ことの証拠。** 切れてしまうなら、
    // VS Code が待ち受け役を捨てなくなった（あるいは差し替えが効いていない）
    assert.equal(
      global.kind,
      "ok",
      `globalThis.fetch が待ち受け役どおりに切れた——差し替えが見えていない。この試験は差し替えを確かめていない\n${summary}`
    );
    assert.ok(
      global.ms >= SILENT_MS - 100,
      `globalThis.fetch が黙る長さより早く返った（${global.ms}ms）\n${summary}`
    );
  } else if (report.vscodeVersion.startsWith("1.90.")) {
    // 1.90 には差し替えが無い（設計書6.63）。渡した待ち受け役がそのまま効く
    assert.equal(
      global.kind,
      "cut",
      `差し替えの無いはずの 1.90 で、globalThis.fetch が待ち受け役を無視した\n${summary}`
    );
  }
  // 1.91〜1.137 は、どこで差し替えが入ったか確かめていないので記録だけ残す
}
