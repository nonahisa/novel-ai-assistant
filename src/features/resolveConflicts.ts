import * as path from "path";
import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { scanWork } from "../core/scanner";
import { encodeForNewFile, readTextFile } from "../core/textFile";
import { atomicWriteFile } from "../core/atomicWrite";
import {
  checkoutSide,
  unmergedPaths,
  type GitCommandRunner,
} from "../core/git";
import {
  describeConflict,
  parseConflicts,
  resolveConflicts as buildResolvedText,
  sideFileName,
  type ConflictParseResult,
} from "../core/conflictFile";
import { countChars, formatCount } from "../core/charCount";
import { logFailure, showLog } from "../core/logger";

/**
 * 競合の解決（設計書5.5.4）。
 *
 * 同一人物が書いている以上「どちらが正しいか」は本人が見れば分かる。
 * 機械的なマージは試みず、**両方を並べて選ばせる**。
 *
 * **設計書からの変更：専用WebViewではなくVS Code標準の差分エディタを使う。**
 * 小説は1行が短く段落が多いので、差分は行単位で横に並べて読むのが
 * いちばん分かりやすい。標準の差分エディタは折り返し・移動・検索が
 * そのまま効き、作者が普段使っている表示設定も反映される。
 * 同じものをHTMLで作り直しても劣化版にしかならない。
 *
 * **原稿への書き込みはgitにやらせる。** この拡張機能は既存ファイルを
 * 上書きしないという不変条件を持つため、`checkout --ours` などで
 * gitに版を書き戻させる。
 */

/** 差分エディタへ読み取り専用の本文を出すための仕組み */
export const CONFLICT_SCHEME = "novelai-conflict";

export class ConflictContentProvider
  implements vscode.TextDocumentContentProvider
{
  private readonly contents = new Map<string, string>();

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }

  /** 本文を登録して、それを指すURIを返す */
  register(key: string, label: string, text: string): vscode.Uri {
    const uri = vscode.Uri.from({
      scheme: CONFLICT_SCHEME,
      path: `/${key}/${label}`,
    });
    this.contents.set(uri.toString(), text);
    return uri;
  }

  clear(): void {
    this.contents.clear();
  }
}

export interface ConflictedFile {
  /** 作品フォルダーからの相対パス */
  relativePath: string;
  absolutePath: string;
  parsed: ConflictParseResult;
  /** gitがマージ未解決としているか。していればgitに版を書き戻させられる */
  unmerged: boolean;
}

export interface ResolveConflictsOptions {
  run?: GitCommandRunner;
  provider: ConflictContentProvider;
}

/** 競合しているファイルを集める */
export async function findConflictedFiles(
  work: WorkEntry,
  run?: GitCommandRunner
): Promise<ConflictedFile[]> {
  const unmerged = new Set(await unmergedPaths(work.folderPath, run));
  const scan = await scanWork(work);
  const files: ConflictedFile[] = [];

  for (const episode of scan.episodes) {
    if (!episode.hasConflictMarkers) continue;
    const file = await readTextFile(episode.filePath);
    const relative = toRepositoryRelative(work.folderPath, episode.filePath);
    files.push({
      relativePath: relative,
      absolutePath: episode.filePath,
      parsed: parseConflicts(file.text),
      unmerged: unmerged.has(relative),
    });
  }
  return files;
}

/** 作品フォルダーからの相対パスを、gitへ渡せる形（`/` 区切り）にする */
export function toRepositoryRelative(
  workFolder: string,
  filePath: string
): string {
  return path.relative(workFolder, filePath).split(path.sep).join("/");
}

export async function resolveWorkConflicts(
  work: WorkEntry,
  options: ResolveConflictsOptions
): Promise<void> {
  const files = await findConflictedFiles(work, options.run);
  if (files.length === 0) {
    vscode.window.showInformationMessage(
      `「${work.title}」に未解決の競合はありません。`
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(
    files.map((file) => ({
      label: `$(warning) ${path.basename(file.relativePath)}`,
      description: describeConflict(file.parsed),
      detail: file.unmerged
        ? file.relativePath
        : `${file.relativePath}（マージの途中ではありません。マーカーが本文に残っています）`,
      file,
    })),
    {
      title: `${work.title} の未解決の競合（${files.length}件）`,
      placeHolder: "内容を見比べるファイルを選んでください",
    }
  );
  if (!picked) return;

  await reviewConflict(work, picked.file, options);
}

/** 1ファイルぶんの見比べと解決 */
async function reviewConflict(
  work: WorkEntry,
  file: ConflictedFile,
  options: ResolveConflictsOptions
): Promise<void> {
  if (file.parsed.hunks.length === 0) {
    await vscode.window.showWarningMessage(
      `${path.basename(file.relativePath)} の競合マーカーを読み取れませんでした。` +
        "手で編集された可能性があります。ファイルを開いて確認してください。"
    );
    await openFile(file.absolutePath);
    return;
  }

  const original = await readTextFile(file.absolutePath);
  const ours = buildResolvedText(original.text, "ours");
  const theirs = buildResolvedText(original.text, "theirs");
  const theirsLabel = file.parsed.hunks[0].theirsLabel || "別環境";
  const oursLabel = file.parsed.hunks[0].oursLabel || "この環境";

  // 両方を並べて見せる。左がこの環境、右が別環境
  const key = `${work.id}-${Date.now()}`;
  const leftUri = options.provider.register(
    key,
    `この環境（${oursLabel}）`,
    ours
  );
  const rightUri = options.provider.register(
    key,
    `別環境（${theirsLabel}）`,
    theirs
  );
  await vscode.commands.executeCommand(
    "vscode.diff",
    leftUri,
    rightUri,
    `${path.basename(file.relativePath)}: この環境 ↔ 別環境`,
    { preview: true }
  );

  const oursCount = countChars(ours).net;
  const theirsCount = countChars(theirs).net;

  const choice = await vscode.window.showQuickPick(
    [
      {
        label: "$(arrow-left) こちらを採用",
        description: `この環境の版（${formatCount(oursCount)}字）`,
        detail: "別環境の変更は捨てられます。",
        action: "ours" as const,
      },
      {
        label: "$(arrow-right) 別環境のものを採用",
        description: `別環境の版（${formatCount(theirsCount)}字）`,
        detail: "この環境の変更は捨てられます。",
        action: "theirs" as const,
      },
      {
        label: "$(files) 両方を残す",
        description: "別環境の版を別ファイルへ書き出す",
        detail:
          `${sideFileName(path.basename(file.relativePath), theirsLabel)} を作り、` +
          "本文はこの環境の版にします。迷ったらこれが安全です。",
        action: "both" as const,
      },
      {
        label: "$(edit) 自分で直す",
        description: "ファイルを開く",
        detail: "マーカーを見ながら手で編集します。",
        action: "manual" as const,
      },
    ],
    {
      title: `${path.basename(file.relativePath)} をどう解決しますか`,
      placeHolder: describeConflict(file.parsed),
    }
  );
  if (!choice) return;

  if (choice.action === "manual") {
    await openFile(file.absolutePath);
    return;
  }

  await applyChoice(work, file, choice.action, {
    ours,
    theirs,
    theirsLabel,
    original,
    options,
  });
}

interface ApplyContext {
  ours: string;
  theirs: string;
  theirsLabel: string;
  original: Awaited<ReturnType<typeof readTextFile>>;
  options: ResolveConflictsOptions;
}

async function applyChoice(
  work: WorkEntry,
  file: ConflictedFile,
  action: "ours" | "theirs" | "both",
  context: ApplyContext
): Promise<void> {
  // 「両方を残す」は、捨てる側を先に別ファイルへ逃がしてから確定する。
  // 逆にすると、書き出しに失敗したときに版が失われる
  if (action === "both") {
    const saved = await writeSideFile(work, file, context);
    if (!saved) return;
  }

  const side = action === "theirs" ? "theirs" : "ours";

  if (!file.unmerged) {
    // マージの途中ではないので、gitに版を書き戻させることができない。
    // この拡張機能は既存の原稿を上書きしないため、ここでは確定できない
    await vscode.window.showWarningMessage(
      `${path.basename(file.relativePath)} はマージの途中ではないため、` +
        "こちらからは書き換えません（競合マーカーが本文に残ったままの状態です）。" +
        "ファイルを開いて、選んだ版になるよう手で直してください。"
    );
    await openFile(file.absolutePath);
    return;
  }

  const result = await checkoutSide(
    work.folderPath,
    file.relativePath,
    side,
    context.options.run
  );
  if (!result.ok) {
    logFailure("競合の解決に失敗", {
      作品: work.title,
      ファイル: file.relativePath,
      詳細: result.detail ?? "（詳細なし）",
    });
    const answer = await vscode.window.showErrorMessage(
      `${path.basename(file.relativePath)} の解決に失敗しました。`,
      "ログを表示",
      "閉じる"
    );
    if (answer === "ログを表示") showLog();
    return;
  }

  vscode.window.showInformationMessage(
    `${path.basename(file.relativePath)} を` +
      `${side === "ours" ? "この環境" : "別環境"}の版で確定しました。`
  );
}

/**
 * 捨てる側の版を別ファイルへ残す。
 *
 * **新規作成しかしない。** 既存ファイルがあれば止める。
 * 前回の競合で作ったファイルを黙って潰すと、そこにしか無い原稿が消える。
 */
async function writeSideFile(
  work: WorkEntry,
  file: ConflictedFile,
  context: ApplyContext
): Promise<boolean> {
  const directory = path.dirname(file.absolutePath);
  const name = sideFileName(
    path.basename(file.relativePath),
    context.theirsLabel
  );
  const target = path.join(directory, name);

  const bytes = encodeForNewFile(context.theirs, context.original);
  if (!bytes) {
    await vscode.window.showErrorMessage(
      `${name} を元の文字コード（${context.original.encoding}）で書き出せませんでした。` +
        "表せない文字が含まれています。手で解決してください。"
    );
    return false;
  }

  try {
    await atomicWriteFile(target, bytes, { mode: "create" });
  } catch (error) {
    await vscode.window.showErrorMessage(
      `${name} を作成できませんでした。すでに同じ名前のファイルがあるか、` +
        `書き込めない状態です。\n${
          error instanceof Error ? error.message : String(error)
        }`
    );
    return false;
  }

  vscode.window.showInformationMessage(`別環境の版を ${name} へ残しました。`);
  return true;
}

async function openFile(filePath: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.file(filePath)
  );
  await vscode.window.showTextDocument(document);
}
