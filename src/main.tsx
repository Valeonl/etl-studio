import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";

// No StrictMode on purpose: its double-mount in dev would build a second Yjs session and a second
// WebRTC provider for the same room, which shows phantom peers while developing.
createRoot(document.getElementById("root")!).render(<App />);
