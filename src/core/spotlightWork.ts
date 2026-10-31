/**
 * 相談から光らせた**詳細メニューの項目**に、相談の作品を一時的に結びつける
 * （作者の判断 2026-11-01「合わせる」。設計書6.104）。
 *
 * ## なぜ要るか
 *
 * 簡単ステップメニューの項目は作品を持っている（メニューの作品を相談の作品へ
 * 合わせれば済む。`StepMenuProvider.alignWorkForSpotlight`）。詳細メニューの
 * 項目は作品を持たず、押すと `pickHintedWork`（作品一覧の選択 → 相談の作品 →
 * 訊く。6.68.2）で決まる。そのため**作品一覧で別の作品を選んでいると、
 * 相談から光らせた項目が作品一覧の作品で走っていた**。
 *
 * ## なぜ作品一覧の選択を動かさないか
 *
 * 作品一覧の選択は、作者が自分で選んだ「いま見ている作品」である。光らせる
 * たびに勝手に動かすと、相談と関係なく詳細メニューを押したときの作品まで
 * 替わる。**ここでは「光らせたその項目を、次に押した1回」だけ**を相談の作品に
 * する。ふだんの詳細メニューの動きは変えない。
 *
 * ## 1回使ったら消える
 *
 * 押して確認の窓でやめたあと、作品一覧で作品を選び直してから押し直すことも
 * ある。結びつきを残し続けると、作者が選び直した作品より古い光らせが勝つ。
 * 迷ったら、ふだんの決め方（作品一覧の選択が先）へ戻す。
 *
 * VS Code API に依存しない。
 */
export class SpotlightWorkBinding {
  private bound: { readonly command: string; readonly workId: string } | undefined;

  /** 光らせた項目と相談の作品を結ぶ。**前の結びつきは捨てる**（光るのは1つだけ） */
  bind(command: string, workId: string): void {
    this.bound = { command, workId };
  }

  /** 結びつきを捨てる（光らせ直したとき・案内が終わったとき） */
  clear(): void {
    this.bound = undefined;
  }

  /**
   * 押された操作が光らせた項目なら、結んだ作品を返して**結びつきを消す**。
   * 別の操作なら何も返さず、結びつきも残す（光っている項目はまだ押されていない）。
   */
  take(command: string): string | undefined {
    if (!this.bound || this.bound.command !== command) return undefined;
    const { workId } = this.bound;
    this.bound = undefined;
    return workId;
  }
}
