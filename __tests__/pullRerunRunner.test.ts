import { context } from '@actions/github'
import { octokit } from '../src/octokit'
import { rerunPullRequestWorkflowIfRequired } from '../src/pullRerunRunner'

jest.mock('../src/octokit', () => ({
  octokit: {
    pulls: {
      get: jest.fn()
    },
    actions: {
      getWorkflowRun: jest.fn(),
      listRepoWorkflows: jest.fn(),
      listWorkflowRuns: jest.fn(),
      reRunWorkflow: jest.fn()
    }
  }
}))

type PullRequestResponse = Awaited<ReturnType<typeof octokit.pulls.get>>
type WorkflowListResponse = Awaited<
  ReturnType<typeof octokit.actions.listRepoWorkflows>
>
type WorkflowRunResponse = Awaited<
  ReturnType<typeof octokit.actions.getWorkflowRun>
>
type WorkflowRunsResponse = Awaited<
  ReturnType<typeof octokit.actions.listWorkflowRuns>
>

interface WorkflowRunFixture {
  conclusion: string | null
  created_at: string
  event: string
  head_branch: string
  head_repository: {
    id: number
  }
  head_sha: string
  id: number
  run_number: number
  status: string
  workflow_url: string
}

function createPartialResponse<T>(data: unknown): T {
  return { data } as T
}

describe('rerunPullRequestWorkflowIfRequired', () => {
  const mockedPullsGet = jest.mocked(octokit.pulls.get)
  const mockedGetWorkflowRun = jest.mocked(octokit.actions.getWorkflowRun)
  const mockedListRepoWorkflows = jest.mocked(
    octokit.actions.listRepoWorkflows
  )
  const mockedListWorkflowRuns = jest.mocked(octokit.actions.listWorkflowRuns)
  const mockedRerunWorkflow = jest.mocked(octokit.actions.reRunWorkflow)

  function createWorkflowRun(
    overrides: Partial<WorkflowRunFixture> = {}
  ): WorkflowRunFixture {
    return {
      conclusion: 'failure',
      created_at: '2026-09-21T08:00:00Z',
      event: 'pull_request_target',
      head_branch: 'main',
      head_repository: {
        id: 456
      },
      head_sha: 'current-pr-head-sha',
      id: 9002,
      run_number: 12,
      status: 'completed',
      workflow_url:
        'https://api.github.com/repos/SiliconLabsSoftware/community-creations/actions/workflows/123',
      ...overrides
    }
  }

  function setWorkflowRunResponse(workflowRun: WorkflowRunFixture): void {
    mockedGetWorkflowRun.mockResolvedValue(
      createPartialResponse<WorkflowRunResponse>(workflowRun)
    )
  }

  function setWorkflowRunsResponse(
    workflowRuns: WorkflowRunFixture[],
    totalCount = workflowRuns.length
  ): void {
    mockedListWorkflowRuns.mockResolvedValue(
      createPartialResponse<WorkflowRunsResponse>({
        total_count: totalCount,
        workflow_runs: workflowRuns
      })
    )
  }

  beforeEach(() => {
    jest.clearAllMocks()
    process.env.GITHUB_WORKFLOW_REF =
      'SiliconLabsSoftware/community-creations/.github/workflows/cla.yml@refs/heads/main'
    context.eventName = 'issue_comment'
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
          repo: {
            id: 456
          },
          sha: 'current-pr-head-sha'
        }
      })
    )
    mockedListRepoWorkflows.mockResolvedValue(
      createPartialResponse<WorkflowListResponse>({
        total_count: 2,
        workflows: [
          {
            id: 999,
            name: 'CLA Assistant',
            path: '.github/workflows/different-cla.yml',
            url:
              'https://api.github.com/repos/SiliconLabsSoftware/community-creations/actions/workflows/999'
          },
          {
            id: 123,
            name: 'CLA Assistant',
            path: '.github/workflows/cla.yml',
            url:
              'https://api.github.com/repos/SiliconLabsSoftware/community-creations/actions/workflows/123'
          }
        ]
      })
    )
    setWorkflowRunResponse(createWorkflowRun())
  })

  afterAll(() => {
    delete process.env.GITHUB_WORKFLOW_REF
  })

  test('does not look up reruns for pull_request_target events', async () => {
    context.eventName = 'pull_request_target'

    await rerunPullRequestWorkflowIfRequired([9002])

    expect(mockedPullsGet).not.toHaveBeenCalled()
    expect(mockedRerunWorkflow).not.toHaveBeenCalled()
  })

  test('validates and reruns the workflow stored in the bot comment', async () => {
    await rerunPullRequestWorkflowIfRequired([9002])

    expect(mockedListRepoWorkflows).toHaveBeenCalledWith({
      owner: 'SiliconLabsSoftware',
      repo: 'community-creations',
      page: 1,
      per_page: 100
    })
    expect(mockedGetWorkflowRun).toHaveBeenCalledWith({
      owner: 'SiliconLabsSoftware',
      repo: 'community-creations',
      run_id: 9002
    })
    expect(mockedListWorkflowRuns).not.toHaveBeenCalled()
    expect(mockedRerunWorkflow).toHaveBeenCalledWith({
      owner: 'SiliconLabsSoftware',
      repo: 'community-creations',
      run_id: 9002
    })
  })

  test('uses the newest valid run from duplicate bot comments', async () => {
    mockedGetWorkflowRun
      .mockResolvedValueOnce(
        createPartialResponse<WorkflowRunResponse>(
          createWorkflowRun({
            created_at: '2026-09-21T07:00:00Z',
            id: 9999,
            run_number: 11
          })
        )
      )
      .mockResolvedValueOnce(
        createPartialResponse<WorkflowRunResponse>(
          createWorkflowRun({
            created_at: '2026-09-21T08:00:00Z',
            id: 100,
            run_number: 12
          })
        )
      )

    await rerunPullRequestWorkflowIfRequired([9999, 100])

    expect(mockedListWorkflowRuns).not.toHaveBeenCalled()
    expect(mockedRerunWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: 100 })
    )
  })

  test('ignores a deleted marker when another valid marker exists', async () => {
    const notFoundError = Object.assign(new Error('run not found'), {
      status: 404
    })
    mockedGetWorkflowRun
      .mockRejectedValueOnce(notFoundError)
      .mockResolvedValueOnce(
        createPartialResponse<WorkflowRunResponse>(createWorkflowRun())
      )

    await rerunPullRequestWorkflowIfRequired([9001, 9002])

    expect(mockedListWorkflowRuns).not.toHaveBeenCalled()
    expect(mockedRerunWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: 9002 })
    )
  })

  test('reports a marker lookup API failure instead of hiding it', async () => {
    const serverError = Object.assign(new Error('API unavailable'), {
      status: 500
    })
    mockedGetWorkflowRun.mockRejectedValueOnce(serverError)

    await expect(
      rerunPullRequestWorkflowIfRequired([9002])
    ).rejects.toThrow('API unavailable')
    expect(mockedListWorkflowRuns).not.toHaveBeenCalled()
    expect(mockedRerunWorkflow).not.toHaveBeenCalled()
  })

  test('falls back when a stored run belongs to a different fork', async () => {
    mockedGetWorkflowRun
      .mockResolvedValueOnce(
        createPartialResponse<WorkflowRunResponse>(
          createWorkflowRun({
            head_repository: {
              id: 999
            }
          })
        )
      )
      .mockResolvedValueOnce(
        createPartialResponse<WorkflowRunResponse>(createWorkflowRun())
      )
    setWorkflowRunsResponse([createWorkflowRun()])

    await rerunPullRequestWorkflowIfRequired([9002])

    expect(mockedListWorkflowRuns).toHaveBeenCalled()
    expect(mockedRerunWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: 9002 })
    )
  })

  test('uses a single exact legacy candidate when no marker exists', async () => {
    setWorkflowRunsResponse([
      createWorkflowRun({
        head_repository: {
          id: 999
        },
        id: 9001
      }),
      createWorkflowRun()
    ])

    await rerunPullRequestWorkflowIfRequired()

    expect(mockedListWorkflowRuns).toHaveBeenCalledWith({
      owner: 'SiliconLabsSoftware',
      repo: 'community-creations',
      event: 'pull_request_target',
      head_sha: 'current-pr-head-sha',
      page: 1,
      per_page: 100,
      workflow_id: 123
    })
    expect(mockedRerunWorkflow).toHaveBeenCalledWith({
      owner: 'SiliconLabsSoftware',
      repo: 'community-creations',
      run_id: 9002
    })
  })

  test('rejects an ambiguous legacy lookup', async () => {
    setWorkflowRunsResponse([
      createWorkflowRun({ id: 9001 }),
      createWorkflowRun({ id: 9002 })
    ])

    await expect(rerunPullRequestWorkflowIfRequired()).rejects.toThrow(
      'Workflow run lookup is ambiguous for pull request 69; candidates: 9002, 9001'
    )
    expect(mockedGetWorkflowRun).not.toHaveBeenCalled()
    expect(mockedRerunWorkflow).not.toHaveBeenCalled()
  })

  test('paginates the legacy lookup before selecting a candidate', async () => {
    const unrelatedRuns = Array.from({ length: 100 }, (_, index) =>
      createWorkflowRun({
        head_repository: {
          id: 999
        },
        id: index + 1
      })
    )
    mockedListWorkflowRuns
      .mockResolvedValueOnce(
        createPartialResponse<WorkflowRunsResponse>({
          total_count: 101,
          workflow_runs: unrelatedRuns
        })
      )
      .mockResolvedValueOnce(
        createPartialResponse<WorkflowRunsResponse>({
          total_count: 101,
          workflow_runs: [createWorkflowRun()]
        })
      )

    await rerunPullRequestWorkflowIfRequired()

    expect(mockedListWorkflowRuns).toHaveBeenCalledTimes(2)
    expect(mockedListWorkflowRuns).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 2 })
    )
    expect(mockedRerunWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: 9002 })
    )
  })

  test.each(['success', 'neutral', 'skipped'])(
    'does not rerun a workflow with conclusion %s',
    async conclusion => {
    setWorkflowRunResponse(
      createWorkflowRun({
          conclusion
      })
    )

    await rerunPullRequestWorkflowIfRequired([9002])

    expect(mockedRerunWorkflow).not.toHaveBeenCalled()
    }
  )

  test.each([
    'failure',
    'cancelled',
    'timed_out',
    'startup_failure',
    'stale'
  ])('reruns a workflow with conclusion %s', async conclusion => {
    setWorkflowRunResponse(createWorkflowRun({ conclusion }))

    await rerunPullRequestWorkflowIfRequired([9002])

    expect(mockedRerunWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: 9002 })
    )
  })

  test('waits for a running workflow before rerunning it', async () => {
    const immediateTimer = jest
      .spyOn(global, 'setTimeout')
      .mockImplementation(callback => {
        callback()
        return 0 as unknown as NodeJS.Timeout
      })
    mockedGetWorkflowRun
      .mockResolvedValueOnce(
        createPartialResponse<WorkflowRunResponse>(
          createWorkflowRun({
            conclusion: null,
            status: 'in_progress'
          })
        )
      )
      .mockResolvedValueOnce(
        createPartialResponse<WorkflowRunResponse>(createWorkflowRun())
      )

    await rerunPullRequestWorkflowIfRequired([9002])

    expect(mockedGetWorkflowRun).toHaveBeenCalledTimes(2)
    expect(mockedRerunWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: 9002 })
    )
    immediateTimer.mockRestore()
  })

  test('reports when a workflow does not finish before the polling limit', async () => {
    const immediateTimer = jest
      .spyOn(global, 'setTimeout')
      .mockImplementation(callback => {
        callback()
        return 0 as unknown as NodeJS.Timeout
      })
    setWorkflowRunResponse(
      createWorkflowRun({
        conclusion: null,
        status: 'in_progress'
      })
    )

    await expect(
      rerunPullRequestWorkflowIfRequired([9002])
    ).rejects.toThrow(
      'Workflow run 9002 did not complete after 30 checks; status: in_progress'
    )
    expect(mockedGetWorkflowRun).toHaveBeenCalledTimes(30)
    expect(mockedRerunWorkflow).not.toHaveBeenCalled()
    immediateTimer.mockRestore()
  })

  test('rejects an unsupported completed conclusion', async () => {
    setWorkflowRunResponse(
      createWorkflowRun({
        conclusion: 'action_required'
      })
    )

    await expect(rerunPullRequestWorkflowIfRequired([9002])).rejects.toThrow(
      'Workflow run 9002 has unsupported conclusion: action_required'
    )
  })

  test('reports a rerun API failure to the caller', async () => {
    mockedRerunWorkflow.mockRejectedValueOnce(new Error('API unavailable'))

    await expect(rerunPullRequestWorkflowIfRequired([9002])).rejects.toThrow(
      'API unavailable'
    )
  })
})
