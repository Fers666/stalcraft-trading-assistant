import { tokens } from '../theme'

const { goldSoft: G1, gold: G2, goldHighlight: G4, text2: T2 } = tokens

export const TIER_OPTIONS = ['base', 'advanced', 'advanced_plus', 'advanced_max'] as const
export type Tier = typeof TIER_OPTIONS[number]

export const TIER_LABELS: Record<Tier, string> = {
  base: 'Базовая',
  advanced: 'Продвинутая',
  advanced_plus: 'Продвинутая+',
  advanced_max: 'Макс',
}

export const TIER_COLORS: Record<Tier, string> = {
  base: T2,
  advanced: G1,
  advanced_plus: G2,
  advanced_max: G4,
}
