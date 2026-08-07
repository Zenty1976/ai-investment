import { useRef } from "react";
import { useGetPortfolio } from "@workspace/api-client-react";
import { useTileSize } from "@/hooks/useTileSize";
import { timeAgo } from "@/lib/widget-utils";
import { WidgetSpinner, WidgetNoData, ScoreBar } from "@/lib/widget-components";

function fmtCcy(n: number, decimals = 0) {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(decimals);
}

function plColor(n: number) {
  return n > 0 ? "text-green-400" : n < 0 ? "text-red-400" : "text-muted-foreground";
}

export function PortfolioManagerWidget() {
  const ref = useRef<HTMLDivElement>(null);
  const size = useTileSize(ref);
  const { data, isLoading } = useGetPortfolio();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const portfolio = data as any;
  const accounts: any[] = portfolio?.accounts ?? [];
  const totalPositions = accounts.flatMap((a: any) => a.positions ?? []);
  const totalPL = accounts.reduce((s: number, a: any) => s + (a.unrealizedProfitLoss ?? 0), 0);
  const totalValue = accounts.reduce((s: number, a: any) => s + (a.accountValue ?? 0), 0);
  const isMock = portfolio?.isMockData === true;
  const updatedAt = portfolio?.updatedAt as string | undefined;

  return (
    <div ref={ref} className="h-full w-full overflow-hidden p-2 flex flex-col gap-1.5">
      {isLoading && <WidgetSpinner />}
      {!isLoading && !portfolio && <WidgetNoData label="Portfolio not connected" />}
      {portfolio && (
        <>
          {size === "xs" && (
            <div className="h-full flex items-center gap-2">
              <span className="text-xs font-medium text-foreground">{totalPositions.length} pos</span>
              <span className={`text-xs font-medium ${plColor(totalPL)}`}>
                {totalPL >= 0 ? "+" : ""}{fmtCcy(totalPL)}
              </span>
              {isMock && <span className="text-[9px] text-yellow-400">SIM</span>}
            </div>
          )}

          {size === "sm" && (
            <div className="h-full flex flex-col justify-between">
              <div className="flex items-baseline gap-1.5">
                <span className="text-sm font-bold text-foreground">{fmtCcy(totalValue)}</span>
                <span className="text-[10px] text-muted-foreground">total</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-[11px] font-medium ${plColor(totalPL)}`}>
                  P/L {totalPL >= 0 ? "+" : ""}{fmtCcy(totalPL)}
                </span>
                <span className="text-[10px] text-muted-foreground">· {totalPositions.length} pos</span>
                {isMock && <span className="text-[9px] text-yellow-400">SIM</span>}
              </div>
              <span className="text-[10px] text-muted-foreground">{timeAgo(updatedAt)}</span>
            </div>
          )}

          {size === "md" && (
            <div className="h-full flex flex-col gap-1.5 overflow-hidden">
              <div className="flex items-center justify-between shrink-0">
                <div className="flex items-baseline gap-1">
                  <span className="text-lg font-bold text-foreground">{fmtCcy(totalValue)}</span>
                  <span className="text-[10px] text-muted-foreground">DKK</span>
                </div>
                <div className="flex items-center gap-1">
                  {isMock && <span className="text-[9px] text-yellow-400 border border-yellow-400/30 px-1 rounded">SIM</span>}
                  <span className={`text-[11px] font-medium ${plColor(totalPL)}`}>
                    {totalPL >= 0 ? "+" : ""}{fmtCcy(totalPL)}
                  </span>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto space-y-0.5 min-h-0">
                {totalPositions.slice(0, 5).map((pos: any) => (
                  <div key={pos.id} className="flex items-center gap-1.5 text-[10px]">
                    <span className="font-medium text-foreground/90 w-14 truncate">{pos.symbol}</span>
                    <div className="flex-1 min-w-0">
                      <ScoreBar
                        score={Math.abs(pos.dayChangePercent ?? 0) * 10}
                        color={pos.dayChangePercent >= 0 ? "bg-green-400/50" : "bg-red-400/50"}
                      />
                    </div>
                    <span className={`${plColor(pos.dayChangePercent)} shrink-0 w-12 text-right`}>
                      {pos.dayChangePercent >= 0 ? "+" : ""}{pos.dayChangePercent?.toFixed(2)}%
                    </span>
                  </div>
                ))}
              </div>
              <span className="text-[10px] text-muted-foreground shrink-0">{timeAgo(updatedAt)}</span>
            </div>
          )}

          {size === "lg" && (
            <div className="h-full flex flex-col gap-2 overflow-hidden">
              <div className="grid grid-cols-3 gap-2 shrink-0">
                <div className="rounded border border-border/50 p-1.5">
                  <p className="text-[10px] text-muted-foreground">Total Value</p>
                  <p className="text-sm font-bold text-foreground">{fmtCcy(totalValue)}</p>
                </div>
                <div className="rounded border border-border/50 p-1.5">
                  <p className="text-[10px] text-muted-foreground">Unrealised P/L</p>
                  <p className={`text-sm font-bold ${plColor(totalPL)}`}>{totalPL >= 0 ? "+" : ""}{fmtCcy(totalPL)}</p>
                </div>
                <div className="rounded border border-border/50 p-1.5">
                  <p className="text-[10px] text-muted-foreground">Positions</p>
                  <p className="text-sm font-bold text-foreground">{totalPositions.length}</p>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto min-h-0">
                <table className="w-full text-[10px]">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="text-left pb-1">Symbol</th>
                      <th className="text-right pb-1">Value</th>
                      <th className="text-right pb-1">Day%</th>
                      <th className="text-right pb-1">P/L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {totalPositions.map((pos: any) => (
                      <tr key={pos.id} className="border-t border-border/30">
                        <td className="py-0.5 text-foreground/90 font-medium">{pos.symbol}</td>
                        <td className="py-0.5 text-right text-foreground/80">{fmtCcy(pos.marketValueBaseCurrency ?? pos.marketValue)}</td>
                        <td className={`py-0.5 text-right ${plColor(pos.dayChangePercent)}`}>{pos.dayChangePercent >= 0 ? "+" : ""}{pos.dayChangePercent?.toFixed(2)}%</td>
                        <td className={`py-0.5 text-right ${plColor(pos.profitLoss)}`}>{pos.profitLoss >= 0 ? "+" : ""}{fmtCcy(pos.profitLoss)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {isMock && <span className="text-[9px] text-yellow-400 border border-yellow-400/30 px-1.5 py-0.5 rounded">SIMULATION</span>}
                <span className="text-[10px] text-muted-foreground ml-auto">{timeAgo(updatedAt)}</span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
