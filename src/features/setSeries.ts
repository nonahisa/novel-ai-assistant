import * as vscode from "vscode";
import * as path from "../core/paths";
import type { SeriesConfig, WorkConfig, WorkEntry } from "../models/types";
import { readWorkConfig, writeWorkConfig } from "../core/workRegistry";
import { clearSeriesCache } from "../core/seriesSettings";
import { isPlainFolderName } from "../core/seriesLink";
import { askText } from "../views/dialogs";
import { notifyDone } from "../views/notify";

/**
 * シリーズ作品を、設定資料でゆるくつなぐ（設計書6.95）。
 *
 * 作者の言葉（2026-09-19）：「シリーズ作品は設定資料等でゆるくつなぐ機能が
 * あってもいいですね」。
 *
 * ## 選ばせるのは、隣に並んでいる作品だけ
 *
 * つなぐ相手は**同じ親フォルダーの子**（書庫の中の隣り合わせ）に限る。
 * フォルダーを選ぶ画面を出さないのは、**絶対パスを持たないため**である
 * ——`config.json` は同期されるので、書き込んだ瞬間に別の機械で壊れる。
 *
 * ## シリーズ名は推測しない
 *
 * フォルダー名の共通部分から推すことはできるが、**推測で作者のデータに
 * 書き込まない**（設計書6.95.4）。空の入力欄から作者に書いてもらう。
 * すでに付けてあれば、それは作者のものなので初期値に置く。
 */
export async function setSeries(work: WorkEntry): Promise<boolean> {
  const config = await readWorkConfig(work);
  if (!config) {
    void vscode.window.showWarningMessage(
      `「${work.title}」の設定ファイルが見つかりません。` +
        "作品として登録し直してから、もう一度お試しください。"
    );
    return false;
  }

  const neighbors = await listSiblingFolderNames(work.folderPath);
  if (neighbors.length === 0) {
    void vscode.window.showInformationMessage(
      `「${work.title}」と同じフォルダーに、ほかの作品がありません。`,
      {
        modal: true,
        detail:
          "つなげられるのは、同じフォルダーに並んでいる作品だけです。" +
          "「作品を書庫にまとめる」で1つのフォルダーへ寄せてから、" +
          "もう一度お試しください。",
      }
    );
    return false;
  }

  const already = new Set(config.series?.related ?? []);
  const picked = await vscode.window.showQuickPick(
    neighbors.map((name) => ({
      label: name,
      picked: already.has(name),
    })),
    {
      title: `${work.title}とつなぐ作品`,
      placeHolder:
        "同じ世界・同じ人物の作品を選んでください。チェックを全部外すとつながりを解きます",
      canPickMany: true,
      ignoreFocusOut: true,
    }
  );
  // Esc（取りやめ）。0件を選んだ場合は「解く」なので、ここでは弾かない
  if (!picked) return false;

  if (picked.length === 0) {
    if (!config.series) return false;
    await writeSeries(work, config, undefined);
    notifyDone(`「${work.title}」のシリーズのつながりを解きました。`);
    return true;
  }

  const name = await askText({
    title: "シリーズの呼び名",
    prompt: "この2作をまとめて何と呼びますか",
    value: config.series?.name ?? "",
    validateInput: (value) =>
      value.trim().length === 0 ? "シリーズの呼び名を入れてください" : null,
  });
  if (name === undefined) return false;
  const trimmed = name.trim();
  if (!trimmed) return false;

  await writeSeries(work, config, {
    name: trimmed,
    related: picked.map((item) => item.label),
  });

  notifyDone(
    `「${work.title}」を${trimmed}としてつなぎました` +
      `（${picked.map((item) => item.label).join("、")}）。`,
    [
      "相手の人物・場所・能力・組織の名前と読み仮名を、色分け・ルビ・" +
        "IME辞書・表記ゆれの材料に足します。",
      "中身（紹介など）は読みません。相手の資料は書き換えません。",
    ]
  );
  return true;
}

/**
 * つながりを `config.json` へ書く。
 *
 * **片方向である**（設計書6.95.3）。相手の `config.json` は触らない。
 * 双方向にしたければ、作者が相手側でもこの操作を行う。
 */
async function writeSeries(
  work: WorkEntry,
  config: WorkConfig,
  series: SeriesConfig | undefined
): Promise<void> {
  const next = { ...config };
  if (series) next.series = series;
  else delete next.series;
  await writeWorkConfig(work, next);
  // 借りた語は控えてあるので、つなぎ直したら捨てる
  clearSeriesCache();
}

/**
 * 同じ親フォルダーに並んでいるフォルダーの名前を返す。
 *
 * **登録済みの作品に限らない。** 書庫へ写しただけでまだ登録していない
 * 作品ともつなげるようにしてある。隠しフォルダー（`.git` など）は外す。
 */
export async function listSiblingFolderNames(
  folderPath: string
): Promise<string[]> {
  const normalized = path.normalize(folderPath);
  const parent = path.dirname(normalized);
  if (!parent || parent === normalized) return [];
  const selfName = path.basename(normalized);

  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(path.toUri(parent));
  } catch {
    // 親が読めないときは、つなげる相手を出せないだけ。止めはしない
    return [];
  }

  return entries
    .filter(([, type]) => (type & vscode.FileType.Directory) !== 0)
    .map(([name]) => name)
    .filter(
      (name) =>
        name !== selfName && !name.startsWith(".") && isPlainFolderName(name)
    )
    .sort((a, b) => a.localeCompare(b, "ja"));
}
