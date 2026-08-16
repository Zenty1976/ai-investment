/**
 * AI Chat Routes
 *
 * Isolated module — does NOT modify any existing route or module behavior.
 *
 * Endpoints:
 *   POST   /ai-chat/conversations          create new conversation
 *   GET    /ai-chat/conversations          list conversations
 *   GET    /ai-chat/conversations/:id      get conversation + messages
 *   POST   /ai-chat/conversations/:id/messages  send message
 *   DELETE /ai-chat/conversations/:id      archive conversation
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { chatRepository } from "../lib/chat-repository.js";
import { sendChatMessage } from "../lib/ai-chat-service.js";

const router: IRouter = Router();

// ── Deterministic title from first user message ───────────────────────────────

function makeTitle(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= 45) return trimmed;
  return trimmed.slice(0, 42) + "…";
}

// ── POST /ai-chat/conversations — create new conversation ─────────────────────

router.post("/ai-chat/conversations", (_req: Request, res: Response) => {
  const conv = chatRepository.createConversation("New Chat");
  res.json({ ok: true, conversation: conv });
});

// ── GET /ai-chat/conversations — list conversations ───────────────────────────

router.get("/ai-chat/conversations", (_req: Request, res: Response) => {
  const conversations = chatRepository.listConversations();
  res.json({ ok: true, conversations });
});

// ── GET /ai-chat/conversations/:id — get conversation + messages ──────────────

router.get("/ai-chat/conversations/:id", (req: Request, res: Response) => {
  const conv = chatRepository.getConversation(req.params.id);
  if (!conv) {
    res.status(404).json({ ok: false, error: "Conversation not found" });
    return;
  }
  const messages = chatRepository.getMessages(req.params.id, 100);
  res.json({ ok: true, conversation: conv, messages });
});

// ── POST /ai-chat/conversations/:id/messages — send message ──────────────────

router.post(
  "/ai-chat/conversations/:id/messages",
  async (req: Request, res: Response) => {
    const chatId = req.params.id;
    const conv = chatRepository.getConversation(chatId);
    if (!conv) {
      res.status(404).json({ ok: false, error: "Conversation not found" });
      return;
    }

    const userText: string = String((req.body as { text?: string }).text ?? "").trim();
    if (!userText) {
      res.status(400).json({ ok: false, error: "text is required" });
      return;
    }

    // Save user message immediately so the UI can show it
    const userMsg = chatRepository.addMessage(chatId, "user", userText);

    // First message in conversation → derive title from it
    const messages = chatRepository.getMessages(chatId);
    if (messages.filter((m) => m.role === "user").length === 1) {
      chatRepository.updateTitle(chatId, makeTitle(userText));
    }

    // Send to OpenAI
    let turn;
    try {
      turn = await sendChatMessage(userText, conv.openAiLastResponseId);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Save error as assistant message so the user can see what went wrong
      const errMsgRecord = chatRepository.addMessage(chatId, "assistant", `Error: ${errMsg}`);
      res.status(502).json({
        ok: false,
        error: errMsg,
        userMessage: userMsg,
        assistantMessage: errMsgRecord,
      });
      return;
    }

    // Persist the new response ID for conversation continuity
    chatRepository.updateLastResponseId(chatId, turn.newResponseId);

    // Save assistant message
    const assistantMsg = chatRepository.addMessage(
      chatId,
      "assistant",
      turn.assistantText,
      turn.newResponseId
    );

    res.json({
      ok: true,
      userMessage: userMsg,
      assistantMessage: assistantMsg,
      toolsUsed: turn.toolsUsed,
      webSearchUsed: turn.webSearchUsed,
      usage: turn.usage,
    });
  }
);

// ── DELETE /ai-chat/conversations/:id — archive conversation ──────────────────

router.delete("/ai-chat/conversations/:id", (req: Request, res: Response) => {
  const conv = chatRepository.getConversation(req.params.id);
  if (!conv) {
    res.status(404).json({ ok: false, error: "Conversation not found" });
    return;
  }
  chatRepository.archiveConversation(req.params.id);
  res.json({ ok: true });
});

export default router;
