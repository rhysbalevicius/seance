You are running headless on a disposable agent workstation, in the root of a project repository that was just cloned. Your job is to make this project's development environment work here, and to document what you did.

Do, in order:

1. Read the README, any docs/, Makefile, docker-compose*, package manifests, and CI config to understand how this project is built, run, and tested.
2. Perform the setup: install dependencies (project-local where possible: venvs, node_modules — the box already has Docker + compose, Node 22, Python 3, build tools), build what needs building, prepare any .env the project expects. API keys already present in your environment may be used; never invent placeholder secrets for ones that are missing — list them as missing instead.
3. Verify: run the test suite, or if there is none, start the main service/dev server, confirm it answers (curl or `seance-screenshot http://localhost:<port>`), then stop it. Leave nothing running.
4. Write AGENT_SETUP.md at the repo root: how to run/test/start everything as verified on THIS box, any deviations from the README you needed, missing secrets or unresolved problems, and (if relevant) which port the dev server uses plus the `seance-expose add <name> <port>` line to preview it.

Rules: do not push, do not commit unless the repo's own setup generates files that its docs say to commit; make no destructive changes outside this directory; prefer boring, repo-idiomatic choices over clever ones. If setup cannot complete, still write AGENT_SETUP.md describing exactly where and why it stopped.
