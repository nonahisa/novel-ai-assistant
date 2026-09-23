import * as vscode from "vscode";
import * as path from "../core/paths";
import { atomicWriteFile } from "../core/atomicWrite";
import { pathExists } from "../core/fileSystem";
import { logFailure, useLogFile } from "../core/logger";
import { parsePlotMarkdown } from "../core/plotDoc";
import { readPlotText, writePlotSections } from "../core/plotFile";
import {
  buildSynopsisMarkdown,
  SYNOPSIS_FILE,
  type SynopsisDoc,
} from "../core/synopsisDoc";
import {
  plotDraftFromWorkInfo,
  synopsisDraftFromWorkInfo,
} from "../core/workInfoDraft";
import { formatCount } from "../core/charCount";
import {
  buildImportRecord,
  IMPORT_RECORD_KIND,
} from "../core/importRecordMarkdown";
import { readWorkConfig, scaffoldWorkFolder, workPaths } from "../core/workRegistry";
import { PostingStore } from "../core/postingStore";
import { supportsReaderStatsHelper } from "../core/readerStatsEnvelope";
import {
  hasReaderStatsMetrics,
  postingSiteInfo,
  siteProfile,
  withReaderStats,
  withSiteProfile,
  type PostingLedger,
  type PostingSiteId,
  type PostingSiteProfile,
} from "../models/posting";
import {
  BACKUP_FILE_EXTENSIONS,
  inspectWorkBackup,
  WorkZipError,
  type WorkZipInspection,
} from "../core/workZip";
import { describeBackupEncoding } from "../core/backupEncoding";
import { showBackupOpenDialog } from "./backupPickFolder";
import { describeEpisodeNumbers } from "../core/episodeNumberCheck";
import type { WorkInfo } from "../core/workInfoParse";
import { DEFAULT_MANUSCRIPT_DIR, type WorkEntry } from "../models/types";
import type { WorkLocation } from "../core/libraryHome";
import type { CollectionOptions } from "./addCollection";
import { askText } from "../views/dialogs";
import { confirmRun } from "../views/notify";
import {
  openInDefaultEditor,
  revealFolder,
  saveGeneratedMarkdown,
} from "../views/openDocument";
import { withProgress } from "../views/progress";
import { resolveNewWorkHome } from "./newWorkHome";

/**
 * バックアップから取り込む（設計書6.99）。
 *
 * 作者の指示（2026-09-19）：「初心者が初めて使うところを魅せたい」。
 * カクヨム・なろう・アルファポリスからダウンロードしたバックアップを
 * 渡せば、展開・作品フォルダーの用意・登録までが一度に済む。
 *
 * ## 入れ物はサイトによって違う（0.69.10）
 *
 * カクヨム・なろうは **ZIP**、アルファポリスは **`.txt` 直**である。
 * 読み分けるのは `core/workZip.ts` の `inspectWorkBackup` で、ここから先の
 * 手順（置き場・題・展開・登録）は**どちらでも同じ1本**を通る。
 *
 * ## 同じ話・飛んだ話は、必ず言う（作者の指示、2026-09-19）
 *
 * 話番号の重複と欠番を、**確認の画面と完了のお知らせの両方**で伝える。
 * **止めない**——番号が飛ぶのは普通にあることなので、知らせてから進む。
 * 中身まで同じ話は1つだけ取り込み、**落としたことも言う**（黙って捨てない）。
 *
 * ## 作品名を打たせない
 *
 * 題は `about.txt` の【タイトル】から採る（無ければZIPのファイル名から）。
 * **入力欄は出すが、既定値が入っている**ので、そのままEnterで進める。
 * 打たせないことと、直せないことは違う。
 *
 * ## すでに書いてあるものを、AIに作り直させない
 *
 * `about.txt` にはキャッチコピー・紹介文・ジャンル・タグが入っている。
 * これを捨てて「AIで紹介文を作りましょう」と言うのは、作者が書いた
 * ものを見ていないのと同じである。**空の欄にだけ**下書きとして置く
 * （実装ルール2。新しい作品なので普通は空だが、確かめてから入れる）。
 *
 * ## 決め事は、ここでは決めない
 *
 * 置き場は `newWorkHome.ts`、登録は `extension.ts` の
 * `registerFolderAsWork`、ZIPの読み取りは `core/workZip.ts` が持つ。
 * ここがするのは**順に繋ぐことと、作者に確かめること**だけである。
 */

/** 作品として登録する道。`extension.ts` の `registerFolderAsWork` を渡す */
export type RegisterWork = (
  folderPath: string,
  title: string,
  options: CollectionOptions
) => Promise<WorkEntry | undefined>;

/**
 * 選び終わって読み終わったバックアップ（相談パネルへ持ち込まれたもの）。
 *
 * **もう一度選ばせない。** 相談パネルに落としたファイルを、取り込みの道で
 * もう一度ダイアログから選ばせると、作者には同じことを2度頼まれたように
 * 見える（`features/backupDrop.ts`）。
 */
export interface PickedBackup {
  /** 拡張子まで含むファイル名。確認の画面と取り込みの記録に出す */
  readonly fileName: string;
  /** 点検済みの中身（`inspectWorkBackup` の結果） */
  readonly inspection: WorkZipInspection;
}

export async function importWorkFromZip(
  works: readonly WorkLocation[],
  register: RegisterWork,
  /** 相談パネルから渡されたとき。無ければ、これまでどおりファイルを選ばせる */
  picked?: PickedBackup
): Promise<void> {
  // **作品フォルダーが決まるまでは、保管庫の記録へ書く。** 切り替えないと、
  // 読み取りの失敗が直前に触った関係の無い作品の記録へ紛れる
  // （相談パネルの取り込みで実際に起きた。2026-09-23）
  useLogFile(undefined);
  const source = picked ?? (await pickAndInspect());
  if (!source) return;
  const { inspection } = source;
  const zipPath = source.fileName;

  if (!(await confirmImport(zipPath, inspection))) return;

  // **置き場を決めてから題を訊く。** 逆にすると、名前を考えたあとで
  // 「どこに作りますか」と訊かれる（書庫の決め方は 6.97.2 のまま）
  const home = await resolveNewWorkHome(works);
  if (!home) return;

  const title = await askWorkTitle(inspection, home.note);
  if (!title) return;

  const folderPath = path.join(home.folderPath, title);
  if (await pathExists(folderPath)) {
    // **上書きしない**（実装ルール1・2）。同じ名前の作品が既にあるなら、
    // 中身を混ぜるより、名前を変えてもらうほうが取り返しがつく
    await vscode.window.showWarningMessage(
      `「${title}」はすでにあります。`,
      {
        modal: true,
        detail: [
          `${folderPath} がすでに存在するため、取り込みを中止しました。`,
          "",
          "中のファイルを上書きしないための決まりです。",
          "別の作品名でもう一度お試しください。",
        ].join("\n"),
      }
    );
    return;
  }

  // **ここから先の失敗は、その作品の記録へ残す**（`logFileRouting.test.ts`）。
  // 出力チャンネルにしか残らないと、VS Code を閉じた時点で手がかりが消える。
  // 場所が決まるのはここが最初である（ZIPを読むところまでは作品が無い）
  useLogFile(folderPath);

  const extracted = await extractInto(folderPath, title, inspection);
  if (!extracted) return;

  /*
    登録は「フォルダから追加」と同じ道を通る（写しを作らない）。

    **ただし「書庫かもしれない」の見分けだけは通さない**（`knownSingleWork`）。
    いま作ったのはこの作品フォルダー1つで、`本文/` と `設定/` を置いたのも
    ここである。それを見分けの道へ入れると、`設定/` があるせいで
    「作品にも書庫にも見えます」と訊かれ、**しかも既定は書庫のほう**を
    指す（2026-09-19、作者の実機確認）。知っていることを訊かない。
  */
  const entry = await register(folderPath, title, { knownSingleWork: true });
  if (!entry) return;

  const placed = inspection.info
    ? await applyWorkInfo(entry, inspection.info)
    : [];

  // **訊かずに下ごしらえする。** 出どころが分かったときだけ、投稿状態の
  // 台帳へ「このサイトに載っている」ことを書き留める（6.99の「打鍵ゼロ」）
  const recorded = inspection.site
    ? await notePostingSite(entry, inspection.site, inspection)
    : NOTHING_RECORDED;

  await reportResult(entry, zipPath, inspection, placed, recorded);
}

/** ファイルを選ばせて、読んで確かめる（メニューから始めたときの道） */
async function pickAndInspect(): Promise<PickedBackup | undefined> {
  const zipPath = await pickZipFile();
  if (!zipPath) return undefined;
  const inspection = await inspectPickedZip(zipPath);
  if (!inspection) return undefined;
  // 以降は名前しか使わない（確認の画面と記録は `basename` を出す）
  return { fileName: zipPath, inspection };
}

/**
 * バックアップのファイルを選ぶ。
 *
 * **フォルダー選択（`pickFolder.ts`）とは分ける。** あちらはブラウザ版で
 * 「開いているフォルダーから選ぶ」へ切り替える必要があるが、バックアップは
 * ワークスペースの中にあるとはかぎらない。ダイアログが出せない環境では
 * 何も選ばれずに戻るだけで、原稿には触れない。
 *
 * **`.txt` も選べる**（0.69.10）。アルファポリスのバックアップは ZIP では
 * なく `.txt` 直で降りてくるので、絞り込みを `zip` だけにしておくと、
 * 作者のファイルが選ぶ画面にそもそも出てこない。
 */
async function pickZipFile(): Promise<string | undefined> {
  // **前に選んだフォルダーから開く**（`backupPickFolder.ts`）。展開した
  // バックアップを何作ぶんも続けて渡すとき、毎回辿り直さずに済む
  const picked = await showBackupOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel: "これを取り込む",
    title: "取り込むバックアップを選ぶ（ZIP／テキスト）",
    filters: { "バックアップ（ZIP／テキスト）": [...BACKUP_FILE_EXTENSIONS] },
  });
  if (!picked) return undefined;
  return path.fromUri(picked);
}

/** 読んで確かめる。**この時点では1文字も書かない** */
async function inspectPickedZip(
  zipPath: string
): Promise<WorkZipInspection | undefined> {
  try {
    const bytes = await withProgress("ZIPの中を見ています…", async () =>
      vscode.workspace.fs.readFile(path.toUri(zipPath))
    );
    return inspectWorkBackup(bytes, path.basename(zipPath));
  } catch (error) {
    if (error instanceof WorkZipError) {
      await vscode.window.showWarningMessage(error.message, {
        modal: true,
        detail: error.detail,
      });
      return undefined;
    }
    logFailure("ZIPの読み取り", {
      ファイル: zipPath,
      詳細: error instanceof Error ? error.message : String(error),
    });
    await vscode.window.showErrorMessage(
      `ZIPを読めませんでした：${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return undefined;
  }
}

/**
 * 何が入っているかを見せてから確認を取る（設計書6.81の規則1）。
 *
 * **展開する前に見せる。** 取り込んだあとで「思っていたものと違った」と
 * 分かっても、作者はフォルダーごと消すしかない。
 */
async function confirmImport(
  zipPath: string,
  inspection: WorkZipInspection
): Promise<boolean> {
  const lines = [
    `取り込む元：${path.basename(zipPath)}`,
    `作品名：${inspection.title}` +
      (inspection.titleSource === "about"
        ? "（作品情報から採りました。次の画面で直せます）"
        : inspection.titleSource === "fileName"
          ? "（ファイルの名前から採りました。次の画面で直せます）"
          : "（ZIPの名前から採りました。次の画面で直せます）"),
    "",
    // **話の数であって、ファイルの数ではない**（`workZip.ts` の `episodeCount`）。
    // 合本は1ファイルに全話が入っているので、そのことも書き添える
    `取り込む話：${inspection.episodeCount}話` +
      (inspection.collected
        ? "（1つのファイルに全話が入っています）"
        : ""),
    `合計の文字数：${formatCount(inspection.totalChars)}字`,
  ];

  const info = inspection.info;
  if (info) {
    const found = [
      info.catchphrase ? "キャッチコピー" : "",
      info.blurb ? "紹介文" : "",
      info.genre ? "ジャンル" : "",
      info.tags.length > 0 ? `タグ${info.tags.length}件` : "",
    ].filter((item) => item !== "");
    lines.push(
      "",
      found.length > 0
        ? `作品情報（about.txt）から下書きにできるもの：${found.join("・")}`
        : "作品情報（about.txt）が入っていますが、使える欄はありませんでした。"
    );
  }

  if (inspection.skipped.length > 0) {
    lines.push(
      "",
      `原稿ではないファイル${inspection.skipped.length}件は入れません` +
        "（.txt と .md だけを取り込みます）。"
    );
  }

  /*
    **重複と欠番は、展開する前に言う**（作者の指示、2026-09-19）。

    取り込んだあとで「同じ話が2つ入っていました」と言われても、作者は
    フォルダーを開いて自分で探すしかない。**止めはしない**——番号が飛ぶのは
    普通にあることなので、知らせてから進む。
  */
  const notices = describeEpisodeNumbers(
    inspection.episodeNumbers,
    inspection.dropped
  );
  if (notices.length > 0) lines.push("", ...notices);

  /*
    **文字コードの助言も、展開する前に言う**（作者の指示、2026-09-19）。

    ここに出るのがいちばん大事である——**取り込む前なら、作者は投稿サイトから
    UTF-8 で書き出し直して来られる。** 取り込んだあとで知っても、置き換わった
    文字はもう戻らない（`backupEncoding.ts` に実測の数字がある）。
    **止めはしない**——半角の `?` は作者が自分で書いていることもある。
  */
  const encoding = describeBackupEncoding(inspection.encodingNotice, "before");
  if (encoding.length > 0) lines.push("", ...encoding);

  return confirmRun("この内容で作品を作りますか？", "取り込む", {
    detail: lines.join("\n"),
  });
}

/** 題を直せるようにして訊く。既定値が入っているのでEnterだけで進める */
async function askWorkTitle(
  inspection: WorkZipInspection,
  homeNote: string
): Promise<string | undefined> {
  const title = await askText({
    title: homeNote,
    value: inspection.title,
    prompt: "作品名を確かめてください（フォルダ名になります）",
    validateInput: (value) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) return "作品名を入力してください";
      if (/[/\\:*?"<>|]/.test(trimmed)) {
        return "フォルダ名に使えない文字が含まれています";
      }
      return null;
    },
  });
  return title?.trim() || undefined;
}

/**
 * 作品フォルダーを作って、中身を書き出す。
 *
 * **書き込みは `mode: "create"` だけ**（新規作成しか行わないと決めて
 * おけば、上書きの経路が紛れ込む余地がない。`docxImport.ts` と同じ流儀）。
 * `scaffoldWorkFolder` も、すでにあるフォルダーには作らない。
 *
 * プロットの雛形は置かない（`withPlot: false`）。すでに書き上がっている
 * 原稿を入れるのだから、見出しだけのプロットは邪魔になる。**`about.txt`
 * から書くものがあるときだけ**、あとで `plot.md` ができる。
 */
async function extractInto(
  folderPath: string,
  title: string,
  inspection: WorkZipInspection
): Promise<boolean> {
  try {
    await scaffoldWorkFolder(folderPath, title, { withPlot: false });

    // `scaffoldWorkFolder` が置いたばかりの設定は既定のままなので、
    // 本文の置き場も既定である（登録前で `WorkEntry` がまだ無い）
    const manuscript = path.join(folderPath, DEFAULT_MANUSCRIPT_DIR);

    await withProgress("ZIPから原稿を取り出しています…", async (progress) => {
      for (const [index, file] of inspection.files.entries()) {
        progress.report({
          message: `${inspection.files.length}件中 ${index + 1}件目（${file.name}）`,
        });
        const target = path.join(manuscript, file.name);
        await vscode.workspace.fs.createDirectory(
          path.toUri(path.dirname(target))
        );
        await atomicWriteFile(target, file.bytes, { mode: "create" });
      }
    });
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logFailure("ZIPからの取り込み", { 作品: title, 詳細: detail });
    await vscode.window.showErrorMessage(
      `取り込みに失敗しました：${detail} ` +
        `途中まで作られたものが「${folderPath}」に残っていることがあります。` +
        "中をご確認のうえ、要らなければ削除してください。"
    );
    return false;
  }
}

/**
 * `about.txt` の中身を、製品の置き場へ下書きとして置く。
 *
 * **どこへ置いてよいかは `core/workInfoDraft.ts` が決める**（空の欄にだけ、
 * という一番間違えやすい決まりを試験にかけられるようにするため）。
 * ここがするのは、いまの中身を読んで渡すことと、書くことだけである。
 *
 * @returns 実際に置いたものの名前（作者への報告に使う）
 */
async function applyWorkInfo(
  work: WorkEntry,
  info: WorkInfo
): Promise<string[]> {
  const placed: string[] = [];

  try {
    placed.push(...(await writeSynopsisIfAbsent(work, info)));
  } catch (error) {
    // **設定資料を置けなくても、取り込みそのものは成り立っている。**
    // ここで止めると、登録済みの作品が中途半端に見える
    logFailure("作品情報からの紹介文の下書き", {
      作品: work.title,
      詳細: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const filled = await writePlotFromInfo(work, info);
    placed.push(...filled);
  } catch (error) {
    logFailure("作品情報からのプロットの下書き", {
      作品: work.title,
      詳細: error instanceof Error ? error.message : String(error),
    });
  }

  return placed;
}

/**
 * `設定/synopsis.md` がまだ無いときだけ作る。
 *
 * **あれば触らない。** 作者が書いた紹介文が、取り込みの下書きで
 * 押し流されることが無いようにする（判断は `workInfoDraft.ts`）。
 */
async function writeSynopsisIfAbsent(
  work: WorkEntry,
  info: WorkInfo
): Promise<readonly string[]> {
  const config = await readWorkConfig(work);
  const target = path.join(workPaths(work, config).settings, SYNOPSIS_FILE);
  const existing = (await pathExists(target)) ? emptySynopsisDoc() : null;

  const draft = synopsisDraftFromWorkInfo(info, existing);
  if (!draft) return [];

  const body = buildSynopsisMarkdown(work.title, draft.doc);
  await vscode.workspace.fs.createDirectory(
    path.toUri(path.dirname(target))
  );
  await atomicWriteFile(target, new TextEncoder().encode(body), {
    mode: "create",
  });
  return draft.labels;
}

/**
 * 「すでに文書がある」ことだけを伝えるための値。
 *
 * 中身は読まない——**あると分かった時点で触らない**ので、読み取って
 * 比べる必要が無い（読んで書き戻す道を作れば、そこが上書きの経路になる）。
 */
function emptySynopsisDoc(): SynopsisDoc {
  return { catchphrase: null, blurb: "" };
}

/** プロットの空いている節にだけ書き足す。戻りは置いたものの名前 */
async function writePlotFromInfo(
  work: WorkEntry,
  info: WorkInfo
): Promise<readonly string[]> {
  const current = parsePlotMarkdown(await readPlotText(work));
  const draft = plotDraftFromWorkInfo(info, current.sections);
  if (draft.labels.length === 0) return [];

  await writePlotSections(work, draft.updates);
  return draft.labels;
}

/**
 * 「この作品は、そのサイトに載っている」ことを台帳へ書き留める（設計書6.99）。
 *
 * ## 訊かない
 *
 * 取り込みの途中で「どのサイトに出していますか」と訊くと、いちばん最初の
 * 体験に問いが1つ増える。**分かったことだけを黙って書く**——書かれたものは
 * 「投稿サイトの設定」からいつでも直せる。
 *
 * ## 読めなかった欄は持たない（6.68.5）
 *
 * バックアップに入っているのは、サイトの名前と【ジャンル】までである。
 * **作品IDも作品ページのURLも入っていない**ので、書かない。紹介文に
 * 「10万PV達成記念」と書いてあっても、そこから数字を拾わない——作者が
 * 書いた文章であって、いまの数字ではない（AIに事実を作らせるのと同じ）。
 *
 * ジャンルすら読めなかったときは**台帳そのものを作らない。** 中身の無い
 * 行は `withSiteProfile` が置かない決まりで、空の台帳だけが残ると、
 * 使っていない作品のフォルダーにファイルが1つ増えるだけになる。
 *
 * ## すでにある記述は壊さない（実装ルール2）
 *
 * 同じサイトの作品情報がすでにあれば、**何もしない。** 作者が書いた
 * メモやジャンルを、取り込みの下ごしらえで押し流さない。
 */
async function notePostingSite(
  work: WorkEntry,
  site: PostingSiteId,
  inspection: WorkZipInspection
): Promise<RecordedReaderStats> {
  try {
    const store = new PostingStore(work);
    const ledger = await store.load();

    const profile = backupSiteProfile(inspection);
    let next = ledger;
    // **すでに作品情報があれば触らない。** 作者が書いたメモやジャンルを、
    // 取り込みの下ごしらえで押し流さない（実装ルール2）
    if (profile && !siteProfile(ledger, site)) {
      next = withSiteProfile(ledger, site, profile);
    }

    const before = next.readerStats ?? [];
    next = withBackupReaderStats(next, inspection);
    const added = (next.readerStats ?? []).slice(before.length);

    // 何も足すものが無ければ、台帳そのものを作らない（空の入れ物を置かない）
    if (next === ledger) return NOTHING_RECORDED;
    await store.save(next);
    return {
      work: added.some((record) => record.scope === "work"),
      episodes: added.filter((record) => record.scope === "episode").length,
    };
  } catch (error) {
    // **書けなくても、取り込みそのものは成り立っている**（下書きと同じ扱い）。
    // ここで止めると、原稿は入っているのに失敗したように見える
    logFailure("投稿状態の下ごしらえ", {
      作品: work.title,
      サイト: site,
      詳細: error instanceof Error ? error.message : String(error),
    });
    return NOTHING_RECORDED;
  }
}

/**
 * 台帳へ積んだ読者の反応の内訳（設計書6.99）。
 *
 * **件数をそのまま伝えないために、範囲で持つ。** 話ごとに1件ずつ積むので、
 * 500話の作品では501件になる——「読者の反応を501件記録しました」は、
 * 何が起きたのか分からないまま作者を驚かせる（作者の指摘、2026-09-19）。
 * 内訳は台帳と執筆量パネルの「サイトの記録」で見られる。
 */
interface RecordedReaderStats {
  /** 作品全体の数字（【評価】）を積んだか */
  readonly work: boolean;
  /** 話ごとの数字（【リアクション】）を積んだ話数 */
  readonly episodes: number;
}

const NOTHING_RECORDED: RecordedReaderStats = { work: false, episodes: 0 };

/**
 * 台帳へ書く作品情報を組み立てる（設計書6.68.5）。**読めた欄だけを持つ。**
 *
 * - カクヨム：バックアップに作品IDもURLも入っていないので、ジャンルだけ
 * - なろう：**Nコードが入っている**ので、作品IDと作品ページのURLも入る
 *   （URLはNコードから一意に決まる形を合成する。読みにはいかない）
 */
function backupSiteProfile(
  inspection: WorkZipInspection
): PostingSiteProfile | undefined {
  const genre = (inspection.narou?.header.genre ?? inspection.info?.genre ?? "")
    .trim();
  const narou = inspection.narou?.header;

  const profile: PostingSiteProfile = {
    // **小文字で持つ。** URLの中も、貼り込み係が管理画面から読む作品IDも
    // 小文字なので、照合（`matchReaderStatsEnvelope`）が素直に通る
    ...(narou ? { workId: narou.ncode, workUrl: narou.workUrl } : {}),
    ...(genre ? { genre } : {}),
  };
  return Object.keys(profile).length > 0 ? profile : undefined;
}

/**
 * バックアップに入っていた読者の反応を積む（設計書6.99）。
 *
 * ## なろうのバックアップからは読んでよい
 *
 * 設計書6.79.7の「なろうは手入力のみ」は**サイトを機械で読むこと**に
 * ついての判断であって、**作者が自分でダウンロードしたファイルを読むこと
 * とは別**である（作者の裁定、2026-09-19）。ここでもHTTPは1本も発しない。
 *
 * ## カクヨムには数字が無い
 *
 * カクヨムのバックアップに入っているのは作品情報だけである。紹介文に
 * 「10万PV達成記念」と書いてあっても**そこから数字を拾わない**——作者が
 * 書いた文章であって、いまのPVではない（AIに事実を作らせるのと同じ）。
 *
 * ## 読み取った日時
 *
 * `readAt` は取り込んだ日時にする。バックアップがいつの数字かは
 * ファイルに書かれていないので、**分かる時刻だけを書く**。
 */
function withBackupReaderStats(
  ledger: PostingLedger,
  inspection: WorkZipInspection
): PostingLedger {
  const narou = inspection.narou;
  if (!narou) return ledger;

  const readAt = new Date().toISOString();
  let next = ledger;

  // 作品全体（【評価】）。読めた欄が1つも無ければ記録しない
  if (hasReaderStatsMetrics(narou.header.metrics)) {
    next = withReaderStats(next, {
      site: "narou",
      readAt,
      scope: "work",
      metrics: narou.header.metrics,
      source: "backup",
    });
  }

  // 話ごと（【リアクション】）。**作者の確認：各話での読者の反応である**
  for (const episode of narou.episodes) {
    if (!hasReaderStatsMetrics(episode.metrics)) continue;
    next = withReaderStats(next, {
      site: "narou",
      readAt,
      scope: "episode",
      episode: episode.episode,
      metrics: episode.metrics,
      source: "backup",
    });
  }

  return next;
}

/** 通知に並べる「気をつけたいこと」の見出しの上限。超えたら「ほか」 */
const LISTED_CONCERNS = 3;

/**
 * 結果を伝える（設計書6.81の規則3）。
 *
 * ## 通知に全部入れない（作者の実機報告、2026-09-19）
 *
 * アルファポリスの Shift_JIS 版（188話）を取り込んだとき、重複・欠番・
 * 文字コードの助言・読者の反応がぜんぶ繋がって**280字あまりの1行**になった。
 * **VS Code の通知は行を分けられない**ので、長い説明を入れた時点で読めなく
 * なる（確認の画面はモーダルなので `\n` が効く。あちらは今のままでよい）。
 *
 * そこで、**通知は「終わったこと」と「次にできること」だけ**にする。
 * 気をつけたいことは**見出しだけ**を並べ、中身は記録へ回す。
 *
 * ## 記録は、通知より先に書く
 *
 * `.aiwriter/generated/` へ「取り込みの記録」として書き出してから通知を出す。
 * **通知を閉じても読める**ことがこの直しの肝で、押されたときに初めて作ると、
 * 閉じた人には結局残らない。書けなかったときだけ、従来どおり通知へ全部入れる
 * ——読めない通知のほうが、消えてしまうよりはましである。
 */
async function reportResult(
  work: WorkEntry,
  /** 取り込んだ元。記録に残す（あとから「どれを入れたか」を辿れるように） */
  zipPath: string,
  inspection: WorkZipInspection,
  placed: readonly string[],
  /** 台帳へ積んだ読者の反応の内訳（バックアップに入っていたぶん） */
  recorded: RecordedReaderStats
): Promise<void> {
  const invite = readerStatsInvite(inspection.site, recorded);
  // **確認の画面で言ったことを、済んだあとでもう一度言う**（作者の指示）。
  // 確認は読み飛ばされることがあり、重複と欠番はあとから直すものなので、
  // 終わったところにも残しておかないと気づかれないまま埋もれる。
  // 取りやめの案内はしない——もう取り込んである（`describeBackupEncoding`）
  const episodeNotes = describeEpisodeNumbers(
    inspection.episodeNumbers,
    inspection.dropped
  );
  const encodingNotes = describeBackupEncoding(
    inspection.encodingNotice,
    "after"
  );
  const concerns = [...episodeNotes, ...encodingNotes];

  const recordPath = await saveGeneratedMarkdown(
    IMPORT_RECORD_KIND,
    buildImportRecord({
      title: work.title,
      sourceName: path.basename(zipPath),
      episodeCount: inspection.episodeCount,
      collected: inspection.collected,
      totalChars: inspection.totalChars,
      placed,
      skipped: inspection.skipped,
      episodeNotes,
      encodingNotes,
      noted: invite?.noted,
    }),
    work
  );

  const message = recordPath
    ? shortSummary(inspection, concerns, invite)
    : // 記録を置けなかった（権限・容量・ブラウザ版の保管庫）。
      // **黙って落とさない**——読みにくくても、この場で全部言う
      [
        `${inspection.episodeCount}話を取り込みました。`,
        invite?.noted ?? "",
        ...concerns,
        invite?.line ?? "",
      ]
        .filter((note) => note !== "")
        .join(" ");

  const action = await vscode.window.showInformationMessage(
    message,
    // **記録を先頭に置く。** 気をつけたいことがあるときは、ここが次の一歩
    ...(recordPath ? [`${IMPORT_RECORD_KIND}を開く`] : []),
    "フォルダーを開く",
    ...(invite?.buttons ?? [])
  );

  if (recordPath && action === `${IMPORT_RECORD_KIND}を開く`) {
    await openInDefaultEditor(recordPath);
    return;
  }
  if (action === "フォルダーを開く") {
    await revealFolder(work.folderPath);
    return;
  }

  const command = invite?.commands[action ?? ""];
  // **押さなければ何も起きない。** 誘いであって、取り込みの続きではない
  if (command) {
    await vscode.commands.executeCommand(command, { type: "work", work });
  }
}

/**
 * 通知に出す短い文（1行で読み切れる長さに収める）。
 *
 * 気をつけたいことは**見出しだけ**にする。「同じ話番号」とだけ言えば、
 * 記録を開くかどうかを作者が決められる——中身まで通知に書くと、
 * 決める前に読まされることになる。
 */
function shortSummary(
  inspection: WorkZipInspection,
  concerns: readonly string[],
  invite: ReaderStatsInvite | undefined
): string {
  const topics = concernTopics(inspection);
  const listed = topics.slice(0, LISTED_CONCERNS).join("・");
  const heading =
    concerns.length === 0
      ? `取り込んだ内容は「${IMPORT_RECORD_KIND}」に残しました。`
      : `気をつけたいこと（${listed}${
          topics.length > LISTED_CONCERNS ? " ほか" : ""
        }）を「${IMPORT_RECORD_KIND}」に残しました。`;

  return [
    `${inspection.episodeCount}話を取り込みました。`,
    invite?.short ?? "",
    heading,
    invite?.line ?? "",
  ]
    .filter((part) => part !== "")
    .join("");
}

/**
 * 気をつけたいことの見出し。**短い言葉にする**（通知は1行に並ぶ）。
 *
 * 文面そのもの（`describeEpisodeNumbers`）から作らないのは、あちらが
 * 助言を含む長い文だからである。**見出しは見出しとして持つ。**
 */
function concernTopics(inspection: WorkZipInspection): string[] {
  const numbers = inspection.episodeNumbers;
  return [
    numbers.duplicates.length > 0 ? "同じ話番号" : "",
    numbers.missing.length > 0 ? "番号の抜け" : "",
    numbers.unnumbered > 0 ? "読み取れない話数" : "",
    inspection.encodingNotice.shiftJis ? "文字コード" : "",
  ].filter((topic) => topic !== "");
}

/** 読者の反応の誘い（`readerStatsInvite` が返すもの） */
interface ReaderStatsInvite {
  /** 通知に出す短い一言（「アルファポリスの作品として下ごしらえしました。」） */
  short: string;
  /** 記録に残す、何をしたかの全文 */
  noted: string;
  /** 通知に出す「次にできること」 */
  line: string;
  buttons: string[];
  commands: Record<string, string>;
}

/**
 * 読者の反応の口へ誘う1行（設計書6.79.7）。
 *
 * **サイトによって書き分ける。** 貼り付けでの取り込みに対応しているのは
 * カクヨムとアルファポリスだけで、**なろうの封筒は受け取らない**
 * （規約の判断。`readerStatsEnvelope.ts`）。なろうで「貼り付け」を案内すると、
 * 押した先で断られる——できないことを誘わない。
 *
 * **何を記録したかは、通知ではなく記録へ書く**（0.70.1）。「バックアップに
 * あった作品全体と各話の読者の反応を記録しました」は、終わったことの内訳
 * なので、通知には短い `short` だけを出す。黙るわけではない（`noted` が
 * 取り込みの記録に載る）。
 *
 * @returns 誘わないなら undefined（出どころが分からなかったとき）
 */
function readerStatsInvite(
  site: PostingSiteId | null,
  recorded: RecordedReaderStats
): ReaderStatsInvite | undefined {
  if (!site) return undefined;
  const label = postingSiteInfo(site).label;
  /*
    **書き留めたことを黙っていない。** 訊かずに書いたものこそ、何を書いたかを
    伝える（設計書6.81の規則3）。

    **ただし件数は言わない**（0.69.9、作者の指摘）。話ごとに1件ずつ積むので
    500話なら501件になり、「501件記録しました」は知らせではなく驚きになる。
    どこに何が入ったかは、執筆量パネルの「サイトの記録」と台帳で見られる。
  */
  const scope = [
    recorded.work ? "作品全体" : "",
    recorded.episodes > 0 ? "各話" : "",
  ]
    .filter((part) => part !== "")
    .join("と");
  const short = `${label}の作品として下ごしらえしました。`;
  const noted = scope
    ? `${label}の作品として下ごしらえし、バックアップにあった${scope}の読者の反応を記録しました。`
    : short;

  if (supportsReaderStatsHelper(site)) {
    return {
      short,
      noted,
      line: "読者の反応（PV・応援など）は、貼り付けか手入力で足せます。",
      buttons: ["貼り付けて取り込む", "手入力する"],
      commands: {
        貼り付けて取り込む: "novelai.importReaderStats",
        手入力する: "novelai.recordReaderStats",
      },
    };
  }

  return {
    short,
    noted,
    line: "この先の読者の反応は、手入力で足せます。",
    buttons: ["手入力する"],
    commands: { 手入力する: "novelai.recordReaderStats" },
  };
}
