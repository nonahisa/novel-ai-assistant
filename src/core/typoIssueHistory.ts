import * as vscode from "vscode";
import * as path from "path";
import * as crypto from "crypto";
import type { WorkEntry } from "../models/types";
import { workPaths } from "./workRegistry";
import { atomicWriteFile } from "./atomicWrite";
import { formatLogTime } from "./logger";
import type { AcceptedTypoIssue } from "./typoCheckValidation";

/**
 * 提案（誤字脱字など）の「無視」履歴と、承認・却下の操作ログ。
 *
 * 設計書6.11「承認済み・却下済みの履歴は `.aiwriter/logs/ai_actions.log` に
 * 保存し、あとから見返せるようにする」に対応する。
 *
 * 無視した指摘は、次回の検知結果からも除く。除かないと、無視を押しても
 * 毎回また出てきて承認作業が終わらない。
 */

const DISMISSED_FILE = "typo_dismissed.json";
/** 覚えておく件数。増やしすぎても意味が薄く、ファイルが際限なく育つのを防ぐ */
const MAX_DISMISSED = 500;

/** 無視した指摘を識別するキー */
export function dismissKey(
  /**
   * どのファイルの指摘か。
   *
   * **以前はチャンクのハッシュだった。** チャンクは分け方で変わるので、
   * まとめ方を変えたり本文をどこか1文字直したりするだけで鍵が変わり、
   * **無視したはずの指摘がまた出てくる**（設計書6.8.10）。
   * ファイルを基準にすれば、まとめ方に左右されない。
   */
  filePath: string,
  issue: Pick<AcceptedTypoIssue, "line" | "target" | "suggestion">
): string {
  // 絶対パスと相対パスが混ざるので、ファイル名だけで揃える。
  // 同じ作品の中で名前が重なることはない
  const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
  return crypto
    .createHash("sha1")
    .update(`${fileName}|${issue.line}|${issue.target}|${issue.suggestion}`)
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

/** 適用済みの「target→suggestion」の組を識別するキー */
export function appliedFixKey(
  file: string,
  target: string,
  suggestion: string
): string {
  return `${file}|${target}|${suggestion}`;
}

/**
 * `.aiwriter/logs/ai_actions.log` から、これまでに適用された
 * 「target→suggestion」の組を読み込む。
 *
 * 用途：AIが一度「AをBに直す」を適用させた直後、次の検知で
 * 「BをAに戻す」を指摘してくる往復ループを防ぐ。実際に
 * 「良い」→「よい」を適用した直後、次の検知で「よい」→「良い」が
 * 指摘される事故が起きた（表記ゆれは優劣が無く、プロンプトで
 * 除外を指示していても小さいモデルは無視することがあるため、
 * ここでもコード側で二重に弾く）。
 *
 * ログが読めない・壊れている場合は空として扱う（検知そのものは動かす）。
 */
export async function loadAppliedFixKeys(
  work: WorkEntry
): Promise<Set<string>> {
  const target = path.join(workPaths(work).aiwriter, "logs", "ai_actions.log");
  const keys = new Set<string>();
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(target));
    const text = new TextDecoder().decode(bytes);
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry: unknown = JSON.parse(line);
        if (
          isRecord(entry) &&
          entry.category === "typo" &&
          entry.action === "applied" &&
          typeof entry.file === "string" &&
          typeof entry.target === "string" &&
          typeof entry.suggestion === "string"
        ) {
          keys.add(appliedFixKey(entry.file, entry.target, entry.suggestion));
        }
      } catch {
        // 壊れた行は無視して次の行へ
      }
    }
  } catch {
    // ログが無い（初回実行など）場合も空集合のまま返す
  }
  return keys;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface AiActionLogEntry {
  /** 指摘の種類。推敲・逸脱検知を足すときも、ここへ名前を増やす */
  category: "typo" | "contradiction";
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
