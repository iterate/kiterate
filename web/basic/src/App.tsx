import { useMemo, useState, useCallback } from "react";
import { AgentChat } from "@/components/agent-chat";
import { AppHeader } from "@/components/app-header";
import { useHashAgent } from "@/hooks/use-hash-agent";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Label } from "@/components/ui/label";
import type { ConnectionStatus } from "@/reducers";
import type { HarnessType } from "@/lib/agent-api";

const HARNESS_INFO: Record<HarnessType & string, { placeholder: string; description: string }> = {
  pi: {
    placeholder: "e.g. /pi/my-session",
    description: "Pi coding agent. Messages will be processed by the Pi AI.",
  },
  claude: {
    placeholder: "e.g. /claude/my-session",
    description: "Claude Agent SDK. Messages will be processed by Claude.",
  },
  opencode: {
    placeholder: "e.g. /opencode/my-session",
    description: "OpenCode agent. Messages will be processed by OpenCode.",
  },
};

const DEFAULT_INFO = {
  placeholder: "e.g. demo",
  description: "Standard mode for raw event streams without AI processing.",
};

export function App() {
  const apiURL = useMemo(() => new URL("/", window.location.href).toString(), []);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus | null>(null);

  const {
    selectedStream,
    agentPathInput,
    harnessType,
    setAgentPathInput,
    setHarnessType,
    selectAgent,
  } = useHashAgent();

  const handleConnectionStatusChange = useCallback((status: ConnectionStatus) => {
    setConnectionStatus(status);
  }, []);

  const info = harnessType ? HARNESS_INFO[harnessType] : DEFAULT_INFO;

  return (
    <div className="flex h-screen bg-background text-foreground">
      <section className="flex min-w-0 flex-1 flex-col">
        <AppHeader
          {...(selectedStream ? { agentId: selectedStream } : {})}
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
                    placeholder={info.placeholder}
                    value={agentPathInput}
                    onChange={(e) => setAgentPathInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && selectAgent()}
                    className="flex-1"
                  />
                  <Button onClick={selectAgent}>Open</Button>
                </div>
                <div className="flex flex-col gap-2">
                  <Label className="text-muted-foreground">Harness</Label>
                  <ButtonGroup>
                    <Button
                      variant={harnessType === "pi" ? "default" : "outline"}
                      size="sm"
                      onClick={() => setHarnessType(harnessType === "pi" ? null : "pi")}
                    >
                      Pi
                    </Button>
                    <Button
                      variant={harnessType === "claude" ? "default" : "outline"}
                      size="sm"
                      onClick={() => setHarnessType(harnessType === "claude" ? null : "claude")}
                    >
                      Claude
                    </Button>
                    <Button
                      variant={harnessType === "opencode" ? "default" : "outline"}
                      size="sm"
                      onClick={() => setHarnessType(harnessType === "opencode" ? null : "opencode")}
                    >
                      OpenCode
                    </Button>
                  </ButtonGroup>
                </div>
                <p className="text-xs text-muted-foreground">{info.description}</p>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
