import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { Toaster } from "./components/ui/sonner";
import { TooltipProvider } from "./components/ui/tooltip";
import { ToolPickerProvider } from "./features/panels/tool-picker-context";
import { WorkspaceSurfaceFocusProvider } from "./features/panels/workspace-surface-focus-context";
import { apiRetryDelay, shouldRetryApiQuery } from "./metadata-sync";
import { router } from "./router";
import { TerminalFocusProvider } from "./terminal-focus";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: shouldRetryApiQuery,
      retryDelay: apiRetryDelay,
      refetchOnReconnect: true,
    },
    mutations: { retry: false },
  },
});

export function TreeportRoot() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <TerminalFocusProvider>
          <WorkspaceSurfaceFocusProvider>
            <ToolPickerProvider>
              <RouterProvider router={router} />
              <Toaster />
            </ToolPickerProvider>
          </WorkspaceSurfaceFocusProvider>
        </TerminalFocusProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
