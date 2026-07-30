import { Link, useLocation } from "wouter"
import { Activity, LayoutDashboard, Settings, Menu, X } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"

interface AppShellProps {
  children: React.ReactNode
}

export function AppShell({ children }: AppShellProps) {
  const [location] = useLocation()
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const navItems = [
    { label: "Dashboard", href: "/", icon: LayoutDashboard },
    { label: "Market Monitor", href: "/", icon: Activity },
    { label: "Settings", href: "/settings", icon: Settings },
  ]

  return (
    <div className="flex min-h-[100dvh] w-full bg-background text-foreground">
      {/* Mobile Sidebar Overlay */}
      {sidebarOpen && (
        <div 
          className="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 transform border-r border-border bg-sidebar transition-transform duration-300 ease-in-out md:static md:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-16 items-center px-6 border-b border-border">
          <Activity className="h-6 w-6 text-primary mr-2" />
          <span className="text-lg font-bold tracking-tight">AI Investment</span>
          <Button 
            variant="ghost" 
            size="icon" 
            className="ml-auto md:hidden"
            onClick={() => setSidebarOpen(false)}
          >
            <X className="h-5 w-5" />
          </Button>
        </div>
        
        <nav className="space-y-1 p-4">
          {navItems.map((item, i) => {
            const isActive = location === item.href && (i !== 0 || location === "/")
            // Quick hack for the dual "/" links to not both look active, 
            // though they actually have the same href. We'll make them both active if on "/" for simplicity,
            // or just rely on exact match.
            const isReallyActive = location === item.href;

            return (
              <Link 
                key={i} 
                href={item.href} 
                onClick={() => setSidebarOpen(false)}
                className={`flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors ${
                  isReallyActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-accent/50"
                }`}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            )
          })}
        </nav>
      </aside>

      {/* Main Content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Header */}
        <header className="flex h-16 shrink-0 items-center gap-4 border-b border-border bg-background px-4 md:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu className="h-5 w-5" />
          </Button>
          
          <div className="flex flex-1 items-center justify-between">
            <h1 className="text-lg font-semibold">
              {location === "/" ? "Market Monitor" : location === "/settings" ? "Settings" : "App"}
            </h1>
            <div id="header-extra" />
          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  )
}
