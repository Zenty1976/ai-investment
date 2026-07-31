import MarketMonitor from "./MarketMonitor"
import EventMonitor from "./EventMonitor"

export default function Dashboard() {
  return (
    <div className="space-y-3">
      <MarketMonitor initialExpanded={false} />
      <EventMonitor initialExpanded={false} />
    </div>
  )
}
