import * as fsSync from "node:fs";
import { expect, test, vi } from "vitest";
import { workspace } from "../unit/support/vscodeStub";
import { OllamaProvider } from "../../src/ai/ollamaProvider";
import type { WorkEntry } from "../../src/models/types";
import { LIVE_MODEL } from "./support/liveEnv";

/**
 * 相談で、操作を**実行したふり**の答えに断りが付くか（0.86.10 の担当の報告）を、
 * 手元の Ollama で回す。旧名で頼まれた gemma4:26b が「診断を実行します」と
 * 答えた問いと、同じ形の頼みを並べる。
 *
 * 相談パネル（`WorkChatPanel.ask`）へ質問を送り、答え・実行ボタン・断り（note）を
 * 書き出す。**材料集め（本文の抜粋・関連資料）だけを空に差し替える**——見たいのは
 * 答えの言い切りと断りで、材料の中身には依らない。指示文・目次・検算は製品のまま。
 *
 *   $env:PROBE_CHAT_CLAIM = "1"
 *   $env:NOVELAI_MODEL = "gemma4:26b"
 *   $env:PROBE_REPEAT = "2"（同じ問いを何回送るか。既定 2）
 *   $env:PROBE_OUT = "結果を書き出すファイル"（任意）
 *   npx vitest run --config vitest.live.config.mts test/live/chatExecutionClaim.test.ts
 */

vi.mock("../../src/core/chatLog", () => ({
  appendChatLog: () => undefined,
  summarizeMaterials: () => [],
}));
vi.mock("../../src/core/logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/core/logger")>()),
  logFailure: (...args: unknown[]) => log(`（ログ・失敗）${JSON.stringify(args)}`),
  logStep: (text: string) => {
    if (text.startsWith("相談:")) log(`（ログ）${text}`);
  },
  logLine: () => undefined,
  useLogFile: () => undefined,
}));
vi.mock("../../src/features/aiConnectivity", () => ({
  confirmProviderReachable: async () => true,
  confirmPaidUsage: async () => true,
}));

const { WorkChatPanel } = await import("../../src/features/workChatPanel");

const OUT = process.env.PROBE_OUT;
function log(text: string): void {
  if (OUT) fsSync.appendFileSync(OUT, `${text}\n`);
}

const ENABLED = process.env.PROBE_CHAT_CLAIM === "1";
const REPEAT = Number(process.env.PROBE_REPEAT ?? 2);

const QUESTIONS = [
  // 0.86.10 の担当の報告の問い（旧名）
  "ターゲット読者診断を実行して",
  "ターゲット読者診断をお願いします",
  // 3.13 のきっかけの形（「実行して」）
  "冒頭診断を実行してください",
  // 実行ボタンが付くはずの頼み（断りは付かないはず）
  "誤字脱字を検知して",
];

const WORK: WorkEntry = {
  id: "w_probe",
  title: "ギルド（作り物）",
  folderPath: "C:\\novels\\probe",
  registeredAt: "2026-09-25T00:00:00.000Z",
};

interface Posted {
  type: string;
  reply?: string;
  message?: string;
  run?: { label?: string };
}

test.skipIf(!ENABLED)(
  `相談の実行したふりに断りが付く（${LIVE_MODEL}）${ENABLED ? "" : "——PROBE_CHAT_CLAIM=1 で走ります"}`,
  { timeout: 1_800_000 },
  async () => {
    workspace.getConfiguration = (() => ({
      get: <T>(_key: string, defaultValue: T): T => defaultValue,
      update: async () => undefined,
    })) as unknown as typeof workspace.getConfiguration;

    const provider = new OllamaProvider();
    log(`\n===== 相談の実行したふり ${LIVE_MODEL}（${new Date().toISOString()}）`);
    let claims = 0;
    let notes = 0;
    for (const question of QUESTIONS) {
      for (let round = 1; round <= REPEAT; round++) {
        const posted: Posted[] = [];
        const panel = new WorkChatPanel(
          { list: () => [WORK] } as never,
          {
            onDidChangeSelection: () => ({ dispose: () => undefined }),
            resolve: () => ({ provider, model: LIVE_MODEL }),
          } as never,
          { run: async () => undefined } as never
        );
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const inner = panel as any;
        inner.findRelated = async () => ({ reference: [], searchTerms: [], materials: [] });
        inner.resolveContext = async () => ({
          work: WORK,
          kind: "workOnly",
          filePath: WORK.folderPath,
          label: WORK.title,
          excerpt: "",
          truncated: false,
          fromSelection: false,
          reference: [],
        });

        const started = Date.now();
        await inner.ask(question);
        const answer = posted.find((message) => message.type === "answer");
        const note = posted.find(
          (message) => message.type === "note" && message.message?.includes("動かせないため")
        );
        const error = posted.find((message) => message.type === "error");
        log(
          `\n[${question}]（${round}回目・${Math.round((Date.now() - started) / 1000)}秒）` +
            `\n  答え：${(answer?.reply ?? error?.message ?? "（なし）").replace(/\n/g, " ")}` +
            `\n  実行ボタン：${answer?.run?.label ?? "（なし）"}` +
            `\n  断り：${note?.message ?? "（なし）"}`
        );
        if (note) notes++;
        if (/実行(?:いた)?し(?:ます|ました)|開始し|お待ち/u.test(answer?.reply ?? "")) claims++;
        expect(answer ?? error, "答えが出ない").toBeDefined();
      }
    }
    log(`\n  言い切りを含む答え（粗い数え方）${claims}件／断りを添えた ${notes}件`);
  }
);
