import * as vscode from "vscode";
import * as paths from "../core/paths";
import type { WorkEntry } from "../models/types";
import type { Character } from "../models/character";
import {
  readTextFile,
  writeTextFilePreservingFormat,
  type TextFileContent,
  type WriteTextFileResult,
} from "../core/textFile";
import { CharacterStore } from "../core/characterStore";
import {
  createAbilityStore,
  createLocationStore,
  createOrganizationStore,
} from "../core/abilityStore";
import { PendingUpdateStore, type PendingUpdate } from "../core/pendingUpdates";
import { buildNameEntries } from "../core/nameCollision";
import {
  originToRemember,
  planNameOrigin,
  type NameOriginPlan,
} from "../core/nameOriginFit";
import { readRememberedNameOrigin } from "../core/nameOriginStore";
import { normalizeName } from "../core/characterMerge";
import {
  buildNewCharacterRecords,
  findCharactersByAppellation,
} from "../core/plotCharacterSync";
import { classifyRoleName } from "../core/plotRoleNames";
import {
  buildRoleRenameProposal,
  findRoleOnlyCharacters,
  insertNamesIntoPlot,
  settingFromPlotText,
  type PlotNamePick,
  type PlotRoleTarget,
} from "../core/plotNameTargets";
import {
  screenPlotNameCandidates,
  type PlotNameDrop,
} from "../core/plotNameCandidates";
import type { NameCandidate, NameOrigin } from "../prompts/nameSuggest";
import {
  PLOT_NAME_SUGGEST_COUNT,
  PLOT_NAME_SUGGEST_SYSTEM_PROMPT,
  PLOT_NAME_SUGGEST_TEMPERATURE,
  PLOT_NAME_SUGGEST_VERSION,
  buildPlotNameSuggestPrompt,
  buildPlotNameSuggestSchema,
  parsePlotNameSuggestAnswer,
} from "../prompts/plotNameSuggest";
import { AIRegistry, ensureConfigured } from "../ai/registry";
import { AIError } from "../ai/types";
import {
  resolveOutputTokensForPlanning,
  resolveOutputTokensForSend,
} from "../ai/outputLimit";
import { withCancellableProgress } from "../views/progress";
import { warnWithLog } from "../views/notify";
import { reportAIError } from "./reportAIError";
import { confirmPaidUsage, confirmProviderReachable } from "./aiConnectivity";
import { markPlotCharactersSynced } from "./plotCharacterSync";
import { recordRoleRenameOffers } from "./roleRenameOffers";
import { describeOriginPlan, pickOrigin, rememberOrigin } from "./nameCheck";
import {
  logFailure,
  logStep,
  responseExcerptForLog,
  useLogFile,
} from "../core/logger";

/**
 * プロットモードの「名前の候補を出す」（設計書6.4.8。作者の依頼、2026-09-25）。
 *
 * plot.md の「主要登場人物」で**役名だけ**の人物（「主人公：〜」「班長：〜」）を
 * まとめて拾い、1回のAI呼び出し（P-45）で人物ごとに名前の候補を出す。
 * 作者が人物ごとに1つ選び、［入れる］を押したときだけ書く。
 *
 * ## 書くのは2か所
 *
 * 1. **plot.md の該当の行**：「主人公：〜」→「主人公（相馬 誠）：〜」。
 *    書き戻しは本文と同じ口（`writeTextFilePreservingFormat`）——読み込み時の
 *    ハッシュ照合（候補を待つあいだに書き換わっていたら止める）・文字コードと
 *    改行の保持・退避→新規作成
 * 2. **設定資料**：新規の人物として**承認待ちへ置くだけ**（名前・読み・役割・説明）。
 *    台帳へは作者が承認したときに入る（プロットからの反映 6.4.9 と同じ道）。
 *    同じ名前の人物が資料か承認待ちに既にいれば置かない。
 *    **資料に名前が役名だけの同じ人物（「主人公」）がいれば、新規ではなく
 *    その人物の名前を直す更新案**にする（作者の裁定、2026-09-25 午前。
 *    名前を 主人公 → 相馬 誠、元の役名は役割の欄へ、読みを入れる）
 *
 * **キャッシュしない**（P-29 と同じ。同じ人物へ何度も頼むのは、違う候補が
 * 欲しい場面である）。
 */

/** 候補を出したときの控え。［入れる］で照らし合わせる */
export interface PlotNameSession {
  plotFile: string;
  /** 読んだときの中身（ハッシュ・文字コード・改行を含む）。書き足す元 */
  file: TextFileContent;
  targets: PlotRoleTarget[];
  /** 人物の id → 残した候補。**画面から届いた名前は、ここにあるものしか受け取らない** */
  candidates: Map<string, NameCandidate[]>;
}

/** 画面へ送る形（`plotNames`） */
export interface PlotNamesView {
  status: "idle" | "busy" | "ready";
  note: string;
  people: Array<{
    id: string;
    role: string;
    summary: string;
    /** 役名か迷った人物に添える一言。言い切れる人物は空 */
    unsure: string;
    /**
     * 設定資料に役名だけの同じ人物がいるときの一言（選んだ名前に直す案を
     * 承認待ちへ置くと伝える）。いなければ空
     */
    ledger: string;
    candidates: Array<{ name: string; reading: string; note: string }>;
    dropped: PlotNameDrop[];
  }>;
}

export const IDLE_PLOT_NAMES: PlotNamesView = { status: "idle", note: "", people: [] };

/**
 * 候補を出す。取りやめた・出せなかったときは undefined。
 *
 * @param onBusy AIへ送る直前に呼ぶ（画面のボタンを押せなくする）
 */
export async function suggestPlotNames(
  work: WorkEntry,
  registry: AIRegistry,
  plotFile: string,
  onBusy: () => void
): Promise<{ session: PlotNameSession; view: PlotNamesView } | undefined> {
  useLogFile(work.folderPath);

  // **書きかけの plot.md があれば止める。** 拾うのはディスクの中身で、
  // 書き足すのもディスクへである。画面の書きかけと食い違ったまま進めると、
  // ［入れる］で保存していない書きかけとぶつかる
  if (isDirtyDocument(plotFile)) {
    void vscode.window.showWarningMessage(
      "プロット（plot.md）に保存していない変更があります。保存してから押してください。"
    );
    return undefined;
  }

  let file: TextFileContent;
  try {
    file = await readTextFile(plotFile);
  } catch (error) {
    void vscode.window.showWarningMessage(
      `プロット（plot.md）を読めませんでした：${messageOf(error)}`
    );
    return undefined;
  }
  if (file.hasConflictMarkers) {
    // 競合の印が残っている文書にはAIの処理を掛けない（実装ルール1）
    void vscode.window.showWarningMessage(
      "プロット（plot.md）に競合の印（<<<<<<<）が残っています。直してから押してください。"
    );
    return undefined;
  }

  const loaded = await new CharacterStore(work).loadAll();
  if (loaded.errors.length > 0) {
    // 読めない人物があるまま突き合わせると、名前のある人を「役名だけ」と
    // 見てしまう（プロットからの反映 6.4.9 と同じ判断）
    void vscode.window.showWarningMessage(
      `読み込めない人物設定が ${loaded.errors.length} 件あるため、名前の候補を出せません。`
    );
    return undefined;
  }

  const scan = findRoleOnlyCharacters(file.text, loaded.characters);
  if (!scan.hasSection) {
    void vscode.window.showInformationMessage(
      "プロットに「## 主要登場人物」の節がありません。人物を「- 主人公：説明」の形で書くと、名前の候補を出せます。"
    );
    return undefined;
  }
  if (scan.targets.length === 0) {
    void vscode.window.showInformationMessage(
      "「主要登場人物」に、名前がまだ無く役名だけの人物は見つかりませんでした。" +
        (scan.skipped.length > 0
          ? `（見た人物：${scan.skipped
              .map((entry) => `${entry.name}＝${entry.reason}`)
              .join("、")}）`
          : "")
    );
    return undefined;
  }

  const chosenTargets = await pickTargets(scan.targets);
  if (!chosenTargets) return undefined;

  // 名前の生成は「生成系」の割当に従う（名前の点検と同じ扱い）
  const resolved = await ensureConfigured(registry, "generate");
  if (!resolved) return undefined;

  // 名前点検と同じく、この作品で覚えている系統を使う（設計書6.37.2）
  const remembered = await readRememberedNameOrigin(work);
  const origin = await pickOrigin(
    `名前の系統（${chosenTargets.length}人に${PLOT_NAME_SUGGEST_COUNT}件ずつ候補を出します）`,
    remembered
  );
  if (origin === undefined) return undefined;

  // 繋がるかを、費用の確認より先に確かめる（設計書6.51。名前の点検と同じ順）
  if (!(await confirmProviderReachable(resolved.provider, "名前の候補づくり", resolved.model))) {
    return undefined;
  }
  const ok = await confirmPaidUsage(resolved.provider, {
    actionLabel: "プロットの人物の名前の候補",
    remember: { id: "ai.paid.plotNameSuggest" },
    work,
    model: resolved.model,
    calls: 1,
    detail:
      `送るのは、選んだ${chosenTargets.length}人の役名と説明、既にある名前の一覧、` +
      "プロットの世界観の節だけです。本文は送りません。候補が出るだけで、" +
      "［入れる］を押すまで何も書き換わりません。",
  });
  if (!ok) return undefined;

  const material = await collectMaterial(
    work,
    loaded.characters,
    file.text,
    origin === "auto" ? undefined : origin,
    remembered
  );
  const plan = material.plan;

  onBusy();
  let responseText: string | undefined;
  let failure: unknown;
  await withCancellableProgress(
    `${chosenTargets.length}人の名前の候補を考えています`,
    async (_progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());
      try {
        logStep(
          `プロットの名前の候補を開始: ${work.title} / ${chosenTargets
            .map((target) => target.role)
            .join("・")} / ${resolved.provider.displayName} / ${resolved.model} / ` +
            `v${PLOT_NAME_SUGGEST_VERSION} / 系統 ${plan.choices.join("・")}（${plan.basis}）`
        );
        const response = await resolved.provider.generate({
          systemPrompt: PLOT_NAME_SUGGEST_SYSTEM_PROMPT,
          userPrompt: buildPlotNameSuggestPrompt({
            workTitle: work.title,
            setting: material.setting,
            existingNames: material.existingNames,
            people: chosenTargets.map((target) => ({
              id: target.id,
              role: target.role,
              summary: target.summary,
            })),
            plan,
          }),
          model: resolved.model,
          temperature: PLOT_NAME_SUGGEST_TEMPERATURE,
          // 見込みと実上限を分けて渡す（設計書6.77の第2段）。人数で書く量が
          // 変わるので、名前の点検とは別の機能名で数える
          maxOutputTokens: resolveOutputTokensForSend(
            resolved.provider.id,
            resolved.model,
            "plot_name_suggest"
          ),
          plannedOutputTokens: resolveOutputTokensForPlanning(
            resolved.provider.id,
            resolved.model,
            "plot_name_suggest"
          ),
          jsonSchema: buildPlotNameSuggestSchema(plan.choices) as unknown as object,
          disableThinking: true,
          meta: { feature: "plot_name_suggest", workFolder: work.folderPath },
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
    }
  );

  if (failure || responseText === undefined) {
    const cancelled = failure instanceof AIError && failure.kind === "aborted";
    logEnd({ failed: !cancelled, cancelled, people: chosenTargets.length, kept: 0, dropped: 0 });
    if (!cancelled) reportAIError("名前の候補づくり", failure);
    return undefined;
  }

  const answer = parsePlotNameSuggestAnswer(
    responseText,
    chosenTargets.map((target) => target.id)
  );
  if (answer.people.size === 0) {
    // 応答の中身は捨てない。通知に出さなくても、ログには残す
    logFailure("プロットの名前の候補", {
      理由: "応答を読み取れません",
      応答: responseExcerptForLog(responseText),
    });
    await warnWithLog("名前の候補を読み取れませんでした。");
    logEnd({ failed: true, cancelled: false, people: chosenTargets.length, kept: 0, dropped: 0 });
    return undefined;
  }
  if (answer.unmatched > 0) {
    logStep(`プロットの名前の候補：人物に当てられなかった答え ${answer.unmatched}件（読み飛ばしました）`);
  }
  if (answer.byOrder > 0) {
    logStep(`プロットの名前の候補：id が読めない答え ${answer.byOrder}件を、並びの位置で人物に当てました`);
  }

  const screened = screenPlotNameCandidates(
    chosenTargets.map((target) => ({
      id: target.id,
      label: target.role,
      candidates: answer.people.get(target.id) ?? [],
    })),
    plan,
    material.entries,
    answer.origin
  );
  if (screened.converted.length > 0) {
    logStep(
      `プロットの名前の候補：英字の名前を読みからカタカナに直しました（${screened.converted
        .map((item) => `${item.from}→${item.to}`)
        .join("・")}）`
    );
  }

  const candidates = new Map<string, NameCandidate[]>();
  const view: PlotNamesView = { status: "ready", note: "", people: [] };
  let kept = 0;
  let dropped = 0;
  for (const target of chosenTargets) {
    const person = screened.people.find((entry) => entry.id === target.id);
    const list = person?.kept ?? [];
    candidates.set(target.id, list);
    kept += list.length;
    dropped += person?.dropped.length ?? 0;
    view.people.push({
      id: target.id,
      role: target.role,
      summary: target.summary,
      unsure: target.kind === "unsure" ? `役名か迷いました（${target.reason}）` : "",
      ledger: target.ledger
        ? `設定資料の「${target.ledger.name}」を、選んだ名前に直す案を承認待ちに置きます（元の役名は役割の欄へ）`
        : "",
      candidates: list.map((candidate) => ({
        name: candidate.name,
        reading: candidate.reading,
        note: candidate.note,
      })),
      dropped: person?.dropped ?? [],
    });
  }
  // 最初に決まった系統を覚える（名前点検と同じ決め方・同じ置き場所）
  await rememberOrigin(
    work,
    originToRemember(plan, remembered, screened.origin, kept),
    "プロットの名前の候補"
  );
  view.note =
    // 書き方は名前点検と揃える（覚えている系統なら変え方も添える）
    `${describeOriginPlan(plan, screened.origin)}。人物ごとに1つ選んで［入れる］を押すと、プロットの行に「役名（名前）」の形で書き足し、` +
    (chosenTargets.some((target) => target.ledger)
      ? "設定資料には新規の人物として（資料に役名だけの人物がいれば、その名前を直す案として）承認待ちに置きます。"
      : "設定資料には新規の人物として承認待ちに置きます。") +
    "選ばない人物はそのままです。";

  logEnd({ failed: false, cancelled: false, people: chosenTargets.length, kept, dropped });
  return {
    session: { plotFile, file, targets: chosenTargets, candidates },
    view,
  };
}

/** 画面から届いた選び方 */
export interface PlotNameChoice {
  id: string;
  name: string;
}

/**
 * 選んだ名前を入れる。**書けたら true**（画面の候補を片付けてよい）。
 *
 * 画面から届いた名前は信用しない——控え（`session.candidates`）にある
 * 名前だけを受け取る。
 */
export async function applyPlotNames(
  work: WorkEntry,
  session: PlotNameSession,
  choices: readonly PlotNameChoice[]
): Promise<boolean> {
  useLogFile(work.folderPath);

  const picks: Array<PlotNamePick & { target: PlotRoleTarget; candidate: NameCandidate }> = [];
  for (const choice of choices) {
    const target = session.targets.find((entry) => entry.id === choice.id);
    const candidate = session.candidates
      .get(choice.id)
      ?.find((entry) => entry.name === choice.name);
    if (!target || !candidate) continue;
    picks.push({
      lineIndex: target.lineIndex,
      lineText: target.lineText,
      role: target.role,
      name: candidate.name,
      target,
      candidate,
    });
  }
  if (picks.length === 0) {
    void vscode.window.showInformationMessage(
      "名前が選ばれていません。人物ごとに候補を1つ選んでから［入れる］を押してください。"
    );
    return false;
  }

  const inserted = insertNamesIntoPlot(session.file.text, picks);
  if (inserted.applied.length === 0) {
    void vscode.window.showWarningMessage(
      "プロットの行が候補を出したときと変わっているため、入れられませんでした。もう一度「名前の候補を出す」を押してください。"
    );
    return false;
  }

  const written = await writeTextFilePreservingFormat(
    session.plotFile,
    inserted.text,
    session.file,
    session.file.hash
  );
  if (!written.ok) {
    logFailure("プロットの名前の書き足し", {
      作品: work.title,
      理由: written.reason,
      詳細: written.detail ?? "",
    });
    void vscode.window.showWarningMessage(describeWriteFailure(written));
    return false;
  }

  const applied = picks.filter((pick) => inserted.applied.includes(pick));
  const staged = await stagePendingCharacters(work, applied);
  // 反映済みの印を追いつかせる（同じ人を読みの無い案で積み直さない）
  try {
    await markPlotCharactersSynced(work, session.file.text, inserted.text);
  } catch (error) {
    // 印が進まなくても、次の反映で同じ人が積み直されるだけ（読みは引き継ぐ）
    logFailure("プロットの名前の書き足し（反映済みの印）", {
      作品: work.title,
      詳細: messageOf(error),
    });
  }

  logStep(
    `プロットの名前を書き足しました: ${work.title} / ${applied
      .map((pick) => `${pick.role}→${pick.name}`)
      .join("・")} / 承認待ちへ 新規 ${staged.staged.length}件・名前を直す案 ${
        staged.renamed.length
      }件` +
      (staged.skipped.length > 0 ? ` / 置かなかった ${staged.skipped.join("・")}` : "") +
      (staged.changed.length > 0
        ? ` / 資料の人物が変わっていて置かなかった ${staged.changed.join("・")}`
        : "")
  );

  const notes = [
    `プロットの${applied.length}人に名前を入れました（${applied
      .map((pick) => `${pick.role}→${pick.name}`)
      .join("、")}）。`,
  ];
  if (staged.staged.length > 0) {
    notes.push(
      `設定資料には新規の人物${staged.staged.length}人を承認待ちに置きました（「設定資料更新分反映」で確認できます）。`
    );
  }
  if (staged.renamed.length > 0) {
    notes.push(
      `設定資料にいた${staged.renamed
        .map((entry) => `${entry.from}→${entry.to}`)
        .join("、")}は、名前を直す案を承認待ちに置きました（承認するまで資料は変わりません。「設定資料更新分反映」で確認できます）。`
    );
  }
  if (staged.skipped.length > 0) {
    notes.push(
      `${staged.skipped.join("、")}は、同じ名前の人物が資料か承認待ちにいるため置いていません。`
    );
  }
  if (staged.changed.length > 0) {
    notes.push(
      `${staged.changed.join("、")}は、資料の人物が候補を出したときと変わっているため、名前を直す案を置いていません。`
    );
  }
  if (staged.error) {
    notes.push(
      `ただし承認待ちへ置けませんでした（${staged.error}）。「プロットの人物を資料へ反映」で積み直せます。`
    );
  }
  if (inserted.missing.length > 0) {
    notes.push(
      `${inserted.missing.map((pick) => pick.role).join("、")}は行が変わっていたため入れていません。`
    );
  }
  const message = notes.join("");
  if (staged.error || inserted.missing.length > 0) {
    void vscode.window.showWarningMessage(message);
  } else {
    void vscode.window.showInformationMessage(message);
  }
  return true;
}

/** 承認待ちへ置いた結果 */
interface StagedPlotNames {
  /** 新規の人物として置いた名前 */
  staged: string[];
  /** 資料の役名の人物を直す案として置いたもの（元の名前 → 選んだ名前） */
  renamed: Array<{ from: string; to: string }>;
  /** 同じ名前の人物が資料か承認待ちにいるため、置かなかった名前 */
  skipped: string[];
  /** 資料の人物が候補を出したときと変わっていたため、置かなかった役名 */
  changed: string[];
  error?: string;
}

/**
 * 承認待ちへ置く。
 *
 * - 資料に役名だけの同じ人物がいれば（`target.ledger`）、**その人物の名前を
 *   直す更新案**（作者の裁定、2026-09-25 午前）。いなければ**新規の人物**
 * - **同じ名前の人物が資料か承認待ちにいれば置かない**（二重に作らない）
 * - プロットから役名だけで積まれていた古い新規案（「主人公」）は片付ける——
 *   名前を入れたあとも残すと、承認したときに「主人公」と「相馬 誠」の2人ができる
 */
async function stagePendingCharacters(
  work: WorkEntry,
  picks: ReadonlyArray<{ target: PlotRoleTarget; candidate: NameCandidate }>
): Promise<StagedPlotNames> {
  const result: StagedPlotNames = { staged: [], renamed: [], skipped: [], changed: [] };
  try {
    const store = new PendingUpdateStore(work);
    const [ledger, pending] = await Promise.all([
      new CharacterStore(work).loadAll(),
      store.loadAll(),
    ]);
    const creations = pending.updates.filter((entry) => entry.kind === "creation");

    const records: Character[] = [];
    const stale: PendingUpdate[] = [];
    for (const { target, candidate } of picks) {
      const key = normalizeName(candidate.name);
      const exists =
        findCharactersByAppellation(ledger.characters, candidate.name).some(
          // 直す本人は「同じ名前の別人」ではない（別名に選んだ名前を持っていることがある）
          (character) => character.id !== target.ledger?.id
        ) || creations.some((entry) => normalizeName(entry.character.name) === key);
      const roleKey = normalizeName(target.role);
      // 片付けるのは**プロットから積んだ案だけ**。抽出や相談から来た案は
      // 本文の根拠を持っていることがあり、作者が見ずに消してよいものではない
      stale.push(
        ...creations.filter(
          (entry) =>
            entry.source === "plot" && normalizeName(entry.character.name) === roleKey
        )
      );
      if (exists) {
        result.skipped.push(candidate.name);
        continue;
      }

      if (target.ledger) {
        const staged = await stageRename(
          work,
          store,
          ledger.characters,
          pending.updates,
          target,
          candidate
        );
        if (staged) result.renamed.push(staged);
        else result.changed.push(target.role);
        continue;
      }

      const [record] = buildNewCharacterRecords([
        { name: candidate.name, summary: target.summary, role: target.role },
      ]);
      records.push({ ...record, reading: candidate.reading || null });
      result.staged.push(candidate.name);
    }

    if (records.length > 0) {
      await store.stage(records, { source: "plot", kind: "creation" });
    }
    for (const filePath of new Set(stale.map((entry) => entry.filePath))) {
      await store.discard(filePath);
    }
    return result;
  } catch (error) {
    logFailure("プロットの名前を承認待ちへ置けませんでした", {
      作品: work.title,
      詳細: messageOf(error),
    });
    return { ...result, staged: [], renamed: [], error: messageOf(error) };
  }
}

/**
 * 資料の役名の人物（「主人公」）を、選んだ名前に直す更新案を置く。
 * **置けなければ undefined**（資料の人物が消えた・名前が変わった）。
 *
 * - 台帳は書き換えない。作者が承認したときに入る（実装ルール2。
 *   `autoGenerated: false` の人物も、`authorLocked` の呼称を持つ人物も、案に出すだけ）
 * - **同じ人物の更新案が既に承認待ちにあれば、その案の上に重ねる。**
 *   更新案のファイルは人物のIDで付くので、重ねずに置くと先の案（抽出など）を
 *   上書きで消してしまう。出どころも先の案のものを引き継ぐ
 */
async function stageRename(
  work: WorkEntry,
  store: PendingUpdateStore,
  characters: readonly Character[],
  pending: readonly PendingUpdate[],
  target: PlotRoleTarget,
  candidate: NameCandidate
): Promise<{ from: string; to: string } | undefined> {
  const current = characters.find((character) => character.id === target.ledger?.id);
  // 候補を待つあいだに作者が名前を付けていたら、上から別の名前を重ねない
  if (!current || current.name !== target.ledger?.name) return undefined;

  const previous = pending.find(
    (entry) => entry.kind !== "creation" && entry.character.id === current.id
  );
  const base = previous ? previous.character : current;
  const proposal = buildRoleRenameProposal(base, {
    name: candidate.name,
    reading: candidate.reading,
  });
  const reason =
    `プロットモードで選んだ名前に直します（${current.name} → ${candidate.name}）。` +
    "元の役名は役割の欄へ移します。";
  await store.stage([proposal], {
    // 出どころ無しを渡すと、`stage` が先の案のファイルから引き継ぐ
    source: previous ? previous.source : "plot",
    reason: previous?.reason ? `${previous.reason}／${reason}` : reason,
  });
  // **置いたことを覚える**（設計書6.4.9）。作者がこの案を見送ったあと
  // plot.md を保存すると、「主人公（相馬 誠）」の行を見たプロットからの
  // 反映が、同じ案を置き直してしまう
  await recordRoleRenameOffers(work, [
    { id: current.id, from: current.name, to: candidate.name },
  ]);
  return { from: current.name, to: candidate.name };
}

/** 対象を選ばせる。**全員を選んだ状態で出し、作者が外す**（迷うものも含める） */
async function pickTargets(
  targets: readonly PlotRoleTarget[]
): Promise<PlotRoleTarget[] | undefined> {
  const items = targets.map((target) => ({
    label: target.role,
    description: [
      target.kind === "unsure" ? "役名か迷いました" : "",
      target.ledger ? "設定資料にいる人物の名前を直す案になります" : "",
    ]
      .filter(Boolean)
      .join("・"),
    detail: target.summary || "（説明なし）",
    picked: true,
    target,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: "名前の候補を出す人物（外す人物はチェックを外してください）",
    placeHolder: "役名だけで書かれている人物です。名前のある人物は並びません",
    canPickMany: true,
    ignoreFocusOut: true,
  });
  if (!picked || picked.length === 0) return undefined;
  return picked.map((item) => item.target);
}

interface Material {
  existingNames: string[];
  entries: ReturnType<typeof buildNameEntries>;
  setting: string;
  plan: NameOriginPlan;
}

/**
 * 既にある名前と系統の決め方を集める。
 *
 * **役名は名前として数えない**（資料や承認待ちにある「主人公」「班長」）。
 * 数えると、響きの判定で役名と比べ、系統の見立てでは「漢字の名前」が
 * 増えて和風へ寄る。
 */
async function collectMaterial(
  work: WorkEntry,
  characters: readonly Character[],
  plotText: string,
  chosen: NameOrigin | undefined,
  remembered: NameOrigin | undefined
): Promise<Material> {
  const [abilities, locations, organizations, pending] = await Promise.all([
    createAbilityStore(work).loadAll(),
    createLocationStore(work).loadAll(),
    createOrganizationStore(work).loadAll(),
    new PendingUpdateStore(work).loadAll().catch(() => ({ updates: [], errors: [] })),
  ]);
  const people = [
    ...characters,
    // 承認待ちの新規の人物も、避ける相手に入れる（承認すれば資料に並ぶ）
    ...pending.updates
      .filter((entry) => entry.kind === "creation")
      .map((entry) => entry.character),
  ].filter((character) => !classifyRoleName(character.name));

  const entries = buildNameEntries({
    characters: people,
    abilities: abilities.records,
    locations: locations.records,
    organizations: organizations.records,
  });
  const existingNames = entries.map((entry) =>
    entry.reading ? `${entry.name}（${entry.reading}）` : entry.name
  );
  const setting = settingFromPlotText(plotText);
  const plan = planNameOrigin({
    chosen,
    remembered,
    existingNames: people.map((character) => character.name),
    setting,
  });
  return { existingNames, entries, setting, plan };
}

/** 終了ログ（設計書6.77）。**開始したら必ず終わりを残す** */
function logEnd(counts: {
  failed: boolean;
  cancelled: boolean;
  people: number;
  kept: number;
  dropped: number;
}): void {
  logStep(
    `プロットの名前の候補を終了: ${counts.cancelled ? 0 : 1}/1（失敗 ${
      counts.failed ? 1 : 0
    }件 / 人物 ${counts.people}人 / 候補 ${counts.kept}件 / 落とした ${counts.dropped}件` +
      (counts.cancelled ? " / 中止された" : "") +
      "）"
  );
}

function describeWriteFailure(result: WriteTextFileResult): string {
  if (result.ok) return "";
  switch (result.reason) {
    case "unsaved_changes":
      return "プロット（plot.md）に保存していない変更があります。保存してから［入れる］を押してください。";
    case "modified_externally":
      return "候補を出したあとにプロット（plot.md）が書き換わったため、入れるのを止めました。もう一度「名前の候補を出す」を押してください。";
    case "conflict_markers":
      return "プロット（plot.md）に競合の印（<<<<<<<）が残っているため、入れるのを止めました。";
    case "encoding_error":
      return "プロット（plot.md）を元の文字コードで書き出せないため、入れるのを止めました。";
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
