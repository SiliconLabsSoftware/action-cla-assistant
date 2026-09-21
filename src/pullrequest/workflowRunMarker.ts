const workflowRunMarkerPattern =
  /<!--\s*cla-assistant-workflow-run-id:\s*(\d+)\s*-->/i
const allWorkflowRunMarkersPattern =
  /<!--\s*cla-assistant-workflow-run-id:\s*\d+\s*-->/gi

export function parseWorkflowRunId(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) {
    return undefined
  }

  const workflowRunId = Number(value)
  if (!Number.isSafeInteger(workflowRunId) || workflowRunId <= 0) {
    return undefined
  }

  return workflowRunId
}

export function getWorkflowRunIdFromComment(
  commentBody: string | null | undefined
): number | undefined {
  if (!commentBody) {
    return undefined
  }

  const markerMatch = workflowRunMarkerPattern.exec(commentBody)
  return parseWorkflowRunId(markerMatch?.[1])
}

export function addWorkflowRunIdToComment(
  commentBody: string,
  workflowRunId: number
): string {
  const bodyWithoutMarker = commentBody
    .replace(allWorkflowRunMarkersPattern, '')
    .replace(/\s+$/, '')

  return `${bodyWithoutMarker}\n<!-- cla-assistant-workflow-run-id: ${workflowRunId} -->`
}
