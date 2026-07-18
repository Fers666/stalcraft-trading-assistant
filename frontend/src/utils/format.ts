// Единые форматтеры цен/чисел (design/v5/assets/app.js:36-43).
// Все страницы используют только эти функции — «свой формат цен» запрещён (DIRECTION §2).
// toLocaleString('ru-RU') сам вставляет U+00A0/U+202F как разделитель разрядов — это ок;
// пробел перед ₽ фиксируем явным NBSP (U+00A0), чтобы цена не рвалась переносом.

const NBSP = ' '

/** Округлённое число с ru-RU разделителями разрядов: 1 234 567 */
export const fmtN = (n: number): string => Math.round(n).toLocaleString('ru-RU')

/** Цена с рублём: «1 234 567 ₽» (NBSP перед ₽) */
export const fmtP = (n: number): string => `${fmtN(n)}${NBSP}₽`

/** Компактная цена: «1.2 млн ₽» / «340 тыс ₽» / «990 ₽» */
export const fmtCompact = (n: number): string => {
  if (n >= 1e6) {
    const m = n / 1e6
    const v = m >= 10 ? Math.round(m) : Math.round(m * 10) / 10
    return `${v.toLocaleString('ru-RU')}${NBSP}млн${NBSP}₽`
  }
  if (n >= 1e4) {
    return `${Math.round(n / 1e3).toLocaleString('ru-RU')}${NBSP}тыс${NBSP}₽`
  }
  return fmtP(n)
}
