import type { AIProvider } from "../ai/types";
import { logStep } from "../core/logger";
import { readTextFile } from "../core/textFile";
import type { WorkEntry } from "../models/types";
import {
  buildChatterCommentPrompt,
  CHATTER_COMMENT_EXCERPT_CHARS,
  CHATTER_COMMENT_MIN_CHARS,
  CHATTER_COMMENT_SCHEMA,
  CHATTER_COMMENT_SYSTEM_PROMPT,
  CHATTER_COMMENT_VERSION,
  parseChatterComment,
  tailExcerpt,
} from "../prompts/chatterComment";

/**
 * 本文を読んで言う一言を、AIから1つもらう（設計書6.21.4、P-34）。
 *
 * **呼ばれるのは「言ってよい」と決まってからだけである**
 * （`features/chatterService.ts` が判断する）。ここは材料をそろえて
 * 1回だけ投げる役に徹する。
 *
 * 言えないときは `undefined` を返す。**理由は返さない**——独り言は
 * 黙るのが既定であって、黙った理由を画面に出す先が無い。
 * 呼び出し側は返り値を検査（`core/chatterCommentValidation.ts`）に通す。
 */
export async function requestChatterComment(
  work: WorkEntry,
  manuscriptPath: string,
  resolve: () => { provider: AIProvider; model: string } | undefined,
  abortSignal: AbortSignal
): Promise<string | undefined> {
  const resolved = resolve();
  if (!resolved) return undefined;

  // **有料のAIでは動かさない。** 独り言の側でも見ているが、ここでも見る
  // ——割当は判断のあとでも変わりうるし、実際に金を使うのはこの行の先である
  if (resolved.provider.isPaid) return undefined;

  const content = await readTextFile(manuscriptPath);
  // 競合マーカーの残った本文はAIへ渡さない（実装ルール1）。
  // 取り込み途中の断片を読ませても、まともな感想にはならない
  if (content.hasConflictMarkers) return undefined;

  const excerpt = tailExcerpt(content.text, CHATTER_COMMENT_EXCERPT_CHARS);
  // 書きかけの数行に「盛り上がってきましたね」は的外れになる
  if ([...excerpt].length < CHATTER_COMMENT_MIN_CHARS) return undefined;

  // **どの版・どのモデルで訊いたかを残す**（ほかのAI機能と同じ流儀）。
  // 独り言は画面に何も出さずに黙ることがあるので、記録が無いと
  // 「呼んだのか、そもそも呼ばなかったのか」すら分からない
  logStep(
    `独り言の感想: v${CHATTER_COMMENT_VERSION} / ${resolved.model}` +
      ` / 本文${excerpt.length}字`
  );

  const result = await resolved.provider.generate({
    systemPrompt: CHATTER_COMMENT_SYSTEM_PROMPT,
    userPrompt: buildChatterCommentPrompt({
      workTitle: work.title,
      excerpt,
    }),
    model: resolved.model,
    // 感想なので少し幅を持たせる。0にすると同じ言い回しが毎日出る
    temperature: 0.7,
    jsonSchema: CHATTER_COMMENT_SCHEMA as unknown as object,
    // 抽出と同じく、考えさせる必要が無いぶん速いほうがよい
    disableThinking: true,
    // 返らせるのは1文だけ。受け皿の見積もりに使う
    maxOutputTokens: 200,
    // **numCtx は渡さない。** 送るのは末尾1,500字だけなので、
    // 受け皿（プロバイダ側）が送る文字数から見積もるほうが正確になる
    //
    // 中止の合図は、独り言の側の30秒の締め切りから来る。
    // 省略形で書かないのは、配線をソースの形で見張っている検査
    // （`generateCancellation.test.ts`）が `signal:` を探すためである
    signal: abortSignal,
    meta: {
      feature: "chatter_comment",
      workFolder: work.folderPath,
      parts: { 本文: excerpt.length },
    },
  });

  return parseChatterComment(result.text);
}
