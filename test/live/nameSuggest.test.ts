import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { expect, test, vi } from "vitest";
import { FileSystemError, window, workspace } from "../unit/support/vscodeStub";
import { OllamaProvider } from "../../src/ai/ollamaProvider";
import { CharacterStore } from "../../src/core/characterStore";
import { emptyCharacter } from "../../src/models/character";
import type { WorkEntry } from "../../src/models/types";
import { LIVE_MODEL, SKIP_REASON, liveWorkPath } from "./support/liveEnv";

/**
 * 名前の点検の「候補を出す」（P-29、設計書6.37.2）を、**手元の Ollama で実際に回す。**
 *
 * 確かめたいこと（作者の裁定、2026-09-25 午前）：人物名の手がかりが無い
 * 現代ものの作品で、「指定なし（作品に合わせる）」の系統が**和風**に決まり、
 * その根拠が画面へ出ること。0.87.0 まではプロットモード（P-45）の指示文にだけ
 * 見立てを書いていて、名前の点検には無かった。
 *
 * 製品と同じ道を通す——`suggestNames`（系統の決め方・プロンプト・スキーマ・
 * 読み取り・系統と響きの検算・画面への送り出し）。AIは実物の `OllamaProvider`。
 * 迂回するのは、作者が押す画面（系統の選択・確認）と、画面そのもの
 * （送り出された中身を受け取るだけの写し）。
 *
 * **作者の作品は書き換えない。** plot.md を一時フォルダーへ写し、
 * 付け直す人物（`PROBE_PERSON`、既定は「主人公」）を1人だけ置いた資料で回す。
 *
 *   $env:NOVELAI_LIVE_WORK = "C:/path/to/作品"
 *   $env:NOVELAI_MODEL = "gemma4:e4b"
 *   $env:PROBE_OUT = "結果を書き出すファイル"（任意）
 *   npx vitest run --config vitest.live.config.mts test/live/nameSuggest.test.ts
 */

vi.mock("../../src/core/logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/core/logger")>()),
  logFailure: (...args: unknown[]) => log(`（ログ・失敗）${JSON.stringify(args)}`),
  logStep: (text: string) => log(`（ログ）${text}`),
  logLine: () => undefined,
  useLogFile: () => undefined,
}));

const state = vi.hoisted(() => ({ provider: undefined as unknown }));
vi.mock("../../src/ai/registry", () => ({
  AIRegistry: class {},
  ensureConfigured: async () => ({ provider: state.provider, model: process.env.NOVELAI_MODEL ?? "gemma4:e4b" }),
}));
vi.mock("../../src/features/aiConnectivity", () => ({
  confirmProviderReachable: async () => true,
  confirmPaidUsage: async () => true,
}));
vi.mock("../../src/features/reportAIError", () => ({
  reportAIError: (label: string, error: unknown) =>
    log(`（失敗）${label}：${error instanceof Error ? error.stack : String(error)}`),
}));
vi.mock("../../src/views/progress", () => ({
  withCancellableProgress: async <T>(
    _title: string,
    task: (progress: unknown, token: unknown) => Promise<T>
  ) =>
    task(
      { report: () => undefined },
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) }
    ),
}));

const { suggestNames } = await import("../../src/features/nameCheck");

const OUT = process.env.PROBE_OUT;
function log(text: string): void {
  if (OUT) fsSync.appendFileSync(OUT, `${text}\n`);
}

const source = liveWorkPath();

interface CandidatesMessage {
  type: string;
  data: {
    characterId: string;
    originNote?: string;
    kept: Array<{ name: string; reading: string; origin: string; note: string }>;
    dropped: Array<{ name: string; reason: string }>;
  };
}

test.skipIf(!source)(
  `名前の点検の候補：現代ものは和風に揃う（${LIVE_MODEL}）${source ? "" : `——${SKIP_REASON}`}`,
  { timeout: 900_000 },
  async () => {
    // 写しの置き場。PROBE_TMP があればその下（スクラッチパッドなど）
    const base = process.env.PROBE_TMP || os.tmpdir();
    await fs.mkdir(base, { recursive: true });
    const root = await fs.mkdtemp(nodePath.join(base, "name-suggest-"));
    try {
      const work: WorkEntry = {
        id: "w_probe",
        title: nodePath.basename(source!),
        folderPath: root,
        registeredAt: "2026-09-25T00:00:00.000Z",
      };
      // 写すのは plot.md だけ（作者の作品は読むだけ）
      await fs.mkdir(nodePath.join(root, "設定"), { recursive: true });
      await fs.copyFile(
        nodePath.join(source!, "設定", "plot.md"),
        nodePath.join(root, "設定", "plot.md")
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
        copy: async (from: { fsPath: string }, to: { fsPath: string }) => {
          await fs.copyFile(from.fsPath, to.fsPath);
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

      const notices: string[] = [];
      window.showInformationMessage = (async (message: string) => {
        notices.push(message);
        return undefined;
      }) as never;
      window.showWarningMessage = (async (message: string) => {
        notices.push(message);
        return undefined;
      }) as never;
      // 作者が押す画面：系統は「指定なし（作品に合わせる）」（PROBE_ORIGIN で変えられる）
      window.showQuickPick = (async (items: unknown) => {
        const list = items as Array<{ label?: string; origin?: string }>;
        const wanted = process.env.PROBE_ORIGIN || "auto";
        return list.find((item) => item.origin === wanted);
      }) as never;

      // 付け直す人物を1人だけ置く（ほかに人物がいない＝人物名の手がかりが無い作品）
      const person = process.env.PROBE_PERSON || "主人公";
      await new CharacterStore(work).saveOrUpdate(emptyCharacter("char_001", person));

      const messages: CandidatesMessage[] = [];
      const panel = {
        webview: {
          postMessage: async (message: CandidatesMessage) => {
            messages.push(message);
            return true;
          },
        },
      };

      state.provider = new OllamaProvider();
      log(`\n===== P-29 ${LIVE_MODEL}（${new Date().toISOString()}）／付け直す人物：${person}`);
      const started = Date.now();
      await suggestNames(panel as never, work, {} as never, "char_001");
      log(`（${Math.round((Date.now() - started) / 1000)}秒）`);
      for (const notice of notices) log(`（知らせ）${notice}`);

      const result = messages.find((message) => message.type === "candidates");
      expect(result, "候補が画面へ送られていない").toBeDefined();
      log(result!.data.originNote ?? "（系統の一言なし）");
      for (const candidate of result!.data.kept) {
        log(`  ・${candidate.name}（${candidate.reading}）${candidate.origin} ${candidate.note}`);
      }
      for (const entry of result!.data.dropped) log(`  ×${entry.name}：${entry.reason}`);

      // 系統の一言が画面に出て、和風で揃っている（カタカナの名前が残らない）
      expect(result!.data.originNote).toContain("和風");
      expect(result!.data.kept.length).toBeGreaterThan(0);
      for (const candidate of result!.data.kept) {
        expect(candidate.name).not.toMatch(/^[\p{Script=Katakana}ー・\s]+$/u);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
);
