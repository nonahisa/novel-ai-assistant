import * as vscode from "vscode";
import * as path from "../core/paths";
import { fromUri } from "../core/paths";
import { isWebRuntime } from "../core/runtime";

/**
 * いまの環境で、ファイルに何ができるかを実際に試して並べる（設計書5.8.11）。
 *
 * **憶測で直さないために作った。** ブラウザのVS Code（vscode.dev）で
 * 作品を登録できなかったとき、原因の候補は複数あった——フォルダーが
 * 取れていないのか、ディレクトリを作れないのか、`rename` が無いのか。
 * どれも「たぶんこれだろう」で書き換えられる話ではない。**原稿を守る
 * 仕組みの土台**（`atomicWrite.ts`）に関わるからである。
 *
 * だから**測る**。作者に1回だけ試してもらえば、こちらは事実を得られる。
 *
 * **原稿には一切触れない。** 試すのは作品フォルダーの中に作った
 * 使い捨ての場所だけで、終わったら消す（消せなくても、消し方を伝える）。
 */

/** 試した1つの操作の結果 */
export interface ProbeResult {
  name: string;
  ok: boolean;
  detail?: string;
  /** これが駄目だと何が困るか */
  impact: string;
}

/** 試す場所の名前。作品フォルダーの中に作って、あとで消す */
const PROBE_DIR = ".novelai-probe";

export async function diagnoseWeb(
  workFolderPath: string | undefined
): Promise<void> {
  const lines: string[] = ["# ブラウザ版の動作診断", ""];

  lines.push("## 環境", "");
  lines.push(`- 実行環境: ${isWebRuntime() ? "ブラウザ（Nodeなし）" : "手元（Nodeあり）"}`);
  lines.push(`- VS Codeの見え方: ${describeUiKind()}`);

  const folders = vscode.workspace.workspaceFolders ?? [];
  lines.push(`- 開いているフォルダー: ${folders.length}件`);
  for (const folder of folders) {
    lines.push(`  - \`${fromUri(folder.uri)}\``);
  }
  if (folders.length === 0) {
    lines.push(
      "",
      "**フォルダーが1つも開かれていません。** ブラウザ版では、ここから作品を選びます。",
      "vscode.dev でGitHubのリポジトリを開いてから、もう一度お試しください。"
    );
  }

  // 試す場所を決める。作品が登録されていればその中、無ければ開いているフォルダー
  const base = workFolderPath ?? (folders[0] ? fromUri(folders[0].uri) : undefined);
  if (!base) {
    lines.push("", "試せる場所がないため、ここまでです。");
    await show(lines.join("\n"));
    return;
  }

  lines.push("", `## ファイル操作（\`${base}\` の中で試します）`, "");
  const scheme = path.toUri(base).scheme;
  const writable = vscode.workspace.fs.isWritableFileSystem(scheme);
  lines.push(
    `- 仕組み（scheme）: \`${scheme}\``,
    `- VS Codeの申告する書き込み可否: ${describeWritable(writable)}`,
    ""
  );

  const results = await probeAll(base);
  lines.push("| 操作 | 結果 | これが駄目だと |", "|---|---|---|");
  for (const r of results) {
    const mark = r.ok ? "○" : "×";
    const detail = r.detail ? `<br>${escapeCell(r.detail)}` : "";
    lines.push(`| ${r.name} | ${mark}${detail} | ${r.impact} |`);
  }

  const failed = results.filter((r) => !r.ok);
  lines.push("", "## まとめ", "");
  if (failed.length === 0) {
    lines.push("**すべて通りました。** ファイル操作は原因ではありません。");
  } else {
    lines.push(`**${failed.length}件が通りませんでした。**`, "");
    for (const r of failed) {
      lines.push(`- **${r.name}** … ${r.impact}`);
    }
  }
  lines.push(
    "",
    "この内容をそのまま開発側へ伝えてください。どこを直せばよいかが決まります。"
  );

  await show(lines.join("\n"));
}

/**
 * 順に試す。
 *
 * **前の操作が失敗したら、その先は試さない**（試せないので）。
 * ただし「試していない」ことが分かるように結果へ残す。
 */
async function probeAll(base: string): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  const dir = path.join(base, PROBE_DIR);
  const file = path.join(dir, "probe.txt");
  const renamed = path.join(dir, "probe-renamed.txt");
  const body = new TextEncoder().encode("novelai probe\n");

  const madeDir = await probe(
    results,
    "フォルダーを作る（createDirectory）",
    "作品の設定（.aiwriter）を置けません。作品を登録できません",
    () => vscode.workspace.fs.createDirectory(path.toUri(dir))
  );
  if (!madeDir) return results;

  const wrote = await probe(
    results,
    "ファイルを書く（writeFile）",
    "何も保存できません",
    () => vscode.workspace.fs.writeFile(path.toUri(file), body)
  );
  if (!wrote) {
    await cleanup(dir);
    return results;
  }

  await probe(
    results,
    "ファイルの情報を見る（stat）",
    "ファイルの有無を確かめられません。上書きを防げなくなります",
    () => vscode.workspace.fs.stat(path.toUri(file))
  );

  await probe(
    results,
    "ファイルを読む（readFile）",
    "本文を読めません",
    async () => {
      const read = await vscode.workspace.fs.readFile(path.toUri(file));
      if (new TextDecoder().decode(read) !== "novelai probe\n") {
        throw new Error("書いた内容と読んだ内容が違います");
      }
    }
  );

  await probe(
    results,
    "フォルダーの中を見る（readDirectory）",
    "作品や話数を見つけられません",
    () => vscode.workspace.fs.readDirectory(path.toUri(dir))
  );

  // **ここがいちばん知りたい。** 原稿の保存は一時ファイルを作って
  // 差し替える形（atomicWrite）で、その差し替えに rename を使っている
  const canRename = await probe(
    results,
    "ファイルを移す（rename）",
    "**原稿の保存が丸ごと通りません**（設定資料・本文・キャッシュのすべて）",
    () =>
      vscode.workspace.fs.rename(path.toUri(file), path.toUri(renamed), {
        overwrite: false,
      })
  );

  await probe(
    results,
    "ファイルを消す（delete）",
    "退避や後片付けができません",
    () => vscode.workspace.fs.delete(path.toUri(canRename ? renamed : file))
  );

  await cleanup(dir);
  return results;
}

/** 1つ試して、結果を積む。成功したかを返す */
async function probe(
  results: ProbeResult[],
  name: string,
  impact: string,
  run: () => Thenable<unknown> | Promise<unknown>
): Promise<boolean> {
  try {
    await run();
    results.push({ name, ok: true, impact });
    return true;
  } catch (error) {
    results.push({
      name,
      ok: false,
      detail: describeError(error),
      impact,
    });
    return false;
  }
}

async function cleanup(dir: string): Promise<void> {
  try {
    await vscode.workspace.fs.delete(path.toUri(dir), { recursive: true });
  } catch {
    // 消せなくても診断の結果は出す。残ったものは作者が消せる場所にある
  }
}

function describeError(error: unknown): string {
  if (error instanceof vscode.FileSystemError) {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function describeWritable(value: boolean | undefined): string {
  if (value === undefined) return "分からない（VS Codeが答えていません）";
  return value ? "書ける" : "**書けない**";
}

function describeUiKind(): string {
  // 「ブラウザで見ている」と「Nodeが無い」は別物。
  // Codespaces は前者だけ当てはまる（Nodeはある）
  return vscode.env.uiKind === vscode.UIKind.Web
    ? "ブラウザ"
    : "デスクトップアプリ";
}

/** 表の中で改行や縦棒が崩れないようにする */
function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

async function show(markdown: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument({
    content: markdown,
    language: "markdown",
  });
  await vscode.window.showTextDocument(document);
}
