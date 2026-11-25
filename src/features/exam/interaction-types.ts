/** Candidate-only display contracts: immutable source IDs, text, and verified metadata.
 * No answer keys, scoring dependencies, or guessed image geometry belong here. */
export interface DisplayOption {
  readonly id: string
  readonly label: string
}

export interface DisplayTarget {
  readonly id: string
  readonly label: string
  readonly options: readonly DisplayOption[]
}

type ChoiceKind = 'SINGLE_CHOICE' | 'MULTIPLE_CHOICE'
type TargetKind = 'DROPDOWN' | 'DROPDOWN_HOTSPOT' | 'MATCHING' | 'DRAG_DROP' | 'STATEMENT'
type Typed<K extends string, T> = { [P in K]: { readonly kind: P } & T }[K]

export type AnswerableDisplayInteraction =
  | Typed<ChoiceKind, { readonly options: readonly DisplayOption[]; readonly requiredSelections?: number }>
  | Typed<TargetKind, { readonly targets: readonly DisplayTarget[]; readonly selectionPolicy?: 'REUSABLE' | 'UNIQUE' }>
  | { readonly kind: 'ORDERING'; readonly items: readonly DisplayOption[]; readonly positions?: readonly DisplayOption[] }

export type DisplayInteraction =
  | AnswerableDisplayInteraction
  | { readonly kind: 'IMAGE_HOTSPOT' }
  | { readonly kind: 'DIAGRAM_DEPENDENT'; readonly assetId?: string; readonly interaction?: AnswerableDisplayInteraction }

export type OrderingChange =
  | { readonly type: 'MOVE'; readonly id: string; readonly direction: 'UP' | 'DOWN' }
  | { readonly type: 'PLACE'; readonly id: string; readonly beforeId: string | null }
  | { readonly type: 'REMOVE'; readonly id: string }
  | { readonly type: 'CONFIRM' }

// A display-side response deliberately excludes keys, scoring and source content.
// Stable-ID deltas merge into the newest queued candidate answer; snapshots are
// also emitted for presentation/tests and are not authoritative when a delta is present.
export interface DisplayResponse {
  readonly selected?: readonly string[]
  readonly choiceChange?: { readonly id: string; readonly selected: boolean }
  readonly targets?: Readonly<Record<string, string>>
  readonly targetChange?: { readonly id: string; readonly value: string | null; readonly fromId?: string }
  readonly order?: readonly string[]
  readonly orderChange?: OrderingChange
}

export interface RendererProps<T extends DisplayInteraction> {
  readonly interaction: T
  readonly response: DisplayResponse
  readonly onChange: (response: DisplayResponse) => void
  readonly disabled?: boolean
  readonly readOnly?: boolean
  readonly availableExhibitIds?: readonly string[]
}

export type PlacementInteraction = Extract<AnswerableDisplayInteraction, { readonly kind: 'MATCHING' | 'DRAG_DROP' }>
export type OrderingDisplayInteraction = Extract<AnswerableDisplayInteraction, { readonly kind: 'ORDERING' }>

export function getTargetSelection(targets: DisplayResponse['targets'], id: string): string | undefined {
  return targets && Object.hasOwn(targets, id) ? targets[id] : undefined
}
