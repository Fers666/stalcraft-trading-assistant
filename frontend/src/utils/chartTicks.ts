// Тики лог-шкалы цены: мантиссы 1-2-5 по декадам, прореживание до <=6
// (портировано из design/v5/assets/charts.js:31-44).

export function logTicks(lo: number, hi: number): number[] {
  let t: number[] = []
  const d0 = Math.floor(Math.log10(lo))
  const d1 = Math.ceil(Math.log10(hi))
  const mults = d1 - d0 >= 3 ? [1] : [1, 2, 5]
  for (let d = d0; d <= d1; d++) {
    mults.forEach((m) => {
      const v = m * Math.pow(10, d)
      if (v >= lo * 0.999 && v <= hi * 1.001) t.push(v)
    })
  }
  while (t.length > 6) {
    t = t.filter((_, i) => i % 2 === 0 || i === t.length - 1)
  }
  return t
}
