# Organized Reader Library and Automatic PDF Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver a clean user-facing reader folder, automatic local PDF generation after every successful capture, and a searchable history view.

**Architecture:** Keep Git at the outer folder while moving executable code and dependencies to `程序文件/`; keep `文章库/` as the only user result root. The capture core saves text and images first, then generates a PDF from local evidence; PDF failure is recorded separately and never turns a successful text capture into a failure. A small WinForms window calls JSON CLI commands for capture, history, and PDF regeneration.

**Tech Stack:** TypeScript, Node.js, Playwright Core + local Edge, Cheerio, PowerShell WinForms, Node test runner.

---

### Task 1: Separate the application root from the article result root

**Files:**
- Modify: `src/config.ts`, `src/mcp/handlers.ts`, `src/cli.ts`, `reader-window.ps1`, `启动公众号文章阅读器.cmd`
- Modify: `tests/project.test.ts`, `tests/cli.test.ts`, `tests/window-launcher.test.ts`

**Step 1: Write failing tests** requiring `程序文件/` as application root and outer `文章库/` as the only result root.

**Step 2: Run:** `cmd /c npm run test -- tests/project.test.ts tests/cli.test.ts tests/window-launcher.test.ts`

Expected: FAIL because the runtime and launcher still assume a shared root.

**Step 3: Implement** `resolveLibraryRoot` with an explicit `WECHAT_ARTICLE_LIBRARY_ROOT` override and a default outer result location. Pass the outer root through the launcher and set the application working directory to `程序文件/`.

**Step 4: Run:** `cmd /c npm run test -- tests/project.test.ts tests/cli.test.ts tests/window-launcher.test.ts`

Expected: PASS.

**Step 5: Commit:** `feat: separate article results from application files`

### Task 2: Use clean article folder names and remove legacy result roots

**Files:**
- Modify: `src/article-library.ts`, `src/migrate-legacy-library.ts`, `tests/article-library.test.ts`, `tests/migrate-legacy-library.test.ts`

**Step 1: Write failing tests** for `YYYY-MM-DD_标题`, a `（2）` collision suffix, and preserved internal `articleId` in `manifest.json`.

**Step 2: Run:** `cmd /c npm run test -- tests/article-library.test.ts tests/migrate-legacy-library.test.ts`

Expected: FAIL because directory names expose the ID suffix.

**Step 3: Implement** collision-aware naming. When an identical capture already exists, reuse its directory; otherwise select the next parenthesized suffix. Retain all identity and hash data only in the manifest.

**Step 4: Migrate** the valid current article to its clean directory, and remove the obsolete `article-library/` legacy result root only after confirming its duplicate content is no longer needed.

**Step 5: Run:** `cmd /c npm run test -- tests/article-library.test.ts tests/migrate-legacy-library.test.ts`

Expected: PASS.

**Step 6: Commit:** `feat: simplify article result folder names`

### Task 3: Generate a local PDF after each successful capture

**Files:**
- Create: `src/article-pdf.ts`, `tests/article-pdf.test.ts`
- Modify: `src/article-library.ts`, `src/mcp/handlers.ts`, `src/cli.ts`, `tests/mcp-handlers.test.ts`, `tests/cli.test.ts`

**Step 1: Write failing tests** for local image references, successful `文章.pdf` metadata, and a PDF error that preserves a successful saved article.

**Step 2: Run:** `cmd /c npm run test -- tests/article-pdf.test.ts tests/mcp-handlers.test.ts tests/cli.test.ts`

Expected: FAIL because no PDF result exists.

**Step 3: Implement** a local Edge PDF renderer from saved source HTML with local image substitutions and print CSS. Generate `文章.pdf` after `saveArticle`; record `pdf: { status, path?, reason? }` in the manifest. Add a `regenerate-pdf` CLI command.

**Step 4: Run:** `cmd /c npm run test -- tests/article-pdf.test.ts tests/mcp-handlers.test.ts tests/cli.test.ts`

Expected: PASS.

**Step 5: Build and render one real PDF** from the supplied article, render it to PNG with Poppler, and inspect it for Chinese-text and image layout defects.

**Step 6: Commit:** `feat: generate article PDFs automatically`

### Task 4: Add a small searchable article-library window

**Files:**
- Modify: `src/cli.ts`, `reader-window.ps1`, `tests/cli.test.ts`, `tests/window-launcher.test.ts`, `README.md`

**Step 1: Write failing tests** for `list <query>` and `regenerate-pdf <articleId>` CLI actions and required window labels.

**Step 2: Run:** `cmd /c npm run test -- tests/cli.test.ts tests/window-launcher.test.ts`

Expected: FAIL because only capture is exposed.

**Step 3: Implement** article-list JSON output, library search, list selection, open article/folder, and PDF regeneration. Refresh the list after every capture. Do not add clipboard polling, accounts, background retries, or network submission.

**Step 4: Run:** `cmd /c npm run test -- tests/cli.test.ts tests/window-launcher.test.ts`

Expected: PASS.

**Step 5: Commit:** `feat: add searchable local article library`

### Task 5: Move technical files into `程序文件` and verify the installed layout

**Files:**
- Move: `src/`, `tests/`, `docs/`, `dist/`, `node_modules/`, `.wechat-reader-profile/`, package files, TypeScript config, PowerShell window script into `程序文件/`
- Modify: outer `.gitignore`, outer `README.md`, outer launcher, `程序文件/docs/mcp-setup.md`
- Modify outside repository: local MCP registration

**Step 1: Check** the outer folder is clean and that `文章库/` contains the verified article before moving.

**Step 2: Move** only named technical entries into `程序文件/`; preserve outer `.git/`, `文章库/`, and the user-facing launcher.

**Step 3: Update** the MCP command to `程序文件/dist/index.js`, set application root to `程序文件/`, and set library root to outer `文章库/`.

**Step 4: Run:** `cmd /c npm run test`, `cmd /c npm run typecheck`, `cmd /c npm run build` from `程序文件/`; launch the outer `.cmd`; capture the supplied URL and confirm Markdown, five local images, and `文章.pdf` are present.

**Step 5: Commit:** `refactor: organize reader application and article library`
