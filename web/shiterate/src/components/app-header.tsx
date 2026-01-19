import { Trash2Icon } from "lucide-react";
import { useRawMode, type DisplayMode } from "@/hooks/use-raw-mode.ts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip.tsx";
import { clearCache } from "@/lib/event-storage";
import type { ConnectionStatus } from "@/reducers";

interface AppHeaderProps {
  agentId?: string;
  connectionStatus?: ConnectionStatus | null;
}

const DISPLAY_MODE_LABELS: Record<DisplayMode, string> = {
  "pretty": "Pretty",
  "raw-pretty": "Raw + Pretty",
  "raw": "Raw",
};

/** Connection status indicator with pulsing dot */
function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  const isConnected = status.state === "connected";
  const isError = status.state === "error";
  const isConnecting = status.state === "connecting";

  return (
    <div className="flex items-center gap-1.5">
      <span
        className={`size-2 rounded-full ${
          isConnected
            ? "bg-green-500 animate-pulse"
            : isError
              ? "bg-red-500"
              : isConnecting
                ? "bg-yellow-500 animate-pulse"
                : "bg-gray-400"
        }`}
      />
      {isError && (
        <span className="text-xs text-destructive">{status.message}</span>
      )}
    </div>
  );
}

export function AppHeader({ agentId, connectionStatus }: AppHeaderProps) {
  const { displayMode, setDisplayMode, rawEventsCount } = useRawMode();

  if (!agentId) {
    return null;
  }

  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-2 px-4 border-b">
      <div className="flex items-center gap-2">
        <span className="font-medium truncate max-w-[200px] sm:max-w-[300px]">{agentId}</span>
        {connectionStatus && <ConnectionIndicator status={connectionStatus} />}
      </div>
      <div className="flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={async () => {
                await clearCache(`agent:${agentId}`);
                window.location.reload();
              }}
            >
              <Trash2Icon className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Clear local storage</TooltipContent>
        </Tooltip>
        <Select value={displayMode} onValueChange={(value) => setDisplayMode(value as DisplayMode)}>
          <SelectTrigger className="h-8 w-auto min-w-[130px] text-xs">
            <SelectValue>
              {DISPLAY_MODE_LABELS[displayMode]}
              {rawEventsCount > 0 && (
                <span className="ml-1 text-muted-foreground">({rawEventsCount})</span>
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="pretty" className="py-2">
              <div className="flex flex-col">
                <span className="text-sm font-medium">Pretty</span>
                <span className="text-xs text-muted-foreground">Hide raw events</span>
              </div>
            </SelectItem>
            <SelectItem value="raw-pretty" className="py-2">
              <div className="flex flex-col">
                <span className="text-sm font-medium">Raw + Pretty</span>
                <span className="text-xs text-muted-foreground">Grouped raw events + pretty</span>
              </div>
            </SelectItem>
            <SelectItem value="raw" className="py-2">
              <div className="flex flex-col">
                <span className="text-sm font-medium">Raw</span>
                <span className="text-xs text-muted-foreground">Individual raw events only</span>
              </div>
            </SelectItem>
            <SelectItem value="raw-raw" className="py-2">
              <div className="flex flex-col">
                <span className="text-sm font-medium">Raw Raw</span>
                <span className="text-xs text-muted-foreground">All events as YAML dump</span>
              </div>
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
    </header>
  );
}
