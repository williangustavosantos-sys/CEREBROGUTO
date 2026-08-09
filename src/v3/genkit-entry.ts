import "./observability/instrumentation.js";
import { getV3Runtime } from "./runtime.js";

// Genkit CLI discovers gutoTurnFlow through this dedicated entrypoint.
getV3Runtime();

