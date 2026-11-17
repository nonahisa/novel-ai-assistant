import { describe, expect, it } from "vitest";
import { blockingAdvisories } from "../../../scripts/auditDevGate.mjs";

/** 2026-11-18 の CI で落ちた形（根は picomatch、ほかは連れ） */
function report(extra: Record<string, unknown> = {}) {
  return {
    vulnerabilities: {
      picomatch: {
        via: [{ url: "https://github.com/advisories/GHSA-fc5q-39xc-vjpf", severity: "high", title: "ReDoS" }],
      },
      vitest: { via: ["picomatch", "@vitest/coverage-v8"] },
      tinyglobby: { via: ["fdir", "picomatch"] },
      minimatch: {
        via: [{ url: "https://github.com/advisories/GHSA-g3hv-75wg-m249", severity: "moderate", title: "DoS" }],
      },
      ...extra,
    },
  };
}

const allowed = [{ id: "GHSA-fc5q-39xc-vjpf", packageName: "picomatch", reason: "試し", until: "2026-12-18" }];

describe("開発用の道具の npm audit の門", () => {
  it("許した知らせ1件と、その連れだけなら通る（中程度は数えない）", () => {
    expect(blockingAdvisories(report(), new Date("2026-11-18T00:00:00Z"), allowed)).toEqual([]);
  });

  it("別の「高い」が1件混ざれば落ちる", () => {
    const withOther = report({
      lodash: { via: [{ url: "https://github.com/advisories/GHSA-xxxx-yyyy-zzzz", severity: "critical", title: "x" }] },
    });
    expect(blockingAdvisories(withOther, new Date("2026-11-18T00:00:00Z"), allowed)).toEqual([
      "lodash: GHSA-xxxx-yyyy-zzzz（critical）",
    ]);
  });

  it("期限を過ぎた許しは効かない", () => {
    expect(blockingAdvisories(report(), new Date("2026-12-19T00:00:00Z"), allowed)).toEqual([
      "picomatch: GHSA-fc5q-39xc-vjpf（high）",
    ]);
  });

  it("同じ id でも別の部品なら許さない", () => {
    const elsewhere = { vulnerabilities: { other: report().vulnerabilities.picomatch } };
    expect(blockingAdvisories(elsewhere, new Date("2026-11-18T00:00:00Z"), allowed)).toHaveLength(1);
  });
});
