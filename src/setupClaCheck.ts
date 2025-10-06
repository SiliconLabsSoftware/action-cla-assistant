import * as core from '@actions/core'
import { context } from '@actions/github'
import { checkAllowList } from './checkAllowList'
import getCommitters from './graphql'
import {
  ClafileContentAndSha,
  CommitterMap,
  CommittersDetails,
  ReactedCommitterMap
} from './interfaces'
import {
  createFile,
  getFileContent,
  updateFile
} from './persistence/persistence'
import prCommentSetup from './pullrequest/pullRequestComment'
import { reRunLastWorkFlowIfRequired } from './pullRerunRunner'
import { octokit } from './octokit'

async function getPRAuthorEmail(username: string): Promise<string | null> {
  try {
    const userResponse = await octokit.users.getByUsername({
      username: username
    })
    return userResponse.data.email
  } catch (error) {
    core.debug(`Could not fetch email for user ${username}: ${error}`)
    return null
  }
}

export async function setupClaCheck() {
  // Step 0: Check if PR author has @silabs.com email domain bypass
  const prAuthor = context?.payload?.pull_request?.user?.login
  if (prAuthor) {
    core.info(`Checking PR author ${prAuthor} for Silabs email domain bypass`)
    const prAuthorEmail = await getPRAuthorEmail(prAuthor)
    if (prAuthorEmail && prAuthorEmail.endsWith('@silabs.com')) {
      core.info(` PR Author ${prAuthor} has @silabs.com email (${prAuthorEmail}) - bypassing CLA check`)
      return reRunLastWorkFlowIfRequired()
    } else {
      core.info(`PR Author ${prAuthor} email: ${prAuthorEmail || 'not public'} - continuing with CLA check`)
    }
  }

  let committerMap = getInitialCommittersMap()

  let committers = await getCommitters()
  committers = checkAllowList(committers)

  const { claFileContent, sha } = (await getCLAFileContentandSHA(
    committers,
    committerMap
  )) as ClafileContentAndSha

  committerMap = prepareCommiterMap(committers, claFileContent) as CommitterMap

  try {
    const reactedCommitters = (await prCommentSetup(
      committerMap,
      committers
    )) as ReactedCommitterMap

    if (reactedCommitters?.newSigned.length) {
      /* pushing the recently signed  contributors to the CLA Json File */
      await updateFile(sha, claFileContent, reactedCommitters)
    }
    if (
      reactedCommitters?.allSignedFlag ||
      committerMap?.notSigned === undefined ||
      committerMap.notSigned.length === 0
    ) {
      core.info(`All contributors have signed the CLA 📝 ✅ `)
      return reRunLastWorkFlowIfRequired()
    } else {
      core.setFailed(
        `Committers of Pull Request number ${context.issue.number} have to sign the CLA 📝`
      )
    }
  } catch (err) {
    core.setFailed(`Could not update the JSON file: ${err.message}`)
  }
}

async function getCLAFileContentandSHA(
  committers: CommittersDetails[],
  committerMap: CommitterMap
): Promise<void | ClafileContentAndSha> {
  let result, claFileContentString, claFileContent, sha
  try {
    result = await getFileContent()
  } catch (error) {
    if (error.status === "404") {
      return createClaFileAndPRComment(committers, committerMap)
    } else {
      throw new Error(
        `Could not retrieve repository contents. Status: ${
          error.status || 'unknown'
        }`
      )
    }
  }
  sha = result?.data?.sha
  claFileContentString = Buffer.from(result.data.content, 'base64').toString()
  claFileContent = JSON.parse(claFileContentString)
  return { claFileContent, sha }
}

async function createClaFileAndPRComment(
  committers: CommittersDetails[],
  committerMap: CommitterMap
): Promise<void> {
  committerMap.notSigned = committers
  committerMap.signed = []
  committers.map(committer => {
    if (!committer.id) {
      committerMap.unknown.push(committer)
    }
  })

  const initialContent = { signedContributors: [] }
  const initialContentString = JSON.stringify(initialContent, null, 3)
  const initialContentBinary =
    Buffer.from(initialContentString).toString('base64')

  await createFile(initialContentBinary).catch(error =>
    core.setFailed(
      `Error occurred when creating the signed contributors file: ${
        error.message || error
      }. Make sure the branch where signatures are stored is NOT protected.`
    )
  )
  await prCommentSetup(committerMap, committers)
  throw new Error(
    `Committers of pull request ${context.issue.number} have to sign the CLA`
  )
}

function prepareCommiterMap(
  committers: CommittersDetails[],
  claFileContent
): CommitterMap {
  let committerMap = getInitialCommittersMap()
  const validDateOffset = 15811200000 // 183 days in millis
  const currentDate = Date.now()

  committerMap.notSigned = committers.filter(
    committer =>
      !claFileContent?.signedContributors.some(cla => (committer.id === cla.id) &&
        ((currentDate - Date.parse(cla.created_at)) < validDateOffset))
  )
  committerMap.signed = committers.filter(committer =>
    claFileContent?.signedContributors.some(cla => (committer.id === cla.id) &&
      ((currentDate - Date.parse(cla.created_at)) < validDateOffset))
  )
  committers.map(committer => {
    if (!committer.id) {
      committerMap.unknown.push(committer)
    }
  })
  return committerMap
}

const getInitialCommittersMap = (): CommitterMap => ({
  signed: [],
  notSigned: [],
  unknown: []
})
