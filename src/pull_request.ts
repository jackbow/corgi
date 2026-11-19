//! GitHub reads and mutations use the user's gh login; no checkout is changed.
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as subprocess from "./subprocess";
import { parse, type Ref } from "./pull_request_ref";
export { parse, type Ref } from "./pull_request_ref";

export const stale_ms = 2 * 24 * 60 * 60 * 1000;
export const cache_size = 100;
export function stale(snapshot: Snapshot, now = Date.now()): boolean {
  return snapshot.state !== "MERGED" && (now < snapshot.fetched || now - snapshot.fetched >= stale_ms);
}
export type CheckState = "pending" | "failed" | "passed";
export interface Check {
  title: string;
  state: CheckState;
  id?: string;
  summary?: string;
}
export interface Comment {
  author: string;
  body: string;
  at: string;
  path: string;
}
export interface Thread {
  id: string;
  resolved: boolean;
  path: string;
  comments: Comment[];
}
export interface Review {
  author: string;
  state: string;
}
export interface StackEntry extends Ref {
  title: string;
  headBranch: string;
  baseBranch: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  draft: boolean;
}
export interface Snapshot {
  ref: Ref;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  draft: boolean;
  mergeable: string;
  mergeState: string;
  decision: string;
  autoMerge: boolean;
  head: string;
  base: string;
  headBranch: string;
  baseBranch: string;
  reviewers: string[];
  reviews: Review[];
  labels: string[];
  comments: Comment[];
  threads: Thread[];
  checks: Check[];
  stack: StackEntry[];
  fetched: number;
  statusFetched?: number;
  unresolved?: number;
}
export function orderedStack(snapshot: Snapshot): StackEntry[] {
  const current: StackEntry = {
    ...snapshot.ref,
    title: snapshot.title,
    headBranch: snapshot.headBranch,
    baseBranch: snapshot.baseBranch,
    state: snapshot.state,
    draft: snapshot.draft,
  };
  const nodes = [current, ...snapshot.stack],
    seen = new Set<string>(),
    result: StackEntry[] = [];
  const visit = (node: StackEntry) => {
    if (seen.has(node.url)) return;
    seen.add(node.url);
    result.push(node);
    for (const child of nodes
      .filter(p => p.url !== node.url && p.baseBranch === node.headBranch)
      .sort((a, b) => a.number - b.number))
      visit(child);
  };
  for (const root of nodes
    .filter(p => !nodes.some(parent => parent.url !== p.url && parent.headBranch === p.baseBranch))
    .sort((a, b) => a.number - b.number))
    visit(root);
  for (const node of nodes) visit(node);
  return result;
}
export function conflictPrompt(snapshot: Snapshot): string {
  return `Resolve merge conflicts for ${snapshot.ref.url} and push the fix to that PR.
Target repository: ${snapshot.ref.repo}; PR head: ${snapshot.head}; head branch: ${snapshot.headBranch}; base branch: ${snapshot.baseBranch}.
Verify the current repository matches the PR before changing anything. If a suitable local checkout cannot be found, stop and ask for its location.
Create an isolated git worktree on a new jb/ branch from the live PR head. Leave existing checkouts and uncommitted work untouched.
Re-fetch the live PR head and its actual base branch; merge that base into the PR head and resolve conflicts carefully. Preserve stacked PR dependencies; do not merge main instead of a stacked base, rebase the stack, or merge the PR itself.
Follow the repository's instructions and run focused tests. Commit the resolution with the trailer Co-authored-by: Codex <codex@openai.com>.
Push HEAD to the PR's original head branch using a normal push, never a force push. Re-fetch PR status to verify the push and report remaining conflicts, checks, and the worktree path. Do not post GitHub comments or mark the PR ready.`;
}
export type Method = "squash" | "merge" | "rebase";
export type Mutation =
  | { kind: "merge" | "enable-auto"; method: Method }
  | { kind: "disable-auto" }
  | { kind: "ready" }
  | { kind: "retry"; check?: string };
export type Run = (args: string[]) => Promise<string>;
export const run: Run = async args => {
  const result = await subprocess.run(["gh", ...args, ...(args[0] === "api" ? ["--hostname", "github.com"] : [])], {
    timeout_ms: 30_000,
    max_output: 16 * 1024 * 1024,
    stderr: true,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat" },
  });
  if (!result.ok()) throw new Error(result.stderr.toString().trim() || "GitHub request failed (is gh signed in?)");
  return result.stdout.toString();
};
const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
const string = (v: unknown): string => (typeof v === "string" ? v : "");
const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const login = (v: unknown): string => string(object(v).login) || "deleted user";
const comment = (v: unknown): Comment => {
  const c = object(v);
  return {
    author: login(c.user),
    body: string(c.body),
    at: string(c.created_at) || string(c.submitted_at),
    path: string(c.path),
  };
};
export function checkState(status: unknown, conclusion: unknown): CheckState {
  if (status !== "completed") return "pending";
  return ["success", "neutral", "skipped"].includes(string(conclusion)) ? "passed" : "failed";
}
const fields =
  "title,body,state,isDraft,mergeable,mergeStateStatus,reviewDecision,autoMergeRequest,headRefOid,baseRefOid,headRefName,baseRefName,reviewRequests,labels";

const identifier = (value: unknown): string | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
function actionJob(value: unknown, repo: string): string | undefined {
  const check = object(value);
  if (object(check.app).slug !== "github-actions") return undefined;
  try {
    const url = new URL(string(check.details_url));
    const prefix = "/" + repo.toLowerCase() + "/actions/runs/";
    if (url.origin !== "https://github.com" || !url.pathname.toLowerCase().startsWith(prefix)) return undefined;
    return /^\d+\/job\/([1-9]\d*)$/.exec(url.pathname.slice(prefix.length))?.[1];
  } catch {
    return undefined;
  }
}
const threadComments =
  "comments(first:100, after:$commentAfter) { nodes { author { login } body createdAt } pageInfo { hasNextPage endCursor } }";
const threadFields = "id isResolved path " + threadComments;
export class Client {
  constructor(readonly execute: Run = run) {}
  private async pages(endpoint: string): Promise<unknown[]> {
    const separator = endpoint.includes("?") ? "&" : "?";
    const raw: unknown = JSON.parse(
      await this.execute(["api", "--paginate", "--slurp", `${endpoint}${separator}per_page=100`]),
    );
    return array(raw).flatMap(array);
  }
  private async graphql(query: string, variables: Record<string, string | number>): Promise<Record<string, unknown>> {
    const response = object(
      JSON.parse(
        await this.execute([
          "api",
          "graphql",
          "-f",
          "query=" + query,
          ...Object.entries(variables).flatMap(([key, value]) => [
            typeof value === "number" ? "-F" : "-f",
            key + "=" + value,
          ]),
        ]),
      ),
    );
    if (array(response.errors).length)
      throw new Error(
        array(response.errors)
          .map(error => string(object(error).message))
          .join("; "),
      );
    return object(response.data);
  }
  private async threads(ref: Ref): Promise<Thread[]> {
    const [owner, name] = ref.repo.split("/");
    const result: Thread[] = [];
    let after = "";
    do {
      const data = await this.graphql(
        "query($owner:String!,$name:String!,$number:Int!,$after:String,$commentAfter:String) { repository(owner:$owner,name:$name) { pullRequest(number:$number) { reviewThreads(first:100,after:$after) { nodes { " +
          threadFields +
          " } pageInfo { hasNextPage endCursor } } } } }",
        { owner, name, number: ref.number, ...(after ? { after } : {}) },
      );
      const connection = object(object(object(data.repository).pullRequest).reviewThreads);
      if (!Array.isArray(connection.nodes)) throw new Error("GitHub did not return review threads");
      for (const value of connection.nodes) {
        const node = object(value),
          id = string(node.id),
          path = string(node.path);
        const comments: Comment[] = [];
        let page = object(node.comments);
        for (;;) {
          comments.push(
            ...array(page.nodes).map(value => {
              const c = object(value);
              return { author: login(c.author), body: string(c.body), at: string(c.createdAt), path };
            }),
          );
          const info = object(page.pageInfo);
          if (!info.hasNextPage) break;
          const commentAfter = string(info.endCursor);
          if (!commentAfter) throw new Error("GitHub returned an invalid comments cursor");
          const next = await this.graphql(
            "query($id:ID!,$commentAfter:String) { node(id:$id) { ... on PullRequestReviewThread { " +
              threadComments +
              " } } }",
            { id, commentAfter },
          );
          page = object(object(next.node).comments);
        }
        result.push({ id, path, resolved: node.isResolved === true, comments });
      }
      const info = object(connection.pageInfo);
      after = info.hasNextPage ? string(info.endCursor) : "";
      if (info.hasNextPage && !after) throw new Error("GitHub returned an invalid threads cursor");
    } while (after);
    return result;
  }
  private async stack(current: StackEntry): Promise<StackEntry[]> {
    const entries = new Map<string, StackEntry>([[current.url, current]]);
    const queries = new Map<string, Promise<unknown[]>>();
    const query = (filter: string) => {
      let pending = queries.get(filter);
      if (!pending) {
        pending = this.pages(`repos/${current.repo}/pulls?${filter}`);
        queries.set(filter, pending);
      }
      return pending;
    };
    const entry = (value: unknown): StackEntry | null => {
      const p = object(value),
        ref = parse(string(p.html_url)),
        head = object(p.head),
        base = object(p.base);
      if (
        !ref ||
        string(object(head.repo).full_name) !== current.repo ||
        string(object(base.repo).full_name) !== current.repo
      )
        return null;
      const headBranch = string(head.ref),
        baseBranch = string(base.ref);
      if (!headBranch || !baseBranch || headBranch === baseBranch) return null;
      return {
        ...ref,
        title: string(p.title),
        headBranch,
        baseBranch,
        draft: p.draft === true,
        state: p.merged_at ? "MERGED" : p.state === "open" ? "OPEN" : "CLOSED",
      };
    };
    let queue = [current];
    while (queue.length) {
      const related = await Promise.all(
        queue.map(async node => {
          const [parents, children] = await Promise.all([
            query("state=all&head=" + encodeURIComponent(current.repo.split("/")[0] + ":" + node.baseBranch)),
            query("state=open&base=" + encodeURIComponent(node.headBranch)),
          ]);
          const candidates = parents
            .map(entry)
            .filter((p): p is StackEntry => p !== null && p.headBranch === node.baseBranch && p.state !== "CLOSED");
          // A reused branch can have historical PRs; prefer its open PR, then the latest merged one.
          candidates.sort((a, b) => Number(b.state === "OPEN") - Number(a.state === "OPEN") || b.number - a.number);
          return [
            ...candidates.slice(0, 1),
            ...children
              .map(entry)
              .filter((p): p is StackEntry => p !== null && p.baseBranch === node.headBranch && p.state === "OPEN"),
          ];
        }),
      );
      queue = [];
      for (const node of related.flat())
        if (!entries.has(node.url)) {
          entries.set(node.url, node);
          queue.push(node);
        }
    }
    return [...entries.values()].filter(p => p.url !== current.url);
  }
  async fetch(ref: Ref): Promise<Snapshot> {
    const endpoint = `repos/${ref.repo}`;
    const meta = object(JSON.parse(await this.execute(["pr", "view", ref.url, "--json", fields])));
    const state = meta.state;
    if (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED")
      throw new Error("GitHub returned an invalid PR state");
    const head = string(meta.headRefOid),
      base = string(meta.baseRefOid);
    if (![head, base].every(sha => /^[a-f0-9]{40,64}$/i.test(sha)))
      throw new Error("GitHub returned an invalid PR revision");
    const [discussion, threads, reviews, checks, stack] = await Promise.all([
      this.pages(`${endpoint}/issues/${ref.number}/comments`),
      this.threads(ref),
      this.pages(`${endpoint}/pulls/${ref.number}/reviews`),
      this.checks(ref, head),
      this.stack({
        ...ref,
        title: string(meta.title),
        headBranch: string(meta.headRefName),
        baseBranch: string(meta.baseRefName),
        state,
        draft: meta.isDraft === true,
      }),
    ]);
    const latestReviews = new Map<string, Review>();
    for (const value of reviews) {
      const r = object(value),
        state = string(r.state);
      if (state !== "COMMENTED" && state !== "PENDING")
        latestReviews.set(login(r.user), { author: login(r.user), state });
    }
    return {
      ref,
      title: string(meta.title),
      body: string(meta.body),
      state,
      draft: meta.isDraft === true,
      mergeable: string(meta.mergeable),
      mergeState: string(meta.mergeStateStatus),
      decision: string(meta.reviewDecision),
      autoMerge: meta.autoMergeRequest != null,
      head,
      base: string(meta.baseRefOid),
      headBranch: string(meta.headRefName),
      baseBranch: string(meta.baseRefName),
      reviewers: array(meta.reviewRequests)
        .map(value => {
          const r = object(value);
          return string(r.login) || string(r.slug) || string(r.name);
        })
        .filter(Boolean),
      labels: array(meta.labels).map(value => string(object(value).name)),
      reviews: [...latestReviews.values()],
      comments: [...discussion.map(comment), ...reviews.filter(value => string(object(value).body)).map(comment)].sort(
        (a, b) => b.at.localeCompare(a.at),
      ),
      threads,
      checks,
      unresolved: threads.filter(t => !t.resolved).length,
      stack,
      fetched: Date.now(),
    };
  }
  private async checks(ref: Ref, head: string): Promise<Check[]> {
    const endpoint = `repos/${ref.repo}`;
    const [runs, statuses] = await Promise.all([
      this.execute([
        "api",
        "--paginate",
        "--slurp",
        `${endpoint}/commits/${head}/check-runs?per_page=100&filter=latest`,
      ]).then(raw => array(JSON.parse(raw)).flatMap(page => array(object(page).check_runs))),
      this.pages(`${endpoint}/commits/${head}/statuses`),
    ]);
    const latestStatuses = new Map<string, Check>();
    for (const value of statuses) {
      const s = object(value),
        title = string(s.context),
        state = string(s.state);
      if (!latestStatuses.has(title))
        latestStatuses.set(title, {
          title,
          ...(/^pullapprove/i.test(title) ? { summary: string(s.description) } : {}),
          state: state === "success" ? "passed" : state === "pending" || state === "expected" ? "pending" : "failed",
        });
    }
    return [
      ...runs.map(value => {
        const c = object(value);
        return {
          title: string(c.name),
          state: checkState(c.status, c.conclusion),
          ...(identifier(c.id) ? { id: identifier(c.id) } : {}),
        };
      }),
      ...latestStatuses.values(),
    ];
  }
  async status(snapshot: Snapshot): Promise<Snapshot> {
    const ref = snapshot.ref;
    const meta = object(
      JSON.parse(
        await this.execute([
          "pr",
          "view",
          ref.url,
          "--json",
          "state,isDraft,mergeable,mergeStateStatus,reviewDecision,autoMergeRequest,headRefOid,baseRefOid,headRefName,baseRefName",
        ]),
      ),
    );
    const state = meta.state,
      head = string(meta.headRefOid),
      base = string(meta.baseRefOid);
    if (
      (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED") ||
      ![head, base].every(sha => /^[a-f0-9]{40,64}$/i.test(sha))
    )
      throw new Error("GitHub returned invalid PR readiness");
    const [checks, threads] = await Promise.all([this.checks(ref, head), this.threadStatus(ref)]);
    return {
      ...snapshot,
      state,
      draft: meta.isDraft === true,
      mergeable: string(meta.mergeable),
      mergeState: string(meta.mergeStateStatus),
      decision: string(meta.reviewDecision),
      autoMerge: meta.autoMergeRequest != null,
      head,
      base,
      headBranch: string(meta.headRefName),
      baseBranch: string(meta.baseRefName),
      checks,
      unresolved: threads,
      statusFetched: Date.now(),
    };
  }
  private async threadStatus(ref: Ref): Promise<number> {
    const [owner, name] = ref.repo.split("/");
    let after = "",
      unresolved = 0;
    do {
      const data = await this.graphql(
        "query($owner:String!,$name:String!,$number:Int!,$after:String) { repository(owner:$owner,name:$name) { pullRequest(number:$number) { reviewThreads(first:100,after:$after) { nodes { isResolved } pageInfo { hasNextPage endCursor } } } } }",
        { owner, name, number: ref.number, ...(after ? { after } : {}) },
      );
      const connection = object(object(object(data.repository).pullRequest).reviewThreads);
      if (!Array.isArray(connection.nodes)) throw new Error("GitHub did not return review threads");
      unresolved += connection.nodes.filter(t => object(t).isResolved !== true).length;
      const info = object(connection.pageInfo);
      after = info.hasNextPage ? string(info.endCursor) : "";
      if (info.hasNextPage && !after) throw new Error("GitHub returned an invalid threads cursor");
    } while (after);
    return unresolved;
  }
  diff(snapshot: Snapshot): Promise<string> {
    return this.execute([
      "api",
      `repos/${snapshot.ref.repo}/compare/${snapshot.base}...${snapshot.head}`,
      "-H",
      "Accept: application/vnd.github.diff",
    ]);
  }
  async content(snapshot: Snapshot, path: string, base = false): Promise<string> {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const ref = base
      ? (
          await this.execute([
            "api",
            `repos/${snapshot.ref.repo}/compare/${snapshot.base}...${snapshot.head}`,
            "--jq",
            ".merge_base_commit.sha",
          ])
        ).trim()
      : snapshot.head;
    if (!/^[a-f0-9]{40,64}$/i.test(ref)) throw Error("GitHub returned an invalid file revision");
    return this.execute([
      "api",
      `repos/${snapshot.ref.repo}/contents/${encoded}?ref=${ref}`,
      "-H",
      "Accept: application/vnd.github.raw+json",
    ]);
  }
  async mutate(snapshot: Snapshot, mutation: Mutation): Promise<void> {
    if (mutation.kind === "retry") {
      const checks = snapshot.checks.filter(
        check => check.state === "failed" && check.id && (mutation.check === undefined || check.id === mutation.check),
      );
      if (!checks.length) throw new Error("No retryable failed checks in this view");
      const endpoint = `repos/${snapshot.ref.repo}`;
      const current = object(JSON.parse(await this.execute(["api", `${endpoint}/pulls/${snapshot.ref.number}`])));
      if (string(object(current.head).sha) !== snapshot.head)
        throw new Error("The PR changed; refresh before retrying checks");
      for (const check of checks) {
        const current = object(JSON.parse(await this.execute(["api", `${endpoint}/check-runs/${check.id}`])));
        if (string(current.head_sha) !== snapshot.head || checkState(current.status, current.conclusion) !== "failed")
          throw new Error("The check changed; refresh before retrying it");
        const job = actionJob(current, snapshot.ref.repo);
        // The Actions job endpoint targets this job rather than the entire workflow.
        await this.execute([
          "api",
          "--method",
          "POST",
          job ? `${endpoint}/actions/jobs/${job}/rerun` : `${endpoint}/check-runs/${check.id}/rerequest`,
        ]);
      }
      return;
    }
    if (mutation.kind === "ready") {
      if (snapshot.state !== "OPEN" || !snapshot.draft) throw new Error("Only open drafts can be marked ready");
      await this.execute(["pr", "ready", snapshot.ref.url]);
      return;
    }
    if (snapshot.state !== "OPEN" || (snapshot.draft && mutation.kind !== "disable-auto"))
      throw new Error("Only open, ready PRs can be merged");
    // Always bind mutations to the displayed head; never silently merge newer code.
    await this.execute([
      "pr",
      "merge",
      snapshot.ref.url,
      "--match-head-commit",
      snapshot.head,
      ...(mutation.kind === "disable-auto" ? ["--disable-auto"] : [`--${mutation.method}`, "--auto"]),
    ]);
  }
}

const cacheWrites = new Map<string, Promise<void>>();
let lastAccess = 0;
export class Cache {
  private memory = new Map<string, Snapshot>();
  private flights = new Map<string, Promise<Snapshot>>();
  constructor(
    readonly client = new Client(),
    readonly directory = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "corgi", "pull-requests"),
  ) {}
  private file(ref: Ref): string {
    return join(this.directory, createHash("sha256").update(ref.url).digest("hex") + ".json");
  }
  async cached(ref: Ref): Promise<Snapshot | null> {
    let snapshot = this.memory.get(ref.url);
    if (!snapshot) {
      try {
        const value: unknown = JSON.parse(await readFile(this.file(ref), "utf8"));
        if (!validSnapshot(value, ref)) return null;
        snapshot = value;
      } catch {
        return null;
      }
    }
    const newer = this.memory.get(ref.url);
    if (newer && newer.fetched > snapshot.fetched) snapshot = newer;
    this.remember(snapshot);
    void this.retain(ref);
    return snapshot;
  }
  refresh(ref: Ref, afterMutation = false): Promise<Snapshot> {
    const pending = this.flights.get(ref.url);
    if (pending) return afterMutation ? pending.catch(() => {}).then(() => this.refresh(ref)) : pending;
    const flight = this.client
      .fetch(ref)
      .then(async snapshot => {
        await this.put(snapshot);
        return snapshot;
      })
      .finally(() => this.flights.delete(ref.url));
    this.flights.set(ref.url, flight);
    return flight;
  }
  async status(snapshot: Snapshot): Promise<Snapshot> {
    const base = await (this.flights.get(snapshot.ref.url) ?? Promise.resolve(snapshot));
    const fresh = await this.client.status(base);
    const latest = this.memory.get(snapshot.ref.url);
    if (latest && latest.fetched > base.fetched) return latest;
    await this.put(fresh);
    return fresh;
  }
  private async put(snapshot: Snapshot): Promise<void> {
    this.remember(snapshot);
    await this.retain(snapshot.ref, snapshot);
  }
  private remember(snapshot: Snapshot): void {
    this.memory.delete(snapshot.ref.url);
    this.memory.set(snapshot.ref.url, snapshot);
    while (this.memory.size > cache_size) this.memory.delete(this.memory.keys().next().value!);
  }
  private async retain(ref: Ref, snapshot?: Snapshot): Promise<void> {
    const work = (cacheWrites.get(this.directory) ?? Promise.resolve()).then(async () => {
      try {
        const file = this.file(ref);
        if (snapshot) {
          await mkdir(this.directory, { recursive: true, mode: 0o700 });
          const temporary = file + `.${process.pid}.${crypto.randomUUID()}.tmp`;
          await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600 });
          await rename(temporary, file);
        }
        const accessed = (lastAccess = Math.max(Date.now(), lastAccess + 1)) / 1000;
        await utimes(file, accessed, accessed);
        const entries = await Promise.all(
          (await readdir(this.directory))
            .filter(name => /^[a-f0-9]{64}\.json$/.test(name))
            .map(async name => {
              const path = join(this.directory, name);
              return { path, accessed: (await stat(path)).mtimeMs };
            }),
        );
        entries.sort((a, b) => b.accessed - a.accessed);
        for (const entry of entries.slice(cache_size)) {
          await rm(entry.path, { force: true });
          for (const [url, value] of this.memory) if (this.file(value.ref) === entry.path) this.memory.delete(url);
        }
      } catch {
        /* The live view still works on a read-only filesystem. */
      }
    });
    cacheWrites.set(this.directory, work);
    await work;
    if (cacheWrites.get(this.directory) === work) cacheWrites.delete(this.directory);
  }
}
function validSnapshot(value: unknown, ref: Ref): value is Snapshot {
  const v = object(value);
  const strings = ["title", "body", "mergeable", "mergeState", "decision", "head", "base", "headBranch", "baseBranch"];
  return (
    object(v.ref).url === ref.url &&
    object(v.ref).repo === ref.repo &&
    object(v.ref).number === ref.number &&
    strings.every(key => typeof v[key] === "string") &&
    [v.head, v.base].every(sha => /^[a-f0-9]{40,64}$/i.test(string(sha))) &&
    ["OPEN", "CLOSED", "MERGED"].includes(string(v.state)) &&
    typeof v.draft === "boolean" &&
    typeof v.autoMerge === "boolean" &&
    (v.unresolved === undefined ||
      (typeof v.unresolved === "number" && Number.isSafeInteger(v.unresolved) && v.unresolved >= 0)) &&
    (v.statusFetched === undefined || (typeof v.statusFetched === "number" && Number.isFinite(v.statusFetched))) &&
    typeof v.fetched === "number" &&
    Number.isFinite(v.fetched) &&
    ["reviewers", "labels"].every(key => Array.isArray(v[key]) && array(v[key]).every(s => typeof s === "string")) &&
    Array.isArray(v.reviews) &&
    v.reviews.every(r => typeof object(r).author === "string" && typeof object(r).state === "string") &&
    Array.isArray(v.comments) &&
    v.comments.every(c => ["author", "body", "at", "path"].every(key => typeof object(c)[key] === "string")) &&
    Array.isArray(v.threads) &&
    v.threads.every(t => {
      const thread = object(t);
      return (
        typeof thread.id === "string" &&
        typeof thread.path === "string" &&
        typeof thread.resolved === "boolean" &&
        Array.isArray(thread.comments) &&
        thread.comments.every(c => ["author", "body", "at", "path"].every(key => typeof object(c)[key] === "string"))
      );
    }) &&
    Array.isArray(v.checks) &&
    v.checks.every(
      c =>
        typeof object(c).title === "string" &&
        (object(c).summary === undefined || typeof object(c).summary === "string") &&
        ["pending", "failed", "passed"].includes(string(object(c).state)) &&
        ["id"].every(key => object(c)[key] === undefined || /^[1-9]\d*$/.test(string(object(c)[key]))),
    ) &&
    Array.isArray(v.stack) &&
    v.stack.every(r => {
      const value = object(r),
        linked = parse(string(value.url));
      return (
        linked?.repo === ref.repo &&
        value.repo === linked.repo &&
        value.number === linked.number &&
        value.url === linked.url &&
        ["title", "headBranch", "baseBranch"].every(key => typeof value[key] === "string") &&
        ["OPEN", "CLOSED", "MERGED"].includes(string(value.state)) &&
        typeof value.draft === "boolean"
      );
    })
  );
}
