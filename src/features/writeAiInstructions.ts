import * as vscode from "vscode";
import * as path from "../core/paths";
import { fromUri } from "../core/paths";
import type { WorkEntry } from "../models/types";
import { canRunProcesses } from "../core/runtime";
import {
  atomicWriteFile,
  createManagedRecoveryPath,
  pruneManagedRecoveries,
} from "../core/atomicWrite";
import {
  AI_INSTRUCTION_TARGETS,
  AI_INSTRUCTION_TEMPLATE_PATH,
  AiInstructionFormatError,
  applyUsageToInstructionBody,
  buildAiInstructionDocument,
  mergeCodexToml,
  mergeMcpServersJson,
  type AiInstructionTarget,
  type McpRegistration,
} from "../core/aiInstructions";
import type { AiInstructionUsage } from "../core/aiInstructionUsage";
import { AiInstructionUsageStore } from "../core/aiInstructionUsageStore";
import { SERVER_NAME } from "../mcp/version";
import { cancelItem } from "../views/dialogs";
import { notifyDone } from "../views/notify";

/**
 * AI用の指示書を作品フォルダーへ置く（設計書6.87.15 柱5）。
 *
 * **書き込みは拡張機能から**（設計書5.5.1 と同じ。作者の操作を起点にする）。
 * 外部AIに自分で置かせると、何が置かれたのかを作者が見ないまま決まる。
 *
 * **相手は複数選べる。** 同じ作品を Claude Code でも Gemini CLI でも
 * 開くことがあり、どちらか一方しか置けない理由が無い。
 *
 * **使い方も選べる**（設計書6.87.14 の末尾、作者の指示 2026-09-18）。
 * 作品フォルダーを開いて使うか、開かずに使うか——置き先と、指示書の頭の
 * 数行が変わる。**本文は1つのまま。**
 */

/** 束（MCPサーバー）の場所を覚えておく鍵（`globalState`。作品をまたいで共通） */
const KEY_BUNDLE_PATH = "novelai.mcpBundlePath";

/** 指示書を置いたときの結果（報告のために集める） */
interface WriteOutcome {
  readonly target: AiInstructionTarget;
  readonly instruction: string;
  /** 何をしたか（「置きました」「同じ内容だったので触っていません」など） */
  readonly instructionNote: string;
  readonly registration?: string;
  readonly registrationNote?: string;
}

export async function writeAiInstructions(
  context: vscode.ExtensionContext,
  work: WorkEntry
): Promise<void> {
  const template = await readTemplate(context);
  if (template === undefined) return;

  const targets = await pickTargets();
  if (!targets) return;

  const usage = await pickUsage();
  if (!usage) return;

  // **置き先は使い方で変わる。** 開かずに使うなら、作品とは別の
  // フォルダー（AIに開かせる場所）へ置く
  const root =
    usage === "open-work" ? work.folderPath : await pickDetachedRoot(work);
  if (!root) return;

  // 開かずに使うときだけ、頭に「作品はここにある」の数行を足す
  const body = applyUsageToInstructionBody(template, usage, work.folderPath);

  const registration = await resolveRegistration(context, targets);
  // 束が見つからなかったときも指示書は置く（登録は作者が後から足せる）。
  // ここで全部やめると、**指示書という文章そのものは置けるのに**
  // 「MCPが無いから何もできない」と読める行き止まりになる

  const existing = await findExistingInstructions(root, targets);
  const keepBackup = await askAboutExisting(existing);
  if (keepBackup === undefined) return;

  const outcomes: WriteOutcome[] = [];
  const failures: string[] = [];

  for (const target of targets) {
    const instructionPath = path.join(root, target.instructionPath);
    const document = buildAiInstructionDocument(target, body);
    try {
      const note = await placeDocument(instructionPath, document, keepBackup);
      const outcome: WriteOutcome = {
        target,
        instruction: target.instructionPath,
        instructionNote: note,
        ...(await placeRegistration(root, target, registration)),
      };
      outcomes.push(outcome);
    } catch (error) {
      // **1つの相手で止まっても、ほかの相手は最後まで置く**
      // （チャンク単位の失敗と同じ作法）。指示書だけ置けていることも
      // あるので、どこで止まったかが分かる文をそのまま出す
      failures.push(`${target.label}：${errorText(error)}`);
    }
  }

  /*
    **選んだことを覚える。** 編集履歴の画面（設計書6.87.9）で
    「直接読んだぶんは記録に残らない」と断るために要る——覚えないと、
    記録が実態より少なく見えることを作者に伝えられない。

    置けたものが1つも無ければ覚えない（何も起きていないため）。
  */
  if (outcomes.length > 0) {
    try {
      await new AiInstructionUsageStore(work).save(usage);
    } catch {
      // 控えが書けなくても、指示書は置けている。**報告を止めない**
    }
  }

  report(work, root, usage, outcomes, failures, registration);
}

/**
 * 雛形を読む。**同梱してあるものを読む**（`docs/skills/novel-assist.md`）。
 *
 * 写しをソースへ持たず、配布物に本物を入れてある（`.vscodeignore` で
 * この1ファイルだけ除外から外してある）。読めないときは**作り直さずに断る**
 * ——ここで組み立て始めると、雛形と中身が別物になる。
 */
async function readTemplate(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  const file = path.toUri(
    path.join(fromUri(context.extensionUri), AI_INSTRUCTION_TEMPLATE_PATH)
  );
  try {
    const bytes = await vscode.workspace.fs.readFile(file);
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    await vscode.window.showWarningMessage(
      "AI用の指示書のもとになるファイルが見つかりませんでした。",
      {
        modal: true,
        detail:
          `拡張機能の中の「${AI_INSTRUCTION_TEMPLATE_PATH}」を読もうとしましたが、開けませんでした。\n\n` +
          "拡張機能を入れ直すか、リポジトリから直接お使いください。",
      }
    );
    return undefined;
  }
}

/** どの相手へ置くかを選ぶ（複数可） */
async function pickTargets(): Promise<AiInstructionTarget[] | undefined> {
  const picked = await vscode.window.showQuickPick(
    AI_INSTRUCTION_TARGETS.map((target) => ({
      label: target.label,
      description: target.instructionPath,
      detail: target.detail,
      target,
    })),
    {
      canPickMany: true,
      title: "AI用の指示書を、どの相手向けに置きますか",
      placeHolder: "いくつでも選べます（中身は同じで、置き先と頭の数行だけが違います）",
      ignoreFocusOut: true,
    }
  );
  if (!picked || picked.length === 0) return undefined;
  return picked.map((item) => item.target);
}

/**
 * 使い方を選ぶ（設計書6.87.14 の末尾）。
 *
 * **選ばせる前に、違いをその場で見せる。** 「MCP を通すか通さないか」では
 * 作者に伝わらない——**原稿が黙って読まれるかどうか**の言葉で書く。
 */
async function pickUsage(): Promise<AiInstructionUsage | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: "作品フォルダーを開いて使う",
        description: "いまのやり方。手軽",
        detail:
          "AIに作品フォルダーそのものを開かせます。手引きは自動で効きますが、" +
          "開いたAIは原稿を直接読めます——そのときは許可をお尋ねできず、編集履歴にも残りません。",
        usage: "open-work" as const,
      },
      {
        label: "作品を開かずに使う",
        description: "原稿を黙って読ませない",
        detail:
          "AIには別のフォルダーを開かせ、手引きに作品の場所を書きます。" +
          "原稿は道具（MCP）を通してしか読めないので、読むたびに許可をお尋ねし、編集履歴に残ります。",
        usage: "keep-closed" as const,
      },
      // Escでも閉じられるが、それを知らない人には出口が無いように見える
      cancelItem(),
    ],
    {
      title: "AIに、この作品をどう使わせますか",
      placeHolder: "原稿が黙って読まれるかどうかが変わります",
      ignoreFocusOut: true,
    }
  );
  return picked && "usage" in picked ? picked.usage : undefined;
}

/**
 * 「作品を開かずに使う」ときの置き先を選んでもらう。
 *
 * **作品フォルダー（とその親）を選んだら、選び直してもらう。** そこへ置くと
 * AIは結局その作品を開くことになり、前者と同じになる——**選んだつもりの
 * 守りが無い状態**がいちばん悪い。
 */
async function pickDetachedRoot(work: WorkEntry): Promise<string | undefined> {
  for (;;) {
    const selected = await vscode.window.showOpenDialog({
      title: "AIに開かせるフォルダーを選んでください（作品フォルダー以外）",
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "ここへ手引きを置く",
    });
    if (!selected || selected.length === 0) return undefined;

    const chosen = fromUri(selected[0]);
    if (!reachesWork(chosen, work.folderPath)) return chosen;

    const again = "選び直す";
    const answer = await vscode.window.showWarningMessage(
      "そのフォルダーからは、作品の原稿がそのまま見えます。",
      {
        modal: true,
        detail:
          `選ばれたのは「${chosen}」で、作品（${work.folderPath}）そのもの、` +
          "またはその作品を含む場所です。\n\n" +
          "ここへ置くと「作品フォルダーを開いて使う」と同じことになり、" +
          "AIは原稿を直接読めます（許可も記録もありません）。\n\n" +
          "作品の外に、AI用のフォルダーを選んでください。",
      },
      again
    );
    if (answer !== again) return undefined;
  }
}

/** 選んだフォルダーを開くと、作品の中まで見えるか */
function reachesWork(chosen: string, workFolder: string): boolean {
  const relative = path.relative(chosen, workFolder);
  // 空文字＝同じ場所。外を指していなければ、作品は選んだ場所の中にある
  return relative === "" || !path.goesOutside(chosen, relative);
}

/**
 * MCP の登録に書く中身を決める。
 *
 * **束（`dist/mcp-server.mjs`）は配布物に入っている**（設計書6.87.8。
 * 2026-09-18 に同梱へ方針を変えた）。だから①拡張機能の中にあれば使う——
 * 配布版でも開発ホストでも、ふつうはここで決まり、作者は何も訊かれない。
 * ②③は、束を消してしまった等でここに無かったときの逃げ道である
 * （②前に選んだ場所を覚えていれば使う ③作者に選んでもらう）。
 * **選ばなければ登録は書かない**（指示書だけ置く）。
 */
async function resolveRegistration(
  context: vscode.ExtensionContext,
  targets: readonly AiInstructionTarget[]
): Promise<McpRegistration | undefined> {
  if (!targets.some((target) => target.registrationPath)) return undefined;

  if (!canRunProcesses()) {
    // ブラウザ版では `node` を起こせない。**消さずに理由を出す**（設計書5.8.5）
    await vscode.window.showInformationMessage(
      "ブラウザ版では、MCPサーバーの登録は書けません（外部プロセスを起動できないためです）。",
      { modal: true, detail: "指示書だけを置きます。登録は手元のVS Codeからどうぞ。" }
    );
    return undefined;
  }

  const bundled = path.join(
    fromUri(context.extensionUri),
    "dist",
    "mcp-server.mjs"
  );
  if (await exists(bundled)) return registrationFor(bundled);

  const remembered = context.globalState.get<string>(KEY_BUNDLE_PATH);
  if (remembered && (await exists(remembered))) {
    return registrationFor(remembered);
  }

  const choose = "束の場所を選ぶ";
  const skip = "登録は書かずに、指示書だけ置く";
  const answer = await vscode.window.showInformationMessage(
    "MCPサーバーの束（dist/mcp-server.mjs）が見つかりませんでした。",
    {
      modal: true,
      detail:
        "ふだんは拡張機能に同梱されているものを使います。見つからないのは、" +
        "拡張機能の中の「dist/mcp-server.mjs」が失われているか、" +
        "リポジトリから直接動かしていて束をまだ作っていない場合です" +
        "（その場合は `npm run build` で作れます）。\n\n" +
        "場所を選ぶと、次からはそれを使います。",
    },
    choose,
    skip
  );
  if (answer !== choose) return undefined;

  const selected = await vscode.window.showOpenDialog({
    title: "MCPサーバーの束（mcp-server.mjs）を選んでください",
    canSelectMany: false,
    filters: { "MCPサーバーの束": ["mjs", "js"] },
  });
  if (!selected || selected.length === 0) return undefined;

  const chosen = fromUri(selected[0]);
  await context.globalState.update(KEY_BUNDLE_PATH, chosen);
  return registrationFor(chosen);
}

function registrationFor(bundlePath: string): McpRegistration {
  return { name: SERVER_NAME, command: "node", args: [bundlePath] };
}

/** 既に指示書があるものを挙げる（同じ中身かどうかはここでは見ない） */
async function findExistingInstructions(
  root: string,
  targets: readonly AiInstructionTarget[]
): Promise<string[]> {
  const found: string[] = [];
  for (const target of targets) {
    if (await exists(path.join(root, target.instructionPath))) {
      found.push(target.instructionPath);
    }
  }
  return found;
}

/**
 * 既にあるファイルをどうするかを訊く。
 *
 * **黙って上書きしない。** `AGENTS.md`・`GEMINI.md` は、作者や別の道具が
 * 既に置いていることが多いファイルである（この作品のリポジトリにもある）。
 *
 * 返り値：`true`＝退避してから置く／`false`＝そのまま置き換える／
 * `undefined`＝やめる。**何も無ければ訊かない**（退避する対象が無いので `false`）。
 */
async function askAboutExisting(
  existing: readonly string[]
): Promise<boolean | undefined> {
  if (existing.length === 0) return false;

  const backup = "退避してから置く";
  const overwrite = "そのまま置き換える";
  const answer = await vscode.window.showWarningMessage(
    `次のファイルは、この作品にもうあります：${existing.join("、")}`,
    {
      modal: true,
      detail:
        "「退避してから置く」を選ぶと、いまの中身を .novelai-recovery フォルダーへ写してから置き換えます（5世代まで残ります）。\n\n" +
        "「そのまま置き換える」は、いまの中身が残りません。",
    },
    backup,
    overwrite
  );
  if (answer === backup) return true;
  if (answer === overwrite) return false;
  return undefined;
}

/**
 * 1つのファイルを置く。**「退避 → 新規作成」**の形（実装ルール2）。
 *
 * `atomicWriteFile` を `mode: "replace"` で呼ばない——あの経路は必ず失敗する
 * （正規ファイルへ触れずに提案を回復パスへ残す設計）。`core/plotFile.ts` と
 * 同じ手順を踏む。
 */
async function placeDocument(
  target: string,
  body: string,
  keepBackup: boolean
): Promise<string> {
  const bytes = new TextEncoder().encode(body);
  const current = await readIfExists(target);

  if (current !== undefined) {
    if (current === body) return "同じ中身が置いてあったので、触っていません";
    await replaceFile(target, bytes, current, keepBackup);
    return keepBackup ? "退避してから置き換えました" : "置き換えました";
  }

  await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(target)));
  await atomicWriteFile(target, bytes, { mode: "create" });
  return "置きました";
}

/**
 * MCP の登録を書く。**丸ごと置き換えず、このサーバーの項目だけを足す／直す。**
 *
 * 既にあるファイルは**必ず退避してから**書き換える——他の道具の登録が
 * 入っていることがあり、こちらの読み違いで消えたときに戻せる道を残す。
 */
async function placeRegistration(
  root: string,
  target: AiInstructionTarget,
  registration: McpRegistration | undefined
): Promise<{ registration?: string; registrationNote?: string }> {
  if (!target.registrationPath || !target.registrationFormat) return {};
  if (!registration) {
    return {
      registration: target.registrationPath,
      registrationNote: "束の場所が決まらなかったので、書いていません",
    };
  }

  const file = path.join(root, target.registrationPath);
  const current = await readIfExists(file);
  const next =
    target.registrationFormat === "json"
      ? mergeMcpServersJson(current, registration, target.registrationPath)
      : mergeCodexToml(current, registration);

  if (current === next) {
    return {
      registration: target.registrationPath,
      registrationNote: "同じ登録が入っていたので、触っていません",
    };
  }

  const bytes = new TextEncoder().encode(next);
  if (current !== undefined) {
    await replaceFile(file, bytes, current, true);
    return {
      registration: target.registrationPath,
      registrationNote: "退避してから、この登録だけを足しました（他の登録はそのままです）",
    };
  }

  await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(file)));
  await atomicWriteFile(file, bytes, { mode: "create" });
  return { registration: target.registrationPath, registrationNote: "登録を書きました" };
}

/** 既存ファイルの置き換え（退避 → 消す → 新規作成） */
async function replaceFile(
  target: string,
  bytes: Uint8Array,
  current: string,
  keepBackup: boolean
): Promise<void> {
  if (keepBackup) {
    const recovery = await createManagedRecoveryPath(target);
    await atomicWriteFile(recovery, new TextEncoder().encode(current), {
      mode: "create",
    });
    await pruneManagedRecoveries(target);
  }
  await vscode.workspace.fs.delete(path.toUri(target), { useTrash: false });
  await atomicWriteFile(target, bytes, { mode: "create" });
}

/**
 * 何を置いたかを報告する。
 *
 * **許可が相手ごとに分かれることを、ここで言う**（設計書6.87.14）。
 * 指示書を置いただけでは1文字も読めない——それを知らないと、作者は
 * 「置いたのに動かない」と読む。
 */
function report(
  work: WorkEntry,
  root: string,
  usage: AiInstructionUsage,
  outcomes: readonly WriteOutcome[],
  failures: readonly string[],
  registration: McpRegistration | undefined
): void {
  const lines = outcomes.map((outcome) => {
    const rows = [`■ ${outcome.target.label}`];
    rows.push(`　・${outcome.instruction}：${outcome.instructionNote}`);
    if (outcome.registration) {
      rows.push(`　・${outcome.registration}：${outcome.registrationNote}`);
    }
    return rows.join("\n");
  });

  const clients = outcomes
    .map((outcome) => outcome.target.clientName)
    .filter((name): name is string => Boolean(name));

  const notes = [
    // **使い方の結果を、置いた直後に言う**（設計書6.87.14 の末尾）。
    // 開いて使う作品では、記録が実態より少なく見える
    usage === "open-work"
      ? "この作品は「作品フォルダーを開いて使う」設定にしました。開いたAIは原稿を直接読めます——" +
        "そのぶんは許可をお尋ねできず、編集履歴にも残りません（編集履歴の画面にも同じ断りが出ます）。"
      : `この作品は「作品を開かずに使う」設定にしました。手引きは「${root}」へ置き、` +
        "作品の場所を書き添えてあります。原稿は道具を通してだけ読まれ、すべて編集履歴に残ります。",
    "許可は、外部AIが実際に使おうとしたときに画面でお尋ねします（既定は拒否です）。",
    clients.length > 1
      ? `許可は接続元ごとに分かれます（${clients.join("・")}）。` +
        "同じ作品でも、Claude Code に許した機能は Gemini CLI には効きません（そういう作りです）。"
      : "許可は接続元ごとに分かれます。別のAIから繋ぐと、あらためてお尋ねします。",
  ];
  if (!registration) {
    notes.push(
      "MCPサーバーの登録は書いていません。指示書だけでは道具を呼べないので、登録は後から足してください。"
    );
  }
  if (failures.length > 0) {
    notes.push(`置けなかったもの：\n${failures.join("\n")}`);
  }

  void vscode.window.showInformationMessage(
    usage === "open-work"
      ? `「${work.title}」にAI用の指示書を置きました。`
      : `「${work.title}」のためのAI用の指示書を、作品の外へ置きました。`,
    { modal: true, detail: [...lines, "", ...notes].join("\n") }
  );
  notifyDone(`AI用の指示書を置きました（${outcomes.length}件）`);
}

async function readIfExists(target: string): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(path.toUri(target));
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return undefined;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(path.toUri(target));
    return true;
  } catch {
    return false;
  }
}

function errorText(error: unknown): string {
  if (error instanceof AiInstructionFormatError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
