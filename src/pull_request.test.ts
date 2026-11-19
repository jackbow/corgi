import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Cache,
  Client,
  cache_size,
  checkState,
  parse,
  stale,
  stale_ms,
  commentPrompt,
  commentSnippet,
  location,
} from "./pull_request";

import { snapshot } from "./fixtures/pull_request";

test("diff revision checks read only the current commit IDs and reject invalid responses", async () => {
  const s = snapshot(),
    calls: string[][] = [];
  const client = new Client(async args => {
    calls.push(args);
    return JSON.stringify({ headRefOid: s.head, baseRefOid: s.base });
  });
  expect(await client.revisions(s.ref)).toEqual({ head: s.head, base: s.base });
  expect(calls).toEqual([["pr", "view", s.ref.url, "--json", "headRefOid,baseRefOid"]]);
  await expect(
    new Client(async () => JSON.stringify({ headRefOid: "bad", baseRefOid: s.base })).revisions(s.ref),
  ).rejects.toThrow("invalid PR revision");
});

test("PR URLs normalize subpages and fragments and reject other hosts and invalid IDs", () => {
  expect(parse("https://github.com/acme/app/pull/12/files#diff-abc")).toEqual(snapshot().ref);
  for (const url of [
    "https://github.com.evil.org/acme/app/pull/12",
    "http://github.com/acme/app/pull/12",
    "https://github.com/acme/app/issues/12",
    "https://github.com/acme/app/pull/12suffix",
    "https://github.com/acme/app/pull/0",
    "https://github.com/acme/app/pull/9007199254740992",
    "https://user@github.com/acme/app/pull/12",
  ])
    expect(parse(url)).toBeNull();
});
test("checks distinguish incomplete, failed, successful and nonblocking conclusions", () => {
  expect(checkState("queued", null)).toBe("pending");
  expect(checkState("in_progress", "success")).toBe("pending");
  for (const conclusion of ["success", "neutral", "skipped"])
    expect(checkState("completed", conclusion)).toBe("passed");
  for (const conclusion of ["failure", "timed_out", "cancelled", "action_required", "stale", null])
    expect(checkState("completed", conclusion)).toBe("failed");
});
test("GitHub reads paginate comments/checks, keep latest reviews/statuses, and find adjacent stack branches", async () => {
  const calls: string[][] = [];
  const s = snapshot();
  const metadata = {
    title: s.title,
    body: s.body,
    state: s.state,
    headRefOid: s.head,
    baseRefOid: s.base,
    headRefName: "topic",
    baseRefName: "parent",
    isDraft: false,
    mergeable: s.mergeable,
    mergeStateStatus: s.mergeState,
    reviewDecision: s.decision,
    autoMergeRequest: null,
    reviewRequests: [{ login: "reviewer" }, { slug: "team" }],
    labels: [{ name: "bug" }],
  };
  const linked = (number: number) => ({
    html_url: `https://github.com/acme/app/pull/${number}`,
    title: "PR " + number,
    state: "open",
    draft: false,
    head: { ref: number === 11 ? "parent" : "child", repo: { full_name: "acme/app" } },
    base: { ref: number === 11 ? "main" : "topic", repo: { full_name: "acme/app" } },
  });
  const client = new Client(async args => {
    calls.push(args);
    if (args[0] === "pr") return JSON.stringify(metadata);
    if (args[1] === "graphql")
      return JSON.stringify({
        data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } },
      });
    const endpoint = args.at(-1)!;
    if (endpoint.includes("/issues/"))
      return JSON.stringify([
        [{ user: { login: "one" }, body: "first", created_at: "2026-01-01" }],
        [{ user: null, body: "second", created_at: "2026-01-02" }],
      ]);
    if (endpoint.includes("/reviews?"))
      return JSON.stringify([
        [
          { user: { login: "reviewer" }, state: "CHANGES_REQUESTED", body: "fix it", submitted_at: "2026-01-01" },
          { user: { login: "reviewer" }, state: "APPROVED", body: "", submitted_at: "2026-01-02" },
          { user: { login: "reviewer" }, state: "COMMENTED", body: "fine", submitted_at: "2026-01-03" },
        ],
      ]);
    if (endpoint.includes("check-runs"))
      return JSON.stringify([
        { check_runs: [{ name: "lint", status: "completed", conclusion: "success" }] },
        { check_runs: [{ name: "test", status: "queued" }] },
      ]);
    if (endpoint.includes("/statuses"))
      return JSON.stringify([
        [
          { context: "deploy", state: "success" },
          { context: "pullapprove5", state: "pending", description: "One approval required" },
          { context: "deploy", state: "failure" },
        ],
      ]);
    if (endpoint.includes("head=")) return JSON.stringify([[linked(11)]]);
    if (endpoint.includes("base="))
      return JSON.stringify([[linked(13), { ...linked(14), head: { repo: { full_name: "fork/app" } } }]]);
    return "[[]]";
  });
  const result = await client.fetch(s.ref);
  expect(result.comments.map(c => c.body)).toEqual(["fine", "second", "first", "fix it"]);
  expect(result.comments.find(c => c.body === "second")?.author).toBe("deleted user");
  expect(result.reviews).toEqual([{ author: "reviewer", state: "APPROVED" }]);
  expect(result.reviewers).toEqual(["reviewer", "team"]);
  expect(result.checks).toEqual([
    { title: "lint", state: "passed" },
    { title: "test", state: "pending" },
    { title: "deploy", state: "passed" },
    { title: "pullapprove5", state: "pending", summary: "One approval required" },
  ]);
  expect(result.stack.map(r => r.number)).toEqual([11, 13]);
  expect(
    calls
      .filter(c => c[0] === "api" && c[1] !== "graphql")
      .every(c => c.includes("--paginate") && c.includes("--slurp")),
  ).toBe(true);
});
test("merge mutations target the viewed head and method, without admin bypass or branch deletion", async () => {
  const calls: string[][] = [],
    client = new Client(async args => {
      calls.push(args);
      return "";
    });
  const s = snapshot();
  await client.mutate(s, { kind: "merge", method: "squash" });
  expect(calls[0]).toEqual(["pr", "merge", s.ref.url, "--match-head-commit", s.head, "--squash", "--auto"]);
  await client.mutate(s, { kind: "enable-auto", method: "rebase" });
  expect(calls[1]?.slice(-2)).toEqual(["--rebase", "--auto"]);
  await client.mutate(s, { kind: "disable-auto" });
  expect(calls[2]?.at(-1)).toBe("--disable-auto");
  await expect(client.mutate({ ...s, draft: true }, { kind: "merge", method: "merge" })).rejects.toThrow();
  await expect(client.mutate({ ...s, state: "MERGED" }, { kind: "merge", method: "merge" })).rejects.toThrow();
  expect(calls).toHaveLength(3);
});

test("PR diff reads are pinned to both displayed revisions", async () => {
  const s = snapshot(),
    calls: string[][] = [];
  await new Client(async args => {
    calls.push(args);
    return "";
  }).diff(s);
  expect(calls).toEqual([
    ["api", `repos/acme/app/compare/${s.base}...${s.head}`, "-H", "Accept: application/vnd.github.diff"],
  ]);
});

test("a mutation's refresh waits out an older read and then fetches again", async () => {
  let resolve!: (value: ReturnType<typeof snapshot>) => void;
  const s = snapshot(),
    client = new Client(),
    dir = await mkdtemp(join(tmpdir(), "corgi-pr-mutation-cache-"));
  let calls = 0;
  client.fetch = async () => {
    if (++calls === 1)
      return new Promise(yes => {
        resolve = yes;
      });
    return { ...s, autoMerge: true };
  };
  try {
    const cache = new Cache(client, dir),
      old = cache.refresh(s.ref),
      fresh = cache.refresh(s.ref, true);
    resolve(s);
    expect((await old).autoMerge).toBe(false);
    expect((await fresh).autoMerge).toBe(true);
    expect(calls).toBe(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("cache survives recreation without expiry, deduplicates reads and rejects corrupt entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "corgi-pr-cache-"));
  let calls = 0;
  const s = snapshot();
  const client = new Client();
  client.fetch = async () => {
    calls++;
    return s;
  };
  try {
    const cache = new Cache(client, dir);
    const one = cache.refresh(s.ref),
      two = cache.refresh(s.ref);
    expect(one).toBe(two);
    await one;
    expect(calls).toBe(1);
    const restored = new Cache(client, dir);
    expect(await restored.cached(s.ref)).toEqual(s);
    const aged = { ...s, fetched: s.fetched - stale_ms * 10 };
    client.fetch = async () => aged;
    await cache.refresh(s.ref);
    expect(await new Cache(client, dir).cached(s.ref)).toEqual(aged);
    const files = await Array.fromAsync(new Bun.Glob("*.json").scan(dir));
    const file = join(dir, files[0]);
    const raw = JSON.parse(await readFile(file, "utf8"));
    raw.checks = [{ title: 7 }];
    await writeFile(file, JSON.stringify(raw));
    expect(await new Cache(client, dir).cached(s.ref)).toBeNull();
    raw.checks = [{ title: "pullapprove5", state: "pending", summary: {} }];
    await writeFile(file, JSON.stringify(raw));
    expect(await new Cache(client, dir).cached(s.ref)).toBeNull();
    await writeFile(file, "broken");
    expect(await new Cache(client, dir).cached(s.ref)).toBeNull();
    client.fetch = async () => {
      throw new Error("offline");
    };
    await expect(cache.refresh(s.ref)).rejects.toThrow("offline");
    expect(await cache.cached(s.ref)).toEqual(aged);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("only unmerged PRs become stale after two days, without expiring their data", () => {
  const s = snapshot();
  expect(stale(s, s.fetched + stale_ms - 1)).toBe(false);
  expect(stale(s, s.fetched + stale_ms)).toBe(true);
  expect(stale({ ...s, state: "CLOSED" }, s.fetched + stale_ms)).toBe(true);
  expect(stale({ ...s, state: "MERGED" }, s.fetched + stale_ms * 100)).toBe(false);
});

test("memory and disk caches retain 100 least-recently-used entries across recreation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "corgi-pr-lru-")),
    client = new Client();
  client.fetch = async ref => snapshot(ref.number);
  try {
    const cache = new Cache(client, dir);
    for (let n = 1; n <= cache_size; n++) await cache.refresh(snapshot(n).ref);
    const restored = new Cache(client, dir);
    expect(await restored.cached(snapshot(1).ref)).not.toBeNull();
    await cache.cached(snapshot(1).ref);
    await cache.refresh(snapshot(cache_size + 1).ref);
    expect(await cache.cached(snapshot(2).ref)).toBeNull();
    expect(await new Cache(client, dir).cached(snapshot(2).ref)).toBeNull();
    expect(await new Cache(client, dir).cached(snapshot(1).ref)).not.toBeNull();
    expect(await new Cache(client, dir).cached(snapshot(cache_size + 1).ref)).not.toBeNull();
    expect(await Array.fromAsync(new Bun.Glob("*.json").scan(dir))).toHaveLength(cache_size);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("review threads and replies paginate with resolution state and chronological timestamps", async () => {
  const s = snapshot(),
    calls: string[][] = [];
  const connection = (nodes: unknown[], next: string | null = null) => ({
    nodes,
    pageInfo: { hasNextPage: next !== null, endCursor: next },
  });
  const c = (body: string, at: string) => ({ author: { login: "reviewer" }, body, createdAt: at });
  const client = new Client(async args => {
    calls.push(args);
    if (args[0] === "pr")
      return JSON.stringify({
        ...s,
        isDraft: s.draft,
        headRefOid: s.head,
        baseRefOid: s.base,
        headRefName: s.headBranch,
        baseRefName: s.baseBranch,
      });
    if (args[1] === "graphql") {
      if (args.includes("id=thread-1"))
        return JSON.stringify({ data: { node: { comments: connection([c("reply", "2026-01-03")]) } } });
      const nodes = args.includes("after=thread-page-2")
        ? [{ id: "thread-2", isResolved: false, path: "open.ts", comments: connection([c("open", "2026-01-02")]) }]
        : [
            {
              id: "thread-1",
              isResolved: true,
              path: "done.ts",
              line: null,
              originalLine: 8,
              startLine: null,
              originalStartLine: 7,
              diffSide: "LEFT",
              isOutdated: true,
              comments: connection(
                [
                  {
                    ...c("root", "2026-01-01"),
                    url: "https://github.com/acme/app/pull/12#discussion_r1",
                    diffHunk: "@@ -7,2 +7 @@\n-old\n-more\n+new",
                  },
                ],
                "reply-page-2",
              ),
            },
          ];
      return JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: connection(nodes, args.includes("after=thread-page-2") ? null : "thread-page-2"),
            },
          },
        },
      });
    }
    return "[[]]";
  });
  const result = await client.fetch(s.ref);
  expect(result.threads).toEqual([
    {
      id: "thread-1",
      resolved: true,
      path: "done.ts",
      line: 8,
      startLine: 7,
      side: "LEFT",
      outdated: true,
      comments: [
        {
          author: "reviewer",
          body: "root",
          at: "2026-01-01",
          path: "done.ts",
          url: "https://github.com/acme/app/pull/12#discussion_r1",
          diffHunk: "@@ -7,2 +7 @@\n-old\n-more\n+new",
        },
        { author: "reviewer", body: "reply", at: "2026-01-03", path: "done.ts" },
      ],
    },
    {
      id: "thread-2",
      resolved: false,
      path: "open.ts",
      comments: [{ author: "reviewer", body: "open", at: "2026-01-02", path: "open.ts" }],
    },
  ]);
  expect(calls.some(args => args.includes("commentAfter=reply-page-2"))).toBe(true);
  expect(calls.some(args => args.includes("after=thread-page-2"))).toBe(true);
});

test("retrying a failed check targets only that Actions job, and retry all excludes passed and pending", async () => {
  const s = snapshot(),
    calls: string[][] = [];
  s.draft = true;
  s.checks = [
    { title: "lint", state: "failed", id: "101" },
    { title: "test", state: "failed", id: "102" },
    { title: "passed", state: "passed", id: "103" },
    { title: "pending", state: "pending", id: "104" },
  ];
  const client = new Client(async args => {
    calls.push(args);
    if (args[1] === `repos/${s.ref.repo}/pulls/${s.ref.number}`) return JSON.stringify({ head: { sha: s.head } });
    if (args[1]?.includes("/check-runs/")) {
      const id = args[1].split("/").at(-1);
      return JSON.stringify({
        head_sha: s.head,
        status: "completed",
        conclusion: "failure",
        app: { slug: "github-actions" },
        details_url: `https://github.com/acme/app/actions/runs/42/job/${id}`,
      });
    }
    return "";
  });
  await client.mutate(s, { kind: "retry", check: "101" });
  expect(calls.filter(args => args.includes("POST"))).toEqual([
    ["api", "--method", "POST", "repos/acme/app/actions/jobs/101/rerun"],
  ]);
  calls.length = 0;
  await client.mutate(s, { kind: "retry" });
  expect(calls.filter(args => args.includes("POST"))).toEqual([
    ["api", "--method", "POST", "repos/acme/app/actions/jobs/101/rerun"],
    ["api", "--method", "POST", "repos/acme/app/actions/jobs/102/rerun"],
  ]);
  await expect(client.mutate(s, { kind: "retry", check: "103" })).rejects.toThrow("No retryable failed checks");
});

test("retries reject changed PR heads and changed checks, and rerequest external check runs", async () => {
  const s = snapshot();
  s.checks = [{ title: "lint", state: "failed", id: "101" }];
  for (const changed of ["head", "check-head", "check-state", "none"]) {
    const calls: string[][] = [];
    const client = new Client(async args => {
      calls.push(args);
      if (args[1]?.includes("/pulls/"))
        return JSON.stringify({ head: { sha: changed === "head" ? "c".repeat(40) : s.head } });
      if (args[1]?.includes("/check-runs/"))
        return JSON.stringify({
          head_sha: changed === "check-head" ? "c".repeat(40) : s.head,
          status: "completed",
          conclusion: changed === "check-state" ? "success" : "failure",
          app: { slug: "external-ci" },
          details_url: "https://evil.example/acme/app/actions/runs/42/job/900",
        });
      return "";
    });
    if (changed === "none") {
      await client.mutate(s, { kind: "retry", check: "101" });
      expect(calls.filter(args => args.includes("POST"))).toEqual([
        ["api", "--method", "POST", "repos/acme/app/check-runs/101/rerequest"],
      ]);
    } else {
      await expect(client.mutate(s, { kind: "retry", check: "101" })).rejects.toThrow("changed");
      expect(calls.some(args => args.includes("POST"))).toBe(false);
    }
  }
});

test("stacks traverse ancestors and descendants and avoid old PRs on reused branches", async () => {
  const s = snapshot();
  s.baseBranch = "parent";
  const node = (number: number, title: string, head: string, base: string, state = "open", merged = false) => ({
    number,
    title,
    html_url: `https://github.com/acme/app/pull/${number}`,
    state,
    draft: false,
    merged_at: merged ? "2026-01-01" : null,
    head: { ref: head, repo: { full_name: s.ref.repo } },
    base: { ref: base, repo: { full_name: s.ref.repo } },
  });
  const nodes = [
    node(10, "Foundation", "foundation", "main"),
    node(11, "Parent", "parent", "foundation"),
    node(12, s.title, "topic", "parent"),
    node(13, "First child", "child", "topic"),
    node(14, "Sibling", "sibling", "topic"),
    node(15, "Grandchild", "leaf", "child"),
    node(9, "Old parent", "parent", "main", "closed", true),
  ];
  const calls: string[][] = [];
  const result = await new Client(async args => {
    calls.push(args);
    if (args[0] === "pr")
      return JSON.stringify({
        ...s,
        isDraft: false,
        headRefOid: s.head,
        baseRefOid: s.base,
        headRefName: s.headBranch,
        baseRefName: s.baseBranch,
      });
    if (args[1] === "graphql")
      return JSON.stringify({
        data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } },
      });
    const url = new URL("https://api.github.com/" + args.at(-1));
    const head = url.searchParams.get("head")?.split(":")[1],
      base = url.searchParams.get("base");
    return JSON.stringify([
      nodes.filter(n => (head ? n.head.ref === head : base ? n.base.ref === base && n.state === "open" : false)),
    ]);
  }).fetch(s.ref);
  expect(result.stack.map(p => p.title).sort()).toEqual([
    "First child",
    "Foundation",
    "Grandchild",
    "Parent",
    "Sibling",
  ]);
  const stackQueries = calls.filter(args => args.at(-1)?.includes("/pulls?"));
  expect(new Set(stackQueries.map(args => args.at(-1))).size).toBe(stackQueries.length);
});

test("marking ready targets the displayed PR and rejects closed or already-ready PRs", async () => {
  const calls: string[][] = [],
    client = new Client(async args => {
      calls.push(args);
      return "";
    }),
    s = snapshot();
  await client.mutate({ ...s, draft: true }, { kind: "ready" });
  expect(calls).toEqual([["pr", "ready", s.ref.url]]);
  await expect(client.mutate(s, { kind: "ready" })).rejects.toThrow();
  await expect(client.mutate({ ...s, draft: true, state: "CLOSED" }, { kind: "ready" })).rejects.toThrow();
  expect(calls).toHaveLength(1);
});

test("status-only refresh updates head checks and unresolved count without refetching discussion or stacks", async () => {
  const s = snapshot(),
    calls: string[][] = [];
  const meta = {
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "BLOCKED",
    reviewDecision: "APPROVED",
    autoMergeRequest: {},
    headRefOid: "c".repeat(40),
    baseRefOid: s.base,
    headRefName: s.headBranch,
    baseRefName: s.baseBranch,
  };
  const client = new Client(async args => {
    calls.push(args);
    if (args[0] === "pr") return JSON.stringify(meta);
    if (args[1] === "graphql")
      return JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }], pageInfo: { hasNextPage: false } },
            },
          },
        },
      });
    if (args.some(a => a.includes("check-runs")))
      return JSON.stringify([{ check_runs: [{ name: "test", status: "queued" }] }]);
    return "[[]]";
  });
  const result = await client.status(s);
  expect(result.body).toBe(s.body);
  expect(result.comments).toBe(s.comments);
  expect(result.stack).toBe(s.stack);
  expect(result.head).toBe(meta.headRefOid);
  expect(result.checks).toEqual([{ title: "test", state: "pending" }]);
  expect(result.unresolved).toBe(1);
  expect(result.autoMerge).toBe(true);
  expect(result.fetched).toBe(s.fetched);
  expect(calls.some(a => a.some(v => v.includes("/issues/") || v.includes("/pulls?") || v.includes("/reviews")))).toBe(
    false,
  );
  expect(
    calls
      .flat()
      .filter(a => a.includes("/commits/"))
      .every(a => a.includes(meta.headRefOid)),
  ).toBe(true);
});

test("status-only cache updates retain the full-content staleness timestamp", async () => {
  const dir = await mkdtemp(join(tmpdir(), "corgi-pr-status-")),
    s = snapshot(),
    client = new Client();
  client.fetch = async () => s;
  client.status = async previous => ({ ...previous, unresolved: 3, statusFetched: Date.now() });
  try {
    const cache = new Cache(client, dir);
    await cache.refresh(s.ref);
    await cache.status(s);
    expect((await new Cache(client, dir).cached(s.ref))?.unresolved).toBe(3);
    const cached = (await new Cache(client, dir).cached(s.ref))!;
    expect(cached.fetched).toBe(s.fetched);
    expect(stale(cached, s.fetched + stale_ms)).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("full file content uses the pinned head and the compare merge base for deleted files", async () => {
  const s = snapshot(),
    calls: string[][] = [],
    mergeBase = "c".repeat(40);
  const client = new Client(async args => {
    calls.push(args);
    return args.includes("--jq") ? mergeBase + "\n" : "pinned content\n";
  });
  expect(await client.content(s, "dir/a #?.ts")).toBe("pinned content\n");
  expect(calls[0]).toContain(`repos/acme/app/contents/dir/a%20%23%3F.ts?ref=${s.head}`);
  expect(await client.content(s, "deleted.ts", true)).toBe("pinned content\n");
  expect(calls[1]).toContain(`repos/acme/app/compare/${s.base}...${s.head}`);
  expect(calls[2]).toContain(`repos/acme/app/contents/deleted.ts?ref=${mergeBase}`);
});

test("comments post to the displayed PR and replies use its native review thread", async () => {
  const s = snapshot(),
    calls: string[][] = [];
  s.state = "MERGED";
  s.threads = [{ id: "thread-12", path: "app.ts", resolved: true, comments: [] }];
  const client = new Client(async args => {
    calls.push(args);
    return JSON.stringify({ data: {} });
  });
  const body = "First line\nSecond line with `code` and $literal";
  await client.mutate(s, { kind: "comment", body });
  expect(calls[0]).toEqual(["api", "--method", "POST", "repos/acme/app/issues/12/comments", "-f", "body=" + body]);
  await client.mutate(s, { kind: "comment", body, thread: "thread-12" });
  expect(calls[1][1]).toBe("graphql");
  expect(calls[1]).toContain("thread=thread-12");
  expect(calls[1]).toContain("body=" + body);
  expect(calls[1].join(" ")).toContain("addPullRequestReviewThreadReply");
  await expect(client.mutate(s, { kind: "comment", body: "  " })).rejects.toThrow("Write a comment");
  await expect(client.mutate(s, { kind: "comment", body, thread: "other-pr" })).rejects.toThrow("Thread is no longer");
  expect(calls).toHaveLength(2);
  const failed = new Client(async () => JSON.stringify({ errors: [{ message: "Replies are disabled" }] }));
  await expect(failed.mutate(s, { kind: "comment", body, thread: "thread-12" })).rejects.toThrow(
    "Replies are disabled",
  );
});
test("agent comment context includes saved old-side ranges and numbered code", () => {
  const s = snapshot(),
    comment = {
      author: "reviewer",
      body: "Check this",
      at: "2026-01-01",
      path: "app.ts",
      diffHunk: "@@ -7,2 +7,2 @@\n same\n-old\n+new",
    };
  const thread = {
    id: "t",
    resolved: false,
    path: "app.ts",
    comments: [comment],
    line: 8,
    startLine: 7,
    side: "LEFT" as const,
    outdated: true,
  };
  expect(location(thread)).toBe("app.ts:7-8 (old side) (outdated)");
  expect(commentSnippet(thread)).toEqual(["7  7   same", "8    -old"]);
  const prompt = commentPrompt(s, comment, thread);
  for (const text of [s.ref.url, "File: app.ts:7-8 (old side) (outdated)", "@reviewer", "Check this", "8    -old"])
    expect(prompt).toContain(text);
  expect(commentSnippet({ ...thread, side: "RIGHT", startLine: undefined, outdated: false })).toEqual([
    "7  7   same",
    "8    -old",
    "  8  +new",
  ]);
  expect(commentPrompt(s, { ...comment, path: "", diffHunk: undefined })).not.toContain("Code context");
  expect(commentSnippet({ ...thread, comments: [] })).toEqual([]);
});
