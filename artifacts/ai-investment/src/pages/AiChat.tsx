import { useState, useEffect, useRef, useCallback } from "react";
import { MessageSquare, Plus, Send, Loader2, Trash2 } from "lucide-react";
import { customFetch } from "@workspace/api-client-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ChatConversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  archived: boolean;
}

interface ChatMessage {
  id: string;
  chatId: string;
  role: "user" | "assistant" | "tool";
  text: string;
  createdAt: string;
}

// ── Date grouping ─────────────────────────────────────────────────────────────

function dateGroup(iso: string | null): string {
  if (!iso) return "Older";
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "This week";
  return "Older";
}

function groupConversations(
  convs: ChatConversation[]
): { label: string; items: ChatConversation[] }[] {
  const groups: Record<string, ChatConversation[]> = {};
  const order = ["Today", "Yesterday", "This week", "Older"];
  for (const c of convs) {
    const g = dateGroup(c.lastMessageAt ?? c.createdAt);
    if (!groups[g]) groups[g] = [];
    groups[g].push(c);
  }
  return order.filter((g) => groups[g]).map((g) => ({ label: g, items: groups[g] }));
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function AiChat() {
  const LAST_CHAT_KEY = "ai-chat:lastChatId";

  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingChat, setLoadingChat] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ── Load conversation list ────────────────────────────────────────────────
  const loadConversations = useCallback(async () => {
    const res = await customFetch<{ ok: boolean; conversations: ChatConversation[] }>(
      "/api/ai-chat/conversations"
    );
    if (res.ok) setConversations(res.conversations);
  }, []);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  // ── Restore last active chat from localStorage ────────────────────────────
  useEffect(() => {
    const savedId = localStorage.getItem(LAST_CHAT_KEY);
    if (!savedId) return;
    customFetch<{ ok: boolean; conversation: ChatConversation; messages: ChatMessage[] }>(
      `/api/ai-chat/conversations/${savedId}`
    ).then((res) => {
      if (res.ok) {
        setActiveChatId(savedId);
        setMessages(res.messages);
      } else {
        localStorage.removeItem(LAST_CHAT_KEY);
      }
    }).catch(() => localStorage.removeItem(LAST_CHAT_KEY));
  // Run once on mount only
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Open a conversation ───────────────────────────────────────────────────
  const openChat = useCallback(async (id: string) => {
    setLoadingChat(true);
    setError(null);
    const res = await customFetch<{
      ok: boolean;
      conversation: ChatConversation;
      messages: ChatMessage[];
    }>(`/api/ai-chat/conversations/${id}`);
    setLoadingChat(false);
    if (res.ok) {
      setActiveChatId(id);
      setMessages(res.messages);
      localStorage.setItem(LAST_CHAT_KEY, id);
    }
  }, []);

  // ── New chat ──────────────────────────────────────────────────────────────
  const newChat = useCallback(async () => {
    const res = await customFetch<{ ok: boolean; conversation: ChatConversation }>(
      "/api/ai-chat/conversations",
      { method: "POST" }
    );
    if (res.ok) {
      setConversations((prev) => [res.conversation, ...prev]);
      setActiveChatId(res.conversation.id);
      setMessages([]);
      setError(null);
      localStorage.setItem(LAST_CHAT_KEY, res.conversation.id);
    }
  }, []);

  // ── Archive chat ──────────────────────────────────────────────────────────
  const archiveChat = useCallback(
    async (id: string) => {
      await customFetch(`/api/ai-chat/conversations/${id}`, { method: "DELETE" });
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (activeChatId === id) {
        setActiveChatId(null);
        setMessages([]);
      }
    },
    [activeChatId]
  );

  // ── Send message ──────────────────────────────────────────────────────────
  const sendMessage = useCallback(async () => {
    if (!input.trim() || isSending) return;

    let chatId = activeChatId;

    // Auto-create conversation if none is open
    if (!chatId) {
      const res = await customFetch<{ ok: boolean; conversation: ChatConversation }>(
        "/api/ai-chat/conversations",
        { method: "POST" }
      );
      if (!res.ok) {
        setError("Failed to create conversation");
        return;
      }
      chatId = res.conversation.id;
      setActiveChatId(chatId);
      setConversations((prev) => [res.conversation, ...prev]);
    }

    const text = input.trim();
    setInput("");
    setIsSending(true);
    setError(null);

    // Optimistic user message
    const tempId = `temp-${Date.now()}`;
    const tempUserMsg: ChatMessage = {
      id: tempId,
      chatId,
      role: "user",
      text,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, tempUserMsg]);

    const res = await customFetch<{
      ok: boolean;
      error?: string;
      userMessage: ChatMessage;
      assistantMessage: ChatMessage;
    }>(`/api/ai-chat/conversations/${chatId}/messages`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });

    setIsSending(false);

    if (res.ok) {
      setMessages((prev) => [
        ...prev.filter((m) => m.id !== tempId),
        res.userMessage,
        res.assistantMessage,
      ]);
      loadConversations();
    } else {
      setError(res.error ?? "Failed to send message");
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
    }
  }, [input, isSending, activeChatId, loadConversations]);

  // ── Keyboard handler ──────────────────────────────────────────────────────
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    },
    [sendMessage]
  );

  // ── Auto-scroll ───────────────────────────────────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── Auto-resize textarea ──────────────────────────────────────────────────
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  const grouped = groupConversations(conversations);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="h-[calc(100vh-4rem)] flex overflow-hidden">
      {/* ── Sidebar ────────────────────────────────────────────────────────── */}
      <div className="w-52 shrink-0 border-r border-border/30 flex flex-col bg-background/50">
        <div className="p-3 border-b border-border/30">
          <button
            onClick={newChat}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium
                       bg-primary/10 hover:bg-primary/20 text-primary transition-colors"
          >
            <Plus size={14} />
            New Chat
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-3">
          {grouped.length === 0 && (
            <p className="text-xs text-muted-foreground px-2 mt-3">No conversations yet.</p>
          )}
          {grouped.map(({ label, items }) => (
            <div key={label}>
              <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50 px-2 mb-1">
                {label}
              </p>
              <div className="space-y-0.5">
                {items.map((conv) => (
                  <div
                    key={conv.id}
                    className={`group flex items-center gap-1 px-2 py-1.5 rounded-md cursor-pointer text-xs transition-colors
                      ${activeChatId === conv.id
                        ? "bg-primary/15 text-foreground"
                        : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"}`}
                    onClick={() => openChat(conv.id)}
                  >
                    <MessageSquare size={11} className="shrink-0 opacity-50" />
                    <span className="flex-1 truncate">{conv.title}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        archiveChat(conv.id);
                      }}
                      className="opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity"
                    >
                      <Trash2 size={10} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Main chat area ──────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="shrink-0 px-6 py-3 border-b border-border/30 flex items-center gap-2">
          <MessageSquare size={16} className="text-primary" />
          <h1 className="text-sm font-semibold tracking-wide">AI CHAT</h1>
          {activeChatId && (
            <span className="ml-2 text-xs text-muted-foreground truncate">
              {conversations.find((c) => c.id === activeChatId)?.title ?? ""}
            </span>
          )}
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {!activeChatId && !loadingChat && (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
              <MessageSquare size={36} className="text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">
                Start a new chat or select a previous one.
              </p>
              <p className="text-xs text-muted-foreground/60 max-w-sm">
                Ask about your portfolio, trade decisions, catalyst setups, or any market
                question. The AI can look up current system data on demand.
              </p>
              <button
                onClick={newChat}
                className="mt-2 px-4 py-2 rounded-md text-sm bg-primary/10 hover:bg-primary/20 text-primary transition-colors"
              >
                New Chat
              </button>
            </div>
          )}

          {loadingChat && (
            <div className="flex justify-center pt-12">
              <Loader2 size={20} className="animate-spin text-muted-foreground" />
            </div>
          )}

          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[75%] rounded-xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap
                  ${msg.role === "user"
                    ? "bg-primary/15 text-foreground rounded-br-sm"
                    : "bg-muted/50 text-foreground rounded-bl-sm"}`}
              >
                {msg.text}
              </div>
            </div>
          ))}

          {isSending && (
            <div className="flex justify-start">
              <div className="bg-muted/50 rounded-xl rounded-bl-sm px-4 py-3 flex items-center gap-2">
                <Loader2 size={14} className="animate-spin text-muted-foreground" />
                <span className="text-xs text-muted-foreground">Thinking…</span>
              </div>
            </div>
          )}

          {error && (
            <div className="flex justify-center">
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-2 text-xs text-red-400 max-w-lg">
                {error}
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="shrink-0 border-t border-border/30 px-6 py-3">
          <div className="flex items-end gap-3">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Ask something… (Enter to send, Shift+Enter for new line)"
              rows={1}
              disabled={isSending}
              className="flex-1 resize-none rounded-xl border border-border/50 bg-muted/30
                         px-4 py-2.5 text-sm placeholder:text-muted-foreground/50
                         focus:outline-none focus:ring-1 focus:ring-primary/50
                         disabled:opacity-50 overflow-hidden leading-relaxed"
            />
            <button
              onClick={sendMessage}
              disabled={!input.trim() || isSending}
              className="shrink-0 p-2.5 rounded-xl bg-primary/15 hover:bg-primary/25 text-primary
                         disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {isSending ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Send size={16} />
              )}
            </button>
          </div>
          <p className="mt-1.5 text-[10px] text-muted-foreground/40">
            Reads current system data on demand. Cannot execute trades or modify the system.
          </p>
        </div>
      </div>
    </div>
  );
}
