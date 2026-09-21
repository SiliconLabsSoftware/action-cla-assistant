# CLA workflow rerun branch-collision investigation

Date investigated: 2026-09-21

## Summary

The CLA signature flow succeeds, but the action can rerun the wrong failed
GitHub Actions workflow when multiple pull requests use the same head branch
name. This is common for pull requests opened from forks whose default branch
is named `main` or `master`.

The affected code is in `src/pullRerunRunner.ts`. It retrieves the pull
request's head branch name, lists `pull_request_target` workflow runs using
that branch name, and selects `workflow_runs[0]`. A branch name does not
uniquely identify a pull request across forks.

The intermediate fix on branch `SOSC-267-fix-cla-check` narrows workflow runs
using the pull request's head commit SHA instead. A later senior review found
that a SHA can still be shared by multiple pull requests, so this is not yet a
complete run-identity solution.

## Observed failure

The investigation compared these pull requests:

- Failing case: [SiliconLabsSoftware/community-creations#69](https://github.com/SiliconLabsSoftware/community-creations/pull/69)
- Passing control case: [SiliconLabsSoftware/devs-refd-ble-remote#5](https://github.com/SiliconLabsSoftware/devs-refd-ble-remote/pull/5)

### `community-creations#69`

1. The initial `pull_request_target` run correctly failed on 2026-08-21
   because the contributor had not signed yet:
   [run 32485695296](https://github.com/SiliconLabsSoftware/community-creations/actions/runs/32485695296).
2. The contributor signed on 2026-09-10.
3. The signature was successfully stored in the shared CLA database.
4. Comment-triggered action runs subsequently logged `All contributors have
   signed the CLA`.
5. The original failed check remained at attempt 1 and stayed attached to the
   pull request.
6. Instead, the action repeatedly reran an unrelated failed workflow named
   `Real-Time Gesture Recognition using Siwx917`. That workflow reached attempt
   6 after comments were added to pull request 69.

The pull request's fork branch was named `main`. The unrelated workflow also
used a head branch named `main`, so branch-only selection chose the newer,
unrelated run.

### `devs-refd-ble-remote#5`

The control pull request used the distinctive branch name
`test-cla-funcitonality`:

1. Attempt 1 failed because the contributor had not signed.
2. The contributor posted the CLA signature comment.
3. The issue-comment workflow stored the signature and selected the failed run
   by its branch name.
4. Because that branch name was unique, the action happened to select the
   correct run.
5. Attempt 2 passed:
   [run 35578807829](https://github.com/SiliconLabsSoftware/devs-refd-ble-remote/actions/runs/35578807829).

This confirms that the passing repository does not disprove the bug. Its
unique branch name merely avoids the collision.

## Original problematic implementation

Before the fix, the relevant flow in `src/pullRerunRunner.ts` was:

1. `getBranchOfPullRequest()` returns `pullRequest.data.head.ref`.
2. `listWorkflowRunsInBranch()` passes that value as the `branch` filter to
   `octokit.actions.listWorkflowRuns()`.
3. `reRunLastWorkFlowIfRequired()` selects `workflow_runs[0]` without verifying
   that the run belongs to the current pull request's head commit.

The same implementation was compiled into `dist/index.js`, which is the file
executed by GitHub Actions.

There was also a related event guard:

```ts
if (context.eventName === 'pull_request') {
  return
}
```

The workflow uses `pull_request_target`, not `pull_request`. Rerun handling
should be restricted to the intended comment-triggered event rather than
relying on this mismatched exclusion.

## Consumer workflow observation

The `community-creations` workflow also used a partially wrapped expression:

```yaml
if: ${{ contains(github.event.comment.body, 'I have read the CLA Document and I hereby sign the CLA') }} || github.event_name == 'pull_request_target'
```

It ran the CLA action for unrelated issue comments, including `recheck` and
ordinary discussion comments. The more robust pattern used by the control
repository places one complete condition at job level and explicitly accepts
only:

- `pull_request_target`; or
- a pull-request issue comment whose body is `recheck` or contains the CLA
  signature text.

This workflow condition should be corrected separately. It causes unnecessary
runs, but the persistent red check on pull request 69 is explained by the
action's branch-only rerun selection.

## Upstream fork search

A read-only search of the upstream fork network found no existing fix for the
cross-fork branch-name collision.

- Canonical repository: [contributor-assistant/github-action](https://github.com/contributor-assistant/github-action)
- Accessible forks enumerated through the GitHub API: 134
- Forks reported by repository metadata: 143
- Default branches with resolvable comparisons: 129
- Copies of `pullRerunRunner.ts` inspected: 118
- Unique implementations after content deduplication: 11

The search prioritized recent and divergent forks, compared ahead commits,
inspected relevant non-default branches, and searched source, commits, issues,
and pull requests for terms including:

- `reRunLastWorkFlowIfRequired`
- `listWorkflowRunsInBranch`
- `getBranchOfPullRequest`
- `head_sha`
- `pull_request_target`
- `workflow_runs[0]`

Every inspected implementation continued to combine the pull request branch
name with `workflow_runs[0]`. None used the pull request head SHA to uniquely
identify the run.

Nine forks reported in the repository count were not returned by the API and
were likely deleted, private, or otherwise inaccessible.

## Closest related upstream changes

- [iainmcgin/cla-github-action commit eeb7f3f](https://github.com/iainmcgin/cla-github-action/commit/eeb7f3ffa305b600c6e873578b9ea78ca11a5f3e)
  skips rerun logic for `pull_request_target`. This addresses a different
  false-failure problem but still selects runs by branch name.
- [contributor-assistant/github-action#139](https://github.com/contributor-assistant/github-action/pull/139)
  improves workflow-list pagination but does not change run identity or solve
  branch-name collisions.

No open issue in the separately maintained
[`cla-assistant/cla-assistant`](https://github.com/cla-assistant/cla-assistant/issues)
service repository explicitly described this root cause. Several issues report
similar symptoms, such as a signed CLA remaining pending, but there is not
enough evidence to treat them as the same defect.

## Intermediate implementation

The first action fix on `SOSC-267-fix-cla-check`:

1. Executes rerun lookup only for the intended `issue_comment` event.
2. Retrieves the pull request's exact `head.sha`.
3. Queries `pull_request_target` workflow runs using `head_sha` rather than
   `head.ref`.
4. Verifies the selected run has the current head SHA before requesting a
   rerun.
5. Includes regression coverage where two fork pull requests both use a
   branch named `main` but have different head SHAs.
6. Regenerates `dist/index.js` from the updated TypeScript source.

This resolves the observed branch-name collision, but it must not be treated
as release-ready until workflow-run identity is made unambiguous. The consumer
workflow condition also remains a separate repository change.

## Remaining architecture work

A senior follow-up review found these unresolved cases:

1. A head SHA can be used by multiple pull requests. The implementation must
   not select the first SHA match without additional identity checks.
2. Workflow display names are not unique. Workflow lookup should use the
   workflow file path rather than only `context.workflow`.
3. API ordering is not guaranteed, and a filtered SHA can have multiple runs.
   Any search-based fallback must sort explicitly, paginate, and reject
   ambiguous candidates.
4. The action should define which conclusions are retryable instead of only
   handling `failure` implicitly.
5. Rerun lookup and API failures must remain visible so the comment-triggered
   workflow cannot report success while the pull request remains blocked.

The preferred robust design is to store the original `GITHUB_RUN_ID` in a
hidden marker in the CLA bot comment. A later `issue_comment` run can retrieve
that exact ID and validate its workflow path, head repository, branch, and SHA
before requesting the rerun. Existing comments without a marker need a strict,
ambiguity-safe fallback.

## Testing note

At the start of this investigation, the repository's existing Jest suite did
not execute any tests. It failed during TypeScript compilation because the
tests contained stale source imports, used the removed `ts-jest/utils` path,
and lacked Jest type declarations. There was no test coverage for
`pullRerunRunner.ts`.

The branch repairs the two existing test files and adds focused rerun tests.
The intermediate suite contains ten passing tests across three suites,
including the same-branch-name collision regression, successful-run behavior,
and visible rerun API failures.
