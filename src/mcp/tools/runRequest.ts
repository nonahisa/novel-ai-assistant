import fs from "node:fs";
import nodePath from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  RUN_COVER_FEATURE,
  RUN_COVER_SIDES,
  RUN_COVER_SIZES,
  RUN_FEATURES,
  RUN_INDEX_FEATURE,
  RUN_INDEX_LABEL,
  RUN_MAX_OPEN_REQUESTS,
  RUN_REQUESTABLE_FEATURES,
  RUN_REQUEST_DIRECTORY,
  buildRunUri,
  checkRunCover,
  checkRunFile,
  isRunCoverFeature,
  isRunIndexFeature,
  isRunTestAiFeature,
  isRunExportFeature,
  runFeatureTakesFile,
  RUN_TEST_AI_FEATURE,
  RUN_TEST_AI_LABEL,
  runCoverSideLabel,
  describeRunCoverSpec,
  type RunCoverSpec,
  runFeatureLabel,
  type RunFeature,
  formatRunTicket,
  isRunHandledBy,
  isRunOpen,
  isRunRequestId,
  isTestVsCodeAppRoot,
  RUN_TEST_HOST_NOTE,
  type RunHandledBy,
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

const FEATURE_NAMES = [...RUN_REQUESTABLE_FEATURES] as [string, ...string[]];

export const RUN_REQUEST_INPUT = {
  folder: z
    .string()
    .describe("作品フォルダーの絶対パス（scope: all のときも、依頼の持ち主として1作品を渡す）"),
  feature: z
    .enum(FEATURE_NAMES)
    .describe(
      "走らせる機能（読み取りと生成だけ）。" +
        RUN_FEATURES.map((def) => `${def.feature}＝${def.label}`).join("、") +
        `、${RUN_INDEX_FEATURE}＝${RUN_INDEX_LABEL}（手元の Ollama で検索用の索引を作る・更新する。料金なし。novel.search で引く）` +
        `、${RUN_COVER_FEATURE}＝作者の VS Code の EPUBエディターで表紙を焼く（AIを呼ばない。cover が要る。字の向きは cover.ink で測る）` +
        `、${RUN_TEST_AI_FEATURE}＝${RUN_TEST_AI_LABEL}（作者のAI設定のAIへ短い文を1回だけ送り、いま生成できるかを返す。本文は送らない。ほかの依頼の前に使える）` +
        "、exportPdf＝印刷用のファイル（作品の前回の［PDF出力］の紙・向き・範囲。記録が無ければ文庫サイズ・縦書き・全話。作者がブラウザで印刷してPDFにする）・exportEpub＝EPUB" +
        "（どちらもAIを呼ばず、作品の .aiwriter/exports/ に新しいファイルを作るだけ。表紙は焼いてあればそれを使う）。" +
        "settings は検算を通った答えを作品の貯め場所へ貯めるだけで、設定資料への保存は novel.extract.commit で行う"
    ),
  file: z
    .string()
    .optional()
    .describe(
      "対象の話（novel.scan の filePath）。省略すると作品全体。" +
        "vectorIndex・coverBake・opening（第1話の冒頭だけを見る）・testAI・exportPdf・exportEpub では使えません"
    ),
  scope: z
    .enum(["work", "all"])
    .optional()
    .describe(
      "vectorIndex のときだけ。all で登録済みの全作品を順に回す（外部AIの許可がある作品だけ。無い作品は結果に理由つきで並ぶ）。" +
        "省略か work で folder の作品だけ"
    ),
  cover: z
    .object({
      side: z.enum(RUN_COVER_SIDES as [string, ...string[]]).describe("front＝表紙、back＝裏表紙"),
      vertical: z.boolean().describe("題名を縦に並べるなら true、横なら false"),
      size: z.enum(RUN_COVER_SIZES as [string, ...string[]]).describe("題名の大きさ（large＝大・medium＝中・small＝小）"),
    })
    .optional()
    .describe(
      `${RUN_COVER_FEATURE} のときだけ（必須）。この1回だけ題名に当てる体裁で、book.json と画面の欄は変わらない。` +
        "焼いた画像は［表紙を焼く］と同じ 設定/書籍/表紙_合成済み.png（裏表紙は 裏表紙_合成済み.png）に置き換わる"
    ),
};

export const RUN_RESULT_INPUT = {
  folder: z.string().describe("run.request に渡した作品フォルダー"),
  requestId: z.string().describe("run.request が返した依頼番号"),
};

export interface RunRequestInput {
  folder: string;
  feature: string;
  file?: string;
  scope?: "work" | "all";
  cover?: { side: string; vertical: boolean; size: string };
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
  const label = runFeatureLabel(args.feature);
  if (!label) {
    // **白名簿の外は開く前に断る。** 受け口でも断るが、確認の画面を出すまでもない
    throw new McpToolError(
      `この道で走らせられる機能ではありません（${String(args.feature).slice(0, 40)}）。` +
        `読み取りと生成だけです：${RUN_REQUESTABLE_FEATURES.join("・")}`
    );
  }
  const index = isRunIndexFeature(args.feature);
  if (args.scope === "all" && !index) {
    throw new McpToolError(`scope: all は ${RUN_INDEX_FEATURE}（索引づくり）のときだけ使えます。`);
  }
  if (index && args.file !== undefined) {
    throw new McpToolError("索引づくりは作品ごとに作ります。file は渡さないでください。");
  }
  // 表紙を焼く体裁は coverBake のときだけ、しかも必須（札を読む側と同じ判定 `checkRunCover`）
  const coverFeature = isRunCoverFeature(args.feature);
  if (coverFeature) {
    const problem = checkRunCover(args.cover);
    if (problem) throw new McpToolError(problem);
    if (args.file !== undefined) {
      throw new McpToolError("表紙を焼く依頼は話を指しません。file は渡さないでください。");
    }
  } else if (args.cover !== undefined) {
    throw new McpToolError(`cover は ${RUN_COVER_FEATURE}（表紙を焼く）のときだけ使えます。`);
  }
  // 話を指せない機能（冒頭診断・AI接続確認）。札を読む側と同じ判定（`runFeatureTakesFile`）
  if (args.file !== undefined && !runFeatureTakesFile(args.feature)) {
    throw new McpToolError(
      `${label}は話を指しません（${
        isRunTestAiFeature(args.feature)
          ? "本文を送りません"
          : isRunExportFeature(args.feature)
            ? "作品の全話で作ります"
            : "第1話の冒頭だけを見ます"
      }）。file は渡さないでください。`
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
    feature: args.feature as RunFeature,
    folder,
    ...(args.file !== undefined ? { file: args.file } : {}),
    ...(index && args.scope === "all" ? { scope: "all" as const } : {}),
    ...(coverFeature ? { cover: args.cover as RunCoverSpec } : {}),
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
      (index
        ? `作者の VS Code に「検索用の索引を作りますか」という確認が出ます（${
            args.scope === "all" ? "登録済みの全作品" : "この作品"
          }。手元の Ollama で、料金はかかりません）。押すのは作者で、作者は途中で止められます。` +
          "作品の数によっては数分かかります。"
        : coverFeature
          ? `作者の VS Code に「${runCoverSideLabel((args.cover as RunCoverSpec).side)}を焼きますか」という確認が出ます` +
            `（${describeRunCoverSpec(args.cover as RunCoverSpec)}。AIは呼びません）。押すのは作者です。` +
            "焼けたら result.findings の titleBlock を cover.ink の region に渡すと、題名の字が立っているかを測れます。"
          : isRunExportFeature(args.feature)
            ? `作者の VS Code に「${label}」で新しいファイルを作るかの確認が出ます（AIは呼びません。原稿は変わりません）。` +
              "押すのは作者です。作れたら、作品フォルダーからの場所が result.findings に入ります。"
            : `作者の VS Code に「${label}を走らせますか」という確認が出ます。押すのは作者です。` +
            (args.feature === "settings"
              ? "抽出した答えは作品の貯め場所へ貯めるだけで、設定資料には保存しません。" +
                "保存は、走り終えたあとで novel.extract.commit（まず dryRun: true）を呼んでください。"
              : "")) + after,
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
  /** 依頼を受けた VS Code（版と置き場）。受けた記録が無い・古い記録なら無い */
  handledBy?: RunHandledBy;
  /** 試験用の VS Code（`.vscode-test` の下）で受けたときだけの一言 */
  note?: string;
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
  // 記録は手で書き換えられうるので、形を確かめてから返す（崩れていれば返さない）
  const recorded: unknown = state?.handledBy;
  const handledBy: RunHandledBy | undefined = isRunHandledBy(recorded)
    ? { version: recorded.version, appRoot: recorded.appRoot }
    : undefined;
  return {
    requestId: args.requestId,
    status: view.status,
    message: view.message,
    ...(view.status === "done" && state?.result ? { result: state.result } : {}),
    ...(state?.errorKind ? { errorKind: state.errorKind } : {}),
    ...(state?.nextAction ? { nextAction: state.nextAction } : {}),
    ...(handledBy ? { handledBy } : {}),
    ...(handledBy && isTestVsCodeAppRoot(handledBy.appRoot) ? { note: RUN_TEST_HOST_NOTE } : {}),
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
