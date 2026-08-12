import * as vscode from "vscode";
import * as path from "path";
import * as crypto from "crypto";
import type { WorkEntry } from "../models/types";
import { workPaths } from "./workRegistry";
import { atomicWriteFile } from "./atomicWrite";
import { formatLogTime } from "./logger";
import type { AcceptedTypoIssue } from "./typoCheckValidation";

/**
 * AI指摘（誤字脱字など）の「無視」履歴と、承認・却下の操作ログ。
 *
 * 設計書6.11「承認済み・却下済みの履歴は `.aiwriter/logs/ai_actions.log` に
 * 保存し、あとから見返せるようにする」に対応する。
 *
 * 無視した指摘は、チャンクが変わらない限り次回の検知結果からも除く。
 * 除かないと、無視を押しても毎回また出てきて承認作業が終わらない。
 */

const DISMISSED_FILE = "typo_dismissed.json";
/** 覚えておく件数。増やしすぎても意味が薄く、ファイルが際限なく育つのを防ぐ */
const MAX_DISMISSED = 500;

/** 無視した指摘を識別するキー。チャンクが変われば別キーになり、自然に古い記録は使われなくなる */
export function dismissKey(
  chunkHash: string,
  issue: Pick<AcceptedTypoIssue, "line" | "target" | "suggestion">
): string {
  return crypto
    .createHash("sha1")
    .update(`${chunkHash}|${issue.line}|${issue.target}|${issue.suggestion}`)
    .digest("hex")
    .slice(0, 24);
}

export class TypoDismissedHistory {
  constructor(private readonly work: WorkEntry) {}

  private filePath(): string {
    return path.join(workPaths(this.work).aiwriter, "cache", DISMISSED_FILE);
  }

  /** 読めなければ空として扱う。履歴が無くても機能は成り立つ */
  async load(): Promise<Set<string>> {
    try {
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.file(this.filePath())
      );
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!Array.isArray(parsed)) return new Set();
      return new Set(
        parsed.filter((item): item is string => typeof item === "string")
      );
    } catch {
      return new Set();
    }
  }

  /** 無視した指摘のキーを足す。保存に失敗しても機能を止めない */
  async add(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const existing = await this.load();
    const merged = [...new Set([...existing, ...keys])].slice(-MAX_DISMISSED);

    const target = this.filePath();
    try {
      await vscode.workspace.fs.createDirectory(
        vscode.Uri.file(path.dirname(target))
      );
      await atomicWriteFile(
        target,
        new TextEncoder().encode(`${JSON.stringify(merged, null, 2)}\n`)
      );
    } catch {
      // 履歴が残らないだけで、次回の検知は動く（無視した指摘が再度出るだけ）
    }
  }
}

export interface AiActionLogEntry {
  /** 指摘の種類。誤字脱字検知しか無い段階だが、将来の推敲・矛盾検知でも使う */
  category: "typo";
  action: "applied" | "dismissed";
  file: string;
  line: number;
  target: string;
  suggestion: string;
}

/**
 * 承認・却下の履歴を `.aiwriter/logs/ai_actions.log` にJSONL形式で追記する。
 *
 * 診断ログ（`core/logger.ts` の `actions.log`）とは別のファイル。
 * こちらは「作者が何を承認・却下したか」という作業記録であり、
 * AI呼び出しの成否を追う診断目的のログとは性質が違うため分けている。
 */
export async function appendAiActionLog(
  work: WorkEntry,
  entry: AiActionLogEntry
): Promise<void> {
  const target = path.join(
    workPaths(work).aiwriter,
    "logs",
    "ai_actions.log"
  );
  const line = JSON.stringify({ timestamp: formatLogTime(), ...entry });

  try {
    const uri = vscode.Uri.file(target);
    await vscode.workspace.fs.createDirectory(
      vscode.Uri.file(path.dirname(target))
    );
    let existing: Uint8Array;
    try {
      existing = await vscode.workspace.fs.readFile(uri);
    } catch {
      existing = new Uint8Array();
    }
    const addition = new TextEncoder().encode(`${line}\n`);
    const merged = new Uint8Array(existing.byteLength + addition.byteLength);
    merged.set(existing, 0);
    merged.set(addition, existing.byteLength);
    await vscode.workspace.fs.writeFile(uri, merged);
  } catch {
    // 記録できなくても、適用・無視そのものは既に完了しているので通知は不要
  }
}
