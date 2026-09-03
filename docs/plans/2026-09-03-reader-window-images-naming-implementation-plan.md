# 公众号文章阅读器窗口与媒体 Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let a Windows user double-click a small local window, paste a WeChat article URL, and receive a locally saved Markdown article with real image files and readable directory names.

**Architecture:** Keep the existing Node/MCP capture core, add a JSON CLI command for one capture, and place a PowerShell WinForms window over that CLI. Persist article identities in manifests while using safe title-based directories; migrate the existing hash-only library into the new Chinese-named library without deleting unmatched files. Extract true lazy-loaded image URLs and download them under strict size/type limits as local article assets.

**Tech Stack:** Node.js 24, TypeScript, Playwright Core with local Edge, Cheerio, Turndown, Node test runner, PowerShell WinForms, and Windows command launchers.

---

## Preconditions

- Work in the current D-drive repository, per the user’s explicit preference; do not create a separate worktree.
- Preserve `main` as local-only. No remote, push, deployment, clipboard monitoring, WeChat injection, Electron download, or installer packaging.
- Before the physical project rename, ensure the working tree is clean and the target path `D:\CS\Coding\公众号文章阅读器` does not exist.
- Treat every article page and image as untrusted data. Only process a URL submitted through the UI or CLI.

### Task 1: Establish configured paths and readable article directory rules

**Files:**
- Modify: `src/config.ts`
- Modify: `src/article.ts`
- Modify: `src/article-library.ts`
- Modify: `tests/project.test.ts`
- Modify: `tests/article-library.test.ts`
- Modify: `.gitignore`

**Step 1: Write failing tests**

Add tests that require the data root to be `<project>/文章库`, that `articleDirectoryName` yields a Windows-safe value such as `2026-09-03_对话兰小欢_AI透镜_b758e4d8`, and that the complete 24-character article ID still resolves via its manifest rather than via the directory name. Test removal of `<>:"/\\|?*`, control characters, trailing periods, and excess title length.

**Step 2: Verify RED**

Run: `cmd /c npm run test -- tests/project.test.ts tests/article-library.test.ts`

Expected: FAIL because `文章库` and manifest-backed directory resolution do not exist.

**Step 3: Implement the minimum path model**

Keep `articleId` and content hash unchanged. Add `articleDirectoryName(record)` using the captured local date, a 48-character safe-title limit, and the first eight article-ID characters. Change writes to `文章库/<readable-directory>/`; make reads/search scan only directories whose `manifest.json` parses and whose `articleId` matches. Keep `article-library/` ignored during migration and add `文章库/` to `.gitignore`.

**Step 4: Verify GREEN**

Run: `cmd /c npm run test -- tests/project.test.ts tests/article-library.test.ts` and `cmd /c npm run typecheck`

Expected: PASS.

**Step 5: Commit**

Run: `git add src/config.ts src/article.ts src/article-library.ts tests/project.test.ts tests/article-library.test.ts .gitignore && git commit -m "feat: use readable local article directories"`

### Task 2: Extract actual WeChat image sources and store local media

**Files:**
- Modify: `src/article.ts`
- Modify: `src/extract-article.ts`
- Create: `src/article-images.ts`
- Modify: `src/article-library.ts`
- Modify: `src/markdown.ts`
- Modify: `tests/fixtures/wechat-article.html`
- Modify: `tests/extract-article.test.ts`
- Modify: `tests/article-library.test.ts`

**Step 1: Write failing extraction tests**

Extend the fixture with one image whose `src` is a transparent SVG placeholder and whose `data-src` is `https://example.test/real.jpg`, plus one image with only a placeholder. Assert that extraction selects the first real URL, rejects data/SVG placeholders, and emits an image record with an ordered index and alt text.

**Step 2: Verify RED**

Run: `cmd /c npm run test -- tests/extract-article.test.ts`

Expected: FAIL because image source selection and image records are absent.

**Step 3: Implement source selection and bounded download**

Add `ArticleImage` records to `ArticleRecord`. Inspect image attributes in this order: `data-src`, `data-original`, `data-actualsrc`, then `src`; accept only absolute HTTP(S) URLs and reject known transparent SVG/data placeholders. In `article-images.ts`, use `fetch` with a 10 MB per-image limit, a 30-second timeout, and an allowlist of `image/*` content types. Save only successful files as `images/001.<safe-extension>` under the article’s temporary directory. Record a per-image `saved`, `remote`, or `failed` status in the manifest; never fail an otherwise complete text capture solely because an image fails.

**Step 4: Generate honest Markdown**

Replace successful image URLs with relative local paths. For a failed image, render `图片未获取：<alt-or-source>` rather than a non-functional placeholder. Preserve the remote URL only in manifest metadata.

**Step 5: Verify GREEN**

Run: `cmd /c npm run test -- tests/extract-article.test.ts tests/article-library.test.ts` and `cmd /c npm run typecheck`

Expected: PASS.

**Step 6: Commit**

Run: `git add src/article.ts src/extract-article.ts src/article-images.ts src/article-library.ts src/markdown.ts tests && git commit -m "feat: save real article images locally"`

### Task 3: Migrate only valid legacy article records

**Files:**
- Create: `src/migrate-legacy-library.ts`
- Create: `tests/migrate-legacy-library.test.ts`
- Modify: `src/mcp/handlers.ts`

**Step 1: Write failing migration tests**

Create a temporary old `article-library/<24-hex-id>/` fixture with valid Markdown, HTML, and manifest. Assert that migration moves it to the readable `文章库/` name, returns the original article ID, and leaves an unrelated malformed folder untouched. Add an idempotence test: a second run does not duplicate or rename the record again.

**Step 2: Verify RED**

Run: `cmd /c npm run test -- tests/migrate-legacy-library.test.ts`

Expected: FAIL because no migrator exists.

**Step 3: Implement the constrained migrator**

Only enumerate immediate child directories beneath the old root. Require a valid manifest with a 24-hex `articleId`, a title, and all three expected artifact files before moving. Use a same-volume rename into `文章库/`; on collision, retain the source and report it. Call migration once before capture/search/read from the default handler path. Return structured counts and errors for the CLI/UI.

**Step 4: Verify GREEN**

Run: `cmd /c npm run test -- tests/migrate-legacy-library.test.ts` and `cmd /c npm run typecheck`

Expected: PASS.

**Step 5: Commit**

Run: `git add src/migrate-legacy-library.ts src/mcp/handlers.ts tests/migrate-legacy-library.test.ts && git commit -m "feat: migrate legacy article library safely"`

### Task 4: Provide a single-capture JSON CLI

**Files:**
- Create: `src/cli.ts`
- Modify: `package.json`
- Create: `tests/cli.test.ts`
- Modify: `README.md`

**Step 1: Write failing CLI contract tests**

Inject capture dependencies into a testable `runCli(argv, dependencies)` function. Assert `capture <url>` writes exactly one JSON result to stdout, writes errors only to stderr, returns exit code 0 for `complete`/`partial`, and returns non-zero for an invalid URL or failed capture.

**Step 2: Verify RED**

Run: `cmd /c npm run test -- tests/cli.test.ts`

Expected: FAIL because `runCli` does not exist.

**Step 3: Implement the smallest CLI**

Accept exactly `capture <url>`. Invoke the same constrained handler used by MCP, await legacy migration, and JSON-serialize `{ status, articleId, title, directory, imageSummary, reason }`. Add a build output script `reader-cli` that runs `dist/cli.js`; do not add a generic shell or arbitrary file command.

**Step 4: Verify GREEN**

Run: `cmd /c npm run test -- tests/cli.test.ts`, `cmd /c npm run typecheck`, and `cmd /c npm run build`

Expected: PASS.

**Step 5: Commit**

Run: `git add src/cli.ts package.json tests/cli.test.ts README.md && git commit -m "feat: add one-shot article capture CLI"`

### Task 5: Add the independent Windows reader window

**Files:**
- Create: `scripts/启动公众号文章阅读器.cmd`
- Create: `scripts/公众号文章阅读器.ps1`
- Create: `tests/window-launcher.test.ts`
- Modify: `README.md`

**Step 1: Write failing launcher contract tests**

Read the two launcher files as text. Assert the command launcher resolves its own project directory, invokes PowerShell with `-NoProfile`, and never uses clipboard APIs. Assert the PowerShell script creates a form titled `公众号文章阅读器`, includes the input field and the four user-visible labels `读取文章`、`正在读取`、`打开文章`、`打开保存位置`, and launches only `dist/cli.js capture <entered-url>`.

**Step 2: Verify RED**

Run: `cmd /c npm run test -- tests/window-launcher.test.ts`

Expected: FAIL because the scripts do not exist.

**Step 3: Implement the minimal WinForms UI**

The `.cmd` launcher must calculate `%~dp0..` and start `公众号文章阅读器.ps1`. The PowerShell script must create a fixed-size, non-admin form; disable the read button during capture; use `System.Diagnostics.Process` to run `node dist/cli.js capture` in the project directory; parse only its final JSON stdout; update the status label on each phase; and enable the two open buttons only for a successful article directory. The “open” actions use `Start-Process` on the exact saved Markdown or directory path returned by the CLI. No clipboard reads, tray process, global hotkey, or background retry.

**Step 4: Verify GREEN and manually smoke-test the window**

Run: `cmd /c npm run test -- tests/window-launcher.test.ts`, `cmd /c npm run test`, `cmd /c npm run typecheck`, and `cmd /c npm run build`.

Then start `scripts\启动公众号文章阅读器.cmd`, verify the window opens, cancel without a link, and confirm no article is created. Close the window.

**Step 5: Commit**

Run: `git add scripts tests/window-launcher.test.ts README.md && git commit -m "feat: add local article reader window"`

### Task 6: Rename the project directory and refresh local registration

**Files:**
- Modify: `README.md`
- Modify: `docs/mcp-setup.md`
- Modify: `docs/privacy-and-failures.md`
- Modify: local Codex MCP configuration (outside repository)

**Step 1: Preflight rename**

Run `git status --short`, verify no output; verify `D:\CS\Coding\公众号文章阅读器` does not exist; record `git worktree list --porcelain`; and confirm the current branch is `main`.

**Step 2: Update source references and run checks**

Replace the display name and all old project-path examples in documentation. Run `cmd /c npm run test`, `cmd /c npm run typecheck`, and `cmd /c npm run build`. Commit source-only documentation updates before moving the folder.

**Step 3: Rename only the validated target**

Move `D:\CS\Coding\微信公号号阅读插件` to `D:\CS\Coding\公众号文章阅读器`. Do not use recursive deletion; abort if the target path exists or the source path differs from the recorded absolute path.

**Step 4: Re-register the local MCP and verify**

Remove the old global `wechat_article_local_reader` entry and add it back with the new absolute `dist/index.js` path and `WECHAT_ARTICLE_READER_ROOT=D:\CS\Coding\公众号文章阅读器`. Verify with `codex mcp get wechat_article_local_reader`. The current conversation may need to be replaced by a fresh local Codex task before the new tool inventory is visible.

**Step 5: Final live acceptance**

Use the already user-provided public WeChat URL through the new window. Verify: title matches, text is non-empty, the legacy article moved to a readable directory, at least one real image is saved locally or a truthful failed-image status is visible, and no output appears under the old library root. Report browser/UI verification separately from tests. Do not push.

## Completion evidence

- All unit tests, type checks, builds, launcher smoke test, and live article results are reported separately.
- Report the final local commits, branch, D-drive project location, and MCP registration; explicitly state no remote push or deployment.
- Confirm the legacy hash-only article directory was moved only if its manifest was valid; retain any unmatched legacy content.
