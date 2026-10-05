// ログの書き先：作品が定まらない——割り当てはどの作品の話でもないので
// 保管庫のログへ倒す（登録簿の写しと同じ扱い）
import * as vscode from "vscode";
import * as path from "../core/paths";
import {
  AI_ASSIGNMENTS_SNAPSHOT_PATH,
  buildAiAssignmentsSnapshot,
  serializeAiAssignmentsSnapshot,
  type AiAssignmentsSource,
} from "../core/aiAssignmentsSnapshot";
import { atomicWriteFile } from "../core/atomicWrite";
import { canRunProcesses } from "../core/runtime";
import { logLine } from "../core/logger";
import { globalStorageRoot } from "./globalStoragePath";
import { readMachineName } from "./windowCard";

/**
 * 機能ごとのAIの割り当てと、いま既定の AI の写しを保管庫へ書く
 * （MCP の `ai.settings` が読む。作者の裁定、2026-10-01）。
 *
 * 形は登録簿の写し（`features/worksSnapshot.ts`）と同じ。
 *
 * - **起動したときと、既定のAIか割り当てが変わったとき**
 *   （`AIRegistry.onDidChangeSelection`。選ぶ・外す・割り当てる・割り当てを外す
 *   の4つで鳴る）に書く
 * - 変わった合図は変えた窓にしか届かないので、写しは**最後に書いた窓から見た
 *   割り当て**になる。`writtenBy` と `writtenAt` に、どの窓がいつ書いたかを残す
 * - **原子的に書く**（`atomicWriteFile` の指定なし＝経路①）。写しは作者の
 *   データではない（本物は `globalState`）ので、退避は取らない
 * - **割り当てを書き換える道は作らない。** ここは読んで写すだけ
 * - **写すのはプロバイダIDとモデル名だけ**（`core/aiAssignmentsSnapshot.ts`）。
 *   鍵は OS の資格情報ストアにあり、この写しの材料には入れない
 *
 * **ブラウザ版では書かない**（読む相手の MCP サーバーが走らない）。
 * **失敗しても画面には出さない**。理由はログへ残す。
 */
export interface AiAssignmentsSnapshotOptions {
  /** 写しの材料。**渡すのは関数**——書くたびに、その時点の割り当てを読む */
  readSource: () => AiAssignmentsSource;
  /** 既定のAIか割り当てが変わったとき */
  onDidChange: vscode.Event<void>;
}

export function startAiAssignmentsSnapshot(
  context: vscode.ExtensionContext,
  options: AiAssignmentsSnapshotOptions
): vscode.Disposable | undefined {
  if (!canRunProcesses()) return undefined;

  const target = path.join(globalStorageRoot(context), ...AI_ASSIGNMENTS_SNAPSHOT_PATH);
  const extensionVersion =
    (context.extension.packageJSON as { version?: string }).version ?? "";
  // 書き込みを1本の列に並べる。**追い越されると、古い割り当ての写しが最後に残る**
  let queue: Promise<void> = Promise.resolve();

  const write = (): Promise<void> => {
    queue = queue.then(async () => {
      try {
        const snapshot = buildAiAssignmentsSnapshot(
          options.readSource(),
          {
            pid: process.pid,
            extensionVersion,
            machineName: await readMachineName(),
          },
          new Date()
        );
        await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(target)));
        await atomicWriteFile(
          target,
          new TextEncoder().encode(serializeAiAssignmentsSnapshot(snapshot))
        );
      } catch (error) {
        logLine(
          "AIの割り当ての写しを保管庫へ書けませんでした（MCP の ai.settings が古いままです）：" +
            (error instanceof Error ? error.message : String(error))
        );
      }
    });
    return queue;
  };

  void write();
  return vscode.Disposable.from(
    options.onDidChange(() => void write()),
    // 意味検索の設定（MCP の novel.search が索引と照らす。0.99.19）が変わったときも書き直す
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("novelai.vectorSearch") ||
        event.affectsConfiguration("novelai.ollama.endpoint")
      ) {
        void write();
      }
    })
  );
}
