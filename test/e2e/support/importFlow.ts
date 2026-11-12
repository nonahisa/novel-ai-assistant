/**
 * 原稿エディターの［入力］（テキストファイル・Word・バックアップ）を押す画面の自動テストの共通部品
 * （設計書6.25.13・6.113。実機確認リスト 0.147.0／0.150.0 の項目を機械へ移す束で使う）。
 *
 * - 取り込み元のファイルは、**作品の外**（書庫の隣の「取り込み元」フォルダー。作者がダウンロードした
 *   フォルダーに当たる）へ起こす前に置く。作者の原稿・確認用コピーは読まない
 * - ファイルを選ぶ窓は、VS Code の簡易の窓（`files.simpleDialog.enable`）で開く。OS のダイアログは
 *   Playwright から読めず、作者の画面の前面に出るため（`backupFileDialog.test.ts` と同じ道）
 * - 確認の窓（モーダル）は `window.dialogStyle: "custom"`（`vscodeApp.ts` の既定）で VS Code の中に出る
 *
 * **AI は呼ばない。**
 */
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { zipSync } from "fflate";
import type { Frame, Page } from "playwright-core";
import { composeText, frameLayer, manuscriptFrames } from "./manuscriptFrame";
import { describeNotices } from "./noticeRecord";
import { fillInput, waitForQuickInput } from "./quickInput";
import type { E2ESession, LaunchOptions } from "./vscodeApp";
import { waitUntil } from "./wait";
import { activeTabNames, dialogText, quickOpen, quickPickTitle, tabNamesInclude } from "./workbenchDom";

/** ファイルを選ぶ3つの窓の題（`manuscriptImport.ts`・`manuscriptBackupImport.ts`） */
export const TEXT_DIALOG_TITLE = "取り込むテキストファイルを選ぶ";
export const WORD_DIALOG_TITLE = "取り込む Word の文書を選ぶ";
export const BACKUP_DIALOG_TITLE = "話を足すバックアップを選ぶ（ZIP／テキスト）";

/** ファイルを選ぶ窓を、OS のダイアログでなく VS Code の中の簡易の窓で出す */
export const FILE_DIALOG_SETTINGS = { "files.simpleDialog.enable": true } as const;

const SOURCE_FOLDER = "取り込み元";

/** 取り込み元を置くフォルダー（書庫の隣。作品とワークスペースの外） */
export function sourceFolderOfWork(workFolder: string): string {
  return path.join(path.dirname(path.dirname(workFolder)), SOURCE_FOLDER);
}

/** 起こす前に取り込み元を置く（`LaunchOptions.prepareWork` の中で呼ぶ） */
export async function putSources(workFolder: string, files: Readonly<Record<string, string | Uint8Array>>): Promise<void> {
  const folder = sourceFolderOfWork(workFolder);
  await mkdir(folder, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(folder, name), content);
  }
}

/**
 * 取り込み元を作品の外へ置いて起こす指定（`withVsCode` の4つ目）。
 * `extra` は作品の中へ置くもの（台帳・単話プロット・本文の置き直し）。
 * `settings` は使い捨ての settings.json へ足す（ファイルを選ぶ窓の設定は常に入る）
 */
export function launchWith(
  sources: Readonly<Record<string, string | Uint8Array>>,
  extra?: (folders: { workFolder: string; manuscriptFolder: string }) => Promise<void>,
  settings: Record<string, unknown> = {}
): LaunchOptions {
  return {
    settings: { ...FILE_DIALOG_SETTINGS, ...settings },
    prepareWork: async (folders) => {
      await putSources(folders.workFolder, sources);
      await extra?.(folders);
    },
  };
}

/** 取り込み元のファイルの場所（テスト本体から） */
export function sourcePathOf(session: E2ESession, name: string): string {
  return path.join(session.root, SOURCE_FOLDER, name);
}

/** 簡易の窓の入力欄の値（いま開いているフォルダーの道）。窓が出ていなければ空 */
async function dialogPath(page: Page): Promise<string> {
  return page.locator(".quick-input-widget input").first().inputValue().catch(() => "");
}

/**
 * ファイルを選ぶ窓（簡易の窓）で、道を打って選ぶ。
 *
 * 簡易の窓は、打った道を候補の行と突き合わせてから受ける。1回の Enter で決まらず行を選んだだけで
 * 止まることがあるので、窓の題が消えるまで（3回まで）押す（`backupFileDialog.test.ts` と同じ）
 */
export async function pickFileInDialog(page: Page, dialogTitle: string, file: string): Promise<void> {
  await waitForQuickInput(page, dialogTitle, 20_000);
  await waitUntil(async () => (await dialogPath(page)).length > 0, `ファイルを選ぶ窓（${dialogTitle}）の入力欄に道が入る`, 10_000);
  await fillInput(page, file);
  for (let attempt = 0; attempt < 3 && ((await quickPickTitle(page)) ?? "").includes(dialogTitle); attempt++) {
    await page.keyboard.press("Enter");
    await waitUntil(async () => !((await quickPickTitle(page)) ?? "").includes(dialogTitle), "ファイルを選ぶ窓が閉じる", 3_000).catch(() => undefined);
  }
}

/** 確認の窓（モーダル）のボタンの名前（出ていなければ空） */
export async function dialogButtons(page: Page): Promise<string[]> {
  return (await page.locator(".monaco-dialog-box .monaco-button").allInnerTexts().catch(() => [] as string[])).map((text) => text.trim());
}

/** 確認の窓の文に `needle` が出るまで待ち、窓の文を返す（時間切れには、いまの窓と知らせを添える） */
export async function waitDialogWith(session: E2ESession, needle: string, label: string, timeoutMs = 30_000): Promise<string> {
  let last: string | undefined;
  await waitUntil(
    async () => {
      last = await dialogText(session.page);
      return (last ?? "").includes(needle);
    },
    label,
    timeoutMs
  ).catch(async (error: unknown) => {
    throw new Error(
      `${String(error)}（いまの窓：${JSON.stringify(last ?? null)}／選ぶ画面の題：${(await quickPickTitle(session.page)) ?? "なし"}／` +
        `${await describeNotices(session)}／本文フォルダー：${JSON.stringify(await manuscriptNames(session))}）`
    );
  });
  return last ?? "";
}

/** 本文フォルダーの話のファイル名（並べ替え済み）。書き込み途中の一時ファイル（`*.novelai-*.tmp`）・フォルダーは数えない */
export async function manuscriptNames(session: E2ESession): Promise<string[]> {
  const entries = await readdir(session.manuscriptFolder, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && !/\.novelai-[^/\\]*\.tmp$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/** 本文フォルダーの話のバイト列（書き戻しは退避→作り直しで一瞬無いので、その間は待つ。無ければ undefined） */
export async function manuscriptBytes(session: E2ESession, fileName: string): Promise<Buffer | undefined> {
  const file = path.join(session.manuscriptFolder, fileName);
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return await readFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return undefined;
}

/** 本文フォルダーの話の文字（UTF-8。無ければ undefined） */
export async function manuscriptText(session: E2ESession, fileName: string): Promise<string | undefined> {
  return (await manuscriptBytes(session, fileName))?.toString("utf8");
}

/** 落ちたときの文へ添える、本文フォルダーの様子・窓・知らせ・タブ */
export async function importContext(session: E2ESession, since = 0): Promise<string> {
  return (
    `本文フォルダー：${JSON.stringify(await manuscriptNames(session))}／確認の窓：${JSON.stringify((await dialogText(session.page)) ?? null)}／` +
    `選ぶ画面の題：${(await quickPickTitle(session.page)) ?? "なし"}／タブ：${JSON.stringify(await activeTabNames(session.page))}／` +
    (await describeNotices(session, since))
  );
}

/** 条件が満たされるまで待つ。時間切れには `importContext` を添える */
export async function waitWithContext(
  session: E2ESession,
  check: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 30_000,
  since = 0
): Promise<void> {
  await waitUntil(check, label, timeoutMs).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（${await importContext(session, since)}）`);
  });
}

/**
 * クイックオープンで話を開き、前に出ている原稿エディターの面を返す。
 *
 * 本文が空の話は、本文の文字で面を探せない（`openEpisode` は本文の目印を待つ）ので、
 * 前に出ているタブの名前と、前に出ている面で見つける。**面は1枚ずつ前に出る**ので、
 * 前の話の裏に回った面は拾わない
 */
export async function openEpisodeFrame(page: Page, fileName: string): Promise<Frame> {
  await quickOpen(page, fileName);
  let found: Frame | undefined;
  await waitUntil(
    async () => {
      if (!tabNamesInclude(await activeTabNames(page), fileName)) return false;
      for (const frame of await manuscriptFrames(page)) {
        if ((await frameLayer(page, frame).catch(() => undefined))?.inFront) {
          found = frame;
          return true;
        }
      }
      return false;
    },
    `原稿エディターで「${fileName}」が前に出て、その面が見える`,
    30_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（前のタブ：${JSON.stringify(await activeTabNames(page))}）`);
  });
  if (!found) throw new Error(`「${fileName}」の面が見つかりません`);
  return found;
}

/** 面（本文の組む欄）に `needle` が出るまで待つ（取り込みのあとの読み直し） */
export async function waitComposeWith(session: E2ESession, frame: Frame, needle: string, label: string): Promise<void> {
  await waitWithContext(session, async () => (await composeText(frame).catch(() => "")).includes(needle), label, 20_000);
}

/** 面の見た目（縦書きか・字の大きさ px・組んで書く面か）。`renameSubtitleAppearance.test.ts` と同じ読み方 */
export async function faceLook(frame: Frame): Promise<{ vertical: boolean; size: number; compose: boolean }> {
  return frame.evaluate(() => ({
    vertical: document.body.classList.contains("vertical"),
    size: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--novelai-size")) || 0,
    compose: document.body.classList.contains("compose"),
  }));
}

/* ── 取り込み元の見本の組み立て ── */

const encoder = new TextEncoder();

/** 段落の XML から .docx（ZIP）を組む。読むのは本文の XML だけ（`readWordManuscript`） */
export function docxOf(paragraphsXml: string): Uint8Array {
  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    paragraphsXml +
    "</w:body></w:document>";
  return zipSync({ "word/document.xml": encoder.encode(xml) });
}

/** 字だけの1つの run */
export const wordRun = (text: string): string => `<w:r><w:t>${text}</w:t></w:r>`;

/** ルビ。読み（`w:rt`）が先、親文字（`w:rubyBase`）が後という Word の並び */
export const wordRuby = (base: string, reading: string): string =>
  '<w:r><w:ruby><w:rubyPr><w:rubyAlign w:val="center"/></w:rubyPr>' +
  `<w:rt><w:r><w:t>${reading}</w:t></w:r></w:rt><w:rubyBase><w:r><w:t>${base}</w:t></w:r></w:rubyBase></w:ruby></w:r>`;

/** 傍点（`w:em w:val="dot"`）の付いた run */
export const wordDotted = (text: string): string => `<w:r><w:rPr><w:em w:val="dot"/></w:rPr><w:t>${text}</w:t></w:r>`;

/** 段落 */
export const wordParagraph = (inner: string): string => `<w:p>${inner}</w:p>`;

/** バイト列を16進で（落ちたときの文へ添える） */
export function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
}
