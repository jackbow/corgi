import { createRootRoute, createRoute, createRouter, type RouterHistory } from "@tanstack/react-router";
import { AgentScreen, HomeScreen, NewScreen, Root, SettingsScreen } from "./app";
const root = createRootRoute({ component: Root, notFoundComponent: HomeScreen });
const routes = [
  createRoute({ getParentRoute: () => root, path: "/", component: HomeScreen }),
  createRoute({
    getParentRoute: () => root,
    path: "/agents/$pane",
    component: AgentScreen,
    validateSearch: (value: Record<string, unknown>): { view: "terminal" | "conversation"; notification?: string } => ({
      view: value.view === "terminal" ? ("terminal" as const) : ("conversation" as const),
      notification:
        typeof value.notification === "string" && value.notification.length <= 512 ? value.notification : undefined,
    }),
  }),
  createRoute({ getParentRoute: () => root, path: "/new", component: NewScreen }),
  createRoute({ getParentRoute: () => root, path: "/settings", component: SettingsScreen }),
];
export function phoneRouter(history?: RouterHistory) {
  return createRouter({ routeTree: root.addChildren(routes), history, scrollRestoration: true });
}
declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof phoneRouter>;
  }
}
