import * as vscode from "vscode";
import * as path from "../core/paths";
import { sha256Bytes } from "../core/hash";
import type { WorkRegistry } from "../core/workRegistry";
import {
  describeMergePlans,
  planMerge,
  shouldSkip,
  type MergePlan,
} from "../core/libraryMerge";
import { logFailure, logStep } from "../core/logger";
import { pickFolder } from "./pickFolder";
import { withCancellableProgress } from "../views/progress";


/**
 * 別々に置かれている作品を、1つの書庫へまとめ直す（設計書5.7.10）。
 *
 * 作者の指示（2026-08-22）：「ひとつへまとめなおす道を作ってください」。
 *
 * ## 原本は消さない。写すだけ
 *
 * **元のフォルダーはそのまま残す。** 中身を見比べて納得してから、作者が
 * 自分で消せばよい。**原稿を動かす操作で、こちらが後戻りできない形に
 * してはいけない**（設計書5.4）。
 *
 * 登録簿の指す先だけを新しい場所へ移し替える。元のフォルダーは
 * **登録から外れるだけで、ディスクには残っている。**
 *
 * ## 写したものを、必ず読み直して照合する
 *
 * 1ファイルずつ、写す前と写したあとのハッシュを突き合わせる。
 * **「コピーした」と「同じものがある」は違う。** ここを確かめずに
 * 元を登録から外すと、欠けに気づくのが何日も先になる。
 */

/** 1件の結果 */
interface MergeOutcome {
  title: string;
  ok: boolean;
  detail?: string;
  /** 写した先（成功したときだけ） */
  destination?: string;
}

export async function mergeIntoLibrary(
  registry: WorkRegistry
): Promise<boolean> {
  const works = registry.list();
  if (works.length < 2) {
    await vscode.window.showInformationMessage(
      "まとめる作品が足りません。作品を2つ以上登録してからお試しください。"
    );
    return false;
  }

  const library = await pickFolder(
    "書庫にするフォルダーを選択",
    "ここを書庫にする"
  );
  if (!library) return false;

  const takenNames = await namesInside(library);
  const candidates = works.filter(
    (work) =>
      path.normalizeForComparison(work.folderPath) !==
      path.normalizeForComparison(library)
  );
  const plans = planMerge(candidates, library, takenNames);

  const movable = plans.filter((plan) => !plan.blocked);
  if (movable.length === 0) {
    await vscode.window.showWarningMessage(
      `「${path.basename(library)}」へまとめられる作品がありませんでした。`,
      { modal: true, detail: describeMergePlans(plans) }
    );
    return false;
  }

  const chosen = await chooseWorks(movable, plans, library);
  if (!chosen || chosen.length === 0) return false;

  if (!(await confirm(chosen, library))) return false;

  const outcomes = await runMerge(chosen);
  await reregister(registry, outcomes, chosen);
  await report(outcomes, library);
  return outcomes.some((outcome) => outcome.ok);
}

/** 書庫の直下にすでにある名前（比較用に正規化して返す） */
async function namesInside(library: string): Promise<Set<string>> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(
      path.toUri(library)
    );
    return new Set(
      entries.map(([name]) => path.normalizeForComparison(name))
    );
  } catch {
    // 読めないなら、名前の重なりは判定できない。実行時に上書き禁止で止まる
    return new Set();
  }
}

/**
 * どれをまとめるか選ばせる。
 *
 * **黙って全部は動かさない。** 別々に置いてあるのには理由があることがある
 * （編集部へ渡している作品など）。
 */
async function chooseWorks(
  movable: readonly MergePlan[],
  all: readonly MergePlan[],
  library: string
): Promise<MergePlan[] | undefined> {
  const blocked = all.filter((plan) => plan.blocked);
  const picked = await vscode.window.showQuickPick(
    movable.map((plan) => ({
      label: plan.work.title,
      description: `→ ${plan.folderName}`,
      detail: plan.work.folderPath,
      picked: true,
      plan,
    })),
    {
      canPickMany: true,
      title: `「${path.basename(library)}」へまとめる作品を選んでください`,
      placeHolder:
        blocked.length > 0
          ? `${blocked.length}件は名前が重なるなどの理由で選べません`
          : "外したいもののチェックを外して、OKを押してください",
      ignoreFocusOut: true,
    }
  );
  return picked?.map((item) => item.plan);
}

/**
 * 実行前の確認。
 *
 * **何が起きて、何が起きないかを両方書く。** 原稿を扱う操作なので、
 * 「元は消えない」を先に言う。
 */
async function confirm(
  plans: readonly MergePlan[],
  library: string
): Promise<boolean> {
  const answer = await vscode.window.showWarningMessage(
    `${plans.length}件の作品を「${path.basename(library)}」へまとめますか？`,
    {
      modal: true,
      detail: [
        describeMergePlans(plans),
        "",
        "元のフォルダーは消しません。中身を写したうえで、作品一覧の指す先だけを",
        "新しい場所へ移します。見比べて納得できたら、元のフォルダーはご自身で消してください。",
        "",
        "書き換えの記録（履歴）は元のフォルダーに残ります。新しい書庫では、",
        "まとめた時点からの記録が始まります。",
      ].join("\n"),
    },
    "まとめる"
  );
  return answer === "まとめる";
}

/** 1件ずつ写して、写したものを読み直して照合する */
async function runMerge(plans: readonly MergePlan[]): Promise<MergeOutcome[]> {
  const outcomes: MergeOutcome[] = [];

  await withCancellableProgress(
    "作品を書庫へまとめています…",
    async (progress, token) => {
      let done = 0;
      for (const plan of plans) {
        if (token.isCancellationRequested) break;
        progress.report({
          message: `${plan.work.title}（${++done}/${plans.length}）`,
        });
        outcomes.push(await mergeOne(plan, token));
      }
    }
  );

  return outcomes;
}

async function mergeOne(
  plan: MergePlan,
  token: vscode.CancellationToken
): Promise<MergeOutcome> {
  const title = plan.work.title;
  try {
    // **すでにあるものへは絶対に書かない。** 選んだ時点から実行までの間に
    // 作られていることもあるので、直前にもう一度確かめる
    if (await exists(plan.destination)) {
      return {
        title,
        ok: false,
        detail: `「${plan.folderName}」がすでにあります（上書きしません）`,
      };
    }

    const files = await collectFiles(plan.work.folderPath);
    if (files.length === 0) {
      return { title, ok: false, detail: "写すファイルがありませんでした" };
    }

    for (const relative of files) {
      if (token.isCancellationRequested) {
        return { title, ok: false, detail: "取りやめました" };
      }
      const from = path.join(plan.work.folderPath, relative);
      const to = path.join(plan.destination, relative);
      const bytes = await vscode.workspace.fs.readFile(path.toUri(from));
      await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(to)));
      await vscode.workspace.fs.writeFile(path.toUri(to), bytes);

      // **写したものを読み直して照合する。** 「コピーした」と
      // 「同じものがある」は違う
      const written = await vscode.workspace.fs.readFile(path.toUri(to));
      if (sha256Bytes(written) !== sha256Bytes(bytes)) {
        return {
          title,
          ok: false,
          detail: `写した中身が一致しませんでした（${relative}）`,
        };
      }
    }

    logStep(`書庫へまとめた: ${title} → ${plan.destination}（${files.length}件）`);
    return { title, ok: true, destination: plan.destination };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logFailure("書庫へまとめる", { 作品: title, 詳細: detail });
    return { title, ok: false, detail };
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(path.toUri(target));
    return true;
  } catch {
    return false;
  }
}

/**
 * 写すファイルを、作品フォルダーからの相対パスで並べる。
 *
 * `.git` とキャッシュは写さない（`core/libraryMerge.ts` の `shouldSkip`）。
 */
async function collectFiles(root: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(relative: string): Promise<void> {
    const current = relative ? path.join(root, relative) : root;
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(path.toUri(current));
    } catch {
      return;
    }
    for (const [name, kind] of entries) {
      const next = relative ? `${relative}/${name}` : name;
      if (shouldSkip(next)) continue;
      if (kind === vscode.FileType.Directory) {
        await walk(next);
      } else if (kind === vscode.FileType.File) {
        found.push(next);
      }
    }
  }

  await walk("");
  return found;
}

/**
 * 登録簿の指す先を、新しい場所へ移し替える。
 *
 * **写せたものだけ**を移す。失敗した作品は元の登録のまま残す
 * ——そこで登録を外すと、作者は作品を見失う。
 */
async function reregister(
  registry: WorkRegistry,
  outcomes: readonly MergeOutcome[],
  plans: readonly MergePlan[]
): Promise<void> {
  const byTitle = new Map(plans.map((plan) => [plan.work.title, plan.work]));

  for (const outcome of outcomes) {
    if (!outcome.ok || !outcome.destination) continue;
    const work = byTitle.get(outcome.title);
    if (!work) continue;
    try {
      await registry.addExisting(outcome.destination, work.title);
      // 新しい先を登録できてから、古い登録を外す。順を逆にすると、
      // 途中で失敗したときに作品が一覧から消える
      await registry.remove(work.id);
    } catch (error) {
      logFailure("書庫へまとめたあとの登録", {
        作品: work.title,
        詳細: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * 結果を伝える。
 *
 * **元のフォルダーがどこに残っているかを必ず言う。** 「まとめました」だけ
 * だと、作者は元が消えたのか残っているのか分からない。
 */
async function report(
  outcomes: readonly MergeOutcome[],
  library: string
): Promise<void> {
  const done = outcomes.filter((outcome) => outcome.ok);
  const failed = outcomes.filter((outcome) => !outcome.ok);

  if (done.length === 0) {
    const action = await vscode.window.showErrorMessage(
      "まとめられませんでした。",
      { modal: true, detail: failed.map(describeOutcome).join("\n") },
      "ログを表示"
    );
    if (action === "ログを表示") {
      await vscode.commands.executeCommand("novelai.showLog");
    }
    return;
  }

  const detail = [
    `書庫: ${library}`,
    "",
    ...done.map((outcome) => `　${outcome.title}`),
    ...(failed.length > 0
      ? ["", `まとめられなかったもの（${failed.length}件）`, ...failed.map(describeOutcome)]
      : []),
    "",
    "元のフォルダーはそのまま残っています。中身を見比べて納得できたら、",
    "ご自身で消してください（作品一覧からは外れています）。",
    "",
    "この書庫をGitHubへ載せるには、「GitHubに置く（はじめて）」をお使いください。",
  ].join("\n");

  await vscode.window.showInformationMessage(
    `${done.length}件を「${path.basename(library)}」へまとめました。`,
    { modal: true, detail }
  );
}

function describeOutcome(outcome: MergeOutcome): string {
  return `　${outcome.title}：${outcome.detail ?? "（理由なし）"}`;
}

