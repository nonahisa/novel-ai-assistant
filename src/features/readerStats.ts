import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import {
  knownPostingSites,
  latestReaderStats,
  parseReaderStatsEpisode,
  parseReaderStatsValue,
  postingSiteInfo,
  readerStatsMetricsFor,
  siteProfile,
  validateReaderStatsEpisode,
  validateReaderStatsValue,
  validateReaderStatsPeriodKey,
  withReaderStats,
  type PostingLedger,
  type PostingSiteId,
  type ReaderStatsMetrics,
  type ReaderStatsPeriod,
  type ReaderStatsScope,
} from "../models/posting";
import { PostingStore, PostingStoreError } from "../core/postingStore";
import {
  applyReaderStatsEnvelope,
  matchReaderStatsEnvelope,
  parseReaderStatsPaste,
  readerStatsSourceLabel,
  type ReaderStatsApplied,
  type ReaderStatsBundle,
  type ReaderStatsEnvelope,
} from "../core/readerStatsEnvelope";
import {
  readerStatsBundleItemLabel,
  readerStatsBundleNotice,
  routeReaderStatsBundleItem,
  type ReaderStatsBundleFailure,
  type ReaderStatsBundleWorkOutcome,
} from "../core/readerStatsHelperLink";
// 管理画面のURLを組むのは core（画面を出さずに確かめられるようにする）
import { readerStatsPageUrl } from "../core/postingSiteUrls";
import { HELPER_DOWNLOAD_URL } from "../core/postingEnvelope";
import { formatReaderStatsMetrics } from "../core/postingSiteRecords";
import { askText, cancelItem, isCancelItem } from "../views/dialogs";
import { logFailure, logStep, useLogFile } from "../core/logger";
import { whenNoticePicked } from "../views/notify";
import { configurePostingSites } from "./postingKit";

/**
 * 読者の反応を台帳へ入れる2つの入口（設計書6.79.7）。
 *
 * ## サイトへは触りにいかない
 *
 * 投稿キット（6.68.1）と同じ線の内側にある。ここが読むのは
 * **クリップボード**と**作者が打った数字**だけで、アクセス解析のページを
 * 機械で開くことも、HTTPを発することもしない。
 *
 * 貼り込み係（ブラウザ拡張）が読むのは、**作者が自分で開いた自分の管理画面**を
 * ボタン1回ぶんだけである（6.79.7の1と2）。母艦はその結果を封筒として受ける。
 *
 * ## 手入力の口を必ず残す
 *
 * なろう・pixiv・ハーメルン・noteは規約の判断から**読み取りに対応しない**
 * （なろうの数は、作者が開いた分析サイト Narou.fun の頁からなら封筒で受ける。
 * 断っているのは、なろう本体を機械で読むことである。残課題 B11）。
 * 手入力があれば、対応しないサイトでも記録は残せる——「対応していないから
 * 何もできない」を作らないための口である。
 *
 * ## 台帳は追記だけ
 *
 * 書き込むのは `設定/投稿状態.json` の `readerStats` だけで、原稿にも
 * 設定資料にも触らない。畳まない（同じ日に2回読めば2件）。
 */

export interface ReaderStatsResult {
  /** 台帳を書き換えたか。呼ぶ側が執筆量パネルを作り直すのに使う */
  changed: boolean;
  /**
   * 書き換えた作品（まとめて渡された分を取り込んだときだけ入る）。
   * 選んだ作品とは限らない——振り分けた先の執筆量パネルを作り直すのに使う
   */
  changedWorks?: readonly WorkEntry[];
}

const UNCHANGED: ReaderStatsResult = { changed: false };

/** 取り込みの呼び方の違い（設計書6.79.7。ヘルパーから呼ばれたとき） */
export interface ImportReaderStatsOptions {
  /**
   * **確かめ済みのクリップボードの中身。** 渡されたらクリップボードを
   * 読み直さない——ヘルパーからの呼び出し（`readerStatsHelperLink.ts`）は、
   * 作品を選んでもらう前に中身を確かめている。選んでいる間に作者が別の
   * ものをコピーしても、**訊いたときのデータ**を取り込む。
   */
  clipboardText?: string;
  /**
   * 知らせに作品名を添える。**作者が作品を選ばずに走ったとき**（ヘルパー
   * から呼ばれて作品が1つに決まったとき）は、どの作品へ入ったかが画面の
   * どこにも出ていない。
   */
  announceWork?: boolean;
  /**
   * 登録した作品ぜんぶ。**まとめて渡された読者の反応**（ヘルパー 0.9.0）を
   * 貼り付けたとき、作品ごとに振り分ける先になる。渡さなければ選んだ作品だけ。
   */
  works?: readonly WorkEntry[];
}

/**
 * クリップボードの封筒から取り込む（設計書6.79.7）。
 *
 * **読めなければ、何も書かずに理由を言う。** 押したのに何も起きない、を
 * 作らない——とくに「このサイトは読み取りに対応していない」は仕様であって
 * 故障ではないので、そう言わないと伝わらない。
 */
export async function importReaderStats(
  work: WorkEntry,
  options: ImportReaderStatsOptions = {}
): Promise<ReaderStatsResult> {
  const store = new PostingStore(work);
  let ledger = await load(store, work);
  if (!ledger) return UNCHANGED;
  const say = (message: string): string =>
    options.announceWork ? `「${work.title}」：${message}` : message;

  let parsed = parseReaderStatsPaste(
    options.clipboardText ?? (await vscode.env.clipboard.readText())
  );

  /*
    **封筒が入っていないときだけ、管理画面への道を出す**（作者の要望、
    2026-09-22。「該当ページのリンクを開かせるってできないんでしょうか？」）。

    ほかの断り方（版違い・読み取りに対応しないサイト）は、管理画面を開いても
    直らない——そこでボタンを出すと、押した先で手詰まりになる。

    **封筒が入っていれば2択は出さない。** もうコピーしてある作者に、
    ここで1手増やす理由が無い。
  */
  const page = parsed.ok ? undefined : adminPage(ledger);
  if (!parsed.ok && parsed.kind === "notEnvelope" && page) {
    const answer = await askAdminPage(work, page);
    if (answer === "cancel") return UNCHANGED;
    if (answer === "open") {
      await openAdminPage(page);
      return UNCHANGED;
    }
    if (answer === "helper") {
      await openHelperDownload();
      return UNCHANGED;
    }
    // **もう一度クリップボードを読む。** 2択を出している間に貼り込み係で
    // コピーしてきていることがある（そのときに読み直さないと、押しても
    // 何も起きないのと同じになる）
    parsed = parseReaderStatsPaste(await vscode.env.clipboard.readText());
    /*
      **台帳も読み直す**（0.81.4。実機、教科書チート_確認用 2026-09-22）。
      2択は焦点が外れても閉じないので、作者がブラウザでヘルパーを押している
      間に、ヘルパーの合図（URI）や VS Code へ戻ったときの取り込みが**先に
      同じ台帳へ書く**。2択の前に読んだ台帳のまま積むと、保存の照合で
      「外部で変更」と止まっていた（守りは正しいが、作者には理由が見えない）。
      読み直せば、先に取り込まれた分は「すでに取り込んだ数と同じ」になる
    */
    const reloaded = await load(store, work);
    if (!reloaded) return UNCHANGED;
    ledger = reloaded;
  }

  if (!parsed.ok) {
    // 封筒が無いままなら、断りの文言に管理画面とヘルパーの入手先への道を添える。
    // **入手先は管理画面を組めないときも出す**——ヘルパーが無ければ、
    // 案内の「読者の反応をコピー」を押す場所がそもそも無い。
    // 版違いなどほかの断りには出さない（入れても直らない）
    if (parsed.kind === "notEnvelope") {
      const buttons = page
        ? [openAdminLabel(page), HELPER_INSTALL_LABEL]
        : [HELPER_INSTALL_LABEL];
      /*
        **ボタンが押されるのを待たずに戻る**（残課題9。`views/notify.ts` の
        `whenNoticePicked`）。ボタン付きの知らせは、閉じられるまで返事が来ない
        ——通知センターへ沈んだだけでは来ない。待ったままだと「読者の反応を
        取り込む」が動いたままになり、押し直すと「いま動いています」の知らせが
        もう1つ出て、この断りを上へ押しやる（2026-09-23 ノートPCの (d)）
      */
      whenNoticePicked(
        vscode.window.showWarningMessage(parsed.reason, ...buttons),
        async (answer) => {
          if (answer === HELPER_INSTALL_LABEL) await openHelperDownload();
          else if (answer && page) await openAdminPage(page);
        },
        { label: "読者の反応の取り込み", workFolder: work.folderPath }
      );
    } else {
      void vscode.window.showWarningMessage(parsed.reason);
    }
    return UNCHANGED;
  }

  /*
    **まとめて渡された分（ヘルパー 0.9.0 の「まとめて渡す」）なら、作品ごとに振り分ける。**
    選んだ作品だけに入れると、ほかの作品の画面は取り込めないまま捨てられる
    ——作者は1回貼り付ければ済むと思っている。振り分けの先は登録した作品ぜんぶ
    （呼ぶ側が渡さなければ、選んだ作品だけ）。
  */
  if (parsed.kind === "bundle") {
    const works = options.works ?? [work];
    return importReaderStatsBundle(
      parsed.bundle,
      works.some((entry) => entry.id === work.id) ? works : [work, ...works]
    );
  }

  // **取り違えを止めるのが、書き込む前の最後の関所**（6.79.7の4）。
  // 別の作品の管理画面を開いたまま押すことは現実に起きる
  const mismatch = matchReaderStatsEnvelope(parsed.envelope, ledger);
  if (mismatch) {
    void vscode.window.showWarningMessage(say(mismatch));
    return UNCHANGED;
  }

  const info = postingSiteInfo(parsed.envelope.site);
  const sourceLabel = readerStatsSourceLabel(parsed.envelope.source);
  /*
    **同じ数の繰り返しは積まない**（残課題 B11 の続き、作者の裁定「同じ表を2度
    取り込んでも二重に積まない」）。Narou.fun の日ごとの表もカクヨムの日ごとの
    PV も直近30日なので、毎日取り込むと29日ぶんが前の回と重なる（見分けは
    サイトで分けず `repeatsReaderStats` の1か所）。どれを積まなかったかは件数で
    言う（黙って減らさない）。

    積み方は core の `applyReaderStatsEnvelope` の1か所——まとめて渡された分
    （`importReaderStatsBundle`）も同じところを通る。記録の組み方（メモの書き方を
    含む）も core が持つ。自動取り込みの「もう取り込んだか」の見分けと同じ記録を見るため。
  */
  let applied: ReaderStatsApplied;
  try {
    applied = applyReaderStatsEnvelope(ledger, parsed.envelope);
  } catch (error) {
    // 封筒の検証を通っていれば来ないが、黙って落とさない
    await report("読者の反応の取り込み", work, error);
    return UNCHANGED;
  }
  const { ledger: next, added, repeated } = applied;

  if (added === 0) {
    // 何も書かない（保存もしない）。押したのに何も起きない、にならないよう理由を言う
    announceResult(
      work,
      say(
        `${info.label} の読者の反応は、すでに取り込んだ数と同じでした（${repeated}件）。` +
          "投稿の記録は変えていません。"
      )
    );
    return UNCHANGED;
  }

  if (!(await save(store, work, next, "読者の反応の取り込み"))) return UNCHANGED;

  announceResult(
    work,
    say(
      `${info.label} の読者の反応を ${added}件 取り込みました` +
        (sourceLabel ? `（${sourceLabel}から）` : "") +
        (repeated > 0
          ? `（${repeated}件は、取り込み済みの数と同じだったので積んでいません）`
          : "") +
        "。執筆量パネルの「サイトの記録」で履歴を見られます。"
    )
  );
  return { changed: true };
}

/**
 * まとめて渡された読者の反応（束）を、作品ごとに振り分けて取り込む
 * （作者の依頼 2026-09-23。ヘルパー 0.9.0 の「まとめて渡す」）。
 *
 * ## 1件のときと同じ道を通す
 *
 * 1件ずつ、1件の封筒と同じ関所（`matchReaderStatsEnvelope`。Narou.fun の
 * Nコードの照合を含む）で行き先を決め、同じ積み方（`applyReaderStatsEnvelope`。
 * 二重に積まない）で積む。足したのは**振り分け**と**知らせのまとめ方**だけである。
 *
 * ## 作品が決まらない画面は訊かずに外す
 *
 * 台帳の作品IDで1つに決まる画面だけを取り込む（`routeReaderStatsBundleItem`）。
 * 決まらない画面は「取り込めなかったもの」に理由を添えて残し、**残りは止めない**。
 * 画面ごとに作品を選ばせると、まとめて渡した意味が無くなる。
 *
 * ## 作品ごとに1回だけ書く
 *
 * 同じ作品の画面は**溜めた順に同じ台帳へ**積み、最後に1回保存する。作品管理と
 * アクセス数のように話ごと・日ごとの数が重なる2画面も、あとの画面の重なった行は
 * 前の画面の行を見て止まる（1件ずつ順に取り込んだのと同じ結果）。1つの作品の
 * 保存に失敗しても、ほかの作品の取り込みは止めない。
 */
export async function importReaderStatsBundle(
  bundle: ReaderStatsBundle,
  works: readonly WorkEntry[]
): Promise<ReaderStatsResult> {
  // 各作品の投稿状態を読む。**読めない作品は振り分けの先から外す**（直さずに止める）
  const loaded: { work: WorkEntry; store: PostingStore; ledger: PostingLedger }[] = [];
  const unreadable: WorkEntry[] = [];
  for (const work of works) {
    const store = new PostingStore(work);
    try {
      loaded.push({ work, store, ledger: await store.load() });
    } catch (error) {
      unreadable.push(work);
      logBundleFailure(`${work.title} の投稿状態を読めませんでした`, error, work);
    }
  }
  const candidates = loaded.map((entry) => ({ id: entry.work.id, ledger: entry.ledger }));

  const failures: ReaderStatsBundleFailure[] = [];
  // 作品ごとの画面。**束に最初に出てきた順**（Map は入れた順を保つ）で、中は溜めた順
  const groups = new Map<string, ReaderStatsEnvelope[]>();
  for (const item of bundle.items) {
    if (!item.result.ok) {
      failures.push({
        label: `${item.position}件目`,
        reason: item.result.reason,
        fixByWorkId: false,
      });
      continue;
    }
    const envelope = item.result.envelope;
    const route = routeReaderStatsBundleItem(envelope, candidates);
    if (route.kind === "none") {
      failures.push({
        label: readerStatsBundleItemLabel(envelope),
        reason: route.reason,
        fixByWorkId: true,
      });
      continue;
    }
    groups.set(route.id, [...(groups.get(route.id) ?? []), envelope]);
  }
  /*
    投稿状態を読めなかった作品は、振り分けの先に入っていない。その作品の画面は
    「作品が見つかりません」で落ちているかもしれないので、**そちらの失敗があるとき
    だけ**読めなかった作品の名前も並べる（関係の無いときは知らせを長くしない）。
  */
  if (unreadable.length > 0 && failures.some((failure) => failure.fixByWorkId)) {
    for (const work of unreadable) {
      failures.push({
        label: `「${work.title}」`,
        reason: "投稿状態を読めなかったため、取り込み先に入れられませんでした（出力パネルに記録しました）。",
        fixByWorkId: false,
      });
    }
  }

  const outcomes: ReaderStatsBundleWorkOutcome[] = [];
  const changedWorks: WorkEntry[] = [];
  for (const [id, envelopes] of groups) {
    const entry = loaded.find((candidate) => candidate.work.id === id);
    if (!entry) continue; // 振り分けの先は読めた作品からしか選ばないので来ない
    let ledger = entry.ledger;
    let added = 0;
    let repeated = 0;
    let screens = 0;
    for (const envelope of envelopes) {
      try {
        const applied = applyReaderStatsEnvelope(ledger, envelope);
        ledger = applied.ledger;
        added += applied.added;
        repeated += applied.repeated;
        screens++;
      } catch (error) {
        // 封筒の検証を通っていれば来ないが、1画面の失敗で残りを止めない
        logBundleFailure(`${entry.work.title} への取り込み`, error, entry.work);
        failures.push({
          label: readerStatsBundleItemLabel(envelope),
          reason: `記録にできませんでした（${errorMessage(error)}）。`,
          fixByWorkId: false,
        });
      }
    }
    if (screens === 0) continue;
    if (added > 0) {
      try {
        await entry.store.save(ledger);
      } catch (error) {
        logBundleFailure(`${entry.work.title} の投稿状態の保存`, error, entry.work);
        failures.push({
          label: `「${entry.work.title}」の${screens}画面`,
          reason: `保存できませんでした（${errorMessage(error)}）。`,
          fixByWorkId: false,
        });
        continue;
      }
      changedWorks.push(entry.work);
    }
    outcomes.push({ title: entry.work.title, screens, added, repeated });
  }

  // 取り込めなかったものは**全部を記録に残す**（知らせには先頭の数件しか並べない）
  if (failures.length > 0) {
    useLogFile(undefined);
    logFailure("まとめて渡された読者の反応のうち、取り込めなかったもの", {
      件数: failures.length,
      内訳: failures.map((failure) => `${failure.label}：${failure.reason}`).join("\n"),
    });
  }

  const notice = readerStatsBundleNotice({ works: outcomes, failures });
  // 知らせが画面から外れても読み返せるよう、同じ文を操作ログにも残す
  // （`announceResult` と同じ理由。束は作品をまたぐので、書き先は保管庫）
  useLogFile(undefined);
  logStep(notice.message);
  if (notice.level === "warning") {
    void vscode.window.showWarningMessage(notice.message);
  } else {
    void vscode.window.showInformationMessage(notice.message);
  }
  return { changed: changedWorks.length > 0, changedWorks };
}

/**
 * 取り込みの結果を知らせる。**同じ文を操作ログにも残す**（残課題9）。
 *
 * 右下の知らせ（トースト）は、ボタンが付いていても時間がたつと通知
 * センターへ沈み、あとから来た知らせに押されて画面を外れる。拡張機能の
 * 側から「消えない知らせ」は作れない（モーダルにすると、毎日の取り込みの
 * たびに手が止まる）。**何件取り込んだかは、あとで確かめたくなる数字**
 * なので、画面から外れても操作ログで読み返せるようにしておく。
 *
 * 知らせそのものは1つだけ出す——取り込みの道で続けて知らせを重ねない。
 */
function announceResult(work: WorkEntry, message: string): void {
  // **記録の直前に書き先を向ける**（0.43.3 と同じ）
  useLogFile(work.folderPath);
  logStep(message);
  void vscode.window.showInformationMessage(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 束の取り込みの失敗を記録する（知らせは最後に1つにまとめるので、ここでは出さない） */
function logBundleFailure(what: string, error: unknown, work: WorkEntry): void {
  // **記録の直前に書き先を向ける**（0.43.3 と同じ）
  useLogFile(work.folderPath);
  logFailure(what, {
    作品: work.title,
    種類: error instanceof PostingStoreError ? error.kind : "unknown",
    内容: errorMessage(error),
  });
}

/** 開ける管理画面。**どのサイトのものかを一緒に持つ**（文言に出すため） */
interface AdminPage {
  label: string;
  url: string;
}

/**
 * 台帳から、開ける管理画面を1つ選ぶ（設計書6.79.7）。
 *
 * 見るのは**登録した投稿先だけではない**（`knownPostingSites`）。ZIPから
 * 取り込んだ作品は `siteProfiles` にしか印が無い。
 *
 * **組めるサイトが無ければ undefined。** そのときはボタンを出さない——
 * 押した先が存在しないページになるくらいなら、ボタンが無いほうがよい。
 */
function adminPage(ledger: PostingLedger): AdminPage | undefined {
  for (const site of knownPostingSites(ledger)) {
    const url = readerStatsPageUrl(
      site,
      siteProfile(ledger, site),
      ledger.sites.find((entry) => entry.site === site)?.newEpisodeUrl
    );
    if (url) return { label: postingSiteInfo(site).label, url };
  }
  return undefined;
}

/**
 * 管理画面を開くボタンの文言。
 *
 * **「Chrome」と書かない。** 開くのは `openExternal`＝**作者の既定の
 * ブラウザ**であって、こちらがブラウザを選ぶわけではない（決め打ちで
 * サービス名を書かない、という線は実装ルール5と同じ）。
 */
function openAdminLabel(page: AdminPage): string {
  return `${page.label}の管理画面をブラウザで開く`;
}

/**
 * 「管理画面を開く」か「クリップボードから取り込む」かを訊く。
 * ヘルパーをまだ入れていない作者のために、入手先を開く道も並べる（0.76.7）。
 *
 * **封筒が入っていなかったときだけ出る。** 入っていれば黙って取り込む
 * （もうコピーしてある作者に、1手増やす理由が無い）。
 */
async function askAdminPage(
  work: WorkEntry,
  page: AdminPage
): Promise<"open" | "clipboard" | "helper" | "cancel"> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: `$(link-external) ${openAdminLabel(page)}`,
        detail:
          "統合小説執筆環境ヘルパーの「読者の反応をコピー」を押してから、もう一度ここへ戻ってください",
        open: true,
      },
      {
        label: "$(clippy) クリップボードから取り込む",
        detail: "もうコピーしてある場合はこちら",
        open: false,
      },
      {
        label: `$(cloud-download) ${HELPER_INSTALL_LABEL}`,
        detail: "まだ入れていない場合はこちら。入手先（GitHub）をブラウザで開きます",
        helper: true,
      },
      // 出口を目に見える形で置く（`views/dialogs.ts`。Esc を知らない作者にも）
      cancelItem("取り込まずに終わる"),
    ],
    {
      // **一覧から選ぶ画面だと、題にも書く**（placeHolder は打つと消える）
      title: `${work.title} の読者の反応（一覧から選びます）`,
      placeHolder:
        "クリップボードに、ヘルパーでコピーした読者の反応が入っていません。どうしますか",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked)) return "cancel";
  if ("helper" in picked) return "helper";
  if (!("open" in picked)) return "cancel";
  return picked.open ? "open" : "clipboard";
}

/**
 * 管理画面を開く。**開くだけで、読みにはいかない**（6.68.1の線の内側）。
 *
 * 数字を拾うのは貼り込み係（ブラウザ拡張）であり、母艦はその結果を封筒で
 * 受けるだけである。ここからHTTPは発しない。
 */
async function openAdminPage(page: AdminPage): Promise<void> {
  // `Uri.parse` を使う——`paths.toUri()` は手元のファイル用で、
  // ここで開くのは http(s) のURLである（実装ルール7の対象外）
  await vscode.env.openExternal(vscode.Uri.parse(page.url));
}

/**
 * ヘルパーを入れる道の文言（0.76.7。作者の依頼、2026-09-23）。
 * 2択の画面と断りの知らせで同じ言葉を使う（押した答えをこの文字列で見分ける）
 */
const HELPER_INSTALL_LABEL = "ヘルパーを入れる";

/**
 * ヘルパーの入手先を開く。**開くだけ**で、入れるのは作者がブラウザで行う。
 * URL は `core/postingEnvelope.ts` の1か所が持つ。
 */
async function openHelperDownload(): Promise<void> {
  // http(s) のURLなので `Uri.parse`（`openAdminPage` と同じ。実装ルール7の対象外）
  await vscode.env.openExternal(vscode.Uri.parse(HELPER_DOWNLOAD_URL));
}

/**
 * 手で入力して記録する（設計書6.79.7）。
 *
 * 訊く順は「サイト → 範囲 → 粒度 → 数値」。**空欄は飛ばせる**——サイトに
 * よって読める数字が違い、全部を埋めさせると使えない画面になる。
 * 読み取った日時は打ち込んだ時刻を入れる（サイトが集計した時刻ではない）。
 */
export async function recordReaderStats(
  work: WorkEntry
): Promise<ReaderStatsResult> {
  const store = new PostingStore(work);
  const ledger = await load(store, work);
  if (!ledger) return UNCHANGED;

  /*
    **どのサイトに載っているかが1つも分からなければ、そこへ誘導する**
    （「ランキングを記録」と同じ入口の作り）。どのサイトの数字かを
    訊いても答えようがないので、選択画面すら出さない。

    見るのは投稿先の登録だけではない（0.69.9。`knownPostingSites`）。
    ZIPから取り込んだ作品は `siteProfiles` にしか印が無く、ここで
    断っていると**取り込んだ直後は手入力すらできなかった。**
  */
  const sites = knownPostingSites(ledger);
  if (sites.length === 0) {
    const answer = await vscode.window.showWarningMessage(
      `${work.title} には投稿サイトが登録されていません。` +
        "「投稿サイト設定」でサイトを登録すると、そのサイトの反応を記録できます。",
      "投稿サイト設定"
    );
    if (answer === "投稿サイト設定") {
      const result = await configurePostingSites(work);
      return { changed: result.changed };
    }
    return UNCHANGED;
  }

  const site = await askSite(work, ledger, sites);
  if (!site) return UNCHANGED;
  const info = postingSiteInfo(site);

  const scope = await askScope(info.label);
  if (!scope) return UNCHANGED;

  let episode: number | undefined;
  if (scope === "episode") {
    const text = await askText({
      title: `${info.label} の何話の数字ですか`,
      prompt: "話番号を数字で入れてください（第3話なら 3）",
      placeHolder: "3",
      ignoreFocusOut: true,
      // **話番号は数値とは別の読み方をする**（0.33.9）。数値は「1,234」と
      // 打たれるので区切りを落とすが、話番号でそれをすると「1,2」が12話になる
      validateInput: (value) => validateReaderStatsEpisode(value) ?? undefined,
    });
    if (text === undefined) return UNCHANGED;
    const parsed = parseReaderStatsEpisode(text);
    // 入力欄で断っているので、ここへ来るのは画面の作りが変わったときだけ
    if (parsed === null) return UNCHANGED;
    episode = parsed;
  }

  const period = await askPeriod(info.label);
  if (period === undefined) return UNCHANGED;

  let periodKey: string | undefined;
  if (period !== null) {
    const text = await askText({
      title: `${info.label} の${PERIOD_LABELS[period]}の期間`,
      prompt: `どの${PERIOD_LABELS[period]}の数字ですか`,
      // 今日の値を入れておく。ふつうは「いま見ている期間」を打つ
      value: todayPeriodKey(period),
      ignoreFocusOut: true,
      validateInput: (value) =>
        validateReaderStatsPeriodKey(period, value) ?? undefined,
    });
    if (text === undefined) return UNCHANGED;
    periodKey = text.trim();
  }

  // **数値の段のEscは「入力おわり」**（0.33.9）。取りやめの出口は、
  // ここより前の3つの選択画面にある（`askSite`・`askScope`・`askPeriod`）
  const metrics = await askMetrics(site);

  if (Object.keys(metrics).length === 0) {
    void vscode.window.showInformationMessage(
      "数値が1つも入らなかったので、記録しませんでした。" +
        "読めた数字だけで構いませんので、いずれかにご記入ください。"
    );
    return UNCHANGED;
  }

  const next = withReaderStats(ledger, {
    site,
    readAt: new Date().toISOString(),
    scope,
    ...(episode === undefined ? {} : { episode }),
    ...(period === null ? {} : { period, periodKey }),
    metrics,
    source: "manual",
  });
  if (!(await save(store, work, next, "読者の反応の手入力"))) return UNCHANGED;

  void vscode.window.showInformationMessage(
    `${info.label} の読者の反応を記録しました（${formatReaderStatsMetrics(metrics)}）。` +
      "執筆量パネルの「サイトの記録」で履歴を見られます。"
  );
  return { changed: true };
}

/** どのサイトの数字か。**載っていると分かっているサイトの中から選ぶ** */
async function askSite(
  work: WorkEntry,
  ledger: PostingLedger,
  sites: readonly PostingSiteId[]
): Promise<PostingSiteId | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      ...sites.map((site) => {
        const info = postingSiteInfo(site);
        const latest = latestReaderStats(ledger, site);
        return {
          label: info.label,
          // 前回の値を添える。「前より増えたか」がこの操作の関心である
          description: latest
            ? `前回 ${formatReaderStatsMetrics(latest.metrics)}`
            : "記録はまだありません",
          site,
        };
      }),
      cancelItem(),
    ],
    {
      title: `${work.title} の読者の反応を記録`,
      placeHolder: "どのサイトの数字ですか",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked) || !("site" in picked)) return undefined;
  return picked.site;
}

/** 作品全体の数字か、1話ぶんか */
async function askScope(
  siteLabel: string
): Promise<ReaderStatsScope | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: "作品全体",
        detail: "作品のページや解析画面に出ている、作品ぜんぶの数字",
        scope: "work" as const,
      },
      {
        label: "話を指定する",
        detail: "1話ぶんの数字（話ごとの解析画面）",
        scope: "episode" as const,
      },
      cancelItem(),
    ],
    {
      title: `${siteLabel} のどの範囲の数字ですか`,
      placeHolder: "作品全体か、1話ぶんか",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked) || !("scope" in picked)) return undefined;
  return picked.scope;
}

/** 粒度の呼び名（画面と入力欄で同じ言葉を使う） */
const PERIOD_LABELS: Record<Exclude<ReaderStatsPeriod, "total">, string> = {
  day: "日",
  month: "月",
  year: "年",
};

/**
 * 解析の粒度を訊く。
 *
 * `null` は「その時点の値」（粒度を持たない）。**`undefined` は取りやめ**で、
 * 2つを同じ値で表すと、取りやめが「時点の値」として記録されてしまう。
 */
async function askPeriod(
  siteLabel: string
): Promise<Exclude<ReaderStatsPeriod, "total"> | null | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: "その時点の値",
        detail: "画面に出ている数字をそのまま（累計のPVやブックマークなど）",
        period: null,
      },
      { label: "日別", detail: "その日ぶんの数字", period: "day" as const },
      { label: "月別", detail: "その月ぶんの数字", period: "month" as const },
      { label: "年別", detail: "その年ぶんの数字", period: "year" as const },
      cancelItem(),
    ],
    {
      title: `${siteLabel} の数字の粒度`,
      placeHolder: "いつぶんの数字ですか",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked) || !("period" in picked)) return undefined;
  return picked.period;
}

/**
 * 数値を順に訊く。**空欄は飛ばせる。**
 *
 * **訊く順と項目は `readerStatsMetricsFor(site)` が決める**（0.69.9）。
 * 共通の7つのあとに、そのサイト固有の指標が続く——なろうなら評価者数・
 * 評価ポイント・評価平均である。**サイトごとの表はここに写さない**
 * （写しを作ると、片方だけ増えて欄が消える）。
 *
 * **Escは「入力おわり」として扱う**（0.33.9のレビュー）。何問もあって読めるのは
 * 2つか3つ、というのが普通なので、残りをEscで抜けるのは自然な操作である。
 * ここで捨てると、**打った値が黙って消える**——取りやめの出口は、この前の
 * 3つの選択画面（サイト・範囲・粒度）の「取りやめる」にある。順位のメモの
 * Escを「メモ無し」として扱うのと同じ判断である。
 *
 * @returns 入れてもらった数値。1つも入らなければ空（呼ぶ側が知らせる）
 */
async function askMetrics(site: PostingSiteId): Promise<ReaderStatsMetrics> {
  const siteLabel = postingSiteInfo(site).label;
  const metrics: ReaderStatsMetrics = {};
  for (const info of readerStatsMetricsFor(site)) {
    const text = await askText({
      title: `${siteLabel} の${info.label}`,
      prompt:
        `${info.label}の数を入れてください` +
        "（そのサイトに無い項目や、読めなかった項目は空のままで構いません。" +
        "Escを押すと、ここまでの値で記録します）",
      placeHolder: info.example,
      ignoreFocusOut: true,
      validateInput: (value) =>
        validateReaderStatsValue(value, info) ?? undefined,
    });
    if (text === undefined) break;
    const value = parseReaderStatsValue(text, info);
    // 空欄は「読めなかった」。0で埋めると、次に読んだとき減ったように見える
    if (value !== null) metrics[info.key] = value;
  }
  return metrics;
}

/** 今日の期間（入力欄の初期値）。**手元の時計の日付で作る** */
function todayPeriodKey(
  period: Exclude<ReaderStatsPeriod, "total">
): string {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  if (period === "year") return year;
  if (period === "month") return `${year}-${month}`;
  return `${year}-${month}-${day}`;
}

async function load(
  store: PostingStore,
  work: WorkEntry
): Promise<PostingLedger | undefined> {
  try {
    return await store.load();
  } catch (error) {
    await report("投稿状態の読み込み", work, error);
    return undefined;
  }
}

async function save(
  store: PostingStore,
  work: WorkEntry,
  ledger: PostingLedger,
  /** 何の保存か。**ログに残す**（`postingKit.ts` の `save` と同じ。0.81.4） */
  purpose: string
): Promise<boolean> {
  try {
    await store.save(ledger);
    return true;
  } catch (error) {
    await report("投稿状態の保存", work, error, purpose);
    return false;
  }
}

/** 失敗はログに残してから知らせる（原因にたどり着けるようにする） */
async function report(
  what: string,
  work: WorkEntry,
  error: unknown,
  purpose?: string
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  // **記録の直前に書き先を向ける**（0.43.3 と同じ）
  useLogFile(work.folderPath);
  logFailure(what, {
    作品: work.title,
    保存しようとしたもの: purpose,
    種類: error instanceof PostingStoreError ? error.kind : "unknown",
    読み込んだ時刻:
      error instanceof PostingStoreError ? error.loadedAt : undefined,
    内容: message,
  });
  await vscode.window.showErrorMessage(message);
}
