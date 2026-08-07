import { Link, useLocation } from "wouter"
import {
  LayoutGrid,
  Briefcase,
  TrendingUp,
  Activity,
  Newspaper,
  CalendarDays,
  PieChart,
  Building2,
  ShieldAlert,
  BarChart2,
  Lightbulb,
  Bell,
  GitMerge,
  ClipboardList,
  Cpu,
  History,
  Settings,
  Users,
} from "lucide-react"
import { useState, useEffect } from "react"
import { format } from "date-fns"

interface AppShellProps {
  children: React.ReactNode
}

// Market tickers shown in header — static display, live data comes in a future iteration
const TICKERS = [
  { label: "OMXC25", value: null },
  { label: "S&P 500", value: null },
  { label: "NASDAQ 100", value: null },
  { label: "VIX", value: null },
]

// All sidebar nav items.
// enabled=true → clickable and navigates; enabled=false → greyed-out stub for future modules
const NAV_ITEMS = [
  { label: "OVERVIEW",    href: "/",          icon: LayoutGrid,   enabled: true  },
  { label: "PORTFOLIO",   href: "/portfolio", icon: Briefcase,    enabled: true  },
  { label: "STOCKS",      href: "/stocks",    icon: TrendingUp,   enabled: false },
  { label: "MARKET",      href: "/market",    icon: Activity,     enabled: true  },
  { label: "NEWS",        href: "/news",      icon: Newspaper,    enabled: true  },
  { label: "EVENTS",      href: "/events",    icon: CalendarDays, enabled: true  },
  { label: "SECTORS",     href: "/sectors",   icon: PieChart,     enabled: true  },
  { label: "COMPANIES",  href: "/companies", icon: Building2,    enabled: true  },
  { label: "INVESTORS",  href: "/investors", icon: Users,         enabled: true  },
  { label: "RISK",        href: "/risk",      icon: ShieldAlert,  enabled: true  },
  { label: "ANALYZER",    href: "/analyse",      icon: BarChart2,  enabled: true  },
  { label: "OPPORTUNITY", href: "/opportunities", icon: Lightbulb,  enabled: true  },
  { label: "ALERTS",      href: "/alerts",        icon: Bell,       enabled: true  },
  { label: "DECISIONS",   href: "/decisions",     icon: GitMerge,      enabled: true  },
  { label: "REVIEW",      href: "/trade-review",  icon: ClipboardList, enabled: true  },
  { label: "AUTOMATE",   href: "/automation",    icon: Cpu,           enabled: true  },
  { label: "LOG & HIST.", href: "/log",           icon: History,    enabled: true  },
  { label: "SETTINGS",    href: "/settings",  icon: Settings,     enabled: true  },
]

function LiveClock() {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  return (
    <div className="text-right leading-tight">
      <div className="text-xl font-mono font-bold tabular-nums tracking-tight text-foreground">
        {format(now, "HH:mm:ss")}
      </div>
      <div className="text-[11px] text-muted-foreground">
        {format(now, "d. MMM yyyy")}
      </div>
    </div>
  )
}

export function AppShell({ children }: AppShellProps) {
  const [location] = useLocation()

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
      {/* ── Narrow icon sidebar ── */}
      <aside className="flex flex-col w-16 shrink-0 bg-sidebar border-r border-sidebar-border z-30">
        {/* Logo */}
        <div className="flex items-center justify-center h-14 border-b border-sidebar-border">
          <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary/15 ring-1 ring-primary/30">
            <Activity className="h-5 w-5 text-primary" />
          </div>
        </div>

        {/* Nav items */}
        <nav className="flex flex-col flex-1 py-2 gap-0.5 overflow-y-auto">
          {NAV_ITEMS.map((item, i) => {
            const isActive = item.enabled && location === item.href
            const Icon = item.icon

            if (!item.enabled) {
              return (
                <div
                  key={i}
                  className="flex flex-col items-center gap-1 py-2.5 px-1 mx-1 rounded-md opacity-25 cursor-not-allowed select-none"
                  title={item.label}
                >
                  <Icon className="h-4 w-4 text-sidebar-foreground" />
                  <span className="text-[8px] font-medium tracking-wider text-sidebar-foreground leading-none text-center">
                    {item.label}
                  </span>
                </div>
              )
            }

            return (
              <Link
                key={i}
                href={item.href}
                className={`flex flex-col items-center gap-1 py-2.5 px-1 mx-1 rounded-md transition-all ${
                  isActive
                    ? "bg-primary/15 ring-1 ring-primary/20 text-primary"
                    : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
                }`}
                title={item.label}
              >
                <Icon className={`h-4 w-4 ${isActive ? "text-primary" : ""}`} />
                <span className={`text-[8px] font-medium tracking-wider leading-none text-center ${isActive ? "text-primary" : ""}`}>
                  {item.label}
                </span>
              </Link>
            )
          })}
        </nav>
      </aside>

      {/* ── Main column (header + content) ── */}
      <div className="flex flex-col flex-1 overflow-hidden">

        {/* ── Top header ── */}
        <header className="shrink-0 border-b border-border bg-background/95 backdrop-blur-sm">

          {/* Primary header row */}
          <div className="flex items-center gap-4 px-4 h-14">
            {/* App title */}
            <div className="flex-1 min-w-0 leading-tight">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold tracking-widest uppercase text-foreground">
                  AI INVESTOR COMMAND CENTER
                </span>
              </div>
              <div className="text-[10px] text-muted-foreground tracking-wide mt-0.5">
                Real-time investment intelligence
              </div>
            </div>

            {/* Ticker strip */}
            <div className="hidden lg:flex items-center gap-3 border-l border-border pl-4">
              {TICKERS.map((t) => (
                <div key={t.label} className="flex flex-col items-center leading-tight">
                  <span className="text-[10px] font-bold text-muted-foreground tracking-widest">{t.label}</span>
                  <span className="text-xs font-mono text-foreground/40 tracking-tight">
                    {t.value ?? "—"}
                  </span>
                </div>
              ))}
            </div>

            {/* Clock */}
            <div className="border-l border-border pl-4">
              <LiveClock />
            </div>
          </div>
        </header>

        {/* ── Page content ── */}
        <main className="flex-1 overflow-y-auto p-4 md:p-5">
          {children}
        </main>
      </div>
    </div>
  )
}
