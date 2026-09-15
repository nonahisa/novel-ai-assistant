import * as vscode from "vscode";
import * as path from "./paths";
import { canRunProcesses } from "./runtime";
import type { WorkEntry } from "../models/types";
import { workPaths } from "./workRegistry";
import {
  DENIED,
  EXTERNAL_PERMISSION_FILE,
  formatExternalAccessPermission,
  parseExternalAccessPermission,
  type ExternalAccessPermission,
} from "./externalAccessPermission";

/**
 * 外部AIの利用許可を、拡張機能から読み書きする（設計書6.87.10）。
 *
 * **書けるのはここだけ。** MCPサーバー側は読むだけである——許可を
 * 自分で書ける仕組みにすると、意思確認の意味が無くなる。
 *
 * **消すのも操作のうち。** 取り消しはファイルを消すのではなく
 * `allowed: false` を書く——消すと「一度も決めていない」のか
 * 「取り消した」のかが分からなくなる。
 */
export class ExternalAccessPermissionStore {
  constructor(private readonly work: WorkEntry) {}

  private get filePath(): string {
    return path.join(workPaths(this.work).aiwriter, EXTERNAL_PERMISSION_FILE);
  }

  /** いまどちらか。**印が無い・読めないときは拒否** */
  async load(): Promise<ExternalAccessPermission> {
    try {
      const bytes = await vscode.workspace.fs.readFile(
        path.toUri(this.filePath)
      );
      return parseExternalAccessPermission(new TextDecoder().decode(bytes));
    } catch {
      return DENIED;
    }
  }

  /**
   * 決めたことを書く。
   *
   * @param allowed 許可するか
   * @param note 作者の覚え書き（無くてよい）
   */
  async save(allowed: boolean, note = ""): Promise<void> {
    const target = this.filePath;
    await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(target)));
    const permission: ExternalAccessPermission = {
      allowed,
      decidedAt: new Date().toISOString(),
      // **どの機械で決めたかを残す。** この印は同期しないので、
      // 別の機械の印と取り違えることは無いが、作者が後で読んで分かるように
      decidedOn: await safeHostName(),
      note,
    };
    await vscode.workspace.fs.writeFile(
      path.toUri(target),
      new TextEncoder().encode(formatExternalAccessPermission(permission))
    );
  }
}

/**
 * 機械の名前。取れなければ空（**取れないことで操作を止めない**）。
 *
 * **`node:os` は動的 import で取る**（CLAUDE.md 規則7）。静的に書くと、
 * ブラウザ版（vscode.dev）は拡張機能を読み込んだ瞬間に落ちる。
 * ブラウザでは名前が取れないので、VS Code が知っている入れ物の名前を使う。
 */
async function safeHostName(): Promise<string> {
  if (!canRunProcesses()) return vscode.env.appHost;
  try {
    const os = await import("node:os");
    return os.hostname();
  } catch {
    return "";
  }
}
