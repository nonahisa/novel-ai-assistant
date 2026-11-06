/**
 * 別名を別人に分ける前に、その呼び名が本文で**元の人物への呼びかけ**として
 * 使われているだけではないかを見る（作者の裁定 2026-11-06「分ける前に断る」。設計書6.5.8）。
 *
 * 実データ：「文佳」から「お嬢様」を分けたら、新しい記録は中身が空のまま残った。
 * 本文の「お嬢様」5か所は「お嬢様、副社長からお返事が」「文佳ちゃん、お嬢様なんだ」のように
 * どれも文佳への呼びかけで、抽出のAIも文佳の呼び名として読んでいたため。
 * 分けたあとで取り下げを持ちかける道（0.96.11）はあるが、分ける前に知らせれば
 * 作者は分けずに済む。
 *
 * ## 目安（AIは呼ばない。分ける確認の窓を開くたびに呼ぶと料金がかかる）
 *
 * 呼び名の出た所を1つずつ見て、次のどちらかなら「元の人物に向いている」と数える。
 *
 * - **呼びかけの形**：台詞（「」『』の中）で、呼び名のすぐ後が「、」「！」「？」「…」か台詞の終わり
 * - **元の人物と同じ所に出る**：同じ行か、前後1行に元の人物の名前か残る別名がある
 *
 * **全部がそうなら**知らせる。1つでも外れたら知らせない（別の人物として出ている所がある）。
 * 本文に1度も出ない呼び名も知らせない（見るものが無い）。
 *
 * **止めはしない。** 知らせは確認の窓の説明に1行足すだけで、分けるかどうかは作者が決める。
 * 本当に別の人物（例：作中に実在する別の「お嬢様」）でも、文佳と話す場面にしか出なければ
 * 知らせが出る——そのときは作者がそのまま分ければよい。
 *
 * vscode にもファイルにも触らない（本文は呼び出し側が読んで渡す）。
 */

export interface AliasUsage {
  /** 本文に出た回数 */
  total: number;
  /** そのうち、元の人物に向いていると見た回数 */
  towardOriginal: number;
}

/** 呼び名のすぐ後にこれが来たら、呼びかけの形と見る */
const ADDRESS_FOLLOWERS = new Set(["、", "，", ",", "！", "!", "？", "?", "…", "」", "』", "‥"]);

/**
 * @param alias 分けようとしている呼び名
 * @param originalNames 分けたあとも元の人物に残る名前と別名
 * @param texts 本文（話ごと・場面ごとの塊のままでよい）
 */
export function aliasUsageTowardOriginal(
  alias: string,
  originalNames: readonly string[],
  texts: readonly string[]
): AliasUsage {
  const wanted = alias.trim();
  const names = [...new Set(originalNames.map((name) => name.trim()))].filter(
    (name) => name && name !== wanted
  );
  const usage: AliasUsage = { total: 0, towardOriginal: 0 };
  if (!wanted) return usage;

  for (const text of texts) {
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      let from = line.indexOf(wanted);
      if (from < 0) return;
      // 前後1行に元の人物の名前があるか。**呼び名そのものを抜いてから**探す——
      // 呼び名が名前を含む（「文佳様」と「文佳」）と、どの行でも当たってしまう
      const nearby = lines
        .slice(Math.max(0, index - 1), index + 2)
        .map((near) => near.split(wanted).join("\n"))
        .join("\n");
      const besideOriginal = names.some((name) => nearby.includes(name));
      while (from >= 0) {
        usage.total += 1;
        if (besideOriginal || isAddress(line, from, wanted.length)) usage.towardOriginal += 1;
        from = line.indexOf(wanted, from + wanted.length);
      }
    });
  }
  return usage;
}

/** 本文での出方が、すべて元の人物に向いているか（知らせを出すか） */
export function aliasLooksAddressedToOriginal(usage: AliasUsage): boolean {
  return usage.total > 0 && usage.towardOriginal === usage.total;
}

/** 台詞の中で、呼び名のすぐ後に区切りが来ているか */
function isAddress(line: string, at: number, length: number): boolean {
  const before = line.slice(0, at);
  const open = Math.max(before.lastIndexOf("「"), before.lastIndexOf("『"));
  const close = Math.max(before.lastIndexOf("」"), before.lastIndexOf("』"));
  if (open < 0 || open < close) return false;
  const next = line.charAt(at + length);
  return ADDRESS_FOLLOWERS.has(next);
}
