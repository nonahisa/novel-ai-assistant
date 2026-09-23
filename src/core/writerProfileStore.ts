import type * as vscode from "vscode";
import {
  buildWriterStyle,
  parseWriterReviseStreak,
  type WriterReviseStreak,
  type WriterStyle,
} from "./writerStyle";

/**
 * 作家タイプ診断の保存先（設計書6.90）。
 *
 * **作者ごとに1つ。作品ごとではない。** 段取り・直す時期・設定の持ち方・
 * 出し先は、作品を変えても大きくは変わらない癖である。作品ごとに持つと、
 * 新しい作品を作るたびに5問聞き直すことになる。
 *
 * **`.aiwriter/config.json` には置かない**（6.86 と同じ理由）。あそこは
 * 作品と一緒に GitHub へ送られ、編集部と共有される。「設定は頭の中にある」
 * 「まだ出し先を決めていない」は、他人に見せる情報ではない。
 *
 * そのため `globalState` を使う。端末をまたがないが、移ったら5問答え直せば済む。
 */
export const WRITER_PROFILE_KEY = "novelai.writerProfile";

/** はじめの声かけを出したか（出すのは1回きり） */
export const WRITER_WELCOME_KEY = "novelai.writerWelcome";

/** はじめの声かけの、作者の返事 */
export type WelcomeState =
  /** 「あとで」。次に立ち上げたときにもう一度だけ出す */
  | "later"
  /** 診断した、または「二度と出さない」。もう出さない */
  | "done";

export interface WriterProfile {
  style: WriterStyle;
  /** 診断した日時（ISO） */
  updatedAt: string;
  /**
   * 直す時期（S2）が続けて読み取れた回数（設計書6.90.1）。
   *
   * **数えをここ（保存の中）に置くのは、相談が日をまたぐからである。**
   * パネルの中や実行中のメモリに置くと、VS Code を閉じた時点で消える
   * ——「2回続けて」が実質成立しなくなり、歯止めが歯止めでなくなる。
   * 逆に、ここに置けば端末をまたがない（`globalState`）ことも都合がよい：
   * 別の端末での読み取りと足し合わさらない。
   *
   * **無くても読める形にする**（この項目が入る前に保存した記録がある）。
   */
  reviseStreak?: WriterReviseStreak;
}

export class WriterProfileStore {
  /**
   * @param onChange 答えが変わったら呼ぶ（保存のあと）。**控えの書き出しに使う**
   *   （`features/adviceProfileMirror.ts` の `refreshWriterProfileMirror`。
   *   2026-09-23）。書き出しを呼び出し側の各所へ足して回ると、足し忘れた道
   *   からの変更だけが外部AIへ届かない——`AdvicePolicyStore` と同じ理由で
   *   ここへ1か所置く。受け取る側で待たない
   */
  constructor(
    private readonly state: vscode.Memento,
    private readonly onChange?: () => void
  ) {}

  /**
   * 診断の結果。まだなら `undefined`。
   *
   * **読むときも `buildWriterStyle` を通す。** 古い版で保存した値や、
   * 手で書き換えた値が入っていたら、黙って使わずに「まだ診断していない」
   * として扱う——半端な値で案内を組み立てるより、聞き直すほうがよい。
   */
  get(): WriterProfile | undefined {
    const raw = this.state.get<{
      style?: unknown;
      updatedAt?: unknown;
      reviseStreak?: unknown;
    }>(WRITER_PROFILE_KEY);
    if (!raw || typeof raw.style !== "object" || raw.style === null) {
      return undefined;
    }
    const style = buildWriterStyle(raw.style as Record<string, unknown>);
    if (!style) return undefined;
    // **数えが壊れていても、答えは捨てない。** 数えは途中経過にすぎないので、
    // 読めなければ「数えていない」に戻せばよい（診断の答えのほうは残す）
    const reviseStreak = parseWriterReviseStreak(raw.reviseStreak);
    return {
      style,
      updatedAt:
        typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
      ...(reviseStreak ? { reviseStreak } : {}),
    };
  }

  /**
   * 診断の答えを入れ直す。
   *
   * **相談からの読み取りの数えは持ち越さない。** 作者がいま5問に答えた
   * のだから、その前の会話から数えていた途中経過は用済みである
   * （持ち越すと、答え直した直後に1回の読み取りで書き換わる）。
   */
  async set(style: WriterStyle): Promise<void> {
    const profile: WriterProfile = {
      style,
      updatedAt: new Date().toISOString(),
    };
    await this.state.update(WRITER_PROFILE_KEY, profile);
    this.onChange?.();
  }

  /**
   * 相談からの読み取りを反映した記録を、そのまま書く（設計書6.90.1）。
   *
   * **`set` と分ける。** あちらは作者が答えた瞬間で、診断日（`updatedAt`）を
   * 今日にする。こちらは推定の反映なので、**診断日を動かしてはいけない**
   * ——動かすと、相談のたびに「作者が答えた日」が今日へ書き換わる。
   */
  async update(profile: WriterProfile): Promise<void> {
    await this.state.update(WRITER_PROFILE_KEY, profile);
    this.onChange?.();
  }

  /**
   * 答えを消す。**はじめての声かけの記憶も、一緒に消す**（0.52.3）。
   *
   * 答えを捨てたのなら、その人は「まだ診断していない人」である。
   * 声かけの記憶だけ「済み」で残ると、**二度と最初から試せない**——
   * 実機で初回の流れを確かめたい作者が、そこで詰まる
   * （作者の報告、2026-09-13「テストのためタイプ診断をやり直したい
   * のですが、方法がよくわかりません」）。
   *
   * 声かけそのものを止めたい人は、声かけの「出さない」を押せばよい。
   */
  async clear(): Promise<void> {
    await this.state.update(WRITER_PROFILE_KEY, undefined);
    await this.state.update(WRITER_WELCOME_KEY, undefined);
    // 控えからも消す（残すと、消した答えで外部AIが助言し続ける）
    this.onChange?.();
  }

  /** はじめの声かけを、もう出してよいか */
  welcomeState(): WelcomeState | undefined {
    const raw = this.state.get<string>(WRITER_WELCOME_KEY);
    return raw === "later" || raw === "done" ? raw : undefined;
  }

  async setWelcomeState(next: WelcomeState): Promise<void> {
    await this.state.update(WRITER_WELCOME_KEY, next);
  }
}
