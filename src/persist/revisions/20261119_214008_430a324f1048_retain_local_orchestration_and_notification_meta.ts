import type { Revision } from "../formats";

export const revision: Revision = {
  id: "430a324f1048",
  parent: "c52d95a61ae4",
  description: "Retain local orchestration and notification metadata",
  // Local fields are additive; readers already default absent metadata.
  up: value => value,
  down: value => value,
};
