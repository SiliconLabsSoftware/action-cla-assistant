import { context } from '@actions/github'
import { octokit } from '../src/octokit'
import { rerunPullRequestWorkflowIfRequired } from '../src/pullRerunRunner'

jest.mock('../src/octokit', () => ({
  octokit: {
    pulls: {
      get: jest.fn()
    },
    actions: {
      listRepoWorkflows: jest.fn(),
      listWorkflowRuns: jest.fn(),
      getWorkflowRun: jest.fn(),
      reRunWorkflow: jest.fn()
    }
  }
}))

type PullRequestResponse = Awaited<ReturnType<typeof octokit.pulls.get>>
type WorkflowListResponse = Awaited<
  ReturnType<typeof octokit.actions.listRepoWorkflows>
>
type WorkflowRunsResponse = Awaited<
  ReturnType<typeof octokit.actions.listWorkflowRuns>
>
type WorkflowRunResponse = Awaited<
  ReturnType<typeof octokit.actions.getWorkflowRun>
>

// Octokit response objects contain extensive metadata that these unit tests do
// not use. This helper keeps each fixture focused on the API fields under test.
function createPartialResponse<T>(data: unknown): T {
  return { data } as T
}

describe('rerunPullRequestWorkflowIfRequired', () => {
  const mockedPullsGet = jest.mocked(octokit.pulls.get)
  const mockedListRepoWorkflows = jest.mocked(
    octokit.actions.listRepoWorkflows
  )
  const mockedListWorkflowRuns = jest.mocked(octokit.actions.listWorkflowRuns)
  const mockedGetWorkflowRun = jest.mocked(octokit.actions.getWorkflowRun)
  const mockedRerunWorkflow = jest.mocked(octokit.actions.reRunWorkflow)

  function setWorkflowRuns(
    workflowRuns: Array<{
      id: number
      head_branch: string
      head_sha: string
    }>
  ) {
    mockedListWorkflowRuns.mockResolvedValue(
      createPartialResponse<WorkflowRunsResponse>({
        total_count: workflowRuns.length,
        workflow_runs: workflowRuns
      })
    )
  }

  beforeEach(() => {
    jest.clearAllMocks()
    context.eventName = 'issue_comment'
    context.workflow = 'CLA Assistant'
    context.payload = {
      issue: {
        number: 69
      },
      repository: {
        name: 'community-creations',
        owner: {
          login: 'SiliconLabsSoftware'
        }
      }
    }

    mockedPullsGet.mockResolvedValue(
      createPartialResponse<PullRequestResponse>({
        head: {
          ref: 'main',
          sha: 'current-pr-head-sha'
        }
      })
    )
    mockedListRepoWorkflows.mockResolvedValue(
      createPartialResponse<WorkflowListResponse>({
        total_count: 1,
        workflows: [
          {
            id: 123,
            name: 'CLA Assistant'
          }
        ]
      })
    )
    mockedGetWorkflowRun.mockResolvedValue(
      createPartialResponse<WorkflowRunResponse>({
        conclusion: 'failure'
      })
    )
  })

  test('does not look up reruns for pull_request_target events', async () => {
    context.eventName = 'pull_request_target'

    await rerunPullRequestWorkflowIfRequired()

    expect(mockedPullsGet).not.toHaveBeenCalled()
    expect(mockedRerunWorkflow).not.toHaveBeenCalled()
  })

  test('reruns the workflow matching the pull request head SHA', async () => {
    setWorkflowRuns([
      {
        id: 9001,
        head_branch: 'main',
        head_sha: 'different-pr-head-sha'
      },
      {
        id: 9002,
        head_branch: 'main',
        head_sha: 'current-pr-head-sha'
      }
    ])

    await rerunPullRequestWorkflowIfRequired()

    expect(mockedListWorkflowRuns).toHaveBeenCalledWith({
      owner: 'SiliconLabsSoftware',
      repo: 'community-creations',
      head_sha: 'current-pr-head-sha',
      workflow_id: 123,
      event: 'pull_request_target'
    })
    expect(mockedGetWorkflowRun).toHaveBeenCalledWith({
      owner: 'SiliconLabsSoftware',
      repo: 'community-creations',
      run_id: 9002
    })
    expect(mockedRerunWorkflow).toHaveBeenCalledWith({
      owner: 'SiliconLabsSoftware',
      repo: 'community-creations',
      run_id: 9002
    })
  })

  test('fails when no workflow belongs to the pull request SHA', async () => {
    setWorkflowRuns([
      {
        id: 9001,
        head_branch: 'main',
        head_sha: 'different-pr-head-sha'
      }
    ])

    await expect(rerunPullRequestWorkflowIfRequired()).rejects.toThrow(
      'Unable to locate a workflow run for pull request head SHA current-pr-head-sha'
    )
    expect(mockedGetWorkflowRun).not.toHaveBeenCalled()
    expect(mockedRerunWorkflow).not.toHaveBeenCalled()
  })

  test('does not rerun a successful workflow', async () => {
    setWorkflowRuns([
      {
        id: 9002,
        head_branch: 'main',
        head_sha: 'current-pr-head-sha'
      }
    ])
    mockedGetWorkflowRun.mockResolvedValue(
      createPartialResponse<WorkflowRunResponse>({
        conclusion: 'success'
      })
    )

    await rerunPullRequestWorkflowIfRequired()

    expect(mockedRerunWorkflow).not.toHaveBeenCalled()
  })

  test('reports a rerun API failure to the caller', async () => {
    setWorkflowRuns([
      {
        id: 9002,
        head_branch: 'main',
        head_sha: 'current-pr-head-sha'
      }
    ])
    mockedRerunWorkflow.mockRejectedValueOnce(new Error('API unavailable'))

    await expect(rerunPullRequestWorkflowIfRequired()).rejects.toThrow(
      'API unavailable'
    )
  })
})
