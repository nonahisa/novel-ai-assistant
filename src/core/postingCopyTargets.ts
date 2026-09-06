import {
  POSTING_SITES,
  postingSiteInfo,
  type PostingSiteId,
} from "../models/posting";
import { EMPHASIS_SITES, RUBY_STYLES, type EmphasisSite, type RubyStyle } from "./ruby";

/**
 * 「投稿サイト用に変換してコピー」で訊く、貼り付け先の一覧
 * （作者の裁定、2026-09-06。設計書6.12.4）。
 *
 * **訊くのは貼り付け先だけにする。** それまでは2段だった——
 * 1段目で「どの形で書き出すか」（投稿サイト用／アルファポリス旧記法／
 * HTML）を訊き、傍点があるときだけ2段目で「貼り付け先のサイト」を訊いて
 * いた。1段目は**記法**を訊いており、作者は自分の貼り付け先がどの記法に
 * 当たるのかを記号から逆算させられていた。
 *
 * **サイトが決まれば記法は決まる。** その対応表は既に
 * `models/posting.ts` の `POSTING_SITES`（`notation`・`emphasis`）にある
 * ので、ここでは**引くだけ**にする——書き写すと、サイトの記法が変わった
 * ときに片方だけが直る日が来る。
 *
 * VS Code API には依存しない（画面は `features/ruby.ts` が持つ）。
 */

export interface PostingCopyTarget {
  /**
   * どのサイトか。**記法だけで決まる書き出し先（別記法・HTML）には無い。**
   *
   * 記法（`style`）では貼り付け先を見分けられない——noteは
   * **Markdownをそのまま解釈する**ので、ルビの落とし方（`paren`）だけでは
   * 済まず、貼る形そのものを整え直す（`core/postingConvert.ts`）。
   * 「`paren` ならnote」と読むと、あとで同じ記法のサイトが増えたときに
   * 別のサイトまでnoteの整えを通ることになる。
   */
  site?: PostingSiteId;
  /** 画面に出す名前。**サイト名で並べる**（記法の記号では選べない） */
  label: string;
  /** 選ぶ手がかり。ルビ・傍点がどう出るかを一言で */
  detail: string;
  /** 変換に渡す記法（`core/ruby.ts` の `toSiteNotation`） */
  style: RubyStyle["id"];
  /** 傍点の書き方。`style` が `site` のときだけ効く */
  emphasis: EmphasisSite;
  /** 投稿状態の台帳に登録してある投稿先か。先頭に寄せる印 */
  registered: boolean;
}

/** 傍点の説明は `EMPHASIS_SITES` から引く（言い回しの写しを作らない） */
function emphasisDetail(emphasis: EmphasisSite): string {
  return (
    EMPHASIS_SITES.find((entry) => entry.id === emphasis)?.detail ??
    "ルビと傍点を投稿サイトの書き方にします"
  );
}

function detailFor(site: PostingSiteId): string {
  const info = postingSiteInfo(site);
  if (info.notation === "paren") {
    // **noteにはルビの記法が無い**（設計書6.68.3）。記号がそのまま
    // 読者の目に入るので、読みは括弧で本文の中へ落とす
    return "ルビは括弧書き（漢字（かんじ））にします。傍点の印は外します";
  }
  return emphasisDetail(info.emphasis);
}

/** 記法だけで決まる書き出し先（サイトを選ぶ画面の、いちばん後ろ） */
function styleTarget(id: RubyStyle["id"], label?: string): PostingCopyTarget {
  const style = RUBY_STYLES.find((entry) => entry.id === id);
  // 一覧に無いのは書き間違えのとき。押しても何も起きないより、気づける形で
  if (!style) throw new Error(`記法 ${id} が RUBY_STYLES にありません`);
  return {
    label: label ?? style.label,
    detail: style.detail,
    style: style.id,
    // 傍点の出し方がその記法だけで決まるので、ここは効かない
    emphasis: "kakuyomu",
    registered: false,
  };
}

/**
 * 貼り付け先の選択肢を、作者に見せる順で組み立てる。
 *
 * @param registered 投稿状態の台帳に登録してある投稿先。
 *   **先頭へ寄せる**——毎回同じサイトへ貼る作者に、毎回同じだけ
 *   探させない。登録どうしの順は `POSTING_SITES` の並び（作者が投稿する順）
 *   のままにする（呼ぶ場所ごとに順番が変わらないように）
 */
export function postingCopyTargets(
  registered: readonly PostingSiteId[]
): PostingCopyTarget[] {
  const sites = POSTING_SITES.map((info) => ({
    site: info.id,
    label: info.label,
    detail: detailFor(info.id),
    style: info.notation,
    emphasis: info.emphasis,
    registered: registered.includes(info.id),
  }));

  return [
    ...sites.filter((target) => target.registered),
    ...sites.filter((target) => !target.registered),
    /*
      **サイトの一覧から漏れるものを、2つだけ残す。**

      - アルファポリスの別記法：`｜漢字《かんじ》` で不都合が出たときの
        逃げ道である（0.30.7 以前からある）。サイトを選ぶ形に変えたので
        既定では通らなくなるが、**逃げ道を黙って塞がない**
      - HTML：自分のサイトやEPUBへ持っていく先。投稿サイトではないので
        いちばん後ろに置く
    */
    styleTarget("alphapolis-hash", "アルファポリス（別記法）"),
    styleTarget("html"),
  ];
}
