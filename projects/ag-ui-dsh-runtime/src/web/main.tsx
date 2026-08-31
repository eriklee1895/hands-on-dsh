import "@copilotkit/react-core/v2/styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#root");
if (root === null) throw new Error("#root is required");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
