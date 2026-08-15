import { describe, expect, test } from "vitest";
import {
  buildSetupPlan,
  describeSetupPlan,
  REQUIREMENTS,
  totalSizeLabel,
  type RequirementId,
  type RequirementState,
} from "../../src/core/requirements";
import {
  interpretWingetResult,
  shortenProgress,
  stripControl,
} from "../../src/core/packageInstall";

function states(
  overrides: Partial<Record<RequirementId, boolean>>
): RequirementState[] {
  return REQUIREMENTS.map((requirement) => ({
    id: requirement.id,
    present: overrides[requirement.id] ?? false,
  }));
}

describe("何を入れればよいかの組み立て", () => {
  test("Ollamaが無いときは、モデルを「足りない」に並べない", () => {
    // Ollamaが無ければモデルは取得しようがない。2件並べると
    // 作者はどちらから手を付けるべきか分からなくなる
    const plan = buildSetupPlan(states({}));
    const missing = [...plan.missingRequired, ...plan.missingOptional].map(
      (entry) => entry.requirement.id
    );

    expect(missing).toContain("ollama");
    expect(missing).not.toContain("chatModel");
    expect(missing).not.toContain("embeddingModel");
  });

  test("Ollamaが入ったら、会話モデルが必須として出る", () => {
    const plan = buildSetupPlan(states({ ollama: true }));

    expect(plan.missingRequired.map((e) => e.requirement.id)).toContain(
      "chatModel"
    );
  });

  test("埋め込みモデルは任意にとどめる", () => {
    // 非力な機械では入れないほうが軽く動く。必須にすると
    // 1.2GBの取得を全員に強いることになる
    const plan = buildSetupPlan(states({ ollama: true }));

    expect(plan.missingOptional.map((e) => e.requirement.id)).toContain(
      "embeddingModel"
    );
    expect(plan.missingRequired.map((e) => e.requirement.id)).not.toContain(
      "embeddingModel"
    );
  });

  test("すべて入っていれば完了になる", () => {
    const plan = buildSetupPlan(
      states({
        ollama: true,
        chatModel: true,
        embeddingModel: true,
        git: true,
        gh: true,
      })
    );

    expect(plan.complete).toBe(true);
    expect(plan.missingRequired).toEqual([]);
  });

  test("GitとGitHub CLIは任意（クラウドAIだけでも書ける）", () => {
    const plan = buildSetupPlan(states({ ollama: true, chatModel: true }));
    const required = plan.missingRequired.map((e) => e.requirement.id);

    expect(required).not.toContain("git");
    expect(required).not.toContain("gh");
  });
});

describe("作者への説明", () => {
  test("何のために要るのかを併記する", () => {
    // 名前だけ並べても、入れるかどうかを判断できない
    const text = describeSetupPlan(buildSetupPlan(states({})));

    expect(text).toContain("Ollama");
    expect(text).toContain("入れない場合：");
  });

  test("入っているものには用途は書くが「入れない場合」は書かない", () => {
    const text = describeSetupPlan(
      buildSetupPlan(
        states({ ollama: true, chatModel: true, embeddingModel: true, git: true, gh: true })
      )
    );

    expect(text).not.toContain("入れない場合：");
  });

  test("合計の大きさを示せる", () => {
    // 待ち時間と容量を見積もれるようにする
    const plan = buildSetupPlan(states({ ollama: true }));

    expect(totalSizeLabel(plan.missingRequired)).toContain("GB");
  });

  test("大きさの分からないものがあっても壊れない", () => {
    expect(totalSizeLabel([])).toBe("");
  });
});

describe("導入結果の読み取り", () => {
  const result = (code: number, stdout = "", stderr = "") => ({
    code,
    stdout,
    stderr,
  });

  test("成功", () => {
    expect(interpretWingetResult(result(0)).kind).toBe("installed");
  });

  test("すでに入っているのは失敗にしない", () => {
    // 入れ直す必要は無い。赤く出すと作者は壊れたと思う
    expect(
      interpretWingetResult(result(-1978335189, "already installed")).kind
    ).toBe("already");
    expect(
      interpretWingetResult(result(1, "既にインストールされています")).kind
    ).toBe("already");
  });

  test("作者が取りやめたのは失敗にしない", () => {
    // ユーザーアカウント制御で断っただけ
    expect(interpretWingetResult(result(1, "", "0x800704c7")).kind).toBe(
      "cancelled"
    );
  });

  test("時間切れは理由を添える", () => {
    const outcome = interpretWingetResult(result(-1));

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.detail).toContain("回線");
    }
  });

  test("分からない失敗は、出力をそのまま残す", () => {
    // 原因を決めつけない（クラウドAIの失敗で繰り返した教訓と同じ）
    const outcome = interpretWingetResult(result(3, "", "何かがおかしい"));

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.detail).toContain("何かがおかしい");
    }
  });
});

describe("進捗の短縮", () => {
  test("割合があればそれだけを出す", () => {
    expect(shortenProgress("pulling manifest  47% ▕████  ▏ 1.2 GB")).toBe("47%");
  });

  test("長い行は切り詰める", () => {
    expect(shortenProgress("あ".repeat(100)).length).toBeLessThanOrEqual(41);
  });

  test("短い行はそのまま", () => {
    expect(shortenProgress("verifying sha256")).toBe("verifying sha256");
  });

  test("端末の制御文字を落とす", () => {
    // ollama pull の進捗には色やカーソル操作の文字が混じる（実機で確認）。
    // そのまま出すと意味の分からない記号が並ぶ
    const raw = "\u001b[?2026h\u001b[?25l\u001b[1Gpulling manifest \u001b[K";

    expect(stripControl(raw)).toBe("pulling manifest");
  });

  test("実機で出た進捗行から割合を取れる", () => {
    const raw = "\u001b[2Kpulling daec91ffb5dd: 100% ▕██████▏ 1.2 GB";

    expect(shortenProgress(raw)).toBe("100%");
  });

  test("制御文字だけの行は空になる（進捗に出さない）", () => {
    expect(stripControl("\u001b[?25h\u001b[?2026l")).toBe("");
  });
});
