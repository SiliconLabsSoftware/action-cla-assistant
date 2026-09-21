import { context } from '@actions/github'
import * as core from '@actions/core'
import { octokit } from '../src/octokit'
import { lockPullRequest } from '../src/pullrequest/pullRequestLock'

jest.mock('@actions/core')
jest.mock('../src/octokit', () => ({
  octokit: {
    issues: {
      lock: jest.fn()
    }
  }
}))

describe('lockPullRequest', () => {
  const mockedLock = jest.mocked(octokit.issues.lock)

  beforeEach(() => {
    jest.clearAllMocks()
    context.payload = {
      issue: {
        number: 17
      },
      repository: {
        name: 'example-repository',
        owner: {
          login: 'example-owner'
        }
      }
    }
  })

  test('locks the current pull request', async () => {
    await lockPullRequest()

    expect(mockedLock).toHaveBeenCalledWith({
      owner: 'example-owner',
      repo: 'example-repository',
      issue_number: 17
    })
  })

  test('reports a lock failure without throwing', async () => {
    mockedLock.mockImplementationOnce(async () => {
      throw new Error('lock failed')
    })

    await expect(lockPullRequest()).resolves.toBeUndefined()
    expect(core.error).toHaveBeenCalledWith(
      'failed when locking the pull request '
    )
  })
})
