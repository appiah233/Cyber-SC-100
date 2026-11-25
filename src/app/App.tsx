import { Component, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, ConfirmDialog, Panel, Progress, Select, Status } from '../design-system/primitives'
import { QuestionRenderer } from '../features/exam/QuestionRenderer'
import { ExhibitViewer } from '../features/exam/ExhibitViewer'
import { responseState } from '../features/exam/question-response'
import type { DisplayInteraction, DisplayResponse } from '../features/exam/QuestionRenderer'
import '../styles/exam.css'
import '../styles/exam-lifecycle.css'

export interface FoundationAsset {
  readonly id: string
  readonly label: string
  readonly alt?: string
  readonly src?: string
  readonly description?: string
}

export interface FoundationContext {
  readonly title: string
  readonly paragraphs?: readonly string[]
  readonly sections?: readonly { readonly title: string; readonly paragraphs: readonly string[] }[]
  readonly assets?: readonly FoundationAsset[]
}

export interface FoundationQuestion {
  readonly id: string
  readonly title?: string
  readonly prompt: string
  readonly interaction: DisplayInteraction
  readonly assets?: readonly FoundationAsset[]
}

export interface FoundationSection {
  readonly id: string
  readonly kind?: string
  readonly label: string
  readonly count: number
  readonly state: 'locked' | 'current' | 'upcoming'
}

export interface FoundationPreview {
  readonly sections: readonly FoundationSection[]
  readonly activeSectionId: string
  readonly batchMode?: 'NORMAL' | 'ADAPTIVE' | 'FINAL_REMAINDER'
  readonly questions: readonly FoundationQuestion[]
  readonly position: number
  readonly answers?: Readonly<Record<string, DisplayResponse>>
  readonly marks?: readonly string[]
  readonly view?: 'intro' | 'question' | 'review' | 'final' | 'complete' | 'error'
  readonly context?: FoundationContext
  readonly examTitle?: string
  readonly synthetic?: boolean
  readonly contentNotice?: string
  readonly error?: { readonly title: string; readonly description: string }
  readonly status?: { readonly label: string; readonly tone?: 'neutral' | 'warning' | 'error' }
  readonly readOnly?: boolean
  readonly canTakeOver?: boolean
  readonly hasUnsavedChange?: boolean
  readonly canRetrySave?: boolean
  readonly notice?: string
  readonly timer?: { readonly remainingMs: number; readonly announcement?: string; readonly expired?: boolean }
  readonly finalizationReason?: 'MANUAL_SUBMISSION' | 'TIME_EXPIRED'
  readonly finalizing?: boolean
  readonly examSummary?: { readonly unanswered: number; readonly marked: number }
}

export type FoundationAction =
  | { readonly type: 'START' }
  | { readonly type: 'TAKE_OVER' | 'RETRY_SAVE' | 'DISCARD_UNSAVED' }
  | { readonly type: 'NAVIGATE'; readonly position: number; readonly sectionId?: string }
  | { readonly type: 'ANSWER'; readonly questionId: string; readonly response: DisplayResponse }
  | { readonly type: 'TOGGLE_MARK'; readonly questionId: string }
  | { readonly type: 'OPEN_REVIEW' | 'CLOSE_REVIEW'; readonly sectionId?: string }
  | { readonly type: 'SUBMIT_SECTION'; readonly sectionId: string }
  | { readonly type: 'FINAL_SUBMIT' | 'END_EXAM' }

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
  try {
    const state = responseState(question.interaction, answer ?? {})
    return state === 'ANSWERED' ? 'Answered' : state === 'INCOMPLETE' ? 'Incomplete' : 'Unanswered'
  } catch { return 'Unanswered' }
}

function Exhibits({ assets, onAvailabilityChange }: {
  assets?: readonly FoundationAsset[]
  onAvailabilityChange?: (asset: FoundationAsset, available: boolean) => void
}) {
  if (!assets?.length) return null
  return <div className="exhibit-list">{assets.map(asset => (
    <ExhibitViewer key={asset.id} asset={asset} onAvailabilityChange={(_, available) => onAvailabilityChange?.(asset, available)} />
  ))}</div>
}

function timerText(remainingMs: number): string {
  const total = Number.isFinite(remainingMs) ? Math.max(0, Math.ceil(remainingMs / 1000)) : 0
  return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60].map(n => String(n).padStart(2, '0')).join(':')
}

class QuestionBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() { return { failed: true } }

  render() {
    if (this.state.failed) return (
      <div className="notice notice--error" role="alert">
        <h2>Question could not be displayed</h2>
        <p>Reload the examination to try again, or move to another question. Your saved responses are not changed.</p>
        <Button onClick={() => window.location.reload()}>Reload exam</Button>
      </div>
    )
    return this.props.children
  }
}

type ReviewFilter = 'all' | 'unfinished' | 'marked'
const reviewFilters: readonly { value: ReviewFilter; label: string }[] = [
  { value: 'all', label: 'All questions' }, { value: 'unfinished', label: 'Unanswered' }, { value: 'marked', label: 'Marked' },
]
const wideWorkspace = '(min-width: 61rem)'
const wideCasePane = '(width > 71rem)'
const matchesWidth = (query: string) => typeof matchMedia === 'function' && matchMedia(query).matches

const countLabel = (count: number, noun: 'question' | 'section') =>
  `${count} ${noun}${count === 1 ? '' : 's'}`

function sectionKind(section: FoundationSection | undefined) {
  return section?.kind ?? section?.id.split(':')[0]
}

function caseSection(section: FoundationSection | undefined) {
  const kind = sectionKind(section)
  return kind === 'CASE_STUDY_1' || kind === 'CASE_STUDY_2' || kind === 'REMAINDER_CASE_STUDY'
}

function sectionLabels(sections: readonly FoundationSection[]) {
  const caseCount = sections.filter(caseSection).length
  let caseNumber = 0
  return new Map(sections.map((section) => {
    if (!caseSection(section)) return [section.id, section.label]
    caseNumber += 1
    return [section.id, caseCount === 1 ? 'Case Study' : `Case Study ${caseNumber}`]
  }))
}

export default function App({ preview, onAction }: {
  preview?: FoundationPreview
  onAction?: (action: FoundationAction) => void
}) {
  const [sample, setSample] = useState(standalone)
  const [dialog, setDialog] = useState<'section' | 'end' | 'final' | null>(null)
  const [filter, setFilter] = useState<ReviewFilter>('all')
  const [navFilter, setNavFilter] = useState<ReviewFilter>('all')
  const [navigatorOpen, setNavigatorOpen] = useState(() => matchesWidth(wideWorkspace))
  const [contextOpen, setContextOpen] = useState(() => matchesWidth(wideCasePane))
  const [loadedExhibits, setLoadedExhibits] = useState<ReadonlyMap<string, string>>(() => new Map())
  const recordExhibit = useCallback((asset: FoundationAsset, available: boolean) => {
    const {id, src} = asset
    if (!src) return
    setLoadedExhibits(previous => {
      if (available === (previous.get(id) === src)) return previous
      const next = new Map(previous)
      if (available) next.set(id, src)
      else next.delete(id)
      return next
    })
  }, [])
  const exhibitLoaded = ({id, src}: FoundationAsset) => Boolean(src && loadedExhibits.get(id) === src)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const navigatorSummaryRef = useRef<HTMLElement>(null)
  const dialogTrigger = useRef<HTMLButtonElement | null>(null)
  const previousViewKey = useRef<string | null>(null)
  const data = preview ?? sample
  const activeIndex = data.sections.findIndex((section) => section.id === data.activeSectionId)
  const active = data.sections[activeIndex]
  const labels = sectionLabels(data.sections)
  const activeLabel = active && labels.get(active.id)
  const total = data.sections.reduce((count, section) => count + section.count, 0)
  const question = data.questions[data.position]
  const requestedView = data.view ?? (data.error ? 'error' : 'question')
  const view = ((requestedView === 'intro' && total <= 0) || (requestedView === 'question' && !question) ||
      ((requestedView === 'question' || requestedView === 'review') &&
        (!active || active.state !== 'current' || active.count <= 0 || active.count !== data.questions.length)))
    ? 'error' : requestedView
  const isWorking = view === 'question' || view === 'review'
  const markSet = new Set(data.marks ?? [])
  const questionStates = isWorking ? data.questions.map((item, position) => ({
    item, position, state: answerState(item, data.answers?.[item.id]), marked: markSet.has(item.id),
  })) : []
  const answeredCount = questionStates.filter(({ state }) => state === 'Answered').length
  const markedCount = questionStates.filter(({ marked }) => marked).length
  const sectionCount = active?.count ?? data.questions.length
  const unansweredCount = Math.max(0, sectionCount - answeredCount)
  const overallPosition = Math.min(total, data.sections.slice(0, Math.max(0, activeIndex)).reduce((count, section) => count + section.count, 0)
    + Math.min(data.position + 1, sectionCount))
  const status = data.status ?? { label: 'Not saved' }
  const expired = data.timer?.expired || (data.timer !== undefined && data.timer.remainingMs <= 0)
  const actionsDisabled = data.readOnly === true || Boolean(data.finalizing || expired) || Boolean(preview && !onAction)
  const canCommit = Boolean(preview && onAction && !actionsDisabled && !data.hasUnsavedChange)
  const showLifecycle = (isWorking || view === 'final') && Boolean(preview && onAction)
  const displayTime = data.timer ? timerText(data.timer.remainingMs) : undefined
  const finalUnanswered = data.examSummary?.unanswered ?? unansweredCount
  const finalMarked = data.examSummary?.marked ?? markedCount
  const endDescription = `This locks every section and saves your final responses. Unanswered or incomplete: ${finalUnanswered}. Marked for review: ${finalMarked}.${displayTime ? ' Time remaining: ' + displayTime + '.' : ''}`
  const isCase = caseSection(active)
  const isInteractive = sectionKind(active) === 'FINAL_INTERACTIVE_BLOCK'
  const finishLabel = isCase ? 'Finish case study' : isInteractive ? 'Finish interactive section' : 'Finish section'
  const unnamedTitle = data.synthetic === true ? 'Practice examination' : 'Examination'
  const title = data.examTitle ?? unnamedTitle
  const finalBatchLabel = data.batchMode === 'FINAL_REMAINDER' ? 'Final Examination Batch' : null
  const oneSection = data.sections.length === 1
  const currentMarked = Boolean(question && markSet.has(question.id))
  const filterQuestions = (currentFilter: ReviewFilter) => questionStates.filter(({ state, marked }) =>
    currentFilter === 'all' || (currentFilter === 'marked' ? marked : state !== 'Answered'))
  const [scope, setScope] = useState(() => ({ section: data.activeSectionId, view }))
  if (scope.section !== data.activeSectionId || scope.view !== view) {
    setScope({ section: data.activeSectionId, view })
    setFilter('all')
    if (view !== 'question') setNavFilter('all')
    if (data.activeSectionId !== scope.section) setContextOpen(matchesWidth(wideCasePane))
    if (dialog !== null) setDialog(null)
  }
  if (dialog !== null && !canCommit) setDialog(null)

  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const media = matchMedia(wideWorkspace)
    const caseMedia = matchMedia(wideCasePane)
    const setNavigator = (event: MediaQueryListEvent) => setNavigatorOpen(event.matches)
    const setContext = (event: MediaQueryListEvent) => setContextOpen(event.matches)
    media.addEventListener('change', setNavigator)
    caseMedia.addEventListener('change', setContext)
    return () => {
      media.removeEventListener('change', setNavigator)
      caseMedia.removeEventListener('change', setContext)
    }
  }, [])

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
        default: return previous
      }
    })
  }
  const navigate = (position: number) => {
    if (position < 0 || position >= data.questions.length) return
    if (typeof matchMedia === 'function' && !matchMedia(wideWorkspace).matches) setNavigatorOpen(false)
    if (position === data.position && view === 'question') headingRef.current?.focus()
    act({ type: 'NAVIGATE', position, sectionId: active?.id })
  }
  const dismiss = () => {
    const element = dialogTrigger.current
    setDialog(null)
    if (element) window.requestAnimationFrame(() => {
      if (element.isConnected && !element.disabled) element.focus()
      else headingRef.current?.focus()
    })
  }
  const sections = (
    <ol className="stepper" role="list" aria-label="Exam sections">
      {data.sections.map((section, index) => (
        <li key={section.id} className={`step step--${section.state}`} aria-current={section.state === 'current' && isWorking ? 'step' : undefined}>
          <span className="step-number" aria-hidden="true">{section.state === 'locked' && view !== 'intro' ? '✓' : String(index + 1).padStart(2, '0')}</span>
          <span className="step-copy">
            <strong>{labels.get(section.id)}</strong>
            <span>{view === 'intro' ? '' : section.state === 'locked' ? 'Locked · ' : section.state === 'current' ? 'Current · ' : 'Upcoming · '}{countLabel(section.count, 'question')}</span>
          </span>
        </li>
      ))}
    </ol>
  )
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
            <div className="brand-name">Examination Hub</div>
          </div>
          <div className="topbar-status" role="status"><Status tone={status.tone}>{status.label}</Status></div>
        </div>
        {isWorking && active && (
          <div className="exam-strip">
            <div className="exam-strip-inner">
              <div className="exam-location">
                <span className="eyebrow">Section {activeIndex + 1} of {data.sections.length}</span>
                <strong>{activeLabel}</strong>
              </div>
              <div className="exam-progress">
                <span><strong>{view === 'review' ? 'Review' : `Question ${data.position + 1} of ${sectionCount}`}</strong><span>{answeredCount} of {sectionCount} answered</span></span>
                <Progress current={answeredCount} total={sectionCount || 1} label="Questions answered in this section" />
              </div>
              {total > 0 && <span className="exam-overall">Exam position <strong>{overallPosition} of {total}</strong></span>}
              {currentMarked && view === 'question' && <span className="header-mark"><span aria-hidden="true">⚑ </span>Marked for review</span>}
            </div>
          </div>
        )}
        {showLifecycle && (
          <div className="exam-lifecycle" aria-label="Exam actions and time">
            {displayTime && <span className="exam-timer" role="timer" aria-live="off" aria-label="Time remaining">
              Time remaining <strong>{displayTime}</strong>
            </span>}
            {isWorking && <Button tone="quiet" disabled={!canCommit} onClick={event => {
              dialogTrigger.current = event.currentTarget
              setDialog('end')
            }}>End exam</Button>}
          </div>
        )}
      </header>
      <main id="main-content" className={`layout-shell layout-shell--${view}`} tabIndex={-1}>
        <p className="phase6-sr-only" role="status" aria-label="Exam timer announcements">{expired ? '' : data.timer?.announcement ?? ''}</p>
        {showLifecycle && expired && !data.notice && <p role="alert" className="notice notice--warning">Time has expired. Your examination is being submitted.</p>}
        {(data.notice || (data.readOnly && data.canTakeOver) || data.hasUnsavedChange) && (
          <div className={`notice notice--${data.hasUnsavedChange || status.tone === 'error' ? 'error' : 'warning'}`} aria-label="Attempt notice">
            {(data.notice || data.hasUnsavedChange) && <p role={data.hasUnsavedChange ? 'alert' : 'status'}>{data.notice ?? 'A response could not be saved. Retry or discard the unsaved change before submitting.'}</p>}
            {preview && onAction && data.readOnly && data.canTakeOver && (
              <div className="takeover"><Button onClick={() => act({ type: 'TAKE_OVER' })}>Take over editing</Button></div>
            )}
            {preview && onAction && data.hasUnsavedChange && (
              <div className="takeover" role="group" aria-label="Unsaved change actions">
                <Button disabled={!data.canRetrySave} onClick={() => act({ type: 'RETRY_SAVE' })}>Retry save</Button>
                <Button onClick={() => act({ type: 'DISCARD_UNSAVED' })}>Discard unsaved change</Button>
              </div>
            )}
          </div>
        )}

        {view === 'intro' && (
          <Panel className="surface intro" label="Examination introduction">
            <div className="intro-main">
              <p className="eyebrow">{finalBatchLabel ? title : 'Before you begin'}</p>
              <h1 ref={headingRef} tabIndex={-1}>{finalBatchLabel ?? title}</h1>
              <p className="intro-lead">{oneSection
                ? 'You can change and review your responses before submitting this section.'
                : 'Work through the sections in order. You can change and review your responses within the active section.'}</p>
            </div>
            <div className="intro-outline">
              <h2>Exam structure</h2>
              <p>{countLabel(total, 'question')} · {countLabel(data.sections.length, 'section')}</p>
              {sections}
            </div>
            <div className="intro-actions">
              <div className="commit-note">
                <strong>{oneSection ? 'This section cannot be reopened' : 'Sections cannot be reopened'}</strong>
                <p>Once you submit {oneSection ? 'this section' : 'a section'}, you cannot return to {sectionCount === 1 && oneSection ? 'its question or change your response' : 'its questions or change your responses'}.</p>
              </div>
              <Button tone="primary" disabled={actionsDisabled} onClick={() => act({ type: 'START' })}>Start exam <span aria-hidden="true">→</span></Button>
              <p className="content-notice">{data.contentNotice ?? (data.synthetic === false
                ? 'Development practice examination. Not an official certification exam.'
                : 'Synthetic practice content. Not an official certification exam.')}</p>
            </div>
          </Panel>
        )}

        {view === 'question' && question && (
          <div className={`desk ${data.context ? 'desk--with-context' : ''}`}>
            {data.context && (
              <details className="panel case-panel" key={data.activeSectionId} open={contextOpen} onToggle={(event) => setContextOpen(event.currentTarget.open)}>
                <summary>Case study context</summary>
                <div className="case-body" role="region" aria-label="Case study material" tabIndex={0}>
                  <h2>{data.context.title}</h2>
                  {data.context.paragraphs?.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
                  {data.context.sections?.map((group, index) => <section className="context-section" key={index}>
                    <h3>{group.title}</h3>
                    {group.paragraphs.map((paragraph, position) => <p key={position}>{paragraph}</p>)}
                  </section>)}
                  <Exhibits assets={data.context.assets} onAvailabilityChange={recordExhibit} />
                </div>
              </details>
            )}
            <Panel className="surface question-panel" label="Question and response">
              <div className="question-header">
                <p className="eyebrow">Question {data.position + 1} of {sectionCount}</p>
                <div className="question-tools">
                  <Button className="navigator-shortcut" tone="quiet" aria-label="Open question navigator" onClick={() => {
                    setNavigatorOpen(true)
                    window.requestAnimationFrame(() => {
                      navigatorSummaryRef.current?.focus({ preventScroll: true })
                      navigatorSummaryRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' })
                    })
                  }}><span aria-hidden="true">▦</span> Navigator</Button>
                  <Button disabled={actionsDisabled} tone="quiet" aria-pressed={currentMarked}
                  onClick={() => act({ type: 'TOGGLE_MARK', questionId: question.id })}
                  ><span aria-hidden="true">{currentMarked ? '⚑' : '⚐'}</span>{currentMarked ? 'Marked for review' : 'Mark for review'}</Button>
                </div>
              </div>
              <h1 ref={headingRef} tabIndex={-1}>{question.title ?? `Question ${data.position + 1}`}</h1>
              <QuestionBoundary key={question.id}>
                <p className="prompt">{question.prompt}</p>
                {Boolean(question.assets?.length) && <details className="exhibit-disclosure" open>
                  <summary>Question exhibits</summary>
                  <Exhibits assets={question.assets} onAvailabilityChange={recordExhibit} />
                </details>}
                <QuestionRenderer
                  questionKey={question.id}
                  interaction={question.interaction}
                  availableExhibitIds={question.interaction.kind === 'DIAGRAM_DEPENDENT'
                    && !(question.assets ?? []).every(exhibitLoaded) ? []
                    : [...(question.assets ?? []), ...(data.context?.assets ?? [])]
                      .filter(exhibitLoaded).map(asset => asset.id)}
                  response={data.answers?.[question.id] ?? {}}
                  onChange={(response) => act({ type: 'ANSWER', questionId: question.id, response })}
                  disabled={actionsDisabled}
                />
              </QuestionBoundary>
              <div className="question-actions" role="group" aria-label="Question controls">
                <Button disabled={actionsDisabled || data.position <= 0} onClick={() => navigate(data.position - 1)}><span aria-hidden="true">←</span>Previous</Button>
                <Button disabled={actionsDisabled} onClick={() => act({ type: 'OPEN_REVIEW', sectionId: active?.id })}>Review section</Button>
                <Button tone="primary" disabled={actionsDisabled}
                  onClick={() => data.position >= data.questions.length - 1 ? act({ type: 'OPEN_REVIEW', sectionId: active?.id }) : navigate(data.position + 1)}
                >{data.position >= data.questions.length - 1 ? 'Continue to review' : 'Next'}<span aria-hidden="true">→</span></Button>
              </div>
            </Panel>
            <details className="panel navigator-panel" open={navigatorOpen} onToggle={(event) => setNavigatorOpen(event.currentTarget.open)}>
              <summary ref={navigatorSummaryRef}>Question navigator</summary>
              <div className="navigator-content">
                <p>{answeredCount} answered · {unansweredCount} unanswered · {markedCount} marked</p>
                <div className="navigator-filter">
                  <Select label="Show questions" value={navFilter}
                    onChange={(event) => setNavFilter(event.currentTarget.value as ReviewFilter)}>
                    <option value="all">All questions</option>
                    <option value="unfinished">Unanswered or incomplete</option>
                    <option value="marked">Marked for review</option>
                  </Select>
                </div>
                <nav aria-label="Current section questions">
                  {filterQuestions(navFilter).length === 0 ? <p>No questions match this filter.</p> :
                    <div className="question-grid">
                      {filterQuestions(navFilter).map(({ item, position, state, marked }) => (
                        <Button key={item.id} className={`number-button number-button--${state.toLowerCase()}`}
                          aria-label={`Question ${position + 1}, ${state.toLowerCase()}${marked ? ', marked for review' : ''}${position === data.position ? ', current question' : ''}`}
                          aria-current={position === data.position ? 'true' : undefined}
                          disabled={actionsDisabled} onClick={() => navigate(position)}
                        >
                          <span>{position + 1}</span>
                          <span className="number-symbol" aria-hidden="true">{state === 'Answered' ? '✓' : state === 'Incomplete' ? '◐' : '○'}</span>
                          {marked && <span className="number-mark" aria-hidden="true">⚑</span>}
                        </Button>
                      ))}
                    </div>
                  }
                </nav>
                <p className="navigator-footer"><span>▣ Current</span><span>✓ Answered</span><span>○ Unanswered</span><span>◐ Incomplete</span><span>⚑ Marked</span></p>
              </div>
            </details>
          </div>
        )}

        {view === 'review' && (
          <Panel className="surface review" label="Active section review">
            <p className="eyebrow">{activeLabel}</p>
            <h1 ref={headingRef} tabIndex={-1}>Review section</h1>
            <p>{sectionCount === 1 ? 'You can return to the question before submitting.' : 'Return to any question in this section before submitting.'} Incomplete responses count as unanswered.</p>
            <dl className="review-stats">
              {([['Total questions', sectionCount], ['Answered', answeredCount], ['Unanswered', unansweredCount], ['Marked for review', markedCount]] as const)
                .map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}
            </dl>
            <div className="review-actionbar">
              <Button disabled={actionsDisabled} onClick={() => act({ type: 'CLOSE_REVIEW', sectionId: active?.id })}>Return to section</Button>
              <Button tone="primary" disabled={!canCommit || !active} onClick={(event) => {
                dialogTrigger.current = event.currentTarget
                setDialog('section')
              }}>{finishLabel}</Button>
            </div>
            <div className="review-filters" role="group" aria-label="Filter review questions">
              {reviewFilters.map(({ value, label }) => (
                <Button key={value} tone="quiet" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</Button>
              ))}
            </div>
            <p className="review-result-count" role="status">Showing {filterQuestions(filter).length} of {countLabel(sectionCount, 'question')}</p>
            {filterQuestions(filter).length ? <ul className="review-list" role="list">
              {filterQuestions(filter).map(({ item, position, state, marked }) => (
                <li key={item.id}>
                  <div><strong>Question {position + 1}</strong><span>{state}{marked ? ' · Marked for review' : ''}</span></div>
                  <Button disabled={actionsDisabled} onClick={() => navigate(position)} aria-label={`Open question ${position + 1}`}>Open</Button>
                </li>
              ))}
            </ul> : <p className="information">No questions match this filter.</p>}
          </Panel>
        )}

        {view === 'final' && (
          <Panel className="surface review final-panel" label="Final submission">
            <p className="eyebrow">{finalBatchLabel ?? (oneSection ? 'Section finished' : 'All sections finished')}</p>
            <h1 ref={headingRef} tabIndex={-1}>Final submission</h1>
            <p>{oneSection ? 'You have completed this examination section. It cannot be reopened.' : 'You have completed all examination sections. Submitted sections cannot be reopened.'}</p>
            {sections}
            <Button tone="primary" disabled={!canCommit} onClick={(event) => {
              dialogTrigger.current = event.currentTarget
              setDialog('final')
            }}>Submit exam</Button>
          </Panel>
        )}

        {view === 'complete' && (
          <Panel className="surface review complete-panel" label="Submission confirmation">
            <p className="eyebrow"><span aria-hidden="true">✓ </span>Submission recorded</p>
            <h1 ref={headingRef} tabIndex={-1}>Exam submitted</h1>
            <p>{data.finalizationReason === 'TIME_EXPIRED' ? 'Time expired. Your examination was submitted automatically and responses are locked.' : 'The examination has been submitted. Your responses are no longer editable.'}</p>
          </Panel>
        )}

        {view === 'error' && (
          <Panel className="surface review complete-panel" label="Examination recovery">
            <p className="eyebrow">Unable to continue</p>
            <h1 ref={headingRef} tabIndex={-1}>{data.error?.title ?? 'The examination could not be opened'}</h1>
            <p>{data.error?.description ?? 'Reload to try opening the saved attempt again. Reloading does not reset your examination.'}</p>
            <Button onClick={() => window.location.reload()}>Reload exam</Button>
          </Panel>
        )}

        {isWorking && <details className="section-outline">
          <summary>{oneSection ? 'Exam section and lock' : 'Exam sections and locks'}</summary>
          {sections}
        </details>}
        <footer className="page-footer">Examination Hub <span aria-hidden="true">·</span> Candidate examination</footer>
      </main>
      <ConfirmDialog
        open={dialog !== null && canCommit}
        title={dialog === 'end' ? 'End this exam?' : dialog === 'final' ? 'Submit this exam?' : isCase ? 'Finish this case study?' : isInteractive ? 'Finish this interactive section?' : 'Finish this section?'}
        description={dialog === 'final' || dialog === 'end'
          ? endDescription
          : `${unansweredCount > 0 ? `You have ${unansweredCount} unanswered or incomplete ${unansweredCount === 1 ? 'question' : 'questions'}. ` : ''}After you submit this ${isCase ? 'case study' : 'section'}, you cannot return to ${sectionCount === 1 ? 'this question or change your answer' : 'these questions or change your answers'}.`}
        confirmLabel={dialog === 'end' ? 'End and submit' : dialog === 'final' ? 'Submit exam' : isCase ? 'Submit case study' : 'Submit section'}
        cancelLabel={dialog === 'end' ? 'Return to exam' : dialog === 'final' || isCase ? 'Go back' : 'Return to review'}
        onCancel={dismiss}
        onConfirm={() => {
          setDialog(null)
          if (!canCommit) return
          if (dialog === 'final' && view === 'final') act({ type: 'FINAL_SUBMIT' })
          else if (dialog === 'end' && isWorking) act({ type: 'END_EXAM' })
          else if (active && view === 'review') act({ type: 'SUBMIT_SECTION', sectionId: active.id })
        }}
      />
    </>
  )
}
