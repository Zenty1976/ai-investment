import { useRef, useState, useEffect } from "react";
import { useTileSize } from "@/hooks/useTileSize";
import { MessageSquare } from "lucide-react";
import { WidgetSpinner } from "@/lib/widget-components";
import { customFetch } from "@workspace/api-client-react";

interface ChatConversation {
  id: string;
  title: string;
  lastMessageAt: string | null;
  createdAt: string;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function AiChatWidget() {
  const ref = useRef<HTMLDivElement>(null);
  const size = useTileSize(ref);
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    customFetch<{ ok: boolean; conversations: ChatConversation[] }>("/api/ai-chat/conversations")
      .then((data) => {
        if (!cancelled && data.ok) setConversations(data.conversations.slice(0, 6));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div ref={ref} className="h-full w-full overflow-hidden p-2 flex flex-col gap-1.5">
      {loading && <WidgetSpinner />}

      {!loading && size === "xs" && (
        <div className="h-full flex items-center gap-1.5">
          <MessageSquare size={12} className="text-primary shrink-0" />
          <span className="text-xs font-semibold truncate text-foreground">AI Chat</span>
        </div>
      )}

      {!loading && size === "sm" && (
        <div className="h-full flex flex-col justify-between">
          <div className="flex items-center gap-1.5">
            <MessageSquare size={12} className="text-primary shrink-0" />
            <span className="text-sm font-semibold text-foreground">AI Chat</span>
          </div>
          <span className="text-xs text-muted-foreground">
            {conversations.length === 0
              ? "No conversations yet"
              : `${conversations.length} conversation${conversations.length === 1 ? "" : "s"}`}
          </span>
        </div>
      )}

      {!loading && (size === "md" || size === "lg") && (
        <div className="h-full flex flex-col gap-1.5 overflow-hidden">
          <div className="shrink-0 flex items-center gap-1.5">
            <MessageSquare size={12} className="text-primary" />
            <span className="text-xs font-bold uppercase tracking-wide text-foreground">
              AI Chat
            </span>
          </div>

          {conversations.length === 0 ? (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-xs text-muted-foreground/60 text-center">
                No conversations yet.
                <br />
                Open AI Chat to start.
              </p>
            </div>
          ) : (
            <div className="flex-1 overflow-hidden space-y-0.5 min-h-0">
              {conversations.map((conv) => (
                <div
                  key={conv.id}
                  className="flex items-center justify-between gap-2 py-0.5"
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <MessageSquare size={9} className="text-muted-foreground/40 shrink-0" />
                    <span className="text-xs text-foreground/70 truncate">{conv.title}</span>
                  </div>
                  <span className="text-[10px] text-muted-foreground/40 shrink-0">
                    {relativeTime(conv.lastMessageAt ?? conv.createdAt)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
