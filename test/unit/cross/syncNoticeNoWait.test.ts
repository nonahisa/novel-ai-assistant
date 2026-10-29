import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 同期の旗の中で、ボタン付きのモーダルでない知らせの答えを待たない（0.103.5）。
 *
 * 自動の送り直し（`features/autoResend.ts` の `busyReason`）は、
 * 取り込み・送信の旗（`isOperating`）と、同期のコマンドの札
 * （`SYNC_BUSY_COMMANDS` の配下）を見て控える。ボタン付きの知らせは、
 * 作者が押すか閉じるまで答えが来ない（ベルへ畳んだだけでは来ない）ので、
 * その答えを旗の中で待つと、回線が戻っても送り直しが見送り続ける。
 * 0.103.2（開いたときの点検）と 0.103.5（未記録の問い）で同じ形を2度直した。
 *
 * **ソースを読んで止める。** 知らせを出す箇所は増えるので、1件ずつの
 * テストでは次に足された所を見張れない。待ってよいのはモーダル
 * （答えるまで画面が止まる＝作者が必ずその場で答える）と、
 * ボタンの無い知らせだけ。ボタンの答えは `whenNoticePicked` で受ける。
 */

const ROOT = path.resolve(__dirname, "../../..");

/** 同期の旗の中で走るファイル（同期のコマンドの本体と、取り込み・送信の見張り） */
const SYNC_FILES = [
  "src/features/gitSync.ts",
  "src/features/gitRestore.ts",
  "src/features/resolveConflicts.ts",
  "src/features/resolveDivergence.ts",
  "src/features/syncAllWorks.ts",
  "src/features/handoffSync.ts",
  // 編集部連携も同じ札（`SYNC_BUSY_COMMANDS`・`EXCLUSIVE_COMMANDS`）を持つ。
  // 「編集部へ渡す」の終わりの知らせを待ったまま、通知センターへ沈むと
  // 「いま動いています」が出続けた（作者の実機、2026-10-30）
  "src/features/shareWithEditor.ts",
  "src/features/joinAsEditor.ts",
  "src/features/finishReview.ts",
  "src/features/revokeEditorAccess.ts",
  "src/features/editingAutomation.ts",
];

/**
 * 旗の外で待っていると分かっている所。**足すときは理由を書く。**
 *
 * いまは無い。0.103.9 まで許していた「未取得です」の知らせ（`notifyIfBehind`）は、
 * 送り直しの旗には入らないが数え直しの印（`refreshing`）の中で待っており、
 * 押さずに置くとその作品の数え直しが止まったので、`whenNoticePicked` へ直した。
 */
const ALLOWED = new Set<string>();

/** `await vscode.window.showXxxMessage(` から閉じ括弧までを切り出す */
function awaitedNotices(source: string): string[] {
  const calls: string[] = [];
  const re = /await vscode\.window\.show(?:Warning|Error|Information)Message\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    let depth = 1;
    let index = match.index + match[0].length;
    while (depth > 0 && index < source.length) {
      const char = source[index];
      if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
      index += 1;
    }
    calls.push(source.slice(match.index, index));
  }
  return calls;
}

/** 呼び出しの引数の数を、いちばん外の `,` で数える（ボタンが有るか） */
function topLevelArgs(call: string): number {
  const inner = call.slice(call.indexOf("(") + 1, -1);
  let depth = 0;
  let quote: string | undefined;
  let count = inner.trim() ? 1 : 0;
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i];
    if (quote) {
      if (char === "\\") i += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if ("([{".includes(char)) depth += 1;
    else if (")]}".includes(char)) depth -= 1;
    else if (char === "," && depth === 0 && inner.slice(i + 1).trim()) count += 1;
  }
  return count;
}

describe("同期の旗の中で、ボタン付きの知らせの答えを待たない", () => {
  test("モーダルでなくボタンのある知らせを await していない", () => {
    const offenders: string[] = [];
    for (const file of SYNC_FILES) {
      const source = fs.readFileSync(path.join(ROOT, file), "utf8");
      for (const call of awaitedNotices(source)) {
        if (/modal:\s*true/.test(call)) continue;
        if (topLevelArgs(call) <= 1) continue;
        const allowed = [...ALLOWED].some(
          (key) => key.startsWith(`${file}:`) && call.includes(key.slice(file.length + 1))
        );
        if (allowed) continue;
        const line = source.slice(0, source.indexOf(call)).split("\n").length;
        offenders.push(`${file}:${line}`);
      }
    }
    expect(offenders, "whenNoticePicked で受けてください（views/notify.ts）").toEqual([]);
  });

  test("見張りの道具が呼び出しを拾えている（空振りで緑にならない）", () => {
    const source = fs.readFileSync(path.join(ROOT, "src/features/gitSync.ts"), "utf8");
    const calls = awaitedNotices(source);
    expect(calls.length).toBeGreaterThan(0);
    // モーダルの知らせ（改行の注意）は、ボタン2つの呼び出しとして数えられている
    const modal = calls.find((call) => call.includes("改行コードが変わる"));
    expect(modal && topLevelArgs(modal)).toBe(4);
    // ボタン付きの await を見つけられることを、作った呼び出しで確かめる
    const sample = awaitedNotices(
      'await vscode.window.showWarningMessage("未取得です", "取り込む", "このまま開く");'
    );
    expect(sample.map(topLevelArgs)).toEqual([3]);
  });
});
