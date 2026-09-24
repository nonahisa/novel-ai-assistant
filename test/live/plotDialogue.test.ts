import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { expect, test, vi } from "vitest";
import { FileSystemError, commands, window, workspace } from "../unit/support/vscodeStub";
import { OllamaProvider } from "../../src/ai/ollamaProvider";
import { buildPlotMarkdown, emptyPlotSections } from "../../src/core/plotDoc";
import {
  PLOT_END_OPTION,
  PLOT_RETRY_OPTION,
  PLOT_SKIP_OPTION,
  PLOT_START_FROM_PLOT_OPTION,
  PLOT_WRITE_OPTION,
} from "../../src/core/plotInterview";
import type { WorkEntry } from "../../src/models/types";

/**
 * 対話式プロット作成（設計書6.4.7、P-43）を、**手元の Ollama で実際に回す。**
 *
 * 作者の実機の報告（2026-09-24 夜）「選択肢が延々と出てきてループします」を
 * 再現して直すために書いた。**製品と同じ組み立て**——相談パネル
 * （`WorkChatPanel`）へ作者の返事を送り、パネルが組んだ指示を実物の
 * `OllamaProvider` へ渡す。検算もパネルの中の道をそのまま通る。
 *
 * 作品は一時フォルダーの作り物（雛形だけの plot.md）。作者の原稿には触れない。
 *
 * - `PROBE_MODEL`：モデル（既定 gemma4:e4b）
 * - `PROBE_IDEA`：1通目に書く着想
 * - `PROBE_TURNS`：往復の数（既定 5）
 * - `PROBE_REPLIES`：「|」区切りで、往復ごとの返事を指定（空なら出た候補の1つ目を押す）
 * - `PROBE_OUT`：やり取りを書き出すファイル（指定したときだけ）
 */

vi.mock("../../src/core/logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/core/logger")>()),
  logFailure: () => undefined,
  logStep: () => undefined,
  logLine: () => undefined,
  useLogFile: () => undefined,
}));

const { WorkChatPanel } = await import("../../src/features/workChatPanel");

const MODEL = process.env.PROBE_MODEL ?? "gemma4:e4b";
const OUT = process.env.PROBE_OUT;
const IDEA =
  process.env.PROBE_IDEA ??
  "現代ベースのファンタジー。各地にダンジョンが出現。ダンジョンに挑む冒険者と、その中から配信で稼ぐ者が現れるが、配信のために通信ケーブルを敷設するインフラ業者が最強で……みたいな話。";
const TURNS = Number(process.env.PROBE_TURNS ?? 5);
const RESERVED = [
  PLOT_SKIP_OPTION,
  PLOT_WRITE_OPTION,
  PLOT_END_OPTION,
  PLOT_RETRY_OPTION,
  PLOT_START_FROM_PLOT_OPTION,
];

function log(text: string): void {
  if (OUT) fsSync.appendFileSync(OUT, `${text}\n`);
}

interface Posted {
  type: string;
  text?: string;
  reply?: string;
  options?: string[];
  message?: string;
  preview?: string;
}

test(`対話式プロット作成を手元のAIで${TURNS}往復させる（${MODEL}）`, { timeout: 1_800_000 }, async () => {
  const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), "plot-dialogue-"));
  try {
    const work: WorkEntry = {
      id: "w_probe",
      title: "回線の街",
      folderPath: root,
      registeredAt: "2026-09-25T00:00:00.000Z",
    };
    await fs.mkdir(nodePath.join(root, "設定"), { recursive: true });
    await fs.writeFile(
      nodePath.join(root, "設定", "plot.md"),
      buildPlotMarkdown(work.title, emptyPlotSections(), { hints: true })
    );

    const notFound = (error: unknown): never => {
      if ((error as { code?: string }).code === "ENOENT") {
        throw new FileSystemError("missing", "FileNotFound");
      }
      throw error;
    };
    workspace.fs = {
      stat: async (uri: { fsPath: string }) => {
        try {
          const s = await fs.stat(uri.fsPath);
          return { type: s.isDirectory() ? 2 : 1, ctime: 0, mtime: s.mtimeMs, size: s.size };
        } catch (error) {
          return notFound(error);
        }
      },
      createDirectory: async (uri: { fsPath: string }) => {
        await fs.mkdir(uri.fsPath, { recursive: true });
      },
      readFile: async (uri: { fsPath: string }) => {
        try {
          return new Uint8Array(await fs.readFile(uri.fsPath));
        } catch (error) {
          return notFound(error);
        }
      },
      writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
        await fs.mkdir(nodePath.dirname(uri.fsPath), { recursive: true });
        await fs.writeFile(uri.fsPath, bytes);
      },
      rename: async (from: { fsPath: string }, to: { fsPath: string }) => {
        await fs.rename(from.fsPath, to.fsPath);
      },
      delete: async (uri: { fsPath: string }) => {
        await fs.rm(uri.fsPath, { recursive: true, force: true });
      },
      readDirectory: async (uri: { fsPath: string }) => {
        try {
          const entries = await fs.readdir(uri.fsPath, { withFileTypes: true });
          return entries.map((e) => [e.name, e.isDirectory() ? 2 : 1]);
        } catch (error) {
          return notFound(error);
        }
      },
    } as unknown as typeof workspace.fs;
    window.showInformationMessage = (async () => undefined) as never;
    commands.executeCommand = (async () => undefined) as never;

    const provider = new OllamaProvider();
    let calls = 0;
    const counted = {
      id: provider.id,
      displayName: provider.displayName,
      isPaid: false,
      testConnection: () => provider.testConnection(),
      generate: (params: Parameters<OllamaProvider["generate"]>[0]) => {
        calls++;
        return provider.generate(params);
      },
    };
    const posted: Posted[] = [];
    const panel = new WorkChatPanel(
      { list: () => [work] } as never,
      {
        onDidChangeSelection: () => ({ dispose: () => undefined }),
        resolve: () => ({ provider: counted, model: MODEL }),
      } as never,
      { run: async () => undefined } as never
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inner = panel as any;
    panel.resolveWebviewView({
      visible: true,
      webview: {
        options: {},
        html: "",
        cspSource: "vscode-webview:",
        onDidReceiveMessage: () => ({ dispose: () => undefined }),
        postMessage: (message: Posted) => {
          posted.push(message);
          return Promise.resolve(true);
        },
      },
      onDidDispose: () => ({ dispose: () => undefined }),
    } as never);

    const show = (message: Posted): void => {
      if (message.type === "answer" || message.type === "chatter") {
        log(`AI：${message.reply ?? message.text}\n  札：${(message.options ?? []).join(" ／ ")}`);
      } else if (message.type === "editDone") {
        log(`（書き込み）${message.message}\n  ${message.preview}`);
      } else if (message.type === "note" || message.type === "error") {
        log(`（${message.type}）${message.message}`);
      }
    };

    await panel.startPlotInterview(work);
    posted.forEach(show);

    const plan = (process.env.PROBE_REPLIES ?? "").split("|");
    const topics: string[] = [];
    for (let turn = 0; turn < TURNS; turn++) {
      const options = [...posted].reverse().find((m) => m.options?.length)?.options ?? [];
      const candidates = options.filter((option) => !RESERVED.includes(option));
      const pick = turn === 0 ? IDEA : plan[turn] || candidates[0] || PLOT_RETRY_OPTION;
      const seen = posted.length;
      const before = calls;
      const started = Date.now();
      log(`\n----- 往復${turn + 1}\n作者：${pick}`);
      await inner.ask(pick);
      log(`  （AIを呼んだ回数 ${calls - before}／${Math.round((Date.now() - started) / 1000)}秒）`);
      posted.slice(seen).forEach(show);

      const answer = posted.slice(seen).find((m) => m.type === "answer");
      expect(answer, `往復${turn + 1}で答えが出ない`).toBeDefined();
      const topic = /【(.+?)】/u.exec(answer?.reply ?? "")?.[1];
      if (topic) topics.push(topic);
    }

    log("\n----- 「ここまでをプロットに書く」");
    const seen = posted.length;
    await inner.ask(PLOT_WRITE_OPTION);
    posted.slice(seen).forEach(show);
    log(`\n[AIを呼んだ回数] ${calls}`);

    // **同じ問いを二度出さない**（ループしない）
    expect(new Set(topics).size).toBe(topics.length);
    // 書いたものが plot.md に入っている
    expect(posted.slice(seen).some((m) => m.type === "editDone")).toBe(true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
