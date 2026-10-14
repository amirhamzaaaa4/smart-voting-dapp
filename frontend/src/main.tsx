import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ToastProvider } from "./components/Toasts";
import { WalletProvider } from "./lib/wallet";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WalletProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </WalletProvider>
  </StrictMode>,
);
