// Чистая сортировка лотов — вынесена из pages/LotsPage.tsx для переиспользования
// в десктопной LotsPage и мобильной MobileLotsPage (единый источник, поведение
// не меняется).

export type SortKey = 'buyout_price' | 'amount' | 'price_per_unit' | 'hours_remaining' | 'enchant_level'
export type SortDir = 'asc' | 'desc'

export function sortLots<T extends { buyout_price: number; amount: number; hours_remaining: number | null; enchant_level: number | null }>(
  lots: T[], key: SortKey, dir: SortDir,
): T[] {
  return [...lots].sort((a, b) => {
    let av: number, bv: number
    if (key === 'price_per_unit') {
      av = Math.floor(a.buyout_price / a.amount)
      bv = Math.floor(b.buyout_price / b.amount)
    } else if (key === 'hours_remaining') {
      av = a.hours_remaining ?? Infinity
      bv = b.hours_remaining ?? Infinity
    } else if (key === 'enchant_level') {
      av = a.enchant_level ?? -1
      bv = b.enchant_level ?? -1
    } else {
      av = a[key] as number
      bv = b[key] as number
    }
    return dir === 'asc' ? av - bv : bv - av
  })
}
