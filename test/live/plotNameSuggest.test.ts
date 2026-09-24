import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { expect, test, vi } from "vitest";
import { FileSystemError, window, workspace } from "../unit/support/vscodeStub";
import { OllamaProvider } from "../../src/ai/ollamaProvider";
import type { WorkEntry } from "../../src/models/types";
import { LIVE_MODEL, SKIP_REASON, liveWorkPath } from "./support/liveEnv";

/**
 * プロットモードの「名前の候補を出す」（P-45、設計書6.4.8）を、
 * **手元の Ollama で実際に回す。**
 *
 * 製品と同じ道を通す——`suggestPlotNames`（役名の拾い出し・系統の決め方・
 * プロンプト・スキーマ・読み取り・系統と響きの検算）と `applyPlotNames`
 * （plot.md への書き足し・承認待ちへの配置）。AIは実物の `OllamaProvider`。
 * 迂回するのは、作者が押す画面（人物と系統の選択・確認）だけ。
 *
 * **作者の作品は書き換えない。** 作品フォルダーの plot.md と承認待ちを
 * 一時フォルダーへ写し、そちらで回す。
 *
 *   $env:NOVELAI_LIVE_WORK = "C:/path/to/作品"
 *   $env:NOVELAI_MODEL = "gemma4:e4b"
 *   $env:PROBE_OUT = "結果を書き出すファイル"（任意）
 *   npx vitest run --config vitest.live.config.mts test/live/plotNameSuggest.test.ts
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
  confirmProviderReachable: async () => {
    log("（確認）繋がるか：通す");
    return true;
  },
  confirmPaidUsage: async () => {
    log("（確認）料金：通す");
    return true;
  },
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

const { suggestPlotNames, applyPlotNames } = await import(
  "../../src/features/plotNameSuggest"
);

const OUT = process.env.PROBE_OUT;
function log(text: string): void {
  if (OUT) fsSync.appendFileSync(OUT, `${text}\n`);
}

const source = liveWorkPath();

test.skipIf(!source)(
  `プロットの役名だけの人物に、名前の候補を出して入れる（${LIVE_MODEL}）${source ? "" : `——${SKIP_REASON}`}`,
  { timeout: 900_000 },
  async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), "plot-names-"));
    try {
      const work: WorkEntry = {
        id: "w_probe",
        title: nodePath.basename(source!),
        folderPath: root,
        registeredAt: "2026-09-25T00:00:00.000Z",
      };
      // 写すのは plot.md と承認待ちだけ（作者の作品は読むだけ）
      await fs.mkdir(nodePath.join(root, "設定"), { recursive: true });
      await fs.copyFile(
        nodePath.join(source!, "設定", "plot.md"),
        nodePath.join(root, "設定", "plot.md")
      );
      await fs
        .cp(
          nodePath.join(source!, ".aiwriter", "pending-characters"),
          nodePath.join(root, ".aiwriter", "pending-characters"),
          { recursive: true }
        )
        .catch(() => undefined);

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
      // 作者が押す画面：人物は全員（既定のまま）、系統は「指定なし（作品に合わせる）」
      window.showQuickPick = (async (items: unknown, options?: { canPickMany?: boolean }) => {
        const list = items as Array<{ label?: string; picked?: boolean; origin?: string }>;
        log(`（選ぶ画面）${list.map((item) => item.label).join("／")}`);
        if (options?.canPickMany) return list.filter((item) => item.picked);
        // PROBE_ORIGIN で系統を選べる（既定は「指定なし」）。取りやめる項目は
        // origin を持たないので、指定が無いときに undefined で探さない
        const wanted = process.env.PROBE_ORIGIN || "auto";
        return list.find((item) => item.origin === wanted);
      }) as never;

      const provider = new OllamaProvider();
      state.provider = provider;
      const plotFile = nodePath.join(root, "設定", "plot.md");
      const before = await fs.readFile(plotFile, "utf8");

      log(`\n===== ${LIVE_MODEL}（${new Date().toISOString()}）`);
      const started = Date.now();
      const result = await suggestPlotNames(work, {} as never, plotFile, () => undefined);
      log(`（${Math.round((Date.now() - started) / 1000)}秒）`);
      for (const notice of notices) log(`（知らせ）${notice}`);
      expect(result, "候補が出ない").toBeDefined();
      log(result!.view.note);
      for (const person of result!.view.people) {
        log(`\n■ ${person.role}：${person.summary}`);
        for (const candidate of person.candidates) {
          log(`  ・${candidate.name}（${candidate.reading}）${candidate.note}`);
        }
        for (const entry of person.dropped) log(`  ×${entry.name}：${entry.reason}`);
      }
      expect(result!.view.people.length).toBeGreaterThan(0);

      // 1人目の候補をそれぞれ選んで入れる（候補の残らなかった人物は選ばない）
      const picks = result!.view.people
        .filter((person) => person.candidates.length > 0)
        .map((person) => ({ id: person.id, name: person.candidates[0].name }));
      notices.length = 0;
      const written = await applyPlotNames(work, result!.session, picks);
      for (const notice of notices) log(`（知らせ）${notice}`);
      expect(written).toBe(true);

      const after = await fs.readFile(plotFile, "utf8");
      const changed = after
        .split(/\r?\n/)
        .filter((line, index) => line !== before.split(/\r?\n/)[index]);
      log(`\n書き足した行：\n${changed.join("\n")}`);
      expect(changed).toHaveLength(picks.length);
      const pendingDir = nodePath.join(root, ".aiwriter", "pending-characters");
      const pending = await fs.readdir(pendingDir);
      log(`承認待ち：${pending.join("、")}`);
      for (const pick of picks) {
        // ファイル名は空白を抜いた名前（`pendingFileName`）
        const staged = pending.find((name) => name === `new_${pick.name.replace(/\s/g, "")}.json`);
        expect(staged, `${pick.name} が承認待ちに無い`).toBeDefined();
        const body = JSON.parse(await fs.readFile(nodePath.join(pendingDir, staged!), "utf8"));
        log(`  ${staged}：読み ${body.character.reading}／役割 ${body.character.role}`);
        expect(body.character.reading).toBeTruthy();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
);
