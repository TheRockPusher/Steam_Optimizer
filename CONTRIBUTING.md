# Contributing

Thanks for contributing to Steam Optimizer. Keep changes small, focused, and consistent with the read-only product boundary described in [`docs/PROJECT_SUMMARY.md`](docs/PROJECT_SUMMARY.md).

## Trunk-based workflow

- `main` is the trunk and should remain releasable.
- Create a short-lived branch from the latest `main`, such as `feat/public-inventory-view` or `fix/health-route`.
- Rebase or update the branch before opening a pull request. Avoid long-running branches and unrelated drive-by changes.
- Open a pull request for review; do not push directly to `main`.
- Required CI must pass before merge. Prefer squash merging so the trunk history stays focused.
- Delete the branch after it is merged.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/), for example:

```text
feat(api): add public inventory endpoint
fix(ui): handle unavailable health check
chore(ci): pin action versions
```

Use a short imperative subject. Keep each commit coherent, explain non-obvious decisions in the body, and mark breaking changes with `!` or a `BREAKING CHANGE:` footer.

## Pull requests

Describe the behavior changed, the scope of the change, and how it was checked. Update relevant documentation and changelog entries when behavior or public interfaces change. Do not add Steam transaction automation, private-inventory assumptions, or credentials to the project.
