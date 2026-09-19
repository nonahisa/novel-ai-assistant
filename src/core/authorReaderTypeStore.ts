import type * as vscode from "vscode";
import type { AuthorReaderProfile } from "./authorReaderType";

/**
 * 作者自身の読者タイプの保存先（設計書6.101）。
 *
 * **作品の `設定/読者像.json` には置かない。** あそこは作品ごとの台帳で、
 * GitHubへ送られて編集部とも共有される。ここに入るのは
 * **作者自身が読者として何を求めるか**であって、作品の情報ではない。
 * 作品の数だけ写しができるのも困る（作者ごとに1つだから）。
 *
 * そのため `globalState`（VS Code の保管庫。助言方針 6.86 と同じ場所）を使う。
 * 端末をまたがないが、それでよい——移ったら聞き直せば済む（9問）。
 */

/**
 * 保管庫の鍵。
 *
 * **助言方針の接頭辞（`novelai.advicePolicy.`）と踏み合わない形にする。**
 * あちらは作品IDを後ろに足す鍵なので、似た形にすると
 * 作品IDしだいで踏み合う（`advicePolicyStore.ts` の既定の鍵と同じ用心）。
 */
export const AUTHOR_READER_TYPE_KEY = "novelai.authorReaderType";

export class AuthorReaderTypeStore {
  constructor(private readonly state: vscode.Memento) {}

  /** まだ答えていなければ `undefined`（**推測で埋めない**） */
  get(): AuthorReaderProfile | undefined {
    return this.state.get<AuthorReaderProfile>(AUTHOR_READER_TYPE_KEY);
  }

  async set(profile: AuthorReaderProfile): Promise<void> {
    await this.state.update(AUTHOR_READER_TYPE_KEY, profile);
  }

  async clear(): Promise<void> {
    await this.state.update(AUTHOR_READER_TYPE_KEY, undefined);
  }
}
