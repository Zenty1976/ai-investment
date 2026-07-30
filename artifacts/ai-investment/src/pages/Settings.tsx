import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"

export default function Settings() {
  return (
    <div className="max-w-2xl mx-auto space-y-6 animate-in fade-in duration-500">
      <Card>
        <CardHeader>
          <CardTitle>Preferences</CardTitle>
          <CardDescription>
            Manage your AI Investment monitor settings.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <h4 className="text-sm font-medium">Data Sources</h4>
            <p className="text-sm text-muted-foreground">
              Configure which financial APIs the AI model uses for context. (Coming soon)
            </p>
          </div>
          <div className="space-y-1">
            <h4 className="text-sm font-medium">Alert Thresholds</h4>
            <p className="text-sm text-muted-foreground">
              Set custom risk levels to trigger email notifications. (Coming soon)
            </p>
          </div>
          <div className="pt-4">
            <Button disabled>Save Preferences</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
