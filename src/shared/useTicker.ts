import { useCallback, useEffect, useState } from "react";

/** Simple 1-second ticker: counts up while `running` is true. */
export function useTicker(running: boolean): [number, () => void] {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  const reset = useCallback(() => setSeconds(0), []);
  return [seconds, reset];
}

export const fmtTime = (s: number) =>
  `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, s) % 60).padStart(2, "0")}`;
