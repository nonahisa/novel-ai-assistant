import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import type { AIRegistry } from "../ai/registry";
import { AIError, recoveryForAIError } from "../ai/types";
import {
  resolveOutputLimitForSend,
  resolveOutputTokensForPlanning,
  truncatedOutputAdvice,
} from "../ai/outputLimit";
import { CharacterStore } from "../core/characterStore";
import { appendChatLog } from "../core/chatLog";
import { PendingUpdateStore } from "../core/pendingUpdates";
import {
  chatHistoryDigest,
  formatChatConversation,
  trimChatHistory,
  verifyChatDecisions,
  type ChatDecisionRejection,
  type VerifiedChatDecisions,
} from "../core/chatSettingsSync";
import {
  buildNewCharacterRecords,
  buildPlotCharacterUpdates,
  type PlotCharacterSkip,
} from "../core/plotCharacterSync";
import { logFailure, logStep, responseExcerptForLog } from "../core/logger";
import {
  buildChatSettingsSyncPrompt,
  parseChatSettingsSync,
  CHAT_SETTINGS_SYNC_SCHEMA,
  CHAT_SETTINGS_SYNC_SYSTEM_PROMPT,
  CHAT_SETTINGS_SYNC_VERSION,
} from "../prompts/chatSettingsSync";
import type { WorkChatTurn } from "../prompts/workChat";
import { withCancellableProgress } from "../views/progress";
import { confirmPaidUsage, confirmProviderReachable } from "./aiConnectivity";
import { readSyncDigest, writeSyncDigest } from "./syncDigest";

/**
 * 相談で決まったことを、設定資料の更新案として積む（設計書6.72、P-32）。
 *
 * ## 資料は直接書き換えない
 *
 * 積むのは**承認待ち（`PendingUpdateStore`）だけ**で、台帳へ入るのは
 * 作者が「更新分を反映」で承認したときである。**抽出・プロット反映と
 * まったく同じ道**を通る——新しい反映経路を作らない。
 *
 * ## 対象は「いま画面にある会話」だけ
 *
 * 過去のログファイル（`.aiwriter/logs/chat.md`）は読まない。追記型の
 * 記録で読み出しの区切りが無く、昔の相談を掘り起こすと「当時は言ったが
 * 今は違う」設定を積んでしまう。反映したい相談は、開いているうちに押す。
 *
 * ## AIの割当は「抽出」
 *
 * 相談（chat）とは仕事が違う。相談は話し相手で、これは拾い出しである。
 */

const STATE_FILE = "chat-sync.json";
/** 覚え書きの中の項目名。**変えると、反映済みの会話がもう一度積まれる** */
const STATE_KEY = "historyDigest";

/**
 * 一度に渡す会話の上限。
 *
 * 相談は12往復までしか覚えていないので普通は収まるが、1回の発言に
 * 本文を貼ることはある。超えたぶんは古い発言から落とす（落としたことは
 * 作者へ伝える。黙って減らさない）。
 */
const MAX_CONVERSATION_CHARS = 20_000;

export interface ChatSettingsSyncDeps {
  /**
   * AIの割当。**`"extract"` キーを使う**（新しいキーは作らない）。
   *
   * 受け取るのは `resolve` だけでよい。狭く取るのは、この機能が
   * 何を使うのかを型で言い切るためである。
   */
  ai: Pick<AIRegistry, "resolve">;
}

export interface ChatSettingsSyncResult {
  /** 既存人物の更新案として積んだ件数 */
  staged: number;
  /** 新規の人物案として積んだ名前 */
  creations: string[];
  /** 突合で積まなかったもの（作者確定・複数一致） */
  skipped: PlotCharacterSkip[];
  /** 検証で落としたもの（指示語・根拠なし） */
  rejected: ChatDecisionRejection[];
  /** 長すぎて外した発言の数 */
  dropped: number;
  /** 前回と同じ会話なので、何もしなかった */
  unchanged: boolean;
  /** 途中で止めた（AI未設定・接続不可・資料が読めない・失敗） */
  failed: boolean;
}

const EMPTY: ChatSettingsSyncResult = {
  staged: 0,
  creations: [],
  skipped: [],
  rejected: [],
  dropped: 0,
  unchanged: false,
  failed: false,
};

/**
 * 相談の会話から、人物の更新案を積む。
 *
 * 呼ぶのは相談パネルのボタンだけである（設計書6.72。コマンドは作らない
 * ——入口を増やすと「どの会話について押したのか」が曖昧になる）。
 */
export async function applyChatToSettings(
  work: WorkEntry,
  turns: readonly WorkChatTurn[],
  deps: ChatSettingsSyncDeps
): Promise<ChatSettingsSyncResult> {
  /*
    **押した時点の会話を写し取って、以降はこれだけを見る**（0.32.6のレビュー）。

    渡されるのは相談パネルが持っている生の配列で、**この処理の途中でも
    伸びる**（費用の確認は、作者がダイアログを読むぶんだけ待つ）。
    覚え書き（ダイジェスト）を押した時点で作り、送る中身を後から組むと、
    2つがずれる——次に押したときに「反映済み」と言われて、途中で足した
    発言が永久に反映されなくなる。
  */
  const snapshot = [...turns];

  if (snapshot.length === 0) {
    void vscode.window.showInformationMessage(
      "まだ会話がありません。相談してから押してください。"
    );
    return { ...EMPTY, failed: true };
  }

  /*
    **AIを呼ぶ前にダイジェストを見る。** 同じ会話で二度押したときに
    料金だけかかって「反映済みです」と出るのでは、押した意味がない。
  */
  const digest = chatHistoryDigest(snapshot);
  if (digest === (await readSyncDigest(work, STATE_FILE, STATE_KEY))) {
    void vscode.window.showInformationMessage(
      "この相談は反映済みです（会話が進んでから、もう一度お試しください）。"
    );
    return { ...EMPTY, unchanged: true };
  }

  const resolved = deps.ai.resolve("extract");
  if (!resolved) {
    void vscode.window.showWarningMessage(
      "AIが設定されていません。詳細メニューの「AIの設定」から設定してください。"
    );
    return { ...EMPTY, failed: true };
  }

  // 読めない人物設定があるまま突き合わせると、「資料に居ない」と判断して
  // 同じ人物の新規案を出してしまう。**AIを呼ぶ前に確かめる**（無駄な課金を
  // させない）。覚え書きも残さず、直したあとにやり直せるようにする
  const loaded = await new CharacterStore(work).loadAll();
  if (loaded.errors.length > 0) {
    void vscode.window.showWarningMessage(
      `読み込めない人物設定が ${loaded.errors.length} 件あるため、` +
        "相談からの反映を見送りました。"
    );
    return { ...EMPTY, failed: true };
  }

  /*
    **繋がるかを、費用の確認より先に確かめる**（設計書6.51）。
    止まっているAIへ送っても、赤い字が出るだけで起こす手立てが無い。
  */
  if (
    !(await confirmProviderReachable(
      resolved.provider,
      "相談を資料へ反映",
      resolved.model
    ))
  ) {
    return { ...EMPTY, failed: true };
  }

  // 有料のAIは呼ぶたびに課金される。**相談の確認とは別に取る**——
  // 相談は話し相手、こちらは拾い出しで、仕事が違う（設計書7.1.1）
  const ok = await confirmPaidUsage(resolved.provider, {
    actionLabel: "相談を資料へ反映",
    model: resolved.model,
    calls: 1,
    detail:
      "いま画面にある会話をAIへ送り、作者が決めた人物の設定を拾い出します。\n" +
      "拾ったものは承認待ちに積まれるだけで、設定資料はまだ変わりません。",
  });
  if (!ok) return { ...EMPTY, failed: true };

  const trimmed = trimChatHistory(snapshot, MAX_CONVERSATION_CHARS);
  const conversation = formatChatConversation(trimmed.turns);
  // **既知の名前は絞らずに全部渡す。** 絞ると、漏れた人物が毎回
  // 「新規」として提案される
  const knownNames = loaded.characters.map((character) => character.name);

  /*
    **上限は、出どころごと受け取る**（設計書6.77の第2段、0.33.9のレビュー）。
    切り詰められたときの直し方は、上限が設定から来たのか実測から来たのかで
    変わる（`truncatedOutputAdvice`）。実測で頭打ちなのに「設定を大きくして」
    と言うと、作者は直らない操作を繰り返すことになる。
  */
  const outputLimit = resolveOutputLimitForSend(
    resolved.provider.id,
    resolved.model
  );

  /**
   * 拾い出しの結果。**「読めなかった」を空振りと区別する**（0.32.6のレビュー）。
   * 読めなかった回に覚え書きを書くと、その会話は二度と送れなくなる。
   *
   * **切り詰めも別に持つ**（0.33.9のレビュー）。会話を丸ごと送るこの機能は
   * 上限に当たりやすく、「読み取れませんでした」としか言わないと、作者は
   * 同じ会話を何度も送り直すことになる。
   */
  let outcome:
    | { kind: "truncated"; text: string }
    | { kind: "malformed"; text: string }
    | { kind: "ok"; verified: VerifiedChatDecisions };
  try {
    // **中止できるようにする**（設計書6.43）。相談の会話を丸ごと送るので
    // 数十秒かかることがあり、有料AIではその間ずっと課金される
    outcome = await withCancellableProgress(
      "相談から決まったことを拾っています",
      async (_progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());

        logStep(
          `相談を資料へ反映: v${CHAT_SETTINGS_SYNC_VERSION} / ${resolved.model}` +
            (trimmed.dropped > 0 ? ` / 古い発言${trimmed.dropped}件を除外` : "")
        );
        const response = await resolved.provider.generate({
          systemPrompt: CHAT_SETTINGS_SYNC_SYSTEM_PROMPT,
          userPrompt: buildChatSettingsSyncPrompt({
            workTitle: work.title,
            conversation,
            knownNames,
          }),
          model: resolved.model,
          // 拾い出しなので揺らさない（抽出と同じ扱い）
          temperature: 0.2,
          /*
            **実際に送る上限と、場所の見込みは別物である**（設計書6.77の
            第2段）。渡さないと、関所も実送信もグローバル設定（既定16,384）
            で動く——会話を丸ごと送るこの機能では、非力な機械で確保する
            `num_ctx` がいちばん大きくなる。
          */
          maxOutputTokens: outputLimit.tokens,
          plannedOutputTokens: resolveOutputTokensForPlanning(
            resolved.provider.id,
            resolved.model
          ),
          jsonSchema: CHAT_SETTINGS_SYNC_SCHEMA as unknown as object,
          disableThinking: true,
          meta: { feature: "chat_settings_sync", workFolder: work.folderPath },
          signal: controller.signal,
        });
        /*
          **切り詰めを先に見る。** 途中で切れた応答はJSONとしても読めない
          ので、読み取りの失敗として扱うと「AIの気まぐれ」に見えてしまう。
        */
        if (response.truncated) {
          return { kind: "truncated" as const, text: response.text };
        }
        const parsed = parseChatSettingsSync(response.text);
        // **読めなかったことを、0件として飲み込まない。**
        // 応答そのものは呼び出し側で記録へ残す（ここでは判断だけ）
        if (parsed.malformed) {
          return { kind: "malformed" as const, text: response.text };
        }
        // **根拠が会話に実在するかを、ここで確かめる。**
        // AIが「決まった」と言っただけのものは積まない
        return {
          kind: "ok" as const,
          verified: verifyChatDecisions(parsed.decisions, trimmed.turns),
        };
      }
    );
  } catch (error) {
    // 中止は失敗ではない。作者が自分で止めたことを警告で知らせ直さない
    if (error instanceof AIError && error.kind === "aborted") {
      return { ...EMPTY, failed: true };
    }
    const message =
      error instanceof AIError
        ? `${error.message} ${recoveryForAIError(error)}`
        : error instanceof Error
          ? error.message
          : String(error);
    logFailure("相談を資料へ反映", { 内容: message });
    void vscode.window.showWarningMessage(`反映できませんでした: ${message}`);
    return { ...EMPTY, failed: true };
  }

  if (outcome.kind === "truncated") {
    logFailure("相談を資料へ反映：応答が出力上限で切り詰められました", {
      作品: work.title,
      モデル: resolved.model,
      上限: `${outputLimit.tokens}（${outputLimit.source}）`,
      応答: responseExcerptForLog(outcome.text),
    });
    /*
      **覚え書きを残さない**（読めなかったときと同じ扱い）。切り詰めは
      やり直せる失敗なので、この会話を「反映済み」にしてはいけない。

      文言は `ai/outputLimit.ts` が持つ（判定の置き場を2つにしない）。
      ここで足すのは、この機能でできる絞り方だけである。
    */
    void vscode.window.showWarningMessage(
      `${truncatedOutputAdvice(outputLimit)}` +
        "会話が長いときは、反映したい範囲まで新しい相談を始めてください。"
    );
    return { ...EMPTY, failed: true };
  }

  if (outcome.kind === "malformed") {
    // **応答の中身を捨てない**（実装ルール5）。何が返ってきたのかが
    // 分からないと、プロンプトが悪いのかモデルが悪いのかを切り分けられない
    logFailure("相談を資料へ反映：AIの答えを読み取れませんでした", {
      作品: work.title,
      モデル: resolved.model,
      応答: responseExcerptForLog(outcome.text),
    });
    // **覚え書きを残さない。** もう一度押せば、同じ会話をやり直せる
    void vscode.window.showWarningMessage(
      "AIの答えを読み取れませんでした。もう一度試せます。"
    );
    return { ...EMPTY, failed: true };
  }

  const verified = outcome.verified;
  const plan = buildPlotCharacterUpdates(verified.entries, loaded.characters);

  if (plan.updates.length > 0 || plan.creations.length > 0) {
    try {
      const store = new PendingUpdateStore(work);
      // 出どころを添えて積む。AIが本文から読んだものと、相談で作者が
      // 決めたものとでは、承認するときの見方が変わる
      if (plan.updates.length > 0) {
        await store.stage(plan.updates, { source: "chat" });
      }
      // 資料にまだ無い人は**新規の人物案**として積む。台帳へは書かない
      // ——承認したときに `applyPendingUpdates` が採番して作る
      if (plan.creations.length > 0) {
        await store.stage(buildNewCharacterRecords(plan.creations), {
          source: "chat",
          kind: "creation",
        });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logFailure("相談から人物の更新案を積めませんでした", {
        作品: work.title,
        詳細: detail,
      });
      void vscode.window.showWarningMessage(
        `相談からの更新案を保留できませんでした: ${detail}`
      );
      // 覚え書きを残さない。もう一度押せばやり直せる
      return { ...EMPTY, failed: true };
    }
  }

  await writeSyncDigest(work, STATE_FILE, STATE_KEY, digest, "相談反映");

  const result: ChatSettingsSyncResult = {
    staged: plan.updates.length,
    creations: plan.creations.map((entry) => entry.name),
    skipped: plan.skipped,
    rejected: verified.rejected,
    dropped: trimmed.dropped,
    unchanged: false,
    failed: false,
  };

  // **何を積んだかを記録に残す。** 承認待ちに並んだものが、どの相談から
  // 来たのかを後から追えないと、作者も開発側も確かめようがない
  appendChatLog(work, {
    panel: "相談パネル",
    promptVersion: CHAT_SETTINGS_SYNC_VERSION,
    provider: resolved.provider.displayName,
    model: resolved.model,
    paid: resolved.provider.isPaid,
    target: "相談を資料へ反映",
    question: "（相談を資料へ反映：この会話から、作者が決めた設定を拾う）",
    reply: describeForLog(verified.entries, result),
    proposals: verified.entries.map((entry) =>
      `${entry.name}: ${entry.summary}`
    ),
  });

  announce(work, result);
  return result;
}

/** 記録用の短い要約。積んだものと落としたものの両方を残す */
function describeForLog(
  entries: ReadonlyArray<{ name: string; summary: string }>,
  result: ChatSettingsSyncResult
): string {
  const lines = [
    `拾い出し ${entries.length}件 / 更新案 ${result.staged}件 / ` +
      `新規案 ${result.creations.length}件`,
  ];
  for (const entry of entries) lines.push(`- ${entry.name}: ${entry.summary}`);
  for (const item of result.rejected) {
    lines.push(`- 見送り（${item.reason}）: ${item.name}`);
  }
  for (const item of result.skipped) {
    lines.push(`- 見送り（${item.reason}）: ${item.name}`);
  }
  return lines.join("\n");
}

/**
 * 結果を作者へ知らせる。
 *
 * **作者が自分で押した操作なので、必ず返事をする**（プロット反映が
 * 保存のたびに黙るのとは違う）。積むものが無くても「無かった」と言う。
 */
function announce(work: WorkEntry, result: ChatSettingsSyncResult): void {
  const created = result.creations.length;
  const total = result.staged + created;
  const notes = describeNotes(result);

  if (total === 0) {
    void vscode.window.showInformationMessage(
      ["相談から反映できる決定は見つかりませんでした。", ...notes].join("")
    );
    return;
  }

  // **新規と更新は分けて数える。** 「更新案」とだけ言うと、
  // 資料に人が増える提案が混ざっていることが伝わらない
  const detail =
    created === 0
      ? "更新案"
      : result.staged === 0
        ? "新規案"
        : `案（新規${created}件・更新${result.staged}件）`;

  const message = [
    `相談から人物${total}件の${detail}を積みました。`,
    ...notes,
  ].join("");

  void vscode.window
    .showInformationMessage(message, "承認待ちを確認")
    .then((answer) => {
      if (answer !== "承認待ちを確認") return;
      // 作品を指定して呼ぶ。引数無しだと作品選択からやり直させてしまう
      void vscode.commands.executeCommand("novelai.applyPendingUpdates", {
        type: "work",
        work,
      });
    });
}

/**
 * 通知に添える「積まなかったもの」。
 *
 * **黙って捨てない。** 根拠が確かめられなかったものが何件あったかは、
 * 「AIが何も拾わなかった」のとは意味が違う。
 */
function describeNotes(result: ChatSettingsSyncResult): string[] {
  const lines: string[] = [];

  const ungrounded = result.rejected.filter(
    (item) => item.reason === "ungrounded"
  ).length;
  const placeholder = result.rejected.filter(
    (item) => item.reason === "placeholder"
  ).length;
  if (ungrounded > 0) {
    lines.push(
      `${ungrounded}件は、根拠が確認できず見送りました（会話に無い引用でした）。`
    );
  }
  if (placeholder > 0) {
    lines.push(`${placeholder}件は、中身が空だったため見送りました。`);
  }

  const confirmed = result.skipped
    .filter((entry) => entry.reason === "authorConfirmed")
    .map((entry) => entry.name);
  const ambiguous = result.skipped
    .filter((entry) => entry.reason === "ambiguous")
    .map((entry) => entry.name);
  if (confirmed.length > 0) {
    lines.push(
      `${confirmed.join("、")}は、作者が確定させた人物なので変えていません。`
    );
  }
  if (ambiguous.length > 0) {
    lines.push(
      `${ambiguous.join("、")}は、同じ呼び名の人物が資料に複数居るため当てられませんでした。`
    );
  }

  if (result.dropped > 0) {
    lines.push(
      `会話が長いため、古い発言${result.dropped}件は送っていません。`
    );
  }
  return lines;
}
