import type { AddressForm, Character } from "../models/character";
import {
  createNameResolver,
  type UnresolvedReason,
} from "./characterNameResolve";

/**
 * 登場人物どうしの呼び合い（設計書6.92）。
 *
 * 作者の依頼（2026-09-13）：「人物設定のパネルに、登場人物間の二人称を
 * 表示させることは可能でしょうか？　本編から開いている場合には、その話で
 * 登場している人物のみ表示するとか。」
 *
 * ## 材料はもう揃っている
 *
 * 人物レコードの `addressTerms`（誰を・どう呼ぶか）を組み替えるだけである。
 * **AIを呼ばない。** 設定資料集（Markdown）と人物相関図では既に出していて、
 * 設定資料パネルにだけ出ていなかった。
 *
 * ## 半分は壊れている
 *
 * 実データ（ハイエルフ未亡人、呼び方48件）で測ると、**25件が自分あて**
 * （コリンナ → コリンナ）、7件が資料に無い相手だった。抽出が「呼び方」と
 * 「呼ばれ方」を取り違えており、呼称そのもの（「おひいさま」）を相手の
 * 名前として持っているものもある。そのまま並べると3件に2件が意味を成さない。
 *
 * **黙って捨てない**（作者の裁定、2026-09-13「畳んで『要確認』に出す」）。
 * 捨てると、抽出が壊れていることに気づく機会が消える。使えるものと
 * 要確認を分けて返し、画面の側が要確認を畳む。
 *
 * ## 名前の照合は分け合う
 *
 * 相手の名前を人物レコードへ当てる規則は `characterNameResolve.ts` に
 * 置いてある（相関図と共通）。写しを作ると片方だけ直る日が来る。
 *
 * VS Code APIに依存しない。
 */

/**
 * 要確認になった理由。
 *
 * - `self`：自分自身を相手にしている（抽出が呼ばれ方を取り違えた）
 * - `notFound`：その名前の人物が資料に居ない
 * - `ambiguous`：同じ名前の人物が複数居て、どちらか決められない
 */
export type AddressIssue = "self" | UnresolvedReason;

export const ADDRESS_ISSUE_LABELS: Record<AddressIssue, string> = {
  self: "自分あて",
  notFound: "資料に無い相手",
  ambiguous: "同じ名前が複数",
};

/** 1つの呼び方 */
export interface AddressUse {
  term: string;
  category: string | null;
  /** どんなときの言い方か（「人前では」） */
  context: string | null;
  firstChapter: number | null;
  lastChapter: number | null;
  /** いま使っているか。`past` は作中で呼び方が変わった名残 */
  status: "current" | "past";
}

/** AがBをどう呼ぶか、の1組 */
export interface AddressPair {
  fromId: string;
  fromName: string;
  /** 資料に当たらなければ null（名前だけが残る） */
  toId: string | null;
  toName: string;
  uses: AddressUse[];
  /** 要確認の理由。使えるものには付かない */
  issue?: AddressIssue;
}

export interface AddressPairs {
  /** そのまま読める組 */
  usable: AddressPair[];
  /** **畳んで出す**（黙って捨てない） */
  needsCheck: AddressPair[];
}

function useOf(form: AddressForm): AddressUse | undefined {
  const term = (form.term ?? "").trim();
  if (!term) return undefined;
  return {
    term,
    category: form.category,
    context: form.context,
    firstChapter: form.firstChapter,
    lastChapter: form.lastChapter,
    // 知らない値は「いま使っている」に寄せる。作者が手で書いた台帳も通る
    status: form.status === "past" ? "past" : "current",
  };
}

/**
 * 人物レコードから、呼び合いの組を作る。
 *
 * **同じ相手への呼び方はまとめる。** 「先生」「マイナ先生」を別の組に
 * すると、1人の相手が2行に分かれて誰が誰を呼んでいるのか読めなくなる。
 */
export function buildAddressPairs(
  characters: readonly Character[]
): AddressPairs {
  const resolve = createNameResolver(characters);
  const byId = new Map(characters.map((character) => [character.id, character]));

  const usable = new Map<string, AddressPair>();
  const needsCheck = new Map<string, AddressPair>();

  for (const character of characters) {
    for (const term of character.addressTerms ?? []) {
      const toName = (term.targetName ?? "").trim();
      if (!toName) continue;

      const uses = (term.forms ?? [])
        .map(useOf)
        .filter((use): use is AddressUse => use !== undefined);
      if (uses.length === 0) continue;

      // idがあればそれを信じる。ただし指し先が消えていることがあるので、
      // そのときは名前の照合へ落とす（組ごと消さない）
      const resolved =
        term.targetId && byId.has(term.targetId)
          ? { id: term.targetId, reason: null as UnresolvedReason | null }
          : resolve(toName);

      const issue: AddressIssue | undefined =
        resolved.id === character.id
          ? "self"
          : (resolved.reason ?? undefined);

      const target = resolved.id ? byId.get(resolved.id) : undefined;
      const pair: AddressPair = {
        fromId: character.id,
        fromName: character.name,
        toId: issue ? null : (resolved.id ?? null),
        toName: target && !issue ? target.name : toName,
        uses,
        ...(issue ? { issue } : {}),
      };

      const box = issue ? needsCheck : usable;
      // **鍵はJSONで作る**（`relationGraph.ts` の `keyOf` と同じ流儀）。
      // 区切り字をつなぐと、名前に同じ字が入ったときに
      // 別の組が同じ鍵になる（人物名は作者が自由に付けられる）
      const key = JSON.stringify([
        pair.fromId,
        pair.toId ?? pair.toName,
        issue ?? "",
      ]);
      const found = box.get(key);
      if (found) found.uses.push(...uses);
      else box.set(key, pair);
    }
  }

  return {
    usable: [...usable.values()],
    needsCheck: [...needsCheck.values()],
  };
}

/**
 * その話に出る人どうしの呼び合いだけにする（作者の依頼、2026-09-13）。
 *
 * **両方がその話に出ていること**を条件にする。片方だけで絞ると、
 * その話に居ない相手への呼び方まで並び、「この話の会話」を書くのに使えない。
 *
 * **登場話数を持たない人物は落とさない。** `appearedChapters` が空なのは
 * 「出ていない」ではなく「まだ数えていない」ことがある（作者が手で足した
 * レコード）。落とすと、手で書いた人物だけが黙って消える。
 */
export function pairsInChapter(
  pairs: readonly AddressPair[],
  chapter: number,
  characters: readonly Character[]
): AddressPair[] {
  const appears = new Map<string, boolean>();
  for (const character of characters) {
    const chapters = character.appearedChapters ?? [];
    appears.set(character.id, chapters.length === 0 || chapters.includes(chapter));
  }
  const here = (id: string | null): boolean =>
    id === null ? true : (appears.get(id) ?? true);

  return pairs.filter((pair) => here(pair.fromId) && here(pair.toId));
}

/**
 * その呼び方が、その話の時点で使われているか。
 *
 * **範囲を持たないものは「使っている」と読む。** 話数が入っていないのは
 * 抽出が取れなかっただけで、使っていない証拠ではない。
 */
export function useCoversChapter(use: AddressUse, chapter: number): boolean {
  if (use.firstChapter === null && use.lastChapter === null) return true;
  const from = use.firstChapter ?? Number.NEGATIVE_INFINITY;
  const to = use.lastChapter ?? Number.POSITIVE_INFINITY;
  return chapter >= from && chapter <= to;
}

/** ある人物から見た呼び合い（この人が呼ぶ／この人が呼ばれる） */
export interface AddressesOfCharacter {
  /** この人 → 相手 */
  calls: AddressPair[];
  /** 相手 → この人 */
  calledBy: AddressPair[];
}

export function addressesOf(
  pairs: readonly AddressPair[],
  characterId: string
): AddressesOfCharacter {
  return {
    calls: pairs.filter((pair) => pair.fromId === characterId),
    calledBy: pairs.filter((pair) => pair.toId === characterId),
  };
}

/**
 * 画面に出す1行。
 *
 * **話数の範囲は、あるときだけ添える。** 「第1〜3話」が付いていない
 * 呼び方のほうが多いので、無いものに「（話数不明）」と書くと
 * その断りばかりが並ぶ。
 */
export function describeUse(use: AddressUse): string {
  const parts = [use.term];
  const range = describeRange(use);
  if (range) parts.push(`（${range}）`);
  if (use.context) parts.push(`／${use.context}`);
  if (use.status === "past") parts.push("［いまは使わない］");
  return parts.join("");
}

function describeRange(use: AddressUse): string {
  if (use.firstChapter === null && use.lastChapter === null) return "";
  if (use.firstChapter === null) return `第${use.lastChapter}話まで`;
  if (use.lastChapter === null) return `第${use.firstChapter}話から`;
  if (use.firstChapter === use.lastChapter) return `第${use.firstChapter}話`;
  return `第${use.firstChapter}〜${use.lastChapter}話`;
}

/** 組を1行にまとめる（「コリンナ → ナイン：おひいさま」） */
export function describePair(pair: AddressPair): string {
  const terms = pair.uses.map(describeUse).join("・");
  return `${pair.fromName} → ${pair.toName}：${terms}`;
}
