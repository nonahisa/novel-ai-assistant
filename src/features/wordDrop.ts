import * as vscode from "vscode";
import * as path from "../core/paths";
import { isEditorMode } from "../core/actorContext";
import { BACKUP_DROP_MAX_BYTES, tooLargeMessage } from "../core/backupFileKinds";
import type { MissingEpisodeFile } from "../core/backupMissingEpisodes";
import { episodePathFor } from "../core/bookStore";
import { nextChapterNumber, parseEpisodeFileName } from "../core/episodeParser";
import { logFailure, logStep, useLogFile } from "../core/logger";
import { scanWork } from "../core/scanner";
import { NOTATION_CLASH_ADVICE, describeNotationClashLines } from "../core/docxToMarkdown";
import { readTextFile } from "../core/textFile";
import {
  bodyFingerprint,
  inspectionFromWord,
  matchWordToWorks,
  readWordManuscript,
  wordBodyHead,
  type WordManuscript,
  type WordMatch,
  type WordMatchWork,
} from "../core/wordManuscript";
import type { WorkEntry } from "../models/types";
import { withProgress } from "../views/progress";
import { nameNewEpisodes, writeNewEpisodes, type WorkScan } from "./addEpisodeFiles";
import type { BackupDropDeps, BackupDropResult } from "./backupDrop";
import { pickDropTarget } from "./dropTargetPick";

/**
 * 相談パネルへ落とされた Word 原稿（.docx）を受け取る（作者の裁定、2026-09-23
 * 「相談パネルドロップにも対応してください。相談パネルが既存作の続きでも、
 * わかれば対応できるようにしてください」。設計書6.99.7）。
 *
 * ## 流れ
 *
 * 1. 既存の Word 変換の部品（`docxToMarkdown`）で読む。**この時点では書かない**
 * 2. どの作品の続きかを照らす（`core/wordManuscript.ts`。確かな手掛かりだけ）
 * 3. **当たっても決めつけない。** 確認画面で作品・題・足すファイルの名前を見せる
 * 4. 当たれば、その作品の**新しい話のファイル**として足す（バックアップの
 *    「手元に無い話」と同じ道。`addEpisodeFiles.ts`）。既存の話には触らない
 * 5. 当たらなければ、確かめてから**新しい作品として**取り込む（6.99 の
 *    取り込みの道へ `.md` 1つの形で渡す。置き場・題・登録は写さない）
 *
 * ## 既にある話と書き出しが同じなら足さない
 *
 * 直した版を落とした、ということがある。新しい話として足すと同じ話が2つに
 * なるので、どの話と同じかを言って止める（それでも足す道は残す）。
 */
export async function receiveWordManuscript(
  source: {
    readonly fileName: string;
    readonly bytes: Uint8Array;
    /** 落とされたファイルの場所（エクスプローラーから落としたときだけ分かる） */
    readonly sourcePath?: string;
  },
  deps: BackupDropDeps
): Promise<BackupDropResult | undefined> {
  // 作品が決まるまでは保管庫の記録へ（`backupDrop.ts` と同じ理由）
  useLogFile(undefined);

  // **編集部は原稿を足さない**（設計書5.6）
  if (isEditorMode()) {
    return {
      message:
        "編集者モードでは、Word 原稿の取り込みはできません（作者の環境で行ってください）。",
    };
  }
  if (source.bytes.byteLength > BACKUP_DROP_MAX_BYTES) {
    return { message: tooLargeMessage(source.fileName) };
  }

  let doc: WordManuscript;
  try {
    doc = readWordManuscript(source.bytes, source.fileName);
  } catch (error) {
    logFailure("相談パネル：Word 原稿の読み取り", {
      ファイル: source.fileName,
      詳細: messageOf(error),
    });
    return {
      message:
        `「${source.fileName}」を Word 原稿として読めませんでした：${messageOf(error)}` +
        "（古い形式の .doc なら、Word で .docx として保存し直してください）",
    };
  }

  const scans = await withProgress("既にある作品と照らしています…", () =>
    readWorks(deps.works)
  );
  const match = matchWordToWorks({
    titles: [doc.heading, doc.baseName],
    head: wordBodyHead(doc),
    sourcePath: source.sourcePath ?? null,
    works: scans.map((entry) => entry.match),
  });
  logStep(`相談パネル：Word 原稿「${source.fileName}」の照合：${describeMatchForLog(match)}`);

  const byId = new Map(deps.works.map((work) => [work.id, work]));
  const target = await chooseTarget(match, doc, deps.works, byId);
  if (target === undefined) {
    logStep("相談パネル：Word 原稿の取り込みを取りやめました（取り込み先を決める前）");
    return undefined;
  }
  if (typeof target === "object" && "stopped" in target) return target.stopped;
  if (target === "new") return importAsNewWork(source.fileName, doc, deps);

  const scan = scans.find((entry) => entry.work.id === target.work.id)?.scan;
  if (!scan) {
    return { message: `「${target.work.title}」の原稿を読めなかったため、足せませんでした。` };
  }
  return addToWork(target.work, target.note, doc, source.fileName, scan, deps);
}

/* ── 照らす ─────────────────────────────────────────────── */

interface ScannedWork {
  readonly work: WorkEntry;
  readonly scan: WorkScan | null;
  readonly match: WordMatchWork;
}

/**
 * 作品ごとに話を読み、書き出しを照らす材料にする。**読めない作品・話が
 * あっても止めない**（その作品は題と場所だけで照らす）。
 */
async function readWorks(works: readonly WorkEntry[]): Promise<ScannedWork[]> {
  const result: ScannedWork[] = [];
  for (const work of works) {
    let scan: WorkScan | null = null;
    const episodes: { relPath: string; fingerprint: string }[] = [];
    try {
      scan = await scanWork(work);
      for (const episode of scan.episodes) {
        try {
          const file = await readTextFile(episode.filePath);
          episodes.push({
            relPath: episodePathFor(work.folderPath, episode.filePath),
            fingerprint: bodyFingerprint(file.text),
          });
        } catch {
          // 読めない話は照らさない（その話と同じかどうかは言えない）
        }
      }
    } catch (error) {
      logStep(
        `相談パネル：「${work.title}」の原稿を読めなかったため、題と場所だけで照らします（${messageOf(error)}）`
      );
    }
    result.push({
      work,
      scan,
      match: {
        id: work.id,
        title: work.title,
        folderName: path.basename(work.folderPath),
        folderPath: work.folderPath,
        episodes,
      },
    });
  }
  return result;
}

type Target =
  | { work: WorkEntry; note: string }
  | "new"
  | { stopped: BackupDropResult };

/**
 * 足す先を決める。**どの道でも作者に確かめる**（足す前の確認は `addToWork`）。
 *
 * @returns 作者が取りやめたら undefined
 */
async function chooseTarget(
  match: WordMatch,
  doc: WordManuscript,
  works: readonly WorkEntry[],
  byId: ReadonlyMap<string, WorkEntry>
): Promise<Target | undefined> {
  const title = doc.heading ?? doc.baseName;

  if (match.kind === "already") {
    const work = byId.get(match.workId);
    if (work) {
      const FORCE = "それでも新しい話として足す";
      const answer = await vscode.window.showInformationMessage(
        `「${title}」は、「${work.title}」の ${match.relPath} と書き出しが同じです。`,
        {
          modal: true,
          detail: [
            "既にある話なので、新しい話としては足しません。",
            "直した版なら、その話を開いて直してください（違いを並べる道はまだありません）。",
            "",
            "別の話として足したいときは「それでも新しい話として足す」を押してください。",
          ].join("\n"),
        },
        FORCE
      );
      if (answer === FORCE) return { work, note: "" };
      return {
        stopped: {
          message: `「${title}」は「${work.title}」の既にある話と書き出しが同じなので、足しませんでした（${match.relPath}）。`,
        },
      };
    }
  }

  if (match.kind === "matched") {
    const work = byId.get(match.workId);
    if (work) {
      return {
        work,
        note: match.by === "folder" ? "作品フォルダーの中から渡されました" : "題が一致",
      };
    }
  }

  if (match.kind === "ambiguous") {
    const picked = await pickDropTarget(
      match.workIds
        .map((id) => byId.get(id))
        .filter((work): work is WorkEntry => work !== undefined),
      works,
      `「${title}」はどの作品の続きですか？（${match.by === "title" ? "題が一致" : "題の一部が一致"}する作品を先に並べました）`
    );
    if (picked === undefined || picked === "new") return picked;
    return { work: picked, note: "" };
  }

  // 当たらない。**新しい作品にする前に、必ず確かめる**
  const NEW = "新しい作品として取り込む";
  const EXISTING = "既にある作品に足す";
  const answer = await vscode.window.showInformationMessage(
    `「${doc.baseName}」は、登録済みの作品の続きには見えませんでした。新しい作品として取り込みますか？`,
    {
      modal: true,
      detail: [
        `題：${title}`,
        `字数：${doc.charCount}字`,
        "",
        "既にある作品の新しい話なら「既にある作品に足す」から選べます。",
      ].join("\n"),
    },
    NEW,
    EXISTING
  );
  if (answer === NEW) return "new";
  if (answer === EXISTING) {
    const picked = await pickDropTarget([], works, `「${title}」をどの作品に足しますか？`);
    if (picked === undefined || picked === "new") return picked;
    return { work: picked, note: "" };
  }
  return undefined;
}

/* ── 足す ───────────────────────────────────────────────── */

/**
 * 既存作品の新しい話として足す。**押す前に名前まで決めて見せる。**
 *
 * - 名前は手元の話の流儀で次の番号（「新しい話を作る」と同じ）。拡張子は
 *   `.md`——中身は Word 変換の Markdown（見出しの `#`・ルビの記法）なので、
 *   `.txt` の作品でも `.md` にする（既存の Word 変換も必ず `.md` を作る）
 * - 書き込みは `mode: "create"` だけ（既存のファイルは上書きしない）
 */
async function addToWork(
  work: WorkEntry,
  note: string,
  doc: WordManuscript,
  fileName: string,
  scan: WorkScan,
  deps: BackupDropDeps
): Promise<BackupDropResult | undefined> {
  useLogFile(work.folderPath);
  logStep(
    `相談パネル：Word 原稿「${fileName}」→ 足す先「${work.title}」${note ? `（${note}）` : "（作者が選んだ）"}`
  );

  const number = nextChapterNumber(
    scan.episodes.map((episode) => parseEpisodeFileName(episode.fileName))
  );
  const file: MissingEpisodeFile = {
    order: number,
    label: doc.heading ?? doc.baseName,
    part: null,
    number,
    // 手元の流儀が読めないとき（話が1つも無い等）の名前
    defaultFileName: `${String(number).padStart(3, "0")}.md`,
    renamable: true,
    content: { kind: "text", text: doc.markdown },
  };
  const naming = nameNewEpisodes(
    [file],
    scan,
    scan.episodes.map((episode) =>
      path.relative(scan.manuscriptDir, episode.filePath).replace(/\\/g, "/")
    ),
    { extension: ".md" }
  );

  const kept = [
    doc.rubyCount > 0 ? `ルビ${doc.rubyCount}件` : "",
    doc.emphasisCount > 0 ? `傍点${doc.emphasisCount}件` : "",
  ].filter((part) => part !== "");
  const detail = [
    `取り込む元：${path.basename(fileName)}`,
    `題：${doc.heading ?? "（見出しがありません）"}`,
    `字数：${doc.charCount}字${kept.length > 0 ? `（${kept.join("・")}を保存）` : ""}`,
    ...(doc.skipped.length > 0 ? [`入らないもの：${doc.skipped.join("、")}`] : []),
    // 入らないものとは別に言う（字は入る。気をつけるのは投稿サイト向けの変換。残課題 F3）
    ...(doc.notationClashLines.length > 0
      ? [`${NOTATION_CLASH_ADVICE}：${describeNotationClashLines(doc.notationClashLines)}`]
      : []),
    "",
    ...(naming.named.length > 0
      ? [
          `足すファイル：${naming.named[0].name}（${path.basename(scan.manuscriptDir)} の中）`,
          "既存の話には触りません。元の .docx もそのままです。",
        ]
      : naming.skipped.map((entry) => `足せません：${entry.reason}`)),
  ].join("\n");

  const ADD = "新しい話として足す";
  const OTHER = "別の作品を選ぶ";
  const answer = await vscode.window.showInformationMessage(
    `「${work.title}」の新しい話として足しますか？${note ? `（${note}）` : ""}`,
    { modal: true, detail },
    ...(naming.named.length > 0 ? [ADD, OTHER] : [OTHER])
  );
  if (answer === OTHER) {
    const picked = await pickDropTarget([], deps.works, `「${file.label}」をどの作品に足しますか？`);
    if (picked === undefined) return undefined;
    if (picked === "new") return importAsNewWork(fileName, doc, deps);
    // 選び直した作品の原稿を読み直す（名前の流儀と、ぶつかる名前はその作品のもの）
    let other: WorkScan;
    try {
      other = await scanWork(picked);
    } catch (error) {
      return { message: `「${picked.title}」の原稿を読めませんでした：${messageOf(error)}` };
    }
    return addToWork(picked, "", doc, fileName, other, deps);
  }
  if (answer !== ADD) {
    logStep(`相談パネル：「${work.title}」への Word 原稿の追加を取りやめました（確かめの画面で押さなかった）`);
    return undefined;
  }

  const written = await writeNewEpisodes(work, scan, naming.named);
  if (written.added.length === 0) {
    const reason = written.skipped.map((entry) => entry.reason).join("、");
    logStep(`相談パネル：Word 原稿を「${work.title}」へ足せませんでした：${reason}`);
    return { message: `「${work.title}」へ足せませんでした：${reason}` };
  }
  if (deps.afterEpisodesAdded) {
    try {
      await deps.afterEpisodesAdded(work);
    } catch (error) {
      logFailure("相談パネル：Word 原稿を足したあとの一覧の読み直し", {
        作品: work.title,
        詳細: messageOf(error),
      });
    }
  }
  const addedName = path.basename(written.added[0].path);
  logStep(`相談パネル：Word 原稿「${fileName}」を「${work.title}」へ ${addedName} として足しました`);
  return {
    message:
      `「${work.title}」に新しい話として足しました：${addedName}` +
      (kept.length > 0 ? `（${kept.join("・")}を保存）` : "") +
      "。元の .docx はそのままです。",
  };
}

/**
 * 新しい作品として取り込む（6.99 の取り込みの道。置き場・題・登録は写さない）。
 */
async function importAsNewWork(
  fileName: string,
  doc: WordManuscript,
  deps: BackupDropDeps
): Promise<BackupDropResult> {
  logStep(`相談パネル：Word 原稿「${fileName}」を新しい作品として取り込む道へ回しました`);
  if (!deps.importAsNew) {
    /*
      取り込みの道が繋がっていないとき。メニューの「バックアップから取り込む」は
      .docx を選べないので、既存の「Word 原稿の変換」を案内する（フォルダーの
      中の .docx を .md にする道。作品の登録は「フォルダから追加」で行う）。
    */
    return {
      message:
        "新しい作品として取り込む道が繋がっていません。「既存原稿登録」の「Word 原稿変換」で " +
        ".md にしてから、作品として登録してください。",
    };
  }
  const inspection = inspectionFromWord(doc);
  await deps.importAsNew({ fileName, inspection });
  return { message: `「${inspection.title}」の取り込みを進めました。` };
}

/* ── 小物 ─────────────────────────────────────────────── */

function describeMatchForLog(match: WordMatch): string {
  switch (match.kind) {
    case "already":
      return `既にある話と書き出しが同じ（${match.relPath}）`;
    case "matched":
      return `当たり（${match.by}）`;
    case "ambiguous":
      return `候補${match.workIds.length}件（${match.by}）`;
    case "none":
      return "当たりなし";
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
