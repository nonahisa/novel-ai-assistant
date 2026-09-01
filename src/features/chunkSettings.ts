import * as vscode from "vscode";
import {
  parseChunkSizeMode,
  planChunkBudget,
  resolveChunkChars,
  resolveMergeChars,
  type ChunkBudget,
  type ChunkSizeMode,
  type ResolvedChunkSize,
} from "../core/chunker";
import { confirmProviderReachable } from "./aiConnectivity";
import type { AIProvider, ModelInfo } from "../ai/types";
import type { AssignableFeature } from "../ai/registry";

/**
 * チャンクの大きさに関する設定を、1か所で読む（設計書6.23）。
 *
 * **同じ設定が、機能によって効いたり効かなかったりしていた。**
 * `novelai.chunkChars` を見ていたのは誤字脱字検知と設定資料の抽出だけで、
 * **推敲と矛盾検知は設定を無視していつも自動**だった（2026-08-23に判明）。
 * 作者から見て理由の無い違いなので、読むところを1つにまとめる。
 */

export interface ChunkSettings {
  mode: ChunkSizeMode;
  /** 1チャンクの字数 */
  chunk: ResolvedChunkSize;
  /** まとめて送るときの1回ぶんの字数。0ならまとめない */
  mergeChars: number;
  /**
   * 固定費を差し引いた結果。差し引く材料を渡されなければ undefined。
   *
   * 何字を差し引いたかをログへ出すために持つ。「20,000字で処理します」
   * だけでは、設定を直したのに変わらない理由が読めない。
   */
  budget?: ChunkBudget & { overheadChars: number };
}

/**
 * 本文以外に毎回送る量（設計書6.27.10）。
 *
 * **見込みではなく実測を渡すこと。** 呼び出し側は、走り始めに
 * **本文を空にしてプロンプトを組み**、その字数をここへ入れる。
 * 「だいたいこれくらい」という定数を置き直すと、プロンプトの改訂に
 * 置いていかれて同じ穴に落ちる（実際に7,000字が実測の半分になった）。
 */
export interface ChunkFixedCost {
  /** system＋（本文を空にした）user の実測字数 */
  overheadChars: number;
  /** 応答に見込むトークン数。`generate` へ渡す値と揃える */
  outputTokens: number;
}

/**
 * モデルの詳細を取り、取れなければ理由を出して中止する（設計書6.23・6.27.10）。
 *
 * **`?? 8192` へ黙って落ちてはいけない。** チャンクの字数はモデルの
 * コンテキスト長から決まるので、131,072のモデルで20,000字だったチャンクが
 * 8,192の見込みでは**1,500字**になる。すると
 *
 *   - チャンクのハッシュが総入れ替えになり、処理済みキャッシュが全滅する
 *   - 1回あたりの本文が10分の1以下になり、呼び出し回数が十数倍になる
 *
 * という2つが同時に起きる。しかも作者には「急に遅くなった」としか見えない。
 * **モデル情報が取れない＝サーバーが止まっている経路そのもの**なので、
 * 疎通を回復させてから取り直し、それでも駄目なら理由を出して止める。
 *
 * この手順は誤字脱字検知と設定資料の抽出だけが持っており、推敲・矛盾検知・
 * 伏線（検知と回収）は黙って既定値へ落ちていた。**写しを増やさずに1つへ寄せる**
 * ——同じ設定が機能によって効いたり効かなかったりするのは、作者から見て
 * 理由が無い（`readChunkSettings` を1か所にした理由と同じ）。
 *
 * @returns 取れたモデルの詳細。取れなければ `undefined`（呼び出し側は中止する）
 */
export async function resolveModelInfoOrWarn(options: {
  /** `AIRegistry`。**機能キーを渡せる形のまま受ける**（既定モデルで代用しない） */
  registry: {
    resolveModelInfo(
      feature: AssignableFeature | "default"
    ): Promise<ModelInfo | undefined>;
  };
  feature: AssignableFeature;
  /** 素のプロバイダ。疎通確認と、手元のAIの起動導線に使う */
  provider: Pick<AIProvider, "id" | "testConnection">;
  model: string;
  /**
   * 実行しようとしている処理の名前（「推敲」「矛盾検知」など）。
   *
   * **決め打ちにしない。** 誤字脱字の文言をそのまま写すと、推敲を
   * 動かしているのに「誤字脱字の検知を開始できません」と出る
   * （Geminiを使っているのに「Claudeの…」と出た不具合と同じ形）
   */
  actionLabel: string;
}): Promise<ModelInfo | undefined> {
  const info = await options.registry.resolveModelInfo(options.feature);
  if (info) return info;

  // **モデル名を渡す。** LM Studioをこの場から起こしたとき、起こした直後に
  // 読み込ませるために要る（`aiConnectivity.ts`）。渡さないとJITが
  // 短い文脈で載せてしまう
  if (
    !(await confirmProviderReachable(
      options.provider,
      options.actionLabel,
      options.model
    ))
  ) {
    // 理由は疎通確認の側が既に出している。二重に出さない
    return undefined;
  }

  const retried = await options.registry.resolveModelInfo(options.feature);
  if (retried) return retried;

  const action = await vscode.window.showWarningMessage(
    `${options.actionLabel}：モデル「${options.model}」の情報を取得できませんでした。` +
      "このまま実行すると本文の分割単位が変わり、" +
      "これまでの処理済みキャッシュが使えなくなります。" +
      "モデルを選び直してから、もう一度実行してください。",
    "AIの設定を開く",
    "中止"
  );
  if (action === "AIの設定を開く") {
    await vscode.commands.executeCommand("novelai.setupAI");
  }
  return undefined;
}

export function readChunkSettings(
  contextWindow: number,
  fixedCost?: ChunkFixedCost
): ChunkSettings {
  const config = vscode.workspace.getConfiguration("novelai");
  const mode = parseChunkSizeMode(config.get<string>("chunkSizeMode"));

  const requested = resolveChunkChars({
    mode,
    configured: config.get<number>("chunkChars"),
    contextWindow,
  });

  // 固定費が分かっているなら、そのぶんを本文から引く。**引かないと、
  // 指示や資料が育ったときに本文が押し出されて溢れる**（溢れた分は
  // Ollama では黙って捨てられる）
  const budget = fixedCost
    ? {
        ...planChunkBudget({
          contextWindow,
          overheadChars: fixedCost.overheadChars,
          outputTokens: fixedCost.outputTokens,
          requestedChars: requested.chars,
        }),
        overheadChars: fixedCost.overheadChars,
      }
    : undefined;

  const chunk: ResolvedChunkSize = budget
    ? { ...requested, chars: budget.chunkChars }
    : requested;

  const mergeChars = resolveMergeChars({
    mode,
    configured: config.get<number>("mergeChunkChars"),
    chunkChars: chunk.chars,
  });

  return { mode, chunk, mergeChars, budget };
}

/**
 * 何を根拠に決めたかを、ログへ残す言葉にする。
 *
 * **「20,000字で処理します」だけでは、なぜその値なのか分からない。**
 * 設定を直したのに変わらない、という問い合わせの元になる。
 */
export function describeChunkSettings(settings: ChunkSettings): string {
  const source =
    settings.chunk.from === "model"
      ? "モデルのコンテキスト長から"
      : settings.chunk.from === "setting"
        ? "設定の指定値"
        : "字数の指定が無いためモデルから";
  const merge =
    settings.mergeChars > 0
      ? `／まとめ送信 ${settings.mergeChars}字`
      : "／まとめ送信なし";
  // **何を差し引いたかまで書く。** 設定に20,000字と書いたのに18,000字で
  // 動いていると、作者からは設定が効いていないように見える
  const budget = settings.budget
    ? `／指示と資料 ${settings.budget.overheadChars}字を差し引き` +
      (settings.budget.reason === "shrunk_to_fit"
        ? "（入るように縮めた）"
        : settings.budget.reason === "minimum"
          ? "（縮めても入り切らない見込み。下限で送ります）"
          : "")
    : "";
  return `1チャンク ${settings.chunk.chars}字（${source}）${merge}${budget}`;
}
