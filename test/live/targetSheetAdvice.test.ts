import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { expect, test, vi } from "vitest";
import { FileSystemError, window, workspace } from "../unit/support/vscodeStub";
import { OllamaProvider } from "../../src/ai/ollamaProvider";
import type { WorkEntry } from "../../src/models/types";
import type { ReaderProfile } from "../../src/models/readerProfile";
import { LIVE_MODEL, SKIP_REASON, liveWorkPath } from "./support/liveEnv";

/**
 * ターゲットシートの助言（P-46、設計書6.108.4 の第3段）を、
 * **手元の Ollama で実際に回す。**
 *
 * 製品と同じ道を通す——本文の実像は `readFromWork`（P-38。材料集め・
 * プロンプト・検算）、助言は `makeTargetSheetAdvice`（材料の組み立て・
 * プロンプト・スキーマ・検算・記録）。AI は実物の `OllamaProvider`。
 * 迂回するのは、作者が押す画面（確認・「それでも作り直す」）だけ。
 *
 * 狙いと理由は**この試験が置く仮のもの**（作者が書いたものではない）。
 * 狙いと理由の組み合わせごとに PROBE_RUNS 回ずつ作り、記録を書き出す。
 *
 * **作者の作品は書き換えない。** 作品フォルダーを一時フォルダーへ写し、
 * そちらで回す。
 *
 *   $env:NOVELAI_LIVE_WORK = "C:/path/to/作品"
 *   $env:NOVELAI_MODEL = "gemma4:e4b"
 *   $env:PROBE_OUT = "結果を書き出すファイル"（任意）
 *   $env:PROBE_RUNS = "2"（任意）
 *   npx vitest run --config vitest.live.config.mts test/live/targetSheetAdvice.test.ts
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
  ensureConfigured: async () => ({
    provider: state.provider,
    model: process.env.NOVELAI_MODEL ?? "gemma4:e4b",
  }),
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

const { readFromWork } = await import("../../src/features/readerTargetDiagnosis");
const { makeTargetSheetAdvice } = await import("../../src/features/targetSheetAdvice");
const { targetSheetAdvicePath } = await import("../../src/features/targetSheet");
const { buildTargetSheetAdviceMaterial } = await import("../../src/core/targetSheetAdvice");
const { buildTargetSheetAdvicePrompt } = await import("../../src/prompts/targetSheetAdvice");

const OUT = process.env.PROBE_OUT;
function log(text: string): void {
  if (OUT) fsSync.appendFileSync(OUT, `${text}\n`);
}

/** 仮の狙いと理由（作者の欄の書き方そのまま） */
const SCENARIOS: Array<{ name: string; block: string }> = [
  {
    name: "A 考察層・理由あり",
    block: "狙い：考察層\n理由：お金と商売の仕組みが少しずつ明かされるのを、じっくり読み解いてくれる人に届けたい",
  },
  {
    name: "B すきま層・理由あり",
    block: "狙い：すきま層\n理由：仕事帰りの電車で、料理と商売の痛快さを気軽に楽しんでほしい",
  },
  { name: "C 考察層・理由なし", block: "狙い：考察層\n理由：" },
];

const source = liveWorkPath();

test.skipIf(!source)(
  `ターゲットシートの助言（${LIVE_MODEL}）${source ? "" : `——${SKIP_REASON}`}`,
  { timeout: 3_600_000 },
  async () => {
    const base = process.env.PROBE_TMP || os.tmpdir();
    await fs.mkdir(base, { recursive: true });
    const root = await fs.mkdtemp(nodePath.join(base, "advice-"));
    try {
      await fs.cp(source!, root, { recursive: true });
      // 前の実行の控え・記録を持ち込まない
      await fs.rm(nodePath.join(root, ".aiwriter", "cache"), { recursive: true, force: true });
      await fs.rm(nodePath.join(root, "設定", "ターゲットシート"), { recursive: true, force: true });
      const work: WorkEntry = {
        id: "w_probe",
        title: nodePath.basename(source!).replace(/_確認用$/, ""),
        folderPath: root,
        registeredAt: "2026-10-04T00:00:00.000Z",
      };

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
      window.showWarningMessage = (async (message: string) => {
        log(`（知らせ）${message}`);
        return undefined;
      }) as never;
      // 同じ材料で回すときは「それでも作り直す」を押す
      window.showQuickPick = (async (items: Array<{ label: string }>) =>
        items.find((item) => item.label === "それでも作り直す")) as never;

      state.provider = new OllamaProvider();
      log(`\n===== ${LIVE_MODEL}（${new Date().toISOString()}）作品：${work.title}`);

      // 1. 本文の実像（P-38）——製品の3段目と同じ道
      let started = Date.now();
      const read = await readFromWork(work, {} as never);
      log(`（実像 ${Math.round((Date.now() - started) / 1000)}秒）`);
      expect(read && read !== "cancelled", "実像が読めない").toBeTruthy();
      if (!read || read === "cancelled") return;
      log(
        `実像：読み慣れ${read.reading.scores.familiarity}・読む姿勢${read.reading.scores.posture}・求めるもの${read.reading.scores.craving}／根拠${read.reading.evidence.length}件／読めなかった軸 ${read.reading.unmeasured.join("・") || "なし"}`
      );
      const profile: ReaderProfile = {
        schemaVersion: "1",
        actual: {
          scores: read.reading.scores,
          evidence: read.reading.evidence,
          basis: read.basis,
          model: read.model,
          updatedAt: new Date().toISOString(),
        },
      };

      const settings = nodePath.join(root, "設定");
      const runs = Number(process.env.PROBE_RUNS ?? "2");
      for (const scenario of SCENARIOS) {
        const built = buildTargetSheetAdviceMaterial({ authorBlock: scenario.block, profile });
        log(`\n----- ${scenario.name}`);
        if ("missing" in built) {
          log(`材料が組めない：${built.missing}`);
          continue;
        }
        if (process.env.PROBE_SHOW_PROMPT) log(buildTargetSheetAdvicePrompt(built.material));
        log(
          `寄せてよい：${Object.entries(built.material.allowed)
            .map(([axis, list]) => `${axis}:${(list ?? []).join("/")}`)
            .join(" ") || "なし"}`
        );
        for (let run = 1; run <= runs; run += 1) {
          started = Date.now();
          const outcome = await makeTargetSheetAdvice(work, {} as never, {
            settings,
            authorBlock: scenario.block,
            profile,
          });
          log(`[${run}回目] ${outcome}（${Math.round((Date.now() - started) / 1000)}秒）`);
          if (outcome !== "done") continue;
          const record = JSON.parse(await fs.readFile(targetSheetAdvicePath(settings), "utf8"));
          log(`総評：${record.overall}`);
          for (const keep of record.keep) log(`  ○ ${keep}`);
          for (const item of record.advice) log(`  → ${item.axis}/${item.direction}：${item.text}`);
          log(`  捨てた：${record.dropped}`);
        }
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
);
