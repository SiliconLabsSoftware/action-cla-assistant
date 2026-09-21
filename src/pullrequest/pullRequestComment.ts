import * as core from '@actions/core'
import { octokit } from '../octokit'
import { context } from '@actions/github'
import signatureWithPRComment from './signatureComment'
import { commentContent } from './pullRequestCommentContent'
import {
  CommitterMap,
  CommittersDetails
} from '../interfaces'
import { getUseDcoFlag } from '../shared/getInputs'
import {
  addWorkflowRunIdToComment,
  getWorkflowRunIdFromComment,
  parseWorkflowRunId
} from './workflowRunMarker'

const commentPageSize = 100
const maximumCommentPages = 10
type IssueComment = Awaited<
  ReturnType<typeof octokit.issues.listComments>
>['data'][number]

export default async function prCommentSetup(committerMap: CommitterMap, committers: CommittersDetails[]) {
  const signed = committerMap?.notSigned && committerMap?.notSigned.length === 0

  try {
    const claBotComments = await getComments()
    const claBotComment = selectNewestComment(claBotComments)
    if (!claBotComment && !signed) {
      return createComment(signed, committerMap)
    } else if (claBotComment?.id) {
      // reacted committers are contributors who have newly signed by posting the Pull Request comment
      const reactedCommitters = await signatureWithPRComment(committerMap, committers)
      if (reactedCommitters?.onlyCommitters) {
          reactedCommitters.allSignedFlag = prepareAllSignedCommitters(committerMap, reactedCommitters.onlyCommitters, committers)
      }
      reactedCommitters.workflowRunIds = claBotComments
        .map(comment => getWorkflowRunIdFromComment(comment.body))
        .filter((workflowRunId): workflowRunId is number => !!workflowRunId)
      committerMap = prepareCommiterMap(committerMap, reactedCommitters)
      await updateComment(reactedCommitters.allSignedFlag, committerMap, claBotComment)
      return reactedCommitters
    }
  } catch (error) {
    throw new Error(
      `Error occured when creating or editing the comments of the pull request: ${error.message}`)
  }
}

async function createComment(signed: boolean, committerMap: CommitterMap): Promise<void> {
  await octokit.issues.createComment({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: context.issue.number,
    body: buildCommentContent(signed, committerMap)
  }).catch(error => { throw new Error(`Error occured when creating a pull request comment: ${error.message}`) })
}

async function updateComment(
  signed: boolean,
  committerMap: CommitterMap,
  claBotComment: IssueComment
): Promise<void> {
  const latestComment = await octokit.issues.getComment({
    owner: context.repo.owner,
    repo: context.repo.repo,
    comment_id: claBotComment.id
  })
  if (await newerTargetRunAlreadyOwnsComment(latestComment.data.body)) {
    return
  }

  await octokit.issues.updateComment({
    owner: context.repo.owner,
    repo: context.repo.repo,
    comment_id: claBotComment.id,
    body: buildCommentContent(signed, committerMap, latestComment.data.body)
  }).catch(error => { throw new Error(`Error occured when updating the pull request comment: ${error.message}`) })
}

async function newerTargetRunAlreadyOwnsComment(
  commentBody: string | null | undefined
): Promise<boolean> {
  if (context.eventName !== 'pull_request_target') {
    return false
  }

  const storedWorkflowRunId = getWorkflowRunIdFromComment(commentBody)
  if (!storedWorkflowRunId) {
    return false
  }

  const currentWorkflowRunId = parseWorkflowRunId(process.env.GITHUB_RUN_ID)
  const currentWorkflowRunNumber = parseWorkflowRunId(
    process.env.GITHUB_RUN_NUMBER
  )
  if (!currentWorkflowRunId || !currentWorkflowRunNumber) {
    throw new Error('GITHUB_RUN_ID or GITHUB_RUN_NUMBER is missing or invalid')
  }

  let storedWorkflowRun
  try {
    storedWorkflowRun = await octokit.actions.getWorkflowRun({
      owner: context.repo.owner,
      repo: context.repo.repo,
      run_id: storedWorkflowRunId
    })
  } catch (error) {
    if (isNotFoundError(error)) {
      return false
    }
    throw error
  }

  if (storedWorkflowRun.data.run_number <= currentWorkflowRunNumber) {
    return false
  }

  const currentWorkflowRun = await octokit.actions.getWorkflowRun({
    owner: context.repo.owner,
    repo: context.repo.repo,
    run_id: currentWorkflowRunId
  })
  const sameWorkflow =
    storedWorkflowRun.data.workflow_url ===
    currentWorkflowRun.data.workflow_url

  if (sameWorkflow) {
    core.debug(
      `Skipping stale comment update from workflow run ${currentWorkflowRunId}; run ${storedWorkflowRunId} is newer`
    )
  }

  return sameWorkflow
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    error.status === 404
  )
}

async function getComments(): Promise<IssueComment[]> {
  try {
    const botComments: IssueComment[] = []

    for (let page = 1; page <= maximumCommentPages; page++) {
      const response = await octokit.issues.listComments({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: context.issue.number,
        page,
        per_page: commentPageSize
      })
      botComments.push(
        ...response.data.filter(comment =>
          isExpectedAssistantComment(comment)
        )
      )

      if (response.data.length < commentPageSize) {
        return botComments
      }
    }

    throw new Error(
      `CLA bot comment lookup exceeded ${maximumCommentPages * commentPageSize} comments`
    )
  } catch (error) {
    throw new Error(`Error occured when getting  all the comments of the pull request: ${error.message}`)
  }
}

function selectNewestComment(
  comments: IssueComment[]
): IssueComment | undefined {
  return comments.reduce<IssueComment | undefined>((newest, comment) => {
    if (!newest || comment.id > newest.id) {
      return comment
    }

    return newest
  }, undefined)
}

function isGitHubActionsBotComment(comment: IssueComment): boolean {
  return comment.user?.login === 'github-actions[bot]' && !!comment.body
}

function isExpectedAssistantComment(comment: IssueComment): boolean {
  if (!isGitHubActionsBotComment(comment)) {
    return false
  }

  // GitHub Action inputs are strings rather than booleans.
  if (getUseDcoFlag() === 'true') {
    return comment.body.match(/.*DCO Assistant Lite bot.*/m) !== null
  }

  return comment.body.match(/.*CLA Assistant Lite bot.*/m) !== null
}

function buildCommentContent(
  signed: boolean,
  committerMap: CommitterMap,
  existingCommentBody?: string
): string {
  const body = commentContent(signed, committerMap)
  let workflowRunId: number | undefined

  if (context.eventName === 'pull_request_target') {
    workflowRunId = parseWorkflowRunId(process.env.GITHUB_RUN_ID)
    if (!workflowRunId) {
      throw new Error('GITHUB_RUN_ID is missing or invalid')
    }
  } else {
    workflowRunId = getWorkflowRunIdFromComment(existingCommentBody)
  }

  if (!workflowRunId) {
    return body
  }

  return addWorkflowRunIdToComment(body, workflowRunId)
}

function prepareCommiterMap(committerMap: CommitterMap, reactedCommitters) {
  committerMap.signed?.push(...reactedCommitters.newSigned)
  committerMap.notSigned = committerMap.notSigned!.filter(
    committer =>
      !reactedCommitters.newSigned.some(
        reactedCommitter => committer.id === reactedCommitter.id
      )
  )
  return committerMap

}

function prepareAllSignedCommitters(committerMap: CommitterMap, signedInPrCommitters: CommittersDetails[], committers: CommittersDetails[]): boolean {
  let allSignedCommitters = [] as CommittersDetails[]
  /*
   * 1) already signed committers in the file 2) signed committers in the PR comment
  */
  const ids = new Set(signedInPrCommitters.map(committer => committer.id))
  allSignedCommitters = [...signedInPrCommitters, ...committerMap.signed!.filter(signedCommitter => !ids.has(signedCommitter.id))]
  /*
  * checking if all the unsigned committers have reacted to the PR comment (this is needed for changing the content of the PR comment to "All committers have signed the CLA")
  */
  let allSignedFlag: boolean = committers.every(committer => allSignedCommitters.some(reactedCommitter => committer.id === reactedCommitter.id))
  return allSignedFlag
}
