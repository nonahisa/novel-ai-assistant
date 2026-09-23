import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { postingSiteInfo, type PostingLedger } from "../models/posting";
import { PostingStore } from "../core/postingStore";
import {
  parseReaderStatsEnvelope,
  type ReaderStatsEnvelope,
} from "../core/readerStatsEnvelope";
import {
  pickReaderStatsWork,
  readerStatsAlreadyImported,
  readerStatsClipboardFingerprint,
  readerStatsUriAction,
  rememberFingerprint,
  uriPathForLog,
  type ReaderStatsWorkCandidate,
} from "../core/readerStatsHelperLink";
import { isWebRuntime } from "../core/runtime";
import { logLine, useLogFile } from "../core/logger";
import { cancelItem, isCancelItem } from "../views/dialogs";
import { importReaderStats } from "./readerStats";

/**
 * ヘルパーから読者の反応を受け取る2つの入口（設計書6.79.7「ヘルパーからの受け口」）。
 *
 * 1. **URI**：ヘルパーが読者の反応をクリップボードへコピーしたあと
 *    `vscode://nonahisa.novel-ai-assistant/import-reader-stats` を開く。
 *    VS Code が前に出て、ここが取り込みを始める
 * 2. **VS Code に戻ったとき**：窓が前に出たとき、クリップボードに
 *    まだ取り込んでいない読者の反応があれば、取り込むかを1度だけ訊く
 *
 * **どちらも取り込みそのものは `importReaderStats` に任せる**（写しを
 * 作らない）。作品の照合・版の食い違いの断り・二重に積まない処理は、
 * 作者が「読者の反応を貼り付けて取り込む」を押したときと同じである。
 * ここが足すのは「どの作品へ入れるか」を決める段だけで、それも取り込みと
 * 同じ照合（`matchReaderStatsEnvelope`）で絞り、**決めきれなければ訊く。**
 *
 * ## クリップボードは作者の私物
 *
 * 窓が前に出るたびに読むので、**読者の反応のデータでないものは、中身も
 * 指紋も残さない**（記録にも書かない）。覚えるのは、読者の反応のデータと
 * 確かめたものの指紋だけである。
 */

/** 覚えた指紋の置き場（`context.globalState` の鍵） */
export const SEEN_FINGERPRINTS_KEY = "novelai.readerStats.seenClipboard";

/** 設定の名前（`novelai.` の下）。既定は入 */
export const IMPORT_ON_FOCUS_SETTING = "readerStats.importOnFocus";

/**
 * 窓が前に出てから、クリップボードを見るまでの間（ミリ秒）。
 *
 * **URI で呼ばれたときは、窓が前に出るのと URI が届くのがほぼ同時**である。
 * 先に訊いてしまうと、URI の取り込みと二重になる——少し待って、URI が
 * 先に同じデータを片づけていれば（指紋を覚えていれば）訊かない。
 */
export const FOCUS_CHECK_DELAY_MS = 1500;

/** 覚えた指紋の置き場（`vscode.Memento` のうち使う分だけ） */
export interface FingerprintMemory {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

export interface ReaderStatsHelperLinkDeps {
  /** 登録された作品 */
  listWorks(): readonly WorkEntry[];
  /** 覚えた指紋の置き場（`context.globalState`） */
  memory: FingerprintMemory;
  /** 取り込んだあと（執筆量パネルを作り直す） */
  afterImport(work: WorkEntry): Promise<void>;
}

/** URI の中身のうち、見るもの（パスだけ。クエリは読まない） */
export interface HelperUri {
  readonly path: string;
}

type Trigger = "uri" | "focus";

export class ReaderStatsHelperLink {
  /**
   * 取り込みの途中か。**窓が前に出るたびに走らせない**——訊いている間に
   * 窓を行き来すると、同じ問いが重なって出る。
   */
  private busy = false;

  constructor(private readonly deps: ReaderStatsHelperLinkDeps) {}

  /**
   * URI を受ける。**パスで合図を見分けるだけで、クエリは読まない。**
   * 知らないパスは何もせず、記録だけ残す。
   */
  async handleUri(uri: HelperUri): Promise<void> {
    if (readerStatsUriAction(uri.path) !== "import") {
      useLogFile(undefined);
      logLine(
        `知らない呼び出し（${uriPathForLog(uri.path)}）を受けました。何もしていません。`
      );
      return;
    }
    await this.run("uri");
  }

  /**
   * 窓が前に出たとき（設定が入のときだけ）。
   *
   * **読者の反応のデータで、まだ訊いていない・まだ取り込んでいないもの**
   * のときだけ訊く。それ以外は何も出さない（窓を行き来するたびに通知が
   * 出ると、作者の手が止まる）。
   */
  async checkOnFocus(): Promise<void> {
    if (!importOnFocusEnabled()) return;
    if (this.busy) return;
    await this.run("focus");
  }

  private async run(trigger: Trigger): Promise<void> {
    this.busy = true;
    try {
      await this.runUnguarded(trigger);
    } catch (error) {
      // **窓の出入りで落ちない。** 失敗は記録して、URI のときだけ知らせる
      const message = error instanceof Error ? error.message : String(error);
      useLogFile(undefined);
      logLine(`ヘルパーからの読者の反応の取り込みに失敗しました：${message}`);
      if (trigger === "uri") {
        void vscode.window.showErrorMessage(
          `読者の反応を取り込めませんでした：${message}`
        );
      }
    } finally {
      this.busy = false;
    }
  }

  private async runUnguarded(trigger: Trigger): Promise<void> {
    const text = await readClipboard(trigger);
    if (text === undefined) return;

    const parsed = parseReaderStatsEnvelope(text);
    if (!parsed.ok && parsed.kind === "notEnvelope") {
      // **読者の反応のデータでない。** 窓が前に出ただけなら黙る（中身は記録にも残さない）
      if (trigger === "uri") {
        void vscode.window.showInformationMessage(
          "クリップボードに読者の反応のデータがありませんでした。" +
            "管理画面で統合小説執筆環境ヘルパーの「読者の反応をコピー」を押してから、" +
            "もう一度お試しください。"
        );
      }
      return;
    }

    // ここから先は**読者の反応のデータ**（読めたかどうかは別）。指紋を覚えてよい
    const fingerprint = readerStatsClipboardFingerprint(text);
    if (trigger === "focus" && this.seen(fingerprint)) return;
    // **訊く前に覚える。** 問いが出ている間に窓を行き来しても、二度目は出さない
    await this.remember(fingerprint);

    if (!parsed.ok) {
      // 形が合わない（版の食い違いなど）。理由は取り込みと同じ文言で1度だけ言う
      void vscode.window.showWarningMessage(parsed.reason);
      return;
    }
    const envelope = parsed.envelope;
    const siteLabel = postingSiteInfo(envelope.site).label;
    useLogFile(undefined);
    logLine(
      `ヘルパーの読者の反応（${siteLabel}、${envelope.entries.length}件）を` +
        (trigger === "uri" ? "呼び出しで受けました。" : "クリップボードに見つけました。")
    );

    const works = this.deps.listWorks();
    if (works.length === 0) {
      if (trigger === "uri") {
        void vscode.window.showInformationMessage(
          "作品が登録されていないため、読者の反応を取り込めませんでした。"
        );
      }
      return;
    }
    const candidates = await loadCandidates(works);
    const pick = pickReaderStatsWork(envelope, candidates);

    if (pick.kind === "none") {
      if (trigger === "uri") {
        await explainNoWork(text, envelope, works, candidates);
      }
      return;
    }

    const pool = pick.kind === "one" ? [pick.id] : pick.ids;
    if (trigger === "focus") {
      // **もう取り込んであれば訊かない**（「貼り付けて取り込む」で入れたあと、など）
      const already = candidates.some(
        (candidate) =>
          pool.includes(candidate.id) &&
          readerStatsAlreadyImported(envelope, candidate.ledger)
      );
      if (already) return;
      const single =
        pick.kind === "one" ? works.find((work) => work.id === pick.id) : undefined;
      const answer = await vscode.window.showInformationMessage(
        `クリップボードに、統合小説執筆環境ヘルパーがコピーした${siteLabel}の読者の反応` +
          `（${envelope.entries.length}件）があります。` +
          (single ? `「${single.title}」に取り込みますか？` : "取り込みますか？"),
        "取り込む",
        "取り込まない"
      );
      if (answer !== "取り込む") return;
    }

    const work =
      pick.kind === "one"
        ? works.find((entry) => entry.id === pick.id)
        : await askWork(
            siteLabel,
            works.filter((entry) => pick.ids.includes(entry.id))
          );
    if (!work) return;

    const result = await importReaderStats(work, {
      clipboardText: text,
      // 選んでもらったときは画面に作品名が出ているが、決まったときは出ていない
      announceWork: pick.kind === "one",
    });
    if (result.changed) await this.deps.afterImport(work);
  }

  private seen(fingerprint: string): boolean {
    return this.deps.memory
      .get<string[]>(SEEN_FINGERPRINTS_KEY, [])
      .includes(fingerprint);
  }

  private async remember(fingerprint: string): Promise<void> {
    const remembered = this.deps.memory.get<string[]>(SEEN_FINGERPRINTS_KEY, []);
    await this.deps.memory.update(
      SEEN_FINGERPRINTS_KEY,
      rememberFingerprint(remembered, fingerprint)
    );
  }
}

/** 設定「VS Code に戻ったら読者の反応を取り込むか訊く」。既定は入 */
function importOnFocusEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("novelai")
    .get<boolean>(IMPORT_ON_FOCUS_SETTING, true);
}

/**
 * クリップボードを読む。**読めなければ、窓が前に出ただけのときは黙る**
 * （URI で呼ばれたときは、押したのに何も起きない、にしないよう言う）。
 */
async function readClipboard(trigger: Trigger): Promise<string | undefined> {
  try {
    return await vscode.env.clipboard.readText();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    useLogFile(undefined);
    logLine(`クリップボードを読めませんでした：${message}`);
    if (trigger === "uri") {
      void vscode.window.showWarningMessage(
        "クリップボードを読めなかったため、読者の反応を取り込めませんでした。"
      );
    }
    return undefined;
  }
}

/**
 * 各作品の投稿状態を読む。**読めない作品は候補から外す**——壊れた
 * 投稿状態を直さずに止めるのは、その作品を選んで取り込むとき
 * （`importReaderStats` が理由を出す）の役目である。
 */
async function loadCandidates(
  works: readonly WorkEntry[]
): Promise<ReaderStatsWorkCandidate[]> {
  const candidates: ReaderStatsWorkCandidate[] = [];
  for (const work of works) {
    let ledger: PostingLedger;
    try {
      ledger = await new PostingStore(work).load();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      useLogFile(work.folderPath);
      logLine(
        `読者の反応の取り込み先を探す途中で、${work.title} の投稿状態を読めませんでした：${message}`
      );
      continue;
    }
    candidates.push({ id: work.id, ledger });
  }
  return candidates;
}

/**
 * どの作品とも照合できなかったとき（URI のときだけ）。
 *
 * 作品が1つなら、**取り込みの断りと同じ理由**をそのまま出す（なぜ入らない
 * のかが一番はっきりする）。2つ以上なら、どの作品の理由を出すべきか
 * 決められないので、確かめる場所を言う。
 */
async function explainNoWork(
  text: string,
  envelope: ReaderStatsEnvelope,
  works: readonly WorkEntry[],
  candidates: readonly ReaderStatsWorkCandidate[]
): Promise<void> {
  if (works.length === 1 && candidates.length === 1) {
    // 取り込みの関所へ通す——同じ理由の文言が出る（写しを作らない）。
    // 照合で断られるので、台帳は変わらない
    await importReaderStats(works[0], { clipboardText: text, announceWork: true });
    return;
  }
  const siteLabel = postingSiteInfo(envelope.site).label;
  void vscode.window.showWarningMessage(
    `${siteLabel}の読者の反応を取り込める作品が見つかりませんでした。` +
      `取り込みたい作品の「投稿サイトの設定」で、${siteLabel}と作品IDが` +
      "登録されているかご確認ください。"
  );
}

/**
 * 候補が複数あるとき、どの作品へ入れるかを訊く。**推し量って決めない**
 * ——別の作品へ数字が混ざると、あとから分けられない。
 */
async function askWork(
  siteLabel: string,
  works: readonly WorkEntry[]
): Promise<WorkEntry | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      ...works.map((work) => ({
        label: work.title,
        description: work.folderPath,
        work,
      })),
      cancelItem("取り込まずに終わる"),
    ],
    {
      title: "読者の反応を取り込む作品（一覧から選びます）",
      placeHolder: `${siteLabel}の読者の反応を、どの作品へ取り込みますか`,
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked) || !("work" in picked)) return undefined;
  return picked.work;
}

/**
 * 受け口を VS Code へつなぐ（`extension.ts` の起動時に1回）。
 *
 * ## ブラウザ版（vscode.dev）では
 *
 * - **URI の受け口**：つなぐだけはつなぐ。ヘルパーが開く `vscode://` は
 *   手元の VS Code を起こすもので、ブラウザ版へは届かない（届かないだけで
 *   壊れはしない）。つなげなかったときは記録して先へ進む
 * - **戻ったときの自動取り込み**：**働かせない。** ブラウザはページが
 *   クリップボードを読むたびに許可を求めるので、窓へ戻るたびに許可の
 *   問いが出てしまう（設計書5.8）
 */
export function registerReaderStatsHelperLink(
  link: ReaderStatsHelperLink
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];
  try {
    disposables.push(
      vscode.window.registerUriHandler({
        handleUri: (uri) => void link.handleUri(uri),
      })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    useLogFile(undefined);
    logLine(`ヘルパーからの呼び出しの受け口をつなげませんでした：${message}`);
  }

  if (isWebRuntime()) return disposables;

  let timer: ReturnType<typeof setTimeout> | undefined;
  disposables.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void link.checkOnFocus();
      }, FOCUS_CHECK_DELAY_MS);
    }),
    {
      dispose: () => {
        if (timer !== undefined) clearTimeout(timer);
      },
    }
  );
  return disposables;
}
