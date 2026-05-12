// Promethean V0 vocab — mirrors the lib/client-vocab.ts pattern. These
// values are mock-only for the shell; when real ingestion lands, replace
// the source with DB CHECK constraints + drop the SAMPLE_* helpers.

export type VocabOption<T extends string = string> = {
  value: T
  label: string
}

export const COUNTRY_OPTIONS = [
  { value: 'USA', label: 'United States' },
  { value: 'CAN', label: 'Canada' },
  { value: 'AUS', label: 'Australia' },
  { value: 'UK', label: 'United Kingdom' },
  { value: 'GBR', label: 'Great Britain' },
] as const satisfies readonly VocabOption[]

export type CountryValue = (typeof COUNTRY_OPTIONS)[number]['value']

export const LEAD_STATUS_OPTIONS = [
  { value: 'new', label: 'New' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'qualified', label: 'Qualified' },
  { value: 'booked', label: 'Booked' },
  { value: 'showed', label: 'Showed' },
  { value: 'pitched', label: 'Pitched' },
  { value: 'won', label: 'Won' },
  { value: 'lost', label: 'Lost' },
] as const satisfies readonly VocabOption[]

export type LeadStatusValue = (typeof LEAD_STATUS_OPTIONS)[number]['value']

export const OUTCOME_OPTIONS = [
  { value: 'won', label: 'Won' },
  { value: 'lost', label: 'Lost' },
  { value: 'no_show', label: 'No show' },
  { value: 'dq', label: 'Disqualified' },
] as const satisfies readonly VocabOption[]

export type OutcomeValue = (typeof OUTCOME_OPTIONS)[number]['value']

export const LEAD_QUALITY_OPTIONS = [
  { value: 'ready_to_buy', label: 'Ready to buy' },
  { value: 'good', label: 'Good' },
  { value: 'average', label: 'Average' },
  { value: 'poor', label: 'Poor' },
] as const satisfies readonly VocabOption[]

export type LeadQualityValue = (typeof LEAD_QUALITY_OPTIONS)[number]['value']

export const SENTIMENT_OPTIONS = [
  { value: 'green', label: 'Green' },
  { value: 'yellow', label: 'Yellow' },
  { value: 'red', label: 'Red' },
] as const satisfies readonly VocabOption[]

export type SentimentValue = (typeof SENTIMENT_OPTIONS)[number]['value']

export const DIAL_OUTCOME_OPTIONS = [
  { value: 'no_answer', label: 'No answer' },
  { value: 'voicemail', label: 'Voicemail' },
  { value: 'live', label: 'Live convo' },
  { value: 'booked', label: 'Booked' },
] as const satisfies readonly VocabOption[]

export type DialOutcomeValue = (typeof DIAL_OUTCOME_OPTIONS)[number]['value']

export const TRIAGE_STATUS_OPTIONS = [
  { value: 'untriaged', label: 'Untriaged' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'dq', label: 'DQ' },
  { value: 'follow_up', label: 'Follow-up' },
  { value: 'no_show', label: 'No show' },
] as const satisfies readonly VocabOption[]

export type TriageStatusValue = (typeof TRIAGE_STATUS_OPTIONS)[number]['value']

export const QC_GRADE_OPTIONS = [
  { value: 'green', label: 'Green' },
  { value: 'yellow', label: 'Yellow' },
  { value: 'red', label: 'Red' },
] as const satisfies readonly VocabOption[]

export type QcGradeValue = (typeof QC_GRADE_OPTIONS)[number]['value']
