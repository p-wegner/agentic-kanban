import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import "./app.css";
import { AppQueryProvider } from "./lib/queryClient.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppQueryProvider>
      <App />
    </AppQueryProvider>
  </StrictMode>,
);
