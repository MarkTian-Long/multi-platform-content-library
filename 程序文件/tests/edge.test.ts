import test from "node:test";
import assert from "node:assert/strict";
import { resolveEdgeExecutable } from "../src/url-policy.js";

test("rejects a relative or non-executable Edge path", () => {
  assert.throws(() => resolveEdgeExecutable("edge.exe"), /absolute/);
  assert.throws(() => resolveEdgeExecutable("C:\\edge.txt"), /absolute/);
});
