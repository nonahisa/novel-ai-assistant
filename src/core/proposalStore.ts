import * as vscode from "vscode";
import * as path from "./paths";
import type { WorkEntry } from "../models/types";
import { workPaths } from "./workRegistry";
import {
  resolveProposals,
  type Proposal,
  type ProposalDecision,
  type ProposalLine,
  type ProposalView,
} from "../models/proposal";

/**
 * 編集部からの提案の置き場（設計書5.6）。
 *
 * `.aiwriter/proposals/proposals.jsonl`。**同期される**
 * （`.gitignore` で外れているのは `cache/` と `logs/` だけ）。
 *
 * **1行1件の追記だけ。** 編集履歴と同じ理由である。
 *
 * - 追記どうしなら git がそのまま繋げられることが多い
 * - 競合しても、両方の行を残せば正しい状態になる
 *
 * **提案そのものを書き換えない。** 承認も却下も、それを指す行を足す。
 * 書き換える作りにすると、編集部と作者が同時に触ったときに
 * **どちらかの記録が消える。**
 */

const PROPOSAL_DIRECTORY = "proposals";
const PROPOSAL_FILE = "proposals.jsonl";

export class ProposalStore {
  constructor(private readonly work: WorkEntry) {}

  private get filePath(): string {
    return path.join(
      workPaths(this.work).aiwriter,
      PROPOSAL_DIRECTORY,
      PROPOSAL_FILE
    );
  }

  /** 提案を足す。既に同じ番号があっても足す（読むときに1つへ畳む） */
  async propose(proposals: Proposal[]): Promise<void> {
    await this.appendLines(
      proposals.map((proposal) => ({ kind: "proposal" as const, ...proposal }))
    );
  }

  /** 承認・却下を足す。**提案そのものは書き換えない** */
  async decide(decisions: ProposalDecision[]): Promise<void> {
    await this.appendLines(
      decisions.map((decision) => ({ kind: "decision" as const, ...decision }))
    );
  }

  /** いまの状態。未決が先に並ぶ */
  async load(): Promise<ProposalView[]> {
    try {
      const bytes = await vscode.workspace.fs.readFile(
        path.toUri(this.filePath)
      );
      return resolveProposals(parseProposalLines(new TextDecoder().decode(bytes)));
    } catch {
      return [];
    }
  }

  /** 未決の件数。通知や印に使う */
  async pendingCount(): Promise<number> {
    return (await this.load()).filter((entry) => entry.status === "pending")
      .length;
  }

  private async appendLines(lines: ProposalLine[]): Promise<void> {
    if (lines.length === 0) return;
    const target = this.filePath;
    const text = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
    await vscode.workspace.fs.createDirectory(
      path.toUri(path.dirname(target))
    );
    const uri = path.toUri(target);
    let existing: Uint8Array;
    try {
      existing = await vscode.workspace.fs.readFile(uri);
    } catch {
      existing = new Uint8Array();
    }
    const added = new TextEncoder().encode(text);
    const merged = new Uint8Array(existing.byteLength + added.byteLength);
    merged.set(existing, 0);
    merged.set(added, existing.byteLength);
    await vscode.workspace.fs.writeFile(uri, merged);
  }
}

/**
 * 1行1件を読む。
 *
 * **読めない行は捨てて、読める行は残す。** 競合で1行が壊れたときに、
 * 無事な提案まで見えなくしない。競合マーカーの行も落とす。
 */
export function parseProposalLines(text: string): ProposalLine[] {
  const lines: ProposalLine[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^(<<<<<<<|=======|>>>>>>>)/.test(line)) continue;
    try {
      const parsed = toLine(JSON.parse(line));
      if (parsed) lines.push(parsed);
    } catch {
      // 壊れた行は捨てる
    }
  }
  return lines;
}

function toLine(value: unknown): ProposalLine | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;

  if (record.kind === "proposal") {
    const id = str(record.id);
    const file = str(record.file);
    const target = str(record.target);
    // **どこを直すのか分からない提案は、作者が判断できない**
    if (!id || !file || !target) return undefined;
    return {
      kind: "proposal",
      id,
      time: str(record.time),
      proposer: str(record.proposer),
      file,
      line: typeof record.line === "number" ? record.line : 0,
      original: str(record.original),
      target,
      suggestion: str(record.suggestion),
      reason: str(record.reason),
      category: str(record.category),
    };
  }

  if (record.kind === "decision") {
    const proposalId = str(record.proposalId);
    const status = record.status;
    if (!proposalId || (status !== "accepted" && status !== "rejected")) {
      return undefined;
    }
    return {
      kind: "decision",
      proposalId,
      time: str(record.time),
      decidedBy: str(record.decidedBy),
      status,
      note: str(record.note),
    };
  }
  return undefined;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
