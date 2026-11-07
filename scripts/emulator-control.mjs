// `adb emu avd` talks to the emulator console even when guest execution is paused.
export async function setEmulatorRunning(execute, serial, running) {
  if (!/^emulator-\d+$/.test(serial)) throw new Error("A specific Android emulator serial is required.");
  const command = async (action) => {
    const output = await execute(["-s", serial, "emu", "avd", action]);
    if (!/^OK\s*$/m.test(output) || /^KO\b/m.test(output)) {
      throw new Error(`Android emulator ${action} failed: ${output.trim()}`);
    }
    return output;
  };
  const status = await command("status");
  const current = /\b(running|stopped)\b/i.exec(status)?.[1]?.toLowerCase();
  if (!current) throw new Error(`Could not determine Android emulator state: ${status.trim()}`);
  if ((current === "running") !== running) await command(running ? "start" : "stop");
}
