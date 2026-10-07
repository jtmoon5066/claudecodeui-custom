# Repository guidance

## Backend code

For every task that creates, modifies, refactors, or reviews backend code under `server/`, load and follow `$backend-module-standards` from `.agents/skills/backend-module-standards/SKILL.md`. Apply it only to backend code; do not impose those architecture rules on the frontend.

## Frontend code

For every task that creates, modifies, refactors, or reviews frontend code under `src/`, load and follow `$frontend-module-standards` from `.agents/skills/frontend-module-standards/SKILL.md`. Apply it only to frontend code; do not impose those architecture rules on the backend.

## CCUI project governance

- `CCUI_PROJECT_ID=d29e80ad-887b-4e2e-a514-7b757a8d6529`
- `PROJECT_ROOT=C:\AI-Workspace\claudecodeui-custom` contains the canonical operating documents. Read `PROJECT_ROOT\PROJECT.md`, `PROJECT_ROOT\RULES.md` (CCUI-RULES-1.0.0), and the applicable REQUEST before work; follow their required-reading pointers. If required context is inaccessible or ambiguous, report the gap and stop the dependent action.
- `LOCAL_WORK_ROOT=C:\Users\jtmoo\ai-workspace\claudecodeui-custom` is the source/Git working root. Keep operating documents and source work in their respective roots.
- `origin=https://github.com/jtmoon5066/claudecodeui-custom.git` is the user's custom repository; `upstream=https://github.com/siteboon/claudecodeui.git` is the original CloudCLI repository. Adopt upstream changes selectively under an explicit REQUEST, preserving custom behavior and recording source commits and compatibility checks; do not automatically synchronize or push to upstream.
- Preserve upstream guidance, module conventions, licenses, NOTICE, contribution attribution, and existing uncommitted work. This file is the shared persistent guidance; `CLAUDE.md` imports it. Keep current request/task/session details in operating documents and reports, not in persistent guidance.
- Separate Application Session, Agent Run, Provider Conversation/Thread, OS Process, and UI connection identities. A canonical session name is not a provider locator; record only observed locators and distinguish missing from unknown.
- Allow one active source writer per working directory and one active writer per provider conversation/thread. Additional writers require explicitly assigned isolated branches/worktrees and integration ownership. If ownership or liveness is unknown, fail closed: do not create a competing writer, continue a thread, kill, or delete.
- Reattach/reconcile a live run after UI disconnection; do not infer worker termination from UI or registry state. Fresh runs and resumes are distinct intents. Resume requires the exact target and confirmed termination of the previous writer; never silently fall back to a fresh conversation.
- Before OS or Git operations, inspect the actual scope, including parent chains, links/junctions/reparse points, Git child-process scope, and both endpoints of moves/copies. The preflight must cover the full operation scope within authorized roots; if it cannot, stop. Recheck important boundaries immediately before destructive actions and state any TOCTOU limits.
- Without an applicable REQUEST, do not change product code, commit, push, alter remote/branch configuration, or perform destructive cleanup. Permission for each external effect comes from the current contract. Stop/cleanup applies only to proven task-owned process trees; unrelated sessions, provider data, credentials, and personal files are protected.
