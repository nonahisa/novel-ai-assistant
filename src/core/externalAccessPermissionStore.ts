import * as vscode from "vscode";
import * as path from "./paths";
import { canRunProcesses } from "./runtime";
import type { WorkEntry } from "../models/types";
import { workPaths } from "./workRegistry";
import {
  ALL_TOOLS,
  DENIED,
  EXTERNAL_PERMISSION_FILE,
  clientKeyOf,
  formatExternalAccessPermission,
  parseExternalAccessPermission,
  type ExternalAccessPermission,
  type ExternalClientPermission,
} from "./externalAccessPermission";

/**
 * 外部AIの利用許可を、拡張機能から読み書きする（設計書6.87.10、6.87.14）。
 *
 * **書けるのはここだけ。** MCPサーバー側は読むだけである——許可を
 * 自分で書ける仕組みにすると、意思確認の意味が無くなる。
 *
 * **許可は足し引きする。** 接続元ごと・道具ごとに持つので、
 * 「1つ許す」「1つ取り消す」「その接続元を丸ごと取り消す」が要る。
 */
export class ExternalAccessPermissionStore {
  constructor(private readonly work: WorkEntry) {}

  private get filePath(): string {
    return path.join(workPaths(this.work).aiwriter, EXTERNAL_PERMISSION_FILE);
  }

  /** いまどうなっているか。**印が無い・読めないときは拒否** */
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
   * 道具を1つ（または全部）許す。
   *
   * @param client 接続元の名乗り（空なら「名乗りなし」として持つ）
   * @param tool 道具の名前。`ALL_TOOLS` なら、その接続元に全部
   */
  async allowTool(client: string | undefined, tool: string): Promise<void> {
    await this.update(client, (entry) => {
      if (tool === ALL_TOOLS) {
        /*
          **全部を許したら、個別の指定は畳む。** 残しても意味が変わらず、
          あとで「全部」を取り消したときに古い指定だけが生き残る
          ——作者から見れば、取り消したはずのものが残る形になる。
        */
        return { ...entry, tools: [ALL_TOOLS] };
      }
      if (entry.tools.includes(ALL_TOOLS) || entry.tools.includes(tool)) {
        return entry;
      }
      return { ...entry, tools: [...entry.tools, tool].sort() };
    });
  }

  /** 考えさせること（sampling）を、その接続元に許す／やめる */
  async setSampling(
    client: string | undefined,
    sampling: boolean
  ): Promise<void> {
    await this.update(client, (entry) => ({ ...entry, sampling }));
  }

  /** 道具を1つ取り消す。**「全部」を許しているときは、全部を取り消す** */
  async revokeTool(client: string | undefined, tool: string): Promise<void> {
    await this.update(client, (entry) =>
      entry.tools.includes(ALL_TOOLS)
        ? { ...entry, tools: [] }
        : { ...entry, tools: entry.tools.filter((name) => name !== tool) }
    );
  }

  /**
   * その接続元を丸ごと取り消す。
   *
   * **考えさせる許可も一緒に落ちる**（設計書6.87.12）——片方だけ残ると、
   * 「拒否したはずなのに本文が外のAIへ渡る」形になる。
   */
  async revokeClient(client: string | undefined): Promise<void> {
    const name = clientKeyOf(client);
    const current = await this.load();
    await this.write({
      clients: current.clients.filter((entry) => entry.name !== name),
      legacy: false,
    });
  }

  /** 全部やめる（どの接続元にも、何も許していない状態へ戻す） */
  async revokeAll(): Promise<void> {
    await this.write({ clients: [], legacy: false });
  }

  private async update(
    client: string | undefined,
    change: (entry: ExternalClientPermission) => ExternalClientPermission
  ): Promise<void> {
    const name = clientKeyOf(client);
    const current = await this.load();
    const existing = current.clients.find((entry) => entry.name === name);
    const base: ExternalClientPermission = existing ?? {
      name,
      tools: [],
      sampling: false,
      decidedAt: "",
      decidedOn: "",
      note: "",
    };
    const changed: ExternalClientPermission = {
      ...change(base),
      decidedAt: new Date().toISOString(),
      // **どの機械で決めたかを残す。** この印は同期しないので取り違えは
      // 起きないが、作者が後で読んで分かるように
      decidedOn: await safeHostName(),
    };
    const clients = existing
      ? current.clients.map((entry) => (entry.name === name ? changed : entry))
      : [...current.clients, changed];
    /*
      **何も許していない接続元は、印から消す。** 残すと、画面に
      「許可0個の接続元」が並んで、何を許したのかが読み取りにくくなる。
      ただし**考えさせる許可だけが立っている状態は残す**——道具を許し直した
      ときに、作者がもう一度 sampling を選ばされるのを避ける。
    */
    await this.write({
      clients: clients.filter(
        (entry) => entry.tools.length > 0 || entry.sampling
      ),
      legacy: false,
    });
  }

  private async write(permission: ExternalAccessPermission): Promise<void> {
    const target = this.filePath;
    await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(target)));
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
