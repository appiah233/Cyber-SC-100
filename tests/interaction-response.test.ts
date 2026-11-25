import { describe, expect, it } from 'vitest'
import type { CandidateAnswer } from '../src/domain/model'
import type { DisplayInteraction, DisplayResponse, OrderingDisplayInteraction } from '../src/features/exam/interaction-types'
import { isCandidateAnswerFor, readDisplayResponse, responseState, toCandidateAnswer } from '../src/features/exam/question-response'

const opts = [{ id: 'alpha', label: 'Alpha' }, { id: 'beta', label: 'Beta' }, { id: 'gamma', label: 'Gamma' }] as const
const targets = [{ id: 'one', label: 'One', options: opts }, { id: 'two', label: 'Two', options: opts }, { id: 'three', label: 'Three', options: opts }] as const
const ordering = { kind: 'ORDERING', items: opts } as const satisfies OrderingDisplayInteraction
const diagram = { kind: 'DIAGRAM_DEPENDENT', assetId: 'verified-demo', interaction: { kind: 'DROPDOWN', targets } } as const satisfies DisplayInteraction

describe('Phase 6 stable-ID response contracts', () => {
  it('round trips every supported interaction across JSON and structured clone without scoring fields', () => {
    const samples: readonly [DisplayInteraction, DisplayResponse, CandidateAnswer][] = [
      [{ kind: 'SINGLE_CHOICE', options: opts }, { selected: ['beta'] }, { kind: 'SINGLE_CHOICE', optionId: 'beta' }],
      [{ kind: 'MULTIPLE_CHOICE', options: opts }, { selected: ['beta', 'alpha'] }, { kind: 'MULTIPLE_CHOICE', optionIds: ['beta', 'alpha'] }],
      [ordering, { order: ['gamma', 'beta', 'alpha'] }, { kind: 'ORDERING', optionIds: ['gamma', 'beta', 'alpha'] }],
      ...(['DROPDOWN', 'DROPDOWN_HOTSPOT', 'STATEMENT', 'MATCHING', 'DRAG_DROP'] as const).map((kind):
        [DisplayInteraction, DisplayResponse, CandidateAnswer] => [
        { kind, targets } as Extract<DisplayInteraction, { targets: readonly unknown[] }>,
        { targets: { one: 'beta', two: 'alpha' } }, { kind, selections: { one: 'beta', two: 'alpha' } },
      ]),
      [diagram, { targets: { one: 'beta' } }, { kind: 'DIAGRAM_DEPENDENT', response: { kind: 'DROPDOWN', selections: { one: 'beta' } } }],
    ]
    for (const [interaction, display, expected] of samples) {
      const serialized = toCandidateAnswer(interaction, display)
      expect(serialized).toStrictEqual(expected)
      for (const incoming of [JSON.parse(JSON.stringify(serialized)) as unknown, structuredClone(serialized)]) {
        expect(isCandidateAnswerFor(interaction, incoming)).toBe(true)
        if (!isCandidateAnswerFor(interaction, incoming)) throw new Error('Candidate response rejected')
        expect(readDisplayResponse(interaction, incoming)).toStrictEqual(display)
        expect(toCandidateAnswer(interaction, readDisplayResponse(interaction, incoming)!)).toStrictEqual(expected)
      }
    }
  })

  it('applies fresh ordering operations to the latest sequence, ignoring stale UI snapshots', () => {
    const stale = { order: ['alpha', 'beta', 'gamma'] }
    const place = toCandidateAnswer(ordering, { ...stale, orderChange: { type: 'PLACE', id: 'gamma', beforeId: 'alpha' } })
    expect(place).toEqual({ kind: 'ORDERING', optionIds: ['gamma', 'alpha', 'beta'] })
    const move = toCandidateAnswer(ordering, { ...stale, orderChange: { type: 'MOVE', id: 'alpha', direction: 'DOWN' } }, place ?? undefined)
    expect(move).toEqual({ kind: 'ORDERING', optionIds: ['gamma', 'beta', 'alpha'] })
    const reverse = toCandidateAnswer(ordering, { ...stale, orderChange: { type: 'MOVE', id: 'alpha', direction: 'UP' } }, move ?? undefined)
    expect(reverse).toEqual(place)
    const reject = toCandidateAnswer(ordering, { ...stale, orderChange: { type: 'PLACE', id: 'gamma', beforeId: 'forged-id' } }, reverse ?? undefined)
    expect(reject).toBe(reverse)
  })

  it('supports explicit subset positions with clear, over-cap protection, and source-stable labels', () => {
    const interaction = { ...ordering, positions: [{ id: 'slot-a', label: 'First' }, { id: 'slot-b', label: 'Second' }] }
    const place = (id: string, beforeId: string | null, prior?: CandidateAnswer) =>
      toCandidateAnswer(interaction, { orderChange: { type: 'PLACE', id, beforeId } }, prior)
    const first = place('alpha', null)
    expect(responseState(interaction, readDisplayResponse(interaction, first ?? undefined))).toBe('INCOMPLETE')
    const second = place('beta', 'alpha', first ?? undefined)
    expect(second).toEqual({ kind: 'ORDERING', optionIds: ['beta', 'alpha'] })
    expect(responseState(interaction, readDisplayResponse(interaction, second ?? undefined))).toBe('ANSWERED')
    expect(place('gamma', null, second ?? undefined)).toBe(second)
    const remove = (id: string, prior?: CandidateAnswer) => toCandidateAnswer(interaction, { orderChange: { type: 'REMOVE', id } }, prior)
    expect(remove('alpha', remove('beta', second ?? undefined) ?? undefined)).toBeNull()
  })

  it('keeps authored complete initial order explicitly unanswered until candidate confirms it', () => {
    expect(responseState(ordering, { orderChange: { type: 'CONFIRM' } })).toBe('UNANSWERED')
    const candidate = toCandidateAnswer(ordering, { orderChange: { type: 'CONFIRM' } })
    expect(candidate).toEqual({ kind: 'ORDERING', optionIds: ['alpha', 'beta', 'gamma'] })
    expect(responseState(ordering, readDisplayResponse(ordering, candidate ?? undefined))).toBe('ANSWERED')
  })

  it('supports reusable atomic drag moves without changing other instances or trusting stale source', () => {
    const interaction = { kind: 'DRAG_DROP', targets, selectionPolicy: 'REUSABLE' } as const
    const before = { kind: 'DRAG_DROP', selections: { one: 'alpha', two: 'alpha', three: 'beta' } } satisfies CandidateAnswer
    const next = toCandidateAnswer(interaction, {
      targets: { one: 'incorrect-snapshot', two: 'incorrect-snapshot' },
      targetChange: { id: 'three', value: 'alpha', fromId: 'one' },
    }, before)
    expect(next).toEqual({ kind: 'DRAG_DROP', selections: { two: 'alpha', three: 'alpha' } })
    expect(toCandidateAnswer(interaction, { targetChange: { id: 'one', fromId: 'three', value: 'beta' } }, next ?? undefined)).toBe(next)
    expect(responseState(interaction, readDisplayResponse(interaction, next ?? undefined))).toBe('INCOMPLETE')
  })

  it('enforces one-use matching only when authored and never allows unvalidated target options', () => {
    const interaction = { kind: 'MATCHING', targets: [...targets.slice(0, 2), { ...targets[2], options: [opts[1]] }], selectionPolicy: 'UNIQUE' } as const
    const before = { kind: 'MATCHING', selections: { one: 'alpha', three: 'beta' } } satisfies CandidateAnswer
    expect(isCandidateAnswerFor(interaction, { kind: 'MATCHING', selections: { one: 'alpha', two: 'alpha' } })).toBe(false)
    const moved = toCandidateAnswer(interaction, { targetChange: { id: 'two', value: 'alpha' } }, before)
    expect(moved).toEqual({ kind: 'MATCHING', selections: { two: 'alpha', three: 'beta' } })
    expect(toCandidateAnswer(interaction, { targetChange: { id: 'three', value: 'alpha', fromId: 'two' } }, moved ?? undefined)).toBe(moved)
  })

  it('rejects image geometry and untrusted or mismatched nested responses', () => {
    const image = { kind: 'IMAGE_HOTSPOT' } as const
    expect(isCandidateAnswerFor(image, { kind: 'IMAGE_HOTSPOT', regionIds: ['made-up'] })).toBe(false)
    expect(toCandidateAnswer(image, {})).toBeNull()
    expect(toCandidateAnswer({ kind: 'DIAGRAM_DEPENDENT', interaction: diagram.interaction }, { targets: { one: 'alpha' } })).toBeNull()
    expect(isCandidateAnswerFor(diagram, { kind: 'DROPDOWN', selections: { one: 'alpha' } })).toBe(false)
    expect(isCandidateAnswerFor(diagram, {
      kind: 'DIAGRAM_DEPENDENT', response: { kind: 'DROPDOWN', selections: { one: 'alpha' }, score: 0 },
    })).toBe(false)
    expect(isCandidateAnswerFor(diagram, {
      kind: 'DIAGRAM_DEPENDENT', response: { kind: 'DROPDOWN', selections: { one: 'alpha', [Symbol('hidden')]: 'gamma' } },
    })).toBe(false)
    expect(responseState(diagram, { targets: { one: 'alpha' } })).toBe('INCOMPLETE')
    expect(responseState(diagram, { targets: { one: 'alpha', two: 'alpha', three: 'alpha' } })).toBe('ANSWERED')
  })
})
