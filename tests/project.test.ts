import test from "node:test";
import assert from "node:assert/strict";
import { resolveLibraryRoot } from "../src/config.js";

test("uses an app-owned article library below the current workspace", () => {
  assert.match(resolveLibraryRoot("D:/work/app"), /D:[\\/]work[\\/]app[\\/]article-library$/);
});
