import test from "node:test";
import assert from "node:assert/strict";
import { normalizeOfficialRateLimits } from "../dist/services/chatgpt_account_usage.js";

test("official Codex rate-limit snapshots map 5-hour and weekly windows without local estimation", () => {
  const usage = normalizeOfficialRateLimits({
    rateLimits: {
      primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1700000000 },
      secondary: { usedPercent: 34, windowDurationMins: 10080, resetsAt: 1700600000 },
      credits: { hasCredits: true, unlimited: false, balance: "7" },
      planType: "plus",
    },
  }, "2026-08-07T00:00:00.000Z");

  assert.equal(usage.status, "fresh");
  assert.equal(usage.source, "official:account/rateLimits/read");
  assert.equal(usage.five_hour?.used_percent, 12);
  assert.equal(usage.five_hour?.remaining_percent, 88);
  assert.equal(usage.weekly?.used_percent, 34);
  assert.equal(usage.weekly?.remaining_percent, 66);
  assert.equal(usage.plan_type, "plus");
  assert.deepEqual(usage.credits, { has_credits: true, unlimited: false, balance: "7" });
});

test("official snapshots preserve unknown window lengths instead of relabeling them", () => {
  const usage = normalizeOfficialRateLimits({
    rateLimits: {
      primary: { usedPercent: 5, windowDurationMins: 1440, resetsAt: 1700000000 },
      planType: "free",
    },
  });

  assert.equal(usage.status, "fresh");
  assert.equal(usage.five_hour, undefined);
  assert.equal(usage.weekly, undefined);
  assert.equal(usage.additional_windows?.[0]?.kind, "other");
  assert.equal(usage.additional_windows?.[0]?.window_minutes, 1440);
});

test("missing official quota fields remain unavailable rather than becoming zero", () => {
  const usage = normalizeOfficialRateLimits({ rateLimits: {} });

  assert.equal(usage.status, "unavailable");
  assert.equal(usage.five_hour, undefined);
  assert.equal(usage.weekly, undefined);
  assert.match(usage.error || "", /未包含/);
});
