import fs from "node:fs";
import nodePath from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  RUN_FEATURES,
  RUN_MAX_OPEN_REQUESTS,
  RUN_REQUEST_DIRECTORY,
  buildRunUri,
  checkRunFile,
  findRunFeature,
  formatRunTicket,
  isRunOpen,
  isRunRequestId,
  isRunStale,
  parseRunState,
  parseRunTicket,
  runIdOfFileName,
  runStateFileName,
  runStatusOf,
  runTicketFileName,
  type RunResultBody,
  type RunStateRecord,
  type RunStatus,
  type RunTicket,
} from "../../core/runRequest";
import { sha256Text } from "../../core/hash";
import { clientKeyOf } from "../../core/externalAccessPermission";
import { isSameFolder } from "../../core/pathText";
import { mcpGlobalStorageRoot } from "../globalStorage";
import { getExternalClientName } from "./accessLog";
import { McpToolError } from "./shared";
import { openUri } from "./setupRequest";

/**
 * VS Code の中のAI設定で走らせてもらう（設計書6.87.22）。
 *
 * **クラウドAIの鍵を、このプロセスへ出さない。** 鍵は VS Code の SecretStorage に
 * あり、MCP サーバーは読めない。だから**拡張機能に走らせてもらい、結果だけを読む**。
 *
 * - `run.request`：依頼の札を保管庫へ置き、`vscode://…/run?id=…&token=…` を開かせる。
 *   **待たずに依頼番号を返す**（作者が席を外していると確認は出たままになる）
 * - `run.result`：依頼番号で、状態か結果を読む
 *
 * **合言葉は依頼ごとに1回限り。** 札には合言葉のハッシュだけを置き、合言葉そのものは
 * URI に載せる。保管庫は機械の中なので、ウェブページは合言葉を知りえない——
 * ウェブのリンクから `vscode://…/run` を開かせても、拡張機能は確認も出さずに断る。
 *
 * **原稿を1文字も書き換えない。** 札と結果は保管庫だけに置く（作品フォルダーには
 * 置かない。同期されて編集部の機械へ流れるため）。
 */

const FEATURE_NAMES = RUN_FEATURES.map((def) => def.feature) as [string, ...string[]];

export const RUN_REQUEST_INPUT = {
  folder: z.string().describe("作品フォルダーの絶対パス"),
  feature: z
    .enum(FEATURE_NAMES)
    .describe(
      "走らせる機能（読み取りと生成だけ）。" +
        RUN_FEATURES.map((def) => `${def.feature}＝${def.label}`).join("、")
    ),
  file: z
    .string()
    .optional()
    .describe("対象の話（novel.scan の filePath）。省略すると作品全体"),
};

export const RUN_RESULT_INPUT = {
  folder: z.string().describe("run.request に渡した作品フォルダー"),
  requestId: z.string().describe("run.request が返した依頼番号"),
};

export interface RunRequestInput {
  folder: string;
  feature: string;
  file?: string;
}

export interface RunResultInput {
  folder: string;
  requestId: string;
}

export interface RunRequestDeps {
  open(uri: string): Promise<void>;
  now(): number;
  /** 依頼番号と合言葉。試験では決まった値を差し込む */
  random(bytes: number): string;
  /** 保管庫の場所。無ければ断る */
  storageRoot(): string | undefined;
  clientName(): string;
}

const defaultDeps: RunRequestDeps = {
  open: openUri,
  now: () => Date.now(),
  random: (bytes) => randomBytes(bytes).toString("hex"),
  storageRoot: mcpGlobalStorageRoot,
  clientName: getExternalClientName,
};

export interface RunRequestResult {
  requestId: string;
  status: RunStatus;
  /** OS に URI を渡せたか */
  opened: boolean;
  /** 開けなかったとき、作者に手で開いてもらう URI */
  uri?: string;
  note: string;
}

export async function runRequest(
  args: RunRequestInput,
  deps: RunRequestDeps = defaultDeps
): Promise<RunRequestResult> {
  const def = findRunFeature(args.feature);
  if (!def) {
    // **白名簿の外は開く前に断る。** 受け口でも断るが、確認の画面を出すまでもない
    throw new McpToolError(
      `この道で走らせられる機能ではありません（${String(args.feature).slice(0, 40)}）。` +
        `読み取りと生成だけです：${RUN_FEATURES.map((entry) => entry.feature).join("・")}`
    );
  }
  if (args.file !== undefined) {
    const problem = checkRunFile(args.file);
    if (problem) throw new McpToolError(problem);
  }
  const folder = nodePath.resolve(args.folder);
  if (!fs.existsSync(folder)) {
    throw new McpToolError(`作品フォルダーが見つかりません: ${args.folder}`);
  }

  const dir = requestDirectory(deps);
  fs.mkdirSync(dir, { recursive: true });
  const now = deps.now();
  const entries = readEntries(dir);
  sweepStale(dir, entries, now);

  /*
    **返事の無い依頼を重ねさせない。** 作者が席を外しているあいだに次々頼むと、
    戻ったときに確認が何枚も重なって出る
  */
  const open = entries.filter(
    (entry) => entry.ticket && !isRunStale(entry.ticket.createdAt, now) && isRunOpen(entry.ticket, entry.state, now)
  );
  if (open.length >= RUN_MAX_OPEN_REQUESTS) {
    throw new McpToolError(
      `作者の返事を待っている依頼が ${open.length} 件あります（${open
        .map((entry) => entry.id)
        .join("・")}）。run.result で返事を確かめてから、次を頼んでください。`
    );
  }

  const id = deps.random(8);
  const token = deps.random(32);
  const ticket: RunTicket = {
    version: 1,
    id,
    tokenHash: sha256Text(token),
    feature: def.feature,
    folder,
    ...(args.file !== undefined ? { file: args.file } : {}),
    client: deps.clientName(),
    createdAt: new Date(now).toISOString(),
  };
  // **新しく作るだけ**（`wx`）。同じ番号が既にあれば、札を上書きせずに断る
  fs.writeFileSync(nodePath.join(dir, runTicketFileName(id)), formatRunTicket(ticket), {
    encoding: "utf8",
    flag: "wx",
  });

  const uri = buildRunUri(id, token);
  const after =
    `作者の返事を待たずに戻ります。run.result に requestId「${id}」と同じ folder を渡して、` +
    "間を置いて確かめてください（確認は依頼から30分で期限切れになります）。";
  try {
    await deps.open(uri);
  } catch (error) {
    // **開けなくても行き止まりにしない**（`setup.request` と同じ）。URI を返し、
    // 作者に手で開いてもらう道を残す。合言葉が入っているが、頼んだ本人に返すだけ
    const reason = error instanceof Error ? error.message : String(error);
    return {
      requestId: id,
      status: "waiting",
      opened: false,
      uri,
      note:
        `URI を開けませんでした（${reason}）。作者に、この URI をブラウザのアドレス欄へ貼って開いてもらってください` +
        "（10分以内）。" +
        after,
    };
  }
  return {
    requestId: id,
    status: "waiting",
    opened: true,
    note:
      `作者の VS Code に「${def.label}を走らせますか」という確認が出ます。押すのは作者です。` + after,
  };
}

export interface RunResultOutput {
  requestId: string;
  status: RunStatus;
  message: string;
  /** 走り終えたときだけ。検算済み */
  result?: RunResultBody;
  errorKind?: string;
  nextAction?: string;
}

/**
 * 依頼の状態か結果を読む。
 *
 * **読むときも許可を通す**（6.87.14）。結果には原稿の抜粋が入る。鍵は `run.request`
 * と同じで、転送層（`server.ts` の `tool()`）が `folder` で確かめてからここへ来る。
 * そのうえで、**依頼の作品と同じ作品か・頼んだ接続元か**を札と突き合わせる——
 * 別の作品の許可で、この作品の結果を読ませないため。
 */
export function runResult(
  args: RunResultInput,
  deps: Pick<RunRequestDeps, "now" | "storageRoot" | "clientName"> = defaultDeps
): RunResultOutput {
  if (!isRunRequestId(args.requestId)) {
    throw new McpToolError("requestId の形が合いません（run.request が返した値を渡してください）。");
  }
  const dir = requestDirectory(deps);
  const ticket = readTicket(dir, args.requestId);
  if (!ticket) {
    throw new McpToolError(
      `依頼番号 ${args.requestId} の依頼は見つかりません（7日で片付けます）。`
    );
  }
  if (!isSameFolder(nodePath.resolve(args.folder), ticket.folder)) {
    throw new McpToolError("この依頼は別の作品のものです。run.request に渡した folder を渡してください。");
  }
  if (clientKeyOf(ticket.client) !== clientKeyOf(deps.clientName())) {
    throw new McpToolError("この依頼は別の接続元が頼んだものなので、読めません。");
  }

  const state = readState(dir, args.requestId);
  const view = runStatusOf(ticket, state, deps.now());
  return {
    requestId: args.requestId,
    status: view.status,
    message: view.message,
    ...(view.status === "done" && state?.result ? { result: state.result } : {}),
    ...(state?.errorKind ? { errorKind: state.errorKind } : {}),
    ...(state?.nextAction ? { nextAction: state.nextAction } : {}),
  };
}

function requestDirectory(deps: Pick<RunRequestDeps, "storageRoot">): string {
  const root = deps.storageRoot();
  if (!root) {
    throw new McpToolError(
      "拡張機能の保管庫の場所が分かりません。拡張機能の「Claude Code とつなぐ」で登録し直してください。"
    );
  }
  return nodePath.join(root, RUN_REQUEST_DIRECTORY);
}

interface Entry {
  id: string;
  ticket?: RunTicket;
  state?: RunStateRecord;
}

function readEntries(dir: string): Entry[] {
  const byId = new Map<string, Entry>();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of names) {
    const parsed = runIdOfFileName(name);
    if (!parsed) continue;
    const entry = byId.get(parsed.id) ?? { id: parsed.id };
    if (parsed.kind === "request") entry.ticket = readTicket(dir, parsed.id);
    else entry.state = readState(dir, parsed.id);
    byId.set(parsed.id, entry);
  }
  return [...byId.values()];
}

function readTicket(dir: string, id: string): RunTicket | undefined {
  try {
    return parseRunTicket(fs.readFileSync(nodePath.join(dir, runTicketFileName(id)), "utf8"));
  } catch {
    return undefined;
  }
}

function readState(dir: string, id: string): RunStateRecord | undefined {
  try {
    return parseRunState(fs.readFileSync(nodePath.join(dir, runStateFileName(id)), "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * 古い札と結果を片付ける（7日）。**結果には原稿の抜粋が入る**ので溜めない。
 * 消せなくても依頼は止めない（次の回にまた試す）。
 */
function sweepStale(dir: string, entries: readonly Entry[], now: number): void {
  for (const entry of entries) {
    const createdAt = entry.ticket?.createdAt ?? entry.state?.at;
    /*
      **読めないものは消さない。** 別の MCP サーバー（2つ目の Claude Code の会話）が
      いま書いている途中の札かもしれない。消すと、その依頼が「札の無い依頼」として断られる
    */
    if (!createdAt || !isRunStale(createdAt, now)) continue;
    for (const name of [runTicketFileName(entry.id), runStateFileName(entry.id)]) {
      try {
        fs.rmSync(nodePath.join(dir, name), { force: true });
      } catch {
        // 次の回にまた試す
      }
    }
  }
}
