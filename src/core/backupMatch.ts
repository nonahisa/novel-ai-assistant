import type { PostingSiteId } from "../models/posting";
import type { WorkZipInspection } from "./workZip";

/**
 * 持ち込まれたバックアップが、どの登録済み作品のものかを決める。
 *
 * 作者の依頼（2026-09-23）：「相談パネルにバックアップファイルを放り込んだら、
 * 既存作品に該当（タイトルなど）がないか確認して、あれば章やいいねや
 * コメントや修正部分の取り込みだけ。なさそうなら作者に確認の上取り込み処理を
 * 走らせてください」。
 *
 * ## 決め方の順
 *
 * 1. **サイトの作品ID**（なろうのNコード）で、投稿状態の台帳の
 *    `siteProfiles[].workId` と照らす。IDは作品ごとに1つしか無いので、
 *    当たればほぼ間違いない
 * 2. 当たらなければ**題**で照らす。前後の空白・全角半角・大文字小文字を
 *    そろえてから比べる（フォルダー名に使えない記号は、登録のときに
 *    落ちていることがあるので、両側から落として比べる）
 * 3. 題がぴったり合わなくても、**片方がもう片方を含む**ものは「曖昧」として
 *    作者に選ばせる（「〜別視点バージョン〜」のような派生作品がある）
 *
 * ## 当たったと決めつけない
 *
 * ここが返すのは**候補**である。取り込むかどうかは、呼ぶ側が必ず作者に
 * 見せてから決める——題が同じ別の作品は、作者の手元に実際にある
 * （本編と別視点版など）。
 *
 * ## IDが違えば、題が同じでも別の作品である
 *
 * 台帳にそのサイトの作品IDが書いてあり、それがバックアップのIDと違うなら、
 * 題が同じでも**別の作品**と読む（同じ題で2作を出していることがある）。
 * 候補から外し、外したことは `differentId` で返す（黙って消さない）。
 *
 * VS Code API には依存しない。
 */

/** バックアップから読めた、作品を見分ける手がかり */
export interface BackupIdentity {
  /** どのサイトのバックアップか。分からなければ null */
  readonly site: PostingSiteId | null;
  /** サイトの作品ID（なろうのNコード）。**小文字**。入っていなければ null */
  readonly workId: string | null;
  /** 題。作品情報の【タイトル】、無ければファイル名から採ったもの */
  readonly title: string;
}

/** 照らす相手になる、登録済みの作品1つ */
export interface BackupMatchCandidate {
  readonly id: string;
  /** 作品一覧に出ている名前 */
  readonly title: string;
  /** 作品フォルダーの名前（題と違うことがある） */
  readonly folderName: string;
  /** 投稿状態の台帳にある、サイトごとの作品ID。読めなかった作品は空 */
  readonly siteIds: readonly {
    readonly site: PostingSiteId;
    readonly workId: string;
  }[];
}

/** 何で当たったか。作者への説明に使う */
export type BackupMatchBy = "id" | "title" | "partial";

/**
 * 題では当たったが、作品IDが違うので外した作品。
 *
 * **題で当たったものだけを入れる**（2026-09-23、実機）。はじめは題を比べる
 * 前に「台帳に別のIDを持つ作品」を全部入れていたので、題のまったく違う
 * バックアップでも「『教科書チート』は題が同じですが…」と出た。
 * `by` は作者への一言を「題が同じ」「題の一部が同じ」と言い分けるために持つ。
 */
export interface DifferentIdWork {
  readonly workId: string;
  readonly by: "title" | "partial";
}

export type BackupMatch =
  /** 1つに決まった。**それでも取り込む前に作者へ見せる** */
  | {
      readonly kind: "matched";
      readonly by: Exclude<BackupMatchBy, "partial">;
      readonly workId: string;
      readonly differentId: readonly DifferentIdWork[];
    }
  /** 候補が2つ以上ある、または部分一致しかない。作者に選ばせる */
  | {
      readonly kind: "ambiguous";
      readonly by: BackupMatchBy;
      readonly workIds: readonly string[];
      readonly differentId: readonly DifferentIdWork[];
    }
  /** どれにも当たらない。新しい作品として取り込むかを作者に訊く */
  | { readonly kind: "none"; readonly differentId: readonly DifferentIdWork[] };

/**
 * 部分一致を候補にする、短いほうの題の長さの下限（そろえたあとの文字数）。
 *
 * 短い題（「夏」「旅」）で部分一致を取ると、ほとんどの作品が候補に
 * 入ってしまい、選ばせる意味が無くなる。
 */
const PARTIAL_MIN_LENGTH = 4;

/** 取り込みの点検結果から、見分けの手がかりを取り出す */
export function backupIdentityOf(inspection: WorkZipInspection): BackupIdentity {
  const ncode = inspection.narou?.header.ncode ?? null;
  return {
    site: inspection.site,
    workId: ncode ? ncode.toLowerCase() : null,
    // **作品情報の題を先に使う。** `inspection.title` はフォルダー名に
    // 使えない記号を落としたものなので、照らすには元の題のほうがよい
    title: inspection.info?.title?.trim() || inspection.title,
  };
}

/**
 * 題をそろえる。**比べるためだけの形**で、作者に見せたり書いたりはしない。
 *
 * - NFKC で全角英数・半角カナをそろえる（「ＡＢＣ」と「ABC」を同じに）
 * - 空白（全角も）をすべて落とす（「〜　別視点」と「〜 別視点」を同じに）
 * - フォルダー名に使えない記号を落とす（登録のときに落ちていることがある）
 * - 大文字小文字をそろえる
 */
export function normalizeWorkTitle(title: string): string {
  return title
    .normalize("NFKC")
    .replace(/[/\\:*?"<>|]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/** 作品IDをそろえる（Nコードは大文字小文字が揺れる） */
function normalizeSiteWorkId(workId: string): string {
  return workId.trim().toLowerCase();
}

/**
 * どの作品のバックアップかを決める。**書かない・訊かない**（純粋な判断だけ）。
 */
export function matchBackupToWorks(
  identity: BackupIdentity,
  works: readonly BackupMatchCandidate[]
): BackupMatch {
  const site = identity.site;
  const backupId = identity.workId ? normalizeSiteWorkId(identity.workId) : null;

  const idOf = (work: BackupMatchCandidate): string | null => {
    if (!site) return null;
    const found = work.siteIds.find((entry) => entry.site === site);
    return found && found.workId.trim() !== ""
      ? normalizeSiteWorkId(found.workId)
      : null;
  };

  // 1. サイトの作品IDで照らす
  if (site && backupId) {
    const byId = works.filter((work) => idOf(work) === backupId);
    if (byId.length === 1) {
      return {
        kind: "matched",
        by: "id",
        workId: byId[0].id,
        differentId: [],
      };
    }
    if (byId.length > 1) {
      // 同じIDが2作品に書いてある。どちらが正しいかは作者にしか分からない
      return {
        kind: "ambiguous",
        by: "id",
        workIds: byId.map((work) => work.id),
        differentId: [],
      };
    }
  }

  const key = normalizeWorkTitle(identity.title);
  if (key === "") return { kind: "none", differentId: [] };

  const namesOf = (work: BackupMatchCandidate): string[] =>
    [work.title, work.folderName]
      .map(normalizeWorkTitle)
      .filter((name) => name !== "");

  /*
    2. 題で照らす。**IDが食い違う作品は外す**——台帳にそのサイトの別の
    作品IDが書いてあるなら、題が同じでも別の作品である。

    **外したと言うのは、題で当たった作品だけ**（2026-09-23、実機）。
    題の違う作品は、IDを見るまでもなく候補ではない——そこまで「外した」と
    言うと、作者の環境ではどのなろうのバックアップでも同じ作品の名前が
    「題が同じですが」と出る。
  */
  const differentId: DifferentIdWork[] = [];
  const eligible = works.filter((work) => {
    const recorded = idOf(work);
    if (backupId && recorded && recorded !== backupId) {
      const names = namesOf(work);
      if (names.includes(key)) {
        differentId.push({ workId: work.id, by: "title" });
      } else if (names.some((name) => overlaps(name, key))) {
        differentId.push({ workId: work.id, by: "partial" });
      }
      return false;
    }
    return true;
  });

  const exact = eligible.filter((work) => namesOf(work).includes(key));
  if (exact.length === 1) {
    return { kind: "matched", by: "title", workId: exact[0].id, differentId };
  }
  if (exact.length > 1) {
    return {
      kind: "ambiguous",
      by: "title",
      workIds: exact.map((work) => work.id),
      differentId,
    };
  }

  // 3. 片方がもう片方を含む（派生作品・副題の付け外し）。**必ず選ばせる**
  const partial = eligible.filter((work) =>
    namesOf(work).some((name) => overlaps(name, key))
  );
  if (partial.length > 0) {
    return {
      kind: "ambiguous",
      by: "partial",
      workIds: partial.map((work) => work.id),
      differentId,
    };
  }

  return { kind: "none", differentId };
}

/** 短いほうが下限以上の長さで、長いほうに含まれるか */
function overlaps(a: string, b: string): boolean {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= PARTIAL_MIN_LENGTH && longer.includes(shorter);
}

/** 作者に見せる「何で当たったか」 */
export function describeMatchBy(
  by: BackupMatchBy,
  identity: BackupIdentity
): string {
  switch (by) {
    case "id":
      return identity.site === "narou"
        ? `Nコード（${identity.workId?.toUpperCase() ?? ""}）が一致`
        : "作品IDが一致";
    case "title":
      return "題が一致";
    case "partial":
      return "題の一部が一致";
  }
}
