// Регионы аукциона STALZONE — единый источник для ui/RegionSelect и страниц
// (вынесено из CatalogPage/LotsPage). Регион никогда не свободный TextField (FORM-01).

export const REGIONS = ['RU', 'EU', 'NA', 'SEA'] as const

export type Region = (typeof REGIONS)[number]
