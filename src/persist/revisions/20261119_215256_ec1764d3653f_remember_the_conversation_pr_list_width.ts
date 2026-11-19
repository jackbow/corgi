import type { Revision } from "../formats";

export const revision: Revision = {
  id: "ec1764d3653f",
  parent: "50cd70f93bfd",
  description: "Remember the conversation PR list width",
  // The value is { viewer, config }: viewer.json and config.json, or null without one.
  up: value => value,
  down: value => value,
};
