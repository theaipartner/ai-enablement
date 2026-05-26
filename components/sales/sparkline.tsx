// Tiny inline SVG sparkline — no animation, no axes, no tooltip.
// Renders a single smooth line over the provided points, normalized to
// the component's width/height. Used in MetricCard beneath the value.

export type SparklineProps = {
  data: number[]
  width?: number
  height?: number
  stroke?: string
  fill?: string
}

export function Sparkline({
  data,
  width = 88,
  height = 24,
  stroke = 'var(--color-geg-text-3)',
  fill = 'transparent',
}: SparklineProps) {
  if (!data || data.length < 2) return null

  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const stepX = width / (data.length - 1)

  const points = data.map((v, i) => {
    const x = i * stepX
    // Invert Y so larger values draw higher.
    const y = height - ((v - min) / range) * height
    return [x, y] as const
  })

  // Smooth quadratic-bezier path through midpoints — gives a softer
  // curve than straight segments without the cost of cubic splines.
  let d = `M ${points[0][0]} ${points[0][1]}`
  for (let i = 1; i < points.length; i++) {
    const [x, y] = points[i]
    const [px, py] = points[i - 1]
    const mx = (px + x) / 2
    const my = (py + y) / 2
    d += ` Q ${px} ${py} ${mx} ${my}`
  }
  d += ` T ${points[points.length - 1][0]} ${points[points.length - 1][1]}`

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      style={{ display: 'block', overflow: 'visible' }}
    >
      <path d={d} stroke={stroke} strokeWidth={1.25} fill={fill} strokeLinecap="round" strokeLinejoin="round" />
      {/* End-point dot so the eye latches onto "now". */}
      <circle
        cx={points[points.length - 1][0]}
        cy={points[points.length - 1][1]}
        r={1.75}
        fill={stroke}
      />
    </svg>
  )
}
