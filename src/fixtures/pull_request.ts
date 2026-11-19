import { parse, type Snapshot } from "../pull_request";

export function snapshot(number = 12): Snapshot {
  return {
    ref: parse(`https://github.com/acme/app/pull/${number}`)!,
    title: "Fix the widget",
    body: "Description",
    state: "OPEN",
    draft: false,
    mergeable: "MERGEABLE",
    mergeState: "BLOCKED",
    decision: "REVIEW_REQUIRED",
    autoMerge: false,
    head: "a".repeat(40),
    base: "b".repeat(40),
    headBranch: "topic",
    baseBranch: "main",
    reviewers: ["reviewer"],
    reviews: [],
    labels: ["bug"],
    comments: [],
    threads: [],
    checks: [],
    stack: [],
    discussionVersion: 1,
    fetched: Date.now(),
  };
}
