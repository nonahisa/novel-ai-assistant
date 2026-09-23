import * as vscode from "vscode";
import {
  ASSIGNABLE_FEATURE_LABELS,
  type AIRegistry,
} from "../ai/registry";
import type { AIProvider, ModelInfo } from "../ai/types";
import { lookupCallSpeeds } from "../ai/runTimeEstimate";
import { maxTimeoutSeconds } from "../core/modelTuning";
import { isLocalProviderId } from "../core/localProviders";
import {
  adviseLargerModel,
  describeLargerModelAdvice,
  largerModelButtons,
} from "../core/largerModelAdvice";
import type { AccuracyFeature } from "../core/bundledFeatureAccuracy";
import { logFailure, logStep, useLogFile } from "../core/logger";

/**
 * 確認画面の「この機械ならもっと大きいモデルが使えます」（作者の裁定、
 * 2026-09-23。A3④）。
 *
 * 決め方は `core/largerModelAdvice.ts`。ここは API と台帳から材料を集め、
 * 押されたボタンを実際の操作へつなぐだけ。
 *
 * ## 押したら何が起きるか（6.28.9 の形に合わせた）
 *
 * | ボタン | 起きること |
 * |---|---|
 * | 「〈モデル〉に切り替える」 | **この機能の割当**（機能ごとのAI割当）を〈モデル〉へ変え、確認を出し直す |
 * | 「〈モデル〉の速さを測る」 | そのモデルを名指しで AIチューニングにかける。**割当は変えない**。今回の実行はやめる |
 *
 * **「この回だけ使う」は作らなかった。** 割当は機能ごとに1つで、実行の途中で
 * 何度も引き直される（検証・分け直し・資料の大きさ）。回ごとの上書きを通すには
 * その全部に手を入れることになり、1か所でも漏れると**決めた大きさと送る
 * モデルが食い違う**（6.28.7 で塞いだ、入力が黙って切り捨てられる形）。
 * 割当なら「機能ごとのAI割当」でいつでも戻せる。
 */

export interface LargerModelOffer {
  /** 確認の詳細へ足す文 */
  readonly detail: string;
  /** 確認に並べるボタン */
  readonly choices: readonly string[];
  /**
   * 記録へ残す文。**呼ぶ側が作品のログへ向けたあとで書く。** 確認を
   * 「以降は訊かない」にしている作者には画面が出ないので、案内を捨てた
   * ことにしないよう記録には残す
   */
  readonly logText: string;
  /**
   * 押されたボタンを実行する。
   *
   * - `"rerun"`……割当を変えた。呼ぶ側は最初からやり直す（モデルが変わると
   *   分け方も資料の量も変わるので、ここまでの準備は使えない）
   * - `"stop"`……測りに行った。今回の実行はやめる
   * - `undefined`……知らないボタン（何もしない）
   */
  handle(label: string): Promise<"rerun" | "stop" | undefined>;
}

export async function findLargerModelOffer(params: {
  registry: AIRegistry;
  /** 割当のキーであり、当たりの記録のキーでもある */
  feature: AccuracyFeature;
  provider: AIProvider;
  model: string;
  /** いまのモデルの大きさ（API の申告） */
  parameterSize: string | null;
  /** 速さの台帳を引く機能名（`meta.feature` と同じ） */
  speedFeature: string;
  /** いまのプロンプトの版（記録が古くないかを見る） */
  promptVersion: string;
  /** これから送る1回ごとの字数 */
  inputChars: readonly number[];
  /** 数えているもの（確認の目安と同じ） */
  unit?: string;
  /** ボタンが押されたときの記録の書き先（作品フォルダー） */
  workFolder: string;
}): Promise<LargerModelOffer | undefined> {
  // **クラウドでは一覧も引かない**（手元のモデルの話。余計な往復をしない）
  if (!isLocalProviderId(params.provider.id)) return undefined;
  if (params.inputChars.length === 0) return undefined;

  let installed: ModelInfo[];
  try {
    installed = await params.provider.listModels();
  } catch (error) {
    // **案内が出せないだけで、実行は止めない。** 理由は記録に残す
    logFailure("大きいモデルの案内：モデルの一覧", {
      詳細: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }

  const providerId = params.provider.id;
  const advice = adviseLargerModel({
    providerId,
    feature: params.feature,
    promptVersion: params.promptVersion,
    current: { id: params.model, parameterSize: params.parameterSize },
    installed: installed.map((info) => ({
      id: info.id,
      parameterSize: info.parameterSize,
    })),
    // **上限は A8 の値**（手元1800秒）。台帳に短い待ち時間を書いたモデルでも、
    // チャンクの大きさがその秒数に収まるよう縮むので、ここでは上限で見る
    timeoutSeconds: maxTimeoutSeconds(providerId),
    inputChars: params.inputChars,
    speedsOf: (modelId) => lookupCallSpeeds(providerId, modelId, params.speedFeature),
  });
  if (!advice) return undefined;

  const detail = describeLargerModelAdvice(advice, {
    count: params.inputChars.length,
    unit: params.unit ?? "チャンク",
    featureLabel: ASSIGNABLE_FEATURE_LABELS[params.feature],
  });
  const buttons = largerModelButtons(advice);
  const choices = [buttons.switchLabel, buttons.measureLabel].filter(
    (label): label is string => label !== undefined
  );

  /*
    **ここではログへ書かない。** 誤字脱字・推敲は、確認で「実行」が押されて
    から作品のログへ向ける（取りやめた回に、別の作品のログへ書かないため）。
    記録は呼ぶ側が向けたあとに `logText` を書く。ボタンが押されたときだけは
    作者がこの作品で選んだ操作なので、この作品のログへ向けて書く。
  */
  return {
    detail,
    choices,
    logText: `大きいモデルの案内（${ASSIGNABLE_FEATURE_LABELS[params.feature]}）\n${detail}`,
    async handle(label) {
      useLogFile(params.workFolder);
      if (label === buttons.switchLabel && advice.fits) {
        await params.registry.assign(params.feature, providerId, advice.fits.id);
        logStep(
          `${ASSIGNABLE_FEATURE_LABELS[params.feature]}の割当を ` +
            `${advice.fits.id} へ変えました（確認画面の案内から）`
        );
        return "rerun";
      }
      if (label === buttons.measureLabel && advice.unmeasured) {
        // **待たない。** 測定は数分〜1時間かかり、何を測るかも向こうで訊く
        void vscode.commands.executeCommand(
          "novelai.measureContext",
          params.feature,
          { providerId, model: advice.unmeasured.id }
        );
        return "stop";
      }
      return undefined;
    },
  };
}
