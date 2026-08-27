import * as vscode from "vscode";
import * as paths from "../core/paths";
import { PENDING_CHECKS, type PendingCheckSection } from "../views/pendingChecks";
import type { OperationCount } from "./operationLog";

/**
 * 操作ログを、実機確認リストへ**たまに**書き戻す（作者の依頼、2026-08-27）。
 *
 * **配布物には入らない**（`__DEV_HELPERS__` の枝の中でしか読み込まれない）。
 *
 * ## 書き足すのは1行だけ
 *
 * 節の見出しの直後へ
 *
 *     ＊操作ログ：最終実行 2026-08-27 14:05（計12回）
 *
 * を挿す。すでにあれば**置き換える**（走らせるたびに増えない）。
 *
 * ## 合否の印には触らない
 *
 * `- [ ]` / `- [x]` の行、`<!-- 対象: … -->` の行、その他の文章は**一切変えない。**
 * 押したことと通ったことは別で、ここが自動で進むと**確かめていないものが
 * 済んだことになる**（`checkRunner.ts` の「判断は作者がする」と同じ理由）。
 * この1行が答えるのは「その節を、いつ・何回動かしたか」までである。
 *
 * ## 生成器に誤読されない形にする
 *
 * `scripts/pendingChecksLib.mjs` は確認リストから見出し（`##`/`###`）・
 * 対象（`<!-- 対象: … -->`）・未確認の項目（`- [ ]`）だけを拾う。
 * `＊` で始まるこの行はどれにも当たらないので、`npm run checks:menu` の
 * 生成物は変わらない（実際に1行入れて走らせ、差分が出ないことを確かめてある）。
 *
 * ## 確認リストの読み書きは、ここに集める
 *
 * 見出しを探す関数は元は `checkRunner.ts` にあったが、両方が要るようになった。
 * `checkRunner.ts` へ置いたままここから読むと相互参照になるので、
 * **文書側の知識（置き場・見出しの探し方）をこちらへ寄せて**、
 * `checkRunner.ts` から読むようにした。
 */

/** 確認リストの場所。**拡張機能のフォルダーから引く**（開いている作品とは無関係） */
export const CHECKLIST = "docs/実機確認リスト.md";

/** 書き足す行の印。これで始まる行だけが、この道具の持ち物 */
const MARKER = "＊操作ログ：";

export function registerReflectOperationLog(
  context: vscode.ExtensionContext
): vscode.Disposable {
  return vscode.commands.registerCommand(
    "novelai.reflectOperationLog",
    async () => {
      await reflectOperationLog(context);
    }
  );
}

async function reflectOperationLog(
  context: vscode.ExtensionContext
): Promise<void> {
  // 記録は node:fs で書いている。ブラウザの開発ビルドには fs が無く、
  // 読み込みそのものが失敗しうるので、理由を出して止める
  let summary: ReadonlyMap<string, OperationCount>;
  try {
    const { readOperationSummary } = await import("./operationLog.js");
    summary = readOperationSummary();
  } catch {
    void vscode.window.showWarningMessage(
      "この環境では操作ログを読めません（手元のVS Codeでお試しください）。"
    );
    return;
  }

  if (summary.size === 0) {
    void vscode.window.showInformationMessage(
      "操作ログがまだありません。F5の開発ホストで操作すると記録されます。"
    );
    return;
  }

  const uri = checklistUri(context);
  const original = new TextDecoder().decode(
    await vscode.workspace.fs.readFile(uri)
  );
  const { text, updatedSections } = reflectIntoChecklist(
    original,
    PENDING_CHECKS,
    summary
  );

  if (updatedSections.length === 0) {
    void vscode.window.showInformationMessage(
      "記録のある節が、確認リストに見つかりませんでした。"
    );
    return;
  }
  // **中身が同じなら書かない。** 書き戻すと更新日時だけが動き、
  // Gitの差分にも出ないのに「何か変えた」ように見える
  if (text === original) {
    void vscode.window.showInformationMessage(
      `${updatedSections.length}節は、すでに最新の記録が書かれています。`
    );
    return;
  }

  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
  void vscode.window.showInformationMessage(
    `${updatedSections.length}節に反映しました。合否の印（[x]）には触れていません。`
  );
}

/**
 * 記録を確認リストへ写した文面を作る（副作用なし）。
 *
 * 返す `updatedSections` は、記録のあった節の番号（無ければ名前）。
 * **同じ入力で2回通しても同じ結果になる**（印の行を置き換えるため）。
 */
export function reflectIntoChecklist(
  markdown: string,
  sections: readonly PendingCheckSection[],
  summary: ReadonlyMap<string, OperationCount>
): { text: string; updatedSections: string[] } {
  const lines = markdown.split("\n");
  const updatedSections: string[] = [];

  for (const section of sections) {
    const totals = totalsOf(section, summary);
    // 一度も動かしていない節には、何も書かない（無音の行を増やさない）
    if (!totals) continue;

    // **行を挿すたびに番号がずれる。** 節ごとに、そのときの中身から探し直す
    const at = findHeadingLine(lines, section);
    if (at === undefined) continue;

    // 行末は周りに合わせる（CRLFの文書へLFの行だけを混ぜない）
    const eol = lines[at].endsWith("\r") ? "\r" : "";
    const marker = `${MARKER}最終実行 ${formatWhen(totals.lastTs)}（計${totals.count}回）${eol}`;

    const existing = findMarkerLine(lines, at);
    if (existing === undefined) {
      lines.splice(at + 1, 0, marker);
    } else {
      lines[existing] = marker;
    }
    updatedSections.push(section.id || section.title);
  }

  return { text: lines.join("\n"), updatedSections };
}

/** その節の操作を合わせた実行回数と、最後に動かした時刻。0回なら undefined */
function totalsOf(
  section: PendingCheckSection,
  summary: ReadonlyMap<string, OperationCount>
): { count: number; lastTs: string } | undefined {
  let count = 0;
  let lastTs = "";
  for (const command of section.commands) {
    const found = summary.get(command);
    if (!found) continue;
    count += found.count;
    if (found.lastTs > lastTs) lastTs = found.lastTs;
  }
  return count > 0 ? { count, lastTs } : undefined;
}

/**
 * その節にすでにある印の行。無ければ undefined。
 *
 * **節の中を最後まで見る**（見出しの真下とは限らない。手で動かされていても拾う）。
 * 見つけたら置き換えるので、走らせるたびに増えることがない。
 */
function findMarkerLine(
  lines: readonly string[],
  headingAt: number
): number | undefined {
  for (let i = headingAt + 1; i < lines.length; i++) {
    // 次の見出しに当たったら、その節は終わり
    if (/^#{2,3}\s/.test(lines[i])) return undefined;
    if (lines[i].trimStart().startsWith(MARKER)) return i;
  }
  return undefined;
}

/**
 * 時刻の見た目。**手元の時刻で書く**（記録はISO8601のUTC）。
 *
 * 作者が「あのとき触ったな」と照らせることが目的なので、
 * 見るのは画面の前にいる人の時計に合っていないと意味がない。
 */
function formatWhen(iso: string): string {
  const at = new Date(iso);
  // 壊れた時刻でも行は書く。読めない値をそのまま出したほうが、原因に辿り着ける
  if (Number.isNaN(at.getTime())) return iso;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}`
  );
}

/** その節の見出しの行。無ければ undefined */
export function findHeading(
  markdown: string,
  section: PendingCheckSection
): number | undefined {
  return findHeadingLine(markdown.split("\n"), section);
}

function findHeadingLine(
  lines: readonly string[],
  section: PendingCheckSection
): number | undefined {
  const at = lines.findIndex((line) => {
    if (!/^#{2,3}\s/.test(line)) return false;
    const text = line.replace(/^#{2,3}\s+/, "");
    return section.id
      ? text.startsWith(`${section.id}.`)
      : text.startsWith(section.title);
  });
  return at === -1 ? undefined : at;
}

export function checklistUri(context: vscode.ExtensionContext): vscode.Uri {
  return paths.toUri(paths.join(context.extensionPath, CHECKLIST));
}
