import * as vscode from "vscode";
import { AIRegistry, ensureConfigured } from "../ai/registry";
import { AIError, recoveryForAIError, type ProviderId } from "../ai/types";
import { CONTEXT_GUARD_EXEMPT_FEATURE } from "../ai/contextGuard";
import { TOKENS_PER_CHAR } from "../core/chunker";
import {
  buildProbePrompt,
  describeProbeResult,
  judgeProbeAnswer,
  makeProbeWords,
  nextProbeSize,
  probeCharsToTokens,
  probeOverheadChars,
  startProbeState,
  worstCaseProbeChars,
  MIN_PROBE_CHARS,
  type ProbeSides,
  type ProbeState,
} from "../core/contextProbe";
import { logFailure, logStep, showLog } from "../core/logger";
import { withCancellableProgress } from "../views/progress";
import { confirmPaidUsage } from "./aiConnectivity";

/**
 * AIが実際に読める長さを測る（設計書6.27.11）。
 *
 * 詰め物の先頭と末尾に合言葉を置いて送り、**両方返ってくる最大の
 * 字数**を二分探索で探す。組み立てと判定は `core/contextProbe.ts`
 * にあり、ここは「送る・数える・作者へ見せる」だけを持つ。
 *
 * **作品は要らない。** 測っているのはモデルの性質であって、
 * 作品の性質ではない。
 */

/**
 * 応答に見込むトークン。
 *
 * 書き写すのは合言葉2つだけだが、**余裕を持たせる。** 足りないと
 * 「承知しました。最初の合言葉は…」と前置きした機種で答えが途中で
 * 切れ、末尾の合言葉が落ちる——**読めていたのに「読めなかった」**と
 * 判定してしまう。少なすぎて誤判定するほうが、多すぎて損するより悪い。
 */
const PROBE_OUTPUT_TOKENS = 128;

/**
 * 申告値がどれだけ小さくても、ここまでは試す。
 *
 * 256Kトークン相当（約180,000字）。**申告値で頭打ちにしない**——
 * さくらのAI Engine の申告値は、作者が設定に書いた当て推量であり、
 * そこで止めると「申告以上に読めるか」が永久に分からない
 * （関所も、この測定のときだけ素通りする。`ai/contextGuard.ts`）。
 *
 * これ以上を既定にはしない。有料AIでは、測るだけで払う額が増える。
 */
const MIN_CEILING_TOKENS = 256 * 1024;

/**
 * 測った値を書き戻せる設定。
 *
 * **申告値を取れないプロバイダだけ**が対象である。Ollama・Gemini・
 * Claude はモデル側から上限を取れるので、こちらが上書きすると
 * 「取れる正しい値」を手書きの値で潰すことになる（参考表示にとどめる）。
 */
const WRITABLE_CONTEXT_SETTING: Partial<Record<ProviderId, string>> = {
  sakura: "sakura.contextWindow",
  lmstudio: "lmstudio.contextWindow",
  openai: "openai.contextWindow",
};

/** 1回ぶんの結果。ログの1行になる */
type RoundOutcome =
  | "両方"
  | "先頭のみ"
  | "末尾のみ"
  | "無し"
  | "関所で止まった";

export async function measureContext(registry: AIRegistry): Promise<void> {
  // 測るのは「使用するAI」。機能ごとの割当は、それぞれの機能が
  // 自分の割当先を使うので、既定を測っておけば基準になる
  const resolved = await ensureConfigured(registry, "default");
  if (!resolved) return;

  const modelInfo = await registry.resolveModelInfo("default");
  const declaredTokens = modelInfo?.contextWindow;
  const ceilingChars = ceilingCharsFor(declaredTokens);

  // 見込みは「各回の詰め物の合計」。探索の枝を全部たどった最大なので、
  // 実際にはこれより少なく済む（`worstCaseProbeChars` に理由）
  const estimateTokens = probeCharsToTokens(worstCaseProbeChars(ceilingChars));
  const ok = await confirmPaidUsage(resolved.provider, {
    actionLabel: "AIが実際に読める長さを測る",
    model: resolved.model,
    detail:
      `最大で約 ${ceilingChars.toLocaleString("ja-JP")} 字まで、` +
      "長さを変えながら10回ほど送ります。\n" +
      `送る量は、多く見て合計 約 ${estimateTokens.toLocaleString("ja-JP")} ` +
      "トークンです（途中で決まれば、これより少なく済みます）。\n" +
      "送るのは検査用の詰め物だけで、作品の本文は送りません。",
  });
  if (!ok) return;

  logStep(
    `読める長さの測定を開始: ${resolved.provider.displayName} / ` +
      `${resolved.model} / 申告 ${declaredTokens ?? "不明"} トークン / ` +
      `測れる上限 ${ceilingChars} 字`
  );

  const sides: ProbeSides = { headDropped: false, tailDropped: false };
  /** 両方返った最大の字数 */
  let low = 0;
  let rounds = 0;
  let failure: unknown;
  let cancelled = false;

  await withCancellableProgress(
    "AIが実際に読める長さを測っています",
    async (progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());

      let state: ProbeState | undefined = startProbeState(ceilingChars);
      while (state) {
        // 回と回の間で押されたときは、次を送らずに抜ける。
        // 送っている最中の中止は `signal` が受ける
        if (token.isCancellationRequested) {
          cancelled = true;
          return;
        }
        rounds += 1;
        const size = state.current;
        progress.report({
          message: `${size.toLocaleString("ja-JP")} 字を送っています（${rounds}回目）…`,
        });

        // **毎回ちがう合言葉にする。** 同じ語を使い回すと、
        // プロンプトキャッシュの効いた回が「読めた」に見えかねない
        const { headWord, tailWord } = makeProbeWords(Math.random);
        const prompt = buildProbePrompt({
          fillerChars: size,
          headWord,
          tailWord,
        });

        let outcome: RoundOutcome;
        try {
          const response = await resolved.provider.generate({
            systemPrompt: prompt.systemPrompt,
            userPrompt: prompt.userPrompt,
            model: resolved.model,
            // 書き写すだけなので、揺らす理由がまったく無い
            temperature: 0,
            maxOutputTokens: PROBE_OUTPUT_TOKENS,
            disableThinking: true,
            // 作品に属さない呼び出しなので workFolder は付けない
            // （どこかの作品の送信量に混ぜると、その作品の数字が狂う）。
            //
            // **機能名は関所側の定数から取る。** 文字列を写すと、
            // 片方を直したときに素通りの例外が静かに外れ、
            // 測定が申告値で頭打ちになったことに誰も気づけない
            meta: { feature: CONTEXT_GUARD_EXEMPT_FEATURE },
            signal: controller.signal,
          });
          const judged = judgeProbeAnswer(response.text, headWord, tailWord);
          outcome = judged.head
            ? judged.tail
              ? "両方"
              : "先頭のみ"
            : judged.tail
              ? "末尾のみ"
              : "無し";
          // 応答が上限で切れると、合言葉が答えの中から落ちる。
          // 「読めていない」と取り違えないよう、記録に残す
          if (response.truncated) {
            logStep(
              `読める長さの測定：${size}字 → 応答が出力上限で切れました（判定が甘くなります）`
            );
          }
        } catch (error) {
          // 作者が止めたときは、途中まででも分かったことを見せる
          if (error instanceof AIError && error.kind === "aborted") {
            cancelled = true;
            return;
          }
          // **関所（6.27.10）は、この測定のときだけ素通りする**ので、
          // ここへは普通は来ない（`ai/contextGuard.ts`）。残してあるのは
          // 保険である——プロバイダ側が「長すぎる」を
          // `context_overflow` で返してくることはありうる。
          // どちらにせよ「その長さでは渡せない」ことに変わりはない
          if (error instanceof AIError && error.kind === "context_overflow") {
            outcome = "関所で止まった";
          } else {
            failure = error;
            return;
          }
        }

        logStep(`読める長さの測定：${size}字 → ${outcome}`);

        // 片方だけ返った回は、どちら側が切られるかの証拠になる。
        // **1回でも出れば記録する**（毎回出るとは限らない）
        if (outcome === "先頭のみ") sides.tailDropped = true;
        if (outcome === "末尾のみ") sides.headDropped = true;

        const bothReturned = outcome === "両方";
        if (bothReturned) low = Math.max(low, size);
        state = nextProbeSize(state, bothReturned);
      }
    }
  );

  if (failure) {
    reportFailure(failure);
    return;
  }

  // 中止しても、通った長さが分かっていれば見せる。
  // 有料AIでは、ここまでの呼び出しの代金はもう払っている
  if (cancelled && low <= 0) {
    logStep("読める長さの測定：中止しました。");
    return;
  }

  const summary = describeProbeResult({ low, sides, ceilingChars });
  logStep(
    `読める長さの測定を終了: ${rounds}回 / ${summary}` +
      (cancelled ? "（中止したため、途中までの結果です）" : "")
  );

  await offerToSave({
    providerId: resolved.provider.id,
    summary,
    low,
    cancelled,
  });
}

/**
 * どこまで測るかを決める。
 *
 * **申告値と 256K 相当の、大きいほう。** 申告値で頭打ちにすると、
 * 申告どおりの長さまでしか試せず、この測定の目的（申告が本当かを
 * 確かめる）を果たせない。申告が 256K を超えるモデルでは、
 * その申告どおりのところまで試す。
 *
 * そのうえで**指示ぶんと出力ぶんを差し引く。** 詰め物に使える字数を
 * 返したいので、指示と応答の分を含めたまま返すと、上限のあたりで
 * 詰め物が申告値をわずかに超えてしまう。
 */
function ceilingCharsFor(declaredTokens: number | undefined): number {
  const tokens = Math.max(declaredTokens ?? 0, MIN_CEILING_TOKENS);
  const usableTokens = tokens - PROBE_OUTPUT_TOKENS;
  const chars = Math.floor(usableTokens / TOKENS_PER_CHAR) - probeOverheadChars();
  return Math.max(MIN_PROBE_CHARS, chars);
}

/**
 * 結果を見せて、設定に書くかを訊く。
 *
 * **黙って書かない。** 測定は1回きりの目安であり、モデルを載せ直せば
 * 変わる。設定を書き換えると本文の分割単位が変わってキャッシュも
 * 効かなくなるので、押すのは作者である。
 */
async function offerToSave(input: {
  providerId: ProviderId;
  summary: string;
  low: number;
  cancelled: boolean;
}): Promise<void> {
  const key = WRITABLE_CONTEXT_SETTING[input.providerId];
  const prefix = input.cancelled ? "（途中で中止しました）" : "";

  if (!key || input.low <= 0) {
    // 書き戻せないAIは参考表示だけ。申告値のほうが確かなので、
    // こちらの測定値で上書きしない
    vscode.window.showInformationMessage(`${prefix}${input.summary}`);
    return;
  }

  const configuration = vscode.workspace.getConfiguration("novelai");
  const current = configuration.get<number>(key);
  const tokens = probeCharsToTokens(input.low);

  const answer = await vscode.window.showInformationMessage(
    `${prefix}${input.summary}` +
      `いまの設定は ${current?.toLocaleString("ja-JP") ?? "未設定"} ` +
      "トークンです。書き換えますか？",
    "設定に書く",
    "そのままにする"
  );
  if (answer !== "設定に書く") return;

  // 設定に入れるのは**トークン数**（字数ではない）。
  // 作品ごとではなく機械全体の設定にする——読み込み方も契約も、
  // 作品ではなく環境の側の事情で決まる
  await configuration.update(key, tokens, true);
  logStep(`読める長さの測定：設定 novelai.${key} を ${tokens} にしました。`);
  vscode.window.showInformationMessage(
    `設定 novelai.${key} を ${tokens.toLocaleString("ja-JP")} トークンにしました。`
  );
}

function reportFailure(error: unknown): void {
  if (error instanceof AIError) {
    logFailure("読める長さの測定", {
      種別: error.kind,
      詳細: error.detail,
      本文: error.message,
    });
    void vscode.window
      .showErrorMessage(
        `${error.message}\n${recoveryForAIError(error)}`,
        "ログを見る"
      )
      .then((answer) => {
        if (answer === "ログを見る") showLog();
      });
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  logFailure("読める長さの測定", { 本文: message });
  void vscode.window.showErrorMessage(`測定に失敗しました。\n${message}`);
}
