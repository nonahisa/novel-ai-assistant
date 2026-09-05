import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as nodePath from "node:path";

/**
 * 応答の見込み（`maxOutputTokens`）を、どの機能がAIへ渡すか
 * （設計書6.65.16の2、6.77の第2段）。
 *
 * ## なぜソースを見るのか
 *
 * `aiTurnWiring.test.ts` と同じ理由である。一括機能を本物どおりに
 * 走らせるには作品フォルダー・設定資料・キャッシュ・プロバイダを
 * すべて用意することになり、確かめたい1点（渡しているか）に対して
 * 仕掛けが大きすぎる。**書き忘れは「無い」ことなので、無いことを
 * 見る検査でよい。**
 *
 * 値そのものの決め方は `outputLimit.test.ts`
 * （`resolveOutputTokensForPlanning` の `min(設定, 実測)`）が、
 * 渡した値が実際にAPIへ載ることは `providerOutputLimit.test.ts` が見ている。
 *
 * ## なぜ「渡す」ことが要るのか
 *
 * 渡さないと、送信直前の関所（`ai/meteredProvider.ts`）も実送信も
 * グローバル設定（既定16,384）で動く。台帳に実測がある——つまり
 * 「このモデルは実際には6,500トークンしか書けない」と分かっている
 * ——モデルでも、16,384を確保したうえで送ることになる。
 * 非力な機械では、その差がそのまま無駄なメモリになる。
 */
const FEATURES = nodePath.join(__dirname, "..", "..", "src", "features");
const AI = nodePath.join(__dirname, "..", "..", "src", "ai");

function read(file: string): string {
  return fs.readFileSync(nodePath.join(FEATURES, file), "utf8");
}

function readAi(file: string): string {
  return fs.readFileSync(nodePath.join(AI, file), "utf8");
}

/**
 * `.generate({ … })` の引数だけを切り出す。
 *
 * **単純な `includes` では足りない。** 1つのファイルに呼び出しが2つ
 * ある（相談パネルの本体と検索語づくり、紹介文とキャッチコピー）ので、
 * ファイルのどこかに `maxOutputTokens` があるだけでは
 * 「目当ての呼び出しに付いている」ことにならない。
 */
/**
 * その呼び出しが、その名前の**欄**を持っているか。
 *
 * **単語を探すだけでは足りない。** `maxOutputTokens: plannedOutputTokens`
 * と書くと、文字列としては両方が現れる——欄は1つしか無いのに、2つ渡した
 * ように見えてしまう（実際にこの検査が一度だまされた）。欄として書かれて
 * いること——**欄が始まる位置**（行頭、`{` の直後、`,` の直後）にあり、
 * 後ろが `:`（または省略記法なら `,` か行末）——を見る。
 * `maxOutputTokens: plannedOutputTokens` の右辺は欄が始まる位置に無いので、
 * これで弾ける。
 */
function hasField(call: string, name: string): boolean {
  return new RegExp(`(^|[{,])\\s*${name}\\s*(:|,|$)`, "m").test(call);
}

function generateCalls(source: string): string[] {
  const calls: string[] = [];
  const marker = ".generate({";
  let from = 0;
  for (;;) {
    const start = source.indexOf(marker, from);
    if (start < 0) break;
    let depth = 0;
    let index = start + marker.length - 1;
    for (; index < source.length; index++) {
      if (source[index] === "{") depth++;
      else if (source[index] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    calls.push(source.slice(start, index + 1));
    from = index + 1;
  }
  return calls;
}

/**
 * 2つの欄を**両方**渡す機能と、その呼び出しを見分ける印。
 *
 * **記録の feature 名で指す。** 行番号で指すと、上の行が1つ増えただけで
 * 検査が別の呼び出しを見にいく。名前を変数で渡している機能
 * （単話プロット）だけは、その変数名を印にしている。
 *
 * **片方だけでは足りない**（設計書6.77の第2段）。実上限だけだと非力な
 * 機械で `num_ctx` が育ち、見込みだけだと測っていないモデルで上限が
 * 設定値の半分になって応答が切れる。
 */
const PASSES_BOTH_TOKENS: Array<[file: string, marker: string]> = [
  // もともと渡していた8機能
  ["checkTypos.ts", '"typo_check"'],
  ["checkProofread.ts", '"proofread"'],
  ["checkContradictions.ts", '"contradiction_check"'],
  ["checkContradictions.ts", '"contradiction_verify"'],
  ["checkForeshadows.ts", '"foreshadow_detect"'],
  ["checkForeshadows.ts", '"foreshadow_resolve"'],
  ["checkEpisodePlot.ts", "feature: options.feature"],
  ["extractCharacters.ts", '"character_extract"'],
  ["generateAnnouncement.ts", '"announce"'],
  ["proposeChapters.ts", '"chapter_propose"'],
  // 0.32.11で足した4機能（設計書6.77の第2段）
  ["checkDeviations.ts", '"deviation_check"'],
  ["generateSynopses.ts", '"synopsis"'],
  ["generateBlurb.ts", '"blurb"'],
  ["workChatPanel.ts", '"work_chat"'],
  // 0.33.8で残っていた9か所（設計書6.77の第2段その1の細部6「残る宿題」）。
  // **12機能に配った時点で残りを放置すると、関所だけが設定値で数える。**
  // 見た目には動くので、非力な機械で `num_ctx` が育っていることに
  // 誰も気づけない——実際、0.32.11から0.33.8まで気づかれなかった
  ["generateBlurb.ts", '"catchphrase"'],
  ["checkOpening.ts", '"opening_check"'],
  ["generatePlot.ts", '"plot_reverse"'],
  ["nameCheck.ts", '"name_suggest"'],
  ["notationAdvice.ts", '"notation_advice"'],
  ["recheckProposal.ts", '"recheck"'],
  // 検索語づくりは相談1回に付随してもう1回呼ぶ（P-22）。**本体だけに
  // 配っても、相談1回のうち半分は設定値のままになる**
  ["workChatPanel.ts", '"search_terms"'],
  ["settingsPanel.ts", '"search_terms"'],
  ["settingsPanel.ts", '"settings_enrich"'],
];

describe("出力トークンの2つの欄の配り先", () => {
  test.each(PASSES_BOTH_TOKENS)(
    "%s の %s の呼び出しは、実上限と見込みの両方を渡す",
    (file, marker) => {
      const call = generateCalls(read(file)).find((text) =>
        text.includes(marker)
      );

      expect(
        call,
        `${marker} を含む generate 呼び出しが見つからない`
      ).toBeDefined();
      expect(hasField(call!, "maxOutputTokens"), "実上限が無い").toBe(true);
      expect(hasField(call!, "plannedOutputTokens"), "見込みが無い").toBe(true);
    }
  );

  test.each([...new Set(PASSES_BOTH_TOKENS.map(([file]) => file))])(
    "%s は2つの値を専用の関数で決める",
    (file) => {
      // **`resolveMaxOutputTokens()` を直接使わない。** 直接使うと、
      // 台帳に実測が付いても値が設定値のまま古びる（設計書6.65.16の2）。
      // 落ちたときにファイル全文が出ないよう、真偽で確かめる
      const source = read(file);
      expect(
        source.includes("resolveOutputTokensForPlanning"),
        `${file} が resolveOutputTokensForPlanning を使っていない`
      ).toBe(true);
      // **値だけを取る口（`…TokensForSend`）と、値と出どころを取る口
      // （`…LimitForSend`）のどちらでもよい。** 中で同じ判定を通るので、
      // 決め方は1か所のままである（出どころは切り詰めの案内に使う）
      expect(
        source.includes("resolveOutputTokensForSend") ||
          source.includes("resolveOutputLimitForSend"),
        `${file} が実上限を専用の関数で決めていない`
      ).toBe(true);
    }
  );
});

/**
 * 読める長さの測定（合言葉の往復）は、**見込みだけを渡す**
 * （設計書6.77の第2段）。
 *
 * 128トークンは「合言葉2つ＋前置きが収まる」見込みであって、上限では
 * ない。上限として送ると、前置きの長い機種で末尾の合言葉が落ち、
 * **読めていたのに「読めなかった」と判定する**——`PROBE_OUTPUT_TOKENS`
 * のコメントが恐れているのは、まさにこれである。
 *
 * 書ける量の測定（`measureOutputLimit`）は逆で、**上限を送るのが目的**
 * なので `maxOutputTokens` のままにする。
 */
describe("測定の2つの呼び出し", () => {
  const source = read("measureContext.ts");

  test("読める長さの測定は、見込みだけを渡す", () => {
    const call = generateCalls(source).find((text) =>
      text.includes("prompt.systemPrompt")
    );

    expect(call, "合言葉の往復の generate 呼び出しが見つからない").toBeDefined();
    expect(call).toContain("plannedOutputTokens: PROBE_OUTPUT_TOKENS");
    expect(hasField(call!, "maxOutputTokens"), "実上限を送っている").toBe(false);
  });

  test("書ける量の測定は、上限として送る", () => {
    const call = generateCalls(source).find((text) =>
      text.includes("OUTPUT_PROBE_SYSTEM_PROMPT")
    );

    expect(call, "書ける量の測定の generate 呼び出しが見つからない").toBeDefined();
    expect(hasField(call!, "maxOutputTokens"), "実上限を送っていない").toBe(true);
    expect(call).toContain("capOutputTokens: true");
  });
});

/**
 * **配らないと決めた呼び出しと、その理由**（設計書6.77の第2段その1）。
 *
 * 0.33.8で残りを配ったとき、配らなかったものを**書き留めずに済ませない。**
 * 一覧に無いと、次に読む人は「配り忘れ」と読んで足しにいく——理由のある
 * 例外は、理由ごと検査に残す。
 */
describe("2つの欄を、意図して配らない呼び出し", () => {
  /**
   * 独り言の感想は、返らせるのが1文だけである（`maxOutputTokens: 200`）。
   *
   * **見込みを配ると、かえって大きくなる。** `resolveOutputTokensForPlanning`
   * は `min(設定, 実測 ?? 8,192)` なので、どう転んでも200より大きい値が
   * 出る。関所は `見込み → 実上限` の順で読む（Ollama）ため、200と書いて
   * あるのに8,192ぶんの席を確保することになる。**ここは実測より正確な値を
   * 呼び出し側が知っている、数少ない場所である。**
   */
  test("独り言の感想は、200の固定だけを渡す", () => {
    const call = generateCalls(read("chatterComment.ts")).find((text) =>
      text.includes('"chatter_comment"')
    );

    expect(call, "独り言の generate 呼び出しが見つからない").toBeDefined();
    expect(call).toContain("maxOutputTokens: 200");
    expect(hasField(call!, "plannedOutputTokens"), "見込みを渡している").toBe(
      false
    );
  });

  /**
   * 生成の下見（接続テスト）は、**どの欄も渡さない。**
   *
   * ここが答えるのは「このあと抽出を始めてよいか」だけで、送るのは
   * 15字・返るのは「はい」の一言である。**大きさの摘みを1つでも決め打ちすると、
   * 確認するはずの処理が確認の対象を壊す**——`numCtx: 1024` を書いていた
   * ときに `gemma4:26b` の読み込みがスタック破壊で落ちた（設計書6.62）。
   * `plannedOutputTokens` は `numCtx` と同じ受け皿（`contextSizeForPrompt`）へ
   * 入るので、同じ摘みを別の名前で戻すことになる。
   *
   * 配っても得るものが無い。クラウド5社は渡さなければ設定値をモデル上限で
   * 丸めて送り（`clampToModelLimit`）、Ollama は `num_predict` を送らない。
   */
  test("生成の下見は、どちらの欄も渡さない", () => {
    const call = generateCalls(readAi("generationProbe.ts"))[0];

    expect(call, "下見の generate 呼び出しが見つからない").toBeDefined();
    expect(hasField(call!, "maxOutputTokens"), "実上限を渡している").toBe(false);
    expect(hasField(call!, "plannedOutputTokens"), "見込みを渡している").toBe(
      false
    );
  });
});

/**
 * 応答が上限で切り詰められたときに、**そう言えること。**
 *
 * 上限を下げうる変更を入れるなら、下がったときに作者へ理由が届かないと
 * いけない。切り詰めを「応答を読み取れませんでした」としか言えないと、
 * 作者からはAIの気まぐれと区別が付かない。
 */
describe("切り詰めを、切り詰めとして伝える", () => {
  test.each([
    "generateSynopses.ts",
    "checkDeviations.ts",
    "generateBlurb.ts",
    "workChatPanel.ts",
  ])("%s は response.truncated を見て理由を分ける", (file) => {
    const source = read(file);

    expect(
      source.includes(".truncated"),
      `${file} が切り詰めを見ていない`
    ).toBe(true);
    expect(
      source.includes("切り詰め"),
      `${file} に切り詰めを伝える文言が無い`
    ).toBe(true);
  });
});
