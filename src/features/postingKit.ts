import * as vscode from "vscode";
import type { EpisodeFile, WorkEntry } from "../models/types";
import {
  firstUnpostedEpisodePath,
  latestRanking,
  parseRankInput,
  POSTING_SITES,
  postingSiteInfo,
  postingSiteLabels,
  rankingBoards,
  siteProfile,
  unpostedSites,
  validateNewEpisodeUrl,
  validateRankInput,
  validateWorkPageUrl,
  withBaselinePosts,
  withPost,
  withRanking,
  withSiteProfile,
  withSites,
  type PostingLedger,
  type PostingSiteEntry,
  type PostingSiteId,
} from "../models/posting";
import { PostingStore, PostingStoreError } from "../core/postingStore";
import { episodePathFor } from "../core/bookStore";
import { scanWork } from "../core/scanner";
import { readTextFile } from "../core/textFile";
import { bodyForPosting, extractEpisodeParts } from "../core/episodeCopy";
import {
  buildPostingEnvelope,
  supportsPasteHelper,
} from "../core/postingEnvelope";
import { hasEmphasis } from "../core/ruby";
import { formatChapterLabel } from "../core/episodeLabel";
import { readWorkFormat } from "../core/workFormatStore";
import type { WorkFormatKey } from "../core/workFormat";
import { askText, cancelItem, isCancelItem } from "../views/dialogs";
import { logFailure } from "../core/logger";
import type { AIRegistry } from "../ai/registry";
import { generateAnnouncement } from "./generateAnnouncement";

/**
 * 投稿キット——「貼るだけ」の新話更新（設計書6.68）。
 *
 * ## 自動投稿はしない（6.68.1）
 *
 * なろう・カクヨム・アルファポリス・noteのいずれにも投稿用の公式APIが無く、
 * 画面の自動操作による投稿は**規約違反でアカウント凍結の危険がある**。
 * **この機能が使う道具は2つだけ**——クリップボードと、URLを開くこと。
 * サイトへHTTPで触りにいく処理は1行も書かない（クロールもしない）。
 *
 * 機械がやるのは「未投稿の話を探す」「サイトの記法へ直す」「クリップボードへ
 * 積む」「投稿ページを開く」「どこまで出したかを記録する」まで。
 * **貼って公開するのは作者**である。
 *
 * ## 原稿には触らない
 *
 * 変換した本文はクリップボードへ入れるだけで、手元の原稿は1文字も
 * 書き換えない（6.12.1と同じ約束）。書き込むのは `設定/投稿状態.json` だけ。
 */

/** 1サイトぶんの案内で、作者が選べること */
type SiteAnswer =
  | "posted"
  | "subtitle"
  | "body"
  /** 貼り込み係（ブラウザ拡張）へ渡すJSON封筒でコピーする（設計書6.79.3） */
  | "envelope"
  | "skip"
  | "abort";

export interface PostingKitResult {
  /** 台帳を書き換えたか。呼ぶ側が作品一覧を作り直すのに使う */
  changed: boolean;
}

/**
 * 新話を投稿する（6.68.3）。
 *
 * @param episode 話ノードの右クリックから始めたときの話。
 *   省略すると**未投稿のいちばん古い話**から始める
 */
export async function postNewEpisode(
  work: WorkEntry,
  registry: AIRegistry,
  episode?: EpisodeFile
): Promise<PostingKitResult> {
  const store = new PostingStore(work);
  let ledger = await load(store, work);
  if (!ledger) return { changed: false };
  let changed = false;

  const format = await readWorkFormat(work);
  const relativePathOf = (file: EpisodeFile) =>
    episodePathFor(work.folderPath, file.filePath);

  /*
    **話が決まっているなら走査しない。** 走査は作品の本文を全部読んで
    文字数まで数えるので、200話の作品では体感で分かるほど待たされる。
    右クリックから始めた回は、どの話かが既に分かっている。
    ——ただし初回の設定（基準線）には話の一覧が要るので、そのときは読む。
  */
  let scanned: EpisodeFile[] | undefined;
  const episodesOf = async (): Promise<EpisodeFile[]> =>
    (scanned ??= (await scanWork(work)).episodes);

  // **対象サイトは作品ごとに選ぶ**（6.68.3の3）。noteに出していない作品で
  // noteを訊かないための設定で、初回の1度だけ答えてもらう
  if (ledger.sites.length === 0) {
    const configured = await setUpPosting(
      store,
      work,
      ledger,
      await episodesOf(),
      format
    );
    if (!configured) return { changed: false };
    ledger = configured.ledger;
    changed = configured.changed;
  }

  const target =
    episode ?? pickOldestUnposted(ledger, await episodesOf(), relativePathOf);
  if (!target) {
    void vscode.window.showInformationMessage(
      `${work.title} に未投稿の話はありません（${postingSiteLabels(
        ledger.sites.map((entry) => entry.site)
      )}）。`
    );
    return { changed };
  }

  const episodePath = relativePathOf(target);
  const label = episodeLabelOf(target, format);

  const parts = await readEpisode(target);
  if (!parts) return { changed };

  let sites = unpostedSites(ledger, episodePath);
  if (sites.length === 0) {
    // 話を名指しで選んだときだけ、ここへ来る（自動選択では未投稿しか選ばない）
    const again = await vscode.window.showWarningMessage(
      `${label} は登録したサイトすべてへ投稿済みです。`,
      {
        modal: true,
        detail:
          "もう一度出す場合は、下のボタンを押してください。" +
          "投稿ページを開き直し、記録の日時を今の時刻で置き換えます。",
      },
      "もう一度すべてのサイトへ出す"
    );
    if (again !== "もう一度すべてのサイトへ出す") return { changed };
    sites = ledger.sites.map((entry) => entry.site);
  }

  const posted: PostingSiteId[] = [];
  const skipped: PostingSiteId[] = [];
  let aborted = false;

  for (const site of sites) {
    const answer = await walkSite({
      ledger,
      site,
      label,
      subtitle: parts.subtitle,
      body: parts.body,
    });
    if (answer === "abort") {
      aborted = true;
      break;
    }
    if (answer === "skip") {
      skipped.push(site);
      continue;
    }

    // **1サイトごとに書く**（まとめて最後に書かない）。途中で閉じても、
    // そこまで出したことは残る。台帳の保存はハッシュ照合つき
    const next = withPost(ledger, episodePath, site, new Date().toISOString());
    if (!(await save(store, work, next))) {
      // 別の端末から同期が降りてきた等。ここで止める——読み直さずに
      // 続けると、こちらの古い手持ちで次のサイトぶんも上書きしてしまう
      return { changed };
    }
    ledger = next;
    changed = true;
    posted.push(site);
  }

  await reportResult({ label, posted, skipped, aborted });

  // **最後に更新告知（任意）**（6.68.3の4）。中止したときは誘わない
  if (!aborted && posted.length > 0) {
    await offerAnnouncement(work, registry);
  }

  return { changed };
}

/**
 * 未投稿のいちばん古い話（6.68.3の1）。
 *
 * **走査の並びをそのまま使う**（話数順・日付順は走査のほうが正しく知って
 * いる）。競合マーカーのある話は**そもそも候補にしない**——本文を読めない
 * ものを「次に出す話」として案内しても、その先で断ることになる。
 */
function pickOldestUnposted(
  ledger: PostingLedger,
  episodes: readonly EpisodeFile[],
  relativePathOf: (file: EpisodeFile) => string
): EpisodeFile | undefined {
  const candidates = episodes.filter((file) => !file.hasConflictMarkers);
  const found = firstUnpostedEpisodePath(
    ledger,
    candidates.map(relativePathOf)
  );
  if (!found) return undefined;
  return candidates.find((file) => relativePathOf(file) === found);
}

/**
 * 1つのサイトぶんの案内（6.68.3の2）。
 *
 * 変換 → クリップボード → 投稿ページを開く → 「投稿しましたか？」の順。
 * **通知のボタンではなく選択画面にしてある**——サブタイトルと本文を
 * 行き来しながら貼るので、選び直せる必要がある（通知は押すと閉じる）。
 *
 * **貼り込み係へ渡す形（設計書6.79.3）も、この選択画面の1項目に置く。**
 * 別のコマンドを立てると、サイトと話をもう一度選び直すことになる——ここは
 * 既に「どのサイトへ、どの話を」が決まっていて、投稿画面も開いている。
 */
async function walkSite(input: {
  ledger: PostingLedger;
  site: PostingSiteId;
  label: string;
  subtitle: string | null;
  body: string;
}): Promise<SiteAnswer> {
  const info = postingSiteInfo(input.site);
  const entry = input.ledger.sites.find((site) => site.site === input.site);
  if (!entry) return "skip";

  const body = bodyForPosting(input.body, info.notation, info.emphasis);
  await vscode.env.clipboard.writeText(body);

  // **開くだけ。** ページの中身は読まないし、操作もしない（6.68.1）
  await vscode.env.openExternal(vscode.Uri.parse(entry.newEpisodeUrl));

  let hint = `本文（${body.length.toLocaleString(
    "ja-JP"
  )}字）をコピーしました。貼り付けて公開したら「投稿しました」を選んでください`;
  // **黙って落とさない**（6.68.3）。noteには傍点の記法が無いので印を外す
  if (info.notation === "paren" && hasEmphasis(input.body)) {
    hint += `／${info.label}には傍点の記法が無いため、傍点の印は外しました`;
  }

  for (;;) {
    const picked = await vscode.window.showQuickPick(
      [
        {
          label: "$(check) 投稿しました",
          detail: "台帳に記録して、次へ進みます",
          answer: "posted" as const,
        },
        {
          label: "$(clippy) サブタイトルをコピー",
          detail: input.subtitle
            ? `「${input.subtitle}」を題名の欄へ貼れます`
            : "この話からはサブタイトルを読み取れませんでした",
          answer: "subtitle" as const,
        },
        {
          label: "$(clippy) 本文をもう一度コピー",
          detail: "クリップボードへ入れ直します",
          answer: "body" as const,
        },
        /*
          貼り込み係へ渡す形（設計書6.79.3）。**対応していないサイトでは
          選択肢そのものを出さない**——押せる形で置いておくと、noteの
          投稿画面で待っても何も起きない理由が作者に分からない。
        */
        ...(supportsPasteHelper(input.site)
          ? [
              {
                label: "$(link-external) 貼り込み係へ渡す形でコピー",
                detail:
                  "題名と本文をまとめた形でコピーします。" +
                  "投稿画面でブラウザ拡張のボタンを押すと、欄が埋まります",
                answer: "envelope" as const,
              },
            ]
          : []),
        {
          label: "$(debug-step-over) このサイトは飛ばす",
          detail: "記録せずに次のサイトへ進みます（あとでまた案内します）",
          answer: "skip" as const,
        },
        cancelItem("中止する"),
      ],
      {
        title: `${input.label} を ${info.label} へ`,
        placeHolder: hint,
        ignoreFocusOut: true,
      }
    );
    if (!picked || isCancelItem(picked)) return "abort";
    if (!("answer" in picked)) return "abort";

    if (picked.answer === "subtitle") {
      // **サブタイトルは別口でコピーする**（6.68.3の5）。投稿欄が
      // 題名と本文で分かれているサイトが多い
      if (!input.subtitle) {
        void vscode.window.showWarningMessage(
          `${input.label} からサブタイトルを読み取れませんでした。` +
            "ファイル名か、本文の中の【タイトル】から読み取ります。"
        );
        continue;
      }
      await vscode.env.clipboard.writeText(input.subtitle);
      hint = `「${input.subtitle}」をコピーしました。次は「本文をもう一度コピー」で本文に戻れます`;
      continue;
    }
    if (picked.answer === "body") {
      await vscode.env.clipboard.writeText(body);
      hint = `本文（${body.length.toLocaleString("ja-JP")}字）をコピーし直しました`;
      continue;
    }
    if (picked.answer === "envelope") {
      /*
        **渡すのは、いま作ったものと同じ変換済みの本文**（6.79.3）。
        封筒に包むだけで、サイトごとの記法変換は上の `bodyForPosting` が
        通っている——ここで作り直すと、傍点の扱いが2か所に散る。

        **題名の欄にはサブタイトルを入れる。** 「サブタイトルをコピー」で
        案内しているのと同じ値で揃える（読み取れなければ話の見出し）。

        作品IDは**入っていれば**添える（6.68.5）。貼り込み係が投稿画面の
        URLと突き合わせて、別の作品の画面への貼り込みを止める（6.79.6の2）。
      */
      await vscode.env.clipboard.writeText(
        buildPostingEnvelope({
          site: input.site,
          workId: siteProfile(input.ledger, input.site)?.workId,
          title: input.subtitle?.trim() || input.label,
          body,
        })
      );
      hint =
        "貼り込み係へ渡す形でコピーしました。投稿画面を開いて、" +
        "貼り込み係（ブラウザ拡張）のボタンを押してください。送信はご自身で";
      continue;
    }
    return picked.answer;
  }
}

/**
 * 初回の設定（6.68.3の2・3）。**サイト → 投稿済みの基準線**の順に訊く。
 *
 * 基準線をここで訊くのは、**導入前に出した話まで「未投稿」と数えない**
 * ためである。19話まで書いた作品でこの機能を使い始めると、印を付けた
 * 途端に全話へ「未投稿2」が並ぶ——それでは印が何も伝えない。
 */
async function setUpPosting(
  store: PostingStore,
  work: WorkEntry,
  ledger: PostingLedger,
  episodes: readonly EpisodeFile[],
  format: WorkFormatKey | undefined
): Promise<{ ledger: PostingLedger; changed: boolean } | undefined> {
  const entries = await askSites(work, ledger.sites);
  if (!entries || entries.length === 0) return undefined;

  const withNewSites = withSites(ledger, entries);
  if (!(await save(store, work, withNewSites))) return undefined;

  const next = await applyBaseline(store, work, withNewSites, episodes, format);
  return { ledger: next ?? withNewSites, changed: true };
}

/**
 * 投稿サイトの設定をやり直す（作者の指示、2026-09-04）。
 *
 * サイトの追加・URLの変更・外すと、投稿済みの基準線の引き直しができる。
 * **画面の部品は初回の設定と同じもの**を使う——2つ書くと、片方だけに
 * 検証や案内が足されて食い違う。
 *
 * **サイトを外しても、そのサイトへ出した記録は消さない。** 出した事実は
 * 変わらないし、また出すことにしたときに戻ってくる（未投稿の印は登録した
 * サイトしか見ないので、外している間は数えられない）。
 *
 * **作品情報と順位も同じ**（設計書6.68.5）。どちらも台帳直下にあり、
 * `sites` の置き換えでは動かない——0.32.0では作品情報がサイトの欄の中に
 * あったため、チェックを外すと作者が書いたメモごと消えていた。
 */
export async function configurePostingSites(
  work: WorkEntry
): Promise<PostingKitResult> {
  const store = new PostingStore(work);
  const ledger = await load(store, work);
  if (!ledger) return { changed: false };

  const chosen = await askSites(work, ledger.sites);
  if (!chosen) return { changed: false };

  /*
    **設定は2段に分ける**（設計書6.68.5）。1段目は投稿の入口（サイトと
    投稿ページのURL）で、これが無いと投稿キットが動かない。作品ID・
    作品ページ・ジャンルは「あると便利」なだけなので、**入れるかどうかを
    先に訊いてから**訊く。

    3サイト登録している作品では、まとめて訊くと入力欄が6つ続く。
    そこまで並ぶと、必須の答えまで「まだ終わらないのか」と読まれる。
  */
  // **作品情報はサイトの登録と別の配列に持つ**（設計書6.68.5）。だから
  // チェックを外しても、そのサイトの作品IDも作者のメモも消えない
  let next = withSites(ledger, chosen);
  if (chosen.length > 0) next = await askSiteProfiles(work, next, chosen);

  if (chosen.length === 0) {
    const answer = await vscode.window.showWarningMessage(
      `${work.title} の投稿先をすべて外しますか？`,
      {
        modal: true,
        detail:
          "作品一覧の「未投稿」の印が出なくなります。\n" +
          "これまでに投稿した記録は消えません。" +
          "またサイトを登録すれば、そのまま続きから使えます。",
      },
      "すべて外す"
    );
    if (answer !== "すべて外す") return { changed: false };
  }

  const withNewSites = next;
  if (!(await save(store, work, withNewSites))) return { changed: false };
  void vscode.window.showInformationMessage(
    chosen.length === 0
      ? `${work.title} の投稿先をすべて外しました（記録は残っています）。`
      : `${work.title} の投稿先を ${postingSiteLabels(
          chosen.map((entry) => entry.site)
        )} にしました。`
  );

  // **基準線は、続けて引き直せるようにする**（サイトを足した直後は、
  // その新しいサイトだけ全話が未投稿になっている）
  if (chosen.length > 0) {
    const picked = await vscode.window.showQuickPick(
      [
        cancelItem("引き直さずに終わる"),
        {
          label: "$(history) 投稿済みの基準線を引き直す",
          detail: "「どの話まで出したか」を選び直します（記録は増えるだけです）",
          redo: true,
        },
      ],
      {
        title: `${work.title} の投稿済みの基準線`,
        placeHolder: "どの話まで投稿済みかを、いま決め直しますか",
        ignoreFocusOut: true,
      }
    );
    if (picked && !isCancelItem(picked) && "redo" in picked) {
      const format = await readWorkFormat(work);
      const { episodes } = await scanWork(work);
      await applyBaseline(store, work, withNewSites, episodes, format);
    }
  }

  return { changed: true };
}

/**
 * 対象サイトと投稿ページのURLを訊く（6.68.3の2）。
 *
 * **訊くのは選んだサイトだけ。** noteに出さない作品でnoteのURLを
 * 訊かれるのは、答えようのない質問である。
 *
 * URLの検証は**そのサイトのドメインかどうかだけ**（6.68.1）。
 * 中身は見ない——見るにはページを読みにいくことになる。
 *
 * @param current 既に登録してあるもの。選択済みにして、URLは初期値に入れる
 * @returns 取りやめたら undefined。空配列は「1つも出さない」という答え
 */
async function askSites(
  work: WorkEntry,
  current: readonly PostingSiteEntry[]
): Promise<PostingSiteEntry[] | undefined> {
  const picked = await vscode.window.showQuickPick(
    POSTING_SITES.map((site) => ({
      label: site.label,
      description: current.some((entry) => entry.site === site.id)
        ? "登録済み"
        : undefined,
      detail:
        site.notation === "paren"
          ? "ルビの記法が無いため、読みは括弧書きにして貼ります"
          : `ルビ・傍点を${site.label}の書き方に直して貼ります`,
      site: site.id,
      // 既に登録してあるものは選択済みで出す。選び直しが「追加と削除」
      // の1画面で済む（外すのはチェックを外すだけ）
      picked: current.some((entry) => entry.site === site.id),
    })),
    {
      title: `${work.title} を出すサイト`,
      placeHolder: "出しているサイトを選んでください（複数選べます）",
      canPickMany: true,
      ignoreFocusOut: true,
    }
  );
  if (!picked) return undefined;

  const entries: PostingSiteEntry[] = [];
  for (const item of picked) {
    const info = postingSiteInfo(item.site);
    const existing = current.find((entry) => entry.site === item.site);
    const url = await askText({
      title: `${info.label} の新規エピソード投稿ページ`,
      prompt:
        `${info.label}で「新しい話を書く」画面を開き、そのURLを貼り付けてください。` +
        "この作品のページを毎回ここから開きます",
      value: existing?.newEpisodeUrl,
      placeHolder: info.urlExample,
      ignoreFocusOut: true,
      validateInput: (value) =>
        validateNewEpisodeUrl(item.site, value) ?? undefined,
    });
    // **1つでも取りやめたら、何も覚えない。** 半分だけ登録されると、
    // 次に押したときに「なぜこのサイトを訊かれないのか」が分からない
    if (url === undefined) return undefined;
    // **作品情報の持ち越しは要らない**（6.68.5）。作品情報は台帳直下の
    // `siteProfiles` にあり、サイトの一覧を置き換えても動かない
    entries.push({ site: item.site, newEpisodeUrl: url.trim() });
  }
  return entries;
}

/**
 * サイトごとの作品情報を訊く（設計書6.68.5）。
 *
 * **全部が任意で、空のまま飛ばせる。** サイトの作品IDやジャンルは、
 * 覚えていないこともあれば、まだ決めていないこともある。答えられない
 * 質問を必須にすると、設定そのものを最後まで通せなくなる。
 *
 * **取りやめ（Esc）は「ここまでで終える」**として扱い、それまでに
 * 入れたぶんは残す。投稿ページのURL（必須）とは扱いを変えている——
 * あちらは半端に登録されると次の案内が壊れるが、こちらは入っている
 * ところまでが素直に使える。
 */
async function askSiteProfiles(
  work: WorkEntry,
  ledger: PostingLedger,
  entries: readonly PostingSiteEntry[]
): Promise<PostingLedger> {
  const picked = await vscode.window.showQuickPick(
    [
      // **入れないほうを先頭に置く**（更新告知の誘いと同じ形）。ここまでで
      // 投稿はできる状態になっており、作品情報は「あると便利」なだけである
      cancelItem("作品情報は入れずに終える"),
      {
        label: "$(edit) 作品ID・作品ページ・ジャンルも入れる",
        detail:
          "サイトごとに3つ訊きます（どれも空のままで構いません）。" +
          "執筆量パネルの「サイトの記録」に出ます",
        detailed: true,
      },
    ],
    {
      title: `${work.title} の投稿サイトの情報`,
      placeHolder: "サイトごとの作品情報も入れますか（あとからでも足せます）",
      ignoreFocusOut: true,
    }
  );
  // **取りやめても、選んだサイトは失わない。** ここで捨てると、必須の
  // 答え（サイトとURL）まで任意の質問の巻き添えになる
  if (!picked || isCancelItem(picked) || !("detailed" in picked)) {
    return ledger;
  }

  let next = ledger;
  for (const entry of entries) {
    const info = postingSiteInfo(entry.site);
    // 既に入っている値を初期値に出す。**外して再登録しても残っている**
    // （作品情報はサイトの登録と別に持つので、外した間も消えていない）
    const current = siteProfile(next, entry.site);

    const workId = await askText({
      title: `${info.label} での作品ID`,
      /*
        **例はサイトごとに出す**（`info.workIdExample`）。IDの形はサイトで
        まるきり違い、なろうのNコードだけを例に出していたころは、
        アルファポリスの欄に作者番号だけが入った——あの作品IDは
        「作者番号＋作品番号」で1つなので、片方では作品を指せない。
      */
      prompt:
        `${info.label}のこの作品のIDを入れてください。` +
        "分からなければ空のままで構いません",
      value: current?.workId,
      placeHolder: info.workIdExample,
      ignoreFocusOut: true,
    });
    // **Escは「ここまでで終える」。** 入れたぶんはそのまま残し、
    // まだ訊いていないサイトの作品情報にも触らない
    if (workId === undefined) return next;

    const workUrl = await askText({
      title: `${info.label} の作品ページのURL`,
      prompt:
        "読者が見る作品ページのURLを貼ってください（空のままで構いません）。" +
        "執筆量パネルからここを開けるようになります",
      value: current?.workUrl,
      placeHolder: `https://${info.domain}/`,
      ignoreFocusOut: true,
      // **確かめるのはドメインだけ**（6.68.1）。ページは読みにいかない
      validateInput: (value) =>
        validateWorkPageUrl(entry.site, value) ?? undefined,
    });
    if (workUrl === undefined) return next;

    const genre = await askText({
      title: `${info.label} でのジャンル`,
      prompt:
        `${info.label}で選んでいるジャンルを入れてください（空のままで構いません）`,
      value: current?.genre,
      placeHolder: "ハイファンタジー",
      ignoreFocusOut: true,
    });
    if (genre === undefined) return next;

    next = withSiteProfile(next, entry.site, {
      workId,
      workUrl,
      genre,
      // **作者が書いたメモは訊かないし、消さない**（台帳を手で直したときの
      // 書き込みが、この画面を通るたびに消えてはいけない）
      note: current?.note,
    });
  }
  return next;
}

/**
 * ランキングを記録する（設計書6.68.5）。
 *
 * **サイトへは取りにいかない。** ランキングのページを機械で読むのは、
 * 自動投稿を断ったのと同じ線の内側にある（6.68.1）。ここが記録するのは
 * **作者が画面で見て打った値だけ**である。
 *
 * 訊く順は「サイト → 種別 → 順位 → メモ」。日時は書き留めた時刻を自動で
 * 入れる（順位が出た時刻は、作者にも分からないことがある）。
 */
export async function recordRanking(
  work: WorkEntry
): Promise<PostingKitResult> {
  const store = new PostingStore(work);
  const ledger = await load(store, work);
  if (!ledger) return { changed: false };

  /*
    **サイトが1つも登録されていなければ、そこへ誘導する。**
    どのサイトの順位かを訊いても答えようがないので、選択画面すら出さない。
  */
  if (ledger.sites.length === 0) {
    const answer = await vscode.window.showWarningMessage(
      `${work.title} には投稿サイトが登録されていません。` +
        "「投稿サイトの設定」でサイトを登録すると、そのサイトの順位を記録できます。",
      "投稿サイトの設定"
    );
    if (answer === "投稿サイトの設定") return await configurePostingSites(work);
    return { changed: false };
  }

  const site = await askRankingSite(work, ledger);
  if (!site) return { changed: false };
  const info = postingSiteInfo(site);

  const board = await askRankingBoard(ledger, site);
  if (board === undefined) return { changed: false };

  const rankText = await askText({
    title: `${info.label} の${board}の順位`,
    prompt: "いま何位でしたか。数字で入れてください（1位なら 1）",
    placeHolder: "12",
    ignoreFocusOut: true,
    validateInput: (value) => validateRankInput(value) ?? undefined,
  });
  if (rankText === undefined) return { changed: false };
  const rank = parseRankInput(rankText);
  // 入力欄で断っているので、ここへ来るのは画面の作りが変わったときだけ
  if (rank === null) return { changed: false };

  const note = await askText({
    title: "メモ（任意）",
    prompt:
      "覚えておきたいことがあれば入れてください" +
      "（空のままでも、取りやめても、順位は記録します）",
    placeHolder: "更新直後",
    ignoreFocusOut: true,
  });

  const next = withRanking(ledger, {
    site,
    recordedAt: new Date().toISOString(),
    board,
    rank,
    // **メモの取りやめは「メモ無し」**として扱う（ここまでの答えを
    // 捨てるほうが、作者にとっては大きな損である）
    ...(note?.trim() ? { note: note.trim() } : {}),
  });
  if (!(await save(store, work, next))) return { changed: false };

  void vscode.window.showInformationMessage(
    `${info.label} ${board} ${rank}位 を記録しました。` +
      "執筆量パネルの「サイトの記録」で履歴を見られます。"
  );
  return { changed: true };
}

/** どのサイトの順位か。**登録してあるサイトの中から選ぶ** */
async function askRankingSite(
  work: WorkEntry,
  ledger: PostingLedger
): Promise<PostingSiteId | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      ...ledger.sites.map((entry) => {
        const info = postingSiteInfo(entry.site);
        const latest = latestRanking(ledger, entry.site);
        return {
          label: info.label,
          // 前回の記録を添える。「前より上がったか」がこの操作の関心である
          description: latest
            ? `前回 ${latest.board} ${latest.rank}位`
            : "記録はまだありません",
          site: entry.site,
        };
      }),
      cancelItem(),
    ],
    {
      title: `${work.title} のランキングを記録`,
      placeHolder: "どのサイトの順位ですか",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked) || !("site" in picked)) return undefined;
  return picked.site;
}

/**
 * 種別（日間・週間・ジャンル別…）を訊く。
 *
 * **候補はこちらで決め打ちしない**（6.68.5）。サイトごとに呼び方が違い、
 * 企画やジャンル別の名前は作品ごとに違う。**作者が過去に使った言葉**を
 * 候補に出し、無ければそのまま入力欄で訊く（空の候補一覧を見せない）。
 */
async function askRankingBoard(
  ledger: PostingLedger,
  site: PostingSiteId
): Promise<string | undefined> {
  const info = postingSiteInfo(site);
  const boards = rankingBoards(ledger, site);

  if (boards.length > 0) {
    const used = new Set(
      ledger.rankings
        .filter((entry) => entry.site === site)
        .map((entry) => entry.board)
    );
    const picked = await vscode.window.showQuickPick(
      [
        ...boards.map((board) => ({
          label: board,
          description: used.has(board)
            ? undefined
            : "ほかのサイトで使った種別",
          board,
        })),
        {
          label: "$(edit) 別の種別を入力する",
          detail: "日間・週間・月間・ジャンル別など、サイトの呼び方のままで結構です",
          board: null,
        },
        cancelItem(),
      ],
      {
        title: `${info.label} のランキングの種別`,
        placeHolder: "どのランキングの順位ですか",
        ignoreFocusOut: true,
      }
    );
    if (!picked || isCancelItem(picked) || !("board" in picked)) {
      return undefined;
    }
    if (typeof picked.board === "string") return picked.board;
  }

  const value = await askText({
    title: `${info.label} のランキングの種別`,
    prompt:
      "ランキングの種別を入れてください（日間・週間・月間・ジャンル別など、" +
      "サイトの呼び方のままで結構です）",
    placeHolder: "日間",
    ignoreFocusOut: true,
    validateInput: (input) =>
      input.trim() ? undefined : "種別を入れてください。",
  });
  return value?.trim() || undefined;
}

/**
 * 「どの話まで投稿済みとみなすか」を訊いて、台帳へ入れる（基準線）。
 *
 * **日時は導入した時刻でしかない**ので、`importedBaseline` の印を付けて
 * 実際の投稿の記録と見分けられるようにする（`models/posting.ts`）。
 * 既にある記録は1つも書き換えない。
 *
 * @returns 記録を足したら新しい台帳。足さなかった・取りやめたら undefined
 */
async function applyBaseline(
  store: PostingStore,
  work: WorkEntry,
  ledger: PostingLedger,
  episodes: readonly EpisodeFile[],
  format: WorkFormatKey | undefined
): Promise<PostingLedger | undefined> {
  if (episodes.length === 0) return undefined;

  const picked = await vscode.window.showQuickPick(
    [
      // **新しい話を上に置く**（たいてい「最新話まで出した」が答えになる）
      ...[...episodes].reverse().map((episode, index) => ({
        label: `$(check) ${episodeLabelOf(episode, format)} まで投稿済み`,
        detail: episode.fileName,
        // 逆順にしたので、元の並びでの位置に直す
        upto: episodes.length - index,
      })),
      {
        label: "$(circle-outline) 最初から（まだ1話も出していない）",
        detail: "記録を1件も入れません",
        upto: 0,
      },
      cancelItem("いま決めない"),
    ],
    {
      title: `${work.title} は、どの話まで投稿済みですか`,
      placeHolder:
        "選んだ話までを、登録したサイトすべてへ投稿済みとして記録します（あとから変えられます）",
      ignoreFocusOut: true,
    }
  );
  // **決めないまま進める。** ここで止めると、サイトの登録までやり直しになる
  if (!picked || isCancelItem(picked) || !("upto" in picked)) return undefined;
  if (picked.upto === 0) return undefined;

  const next = withBaselinePosts(
    ledger,
    episodes
      .slice(0, picked.upto)
      .map((episode) => episodePathFor(work.folderPath, episode.filePath)),
    ledger.sites.map((entry) => entry.site),
    new Date().toISOString()
  );
  const added = next.posts.length - ledger.posts.length;
  if (added === 0) return undefined;
  if (!(await save(store, work, next))) return undefined;

  void vscode.window.showInformationMessage(
    `${episodeLabelOf(episodes[picked.upto - 1], format)} までを、` +
      `${postingSiteLabels(
        ledger.sites.map((entry) => entry.site)
      )}へ投稿済みとして記録しました（${added}件）。` +
      "実際に投稿した記録とは分けて残しています。"
  );
  return next;
}

/** 話の呼び名。話数が読めない話はファイル名で呼ぶ */
function episodeLabelOf(
  episode: EpisodeFile,
  format: WorkFormatKey | undefined
): string {
  return formatChapterLabel(episode, format) || episode.fileName;
}

/** 何をしたかを1回でまとめて伝える（黙って終わらない） */
async function reportResult(input: {
  label: string;
  posted: PostingSiteId[];
  skipped: PostingSiteId[];
  aborted: boolean;
}): Promise<void> {
  const parts: string[] = [];
  if (input.posted.length > 0) {
    parts.push(`${postingSiteLabels(input.posted)}へ投稿と記録しました`);
  }
  if (input.skipped.length > 0) {
    parts.push(`${postingSiteLabels(input.skipped)}は飛ばしました`);
  }
  if (input.aborted) parts.push("途中で中止しました");
  if (parts.length === 0) return;

  void vscode.window.showInformationMessage(
    `${input.label}：${parts.join("／")}。`
  );
}

/**
 * 更新告知（P-30）へ繋ぐ（6.68.3の4）。
 *
 * **作らない選択肢を先に置く。** ここまでで用は足りており、告知は
 * おまけである（しかもAIを呼ぶ＝有料のAIでは料金が出る）。
 */
async function offerAnnouncement(
  work: WorkEntry,
  registry: AIRegistry
): Promise<void> {
  const picked = await vscode.window.showQuickPick(
    [
      // **作らないほうを先頭に置く。** 既定の答えは「作らない」である
      cancelItem("告知は作らずに終わる"),
      {
        label: "$(megaphone) 更新告知文を作る",
        detail: "X用・活動報告用・後書き用の3種を作ります（AIを呼びます）",
        announce: true,
      },
    ],
    {
      title: "投稿おつかれさまでした",
      placeHolder: "更新告知文も作りますか",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked) || !("announce" in picked)) return;
  await generateAnnouncement(work, registry);
}

/**
 * 本文とサブタイトルを読む。
 *
 * **競合マーカーのある話は断る**（実装ルール1）。マーカーごと投稿欄へ
 * 貼られては取り返しがつかない。
 */
async function readEpisode(
  episode: EpisodeFile
): Promise<{ subtitle: string | null; body: string } | undefined> {
  let file;
  try {
    file = await readTextFile(episode.filePath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logFailure("投稿キットの本文の読み込み", {
      ファイル: episode.fileName,
      内容: detail,
    });
    void vscode.window.showErrorMessage(
      `${episode.fileName} を読み込めませんでした: ${detail}`
    );
    return undefined;
  }

  if (file.hasConflictMarkers) {
    void vscode.window.showWarningMessage(
      `${episode.fileName} に未解決の競合（<<<<<<<）があります。` +
        "そのまま投稿すると競合の印ごと公開されるため、中止しました。" +
        "競合を解決してからお試しください。"
    );
    return undefined;
  }

  const parts = extractEpisodeParts(file.text, episode.subtitle);
  if (!parts.body.trim()) {
    void vscode.window.showWarningMessage(
      `${episode.fileName} に本文が見つかりませんでした。`
    );
    return undefined;
  }
  return parts;
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
  ledger: PostingLedger
): Promise<boolean> {
  try {
    await store.save(ledger);
    return true;
  } catch (error) {
    await report("投稿状態の保存", work, error);
    return false;
  }
}

/** 失敗はログに残してから知らせる（原因にたどり着けるようにする） */
async function report(
  what: string,
  work: WorkEntry,
  error: unknown
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  logFailure(what, {
    作品: work.title,
    種類: error instanceof PostingStoreError ? error.kind : "unknown",
    内容: message,
  });
  await vscode.window.showErrorMessage(message);
}
