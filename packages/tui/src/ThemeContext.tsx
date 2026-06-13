import { createContext, useContext, type ReactElement, type ReactNode } from 'react';
import { darkColors, type Palette } from './theme.js';

/**
 * Provides the active {@link Palette} (light or dark, chosen from the terminal
 * background) to every TUI component, so colours stay readable on any theme.
 */
const ThemeContext = createContext<Palette>(darkColors);

export function ThemeProvider({
  colors,
  children,
}: {
  colors: Palette;
  children: ReactNode;
}): ReactElement {
  return <ThemeContext.Provider value={colors}>{children}</ThemeContext.Provider>;
}

export function useColors(): Palette {
  return useContext(ThemeContext);
}
