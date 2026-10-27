# CI verification and GHCR image publishing

## Goal

Add GitHub Actions CI that verifies every pull request and publishes a tested Linux/amd64 Docker image to GitHub Container Registry after changes reach `main`. Change TrueNAS Compose from an inline source build to pulling that image, while preserving `/data`, environment-only secrets, and manual rollback.

## Current state

- No `.github/workflows` exists.
- `app/Dockerfile` already builds the frontend and produces a Node 24 runtime image without runtime health data or notification secrets.
- `app/compose.yaml` uses `build: .` and maps host port 8097 plus a persistent TrueNAS dataset.
- Full verification is documented in `AGENTS.md`; production dependency audits currently pass.
- GitHub CLI is authenticated as the repository owner, so workflow runs can be inspected after a future user-approved push.

## Constraints and decisions

- Use GitHub Actions and GHCR with the built-in `GITHUB_TOKEN`; least-privilege job permissions only.
- Verify PRs and `main`; publish only from `main` (including a manual dispatch on `main`), never from PRs/forks.
- Publish mutable `latest` for routine updates and immutable `sha-<commit>` for rollback.
- Build/smoke-test the image before publishing. Target `linux/amd64` only, matching the current TrueNAS host; do not add multi-architecture scope.
- Do not automatically update the NAS, push commits, expose the service, or place ntfy/data secrets in CI.
- Keep local Docker development possible and document private-GHCR pull authentication.
- Use official GitHub/Docker documentation and pin third-party actions to full commit SHAs with version comments.
- Publish concurrency uses one `publish-ghcr` group with `cancel-in-progress: false` and `queue: max`, so publications serialize and queue rather than replace each other.
- A main-tip guard (`gh api repos/<repo>/commits/main`, fail closed) pushes `latest` only when the run's commit is still the tip; a superseded or failed check pushes only the immutable `sha-<commit>` tag.
- Jobs have 30-minute timeouts; the image smoke test covers `/api/health`, `/`, and `/view`; `docker compose -f compose.yaml config --quiet` is part of verify, which also performs a no-push Docker build; publish additionally requires `github.repository` to equal this repository.

## Scope

- Add `.github/workflows/ci.yml`.
- Update `app/compose.yaml` to use `ghcr.io/bradybrenot/migraine-tracker:latest` with pull policy, removing inline build.
- Update `DEPLOY.md` for image updates, rollback, registry visibility/authentication, local builds, and CI run inspection.
- Update `README.md` and `AGENTS.md` for the published-image deployment and CI verification.
- Add this plan. No application/runtime behavior changes.

## Definition of done

- Workflow syntax is validated against the official GitHub workflow schema and by actionlint (1.7.12), which is clean except for its single known `queue` false positive (the key is documented and schema-valid).
- Workflow runs the complete existing verification suite and production audits before publication.
- Docker image is built and its `/api/health`, `/`, and `/view` responses are smoke-tested before push.
- GHCR tags/permissions/event guards are correct; PRs cannot publish.
- Compose configuration validates and retains all existing volumes/environment/ports.
- Local application tests, lint, build, PWA validation, server checks, and Docker build/smoke pass.
- Independent review finds no publishing, secret, rollback, or deployment regressions.
- Commit locally only. Live Actions/GHCR behavior remains explicitly unverified until the user approves a push.
