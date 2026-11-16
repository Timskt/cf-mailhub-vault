import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/lib/theme";
import { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <main className="boot-screen">
        <h1>页面暂时无法显示</h1>
        <p>刷新页面重新加载工作区。</p>
        <button
          className="rounded-lg border px-4 py-2"
          onClick={() => location.reload()}
        >
          刷新页面
        </button>
      </main>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <ThemeProvider>
      <TooltipProvider delayDuration={300}>
        <a
          className="skip-link"
          href="#main-content"
          onClick={(event) => {
            const main = document.getElementById("main-content");
            if (main) {
              event.preventDefault();
              main.focus();
              main.scrollIntoView({ block: "start" });
            }
          }}
        >
          跳到主要内容
        </a>
        <App />
      </TooltipProvider>
    </ThemeProvider>
  </ErrorBoundary>,
);
