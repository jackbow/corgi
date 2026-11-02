import { test, expect } from "bun:test";
import { resolve, parse } from "./notification_target";
import { Runtime, agent } from "./mirror";

test("notification clicks follow conversations between panes and headless sessions", () => {
  const runtime = new Runtime();
  runtime.panes = [{ id: 2, binding: 4n, agent: agent({ conversation: 17 }) }] as any;
  expect(resolve({ conversation: 17 }, runtime)).toEqual({ pane: 2 });
  runtime.panes[0].agent.conversation = 18;
  expect(resolve({ conversation: 17 }, runtime)).toBeNull();
  runtime.sessions = [{ id: 8, agent: agent({ conversation: 17 }) }] as any;
  expect(resolve({ conversation: 17 }, runtime)).toEqual({ headless: 8 });
  expect(resolve({ pane: 2, binding: 3n }, runtime)).toBeNull();
  expect(resolve({ pane: 2, binding: 4n }, runtime)).toEqual({ pane: 2 });
  expect(resolve({ headless: 8 }, runtime)).toEqual({ headless: 8 });
  expect(resolve({ headless: 9 }, runtime)).toBeNull();
});
test("notification targets reject malformed input and retain large binding generations", () => {
  expect(parse('{"pane":3,"binding":9007199254740993}')).toEqual({ pane: 3, binding: 9007199254740993n });
  for (const value of ["{}", "null", "not json", '{"conversation":0}', '{"conversation":-1}', '{"pane":3}'])
    expect(parse(value)).toBeNull();
});
