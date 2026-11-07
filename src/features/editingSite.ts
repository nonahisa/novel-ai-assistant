import * as path from "../core/paths";
import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { workPaths } from "../core/workRegistry";
import { EDITING_SITE_FILE } from "../core/editingRepo";
import { logFailure, useLogFile } from "../core/logger";
import { ProposerLoginStore } from "../core/proposerLogins";

/**
 * 編集者の送り先と相手（**同期される**。`.aiwriter/editing.json`、cache の外）。
 *
 * 端末ごとに残す pointer（`folderPath` だけ）と分けた理由：別の機械で「渡す」を
 * 押すと、送り先を知らないために**2つ目のリポジトリを作って**いた。送り先の URL を
 * 同期される場所に置けば、2台目はそれを取り寄せて使える。
 *
 * **ブラウザ版の束からも読む**（採否の記録に編集者の名前を書き写すため。`reviewProposals.ts`）。
 * `shareWithEditor.ts` は git を使うので静的 import できず、読み書きだけをここへ分けた
 * （実装ルール7。`shareWithEditor.ts` からも同じものを出している）。
 */
export interface EditingSite {
  /** 編集用リポジトリの取り寄せ用URL（`https://github.com/owner/repo.git`） */
  remoteUrl?: string;
  /** 招待が通った編集者の GitHub 名 */
  editorLogin?: string;
  /**
   * 前の編集者の GitHub 名（0.138.0。作者の答え 2026-11-07）。解除で `editorLogin` を
   * 消すときに写す。次に「編集者へ渡す」で名前を訊くとき、初めの値に入れる（招待は送り直す）
   */
  formerEditorLogin?: string;
}

/** `EditingSite` の項目。書くときはこれだけを入れ替え、ほかの項目は残す */
const SITE_KEYS = ["remoteUrl", "editorLogin", "formerEditorLogin"] as const;

const SITE_RELATIVE = path.join(".aiwriter", EDITING_SITE_FILE);

function sitePath(work: WorkEntry): string {
  return path.join(workPaths(work).root, SITE_RELATIVE);
}

async function readTextIfAny(target: string): Promise<string> {
  try {
    const bytes = await vscode.workspace.fs.readFile(path.toUri(target));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

export async function readSite(work: WorkEntry): Promise<EditingSite> {
  const text = await readTextIfAny(sitePath(work));
  if (text.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return {};
    const record = parsed as Record<string, unknown>;
    const site: EditingSite = {};
    for (const key of SITE_KEYS) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) site[key] = value;
    }
    return site;
  } catch {
    return {};
  }
}

/** 生の中身を読む。無ければ `{}`、読めない・形が違えば `undefined`（直さない） */
async function readSiteRecord(work: WorkEntry): Promise<Record<string, unknown> | undefined> {
  const text = await readTextIfAny(sitePath(work));
  if (text.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return { ...(parsed as Record<string, unknown>) };
  } catch {
    return undefined;
  }
}

async function writeSiteRecord(work: WorkEntry, record: Record<string, unknown>): Promise<void> {
  const target = sitePath(work);
  await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(target)));
  await vscode.workspace.fs.writeFile(
    path.toUri(target),
    new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`)
  );
}

/**
 * 送り先と相手を書く。**`EditingSite` の3項目だけを入れ替え、ほかの項目は残す**（0.138.0）。
 *
 * 以前は渡した中身だけで書き直していたため、`readSite` が読まない項目（ほかの版が足した項目）が
 * 書くたびに落ちていた（実装ルール2）。`site` に無い3項目のうちの項目は消す（解除で名前を忘れる道）。
 *
 * **読めない JSON は直さない。** 書かずにログへ残す（送り先を覚え損ねても、次に「渡す」で訊き直せる。
 * 壊れたファイルを上書きして作者の書いたものを消すより害が小さい）。
 */
export async function writeSite(work: WorkEntry, site: EditingSite): Promise<void> {
  const record = await readSiteRecord(work);
  if (!record) {
    useLogFile(work.folderPath);
    logFailure("編集者の送り先の記録", {
      作品: work.title,
      詳細: "`.aiwriter/editing.json` が読めないため、書き直していません",
    });
    return;
  }
  for (const key of SITE_KEYS) {
    const value = site[key];
    if (value) record[key] = value;
    else delete record[key];
  }
  await writeSiteRecord(work, record);
}

/**
 * 解除で相手の名前を忘れる（設計書5.7.5.4）。**`editorLogin` を `formerEditorLogin` へ写してから消す。**
 * ほかの項目は、知らないものも含めて残す。読めない JSON は直さずに止める（実装ルール2）。
 *
 * 名前は前の編集者として残る（作者の答え 2026-11-07）。次に「編集者へ渡す」で名前を訊くとき、
 * 初めの値になる。
 */
export async function forgetEditorLogin(work: WorkEntry, login?: string): Promise<void> {
  const record = await readSiteRecord(work);
  if (!record) {
    throw new Error(
      "`.aiwriter/editing.json` が読めないため、編集者の名前の記録を外せませんでした（ファイルは直していません）。"
    );
  }
  const current = typeof record.editorLogin === "string" && record.editorLogin ? record.editorLogin : login;
  if (current) record.formerEditorLogin = current;
  if (!("editorLogin" in record) && !current) return;
  delete record.editorLogin;
  await writeSiteRecord(work, record);
}

/**
 * 編集用リポジトリを消したあと、送り先（`remoteUrl`）だけを `.aiwriter/editing.json` から外す
 * （設計書5.7.5.4）。**ほかの項目は、知らないものも含めて残す**。読めない JSON は直さずに止める（実装ルール2）。
 *
 * @returns 外したら `true`。初めから無ければ `false`
 */
export async function forgetRemoteUrl(work: WorkEntry): Promise<boolean> {
  const text = await readTextIfAny(sitePath(work));
  if (text.trim().length === 0) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      "`.aiwriter/editing.json` が読めないため、送り先の記録を外せませんでした（ファイルは直していません）。"
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      "`.aiwriter/editing.json` の形が違うため、送り先の記録を外せませんでした（ファイルは直していません）。"
    );
  }
  const record = { ...(parsed as Record<string, unknown>) };
  if (!("remoteUrl" in record)) return false;
  delete record.remoteUrl;
  await writeSiteRecord(work, record);
  return true;
}

/** いまの編集者の GitHub 名（覚えていなければ `undefined`）。採否の記録に書き写す */
export async function currentEditorLogin(work: WorkEntry): Promise<string | undefined> {
  return (await readSite(work)).editorLogin;
}

/**
 * 提案を出した編集者の GitHub 名（設計書5.7.5.9）。採否・戻すときの履歴の行に書き写す。
 *
 * 取り込んだ時点の覚え（`ProposerLoginStore`）が先。覚えが無い提案（0.138.0 より前に
 * 取り込んだもの）は、決めた時点の `editorLogin` を使う（作者の答え 2026-11-07「採否を決めたとき、
 * その時点の editorLogin を書き写す」）。どちらも無ければ `undefined`（名前なしで書く）。
 */
export async function editorLoginForProposal(
  work: WorkEntry,
  proposalId: string
): Promise<string | undefined> {
  const remembered = (await new ProposerLoginStore(work).load()).get(proposalId);
  return remembered ?? (await currentEditorLogin(work));
}
