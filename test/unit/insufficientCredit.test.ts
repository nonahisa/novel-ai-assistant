import { describe, expect, test } from "vitest";
import { AIError, recoveryForAIError } from "../../src/ai/types";
import { toStatusError } from "../../src/ai/httpClient";
import { billingProblem } from "../../src/ai/claudeProvider";
import { recoveryForAIError as recovery } from "../../src/ai/types";

describe("残高不足の扱い", () => {
  test("Anthropicの残高不足を見分ける", () => {
    // Anthropicは残高不足も400 invalid_request_error で返してくる
    const error = new Error(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}'
    );

    const detected = billingProblem(error);

    expect(detected?.kind).toBe("insufficient_credit");
    expect(detected?.message).toContain("クレジット残高が不足");
    expect(detected?.message).toContain("Plans & Billing");
  });

  test("形の不備を残高不足と取り違えない", () => {
    const error = new Error(
      '400 {"error":{"message":"unsupported keyword maxLength"}}'
    );

    expect(billingProblem(error)).toBeUndefined();
  });

  test("OpenAIの残高切れはレート上限と分ける", () => {
    // 待っても回復しないので、待機して再試行してはいけない
    const body = '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota, please check your plan and billing details."}}';

    expect(toStatusError(429, body, "ChatGPT").kind).toBe(
      "insufficient_credit"
    );
  });

  test("Geminiの無料枠上限はレート上限のまま扱う", () => {
    // こちらは待てば回復する。残高切れにすると待たずに諦めてしまう
    const body =
      '{"error":{"message":"Quota exceeded for metric: generate_content_free_tier_requests, limit: 5. Please retry in 6.4s.","status":"RESOURCE_EXHAUSTED"}}';

    expect(toStatusError(429, body, "Gemini").kind).toBe("rate_limited");
  });

  test("次にすべきことを示す", () => {
    const message = recoveryForAIError(
      new AIError("残高不足", "insufficient_credit")
    );

    expect(message).toContain("クレジットを購入");
    // 権限の問題とは直し方が違うので、案内も分ける
    expect(message).not.toBe(
      recovery(new AIError("権限なし", "permission_denied"))
    );
  });
});
