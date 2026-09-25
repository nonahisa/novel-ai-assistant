import { z } from "zod";
import {
  SETUP_STEPS,
  buildSetupUri,
  describeSetupRequest,
  validateSetupRequest,
} from "../../core/setupRequest";
import { McpToolError } from "./shared";

/**
 * 拡張機能の画面に、セットアップの確認を出させる（設計書6.87.18）。
 *
 * MCP サーバーは別プロセスで、拡張機能の操作を直に呼べない。
 * **`vscode://nonahisa.novel-ai-assistant/setup?step=…` を OS に開かせる**と、
 * VS Code が拡張機能の受け口へ渡し、拡張機能が「Claude Code からの依頼です」
 * の確認を出す。**押すのは作者**で、断れば何も起きない。
 *
 * **ファイルを1つも書かない・読まない。** 作品を作る・登録するのは拡張機能
 * だけ（6.87.7）。作品の場所を `folder` と名付けないのは、`folder` が門番
 * （6.87.14）の許可の鍵だから——まだ登録していない場所では必ず断られる。
 *
 * 引数は拡張機能と**同じ判定**（`core/setupRequest.ts`）で先に確かめ、
 * 通らなければ開く前に断る。
 */

const STEP_NAMES = SETUP_STEPS.map((def) => def.step) as [string, ...string[]];

export const SETUP_REQUEST_INPUT = {
  step: z
    .enum(STEP_NAMES)
    .describe(
      "どの段を頼むか。" +
        SETUP_STEPS.map((def) => `${def.step}＝${def.label}`).join("、")
    ),
  title: z.string().optional().describe("作品名（create・register）"),
  kind: z
    .string()
    .optional()
    .describe("種類（create）。novel・script・manga・essay・lyrics"),
  format: z
    .string()
    .optional()
    .describe("形式（create）。short・shortCollection・long・epic・sns・memo・unset（いまは決めない）"),
  start: z
    .string()
    .optional()
    .describe("始め方（create）。plot（プロットから）・manuscript（本文から）"),
  path: z
    .string()
    .optional()
    .describe("作品フォルダーの絶対パス（register・external-access で必須）"),
};

export interface SetupRequestInput {
  step: string;
  title?: string;
  kind?: string;
  format?: string;
  start?: string;
  path?: string;
}

export interface SetupRequestResult {
  /** 開いた（開こうとした）URI */
  uri: string;
  /** OS に渡せたか */
  opened: boolean;
  /** 作者の画面に出る確認の中身 */
  confirmation: string[];
  /** 呼んだ側が次にすること */
  note: string;
}

export interface SetupRequestDeps {
  open(uri: string): Promise<void>;
}

export async function setupRequest(
  args: SetupRequestInput,
  deps: SetupRequestDeps = { open: openUri }
): Promise<SetupRequestResult> {
  const checked = validateSetupRequest({ ...args });
  if (!checked.ok) throw new McpToolError(checked.reason);
  const uri = buildSetupUri(checked.request);
  const confirmation = describeSetupRequest(checked.request);

  try {
    await deps.open(uri);
  } catch (error) {
    // **開けなくても行き止まりにしない。** URI を返し、作者に手で開いてもらう
    const reason = error instanceof Error ? error.message : String(error);
    return {
      uri,
      opened: false,
      confirmation,
      note:
        `URI を開けませんでした（${reason}）。作者に、この URI をブラウザのアドレス欄へ貼って開いてもらうか、` +
        `ターミナルで code --open-url "${uri}" を実行してもらってください。`,
    };
  }
  return {
    uri,
    opened: true,
    confirmation,
    note:
      "作者の VS Code に「Claude Code からの依頼です」という確認が出ます。" +
      "作者が画面で操作を終えて返事をするまで、次の段を頼まないでください（結果はこちらからは見えません）。",
  };
}

/**
 * URI を開くためのコマンド。**シェルを通さない**——`&` を含む URI が
 * cmd に切られ、引数の後半が消える。
 */
export function openerCommand(
  platform: string,
  uri: string
): { command: string; args: string[] } {
  if (platform === "win32") {
    return { command: "rundll32", args: ["url.dll,FileProtocolHandler", uri] };
  }
  if (platform === "darwin") return { command: "open", args: [uri] };
  return { command: "xdg-open", args: [uri] };
}

/**
 * 子へ渡す環境。**`ELECTRON_RUN_AS_NODE` を外す。**
 *
 * この MCP サーバーは VS Code 本体を Node として走らせている（「Claude Code と
 * つなぐ」の登録。6.87.18）。継いだまま `vscode://` を開くと、呼び起こされた
 * VS Code が Node として立ち上がり、何も出ずに終わる（Electron 製のアプリが
 * 即終了するのと同じ形。LM Studio で実際に踏んだ）。
 */
export function envWithoutElectronFlag(
  env: Readonly<Record<string, string | undefined>>
): Record<string, string | undefined> {
  const next = { ...env };
  delete next.ELECTRON_RUN_AS_NODE;
  return next;
}

export async function openUri(uri: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const { command, args } = openerCommand(process.platform, uri);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env: envWithoutElectronFlag(process.env),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    // 開く係は渡したらすぐ終わる。待たずに手を放す（VS Code の起動は待たない）
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
