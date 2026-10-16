import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import { readWorkConfig, workPaths } from "../core/workRegistry";
import {
  parsePlotMarkdown,
  updatePlotMarkdown,
  type PlotSections,
} from "../core/plotDoc";
import {
  buildSynopsisMarkdown,
  parseSynopsisMarkdown,
  SYNOPSIS_FILE,
  SYNOPSIS_LABEL,
  type SynopsisDoc,
} from "../core/synopsisDoc";
import { hasUnsavedOpenDocument } from "../core/openDocumentEdit";
import { logFailure, useLogFile } from "../core/logger";
import { buildSynopsisListMarkdown } from "../core/synopsisMarkdown";
import { loadSynopsisChapterMarks } from "../core/synopsisChapters";
import { buildEmotionCurveMarkdown } from "../core/emotionCurve";
import { SynopsisStore } from "../core/synopsisStore";
import { rewriteMarkdownFile, rewritePlotFile } from "../core/plotFile";
import type { ChatEdit, ChatEditTarget } from "../core/chatEdit";

/**
 * 相談パネルからの加筆修正を、実際に書き込む。
 *
 * **書き込み先は「真実の在り処」であって、読み物のMarkdownではない。**
 * `characters.md` などはJSONから毎回作り直される生成物なので、そこへ
 * 書いても次の生成で消える。各話あらすじも同じで、真実は
 * `chapter_synopses.json` にある（`synopsis.md` の該当部分は表示物）。
 *
 * **既存ファイルは上書きできない**（`atomicWrite.ts`）。plot.md・synopsis.md は
 * `rewritePlotFile`／`rewriteMarkdownFile` を通す（開いていれば文書へ当てて保存し、
 * 開いていなければ「回復先へ退避 → 新規作成」。どちらも読み込み時のハッシュを照合する）。
 * 作者の文書なので、失敗しても元が残るようにしておく。
 *
 * 戻り値は「どこへ書いたか」。作者に知らせるために使う。
 */
export async function applyChatEdit(
  work: WorkEntry,
  edit: ChatEdit,
  options: {
    /**
     * 空の中身も書く（**取り消し専用**。設計書6.4.7）。
     *
     * **AIには渡させない。** `ChatEdit` の中ではなく呼び出しの引数に
     * 置いてあるのは、AIが返した値からこの印が立つ余地を残さないためである。
     * 普通の書き込みでは `parseChatEdit` が空の `content` を弾くので、
     * ここが立つのは「書く前の値（空かもしれない）へ戻す」ときだけになる。
     */
    allowEmpty?: boolean;
  } = {}
): Promise<string> {
  switch (edit.target.kind) {
    case "plot":
      return applyToPlot(
        work,
        edit.target.section,
        edit.content,
        options.allowEmpty ?? false
      );
    case "blurb":
      return applyToSynopsisDoc(work, (current) => ({
        ...current,
        blurb: edit.content,
      }));
    case "catchphrase":
      return applyToSynopsisDoc(work, (current) => ({
        ...current,
        catchphrase: edit.content,
      }));
    case "episodeSynopsis":
      return applyToEpisodeSynopsis(work, edit.target.chapter, edit.content);
  }
}

/**
 * いま入っている値を読む（取り消しのために控える）。
 *
 * **書く前に控えておく。** 頼まれた書き込みは確認を出さずに行うように
 * なった（設計書6.4.7・2026-09-21の作者の裁定）ので、**戻せる道を
 * その場に出す**必要がある。控えが無ければ、書いたあとに「元は何だったか」を
 * 誰も知らない。
 *
 * 読めない・まだ書かれていないときは空文字を返す。「書かれていなかった」
 * ことも、戻すべき状態である。
 */
export async function readChatEditTarget(
  work: WorkEntry,
  target: ChatEditTarget
): Promise<string> {
  switch (target.kind) {
    case "plot": {
      const text = await readText(await settingsFile(work, "plot.md"));
      return text ? (parsePlotMarkdown(text).sections[target.section] ?? "") : "";
    }
    case "blurb":
    case "catchphrase": {
      const text = await readText(await settingsFile(work, "synopsis.md"));
      if (!text) return "";
      const doc = parseSynopsisMarkdown(text);
      return target.kind === "blurb" ? doc.blurb : (doc.catchphrase ?? "");
    }
    case "episodeSynopsis": {
      try {
        const set = await new SynopsisStore(work).load();
        const found = set.episodes.find(
          (item) => item.chapter === target.chapter
        );
        return found?.synopsis ?? "";
      } catch {
        // 台帳がまだ無い。書けば作られるので、控えは空でよい
        return "";
      }
    }
  }
}

async function applyToPlot(
  work: WorkEntry,
  section: keyof PlotSections,
  content: string,
  allowEmpty: boolean
): Promise<string> {
  const target = await settingsFile(work, "plot.md");
  // **作者の文書の形を変えない。** 節に分解して組み直すと、作者が立てた
  // 見出しが末尾へ寄り、順番も決まった並びへ戻る（作者の指示、2026-08-16）。
  // **書くのは `rewritePlotFile`**——開いていれば文書へ当てて保存し、未保存の変更があれば止める
  // （ディスクを消して作り直すと、開いたままのエディターで Ctrl+S が断られた。0.107.8）
  await rewritePlotFile(target, (current) =>
    updatePlotMarkdown(
      current,
      { [section]: content },
      { workTitle: work.title, allowEmpty }
    )
  );
  return "設定/plot.md";
}

async function applyToSynopsisDoc(
  work: WorkEntry,
  update: (current: SynopsisDoc) => SynopsisDoc
): Promise<string> {
  const target = await settingsFile(work, "synopsis.md");

  // 各話あらすじと感情曲線も同じ文書に載る（6.6.2）。
  // 真実はJSON側なので毎回作り直す
  const sections = await buildEpisodeSection(work);

  // **書くのは plot.md と同じ口**（`rewriteMarkdownFile`）——読み込み時のハッシュを照合し、
  // 開いていれば文書へ当てて保存し、未保存の変更があれば止める。中身は毎回組み立て直すが、
  // 当てるのは変わった所だけになる（設計書6.4.8）
  await rewriteMarkdownFile(
    target,
    (current) =>
      buildSynopsisMarkdown(
        work.title,
        update(
          current
            ? parseSynopsisMarkdown(current)
            : { catchphrase: null, blurb: "" }
        ),
        sections.episodes,
        sections.emotion
      ),
    SYNOPSIS_LABEL
  );
  return "設定/synopsis.md";
}

/**
 * 各話あらすじを書き換える。
 *
 * **`upsertSynopsis` は使わない。** あちらは「AIの抽出結果を差し込む」
 * ための関数で、作者が書き直したあらすじ（`autoGenerated: false`）を
 * 守るために差し替えを拒む。ここは作者自身が書き換えを指示した場面なので、
 * 拒まれては困る。代わりに、書いた結果を `autoGenerated: false` にして
 * **以後の自動生成から守る**（作者の指示で入った内容だから）。
 */
async function applyToEpisodeSynopsis(
  work: WorkEntry,
  chapter: number,
  content: string
): Promise<string> {
  /*
    **空にはできない**（2026-09-21）。台帳は非空を前提に検証しているので、
    空を書くと**保存は通るのに次の読み込みで台帳ごと読めなくなる**
    （`test/unit/core/synopsisStore.test.ts`）。取り消しで空が来たときのために
    ここで断る——`plot.md` のように「空へ戻す」はできない対象である。
  */
  if (content === "") {
    throw new Error(
      `第${chapter}話のあらすじは空にできません（あらすじの記録が読めなくなるため）。` +
        "手で書き換えてください。"
    );
  }

  const store = new SynopsisStore(work);
  const set = await store.load();

  const index = set.episodes.findIndex((item) => item.chapter === chapter);
  if (index < 0) {
    throw new Error(
      `第${chapter}話のあらすじが見つかりません。先に「各話あらすじ」を実行してください。`
    );
  }

  const episodes = set.episodes.map((item) => ({ ...item }));
  episodes[index] = {
    ...episodes[index],
    synopsis: content,
    autoGenerated: false,
    updatedAt: new Date().toISOString(),
  };

  await store.save({ ...set, episodes });

  // 読み物の側（synopsis.md）も追随させる。作らないと、
  // 開いた文書には古いあらすじが出たままになる
  await refreshSynopsisDocAfterEpisodeEdit(work);
  return "設定/chapter_synopses.json";
}

/**
 * 各話あらすじを書き換えたあと、読み物（synopsis.md）を作り直す。**作れなければ知らせる。**
 *
 * あらすじ本体（`chapter_synopses.json`）はもう保存してあるので、ここで投げない（投げると相談パネルが
 * 「書き込めませんでした」と出し、取り消しの道も消える）。ただし 0.107.12 までのように黙って捨てると、
 * synopsis.md が未保存のとき読み物だけが古いまま残り、作者は気づけない（書く口が未保存なら止まるように
 * なったので、起きやすくなった）。作り直す操作を1つ示す（実装ルール5）——［設定資料集出力］は
 * `refreshSynopsisDoc` で読み物のあらすじ部分だけを差し替え、紹介文は残す。
 */
async function refreshSynopsisDocAfterEpisodeEdit(work: WorkEntry): Promise<void> {
  const target = await settingsFile(work, SYNOPSIS_FILE);
  // 未保存は書く口でも断られるが、先に見て作者向けの言い方で知らせる
  if (hasUnsavedOpenDocument(target)) {
    void vscode.window.showWarningMessage(
      `${SYNOPSIS_LABEL}に保存していない変更があるので、各話あらすじの部分を作り直していません。` +
        `保存してから［${REGENERATE_SYNOPSIS_DOC_COMMAND}］で作り直せます。`
    );
    return;
  }
  try {
    await applyToSynopsisDoc(work, (current) => current);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // 記録はこの作品のログへ（呼び手が向けていても、ここで向け直して取り違えない）
    useLogFile(work.folderPath);
    logFailure("各話あらすじの読み物の作り直し", { 詳細: detail });
    void vscode.window.showWarningMessage(
      `${SYNOPSIS_LABEL}の各話あらすじの部分を作り直せませんでした。${detail}` +
        `（あらすじ本体は保存済みです。［${REGENERATE_SYNOPSIS_DOC_COMMAND}］で作り直せます）`
    );
  }
}

/** synopsis.md の各話あらすじを作り直す操作の名前（package.json の `novelai.generateSettingsDocs` の題） */
const REGENERATE_SYNOPSIS_DOC_COMMAND = "設定資料集出力";

async function buildEpisodeSection(
  work: WorkEntry
): Promise<{ episodes: string; emotion: string }> {
  try {
    const set = await new SynopsisStore(work).load();
    if (set.episodes.length === 0) return { episodes: "", emotion: "" };
    return {
      episodes: buildSynopsisListMarkdown(set, {
        workTitle: work.title,
        headingLevel: 2,
        includeTitle: false,
        // 章の見出しも `generateBlurb` と同じ形で挟む（設計書6.66.4の3）。
        // 片方だけ挟むと、書き換えた経路によって文書の形が変わる
        chapters: await loadSynopsisChapterMarks(work, set),
      }),
      emotion: buildEmotionCurveMarkdown(set.episodes),
    };
  } catch {
    return { episodes: "", emotion: "" };
  }
}

async function settingsFile(
  work: WorkEntry,
  fileName: string
): Promise<string> {
  const config = await readWorkConfig(work);
  return path.join(workPaths(work, config).settings, fileName);
}

async function readText(target: string): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(path.toUri(target));
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}
