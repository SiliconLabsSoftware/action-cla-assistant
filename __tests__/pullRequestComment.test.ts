import { context } from '@actions/github'
import { octokit } from '../src/octokit'
import { CommitterMap, CommittersDetails } from '../src/interfaces'
import prCommentSetup from '../src/pullrequest/pullRequestComment'
import signatureWithPRComment from '../src/pullrequest/signatureComment'
import { commentContent } from '../src/pullrequest/pullRequestCommentContent'
import { getUseDcoFlag } from '../src/shared/getInputs'

jest.mock('../src/octokit', () => ({
  octokit: {
    actions: {
      getWorkflowRun: jest.fn()
    },
    issues: {
      createComment: jest.fn(),
      getComment: jest.fn(),
      listComments: jest.fn(),
      updateComment: jest.fn()
    }
  }
}))
jest.mock('../src/pullrequest/signatureComment', () => ({
  __esModule: true,
  default: jest.fn()
}))
jest.mock('../src/pullrequest/pullRequestCommentContent', () => ({
  commentContent: jest.fn()
}))
jest.mock('../src/shared/getInputs', () => ({
  getUseDcoFlag: jest.fn()
}))

type CommentListResponse = Awaited<
  ReturnType<typeof octokit.issues.listComments>
>
type WorkflowRunResponse = Awaited<
  ReturnType<typeof octokit.actions.getWorkflowRun>
>
type CreateCommentResponse = Awaited<
  ReturnType<typeof octokit.issues.createComment>
>
type GetCommentResponse = Awaited<
  ReturnType<typeof octokit.issues.getComment>
>
type UpdateCommentResponse = Awaited<
  ReturnType<typeof octokit.issues.updateComment>
>

function createPartialResponse<T>(data: unknown): T {
  return { data } as T
}

describe('pull request CLA comment workflow marker', () => {
  const mockedCreateComment = jest.mocked(octokit.issues.createComment)
  const mockedGetWorkflowRun = jest.mocked(octokit.actions.getWorkflowRun)
  const mockedGetComment = jest.mocked(octokit.issues.getComment)
  const mockedListComments = jest.mocked(octokit.issues.listComments)
  const mockedUpdateComment = jest.mocked(octokit.issues.updateComment)
  const mockedSignatureWithPRComment = jest.mocked(signatureWithPRComment)
  const mockedCommentContent = jest.mocked(commentContent)
  const mockedGetUseDcoFlag = jest.mocked(getUseDcoFlag)

  const committer: CommittersDetails = {
    accountType: '',
    email: '',
    id: 42,
    name: 'contributor'
  }

  beforeEach(() => {
    jest.clearAllMocks()
    process.env.GITHUB_RUN_ID = '12345'
    process.env.GITHUB_RUN_NUMBER = '10'
    context.eventName = 'pull_request_target'
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
    mockedCommentContent.mockReturnValue('Visible CLA comment')
    mockedGetUseDcoFlag.mockReturnValue('false')
    mockedCreateComment.mockResolvedValue(
      createPartialResponse<CreateCommentResponse>({})
    )
    mockedGetWorkflowRun.mockResolvedValue(
      createPartialResponse<WorkflowRunResponse>({
        id: 12345,
        run_number: 10,
        workflow_url:
          'https://api.github.com/repos/SiliconLabsSoftware/community-creations/actions/workflows/123'
      })
    )
    mockedGetComment.mockResolvedValue(
      createPartialResponse<GetCommentResponse>({
        id: 77,
        body:
          'Existing CLA Assistant Lite bot.\n<!-- cla-assistant-workflow-run-id: 12345 -->',
        user: {
          login: 'github-actions[bot]'
        }
      })
    )
    mockedUpdateComment.mockResolvedValue(
      createPartialResponse<UpdateCommentResponse>({})
    )
    mockedSignatureWithPRComment.mockResolvedValue({
      allSignedFlag: false,
      newSigned: [],
      onlyCommitters: []
    })
  })

  afterAll(() => {
    delete process.env.GITHUB_RUN_ID
    delete process.env.GITHUB_RUN_NUMBER
  })

  test('stores the current workflow run ID in a new bot comment', async () => {
    mockedListComments.mockResolvedValue(
      createPartialResponse<CommentListResponse>([])
    )
    const committerMap: CommitterMap = {
      notSigned: [committer],
      signed: [],
      unknown: []
    }

    await prCommentSetup(committerMap, [committer])

    expect(mockedCreateComment).toHaveBeenCalledWith({
      owner: 'SiliconLabsSoftware',
      repo: 'community-creations',
      issue_number: 69,
      body:
        'Visible CLA comment\n<!-- cla-assistant-workflow-run-id: 12345 -->'
    })
  })

  test('preserves and returns the original run ID during issue comments', async () => {
    context.eventName = 'issue_comment'
    mockedListComments.mockResolvedValue(
      createPartialResponse<CommentListResponse>([
        {
          id: 77,
          body:
            'Existing CLA Assistant Lite bot.\n<!-- cla-assistant-workflow-run-id: 12345 -->',
          user: {
            login: 'github-actions[bot]'
          }
        }
      ])
    )
    const committerMap: CommitterMap = {
      notSigned: [],
      signed: [committer],
      unknown: []
    }

    const result = await prCommentSetup(committerMap, [committer])

    expect(result?.workflowRunIds).toEqual([12345])
    expect(mockedUpdateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body:
          'Visible CLA comment\n<!-- cla-assistant-workflow-run-id: 12345 -->'
      })
    )
  })

  test('does not trust a marker in a contributor-authored comment', async () => {
    mockedListComments.mockResolvedValue(
      createPartialResponse<CommentListResponse>([
        {
          id: 88,
          body:
            'Fake CLA Assistant Lite bot.\n<!-- cla-assistant-workflow-run-id: 99999 -->',
          user: {
            login: 'contributor'
          }
        }
      ])
    )
    const committerMap: CommitterMap = {
      notSigned: [committer],
      signed: [],
      unknown: []
    }

    await prCommentSetup(committerMap, [committer])

    expect(mockedUpdateComment).not.toHaveBeenCalled()
    expect(mockedCreateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body:
          'Visible CLA comment\n<!-- cla-assistant-workflow-run-id: 12345 -->'
      })
    )
  })

  test('finds the bot comment after the first page', async () => {
    context.eventName = 'issue_comment'
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      body: 'Ordinary discussion comment',
      user: {
        login: 'contributor'
      }
    }))
    mockedListComments
      .mockResolvedValueOnce(
        createPartialResponse<CommentListResponse>(firstPage)
      )
      .mockResolvedValueOnce(
        createPartialResponse<CommentListResponse>([
          {
            id: 101,
            body:
              'Existing CLA Assistant Lite bot.\n<!-- cla-assistant-workflow-run-id: 12345 -->',
            user: {
              login: 'github-actions[bot]'
            }
          }
        ])
      )
    const committerMap: CommitterMap = {
      notSigned: [],
      signed: [committer],
      unknown: []
    }

    const result = await prCommentSetup(committerMap, [committer])

    expect(mockedListComments).toHaveBeenCalledTimes(2)
    expect(mockedListComments).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 2, per_page: 100 })
    )
    expect(result?.workflowRunIds).toEqual([12345])
  })

  test('skips an older target run that finishes after a newer run', async () => {
    process.env.GITHUB_RUN_ID = '99999'
    const newerComment = {
      id: 77,
      body:
        'Existing CLA Assistant Lite bot.\n<!-- cla-assistant-workflow-run-id: 100 -->',
      user: {
        login: 'github-actions[bot]'
      }
    }
    mockedListComments.mockResolvedValue(
      createPartialResponse<CommentListResponse>([newerComment])
    )
    mockedGetComment.mockResolvedValue(
      createPartialResponse<GetCommentResponse>(newerComment)
    )
    mockedGetWorkflowRun
      .mockResolvedValueOnce(
        createPartialResponse<WorkflowRunResponse>({
          id: 100,
          run_number: 11,
          workflow_url:
            'https://api.github.com/repos/SiliconLabsSoftware/community-creations/actions/workflows/123'
        })
      )
      .mockResolvedValueOnce(
        createPartialResponse<WorkflowRunResponse>({
          id: 99999,
          run_number: 10,
          workflow_url:
            'https://api.github.com/repos/SiliconLabsSoftware/community-creations/actions/workflows/123'
        })
      )
    const committerMap: CommitterMap = {
      notSigned: [committer],
      signed: [],
      unknown: []
    }

    await prCommentSetup(committerMap, [committer])

    expect(mockedUpdateComment).not.toHaveBeenCalled()
  })

  test('returns markers from duplicate bot comments and updates the newest', async () => {
    context.eventName = 'issue_comment'
    const olderComment = {
      id: 77,
      body:
        'Existing CLA Assistant Lite bot.\n<!-- cla-assistant-workflow-run-id: 11111 -->',
      user: {
        login: 'github-actions[bot]'
      }
    }
    const newerComment = {
      id: 99,
      body:
        'Existing CLA Assistant Lite bot.\n<!-- cla-assistant-workflow-run-id: 22222 -->',
      user: {
        login: 'github-actions[bot]'
      }
    }
    mockedListComments.mockResolvedValue(
      createPartialResponse<CommentListResponse>([
        olderComment,
        newerComment
      ])
    )
    mockedGetComment.mockResolvedValue(
      createPartialResponse<GetCommentResponse>(newerComment)
    )
    const committerMap: CommitterMap = {
      notSigned: [],
      signed: [committer],
      unknown: []
    }

    const result = await prCommentSetup(committerMap, [committer])

    expect(result?.workflowRunIds).toEqual([11111, 22222])
    expect(mockedUpdateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 99 })
    )
  })
})
