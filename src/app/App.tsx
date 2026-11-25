import { useEffect, useRef, useState } from 'react'
import { Button, ConfirmDialog, Panel, Progress, Select, Status } from '../design-system/primitives'
import { QuestionRenderer } from '../features/exam/QuestionRenderer'
import type { DisplayInteraction, DisplayResponse } from '../features/exam/QuestionRenderer'
import '../styles/exam.css'

export interface FoundationQuestion {
  readonly id: string
  readonly title?: string
  readonly prompt: string
  readonly interaction: DisplayInteraction
}

export interface FoundationSection {
  readonly id: string
  readonly label: string
  readonly count: number
  readonly state: 'locked' | 'current' | 'upcoming'
}

export interface FoundationPreview {
  readonly sections: readonly FoundationSection[]
  readonly activeSectionId: string
  readonly questions: readonly FoundationQuestion[]
  readonly position: number
  readonly answers?: Readonly<Record<string, DisplayResponse>>
  readonly marks?: readonly string[]
  readonly view?: 'intro' | 'question' | 'review' | 'final' | 'complete'
  readonly context?: { readonly title: string; readonly paragraphs: readonly string[] }
  readonly status?: { readonly label: string; readonly tone?: 'neutral' | 'warning' | 'error' }
  readonly readOnly?: boolean
  readonly canTakeOver?: boolean
  readonly hasUnsavedChange?: boolean
  readonly canRetrySave?: boolean
  readonly notice?: string
}

export type FoundationAction =
  | { readonly type: 'START' }
  | { readonly type: 'TAKE_OVER' | 'RETRY_SAVE' | 'DISCARD_UNSAVED' }
  | { readonly type: 'NAVIGATE'; readonly position: number }
  | { readonly type: 'ANSWER'; readonly questionId: string; readonly response: DisplayResponse }
  | { readonly type: 'TOGGLE_MARK'; readonly questionId: string }
  | { readonly type: 'OPEN_REVIEW' }
  | { readonly type: 'CLOSE_REVIEW' }
  | { readonly type: 'SUBMIT_SECTION'; readonly sectionId: string }
  | { readonly type: 'FINAL_SUBMIT' }

const sampleQuestions: readonly FoundationQuestion[] = [
  {
    id: 'sample-a', title: 'Select a response', prompt: 'This sample demonstrates how answer choices appear. Select any option to preview the control.',
    interaction: { kind: 'SINGLE_CHOICE', options: [{ id: 'a', label: 'Sample option A' }, { id: 'b', label: 'Sample option B' }, { id: 'c', label: 'Sample option C' }] },
  },
  {
    id: 'sample-b', title: 'Select from menus', prompt: 'Preview two separately labeled dropdown fields. There is no scored response.',
    interaction: {
      kind: 'DROPDOWN',
      targets: ['First field', 'Second field'].map((label, index) => ({
        id: 'field-' + index, label, options: [{ id: 'a', label: 'Sample value A' }, { id: 'b', label: 'Sample value B' }],
      })),
    },
  },
  {
    id: 'sample-c', title: 'Match without dragging', prompt: 'Use the menus to pair sample items. Keyboard and touch use the same control.',
    interaction: {
      kind: 'MATCHING',
      targets: ['Item 1', 'Item 2'].map((label, index) => ({
        id: 'item-' + index, label, options: [{ id: 'a', label: 'Sample match A' }, { id: 'b', label: 'Sample match B' }],
      })),
    },
  },
]

const standalone: FoundationPreview = {
  sections: [{ id: 'sample-section', label: 'Sample section', count: sampleQuestions.length, state: 'current' }],
  activeSectionId: 'sample-section',
  questions: sampleQuestions,
  position: 0,
  view: 'question',
  context: {
    title: 'Sample context',
    paragraphs: ['Examination Hub keeps scenario material together with its questions. This sample does not contain approved exam material.'],
  },
  status: { label: 'Preview only' },
}

function answerState(question: FoundationQuestion, answer: DisplayResponse | undefined) {
  if (!answer) return 'Unanswered'
  const interaction = question.interaction
  if ('targets' in interaction) {
    const count = interaction.targets.filter((target) => {
      const selected = answer.targets?.[target.id]
      return target.options.some((option) => option.id === selected)
    }).length
    return count === 0 ? 'Unanswered' : count === interaction.targets.length ? 'Answered' : 'Incomplete'
  }
  if (interaction.kind === 'ORDERING') {
    if (!answer.order?.length) return 'Unanswered'
    return answer.order.length === interaction.items.length
      && new Set(answer.order).size === interaction.items.length
      && answer.order.every((id) => interaction.items.some((item) => item.id === id)) ? 'Answered' : 'Incomplete'
  }
  if ('options' in interaction) {
    const selected = answer.selected ?? []
    if (!selected.length) return 'Unanswered'
    return selected.every((id) => interaction.options.some((option) => option.id === id)) ? 'Answered' : 'Incomplete'
  }
  return 'Unanswered'
}

export default function App({ preview, onAction }: {
  preview?: FoundationPreview
  onAction?: (action: FoundationAction) => void
}) {
  const [sample, setSample] = useState(standalone)
  const [dialog, setDialog] = useState<'section' | 'final' | null>(null)
  const [filter, setFilter] = useState<'all' | 'unfinished' | 'marked'>('all')
  const [contextOpen, setContextOpen] = useState(() => typeof matchMedia === 'function' && matchMedia('(min-width: 721px)').matches)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const previousViewKey = useRef<string | null>(null)
  const data = preview ?? sample
  const view = data.view ?? 'question'
  const activeIndex = data.sections.findIndex((section) => section.id === data.activeSectionId)
  const active = data.sections[activeIndex]
  const question = data.questions[data.position]
  const markSet = new Set(data.marks ?? [])
  const answeredCount = data.questions.filter((item) => answerState(item, data.answers?.[item.id]) === 'Answered').length
  const total = data.sections.reduce((count, section) => count + section.count, 0)
  const overallPosition = view === 'final' || view === 'complete'
    ? total
    : data.sections.slice(0, Math.max(0, activeIndex)).reduce((count, section) => count + section.count, 0)
      + (view === 'intro' ? 0 : Math.min(data.position + 1, active?.count ?? 0))
  const status = data.status ?? { label: 'Foundation preview' }
  const actionsDisabled = data.readOnly === true || (preview !== undefined && onAction === undefined)

  const viewKey = JSON.stringify([data.activeSectionId, data.position, view])
  useEffect(() => {
    if (previousViewKey.current !== null && previousViewKey.current !== viewKey) headingRef.current?.focus()
    previousViewKey.current = viewKey
  }, [viewKey])

  const act = (action: FoundationAction) => {
    if (actionsDisabled && !['TAKE_OVER', 'RETRY_SAVE', 'DISCARD_UNSAVED'].includes(action.type)) return
    if (onAction) { onAction(action); return }
    setSample((previous) => {
      switch (action.type) {
        case 'NAVIGATE': return { ...previous, view: 'question', position: action.position }
        case 'ANSWER': return { ...previous, answers: { ...previous.answers, [action.questionId]: action.response } }
        case 'TOGGLE_MARK': {
          const marks = previous.marks ?? []
          return { ...previous, marks: marks.includes(action.questionId) ? marks.filter((id) => id !== action.questionId) : [...marks, action.questionId] }
        }
        case 'OPEN_REVIEW': return { ...previous, view: 'review' }
        case 'CLOSE_REVIEW': return { ...previous, view: 'question' }
        default: return previous // Standalone sample never claims to commit an exam section.
      }
    })
  }
  const navigate = (position: number) => {
    if (position >= 0 && position < data.questions.length) act({ type: 'NAVIGATE', position })
  }
  const canCommit = Boolean(preview && onAction && !actionsDisabled)
  const sectionCount = active?.count ?? data.questions.length
  const bookPanels = view === 'question'
    ? data.questions.map((item, position) => ({ item, position }))
      .filter(({ item }) => filter === 'all' || (filter === 'marked' ? markSet.has(item.id) : answerState(item, data.answers?.[item.id]) !== 'Answered'))
    : []

  return (
    <>
      <a className="skip-link" href="#main-content" onClick={(event) => {
        event.preventDefault()
        document.getElementById('main-content')?.focus()
      }}>Skip to exam content</a>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <span aria-hidden="true" className="brand-mark">
              <svg viewBox="0 0 24 24" fill="none" width="22" height="22">
                <path d="M5 5h13a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5zm4 4h6m-6 3h6m-6 3h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <div><div className="brand-name">Examination Hub</div><div className="brand-subtitle">Practice exam workspace</div></div>
          </div>
          <div className="topbar-status" role="status"><Status tone={status.tone}>{status.label}</Status></div>
        </div>
      </header>
      <main id="main-content" className="layout-shell" tabIndex={-1}>
        <section className="overview" aria-label="Attempt overview">
          <div className="overview-copy">
            <p className="eyebrow">Exam desk</p>
            <div className="overview-title">{view === 'complete' ? 'Practice attempt complete' : view === 'final' ? 'Final review' : active?.label ?? 'Practice session'}</div>
          </div>
          {total > 0 && (
            <div className="overview-progress">
              <div className="progress-label">
                <span>Attempt position</span>
                <strong>{overallPosition} of {total}</strong>
              </div>
              <Progress current={overallPosition} total={total} label="Attempt position" />
            </div>
          )}
        </section>
        <ol className="stepper" role="list" aria-label="Exam sections">
          {data.sections.map((section, index) => (
            <li key={section.id} className={`step step--${section.state}`} aria-current={section.state === 'current' ? 'step' : undefined}>
              <span className="step-number" aria-hidden="true">{index + 1}</span>
              <span className="step-copy">
                <strong>{section.label}</strong>
                <span>{section.state === 'locked' ? 'Locked' : section.state === 'current' ? 'Current' : 'Upcoming'} · {section.count} {section.count === 1 ? 'question' : 'questions'}</span>
              </span>
            </li>
          ))}
        </ol>
        {data.notice && <p className="notice" role="status">{data.notice}</p>}
        {preview && onAction && data.readOnly && data.canTakeOver && (
          <div className="takeover"><Button onClick={() => act({ type: 'TAKE_OVER' })}>Take over editing</Button></div>
        )}
        {preview && onAction && data.hasUnsavedChange && (
          <div className="takeover" aria-label="Unsaved change actions">
            <Button disabled={!data.canRetrySave} onClick={() => act({ type: 'RETRY_SAVE' })}>Retry save</Button>
            <Button onClick={() => act({ type: 'DISCARD_UNSAVED' })}>Discard unsaved change</Button>
          </div>
        )}

        {view === 'intro' && (
          <Panel className="surface intro" label="Practice exam introduction">
            <p className="eyebrow">Get ready</p>
            <h1 ref={headingRef} tabIndex={-1}>Practice exam foundation</h1>
            <p>Work through the sections in order, at your own pace. Review your responses before you submit a section; you cannot reopen it afterward.</p>
            <p>This foundation uses synthetic content. Nothing here is an official certification exam or a production question bank.</p>
            <Button tone="primary" disabled={actionsDisabled} onClick={() => act({ type: 'START' })}>Start practice exam</Button>
          </Panel>
        )}

        {view === 'question' && (
          <div className={`desk ${data.context ? 'desk--with-context' : ''}`}>
            {data.context && (
              <details className="panel case-panel" open={contextOpen} onToggle={(event) => setContextOpen(event.currentTarget.open)}>
                <summary>Case study context</summary>
                <div>
                  <h2>{data.context.title}</h2>
                  {data.context.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
                </div>
              </details>
            )}
            <Panel className="surface question-panel" label="Question and response">
              <div className="question-header">
                <p className="eyebrow">{activeIndex >= 0 && data.sections.length > 1 && <>Section {activeIndex + 1} of {data.sections.length} · </>}Question {data.position + 1} of {sectionCount}</p>
                {question && <Button disabled={actionsDisabled} tone="quiet" aria-pressed={markSet.has(question.id)}
                  onClick={() => act({ type: 'TOGGLE_MARK', questionId: question.id })}
                >{markSet.has(question.id) ? 'Marked for review' : 'Mark for review'}</Button>}
              </div>
              <h1 ref={headingRef} tabIndex={-1}>{question?.title ?? 'Practice question'}</h1>
              {question ? <>
                <p className="prompt">{question.prompt}</p>
                <QuestionRenderer
                  key={question.id}
                  interaction={question.interaction}
                  response={data.answers?.[question.id] ?? {}}
                  onChange={(response) => act({ type: 'ANSWER', questionId: question.id, response })}
                  disabled={actionsDisabled}
                />
              </> : <p className="information">No question preview is available.</p>}
              <div className="question-actions" aria-label="Question controls">
                <Button disabled={actionsDisabled || data.position <= 0} onClick={() => navigate(data.position - 1)}>Previous</Button>
                <Button disabled={actionsDisabled || !data.questions.length} onClick={() => act({ type: 'OPEN_REVIEW' })}>Review section</Button>
                <Button tone="primary" disabled={actionsDisabled || !data.questions.length}
                  onClick={() => data.position >= data.questions.length - 1 ? act({ type: 'OPEN_REVIEW' }) : navigate(data.position + 1)}
                >{data.position >= data.questions.length - 1 ? 'Continue to review' : 'Next'}</Button>
              </div>
            </Panel>
            <Panel className="navigator-panel" label="Question navigation">
              <h2>Navigator</h2>
              <p>{answeredCount} of {sectionCount} answered</p>
              <div className="navigator-filter">
                <Select label="Show questions" value={filter}
                  onChange={(event) => setFilter(event.currentTarget.value as typeof filter)}>
                  <option value="all">All questions</option>
                  <option value="unfinished">Unanswered or incomplete</option>
                  <option value="marked">Marked for review</option>
                </Select>
              </div>
              <nav aria-label="Current section questions">
                {bookPanels.length === 0 ? <p>No questions match this filter.</p> :
                  <div className="question-grid">
                    {bookPanels.map(({ item, position }) => {
                      const state = answerState(item, data.answers?.[item.id])
                      const marked = markSet.has(item.id)
                      return <Button key={item.id} tone="neutral" className={`number-button number-button--${state.toLowerCase()}`}
                        aria-label={`Question ${position + 1}, ${state.toLowerCase()}${marked ? ', marked for review' : ''}`}
                        aria-current={position === data.position ? 'true' : undefined}
                        disabled={actionsDisabled} onClick={() => navigate(position)}
                      >
                        <span>{position + 1}</span><span className="number-symbol" aria-hidden="true">{marked ? '★' : state === 'Answered' ? '✓' : state === 'Incomplete' ? '◐' : ''}</span>
                      </Button>
                    })}
                  </div>
                }
              </nav>
              <p className="navigator-footer">★ Marked · ✓ Answered · ◐ Incomplete</p>
            </Panel>
          </div>
        )}

        {view === 'review' && (
          <Panel className="surface review" label="Active section review">
            <p className="eyebrow">Active section</p>
            <h1 ref={headingRef} tabIndex={-1}>Review section</h1>
            <p>{answeredCount} of {sectionCount} answered. You can revisit any question here before locking this section.</p>
            <ul className="review-list" role="list">
              {data.questions.map((item, position) => (
                <li key={item.id}>
                  <div><strong>Question {position + 1}</strong><span>{answerState(item, data.answers?.[item.id])}{markSet.has(item.id) ? ' · Marked for review' : ''}</span></div>
                  <Button disabled={actionsDisabled} onClick={() => navigate(position)} aria-label={`Open question ${position + 1}`}>Open</Button>
                </li>
              ))}
            </ul>
            <div className="question-actions">
              <Button disabled={actionsDisabled} onClick={() => act({ type: 'CLOSE_REVIEW' })}>Return to section</Button>
              <Button tone="primary" disabled={!canCommit || !active} onClick={() => setDialog('section')}>Submit and lock section</Button>
            </div>
          </Panel>
        )}

        {view === 'final' && (
          <Panel className="surface review" label="Final review">
            <p className="eyebrow">Read-only summary</p>
            <h1 ref={headingRef} tabIndex={-1}>Final review</h1>
            <p>All sections are locked. Final submission commits this practice attempt.</p>
            <ul className="review-list" role="list">
              {data.sections.map((section) => <li key={section.id}><strong>{section.label}</strong><span>Locked · {section.count} questions</span></li>)}
            </ul>
            <Button tone="primary" disabled={!canCommit} onClick={() => setDialog('final')}>Confirm final submission</Button>
          </Panel>
        )}

        {view === 'complete' && (
          <Panel className="surface review" label="Submission confirmation">
            <p className="eyebrow">Practice attempt</p>
            <h1 ref={headingRef} tabIndex={-1}>Attempt submitted</h1>
            <p>The practice foundation records submission without computing a score. Responses cannot be edited through this screen.</p>
          </Panel>
        )}

        <footer className="page-footer">Examination Hub <span aria-hidden="true">·</span> Static practice foundation</footer>
      </main>
      <ConfirmDialog
        open={dialog !== null}
        title={dialog === 'final' ? 'Submit this attempt?' : `Submit ${active?.label ?? 'section'}?`}
        description={dialog === 'final' ? 'This commits the attempt. You cannot return to edit your responses.' : `This locks responses, including blanks. You cannot reopen the section. ${Math.max(0, sectionCount - answeredCount)} questions are unanswered or incomplete.`}
        confirmLabel={dialog === 'final' ? 'Submit attempt' : 'Submit and lock'}
        onCancel={() => setDialog(null)}
        onConfirm={() => {
          setDialog(null)
          if (dialog === 'final') act({ type: 'FINAL_SUBMIT' })
          else if (active) act({ type: 'SUBMIT_SECTION', sectionId: active.id })
        }}
      />
    </>
  )
}
