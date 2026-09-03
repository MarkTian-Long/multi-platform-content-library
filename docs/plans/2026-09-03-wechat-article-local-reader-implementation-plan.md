# 微信公众号文章本地读取器 Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a private Windows-local tool that lets Codex capture a user-supplied `mp.weixin.qq.com` article URL through Edge, store a trustworthy local article record, and read it back for discussion.

**Architecture:** A TypeScript MCP server exposes a minimal capture-and-read interface over stdio. Capture starts a dedicated local Edge automation context through the already-installed Edge executable, extracts only the rendered article DOM, converts it to safe Markdown, and writes it under a constrained article-library root. Domain validation, storage containment, result status, and content-completeness checks are pure modules with unit tests; browser interaction is isolated behind a small adapter.

**Tech Stack:** Node.js 24.14.0, TypeScript, `@modelcontextprotocol/sdk`, `playwright-core` using `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`, `cheerio`, `turndown`, `tsx`, and Node's built-in test runner.

---

## Preconditions and scope constraints

- The workspace was not a Git repository when this plan was written. Do not initialize a repository or create commits without separate authorization. Each commit step below is conditional on a repository being supplied or explicitly authorized.
- Do not access the user’s default browser profile, cookies, clipboard, or WeChat process. Use a dedicated, app-owned Edge profile only.
- Never download or bundle a Playwright browser. `playwright-core` must launch the verified local Edge executable instead.
- Do not claim a capture succeeded until a non-empty extracted body has been saved and its status is `complete` or explicitly `partial`.
- All external HTML is untrusted data. It may be saved as a restricted evidence snapshot but must never be executed or treated as instructions.

### Task 1: Create the TypeScript test harness and project boundary

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `src/index.ts`
- Create: `tests/project.test.ts`
- Create: `README.md`

**Step 1: Write the failing project-boundary test**

Create `tests/project.test.ts` before implementing `src/config.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { resolveLibraryRoot } from "../src/config.js";

test("uses an app-owned article library below the current workspace", () => {
  assert.match(resolveLibraryRoot("D:/work/app"), /D:[\\/]work[\\/]app[\\/]article-library$/);
});
```

**Step 2: Run it to verify it fails**

Run: `cmd /c npm run test -- tests/project.test.ts`

Expected: FAIL because the package script and `src/config.ts` do not yet exist.

**Step 3: Add the smallest runnable project configuration**

Create a CommonJS-free ESM package with these scripts:

```json
{
  "type": "module",
  "scripts": {
    "test": "tsx --test tests/**/*.test.ts",
    "typecheck": "tsc --noEmit",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js"
  }
}
```

Add only runtime dependencies needed by later tasks and only `typescript`, `tsx`, and `@types/node` as development dependencies. Implement `resolveLibraryRoot(workspaceRoot)` using `path.resolve(workspaceRoot, "article-library")`. Add ignores for `node_modules/`, `dist/`, `article-library/`, and the app-owned browser profile directory.

**Step 4: Run the focused test and type check**

Run: `cmd /c npm run test -- tests/project.test.ts` and `cmd /c npm run typecheck`

Expected: PASS.

**Step 5: Commit if a repository is authorized**

Run: `git add package.json package-lock.json tsconfig.json .gitignore src/index.ts tests/project.test.ts README.md && git commit -m "chore: initialize local article reader"`

### Task 2: Enforce supported URL and local-path policy

**Files:**
- Create: `src/url-policy.ts`
- Create: `src/config.ts`
- Create: `tests/url-policy.test.ts`
- Modify: `tests/project.test.ts`

**Step 1: Write failing URL-policy tests**

```ts
test("accepts only HTTPS article pages on the exact WeChat host", () => {
  assert.equal(validateArticleUrl("https://mp.weixin.qq.com/s/example?a=1").ok, true);
  assert.equal(validateArticleUrl("http://mp.weixin.qq.com/s/example").ok, false);
  assert.equal(validateArticleUrl("https://mp.weixin.qq.com.evil.test/s/example").ok, false);
  assert.equal(validateArticleUrl("https://example.test/article").ok, false);
});
```

Add a separate test that a configured Edge path must be an absolute `.exe` path and that a storage path resolves below the explicit library root.

**Step 2: Run the test to verify it fails**

Run: `cmd /c npm run test -- tests/url-policy.test.ts`

Expected: FAIL because `validateArticleUrl` does not exist.

**Step 3: Implement policy as pure functions**

`validateArticleUrl` must parse via `new URL`, require `https:`, exact lowercase hostname `mp.weixin.qq.com`, and a non-root path. Return a discriminated result with a user-safe reason rather than throwing. `resolveEdgeExecutable` must prefer a configured absolute path, otherwise check the verified Program Files (x86) Edge path; no shell lookup and no user-profile probing. Use `path.relative` to reject an article ID that could escape the library root.

**Step 4: Run focused tests and full type check**

Run: `cmd /c npm run test -- tests/url-policy.test.ts` and `cmd /c npm run typecheck`

Expected: PASS.

**Step 5: Commit if authorized**

Run: `git add src/config.ts src/url-policy.ts tests/url-policy.test.ts tests/project.test.ts && git commit -m "feat: restrict capture URLs and storage roots"`

### Task 3: Extract safe, structured article content from rendered HTML

**Files:**
- Create: `src/article.ts`
- Create: `src/extract-article.ts`
- Create: `tests/fixtures/wechat-article.html`
- Create: `tests/extract-article.test.ts`

**Step 1: Add a realistic, non-network fixture and failing tests**

The fixture must contain `#activity-name`, `#js_name`, a date element, `#js_content`, headings, paragraphs, a quote, an image with alt text, an outbound link, and an injected `<script>` tag. Test that the result has title, body Markdown, source URL, an `extractedAt` ISO timestamp, and no script text or `javascript:` URL.

```ts
test("turns visible article content into safe Markdown", () => {
  const article = extractRenderedArticle(fixtureHtml, validUrl, fixedTime);
  assert.equal(article.status, "complete");
  assert.match(article.markdown, /## 一个小标题/);
  assert.match(article.markdown, /\[参考\]\(https:\/\/example.com\/\)/);
  assert.doesNotMatch(article.markdown, /window\.location|javascript:/);
});
```

Add failing tests for empty `#js_content` and missing title. Both must return a non-success status and no pretend body text.

**Step 2: Run the extractor tests to verify they fail**

Run: `cmd /c npm run test -- tests/extract-article.test.ts`

Expected: FAIL because the extractor module does not exist.

**Step 3: Implement the minimum extractor**

Use Cheerio only to select the page’s rendered metadata and `#js_content`. Remove executable and non-content nodes (`script`, `style`, `iframe`, `form`, SVG, event-handler attributes) before Turndown conversion. Permit only `http` and `https` links, normalize whitespace, and retain image alt text/captions without downloading images. Define `ArticleRecord` and `CaptureStatus` in `src/article.ts`; statuses are `complete`, `partial`, `empty`, `restricted`, `timeout`, and `failed`.

**Step 4: Run the complete extractor suite**

Run: `cmd /c npm run test -- tests/extract-article.test.ts` and `cmd /c npm run typecheck`

Expected: PASS.

**Step 5: Commit if authorized**

Run: `git add src/article.ts src/extract-article.ts tests/fixtures/wechat-article.html tests/extract-article.test.ts && git commit -m "feat: extract safe local WeChat article records"`

### Task 4: Persist records in an article-only library and expose safe reads

**Files:**
- Create: `src/article-library.ts`
- Create: `src/markdown.ts`
- Create: `tests/article-library.test.ts`
- Modify: `src/article.ts`

**Step 1: Write failing persistence and retrieval tests**

Use a temporary directory created by the test. Assert that `saveArticle(record)` creates exactly `article.md`, `source.html`, and `manifest.json` below one deterministic content-hash-based ID, and that `findArticles("标题词")` returns metadata only. Add a traversal test such as `readArticle("../outside")` that must return a safe failure result.

**Step 2: Run tests to verify they fail**

Run: `cmd /c npm run test -- tests/article-library.test.ts`

Expected: FAIL because the library module does not exist.

**Step 3: Implement atomic, constrained writes**

Create IDs from a SHA-256 hash of the canonical URL plus the content hash. Write files to an ID-specific temporary directory, then rename it into the article-library root only after all three files are complete. Save raw HTML only as text evidence and never load it in a browser. Generate `article.md` with a compact YAML-free front matter block (title, source, status, captured date) followed by Markdown. `manifest.json` contains no cookies, headers, credential data, or browser profile path.

**Step 4: Run persistence tests and the whole unit suite**

Run: `cmd /c npm run test` and `cmd /c npm run typecheck`

Expected: PASS.

**Step 5: Commit if authorized**

Run: `git add src/article-library.ts src/markdown.ts src/article.ts tests/article-library.test.ts && git commit -m "feat: store and retrieve local article records safely"`

### Task 5: Capture via a dedicated local Edge session

**Files:**
- Create: `src/browser/edge.ts`
- Create: `src/browser/capture-page.ts`
- Create: `tests/edge.test.ts`
- Create: `tests/capture-page.test.ts`
- Modify: `src/config.ts`

**Step 1: Write failing adapter tests without the network**

Define a narrow `RenderedPage` interface (`goto`, `waitForSelector`, `content`, `title`, `close`) so tests can supply a fake page. Verify that capture waits for `#js_content`, passes the resulting HTML to the extractor, and maps a selector timeout to `timeout`; verify it closes the page in `finally`.

**Step 2: Run the tests to verify they fail**

Run: `cmd /c npm run test -- tests/capture-page.test.ts tests/edge.test.ts`

Expected: FAIL because the browser adapters do not exist.

**Step 3: Implement the Edge-only adapter**

Use `playwright-core` with Chromium’s `executablePath` set only through `resolveEdgeExecutable`. Launch a persistent context under `<workspace>/.wechat-reader-profile`, with a visible window by default, no default-user-data-dir access, a 30-second navigation budget, and one page per capture request. Navigate only after URL validation. Wait for `#js_content`, then take `page.content()` and send it through the extractor. Translate navigation failures to the declared statuses without exposing internal URLs or cookies.

**Step 4: Validate browser behavior locally, then run the tests**

First serve the HTML fixture on `http://127.0.0.1` in a test-only process and verify the adapter can load and extract it through Edge. Then run: `cmd /c npm run test` and `cmd /c npm run typecheck`.

Expected: all unit tests pass; if Edge launch is blocked by the environment, report it as an environment limitation and preserve the tested fake-page coverage rather than switching to a bundled browser.

**Step 5: Commit if authorized**

Run: `git add src/browser src/config.ts tests/edge.test.ts tests/capture-page.test.ts && git commit -m "feat: capture rendered articles through local Edge"`

### Task 6: Add the MCP surface for capture, search, and read

**Files:**
- Create: `src/mcp/handlers.ts`
- Create: `src/mcp/server.ts`
- Create: `tests/mcp-handlers.test.ts`
- Modify: `src/index.ts`
- Modify: `README.md`

**Step 1: Write failing handler tests**

Test the following three operations directly through handler functions:

```ts
await captureWechatArticle({ url: "https://mp.weixin.qq.com/s/example" });
await findSavedArticles({ query: "文章标题" });
await readSavedArticle({ articleId: "known-id" });
```

Assert that capture returns only status, article ID, title, and a user-safe failure reason; search returns article metadata, not raw HTML; read returns the saved Markdown and manifest fields. Add a test proving unsupported URLs never reach the browser adapter.

**Step 2: Run handler tests to verify they fail**

Run: `cmd /c npm run test -- tests/mcp-handlers.test.ts`

Expected: FAIL because handlers do not exist.

**Step 3: Implement the minimal stdio MCP server**

Register exactly three read-or-capture tools with `@modelcontextprotocol/sdk`: `capture_wechat_article`, `find_saved_articles`, and `read_saved_article`. Validate JSON input before calling handlers. Keep stdout strictly for the MCP protocol and send operational diagnostics to stderr. Never add a generic shell, browser, filesystem, clipboard, or arbitrary-URL tool.

**Step 4: Run regression checks and a stdio smoke test**

Run: `cmd /c npm run test`, `cmd /c npm run typecheck`, and `cmd /c npm run build`.

Then start the built program under an MCP inspector or a scripted stdio test and assert that `find_saved_articles` returns a valid empty list in a new library. Expected: all checks pass and stdout contains only protocol messages.

**Step 5: Commit if authorized**

Run: `git add src/mcp src/index.ts tests/mcp-handlers.test.ts README.md && git commit -m "feat: expose a constrained local article reader MCP"`

### Task 7: Document setup, privacy, and real-page acceptance

**Files:**
- Modify: `README.md`
- Create: `docs/privacy-and-failures.md`
- Create: `docs/mcp-setup.md`

**Step 1: Write documentation acceptance checks**

Add a short test or review checklist requiring documentation to state: no default browser profile access, no clipboard monitoring, the dedicated local library path, how to start the MCP server, supported URL boundary, the six capture statuses, and what the user will see when an article is restricted.

**Step 2: Run the documentation check to verify it fails**

Run: `cmd /c npm run test -- tests/documentation.test.ts`

Expected: FAIL until the documentation and its checklist test exist.

**Step 3: Write concise Chinese-first documentation**

`README.md` should say only: “把链接发给 Codex，Codex 调用本机读取器”。 `docs/mcp-setup.md` must give the exact local MCP registration command/configuration without secrets. `docs/privacy-and-failures.md` must distinguish `restricted`, `timeout`, `empty`, and `partial`, and state that the tool never guesses missing text.

**Step 4: Perform proportional final validation**

Run: `cmd /c npm run test`, `cmd /c npm run typecheck`, and `cmd /c npm run build`.

With the user’s permission and a user-provided non-sensitive public test link, invoke `capture_wechat_article` once. Verify the saved record contains a matching title, source URL, non-empty body, and status. If live capture is unavailable, record the specific cause; fixture/browser verification remains valid but does not prove a live page.

**Step 5: Commit if authorized**

Run: `git add README.md docs tests/documentation.test.ts && git commit -m "docs: explain private local article capture setup"`

## Completion evidence

- All test, type-check, and build commands have been run and their outcomes recorded.
- Browser validation names the exact Edge executable used; it does not silently fall back to a downloaded Chromium.
- A successful live capture is evidenced separately from fixture-only tests.
- The working tree state, local commit (if authorized), remote push, and any deployment are reported separately. This plan does not authorize a remote push or deployment.
