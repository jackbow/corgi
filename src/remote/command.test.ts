import { expect, spyOn, test } from "bun:test";
import { command } from "./command";

test("sudo Corgi fails before looking for a different user's runtime", async () => {
  const uid = spyOn(process, "getuid").mockReturnValue(0);
  try {
    for (const op of ["start", "pair", "stop"])
      await expect(command("/nonexistent/root.sock", "/nonexistent/corgi", [op])).rejects.toThrow(
        "Do not run Corgi with sudo",
      );
  } finally {
    uid.mockRestore();
  }
});
