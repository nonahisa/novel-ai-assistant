import * as vscode from "vscode";
import * as path from "../core/paths";
import { decodeBytes } from "../core/textDecode";
import {
  describeSubstitutions,
  describeUnencodable,
  findShiftJisSubstitutions,
  findUnencodableShiftJis,
  substituteForShiftJis,
  type UnencodableChar,
} from "../core/sjisFallback";
import { isEpisodeBodyRelPath } from "../core/episodeRenameDrift";
import {
  atomicWriteFile,
  createManagedRecoveryPath,
  pruneManagedRecoveries,
} from "../core/atomicWrite";
import { workLog } from "../core/logger";
import type { WorkEntry } from "../models/types";

/**
 * **作者が VS Code で打って保存する道**の、Shift_JIS の字の置き換え（設計書5.4.2、0.148.1）。
 *
 * 0.148.0 の置き換え（`core/textEncodePreserving.ts`）は、拡張機能が書き戻す道
 * （`writeTextFilePreservingFormat`）にしか効かない。素のエディター・原稿エディターで打って
 * 保存すると、**VS Code 自身が** Shift_JIS で書き、符号の無い字（Mac の日本語入力の「〜」など）を
 * 黙って「?」（0x3f）にする（iconv-lite の系統。エラーは出ない）。作者の決定（2026-11-08・09）は
 * 「黙って置き換える」で、作者が打って保存する道も含む。
 *
 * そこで保存の直前の受け口（`onWillSaveTextDocument`）で、表の字を**字ごとに**書き換える。
 * 原稿エディター（`CustomTextEditorProvider`）の保存も同じ文書の `save()` なので、ここを通る。
 * 自動保存（`files.autoSave`）でも同じ受け口が鳴る（`TextDocumentSaveReason.AfterDelay`）。
 *
 * **この受け口では保存を止められない**（API の決まり。待たせられるのは全体で1.5秒まで、
 * 遅れたり投げたりを3回すると以後呼ばれなくなる）。置き換え先の無い字（♡ など）が残る保存は
 * 「?」になって書かれてしまうので、**保存の前に元の本文を控えに残し、保存のあとに知らせる**
 * （作者が選ぶまでの間の、原稿が壊れない側の作り。2026-11-09 母艦の指示）。
 */

/** 何が「?」になる見込みか（知らせの係へ渡す） */
export interface UnencodableSave {
  document: vscode.TextDocument;
  filePath: string;
  workFolder: string;
  /** 保存の直前の本文（作者が打ったまま。置き換える前）。控えに残す */
  text: string;
  found: UnencodableChar[];
}

/** 外とのつなぎ。単体テストで差し替える */
export interface ShiftJisSaveDeps {
  /** 作品の話の本文なら、その作品フォルダー。話でなければ undefined */
  workFolderOf(filePath: string): string | undefined;
  /** ディスク上の今のバイト列（VS Code 1.90 で文字コードを決めるため） */
  readBytes(uri: vscode.Uri): Promise<Uint8Array>;
  /** 設定 `files.encoding`（その文書に効く値） */
  configuredEncoding(uri: vscode.Uri): string | undefined;
  log(workFolder: string, message: string): void;
  onUnencodable(report: UnencodableSave): void;
  /** 書けない字の無い保存だった（知らせの係が「出した」を忘れる） */
  onClean(document: vscode.TextDocument): void;
}

/** `onWillSaveTextDocument` の知らせのうち、使う所だけ */
export interface WillSaveEvent {
  document: vscode.TextDocument;
  waitUntil(thenable: Thenable<readonly vscode.TextEdit[]>): void;
}

/** VS Code の文字コードの名前（`TextDocument.encoding`・`files.encoding`）での Shift_JIS */
const VSCODE_SHIFT_JIS = "shiftjis";

/**
 * 保存の直前の受け口の本体。
 *
 * - **作品の話でなければ何もしない**（`waitUntil` も呼ばない＝保存を待たせない）
 * - 文書の文字コードが分かり、Shift_JIS でなければ何もしない
 * - `waitUntil` は**この呼び出しの中で**呼ぶ（あとからは呼べない決まり）。渡す約束は**決して
 *   失敗させない**——失敗が3回続くと、この受け口ごと以後呼ばれなくなり、置き換えが黙って止まる
 */
export function handleWillSave(event: WillSaveEvent, deps: ShiftJisSaveDeps): void {
  const document = event.document;
  const filePath = path.fromUri(document.uri);
  const workFolder = deps.workFolderOf(filePath);
  if (!workFolder) return;

  const declared = declaredEncoding(document);
  if (declared !== undefined && declared !== VSCODE_SHIFT_JIS) return;

  // 本文は呼ばれた瞬間のものを使う。待つあいだに打たれたら、VS Code が書き換えを捨てる（API の決まり）
  const text = document.getText();
  event.waitUntil(
    (async (): Promise<vscode.TextEdit[]> => {
      try {
        if (declared === undefined && !(await isShiftJisOn190(document, deps))) return [];
        return planEdits(document, filePath, workFolder, text, deps);
      } catch (error) {
        deps.log(
          workFolder,
          `保存の前の Shift_JIS の置き換えを行えませんでした（${path.basename(filePath)}）：${error instanceof Error ? error.message : String(error)}`
        );
        return [];
      }
    })()
  );
}

/**
 * 文書の文字コード（VS Code の名前）。**VS Code 1.90 には `TextDocument.encoding` が無い**
 * （型は新しい版のものなので、型検査が通っても 1.90 では undefined が来る）
 */
function declaredEncoding(document: vscode.TextDocument): string | undefined {
  const value = (document as { encoding?: unknown }).encoding;
  return typeof value === "string" ? value : undefined;
}

/**
 * VS Code 1.90 の道：ディスクの今のバイト列で決める（判定は製品と同じ `decodeBytes`。写さない）。
 * 英数字だけ・空のファイルはバイトから決まらないので、VS Code が書くときに使う設定
 * `files.encoding` に従う
 */
async function isShiftJisOn190(document: vscode.TextDocument, deps: ShiftJisSaveDeps): Promise<boolean> {
  // まだディスクに無い（初めて保存する）話は読めない。バイトから決まらないのと同じに扱う
  const bytes = await deps.readBytes(document.uri).catch(() => new Uint8Array());
  if (bytes.some((byte) => byte >= 0x80)) return decodeBytes(bytes).encoding === "shift_jis";
  return deps.configuredEncoding(document.uri) === VSCODE_SHIFT_JIS;
}

function planEdits(
  document: vscode.TextDocument,
  filePath: string,
  workFolder: string,
  text: string,
  deps: ShiftJisSaveDeps
): vscode.TextEdit[] {
  const name = path.basename(filePath);
  /*
    **字ごとに小さく書き換える**（全文の置き換えにしない）。全文を替えると、取り消しの履歴が
    1つの大きな変更になり、カーソルも先頭へ飛ぶ。範囲は元の本文の位置で取る（𠮟 は2単位で
    置き換え先は1単位。置き換えたあとの本文から数えるとずれる）。`getText()` の改行は文書の
    ままなので、LF に揃えずに数える
  */
  const { spans, substitutions } = findShiftJisSubstitutions(text);
  const edits = spans.map((span) =>
    vscode.TextEdit.replace(
      new vscode.Range(document.positionAt(span.index), document.positionAt(span.index + span.length)),
      span.to
    )
  );
  if (substitutions.length > 0) {
    // 作者には知らせない（作者の決定 2026-11-08「黙って」）。ログには何を何に何個かだけ（本文の前後は書かない）
    deps.log(workFolder, `保存の前に、Shift_JIS に無い字を置き換えました（${name}）：${describeSubstitutions(substitutions)}`);
  }

  const found = findUnencodableShiftJis(substituteForShiftJis(text).text);
  if (found.length > 0) {
    // ログには字と行だけ（前後の本文は原稿なので書かない）
    deps.log(
      workFolder,
      `保存すると「?」になる字があります（${name}）：${found.map(({ char, line }) => `${line}行目の「${char}」`).join("、")}`
    );
    deps.onUnencodable({ document, filePath, workFolder, text, found });
  } else {
    deps.onClean(document);
  }
  return edits;
}

/** 知らせの係の外とのつなぎ。単体テストで差し替える */
export interface UnencodableWarnerDeps {
  /** 本文を控えに残し、その場所を返す（残せなければ undefined） */
  keep(filePath: string, text: string): Promise<string | undefined>;
  /** その文書の保存が済むまで待つ */
  whenSaved(document: vscode.TextDocument): Promise<void>;
  /** 真ん中の窓で知らせ、押されたボタンを返す */
  warn(message: string, detail: string, buttons: readonly string[]): Thenable<string | undefined>;
  openKeep(recoveryPath: string): void;
  log(workFolder: string, message: string): void;
}

const OPEN_KEEP = "控えを開く";

/**
 * 置き換え先の無い字が「?」になる保存の知らせ。
 *
 * - **控えは保存の前に取りはじめる**（本文は受け口が呼ばれた瞬間のもの。保存を待たせない）
 * - 窓は**保存が済んでから**出す。先に出すと「? になりました」がまだ本当でない
 * - **同じ文書・同じ字の組では1度だけ**。自動保存（`afterDelay`）では打つたびに保存が鳴り、
 *   そのたびに窓が出ると書けなくなる。書けない字が無くなったら（`forget`）忘れ、また打てば知らせ直す
 * - 窓のボタンの答えは待たない形で受ける（押されたら控えを開くだけ。処理中の旗は立てない）
 */
export function createUnencodableWarner(deps: UnencodableWarnerDeps): {
  report(report: UnencodableSave): void;
  forget(document: vscode.TextDocument): void;
} {
  /** 文書ごとの、最後に知らせた字の組 */
  const warned = new Map<string, string>();
  return {
    report(report) {
      const key = report.document.uri.toString();
      const signature = [...new Set(report.found.map(({ char }) => char))].sort().join("");
      if (warned.get(key) === signature) return;
      warned.set(key, signature);
      void (async () => {
        const saved = deps.whenSaved(report.document);
        const recoveryPath = await deps.keep(report.filePath, report.text).catch(() => undefined);
        await saved;
        const chars = [...new Set(report.found.map(({ char }) => `「${char}」`))].join("");
        const message = `${chars}は Shift_JIS に無い字のため、保存したファイルでは「?」になりました（${path.basename(report.filePath)}）。`;
        const detail = [
          `場所：${describeUnencodable(report.found)}`,
          "エディターの中にはまだ元の字があります。字を直してから、もう一度保存してください。",
          recoveryPath
            ? `元の字を含む本文は控えに残しました：${recoveryPath}`
            : "元の字を含む本文の控えを残せませんでした。エディターを閉じる前に字を直してください。",
        ].join("\n\n");
        const picked = await deps.warn(message, detail, recoveryPath ? [OPEN_KEEP] : []);
        if (picked === OPEN_KEEP && recoveryPath) deps.openKeep(recoveryPath);
      })().catch((error: unknown) => {
        deps.log(
          report.workFolder,
          `「?」になる字の知らせを出せませんでした（${path.basename(report.filePath)}）：${error instanceof Error ? error.message : String(error)}`
        );
      });
    },
    forget(document) {
      warned.delete(document.uri.toString());
    },
  };
}

/** UTF-8 の BOM。控えを VS Code で開いたとき、`files.encoding` が Shift_JIS でも UTF-8 と読まれるように付ける */
const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf]);

/**
 * 控えを残す。置き場は本文の退避と同じ `.novelai-recovery`（話の隣。5世代。タイムラインの「控え」に
 * 並び、押すと開く）。中身は UTF-8（BOM 付き）——Shift_JIS では元の字を書けないため
 */
async function keepUnencodable(filePath: string, text: string): Promise<string | undefined> {
  const recoveryPath = await createManagedRecoveryPath(filePath);
  const body = new TextEncoder().encode(text);
  const bytes = new Uint8Array(UTF8_BOM.length + body.length);
  bytes.set(UTF8_BOM);
  bytes.set(body, UTF8_BOM.length);
  await atomicWriteFile(recoveryPath, bytes, { mode: "create" });
  await pruneManagedRecoveries(filePath);
  return recoveryPath;
}

/** その文書の次の保存が済むのを待つ（来なければ10秒であきらめて知らせる） */
function nextSaveOf(document: vscode.TextDocument): Promise<void> {
  return new Promise<void>((resolve) => {
    const key = document.uri.toString();
    const timer = setTimeout(done, 10_000);
    const listener = vscode.workspace.onDidSaveTextDocument((saved) => {
      if (saved.uri.toString() === key) done();
    });
    function done(): void {
      clearTimeout(timer);
      listener.dispose();
      resolve();
    }
  });
}

/** 作品の話の本文か（作品フォルダーの中の .txt/.md で、設定や控えの置き場でない） */
function workFolderOfEpisode(registry: { list(): readonly WorkEntry[] }, filePath: string): string | undefined {
  const work = [...registry.list()]
    .sort((a, b) => b.folderPath.length - a.folderPath.length)
    .find((entry) => path.isPathInside(entry.folderPath, filePath));
  if (!work) return undefined;
  return isEpisodeBodyRelPath(path.relative(work.folderPath, filePath)) ? work.folderPath : undefined;
}

/** 拡張機能の起動時に差し込む */
export function installShiftJisSaveGuard(registry: { list(): readonly WorkEntry[] }): vscode.Disposable {
  const log = (workFolder: string, message: string): void => workLog(workFolder).line(message);
  const warner = createUnencodableWarner({
    keep: keepUnencodable,
    whenSaved: nextSaveOf,
    warn: (message, detail, buttons) =>
      vscode.window.showWarningMessage(message, { modal: true, detail }, ...buttons),
    openKeep: (recoveryPath) => {
      void vscode.window.showTextDocument(path.toUri(recoveryPath), { preview: true });
    },
    log,
  });
  const deps: ShiftJisSaveDeps = {
    workFolderOf: (filePath) => workFolderOfEpisode(registry, filePath),
    readBytes: async (uri) => vscode.workspace.fs.readFile(uri),
    configuredEncoding: (uri) => vscode.workspace.getConfiguration("files", uri).get<string>("encoding"),
    log,
    onUnencodable: (report) => warner.report(report),
    onClean: (document) => warner.forget(document),
  };
  return vscode.workspace.onWillSaveTextDocument((event) => handleWillSave(event, deps));
}
