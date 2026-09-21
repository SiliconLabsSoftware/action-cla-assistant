import {
  addWorkflowRunIdToComment,
  getWorkflowRunIdFromComment,
  parseWorkflowRunId
} from '../src/pullrequest/workflowRunMarker'

describe('workflow run comment marker', () => {
  test('adds a hidden workflow run marker', () => {
    const comment = addWorkflowRunIdToComment('Visible CLA text', 12345)

    expect(comment).toBe(
      'Visible CLA text\n<!-- cla-assistant-workflow-run-id: 12345 -->'
    )
  })

  test('replaces an existing marker', () => {
    const comment = addWorkflowRunIdToComment(
      'Visible CLA text\n<!-- cla-assistant-workflow-run-id: 12345 -->',
      67890
    )

    expect(comment).toBe(
      'Visible CLA text\n<!-- cla-assistant-workflow-run-id: 67890 -->'
    )
  })

  test('reads a marker from a comment', () => {
    const workflowRunId = getWorkflowRunIdFromComment(
      'Visible CLA text\n<!-- cla-assistant-workflow-run-id: 12345 -->'
    )

    expect(workflowRunId).toBe(12345)
  })

  test.each([undefined, '', '0', '-1', 'not-a-number'])(
    'rejects invalid workflow run ID %s',
    value => {
      expect(parseWorkflowRunId(value)).toBeUndefined()
    }
  )
})
