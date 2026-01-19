import { useState, useEffect } from "react";
import { AgentChat } from "@/components/agent-chat.tsx";
import { AppHeader } from "@/components/app-header.tsx";

export function App() {
  const apiURL = new URL("/", window.location.href).toString();
  const [selectedStream, setSelectedStream] = useState<string>("");
  const [hashStream, setHashStream] = useState<string>("");
  const [agentPathInput, setAgentPathInput] = useState("");

  useEffect(() => {
    const readHash = () => {
      const hashValue = window.location.hash.replace(/^#/, "");
      const decoded = hashValue ? decodeURIComponent(hashValue) : "";
      setHashStream(decoded);
    };
    readHash();
    window.addEventListener("hashchange", readHash);
    return () => window.removeEventListener("hashchange", readHash);
  }, []);

  useEffect(() => {
    setSelectedStream(hashStream);
    setAgentPathInput(hashStream);
  }, [hashStream]);

  const handleSelectAgent = () => {
    const trimmed = agentPathInput.trim();
    if (!trimmed) return;
    const normalized = trimmed.replace(/^#/, "").replace(/^\/?agents\//, "");
    if (!normalized) return;
    window.location.hash = encodeURIComponent(normalized);
  };

  return (
    <div className="flex h-screen bg-background text-foreground">
      <section className="flex min-w-0 flex-1 flex-col">
        <AppHeader agentId={selectedStream || undefined} />
        <div className="flex min-h-0 flex-1 flex-col">
          {selectedStream ? (
            <AgentChat agentPath={selectedStream} apiURL={apiURL} />
          ) : (
            <div className="flex h-full items-center justify-center">
              <div className="flex w-full max-w-md flex-col gap-4 px-6">
                <label htmlFor="agent-path" className="text-sm font-medium text-muted-foreground">
                  Agent path
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id="agent-path"
                    type="text"
                    placeholder="e.g. #demo"
                    value={agentPathInput}
                    onChange={(e) => setAgentPathInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSelectAgent()}
                    className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm"
                  />
                  <button
                    className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                    onClick={handleSelectAgent}
                  >
                    Open
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
