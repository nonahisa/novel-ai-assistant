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
 * これから何をすればよいか（`planLmStudioModelLoad` の答え）。
 *
 * **「読み込むかどうか」と「読み込む」を分ける。** 読み込み済みのモデルにも
 * 進捗表示（「LM Studioにモデルを読み込んでいます…」）が出ていたためである。
 * 設定資料パネルの相談では**質問のたび**に出ていた。
 */
export type LoadPlan =
  /** 何もしなくてよい。**進捗を出さずに先へ進む** */
  | { kind: "skipped"; reason: SkipReason }
  /** 読み込みが要る。`contextLength` は最初に試す長さ */
  | { kind: "load"; contextLength?: number };

/**
 * 「読み込み済み」と確かめた時刻（モデルごと）。
 *
 * **覚えるのは成功だけである**（CLAUDE.md 規則5「失敗から学習しない」）。
 * 未読込・読み込み失敗を覚えると、作者がLM Studioの画面で載せ直しても
 * こちらは古い判断のまま動き続ける。
 */
const confirmedLoadedAt = new Map<string, number>();

/**
 * 読み込みが要るかを決める。**HTTPの往復は、ここでしか行わない。**
 *
 * 直前に「読み込み済み」と確かめたモデルは、聞き直さずに素通りさせる
 * （`isRecentlyConfirmed`）。載せ替えはLM Studioの画面で人が行うので、
 * 数十秒の古さは害にならない。
 */
export async function planLmStudioModelLoad(
  model: string,
  now: number = Date.now()
): Promise<LoadPlan> {
  // ブラウザ版では外部プロセスを起こせない。別マシンのLM Studioの
  // 読み込みも、こちらからは指示できない
  if (!canRunProcesses()) return { kind: "skipped", reason: "unavailable" };

  const { decideLoadContextLength, isLocalEndpoint, isRecentlyConfirmed } =
    await import("./lmstudioLauncher.js");
  if (!isLocalEndpoint(lmstudioEndpoint())) {
    return { kind: "skipped", reason: "unavailable" };
  }

  // **覚えているうちは聞きに行かない。** AI機能を呼ぶたびの往復を省く
  if (isRecentlyConfirmed(confirmedLoadedAt.get(model), now)) {
    return { kind: "skipped", reason: "already_loaded" };
  }

  const provider = new LmStudioProvider();
  const state = await provider.readModelLoadState(model);
  // 状況が取れない（この口を持たない古い版・サーバーが止まっている）ときは、
  // 読み込み済みかどうかも分からない。**分からないまま読み込ませない**
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
    confirmedLoadedAt.set(model, now);
    return { kind: "skipped", reason: "already_loaded" };
  }

  return { kind: "load", contextLength };
}

/**
 * そのモデルを読み込ませる。**`planLmStudioModelLoad` が `load` を返した
 * ときだけ呼ぶ**（進捗表示を出すのもこの間だけ）。
 *
 * **断られたら文脈を半分にして試し直す。** 既定（設定 0）はモデルの最大で
 * 読み込むため、メモリの足りない機械では安全装置に断られる。以前はそこで
 * 諦めており、`ensureConfigured` が undefined を返して**AI機能が丸ごと
 * 動かなくなっていた**（12b を未読込のまま選んだ機械では、誤字脱字も相談も
 * 一切動かない）。半分ずつ下げ、8192 でも断られたときだけ失敗とする。
 *
 * **失敗しても呼び出し側を止める作りにはしていない。** 読み込めなくても
 * JITがあるので生成自体は試みられる（そこで断られたときは
 * `lmstudioProvider.ts` が理由を伝える）。止めるかどうかは呼び出し側が決める。
 */
export async function runLmStudioModelLoad(
  model: string,
  contextLength?: number,
  now: number = Date.now()
): Promise<EnsureLoadResult> {
  const {
    contextLengthRetrySteps,
    describeLoadFailure,
    isInsufficientResources,
    loadLmStudioModel,
  } = await import("./lmstudioLauncher.js");

  const cliPath = vscode.workspace
    .getConfiguration("novelai")
    .get<string>("lmstudio.cliPath", "");
  // 長さが決まらないときは、LM Studioの既定に任せて1回だけ試す
  // （当てずっぽうの数字を渡さない）
  const steps: Array<number | undefined> =
    contextLength === undefined ? [undefined] : contextLengthRetrySteps(contextLength);

  // **最後の失敗を持ち帰る。** 途中の（長い文脈での）失敗を見せると、
  // 作者には「まだ短くできるのでは」と読めてしまう
  let last: { reason: "load_failed" | "timeout"; detail?: string } | undefined;
  for (const [index, length] of steps.entries()) {
    logStep(
      `LM Studio：モデル「${model}」を読み込みます` +
        `（${index + 1}/${steps.length} 回目` +
        (length === undefined ? "、文脈はLM Studioの既定" : `、文脈 ${length}`) +
        "）。"
    );
    const outcome = await loadLmStudioModel({ model, contextLength: length, cliPath });

    if (outcome.ok) {
      confirmedLoadedAt.set(model, now);
      return { kind: "loaded", contextLength: length };
    }
    // `lms` が無いだけなら、これまでどおりJITに任せる。
    // 「入れてください」と促す場面ではない（生成自体は動く）
    if (outcome.reason === "not_installed") {
      return { kind: "skipped", reason: "not_installed" };
    }
    last = { reason: outcome.reason, detail: outcome.detail };

    // **メモリ不足のときだけ下げる。** モデル名の間違いなど、短くしても
    // 直らない失敗を4回試すと、作者を待たせるだけになる
    if (outcome.reason !== "load_failed" || !isInsufficientResources(outcome.detail)) {
      break;
    }
    logStep(
      `LM Studio：文脈 ${length} では載りませんでした（メモリ不足）。短くして試し直します。`
    );
  }

  // ループは必ず1回は回り、成功と not_installed はそこで返しているので、
  // ここへ来る時点で `last` は必ず入っている
  if (!last) return { kind: "skipped", reason: "unknown_model" };
  return {
    kind: "failed",
    reason: last.reason,
    // **どのモデルの話かを先に言う。** 生成時の失敗
    // （`lmstudioProvider.ts` の `model_load_failed`）と同じ言い方に揃える
    message:
      `LM Studio がモデル「${model}」を読み込めませんでした。` +
      describeLoadFailure({ ok: false, reason: last.reason, detail: last.detail }),
  };
}

/**
 * そのモデルが、指定した長さで読み込まれている状態にする。
 *
 * 判断（`planLmStudioModelLoad`）と読み込み（`runLmStudioModelLoad`）を
 * まとめたもの。**進捗表示を出し分けたい呼び出し側は、2つを別々に呼ぶ**
 * （`ai/registry.ts` の `prepareLmStudioModel`）。
 */
export async function ensureLmStudioModelLoaded(
  model: string
): Promise<EnsureLoadResult> {
  const plan = await planLmStudioModelLoad(model);
  if (plan.kind === "skipped") return plan;
  return runLmStudioModelLoad(model, plan.contextLength);
}

/**
 * 読み込んだ実測の長さを設定へ書き戻す。
 *
 * **作者に写させない。** 手で写させると、写し間違いと写し忘れが起きる。
 * 実際より大きい値が入っていると、入力が黙って切り捨てられる。
 *
 * **そのモデルの長さを見る。** 以前は `readLoadedContextWindow()`
 * （読み込み済みの全モデルのうち**いちばん短いもの**）を保存していた。
 * 別の小さいモデルが 4096 で載っていると、いま 131072 で載せたモデルの
 * 設定が 4096 になり、本文が4096字ぶんずつしか送られなくなる。
 *
 * @param model いま読み込んだモデル
 * @returns 書き戻した長さ。取れなければ undefined（**当てずっぽうで書かない**）
 */
export async function saveLoadedContextWindow(
  model: string
): Promise<number | undefined> {
  // 包み（`MeteredProvider`）越しでは呼べない口なので、自分で立てる。
  // 状態を持たないので、立て直しても費用はかからない
  const state = await new LmStudioProvider().readModelLoadState(model);
  const detected = state?.loadedContextLength;
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
