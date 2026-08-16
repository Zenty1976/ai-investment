/**
 * AiChatWidget — Dashboard tile with full inline chat.
 *
 * • No duplicate header (module title is shown by the tile frame)
 * • Shows only the active conversation — no thread list
 * • Persists the last used chatId in localStorage so it survives refresh/restart
 * • New thread → open the full AI Chat page
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { Send, Loader2, ExternalLink } from "lucide-react";
import { customFetch } from "@workspace/api-client-react";
import { Link } from "wouter";

const LAST_CHAT_KEY = "ai-chat:lastChatId";

interface ChatMessage {
  id: string;
  chatId: string;
  role: "user" | "assistant" | "tool";
  text: string;
  createdAt: string;
}

interface ChatConversation {
  id: string;
  title: string;
  lastMessageAt: string | null;
}

export function AiChatWidget() {
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [title, setTitle] = useState<string>("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ── Restore last conversation on mount ───────────────────────────────────
  useEffect(() => {
    const savedId = localStorage.getItem(LAST_CHAT_KEY);
    if (!savedId) {
      setLoading(false);
      return;
    }
    customFetch<{ ok: boolean; conversation: ChatConversation; messages: ChatMessage[] }>(
      `/api/ai-chat/conversations/${savedId}`
    )
      .then((res) => {
        if (res.ok) {
          setActiveChatId(savedId);
          setTitle(res.conversation.title);
          setMessages(res.messages);
        } else {
          // Stale id — clear it
          localStorage.removeItem(LAST_CHAT_KEY);
        }
      })
      .catch(() => {
        localStorage.removeItem(LAST_CHAT_KEY);
      })
      .finally(() => setLoading(false));
  }, []);

  // ── Auto-scroll ───────────────────────────────────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── Auto-resize textarea ──────────────────────────────────────────────────
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 100)}px`;
  }, [input]);

  // ── Send message ──────────────────────────────────────────────────────────
  const sendMessage = useCallback(async () => {
    if (!input.trim() || isSending) return;

    let chatId = activeChatId;

    if (!chatId) {
      const res = await customFetch<{ ok: boolean; conversation: ChatConversation }>(
        "/api/ai-chat/conversations",
        { method: "POST" }
      );
      if (!res.ok) {
        setError("Kunne ikke oprette samtale");
        return;
      }
      chatId = res.conversation.id;
      setActiveChatId(chatId);
      setTitle(res.conversation.title);
      localStorage.setItem(LAST_CHAT_KEY, chatId);
    }

    const text = input.trim();
    setInput("");
    setIsSending(true);
    setError(null);

    // Optimistic user bubble
    const tempId = `temp-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      { id: tempId, chatId, role: "user", text, createdAt: new Date().toISOString() },
    ]);

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
      // Update title from first message if it was just "New Chat"
      if (title === "" || title === "New Chat") {
        const updated = await customFetch<{ ok: boolean; conversation: ChatConversation }>(
          `/api/ai-chat/conversations/${chatId}`
        );
        if (updated.ok) setTitle(updated.conversation.title);
      }
    } else {
      setError(res.error ?? "Fejl ved afsendelse");
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
    }
  }, [input, isSending, activeChatId, title]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    },
    [sendMessage]
  );

  // ── Render ────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <Loader2 size={16} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  // No active conversation yet
  if (!activeChatId && messages.length === 0) {
    return (
      <div className="h-full w-full flex flex-col overflow-hidden">
        {/* Empty state + inline input so user can start typing right away */}
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center px-4">
          <p className="text-xs text-muted-foreground/70">Ingen aktiv samtale.</p>
          <Link
            to="/ai-chat"
            className="flex items-center gap-1 text-xs text-primary/70 hover:text-primary transition-colors"
          >
            <ExternalLink size={11} />
            Åbn AI Chat for at skifte tråd
          </Link>
        </div>
        <div className="shrink-0 border-t border-border/30 px-2 py-2">
          <div className="flex items-end gap-2">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Skriv og tryk Enter for at starte…"
              rows={1}
              disabled={isSending}
              className="flex-1 resize-none rounded-lg border border-border/40 bg-muted/30
                         px-3 py-1.5 text-xs placeholder:text-muted-foreground/40
                         focus:outline-none focus:ring-1 focus:ring-primary/40
                         disabled:opacity-50 overflow-hidden leading-relaxed"
            />
            <button
              onClick={sendMessage}
              disabled={!input.trim() || isSending}
              className="shrink-0 p-1.5 rounded-lg bg-primary/15 hover:bg-primary/25 text-primary
                         disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {isSending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full flex flex-col overflow-hidden">
      {/* Thread title + link to full page */}
      {title && (
        <div className="shrink-0 flex items-center justify-between px-2 pt-1 pb-0.5 gap-2">
          <span className="text-[10px] text-muted-foreground/50 truncate">{title}</span>
          <Link
            to="/ai-chat"
            title="Åbn i fuld skærm / skift tråd"
            className="shrink-0 text-muted-foreground/30 hover:text-primary/60 transition-colors"
          >
            <ExternalLink size={11} />
          </Link>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-2 py-1 space-y-2 min-h-0">
        {messages
          .filter((m) => m.role !== "tool")
          .map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[85%] rounded-xl px-3 py-1.5 text-xs leading-relaxed whitespace-pre-wrap
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
            <div className="bg-muted/50 rounded-xl rounded-bl-sm px-3 py-2 flex items-center gap-1.5">
              <Loader2 size={11} className="animate-spin text-muted-foreground" />
              <span className="text-[10px] text-muted-foreground">Tænker…</span>
            </div>
          </div>
        )}

        {error && (
          <div className="text-[10px] text-red-400 text-center px-2">{error}</div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-border/30 px-2 py-1.5">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Spørg noget… (Enter sender)"
            rows={1}
            disabled={isSending}
            className="flex-1 resize-none rounded-lg border border-border/40 bg-muted/30
                       px-3 py-1.5 text-xs placeholder:text-muted-foreground/40
                       focus:outline-none focus:ring-1 focus:ring-primary/40
                       disabled:opacity-50 overflow-hidden leading-relaxed"
          />
          <button
            onClick={sendMessage}
            disabled={!input.trim() || isSending}
            className="shrink-0 p-1.5 rounded-lg bg-primary/15 hover:bg-primary/25 text-primary
                       disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {isSending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
          </button>
        </div>
      </div>
    </div>
  );
}
