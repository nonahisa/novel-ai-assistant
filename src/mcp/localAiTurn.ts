import { AsyncLocalStorage } from "node:async_hooks";
import nodePath from "node:path";
import { randomUUID } from "node:crypto";
import { acquireCall, acquireRun, currentRunLabel } from "../core/aiSequence";
import {
  LOCAL_AI_INTERRUPT_FILE,
  LOCAL_AI_LEASE_DIRECTORY,
  LOCAL_AI_LEASE_FILE,
  LOCAL_AI_RUN_LEASE_FILE,
  holderPhrase,
  leaseWaitingMessage,
  type LeaseEntry,
} from "../core/localAiLease";
import { CrossProcessTurn, type CrossTurnKind } from "../core/localAiCrossTurn";
import {
  externalLoadMessage,
  probeExternalLoad,
  readOllamaPsWith,
} from "../core/gpuLoad";
import {
  currentPid,
  nodeLeaseEnvironment,
  runNvidiaSmi,
} from "../core/localAiLeaseNode";
import type { FeatureName } from "../core/mcpFeatures";
import { GLOBAL_STORAGE_ENV, mcpGlobalStorageRoot } from "./globalStorage";

/**
 * MCP サーバーが手元の Ollama へ送るときの順番待ち（設計書6.76.1）。
 *
 * **拡張機能と同じ札（保管庫の `local-ai/`）を使う。** Claude Code から
 * `novel.run` で Ollama を回すと、VS Code の窓や、もう1つの MCP サーバーと
 * 同時に叩きうる（2026-09-25 夜、測定の担当が2つ同時に叩いた）。
 *
 * - **保管庫はこの束の居場所から知る**（`mcp/globalStorage.ts`。試験では
 *   `NOVELAI_GLOBAL_STORAGE`）。**見つからなければ札なしで送り、結果に1行添える**
 * - **道具の呼び出し1回が、一括処理か単発かを先に決める**（`localAiSessionKind`）。
 *   一括処理なら、最初に Ollama へ送るときに**まとまりの札**を取り、道具が
 *   返るまで持つ（チャンクの合間ごとに離すと、別の窓の一括処理と交互に流れて
 *   読み込み直しが往復する）。**1回の送信の札は送るたびに取って離す**ので、
 *   別の窓の相談はチャンクの合間に入れる（拡張機能の側と同じ。`core/localAiCrossTurn.ts`）
 * - **管理外の負荷は警告を出せない**（画面が無い）ので、結果に1行添える。止めない
 *
 * **Node 専用**（この束は Node で走る）。`AsyncLocalStorage` で「いまどの道具の
 * 呼び出しの中か」を運ぶ——同じサーバーへ道具が並んで呼ばれても混ざらない。
 */

/**
 * `novel.run` のうち、**一括処理として扱う** feature。
 *
 * 決め方は「その道具の呼び出し1回が、何回 Ollama へ送るか」。話やチャンクを
 * 回す（`runByRunner`）、候補ごとに判定を重ねるものは一括処理にして、別の窓の
 * 一括処理と交互に流れないようにする。
 *
 * **それ以外は単発**（1回だけ送る：あらすじ・逸脱・単話プロットは1話ぶん、
 * 紹介文・キャッチコピー・章立て・名前・冒頭・プロット逆算・表記ゆれの1問・相談、
 * そして `ollama.generate`）。製品では「各話あらすじの生成」「逸脱の検知」は
 * 全話を回すので一括処理だが、MCP の1回は1話ぶんで、合間というものが無い。
 * 単発にしておけば、別の窓の一括処理の合間に入れる。
 *
 * 一覧に無い道具が何度も送っても壊れはしない（合間ごとに別の窓の一括処理と
 * 交互になりうるだけ）。一覧は `test/unit/mcp/localAiTurn.test.ts` が見張る。
 */
export const MCP_RUN_FEATURES: ReadonlySet<FeatureName> = new Set<FeatureName>([
  "typo",
  "proofread",
  "contradiction",
  "factContradiction",
  "foreshadow",
  "settings",
]);

/** 道具の呼び出し1回を、一括処理として扱うか単発として扱うか */
export function localAiSessionKind(toolName: string, args: unknown): CrossTurnKind {
  if (toolName !== "novel.run") return "single";
  const feature =
    typeof args === "object" && args !== null
      ? (args as { feature?: unknown }).feature
      : undefined;
  return typeof feature === "string" && MCP_RUN_FEATURES.has(feature as FeatureName)
    ? "run"
    : "single";
}

interface Session {
  readonly label: string;
  readonly kind: CrossTurnKind;
  readonly signal?: AbortSignal;
  readonly notes: string[];
  /** 一括処理のとき、このプロセスの中の実行の札（6.76。道具が返るまで持つ） */
  runRelease?: () => void;
  /** 並んで送られたときに、実行の札を1回だけ取りにいく */
  takingRun?: Promise<void>;
  /** 窓をまたぐ札に触ったか（返る前に片づけを待つかどうか） */
  touchedLease: boolean;
  /** 同じ相手を待ったことを、チャンクごとに書き連ねない */
  readonly notedHolders: Set<string>;
  notedNoLedger: boolean;
  notedUnavailable: boolean;
  checkedLoad: boolean;
}

function newSession(
  label: string,
  kind: CrossTurnKind,
  signal: AbortSignal | undefined
): Session {
  return {
    label,
    kind,
    notes: [],
    ...(signal ? { signal } : {}),
    touchedLease: false,
    notedHolders: new Set(),
    notedNoLedger: false,
    notedUnavailable: false,
    checkedLoad: false,
  };
}

const sessions = new AsyncLocalStorage<Session>();

let turnInstance: CrossProcessTurn | null | undefined;

/**
 * 札を置く保管庫。**束の居場所が拡張機能の保管庫だと言えるときだけ**使う。
 *
 * `mcpGlobalStorageRoot` は環境変数が無ければ「走っている束の親フォルダー」を
 * 返すが、単体テストでは走っているのが試験の道具なので、そこへ札を書くと
 * 試験の道具のフォルダーを汚す。束の名前（`mcp-server.mjs`）で見分ける。
 * `dist/` から撃つときは `dist/` に札ができる——拡張機能とは突き合わないので、
 * 開発・測定では `NOVELAI_GLOBAL_STORAGE` で保管庫を渡す（メモの手順どおり）。
 */
function leaseRoot(): string | undefined {
  if (process.env[GLOBAL_STORAGE_ENV]?.trim()) return mcpGlobalStorageRoot();
  const bundle = process.argv[1];
  if (!bundle || !/^mcp-server[^\\/]*\.m?js$/.test(nodePath.basename(bundle))) {
    return undefined;
  }
  return mcpGlobalStorageRoot();
}

/** 窓をまたぐ札。**保管庫が見つからなければ null**（札なしで送る） */
function crossTurn(): CrossProcessTurn | null {
  if (turnInstance !== undefined) return turnInstance;
  const root = leaseRoot();
  if (!root) {
    turnInstance = null;
    return turnInstance;
  }
  const directory = nodePath.join(root, LOCAL_AI_LEASE_DIRECTORY);
  const log = (message: string): void => logToStderr(message);
  turnInstance = new CrossProcessTurn(
    {
      send: nodeLeaseEnvironment(nodePath.join(directory, LOCAL_AI_LEASE_FILE), log),
      run: nodeLeaseEnvironment(nodePath.join(directory, LOCAL_AI_RUN_LEASE_FILE), log),
      interrupt: nodeLeaseEnvironment(nodePath.join(directory, LOCAL_AI_INTERRUPT_FILE), log),
    },
    { pid: currentPid(), host: "mcp", token: randomUUID() },
    {
      // **このプロセスの中で一括処理の道具が動いている間は、まとまりの札を離さない**
      // （並んで呼ばれた一括処理の道具も、同じまとまりとして続けて流す）
      keepRunWhile: () => currentRunLabel() !== undefined,
    }
  );
  return turnInstance;
}

/** 試験用。保管庫の場所を変えたあとに札を作り直す */
export function resetLocalAiLeaseForTest(): void {
  void turnInstance?.dispose();
  turnInstance = undefined;
  nvidiaSmiMissing = false;
}

/**
 * 標準エラーへ1行。**標準出力へは書かない**（MCP の通信路なので、混ぜると壊れる）。
 * Claude Code はこれをサーバーのログとして残す。
 */
function logToStderr(message: string): void {
  process.stderr.write(`[手元のAIの順番] ${message}\n`);
}

let nvidiaSmiMissing = false;
let loggedNoLedger = false;

/** 札が見つからなかったときの1行（結果へ添える） */
export const NO_LEDGER_NOTE =
  "保管庫が見つからないため、ほかの窓との順番待ちをせずに手元の Ollama へ送りました" +
  "（NOVELAI_GLOBAL_STORAGE で保管庫を渡せます）。";

/**
 * 道具の呼び出し1回を包む。中で Ollama へ送れば順番を取る。
 * 結果へ添える行（待ったこと・管理外の負荷・札が無いこと）を返す。
 *
 * `kind` は `localAiSessionKind` で決める。省くと一括処理として扱う
 * （0.86.13 までの「道具1回を1つの実行とみなす」と同じ）。
 */
export async function withLocalAiSession<T>(
  label: string,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
  kind: CrossTurnKind = "run"
): Promise<{ value: T; notes: string[] }> {
  const session = newSession(label, kind, signal);
  try {
    const value = await sessions.run(session, run);
    return { value, notes: session.notes };
  } finally {
    const heldRun = session.runRelease !== undefined;
    session.runRelease?.();
    // 実行の札を返した。**まとまりの札を離す機会**（並んでいた一括処理の道具が
    // 続けて実行の札を受け取っていれば、keepRunWhile で持ち続ける）
    if (heldRun) turnInstance?.runEnded();
    // **札を消し終えてから返す。** 呼び出し元は返事を受けたらサーバーを
    // 終わらせることがあり（実機で起きた）、消し終わる前だと札が残って、
    // 次の者が「持ち主の居ない札」と見切るまで待たされる
    if (session.touchedLease) await turnInstance?.whenSettled();
  }
}

/**
 * Ollama へ送る直前に呼ぶ（`mcp/tools/ollama.ts` の `ollamaGenerate`）。
 * 戻り値は**送り終えたら必ず呼ぶ**抜け口。
 *
 * 取る順は「実行の札（一括処理だけ・道具の呼び出しに1回）→ 窓をまたぐ札
 * （送るたび）→ このプロセスの関所（送るたび）」。6.76 の禁止則と同じ一方向。
 * **道具の呼び出しの外**（試験から直に呼んだとき）は、単発として扱う。
 */
export async function enterLocalAi(endpoint: string): Promise<() => void> {
  const session =
    sessions.getStore() ?? newSession("ollama.generate", "single", undefined);

  if (session.kind === "run") {
    // **このプロセスの中の順番**が先（6.76 の実行の札）。同じサーバーへ一括処理の
    // 道具が並んで呼ばれたとき、交互に流れないようにする
    session.takingRun ??= acquireRun(session.label, session.signal).then((release) => {
      session.runRelease = release;
    });
    await session.takingRun;
  }

  const entry = await enterCrossTurn(session, endpoint);
  let leaveCall: () => void;
  try {
    // **このプロセスの中の送信も1本ずつ**（並んで呼ばれた単発どうし）。
    // 窓をまたぐ札はプロセスの中では数で共有するので、これが無いと重なる
    leaveCall = await acquireCall(session.signal);
  } catch (error) {
    entry?.release();
    throw error;
  }
  let left = false;
  return () => {
    if (left) return;
    left = true;
    leaveCall();
    entry?.release();
  };
}

async function enterCrossTurn(
  session: Session,
  endpoint: string
): Promise<LeaseEntry | undefined> {
  const turn = crossTurn();
  if (!turn) {
    if (!session.notedNoLedger) session.notes.push(NO_LEDGER_NOTE);
    session.notedNoLedger = true;
    // ログは1回だけ（チャンクの数だけ同じ行を並べない）
    if (!loggedNoLedger) logToStderr(NO_LEDGER_NOTE);
    loggedNoLedger = true;
    return undefined;
  }

  session.touchedLease = true;
  const entry = await turn.enter(session.label, {
    kind: session.kind,
    ...(session.signal ? { signal: session.signal } : {}),
    onWait: (holder) => {
      logToStderr(
        `${leaseWaitingMessage(holder)}（こちらは「${session.label}」。相手はプロセス ${holder.pid}）`
      );
    },
  });

  if (entry.kind === "unavailable") {
    if (!session.notedUnavailable) {
      const note = `ほかの窓との順番待ちの札を使えないため、そのまま送りました（${entry.reason}）。`;
      session.notes.push(note);
      logToStderr(note);
    }
    session.notedUnavailable = true;
    return entry;
  }
  if (entry.waitedFor) {
    const note =
      `${holderPhrase(entry.waitedFor)}の完了を${Math.round(entry.waitedMs / 1000)}秒待ってから送りました。`;
    logToStderr(note);
    // 同じ相手へ何度も譲ったことを、チャンクの数だけ並べない
    if (!session.notedHolders.has(entry.waitedFor.token)) {
      session.notedHolders.add(entry.waitedFor.token);
      session.notes.push(note);
    }
  }

  if (entry.fresh && !session.checkedLoad) {
    session.checkedLoad = true;
    await noteExternalLoad(session, endpoint);
  }
  return entry;
}

/**
 * 管理外の負荷を見て、高ければ結果に1行添える（**止めない**。画面が無いので
 * 問えない）。手元の宛先のときだけ見る——別の機械の Ollama なら、この機械の
 * GPU は関係が無い。
 */
async function noteExternalLoad(session: Session, endpoint: string): Promise<void> {
  if (!isLocalEndpoint(endpoint)) return;
  try {
    const judgement = await probeExternalLoad("ollama", {
      runNvidiaSmi: async () => {
        if (nvidiaSmiMissing) return undefined;
        const smi = await runNvidiaSmi();
        if (smi.kind === "ok") return smi.stdout;
        if (smi.kind === "missing") nvidiaSmiMissing = true;
        else logToStderr(`nvidia-smi を読めませんでした：${smi.reason}`);
        return undefined;
      },
      // 読み込みの一覧を聞くだけの短い呼び出し（生成ではない）なので素の fetch でよい
      readOllamaPs: () =>
        readOllamaPsWith((signal) =>
          fetch(`${endpoint.replace(/\/+$/, "")}/api/ps`, { signal })
        ),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    logToStderr(`送る前の負荷：${judgement.summary}`);
    if (judgement.external) {
      session.notes.push(
        `管理外の負荷の疑い：${externalLoadMessage(judgement)}止めずに送りました（結果が遅い・失敗したときはこれを疑ってください）。`
      );
    }
  } catch (error) {
    logToStderr(
      `GPU の負荷を確かめられませんでした：${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function isLocalEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * 結果へ添える（`staleness.ts` の `withStaleNote` と同じ形——`note` の頭へ足す）。
 * 配列・文字列など鍵を足せない形は、そのまま返す。
 */
export function withLocalAiNotes(value: unknown, notes: readonly string[]): unknown {
  if (notes.length === 0) return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const existing = typeof record.note === "string" ? record.note : "";
  return {
    ...record,
    localAiNotes: [...notes],
    note: [...notes, existing].filter(Boolean).join("\n"),
  };
}
