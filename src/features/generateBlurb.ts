import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import { AIRegistry, ensureConfigured } from "../ai/registry";
import {
  resolveOutputTokensForPlanning,
  resolveOutputTokensForSend,
} from "../ai/outputLimit";
import { confirmProviderReachable } from "./aiConnectivity";

import { scanWork } from "../core/scanner";
import { loadEpisodeBodies } from "../core/episodeBodies";
import { SynopsisStore } from "../core/synopsisStore";
import { CatchphraseHistory } from "../core/catchphraseHistory";
import {
  buildSynopsisMarkdown,
  parseSynopsisMarkdown,
  type SynopsisDoc,
} from "../core/synopsisDoc";
import { buildSynopsisListMarkdown } from "../core/synopsisMarkdown";
import { loadSynopsisChapterMarks } from "../core/synopsisChapters";
import { buildEmotionCurveMarkdown } from "../core/emotionCurve";
import { readWorkConfig, workPaths } from "../core/workRegistry";
import { atomicWriteFile, createManagedRecoveryPath } from "../core/atomicWrite";
import {
  BLURB_MAX_CHARS,
  BLURB_SCHEMA,
  BLURB_SYSTEM_PROMPT,
  CATCHPHRASE_MAX_CHARS,
  CATCHPHRASE_SCHEMA,
  buildBlurbPrompt,
  buildCatchphrasePrompt,
  type CatchphraseCandidate,
} from "../prompts/blurb";
import { stripCodeFence } from "../core/synopsisValidation";
import { withCancellableProgress } from "../views/progress";
import { reportAIError } from "./reportAIError";
import {
  logFailure,
  responseExcerptForLog,
  showLog,
  useLogFile,
} from "../core/logger";
import { askText, cancelItem, isCancelItem } from "../views/dialogs";

/**
 * 作品紹介文（P-06）とキャッチコピー3案（P-08）。
 *
 * **どちらも自動では書き込まない。** 読者に見せる文章に正解は無く、
 * 決めるのは作者である。案を見せて、選ばれたものだけを
 * `設定/synopsis.md` へ書く。
 */

const SYNOPSIS_FILE = "synopsis.md";
/**
 * 紹介文・キャッチコピーへ渡す冒頭本文の量。
 * 多く送っても紹介文は良くならず、料金だけ増える。
 *
 * **プロット逆算の `PLOT_OPENING_EXCERPT_CHARS`（3,000字）とは別物である。**
 * 以前はどちらも同じ名前を名乗り、値だけが違っていた
 * （設計書6.77の第2段で改名）。紹介文は文体まで読者に見せる文章なので、
 * 骨格だけで足りるプロットより長く採る。
 */
export const BLURB_OPENING_EXCERPT_CHARS = 6000;
/** 紹介文の材料にする、各話あらすじの件数 */
const SYNOPSES_FOR_BLURB = 30;

export async function generateWorkBlurb(
  work: WorkEntry,
  registry: AIRegistry
): Promise<void> {
  useLogFile(work.folderPath);
  const resolved = await ensureConfigured(registry, "generate");
  if (!resolved) return;

  const material = await collectMaterial(work);
  if (!material) return;

  // **繋がるかを、費用の確認より先に確かめる**（設計書6.51）。
  // 繋がらないと分かっているのに料金の話をしても意味がない。
  // 材料が集まらなかった回（上で return する）はAIを呼ばないので、ここに置く。
  // モデル名を渡すのは、LM Studioをこの場から起こしたときの読み込みに要るため
  if (
    !(await confirmProviderReachable(
      resolved.provider,
      "作品紹介文の作成",
      resolved.model
    ))
  ) {
    return;
  }

  const costNotice = resolved.provider.isPaid
    ? `\n${resolved.provider.displayName} は呼び出すたびに課金されます。`
    : "";
  const confirm = await vscode.window.showInformationMessage(
    `作品紹介文を作ります（AIの呼び出しは1回）。\nモデル: ${resolved.model}${costNotice}`,
    "実行",
    "中止"
  );
  if (confirm !== "実行") return;

  // **応答の見込みに実測を使う**（設計書6.65.16の2、6.77の第2段）。
  // 紹介文は400字ほどだが、渡さないとOllamaの `num_ctx` が
  // 既定の8,192で確保される
  const plannedOutputTokens = resolveOutputTokensForPlanning(
    resolved.provider.id,
    resolved.model
  );
  // **場所の確保（上）と、実際に送る上限（下）は別物である**（設計書6.77の
  // 第2段）。上を上限として送ると、測っていないモデルでは上限が設定値の
  // 半分になり、長い応答が途中で切れる
  const sendOutputTokens = resolveOutputTokensForSend(
    resolved.provider.id,
    resolved.model
  );

  const response = await withCancellableProgress(
    "作品紹介文を作っています",
    async (_progress, token) => {
      // **中止ボタンをAIまで届かせる。** 受け取らないと、ボタンは出るのに
      // 押しても何も起きない（有料AIでは課金が続く）。0.28.3
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());
      try {
        return await resolved.provider.generate({
          systemPrompt: BLURB_SYSTEM_PROMPT,
          userPrompt: buildBlurbPrompt({
            workTitle: material.workTitle,
            plot: material.plot,
            openingExcerpt: material.openingExcerpt,
            chapterSynopses: material.chapterSynopses,
          }),
          model: resolved.model,
          // 紹介文は読ませる文章なので、抽出より少し揺らす
          temperature: 0.5,
          maxOutputTokens: sendOutputTokens,
          plannedOutputTokens,
          jsonSchema: BLURB_SCHEMA as unknown as object,
          disableThinking: true,
          signal: controller.signal,
          meta: { feature: "blurb", workFolder: work.folderPath },
        });
      } catch (error) {
        reportAIError("作品紹介文の生成", error);
        return undefined;
      }
    }
  );
  if (!response) return;

  const parsed = parseBlurbResponse(response.text);
  if (!parsed) {
    // **切り詰めは、切り詰めとして伝える**（設計書6.77の第2段。あらすじ生成と
    // 同じ文言）。「読み取れませんでした」だけだと、作者からは上限が足りない
    // のかAIの気まぐれなのか区別が付かない
    const truncated = response.truncated === true;
    logFailure("作品紹介文の生成", {
      理由: truncated
        ? "応答が出力上限で切り詰められました"
        : "応答を読み取れません",
      応答: responseExcerptForLog(response.text),
    });
    vscode.window
      .showWarningMessage(
        truncated
          ? "応答が出力上限で切り詰められました。"
          : "応答を読み取れませんでした。",
        "ログを見る"
      )
      .then((answer) => {
        if (answer === "ログを見る") showLog();
      });
    return;
  }

  // 字数はコード側で数え直す。長すぎるものは切らずに、そのまま見せて判断させる
  const overLength = parsed.blurb.length > BLURB_MAX_CHARS;

  // **案を見せるのに無題のエディターを開かない。** 以前は開いて閉じていたが、
  // 無題の文書は常に「未保存」なので、閉じる際にVS Codeが保存先を尋ね、
  // 採用するかどうかを選んだだけの作者に保存ダイアログが出ていた
  // （実機で発覚、2026-08-14）。400字ほどなので確認ダイアログに収まる
  const answer = await vscode.window.showInformationMessage(
    `作品紹介文ができました（${parsed.blurb.length}字）`,
    {
      modal: true,
      detail: [
        parsed.blurb,
        parsed.spoilerCheck ? `\n伏せた要素: ${parsed.spoilerCheck}` : "",
        overLength ? `\n目安の${BLURB_MAX_CHARS}字を超えています。` : "",
        "\n採用すると 設定/synopsis.md に書き込みます。",
      ]
        .filter(Boolean)
        .join("\n"),
    },
    "採用"
  );
  if (answer !== "採用") return;

  await writeSynopsisDoc(work, material.workTitle, (current) => ({
    ...current,
    blurb: parsed.blurb,
  }));
}

export async function generateCatchphrases(
  work: WorkEntry,
  registry: AIRegistry
): Promise<void> {
  useLogFile(work.folderPath);
  const resolved = await ensureConfigured(registry, "generate");
  if (!resolved) return;

  const material = await collectMaterial(work);
  if (!material) return;

  // **繋がるかを、費用の確認より先に確かめる**（設計書6.51）。
  // 紹介文と同じ扱い。「別の案を出す」で何度も回る作りなので、
  // 入口で1回だけ確かめる（ループの中には置かない）
  if (
    !(await confirmProviderReachable(
      resolved.provider,
      "キャッチコピーの作成",
      resolved.model
    ))
  ) {
    return;
  }

  // **紹介文と同じ2欄を渡す**（設計書6.77の第2段）。案が3つ返るだけなので
  // 応答は短いが、渡さないと関所とOllamaの `num_ctx` が設定値（既定16,384）で
  // 動き、ループを回すたびにその席を確保することになる
  const plannedOutputTokens = resolveOutputTokensForPlanning(
    resolved.provider.id,
    resolved.model
  );
  const sendOutputTokens = resolveOutputTokensForSend(
    resolved.provider.id,
    resolved.model
  );

  const history = new CatchphraseHistory(work);
  const costNotice = resolved.provider.isPaid
    ? `\n${resolved.provider.displayName} は呼び出すたびに課金されます。`
    : "";
  const confirm = await vscode.window.showInformationMessage(
    `キャッチコピーを3案作ります（AIの呼び出しは1回）。\nモデル: ${resolved.model}${costNotice}`,
    "実行",
    "中止"
  );
  if (confirm !== "実行") return;

  // 「別の案を出す」を選ぶたび、却下した案を渡して繰り返す
  for (;;) {
    const rejected = await history.load();
    const response = await withCancellableProgress(
      "キャッチコピーを考えています",
      async (_progress, token) => {
        // 中止ボタンをAIまで届かせる（0.28.3）
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        try {
          return await resolved.provider.generate({
            systemPrompt: BLURB_SYSTEM_PROMPT,
            userPrompt: buildCatchphrasePrompt({
              workTitle: material.workTitle,
              plot: material.plot,
              blurb: material.currentDoc.blurb,
              openingExcerpt: material.openingExcerpt,
              rejected,
            }),
            model: resolved.model,
            // 案を出させるので、いちばん揺らす
            temperature: 0.9,
            maxOutputTokens: sendOutputTokens,
            plannedOutputTokens,
            meta: { feature: "catchphrase", workFolder: work.folderPath },
            jsonSchema: CATCHPHRASE_SCHEMA as unknown as object,
            disableThinking: true,
            signal: controller.signal,
          });
        } catch (error) {
          reportAIError("キャッチコピーの生成", error);
          return undefined;
        }
      }
    );
    if (!response) return;

    const candidates = parseCatchphraseResponse(response.text);
    const valid = candidates.filter(
      (candidate) =>
        candidate.text.length > 0 &&
        candidate.text.length <= CATCHPHRASE_MAX_CHARS
    );
    if (valid.length === 0) {
      logFailure("キャッチコピーの生成", {
        理由: "使える案がありません",
        応答: responseExcerptForLog(response.text),
      });
      const retry = await vscode.window.showWarningMessage(
        `${CATCHPHRASE_MAX_CHARS}字以内の案が返りませんでした。`,
        "もう一度",
        "やめる"
      );
      if (retry !== "もう一度") return;
      continue;
    }

    const picked = await vscode.window.showQuickPick(
      [
        ...valid.map((candidate) => ({
          label: candidate.text,
          description: `${candidate.text.length}字 / ${candidate.kind}`,
          detail: candidate.intent ?? undefined,
          action: "adopt" as const,
          candidate,
        })),
        {
          label: "$(edit) 手直しして採用",
          description: "案をもとに自分で書く",
          action: "edit" as const,
          candidate: valid[0],
        },
        {
          label: "$(refresh) 別の案を出す",
          description: "今の3案は却下として覚え、もう一度作る",
          action: "again" as const,
          candidate: undefined,
        },
        // 作法を1つに揃える（他の選択画面と同じ見た目にする）
        cancelItem(),
      ],
      {
        title: `${material.workTitle} のキャッチコピー`,
        placeHolder: "採用する案を選んでください",
        ignoreFocusOut: true,
      }
    );

    if (!picked || isCancelItem(picked) || !("action" in picked)) return;

    if (picked.action === "again") {
      await history.add(valid.map((candidate) => candidate.text));
      continue;
    }

    let text = picked.candidate.text;
    if (picked.action === "edit") {
      const edited = await askText({
        title: "キャッチコピーを手直し",
        value: text,
        prompt: `${CATCHPHRASE_MAX_CHARS}字以内`,
        ignoreFocusOut: true,
        validateInput: (value) =>
          value.trim().length === 0
            ? "空にはできません。"
            : value.trim().length > CATCHPHRASE_MAX_CHARS
              ? `${CATCHPHRASE_MAX_CHARS}字以内にしてください（今 ${value.trim().length}字）。`
              : undefined,
      });
      if (!edited) return;
      text = edited.trim();
    }

    // 採用しなかった案は、次に同じものが出ないよう覚えておく
    await history.add(
      valid.map((candidate) => candidate.text).filter((item) => item !== text)
    );
    await writeSynopsisDoc(work, material.workTitle, (current) => ({
      ...current,
      catchphrase: text,
    }));
    return;
  }
}

interface BlurbMaterial {
  workTitle: string;
  plot: string;
  openingExcerpt: string;
  chapterSynopses: string[];
  currentDoc: SynopsisDoc;
}

/** 紹介文・キャッチコピーの材料を集める */
async function collectMaterial(
  work: WorkEntry
): Promise<BlurbMaterial | undefined> {
  const scan = await scanWork(work);
  if (scan.episodes.length === 0) {
    vscode.window.showWarningMessage("本文ファイルが見つかりません。");
    return undefined;
  }

  const bodies = (await loadEpisodeBodies(scan.episodes)).bodies;
  if (bodies.length === 0) {
    vscode.window.showWarningMessage("読める本文がありません。");
    return undefined;
  }

  // 冒頭から順に、上限まで詰める。紹介文は冒頭の雰囲気が要る
  let openingExcerpt = "";
  for (const episode of bodies) {
    if (openingExcerpt.length >= BLURB_OPENING_EXCERPT_CHARS) break;
    openingExcerpt += `${episode.body}\n\n`;
  }
  openingExcerpt = openingExcerpt.slice(0, BLURB_OPENING_EXCERPT_CHARS);

  let chapterSynopses: string[] = [];
  try {
    const set = await new SynopsisStore(work).load();
    chapterSynopses = set.episodes
      .slice(0, SYNOPSES_FOR_BLURB)
      .map((item) =>
        item.chapter !== null
          ? `第${item.chapter}話: ${item.synopsis}`
          : item.synopsis
      );
  } catch {
    // あらすじが読めなくても紹介文は作れる。材料が減るだけ
  }

  return {
    workTitle: work.title,
    plot: await readPlot(work),
    openingExcerpt,
    chapterSynopses,
    currentDoc: await readSynopsisDoc(work),
  };
}

async function readPlot(work: WorkEntry): Promise<string> {
  const config = await readWorkConfig(work);
  const target = path.join(workPaths(work, config).settings, "plot.md");
  try {
    const bytes = await vscode.workspace.fs.readFile(path.toUri(target));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

async function synopsisPath(work: WorkEntry): Promise<string> {
  const config = await readWorkConfig(work);
  return path.join(workPaths(work, config).settings, SYNOPSIS_FILE);
}

/**
 * 各話あらすじの本文を組み立てる。無ければ空文字。
 *
 * あらすじの真実は `chapter_synopses.json` にあるので、
 * 文書へ載せるときは毎回ここから作り直す。
 */
async function buildEpisodeSection(
  work: WorkEntry,
  workTitle: string
): Promise<{ episodes: string; emotion: string }> {
  let set;
  try {
    set = await new SynopsisStore(work).load();
  } catch {
    // あらすじが読めなくても紹介文は書ける。載せないだけにする
    return { episodes: "", emotion: "" };
  }
  if (set.episodes.length === 0) return { episodes: "", emotion: "" };

  return {
    episodes: buildSynopsisListMarkdown(set, {
      workTitle,
      headingLevel: 2,
      includeTitle: false,
      // 章立ての台帳がある作品は、章ごとに見出しを挟む（設計書6.66.4の3）。
      // 台帳が無ければ印は空で、いままでどおりの一覧になる
      chapters: await loadSynopsisChapterMarks(work, set),
    }),
    emotion: buildEmotionCurveMarkdown(set.episodes),
  };
}

/**
 * 紹介文は変えず、各話あらすじの部分だけを今の内容へ更新する。
 *
 * 「設定資料集を出力」から呼ぶ。あらすじを作り直したあと、
 * 読み物の側も追随させるため。
 */
export async function refreshSynopsisDoc(
  work: WorkEntry,
  workTitle: string
): Promise<void> {
  await writeSynopsisDoc(work, workTitle, (current) => current);
}

/**
 * `設定/synopsis.md` を読む。無ければ空の内容を返す。
 *
 * **更新告知（P-30）も同じものを読む**ので公開してある。写しを作ると、
 * 見出しの形を変えたときに片方だけが読めなくなる。
 */
export async function readSynopsisDoc(work: WorkEntry): Promise<SynopsisDoc> {
  try {
    const bytes = await vscode.workspace.fs.readFile(
      path.toUri(await synopsisPath(work))
    );
    return parseSynopsisMarkdown(new TextDecoder().decode(bytes));
  } catch {
    return { catchphrase: null, blurb: "" };
  }
}

/**
 * `synopsis.md` を書き換える。
 *
 * **今ある内容を読んでから、変える部分だけを差し替える。**
 * 紹介文を作り直しても採用済みのキャッチコピーは残す（その逆も同じ）。
 * 元の内容は回復先へ退避してから書く（既存ファイルは上書きできない）。
 */
async function writeSynopsisDoc(
  work: WorkEntry,
  workTitle: string,
  update: (current: SynopsisDoc) => SynopsisDoc
): Promise<void> {
  const target = await synopsisPath(work);
  const current = await readSynopsisDoc(work);
  const next = update(current);
  // 各話あらすじと感情曲線も同じ文書に載せる（作者の要望、2026-08-14／15）。
  // 真実は chapter_synopses.json 側にあるので、書くたびに組み立て直す
  const sections = await buildEpisodeSection(work, workTitle);
  const body = buildSynopsisMarkdown(
    workTitle,
    next,
    sections.episodes,
    sections.emotion
  );

  await vscode.workspace.fs.createDirectory(
    path.toUri(path.dirname(target))
  );

  let recoveryPath: string | undefined;
  if (await exists(target)) {
    try {
      recoveryPath = await createManagedRecoveryPath(target);
      await vscode.workspace.fs.rename(
        path.toUri(target),
        path.toUri(recoveryPath),
        { overwrite: false }
      );
    } catch (error) {
      vscode.window.showErrorMessage(
        `${SYNOPSIS_FILE} を退避できませんでした: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return;
    }
  }

  try {
    await atomicWriteFile(target, new TextEncoder().encode(body), {
      mode: "create",
    });
    // **書いたら開いて見せる。** 「どこに入ったのか分からない」と
    // 言われていた（作者の指摘、2026-08-16）。
    // どのエディターで開くかは決め打ちしない。`vscode.open` なら
    // 作者が既定にしたもの（Markdown Editor など）で開く
    await vscode.commands.executeCommand("vscode.open", path.toUri(target));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(
      recoveryPath
        ? `${SYNOPSIS_FILE} を保存できませんでした: ${detail} 元の内容は「${recoveryPath}」にあります。`
        : `${SYNOPSIS_FILE} を保存できませんでした: ${detail}`
    );
  }
}

export function parseBlurbResponse(
  text: string
): { blurb: string; spoilerCheck: string | null } | null {
  const value = parseJson(text);
  if (!value || typeof value.blurb !== "string") return null;
  const blurb = value.blurb.trim();
  if (!blurb) return null;
  return {
    blurb,
    spoilerCheck:
      typeof value.spoilerCheck === "string" ? value.spoilerCheck : null,
  };
}

export function parseCatchphraseResponse(text: string): CatchphraseCandidate[] {
  const value = parseJson(text);
  if (!value || !Array.isArray(value.catchphrases)) return [];
  return value.catchphrases
    .filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null && !Array.isArray(entry)
    )
    .filter((entry) => typeof entry.text === "string")
    .map((entry) => ({
      text: (entry.text as string).trim().replace(/\s+/g, " "),
      kind: typeof entry.kind === "string" ? entry.kind : "",
      intent: typeof entry.intent === "string" ? entry.intent : null,
    }));
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(stripCodeFence(text));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}


async function exists(filePath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(path.toUri(filePath));
    return true;
  } catch {
    return false;
  }
}
