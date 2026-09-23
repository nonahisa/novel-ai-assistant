// ログの書き先：入口で作品のログへ向ける（useLogFile）
import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { buildRetrievalCorpus, type RetrievalItem } from "../core/retrievalCorpus";
import { findSimilarPairs, type SimilarPair } from "../core/semanticRank";
import * as path from "../core/paths";
import { logFailure, logStep, useLogFile } from "../core/logger";
import { cancelItem, isCancelItem } from "../views/dialogs";
import { withCancellableProgress } from "../views/progress";
import type { RevealInManuscript } from "./revealLocation";
import { lineOf, openScene, sceneLabel, snippet } from "./sceneSearch";
import {
  loadStoredVectors,
  vectorReadiness,
  vectorSetupCommand,
  vectorSetupHint,
  type VectorUnavailable,
} from "./vectorSearch";

/**
 * 似た場面の検出——別の話で、同じような場面・説明を繰り返していないかを
 * 並べる（設計書6.19.10。作者の依頼 2026-09-23 の4）。
 *
 * **候補を並べるだけで、良し悪しは言わない。** 意図した呼応（同じ台詞を
 * 最終話で繰り返す）なのか、うっかりの重複（同じ設定説明を3話で3回）なのかは
 * 作者にしか決められない。
 *
 * **ベクトル検索の索引だけで測る。** 場面どうしの近さは索引に既にある
 * ベクトルの内積で、Ollama も AI も呼ばない。索引が無ければ、準備を案内する
 * （語句一致では「似た場面」を測れないので、代わりの道は無い）。
 */

export interface SimilarScenesDeps {
  revealInManuscript?: RevealInManuscript;
}

/**
 * 近さの下限。**これより遠い組は並べない。**
 *
 * 同じ作品の場面どうしは、文体と登場人物を共有するので全体に近い。
 * 下限を低くすると「同じ作品である」ことしか言わない組が並ぶ。
 * 値の決め方は設計書6.19.10（手元の作品で近さの分布を見た）。
 */
export const SIMILAR_SCENE_MIN = 0.75;
/** 並べる組の上限 */
export const SIMILAR_SCENE_LIMIT = 40;
/**
 * これより短い場面は比べない。話の末尾の数行・章題だけの場面は、
 * 中身が無いぶん互いに近く出て、上位を埋める。
 */
const SIMILAR_SCENE_MIN_CHARS = 80;

type PairItem = vscode.QuickPickItem & { pair: { a: RetrievalItem; b: RetrievalItem } };
type SetupItem = vscode.QuickPickItem & { setupCommand: string };

export async function findSimilarScenes(
  work: WorkEntry,
  deps: SimilarScenesDeps = {}
): Promise<void> {
  useLogFile(work.folderPath);

  const readiness = await vectorReadiness(work);
  if (!readiness.ready) {
    await offerSetup(readiness.reason);
    return;
  }

  let items: RetrievalItem[];
  try {
    items = (await buildRetrievalCorpus(work)).items.filter(
      (item) => item.source === "本文"
    );
  } catch (error) {
    logFailure("似た場面の検出：本文の読み込み", {
      詳細: error instanceof Error ? error.message : String(error),
    });
    void vscode.window.showWarningMessage("本文を読めませんでした（理由は記録に残しました）。");
    return;
  }
  const opened = await loadStoredVectors(work, items.map((item) => item.hash));
  if ("unavailable" in opened) {
    await offerSetup(opened.unavailable);
    return;
  }

  const comparable = items.filter(
    (item) => item.text.replace(/\s+/g, "").length >= SIMILAR_SCENE_MIN_CHARS
  );
  const started = Date.now();
  let cancelled = false;
  const pairs = await withCancellableProgress(
    `似た場面を探しています（${comparable.length}場面）`,
    async (progress, token) =>
      findSimilarPairs(
        comparable.map((item) => ({
          id: item.id,
          hash: item.hash,
          group: item.label,
          position: item.part?.index ?? 1,
        })),
        opened.lookup,
        {
          minScore: SIMILAR_SCENE_MIN,
          limit: SIMILAR_SCENE_LIMIT,
          isCancelled: () => {
            cancelled = token.isCancellationRequested;
            return cancelled;
          },
          onProgress: (done, total) =>
            progress.report({ message: `${Math.round((done / Math.max(total, 1)) * 100)}%` }),
        }
      )
  );
  logStep(
    `似た場面の検出：${comparable.length}場面から${pairs.length}組` +
      `（近さ${SIMILAR_SCENE_MIN}以上・${((Date.now() - started) / 1000).toFixed(1)}秒` +
      (cancelled ? "・途中で中止" : "") +
      "）"
  );

  if (pairs.length === 0) {
    void vscode.window.showInformationMessage(
      cancelled
        ? "中止しました。"
        : `別の話どうしで、よく似た場面は見つかりませんでした（近さ${SIMILAR_SCENE_MIN}以上で探しました）。`
    );
    return;
  }

  const byId = new Map(items.map((item) => [item.id, item]));
  const picked = await vscode.window.showQuickPick(
    [...pairs.flatMap((pair) => toPickItem(pair, byId)), cancelItem("閉じる")],
    {
      title: `似た場面：${work.title}（${pairs.length}組${cancelled ? "・途中まで" : ""}）`,
      placeHolder:
        "近い順です。良し悪しではなく、似ているという候補です。選ぶと2つを並べて開きます",
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked) || !("pair" in picked)) return;

  await openScene(work, picked.pair.a, deps.revealInManuscript, "似た場面");
  await openBeside(picked.pair.b);
}

function toPickItem(
  pair: SimilarPair,
  byId: ReadonlyMap<string, RetrievalItem>
): PairItem[] {
  const a = byId.get(pair.a);
  const b = byId.get(pair.b);
  if (!a || !b) return [];
  return [
    {
      label: `${sceneLabel(a)} ↔ ${sceneLabel(b)}`,
      description: `近さ ${pair.score.toFixed(2)}`,
      detail: `「${snippet(a.text, 40)}」／「${snippet(b.text, 40)}」`,
      pair: { a, b },
    },
  ];
}

/**
 * 2つ目の場面を、隣の列に開く。
 *
 * 1つ目は原稿エディタの口（`revealTextLocation`）で開くが、そちらは開く列を
 * 自分で決める。並べて読み比べるために、2つ目は素のエディタで隣の列へ出す。
 */
async function openBeside(item: RetrievalItem): Promise<void> {
  if (!item.filePath) return;
  try {
    const line = await lineOf(item);
    const doc = await vscode.workspace.openTextDocument(path.toUri(item.filePath));
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: true,
      preview: true,
    });
    const at = Math.min(Math.max(line - 1, 0), Math.max(doc.lineCount - 1, 0));
    const range = doc.lineAt(at).range;
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  } catch (error) {
    logFailure("似た場面：2つ目の場面を開けませんでした", {
      ファイル: item.filePath,
      詳細: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 使えないときの案内。押せば準備・索引づくりへ進める */
async function offerSetup(reason: VectorUnavailable): Promise<void> {
  const hint = vectorSetupHint(reason, "別の話どうしの似た場面を探せます");
  const go: SetupItem = {
    label: reason === "disabled" ? "$(search-fuzzy) ベクトル検索準備" : "$(database) 検索索引作成／更新",
    detail: hint,
    setupCommand: vectorSetupCommand(reason),
  };
  const picked = await vscode.window.showQuickPick([go, cancelItem("閉じる")], {
    title: "似た場面の検出にはベクトル検索が要ります",
    placeHolder: hint,
    ignoreFocusOut: true,
  });
  if (picked && !isCancelItem(picked) && "setupCommand" in picked) {
    await vscode.commands.executeCommand(picked.setupCommand);
  }
}
