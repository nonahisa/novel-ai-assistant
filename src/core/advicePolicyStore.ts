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

export class AdvicePolicyStore {
  constructor(private readonly state: vscode.Memento) {}

  /** 作品の方針。診断していなければ undefined（相談は素の状態で動く） */
  get(workId: string): AdviceProfile | undefined {
    return this.state.get<AdviceProfile>(advicePolicyKey(workId));
  }

  async set(workId: string, profile: AdviceProfile): Promise<void> {
    await this.state.update(advicePolicyKey(workId), profile);
  }

  async clear(workId: string): Promise<void> {
    await this.state.update(advicePolicyKey(workId), undefined);
  }
}
