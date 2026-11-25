import { useId } from 'react'
import type { ReactNode, Ref } from 'react'
import type { ScoredExamResult } from '../domain/model'
import './results.css'

const interactionLabels: Readonly<Record<string, string>> = {
  SINGLE_CHOICE: 'Single choice',
  MULTIPLE_CHOICE: 'Multiple choice',
  DROPDOWN: 'Dropdown',
  MATCHING: 'Matching',
  ORDERING: 'Ordering',
  DRAG_DROP: 'Drag and drop',
  STATEMENT: 'Statements',
  DROPDOWN_HOTSPOT: 'Dropdown HOTSPOT',
  IMAGE_HOTSPOT: 'Image HOTSPOT',
  DIAGRAM_DEPENDENT: 'Diagram-based questions',
}

function sectionFallback(kind: string) {
  switch (kind) {
    case 'CASE_STUDY_1': return 'Case Study 1'
    case 'CASE_STUDY_2': return 'Case Study 2'
    case 'REMAINDER_CASE_STUDY': return 'Case Study'
    case 'STANDARD_BLOCK': return 'Standard Questions'
    case 'FINAL_INTERACTIVE_BLOCK': return 'Interactive Questions'
    default: return 'Other Questions'
  }
}

function Breakdown({ title, rows }: {
  readonly title: string
  readonly rows: readonly { readonly id: string; readonly label: string; readonly correctCount: number; readonly questionCount: number }[]
}) {
  const headingId = useId()
  if (!rows.length) return null
  return (
    <section className="results-breakdown" aria-labelledby={headingId}>
      <h2 id={headingId}>{title}</h2>
      <p>Questions correct out of total</p>
      <dl>
        {rows.map(({ id, label, correctCount, questionCount }) => (
          <div key={id}>
            <dt>{label}</dt>
            <dd>{correctCount} / {questionCount}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

/** Receives only persisted, aggregate result data. It has no source payload,
 * scoring rules, or mutable response state. */
export function Results({ result, labels, headingRef, continuation }: {
  readonly result: ScoredExamResult
  readonly labels: ReadonlyMap<string, string>
  readonly headingRef: Ref<HTMLHeadingElement>
  readonly continuation?: ReactNode
}) {
  const passed = result.outcome === 'PASS'
  const timedOut = result.finalizationReason === 'TIME_EXPIRED'
  const metrics = [
    { label: 'Score', value: `${result.rawScore} / ${result.maximumScore}` },
    { label: 'Percentage', value: result.displayPercentage },
    { label: 'Questions answered', value: result.questionCount - result.unansweredCount },
    { label: 'Questions unanswered', value: result.unansweredCount },
  ]
  return (
    <section className="results-panel panel surface" aria-label="Examination results">
      <header className="results-header">
        <div>
          <p className="eyebrow">Examination results</p>
          <h1 ref={headingRef} tabIndex={-1}>Exam complete</h1>
          <p className="results-reason">
            Completion reason: <strong>{timedOut ? 'Time expired' : 'Submitted'}</strong>
          </p>
        </div>
        <div className={`results-verdict results-verdict--${passed ? 'pass' : 'fail'}`}>
          <strong><span aria-hidden="true">{passed ? '✓' : '×'}</span> {passed ? 'Pass' : 'Fail'}</strong>
          <p>Passing threshold: <span>{result.passingPercentage}%</span></p>
        </div>
      </header>
      <dl className="results-metrics">
        {metrics.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
      <p className="results-reading-note">Answered includes incomplete responses. The pass decision uses the unrounded percentage.</p>
      <div className="results-breakdowns">
        <Breakdown title="Section performance" rows={result.sectionBreakdown.filter(({ questionCount }) => questionCount > 0).map((entry) => ({
          ...entry, id: entry.sectionId, label: labels.get(entry.sectionId) ?? sectionFallback(entry.sectionKind),
        }))} />
        <Breakdown title="Question-type performance" rows={result.interactionTypeBreakdown.filter(({ questionCount }) => questionCount > 0).map((entry) => ({
          ...entry, id: entry.interactionKind, label: interactionLabels[entry.interactionKind] ?? 'Other questions',
        }))} />
      </div>
      <p className="results-locked">This examination is locked. Detailed answer review is not available here.</p>
      {continuation}
    </section>
  )
}
