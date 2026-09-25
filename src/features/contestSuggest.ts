// ログの書き先：作品ごと（`useLogFile(work.folderPath)`）
import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { AIRegistry, ensureConfigured } from "../ai/registry";
import { AIError } from "../ai/types";
import {
  resolveOutputTokensForPlanning,
  resolveOutputTokensForSend,
} from "../ai/outputLimit";
import { charLimitSummary, type StoredContest } from "../core/contestInbox";
import { contestMatchText, hasWorkProfile, workProfileText } from "../core/contestMatchText";
import type { ForecastCandidate } from "../core/contestForecast";
import {
  validateContestSuggestions,
  type ContestSuggestion,
} from "../core/contestSuggestValidation";
import {
  buildContestSuggestPrompt,
  CONTEST_SUGGEST_SCHEMA,
  CONTEST_SUGGEST_SYSTEM_PROMPT,
  CONTEST_SUGGEST_TEMPERATURE,
  CONTEST_SUGGEST_VERSION,
  type ContestSuggestCandidate,
} from "../prompts/contestSuggest";
import {
  CHECK_CANCELLED,
  CHECK_COMPLETED,
  CHECK_FAILED,
  type CheckCommandOutcome,
} from "../core/proofreadingSuite";
import { logFailure, logStep, responseExcerptForLog, useLogFile } from "../core/logger";
import { cancelItem, isCancelItem } from "../views/dialogs";
import { withCancellableProgress } from "../views/progress";
import { warnWithLog } from "../views/notify";
import { confirmPaidUsage, confirmProviderReachable } from "./aiConnectivity";
import { reportAIError } from "./reportAIError";
import { confirmAndSave } from "./contestImport";
import {
  forecastTitle,
  prepareForecast,
  toRanked,
  type ContestForecastDeps,
  type ForecastPlan,
} from "./contestForecast";
import { scoreContestsByWork, similarityGuide } from "./contestSimilarity";

/**
 * AIが応募先を提案する（設計書6.3.6.5、P-42）。**隠し機能**。
 *
 * 詳細メニューには出さない。入口はコマンドパレット（「応募先をAIに提案してもらう」）と、
 * 相談（「応募先を提案して」）だけ（作者の裁定、2026-09-23）。
 *
 * 1. 完成予定から候補を選び出す（`prepareForecast`。締切と字数はコードが先に選り分ける）
 * 2. 候補が多ければ絞る——ベクトル検索の準備が済んでいれば作品に近い順、
 *    無ければ締切の近い順で `MAX_AI_CANDIDATES` 件まで
 * 3. 送る量と費用を示してから、AIに候補の中から並べてもらう
 * 4. **コードで確かめる**（候補に実在するか・指示の言葉の返り。`contestSuggestValidation.ts`）
 * 5. 選べば、これまでの「応募先に入れる」流れ（確かめる画面）へ
 *
 * 答えは覚えない（キャッシュしない）。候補は取り込み直すたびに変わり、1回の呼び出しで済むため。
 */

/** AIへ渡す候補の上限。多すぎると小さなモデルは後ろの候補を読まない */
export const MAX_AI_CANDIDATES = 15;

export interface ContestSuggestDeps extends ContestForecastDeps {
  readonly aiRegistry: AIRegistry;
}

export async function suggestContestsByAI(
  work: WorkEntry,
  deps: ContestSuggestDeps
): Promise<CheckCommandOutcome> {
  useLogFile(work.folderPath);
  const plan = await prepareForecast(work, deps);
  if (!plan) return CHECK_CANCELLED;
  if (plan.selection.candidates.length === 0) {
    void vscode.window.showInformationMessage(
      `${forecastTitle(plan)}。締切に間に合い字数の合う公募が、取り込んだ中にありませんでした。` +
        "AIに頼む候補がありません。新しい一覧を取り込んでからお試しください。"
    );
    return CHECK_CANCELLED;
  }
  if (!hasWorkProfile(plan.profile)) {
    void vscode.window.showWarningMessage(
      "作品の概要がまだ無いため、AIが公募と比べる材料がありません。" +
        "プロット（設定/plot.md）のジャンル・ログライン・あらすじか、作品紹介文を書いてからお試しください。"
    );
    return CHECK_CANCELLED;
  }

  const narrowed = await narrowCandidates(plan);
  const candidates: (ContestSuggestCandidate & { entry: ForecastCandidate })[] = narrowed.list.map(
    (entry, index) => ({
      id: `C${index + 1}`,
      name: entry.contest.name,
      deadline: entry.deadline,
      chars: charLimitSummary(entry.contest.charLimit),
      text: contestMatchText(entry.contest),
      entry,
    })
  );

  const resolved = await ensureConfigured(deps.aiRegistry, "generate");
  if (!resolved) return CHECK_CANCELLED;

  const userPrompt = buildContestSuggestPrompt({ profile: plan.profile, candidates });
  const sendChars = CONTEST_SUGGEST_SYSTEM_PROMPT.length + userPrompt.length;
  const volume =
    `送るのは、作品の概要（${workProfileText(plan.profile).length}字。本文は送りません）と、` +
    `公募${candidates.length}件の募集内容です（合わせて約${sendChars.toLocaleString("ja-JP")}字）。` +
    (narrowed.note ? `\n${narrowed.note}` : "");

  // **繋がるかを、費用の確認より先に確かめる**（設計書6.51）
  if (!(await confirmProviderReachable(resolved.provider, "応募先の提案", resolved.model))) {
    return CHECK_CANCELLED;
  }
  if (resolved.provider.isPaid) {
    const ok = await confirmPaidUsage(resolved.provider, {
      actionLabel: "応募先の提案",
      remember: { id: "ai.paid.contestSuggest" },
      work,
      model: resolved.model,
      calls: 1,
      detail: volume,
    });
    if (!ok) return CHECK_CANCELLED;
  } else {
    // 無料のAIでも、押す前に何をどれだけ送るかを示す（CLAUDE.md 実装スタイル）
    const go = "提案してもらう";
    const answer = await vscode.window.showInformationMessage(
      `「${work.title}」の応募先を、AI（${resolved.provider.displayName}・${resolved.model}）に提案してもらいますか？`,
      { modal: true, detail: `AIの呼び出しは1回です。\n${volume}` },
      go
    );
    if (answer !== go) return CHECK_CANCELLED;
  }

  let responseText: string | undefined;
  let failure: unknown;
  await withCancellableProgress("応募先の提案を待っています", async (_progress, token) => {
    const controller = new AbortController();
    token.onCancellationRequested(() => controller.abort());
    try {
      logStep(
        `応募先の提案を開始: ${work.title} / ${resolved.provider.displayName} / ` +
          `${resolved.model} / v${CONTEST_SUGGEST_VERSION} / 候補${candidates.length}件`
      );
      const response = await resolved.provider.generate({
        systemPrompt: CONTEST_SUGGEST_SYSTEM_PROMPT,
        userPrompt,
        model: resolved.model,
        temperature: CONTEST_SUGGEST_TEMPERATURE,
        maxOutputTokens: resolveOutputTokensForSend(
          resolved.provider.id,
          resolved.model,
          "contest_suggest"
        ),
        plannedOutputTokens: resolveOutputTokensForPlanning(
          resolved.provider.id,
          resolved.model,
          "contest_suggest"
        ),
        jsonSchema: CONTEST_SUGGEST_SCHEMA as unknown as object,
        disableThinking: true,
        meta: { feature: "contest_suggest", workFolder: work.folderPath },
        signal: controller.signal,
      });
      if (response.truncated) {
        failure = new Error("応答が出力上限で切れました。");
        return;
      }
      responseText = response.text;
    } catch (error) {
      failure = error;
    }
  });

  if (failure) {
    if (failure instanceof AIError && failure.kind === "aborted") return CHECK_CANCELLED;
    reportAIError("応募先の提案", failure);
    return CHECK_FAILED;
  }
  if (!responseText) return CHECK_FAILED;

  const validated = validateContestSuggestions(responseText, candidates);
  if (!validated) {
    logFailure("応募先の提案を読み取れませんでした", {
      応答: responseExcerptForLog(responseText),
    });
    await warnWithLog(
      "AIの提案を読み取れませんでした（候補に無い公募だけだった、理由が空だった、または形が読めなかった）。" +
        "完成予定から公募を選ぶ画面では、AIを使わずに候補を見られます。"
    );
    return CHECK_FAILED;
  }
  // **外したものは黙って落とさない**（記録にも残す）
  for (const note of validated.notes) logStep(`応募先の提案の検算：${note}`);

  // **「合う公募なし」は正しい答え**（残課題 F8）。失敗として知らせない
  if (validated.suggestions.length === 0) {
    logStep(`応募先の提案：候補${candidates.length}件のうち、合う公募は無いという答え`);
    void vscode.window.showInformationMessage(
      "合う公募は見つかりませんでした（AIが候補の募集内容と作品の概要を読み比べた結果です）。" +
        "完成予定から公募を選ぶ画面では、AIを使わずに候補を見られます。"
    );
    return CHECK_COMPLETED;
  }

  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate.entry]));
  const picked = await vscode.window.showQuickPick(
    [...suggestionItems(validated.suggestions, byId), cancelItem()],
    {
      title: `「${work.title}」の応募先の提案（${forecastTitle(plan)}）`,
      placeHolder:
        "AIが候補の中から合う順に並べました。選ぶと中身を確かめてから入れます。" +
        (validated.notes.length > 0 ? `（${validated.notes.join(" ")}）` : ""),
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked) || !("entry" in picked) || !picked.entry) {
    return CHECK_COMPLETED;
  }
  await confirmAndSave(work, toRanked(picked.entry, plan.today), deps);
  return CHECK_COMPLETED;
}

function suggestionItems(
  suggestions: readonly ContestSuggestion[],
  byId: ReadonlyMap<string, ForecastCandidate>
): (vscode.QuickPickItem & { entry?: ForecastCandidate })[] {
  return suggestions.flatMap((suggestion, index) => {
    const entry = byId.get(suggestion.id);
    if (!entry) return [];
    return [
      {
        label: `${index + 1}. ${entry.contest.name}`,
        description: `締切 ${entry.deadline}（締切まで余裕${entry.slackDays}日）　${charLimitSummary(entry.contest.charLimit)}`,
        detail: suggestion.reason,
        entry,
      },
    ];
  });
}

/**
 * 候補が多ければ絞る。**ベクトル検索の準備が済んでいれば作品に近い順**、
 * 無ければ（または測れなければ）締切の近い順（`selectContestsForForecast` の並び）。
 */
async function narrowCandidates(
  plan: ForecastPlan
): Promise<{ list: readonly ForecastCandidate[]; note: string }> {
  const all = plan.selection.candidates;
  if (all.length <= MAX_AI_CANDIDATES) return { list: all, note: "" };
  if (plan.similarity.ready) {
    const scores: Map<StoredContest, number> | undefined = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "公募と作品の近さを測っています" },
      () => scoreContestsByWork(plan.profile, all.map((entry) => entry.contest))
    );
    if (scores) {
      const list = [...all]
        .sort((a, b) => (scores.get(b.contest) ?? -2) - (scores.get(a.contest) ?? -2))
        .slice(0, MAX_AI_CANDIDATES);
      return {
        list,
        note: `候補${all.length}件のうち、作品に近い${MAX_AI_CANDIDATES}件に絞りました。`,
      };
    }
  }
  return {
    list: all.slice(0, MAX_AI_CANDIDATES),
    note:
      `候補${all.length}件のうち、締切の近い${MAX_AI_CANDIDATES}件に絞りました。` +
      (plan.similarity.ready ? "" : similarityGuide(plan.similarity)),
  };
}
