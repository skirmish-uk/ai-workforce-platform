export interface MetricPoint {
  timestamp: Date
  value: number
  labels: Record<string, string>
}

export interface MetricSeries {
  name: string
  type: 'counter' | 'gauge' | 'histogram' | 'summary'
  help: string
  points: MetricPoint[]
}

export interface MetricsSnapshot {
  timestamp: Date
  metrics: MetricSeries[]
}

export interface SystemMetrics {
  cpuUsagePercent: number
  memoryUsagePercent: number
  diskUsagePercent: number
  networkInBytesPerSec: number
  networkOutBytesPerSec: number
}

export interface ApplicationMetrics {
  requestsPerSecond: number
  errorRate: number
  avgLatencyMs: number
  p50LatencyMs: number
  p95LatencyMs: number
  p99LatencyMs: number
  activeConnections: number
}

export interface BusinessMetrics {
  activeTenants: number
  activeAgents: number
  workflowsPerHour: number
  tasksCompleted: number
  tasksFailed: number
  avgTaskDurationMs: number
  integrationCalls: number
  integrationErrors: number
}

export interface TenantMetrics {
  tenantId: string
  activeAgents: number
  workflowsRun: number
  workflowsFailed: number
  tasksCompleted: number
  avgLatencyMs: number
  integrationCalls: number
  storageUsedBytes: number
}

export function formatMetricsForPrometheus(metrics: MetricSeries[]): string {
  const lines: string[] = []

  for (const metric of metrics) {
    lines.push(`# HELP ${metric.name} ${metric.help}`)
    lines.push(`# TYPE ${metric.name} ${metric.type}`)

    for (const point of metric.points) {
      const labels = Object.entries(point.labels)
        .map(([k, v]) => `${k}="${v}"`)
        .join(',')
      const labelStr = labels ? `{${labels}}` : ''
      lines.push(`${metric.name}${labelStr} ${point.value} ${point.timestamp.getTime()}`)
    }
  }

  return lines.join('\n') + '\n'
}

export function aggregateMetrics(points: MetricPoint[], intervalMs: number): MetricPoint[] {
  if (points.length === 0) return []

  const sorted = [...points].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
  const buckets = new Map<number, MetricPoint[]>()

  for (const point of sorted) {
    const bucketKey = Math.floor(point.timestamp.getTime() / intervalMs) * intervalMs
    if (!buckets.has(bucketKey)) buckets.set(bucketKey, [])
    buckets.get(bucketKey)!.push(point)
  }

  const aggregated: MetricPoint[] = []
  for (const [bucketKey, bucketPoints] of buckets) {
    const values = bucketPoints.map(p => p.value)
    const sum = values.reduce((a, b) => a + b, 0)
    const avg = sum / values.length
    const min = Math.min(...values)
    const max = Math.max(...values)

    aggregated.push({
      timestamp: new Date(bucketKey),
      value: avg,
      labels: { ...bucketPoints[0].labels, aggregation: 'avg' },
    })
    aggregated.push({
      timestamp: new Date(bucketKey),
      value: min,
      labels: { ...bucketPoints[0].labels, aggregation: 'min' },
    })
    aggregated.push({
      timestamp: new Date(bucketKey),
      value: max,
      labels: { ...bucketPoints[0].labels, aggregation: 'max' },
    })
  }

  return aggregated.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
}

export function calculatePercentile(values: number[], percentile: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.ceil(percentile / 100 * sorted.length) - 1
  return sorted[Math.max(0, index)]
}

export function calculateRate(points: MetricPoint[], windowMs: number): number {
  const now = Date.now()
  const windowStart = now - windowMs
  const recentPoints = points.filter(p => p.timestamp.getTime() >= windowStart)

  if (recentPoints.length < 2) return 0

  const timeSpan = recentPoints[recentPoints.length - 1].timestamp.getTime() - recentPoints[0].timestamp.getTime()
  if (timeSpan === 0) return 0

  return (recentPoints.length / timeSpan) * 1000 // per second
}