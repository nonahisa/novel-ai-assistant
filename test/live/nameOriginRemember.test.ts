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
import { LIVE_MODEL } from "./support/liveEnv";

/**
 * カタカナの作品の名前の系統を、作品ごとに覚えて固定する（設計書6.37.2。
 * 作者の裁定、2026-09-25 昼）を、**手元の Ollama で実際に回す。**
 *
 * 覚える前は、同じ作品でも回ごとに系統が変わった（e4b で、ギルドの作品が
 * フランス → ドイツ）。ここでは同じ作り物の作品に3段で頼む。
 *
 * 1. 覚えていない状態から3回（毎回、覚えた系統を消してから）——回ごとの揺れを見る
 * 2. 覚えたまま3回——最初に決まった系統から動かないか
 * 3. 作者が別の系統（`PROBE_REPICK`、既定「北欧」）を選び直し、次の「指定なし」で
 *    その系統になるか
 *
 * 製品と同じ道（`suggestNames`）。作品は一時フォルダーの作り物で、作者の作品には
 * 触れない。人物名はカタカナだけ（系統は人物名では1つに決まらない）。
 *
 *   $env:PROBE_NAME_ORIGIN = "1"
 *   $env:NOVELAI_MODEL = "gemma4:e4b"
 *   $env:PROBE_TMP = "写しを置くフォルダー"（任意。既定は OS の一時フォルダー）
 *   $env:PROBE_OUT = "結果を書き出すファイル"（任意）
 *   npx vitest run --config vitest.live.config.mts test/live/nameOriginRemember.test.ts
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

const { suggestNames } = await import("../../src/features/nameCheck");

const OUT = process.env.PROBE_OUT;
function log(text: string): void {
  if (OUT) fsSync.appendFileSync(OUT, `${text}\n`);
}

const ENABLED = process.env.PROBE_NAME_ORIGIN === "1";
const GUILD = ["ホンゴー", "ジャック", "ケンプ", "ヒッコリー", "ケイン", "グレイ", "ジャンヌ"];

interface CandidatesMessage {
  type: string;
  data: {
    originNote?: string;
    kept: Array<{ name: string; origin: string }>;
    dropped: Array<{ name: string; reason: string }>;
  };
}

test.skipIf(!ENABLED)(
  `カタカナの作品の系統を覚えて固定する（${LIVE_MODEL}）${ENABLED ? "" : "——PROBE_NAME_ORIGIN=1 で走ります"}`,
  { timeout: 1_800_000 },
  async () => {
    const base = process.env.PROBE_TMP || os.tmpdir();
    await fs.mkdir(base, { recursive: true });
    const root = await fs.mkdtemp(nodePath.join(base, "name-origin-"));
    try {
      const work: WorkEntry = {
        id: "w_guild",
        title: "ギルド（作り物）",
        folderPath: root,
        registeredAt: "2026-09-25T00:00:00.000Z",
      };
      const configPath = nodePath.join(root, ".aiwriter", "config.json");
      const baseConfig = {
        schemaVersion: "0.1",
        workTitle: work.title,
        manuscriptDir: "本文",
        settingsDir: "設定",
        createdAt: "2026-09-25T00:00:00.000Z",
      };
      // 作者の機械で git が取り出した形（CRLF・末尾改行あり）
      const writeBaseConfig = async (): Promise<void> => {
        await fs.mkdir(nodePath.dirname(configPath), { recursive: true });
        await fs.writeFile(
          configPath,
          `${JSON.stringify(baseConfig, null, 2)}\n`.replace(/\n/g, "\r\n")
        );
      };
      await writeBaseConfig();
      await fs.mkdir(nodePath.join(root, "設定"), { recursive: true });
      await fs.writeFile(
        nodePath.join(root, "設定", "plot.md"),
        "# ギルド\n\n## 世界観\n冒険者ギルドが街の暮らしを支える世界。迷宮と魔物がいる。\n"
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
      window.showInformationMessage = (async () => undefined) as never;
      window.showWarningMessage = (async () => undefined) as never;

      const store = new CharacterStore(work);
      for (const [index, name] of GUILD.entries()) {
        await store.saveOrUpdate(emptyCharacter(`char_00${index + 1}`, name));
      }
      const target = "char_005"; // ケイン

      /** 作者が押す系統（"auto" は「指定なし」） */
      let pick = "auto";
      const pickerDetails: string[] = [];
      window.showQuickPick = (async (items: unknown) => {
        const list = items as Array<{ label?: string; detail?: string; origin?: string }>;
        pickerDetails.push(list[0]?.detail ?? "");
        return list.find((item) => item.origin === pick);
      }) as never;

      state.provider = new OllamaProvider();
      const readConfig = async () => {
        const text = await fs.readFile(configPath, "utf8");
        return { text, origin: (JSON.parse(text) as { nameOrigin?: string }).nameOrigin };
      };
      const run = async (label: string): Promise<string> => {
        const messages: CandidatesMessage[] = [];
        const panel = {
          webview: {
            postMessage: async (message: CandidatesMessage) => {
              messages.push(message);
              return true;
            },
          },
        };
        const started = Date.now();
        await suggestNames(panel as never, work, {} as never, target);
        const result = messages.find((message) => message.type === "candidates");
        const note = result?.data.originNote ?? "";
        const origin = /^系統：(.+?)（/u.exec(note)?.[1] ?? "（不明）";
        const config = await readConfig();
        log(
          `${label}：${note}／残った${result?.data.kept.length ?? 0}件・落とした${
            result?.data.dropped.length ?? 0
          }件／覚えた系統=${config.origin ?? "（なし）"}（${Math.round(
            (Date.now() - started) / 1000
          )}秒）`
        );
        log(`    ${result?.data.kept.map((c) => `${c.name}(${c.origin})`).join("・") ?? ""}`);
        return origin;
      };

      log(`\n===== 系統の固定 ${LIVE_MODEL}（${new Date().toISOString()}）`);
      // 1. 覚えていない状態から（毎回消す）
      const unfixed: string[] = [];
      for (let i = 1; i <= 3; i++) {
        await writeBaseConfig();
        unfixed.push(await run(`覚える前${i}`));
      }
      // 2. 覚えたまま
      await writeBaseConfig();
      const first = await run("最初の回");
      const remembered = (await readConfig()).origin;
      expect(remembered, "最初の回で系統を覚えていない").toBeDefined();
      const fixed: string[] = [];
      for (let i = 1; i <= 3; i++) fixed.push(await run(`覚えたあと${i}`));
      log(`  選ぶ画面の「指定なし」の説明：${pickerDetails[pickerDetails.length - 1]}`);
      // 3. 作者が選び直す
      pick = process.env.PROBE_REPICK || "北欧";
      await run(`作者が${pick}を選ぶ`);
      pick = "auto";
      const after = await run("選び直したあとの指定なし");
      const config = await readConfig();
      log(`  覚える前：${unfixed.join(" → ")}`);
      log(`  覚えたあと：${first} → ${fixed.join(" → ")}`);
      log(`  選び直したあと：${after}／config の改行 CRLF のまま=${!/(?:^|[^\r])\n/.test(config.text)}`);

      // AIが時間切れなどで答えなかった回（「（不明）」）は系統を見られないので除く
      // （26b で1回、180秒の時間切れがあった。覚えている系統は変わらなかった）
      const answered = fixed.filter((origin) => origin !== "（不明）");
      expect(answered.length).toBeGreaterThan(0);
      expect(answered.every((origin) => origin === remembered)).toBe(true);
      expect(after).toBe(process.env.PROBE_REPICK || "北欧");
      expect(config.origin).toBe(process.env.PROBE_REPICK || "北欧");
      expect(/(?:^|[^\r])\n/.test(config.text)).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
);
