/**
 * 機能別AI割当（クラウドのAI）で、AI設定と同じ流れ（鍵→接続→モデル→生成の確かめ）が通る
 * （画面の自動テスト、設計書6.28.7・6.113。2026-10-18）。
 *
 * 実機確認リスト「割り当てるとき、AI設定と同じ流れ（鍵→接続→モデル→生成テスト）が通るか」を、
 * **偽のサーバー**で機械へ移したもの。ChatGPT（OpenAI 互換）の行き先 `novelai.openai.endpoint` を、
 * この機械の 127.0.0.1 の小さな HTTP サーバーへ向ける（使い捨ての user-data の中だけ。**本物のクラウドは呼ばない**）。
 * 鍵は**テスト用の作り物の文字列**を、作者の資格情報の置き場ではなく使い捨ての user-data の保管庫へ入れる。
 *
 * 見張るのは次のとおり：
 * - 「機能別AI割当」→ 機能（誤字脱字検知）→「使うAIを選ぶ…」→ プロバイダ（ChatGPT）の順に選ぶ
 * - **鍵の入力**（題「ChatGPTのAPIキーを入力してください」）が出て、打つと進む
 * - **接続の確認**：偽のサーバーが `/models` を、鍵つき（`Authorization: Bearer <打った鍵>`）で受ける
 * - **モデルの選択**：偽のサーバーが返したモデルが一覧に出る。選ぶ
 * - **生成の確かめ**：偽のサーバーが `/chat/completions` を、選んだモデル名で受ける（実際に1回生成を試す）
 * - 通ったあと、知らせ「誤字脱字検知 は ChatGPT（<モデル>）で実行するようにしました。」に
 *   **課金の注意「実行のたびに課金されます」**が付く
 *
 * AI の答えの出来は見えない（偽のサーバーは決まった答えを返すだけ）。課金・本物の鍵は使わない。
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "vitest";
import { answerInput, runCommand, waitForQuickInput } from "./support/quickInput";
import { withVsCode } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { pickQuickPickRow, quickPickRows, quickPickTitle, waitForQuickPick } from "./support/workbenchDom";

const MODEL = "gpt-e2e-mini";
const API_KEY = "sk-e2e-test-key-0123456789abcdef0123456789";

interface Seen {
  method: string;
  url: string;
  authorization: string;
  model?: string;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** 偽の OpenAI 互換サーバー（`/models` と `/chat/completions`） */
async function startFakeOpenAi(): Promise<{ endpoint: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = request.url ?? "/";
      const body = request.method === "POST" ? await readBody(request) : "";
      let model: string | undefined;
      try {
        model = (JSON.parse(body || "{}") as { model?: string }).model;
      } catch {
        model = undefined;
      }
      seen.push({ method: request.method ?? "", url, authorization: String(request.headers.authorization ?? ""), ...(model ? { model } : {}) });
      const sendJson = (value: unknown): void => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (url.endsWith("/models")) {
        sendJson({ object: "list", data: [{ id: MODEL, object: "model" }] });
        return;
      }
      if (url.endsWith("/chat/completions")) {
        sendJson({
          id: "chatcmpl-e2e",
          object: "chat.completion",
          model: model ?? MODEL,
          choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
        });
        return;
      }
      response.writeHead(404);
      response.end();
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    endpoint: `http://127.0.0.1:${port}/v1`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

test("機能別AI割当でChatGPTを選ぶと、鍵の入力→接続（鍵つき）→モデルの一覧→生成の確かめまで通り、課金の注意つきの知らせが出る", async () => {
  const fake = await startFakeOpenAi();
  try {
    await withVsCode(
      "割当のクラウドの流れ",
      [{ name: "001_はじまり.txt", text: "朝の駅は静かだった。\n" }],
      async (session) => {
        const { page } = session;
        await runCommand(page, "機能別AI割当");

        // 機能を選ぶ
        const features = await waitForQuickPick(page, "どの機能のAIを変えますか");
        const typo = features.find((row) => row.label.includes("誤字脱字"));
        expect(typo, `機能の一覧に誤字脱字が無い（${JSON.stringify(features.map((row) => row.label))}）`).toBeTruthy();
        await pickQuickPickRow(page, typo?.label ?? "誤字脱字");

        // 使うAIを選ぶ…
        await waitUntil(async () => ((await quickPickTitle(page)) ?? "").endsWith("で使うAI"), "「<機能> で使うAI」が出る", 15_000);
        await pickQuickPickRow(page, "使うAIを選ぶ");

        // プロバイダ（ChatGPT）
        const providers = await waitForQuickPick(page, "使用するAIを選んでください（1つで構いません）");
        const chatgpt = providers.find((row) => row.label.includes("ChatGPT"));
        expect(chatgpt, `プロバイダの一覧に ChatGPT が無い（${JSON.stringify(providers.map((row) => row.label))}）`).toBeTruthy();
        await pickQuickPickRow(page, chatgpt?.label ?? "ChatGPT");

        // 鍵の入力
        await waitForQuickInput(page, "ChatGPTのAPIキーを入力してください");
        await answerInput(page, API_KEY);

        // 接続の確認（偽のサーバーが鍵つきで /models を受ける）
        await waitUntil(async () => fake.seen.some((entry) => entry.url.endsWith("/models")), "偽のサーバーが /models を受ける", 30_000).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（受けた頼み：${JSON.stringify(fake.seen)}／いまの題：${JSON.stringify(await quickPickTitle(page))}）`);
        });
        const models = fake.seen.find((entry) => entry.url.endsWith("/models"));
        expect(models?.authorization, "接続の確認が、打った鍵（Bearer）つきで送られていない").toBe(`Bearer ${API_KEY}`);

        // モデルの選択（偽のサーバーが返したモデルが出る）
        const modelRows = await waitForQuickPick(page, "使用するモデルを選んでください");
        expect(modelRows.some((row) => row.label.includes(MODEL)), `モデルの一覧に ${MODEL} が無い（${JSON.stringify(modelRows.map((row) => row.label))}）`).toBe(true);
        await pickQuickPickRow(page, MODEL);

        // 生成の確かめ（偽のサーバーが選んだモデル名で /chat/completions を受ける）
        await waitUntil(async () => fake.seen.some((entry) => entry.url.endsWith("/chat/completions")), "偽のサーバーが /chat/completions を受ける（生成の確かめ）", 30_000).catch(
          async (error: unknown) => {
            throw new Error(`${String(error)}（受けた頼み：${JSON.stringify(fake.seen)}／行：${JSON.stringify((await quickPickRows(page).catch(() => [])).map((row) => row.label))}）`);
          }
        );
        const generated = fake.seen.find((entry) => entry.url.endsWith("/chat/completions"));
        expect(generated?.model, "生成の確かめが、選んだモデル名で送られていない").toBe(MODEL);
        expect(generated?.authorization, "生成の確かめが、打った鍵つきで送られていない").toBe(`Bearer ${API_KEY}`);

        // 通ったあとの知らせ：割り当てたことと、課金の注意
        let toast = "";
        await waitUntil(
          async () => {
            const toasts = await page.locator(".notification-toast").allInnerTexts();
            toast = toasts.find((text) => text.includes("で実行するようにしました")) ?? "";
            return toast !== "";
          },
          "「…で実行するようにしました。」の知らせが出る",
          30_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（知らせ：${JSON.stringify(await page.locator(".notification-toast").allInnerTexts())}／受けた頼み：${JSON.stringify(fake.seen)}）`);
        });
        expect(toast, "知らせに機能名が無い").toContain("誤字脱字");
        expect(toast, "知らせにプロバイダとモデルが無い").toContain(MODEL);
        expect(toast, "有料のAIなのに、課金の注意が付いていない").toContain("実行のたびに課金されます");
      },
      { settings: { "novelai.openai.endpoint": fake.endpoint } }
    );
  } finally {
    await fake.close();
  }
}, 240_000);
