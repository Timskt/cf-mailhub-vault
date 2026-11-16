import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
const Context = createContext({
  theme: "system",
  resolved: "light" as "light" | "dark",
  setTheme: (_: string) => {},
});
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState(() => {
    const t = localStorage.getItem("mailhub_theme");
    return t && ["light", "dark", "system"].includes(t) ? t : "system";
  });
  const [resolved, setResolved] = useState<"light" | "dark">("light");
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
      setResolved(dark ? "dark" : "light");
    };
    apply();
    localStorage.setItem("mailhub_theme", theme);
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  return (
    <Context.Provider value={{ theme, setTheme, resolved }}>
      {children}
    </Context.Provider>
  );
}
export const useTheme = () => useContext(Context);
