import type * as vscode from "vscode";
import { buildWriterStyle, type WriterStyle } from "./writerStyle";

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
}

export class WriterProfileStore {
  constructor(private readonly state: vscode.Memento) {}

  /**
   * 診断の結果。まだなら `undefined`。
   *
   * **読むときも `buildWriterStyle` を通す。** 古い版で保存した値や、
   * 手で書き換えた値が入っていたら、黙って使わずに「まだ診断していない」
   * として扱う——半端な値で案内を組み立てるより、聞き直すほうがよい。
   */
  get(): WriterProfile | undefined {
    const raw = this.state.get<{ style?: unknown; updatedAt?: unknown }>(
      WRITER_PROFILE_KEY
    );
    if (!raw || typeof raw.style !== "object" || raw.style === null) {
      return undefined;
    }
    const style = buildWriterStyle(raw.style as Record<string, unknown>);
    if (!style) return undefined;
    return {
      style,
      updatedAt:
        typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
    };
  }

  async set(style: WriterStyle): Promise<void> {
    const profile: WriterProfile = {
      style,
      updatedAt: new Date().toISOString(),
    };
    await this.state.update(WRITER_PROFILE_KEY, profile);
  }

  async clear(): Promise<void> {
    await this.state.update(WRITER_PROFILE_KEY, undefined);
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
