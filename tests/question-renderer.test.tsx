import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CandidateAnswer } from '../src/domain'
import { QuestionRenderer } from '../src/features/exam/QuestionRenderer'
import type { DisplayInteraction } from '../src/features/exam/QuestionRenderer'
import { isCandidateAnswerFor, readDisplayResponse, responseState, toCandidateAnswer } from '../src/features/exam/question-response'

const options = [
  { id: 'green', label: 'Green' },
  { id: 'teal', label: 'Teal' },
  { id: 'blue', label: 'Blue' },
] as const

const matching = {
  kind: 'MATCHING',
  targets: [{ id: 'paper', label: 'Paper', options }, { id: 'photo', label: 'Photograph', options }],
} as const satisfies DisplayInteraction
const ordering = {
  kind: 'ORDERING',
  items: options,
  positions: [{ id: 'first', label: 'First' }, { id: 'second', label: 'Second' }],
} as const satisfies DisplayInteraction

describe('display-only answer adapters', () => {
  it('round-trips reviewed IDs only, leaving no shared mutation reference', () => {
    const answer = { kind: 'MULTIPLE_CHOICE', optionIds: ['green', 'teal'] } as const
    const interaction = { kind: 'MULTIPLE_CHOICE', options } as const
    const view = readDisplayResponse(interaction, answer)
    expect(view?.selected).not.toBe(answer.optionIds)
    expect(toCandidateAnswer(interaction, view ?? {})).toEqual(answer)
    expect(toCandidateAnswer({ kind: 'SINGLE_CHOICE', options }, { selected: ['green'] }))
      .toEqual({ kind: 'SINGLE_CHOICE', optionId: 'green' })
    expect(toCandidateAnswer({ kind: 'SINGLE_CHOICE', options }, { selected: ['green', 'blue'] })).toBeNull()
  })

  it('accepts only known reviewed choices and question-local answer kinds', () => {
    expect(isCandidateAnswerFor(matching, { kind: 'MATCHING', selections: { photo: 'blue' } })).toBe(true)
    expect(isCandidateAnswerFor(matching, { kind: 'DROPDOWN', selections: { photo: 'blue' } })).toBe(false)
    expect(isCandidateAnswerFor(matching, { kind: 'MATCHING', selections: { missing: 'blue' } })).toBe(false)
    expect(isCandidateAnswerFor(matching, { kind: 'MATCHING', selections: { photo: 'outside' } })).toBe(false)
    expect(isCandidateAnswerFor(matching, { kind: 'MATCHING', selections: { photo: 'blue' }, expected: 'outside' })).toBe(false)
    expect(isCandidateAnswerFor(matching, { kind: 'MATCHING', selections: { __proto__: { photo: 'blue' } } })).toBe(false)
    expect(isCandidateAnswerFor({ kind: 'MULTIPLE_CHOICE', options }, { kind: 'MULTIPLE_CHOICE', optionIds: Array(1) })).toBe(false)
    expect(readDisplayResponse(matching, { kind: 'SINGLE_CHOICE', optionId: 'blue' })).toBeUndefined()
  })

  it('combines each matching field edit with the latest answer and allows reuse', () => {
    const first = toCandidateAnswer(matching, { targetChange: { id: 'photo', value: 'teal' } })
    const second = toCandidateAnswer(matching, { targets: { paper: 'teal' }, targetChange: { id: 'paper', value: 'teal' } }, first ?? undefined)
    expect(second).toEqual({ kind: 'MATCHING', selections: { photo: 'teal', paper: 'teal' } })
    expect(responseState(matching, readDisplayResponse(matching, first ?? undefined))).toBe('INCOMPLETE')
    expect(responseState(matching, readDisplayResponse(matching, second ?? undefined))).toBe('ANSWERED')
    const invalid = toCandidateAnswer(matching, { targetChange: { id: 'paper', value: 'outside' } }, second ?? undefined)
    expect(invalid).toBe(second)
    const remove = toCandidateAnswer(matching, { targetChange: { id: 'photo', value: null } }, second ?? undefined)
    expect(remove).toEqual({ kind: 'MATCHING', selections: { paper: 'teal' } })
    expect(toCandidateAnswer(matching, { targetChange: { id: 'paper', value: null } }, remove ?? undefined)).toBeNull()
  })

  it('combines checkbox edits even when the UI snapshot predates the last successful change', () => {
    const interaction = { kind: 'MULTIPLE_CHOICE', options } as const
    const first: CandidateAnswer = { kind: 'MULTIPLE_CHOICE', optionIds: ['teal'] }
    const second = toCandidateAnswer(interaction, { selected: ['green'], choiceChange: { id: 'green', selected: true } }, first)
    expect(second).toEqual({ kind: 'MULTIPLE_CHOICE', optionIds: ['green', 'teal'] })
    expect(toCandidateAnswer(interaction, { choiceChange: { id: 'teal', selected: false } }, second ?? undefined))
      .toEqual({ kind: 'MULTIPLE_CHOICE', optionIds: ['green'] })
  })

  it('preserves partial multi answers, validates the display-only instruction count, and permits deselection', () => {
    const interaction = { kind: 'MULTIPLE_CHOICE', options, requiredSelections: 2 } as const
    const one = toCandidateAnswer(interaction, { selected: ['green'] })
    expect(one).toEqual({ kind: 'MULTIPLE_CHOICE', optionIds: ['green'] })
    expect(responseState(interaction, { selected: ['green'] })).toBe('INCOMPLETE')
    const two = toCandidateAnswer(interaction, { choiceChange: { id: 'teal', selected: true } }, one ?? undefined)
    expect(responseState(interaction, readDisplayResponse(interaction, two ?? undefined))).toBe('ANSWERED')
    expect(toCandidateAnswer(interaction, { choiceChange: { id: 'blue', selected: true } }, two ?? undefined)).toBe(two)
    expect(toCandidateAnswer(interaction, { choiceChange: { id: 'green', selected: false } }, two ?? undefined))
      .toEqual({ kind: 'MULTIPLE_CHOICE', optionIds: ['teal'] })
    expect(isCandidateAnswerFor(interaction, { kind: 'MULTIPLE_CHOICE', optionIds: ['green', 'teal', 'blue'] })).toBe(false)
  })

  it('distinguishes an explicitly ordered subset, incomplete subset, and no response', () => {
    expect(responseState(ordering)).toBe('UNANSWERED')
    expect(responseState(ordering, { order: ['blue'] })).toBe('INCOMPLETE')
    expect(responseState(ordering, { order: ['teal', 'blue'] })).toBe('ANSWERED')
    expect(toCandidateAnswer(ordering, { order: ['blue', 'teal'] })).toEqual({ kind: 'ORDERING', optionIds: ['blue', 'teal'] })
    expect(toCandidateAnswer(ordering, { order: ['green', 'teal', 'blue'] })).toBeNull()
    expect(toCandidateAnswer(ordering, { order: ['teal', 'teal'] })).toBeNull()
  })
})

describe('question renderer markup', () => {
  const markup = (interaction: DisplayInteraction, response = {}, disabled = false) =>
    renderToStaticMarkup(<QuestionRenderer interaction={interaction} response={response} disabled={disabled} onChange={() => undefined} />)

  it('renders matching, dropdown hotspot, and statements with semantic keyboard controls', () => {
    const matches = markup(matching, { targets: { photo: 'blue' } })
    expect(matches.match(/<select/g)).toHaveLength(2)
    expect(matches.match(/<label for=/g)).toHaveLength(2)
    expect(matches).toMatch(/<option value="blue" selected="">Blue<\/option>/)
    const hotspot = markup({ ...matching, kind: 'DROPDOWN_HOTSPOT' })
    expect(hotspot.match(/<select/g)).toHaveLength(2)
    expect(hotspot).not.toMatch(/<canvas|<map|<svg|<img|<button/)
    const statements = markup({ ...matching, kind: 'STATEMENT' }, {}, true)
    expect(statements.match(/<fieldset[^>]* disabled/g)).toHaveLength(2)
    expect(statements.match(/type="radio"/g)).toHaveLength(6)
  })

  it('offers long label text independently of the native popup', () => {
    const label = 'A detailed response may not fit inside a small native selection field'
    const interaction = { kind: 'DROPDOWN', targets: [{ id: 't1', label: 'Response field', options: [{ id: 'long', label }] }] } as const
    const html = markup(interaction, { targets: { t1: 'long' } })
    expect(html).toContain('aria-label="Read options for Response field"')
    expect(html).toContain('Selected: ' + label)
    expect(html).toContain('<li>' + label + '</li>')
  })

  it('exposes ordering positions, accessible move and remove names, and a live announcement region', () => {
    const html = markup(ordering, { order: ['green'] })
    expect(html).toMatch(/First: Green/)
    expect(html).toMatch(/<label[^>]*>Second<\/label>/)
    expect(html).toContain('aria-label="Move Green down"')
    expect(html).toContain('aria-label="Remove Green"')
    expect(html).toContain('role="status"')
  })

  it('announces the source-specified choice count and disables only unselected options when full', () => {
    const html = markup({ kind: 'MULTIPLE_CHOICE', options, requiredSelections: 2 }, { selected: ['green', 'teal'] })
    expect(html).toContain('Select 2 options')
    expect(html).toContain('2 of 2 selected')
    expect(html.match(/<input[^>]* disabled/g)).toHaveLength(1)
  })

  it('renders source content as escaped text and fails closed for geometry not supplied', () => {
    const html = markup({ kind: 'SINGLE_CHOICE', options: [{ id: 'literal', label: '<svg onload=alert(1)>' }] })
    expect(html).toContain('&lt;svg onload=alert(1)&gt;')
    expect(html).not.toContain('<svg')
    expect(markup({ kind: 'IMAGE_HOTSPOT' })).toContain('role="alert"')
    expect(markup({ kind: 'IMAGE_HOTSPOT' })).not.toContain('<input')
  })
})
