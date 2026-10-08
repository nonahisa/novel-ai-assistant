import * as vscode from "vscode";
import * as paths from "../core/paths";
import type { WorkEntry } from "../models/types";
import {
  isBlankPlotSection,
  parsePlotMarkdown,
  updatePlotMarkdown,
} from "../core/plotDoc";
import type { PlotDialogueSection } from "../core/plotInterview";
import {
  describePlotAdviceDrop,
  parsePlotAdviceAnswer,
} from "../core/plotAdviceValidation";
import { hasConflictMarkers } from "../core/textDecode";
import {
  readTextFile,
  writeTextFilePreservingFormat,
  type TextFileContent,
  type WriteTextFileResult,
} from "../core/textFile";
import { appendChatLog } from "../core/chatLog";
import {
  logFailure,
  logStep,
  responseExcerptForLog,
  useLogFile,
} from "../core/logger";
import {
  PLOT_ADVICE_SYSTEM_PROMPT,
  PLOT_ADVICE_TEMPERATURE,
  PLOT_ADVICE_VERSION,
  buildPlotAdvicePrompt,
  recentPlotAdviceHistory,
  type PlotAdviceTurn,
} from "../prompts/plotAdvice";
import { ensureConfigured, type AIRegistry } from "../ai/registry";
import { AIError, recoveryForAIError } from "../ai/types";
import {
  resolveOutputTokensForPlanning,
  resolveOutputTokensForSend,
} from "../ai/outputLimit";
import { confirmPaidUsage, confirmProviderReachable } from "./aiConnectivity";

/**
 * プロットモードのAI助言（P-01、設計書6.4.10。作者の裁定 2026-10-08「作る」）。
 *
 * プロットモードの画面の中で、作者が自由に話しかけ、AIが編集者として
 * プロットの組み立てを手伝う。画面（`plotModePanel.ts`）は押したことを
 * 渡すだけで、AIへの問い合わせ・答えの検算・書き込みはここが受け持つ
 * （名前の候補 `plotNameSuggest.ts` と同じ分け方。画面の外で試せるようにする）。
 *
 * ## 書くのは、作者が案を採ったときだけ
 *
 * AIの答えに書き込み案があっても、**画面に並べるだけで何も書かない**
 * （「サポートは書かない」）。書くのは［この案をプロットに書く］のときだけで、
 *
 * - 案は**ここに控えたもの**を使う。画面から届くのは案の番号だけ
 *   （画面から届いた文をそのまま書く道を作らない）
 * - 節の差し替えは `updatePlotMarkdown`（対話式プロット作成のまとめ P-44 が
 *   最終的に通る組み立てと同じ。作者の見出しの並び・自由に足した節を崩さない）
 * - 書き戻しは本文と同じ口 `writeTextFilePreservingFormat`（押した時点で
 *   読んだハッシュの照合・文字コードと改行の保持・退避→新規作成）
 * - **作者の書いた項目を置き換えるときは確認を出す**
 *
 * ## 会話は残さない
 *
 * 履歴はこの画面が開いているあいだだけ持つ（閉じたら消える）。対話式プロット
 * 作成（P-43）も問答を保存しない。やり取りそのものは、相談と同じ記録
 * （`.aiwriter/logs/chat.md`、`appendChatLog`）に残る——何を渡して何が返ったかを
 * あとで確かめるため。
 *
 * ## 割当は「AIに相談」
 *
 * 新しい割当の鍵は作らない（設計書6.28.9「作者が使い分けたい単位」）。
 * 会話でプロットを組み立てるのは、対話式プロット作成（P-43・P-44）と同じ
 * 「AIに相談」の割当で動く。出力の上限の見込みだけは `plot_advice` の名前で
 * 数える（短い問いの P-43 とは書く量が違う）。
 */

/** 出力の上限・呼び出しの記録に使う機能名 */
export const PLOT_ADVICE_FEATURE = "plot_advice";

/** 書き込み案の画面での状態 */
export type PlotAdviceSuggestionState = "open" | "written" | "dismissed";

/** 画面へ送る形（`plotAdvice`） */
export interface PlotAdviceView {
  status: "idle" | "busy";
  turns: Array<{
    role: "author" | "assistant";
    text: string;
    /** 答えを受け取れなかった・止めた（会話の続きには渡さない） */
    failed?: boolean;
    suggestion?: {
      id: string;
      heading: string;
      value: string;
      /** 書いてある項目を置き換える案 */
      overwrites: boolean;
      /** 作者の発言に無い言葉が多い案（一言添える） */
      grounded: boolean;
      state: PlotAdviceSuggestionState;
    };
  }>;
}

/** 控えておく書き込み案。**書くときはこれだけを使う** */
interface HeldSuggestion {
  section: PlotDialogueSection;
  heading: string;
  value: string;
}

export interface PlotAdviceDeps {
  work: WorkEntry;
  registry: AIRegistry;
  plotFile: string;
  /**
   * いまの plot.md の中身。**開いている文書があればその中身**
   * （作者が打ち込んだばかりの、保存前の行も見て助言する）
   */
  readPlot: () => Promise<string>;
  /** 画面へ送る */
  post: (view: PlotAdviceView) => void;
}

export class PlotAdviceSession {
  /** AIへ渡す会話（受け取れた往復だけ） */
  private history: PlotAdviceTurn[] = [];
  private view: PlotAdviceView = { status: "idle", turns: [] };
  private readonly held = new Map<string, HeldSuggestion>();
  private seq = 0;
  private controller: AbortController | undefined;
  /** 有料の確認を済ませた組（`provider:model`）。**この会話で一度だけ**訊く */
  private paidConfirmedFor: string | undefined;

  constructor(private readonly deps: PlotAdviceDeps) {}

  current(): PlotAdviceView {
    return this.view;
  }

  /** 画面を閉じた。答えを待っていたら止める */
  dispose(): void {
    this.controller?.abort();
    this.controller = undefined;
  }

  /** 会話を消す（AIへ渡す履歴も、控えた案も） */
  clear(): void {
    if (this.view.status === "busy") return;
    this.history = [];
    this.held.clear();
    this.update({ status: "idle", turns: [] });
  }

  /** 答えを待つのをやめる（作者が［止める］を押した） */
  stop(): void {
    this.controller?.abort();
  }

  /** 作者の発言を送る。答えを受け取れたら true */
  async send(rawText: unknown): Promise<boolean> {
    const text = typeof rawText === "string" ? rawText.trim() : "";
    if (!text) return false;
    if (this.view.status === "busy") {
      void vscode.window.showInformationMessage(
        "前の答えを待っています。止めるときは［止める］を押してください。"
      );
      return false;
    }
    const { work } = this.deps;
    useLogFile(work.folderPath);

    const plotText = await this.deps.readPlot();
    if (hasConflictMarkers(plotText)) {
      // 競合の印が残っている文書にはAIの処理を掛けない（実装ルール1）
      void vscode.window.showWarningMessage(
        "プロット（plot.md）に競合の印（<<<<<<<）が残っています。直してから送ってください。"
      );
      return false;
    }

    const resolved = await ensureConfigured(this.deps.registry, "chat");
    if (!resolved) return false;
    if (
      !(await confirmProviderReachable(resolved.provider, "プロットの相談", resolved.model))
    ) {
      return false;
    }
    const paidKey = `${resolved.provider.id}:${resolved.model}`;
    if (resolved.provider.isPaid && this.paidConfirmedFor !== paidKey) {
      const ok = await confirmPaidUsage(resolved.provider, {
        actionLabel: "プロットの相談",
        // 覚え書きの id は `core/confirmMemory.ts` に登録してある
        remember: { id: "ai.paid.plotAdvice" },
        work,
        model: resolved.model,
        detail:
          "送るたびに1回ずつ課金されます。送るのは、プロット（plot.md）の中身と、" +
          `この画面での直近の会話です。本文は送りません。\n（この確認はこの画面で一度だけです）`,
      });
      if (!ok) return false;
      this.paidConfirmedFor = paidKey;
    }

    const parsedPlot = parsePlotMarkdown(plotText);
    const history = recentPlotAdviceHistory(this.history);
    const userPrompt = buildPlotAdvicePrompt({
      workTitle: work.title,
      sections: parsedPlot.sections,
      extra: parsedPlot.extra,
      userMessage: text,
      history,
    });

    this.update({
      status: "busy",
      turns: [...this.view.turns, { role: "author", text }],
    });

    const controller = new AbortController();
    this.controller = controller;
    const started = Date.now();
    logStep(
      `プロットの相談: P-01 ${PLOT_ADVICE_VERSION} / ${work.title} / ` +
        `${resolved.provider.displayName} / ${resolved.model} / 履歴 ${history.length}件`
    );

    let responseText: string;
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    try {
      const response = await resolved.provider.generate({
        systemPrompt: PLOT_ADVICE_SYSTEM_PROMPT,
        userPrompt,
        model: resolved.model,
        temperature: PLOT_ADVICE_TEMPERATURE,
        maxOutputTokens: resolveOutputTokensForSend(
          resolved.provider.id,
          resolved.model,
          PLOT_ADVICE_FEATURE
        ),
        plannedOutputTokens: resolveOutputTokensForPlanning(
          resolved.provider.id,
          resolved.model,
          PLOT_ADVICE_FEATURE
        ),
        // **`numCtx` は渡さない。** 送るのはプロットと短い会話だけなので、
        // 受け皿（`ollamaProvider`）が実物の長さから見積もって明示する
        // （`findingAdvice.ts` と同じ）。**`jsonSchema` も渡さない**——答えは
        // 自然文で、渡すと Ollama の `format` で全体が JSON になる
        disableThinking: true,
        signal: controller.signal,
        meta: { feature: PLOT_ADVICE_FEATURE, workFolder: work.folderPath },
      });
      if (response.truncated) {
        logFailure("プロットの相談", {
          作品: work.title,
          内容: "答えが出力の上限で切れました",
          応答: responseExcerptForLog(response.text),
        });
        this.finishFailed(
          "答えが途中で切れました。短く聞き直すか、もう一度送ってください。"
        );
        return false;
      }
      responseText = response.text;
      usage = response.usage;
    } catch (error) {
      const cancelled =
        controller.signal.aborted ||
        (error instanceof AIError && error.kind === "aborted");
      if (cancelled) {
        // 中止は失敗ではない（作者が［止める］を押した・画面を閉じた）
        logStep("プロットの相談: 止めました");
        this.finishFailed("（止めました）");
        return false;
      }
      const message =
        error instanceof AIError
          ? `${error.message} ${recoveryForAIError(error)}`
          : messageOf(error);
      logFailure("プロットの相談", { 作品: work.title, 内容: message });
      this.finishFailed(`答えを受け取れませんでした。${message}`);
      return false;
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }

    const answer = parsePlotAdviceAnswer(responseText, {
      sections: parsedPlot.sections,
      authorTexts: [
        text,
        ...history.filter((turn) => turn.role === "author").map((turn) => turn.text),
      ],
    });
    for (const warning of answer.warnings) {
      logStep(`プロットの相談: ${warning}`);
    }
    if (answer.dropped) {
      logStep(
        `プロットの相談: ${describePlotAdviceDrop(answer.dropped)}（案は出しません）` +
          ` / ${responseExcerptForLog(answer.rawSuggestion ?? "")}`
      );
    }

    appendChatLog(work, {
      panel: "プロットモード",
      promptVersion: `P-01 ${PLOT_ADVICE_VERSION}`,
      provider: resolved.provider.displayName,
      model: resolved.model,
      paid: resolved.provider.isPaid,
      target: "プロット（plot.md）",
      question: text,
      reply: responseText,
      elapsedMs: Date.now() - started,
      usage,
      ...(answer.reply || answer.suggestion ? {} : { error: "答えが空でした" }),
    });

    if (!answer.reply && !answer.suggestion) {
      logFailure("プロットの相談", {
        作品: work.title,
        内容: "答えを読み取れませんでした",
        応答: responseExcerptForLog(responseText),
      });
      this.finishFailed("答えを読み取れませんでした。もう一度送ってください。");
      return false;
    }

    const reply = answer.reply || "プロットへの書き込み案があります。";
    this.history.push({ role: "author", text }, { role: "assistant", text: reply });

    let suggestion: PlotAdviceView["turns"][number]["suggestion"];
    if (answer.suggestion) {
      const id = `s${++this.seq}`;
      this.held.set(id, {
        section: answer.suggestion.section,
        heading: answer.suggestion.heading,
        value: answer.suggestion.value,
      });
      suggestion = {
        id,
        heading: answer.suggestion.heading,
        value: answer.suggestion.value,
        overwrites: answer.suggestion.overwrites,
        grounded: answer.suggestion.grounded,
        state: "open",
      };
    }
    this.update({
      status: "idle",
      turns: [
        ...this.view.turns,
        { role: "assistant", text: reply, ...(suggestion ? { suggestion } : {}) },
      ],
    });
    return true;
  }

  /** 案を採らない（何も書かない。画面の印だけを変える） */
  dismiss(id: unknown): void {
    if (typeof id !== "string" || !this.held.has(id)) return;
    this.held.delete(id);
    this.markSuggestion(id, "dismissed");
  }

  /**
   * 案をプロットに書く。**書けたら true**。
   *
   * 画面から届くのは番号だけ。控えに無い番号（古い画面・作り物の送信）は
   * 何もしない。
   */
  async apply(id: unknown): Promise<boolean> {
    if (typeof id !== "string") return false;
    const held = this.held.get(id);
    if (!held) {
      void vscode.window.showInformationMessage(
        "この案はもう使えません。もう一度相談してください。"
      );
      return false;
    }
    const { work, plotFile } = this.deps;
    useLogFile(work.folderPath);

    // **保存していない書きかけがあれば止める。** ディスクへ書くので、
    // 書きかけとぶつかる（書き戻しの口も止めるが、先に分かる言い方で断る）
    if (isDirtyDocument(plotFile)) {
      void vscode.window.showWarningMessage(
        "プロット（plot.md）に保存していない変更があります。保存してから［この案をプロットに書く］を押してください。"
      );
      return false;
    }

    let file: TextFileContent;
    try {
      // **押した時点で読む。** 答えを待つあいだに作者が書き足していても、
      // その中身の上に差し込む（読んでから書くまでの間はハッシュが見張る）
      file = await readTextFile(plotFile);
    } catch (error) {
      void vscode.window.showWarningMessage(
        `プロット（plot.md）を読めませんでした：${messageOf(error)}`
      );
      return false;
    }
    if (file.hasConflictMarkers) {
      void vscode.window.showWarningMessage(
        "プロット（plot.md）に競合の印（<<<<<<<）が残っているため、書くのを止めました。"
      );
      return false;
    }

    const current = parsePlotMarkdown(file.text).sections[held.section] ?? "";
    if (!isBlankPlotSection(current)) {
      if (current.trim() === held.value.trim()) {
        void vscode.window.showInformationMessage(
          `「${held.heading}」には、もう同じ中身が書いてあります。`
        );
        this.held.delete(id);
        this.markSuggestion(id, "written");
        return false;
      }
      // **作者の書いた項目を置き換えるときは訊く**（実装ルール2）
      const ok = "置き換える";
      const picked = await vscode.window.showWarningMessage(
        `「${held.heading}」には、もう書いてある文があります。この案で置き換えますか？`,
        {
          modal: true,
          detail:
            `いまの文：\n${clip(current.trim(), 300)}\n\n案：\n${clip(held.value, 300)}\n\n` +
            "置き換える前の plot.md は回復先に退避します。",
        },
        ok
      );
      if (picked !== ok) return false;
    }

    const next = updatePlotMarkdown(
      file.text,
      { [held.section]: held.value },
      { workTitle: work.title }
    );
    if (next === file.text) {
      void vscode.window.showInformationMessage(
        `「${held.heading}」は書き換わりませんでした（同じ中身です）。`
      );
      return false;
    }

    const written = await writeTextFilePreservingFormat(plotFile, next, file, file.hash);
    if (!written.ok) {
      logFailure("プロットの相談の書き込み", {
        作品: work.title,
        項目: held.heading,
        理由: written.reason,
        詳細: written.detail ?? "",
      });
      void vscode.window.showWarningMessage(describeWriteFailure(written));
      return false;
    }

    this.held.delete(id);
    this.markSuggestion(id, "written");
    logStep(`プロットの相談: 「${held.heading}」に案を書きました（${work.title}）`);
    void vscode.window.showInformationMessage(
      `プロットの「${held.heading}」に書きました。`
    );
    return true;
  }

  private finishFailed(message: string): void {
    this.update({
      status: "idle",
      turns: [...this.view.turns, { role: "assistant", text: message, failed: true }],
    });
  }

  private markSuggestion(id: string, state: PlotAdviceSuggestionState): void {
    this.update({
      ...this.view,
      turns: this.view.turns.map((turn) =>
        turn.suggestion?.id === id
          ? { ...turn, suggestion: { ...turn.suggestion, state } }
          : turn
      ),
    });
  }

  private update(view: PlotAdviceView): void {
    this.view = view;
    this.deps.post(view);
  }
}

function describeWriteFailure(result: WriteTextFileResult): string {
  if (result.ok) return "";
  switch (result.reason) {
    case "unsaved_changes":
      return "プロット（plot.md）に保存していない変更があります。保存してから押してください。";
    case "modified_externally":
      return "読んだあとにプロット（plot.md）が書き換わったため、書くのを止めました。もう一度押してください。";
    case "conflict_markers":
      return "プロット（plot.md）に競合の印（<<<<<<<）が残っているため、書くのを止めました。";
    case "encoding_error":
      return "プロット（plot.md）を元の文字コードで書き出せないため、書くのを止めました。";
    default:
      return `プロット（plot.md）に書き込めませんでした。${result.detail ?? ""}`;
  }
}

function isDirtyDocument(filePath: string): boolean {
  return vscode.workspace.textDocuments.some(
    (document) =>
      document.isDirty && paths.isSamePath(paths.fromUri(document.uri), filePath)
  );
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
