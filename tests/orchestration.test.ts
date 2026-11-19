import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { Runtime, EXE } from "./runtime";
import { registerCase, run, shellJoin } from "./support";
import { ORDINARY_PROVIDER, write_executable } from "./provider_sim";

class Orchestration extends Runtime {
  async configure() {
    mkdirSync(this.env.CLAUDE_CONFIG_DIR!, { recursive: true });
  }
  async cli(args: string[], caller?: number) {
    return run([EXE, ...args], { env: { ...this.env, CORGI_PANE: caller ? String(caller) : undefined }, check: false });
  }
  async task(id: number) {
    return (await this.rpc({ op: "task.get", target: `task:${id}` })).task;
  }
  async test_task_listing_works_outside_a_pane_with_optional_workspace_filter() {
    const empty = await this.cli(["task", "list"]);
    this.assertEqual(empty.code, 0, empty.stderr);
    this.assertEqual(empty.stdout, "no tasks\n");
    const started = await this.cli(["run", "--workspace", "1", "--bg", "--json", "--", "/bin/sh", "-c", "sleep 10"]),
      task = JSON.parse(started.stdout).task;
    const listed = await this.cli(["task", "list"]);
    this.assertEqual(listed.code, 0, listed.stderr);
    this.assertIn(`task:${task.id}`, listed.stdout);
    this.assertIn("workspace:1", listed.stdout);
    const filtered = await this.cli(["task", "list", "--workspace", "1", "--json"]);
    this.assertEqual(filtered.code, 0, filtered.stderr);
    this.assertEqual(
      JSON.parse(filtered.stdout).snapshot.tasks.map((t: any) => t.id),
      [task.id],
    );
    const stale = await this.cli(["task", "list"], 999999);
    this.assertEqual(stale.code, 0, stale.stderr);
    const missing = await this.cli(["task", "list", "--workspace", "999999"]);
    this.assertNotEqual(missing.code, 0);
    this.assertIn("NoWorkspace", missing.stderr);
  }
  async test_session_names_work_outside_panes_and_closed_commands_remain_collectable() {
    const started = await this.cli([
        "run",
        "--workspace",
        "1",
        "--name",
        "checks",
        "--bg",
        "--json",
        "--",
        "/bin/sh",
        "-c",
        "sleep 1; printf named-output; exit 7",
      ]),
      task = JSON.parse(started.stdout).task;
    this.assertEqual(started.code, 0, started.stderr);
    const shown = await this.cli(["get", "checks", "--json"]);
    this.assertEqual(shown.code, 0, shown.stderr);
    this.assertEqual(JSON.parse(shown.stdout).session.task.id, `task:${task.id}`);
    const waited = await this.cli(["wait", "checks", "--timeout", "5", "--json"]);
    this.assertEqual(waited.code, 7, waited.stderr);
    this.assertIn("named-output", JSON.parse(waited.stdout).tasks[0].output);
    await this.until(async () => !(await this.panes()).some((p: any) => p.id === task.pane));
    const retained = await this.cli(["wait", `pane:${task.pane}`, "--timeout", "2", "--json"]);
    this.assertEqual(retained.code, 7, retained.stderr);
    this.assertEqual(JSON.parse(retained.stdout).tasks[0].id, task.id);
  }
  async test_foreground_collects_nonzero_exit_output_after_pane_closes() {
    const reply = await this.cli([
        "run",
        "--workspace",
        "1",
        "--name",
        "tests",
        "--json",
        "--",
        "/bin/sh",
        "-c",
        "printf 'collected-output\\n'; exit 7",
      ]),
      result = JSON.parse(reply.stdout);
    this.assertEqual(reply.code, 7, reply.stderr);
    this.assertEqual(result.reason, "exited");
    this.assertIn("collected-output", result.tasks[0].output);
    const task = result.tasks[0];
    await this.until(async () => !(await this.panes()).some((p: any) => p.id === task.pane));
    this.assertEqual((await this.task(task.id)).exit_code, 7);
  }
  async test_timeout_leaves_command_running_and_later_wait_collects_it() {
    const reply = await this.cli([
        "run",
        "--workspace",
        "1",
        "--timeout",
        "0",
        "--json",
        "--",
        "/bin/sh",
        "-c",
        "sleep 1; printf done",
      ]),
      result = JSON.parse(reply.stdout);
    this.assertEqual(reply.code, 124, reply.stderr);
    this.assertEqual(result.reason, "timeout");
    const waited = await this.cli(["wait", `task:${result.tasks[0].id}`, "--timeout", "5", "--json"]);
    this.assertEqual(waited.code, 0, waited.stderr);
    this.assertIn("done", JSON.parse(waited.stdout).tasks[0].output);
  }
  async test_interrupting_foreground_wait_leaves_accepted_work_collectable() {
    const proc = Bun.spawn(
      [EXE, "run", "--workspace", "1", "--timeout", "10", "--", "/bin/sh", "-c", "sleep 1; printf survived"],
      { env: this.env, stdout: "pipe", stderr: "pipe" },
    );
    this.addCleanup(async () => {
      if (proc.exitCode === null) proc.kill();
      await proc.exited;
    });
    const reader = proc.stderr.getReader();
    let text = "";
    while (!text.includes("task:")) {
      const { done, value } = await reader.read();
      if (done) this.fail("foreground run exited before accepting work");
      text += new TextDecoder().decode(value);
    }
    const id = /task:([0-9]+)/.exec(text)![1];
    await this.task(Number(id));
    proc.kill("SIGINT");
    const code = await proc.exited;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    this.assertEqual(code, 130, text);
    const waited = await this.cli(["wait", `task:${id}`, "--timeout", "5", "--json"]);
    this.assertEqual(waited.code, 0, waited.stderr);
    this.assertIn("survived", JSON.parse(waited.stdout).tasks[0].output);
  }
  async test_output_wait_returns_while_program_keeps_running() {
    const started = await this.cli([
        "run",
        "--workspace",
        "1",
        "--bg",
        "--json",
        "--",
        "/bin/sh",
        "-c",
        "sleep 1; printf rea; sleep .2; printf dy; sleep 10",
      ]),
      task = JSON.parse(started.stdout).task;
    const waited = await this.cli(["wait", `task:${task.id}`, "--output", "ready", "--timeout", "5", "--json"]);
    this.assertEqual(waited.code, 0, waited.stderr);
    this.assertEqual(JSON.parse(waited.stdout).reason, "output");
    this.assertEqual((await this.task(task.id)).state, "running");
  }
  async test_live_reload_keeps_exit_status_and_reconnects_the_waiter() {
    const started = await this.cli([
        "run",
        "--workspace",
        "1",
        "--bg",
        "--json",
        "--",
        "/bin/sh",
        "-c",
        "printf before; sleep 2; printf after; exit 9",
      ]),
      task = JSON.parse(started.stdout).task,
      waiter = this.cli(["wait", `task:${task.id}`, "--timeout", "10", "--json"]);
    await this.rpc({ op: "server.reload", executable: EXE });
    const reply = await waiter,
      result = JSON.parse(reply.stdout);
    this.assertEqual(reply.code, 9, reply.stderr);
    this.assertEqual(result.tasks[0].exit_code, 9);
    this.assertIn("before", result.tasks[0].output);
    this.assertIn("after", result.tasks[0].output);
  }
  async test_helper_is_an_ordinary_tab_in_parent_workspace_and_queue_waits_for_completion() {
    const executable = write_executable(
      join(this.temp.name, "claude"),
      ORDINARY_PROVIDER.replaceAll("'ordinary-'+provider", "'ordinary-'+provider+'-'+process.pid"),
    );
    await this.rpc({
      op: "session.command",
      command: { "agent.command": { index: 0, command: shellJoin([executable]) } },
    });
    const parent = (
      await this.rpc({
        op: "session.command",
        command: { "pane.create": { workspace: 1, command: shellJoin([executable]) } },
      })
    ).result.pane;
    await this.until(async () =>
      (await this.panes()).some(
        (p: any) => p.id === parent && p.agent.provider === "claude" && p.agent.session && p.agent.state === "idle",
      ),
    );
    const started = await this.cli(
      ["run", "--agent", "command/1", "--name", "reviewer", "--no-notify", "--bg", "--json", "work"],
      parent,
    );
    this.assertEqual(started.code, 0, started.stderr);
    const first = JSON.parse(started.stdout).task;
    await this.until(async () => (await this.task(first.id)).delivered);
    this.assertEqual(first.workspace, 1);
    this.assertTrue((await this.panes()).some((p: any) => p.id === first.pane));
    const detail = await this.cli(["get", "reviewer", "--json"], parent);
    this.assertEqual(detail.code, 0, detail.stderr);
    this.assertEqual(JSON.parse(detail.stdout).session.parent, `pane:${parent}`);
    this.assertEqual(JSON.parse(detail.stdout).session.task.id, `task:${first.id}`);
    const parentDetail = await this.cli(["get", `pane:${parent}`, "--json"]);
    this.assertTrue(
      JSON.parse(parentDetail.stdout).session.helpers.some((h: any) => h.target === `pane:${first.pane}`),
    );
    const busy = await this.cli(["message", "reviewer", "work", "--json"], parent);
    this.assertNotEqual(busy.code, 0);
    this.assertIn("AgentBusy", busy.stderr);
    const queued = await this.cli(["message", "reviewer", "work", "--busy", "queue", "--json"], parent),
      second = JSON.parse(queued.stdout).task;
    this.assertEqual(second.state, "queued");
    await this.rpc({
      op: "session.command",
      command: { "pane.send": { target: first.pane, text: "stop", enter: true } },
    });
    await this.until(async () => (await this.task(second.id)).delivered);
    this.assertEqual((await this.task(first.id)).state, "completed");
    const news = await this.cli(["wait", "--children", "any", "--timeout", "2", "--json"], parent);
    this.assertEqual(news.code, 0, news.stderr);
    this.assertEqual(JSON.parse(news.stdout).tasks[0].id, first.id);
    await this.rpc({
      op: "session.command",
      command: { "pane.send": { target: first.pane, text: "stop", enter: true } },
    });
    const all = await this.cli(["wait", "--children", "all", "--timeout", "5", "--json"], parent);
    this.assertEqual(all.code, 0, all.stderr);
    this.assertTrue(JSON.parse(all.stdout).tasks.every((t: any) => t.state === "completed"));
    await this.rpc({ op: "session.command", command: { "pane.close": { target: parent } } });
    this.assertTrue((await this.panes()).some((p: any) => p.id === first.pane));
  }
}
registerCase("Orchestration", Orchestration, { inherited: false });
