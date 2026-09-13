import type * as vscode from "vscode";
import type { AdviceProfile } from "./advicePolicy";

/**
 * 助言方針の保存先（設計書6.86）。
 *
 * **`.aiwriter/config.json` には置かない。** あそこは作品と一緒に GitHub へ
 * 送られ、編集部と共有される。受容度（いまは指摘より感想がほしい）や
 * 自信度（面白くないのではと思っている）は、**他人に見せる情報ではない。**
 * 作者の手元にだけ残す。
 *
 * そのため `globalState`（VS Code の保管庫。AIの選択と同じ場所）を使う。
 * 端末をまたがないが、それでよい——引き継ぐほどの中身ではなく、
 * 移ったら聞き直せば済む（9問と2問）。
 */
export const ADVICE_POLICY_KEY_PREFIX = "novelai.advicePolicy.";

export function advicePolicyKey(workId: string): string {
  return `${ADVICE_POLICY_KEY_PREFIX}${workId}`;
}

/**
 * **作者ごとの既定**（0.51.1。設計書6.90.2）。
 *
 * 使用開始時の診断（6.90）は、まだ作品が1つも無いところで9問に答える。
 * 置き先が作品ごとしか無かったので、**その答えを捨てていた**——
 * 作者の指摘「診断に11タイプは入ってないということですか？」で分かった。
 *
 * 鍵を作品ごとの接頭辞と**別の形にする**。`novelai.advicePolicy.default` に
 * すると、`default` という ID の作品ができたときに踏み合う。
 */
export const ADVICE_POLICY_DEFAULT_KEY = "novelai.advicePolicyDefault";

export class AdvicePolicyStore {
  constructor(private readonly state: vscode.Memento) {}

  /** その作品だけの方針。**既定へは落ちない**（消したことを消したままにする） */
  get(workId: string): AdviceProfile | undefined {
    return this.state.get<AdviceProfile>(advicePolicyKey(workId));
  }

  /** 作者ごとの既定。使用開始時の診断で入る */
  getDefault(): AdviceProfile | undefined {
    return this.state.get<AdviceProfile>(ADVICE_POLICY_DEFAULT_KEY);
  }

  async setDefault(profile: AdviceProfile): Promise<void> {
    await this.state.update(ADVICE_POLICY_DEFAULT_KEY, profile);
  }

  /**
   * その作品で実際に使う方針。作品に無ければ**作者の既定**を使う。
   *
   * **読むだけでは書き写さない。** 相談が始まった時点で書き写すと、
   * 開いただけの作品にも方針が生えてしまう。書き写すのは
   * 推定が届いたとき（`workChatPanel` の `updateAdvicePolicy`）で、
   * そこから先はその作品が自分の値として持つ。
   */
  getEffective(workId: string): AdviceProfile | undefined {
    return this.get(workId) ?? this.getDefault();
  }

  async set(workId: string, profile: AdviceProfile): Promise<void> {
    await this.state.update(advicePolicyKey(workId), profile);
  }

  async clear(workId: string): Promise<void> {
    await this.state.update(advicePolicyKey(workId), undefined);
  }
}
