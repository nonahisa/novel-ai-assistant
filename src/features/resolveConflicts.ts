import * as path from "../core/paths";
import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { scanWork } from "../core/scanner";
import { encodeForNewFile, readTextFile } from "../core/textFile";
import { atomicWriteFile } from "../core/atomicWrite";
import {
  checkoutSide,
  keepSideOfConflict,
  showStage,
  unmergedPaths,
  type GitCommandRunner,
} from "../core/git";
import {
  decideByUpdatedAt,
  isSettingsJsonPath,
} from "../core/settingsConflictRule";
import {
  describeConflict,
  parseConflicts,
  resolveConflicts as buildResolvedText,
  sideFileName,
  type ConflictParseResult,
} from "../core/conflictFile";
import { countChars, formatCount } from "../core/charCount";
import { logFailure, logStep, showLog, useLogFile } from "../core/logger";
import { lastAuthorOf } from "../core/git";
import { cancelItem } from "../views/dialogs";
import { openInDefaultEditor } from "../views/openDocument";

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

/**
 * 画面へ登録済みの見比べ用の置き場。
 *
 * **差分エディタは、登録した仕組みからしか本文を読めない**
 * （`registerTextDocumentContentProvider`）。同期の中から合流するときは
 * 呼び出しの経路が違うので、その場で作った置き場を渡しても中身が出ない。
 * 登録した1つをここで覚えておき、経路を問わず同じものを使う。
 */
let registeredProvider: ConflictContentProvider | undefined;

/** `extension.ts` が画面へ登録したときに呼ぶ */
export function useConflictProvider(
  provider: ConflictContentProvider | undefined
): void {
  registeredProvider = provider;
}

export interface WalkConflictsOptions {
  run?: GitCommandRunner;
  /** 省略時は `useConflictProvider` で登録されたものを使う */
  provider?: ConflictContentProvider;
}

/**
 * 見比べの相手。
 *
 * **作品ではなく置き場（リポジトリ）を渡せる形にしてある**（設計書5.5.18）。
 * 同期の中で合流するときは、衝突しているのは置き場ぜんぶであって、
 * どの作品のファイルかは分かれていない（書庫では1つの置き場に複数の作品が
 * 入っている）。`WorkEntry` はこの形をそのまま満たすので、
 * 既存の呼び出しはそのまま通る。
 */
export interface ConflictScope {
  id: string;
  title: string;
  /** gitに渡すときの基点。作品フォルダーか、置き場の根 */
  folderPath: string;
}

/** 1件ぶんの見比べが、どう終わったか */
export type ReviewOutcome =
  /** どちらかの版で確定した */
  | "resolved"
  /** 作者が選ばずに閉じた */
  | "cancelled"
  /** 「自分で直す」を選んだ。ファイルを開いてある */
  | "manual"
  /** マーカーを読み取れず、こちらからは確定できなかった */
  | "unreadable";

interface ReviewOptions extends ResolveConflictsOptions {
  /**
   * 出さない選択肢。
   *
   * - 合流の途中では「自分で直す」を出さない。**やめれば `merge --abort` で
   *   全部戻る**ので、手で直した内容もそこで消える（設計書5.5.18）
   * - 設定資料のJSONでは「両方を残す」を出さない。別ファイルへ逃がすと
   *   `設定/` に読めない名前のJSONが増え、次の抽出が拾ってしまう
   */
  omit?: ReadonlyArray<"both" | "manual">;
  /**
   * 見比べる本文。省略時は本文に残ったマーカーから組む。
   *
   * **マーカーが読めないときの逃げ道**である。削除と変更がぶつかった場合など、
   * 本文にマーカーが出ないまま未解決になることがある
   */
  sides?: { ours: string; theirs: string };
  /** 確定したことを個別に知らせない（まとめて知らせる側が使う） */
  quiet?: boolean;
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
  // **この先の記録は、その作品のログファイルへ残す**（0.43.3 と同じ）。
  // 1件ずつの処理は置き場（`ConflictScope`）しか受け取らないので、入口で向ける
  useLogFile(work.folderPath);
  const files = await findConflictedFiles(work, options.run);
  if (files.length === 0) {
    vscode.window.showInformationMessage(
      `「${work.title}」に未解決の競合はありません。`
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(
    [
      ...files.map((file) => ({
        label: `$(warning) ${path.basename(file.relativePath)}`,
        description: describeConflict(file.parsed),
        detail: file.unmerged
          ? file.relativePath
          : `${file.relativePath}（マージの途中ではありません。マーカーが本文に残っています）`,
        file,
      })),
      cancelItem(),
    ],
    {
      title: `${work.title} の未解決の競合（${files.length}件）`,
      placeHolder: "内容を見比べるファイルを選んでください",
    }
  );
  if (!picked || !("file" in picked)) return;

  await reviewConflict(work, picked.file, options);
}

/** 1ファイルぶんの見比べと解決 */
async function reviewConflict(
  work: ConflictScope,
  file: ConflictedFile,
  options: ReviewOptions
): Promise<ReviewOutcome> {
  if (file.parsed.hunks.length === 0 && !options.sides) {
    await vscode.window.showWarningMessage(
      `${path.basename(file.relativePath)} の競合マーカーを読み取れませんでした。` +
        "手で編集された可能性があります。ファイルを開いて確認してください。"
    );
    await openFile(file.absolutePath);
    return "unreadable";
  }

  const original = await readTextFile(file.absolutePath);
  const ours = options.sides
    ? options.sides.ours
    : buildResolvedText(original.text, "ours");
  const theirs = options.sides
    ? options.sides.theirs
    : buildResolvedText(original.text, "theirs");
  const theirsLabel = file.parsed.hunks[0]?.theirsLabel || "別環境";
  const oursLabel = file.parsed.hunks[0]?.oursLabel || "この環境";

  // **誰の版かを出す**（設計書5.5.4）。
  // 「別環境の版」とだけ出すと、編集部の直しが自分の書き忘れに見える。
  // 見分けが付かないまま捨てさせない。
  //
  // 取れなくても止めない。名前が無いだけで、比較そのものはできる
  const theirsAuthor = await lastAuthorOf(
    work.folderPath,
    file.relativePath,
    "MERGE_HEAD"
  ).catch(() => undefined);
  const oursAuthor = await lastAuthorOf(
    work.folderPath,
    file.relativePath,
    "HEAD"
  ).catch(() => undefined);
  const oursWho = oursAuthor ? `／${oursAuthor}` : "";
  const theirsWho = theirsAuthor ? `／${theirsAuthor}` : "";

  // 両方を並べて見せる。左がこの環境、右が別環境
  const key = `${work.id}-${Date.now()}`;
  const leftUri = options.provider.register(
    key,
    `この環境（${oursLabel}${oursWho}）`,
    ours
  );
  const rightUri = options.provider.register(
    key,
    `別環境（${theirsLabel}${theirsWho}）`,
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

  // **選択肢の意味は変えない**（設計書5.5.4）。出す・出さないだけを場面で選ぶ
  const omitted = new Set(options.omit ?? []);
  const items: Array<vscode.QuickPickItem & { action: ConflictAction }> = [
    {
      label: "$(arrow-left) こちらを採用",
      description:
        `この環境の版（${formatCount(oursCount)}字）` +
        (oursAuthor ? `／最後に触ったのは ${oursAuthor}` : ""),
      detail: "別環境の変更は捨てられます。",
      action: "ours",
    },
    {
      label: "$(arrow-right) 別環境のものを採用",
      description:
        `別環境の版（${formatCount(theirsCount)}字）` +
        (theirsAuthor ? `／最後に触ったのは ${theirsAuthor}` : ""),
      detail: theirsAuthor
        ? `この環境の変更は捨てられます。${theirsAuthor} の直しを採ります。`
        : "この環境の変更は捨てられます。",
      action: "theirs",
    },
  ];
  if (!omitted.has("both")) {
    items.push({
      label: "$(files) 両方を残す",
      description: "別環境の版を別ファイルへ書き出す",
      detail:
        `${sideFileName(path.basename(file.relativePath), theirsLabel)} を作り、` +
        "本文はこの環境の版にします。迷ったらこれが安全です。",
      action: "both",
    });
  }
  if (!omitted.has("manual")) {
    items.push({
      label: "$(edit) 自分で直す",
      description: "ファイルを開く",
      detail: "マーカーを見ながら手で編集します。",
      action: "manual",
    });
  }

  const choice = await vscode.window.showQuickPick([...items, cancelItem()], {
    title: `${path.basename(file.relativePath)} をどう解決しますか`,
    placeHolder: describeConflict(file.parsed),
  });
  if (!choice || !("action" in choice)) return "cancelled";

  if (choice.action === "manual") {
    await openFile(file.absolutePath);
    return "manual";
  }

  const applied = await applyChoice(work, file, choice.action, {
    ours,
    theirs,
    theirsLabel,
    original,
    options,
  });
  return applied ? "resolved" : "cancelled";
}

type ConflictAction = "ours" | "theirs" | "both" | "manual";

interface ApplyContext {
  ours: string;
  theirs: string;
  theirsLabel: string;
  original: Awaited<ReturnType<typeof readTextFile>>;
  options: ReviewOptions;
}

/** 選んだ版で確定する。**確定できたときだけ true** */
async function applyChoice(
  work: ConflictScope,
  file: ConflictedFile,
  action: "ours" | "theirs" | "both",
  context: ApplyContext
): Promise<boolean> {
  // 「両方を残す」は、捨てる側を先に別ファイルへ逃がしてから確定する。
  // 逆にすると、書き出しに失敗したときに版が失われる
  if (action === "both") {
    const saved = await writeSideFile(work, file, context);
    if (!saved) return false;
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
    return false;
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
    return false;
  }

  // まとめて知らせる側が呼ぶときは、1件ずつは出さない
  // （合流では最後に「設定資料 m件・本文 k件」と1回で出す。設計書5.5.18）
  if (!context.options.quiet) {
    vscode.window.showInformationMessage(
      `${path.basename(file.relativePath)} を` +
        `${side === "ours" ? "この環境" : "別環境"}の版で確定しました。`
    );
  }
  return true;
}

/**
 * 捨てる側の版を別ファイルへ残す。
 *
 * **新規作成しかしない。** 既存ファイルがあれば止める。
 * 前回の競合で作ったファイルを黙って潰すと、そこにしか無い原稿が消える。
 */
async function writeSideFile(
  work: ConflictScope,
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
  await openInDefaultEditor(filePath);
}

/** 順に見比べた結果 */
export interface WalkConflictsResult {
  /**
   * 作者が**1件ずつ見比べて選んだ**ファイル。
   *
   * **一括で寄せたものはここに入れない。** 混ぜると、済んだあとの知らせが
   * 13件まとめて押した分まで「お選びいただきました」と言ってしまう
   * （作者の実測、2026-09-11）。実態と違う言い方は、次に同じ画面へ来たときに
   * 「自分が何を選んだのか」を思い出せなくする
   */
  resolved: string[];
  /** 「全部、新しいほうを採る」で確定したファイル */
  bulkResolved: string[];
  /** 途中でやめたか。**やめたら呼び出し側が `merge --abort` で全部戻す** */
  aborted: boolean;
}

/** 入口のボタン。**押された文字で分けるので、定数を1か所に置く** */
const KEEP_ALL_NEWEST = "全部、新しいほうを採る";
const ONE_BY_ONE = "1件ずつ選ぶ";

/**
 * 未解決のファイルを、**1件ずつ順に**選ばせる（設計書5.5.18）。
 *
 * これまでは QuickPick で「見比べるファイルを選んでください」と一覧を出し、
 * 1件解決すると終わっていた。**残りが何件あるのかも、次に何をすればよいのかも
 * 出ていなかった**——作者の言葉では「競合がぜんぜん消えません」。
 *
 * 合流の途中から呼ぶので、**選び終わるまで抜けない**。抜けた（やめた）ときは
 * `aborted` を立てて返し、呼び出し側がマージごと元へ戻す。
 * 中途半端に確定したファイルだけが残る状態を作らないためである。
 *
 * ## 「全部、新しいほうを採る」を先に出す（2026-09-11）
 *
 * 13作品ぶんの分岐が来たとき、**道が「1件ずつ選ぶ」しか無いと抜けられない**
 * （作者の実測。「全部最新を優先する選択肢をまず提示し、操作をシンプルに
 * してください」）。ただし**一括で寄せるのは設定資料のJSONだけ**にする——
 * 設定資料の大半はAIの抽出結果で、捨てた側は抽出をやり直せば戻る
 * （`core/settingsConflictRule.ts`）。**原稿は一括で寄せない。**
 * 作者の原稿を壊さないことが最優先の決まりであり、戻す手立ても無い。
 */
export async function walkConflicts(
  scope: ConflictScope,
  files: readonly string[],
  options: WalkConflictsOptions = {}
): Promise<WalkConflictsResult> {
  const resolved: string[] = [];
  const bulkResolved: string[] = [];
  if (files.length === 0) return { resolved, bulkResolved, aborted: false };

  const provider = options.provider ?? registeredProvider;
  if (!provider) {
    // 見比べる場所が無い。**確定させずに手を引く**——選ばせずに片側へ
    // 寄せるくらいなら、合わせるのをやめたほうがよい
    await vscode.window.showWarningMessage(
      "見比べの画面を用意できませんでした。合わせるのを取りやめます。"
    );
    return { resolved, bulkResolved, aborted: true };
  }

  const settingsFiles = files.filter((file) => isSettingsJsonPath(file));
  // 一括で片づけられるものが無ければ、そのボタンは出さない。
  // **押しても何も減らないボタンは、迷わせるだけである**
  const buttons =
    settingsFiles.length > 0 ? [KEEP_ALL_NEWEST, ONE_BY_ONE] : [ONE_BY_ONE];
  const start = await vscode.window.showInformationMessage(
    describeWalkStart(files),
    { modal: true, detail: describeWalkStartDetail(files) },
    ...buttons
  );
  if (start !== KEEP_ALL_NEWEST && start !== ONE_BY_ONE) {
    return { resolved, bulkResolved, aborted: true };
  }

  let toReview: readonly string[] = files;
  if (start === KEEP_ALL_NEWEST) {
    // 決められなかったものは捨てずに見比べへ回す。**まとめて片づける道が、
    // 決められないものを黙って捨てる道になってはならない**
    const undecided: string[] = [];
    for (const file of settingsFiles) {
      // 一括で寄せた分は `bulkResolved` へ。**作者は選んでいない**ので、
      // 1件ずつ選んだ `resolved` とは分けたまま呼び出し側へ渡す
      if (await keepNewestSide(scope, file, options.run)) bulkResolved.push(file);
      else undecided.push(file);
    }
    toReview = [
      ...undecided,
      ...files.filter((file) => !isSettingsJsonPath(file)),
    ];
    if (toReview.length === 0) return { resolved, bulkResolved, aborted: false };
  }

  for (const [index, relative] of toReview.entries()) {
    const file = await buildConflictedFile(scope, relative, options.run);
    const outcome = await reviewConflict(scope, file, {
      run: options.run,
      provider,
      // JSONを別ファイルへ逃がすと、`設定/` に読めない名前のJSONが増える
      omit: relative.toLowerCase().endsWith(".json")
        ? ["both", "manual"]
        : ["manual"],
      sides: file.sides,
      quiet: true,
    });
    if (outcome !== "resolved") return { resolved, bulkResolved, aborted: true };
    resolved.push(relative);

    const remaining = toReview.length - index - 1;
    if (remaining === 0) break;
    const next = await vscode.window.showInformationMessage(
      `${path.basename(relative)} を確定しました。`,
      {
        modal: true,
        detail:
          `残り ${remaining} 件です。\n\n` +
          "途中でやめると、ここまで選んだ分もふくめて元へ戻します" +
          "（原稿が半分だけ入れ替わった状態を作らないためです）。",
      },
      "次へ"
    );
    if (next !== "次へ") return { resolved, bulkResolved, aborted: true };
  }

  return { resolved, bulkResolved, aborted: false };
}

/**
 * 設定資料の1件を、**更新時刻の新しいほう**で確定させる。
 *
 * **確定できたときだけ true。** 片方の版が無い（追加と削除がぶつかった）
 * ものや、書き戻せなかったものは false を返し、呼び出し側が1件ずつの
 * 見比べへ回す。
 */
async function keepNewestSide(
  scope: ConflictScope,
  relativePath: string,
  run: GitCommandRunner | undefined
): Promise<boolean> {
  const ours = await showStage(scope.folderPath, relativePath, 2, run);
  const theirs = await showStage(scope.folderPath, relativePath, 3, run);
  if (ours === undefined || theirs === undefined) return false;

  const decision = decideByUpdatedAt(ours, theirs);
  if (decision.side === "conflict") return false;
  if (!(await keepSideOfConflict(scope.folderPath, relativePath, decision.side, run))) {
    logFailure("設定資料をまとめて確定できなかった", {
      ファイル: relativePath,
      理由: decision.reason,
    });
    return false;
  }

  // **黙って片方へ寄せたことにしない。** どちらを採ったかを1行ずつ残す
  logStep(
    `設定資料をまとめて確定：${relativePath} → ` +
      `${decision.side === "ours" ? "こちら" : "別環境"}（${decision.reason}）`
  );
  return true;
}

/** 見比べを始める前に出す一言。**画面から切り離して試験できるようにする** */
export function describeWalkStart(files: readonly string[]): string {
  const settings = files.filter((file) => isSettingsJsonPath(file)).length;
  return (
    `同じ箇所を両方で書き換えたものが ${files.length}件あります` +
    `（設定資料 ${settings}件・原稿 ${files.length - settings}件）。`
  );
}

/**
 * 中身の内訳。**ファイル名を並べない。**
 *
 * 13作品ぶんの分岐では、名前を8件並べても「どの作品がどれだけ残っているか」
 * が分からない（作者の実測、2026-09-11）。作者が見たいのは
 * **どの作品で何件か**なので、置き場の先頭のフォルダー名で束ねて数える。
 */
export function describeWalkStartDetail(files: readonly string[]): string {
  const groups = groupByWork(files);
  const lines = groups.map(
    (group) =>
      `${group.name}：設定資料 ${group.settings}件／原稿 ${group.manuscripts}件`
  );
  const settings = groups.reduce((sum, group) => sum + group.settings, 0);

  const guidance =
    settings > 0
      ? `設定資料は「${KEEP_ALL_NEWEST}」で一度に片づきます。` +
        "原稿だけ1件ずつ見ていただきます。"
      : "どちらを残すかは、書いたご本人にしか分かりません。" +
        "1件ずつ両方を並べますので、お選びください。";

  return [
    lines.join("\n"),
    "",
    guidance,
    "途中でやめると、合わせるのをやめて元の状態へ戻します。",
    "気に入らなければ、合わせる前の退避の枝から丸ごと戻せます。",
  ].join("\n");
}

/** 作品ごとの件数 */
interface WorkConflictCount {
  name: string;
  settings: number;
  manuscripts: number;
}

/**
 * 先頭のフォルダー名で束ねる。
 *
 * 書庫では置き場の直下に作品フォルダーが並ぶ（設計書5.7.9）ので、
 * 先頭の区切りまでが作品の名前になる。区切りが無いものは置き場の直下に
 * あるファイルなので、まとめて1つの束にする。
 */
function groupByWork(files: readonly string[]): WorkConflictCount[] {
  const groups = new Map<string, WorkConflictCount>();
  for (const file of files) {
    // gitは `/` 区切りで返すが、呼び出し側が組んだ道が混ざることもある
    const normalized = file.split(path.sep).join("/");
    const cut = normalized.indexOf("/");
    const name = cut > 0 ? normalized.slice(0, cut) : "（置き場の直下）";
    const group = groups.get(name) ?? { name, settings: 0, manuscripts: 0 };
    if (isSettingsJsonPath(file)) group.settings++;
    else group.manuscripts++;
    groups.set(name, group);
  }
  return [...groups.values()];
}

/** 未解決の1件を、見比べられる形に組む */
async function buildConflictedFile(
  scope: ConflictScope,
  relativePath: string,
  run: GitCommandRunner | undefined
): Promise<ConflictedFile & { sides?: { ours: string; theirs: string } }> {
  const absolutePath = path.join(scope.folderPath, relativePath);
  let text = "";
  try {
    text = (await readTextFile(absolutePath)).text;
  } catch {
    // 読めなくても止めない。索引から版を取れば見比べはできる
  }
  const parsed = parseConflicts(text);
  if (parsed.hunks.length > 0) {
    return { relativePath, absolutePath, parsed, unmerged: true };
  }

  // **マーカーが出ない未解決もある**（削除と変更がぶつかった場合など）。
  // そのときは索引の版（2＝この環境／3＝別環境）をそのまま並べる
  const ours = (await showStage(scope.folderPath, relativePath, 2, run)) ?? "";
  const theirs = (await showStage(scope.folderPath, relativePath, 3, run)) ?? "";
  return {
    relativePath,
    absolutePath,
    parsed,
    unmerged: true,
    sides: { ours, theirs },
  };
}
