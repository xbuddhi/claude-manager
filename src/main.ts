// Entry point: global styles, then the foundation starts and mounts every feature.
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/shell.css";
import { start } from "./core/app";
import { mountFeatures } from "./features";
// last: the Liquid Glass style overrides the skin's surfaces (see the file)
import "./styles/glass.css";

void start(mountFeatures);
