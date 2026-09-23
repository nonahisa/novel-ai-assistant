import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import { workPaths } from "../core/workRegistry";
import {
  expiredFindingIds,
  isFindingExpired,
  parseFindingLines,
  resolveFindings,
  type Finding,
  type FindingDecision,
  type FindingLine,
  type FindingView,
} from "../models/finding";

/**
 * AIの指摘の置き場（設計書6.96.4）。
 *
 * **`.aiwriter/findings.jsonl`。1行1件、追記のみ、同期する。**
 *
 * `proposals.jsonl`（編集部の提案、5.6.1.1）と同じ形にした理由は3つある。
 *
 * 1. **同期される。** デスクトップで検知して、ノートPCで直せる
 * 2. **片方で退けたものが、もう片方でも退く**（判断を追記する形なので、
 *    これは自然に成立する）
 * 3. **追記のみなので、同期の衝突が起きにくい**（同じ行を両方が
 *    書き換えることがない）
 *
 * **`.aiwriter/cache/` へは置かない**——あそこは `.gitignore` で外れて
 * いるので、同期されない。
 *
 * ## `core` ではなく `features` に置いている理由
 *
 * ファイルの読み書きに `vscode.workspace.fs` が要るためである。位置の
 * 探し直し（`core/findingLocation.ts`）と、1件の形と期限の判定
 * （`models/finding.ts`）は `vscode` に触らない側へ置いてあるので、
 * 検算だけを取り出して試せる。
 */

const FINDINGS_FILE = "findings.jsonl";

/**
 * 期限の設定を読む。**読んでよいのはこのファイルだけ**（設計書6.58）。
 *
 * 先例は `novelai.logs.retentionDays`（`features/pruneLogs.ts`）。
 * 写しが方々に増えると、同じ設定が機能によって効いたり効かなかったり
 * するので、決め方は1か所へ寄せる。見張りは
 * `test/unit/features/findingRetention.test.ts` が持つ。
 *
 * **既定は3日**（作者の指示）。`0` で無期限。
 */
export function findingsRetentionDays(): number {
  return vscode.workspace
    .getConfiguration("novelai")
    .get<number>("findings.retentionDays", 3);
}

export class FindingStore {
  constructor(private readonly work: WorkEntry) {}

  private get filePath(): string {
    return path.join(workPaths(this.work).aiwriter, FINDINGS_FILE);
  }

  /**
   * 指摘を足す。
   *
   * **同じ番号が既にあっても足す。** 読むときに1件へ畳む
   * （`resolveFindings`）ので、書く側は前の行を探さなくてよい
   * ——探して書き換える作りにすると、そこが同期の衝突点になる。
   */
  async record(findings: readonly Finding[]): Promise<void> {
    await this.appendLines(
      findings.map((finding) => ({ kind: "finding" as const, ...finding }))
    );
  }

  /** 採った・退けたを足す。**指摘そのものは書き換えない** */
  async decide(decisions: readonly FindingDecision[]): Promise<void> {
    await this.appendLines(
      decisions.map((decision) => ({ kind: "decision" as const, ...decision }))
    );
  }

  /**
   * いまの状態を全部読む。**期限切れも含む**（消していないので在る）。
   *
   * 並べる前に `visibleFindings` を通すこと。
   */
  async load(): Promise<FindingView[]> {
    try {
      const bytes = await vscode.workspace.fs.readFile(
        path.toUri(this.filePath)
      );
      return resolveFindings(
        parseFindingLines(new TextDecoder().decode(bytes))
      );
    } catch {
      // 無い・読めないなら「まだ何も残っていない」。検知そのものは動く
      return [];
    }
  }

  /**
   * 期限切れの指摘を、置き場から**本当に消す**（設計書6.96.4）。
   *
   * **`findings.jsonl` を書き直すのは、ここだけである。** ほかはすべて
   * 追記しかしない——追記だけなら同じ行を両方の機械が書き換えることが
   * 無く、同期の衝突が起きにくいからである。その前提を崩さないために、
   * 丸ごと書き直すのは**作者が「古い指摘を片づける」を押したときだけ**に
   * 限る（機械は勝手に消さない。時計のずれや、ノートPCを久しぶりに
   * 開いたときに、**作者が見る前に消える**のを防ぐため）。
   *
   * 消すのは**期限を過ぎた指摘**と、それに付いている判断の行である。
   *
   * **判断だけを残さない。** 指摘を消して判断を残すと、同じものを検知し
   * 直したときに**出た瞬間に「判断済み」として隠れる**——期限切れとして
   * 片付けたはずのものが、二度と見られなくなる。
   *
   * **指す先の見当たらない判断は残す。** 同期の衝突で指摘の行だけが
   * 落ちたときに、退けた記録まで一緒に消すと、次の検知で退けたはずの
   * ものが戻ってくる。増えても1行ずつなので、残すほうが害が小さい。
   *
   * @returns 消した指摘の件数（判断の行は数えない。作者が見るのは指摘の数）
   */
  async prune(retentionDays: number, now: Date = new Date()): Promise<number> {
    const lines = await this.loadLines();
    const doomed = expiredFindingIds(lines, retentionDays, now);
    const kept = lines.filter((line) =>
      line.kind === "finding"
        ? !doomed.has(line.id)
        : !doomed.has(line.findingId)
    );
    if (kept.length === lines.length) return 0;
    await this.rewrite(kept);
    return doomed.size;
  }

  /**
   * 片づけると何件消えるかを、**押す前に**数える。
   *
   * 消してから件数を告げても、作者は取り消せない。
   */
  async countExpired(
    retentionDays: number,
    now: Date = new Date()
  ): Promise<number> {
    return expiredFindingIds(await this.loadLines(), retentionDays, now).size;
  }

  /** 生の行をそのまま読む（畳む前）。**片づけだけが要る** */
  private async loadLines(): Promise<FindingLine[]> {
    try {
      const bytes = await vscode.workspace.fs.readFile(
        path.toUri(this.filePath)
      );
      return parseFindingLines(new TextDecoder().decode(bytes));
    } catch {
      return [];
    }
  }

  /**
   * 置き場を丸ごと書き直す。**`prune` からしか呼ばない。**
   *
   * 壊れた行・競合マーカーの行は `parseFindingLines` が落とすので、
   * ここを通ると一緒に消える。**それでよい**——どちらも読めない行であり、
   * 作者が「片づける」と決めたときにだけ通る道である。
   */
  private async rewrite(lines: readonly FindingLine[]): Promise<void> {
    const uri = path.toUri(this.filePath);
    await vscode.workspace.fs.createDirectory(
      path.toUri(path.dirname(this.filePath))
    );
    const text =
      lines.length === 0
        ? ""
        : lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
  }

  private async appendLines(lines: readonly FindingLine[]): Promise<void> {
    if (lines.length === 0) return;
    const target = this.filePath;
    const text = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
    await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(target)));
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
 * 並べてよい指摘だけを残す（設計書6.96.4）。
 *
 * **期限切れは隠すだけで、ファイルからは消さない。** 消えるのは
 * 「古い指摘を片づける」を作者が押したときだけである——機械が勝手に
 * 消すと、時計がずれていたときや、ノートPCを久しぶりに開いたときに
 * **作者が見る前に消える**。
 *
 * 判断の済んだものも並べない。採ったものはもう本文に入っており、
 * 退けたものは作者が「要らない」と言ったものである。
 *
 * @param now 試験のために外から渡す。既定はいまの時刻
 */
export function visibleFindings(
  findings: readonly FindingView[],
  retentionDays: number,
  now: Date = new Date()
): FindingView[] {
  return findings.filter(
    (finding) =>
      finding.status === "pending" &&
      !isFindingExpired(finding.time, retentionDays, now)
  );
}
