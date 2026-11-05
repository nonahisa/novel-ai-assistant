import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import { workPaths } from "../core/workRegistry";
import { EditHistory } from "../core/editHistory";
import { ProposalStore } from "../core/proposalStore";
import { FindingStore } from "./findingStore";
import { ExternalAccessLog } from "../core/externalAccessStore";
import { PostingStore } from "../core/postingStore";
import { listManagedRecoveries } from "../core/atomicWrite";
import { readPostingLedger, type PostingLedger } from "../models/posting";
import { logLine } from "../core/logger";
import {
  buildEpisodeTimeline,
  parseAiActionLog,
  type AiActionLine,
  type TimelineEntry,
} from "../core/episodeTimeline";

// ログの書き先：作品が定まらない（記録するのは起動時の欄の登録の失敗だけで、作品を選ぶ前に通る）

/**
 * 左のエクスプローラーの下の「タイムライン」欄に、話ごとの記録を出す（設計書6.119。
 * 作者の裁定 2026-11-06「作るが表示は選択制」）。
 *
 * ## 型を自前で持つ理由
 *
 * タイムラインの口（`workspace.registerTimelineProvider`）は、手元の型定義
 * （`@types/vscode` 1.125）に無い。`any` で触らずに済むよう、使う所だけを
 * 最小の形で宣言する。項目はクラスではなく素の値で渡す——古い版では
 * `TimelineItem` のクラスそのものが無いことがあるため。
 *
 * ## 登録の条件
 *
 * - 設定 `novelai.timeline.show` が有効のときだけ（既定は出さない）。変えたら再起動なしで登録・解除する
 * - 口が関数として在るときだけ（`engines` は ^1.90.0 のまま。1.145 より前は登録しない）
 * - **呼んで投げられても止めない。** 正式になる前の版では、口は在っても
 *   呼ぶと「提案中の機能」として断られることがある。記録に残して諦める
 */

interface TimelineItemLike {
  timestamp: number;
  label: string;
  id?: string;
  iconPath?: vscode.ThemeIcon;
  description?: string;
  /** 古い呼び名（提案中の版）。新しい版の `tooltip` と両方に入れる */
  detail?: string;
  tooltip?: string;
  command?: vscode.Command;
  contextValue?: string;
}

interface TimelineLike {
  readonly items: readonly TimelineItemLike[];
}

interface TimelineOptionsLike {
  cursor?: string;
  limit?: number | { timestamp: number; id?: string };
}

interface TimelineChangeEventLike {
  uri: vscode.Uri;
  reset?: boolean;
}

interface TimelineProviderLike {
  readonly id: string;
  readonly label: string;
  onDidChange?: vscode.Event<TimelineChangeEventLike | undefined>;
  provideTimeline(
    uri: vscode.Uri,
    options: TimelineOptionsLike,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<TimelineLike>;
}

type RegisterTimelineProvider = (
  scheme: string | string[],
  provider: TimelineProviderLike
) => vscode.Disposable;

/** 設定の名前。**ここ1か所** */
export const TIMELINE_SETTING = "timeline.show";

/** 手元の作品と、ブラウザ版（GitHub の作品）の場所 */
const TIMELINE_SCHEMES = ["file", "vscode-vfs"];

const ICONS: Record<TimelineEntry["kind"], string> = {
  edit: "edit",
  proposal: "comment",
  finding: "lightbulb",
  aiAction: "checklist",
  posting: "cloud-upload",
  external: "plug",
  recovery: "history",
};

/** 口が在るときだけ、その関数を返す（無い版では何もしない） */
function timelineRegistrar(): RegisterTimelineProvider | undefined {
  const workspace = vscode.workspace as unknown as {
    registerTimelineProvider?: unknown;
  };
  const register = workspace.registerTimelineProvider;
  return typeof register === "function"
    ? (register.bind(vscode.workspace) as RegisterTimelineProvider)
    : undefined;
}

function isTimelineEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("novelai")
    .get<boolean>(TIMELINE_SETTING, false);
}

/**
 * タイムラインの欄を、設定に合わせて登録・解除する。
 * `findWork` は、開いているファイルが属する作品を引く（`extension.ts` の `findWorkForPath`）。
 */
export function registerEpisodeTimeline(
  context: vscode.ExtensionContext,
  findWork: (filePath: string) => WorkEntry | undefined
): void {
  let registration: vscode.Disposable | undefined;
  const changed = new vscode.EventEmitter<TimelineChangeEventLike | undefined>();
  context.subscriptions.push(changed);

  const provider: TimelineProviderLike = {
    id: "novelai.episodeTimeline",
    label: "統合小説執筆環境",
    onDidChange: changed.event,
    provideTimeline: async (uri, options, token) => {
      const filePath = path.fromUri(uri);
      const work = findWork(filePath);
      if (!work) return { items: [] };
      const entries = await collectEntries(work, filePath);
      if (token.isCancellationRequested) return { items: [] };
      const limit = typeof options.limit === "number" ? options.limit : undefined;
      const shown = limit !== undefined ? entries.slice(0, limit) : entries;
      return { items: shown.map((entry) => toItem(entry, work)) };
    },
  };

  const apply = (): void => {
    const wanted = isTimelineEnabled();
    if (!wanted) {
      registration?.dispose();
      registration = undefined;
      return;
    }
    if (registration) return;
    const register = timelineRegistrar();
    if (!register) return;
    try {
      registration = register(TIMELINE_SCHEMES, provider);
    } catch (error) {
      // 正式になる前の版は、口が在っても呼ぶと断る。作者に知らせるほどのことではない
      logLine(
        `タイムラインの欄を登録できませんでした（この版の VS Code では使えないようです）: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      registration = undefined;
    }
  };

  apply();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`novelai.${TIMELINE_SETTING}`)) apply();
    }),
    // 保存すると退避の写しや編集履歴が増えることがある。その話の欄を読み直させる
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (registration) changed.fire({ uri: document.uri });
    }),
    { dispose: () => registration?.dispose() }
  );
}

/**
 * 記録を読む。**1つ読めなくても、ほかは出す。** 読み手はどれも、無い・壊れた行を
 * 飛ばして残りを返す作り（読み手の側の決まり）。それでも投げたら、その種類だけ空にする。
 */
async function collectEntries(work: WorkEntry, episodePath: string): Promise<TimelineEntry[]> {
  const [edits, proposals, findings, aiActions, posting, external, recoveries] =
    await Promise.all([
      safely(() => new EditHistory(work).load(), []),
      safely(() => new ProposalStore(work).load(), []),
      safely(() => new FindingStore(work).load(), []),
      safely(() => readAiActions(work), [] as AiActionLine[]),
      safely(() => readPostingQuietly(work), undefined),
      safely(() => new ExternalAccessLog(work).load(), []),
      safely(() => listManagedRecoveries(episodePath), []),
    ]);
  return buildEpisodeTimeline({
    workFolder: work.folderPath,
    episodePath,
    edits,
    proposals,
    findings,
    aiActions,
    posting,
    external,
    recoveries,
  });
}

async function safely<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

async function readAiActions(work: WorkEntry): Promise<AiActionLine[]> {
  const target = path.join(workPaths(work).aiwriter, "logs", "ai_actions.log");
  try {
    const bytes = await vscode.workspace.fs.readFile(path.toUri(target));
    return parseAiActionLog(new TextDecoder().decode(bytes));
  } catch {
    return [];
  }
}

/**
 * 投稿の台帳を、**知らせを鳴らさずに**読む。
 *
 * `PostingStore.load()` は、知らない値を読み飛ばしたときに記録と知らせの口を鳴らす。
 * タイムラインは話を開くたびに呼ばれるので、そこを通すと同じ知らせが繰り返し出る。
 * 場所だけ台帳の持ち主に訊き、読み方は同じ関数（`readPostingLedger`）を使う。
 * 壊れていれば投稿の項目を出さないだけにする（直すのは台帳の画面の役目）。
 */
async function readPostingQuietly(work: WorkEntry): Promise<PostingLedger | undefined> {
  const target = await new PostingStore(work).filePath();
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(path.toUri(target));
  } catch {
    return undefined;
  }
  try {
    return readPostingLedger(JSON.parse(new TextDecoder().decode(bytes))).ledger;
  } catch {
    return undefined;
  }
}

function toItem(entry: TimelineEntry, work: WorkEntry): TimelineItemLike {
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    label: entry.label,
    description: entry.description || undefined,
    detail: entry.detail,
    tooltip: entry.detail,
    iconPath: new vscode.ThemeIcon(ICONS[entry.kind]),
    contextValue: `novelai.timeline.${entry.kind}`,
    command: commandFor(entry, work),
  };
}

/** 押したときは、今ある画面を開く。合う画面が無い種類（投稿の記録）は何もしない */
function commandFor(entry: TimelineEntry, work: WorkEntry): vscode.Command | undefined {
  const workRef = { type: "work" as const, work };
  switch (entry.open) {
    case "editHistory":
      return { title: "編集履歴", command: "novelai.showEditHistory", arguments: [workRef] };
    case "editorProposals":
      // 作者モードでは編集者の提案を見る画面、編集者モードでは置いた提案の確認（コマンドの側で分ける）
      return { title: "編集者提案確認", command: "novelai.reviewProposals", arguments: [workRef] };
    case "proposalPanel":
      return { title: "提案パネルを開く", command: "novelai.openProposals" };
    case "recovery":
      return entry.recoveryPath
        ? { title: "控えを開く", command: "vscode.open", arguments: [path.toUri(entry.recoveryPath)] }
        : undefined;
    default:
      return undefined;
  }
}
