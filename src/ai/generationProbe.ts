import { AIError, recoveryForAIError, type AIProvider } from "./types";

/**
 * 実際に1回だけ生成させて、本当に使える状態かを確かめる。
 *
 * **モデル一覧が引けても、生成できるとは限らない。**
 * Anthropicもモデル一覧は残高ゼロでも返すため、一覧だけを見た接続テストは
 * 「接続しました（モデル10件）」と成功を報告してしまう。
 * 作者はそれを見て抽出を始め、19話ぶん走らせたあとで
 * 「残高不足」と知ることになる。実際にそうなった。
 *
 * 権限不足・レート上限も同じで、一覧の取得では表に出ない。
 * 接続テストは「このあと抽出を始めてよいか」を答えるためのものなので、
 * 抽出と同じ経路を1回だけ通す。
 *
 * 課金は発生するが、入力も出力も一言なので、
 * 抽出1回ぶんに比べれば無視できる。
 */

/** 確認用の最小の呼び出し。内容に意味はないので、いちばん短い返事を求める */
const PROBE_PROMPT = "「はい」とだけ答えてください。";

export interface ProbeResult {
  ok: boolean;
  /** 失敗したときだけ入る。作者に見せる文言 */
  message?: string;
  /** 失敗の種別。呼び出し側が扱いを分けるために使う */
  error?: AIError;
}

export async function probeGeneration(
  provider: AIProvider,
  model: string
): Promise<ProbeResult> {
  try {
    await provider.generate({
      systemPrompt: "",
      userPrompt: PROBE_PROMPT,
      model,
      temperature: 0,
      /*
        **文脈の広さを決め打ちしない**（設計書6.62）。

        以前は `numCtx: 1024` と書いていた。本文を渡さないので最小でよい、
        という理屈だったが、**そのぶんだけ害があった**。

        1. **モデルが初期化できないことがある。** 作者の機械で `gemma4:26b`
           を1024で読み込ませたところ、llama-server が
           `Gemma4Assistant requires ctx_other to be set` とスタック破壊で
           落ちた（2026-09-01のログ）。**確認するはずの処理が、確認の対象を
           壊していた**
        2. **余分な読み込みが1回増える。** 1024で読み込んだ直後に、本番の
           呼び出しが別の値で読み込み直す（6.53.3に「残っていること」として
           書いてあった問題そのもの）

        渡さなければ、プロバイダが**送る長さから決める**（`contextSizeForPrompt`。
        15字なので下限の4,096になる）。作者が `ollama.numCtx` を指定していれば
        そちらが使われ、**本番の呼び出しと同じ値になる**ので読み込み直しも減る。
      */
      disableThinking: true,
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof AIError) {
      return { ok: false, message: describeProbeFailure(error), error };
    }
    return {
      ok: false,
      message: `AIを呼び出せませんでした: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * 失敗の理由と、次に取れる操作を1つ示す。
 *
 * 「接続できません」だけでは、キーが悪いのか残高が無いのか分からず、
 * 作者は何を直せばよいか判断できない。
 */
export function describeProbeFailure(error: AIError): string {
  // 残高不足は原因がはっきりしているので、そのまま伝える。
  // 待っても回復しないので、再試行を促してはいけない
  if (error.kind === "insufficient_credit") return error.message;
  // モデルを読み込めなかった場合も、AI側が理由（メモリがいくら足りないか）を
  // 具体的に言っている。定型文で覆うと、その理由が作者に届かない
  if (error.kind === "model_load_failed") {
    return `${error.message}${recoveryForAIError(error)}`;
  }
  return `モデルの一覧は取得できましたが、実際の生成に失敗しました。${recoveryForAIError(
    error
  )}（詳細はログを参照）`;
}
