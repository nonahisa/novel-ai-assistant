// ログの書き先：入口で作品のログへ向ける（useLogFile）
import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { describeRetrievedItem, type RetrievalItem } from "../core/retrievalCorpus";
import type { RetrievalCandidate } from "../core/retrieval";
import { lineOfPassage } from "../core/semanticRank";
import { readTextFile } from "../core/textFile";
import { logFailure, logStep, useLogFile } from "../core/logger";
import { askText, cancelItem, isCancelItem } from "../views/dialogs";
import { withProgress } from "../views/progress";
import { revealTextLocation, type RevealInManuscript } from "./revealLocation";
import {
  prepareRetrieval,
  search,
  vectorSetupCommand,
  vectorSetupHint,
} from "./vectorSearch";

/**
 * 場面検索——言葉で場面を探して、その箇所を開く（設計書6.19.10。作者の依頼
 * 2026-09-23 の1）。
 *
 * 「主人公が初めて剣を握った場面」のように書くと、当たりそうな話と箇所を
 * 並べる。押すとその箇所を開く。
 *
 * **相談で使っている検索をそのまま使う**（`prepareRetrieval`・`search`）。
 * ベクトル検索の準備が済んでいれば意味の近さと語句一致を交互に並べ、
 * 済んでいなければ語句一致だけで並べて「準備をすると言い回しが違っても
 * 探せます」を添える。**どちらでも動く。**
 *
 * **AIは呼ばない。** 手元の Ollama で問いを1回埋め込むだけ（料金はかからない）。
 * 本文は読むだけで書き換えない。
 */

export interface SceneSearchDeps {
  /** 原稿エディタで書いていれば、その画面で示す口（`revealLocation.ts`） */
  revealInManuscript?: RevealInManuscript;
}

/** 並べる件数の上限。多すぎると選ぶ手間が検索の意味を消す */
export const SCENE_SEARCH_LIMIT = 20;
/** 1つの検索から取る件数（意味検索・語句一致それぞれ） */
const PER_METHOD = 15;
/** 一覧の2行目に出す、場面の頭の長さ */
const SNIPPET_CHARS = 90;

type HitItem = vscode.QuickPickItem & { hit: RetrievalItem };
type SetupItem = vscode.QuickPickItem & { setupCommand: string };

export async function searchScenes(
  work: WorkEntry,
  deps: SceneSearchDeps = {}
): Promise<void> {
  useLogFile(work.folderPath);
  const query = await askText({
    title: `場面検索：${work.title}`,
    prompt: "探したい場面を、言葉で書いてください。本文の言い回しと違っていても構いません。",
    placeHolder: "例：主人公が初めて剣を握った場面",
  });
  if (!query?.trim()) return;

  let candidates: RetrievalCandidate[] = [];
  let hint = "";
  let setupCommand = "";
  try {
    const found = await withProgress("場面を探しています", async () => {
      const context = await prepareRetrieval(work);
      const hits = await search(context, query, {
        // 字数では切らない（AIへ渡すのではなく、作者に並べるだけ）
        maxChars: Number.MAX_SAFE_INTEGER,
        perMethod: PER_METHOD,
        sources: ["本文"],
      });
      return { hits, context };
    });
    candidates = dropNeighbors(found.hits).slice(0, SCENE_SEARCH_LIMIT);
    if (found.context.vectorUnavailable) {
      hint = vectorSetupHint(
        found.context.vectorUnavailable,
        "言い回しが違っても意味で探せます"
      );
      setupCommand = vectorSetupCommand(found.context.vectorUnavailable);
    }
    logStep(
      `場面検索：「${query}」→ ${candidates.length}件` +
        `（${found.context.vector ? "意味検索と語句一致" : "語句一致だけ"}）`
    );
  } catch (error) {
    logFailure("場面検索", {
      詳細: error instanceof Error ? error.message : String(error),
    });
    void vscode.window.showWarningMessage(
      "場面を探せませんでした（理由は記録に残しました）。"
    );
    return;
  }

  if (candidates.length === 0) {
    void vscode.window.showInformationMessage(
      `「${query}」に近い場面は見つかりませんでした。` + (hint ? ` ${hint}` : "")
    );
    return;
  }

  const items: Array<HitItem | SetupItem> = candidates.map(
    (candidate): HitItem => ({
      label: sceneLabel(candidate.item),
      description: candidate.foundBy,
      detail: snippet(candidate.item.text),
      hit: candidate.item,
    })
  );
  if (hint && setupCommand) {
    items.push({
      label: "$(search-fuzzy) ベクトル検索を使えるようにする",
      detail: hint,
      setupCommand,
    } satisfies SetupItem);
  }
  const picked = await vscode.window.showQuickPick([...items, cancelItem("閉じる")], {
    title: `場面検索：「${query}」`,
    placeHolder: hint
      ? "語句一致で探しました。開く場面を選んでください"
      : "意味の近さと語句一致で探しました。開く場面を選んでください",
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true,
  });
  if (!picked || isCancelItem(picked)) return;
  if ("setupCommand" in picked) {
    await vscode.commands.executeCommand(picked.setupCommand);
    return;
  }
  if (!("hit" in picked)) return;
  await openScene(work, picked.hit, deps.revealInManuscript, "場面検索");
}

/**
 * 場面を開く（似た場面の検出からも使う）。
 *
 * 行は場面の最初の行をファイルの中で探して決める。見つからなければ
 * 話の頭を開く（でたらめな行へ飛ばさない）。
 */
export async function openScene(
  work: WorkEntry,
  item: RetrievalItem,
  revealInManuscript: RevealInManuscript | undefined,
  source: string
): Promise<void> {
  if (!item.filePath) {
    void vscode.window.showWarningMessage("この場面のファイルが分かりませんでした。");
    return;
  }
  const line = await lineOf(item);
  await revealTextLocation(item.filePath, line, revealInManuscript, source, work);
}

/** 場面が何行目から始まるか（1始まり）。読めなければ1行目 */
export async function lineOf(item: RetrievalItem): Promise<number> {
  if (!item.filePath) return 1;
  try {
    const file = await readTextFile(item.filePath);
    return lineOfPassage(file.text, item.text) ?? 1;
  } catch {
    return 1;
  }
}

/** 一覧の1行目。「第3話 再会（場面 2/11）」 */
export function sceneLabel(item: RetrievalItem): string {
  const base = describeRetrievedItem(item).replace(/^本文・/, "");
  return item.part ? `${base}（場面 ${item.part.index}/${item.part.total}）` : base;
}

/** 一覧の2行目。改行を詰めて頭だけ */
export function snippet(text: string, limit = SNIPPET_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * 隣り合う場面を1つにまとめる。
 *
 * 場面は100字ずつ重ねて切ってある（`passages.ts`）ので、1か所の記述が
 * 隣どうしの2件として並ぶことが多い。**先に並んだほうだけを残す。**
 */
export function dropNeighbors(
  candidates: readonly RetrievalCandidate[]
): RetrievalCandidate[] {
  const kept: RetrievalCandidate[] = [];
  for (const candidate of candidates) {
    const { item } = candidate;
    const neighbor = kept.some(
      (other) =>
        other.item.label === item.label &&
        Math.abs((other.item.part?.index ?? 1) - (item.part?.index ?? 1)) <= 1
    );
    if (!neighbor) kept.push(candidate);
  }
  return kept;
}
