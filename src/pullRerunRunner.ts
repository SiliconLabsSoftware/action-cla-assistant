import * as core from '@actions/core'
import { context } from '@actions/github'
import { octokit } from './octokit'

const workflowRunPageSize = 100
const maximumWorkflowRunPages = 10
const workflowPageSize = 100
const maximumWorkflowPages = 10
const workflowRunPollIntervalMilliseconds = 2000
const maximumWorkflowRunPollAttempts = 30
const retryableConclusions = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'startup_failure',
  'stale'
])
const completedConclusionsThatDoNotNeedARerun = new Set([
  'success',
  'neutral',
  'skipped'
])

interface PullRequestIdentity {
  headBranch: string
  headRepositoryId: number
  headSha: string
}

interface WorkflowIdentity {
  id: number
  path: string
  url: string
}

interface WorkflowRunDetails {
  conclusion: string | null
  created_at: string
  event: string
  head_branch: string
  head_repository: {
    id: number
  } | null
  head_sha: string
  id: number
  run_number: number
  status: string
  workflow_url: string
}

// pull_request_target creates the original CLA check. A later issue_comment
// event records the signature and reruns that exact check. New comments store
// the original run ID; the strict search below is only for legacy comments.
export async function rerunPullRequestWorkflowIfRequired(
  storedWorkflowRunIds: number[] = []
) {
  if (context.eventName !== 'issue_comment') {
    core.debug(`rerun not required for event - ${context.eventName}`)
    return
  }

  const pullRequestIdentity = await getPullRequestIdentity()
  const workflowIdentity = await getWorkflowIdentity()

  let workflowRun = await findNewestValidMarkedWorkflowRun(
    storedWorkflowRunIds,
    pullRequestIdentity,
    workflowIdentity
  )
  if (!workflowRun) {
    core.debug(
      'CLA comment has no valid workflow run marker; using strict legacy lookup'
    )
    const workflowRunId = await findLegacyWorkflowRunId(
      pullRequestIdentity,
      workflowIdentity
    )
    workflowRun = await getWorkflowRun(workflowRunId)
  }

  workflowRun = await waitForWorkflowRunToComplete(
    workflowRun,
    pullRequestIdentity,
    workflowIdentity
  )

  await rerunWorkflowForConclusion(workflowRun)
}

async function findNewestValidMarkedWorkflowRun(
  storedWorkflowRunIds: number[],
  pullRequestIdentity: PullRequestIdentity,
  workflowIdentity: WorkflowIdentity
): Promise<WorkflowRunDetails | undefined> {
  const uniqueWorkflowRunIds = [...new Set(storedWorkflowRunIds)]
  const validWorkflowRuns: WorkflowRunDetails[] = []

  for (const workflowRunId of uniqueWorkflowRunIds) {
    let workflowRun: WorkflowRunDetails
    try {
      workflowRun = await getWorkflowRun(workflowRunId)
    } catch (error) {
      if (isNotFoundError(error)) {
        core.debug(
          `Stored workflow run ${workflowRunId} no longer exists; ignoring marker`
        )
        continue
      }
      throw error
    }

    if (
      workflowRunMatches(
        workflowRun,
        pullRequestIdentity,
        workflowIdentity
      )
    ) {
      validWorkflowRuns.push(workflowRun)
    } else {
      core.debug(
        `Stored workflow run ${workflowRunId} does not match the current pull request; ignoring marker`
      )
    }
  }

  return validWorkflowRuns.sort(compareWorkflowRunsNewestFirst)[0]
}

function isNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return false
  }

  return error.status === 404
}

function compareWorkflowRunsNewestFirst(
  left: WorkflowRunDetails,
  right: WorkflowRunDetails
): number {
  const runNumberDifference = right.run_number - left.run_number
  if (runNumberDifference !== 0) {
    return runNumberDifference
  }

  const createdAtDifference =
    Date.parse(right.created_at) - Date.parse(left.created_at)

  if (createdAtDifference !== 0) {
    return createdAtDifference
  }

  return right.id - left.id
}

async function getPullRequestIdentity(): Promise<PullRequestIdentity> {
  const pullRequest = await octokit.pulls.get({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: context.issue.number
  })

  const headRepositoryId = pullRequest.data.head.repo?.id
  if (!headRepositoryId) {
    throw new Error(
      `Pull request ${context.issue.number} has no accessible head repository`
    )
  }

  return {
    headBranch: pullRequest.data.head.ref,
    headRepositoryId,
    headSha: pullRequest.data.head.sha
  }
}

async function getWorkflowIdentity(): Promise<WorkflowIdentity> {
  const workflowPath = getWorkflowPathFromEnvironment()
  for (let page = 1; page <= maximumWorkflowPages; page++) {
    const response = await octokit.actions.listRepoWorkflows({
      owner: context.repo.owner,
      repo: context.repo.repo,
      page,
      per_page: workflowPageSize
    })
    const workflow = response.data.workflows.find(
      candidate => candidate.path === workflowPath
    )

    if (workflow) {
      return {
        id: workflow.id,
        path: workflow.path,
        url: workflow.url
      }
    }

    if (page * workflowPageSize >= response.data.total_count) {
      break
    }
  }

  throw new Error(`Unable to locate workflow file ${workflowPath}`)
}

function getWorkflowPathFromEnvironment(): string {
  const workflowReference = process.env.GITHUB_WORKFLOW_REF
  if (!workflowReference) {
    throw new Error('GITHUB_WORKFLOW_REF is missing')
  }

  const repositoryPrefix = `${context.repo.owner}/${context.repo.repo}/`
  const refSeparatorIndex = workflowReference.lastIndexOf('@')
  if (
    !workflowReference.startsWith(repositoryPrefix) ||
    refSeparatorIndex <= repositoryPrefix.length
  ) {
    throw new Error(
      `GITHUB_WORKFLOW_REF has an unexpected format: ${workflowReference}`
    )
  }

  return workflowReference.slice(repositoryPrefix.length, refSeparatorIndex)
}

async function findLegacyWorkflowRunId(
  pullRequestIdentity: PullRequestIdentity,
  workflowIdentity: WorkflowIdentity
): Promise<number> {
  const workflowRuns = await listWorkflowRunsForHeadSha(
    pullRequestIdentity.headSha,
    workflowIdentity.id
  )
  const candidates = workflowRuns
    .filter(workflowRun =>
      workflowRunMatches(
        workflowRun,
        pullRequestIdentity,
        workflowIdentity
      )
    )
    .sort(compareWorkflowRunsNewestFirst)

  if (candidates.length === 0) {
    throw new Error(
      `Unable to locate a workflow run for pull request ${context.issue.number}`
    )
  }

  if (candidates.length > 1) {
    const candidateIds = candidates.map(candidate => candidate.id).join(', ')
    throw new Error(
      `Workflow run lookup is ambiguous for pull request ${context.issue.number}; candidates: ${candidateIds}`
    )
  }

  return candidates[0].id
}

async function listWorkflowRunsForHeadSha(
  headSha: string,
  workflowId: number
): Promise<WorkflowRunDetails[]> {
  const workflowRuns: WorkflowRunDetails[] = []
  let totalCount = 0

  for (let page = 1; page <= maximumWorkflowRunPages; page++) {
    const response = await octokit.actions.listWorkflowRuns({
      owner: context.repo.owner,
      repo: context.repo.repo,
      event: 'pull_request_target',
      head_sha: headSha,
      page,
      per_page: workflowRunPageSize,
      workflow_id: workflowId
    })

    totalCount = response.data.total_count
    const pageRuns = response.data.workflow_runs as WorkflowRunDetails[]
    workflowRuns.push(...pageRuns)

    if (
      pageRuns.length < workflowRunPageSize ||
      workflowRuns.length >= totalCount
    ) {
      return workflowRuns
    }
  }

  throw new Error(
    `Workflow run lookup exceeded ${maximumWorkflowRunPages * workflowRunPageSize} results for head SHA ${headSha}`
  )
}

async function getWorkflowRun(
  workflowRunId: number
): Promise<WorkflowRunDetails> {
  const response = await octokit.actions.getWorkflowRun({
    owner: context.repo.owner,
    repo: context.repo.repo,
    run_id: workflowRunId
  })

  return response.data as WorkflowRunDetails
}

function validateWorkflowRun(
  workflowRun: WorkflowRunDetails,
  pullRequestIdentity: PullRequestIdentity,
  workflowIdentity: WorkflowIdentity
): void {
  if (
    !workflowRunMatches(
      workflowRun,
      pullRequestIdentity,
      workflowIdentity
    )
  ) {
    throw new Error(
      `Workflow run ${workflowRun.id} does not belong to pull request ${context.issue.number} and workflow ${workflowIdentity.path}`
    )
  }
}

async function waitForWorkflowRunToComplete(
  initialWorkflowRun: WorkflowRunDetails,
  pullRequestIdentity: PullRequestIdentity,
  workflowIdentity: WorkflowIdentity
): Promise<WorkflowRunDetails> {
  let workflowRun = initialWorkflowRun

  for (
    let attempt = 1;
    attempt <= maximumWorkflowRunPollAttempts;
    attempt++
  ) {
    validateWorkflowRun(
      workflowRun,
      pullRequestIdentity,
      workflowIdentity
    )

    if (workflowRun.status === 'completed') {
      return workflowRun
    }

    if (attempt === maximumWorkflowRunPollAttempts) {
      break
    }

    core.debug(
      `Workflow run ${workflowRun.id} is ${workflowRun.status}; waiting for completion (${attempt}/${maximumWorkflowRunPollAttempts})`
    )
    await wait(workflowRunPollIntervalMilliseconds)
    workflowRun = await getWorkflowRun(workflowRun.id)
  }

  throw new Error(
    `Workflow run ${workflowRun.id} did not complete after ${maximumWorkflowRunPollAttempts} checks; status: ${workflowRun.status}`
  )
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, milliseconds))
}

function workflowRunMatches(
  workflowRun: WorkflowRunDetails,
  pullRequestIdentity: PullRequestIdentity,
  workflowIdentity: WorkflowIdentity
): boolean {
  return (
    workflowRun.event === 'pull_request_target' &&
    workflowRun.head_branch === pullRequestIdentity.headBranch &&
    workflowRun.head_repository?.id ===
      pullRequestIdentity.headRepositoryId &&
    workflowRun.head_sha === pullRequestIdentity.headSha &&
    workflowRun.workflow_url === workflowIdentity.url
  )
}

async function rerunWorkflowForConclusion(
  workflowRun: WorkflowRunDetails
): Promise<void> {
  if (workflowRun.status !== 'completed' || !workflowRun.conclusion) {
    throw new Error(
      `Workflow run ${workflowRun.id} is not completed; status: ${workflowRun.status}`
    )
  }

  if (completedConclusionsThatDoNotNeedARerun.has(workflowRun.conclusion)) {
    core.debug(
      `Workflow run ${workflowRun.id} does not require a rerun; conclusion: ${workflowRun.conclusion}`
    )
    return
  }

  if (!retryableConclusions.has(workflowRun.conclusion)) {
    throw new Error(
      `Workflow run ${workflowRun.id} has unsupported conclusion: ${workflowRun.conclusion}`
    )
  }

  core.debug(`Rerunning workflow run ${workflowRun.id}`)
  await octokit.actions.reRunWorkflow({
    owner: context.repo.owner,
    repo: context.repo.repo,
    run_id: workflowRun.id
  })
}
