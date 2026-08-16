/**
 * Chat Repository
 *
 * Isolated persistence layer for AI Chat conversations and messages.
 * Completely separate from analysisRepository — no shared state.
 *
 * Persists to data/chat-repository.json.
 * In-memory Map is the source of truth at runtime; file provides durability.
 */

import { existsSync, mkdirSync, readFileSync } from "fs";
import { writeFile } from "fs/promises";
import { resolve } from "path";

const DATA_DIR = resolve(process.cwd(), "data");
const DATA_FILE = resolve(DATA_DIR, "chat-repository.json");

// ── Entity types ──────────────────────────────────────────────────────────────

export interface ChatConversation {
  id: string;                    // local UUID
  openAiLastResponseId: string | null; // last Responses API response.id — used as previous_response_id
  title: string;
  createdAt: string;             // ISO
  updatedAt: string;             // ISO
  lastMessageAt: string | null;  // ISO
  archived: boolean;
}

export interface ChatMessage {
  id: string;           // local UUID
  chatId: string;
  role: "user" | "assistant" | "tool";
  text: string;
  createdAt: string;    // ISO
  openAiItemId?: string | null;
}

// ── Persisted shape ───────────────────────────────────────────────────────────

interface PersistedStore {
  conversations: ChatConversation[];
  messages: ChatMessage[];
}

// ── Simple UUID ───────────────────────────────────────────────────────────────

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Repository class ──────────────────────────────────────────────────────────

class ChatRepository {
  private conversations: Map<string, ChatConversation> = new Map();
  private messages: Map<string, ChatMessage> = new Map(); // key = message id

  constructor() {
    this._load();
  }

  private _load(): void {
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!existsSync(DATA_FILE)) return;
    try {
      const raw = readFileSync(DATA_FILE, "utf-8");
      const store = JSON.parse(raw) as PersistedStore;
      for (const c of store.conversations ?? []) {
        this.conversations.set(c.id, c);
      }
      for (const m of store.messages ?? []) {
        this.messages.set(m.id, m);
      }
    } catch {
      // Corrupt file — start fresh
    }
  }

  private _persist = (() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    return () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const store: PersistedStore = {
          conversations: Array.from(this.conversations.values()),
          messages: Array.from(this.messages.values()),
        };
        writeFile(DATA_FILE, JSON.stringify(store, null, 2), "utf-8").catch(() => {});
      }, 200);
    };
  })();

  // ── Conversations ───────────────────────────────────────────────────────

  createConversation(title: string): ChatConversation {
    const now = new Date().toISOString();
    const conv: ChatConversation = {
      id: makeId(),
      openAiLastResponseId: null,
      title,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: null,
      archived: false,
    };
    this.conversations.set(conv.id, conv);
    this._persist();
    return conv;
  }

  getConversation(id: string): ChatConversation | null {
    return this.conversations.get(id) ?? null;
  }

  listConversations(): ChatConversation[] {
    return Array.from(this.conversations.values())
      .filter((c) => !c.archived)
      .sort((a, b) => {
        const ta = a.lastMessageAt ?? a.createdAt;
        const tb = b.lastMessageAt ?? b.createdAt;
        return tb.localeCompare(ta);
      });
  }

  updateLastResponseId(chatId: string, responseId: string): void {
    const conv = this.conversations.get(chatId);
    if (!conv) return;
    conv.openAiLastResponseId = responseId;
    conv.updatedAt = new Date().toISOString();
    this._persist();
  }

  updateTitle(chatId: string, title: string): void {
    const conv = this.conversations.get(chatId);
    if (!conv) return;
    conv.title = title;
    conv.updatedAt = new Date().toISOString();
    this._persist();
  }

  archiveConversation(chatId: string): void {
    const conv = this.conversations.get(chatId);
    if (!conv) return;
    conv.archived = true;
    conv.updatedAt = new Date().toISOString();
    this._persist();
  }

  // ── Messages ─────────────────────────────────────────────────────────────

  addMessage(chatId: string, role: ChatMessage["role"], text: string, openAiItemId?: string): ChatMessage {
    const now = new Date().toISOString();
    const msg: ChatMessage = {
      id: makeId(),
      chatId,
      role,
      text,
      createdAt: now,
      openAiItemId: openAiItemId ?? null,
    };
    this.messages.set(msg.id, msg);

    // Update conversation lastMessageAt
    const conv = this.conversations.get(chatId);
    if (conv) {
      conv.lastMessageAt = now;
      conv.updatedAt = now;
    }
    this._persist();
    return msg;
  }

  getMessages(chatId: string, limit = 100): ChatMessage[] {
    return Array.from(this.messages.values())
      .filter((m) => m.chatId === chatId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-limit); // most recent `limit` messages
  }
}

export const chatRepository = new ChatRepository();
