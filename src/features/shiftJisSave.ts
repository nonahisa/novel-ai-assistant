import * as vscode from "vscode";
import * as path from "../core/paths";
import { decodeBytes } from "../core/textDecode";
import {
  SJIS_UNENCODABLE_MARK,
  describeSubstitutions,
  planShiftJisSave,
  type SjisMark,
} from "../core/sjisFallback";
import { buildSjisMarkFindings } from "../core/sjisMarkFinding";
import {
  CONVERT_TO_UTF8_COMMAND,
  UTF8_CONVERT_BUTTON,
  UTF8_CONVERT_HINT,
  utf8ConvertFileArg,
} from "../core/utf8ConvertHint";
import { isEpisodeBodyRelPath } from "../core/episodeRenameDrift";
import {
  atomicWriteFile,
  createManagedRecoveryPath,
  pruneManagedRecoveries,
} from "../core/atomicWrite";
import { workLog } from "../core/logger";
import type { WorkEntry } from "../models/types";
import type { Finding, FindingDecision, FindingView } from "../models/finding";
import { FindingStore } from "./findingStore";
import { refreshSceneMemoFindings } from "./sceneMemoPanel";

/**
 * **作者が VS Code で打って保存する道**の、Shift_JIS の字の置き換え（設計書5.4.2、0.148.1・0.148.3）。
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
 * 遅れたり投げたりを3回すると以後呼ばれなくなる）。置き換え先の無い字（♡ など）は、何もしなければ
 * 「?」になって書かれる。作者の答え（2026-11-09「目印に置き換えた上で、メモ校正パネルに説明を残して、
 * ポップアップもあげてください」）で、**目印の「〓」に字ごとに置き換えて**保存する。順番は
 * 「控えを残す → 〓に置き換えて保存 → 校正・メモパネルへ場所を残す → 真ん中の窓で知らせる」。
 */

/** 〓にした字のある保存（知らせの係へ渡す） */
export interface UnencodableSave {
  document: vscode.TextDocument;
  filePath: string;
  /** 作品フォルダー。作品一覧に登録していない原稿では undefined（ログは保管庫へ。パネルへは残せない） */
  workFolder: string | undefined;
  /** 保存の直前の本文（作者が打ったまま。置き換える前）。控えに残す */
  text: string;
  /** 置き換えたあとの本文（保存されるもの）。校正・メモパネルの行の場所はここから決める */
  savedText: string;
  /** 〓にした字の全部 */
  marks: SjisMark[];
}

/** 外とのつなぎ。単体テストで差し替える */
export interface ShiftJisSaveDeps {
  /** 作品の話の本文なら、その作品フォルダー。話でなければ undefined */
  workFolderOf(filePath: string): string | undefined;
  /**
   * 作品一覧に登録したどの作品の中にも無い原稿（.txt・.md）か（0.152.10）。
   * 登録していない原稿でも、VS Code は「〜」を黙って「?」で書くので置き換える
   */
  isUnregisteredManuscript(filePath: string): boolean;
  /** ディスク上の今のバイト列（VS Code 1.90 で文字コードを決めるため） */
  readBytes(uri: vscode.Uri): Promise<Uint8Array>;
  /** 設定 `files.encoding`（その文書に効く値） */
  configuredEncoding(uri: vscode.Uri): string | undefined;
  /** 書き先の作品。undefined は保管庫のログ（作品が無いので。0.152.7 の記録係と同じ） */
  log(workFolder: string | undefined, message: string): void;
  /**
   * 登録していない原稿で字を置き換えた知らせ（0.152.10）。登録した作品の話は黙って置き換える
   * （作者の決定 2026-11-08）が、登録していない原稿は作品のログが無く、黙ると跡がどこにも見えない。
   * signature は置き換えた字の組（同じ文書・同じ組では1度だけ出すため）
   */
  notifyUnregistered(document: vscode.TextDocument, signature: string, message: string): void;
  /** 〓にする字がある。返す約束は**控えを残し終えたら**済む（〓への置き換えはそれを待つ） */
  onUnencodable(report: UnencodableSave): Promise<void>;
  /** 書けない字の無い保存だった（知らせの係が「出した」を忘れる） */
  onClean(document: vscode.TextDocument): void;
  /** 控えを待つ上限（ミリ秒）。単体テストで縮める */
  keepWaitMs?: number;
}

/** `onWillSaveTextDocument` の知らせのうち、使う所だけ */
export interface WillSaveEvent {
  document: vscode.TextDocument;
  waitUntil(thenable: Thenable<readonly vscode.TextEdit[]>): void;
}

/** VS Code の文字コードの名前（`TextDocument.encoding`・`files.encoding`）での Shift_JIS */
const VSCODE_SHIFT_JIS = "shiftjis";

/**
 * 控えを待つ上限。受け口の持ち時間は全体で1.5秒（文字コードの判定でファイルも読む）。
 * 超えると VS Code は書き換えを捨てて「?」で書くうえ、遅れが3回で受け口ごと止まる。
 * 控えは小さなファイル1つなので普段は数十ミリ秒で済む。遅いときは待たずに〓にする
 * （待っても待たなくても字はファイルから消えるので、控えを続けて残すほうに倒す）
 */
const KEEP_WAIT_MS = 700;

/**
 * 保存の直前の受け口の本体。
 *
 * - **作品の話でも、登録していない原稿（.txt・.md）でもなければ何もしない**（`waitUntil` も呼ばない＝保存を待たせない）。
 *   作品の中の話でないファイル（設定など）は今までどおり触らない
 * - 文書の文字コードが分かり、Shift_JIS でなければ何もしない
 * - `waitUntil` は**この呼び出しの中で**呼ぶ（あとからは呼べない決まり）。渡す約束は**決して
 *   失敗させない**——失敗が3回続くと、この受け口ごと以後呼ばれなくなり、置き換えが黙って止まる
 */
export function handleWillSave(event: WillSaveEvent, deps: ShiftJisSaveDeps): void {
  const document = event.document;
  const filePath = path.fromUri(document.uri);
  const workFolder = deps.workFolderOf(filePath);
  if (!workFolder && !deps.isUnregisteredManuscript(filePath)) return;

  const declared = declaredEncoding(document);
  if (declared !== undefined && declared !== VSCODE_SHIFT_JIS) return;

  // 本文は呼ばれた瞬間のものを使う。待つあいだに打たれたら、VS Code が書き換えを捨てる（API の決まり）
  const text = document.getText();
  event.waitUntil(
    (async (): Promise<vscode.TextEdit[]> => {
      try {
        if (declared === undefined && !(await isShiftJisOn190(document, deps))) return [];
        return await planEdits(document, filePath, workFolder, text, deps);
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

async function planEdits(
  document: vscode.TextDocument,
  filePath: string,
  workFolder: string | undefined,
  text: string,
  deps: ShiftJisSaveDeps
): Promise<vscode.TextEdit[]> {
  const name = path.basename(filePath);
  /*
    **字ごとに小さく書き換える**（全文の置き換えにしない）。全文を替えると、取り消しの履歴が
    1つの大きな変更になり、カーソルも先頭へ飛ぶ。範囲は元の本文の位置で取る（𠮟 は2単位で
    置き換え先は1単位。置き換えたあとの本文から数えるとずれる）。`getText()` の改行は文書の
    ままなので、LF に揃えずに数える
  */
  const plan = planShiftJisSave(text);
  const edits = plan.spans.map((span) =>
    vscode.TextEdit.replace(
      new vscode.Range(document.positionAt(span.index), document.positionAt(span.index + span.length)),
      span.to
    )
  );
  if (plan.substitutions.length > 0) {
    // 作者には知らせない（作者の決定 2026-11-08「黙って」）。ログには何を何に何個かだけ（本文の前後は書かない）
    const described = describeSubstitutions(plan.substitutions);
    deps.log(workFolder, `保存の前に、Shift_JIS に無い字を置き換えました（${name}）：${described}`);
    if (workFolder === undefined) {
      const signature = [...new Set(plan.substitutions.map(({ from }) => from))].sort().join("");
      deps.notifyUnregistered(
        document,
        signature,
        `Shift_JIS に無い字を置き換えて保存しました（${name}：${described}）。この原稿は作品一覧に登録していないので、記録は拡張機能のログに残しました。`
      );
    }
  }

  if (plan.marks.length === 0) {
    deps.onClean(document);
    return edits;
  }
  // ログには字と行だけ（前後の本文は原稿なので書かない）
  deps.log(
    workFolder,
    `保存の前に、Shift_JIS に無い字を「${SJIS_UNENCODABLE_MARK}」にしました（${name}）：${plan.marks.map(({ char, line }) => `${line}行目の「${char}」`).join("、")}`
  );
  /*
    **控えを残し終えてから〓にする**（実装ルール1。置き換えたあとは、元の字はファイルに無い）。
    ただし持ち時間を超えて待つと VS Code が書き換えを捨てて「?」で書くので、上限で切る
  */
  const keeping = deps
    .onUnencodable({ document, filePath, workFolder, text, savedText: plan.text, marks: plan.marks })
    .then(() => true)
    .catch(() => true);
  const kept = await Promise.race([
    keeping,
    new Promise<false>((resolve) => setTimeout(() => resolve(false), deps.keepWaitMs ?? KEEP_WAIT_MS)),
  ]);
  if (!kept) {
    deps.log(workFolder, `控えを残し終える前に、保存の持ち時間が来ました（${name}）。控えは続けて残します`);
  }
  return edits;
}

/** 知らせの係の外とのつなぎ。単体テストで差し替える */
export interface UnencodableWarnerDeps {
  /** 本文を控えに残し、その場所を返す（残せなければ undefined） */
  keep(filePath: string, text: string): Promise<string | undefined>;
  /** その文書の保存が済むまで待つ */
  whenSaved(document: vscode.TextDocument): Promise<void>;
  /** 校正・メモパネルの置き場へ〓の場所を残す。残せた行があれば true */
  record(report: UnencodableSave, recoveryPath: string | undefined): Promise<boolean>;
  /** 真ん中の窓で知らせ、押されたボタンを返す */
  warn(message: string, detail: string, buttons: readonly string[]): Thenable<string | undefined>;
  openKeep(recoveryPath: string): void;
  openPanel(workFolder: string): void;
  /** この原稿を UTF-8 に変換する命令を呼ぶ（0.149.0） */
  convert(filePath: string): void;
  log(workFolder: string | undefined, message: string): void;
}

const OPEN_PANEL = "校正・メモパネルを開く";
const OPEN_KEEP = "控えを開く";
/** 窓の詳しい欄に並べる場所の数（長い原稿で何百も並べない） */
const PLACES_LIMIT = 3;

/**
 * 〓にした字の知らせ。
 *
 * - **控えは保存の前に取りはじめる**（本文は受け口が呼ばれた瞬間のもの）。返す約束は控えが
 *   済んだら済む——受け口が〓への置き換えをそれまで待つ
 * - 校正・メモパネルへ残すのも、窓も、**保存が済んでから**。先に出すと「〓にして保存しました」が
 *   まだ本当でない
 * - **控えとパネルの行は毎回**残す（保存のたびに本文の字が〓になるので、どの回も元の字が要る）
 * - **窓は、同じ文書・同じ字の組では1度だけ**。自動保存（`afterDelay`）では打つたびに保存が鳴り、
 *   そのたびに窓が出ると書けなくなる。書けない字が無くなったら（`forget`）忘れ、また打てば知らせ直す
 * - 窓のボタンの答えは待たない形で受ける（押されたら開くだけ。処理中の旗は立てない）
 */
export function createUnencodableWarner(deps: UnencodableWarnerDeps): {
  report(report: UnencodableSave): Promise<void>;
  forget(document: vscode.TextDocument): void;
} {
  /** 文書ごとの、最後に知らせた字の組 */
  const warned = new Map<string, string>();
  return {
    report(report) {
      const key = report.document.uri.toString();
      const signature = [...new Set(report.marks.map(({ char }) => char))].sort().join("");
      const shouldWarn = warned.get(key) !== signature;
      warned.set(key, signature);
      const name = path.basename(report.filePath);
      const saved = deps.whenSaved(report.document);
      const keeping = deps.keep(report.filePath, report.text).catch((error: unknown) => {
        deps.log(report.workFolder, `元の字を含む本文の控えを残せませんでした（${name}）：${messageOf(error)}`);
        return undefined;
      });
      void (async () => {
        const recoveryPath = await keeping;
        await saved;
        const recorded = await deps.record(report, recoveryPath).catch((error: unknown) => {
          deps.log(report.workFolder, `「〓」にした場所を校正・メモパネルへ残せませんでした（${name}）：${messageOf(error)}`);
          return false;
        });
        if (!shouldWarn) return;
        const [first] = report.marks;
        const count = report.marks.length;
        const message =
          `Shift_JIS に無い字が${count}字あったので、「${SJIS_UNENCODABLE_MARK}」にして保存しました` +
          `（「${first.char}」${first.line}行目${count > 1 ? " ほか" : ""}）。` +
          (recorded
            ? "校正・メモパネルに場所を残しました。"
            : report.workFolder === undefined
              ? "この原稿は作品一覧に登録していないので、校正・メモパネルには場所を残していません。"
              : "校正・メモパネルには場所を残せませんでした。") +
          // 原稿の文字コード変換を案内する（作者の指示 2026-11-09「知らせる時は、原稿の文字コード変換を案内してください」）
          UTF8_CONVERT_HINT;
        const places = report.marks
          .slice(0, PLACES_LIMIT)
          .map(({ char, line }) => `${line}行目の「${char}」`)
          .join("、");
        const detail = [
          `ファイル：${name}`,
          `場所：${places}${count > PLACES_LIMIT ? ` ほか${count - PLACES_LIMIT}字` : ""}`,
          recoveryPath
            ? `元の字を含む本文は控えに残しました：${recoveryPath}`
            : "元の字を含む本文の控えを残せませんでした。「〓」の場所を確かめて、字を直してください。",
          // 変換しても、もう〓になった字は戻らない。変換のあとで直す字だと分かるように書く
          "［UTF-8 に変換する］を押すと、この話を UTF-8 にします。「〓」は変換しても元の字に戻らないので、変換したあとで直してください。",
        ].join("\n\n");
        const buttons = [
          ...(recorded ? [OPEN_PANEL] : []),
          ...(recoveryPath ? [OPEN_KEEP] : []),
          UTF8_CONVERT_BUTTON,
        ];
        const picked = await deps.warn(message, detail, buttons);
        if (picked === OPEN_PANEL && report.workFolder) deps.openPanel(report.workFolder);
        if (picked === OPEN_KEEP && recoveryPath) deps.openKeep(recoveryPath);
        if (picked === UTF8_CONVERT_BUTTON) deps.convert(report.filePath);
      })().catch((error: unknown) => {
        deps.log(report.workFolder, `「〓」にした字の知らせを出せませんでした（${name}）：${messageOf(error)}`);
      });
      return keeping.then(() => undefined);
    },
    forget(document) {
      warned.delete(document.uri.toString());
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 指摘の置き場のうち、ここで使う所（単体テストで差し替える） */
export interface MarkFindingStore {
  load(): Promise<FindingView[]>;
  record(findings: readonly Finding[]): Promise<void>;
  decide(decisions: readonly FindingDecision[]): Promise<void>;
}

/**
 * 〓の行を置き場へ足す。足した行の数を返す。
 *
 * **前に見送った同じ番号の行は、未決へ戻す。** 番号は場所の前後の字から決まるので、作者が
 * 〓を見送ったあとで同じ場所にまた書けない字を打つと、同じ番号になる。判断は後から来たものが
 * 勝つ作りなので、そのままでは新しく置いた〓の行が「見送り済み」として出てこない
 */
export async function recordMarkFindings(
  store: MarkFindingStore,
  findings: readonly Finding[],
  time: string
): Promise<number> {
  if (findings.length === 0) return 0;
  const decided = new Set(
    (await store.load()).filter((view) => view.status !== "pending").map((view) => view.id)
  );
  await store.record(findings);
  const reopen = findings.filter((finding) => decided.has(finding.id));
  if (reopen.length > 0) {
    await store.decide(
      reopen.map((finding) => ({
        findingId: finding.id,
        time,
        status: "pending" as const,
        note: "同じ場所の字を、保存のときにまた「〓」にした",
      }))
    );
  }
  return findings.length;
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

/** 作品一覧に登録したどの作品の中にも無い原稿（.txt・.md）か */
function isUnregisteredManuscript(registry: { list(): readonly WorkEntry[] }, filePath: string): boolean {
  if (!/.(txt|md)$/i.test(filePath)) return false;
  return !registry.list().some((entry) => path.isPathInside(entry.folderPath, filePath));
}

/** 作品の話の本文か（作品フォルダーの中の .txt/.md で、設定や控えの置き場でない） */
function workOfEpisode(registry: { list(): readonly WorkEntry[] }, filePath: string): WorkEntry | undefined {
  const work = [...registry.list()]
    .sort((a, b) => b.folderPath.length - a.folderPath.length)
    .find((entry) => path.isPathInside(entry.folderPath, filePath));
  if (!work) return undefined;
  return isEpisodeBodyRelPath(path.relative(work.folderPath, filePath)) ? work : undefined;
}

/** 拡張機能の起動時に差し込む */
export function installShiftJisSaveGuard(registry: { list(): readonly WorkEntry[] }): vscode.Disposable {
  const log = (workFolder: string | undefined, message: string): void => workLog(workFolder).line(message);
  const workAt = (workFolder: string | undefined): WorkEntry | undefined =>
    workFolder === undefined ? undefined : registry.list().find((entry) => path.pathKeyForComparison(entry.folderPath) === path.pathKeyForComparison(workFolder));
  const warner = createUnencodableWarner({
    keep: keepUnencodable,
    whenSaved: nextSaveOf,
    record: async (report, recoveryPath) => {
      const work = workAt(report.workFolder);
      if (!work) return false;
      const time = new Date().toISOString();
      const findings = buildSjisMarkFindings(
        work.folderPath,
        report.filePath,
        report.savedText,
        report.marks,
        recoveryPath,
        time
      );
      const count = await recordMarkFindings(new FindingStore(work), findings, time);
      // 本文の保存で開いているパネルは読み直したが、行を足したのはそのあとなので、もう一度読ませる
      if (count > 0) await refreshSceneMemoFindings(work.id);
      return count > 0;
    },
    warn: (message, detail, buttons) =>
      vscode.window.showWarningMessage(message, { modal: true, detail }, ...buttons),
    openKeep: (recoveryPath) => {
      void vscode.window.showTextDocument(path.toUri(recoveryPath), { preview: true });
    },
    openPanel: (workFolder) => {
      const work = workAt(workFolder);
      // 作品一覧の右クリックと同じ形で作品を渡す（どの作品かを訊き直させない）
      if (work) void vscode.commands.executeCommand("novelai.openSceneMemos", { type: "work", work });
    },
    convert: (filePath) => {
      // 窓の答えはもう受け取ったあと（保存の受け口の外）なので、命令の終わりは待たない
      void vscode.commands.executeCommand(CONVERT_TO_UTF8_COMMAND, utf8ConvertFileArg(filePath));
    },
    log,
  });
  /** 登録していない原稿ごとの、最後に知らせた置き換えの字の組 */
  const notifiedUnregistered = new Map<string, string>();
  const deps: ShiftJisSaveDeps = {
    workFolderOf: (filePath) => workOfEpisode(registry, filePath)?.folderPath,
    isUnregisteredManuscript: (filePath) => isUnregisteredManuscript(registry, filePath),
    readBytes: async (uri) => vscode.workspace.fs.readFile(uri),
    configuredEncoding: (uri) => vscode.workspace.getConfiguration("files", uri).get<string>("encoding"),
    log,
    notifyUnregistered: (document, signature, message) => {
      // 自動保存では打つたびに保存が鳴る。同じ文書・同じ字の組では1度だけ出す
      const key = document.uri.toString();
      if (notifiedUnregistered.get(key) === signature) return;
      notifiedUnregistered.set(key, signature);
      void vscode.window.showInformationMessage(message);
    },
    onUnencodable: (report) => warner.report(report),
    onClean: (document) => warner.forget(document),
  };
  return vscode.workspace.onWillSaveTextDocument((event) => handleWillSave(event, deps));
}
