"use client";

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

/**
 * Lets a page take over the shared TopBar with its own contextual content.
 *
 * TopBar exposes a "start" slot (left, e.g. a breadcrumb) and an "end" slot
 * (right, e.g. page actions) as DOM nodes; pages portal into them. When a page
 * marks the bar as `filled`, TopBar hides its default global search — which does
 * not make sense on most inner pages. Any route that does not opt in keeps the
 * default search unchanged.
 */
type TopBarSlotsValue = {
  startEl: HTMLElement | null;
  endEl: HTMLElement | null;
  filled: boolean;
  bindStart: (el: HTMLElement | null) => void;
  bindEnd: (el: HTMLElement | null) => void;
  setFilled: (value: boolean) => void;
};

const TopBarSlotsContext = createContext<TopBarSlotsValue | null>(null);

export function TopBarSlotsProvider({ children }: { children: ReactNode }) {
  const [startEl, setStartEl] = useState<HTMLElement | null>(null);
  const [endEl, setEndEl] = useState<HTMLElement | null>(null);
  const [filled, setFilled] = useState(false);

  const bindStart = useCallback((el: HTMLElement | null) => setStartEl(el), []);
  const bindEnd = useCallback((el: HTMLElement | null) => setEndEl(el), []);

  return (
    <TopBarSlotsContext.Provider
      value={{ startEl, endEl, filled, bindStart, bindEnd, setFilled }}
    >
      {children}
    </TopBarSlotsContext.Provider>
  );
}

export function useTopBarSlots(): TopBarSlotsValue {
  const ctx = useContext(TopBarSlotsContext);
  if (!ctx) {
    throw new Error("useTopBarSlots must be used within a TopBarSlotsProvider");
  }
  return ctx;
}
