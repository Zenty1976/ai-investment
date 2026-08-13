import { DashboardGrid } from "@/components/dashboard/DashboardGrid";
import { PortfolioReturnBar } from "@/components/PortfolioReturnBar";

export default function Dashboard() {
  return (
    <div className="flex flex-col gap-0">
      <PortfolioReturnBar />
      <DashboardGrid />
    </div>
  );
}
