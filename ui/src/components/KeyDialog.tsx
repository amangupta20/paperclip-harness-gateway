import { useState } from "react";
import { KeyRound } from "lucide-react";
import { Button, Kbd } from "./ui";

export function KeyDialog({ reason, onSave, onCancel }: { reason: string; onSave: (key: string) => void; onCancel?: () => void }) {
  const [k, setK] = useState("");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <form
        className="fade-in w-full max-w-md rounded-2xl border border-line bg-surface p-5 shadow-2xl"
        onSubmit={(e) => {
          e.preventDefault();
          if (k.trim()) onSave(k.trim());
        }}
      >
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-sunken">
          <KeyRound className="h-5 w-5 text-fg-2" />
        </div>
        <h2 className="text-[16px] font-semibold">Gateway key</h2>
        <p className="mt-1 text-[13px] text-mute">{reason}</p>
        <p className="mt-2 text-[12.5px] text-mute">
          It's in <Kbd>~/.paperclip/agents/&lt;harness&gt;/gateway-key</Kbd> on the gateway host and is kept in this browser only.
        </p>
        <input
          autoFocus
          type="password"
          value={k}
          onChange={(e) => setK(e.target.value)}
          className="mt-4 h-10 w-full rounded-lg border border-line bg-bg px-3 font-mono text-[13px] outline-none focus:border-line-strong"
          placeholder="paste key"
        />
        <div className="mt-4 flex justify-end gap-2">
          {onCancel && (
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <button type="submit" className="inline-flex h-8 items-center rounded-lg bg-fg px-3 text-[13px] font-medium text-bg hover:opacity-90">
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
