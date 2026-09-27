import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import Radial from "./Radial";
import "./styles.css";

// La même page sert la fenêtre principale et la fenêtre du menu radial (#radial)
const isRadial = window.location.hash === "#radial";
document.documentElement.classList.toggle("radial-window", isRadial);

createRoot(document.getElementById("root")!).render(
  <StrictMode>{isRadial ? <Radial /> : <App />}</StrictMode>,
);
