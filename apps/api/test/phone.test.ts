import assert from "node:assert/strict";
import test from "node:test";
import { chooseOriginalCaller, normalizeCanadianNumber } from "../src/phone.js";

test("normalizes Canadian ten and eleven digit numbers", () => {
  assert.equal(normalizeCanadianNumber("(416) 555-0100"), "+14165550100");
  assert.equal(normalizeCanadianNumber("1-416-555-0100"), "+14165550100");
  assert.equal(normalizeCanadianNumber("not-a-number"), undefined);
});

test("prefers forwarded original caller metadata with safe fallback", () => {
  assert.equal(chooseOriginalCaller({ from: "+17372508034", forwardedFrom: "647 555 0101" }), "+16475550101");
  assert.equal(chooseOriginalCaller({ from: "4165550100", originalCaller: "invalid" }), "+14165550100");
});
