import type { Metadata } from "next";
import { ChatView } from "@/components/chat/chat-view";

export const metadata: Metadata = { title: "Chat" };

/** The chat home (DESIGN.md §6). The page owns its layout: thread, wallet rail, and the strip on narrow screens. */
export default function ChatPage() {
  return (
    <>
      <h1 className="sr-only">Chat</h1>
      <ChatView />
    </>
  );
}
