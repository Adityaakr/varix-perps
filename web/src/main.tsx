import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { VaraProviders } from "./providers/VaraProviders";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <VaraProviders>
      <App />
    </VaraProviders>
  </React.StrictMode>
);
