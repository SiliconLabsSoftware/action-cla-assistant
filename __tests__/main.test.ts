import { context } from '@actions/github'
import { setupClaCheck } from '../src/setupClaCheck'
import { lockPullRequest } from '../src/pullrequest/pullRequestLock'
import * as input from '../src/shared/getInputs'
import { run } from '../src/main'

jest.mock('../src/setupClaCheck', () => ({
  setupClaCheck: jest.fn()
}))
jest.mock('../src/pullrequest/pullRequestLock', () => ({
  lockPullRequest: jest.fn()
}))
jest.mock('../src/shared/getInputs', () => ({
  lockPullRequestAfterMerge: jest.fn()
}))

describe('Pull request event', () => {
  const mockedSetupClaCheck = jest.mocked(setupClaCheck)
  const mockedLockPullRequest = jest.mocked(lockPullRequest)
  const mockedLockPullRequestAfterMerge = jest.mocked(
    input.lockPullRequestAfterMerge
  )

  beforeEach(() => {
    jest.clearAllMocks()
    context.payload = {
      action: 'closed',
      pull_request: {
        number: 1
      },
      repository: {
        name: 'auto-assign',
        owner: {
          login: 'ibakshay'
        }
      }
    }
    mockedLockPullRequestAfterMerge.mockReturnValue('true')
  })

  test('locks a closed pull request when locking is enabled', async () => {
    await run()
    expect(mockedLockPullRequest).toHaveBeenCalled()
    expect(mockedSetupClaCheck).not.toHaveBeenCalled()
  })

  test('checks the CLA for an opened pull request', async () => {
    context.payload.action = 'opened'
    await run()

    expect(mockedLockPullRequest).not.toHaveBeenCalled()
    expect(mockedSetupClaCheck).toHaveBeenCalled()
  })

  test('checks the CLA for a synchronized pull request', async () => {
    context.payload.action = 'synchronize'
    await run()

    expect(mockedSetupClaCheck).toHaveBeenCalled()
    expect(mockedLockPullRequest).not.toHaveBeenCalled()
  })
})
