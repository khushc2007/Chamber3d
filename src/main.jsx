import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import GreywaterViz from "./GreywaterViz.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <GreywaterViz />
  </StrictMode>
);
