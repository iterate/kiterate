import { useMemo, useState, useCallback } from "react";
import { AgentChat } from "@/components/agent-chat";
import { AppHeader } from "@/components/app-header";
import { useHashAgent } from "@/hooks/use-hash-agent";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import type { ConnectionStatus } from "@/reducers/persistent-stream-reducer";

export function App() {
  const apiURL = useMemo(() => new URL("/", window.location.href).toString(), []);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus | null>(null);
  
  const {
    selectedStream,
    agentPathInput,
    piMode,
    setAgentPathInput,
    setPiMode,
    selectAgent,
  } = useHashAgent();

  const handleConnectionStatusChange = useCallback((status: ConnectionStatus) => {
    setConnectionStatus(status);
  }, []);

  return (
    <div className="flex h-screen bg-background text-foreground">
      <section className="flex min-w-0 flex-1 flex-col">
        <AppHeader 
          agentId={selectedStream || undefined} 
          connectionStatus={connectionStatus}
        />
        <div className="flex min-h-0 flex-1 flex-col">
          {selectedStream ? (
            <AgentChat 
              key={selectedStream} 
              agentPath={selectedStream} 
              apiURL={apiURL}
              onConnectionStatusChange={handleConnectionStatusChange}
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <div className="flex w-full max-w-md flex-col gap-4 px-6">
                <Label htmlFor="agent-path">Agent path</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="agent-path"
                    placeholder={piMode ? "e.g. /pi/my-session" : "e.g. demo"}
                    value={agentPathInput}
                    onChange={(e) => setAgentPathInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && selectAgent()}
                    className="flex-1"
                  />
                  <Button onClick={selectAgent}>Open</Button>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    id="pi-mode"
                    checked={piMode}
                    onCheckedChange={setPiMode}
                  />
                  <Label htmlFor="pi-mode" className="text-muted-foreground">
                    PI Mode{" "}
                    {piMode && (
                      <span className="text-violet-600 dark:text-violet-400">(enabled)</span>
                    )}
                  </Label>
                </div>
                <p className="text-xs text-muted-foreground">
                  {piMode
                    ? "PI mode connects to the Pi coding agent. Messages will be processed by the AI."
                    : "Standard mode for raw event streams without AI processing."}
                </p>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
