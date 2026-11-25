import { Button, Progress } from '../design-system/primitives'
import './cycle-continuation.css'

export interface CycleContinuationState {
  readonly status: 'ACTIVE' | 'COMPLETE'
  readonly examNumber: number
  readonly availableQuestions: number
  readonly consumedQuestions: number
  readonly totalQuestions: number
  readonly canContinue: boolean
  readonly advancing?: boolean
}

export function CycleContinuation({ state, onNextExam, onNewCycle }: {
  readonly state: CycleContinuationState
  readonly onNextExam: () => void
  readonly onNewCycle: (trigger: HTMLButtonElement) => void
}) {
  const complete = state.status === 'COMPLETE'
  const canContinue = state.canContinue && (complete || state.availableQuestions > 0)
  const progressLabel = `${state.consumedQuestions} of ${state.totalQuestions} eligible questions used`
  const remaining = state.availableQuestions === 1
    ? '1 eligible question remains in this cycle.'
    : `${state.availableQuestions} eligible questions remain in this cycle.`
  return (
    <section className="cycle-continuation" aria-label="Exam cycle">
      <div className="cycle-continuation-main">
        <p className="eyebrow">Exam {state.examNumber} complete</p>
        <h2>{complete ? 'Cycle complete' : 'Continue this cycle'}</h2>
        <p>{complete ? 'You have used all eligible questions in this cycle. A new cycle lets you practice them again.' : remaining}</p>
        <p className="cycle-progress-label">{progressLabel}</p>
        {state.totalQuestions > 0 && <Progress current={state.consumedQuestions} total={state.totalQuestions} label="Eligible questions used in this cycle" />}
      </div>
      <div className="cycle-continuation-actions">
        <Button tone="primary"
          disabled={!canContinue}
          aria-disabled={state.advancing || undefined}
          onClick={(event) => {
            if (state.advancing || !canContinue) return
            if (complete) onNewCycle(event.currentTarget)
            else onNextExam()
          }}>{complete ? 'Start new cycle' : 'Next exam'} <span aria-hidden="true">→</span></Button>
        {state.advancing && <p role="status">{complete ? 'Starting the new cycle…' : 'Preparing the next exam…'}</p>}
        {!state.advancing && !canContinue && (
          <p>{!state.canContinue ? 'Continuing is unavailable in this tab.' : 'Reload to refresh the saved cycle status.'}</p>
        )}
      </div>
    </section>
  )
}
