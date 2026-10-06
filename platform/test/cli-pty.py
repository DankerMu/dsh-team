"""Owned actual-process PTY driver; passwords enter only through JSON stdin and the PTY."""

import errno
import fcntl
import json
import os
import pty
import re
import selectors
import signal
import struct
import subprocess
import sys
import termios
import time


ANSI = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")


def drive(request):
    master = slave = wake_read = wake_write = None
    child = None
    selector = selectors.DefaultSelector()
    captured = bytearray()
    echoes_during = []
    before = after = None
    failure = None
    old_wakeup = None
    old_sigchld = None
    streams = []
    try:
        master, slave = pty.openpty()
        os.set_blocking(master, False)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
        before = termios.tcgetattr(slave)
        before[3] |= termios.ECHO | termios.ICANON
        termios.tcsetattr(slave, termios.TCSANOW, before)
        before = termios.tcgetattr(slave)
        wake_read, wake_write = os.pipe()
        os.set_blocking(wake_read, False)
        os.set_blocking(wake_write, False)
        old_wakeup = signal.set_wakeup_fd(wake_write)
        old_sigchld = signal.signal(signal.SIGCHLD, lambda _signal, _frame: None)
        selector.register(wake_read, selectors.EVENT_READ, "child")
        selector.register(master, selectors.EVENT_READ, "output")

        child = subprocess.Popen(
            [request["node"], request["entrypoint"]] + request["args"],
            cwd=request["cwd"],
            env=request["env"],
            stdin=subprocess.PIPE if request.get("stdinMode") == "pipe" else slave,
            stdout=subprocess.PIPE if request.get("stdoutMode") == "pipe" else slave,
            stderr=slave,
            # Separate owned process group, but no controlling-terminal acquisition: macOS
            # revokes that terminal on session-leader exit, invalidating post-exit termios.
            start_new_session=True,
        )
        if child.stdout is not None:
            streams.append(child.stdout)
            os.set_blocking(child.stdout.fileno(), False)
            selector.register(child.stdout, selectors.EVENT_READ, "output")
        if child.stdin is not None:
            streams.append(child.stdin)
            child.stdin.write(request.get("pipedInput", "").encode("utf-8"))
            child.stdin.close()
        actions = request.get("actions", [])
        next_action = 0
        consumed = 0
        # A prompt that never arrives or a CLI that never exits must fail and be reaped.
        deadline = time.monotonic() + 6
        while True:
            if child.poll() is not None:
                # Keep the slave open for post-exit termios, and drain ready bytes without sleeps.
                ready = selector.select(0)
                if not ready:
                    break
            else:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    failure = "PTY command timed out"
                    break
                ready = selector.select(remaining)
            for key, _mask in ready:
                try:
                    chunk = os.read(key.fd, 65536)
                except OSError as error:
                    if error.errno in (errno.EIO, errno.EBADF):
                        selector.unregister(key.fileobj)
                        continue
                    if error.errno == errno.EAGAIN:
                        continue
                    raise
                if key.data == "child":
                    continue
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                captured.extend(chunk)
                if len(captured) > 1048576:
                    failure = "PTY output exceeded its capture bound"
                    break
            if failure is not None:
                break
            while next_action < len(actions):
                action = actions[next_action]
                prompt = action["prompt"].encode("utf-8")
                found = captured.find(prompt, consumed)
                if found < 0:
                    break
                consumed = found + len(prompt)
                echoes_during.append(bool(termios.tcgetattr(slave)[3] & termios.ECHO))
                if action.get("signal") is not None:
                    os.kill(child.pid, getattr(signal, action["signal"]))
                elif action.get("control") == "EOF":
                    os.write(master, b"\x04")
                elif action.get("control") == "Ctrl-C":
                    # Node's raw readline handles this key byte; no controlling TTY is required.
                    os.write(master, b"\x03")
                else:
                    os.write(master, (action["text"] + "\r").encode("utf-8"))
                next_action += 1
            if child.poll() is not None and next_action < len(actions):
                failure = "PTY command exited before the expected prompt"
                break
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
        child.wait()
        after = termios.tcgetattr(slave)
        text = captured.decode("utf-8", errors="replace")
        visible = ANSI.sub("", text).replace("\r", "")
        secrets = [value for value in request.get("secrets", []) if value]
        leaked = any(value.encode("utf-8") in captured or value in visible for value in secrets)
        for value in sorted(secrets, key=len, reverse=True):
            visible = visible.replace(value, "[redacted]")
        # Return only escape-free, redacted diagnostics; never raw exception/input-bearing output.
        return {
            "exitCode": child.returncode,
            "echoBefore": bool(before[3] & termios.ECHO),
            "echoAfter": bool(after[3] & termios.ECHO),
            "canonicalBefore": bool(before[3] & termios.ICANON),
            "canonicalAfter": bool(after[3] & termios.ICANON),
            "modeRestored": before == after,
            "echoDuring": echoes_during,
            "leakedInput": leaked,
            "output": visible,
            "harnessError": failure,
        }
    finally:
        if child is not None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass  # Only this already-exited, owned process group may be absent.
            child.wait()
        for stream in streams:
            stream.close()
        selector.close()
        if old_wakeup is not None:
            signal.set_wakeup_fd(old_wakeup)
        if old_sigchld is not None:
            signal.signal(signal.SIGCHLD, old_sigchld)
        for descriptor in (master, slave, wake_read, wake_write):
            if descriptor is not None:
                os.close(descriptor)


try:
    result = drive(json.load(sys.stdin))
except Exception:
    # Deliberately omit exception strings/stacks; they can contain supplied arguments or passwords.
    result = {"harnessError": "Python 3 POSIX PTY harness failed"}
print(json.dumps(result, ensure_ascii=True))
