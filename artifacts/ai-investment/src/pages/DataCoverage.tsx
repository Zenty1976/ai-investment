/**
 * Data Coverage Page — Provider health and data gap reporting (spec §25).
 *
 * Shows system/debug information about the current state of data coverage
 * across all domains: universe, calendar, consensus, earnings history, price.
 *
 * NOT part of the normal investment dashboard — system/debug view only.
 */

import { useState, useEffect } from 'react'
import { Database, RefreshCw, AlertTriangle, CheckCircle, XCircle, Info, ChevronDown, ChevronRight } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

// ── Types ─────────────────────────────────────────────────────────────────────

type AvailabilityStatus = 'AVAILABLE' | 'PARTIAL' | 'UNAVAILABLE'

interface UniverseRegion {
  provider: string
  equityCount: number
  lastRefresh: string
  status: 'FULL' | 'SEED_ONLY'
  coverageWarning: string | null
}

interface DataCoverageReport {
  generatedAt: string
  marketUniverse: {
    dk: UniverseRegion
    us: UniverseRegion
    providerName: string
    providerCanEnumerate: boolean
    limitation: string
  }
  earningsCalendar: {
    providerName: string
    status: AvailabilityStatus
    supportsBulkCalendar: boolean
    coveredTickers: number
    limitation: string
  }
  expectations: {
    providerName: string
    epsConsensus: AvailabilityStatus
    revenueConsensus: AvailabilityStatus
    estimateRevisions: AvailabilityStatus
    historicalSnapshots: AvailabilityStatus
    guidance: AvailabilityStatus
    consensusSnapshotCount: number
    consensusCoveredTickers: number
    limitation: string
  }
  earningsHistory: {
    providerName: string
    status: AvailabilityStatus
    supportsActuals: boolean
    supportsEstimates: boolean
    limitation: string
  }
  priceData: {
    providerName: string
    status: AvailabilityStatus
    historyDepthDays: number
    detail: string
  }
  domains: Array<{
    domain: string
    providerName: string
    status: AvailabilityStatus
    detail: string
    lastRefreshedAt: string | null
  }>
  externalDataGaps: Array<{
    domain: string
    priority: 'REQUIRED' | 'NICE_TO_HAVE' | 'NOT_NEEDED'
    description: string
    whyItMatters: string
    targetAbstraction: string
    requirements: string
  }>
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: AvailabilityStatus | 'FULL' | 'SEED_ONLY' }) {
  if (status === 'AVAILABLE' || status === 'FULL') {
    return (
      <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 font-mono text-xs gap-1">
        <CheckCircle className="w-3 h-3" /> AVAILABLE
      </Badge>
    )
  }
  if (status === 'PARTIAL' || status === 'SEED_ONLY') {
    return (
      <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/30 font-mono text-xs gap-1">
        <AlertTriangle className="w-3 h-3" /> {status === 'SEED_ONLY' ? 'SEED ONLY' : 'PARTIAL'}
      </Badge>
    )
  }
  return (
    <Badge className="bg-red-500/15 text-red-400 border-red-500/30 font-mono text-xs gap-1">
      <XCircle className="w-3 h-3" /> UNAVAILABLE
    </Badge>
  )
}

function PriorityBadge({ priority }: { priority: string }) {
  if (priority === 'REQUIRED') {
    return <Badge className="bg-red-500/15 text-red-400 border-red-500/30 font-mono text-xs">REQUIRED</Badge>
  }
  if (priority === 'NICE_TO_HAVE') {
    return <Badge className="bg-blue-500/15 text-blue-400 border-blue-500/30 font-mono text-xs">NICE TO HAVE</Badge>
  }
  return <Badge className="bg-zinc-500/15 text-zinc-400 border-zinc-500/30 font-mono text-xs">NOT NEEDED</Badge>
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="bg-zinc-900 border-zinc-800">
      <CardHeader className="pb-2 border-b border-zinc-800">
        <CardTitle className="font-mono text-xs tracking-widest text-zinc-400 uppercase">{title}</CardTitle>
      </CardHeader>
      <CardContent className="pt-4 space-y-3">{children}</CardContent>
    </Card>
  )
}

function MetaRow({ label, value, className = '' }: { label: string; value: React.ReactNode; className?: string }) {
  return (
    <div className={`flex items-start justify-between gap-4 py-1 border-b border-zinc-800/50 last:border-0 ${className}`}>
      <span className="font-mono text-xs text-zinc-500 shrink-0 pt-0.5">{label}</span>
      <span className="font-mono text-xs text-zinc-200 text-right">{value}</span>
    </div>
  )
}

function UniverseRegionBlock({ label, region }: { label: string; region: UniverseRegion }) {
  return (
    <div className="rounded border border-zinc-800 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs font-semibold text-zinc-300">{label}</span>
        <StatusBadge status={region.status} />
      </div>
      <MetaRow label="Provider" value={region.provider} />
      <MetaRow label="Equities" value={region.equityCount.toLocaleString()} />
      <MetaRow label="Last refresh" value={region.lastRefresh} />
      {region.coverageWarning && (
        <div className="flex gap-2 mt-2 p-2 rounded bg-amber-500/10 border border-amber-500/20">
          <AlertTriangle className="w-3 h-3 text-amber-400 mt-0.5 shrink-0" />
          <p className="font-mono text-xs text-amber-300">{region.coverageWarning}</p>
        </div>
      )}
    </div>
  )
}

function DataGapRow({ gap }: { gap: DataCoverageReport['externalDataGaps'][0] }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded border border-zinc-800 overflow-hidden">
      <button
        className="w-full flex items-center gap-3 p-3 hover:bg-zinc-800/50 transition-colors text-left"
        onClick={() => setOpen(o => !o)}
      >
        <PriorityBadge priority={gap.priority} />
        <span className="font-mono text-xs text-zinc-200 flex-1">{gap.domain}</span>
        {open ? <ChevronDown className="w-3 h-3 text-zinc-500 shrink-0" /> : <ChevronRight className="w-3 h-3 text-zinc-500 shrink-0" />}
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2 border-t border-zinc-800 pt-3">
          <p className="font-mono text-xs text-zinc-400">{gap.description}</p>
          <div className="space-y-1.5">
            <p className="font-mono text-[10px] text-zinc-500 uppercase tracking-wider">Why it matters</p>
            <p className="font-mono text-xs text-zinc-300">{gap.whyItMatters}</p>
          </div>
          <div className="space-y-1.5">
            <p className="font-mono text-[10px] text-zinc-500 uppercase tracking-wider">Target abstraction</p>
            <p className="font-mono text-xs text-blue-400">{gap.targetAbstraction}</p>
          </div>
          <div className="space-y-1.5">
            <p className="font-mono text-[10px] text-zinc-500 uppercase tracking-wider">Provider requirements</p>
            <p className="font-mono text-xs text-zinc-300">{gap.requirements}</p>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function DataCoverage() {
  const [report, setReport] = useState<DataCoverageReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const BASE = import.meta.env.BASE_URL.replace(/\/$/, '')

  async function fetchReport() {
    try {
      setRefreshing(true)
      const res = await fetch(`${BASE}/api/data-coverage`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setReport(data)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => { fetchReport() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48">
        <RefreshCw className="w-5 h-5 animate-spin text-zinc-500" />
      </div>
    )
  }

  if (error || !report) {
    return (
      <div className="p-6 rounded border border-red-500/30 bg-red-500/10">
        <p className="font-mono text-sm text-red-400">Failed to load coverage report: {error}</p>
      </div>
    )
  }

  const requiredGaps = report.externalDataGaps.filter(g => g.priority === 'REQUIRED')
  const niceGaps = report.externalDataGaps.filter(g => g.priority === 'NICE_TO_HAVE')

  return (
    <div className="p-4 space-y-4 max-w-4xl mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Database className="w-4 h-4 text-zinc-400" />
          <h1 className="font-mono text-sm font-semibold tracking-wider text-zinc-200 uppercase">
            Data Coverage
          </h1>
          <Badge className="bg-zinc-800 text-zinc-500 border-zinc-700 font-mono text-[10px]">
            SYSTEM / DEBUG
          </Badge>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] text-zinc-600">
            {new Date(report.generatedAt).toLocaleTimeString()}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs font-mono border-zinc-700 text-zinc-400 hover:text-zinc-200"
            onClick={fetchReport}
            disabled={refreshing}
          >
            <RefreshCw className={`w-3 h-3 mr-1 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Can we answer the key question? */}
      <div className="rounded border border-amber-500/30 bg-amber-500/8 p-3">
        <div className="flex gap-2">
          <Info className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
          <div className="space-y-1">
            <p className="font-mono text-xs font-semibold text-amber-300">
              Can this application discover and evaluate pre-event opportunities across DK and US equities?
            </p>
            <p className="font-mono text-xs text-amber-400/80">
              <strong>Partially.</strong> Price data and portfolio intelligence are functional (Saxo). 
              The market universe is seed-only ({(report.marketUniverse.dk.equityCount + report.marketUniverse.us.equityCount).toLocaleString()} tickers).
              Analyst consensus, estimate revisions, and earnings history are <strong>UNAVAILABLE</strong> — 
              ExpectationGap is always UNKNOWN. An external data provider is required for full capability.
            </p>
          </div>
        </div>
      </div>

      {/* Market Universe */}
      <SectionCard title="Market Universe">
        <div className="grid grid-cols-2 gap-3">
          <UniverseRegionBlock label="🇩🇰 Denmark (CSE/OMX)" region={report.marketUniverse.dk} />
          <UniverseRegionBlock label="🇺🇸 United States (NYSE/NASDAQ)" region={report.marketUniverse.us} />
        </div>
        <MetaRow label="Active provider" value={report.marketUniverse.providerName} />
        <MetaRow label="Can enumerate exchange" value={report.marketUniverse.providerCanEnumerate ? '✓ Yes' : '✗ No'} />
        <div className="text-xs font-mono text-zinc-500 pt-1 leading-relaxed">{report.marketUniverse.limitation}</div>
      </SectionCard>

      {/* Domain overview grid */}
      <SectionCard title="Domain Coverage Summary">
        <div className="space-y-2">
          {report.domains.map(d => (
            <div key={d.domain} className="flex items-start gap-3 py-2 border-b border-zinc-800/50 last:border-0">
              <StatusBadge status={d.status} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs text-zinc-200">{d.domain}</span>
                  <span className="font-mono text-[10px] text-zinc-600 shrink-0">{d.providerName}</span>
                </div>
                <p className="font-mono text-[11px] text-zinc-500 mt-0.5 leading-relaxed">{d.detail}</p>
              </div>
            </div>
          ))}
        </div>
      </SectionCard>

      {/* Expectations detail */}
      <SectionCard title="Expectations / Consensus">
        <MetaRow label="Provider" value={report.expectations.providerName} />
        <MetaRow label="EPS Consensus" value={<StatusBadge status={report.expectations.epsConsensus} />} />
        <MetaRow label="Revenue Consensus" value={<StatusBadge status={report.expectations.revenueConsensus} />} />
        <MetaRow label="Estimate Revisions" value={<StatusBadge status={report.expectations.estimateRevisions} />} />
        <MetaRow label="Historical Snapshots" value={<StatusBadge status={report.expectations.historicalSnapshots} />} />
        <MetaRow label="Company Guidance" value={<StatusBadge status={report.expectations.guidance} />} />
        <MetaRow label="Consensus snapshots stored" value={report.expectations.consensusSnapshotCount} />
        <MetaRow label="Tickers with consensus history" value={report.expectations.consensusCoveredTickers} />
        <div className="font-mono text-xs text-zinc-500 pt-1 leading-relaxed">{report.expectations.limitation}</div>
      </SectionCard>

      {/* Earnings Calendar */}
      <SectionCard title="Earnings Calendar">
        <MetaRow label="Provider" value={report.earningsCalendar.providerName} />
        <MetaRow label="Status" value={<StatusBadge status={report.earningsCalendar.status} />} />
        <MetaRow label="Bulk calendar" value={report.earningsCalendar.supportsBulkCalendar ? '✓ Supported' : '✗ Not supported — per-ticker AI web search only'} />
        <MetaRow label="Tickers with cached dates" value={report.earningsCalendar.coveredTickers} />
        <div className="font-mono text-xs text-zinc-500 pt-1 leading-relaxed">{report.earningsCalendar.limitation}</div>
      </SectionCard>

      {/* Earnings History */}
      <SectionCard title="Earnings History">
        <MetaRow label="Provider" value={report.earningsHistory.providerName} />
        <MetaRow label="Status" value={<StatusBadge status={report.earningsHistory.status} />} />
        <MetaRow label="EPS Actuals" value={report.earningsHistory.supportsActuals ? '✓ Available' : '✗ Unavailable'} />
        <MetaRow label="EPS Estimates" value={report.earningsHistory.supportsEstimates ? '✓ Available' : '✗ Unavailable'} />
        <div className="font-mono text-xs text-zinc-500 pt-1 leading-relaxed">{report.earningsHistory.limitation}</div>
      </SectionCard>

      {/* Price Data */}
      <SectionCard title="Price Data">
        <MetaRow label="Provider" value={report.priceData.providerName} />
        <MetaRow label="Status" value={<StatusBadge status={report.priceData.status} />} />
        <MetaRow label="History depth" value={`~${report.priceData.historyDepthDays} daily bars`} />
        <div className="font-mono text-xs text-zinc-500 pt-1 leading-relaxed">{report.priceData.detail}</div>
      </SectionCard>

      {/* External data gaps */}
      <SectionCard title={`External Data Gaps — ${requiredGaps.length} Required`}>
        <div className="space-y-2">
          {requiredGaps.length > 0 && (
            <>
              <p className="font-mono text-[10px] text-red-400 uppercase tracking-wider">Required — blocks full intelligence capability</p>
              {requiredGaps.map(g => <DataGapRow key={g.domain} gap={g} />)}
            </>
          )}
          {niceGaps.length > 0 && (
            <>
              <p className="font-mono text-[10px] text-blue-400 uppercase tracking-wider mt-4">Nice to have</p>
              {niceGaps.map(g => <DataGapRow key={g.domain} gap={g} />)}
            </>
          )}
        </div>
      </SectionCard>

    </div>
  )
}
