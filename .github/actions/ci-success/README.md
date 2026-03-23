# CI Success

`CI Success` is a first-party promptfoo GitHub Action that rolls up all other checks and legacy status contexts on the current commit into a single required check.

It is intended for repositories that want exactly one required status check in rulesets while still enforcing:

- matrix jobs
- checks from other workflows
- legacy commit status contexts

## Usage

Add a thin wrapper job to the repository workflow that should publish the required check:

```yaml
permissions:
  contents: read
  checks: read
  statuses: read

jobs:
  ci-success:
    name: CI Success
    runs-on: ubuntu-latest
    if: always()
    steps:
      - uses: promptfoo/.github/.github/actions/ci-success@<full-commit-sha>
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          timeout-seconds: 300
```

If the repository already knows which local jobs must finish before the rollup should start, keep using `needs:` in the wrapper job. That shortens the polling window, but it is not required for correctness.

## Inputs

- `github-token`: token used to read checks and statuses
- `check-name`: rollup check name to ignore while polling, defaults to `CI Success`
- `timeout-seconds`: total timeout, defaults to `300`
- `poll-interval-seconds`: delay between polls, defaults to `10`
- `settle-polls`: number of identical all-green polls required before success, defaults to `2`
- `ignore-checks`: newline or comma separated regular expressions for checks or statuses to ignore
- `allowed-conclusions`: newline or comma separated allowed terminal conclusions, defaults to `success,neutral,skipped`
- `require-observed-checks`: require at least one non-self check before success, defaults to `true`

## Notes

- On `pull_request` events, the action watches the PR head SHA.
- On other events, it falls back to `GITHUB_SHA`.
- The action observes both GitHub Checks and legacy commit statuses so it works during ruleset migrations.
- Pin the action by full commit SHA in consuming repositories once this action is released.
