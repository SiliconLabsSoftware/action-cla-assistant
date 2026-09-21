import { context } from '@actions/github'
import { octokit } from './octokit'

import * as core from '@actions/core'

// pull_request_target creates the original CLA check. A later issue_comment
// event records the signature and reruns that check. Forks often use identical
// branch names, so branch names alone cannot identify the correct workflow run.
// See https://github.com/cla-assistant/github-action/issues/39 for why the
// original failed check must be rerun.
export async function rerunPullRequestWorkflowIfRequired() {
  if (context.eventName !== 'issue_comment') {
    core.debug(`rerun not required for event - ${context.eventName}`)
    return
  }

  const headSha = await getPullRequestHeadSha()
  const workflowId = await getSelfWorkflowId()
  const runs = await listWorkflowRunsForHeadSha(headSha, workflowId)
  const workflowRun = runs.data.workflow_runs.find(
    run => run.head_sha === headSha
  )

  if (!workflowRun) {
    throw new Error(
      `Unable to locate a workflow run for pull request head SHA ${headSha}`
    )
  }

  const workflowRunFailed = await checkIfWorkflowRunFailed(
    workflowRun.id
  )
  if (workflowRunFailed) {
    core.debug(`Rerunning build run ${workflowRun.id}`)
    await rerunWorkflow(workflowRun.id)
  }
}

async function getPullRequestHeadSha(): Promise<string> {
  const pullRequest = await octokit.pulls.get({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: context.issue.number
  })

  return pullRequest.data.head.sha
}

async function getSelfWorkflowId(): Promise<number> {
  const perPage = 30
  let hasNextPage = true

  for (let page = 1; hasNextPage === true; page++) {
    const workflowList = await octokit.actions.listRepoWorkflows({
      owner: context.repo.owner,
      repo: context.repo.repo,
      per_page: perPage,
      page
    })

    if (workflowList.data.total_count < page * perPage) {
      hasNextPage = false
    }

    const workflow = workflowList.data.workflows.find(
      w => w.name == context.workflow
    )

    if (workflow) {
      return workflow.id
    }
  }

  throw new Error(
    `Unable to locate this workflow's ID in this repository, can't trigger job..`
  )
}

async function listWorkflowRunsForHeadSha(
  headSha: string,
  workflowId: number
) {
  const runs = await octokit.actions.listWorkflowRuns({
    owner: context.repo.owner,
    repo: context.repo.repo,
    head_sha: headSha,
    workflow_id: workflowId,
    event: 'pull_request_target'
  })
  return runs
}

async function rerunWorkflow(run: number): Promise<void> {
  // The workflow must grant the GITHUB_TOKEN the actions: write permission.
  await octokit.actions.reRunWorkflow({
    owner: context.repo.owner,
    repo: context.repo.repo,
    run_id: run
  })
}

async function checkIfWorkflowRunFailed(run: number): Promise<boolean> {
  const response = await octokit.actions.getWorkflowRun({
    owner: context.repo.owner,
    repo: context.repo.repo,
    run_id: run
  })

  return response.data.conclusion === 'failure'
}
