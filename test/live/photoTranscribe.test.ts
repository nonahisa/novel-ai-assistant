import * as fs from "node:fs";
import * as nodePath from "node:path";
import { expect, test, vi } from "vitest";
import { OllamaProvider } from "../../src/ai/ollamaProvider";
import { parsePhotoTranscription } from "../../src/core/photoTranscribeValidation";
import {
  PHOTO_TRANSCRIBE_NUM_CTX,
  buildPhotoTranscribeRequest,
} from "../../src/prompts/photoTranscribe";
import { LIVE_MODEL } from "./support/liveEnv";

/**
 * 写真の書き起こし（P-48、設計書6.117）を、**手元の Ollama で実際に回す。**
 *
 * 製品と同じ依頼（`buildPhotoTranscribeRequest`）と同じ検算
 * （`parsePhotoTranscription`）を通す。画面の canvas の処理（回す・切る・
 * 長辺2,000pxの JPEG）だけは、先に作っておいた写しで代える。
 *
 * **写真は作者の私的な原稿の材料。** 手元の Ollama だけへ送り、起こした文は
 * リポジトリの外（`NOVELAI_PHOTO_OUT`）へ書く。画面へは数だけを出す。
 *
 *   $env:NOVELAI_PHOTO_PAGES = "C:/path/to/切り分けた写真"   # .jpg を名前の順に
 *   $env:NOVELAI_PHOTO_OUT = "C:/path/to/書き出し先"
 *   $env:NOVELAI_MODEL = "gemma4:26b"
 *   npx vitest run --config vitest.live.config.mts test/live/photoTranscribe.test.ts
 */

vi.mock("../../src/core/logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/core/logger")>()),
  logLine: () => undefined,
  useLogFile: () => undefined,
}));

const pagesDir = process.env.NOVELAI_PHOTO_PAGES?.trim();
const outDir = process.env.NOVELAI_PHOTO_OUT?.trim();
const ready = !!pagesDir && !!outDir && fs.existsSync(pagesDir);

test.skipIf(!ready)(
  "写真を1ページずつ書き起こし、検算を通す（NOVELAI_PHOTO_PAGES・NOVELAI_PHOTO_OUT を指定すると走ります）",
  async () => {
    const files = fs
      .readdirSync(pagesDir as string)
      .filter((name) => /\.jpe?g$/i.test(name))
      .sort();
    fs.mkdirSync(outDir as string, { recursive: true });
    const provider = new OllamaProvider();
    const info = await provider.getModel(LIVE_MODEL);
    const numCtx = Math.min(PHOTO_TRANSCRIBE_NUM_CTX, info?.contextWindow ?? PHOTO_TRANSCRIBE_NUM_CTX);
    const rows: string[] = [
      `モデル ${LIVE_MODEL}（写真を読める申告：${String(info?.imageInput)}）num_ctx ${numCtx}`,
    ];
    for (const file of files) {
      const bytes = fs.readFileSync(nodePath.join(pagesDir as string, file));
      const started = Date.now();
      try {
        const result = await provider.generate({
          ...buildPhotoTranscribeRequest({
            pageLabel: file,
            image: { mimeType: "image/jpeg", base64: bytes.toString("base64") },
            model: LIVE_MODEL,
            numCtx,
          }),
          meta: { feature: "photo_transcribe" },
        });
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        // 生の答えも書き出しの先へ残す（読めなかったときに、崩れ方を数で調べるため）
        fs.writeFileSync(nodePath.join(outDir as string, `${file}.raw.txt`), result.text);
        const parsed = parsePhotoTranscription(result.text);
        if (parsed.ok) {
          fs.writeFileSync(nodePath.join(outDir as string, `${file}.txt`), parsed.value.text);
          rows.push(
            `${file}：${seconds}秒 ${parsed.value.text.split("\n").length}行・${parsed.value.text.length}字・` +
              `〓${parsed.value.unreadable}・英字${parsed.value.latinRuns.length}・説明らしい行${parsed.value.descriptiveLines.length}・` +
              `指示の返り${parsed.value.droppedEchoes}・繰り返しで止めた ${result.stoppedEarly ? `${result.stoppedEarly.stoppedAt}件目` : "なし"}・切れた ${result.truncated}`
          );
        } else {
          rows.push(`${file}：${seconds}秒 読めず（${parsed.reason}）・繰り返しで止めた ${result.stoppedEarly ? "あり" : "なし"}・切れた ${result.truncated}`);
        }
      } catch (error) {
        rows.push(`${file}：失敗 ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    fs.writeFileSync(nodePath.join(outDir as string, "summary.txt"), rows.join("\n"));
    console.log(rows.join("\n"));
    expect(rows.length).toBe(files.length + 1);
  },
  60 * 60 * 1000
);
