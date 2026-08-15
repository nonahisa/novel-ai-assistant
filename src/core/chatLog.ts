import * as vscode from "vscode";
import * as path from "path";
import type { WorkEntry } from "../models/types";
import { workPaths } from "./workRegistry";
import { formatLogTime, redactSecrets } from "./logger";

/**
 * 相談のやり取りを、読める形で残す。
 *
 * ## なぜ actions.log と分けるか
 *
 * `logger.ts` は**本文そのものを書かない**方針で作ってある（原稿がログへ
 * 漏れるのを避けるため）。相談のログはその逆で、**質問・返事・渡した場面**を
 * 残さないと意味がない。方針が違うものを同じファイルへ混ぜると、
 * どちらの規則で書けばよいのか分からなくなる。
 *
 * ## 何のために残すか
 *
 * 作者の要望「開発中はこちらで内容が参照できるようにしてほしい」。
 * 相談は**AIが何を材料にして何を答えたか**が画面に残らない。
 * とくに検索（6.18）を入れてからは「なぜその場面が選ばれたのか」を
 * 後から確かめられることが要る。
 *
 * ## 置き場所と扱い
 *
 * `.aiwriter/logs/chat.md`。**ここはGit除外済み**なので、
 * 原稿の一部を含む記録がGitHubへ流れることはない。
 * 読むためのものなのでMarkdownで書く（JSONの1行だと長文が読めない）。
 *
 * **APIキーらしき文字列は伏せる**（`redactSecrets`）。
 * 作者がログを貼って助けを求めることを考えると、万一の被害が大きい。
 */

/** 1ファイルの上限。超えたら古いほうから捨て、直近が読めることを優先する */
const MAX_LOG_BYTES = 2_000_000;

/** 渡した場面の見出しに添える本文の長さ。全文を載せると読めなくなる */
const MATERIAL_HEAD_CHARS = 60;

/** 書き込みは順番に行う。並行して呼ばれると記録が混ざる */
let writeQueue: Promise<void> = Promise.resolve();

export interface ChatLogMaterial {
  /** 「本文・第105話」など、どこから採ったか */
  label: string;
  /** 冒頭だけ。何が渡ったかを確かめる手掛かり */
  head: string;
}

export interface ChatLogEntry {
  /** どの画面からの相談か */
  panel: "相談パネル" | "設定資料パネル";
  provider: string;
  model: string;
  paid: boolean;
  /**
   * 使ったプロンプトの版。
   *
   * **これが無いと、直したはずの指示が効いているのか分からない。**
   * 拡張機能開発ホストは再読み込みするまで古いビルドで動くため、
   * 「直したのに直っていない」の原因がそこなのか、指示が弱いのかを
   * 切り分けられなかった（実機で実際に迷った、2026-08-15）。
   */
  promptVersion?: string;
  /** 何について聞いているか。「第12話 の本文」「登場人物: 太志」など */
  target?: string;
  /** 選択範囲を使ったか */
  fromSelection?: boolean;
  /** 質問を検索語へ直した結果（P-22） */
  searchTerms?: string[];
  /** 検索の要約。「本文18件・設定資料3件を参照」 */
  retrieval?: string;
  /** 実際に渡した場面 */
  materials?: ChatLogMaterial[];
  question: string;
  reply: string;
  /** AIが並べた次の一手 */
  options?: string[];
  /** 書き込み・機能起動・該当箇所の提案。押されたかどうかは別に記録する */
  proposals?: string[];
  /** AIが求めた追加のファイル */
  requestedFiles?: string[];
  elapsedMs?: number;
  usage?: { inputTokens: number; outputTokens: number };
  /** 失敗したとき */
  error?: string;
}

export function isChatLogEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("novelai")
    .get<boolean>("chatLog.enabled", true);
}

export function chatLogPath(work: WorkEntry): string {
  return path.join(workPaths(work).aiwriter, "logs", "chat.md");
}

/**
 * 1回のやり取りを書き足す。
 *
 * **失敗しても相談は止めない。** ログが書けないことより、
 * 相談が中断するほうが作者にとって困る。
 */
export function appendChatLog(work: WorkEntry, entry: ChatLogEntry): void {
  if (!isChatLogEnabled()) return;

  const target = chatLogPath(work);
  const text = renderChatLogEntry(entry);

  writeQueue = writeQueue
    .then(async () => {
      const uri = vscode.Uri.file(target);
      await vscode.workspace.fs.createDirectory(
        vscode.Uri.file(path.dirname(target))
      );
      let existing: Uint8Array;
      try {
        existing = await vscode.workspace.fs.readFile(uri);
      } catch {
        existing = new TextEncoder().encode(header(work));
      }
      const addition = new TextEncoder().encode(text);
      const merged =
        existing.byteLength + addition.byteLength > MAX_LOG_BYTES
          ? new Uint8Array([
              ...new TextEncoder().encode(header(work)),
              ...addition,
            ])
          : concat(existing, addition);
      await vscode.workspace.fs.writeFile(uri, merged);
    })
    .catch(() => undefined);
}

function header(work: WorkEntry): string {
  return [
    `# ${work.title} の相談ログ`,
    "",
    "AIとのやり取りをそのまま残しています。**原稿の一部を含みます。**",
    "このファイルは `.aiwriter/logs/` にあり、GitHubへは送られません。",
    "残したくない場合は設定 `novelai.chatLog.enabled` を切ってください。",
    "",
  ].join("\n");
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const merged = new Uint8Array(left.byteLength + right.byteLength);
  merged.set(left, 0);
  merged.set(right, left.byteLength);
  return merged;
}

/**
 * 1件を Markdown にする。
 *
 * **見出しを日時にする。** 開いたときに時系列で追え、
 * 折りたたみ表示でも目的の回を探しやすい。
 *
 * VS Code APIに触れないので、ここだけ単体テストできる。
 */
export function renderChatLogEntry(
  entry: ChatLogEntry,
  now: Date = new Date()
): string {
  const lines: string[] = ["", "---", "", `## ${formatLogTime(now)}　${entry.panel}`, ""];

  const facts: string[] = [
    `AI: ${entry.provider}（${entry.model}）${entry.paid ? "・有料" : "・無料"}` +
      (entry.promptVersion ? `／プロンプト v${entry.promptVersion}` : ""),
  ];
  if (entry.target) {
    facts.push(
      `対象: ${entry.target}${entry.fromSelection ? "（選択範囲）" : ""}`
    );
  }
  if (entry.retrieval) facts.push(`検索: ${entry.retrieval}`);
  if (entry.searchTerms && entry.searchTerms.length > 0) {
    facts.push(`検索語: ${entry.searchTerms.join("、")}`);
  }
  if (entry.requestedFiles && entry.requestedFiles.length > 0) {
    facts.push(`AIが求めたファイル: ${entry.requestedFiles.join("、")}`);
  }
  if (entry.elapsedMs !== undefined) {
    facts.push(`所要: ${(entry.elapsedMs / 1000).toFixed(1)}秒`);
  }
  if (entry.usage) {
    facts.push(
      `トークン: 入力 ${entry.usage.inputTokens.toLocaleString()} / 出力 ${entry.usage.outputTokens.toLocaleString()}`
    );
  }
  lines.push(...facts.map((fact) => `- ${fact}`), "");

  lines.push("### 質問", "", quote(entry.question), "");

  if (entry.error) {
    lines.push("### 失敗", "", quote(entry.error), "");
    return lines.join("\n");
  }

  lines.push("### 返事", "", quote(entry.reply), "");

  if (entry.options && entry.options.length > 0) {
    lines.push(
      "### 選択肢",
      "",
      ...entry.options.map((option, i) => `${i + 1}. ${clean(option)}`),
      ""
    );
  }
  if (entry.proposals && entry.proposals.length > 0) {
    lines.push(
      "### 提案（押されるまで実行しません）",
      "",
      ...entry.proposals.map((proposal) => `- ${clean(proposal)}`),
      ""
    );
  }
  if (entry.materials && entry.materials.length > 0) {
    // 折りたたむ。毎回30件並ぶと、質問と返事が読めなくなる
    lines.push(
      "<details><summary>渡した場面（" + entry.materials.length + "件）</summary>",
      ""
    );
    for (const material of entry.materials) {
      lines.push(`- **${clean(material.label)}**　${clean(material.head)}`);
    }
    lines.push("", "</details>", "");
  }

  return lines.join("\n");
}

/** 引用として書く。見出し記号が混ざっても文書の構造を壊さない */
function quote(text: string): string {
  const body = clean(text) || "（空）";
  return body
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

function clean(text: string): string {
  return redactSecrets(text).trim();
}

/** 渡した場面を、記録用に短くする */
export function summarizeMaterials(
  items: ReadonlyArray<{ label: string; text: string }>
): ChatLogMaterial[] {
  return items.map((item) => ({
    label: item.label,
    head: item.text.replace(/\s+/g, " ").slice(0, MATERIAL_HEAD_CHARS),
  }));
}
