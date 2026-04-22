import React from "react";
import ReactDOM from "react-dom/client";
import { Buffer } from "buffer";
import App from "./App";
import { VaraProviders } from "./providers/VaraProviders";
import "./styles.css";

if (typeof window !== "undefined" && !("Buffer" in window)) {
  (window as Window & typeof globalThis & { Buffer: typeof Buffer }).Buffer = Buffer;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <VaraProviders>
    <App />
  </VaraProviders>
);
