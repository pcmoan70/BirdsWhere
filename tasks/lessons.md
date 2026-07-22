# Lessons

## Always sync with the remote before starting work (2026-07-22)

**Mistake.** Built a two-feature change on a local `main` that was **165 commits
behind `origin/main`** (local sw v519, remote v676; `docs/app.js` differed by
~3,600 lines). The push was rejected, and the whole change had to be redone
against the current tree. Worse, the stale base hid a refactor: the map popup had
gained a "📍 Location ▸" submenu (v590) which was exactly where the user had
asked for the new link — the first attempt put it somewhere that no longer
existed in that form. It also led to mistaking already-upstream work
(shift+wheel radius, commit a54fba6) for uncommitted local work, and asking the
user a question based on that wrong premise.

**Why it happened.** The session-start git snapshot lists recent commits but says
nothing about how far behind the branch is, and the working tree looked normal.
I read "M app.js" as in-progress local work rather than as a stale checkout.

**Rule.** Before any non-trivial change, run:

    git fetch origin && git status -sb && git rev-list --count HEAD..@{u}

If the count is non-zero, stop and reconcile (or ask) **before** writing code.
Never infer repo freshness from the working tree or from the commit list in the
session context.

**Corollary.** If a change is already upstream, it is not "uncommitted work" —
verify with `git log --oneline --all --grep=<keyword>` or by searching
`origin/main` for the code before concluding something is unpushed.
