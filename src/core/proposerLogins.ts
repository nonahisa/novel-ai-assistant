import * as vscode from "vscode";
import * as path from "./paths";
import type { WorkEntry } from "../models/types";
import { runSerialized } from "./ledgerQueue";
import { workPaths } from "./workRegistry";
import { stringOrEmpty } from "./stringOrEmpty";

/**
 * 編集者の提案ごとの、出した編集者の GitHub のユーザー名の覚え（設計書5.7.5.9。0.138.0）。
 *
 * 台帳（`proposals.jsonl`）の `proposer` は編集者のパソコンの git の名前（例「Kota Mizushima」）で、
 * GitHub のユーザー名（例「kmizu」）ではない。画面には GitHub のユーザー名だけを出す
 * （作者の答え 2026-11-07）。名前は作者の作品の `.aiwriter/editing.json` の `editorLogin` にしか無く、
 * 解除のときに消える。そこで、提案を取り込んだ時点の名前を、提案の番号ごとにここへ書き写す。
 *
 * **台帳の行に名前を書き足さない。** 提案の台帳は作者と編集用の写しの両方向で混ぜており
 * （`mergeProposalJsonl` は行の中身全部で同じ行かを見る）、名前を足した行は元の行と別物に見え、
 * 写しへ戻って二重に積み上がる。そのため別のファイルにし、`LEDGER_FILES` にも入れない
 * （作者の作品にだけ置き、編集用へは写らない）。
 *
 * 置き場は `.aiwriter/proposals/editor-logins.jsonl`。**同期される**（作者の別の機械でも読める）。
 * 1行1件の追記だけ。同じ番号が2回あれば、先の行を使う（取り込んだ時点の名前を変えない）。
 */

const DIRECTORY = "proposals";
const FILE = "editor-logins.jsonl";

export interface ProposerLoginLine {
  proposalId: string;
  editorLogin: string;
  /** 覚えた時刻（ISO 8601） */
  time: string;
}

export class ProposerLoginStore {
  constructor(private readonly work: WorkEntry) {}

  private get filePath(): string {
    return path.join(workPaths(this.work).aiwriter, DIRECTORY, FILE);
  }

  /** 提案の番号 → GitHub のユーザー名 */
  async load(): Promise<Map<string, string>> {
    try {
      const bytes = await vscode.workspace.fs.readFile(path.toUri(this.filePath));
      return loginsByProposal(parseProposerLoginLines(new TextDecoder().decode(bytes)));
    } catch {
      return new Map();
    }
  }

  /**
   * 名前を覚える。**まだ覚えていない番号だけ**を足す（足した数を返す）。
   * 名前が分からないとき（空）は何もしない——推し量った名前を残さない。
   */
  async remember(proposalIds: readonly string[], editorLogin: string | undefined): Promise<number> {
    if (!editorLogin || proposalIds.length === 0) return 0;
    const target = this.filePath;
    return runSerialized(target, async () => {
      const uri = path.toUri(target);
      let existing: Uint8Array = new Uint8Array();
      try {
        existing = await vscode.workspace.fs.readFile(uri);
      } catch {
        // まだ無い
      }
      const existingText = new TextDecoder().decode(existing);
      const known = loginsByProposal(parseProposerLoginLines(existingText));
      const time = new Date().toISOString();
      const lines = [...new Set(proposalIds)]
        .filter((id) => id !== "" && !known.has(id))
        .map((proposalId) => JSON.stringify({ proposalId, editorLogin, time }));
      if (lines.length === 0) return 0;
      const lead = existingText.length > 0 && !existingText.endsWith("\n") ? "\n" : "";
      const added = new TextEncoder().encode(lead + lines.join("\n") + "\n");
      const merged = new Uint8Array(existing.byteLength + added.byteLength);
      merged.set(existing, 0);
      merged.set(added, existing.byteLength);
      await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(target)));
      await vscode.workspace.fs.writeFile(uri, merged);
      return lines.length;
    });
  }
}

/** 1行1件を読む。読めない行と競合マーカーの行は捨てる（無事な行は残す） */
export function parseProposerLoginLines(text: string): ProposerLoginLine[] {
  const lines: ProposerLoginLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^(<<<<<<<|\|\|\|\|\|\|\||=======|>>>>>>>)/.test(line)) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) continue;
      const record = parsed as Record<string, unknown>;
      const proposalId = stringOrEmpty(record.proposalId);
      const editorLogin = stringOrEmpty(record.editorLogin);
      if (!proposalId || !editorLogin) continue;
      lines.push({ proposalId, editorLogin, time: stringOrEmpty(record.time) });
    } catch {
      // 壊れた行は捨てる
    }
  }
  return lines;
}

function loginsByProposal(lines: readonly ProposerLoginLine[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of lines) {
    if (!map.has(line.proposalId)) map.set(line.proposalId, line.editorLogin);
  }
  return map;
}
