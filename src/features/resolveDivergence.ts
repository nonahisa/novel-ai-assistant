import * as vscode from "vscode";
import * as paths from "../core/paths";
import type { WorkEntry } from "../models/types";
import type { WorkRegistry } from "../core/workRegistry";
import {
  fetchRemote,
  isAutoWrittenLine,
  keepSideOfConflict,
  readSyncStatus,
  runGit,
  showStage,
  type GitCommandRunner,
} from "../core/git";
import { mergeProposalJsonl } from "../core/editingRepo";
import { commitAll, countTrackableFiles, hasCommitIdentity } from "../core/gitSetup";
import { buildSyncTarget, worksInside } from "../core/syncTarget";
import {
  describeMergePreview,
  isAppendOnlyPath,
  mergeTreeArgs,
  parseMergeTree,
  type MergePreview,
} from "../core/mergePreview";
import {
  classifyConflicts,
  readUndecidedSettings,
  type ConflictWalkStart,
} from "../core/divergenceScan";
import {
  decideSettingsConflict,
  type SettingsConflictDecision,
} from "../core/settingsConflictRule";
import {
  containsConflictMarkers,
  describeGuardFailure,
  guardResult,
  unexpectedChanges,
} from "../core/mergeGuard";
import { sha256Bytes } from "../core/hash";
import { fromLfText, toLf } from "../core/eolSpace";
import { detectJsonFileFormat } from "../core/jsonFileFormat";
import {
  logFailure,
  logStep,
  showLog,
  useLogFile,
} from "../core/logger";
import { withCancellableProgress } from "../views/progress";
import type { WalkConflictsResult } from "./resolveConflicts";
import { readAutoResendSettings } from "./autoResend";

/**
 * 分岐したときに、畳めるものは畳む（設計書5.5.16／5.5.18）。
 *
 * 作者の指示（2026-08-26）：「重なっていないなら、マージは自動で行ってください」。
 * 作者の指示（2026-09-10）：「設定資料ファイルは作者が書き換えた部分が変わって
 * いなければ、時系列的に新しいほうに自動で合わせてください。本文も同じ個所の
 * 衝突がなければ、自動で合流させる」「別れた分をあわせるは何のためにある
 * 処理ですか？もう少し手軽にできないですか」。
 *
 * ## これまでは行き止まりだった
 *
 * 別のPCとこちらの両方で書き進めると分岐する。取り込みは早送りできるときだけ
 * 行う決まりなので（5.5.1）、拡張機能は
 * 「Gitのクライアントで見比べてから解決してください」としか言えなかった。
 * **プログラマでない作者に、それは手渡せる道ではない。**
 *
 * 5.5.16で「分かれた分を合わせる」を足したが、**作者のものが1件でも衝突したら
 * 畳まない**という決まりのため、実際の置き場では毎回そこで止まっていた。
 * 作者の言葉では「競合がぜんぜん消えません」。**安全側の設計が、そのまま
 * 行き止まりになっていた。**
 *
 * ## いまの決まり（5.5.18）
 *
 * 1. **自動生成物** → この端末の側を残す（作り直せるもの）
 * 1'. **追記型**（履歴・提案・ロック） → **両方の行を残す**。
 *    行が混ざっただけなので、どちらかを選ぶ必要が無い（`core/editHistory.ts`）
 * 2. **設定資料のJSON** → `core/settingsConflictRule.ts` の規則で決める
 *    （作者が書いた部分が同じなら、時系列で新しいほうへ）
 * 3. **決まらなかった設定資料と、本文** → 作者に1件ずつ選んでもらう。
 *    **同じ箇所を両方で書き換えたものだけ**がここに来る（別の箇所は
 *    gitが合流済み）
 *
 * ## 畳む前後で守ること（5.5.16から変えない）
 *
 * 1. **未記録の変更を先に記録する**（汚れているとマージを始められない）
 * 2. **退避の枝を作る**（確定したあとに戻したくなることがある）
 * 3. `--no-commit` で畳み、**確定する前に検査する**
 * 4. 検査：競合マーカーが残っていないか／**取り込んでいないファイルが
 *    変わっていないか**（`core.autocrlf` が効く経路。目では気づけない）
 * 5. 1つでも落ちたら `merge --abort` で戻す
 *
 * **送信はこの関数からはしない。** 同期の中から呼ばれたときは、合流のあとに
 * 呼び出し側が送信の手順へ進む（5.5.1の「外へ出る操作は作者の操作を起点に」は
 * 同期のボタンが起点になっているので守られている）。
 */

export interface ResolveDivergenceDeps {
  registry: WorkRegistry;
  run?: GitCommandRunner;
  /** 済んだあとに状態表示を作り直す */
  monitor?: { refreshAll(options: { fetch: boolean }): Promise<void> };
}

/** 指紋を取る対象。**作者が書くもの**だけを見る */
const WATCHED_EXTENSIONS = [".txt", ".md", ".json", ".jsonl"];

/**
 * 記録の書き先を、その置き場の作品のログへ向ける（0.45.0）。
 *
 * **合わせる相手は「置き場」であって作品ではない。** 1つのリポジトリに
 * 複数の作品が入る（設計書5.7.9）ので、代表として先頭の作品のログへ書く。
 * 登録済みの作品が無い置き場では向けない（書き先が無い）。
 *
 * この先で呼ぶ `reportFold` は置き場しか受け取らないが、ここを通ったあとの
 * 書き先をそのまま使うので、向け直す必要はない。
 */
function useRootLog(deps: ResolveDivergenceDeps, root: string): void {
  const work = worksInside(deps.registry.list(), root)[0];
  if (work) useLogFile(work.folderPath);
}

/** 合わせる相手の置き場 */
export interface FoldTarget {
  root: string;
  label: string;
  upstream: string;
}

/** 規則で決めた1件 */
export interface SettingsResolution {
  file: string;
  /**
   * `merged` は、両側の変更を項目ごとに合わせた中身を置いた
   * （同じ資料を引き継いでいて、変えた項目が重ならなかった。案3、2026-10-01）
   */
  side: "ours" | "theirs" | "merged";
  reason: string;
}

export type FoldOutcome =
  | {
      ok: true;
      /** 退避の枝の名前 */
      backup: string;
      /** 取り込んだファイル数 */
      incoming: number;
      /** 規則で揃えた設定資料 */
      settingsAutoResolved: SettingsResolution[];
      /**
       * 見比べの入口で「全部、新しいほうを採る」を押して片づいた設定資料の件数。
       *
       * **作者が1件ずつ選んだ分と混ぜない**（2026-09-11）。混ぜると、
       * 13件を一括で寄せただけなのに「お選びいただきました」と知らせてしまう
       */
      settingsBulkResolved: number;
      /** 作者が1件ずつ選んだファイル */
      manuscriptConflicts: string[];
    }
  | { ok: false; reason: string; authored?: string[] };

/**
 * 作者が1件ずつ選ぶところ。
 *
 * **差し替えられる形にしてある。** 本物のgitで規則の分岐を確かめるには、
 * 画面を出さずに答えを決められる必要がある（試験でしか使わない）。
 */
export type ConflictWalker = (input: {
  root: string;
  label: string;
  files: string[];
  run: GitCommandRunner;
  /** 確認の窓で選んだ始め方。あれば入口の窓を出さない（案2） */
  start?: ConflictWalkStart;
}) => Promise<WalkConflictsResult>;

export interface FoldOptions {
  progress?: { report(value: { message?: string }): void };
  walk?: ConflictWalker;
  /**
   * 作者に選んでもらうものが残ったときに、どうするか（既定は `"walk"`）。
   *
   * `"stop"` は**選ぶ画面を開かずに、合わせるのをやめて元へ戻す。**
   * 開いたときの点検（`handoffSync.ts`）が使う。作者が何も押していないのに
   * 選ぶ画面が出るのは、「重なったら止めて訊く」（設計書6.15.1）に届かない。
   * 点検は名前でしか重なりを見ないので、名前を変えたファイルは
   * 「重ならない」と判断したまま、実際に合わせるとぶつかることがある
   */
  authorChoice?: "walk" | "stop";
  /**
   * 作者が押していない自動の経路（開いたときの点検）から呼ぶか。
   *
   * **自動の経路では記録（コミット）しない**（設計書6.15.1）。真のときは
   * 「合わせる前の自動保存」をしない。点検は執筆量の記録（`.aiwriter/stats/`）
   * を未記録に数えないので、統計だけが変わった置き場ではここまで来る
   * （残課題 F6）。統計は未記録のまま合わせ、次に作者が記録するときに入る。
   * 統計のほかに未記録があれば、合わせずに断る（点検が手前で止めているはずで、
   * ここへ来たら状態が変わったということ）
   */
  automatic?: boolean;
  /**
   * 見比べの始め方（作者の裁定、2026-10-01 案2）。
   *
   * 確認の窓（［同期する］・［合わせる］）で先に選んでもらったものを、
   * 見比べ（`walk`）へそのまま渡す。**入口の窓を続けて出さないため。**
   * 渡さなければ、これまでどおり入口の窓で訊く
   */
  start?: ConflictWalkStart;
}

export async function resolveDivergence(
  deps: ResolveDivergenceDeps,
  work?: WorkEntry
): Promise<void> {
  const run = deps.run ?? runGit;
  const target = await pickTarget(deps, work, run);
  if (!target) return;

  const { root, label } = target;
  useRootLog(deps, root);

  const outcome = await withCancellableProgress(
    "2台の原稿を調べています…",
    async (progress, token) => {
      progress.report({ message: "もう1台で書いた分を、GitHubから取りに行っています…" });
      await fetchRemote(root, run);
      if (token.isCancellationRequested) return undefined;

      const status = await readSyncStatus(root, run);
      if (status.kind !== "tracked") return { kind: "not_tracked" as const };
      if (status.ahead === 0 || status.behind === 0) {
        return { kind: "not_diverged" as const };
      }

      progress.report({ message: "そろえられるかを調べています…" });
      const preview = parseMergeTree(
        await run(mergeTreeArgs("HEAD", status.upstream), root, 60_000)
      );
      // 規則で決まらない設定資料があるか（案2）。確認の窓のボタンが変わる。
      // 調べられなければ undefined（設定資料は全部、選ぶ側に数える）
      const undecidedSettings =
        preview.kind === "unsupported" || preview.kind === "failed"
          ? undefined
          : await readUndecidedSettings(
              root,
              status.upstream,
              classifyConflicts(preview.conflicts).settings,
              run
            );
      return { kind: "ready" as const, status, preview, undecidedSettings };
    }
  );
  if (!outcome) return;

  if (outcome.kind === "not_tracked") {
    void vscode.window.showInformationMessage(
      `「${label}」は、GitHubとつながっていません。`
    );
    return;
  }
  if (outcome.kind === "not_diverged") {
    void vscode.window.showInformationMessage(
      `「${label}」は、2台の原稿がそろっています（作業は要りません）。` +
        "送るのと取り込むのは「保存・同期」でできます。"
    );
    return;
  }

  const { status, preview, undecidedSettings } = outcome;
  if (preview.kind === "unsupported" || preview.kind === "failed") {
    void vscode.window.showWarningMessage(describeMergePreview(preview));
    logFailure("分岐の判定に失敗", { 置き場: label, 詳細: preview.detail ?? "" });
    return;
  }

  // **作者のものが衝突していても、もう行き止まりにしない**（設計書5.5.18）。
  // 何が起きるかを先に見せ、押されたら1件ずつ選んでもらう。
  // **選び方もこの窓で訊く**（案2、2026-10-01）——見比べの入口の窓を続けて出さない
  // 窓の文（送るか送らないか）を事実に合わせるため、送り直しの設定を読む
  // （既定は入っている。読めない値は既定どおり「送る」側に数える——
  // 送らないと言って送るほうが、作者にとって悪い食い違いなので）
  const autoResend = readAutoResendSettings().enabled !== false;
  const start = await confirm(
    label,
    status.behind,
    status.ahead,
    preview,
    undecidedSettings,
    autoResend
  );
  if (!start) return;

  const result = await withCancellableProgress(
    "2台の原稿をそろえています…",
    async (progress) =>
      foldDivergence(
        deps,
        { root, label, upstream: status.upstream },
        { progress, start }
      )
  );
  if (!result) return;

  await reportFold(deps, label, result, { sending: false, autoResend });
}

/** どの置き場を畳むか。作品が指定されなければ、登録の先頭から根をたどる */
async function pickTarget(
  deps: ResolveDivergenceDeps,
  work: WorkEntry | undefined,
  run: GitCommandRunner
): Promise<{ root: string; label: string } | undefined> {
  const works = deps.registry.list();
  if (works.length === 0) {
    void vscode.window.showInformationMessage("登録されている作品がありません。");
    return undefined;
  }

  const chosen = work ?? works[0];
  const status = await readSyncStatus(chosen.folderPath, run);
  const root = "root" in status && status.root ? status.root : chosen.folderPath;
  return { root, label: buildSyncTarget(root, works).label };
}

/**
 * 押す前に見せる文面を組む。
 *
 * **画面から切り離してある**——出るかどうかは実機でしか見られないが、
 * 「取り込む件数」「こちらに残る件数」「作者が選ぶ件数」が本当に入って
 * いるかは、ここだけを呼べば機械で確かめられる。
 */
export function describeDivergenceConfirm(input: {
  label: string;
  behind: number;
  ahead: number;
  autoWritten: number;
  /** 追記型（履歴・提案・ロック）の件数。**両方の行を残す** */
  appendOnly?: number;
  /** 規則で揃える見込みの設定資料の件数 */
  settings?: number;
  /**
   * 規則で決まらず、作者が選ぶ見込みの設定資料の件数（案2、2026-10-01）。
   * 1件以上なら、窓に選び方のボタン（新しいほうへ／1件ずつ）を並べる
   */
  settingsToChoose?: number;
  /** 作者が1件ずつ選ぶことになる本文の件数 */
  manuscripts?: number;
  /**
   * 自動の送り直し（`novelai.git.autoResend`）が入っているか。
   *
   * **そろえたあと、送り直しが数分のうちに GitHub へ送る**（そろえた記録は
   * 「送っていない記録」になり、相手より遅れてもいないため）。
   * 2026-10-11、窓に「GitHubへは送信しません」と書いてあったのに、
   * 1分後に送られていた（作者の実機確認）。**窓の文は事実に合わせる**
   */
  autoResend: boolean;
}): { message: string; detail: string; buttons: string[] } {
  const label = `「${input.label}」`;
  const toChoose = input.settingsToChoose ?? 0;
  const manuscripts = input.manuscripts ?? 0;
  // **窓に出すのは、作者が判断に使うことだけ**（作者の裁定、2026-10-11）。
  // 自動で書かれるもの・履歴・設定資料の内訳は作品のログへ回す
  // （`describeDivergenceBreakdown`）。ここに並べると、読む所が分からない
  const lines = ["もう1台で書いた分を入れ、このパソコンで書いた分も残します。"];
  if (manuscripts > 0) {
    lines.push(
      `同じところを両方で書き換えた原稿が ${manuscripts}件あります。` +
        "このあと両方の文を並べるので、残すほうを選んでください。"
    );
  }
  if (toChoose > 0) {
    // ボタンが3つに増える理由が分かるように、これだけは窓に残す
    lines.push(
      `作者が書いたところが両方で違う設定資料が ${toChoose}件あります。` +
        "下のボタンで決め方を選んでください。"
    );
  }
  lines.push(
    input.autoResend
      ? "そろえ終わったら、数分のうちに自動でGitHubへ送ります。"
      : "GitHubへは送りません。送るときは「保存・同期」を押してください。"
  );

  return {
    message: input.autoResend
      ? `${label}：2台の原稿をそろえて、GitHubへ送ります。`
      : `${label}：2台の原稿をそろえます。`,
    detail:
      `${lines.join("\n")}\n\n` +
      "途中でやめれば、原稿は元のままです。そろえたあとでも「そろえる前」へ戻せます。",
    buttons: toChoose > 0 ? [MERGE_NEWEST, MERGE_ONE_BY_ONE] : [MERGE],
  };
}

/**
 * 確認の窓から外した内訳を、作品のログへ1行で残す文（作者の裁定、2026-10-11）。
 *
 * **黙って片方へ寄せたことにしない**（5.5.18）ために、窓から外しても
 * どこかには残す。開発側が「何がどう片づく見込みだったか」を追えるように。
 */
export function describeDivergenceBreakdown(input: {
  label: string;
  behind: number;
  ahead: number;
  autoWritten: number;
  appendOnly?: number;
  settings?: number;
  settingsToChoose?: number;
  manuscripts?: number;
}): string {
  return (
    `そろえる前の見込み（${input.label}／もう1台の記録 ${input.behind}件・` +
    `このパソコンの記録 ${input.ahead}件／自動で書かれるもの ${input.autoWritten}件は` +
    `このパソコンの側／追記型 ${input.appendOnly ?? 0}件は両方の行／` +
    `設定資料 ${input.settings ?? 0}件（作者が選ぶ ${input.settingsToChoose ?? 0}件）／` +
    `作者が選ぶ原稿 ${input.manuscripts ?? 0}件）`
  );
}

/** 確認の窓のボタン。**押された文字で分けるので、定数を1か所に置く** */
const MERGE = "そろえる";
const MERGE_NEWEST = "そろえる（設定資料は新しいほうへ）";
const MERGE_ONE_BY_ONE = "そろえる（1件ずつ選ぶ）";

/** 押されたボタンを見比べの始め方へ。押さずに閉じたら undefined（合わせない） */
function mergeChoiceOf(answer: string | undefined): ConflictWalkStart | undefined {
  if (answer === MERGE_NEWEST) return "newest";
  if (answer === MERGE_ONE_BY_ONE) return "oneByOne";
  if (answer === MERGE) return "manuscriptsOnly";
  return undefined;
}

/**
 * 押す前に、何が起きるかを見せる。**選び方もここで訊く**（案2、2026-10-01）。
 * 押さずに閉じたら undefined（合わせない）
 */
async function confirm(
  label: string,
  behind: number,
  ahead: number,
  preview: MergePreview,
  undecidedSettings: readonly string[] | undefined,
  autoResend: boolean
): Promise<ConflictWalkStart | undefined> {
  const classified = classifyConflicts(preview.conflicts);
  const counts = {
    label,
    behind,
    ahead,
    autoWritten: classified.autoWritten.length,
    appendOnly: classified.appendOnly.length,
    settings: classified.settings.length,
    // 調べられなかったら全部を選ぶ側に数える（安全な側）
    settingsToChoose: (undecidedSettings ?? classified.settings).length,
    manuscripts: classified.manuscripts.length,
  };
  logStep(describeDivergenceBreakdown(counts));
  const text = describeDivergenceConfirm({ ...counts, autoResend });
  const answer = await vscode.window.showInformationMessage(
    text.message,
    { modal: true, detail: text.detail },
    ...text.buttons
  );
  return mergeChoiceOf(answer);
}

/**
 * 実際に畳む。**検査に1つでも落ちたら戻す**
 *
 * **画面の確認は挟まない。** 同期の流れの中から呼ぶためである
 * （作者の指示、2026-09-10：「もう少し手軽にできないですか」）。
 * 作者に選んでもらうところ（`walk`）だけは、性質上どうしても画面が要る。
 */
export async function foldDivergence(
  deps: ResolveDivergenceDeps,
  target: FoldTarget,
  options: FoldOptions = {}
): Promise<FoldOutcome> {
  const run = deps.run ?? runGit;
  const { root, label, upstream } = target;
  useRootLog(deps, root);
  const report = (message: string) => options.progress?.report({ message });

  // **自動の経路では、統計のほかに未記録があれば合わせない。** 書きかけを
  // 履歴へ入れないため（6.15.1）。退避の枝を作る前に見る（断るなら枝は要らない）
  if (options.automatic) {
    const authored = await countAuthoredPending(root, run);
    if (authored === undefined || authored > 0) {
      return {
        ok: false,
        reason:
          authored === undefined
            ? "作業ツリーの状態を読めなかったため、自動では合わせませんでした。"
            : `記録していない変更が${authored}件あるため、自動では合わせませんでした。`,
      };
    }
  }

  report("そろえる前の控えを作っています…");
  const backup = backupBranchName();
  const branched = await run(["branch", backup], root, 15_000);
  if (branched.code !== 0) {
    return {
      ok: false,
      reason: `そろえる前の控えを作れませんでした: ${branched.stderr.trim()}`,
    };
  }

  report("未記録の変更を記録しています…");
  // 自動の経路では記録しない（上で、残っているのは統計だけだと確かめてある）
  const pending = options.automatic ? 0 : await countTrackableFiles(root, run);
  if (pending > 0) {
    if (!(await hasCommitIdentity(root, run))) {
      return {
        ok: false,
        reason:
          "記録する人の名前が未設定です。「GitHubと同期」から一度設定してください。",
      };
    }
    const committed = await commitAll(
      root,
      `合わせる前の自動保存（${pending}件）`,
      run
    );
    if (!committed.ok) {
      return {
        ok: false,
        reason: `記録できませんでした: ${committed.detail ?? ""}`,
      };
    }
  }

  report("原稿の指紋を控えています…");
  const before = await fingerprints(root, run);

  report("そろえています…");
  // **確定させずに畳む。** 検査に落ちたときに戻せるようにするため
  const merged = await run(
    ["merge", "--no-commit", "--no-ff", upstream],
    root,
    120_000
  );

  // 規則で戻したファイル。**触ってよい側に数える**——
  // gitが書き戻すときに改行の自動変換が入るため、中身が同じでも
  // バイトは変わりうる（実際に試験で捕まえた）
  const resolved: string[] = [];
  const settingsAutoResolved: SettingsResolution[] = [];
  let manuscriptConflicts: string[] = [];
  let settingsBulkResolved = 0;
  // 「両方とも残す」で作った別ファイル。**記録の直前まで git へ足さない**（下）
  let sideFiles: string[] = [];

  const unresolved = await unmergedFiles(root, run);
  if (unresolved.length === 0 && merged.code !== 0) {
    await run(["merge", "--abort"], root, 15_000);
    return {
      ok: false,
      reason: `合わせられませんでした: ${(merged.stderr || merged.stdout).trim()}`,
    };
  }

  if (unresolved.length > 0) {
    report("食い違いを片づけています…");
    const classified = classifyConflicts(unresolved);

    // 1. 自動で書かれるもの。**作り直せるので、この端末の側を残す**
    for (const file of classified.autoWritten) {
      if (!(await keepSideOfConflict(root, file, "ours", run))) {
        return await abort(root, run, `${file} を確定できませんでした`);
      }
      resolved.push(file);
    }

    // 1'. 追記型（履歴・提案・ロック）。**どちらも捨てず、両方の行を残す**。
    // 片側を残すと、もう片方の環境で書かれた記録がそこで消える
    // （`core/editHistory.ts`）。作者に訊いても答えは「両方」しか無い
    for (const file of classified.appendOnly) {
      if (!(await mergeAppendOnly(root, file, run))) {
        return await abort(root, run, `${file} の行を混ぜられませんでした`);
      }
      resolved.push(file);
    }
    if (classified.appendOnly.length > 0) {
      logStep(
        `追記型の記録 ${classified.appendOnly.length}件は、両方の行を残しました`
      );
    }

    // 2. 設定資料のJSON。規則で決める（設計書5.5.18）
    const undecided: string[] = [];
    for (const file of classified.settings) {
      const decision = await decideForFile(root, file, run);
      if (decision.side === "conflict") {
        undecided.push(file);
        continue;
      }
      const settled =
        decision.side === "merged"
          ? await placeMergedSettings(root, file, decision.text, run)
          : await keepSideOfConflict(root, file, decision.side, run);
      if (!settled) {
        return await abort(root, run, `${file} を確定できませんでした`);
      }
      resolved.push(file);
      settingsAutoResolved.push({
        file,
        side: decision.side,
        reason: decision.reason,
      });
      // **黙って片方へ寄せたことにしない。** どちらを採ったかを1行ずつ残す
      logStep(
        `設定資料の衝突：${file} → ` +
          `${
            decision.side === "ours"
              ? "こちら"
              : decision.side === "theirs"
                ? "別環境"
                : "両方を合わせた"
          }（${decision.reason}）`
      );
    }

    // 3. 残りは作者が選ぶ。**同じ箇所を両方で書き換えたものだけ**が来る
    const forAuthor = [...undecided, ...classified.manuscripts];
    if (forAuthor.length > 0 && options.authorChoice === "stop") {
      // **選ぶ画面は、作者が押したときだけ開く。** ここでは合わせるのを
      // やめて戻し、何が残ったかだけを返す（知らせと口は呼び出し側が出す）
      await run(["merge", "--abort"], root, 15_000);
      await dropUnusedBackup(root, backup, run);
      return {
        ok: false,
        reason: describeAuthoredStop(forAuthor),
        authored: forAuthor,
      };
    }
    if (forAuthor.length > 0) {
      const walk = options.walk ?? defaultWalk;
      let walked: WalkConflictsResult;
      try {
        walked = await walk({
          root,
          label,
          files: forAuthor,
          run,
          start: options.start,
        });
      } catch (error) {
        return await abort(
          root,
          run,
          `見比べの途中で問題が起きました: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      if (walked.aborted) {
        await run(["merge", "--abort"], root, 15_000);
        return {
          ok: false,
          reason: describeAuthoredStop(forAuthor),
          authored: forAuthor,
        };
      }
      // 検査の白紙は「触ってよい側」なので、**一括で寄せた分もここへ足す**。
      // 落とすと、gitが書き戻したときの改行の違いだけで検査が落ちる
      resolved.push(...walked.resolved, ...walked.bulkResolved);
      manuscriptConflicts = [...walked.resolved];
      settingsBulkResolved = walked.bulkResolved.length;
      sideFiles = [...(walked.sideFiles ?? [])];
    }

    // 選び終わっても未解決が残っているなら、こちらの読み違いである。
    // **中途半端に確定した状態で記録しない**
    const left = await unmergedFiles(root, run);
    if (left.length > 0) {
      return await abort(
        root,
        run,
        `まだ解決できていないファイルが残っています：${left.slice(0, 3).join("、")}`
      );
    }
  }

  report("取り込んだ中身を確かめています…");
  const incoming = await stagedFiles(root, run);
  // 印つきのまま記録されて届いた追記型の記録は、印の行だけ落として両方の行を
  // 残す。**衝突にはならないので上の片づけを通らず**、検査で毎回止まっていた。
  // 追記型に限るので、原稿や設定資料の印はこれまでどおり下の検査が止める
  const cleaned = await cleanAppendOnlyMarkers(root, incoming, run);
  if (cleaned === undefined) {
    return await abort(root, run, "競合の印が残った記録を片づけられませんでした");
  }
  if (cleaned.length > 0) {
    resolved.push(...cleaned);
    logStep(
      `競合の印つきで届いた追記型の記録 ${cleaned.length}件は、印の行を落として両方の行を残しました`
    );
  }
  const markers = await filesWithMarkers(root, incoming);
  const after = await fingerprints(root, run);
  const guard = guardResult(
    markers,
    unexpectedChanges(before, after, [...incoming, ...resolved])
  );

  if (!guard.ok) {
    await run(["merge", "--abort"], root, 15_000);
    return {
      ok: false,
      reason:
        "合わせた中身が検査に通らなかったため、元に戻しました。\n" +
        describeGuardFailure(guard),
    };
  }

  // 「両方とも残す」の別ファイルを、そろえた記録へ一緒に入れる
  // （作者の裁定、2026-10-11「一緒に送る」。もう1台でも写しが読めるように）。
  // **検査のあと・記録の直前に足す。** 選んだ直後に索引へ入れると、途中で
  // やめたときの `merge --abort` が索引ごと戻し、写しが作業ツリーから消えうる
  // （`resolveDivergence.test.ts` の裏づけの試験）。新しいファイルなので
  // 検査の指紋（追跡しているファイルだけ）には入っておらず、検査を乱さない
  if (sideFiles.length > 0) {
    const added = await run(["add", "--", ...sideFiles], root, 15_000);
    if (added.code !== 0) {
      return await abort(
        root,
        run,
        `両方とも残した別ファイルを記録に入れられませんでした: ${(
          added.stderr || added.stdout
        ).trim()}`
      );
    }
    logStep(`両方とも残した別ファイル ${sideFiles.length}件を記録に入れます：${sideFiles.join("、")}`);
  }

  report("記録しています…");
  const committed = await run(["commit", "--no-edit"], root, 60_000);
  if (committed.code !== 0) {
    return {
      ok: false,
      reason: `合わせた分を記録できませんでした: ${(
        committed.stderr || committed.stdout
      ).trim()}`,
    };
  }

  await deps.monitor?.refreshAll({ fetch: false });
  return {
    ok: true,
    backup,
    incoming: incoming.length,
    settingsAutoResolved,
    settingsBulkResolved,
    manuscriptConflicts,
  };
}

/**
 * 作者が書いた未記録の変更の数。**拡張機能が自動で書く統計は数えない**
 * （点検の `parseStatusPorcelain` と同じ線引き。`isAutoWrittenLine`）。
 * 状態を読めなければ undefined（数えられないものを0と言わない）。
 */
async function countAuthoredPending(
  root: string,
  run: GitCommandRunner
): Promise<number | undefined> {
  const result = await run(
    ["status", "--porcelain", "--untracked-files=all"],
    root,
    15_000
  );
  if (result.code !== 0) return undefined;
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0 && !isAutoWrittenLine(line)).length;
}

/** 既定の見比べ。**画面が要るので、使うときだけ読み込む** */
const defaultWalk: ConflictWalker = async ({ root, label, files, run, start }) => {
  const { walkConflicts } = await import("./resolveConflicts.js");
  return walkConflicts(
    { id: root, title: label, folderPath: root },
    files,
    { run, start }
  );
};

/** 索引の3つの版を読んで、どちらを残すか決める */
async function decideForFile(
  root: string,
  file: string,
  run: GitCommandRunner
): Promise<SettingsConflictDecision> {
  const base = await showStage(root, file, 1, run);
  const ours = await showStage(root, file, 2, run);
  const theirs = await showStage(root, file, 3, run);
  if (ours === undefined || theirs === undefined) {
    // 片方にしか無い（追加と削除がぶつかった）。**中身を比べられない**
    return {
      side: "conflict",
      reason: "片方の版がありません",
    };
  }
  return decideSettingsConflict({ base, ours, theirs });
}

/**
 * 追記型の記録を、**両方の行を残す形**で確定させる。
 *
 * 1行1件の追記しかしないので、分岐で起きるのは「行が混ざった」だけである
 * （`core/editHistory.ts`）。混ぜるのは `mergeProposalJsonl`——提案を混ぜる
 * のに既に使っている純粋関数で、同じ行は `lineKey` で1つに畳み、gitが
 * 残した競合マーカーの行は落とす。**写しを作らずに、そちらへ任せる。**
 *
 * ここだけは `atomicWriteFile` を通さない。索引から書き戻すのではなく
 * **その場で組んだ中身を置く**ので、gitに任せる経路が無い。相手は
 * `.aiwriter/` の下の機械の記録であって原稿ではないため、
 * `writeTextFilePreservingFormat`（退避→新規作成）の対象でもない。
 * 巻き戻したいときは、この関数の外側の `merge --abort` と退避の枝が効く。
 */
async function mergeAppendOnly(
  root: string,
  file: string,
  run: GitCommandRunner
): Promise<boolean> {
  const ours = await showStage(root, file, 2, run);
  const theirs = await showStage(root, file, 3, run);
  // 片方にしか無い（追加と削除がぶつかった）。**消さずに、ある側を残す**
  const text =
    ours !== undefined && theirs !== undefined
      ? mergeProposalJsonl(ours, theirs).text
      : ours ?? theirs;
  if (text === undefined) return false;

  try {
    await vscode.workspace.fs.writeFile(
      paths.toUri(paths.join(root, file)),
      new TextEncoder().encode(text)
    );
  } catch (error) {
    logFailure("追記型の記録を混ぜられなかった", {
      ファイル: file,
      詳細: error instanceof Error ? error.message : String(error),
    });
    return false;
  }

  const added = await run(["add", "--", file], root, 15_000);
  return added.code === 0;
}

/**
 * 設定資料の1件を、**両側の変更を項目ごとに合わせた中身**で確定させる
 * （案3、2026-10-01）。
 *
 * 片側を残すとき（`keepSideOfConflict`）は git が索引から書き戻すが、
 * 合わせた中身はどちらの版にも無いので、**その場で組んだものを置いて
 * `git add` する**（`mergeAppendOnly` と同じ形）。
 *
 * **作者のデータを上書きしていないか**——置くのは合流の途中の作業ツリーで、
 * gitが競合の印つきで書いたファイルの上である（作者が書いた版そのものではない）。
 * 中身は `decideSettingsConflict` が「作者の項目を相手の値で書き換えない」
 * 規則で組んだもの。巻き戻したいときは、外側の `merge --abort` と退避の枝が効く。
 *
 * **改行は、いま作業ツリーにあるファイルに合わせる**（`jsonFileFormat.ts` と
 * 同じ考え方）。Windows で git が CRLF にして取り出していれば CRLF で置く——
 * LF で置くと、次に保存したとき全行が差分になる。
 */
async function placeMergedSettings(
  root: string,
  file: string,
  text: string,
  run: GitCommandRunner
): Promise<boolean> {
  const target = paths.join(root, file);
  const current = await readBytes(target);
  const body = current
    ? fromLfText(toLf(text), detectJsonFileFormat(current).useCrlf)
    : text;
  try {
    await vscode.workspace.fs.writeFile(
      paths.toUri(target),
      new TextEncoder().encode(body)
    );
  } catch (error) {
    logFailure("設定資料の合わせた中身を置けなかった", {
      ファイル: file,
      詳細: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  const added = await run(["add", "--", file], root, 15_000);
  return added.code === 0;
}

/**
 * 取り込んだファイルのうち、**追記型の記録で競合の印が残っているもの**を
 * 印の行だけ落として書き戻す。片づけたファイル名を返し、失敗なら undefined。
 *
 * 別の道具（VS Code のソース管理など）で合わせたときに印が残ったまま
 * 記録され、それが届く形がある。追記型なので、印に挟まれた両側の行は
 * どちらも正しい記録であり、落とすのは印の行だけでよい（`mergeProposalJsonl`）。
 * 書き戻し方は `mergeAppendOnly` と同じ（機械の記録なので、原稿用の経路は通さない）。
 */
async function cleanAppendOnlyMarkers(
  root: string,
  incoming: readonly string[],
  run: GitCommandRunner
): Promise<string[] | undefined> {
  const cleaned: string[] = [];
  for (const file of incoming.filter(isAppendOnlyPath)) {
    const bytes = await readBytes(paths.join(root, file));
    if (!bytes) continue;
    const text = new TextDecoder().decode(bytes);
    if (!containsConflictMarkers(text)) continue;
    try {
      await vscode.workspace.fs.writeFile(
        paths.toUri(paths.join(root, file)),
        new TextEncoder().encode(mergeProposalJsonl(text, "").text)
      );
    } catch (error) {
      logFailure("競合の印が残った記録を片づけられなかった", {
        ファイル: file,
        詳細: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
    const added = await run(["add", "--", file], root, 15_000);
    if (added.code !== 0) return undefined;
    cleaned.push(file);
  }
  return cleaned;
}

/**
 * 使わなかった退避の枝を消す。
 *
 * **開いたときの点検は、作者が合わせるまで毎回同じ所で止まる。** そのたびに
 * 枝が1本ずつ増えると、戻したいときにどれが本物か分からなくなる。
 *
 * **消すのは、先頭が枝と同じ位置のときだけ**（`branch -d` なので、先頭に
 * 含まれていない枝は git が消さない）。合わせる前の自動保存で記録が1つ
 * 進んでいるときは、記録する前へ戻れる枝として残す。
 */
async function dropUnusedBackup(
  root: string,
  backup: string,
  run: GitCommandRunner
): Promise<void> {
  const head = await run(["rev-parse", "HEAD"], root, 15_000);
  const saved = await run(["rev-parse", backup], root, 15_000);
  if (head.code !== 0 || saved.code !== 0) return;
  if (head.stdout.trim() !== saved.stdout.trim()) return;
  const dropped = await run(["branch", "-d", backup], root, 15_000);
  if (dropped.code !== 0) {
    // 消せなくても害は無い（枝が1本残るだけ）。理由だけ残す
    logFailure("使わなかった退避の枝を消せなかった", {
      枝: backup,
      詳細: (dropped.stderr || dropped.stdout).trim(),
    });
  }
}

/** 途中でやめる。**原稿を元へ戻してから理由を返す** */
async function abort(
  root: string,
  run: GitCommandRunner,
  reason: string
): Promise<FoldOutcome> {
  await run(["merge", "--abort"], root, 15_000);
  return { ok: false, reason: `${reason}。元に戻しました。` };
}

/**
 * 作者が選ばずにやめたときの知らせ。
 *
 * **次にどうすれば続きへ行けるかまで書く。** 「戻しました」だけだと、
 * 作者は同じところへ戻ってくる道を持たない。
 */
export function describeAuthoredStop(files: readonly string[]): string {
  const listed = files.slice(0, 5).map((file) => baseNameOf(file));
  const more = files.length > 5 ? `、ほか${files.length - 5}件` : "";
  // **「続きから選べます」とは言わない**（2026-10-11）。やめると `merge --abort`
  // で全部戻るので、次は最初から選び直しになる。事実と違う約束をしていた
  return (
    `同じところを両方で書き換えた原稿・設定資料が ${files.length}件あります` +
    `（${listed.join("、")}${more}）。` +
    "そろえるのをやめて、元のままにしました。" +
    "もう一度そろえる操作をすると、最初から選び直せます。"
  );
}

/**
 * 合わせた結果の知らせ（設計書5.5.18）。
 *
 * 作者の指摘（2026-09-10）：「競合解決があるかないかわからない。件数が出ない」。
 * **何件をどう片づけたかを、必ず数字で出す。**
 *
 * **一括で寄せた分と、1件ずつ選んだ分は分けて言う**（2026-09-11）。
 * 13件を「全部、新しいほうを採る」で片づけたのに
 * 「お選びいただきました」と出ていた。**やっていないことを、やったと言わない。**
 */
export function describeFoldSuccess(
  label: string,
  result: Extract<FoldOutcome, { ok: true }>,
  options: {
    /** この知らせのすぐあとに、呼び出し側が送る（同期の流れの中） */
    sending: boolean;
    /**
     * 自動の送り直しが入っているか。**そろえた記録は数分のうちに送られる**
     * （2026-10-11、「送りません」と書いた1分後に送られていた）
     */
    autoResend?: boolean;
  } = { sending: false }
): string {
  const parts = [`もう1台から入れたファイル ${result.incoming}件`];
  if (result.settingsAutoResolved.length > 0) {
    // 両方の変更を項目ごとに合わせた分（案3）。**片方へ寄せたとは言わない**。
    // どちらの側を採ったかの内訳は、1件ずつ作品のログに残してある
    const merged = result.settingsAutoResolved.filter(
      (one) => one.side === "merged"
    ).length;
    parts.push(
      `設定資料 ${result.settingsAutoResolved.length}件は新しいほうにそろえました` +
        (merged > 0 ? `（うち両方の変更を合わせた ${merged}件）` : "")
    );
  }
  if (result.settingsBulkResolved > 0) {
    parts.push(`設定資料 ${result.settingsBulkResolved}件は、まとめて新しいほうを採りました`);
  }
  // **作者が1件ずつ選んだ分だけを数える**（一括で寄せた分を混ぜない。2026-09-11）
  if (result.manuscriptConflicts.length > 0) {
    parts.push(`選んでいただいた原稿 ${result.manuscriptConflicts.length}件`);
  }
  const sendNote = options.sending
    ? "続けてGitHubへ送ります。"
    : options.autoResend
      ? "数分のうちに自動でGitHubへ送ります。"
      : "GitHubへは「保存・同期」で送ります。";
  return (
    `「${label}」の2台の原稿をそろえました（${parts.join("／")}）。` +
    sendNote +
    `そろえる前へ戻したいときは、控え「${result.backup}」から戻せます。`
  );
}

/** 済んだあとの知らせ（「分かれた分を合わせる」から呼ぶとき） */
async function reportFold(
  deps: ResolveDivergenceDeps,
  label: string,
  result: FoldOutcome,
  options: { sending: boolean; autoResend: boolean }
): Promise<void> {
  if (!result.ok) {
    logFailure("分岐を合わせられなかった", { 置き場: label, 詳細: result.reason });
    const action = await vscode.window.showErrorMessage(
      `「${label}」の2台の原稿をそろえられませんでした。`,
      { modal: true, detail: `${result.reason}\n\n原稿は元のままです。` },
      "ログを表示"
    );
    if (action === "ログを表示") showLog();
    return;
  }

  logStep(
    `分岐を合わせた（${label}／取り込み ${result.incoming}件` +
      `／設定資料 ${result.settingsAutoResolved.length}件` +
      `／一括で新しいほう ${result.settingsBulkResolved}件` +
      `／作者が選んだ ${result.manuscriptConflicts.length}件）`
  );
  await deps.monitor?.refreshAll({ fetch: false });
  void vscode.window.showInformationMessage(
    describeFoldSuccess(label, result, options)
  );
}

/** 退避の枝の名前。**日付で分かるようにする** */
function backupBranchName(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `backup/${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-合わせる前`
  );
}

/** まだ解決していないファイル */
async function unmergedFiles(
  root: string,
  run: GitCommandRunner
): Promise<string[]> {
  const result = await run(
    ["diff", "--name-only", "--diff-filter=U", "-z"],
    root,
    15_000
  );
  if (result.code !== 0) return [];
  return [
    ...new Set(result.stdout.split("\u0000").filter((name) => name !== "")),
  ];
}

/** 畳んだ結果として入ったファイル */
async function stagedFiles(
  root: string,
  run: GitCommandRunner
): Promise<string[]> {
  const result = await run(
    ["diff", "--cached", "--name-only", "-z"],
    root,
    30_000
  );
  if (result.code !== 0) return [];
  return result.stdout.split("\u0000").filter((name) => name !== "");
}

/**
 * 追跡している文章ファイルの指紋。
 *
 * **中身をそのまま読んで数える。** gitに聞くと改行の自動変換が入った後の姿を
 * 答えるので、**まさに確かめたい変化が見えなくなる**。
 */
async function fingerprints(
  root: string,
  run: GitCommandRunner
): Promise<Map<string, string>> {
  const listed = await run(["ls-files", "-z"], root, 30_000);
  const files = listed.stdout
    .split("\u0000")
    .filter((name) => name !== "")
    .filter((name) =>
      WATCHED_EXTENSIONS.some((extension) =>
        name.toLowerCase().endsWith(extension)
      )
    );

  const map = new Map<string, string>();
  for (const file of files) {
    const bytes = await readBytes(paths.join(root, file));
    if (bytes) map.set(file, sha256Bytes(bytes));
  }
  return map;
}

/** 競合マーカーが残っているファイル */
async function filesWithMarkers(
  root: string,
  files: readonly string[]
): Promise<string[]> {
  const found: string[] = [];
  for (const file of files) {
    const bytes = await readBytes(paths.join(root, file));
    if (!bytes) continue;
    // 判定に要るのは行頭の記号だけなので、読めない文字は捨てて構わない
    if (containsConflictMarkers(new TextDecoder().decode(bytes))) found.push(file);
  }
  return found;
}

async function readBytes(filePath: string): Promise<Uint8Array | undefined> {
  try {
    return await vscode.workspace.fs.readFile(paths.toUri(filePath));
  } catch {
    // 消えたファイルは「指紋なし」として扱う。`unexpectedChanges` が拾う
    return undefined;
  }
}

/** ファイル名だけを取り出す。**gitは常に `/` 区切りで返す** */
function baseNameOf(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1] || filePath;
}

