import { Switch } from "@/components/ui/switch.tsx";
import { Label } from "@/components/ui/label.tsx";
import { useRawMode } from "@/hooks/use-raw-mode.ts";

interface AppHeaderProps {
  agentId?: string;
}

export function AppHeader({ agentId }: AppHeaderProps) {
  const { rawMode, setRawMode, rawEventsCount } = useRawMode();

  if (!agentId) {
    return null;
  }

  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-2 px-4">
      <div className="font-medium truncate max-w-[200px] sm:max-w-[300px]">{agentId}</div>
      <div className="flex items-center gap-2">
        <Switch id="raw-mode" checked={rawMode} onCheckedChange={setRawMode} />
        <Label htmlFor="raw-mode" className="text-sm text-muted-foreground cursor-pointer">
          Raw
          {rawEventsCount > 0 && (
            <span className="ml-1 text-muted-foreground/60">({rawEventsCount})</span>
          )}
        </Label>
      </div>
    </header>
  );
}
