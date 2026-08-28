import { createContext, useContext, useState, type ReactNode } from "react";
import { clearPlayer, loadPlayer, savePlayer, type Player } from "./storage";

type PlayerContextValue = {
  player: Player | null;
  setPlayer: (p: Player | null) => void;
};

const PlayerContext = createContext<PlayerContextValue>({
  player: null,
  setPlayer: () => {},
});

export function PlayerProvider({ children }: { children: ReactNode }) {
  const [player, setPlayerState] = useState<Player | null>(loadPlayer);

  const setPlayer = (p: Player | null) => {
    if (p) savePlayer(p);
    else clearPlayer();
    setPlayerState(p);
  };

  return (
    <PlayerContext.Provider value={{ player, setPlayer }}>{children}</PlayerContext.Provider>
  );
}

export const usePlayer = () => useContext(PlayerContext);
