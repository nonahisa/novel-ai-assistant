/**
 * VS Code の設定の同期（Settings Sync）で運ぶ作品の一覧（設計書5.5.11.1）。
 *
 * 別の機械で作品一覧を開いたとき、「この機械にはまだ無い作品」を並べて
 * ［取り寄せる］で clone できるようにするための台帳。
 *
 * **運ぶのは作品の名前と GitHub の URL だけ。** フォルダーの場所は機械ごとに違い、
 * 鍵・トークンは同期先（Microsoft / GitHub のアカウントの保管庫）へ出してはいけない。
 * URL に `user:token@` が入っていることがあるので、載せる前と読んだあとの両方で清める。
 *
 * **合わせ方は和集合。** 設定の同期は最後に書いた機械が丸ごと勝つので、
 * この機械の作品だけを書くと、別の機械が足した作品が消える。いま届いている
 * 一覧へこの機械の作品を足し、この機械で登録を外しても自動では消さない
 * （別の機械でまだ書いている作品を消さないため）。消すのは作者が
 * ［一覧から外す］を押したときだけ。
 *
 * vscode にも git にも依存しない（ブラウザ版の束にも入るため。実装ルール7）。
 */

/** 一覧の1行 */
export interface SyncedWork {
  /** 一覧に出す作品名（この一覧へ最後に書いた機械の名前） */
  title: string;
  /** 資格情報を外した `https://` の URL */
  remoteUrl: string;
  /** 初めて一覧へ載せた日時（ISO8601） */
  addedAt: string;
}

/** 保管の形。形を変えたら version を上げ、古い製品が新しい一覧を上書きしないようにする */
export interface StoredSyncedWorkList {
  version: 1;
  works: SyncedWork[];
}

export const SYNCED_WORK_LIST_VERSION = 1;

/** この機械の作品1つ（作品名と、origin の URL をそのまま） */
export interface LocalWorkRemote {
  title: string;
  remoteUrl: string;
}

/** 読んだ結果。壊れていたら直さず「読めない」を返す（実装ルール2） */
export type SyncedWorkListRead =
  | { ok: true; works: SyncedWork[] }
  | { ok: false; reason: string };

/**
 * `https://[資格情報@]ホスト/所有者/名前[.git][/]` の形。
 *
 * 所有者と名前の2段だけを受ける（GitHub の形）。ホストは URL のまま受けるので、
 * GitHub Enterprise も通る（5.5.12 の `parseHttpsRemote` と同じ考え方）。
 * `?` や `#` が付いたものは受けない——トークンが問い合わせの形で付いていることがある
 */
const HTTPS_REMOTE = /^https:\/\/(?:[^@/\s]+@)?([^@/\s?#:]+(?::\d+)?)\/([^/\s?#]+)\/([^/\s?#]+?)(\.git)?\/*$/i;

/** 比べるときだけ受ける SSH の形（`git@ホスト:所有者/名前` と `ssh://git@ホスト/所有者/名前`） */
const SSH_SCP_REMOTE = /^[^@\s/]+@([^:\s/]+):([^/\s]+)\/([^/\s]+?)(?:\.git)?\/*$/;
const SSH_URL_REMOTE = /^ssh:\/\/(?:[^@/\s]+@)?([^/\s:]+)(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/*$/i;

/**
 * 一覧へ載せてよい形へ清める。載せられない形なら undefined。
 *
 * - 資格情報（`user:token@`）は必ず外す
 * - SSH・`http://`・ほかの形は載せない（SSH は鍵の置き方が機械ごとに違い、
 *   `http://` は暗号化されない経路のため）
 */
export function cleanRemoteUrl(raw: string): string | undefined {
  const match = HTTPS_REMOTE.exec(raw.trim());
  if (!match) return undefined;
  const [, host, owner, name, dotGit] = match;
  return `https://${host}/${owner}/${name}${dotGit ?? ""}`;
}

/**
 * 比べるときの鍵（ホスト＋所有者＋名前を小文字にし、末尾の `.git` と `/` を外した形）。
 *
 * **SSH の形も鍵にする。** この機械では SSH で取り寄せた作品を、一覧に載らない
 * からといって「この機械に無い作品」と見ると、同じ作品をもう一度取り寄せさせてしまう。
 * 載せる（`cleanRemoteUrl`）と比べる（ここ）は別の問いである。
 */
export function comparisonKey(raw: string): string | undefined {
  const text = raw.trim();
  const match =
    HTTPS_REMOTE.exec(text) ?? SSH_URL_REMOTE.exec(text) ?? SSH_SCP_REMOTE.exec(text);
  if (!match) return undefined;
  const [, host, owner, name] = match;
  // ポートは鍵に含めない（同じリポジトリを別の口で指しているだけ）
  const bareHost = host.replace(/:\d+$/, "");
  return `${bareHost}/${owner}/${name}`.toLowerCase();
}

/**
 * globalState から読んだ値を確かめる。
 *
 * 形が違えば**直さずに**「読めない」を返す。呼ぶ側はログに残し、書き戻さない。
 * 新しいバージョンの製品が書いた一覧（version が 1 でない）も読めないに入れる——
 * 古い製品が読める所だけ読んで書き戻すと、新しい項目が消える。
 */
export function readSyncedWorkList(value: unknown): SyncedWorkListRead {
  if (value === undefined) return { ok: true, works: [] };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "一覧が JSON のオブジェクトではありません" };
  }
  const record = value as { version?: unknown; works?: unknown };
  if (record.version !== SYNCED_WORK_LIST_VERSION) {
    return { ok: false, reason: `一覧のバージョン（${String(record.version)}）を読めません` };
  }
  if (!Array.isArray(record.works)) {
    return { ok: false, reason: "一覧に works の並びがありません" };
  }
  const works: SyncedWork[] = [];
  for (const [index, item] of record.works.entries()) {
    if (typeof item !== "object" || item === null) {
      return { ok: false, reason: `${index + 1}行目がオブジェクトではありません` };
    }
    const row = item as Record<string, unknown>;
    const { title, remoteUrl, addedAt } = row;
    if (typeof title !== "string" || title.trim().length === 0) {
      return { ok: false, reason: `${index + 1}行目の作品名がありません` };
    }
    if (typeof remoteUrl !== "string" || typeof addedAt !== "string") {
      return { ok: false, reason: `${index + 1}行目の形が違います` };
    }
    // 清めた形と違う（資格情報が入っている等）行は、別の機械が書き違えたもの。
    // 黙って清めて書き戻すと「直した」ことになるので、読めないに入れる
    if (cleanRemoteUrl(remoteUrl) !== remoteUrl) {
      return { ok: false, reason: `${index + 1}行目の URL が一覧に載せる形ではありません` };
    }
    works.push({ title, remoteUrl, addedAt });
  }
  return { ok: true, works };
}

/** 保管の形にする */
export function toStoredList(works: readonly SyncedWork[]): StoredSyncedWorkList {
  return { version: SYNCED_WORK_LIST_VERSION, works: works.map((work) => ({ ...work })) };
}

/**
 * 届いている一覧に、この機械の作品を足す（和集合）。
 *
 * - 同じ鍵があれば、名前だけこの機械の名前に替える（URL と足した日時は保つ）
 * - この機械に無い行は消さない
 * - 1つのリポジトリに作品が複数ある（書庫。設計書5.7）ときは1行にまとめ、
 *   登録の順で最初の作品名に「ほかN作品」を添える。取り寄せると書庫ごと届くので、
 *   行を分けても［取り寄せる］の先は同じになる
 *
 * **何度当てても同じ結果になる**（`VerifiedState.patch` が書き直しのたびに当て直すため）。
 * `now` は新しく足す行にだけ使う。
 */
export function mergeLocalWorks(
  current: readonly SyncedWork[],
  local: readonly LocalWorkRemote[],
  now: string
): SyncedWork[] {
  const localByKey = new Map<string, { url: string; titles: string[] }>();
  for (const work of local) {
    const url = cleanRemoteUrl(work.remoteUrl);
    const key = url ? comparisonKey(url) : undefined;
    if (!url || !key) continue;
    const found = localByKey.get(key);
    if (found) found.titles.push(work.title);
    else localByKey.set(key, { url, titles: [work.title] });
  }
  const titleOf = (titles: string[]): string =>
    titles.length > 1 ? `${titles[0]}ほか${titles.length - 1}作品` : titles[0];

  const merged: SyncedWork[] = [];
  const seen = new Set<string>();
  for (const work of current) {
    const key = comparisonKey(work.remoteUrl);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const here = localByKey.get(key);
    merged.push(here ? { ...work, title: titleOf(here.titles) } : { ...work });
  }
  for (const [key, here] of localByKey) {
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ title: titleOf(here.titles), remoteUrl: here.url, addedAt: now });
  }
  return merged;
}

/** ［一覧から外す］。鍵で外す（同じリポジトリを別の綴りで指した行も外れる） */
export function removeSyncedWork(
  current: readonly SyncedWork[],
  remoteUrl: string
): SyncedWork[] {
  const key = comparisonKey(remoteUrl);
  if (!key) return [...current];
  return current.filter((work) => comparisonKey(work.remoteUrl) !== key);
}

/**
 * 一覧のうち、この機械の作品（origin の URL）に無いもの。
 *
 * 別の機械が書いた行なので、並べる前にもう一度清めを通す（通らない行は出さない）。
 */
export function worksMissingHere(
  synced: readonly SyncedWork[],
  localRemoteUrls: readonly string[]
): SyncedWork[] {
  const here = new Set(
    localRemoteUrls
      .map((url) => comparisonKey(url))
      .filter((key): key is string => key !== undefined)
  );
  return synced.filter((work) => {
    if (cleanRemoteUrl(work.remoteUrl) !== work.remoteUrl) return false;
    const key = comparisonKey(work.remoteUrl);
    return key !== undefined && !here.has(key);
  });
}
