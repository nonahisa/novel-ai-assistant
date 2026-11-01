import { PostingStore } from "../core/postingStore";
import {
  readerStatsAlreadyImported,
  routeReaderStatsBundleItem,
  routeReaderStatsRanking,
  type ReaderStatsWorkCandidate,
} from "../core/readerStatsHelperLink";
import {
  rankingRecordFromHelper,
  type ReaderStatsBundle,
  type ReaderStatsEnvelope,
  type ReaderStatsRanking,
} from "../core/readerStatsEnvelope";
import { hasHelperRankingOn } from "../models/posting";
import { logFailure, useLogFile } from "../core/logger";
import { messageOf } from "../core/errorMessage";
import type { WorkEntry } from "../models/types";
import { importReaderStatsBundle } from "./readerStats";

/**
 * 控えておいた「未登録の自分の作品」の読者の反応を、登録した作品へ取り込む
 * （作者の判断 2026-11-01「自分の管理画面で読んだ作品は訊かずに取り込む」。設計書6.99.8）。
 *
 * **取り込みは束の取り込みと同じ関数**（`importReaderStatsBundle`）を通す。振り分けの関所
 * （台帳の作品IDで1つに決まるか）・積み方（同じ数は二重に積まない）・知らせのまとめ方を
 * 写さないため。
 *
 * ## 渡すのは、作品が1つに決まる画面だけ
 *
 * 決まらない画面まで渡すと「取り込めなかったもの」の注意と［作品に登録する］が出る。
 * 控えはまだ登録されていない作品のためのものなので、決まらない画面は**知らせずに控えに残す**
 * （理由は記録へ。次に登録されたときにまた見る。上限と日数で古いものから捨てる）。
 *
 * ## 控えから外すのは、台帳に入ったと確かめた画面だけ
 *
 * 束の取り込みは保存に失敗しても例外を投げない（記録に残して知らせる）。取り込んだあと
 * 台帳を読み直し、**同じ記録が入っている画面だけ**を控えから外す（入っていなければ残す）。
 *
 * ## 決まらなかった画面は、理由を操作の記録に残す（2026-11-01 作者の実機）
 *
 * ここへ来るのは「登録済み」と見た作品の画面なので、決まらないのは台帳に作品ID が無い
 * （取り込みが書けなかった・サイトが違った）か、同じ作品ID の作品が2つあるときである。
 * 黙って残すと「控えは残っているのに何も起きていない」ことに誰も気づけない。
 *
 * ## 知らせを出さないとき（`silent`）
 *
 * バックアップからの登録の途中で取り込むときは、**登録の知らせが取り込んだ画面の数を言う**。
 * 束の取り込みの知らせまで出すと、同じことを2つの知らせで言うことになる（記録には残る）。
 *
 * 読み込むのは `extension.ts` の閉包から動的 import するときだけ（起動を重くしない）。
 */
export async function importHeldOwnWorkStats(
  envelopes: readonly ReaderStatsEnvelope[],
  works: readonly WorkEntry[],
  lead: string,
  options: { readonly silent?: boolean } = {}
): Promise<{
  /** まだ台帳に入っていない画面（控えに残す） */
  readonly remaining: readonly ReaderStatsEnvelope[];
  /** 台帳を書き換えた作品（執筆統計を作り直す） */
  readonly changedWorks: readonly WorkEntry[];
}> {
  const before = await loadCandidates(works);
  const routed: ReaderStatsEnvelope[] = [];
  const routedTo = new Map<ReaderStatsEnvelope, string>();
  for (const envelope of envelopes) {
    const route = routeReaderStatsBundleItem(envelope, before);
    if (route.kind !== "work") {
      useLogFile(undefined);
      logFailure("控えた読者の反応の取り込み先を決める", {
        作品: `${envelope.title ?? "（題なし）"}（${envelope.site} ${envelope.workId ?? "作品IDなし"}）`,
        詳細: `${route.reason}（控えに残し、次に作品一覧を描き直したときにもう一度試します）`,
      });
      continue;
    }
    routed.push(envelope);
    routedTo.set(envelope, route.id);
  }
  if (routed.length === 0) return { remaining: envelopes, changedWorks: [] };

  const bundle: ReaderStatsBundle = {
    items: routed.map((envelope, index) => ({
      position: index + 1,
      result: { ok: true, envelope },
    })),
  };
  const result = await importReaderStatsBundle(bundle, works, {
    lead,
    ...(options.silent ? { silent: true } : {}),
  });

  const after = await loadCandidates(works.filter((work) => [...routedTo.values()].includes(work.id)));
  const remaining = envelopes.filter((envelope) => {
    const id = routedTo.get(envelope);
    if (id === undefined) return true;
    const ledger = after.find((candidate) => candidate.id === id)?.ledger;
    return !ledger || !readerStatsAlreadyImported(envelope, ledger);
  });
  return { remaining, changedWorks: result.changedWorks ?? [] };
}

/**
 * 控えておいた「未登録の自分の作品」の順位を、登録した作品へ取り込む（2026-11-02）。
 *
 * 画面の控えと同じく**束の取り込みと同じ関数**を通す（振り分けの関所・同じ鍵は積まない）。
 * **知らせは出さない**——読者の反応の控えを移した知らせと重ねない（記録には残る。積んだ順位の
 * お祝いは台帳の保存から出る）。取り込んだあと台帳を読み直し、入った順位だけを控えから外す。
 */
export async function importHeldOwnWorkRankings(
  rankings: readonly ReaderStatsRanking[],
  works: readonly WorkEntry[]
): Promise<{
  /** まだ台帳に入っていない順位（控えに残す） */
  readonly remaining: readonly ReaderStatsRanking[];
  readonly changedWorks: readonly WorkEntry[];
}> {
  const before = await loadCandidates(works);
  const routedTo = new Map<ReaderStatsRanking, string>();
  for (const ranking of rankings) {
    const route = routeReaderStatsRanking(ranking, before);
    if (route.kind === "work") routedTo.set(ranking, route.id);
  }
  if (routedTo.size === 0) return { remaining: rankings, changedWorks: [] };
  const bundle: ReaderStatsBundle = {
    items: [],
    rankings: [...routedTo.keys()].map((ranking, index) => ({
      position: index + 1,
      result: { ok: true, ranking },
    })),
  };
  const result = await importReaderStatsBundle(bundle, works, { silent: true });
  const after = await loadCandidates(works.filter((work) => [...routedTo.values()].includes(work.id)));
  const remaining = rankings.filter((ranking) => {
    const id = routedTo.get(ranking);
    if (id === undefined) return true;
    const ledger = after.find((candidate) => candidate.id === id)?.ledger;
    return !ledger || !hasHelperRankingOn(ledger, rankingRecordFromHelper(ranking));
  });
  return { remaining, changedWorks: result.changedWorks ?? [] };
}

/** 各作品の投稿状態を読む。**読めない作品は振り分けの先から外す**（直さずに止める） */
async function loadCandidates(works: readonly WorkEntry[]): Promise<ReaderStatsWorkCandidate[]> {
  const out: ReaderStatsWorkCandidate[] = [];
  for (const work of works) {
    try {
      out.push({ id: work.id, ledger: await new PostingStore(work).load() });
    } catch (error) {
      useLogFile(work.folderPath);
      logFailure("控えた読者の反応の取り込み先を探す", {
        作品: work.title,
        詳細: messageOf(error),
      });
    }
  }
  return out;
}
