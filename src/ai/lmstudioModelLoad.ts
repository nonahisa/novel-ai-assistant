import * as vscode from "vscode";
import { LmStudioProvider, lmstudioEndpoint } from "./lmstudioProvider";
import { canRunProcesses } from "../core/runtime";
import { logStep } from "../core/logger";

/**
 * LM Studioのモデルを、文脈の長さを指定して読み込ませる（設計書6.24）。
 *
 * 作者の報告（2026-08-29）：「LM Studioで『文脈 8k』と出てしまう。
 * LM Studioの設定を変えないと 8k と表示される」。
 *
 * ## なぜ拡張機能が読み込むのか
 *
 * LM Studioは**要求されたモデルをその場で読み込む**（JIT）が、そのときの
 * 文脈の長さは**LM Studio側の既定**になる。既定は短いことが多く、
 * 拡張機能が本文を分割するときの想定と食い違う。しかも作者から見ると
 * 「モデル選択に 8k と出る」という形でしか現れない。
 *
 * **`lms load <model> -y --context-length <N>` で拡張機能が読み込めば、
 * N は拡張機能が知っている値になる**ので、作者が設定を手で合わせる必要が
 * なくなる。読み込んだあとは実測（`loaded_context_length`）を設定へ書き戻す。
 *
 * ## 読み込み済みなら触らない
 *
 * すでに読み込まれているものを読み直さない（`lms unload` も呼ばない）。
 * 作者がLM Studioの画面で整えた状態を、こちらの都合で壊さないため。
 * 指定より短く載っている場合は**記録だけ残す**（設計書5.8.5と同じ考え方で、
 * 黙って作り変えない）。
 *
 * ## Node専用のファイルは動的importで持ってくる
 *
 * `lmstudioLauncher.ts` は `node:child_process` を静的importしている。
 * このファイルは `registry.ts` から辿れる（＝ブラウザ版の束にも入る）ので、
 * 静的importすると巻き込む（設計書5.8.5）。
 */

/** 拡張機能が読み込むときの文脈の長さの上限。0 はモデルの最大 */
function configuredLoadLimit(): number {
  const value = vscode.workspace
    .getConfiguration("novelai")
    .get<number>("lmstudio.loadContextLength", 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export type EnsureLoadResult =
  /** こちらで読み込んだ。`contextLength` は指定した長さ */
  | { kind: "loaded"; contextLength?: number }
  /**
   * 何もしなかった。**失敗ではない**——読み込み済みだった、`lms` が無い、
   * ブラウザ版・別マシンだった、など。呼び出し側は先へ進んでよい
   */
  | { kind: "skipped"; reason: SkipReason }
  /**
   * 読み込もうとして断られた。`message` はそのまま作者へ見せてよい。
   *
   * **`reason` で扱いを分ける。** `load_failed`（載らないと分かった）は
   * 待っても直らないので実行を止めてよいが、`timeout`（待ちきれなかった）は
   * 裏で読み込みが続いていることがあり、止めると却って邪魔になる。
   */
  | { kind: "failed"; reason: "load_failed" | "timeout"; message: string };

export type SkipReason =
  | "unavailable"
  | "not_installed"
  | "already_loaded"
  | "unknown_model";

/**
 * そのモデルが、指定した長さで読み込まれている状態にする。
 *
 * **失敗しても呼び出し側を止める作りにはしていない。** 読み込めなくても
 * JITがあるので生成自体は試みられる（そこで断られたときは
 * `lmstudioProvider.ts` が理由を伝える）。止めるかどうかは呼び出し側が決める。
 */
export async function ensureLmStudioModelLoaded(
  model: string
): Promise<EnsureLoadResult> {
  // ブラウザ版では外部プロセスを起こせない。別マシンのLM Studioの
  // 読み込みも、こちらからは指示できない
  if (!canRunProcesses()) return { kind: "skipped", reason: "unavailable" };

  const { decideLoadContextLength, describeLoadFailure, isLocalEndpoint, loadLmStudioModel } =
    await import("./lmstudioLauncher.js");
  if (!isLocalEndpoint(lmstudioEndpoint())) {
    return { kind: "skipped", reason: "unavailable" };
  }

  const provider = new LmStudioProvider();
  const state = await provider.readModelLoadState(model);
  // 状況が取れない（この口を持たない古い版）ときは、読み込み済みかどうかも
  // 分からない。**分からないまま読み込ませない**——JITに任せる
  if (!state) return { kind: "skipped", reason: "unknown_model" };

  const contextLength = decideLoadContextLength(
    state.maxContextLength,
    configuredLoadLimit()
  );

  if (state.loaded) {
    // 短く載っていても読み直さない。作者が意図して短くしていることがある
    if (
      contextLength !== undefined &&
      state.loadedContextLength !== undefined &&
      state.loadedContextLength < contextLength
    ) {
      logStep(
        `LM Studio：読み込み済みの文脈 ${state.loadedContextLength} は` +
          `指定 ${contextLength} より短い。` +
          "LM Studio側で読み込み直すと長い本文を扱えます。"
      );
    }
    return { kind: "skipped", reason: "already_loaded" };
  }

  const outcome = await loadLmStudioModel({
    model,
    contextLength,
    cliPath: vscode.workspace
      .getConfiguration("novelai")
      .get<string>("lmstudio.cliPath", ""),
  });

  if (outcome.ok) return { kind: "loaded", contextLength };
  // `lms` が無いだけなら、これまでどおりJITに任せる。
  // 「入れてください」と促す場面ではない（生成自体は動く）
  if (outcome.reason === "not_installed") {
    return { kind: "skipped", reason: "not_installed" };
  }
  return {
    kind: "failed",
    reason: outcome.reason,
    // **どのモデルの話かを先に言う。** 生成時の失敗
    // （`lmstudioProvider.ts` の `model_load_failed`）と同じ言い方に揃える
    message:
      `LM Studio がモデル「${model}」を読み込めませんでした。` +
      describeLoadFailure(outcome),
  };
}

/**
 * 読み込んだ実測の長さを設定へ書き戻す。
 *
 * **作者に写させない。** 手で写させると、写し間違いと写し忘れが起きる。
 * 実際より大きい値が入っていると、入力が黙って切り捨てられる。
 *
 * @returns 書き戻した長さ。取れなければ undefined
 */
export async function saveLoadedContextWindow(): Promise<number | undefined> {
  // 包み（`MeteredProvider`）越しでは呼べない口なので、自分で立てる。
  // 状態を持たないので、立て直しても費用はかからない
  const detected = await new LmStudioProvider().readLoadedContextWindow();
  if (detected === undefined) return undefined;

  const configuration = vscode.workspace.getConfiguration("novelai");
  const current = configuration.get<number>("lmstudio.contextWindow", 8192);
  if (current === detected) return detected;

  // 作品ごとではなく、この機械全体の設定にする。読み込み方は
  // 作品ではなく機械の側の事情で決まる
  await configuration.update("lmstudio.contextWindow", detected, true);
  logStep(`LM Studio：コンテキスト長を ${detected} に合わせました。`);
  return detected;
}
