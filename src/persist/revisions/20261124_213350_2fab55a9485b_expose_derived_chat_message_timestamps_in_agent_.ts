import type { Revision } from "../formats";

export const revision: Revision = {
  id: "2fab55a9485b",
  parent: "430a324f1048",
  description: "Expose derived chat message timestamps in agent snapshots",
  // The defaulted wire field is rebuilt from transcripts; saved metadata stays intact.
  up: value => value,
  down: value => value,
};
