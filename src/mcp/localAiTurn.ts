import { AsyncLocalStorage } from "node:async_hooks";
import nodePath from "node:path";
import { randomUUID } from "node:crypto";
import { acquireRun } from "../core/aiSequence";
import {
  LOCAL_AI_LEASE_DIRECTORY,
  LOCAL_AI_LEASE_FILE,
  ProcessLease,
  holderPhrase,
  leaseWaitingMessage,
  type LeaseEntry,
} from "../core/localAiLease";
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
import { GLOBAL_STORAGE_ENV, mcpGlobalStorageRoot } from "./globalStorage";

/**
 * MCP サーバーが手元の Ollama へ送るときの順番待ち（設計書6.76.1）。
 *
 * **拡張機能と同じ札（保管庫の `local-ai/lease.json`）を使う。** Claude Code から
 * `novel.run` で Ollama を回すと、VS Code の窓や、もう1つの MCP サーバーと
 * 同時に叩きうる（2026-09-25 夜、測定の担当が2つ同時に叩いた）。
 *
 * - **保管庫はこの束の居場所から知る**（`mcp/globalStorage.ts`。試験では
 *   `NOVELAI_GLOBAL_STORAGE`）。**見つからなければ札なしで送り、結果に1行添える**
 * - **道具の呼び出し1回を1つの「実行」とみなす。** 最初に Ollama へ送るときに
 *   札を取り、道具が返るまで持ち続ける（チャンクの合間ごとに離すと、別の窓と
 *   交互に流れて読み込み直しが往復する——拡張機能の側と同じ理由）
 * - **管理外の負荷は警告を出せない**（画面が無い）ので、結果に1行添える。止めない
 *
 * **Node 専用**（この束は Node で走る）。`AsyncLocalStorage` で「いまどの道具の
 * 呼び出しの中か」を運ぶ——同じサーバーへ道具が並んで呼ばれても混ざらない。
 */

interface Session {
  readonly label: string;
  readonly signal?: AbortSignal;
  readonly notes: string[];
  /** 札に入った結果（道具が返るまで持つ） */
  entry?: LeaseEntry;
  /** このプロセスの中の順番（6.76 の実行の札） */
  runRelease?: () => void;
  /** 並んで送られたときに、札を1回だけ取りにいく */
  entering?: Promise<void>;
}

const sessions = new AsyncLocalStorage<Session>();

let leaseInstance: ProcessLease | null | undefined;

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

/** 札。**保管庫が見つからなければ null**（札なしで送る） */
function lease(): ProcessLease | null {
  if (leaseInstance !== undefined) return leaseInstance;
  const root = leaseRoot();
  if (!root) {
    leaseInstance = null;
    return leaseInstance;
  }
  const filePath = nodePath.join(root, LOCAL_AI_LEASE_DIRECTORY, LOCAL_AI_LEASE_FILE);
  leaseInstance = new ProcessLease(
    nodeLeaseEnvironment(filePath, (message) => logToStderr(message)),
    { pid: currentPid(), host: "mcp", token: randomUUID() }
  );
  return leaseInstance;
}

/** 試験用。保管庫の場所を変えたあとに札を作り直す */
export function resetLocalAiLeaseForTest(): void {
  void leaseInstance?.dispose();
  leaseInstance = undefined;
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
 * 道具の呼び出し1回を包む。中で Ollama へ送れば札を取り、返るまで持つ。
 * 結果へ添える行（待ったこと・管理外の負荷・札が無いこと）を返す。
 */
export async function withLocalAiSession<T>(
  label: string,
  signal: AbortSignal | undefined,
  run: () => Promise<T>
): Promise<{ value: T; notes: string[] }> {
  const session: Session = { label, notes: [], ...(signal ? { signal } : {}) };
  try {
    const value = await sessions.run(session, run);
    return { value, notes: session.notes };
  } finally {
    session.entry?.release();
    session.runRelease?.();
    // **札を消し終えてから返す。** 呼び出し元は返事を受けたらサーバーを
    // 終わらせることがあり（実機で起きた）、消し終わる前だと札が残って、
    // 次の者が「持ち主の居ない札」と見切るまで待たされる
    if (session.entry?.kind === "held") await leaseInstance?.whenSettled();
  }
}

/**
 * Ollama へ送る直前に呼ぶ（`mcp/tools/ollama.ts` の `ollamaGenerate`）。
 * 戻り値は送り終えたら呼ぶ抜け口。
 *
 * **道具の呼び出しの中なら**、最初の1回だけ札を取り、あとは素通りする。
 * **外なら**（試験から直に呼んだとき）、その1回だけ取って返す。
 */
export async function enterLocalAi(endpoint: string): Promise<() => void> {
  const session = sessions.getStore();
  if (session) {
    session.entering ??= takeTurn(session, endpoint);
    await session.entering;
    return () => undefined;
  }
  const oneShot: Session = { label: "ollama.generate", notes: [] };
  const leave = (): void => {
    oneShot.entry?.release();
    oneShot.runRelease?.();
  };
  try {
    await takeTurn(oneShot, endpoint);
  } catch (error) {
    leave();
    throw error;
  }
  return leave;
}

async function takeTurn(session: Session, endpoint: string): Promise<void> {
  // **このプロセスの中の順番**が先（6.76 の実行の札）。同じサーバーへ道具が
  // 並んで呼ばれたとき、それぞれが札を取りにいって数が合わなくなるのを防ぐ
  session.runRelease = await acquireRun(session.label, session.signal);

  const shared = lease();
  if (!shared) {
    session.notes.push(NO_LEDGER_NOTE);
    // ログは1回だけ（チャンクの数だけ同じ行を並べない）
    if (!loggedNoLedger) logToStderr(NO_LEDGER_NOTE);
    loggedNoLedger = true;
    return;
  }

  let lastMessage: string | undefined;
  const entry = await shared.enter(session.label, {
    ...(session.signal ? { signal: session.signal } : {}),
    onWait: (holder) => {
      lastMessage = leaseWaitingMessage(holder);
      logToStderr(`${lastMessage}（こちらは「${session.label}」。相手はプロセス ${holder.pid}）`);
    },
  });
  session.entry = entry;

  if (entry.kind === "unavailable") {
    const note = `ほかの窓との順番待ちの札を使えないため、そのまま送りました（${entry.reason}）。`;
    session.notes.push(note);
    logToStderr(note);
    return;
  }
  if (entry.waitedFor) {
    const note =
      `${holderPhrase(entry.waitedFor)}の完了を${Math.round(entry.waitedMs / 1000)}秒待ってから送りました。`;
    session.notes.push(note);
    logToStderr(note);
  }

  if (entry.fresh) await noteExternalLoad(session, endpoint);
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
