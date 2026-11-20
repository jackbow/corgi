import type { Revision } from "../formats";

export const revision: Revision = {
  id: "2de8732b5be8",
  parent: "ec1764d3653f",
  description: "Save code palette and background preferences",
  // The value is { viewer, config }: viewer.json and config.json, or null without one.
  up: value => value,
  down: value => value,
};
