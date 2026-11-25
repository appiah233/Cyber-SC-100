export type ContentVersion = string
export type SourceQuestionId = string
export type OptionId = string
export type TargetId = string
export type AssetId = string
export type Seed = string | number

export interface InteractionOption {
  readonly id: OptionId
  readonly label: string
}

export interface InteractionTarget {
  readonly id: TargetId
  readonly label: string
  readonly options: readonly InteractionOption[]
}

export interface ImageRegion {
  readonly id: string
  readonly label: string
  readonly points: readonly {
    readonly x: number
    readonly y: number
  }[]
}

export type AnswerableQuestionInteraction =
  | { readonly kind: 'SINGLE_CHOICE' | 'MULTIPLE_CHOICE'; readonly options: readonly InteractionOption[] }
  | { readonly kind: 'DROPDOWN' | 'DROPDOWN_HOTSPOT' | 'STATEMENT'; readonly targets: readonly InteractionTarget[] }
  | {
    readonly kind: 'MATCHING' | 'DRAG_DROP'
    readonly targets: readonly Pick<InteractionTarget, 'id' | 'label'>[]
    readonly choices: readonly InteractionOption[]
  }
  | { readonly kind: 'ORDERING'; readonly items: readonly InteractionOption[] }
  | { readonly kind: 'IMAGE_HOTSPOT'; readonly assetId: AssetId; readonly regions: readonly ImageRegion[] }

export type QuestionInteraction =
  | AnswerableQuestionInteraction
  | { readonly kind: 'DIAGRAM_DEPENDENT'; readonly assetId: AssetId; readonly interaction: AnswerableQuestionInteraction }

export interface SourceQuestion {
  readonly sourceId: SourceQuestionId
  readonly sourceDocumentId: string
  readonly sourcePage: number
  readonly sourceSpan?: string
  readonly sourceInteraction: QuestionInteraction['kind']
  readonly rawText: string
  readonly rawOptions: readonly InteractionOption[]
  readonly rawAnswer: string
  readonly rawExplanation: string
  readonly sourceAssets: readonly AssetId[]
}

export interface QuestionMetadata {
  readonly sourceId: SourceQuestionId
  readonly contentVersion: ContentVersion
  readonly interactionType: QuestionInteraction['kind']
  readonly caseStudyIds: readonly string[]
  readonly requiredAssetIds: readonly AssetId[]
  readonly sourceValidated: boolean
  readonly interactionValidated: boolean
  readonly caseStudyValidated: boolean
  readonly contentApproved: boolean
  readonly productionEligible: boolean
  readonly reviewStatus: string
}

export interface PublishedQuestion {
  readonly sourceId: SourceQuestionId
  readonly prompt: string
  readonly interaction: QuestionInteraction
  readonly assetIds: readonly AssetId[]
}

export interface ReviewedAnswerDefinition {
  readonly sourceId: SourceQuestionId
  readonly version: ContentVersion
  readonly sourceAnswerDigest: string
  readonly sourceAnswerReference: string
  readonly answer: CandidateAnswer
}

export interface CaseStudy {
  readonly id: string
  readonly label: string
  readonly scenarioReferences: readonly string[]
  readonly assetIds: readonly AssetId[]
  readonly eligibleChildIds: readonly SourceQuestionId[]
  readonly status: 'NEEDS_REVIEW' | 'VALIDATED_FOR_DEVELOPMENT' | 'PRODUCTION_APPROVED' | 'REJECTED'
}

export interface QuestionAsset {
  readonly id: AssetId
  readonly kind: 'IMAGE' | 'DIAGRAM' | 'EXHIBIT' | 'PLACEHOLDER'
  readonly sourceDocumentId: string
  readonly sourcePage: number
  readonly path: string | null
  readonly sha256: string | null
  readonly originalDimensions: { readonly width: number; readonly height: number } | null
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null
  readonly altText: string
  readonly reviewStatus: 'UNREVIEWED' | 'VERIFIED' | 'SOURCE_PLACEHOLDER_NO_RECOVERABLE_EXHIBIT'
}

export interface QuestionBankManifest {
  readonly schemaVersion: number
  readonly contentVersion: ContentVersion
  readonly sourceVersion: string
  readonly metadataRevision: string
  readonly scoringPolicyVersion: string
  readonly questionIds: readonly SourceQuestionId[]
  readonly assets: Readonly<Record<AssetId, string>>
  readonly contentDigests: Readonly<Record<string, string>>
  readonly mode: 'DEVELOPMENT' | 'PRODUCTION'
}

export const NORMAL_SECTIONS = Object.freeze([
  Object.freeze({ kind: 'CASE_STUDY_1' as const, count: 3 }),
  Object.freeze({ kind: 'CASE_STUDY_2' as const, count: 3 }),
  Object.freeze({ kind: 'STANDARD_BLOCK' as const, count: 49 }),
  Object.freeze({ kind: 'FINAL_INTERACTIVE_BLOCK' as const, count: 4 }),
])

export type NormalExamSectionKind = (typeof NORMAL_SECTIONS)[number]['kind']
export type ExamSectionKind = NormalExamSectionKind | 'REMAINDER_CASE_STUDY' | 'REMAINDER_UNSECTIONED'
export type ExamSectionKey = ExamSectionKind | `REMAINDER_CASE_STUDY:${string}`
export type ExamBatchMode = 'NORMAL' | 'ADAPTIVE' | 'FINAL_REMAINDER'
export const NORMAL_QUESTION_COUNT = NORMAL_SECTIONS.reduce((total, section) => total + section.count, 0)

export interface ExamSection {
  readonly kind: ExamSectionKind
  readonly questionIds: readonly SourceQuestionId[]
  readonly caseStudyId?: string
}

export interface ExamBatch {
  readonly id: string
  readonly contentVersion: ContentVersion
  readonly seed: Seed
  readonly sections: readonly ExamSection[]
  readonly mode?: 'REFERENCE' | 'DEVELOPMENT' | 'PRODUCTION'
  readonly batchMode?: ExamBatchMode
}

export interface ExamCycle {
  readonly id: string
  readonly contentVersion: ContentVersion
  readonly consumedQuestionIds: readonly SourceQuestionId[]
  readonly reservedQuestionIds: readonly SourceQuestionId[]
}

type Selections = Readonly<Partial<Record<TargetId, OptionId>>>

export type CandidateInteractionAnswer =
  | { readonly kind: 'SINGLE_CHOICE'; readonly optionId: OptionId }
  | { readonly kind: 'MULTIPLE_CHOICE' | 'ORDERING'; readonly optionIds: readonly OptionId[] }
  | {
    readonly kind: 'DROPDOWN' | 'DROPDOWN_HOTSPOT' | 'MATCHING' | 'DRAG_DROP' | 'STATEMENT'
    readonly selections: Selections
  }
  | { readonly kind: 'IMAGE_HOTSPOT'; readonly regionIds: readonly string[] }

export type CandidateAnswer =
  | CandidateInteractionAnswer
  | { readonly kind: 'DIAGRAM_DEPENDENT'; readonly response: CandidateInteractionAnswer }

export interface ReviewMark {
  readonly questionId: SourceQuestionId
  readonly marked: boolean
}

export interface ExamResult {
  readonly correctCount: number
  readonly questionCount: number
  readonly percentage: number
  readonly scoringPolicyVersion?: string
}

export type ExamFinalizationReason = 'MANUAL_SUBMISSION' | 'TIME_EXPIRED'
export type PostExamReviewPolicy = 'NONE' | 'RESPONSES_ONLY' | 'CORRECTNESS' | 'ANSWERS_AND_EXPLANATIONS'

export interface ScoreCounts {
  readonly correctCount: number
  readonly incorrectCount: number
  readonly unansweredCount: number
  readonly questionCount: number
}

export interface SectionScore extends ScoreCounts {
  readonly sectionId: ExamSectionKey
  readonly sectionKind: ExamSectionKind
  readonly caseStudyId?: string
}

export interface InteractionScore extends ScoreCounts {
  readonly interactionKind: QuestionInteraction['kind']
}

/** Aggregate result only; this record is never an answer-review payload. */
export interface ScoredExamResult extends ExamResult, ScoreCounts {
  readonly schemaVersion: 2
  readonly attemptId: string
  readonly batchId: string
  readonly snapshotId: string
  readonly bankVersion: ContentVersion
  readonly scoringVersion: string
  readonly scoringPolicyVersion: string
  readonly rawScore: number
  readonly maximumScore: number
  readonly displayPercentage: string
  readonly passingPercentage: number
  readonly outcome: 'PASS' | 'FAIL'
  readonly completedAt: number
  readonly finalizationReason: ExamFinalizationReason
  readonly postExamReviewPolicy: PostExamReviewPolicy
  readonly sectionBreakdown: readonly SectionScore[]
  readonly interactionTypeBreakdown: readonly InteractionScore[]
}

/** Phase 6 compatibility shape. Candidate data only; missing answers stay absent. */
export interface FinalizedAnswerSnapshot {
  readonly attemptId: string
  readonly cycleId: string
  readonly batchId: string
  readonly contentVersion: ContentVersion
  readonly questionIds: readonly SourceQuestionId[]
  readonly submittedAt: number
  readonly reason: ExamFinalizationReason
  readonly answers: Readonly<Partial<Record<SourceQuestionId, CandidateAnswer>>>
}

export type ExamInteractionKinds = Readonly<Record<SourceQuestionId, QuestionInteraction['kind']>>

export interface PinnedFinalizedAnswerSnapshot extends FinalizedAnswerSnapshot {
  readonly schemaVersion: 2
  readonly snapshotId: string
  readonly bankVersion: ContentVersion
  readonly finalizedAt: number
  readonly finalizationReason: ExamFinalizationReason
  readonly sections: readonly ExamSection[]
  readonly interactionKinds: ExamInteractionKinds
}

export type AttemptStatus =
  | 'CREATED' | 'READY'
  | 'CASE_STUDY_1_IN_PROGRESS' | 'CASE_STUDY_1_SUBMITTED'
  | 'CASE_STUDY_2_IN_PROGRESS' | 'CASE_STUDY_2_SUBMITTED'
  | 'STANDARD_BLOCK_IN_PROGRESS' | 'STANDARD_BLOCK_SUBMITTED'
  | 'INTERACTIVE_BLOCK_IN_PROGRESS' | 'INTERACTIVE_BLOCK_SUBMITTED'
  | 'REMAINDER_CASE_STUDY_IN_PROGRESS' | 'REMAINDER_CASE_STUDY_SUBMITTED'
  | 'REMAINDER_UNSECTIONED_IN_PROGRESS' | 'REMAINDER_UNSECTIONED_SUBMITTED'
  | 'FINAL_SUBMISSION_PENDING' | 'SUBMITTED' | 'SCORED'

export interface ExamAttempt {
  readonly id: string
  readonly cycleId: string
  readonly batch: ExamBatch
  readonly contentVersion: ContentVersion
  readonly revision: number
  readonly status: AttemptStatus
  readonly activeSection: ExamSectionKey | null
  readonly position: number
  readonly locks: readonly ExamSectionKey[]
  readonly answers: Readonly<Partial<Record<SourceQuestionId, CandidateAnswer>>>
  readonly reviewMarks: Readonly<Partial<Record<SourceQuestionId, boolean>>>
  readonly optionOrder: Readonly<Partial<Record<SourceQuestionId, readonly OptionId[]>>>
  /** Pinned by the verified plan, never inferred from which items were answered. */
  readonly interactionKinds?: ExamInteractionKinds
  readonly updatedAt: number | null
  readonly submittedAt: number | null
  /** Undefined is the validated pre-timer, untimed storage format. */
  readonly startedAt?: number | null
  readonly expiresAt?: number | null
  readonly finalizationReason?: ExamFinalizationReason | null
  readonly finalizedAnswerSnapshot?: FinalizedAnswerSnapshot | PinnedFinalizedAnswerSnapshot | null
  readonly result: ExamResult | ScoredExamResult | null
}
