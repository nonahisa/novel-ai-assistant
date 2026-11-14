import * as vscode from "vscode";
import { showQuickPickKeepingFocus } from "../views/pickerFocus";
import type { EpisodeFile, WorkEntry } from "../models/types";
import {
  postingEpisodeKey,
  postingSiteInfo,
  postingTargetOfRecord,
  postRecordForPostRef,
  siteProfile,
  siteWorkNumberFor,
  type PostingEpisodeTargetLike,
  type PostingLedger,
  type PostingSiteId,
} from "../models/posting";
import {
  parsePostedClipboard,
  planSiteEpisodeId,
  postedTitleMatches,
  type PostedEnvelope,
} from "../core/postedEnvelope";
import { PostingStore, PostingStoreError } from "../core/postingStore";
import { episodePathFor } from "../core/episodePath";
import { collectedChapterLabel, formatChapterLabel } from "../core/episodeLabel";
import { scanWork } from "../core/scanner";
import { readWorkFormat } from "../core/workFormatStore";
import type { WorkFormatKey } from "../core/workFormat";
import { logFailure, logLine, useLogFile } from "../core/logger";
import { cancelItem, isCancelItem } from "../views/dialogs";
import {
  applyQueuedPostingUpdates,
  findIssuedPostRef,
  isPostingKitActive,
  issuedPostRefsOf,
  queuePostingUpdate,
  type QueuedPostingUpdate,
} from "./postingKitSession";

/**
 * ヘルパーから届いた、投稿した話の番号を受け取る（`vscode://…/import-posted`。設計書6.68.8）。
 *
 * 番号があれば、出し直しのとき話の編集画面を直に開ける（6.68.7）。
 *
 * ## 決め方（推し量って決めない）
 *
 * 1. **札（postRef）があれば札で話を決める。** 札はこちらが封筒へ入れて渡した乱数で、
 *    投稿の記録（`posts[].postRef`）か、開いている投稿キットの案内が覚えている
 * 2. 札が無い・見つからなければ、作品は作品ID（`siteProfiles`）で決め、話は題で照らす。
 *    題がちょうど1つの話と同じときだけ決める
 * 3. それでも決まらなければ、作者に選んでもらう
 *
 * なろうは封筒に作品IDも題も札も無い。作品は台帳の小説番号（`siteFacts.siteWorkNumber`）で引き、
 * 無ければ**なろうの作品が1つでも作者に選んでもらって**番号を覚える。話の番号が台帳に無ければ、
 * 話も選んでもらう。
 *
 * ## 上書きしない
 *
 * その話にもう別の番号があれば、**替えるかを作者に訊く**（黙って替えると、取り違えたときに
 * 戻す道が無い）。同じ番号を別の話がもう持っていれば記録しない。
 *
 * ## 書くもの
 *
 * 書くのは `設定/投稿状態.json` だけ（`PostingStore` の照合つき）。**原稿には触らない。**
 * 投稿キットの案内が開いている作品には書かず、案内へ預ける（`postingKitSession.ts`）。
 */

export interface PostedImportDeps {
  /** 登録された作品 */
  listWorks(): readonly WorkEntry[];
  /** 台帳を書き換えたあと（作品一覧を作り直す） */
  afterChange(work: WorkEntry): void;
}

/** 読めた台帳1つ（書くときは同じ店を使う。照合の手がかりが店にある） */
interface LoadedWork {
  readonly work: WorkEntry;
  readonly store: PostingStore;
  readonly ledger: PostingLedger;
}

/** 話を選ぶ画面の候補1つ */
interface EpisodeCandidate {
  readonly target: PostingEpisodeTargetLike;
  readonly label: string;
  /** 照らす題（封筒の題の欄へ入れた字・ファイル名の題・頭書きの【タイトル】） */
  readonly titles: readonly string[];
  /** 投稿の記録の日時（無い＝案内の途中で、まだ『投稿しました』を選んでいない） */
  readonly postedAt?: string;
  readonly siteEpisodeId?: string;
}

export async function importPostedFromHelper(deps: PostedImportDeps): Promise<void> {
  // 届いたことを最初に記録する（章立ての受け口と同じ。届かなかったのか、届いて止まったのかを分ける）
  useLogFile(undefined);
  logLine("ヘルパーから投稿した話の番号の呼び出しを受けました。");

  let text: string;
  try {
    text = await vscode.env.clipboard.readText();
  } catch (error) {
    logLine(`投稿した話の番号を受け取るためにクリップボードを読めませんでした：${messageOf(error)}`);
    void vscode.window.showWarningMessage(
      "クリップボードを読めなかったため、投稿した話の番号を受け取れませんでした。"
    );
    return;
  }
  const parsed = parsePostedClipboard(text);
  if (!parsed.ok) {
    // 理由だけを記録する。**クリップボードの中身は残さない**（作者の私物）
    if (parsed.kind === "invalid") {
      logLine(`投稿した話の番号を読めませんでした：${parsed.reason}`);
      void vscode.window.showWarningMessage(parsed.reason);
      return;
    }
    logLine("クリップボードに投稿した話の番号が入っていませんでした。");
    void vscode.window.showInformationMessage(
      "クリップボードに投稿した話の番号がありませんでした。投稿したあとの画面で、" +
        "統合小説執筆環境ヘルパーのボタンを押してから、もう一度お試しください。"
    );
    return;
  }
  const envelope = parsed.envelope;
  logLine(
    `投稿した話の番号（${postingSiteInfo(envelope.site).label}、` +
      (envelope.site === "narou"
        ? `小説番号 ${envelope.novelNo}`
        : `作品ID ${envelope.workId}`) +
      `、話の番号 ${envelope.episodeId ?? "なし"}、札 ${envelope.postRef ? "あり" : "なし"}）を受け取りました。`
  );

  const works = deps.listWorks();
  if (works.length === 0) {
    void vscode.window.showInformationMessage(
      "作品が登録されていないため、投稿した話の番号を記録できませんでした。"
    );
    return;
  }
  const loaded = await loadWorks(works);
  if (envelope.site === "narou") {
    await importNarou(envelope, loaded, deps);
  } else {
    await importSiteEpisode(envelope, loaded, deps);
  }
}

/* ── カクヨム・アルファポリス ─────────────────────────── */

async function importSiteEpisode(
  envelope: PostedEnvelope,
  loaded: readonly LoadedWork[],
  deps: PostedImportDeps
): Promise<void> {
  const site: PostingSiteId = envelope.site;
  const siteLabel = postingSiteInfo(site).label;
  const workId = envelope.workId ?? "";
  const episodeId = envelope.episodeId ?? "";

  // 1. 札で決める
  let picked: { entry: LoadedWork; target: PostingEpisodeTargetLike } | undefined;
  if (envelope.postRef) {
    picked = findByPostRef(envelope.postRef, site, loaded);
    if (picked) {
      // 札で決まっても、作品IDが作品の記録と食い違えば取り込まない（別の作品の画面で押した）
      const known = siteProfile(picked.entry.ledger, site)?.workId?.trim();
      if (known && known !== workId) {
        useLogFile(picked.entry.work.folderPath);
        logLine(
          `札の話は「${picked.entry.work.title}」（${siteLabel}の作品ID ${known}）でしたが、` +
            `届いた作品IDは ${workId} でした。記録しませんでした。`
        );
        void vscode.window.showWarningMessage(
          `届いた番号は${siteLabel}の作品ID ${workId} のものですが、貼り込んだ「${picked.entry.work.title}」に` +
            `登録されている作品IDは ${known} です。取り違えを避けるため、記録しませんでした。`
        );
        return;
      }
    } else {
      useLogFile(undefined);
      logLine("届いた札の話が見つからなかったので、作品IDと題で照らします。");
    }
  }

  // 2. 作品IDで作品を決める
  const entry =
    picked?.entry ??
    (await pickWork(
      loaded.filter((candidate) => siteProfile(candidate.ledger, site)?.workId?.trim() === workId),
      `${siteLabel}の作品ID ${workId} を登録した作品が2つ以上あります。番号を記録する作品を選んでください`
    ));
  if (!entry) {
    if (!picked && !loaded.some((candidate) => siteProfile(candidate.ledger, site)?.workId?.trim() === workId)) {
      useLogFile(undefined);
      logLine(`${siteLabel}の作品ID ${workId} を登録した作品が無かったので、記録しませんでした。`);
      void vscode.window.showWarningMessage(
        `${siteLabel}の作品ID ${workId} を登録した作品が見つからないため、話の番号を記録しませんでした。` +
          "作品の「投稿サイト設定」で作品IDを登録してから、ヘルパーのボタンをもう一度押してください。"
      );
    }
    return;
  }

  // 3. 話を決める（札で決まっていなければ題で照らし、決まらなければ選んでもらう）
  let target = picked?.target;
  let label: string;
  const candidates = await episodeCandidates(entry, site);
  if (target) {
    const key = postingEpisodeKey(target);
    label = candidates.find((candidate) => postingEpisodeKey(candidate.target) === key)?.label ?? "その話";
  } else {
    const hits = postedTitleMatches(candidates, envelope.title);
    if (hits.length === 1) {
      target = hits[0].target;
      label = hits[0].label;
      useLogFile(entry.work.folderPath);
      logLine(`届いた題で「${hits[0].label}」に決めました。`);
    } else {
      const chosen = await askEpisode(candidates, hits, siteLabel, entry.work, envelope.title);
      if (!chosen) return;
      target = chosen.target;
      label = chosen.label;
    }
  }

  const update = await decideEpisodeUpdate(entry, site, target, label, episodeId);
  if (!update) return;
  await commit(entry, [update], deps, {
    done: `${label}の${siteLabel}の話の番号（${episodeId}）を記録しました。修正版を出し直すとき、話の編集画面を直接開きます。`,
  });
}

/** 札で話を引く。開いている案内が渡した札を先に見る（まだ『投稿しました』を選んでいない話） */
function findByPostRef(
  postRef: string,
  site: PostingSiteId,
  loaded: readonly LoadedWork[]
): { entry: LoadedWork; target: PostingEpisodeTargetLike } | undefined {
  const issued = findIssuedPostRef(postRef);
  if (issued && issued.issued.site === site) {
    const entry = loaded.find((candidate) => candidate.work.id === issued.workId);
    if (entry) return { entry, target: issued.issued.target };
  }
  for (const entry of loaded) {
    const record = postRecordForPostRef(entry.ledger, site, postRef);
    if (record) return { entry, target: postingTargetOfRecord(record) };
  }
  return undefined;
}

/* ── なろう ─────────────────────────────────────────── */

async function importNarou(
  envelope: PostedEnvelope,
  loaded: readonly LoadedWork[],
  deps: PostedImportDeps
): Promise<void> {
  const site: PostingSiteId = "narou";
  const novelNo = envelope.novelNo ?? "";
  const known = loaded.filter((entry) => siteWorkNumberFor(entry.ledger, site) === novelNo);
  let entry: LoadedWork | undefined;
  let rememberNumber = false;
  if (known.length > 0) {
    entry =
      known.length === 1
        ? known[0]
        : await pickWork(known, `なろうの小説番号 ${novelNo} を覚えている作品が2つ以上あります。選んでください`);
  } else {
    /*
      **番号を持つ作品が無ければ、なろうの作品が1つでも必ず訊く**（ヘルパーとの取り決め）。
      別の小説番号を覚えた作品は候補にしない（なろうの小説番号は作品ごとに変わらない）
    */
    const candidates = loaded.filter(
      (candidate) =>
        usesSite(candidate.ledger, site) && siteWorkNumberFor(candidate.ledger, site) === undefined
    );
    if (candidates.length === 0) {
      useLogFile(undefined);
      logLine(`なろうの小説番号 ${novelNo} を覚える作品の候補が無かったので、記録しませんでした。`);
      void vscode.window.showWarningMessage(
        `なろうの小説番号 ${novelNo} を覚える作品が見つかりませんでした。` +
          "なろうを投稿先にした作品（「投稿サイト設定」）で、まだ小説番号を覚えていないものだけが候補です。"
      );
      return;
    }
    entry = await askWorkAlways(candidates, novelNo);
    rememberNumber = true;
  }
  if (!entry) return;

  const updates: QueuedPostingUpdate[] = [];
  if (rememberNumber) {
    updates.push({
      kind: "workNumber",
      site,
      number: novelNo,
      recordedAt: envelope.readAt ?? new Date().toISOString(),
    });
  }

  let label: string | undefined;
  /** 話の番号がもう台帳にあった（訊かずに済んだ） */
  let episodeKnown = false;
  const episodeId = envelope.episodeId;
  if (episodeId) {
    const holder = entry.ledger.posts.find(
      (post) => post.site === site && post.siteEpisodeId === episodeId
    );
    if (holder) {
      episodeKnown = true;
    } else {
      // なろうには札も題も無いので、照らさずに選んでもらう
      const candidates = await episodeCandidates(entry, site);
      const chosen = await askEpisode(candidates, [], "なろう", entry.work, undefined);
      if (chosen) {
        label = chosen.label;
        const update = await decideEpisodeUpdate(entry, site, chosen.target, chosen.label, episodeId);
        if (update) updates.push(update);
      }
    }
  }

  if (updates.length === 0) {
    // 番号も話の番号も記録済みだったときだけ、そう言う（選ぶのをやめた・断ったときは、もう言ってある）
    if (!rememberNumber && (!episodeId || episodeKnown)) {
      void vscode.window.showInformationMessage(
        `「${entry.work.title}」のなろうの小説番号（${novelNo}）` +
          (episodeId ? "と話の番号は" : "は") +
          "記録済みでした。"
      );
    }
    return;
  }
  const parts: string[] = [];
  if (rememberNumber) parts.push(`なろうの小説番号（${novelNo}）を覚えました`);
  if (updates.some((update) => update.kind === "episode")) {
    parts.push(`${label}の話の番号（${episodeId}）を記録しました`);
  }
  await commit(entry, updates, deps, {
    done: `「${entry.work.title}」の${parts.join("。")}。修正版を出し直すとき、編集の画面を直接開きます。`,
  });
}

/** その作品がそのサイトを投稿先か作品情報に持つか */
function usesSite(ledger: PostingLedger, site: PostingSiteId): boolean {
  return (
    ledger.sites.some((entry) => entry.site === site) ||
    ledger.siteProfiles.some((entry) => entry.site === site)
  );
}

/* ── 書いてよいかを決める ───────────────────────────── */

/**
 * 話の番号を書いてよいか（6.68.8）。書けるなら預かり・書き込みの形を返す。
 * **書かないときは、理由を言ってから undefined。**
 */
async function decideEpisodeUpdate(
  entry: LoadedWork,
  site: PostingSiteId,
  target: PostingEpisodeTargetLike,
  label: string,
  episodeId: string
): Promise<QueuedPostingUpdate | undefined> {
  const siteLabel = postingSiteInfo(site).label;
  const plan = planSiteEpisodeId(entry.ledger, target, site, episodeId);
  useLogFile(entry.work.folderPath);
  const update = (allowReplace: boolean): QueuedPostingUpdate => ({
    kind: "episode",
    site,
    target,
    episodeId,
    allowReplace,
    label,
  });
  switch (plan.kind) {
    case "add":
      return update(false);
    case "same":
      logLine(`${label}の${siteLabel}の話の番号（${episodeId}）は記録済みでした。`);
      void vscode.window.showInformationMessage(
        `${label}の${siteLabel}の話の番号（${episodeId}）は記録済みでした。`
      );
      return undefined;
    case "taken":
      logLine(
        `${siteLabel}の話の番号 ${episodeId} は別の話（${plan.holder}）に記録されているので、${label}には記録しませんでした。`
      );
      void vscode.window.showWarningMessage(
        `${siteLabel}の話の番号 ${episodeId} は、別の話（${plan.holder}）に記録されています。` +
          `取り違えを避けるため、${label}には記録しませんでした。`
      );
      return undefined;
    case "noPost":
      // 案内の途中（『投稿しました』の前）なら預かれる。そうでなければ付ける先が無い
      if (isPostingKitActive(entry.work.id)) return update(false);
      logLine(`${label}には${siteLabel}への投稿の記録が無いため、話の番号 ${episodeId} を記録しませんでした。`);
      void vscode.window.showWarningMessage(
        `${label}にはまだ${siteLabel}への投稿の記録がないため、番号を記録しませんでした。` +
          "投稿キットで「投稿しました」を選んでから、ヘルパーのボタンをもう一度押してください。"
      );
      return undefined;
    case "replace": {
      const replaceLabel = "届いた番号に替える";
      const answer = await vscode.window.showWarningMessage(
        `${label}には、${siteLabel}の別の話の番号（${plan.existing}）が記録されています。届いた番号（${episodeId}）に替えますか？`,
        {
          modal: true,
          detail:
            "番号は、修正版を出し直すときに開く話の編集画面を決めます。" +
            "どちらが正しいか分からなければ、替えずにサイトの話の編集画面のアドレスを確かめてください。",
        },
        replaceLabel
      );
      if (answer !== replaceLabel) {
        logLine(`${label}の${siteLabel}の話の番号は替えませんでした（記録 ${plan.existing}、届いた番号 ${episodeId}）。`);
        return undefined;
      }
      logLine(`${label}の${siteLabel}の話の番号を、作者の答えで ${plan.existing} から ${episodeId} に替えます。`);
      return update(true);
    }
  }
}

/**
 * 書く。**案内が開いている作品には書かず、預ける**（案内の保存を止めないため）。
 * 開いていなければ、読んだときと同じ店で書く（照合つき）。
 */
async function commit(
  entry: LoadedWork,
  updates: readonly QueuedPostingUpdate[],
  deps: PostedImportDeps,
  messages: { readonly done: string }
): Promise<void> {
  useLogFile(entry.work.folderPath);
  if (isPostingKitActive(entry.work.id)) {
    // 預かりは保管庫に残る（VS Code を閉じても消えない。作者の答え 2026-11-03 昼）
    for (const update of updates) await queuePostingUpdate(entry.work.id, update);
    logLine(`投稿キットの案内が開いているので、届いた番号を預かりました（${entry.work.title}）。`);
    void vscode.window.showInformationMessage(
      "番号を受け取りました。投稿キットで「投稿しました」を選ぶと（または案内を終えると）、投稿の記録に入れます。" +
        "VS Code を閉じても預かったままにし、投稿の記録ができていれば次に開いたときに入れます。"
    );
    return;
  }
  const applied = applyQueuedPostingUpdates(entry.ledger, updates);
  if (applied.waiting.length > 0) {
    // 決める段で確かめてあるので、ここへ来るのは台帳の形の不具合だけ。**黙って捨てない**
    for (const item of applied.waiting) logLine(`届いた番号を記録できませんでした：${item.reason}`);
    void vscode.window.showWarningMessage(
      `届いた番号を記録できませんでした：${applied.waiting.map((item) => item.reason).join("／")}`
    );
    if (!applied.changed) return;
  }
  if (!applied.changed) return;
  try {
    await entry.store.save(applied.ledger);
  } catch (error) {
    logFailure("ヘルパーから届いた話の番号の保存", {
      作品: entry.work.title,
      種類: error instanceof PostingStoreError ? error.kind : "unknown",
      内容: messageOf(error),
    });
    void vscode.window.showErrorMessage(messageOf(error));
    return;
  }
  logLine(messages.done);
  void vscode.window.showInformationMessage(messages.done);
  deps.afterChange(entry.work);
}

/* ── 候補と画面 ─────────────────────────────────────── */

/** 各作品の投稿の記録を読む。**読めない作品は候補から外し、記録に残す** */
async function loadWorks(works: readonly WorkEntry[]): Promise<LoadedWork[]> {
  const loaded: LoadedWork[] = [];
  for (const work of works) {
    const store = new PostingStore(work);
    try {
      loaded.push({ work, store, ledger: await store.load() });
    } catch (error) {
      useLogFile(work.folderPath);
      logLine(
        `投稿した話の番号の記録先を探す途中で、${work.title} の投稿状態を読めませんでした：${messageOf(error)}`
      );
    }
  }
  return loaded;
}

/**
 * そのサイトへ投稿した話（新しい順）と、開いている案内が封筒を渡した話。
 * 呼び名と照らす題は、作品の話の一覧から引く（題の読めない合本の話は、札の題だけ）。
 */
async function episodeCandidates(
  entry: LoadedWork,
  site: PostingSiteId
): Promise<EpisodeCandidate[]> {
  let episodes: EpisodeFile[] = [];
  let format: WorkFormatKey | undefined;
  try {
    episodes = (await scanWork(entry.work)).episodes;
    format = await readWorkFormat(entry.work);
  } catch (error) {
    // 話の一覧が読めなくても選ぶ画面は出せる（呼び名がファイルの道になるだけ）
    useLogFile(entry.work.folderPath);
    logLine(`投稿した話の候補を作る途中で、話の一覧を読めませんでした：${messageOf(error)}`);
  }
  const fileOf = (episodePath: string): EpisodeFile | undefined =>
    episodes.find((file) => episodePathFor(entry.work.folderPath, file.filePath) === episodePath);
  const issued = issuedPostRefsOf(entry.work.id).filter((ref) => ref.site === site);

  const candidates: EpisodeCandidate[] = [];
  const seen = new Set<string>();
  const posts = entry.ledger.posts
    .filter((post) => post.site === site)
    .sort((a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt));
  for (const post of posts) {
    const target = postingTargetOfRecord(post);
    const key = postingEpisodeKey(target);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      target,
      label: labelOf(target, fileOf(post.episodePath), format),
      titles: [
        ...titlesOf(target, fileOf(post.episodePath)),
        ...issued.filter((ref) => postingEpisodeKey(ref.target) === key).map((ref) => ref.title),
      ],
      postedAt: post.postedAt,
      ...(post.siteEpisodeId ? { siteEpisodeId: post.siteEpisodeId } : {}),
    });
  }
  // 案内の途中で、まだ『投稿しました』を選んでいない話（封筒は渡した）
  for (const ref of issued) {
    const key = postingEpisodeKey(ref.target);
    if (seen.has(key)) continue;
    seen.add(key);
    const episodePath = typeof ref.target === "string" ? ref.target : ref.target.episodePath;
    candidates.unshift({
      target: ref.target,
      label: labelOf(ref.target, fileOf(episodePath), format),
      titles: [ref.title],
    });
  }
  return candidates;
}

function labelOf(
  target: PostingEpisodeTargetLike,
  file: EpisodeFile | undefined,
  format: WorkFormatKey | undefined
): string {
  const episodePath = typeof target === "string" ? target : target.episodePath;
  const fileLabel = file ? formatChapterLabel(file, format) || file.fileName : episodePath;
  if (typeof target === "string") return fileLabel;
  if (typeof target.chapter === "number") {
    return collectedChapterLabel({ insideCollected: true, chapterStart: target.chapter }, fileLabel, format);
  }
  return typeof target.order === "number" ? `${fileLabel}の${target.order}番目` : fileLabel;
}

/** ファイルまるごとの話の題（合本の中の話の題は、ファイルの一覧からは分からない） */
function titlesOf(target: PostingEpisodeTargetLike, file: EpisodeFile | undefined): string[] {
  if (!file) return [];
  if (typeof target !== "string" && (target.chapter !== undefined || target.order !== undefined)) {
    return [];
  }
  return [file.metaTitle, file.subtitle].filter((title): title is string => Boolean(title));
}

/** 作品を選んでもらう（候補が1つなら訊かない） */
async function pickWork(
  candidates: readonly LoadedWork[],
  placeHolder: string
): Promise<LoadedWork | undefined> {
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  const picked = await showQuickPickKeepingFocus(
    [
      ...candidates.map((entry) => ({ label: entry.work.title, description: entry.work.folderPath, entry })),
      cancelItem("記録せずに終わる"),
    ],
    { title: "投稿した話の番号を記録する作品", placeHolder, ignoreFocusOut: true }
  );
  if (!picked || isCancelItem(picked) || !("entry" in picked)) return undefined;
  return picked.entry;
}

/** なろうの作品を選んでもらう（**候補が1つでも訊く**。作品を足したあとで黙って当たり先が変わらないように） */
async function askWorkAlways(
  candidates: readonly LoadedWork[],
  novelNo: string
): Promise<LoadedWork | undefined> {
  const picked = await showQuickPickKeepingFocus(
    [
      ...candidates.map((entry) => ({ label: entry.work.title, description: entry.work.folderPath, entry })),
      cancelItem("記録せずに終わる"),
    ],
    {
      title: `なろうの小説番号 ${novelNo} の作品（一覧から選びます）`,
      placeHolder: "なろうの管理画面で開いていた作品はどれですか（一度選ぶと、次からは訊きません）",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked) || !("entry" in picked)) return undefined;
  return picked.entry;
}

/** 話を選んでもらう。題が同じ話を先に並べる */
async function askEpisode(
  candidates: readonly EpisodeCandidate[],
  hits: readonly EpisodeCandidate[],
  siteLabel: string,
  work: WorkEntry,
  title: string | undefined
): Promise<EpisodeCandidate | undefined> {
  if (candidates.length === 0) {
    useLogFile(work.folderPath);
    logLine(`「${work.title}」には${siteLabel}への投稿の記録が無いので、話の番号を記録しませんでした。`);
    void vscode.window.showWarningMessage(
      `「${work.title}」には${siteLabel}への投稿の記録がないため、話の番号を記録しませんでした。` +
        "投稿キットで「投稿しました」を選んでから、ヘルパーのボタンをもう一度押してください。"
    );
    return undefined;
  }
  const hitKeys = new Set(hits.map((hit) => postingEpisodeKey(hit.target)));
  const ordered = [
    ...candidates.filter((candidate) => hitKeys.has(postingEpisodeKey(candidate.target))),
    ...candidates.filter((candidate) => !hitKeys.has(postingEpisodeKey(candidate.target))),
  ];
  const picked = await showQuickPickKeepingFocus(
    [
      ...ordered.map((candidate) => ({
        label: candidate.label,
        description: hitKeys.has(postingEpisodeKey(candidate.target)) ? "題が同じ" : undefined,
        detail: [
          candidate.postedAt ? `投稿 ${candidate.postedAt.slice(0, 10)}` : "投稿キットの案内の途中",
          candidate.siteEpisodeId ? `記録済みの番号 ${candidate.siteEpisodeId}` : "",
        ]
          .filter(Boolean)
          .join("　"),
        candidate,
      })),
      cancelItem("記録せずに終わる"),
    ],
    {
      title: `「${work.title}」の${siteLabel}の話（一覧から選びます）`,
      placeHolder:
        (title ? `届いた題「${title}」の話を決められませんでした。` : "") +
        `${siteLabel}で投稿した（保存した）話はどれですか`,
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked) || !("candidate" in picked)) return undefined;
  return picked.candidate;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
