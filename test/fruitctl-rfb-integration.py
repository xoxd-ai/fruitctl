#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Bounded offline RFB/PNG integration proof; never connects to a desktop.

The fixture binds an ephemeral loopback port, uses RFB 3.8 None authentication
and passes a synthetic credential to the native daemon on descriptor 3. It
checks real LibVNCClient decoding, PNG encoding and input messages. Optional
Node arguments repeat the same checks through the actual stdio MCP entrypoint
and shared broker. A legacy direct MCP route can also be selected explicitly.
These receipts qualify this synthetic fixture only, not macOS Screen Sharing,
TCC, overlay exclusion, a signed distribution or live end-to-end latency.
"""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import select
import socket
import statistics
import stat
import struct
import subprocess
import sys
import threading
import time
import zlib


WIDTH, HEIGHT = 96, 53  # Odd height also detects row/dimension mistakes.
POINTER_COLOR = (251, 17, 199)
SYNTHETIC_CREDENTIAL = b"fruitctl-offline-fixture-only"
PIXEL_FORMAT = struct.Struct("!BBBBHHHBBB3x")
MAX_LINE = 8 * 1024 * 1024
# How a static screen answers FramebufferUpdateRequests (TIN-5509). Only
# "immediate" is the historical fixture behavior; none qualifies Apple.
REQUEST_MODELS = ("immediate", "latest-wins", "first-wins", "session-start-only", "silent",
                  "animating-latest-wins")
# Synthetic hypotheses for Apple's idle-screen behavior, run per request mode.
MODEL_SCENARIOS = ("latest-wins", "first-wins", "session-start-only", "silent")
# Synthetic hypotheses for an animating Apple screen, run per request mode.
STREAMING_SCENARIOS = ("animating-latest-wins",)
# One animation frame of the animating model; far longer than a loopback
# round trip, so a re-arm written behind a full request always arrives first.
ANIMATION_TICK_SECONDS = 0.03
ANIMATION_RECT = (0, 0, 8, 8)
ANIMATION_COLOR = (17, 99, 211)
STREAMING_CAPTURES = 6
STALE_SCREEN_CODE = -32010
INPUT_NOT_READY_CODE = -32013
# Synthetic input settle for the fixture; Apple's default is 3000 ms.
FIXTURE_INPUT_SETTLE_MS = 800
FIXTURE_CAPTURE_TIMEOUT_MS = 1500
FIXTURE_CAPTURE_BUDGET_MS = 600
INPUT_REFUSED_CODE = -32011
# Release-only key-up per modifier before a connection's first input (TIN-6597).
MODIFIER_KEYSYMS = (0xFFE1, 0xFFE2, 0xFFE3, 0xFFE4, 0xFFE9, 0xFFEA, 0xFFE7, 0xFFE8, 0xFFEB, 0xFFEC)
MODIFIER_SYNC = [{"kind": "key", "down": 0, "key": key} for key in MODIFIER_KEYSYMS]
OBSERVATION_UNMET_CODE = -32012
CLIPBOARD_UNAVAILABLE_CODE = -32014
# ExtendedClipboard (rfbproto "Extended Clipboard Pseudo-Encoding"). The
# fixture's "extended" clipboard model advertises text with request, notify
# and provide; "legacy" ignores the pseudo-encoding and uses Latin-1 cut text.
CLIPBOARD_MODELS = ("legacy", "extended")
EXTENDED_CLIPBOARD_ENCODING = -1063131698  # 0xC0A1E5CE as a signed int32
CLIP_TEXT, CLIP_CAPS, CLIP_REQUEST, CLIP_PEEK, CLIP_NOTIFY, CLIP_PROVIDE = 1, 1 << 24, 1 << 25, 1 << 26, 1 << 27, 1 << 28
CLIPBOARD_SCENARIO_TEXT = {"legacy": "caf\u00e9 server", "extended": "Gr\u00fc\u00dfe \u65e5\u672c server"}


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def validate_native_ready(params):
    require(isinstance(params, dict)
            and type(params.get("scaledWidth")) is int and params["scaledWidth"] == WIDTH
            and type(params.get("scaledHeight")) is int and params["scaledHeight"] == HEIGHT,
            "unexpected native ready geometry")
    # Older controllers omit this additive field. Its absence is unknown
    # support; present metadata follows the NativeExecutor capability contract.
    if "capabilities" in params:
        capabilities = params["capabilities"]
        require(isinstance(capabilities, list) and len(capabilities) <= 64
                and all(isinstance(action, str) and re.fullmatch(r"[a-z][a-z0-9_]{0,63}", action)
                        for action in capabilities)
                and len(set(capabilities)) == len(capabilities),
                "invalid native ready capabilities")


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def exact_read(connection, count):
    result = bytearray()
    while len(result) < count:
        part = connection.recv(count - len(result))
        if not part:
            raise EOFError("fixture peer closed")
        result.extend(part)
    return bytes(result)


def marker_color(sequence):
    # Carries the server's full-update ordinal in two lossless PNG channels.
    return (sequence & 255, (sequence >> 8) & 255, 73)


class RfbFixture:
    """Owned loopback RFB server with full/partial/truncated/silent content modes.

    ``silent`` records non-incremental requests but answers none of them.
    A prior complete mirror must not turn this missing response into a fresh
    observation. Each accepted connection has its own request state. A request
    model decides which requests a static screen answers; incremental requests
    are never answered because nothing changes:

    - ``immediate`` (default): every non-incremental request on arrival.
    - ``latest-wins``: only when the newest outstanding request is full.
    - ``first-wins``: the oldest outstanding request absorbs later ones, so a
      full request behind an outstanding incremental waits forever.
    - ``session-start-only``: only the first full request on a connection.
    - ``silent``: nothing.
    - ``animating-latest-wins``: the screen animates (TIN-5509, live on Apple
      while the System Settings search field updates). Every animation tick
      answers whatever is outstanding: an incremental request with a partial
      update of ``ANIMATION_RECT``. A full request that arrives behind
      outstanding incremental ones is first preceded by one update already
      in flight for those. The newest request wins: an incremental request
      that arrives behind a full one absorbs it, and the full request is
      never answered (``absorbedFullRequests``).

    One answer satisfies every request it absorbed. These synthetic models
    pin predicted behaviors; none qualifies any real server.
    """

    def __init__(self, request_model="immediate", clipboard="legacy"):
        require(request_model in REQUEST_MODELS, "invalid fixture request model")
        require(clipboard in CLIPBOARD_MODELS, "invalid fixture clipboard model")
        self.clipboard = clipboard
        # The server's clipboard text. Legacy pushes it after SetEncodings;
        # extended answers a Request with it. A client write replaces it.
        self.server_clipboard = None
        self.extended_caps_sent = 0
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(1)
        self.listener.settimeout(0.25)
        self.port = self.listener.getsockname()[1]
        self.connection = None
        self.lock = threading.Lock()
        self.mode = "full"
        self.request_model = request_model
        self.sequence = 0
        self.frames = {}
        self.events = []
        # Receipt time and connection for each event, kept apart so event
        # records keep their exact historical shape.
        self.event_times = []
        # When ServerInit was sent on each connection (input settle origin).
        self.server_init_times = []
        self.requests = []
        self.animation_frames = 0
        self.absorbed_full_requests = 0
        self.errors = []
        self.connections = []
        self.pointer = None
        self.finished = threading.Event()
        self.stopping = False
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def set_mode(self, mode):
        require(mode in ("full", "partial", "truncated", "silent"), "invalid fixture mode")
        with self.lock:
            self.mode = mode

    def snapshot(self):
        with self.lock:
            return {"frames": dict(self.frames), "events": list(self.events),
                    "eventTimes": list(self.event_times),
                    "serverInitTimes": list(self.server_init_times),
                    "requests": list(self.requests), "errors": list(self.errors),
                    "animationFrames": self.animation_frames,
                    "absorbedFullRequests": self.absorbed_full_requests,
                    "connections": [dict(record) for record in self.connections]}

    def _serve(self):
        deadline = time.monotonic() + 15
        try:
            while not self.stopping:
                try:
                    connection, address = self.listener.accept()
                except socket.timeout:
                    require(self.connections or time.monotonic() < deadline, "no fixture client connected")
                    continue
                self._serve_connection(connection, address)
        except (EOFError, OSError) as error:
            if not self.stopping and not isinstance(error, EOFError):
                with self.lock:
                    self.errors.append(type(error).__name__ + ": " + str(error))
        except Exception as error:
            with self.lock:
                self.errors.append(type(error).__name__ + ": " + str(error))

    @staticmethod
    def _quiet(connection):
        # Let back-to-back client writes arrive before deciding what is newest.
        readable, _, _ = select.select([connection], [], [], 0.005)
        return not readable

    def _answers(self, outstanding, answered_full):
        model = self.request_model
        if model == "latest-wins":
            return outstanding[-1] == 0
        if model == "first-wins":
            return outstanding[0] == 0
        if model == "session-start-only":
            return answered_full == 0 and 0 in outstanding
        return False

    def _serve_connection(self, connection, address):
        with self.lock:
            index = len(self.connections)
            record = {"index": index, "shared": None, "requestModel": self.request_model,
                      "acceptedAt": time.monotonic(), "closedAt": None}
            self.connections.append(record)
        outstanding, answered_full = [], 0  # Per-connection server request state.
        try:
            require(address[0] == "127.0.0.1", "non-loopback fixture peer")
            self.connection = connection
            connection.settimeout(15)
            connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            connection.sendall(b"RFB 003.008\n")
            require(exact_read(connection, 12) == b"RFB 003.008\n", "RFB version mismatch")
            connection.sendall(b"\x01\x01")  # One security type: None.
            require(exact_read(connection, 1) == b"\x01", "None-auth was not selected")
            connection.sendall(struct.pack("!I", 0))
            shared = exact_read(connection, 1)[0]  # ClientInit.shared
            with self.lock:
                record["shared"] = shared
            format_bytes = PIXEL_FORMAT.pack(32, 24, 0, 1, 255, 255, 255, 0, 8, 16)
            name = b"Fruitctl owned offline RFB fixture"
            connection.sendall(struct.pack("!HH", WIDTH, HEIGHT) + format_bytes
                               + struct.pack("!I", len(name)) + name)
            with self.lock:
                self.server_init_times.append({"at": time.monotonic(), "connection": index})
            self.pixel_format = PIXEL_FORMAT.unpack(format_bytes)
            animation = {"inFlight": False, "nextTick": time.monotonic() + ANIMATION_TICK_SECONDS}
            while not self.stopping:
                if self.request_model == "animating-latest-wins":
                    wait = max(0.0, animation["nextTick"] - time.monotonic())
                    readable, _, _ = select.select([connection], [], [], wait)
                    if not readable:
                        animation["nextTick"] = time.monotonic() + ANIMATION_TICK_SECONDS
                        if not self._animate(connection, outstanding, animation):
                            return
                        continue
                kind = exact_read(connection, 1)[0]
                if kind == 0:  # SetPixelFormat
                    payload = exact_read(connection, 19)
                    self.pixel_format = PIXEL_FORMAT.unpack(payload[3:])
                    bits, _, _, true_color, red, green, blue, *_ = self.pixel_format
                    require(bits == 32 and true_color == 1 and (red, green, blue) == (255, 255, 255),
                            "fixture requires the supported 32-bit true-color client format")
                elif kind == 2:  # SetEncodings; raw is universally available.
                    _, count = struct.unpack("!BH", exact_read(connection, 3))
                    require(count <= 1024, "unbounded fixture encoding list")
                    encodings = struct.unpack("!%di" % count, exact_read(connection, count * 4))
                    self._announce_clipboard(connection, EXTENDED_CLIPBOARD_ENCODING in encodings)
                elif kind == 3:  # FramebufferUpdateRequest
                    incremental, x, y, width, height = struct.unpack("!BHHHH", exact_read(connection, 9))
                    require(width > 0 and height > 0 and x + width <= WIDTH and y + height <= HEIGHT,
                            "out-of-bounds framebuffer request")
                    with self.lock:
                        self.requests.append({"incremental": incremental, "at": time.monotonic(),
                                              "connection": index})
                        silent = self.mode == "silent"
                    if not incremental:
                        require((x, y, width, height) == (0, 0, WIDTH, HEIGHT), "non-full capture request")
                    if self.request_model == "immediate":
                        # Incremental requests remain pending, as on an idle server.
                        # Explicit nonincremental requests each supply new pixels,
                        # except in silent mode, which answers nothing.
                        if not incremental and not silent:
                            if not self._update(connection):
                                return
                    else:
                        outstanding.append(incremental)
                elif kind == 4:  # KeyEvent
                    down, key = struct.unpack("!B2xI", exact_read(connection, 7))
                    with self.lock:
                        self.events.append({"kind": "key", "down": down, "key": key})
                        self.event_times.append({"at": time.monotonic(), "connection": index})
                elif kind == 5:  # PointerEvent
                    mask, x, y = struct.unpack("!BHH", exact_read(connection, 5))
                    require(x < WIDTH and y < HEIGHT, "out-of-bounds pointer event")
                    with self.lock:
                        self.pointer = (x, y)
                        self.events.append({"kind": "pointer", "mask": mask, "x": x, "y": y})
                        self.event_times.append({"at": time.monotonic(), "connection": index})
                elif kind == 6:  # ClientCutText (no real clipboard involved).
                    length = struct.unpack("!3xi", exact_read(connection, 7))[0]
                    require(abs(length) <= 1024 * 1024, "unbounded fixture clipboard message")
                    if length >= 0:
                        text = exact_read(connection, length).decode("latin-1")
                        self._record_clipboard(index, {"kind": "clipboard", "bytes": length,
                                                       "encoding": "latin1", "text": text})
                    else:
                        self._extended_clipboard(connection, index, exact_read(connection, -length))
                else:
                    raise AssertionError("unsupported fixture client message type %d" % kind)
                if outstanding and self._quiet(connection) and self._answers(outstanding, answered_full):
                    outstanding.clear()
                    answered_full += 1
                    if not self._update(connection):
                        return
        except (EOFError, OSError) as error:
            # The animating model writes on its own ticks, so a client that
            # disconnects with animation bytes unread resets the connection.
            # That is its normal end, like EOF for the request-driven models.
            peer_reset = (self.request_model == "animating-latest-wins"
                          and isinstance(error, (ConnectionResetError, BrokenPipeError)))
            if not self.stopping and not isinstance(error, EOFError) and not peer_reset:
                with self.lock:
                    self.errors.append(type(error).__name__ + ": " + str(error))
        except Exception as error:
            with self.lock:
                self.errors.append(type(error).__name__ + ": " + str(error))
        finally:
            connection.close()
            with self.lock:
                record["closedAt"] = time.monotonic()
            self.finished.set()

    def _record_clipboard(self, index, event):
        with self.lock:
            self.events.append(event)
            self.event_times.append({"at": time.monotonic(), "connection": index})
            if "text" in event:
                self.server_clipboard = event["text"]

    def _announce_clipboard(self, connection, extended_advertised):
        with self.lock:
            text = self.server_clipboard
        if self.clipboard == "extended" and extended_advertised:
            # Caps: text with request/notify/provide, then its size limit.
            flags = CLIP_CAPS | CLIP_TEXT | CLIP_REQUEST | CLIP_NOTIFY | CLIP_PROVIDE
            connection.sendall(struct.pack("!B3xiII", 3, -8, flags, 1024 * 1024))
            with self.lock:
                self.extended_caps_sent += 1
        elif self.clipboard == "legacy" and text is not None:
            data = text.encode("latin-1")
            connection.sendall(struct.pack("!B3xI", 3, len(data)) + data)

    def _extended_clipboard(self, connection, index, payload):
        require(len(payload) >= 4, "short extended clipboard message")
        flags = struct.unpack("!I", payload[:4])[0]
        require(self.clipboard == "extended" and self.extended_caps_sent and not flags & CLIP_CAPS,
                "extended clipboard message without negotiation")
        if flags & CLIP_PROVIDE:
            require(flags & CLIP_TEXT, "provide without text")
            inflater = zlib.decompressobj()
            data = inflater.decompress(payload[4:], 4 + 1024 * 1024 + 1)
            size = struct.unpack("!I", data[:4])[0]
            require(size == len(data) - 4 and data.endswith(b"\0"), "malformed extended clipboard text")
            text = data[4:-1].decode("utf-8")
            self._record_clipboard(index, {"kind": "clipboard", "bytes": len(text.encode()),
                                           "encoding": "utf8", "text": text})
        elif flags & CLIP_REQUEST:
            require(flags & CLIP_TEXT, "request without text")
            self._record_clipboard(index, {"kind": "clipboard-request"})
            with self.lock:
                text = self.server_clipboard
            data = (text or "").encode("utf-8") + b"\0"
            body = struct.pack("!I", CLIP_PROVIDE | CLIP_TEXT) + zlib.compress(struct.pack("!I", len(data)) + data)
            connection.sendall(struct.pack("!B3xi", 3, -len(body)) + body)
        # Notify (LibVNC sends one before each Provide) needs no answer here.

    def _animate(self, connection, outstanding, animation):
        """One animation tick: answer whatever request is newest."""
        if not outstanding:
            return True
        if outstanding[-1] == 0 and not animation["inFlight"] and 1 in outstanding:
            # An update already in flight for the older incremental requests.
            animation["inFlight"] = True
            outstanding[:] = [request for request in outstanding if request == 0]
            return self._animation_update(connection)
        animation["inFlight"] = False
        if outstanding[-1] == 0:
            outstanding.clear()
            return self._update(connection)
        with self.lock:
            self.absorbed_full_requests += outstanding.count(0)
        outstanding.clear()  # Latest wins: an older full request is absorbed.
        return self._animation_update(connection)

    def _animation_update(self, connection):
        x, y, width, height = ANIMATION_RECT
        with self.lock:
            self.animation_frames += 1
        body = self._pixel(ANIMATION_COLOR) * (width * height)
        connection.sendall(b"\x00\x00" + struct.pack("!H", 1) + struct.pack("!HHHHi", x, y, width, height, 0) + body)
        return True

    def _pixel(self, color):
        _, _, big_endian, _, _, _, _, red_shift, green_shift, blue_shift = self.pixel_format
        value = (color[0] << red_shift) | (color[1] << green_shift) | (color[2] << blue_shift)
        return value.to_bytes(4, "big" if big_endian else "little")

    def _update(self, connection):
        with self.lock:
            self.sequence += 1
            sequence, mode, pointer = self.sequence, self.mode, self.pointer
            self.frames[sequence] = {"mode": mode, "pointer": pointer, "at": time.monotonic()}
        width = WIDTH // 2 if mode == "partial" else WIDTH
        body = bytearray(self._pixel(marker_color(sequence)) * (width * HEIGHT))
        if pointer and pointer[0] < width:
            offset = (pointer[1] * width + pointer[0]) * 4
            body[offset:offset + 4] = self._pixel(POINTER_COLOR)
        header = b"\x00\x00" + struct.pack("!H", 1) + struct.pack("!HHHHi", 0, 0, width, HEIGHT, 0)
        if mode == "truncated":
            connection.sendall(header + body[:len(body) // 2])
            connection.shutdown(socket.SHUT_RDWR)
            return False
        connection.sendall(header + body)
        return True

    def close(self):
        self.stopping = True
        if self.connection:
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        self.listener.close()
        self.thread.join(timeout=3)
        require(not self.thread.is_alive(), "owned fixture thread did not stop")


def paeth(left, up, upper_left):
    estimate = left + up - upper_left
    distances = [abs(estimate - left), abs(estimate - up), abs(estimate - upper_left)]
    return (left, up, upper_left)[distances.index(min(distances))]


def decode_png(data):
    """Strict dependency-free decoder for noninterlaced 8-bit RGB/RGBA PNG."""
    require(data[:8] == b"\x89PNG\r\n\x1a\n", "capture is not PNG")
    offset, header, compressed, ended = 8, None, bytearray(), False
    while offset < len(data):
        require(offset + 12 <= len(data), "truncated PNG chunk")
        length = struct.unpack("!I", data[offset:offset + 4])[0]
        kind = data[offset + 4:offset + 8]
        end = offset + 8 + length
        require(end + 4 <= len(data), "truncated PNG payload")
        payload = data[offset + 8:end]
        crc = struct.unpack("!I", data[end:end + 4])[0]
        require(zlib.crc32(kind + payload) & 0xffffffff == crc, "PNG CRC mismatch")
        if kind == b"IHDR":
            require(header is None and offset == 8 and length == 13, "invalid PNG IHDR")
            header = struct.unpack("!IIBBBBB", payload)
        elif kind == b"IDAT":
            compressed.extend(payload)
        elif kind == b"IEND":
            require(length == 0 and end + 4 == len(data), "invalid PNG IEND")
            ended = True
        offset = end + 4
    require(header and ended, "incomplete PNG")
    width, height, depth, color, compression, filtering, interlace = header
    require(depth == 8 and color in (2, 6) and (compression, filtering, interlace) == (0, 0, 0),
            "unsupported PNG format for this proof")
    require(0 < width <= 3840 and 0 < height <= 3840, "unbounded PNG geometry")
    channels = 3 if color == 2 else 4
    row_bytes = width * channels
    inflater = zlib.decompressobj()
    limit = (row_bytes + 1) * height
    raw = inflater.decompress(bytes(compressed), limit + 1)
    require(len(raw) == limit and inflater.eof and not inflater.unused_data and not inflater.unconsumed_tail,
            "PNG decoded length or zlib stream mismatch")
    previous, pixels = bytearray(row_bytes), bytearray()
    for y in range(height):
        start = y * (row_bytes + 1)
        mode, row = raw[start], bytearray(raw[start + 1:start + row_bytes + 1])
        require(mode <= 4, "unknown PNG scanline filter")
        for i in range(row_bytes):
            left = row[i - channels] if i >= channels else 0
            up = previous[i]
            upper_left = previous[i - channels] if i >= channels else 0
            predictor = (0, left, up, (left + up) // 2, paeth(left, up, upper_left))[mode]
            row[i] = (row[i] + predictor) & 255
        for x in range(width):
            pixels.extend(row[x * channels:x * channels + 3])
        previous = row
    return width, height, bytes(pixels)


class JsonProcess:
    def __init__(self, arguments, *, env=None, pass_fds=()):
        self.process = subprocess.Popen(arguments, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, env=env, pass_fds=pass_fds)
        self.messages = queue.Queue()
        self.stderr = bytearray()
        self.notifications = []
        self.identifier = 0
        self.readers = [threading.Thread(target=self._stdout, daemon=True),
                        threading.Thread(target=self._stderr, daemon=True)]
        for reader in self.readers:
            reader.start()

    def _stdout(self):
        try:
            while True:
                line = self.process.stdout.readline(MAX_LINE + 1)
                if not line:
                    self.messages.put(EOFError("owned process output ended"))
                    return
                require(len(line) <= MAX_LINE and line.endswith(b"\n"), "unbounded or incomplete NDJSON")
                self.messages.put(json.loads(line))
        except Exception as error:
            self.messages.put(error)

    def _stderr(self):
        while True:
            chunk = self.process.stderr.read(4096)
            if not chunk:
                return
            # Contains only fixture/server diagnostics. Keep receipts bounded.
            if len(self.stderr) < 128 * 1024:
                self.stderr.extend(chunk[:128 * 1024 - len(self.stderr)])

    def send(self, message):
        self.process.stdin.write(json.dumps(message, separators=(",", ":")).encode() + b"\n")
        self.process.stdin.flush()

    def response(self, identifier, timeout=12):
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("owned protocol response timed out")
            message = self.messages.get(timeout=remaining)
            if isinstance(message, Exception):
                raise message
            if message.get("id") == identifier:
                return message
            require("id" not in message, "unexpected protocol response identifier")
            self.notifications.append(message)

    def rpc(self, method, params=None):
        self.identifier += 1
        request = {"method": method, "id": self.identifier}
        if params is not None:
            request["params"] = params
        self.send(request)
        return self.response(self.identifier)

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()  # EOF only to our own process tree.
            try:
                self.process.wait(timeout=6)
            except subprocess.TimeoutExpired:
                self.process.terminate()  # Recorded fixture ownership only.
                try:
                    self.process.wait(timeout=4)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=3)
        for reader in self.readers:
            reader.join(timeout=2)
        return self.process.returncode


def run_capture_timeout_scenario(args):
    """--capture-timeout-ms sets the fresh full-capture deadline, and a
    request's deadline_ms budget caps it. Both still fail closed."""
    fixture = RfbFixture()
    session = None
    report = {"transport": "native", "scenario": "capture-timeout", "loopbackPort": fixture.port,
              "status": "failed", "captures": [], "captureTimeoutMilliseconds": FIXTURE_CAPTURE_TIMEOUT_MS,
              "claimedScope": "synthetic-loopback-RFB-only; Apple's mid-update pause is not modeled"}
    try:
        session = NativeSession(args.daemon, fixture.port, ["--capture-timeout-ms", str(FIXTURE_CAPTURE_TIMEOUT_MS)])
        report["route"] = "native-PC"
        sequence, _, _ = inspect_capture(session.action("screenshot"), fixture)
        fixture.set_mode("silent")
        failures = {}
        for name, params, limit in (("flag", {}, FIXTURE_CAPTURE_TIMEOUT_MS),
                                    ("budget", {"deadline_ms": FIXTURE_CAPTURE_BUDGET_MS}, FIXTURE_CAPTURE_BUDGET_MS)):
            start = time.monotonic()
            response = session.action("screenshot", **params)
            elapsed = time.monotonic() - start
            require(response["error"] and not response["image"], "%s: silent server returned pixels" % name)
            error = response["error"]
            require(error.get("code") == STALE_SCREEN_CODE and (error.get("data") or {}).get("reason") == "server_silent",
                    "%s: silent capture is not typed stale_screen server_silent: %r" % (name, error))
            # The budget is stamped at request receipt, so the capture's own
            # remainder may be a few milliseconds shorter than deadline_ms.
            named = re.match(r"No fresh complete framebuffer update within (\d+) ms;", error.get("message", ""))
            require(named and limit - 250 <= int(named.group(1)) <= limit,
                    "%s: deadline message does not name its %d ms deadline: %r" % (name, limit, error.get("message")))
            require(limit / 1000 <= elapsed < limit / 1000 + 2.5,
                    "%s: capture took %.3f s, not its %d ms deadline" % (name, elapsed, limit))
            failures[name] = {"elapsedMilliseconds": round(elapsed * 1000, 3), "deadlineMilliseconds": limit}
        blocked = session.action("key_tap", key="b")
        require(blocked["error"], "failed observation authorized subsequent input")
        require(not [e for e in fixture.snapshot()["events"] if e["kind"] == "key"],
                "input reached the server after the fresh observation failed")
        report["silentCaptures"] = failures
        report["priorCompleteFrameMarker"] = sequence
        report["status"] = "passed"
    except Exception as error:
        report["failure"] = type(error).__name__ + ": " + str(error)
    finally:
        if session:
            report["processExitCode"] = session.close()
            (args.output_dir / "native-capture-timeout.stderr.txt").write_bytes(session.stderr)
        fixture.finished.wait(3)
        fixture.close()
        report["fixtureErrors"] = fixture.snapshot()["errors"]
        if report["status"] == "passed" and (report["fixtureErrors"] or report.get("processExitCode") != 0):
            report["status"] = "failed"
            report["failure"] = "fixture errors %r or nonzero exit %r" % (report["fixtureErrors"],
                                                                          report.get("processExitCode"))
        (args.output_dir / "native-capture-timeout.json").write_text(json.dumps(report, indent=2) + "\n")
    require(report["status"] == "passed", report.get("failure", "fixture failed"))
    return report


class NativeSession(JsonProcess):
    def __init__(self, daemon, port, extra_args=()):
        read_fd, write_fd = os.pipe()
        # The bootstrap preserves descriptor 3 without preexec_fn in a process
        # already running the fixture's server thread. The credential is never
        # placed in argv/environment, and descriptor 0 remains native NDJSON.
        bootstrap = ("import os,sys; fd=int(sys.argv[1]); os.dup2(fd,3); "
                     "os.set_inheritable(3,True); "
                     "os.close(fd) if fd!=3 else None; os.execv(sys.argv[2],sys.argv[2:])")
        env = dict(os.environ)
        env.pop("VNC_PASSWORD", None)
        started = False
        try:
            try:
                super().__init__([sys.executable, "-I", "-c", bootstrap, str(read_fd), str(daemon),
                                  "--host", "127.0.0.1", "--port", str(port), "--password-fd", "3",
                                  "--no-reconnect", "--connect-timeout", "2", *extra_args],
                                 env=env, pass_fds=(read_fd,))
                started = True
                os.close(read_fd)
                read_fd = None
                os.write(write_fd, struct.pack("!I", len(SYNTHETIC_CREDENTIAL)) + SYNTHETIC_CREDENTIAL)
            finally:
                if read_fd is not None:
                    os.close(read_fd)
                os.close(write_fd)
            deadline = time.monotonic() + 12
            while True:
                message = self.messages.get(timeout=max(0.01, deadline - time.monotonic()))
                if isinstance(message, Exception):
                    raise message
                require(time.monotonic() < deadline, "native ready timed out")
                self.notifications.append(message)
                if message.get("method") == "ready":
                    validate_native_ready(message.get("params"))
                    break
        except Exception:
            if started:
                self.close()
            raise

    def action(self, action, **params):
        response = self.rpc(action, params or None)
        if response.get("error"):
            return {"error": response["error"], "image": None, "metadata": {}}
        result = response.get("result", {})
        return {"error": None, "image": result.get("image"), "metadata": result}


class McpSession(JsonProcess):
    def __init__(self, daemon, port, node, source_dir, socket_path=None):
        env = dict(os.environ)
        for key in ("VNC_HOST", "VNC_PORT", "VNC_USERNAME", "VNC_PASSWORD",
                    "CLAUDE_KVM_DAEMON_PATH", "CLAUDE_KVM_DAEMON_PARAMETERS"):
            env.pop(key, None)
        if socket_path:
            command = [str(node), str(source_dir / "bin/fruitctl.mjs"), "mcp",
                       "--target", "fixture", "--socket", str(socket_path)]
        else:
            env.update(VNC_HOST="127.0.0.1", VNC_PORT=str(port),
                       VNC_PASSWORD=SYNTHETIC_CREDENTIAL.decode(),
                       CLAUDE_KVM_DAEMON_PATH=str(daemon),
                       CLAUDE_KVM_DAEMON_PARAMETERS="--no-reconnect --connect-timeout 2")
            command = [str(node), str(source_dir / "index.js")]
        super().__init__(command, env=env)
        try:
            response = self.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {},
                                               "clientInfo": {"name": "fruitctl-offline-fixture", "version": "1"}})
            require(not response.get("error"), "MCP initialize failed")
            self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
            tools = self.rpc("tools/list")
            require(not tools.get("error") and {tool["name"] for tool in tools["result"]["tools"]}
                    == {"vnc_command", "action_queue", "task_complete", "task_failed"},
                    "MCP tool compatibility failed")
        except Exception:
            self.close()
            raise

    def send(self, message):
        super().send({"jsonrpc": "2.0", **message})

    def call_tool(self, name, arguments):
        response = self.rpc("tools/call", {"name": name, "arguments": arguments})
        require(not response.get("error"), "MCP JSON-RPC call failed")
        require(isinstance(response.get("result"), dict), "invalid MCP tool response")
        return response["result"]

    def action(self, action, **params):
        result = self.call_tool("vnc_command", {"action": action, **params})
        images = [part for part in result.get("content", []) if part.get("type") == "image"]
        require(len(images) <= 1, "MCP returned multiple capture images")
        if images:
            require(images[0].get("mimeType") == "image/png", "MCP PNG content type mismatch")
        return {"error": result.get("content") if result.get("isError") else None,
                "image": images[0]["data"] if images else None,
                "metadata": result.get("structuredContent", {})}


class BrokerMcpSession(McpSession):
    """Actual CLI MCP -> actual CLI shared broker -> actual native daemon."""

    def __init__(self, daemon, port, node, source_dir, directory):
        directory.mkdir(mode=0o700)
        self.credential_path = directory / "credential"
        socket_path = directory / "s"
        require(len(str(socket_path).encode()) <= 100, "fixture output path is too long for a Darwin Unix socket")
        credential_fd = os.open(self.credential_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(credential_fd, "wb") as credential:
            credential.write(SYNTHETIC_CREDENTIAL)
        config_path = directory / "config.json"
        config_path.write_text(json.dumps({"schema": "fruitctl.config.v1", "targets": {"fixture": {
            "vnc": {"host": "127.0.0.1", "port": port}, "daemonPath": str(daemon),
            "credentialFile": str(self.credential_path)}}}) + "\n")
        config_path.chmod(0o600)
        self.broker = JsonProcess([str(node), str(source_dir / "bin/fruitctl.mjs"), "broker",
                                   "--config", str(config_path), "--socket", str(socket_path)])
        self.broker_exit_code = None
        self.directory = directory
        try:
            deadline = time.monotonic() + 5
            while not socket_path.exists():
                require(self.broker.process.poll() is None, "owned shared broker failed to start")
                require(time.monotonic() < deadline, "owned shared broker startup timed out")
                time.sleep(0.01)
            require(stat.S_ISSOCK(socket_path.stat().st_mode), "broker did not create a socket")
            require(socket_path.stat().st_mode & 0o077 == 0, "broker socket is not private")
            super().__init__(daemon, port, node, source_dir, socket_path)
        except Exception:
            self._stop_broker()
            raise

    def _stop_broker(self):
        if self.broker.process.poll() is None:
            self.broker.process.terminate()  # Exact recorded fixture child.
        self.broker_exit_code = self.broker.close()
        (self.directory / "broker.stderr.txt").write_bytes(self.broker.stderr)
        self.credential_path.unlink(missing_ok=True)  # Only our synthetic provider.

    def close(self):
        try:
            return super().close()
        finally:
            self._stop_broker()


def inspect_capture(response, fixture, previous_sequence=0, expected_pointer=None):
    require(not response["error"] and response["image"], "capture failed or omitted PNG")
    png = base64.b64decode(response["image"], validate=True)
    width, height, pixels = decode_png(png)
    require((width, height) == (WIDTH, HEIGHT), "PNG geometry mismatch")
    metadata = response["metadata"]
    require((metadata.get("scaledWidth"), metadata.get("scaledHeight"),
             metadata.get("nativeWidth"), metadata.get("nativeHeight")) == (WIDTH, HEIGHT, WIDTH, HEIGHT),
            "capture metadata and PNG dimensions disagree")
    require(all(isinstance(metadata.get(key), int) and metadata[key] > 0
                for key in ("connectionGeneration", "allocation")), "missing native allocation binding")
    # The first pixel could be the input marker; choose another to read ordinal.
    sample = pixels[3:6] if expected_pointer == (0, 0) else pixels[:3]
    require(sample[2] == 73, "PNG background color/channel order mismatch")
    sequence = sample[0] | (sample[1] << 8)
    require(sequence > previous_sequence, "capture reused historical pixels")
    frames = fixture.snapshot()["frames"]
    require(sequence in frames and frames[sequence]["mode"] == "full", "PNG did not come from complete fixture update")
    pointer = frames[sequence]["pointer"]
    if expected_pointer is not None:
        require(pointer == expected_pointer, "captured server state predates coordinate input")
    expected = bytearray(marker_color(sequence) * (width * height))
    if pointer is not None:
        offset = (pointer[1] * width + pointer[0]) * 3
        expected[offset:offset + 3] = bytes(POINTER_COLOR)
    require(pixels == bytes(expected), "PNG pixels are incomplete, displaced or different from fixture state")
    return sequence, png, metadata


def exercise_native_input_parity(session, fixture, sequence):
    """TIN-6597 wire checks on the native PC route; returns the new marker.

    triple_click, a modifier click, a right-button drag, hold_key and
    cursor_position, then D27 holds: refused without a batch scope, held
    across a move, force-released by a request from outside the batch, and
    released by release_holds. hold_scope is the executor's private field.
    """
    def pointer(mask, x, y):
        return {"kind": "pointer", "mask": mask, "x": x, "y": y}

    def key(down, keysym):
        return {"kind": "key", "down": down, "key": keysym}

    def ok(action, **params):
        response = session.action(action, **params)
        require(not response["error"], "%s failed: %r" % (action, response["error"]))
        return response

    start = len(fixture.snapshot()["events"])
    ok("triple_click", x=5, y=6)
    ok("mouse_click", x=7, y=8, modifiers=["shift", "cmd"])
    ok("mouse_drag", x=1, y=1, toX=20, toY=10, button="right")
    ok("hold_key", key="a", duration_ms=150)
    position = ok("cursor_position")["metadata"]
    require((position.get("x"), position.get("y")) == (20, 10), "cursor_position is not the tracked position")
    refused = session.action("mouse_down", x=3, y=3)
    require(isinstance(refused["error"], dict) and refused["error"].get("code") == INPUT_REFUSED_CODE
            and (refused["error"].get("data") or {}).get("reason") == "hold_outside_batch",
            "unscoped mouse_down was not a typed refusal: %r" % refused["error"])
    ok("mouse_down", x=2, y=3, hold_scope="fixture-batch-1")
    ok("mouse_move", x=9, y=9, hold_scope="fixture-batch-1")
    ok("mouse_up", hold_scope="fixture-batch-1")
    ok("mouse_down", x=4, y=4, button="middle", hold_scope="fixture-batch-2")
    ok("wait", ms=50)  # outside batch 2: its hold is force-released first
    ok("mouse_down", x=5, y=5, hold_scope="fixture-batch-3")
    released = ok("release_holds", hold_scope="fixture-batch-3")["metadata"]
    require(released.get("detail") == "released", "release_holds did not report a released hold")
    # A later complete frame orders the server's processing of every event above.
    sequence, _, _ = inspect_capture(session.action("screenshot"), fixture, sequence, (5, 5))
    snapshot = fixture.snapshot()
    events, times = snapshot["events"][start:], snapshot["eventTimes"][start:]
    click = [pointer(1, 5, 6), pointer(0, 5, 6)]
    require(events[:6] == click * 3, "triple_click wire mismatch: %r" % events[:6])
    require(events[6:12] == [key(1, 0xFFE1), key(1, 0xFFE7), pointer(1, 7, 8), pointer(0, 7, 8),
                             key(0, 0xFFE7), key(0, 0xFFE1)], "modifier click wire mismatch: %r" % events[6:12])
    drag = events[12:26]
    require(drag[0] == pointer(0, 1, 1) and drag[1] == pointer(4, 1, 1) and drag[-2:] == [pointer(4, 20, 10),
            pointer(0, 20, 10)] and all(event["kind"] == "pointer" and event["mask"] == 4 for event in drag[1:-1]),
            "right drag wire mismatch: %r" % drag)
    require(events[26:28] == [key(1, ord("a")), key(0, ord("a"))], "hold_key wire mismatch: %r" % events[26:28])
    require(times[27]["at"] - times[26]["at"] >= 0.12, "hold_key released before its duration")
    require(events[28:] == [pointer(1, 2, 3), pointer(1, 9, 9), pointer(0, 9, 9),
                            pointer(2, 4, 4), pointer(0, 4, 4), pointer(1, 5, 5), pointer(0, 5, 5)],
            "batch-scoped hold wire mismatch: %r" % events[28:])
    return sequence


def run_scenario(kind, mode, count, args):
    fixture = RfbFixture()
    session = None
    report = {"transport": kind, "scenario": mode, "loopbackPort": fixture.port,
              "status": "failed", "captures": [], "claimedScope": "synthetic-loopback-RFB-only"}
    try:
        if kind == "native":
            session = NativeSession(args.daemon, fixture.port)
        elif args.mcp_route == "shared-broker":
            session = BrokerMcpSession(args.daemon, fixture.port, args.node, args.source_dir,
                                       args.output_dir / ("b-" + mode))
        else:
            session = McpSession(args.daemon, fixture.port, args.node, args.source_dir)
        report["route"] = "native-PC" if kind == "native" else args.mcp_route
        sequence, _, binding = inspect_capture(session.action("screenshot"), fixture)
        if mode == "full":
            latencies = []
            for i in range(count):
                # Deterministic distinct coordinates, including every boundary.
                point = ((i * 17) % WIDTH, (i * 13) % HEIGHT)
                if i == count - 1:
                    point = (WIDTH - 1, HEIGHT - 1)
                moved = session.action("mouse_move", x=point[0], y=point[1])
                require(not moved["error"], "coordinate input failed")
                start = time.monotonic()
                response = session.action("screenshot")
                elapsed = (time.monotonic() - start) * 1000
                sequence, png, metadata = inspect_capture(response, fixture, sequence, point)
                require((metadata["connectionGeneration"], metadata["allocation"]) ==
                        (binding["connectionGeneration"], binding["allocation"]), "unexpected capture allocation change")
                latencies.append(elapsed)
                filename = "%s-%s-%03d.png" % (kind, mode, i + 1)
                (args.output_dir / filename).write_bytes(png)
                report["captures"].append({"ordinal": i + 1, "serverMarker": sequence,
                                           "pointer": list(point), "pngSha256": hashlib.sha256(png).hexdigest(),
                                           "file": filename, "latencyMilliseconds": round(elapsed, 3)})
            require(not session.action("mouse_click", x=WIDTH - 1, y=HEIGHT - 1)["error"], "click failed")
            require(not session.action("key_tap", key="a")["error"], "key tap failed")
            # A subsequent fresh frame orders server processing after input.
            inspect_capture(session.action("screenshot"), fixture, sequence, (WIDTH - 1, HEIGHT - 1))
            events = fixture.snapshot()["events"]
            pointer_events = [event for event in events if event["kind"] == "pointer"]
            require(any(event["mask"] == 1 and (event["x"], event["y"]) == (WIDTH - 1, HEIGHT - 1)
                        for event in pointer_events), "button press was not transmitted")
            require(pointer_events[-1]["mask"] == 0, "button was not released")
            require(events[:len(MODIFIER_SYNC)] == MODIFIER_SYNC,
                    "first input was not preceded by the release-only modifier sync")
            key_events = [event for event in events if event["kind"] == "key"]
            require(key_events == MODIFIER_SYNC + [{"kind": "key", "down": 1, "key": ord("a")},
                                                   {"kind": "key", "down": 0, "key": ord("a")}],
                    "key press/release roundtrip mismatch")
            report["fixtureCaptureLatencyMilliseconds"] = {
                "p50": round(statistics.median(latencies), 3),
                "p95": round(sorted(latencies)[max(0, (95 * len(latencies) + 99) // 100 - 1)], 3),
                "max": round(max(latencies), 3), "scope": "loopback fixture; not a live product SLO"}
            report["coordinateRoundtrips"] = count
            report["buttonAndKeyReleaseRoundtrip"] = "passed"
            if kind == "native":
                sequence = exercise_native_input_parity(session, fixture, sequence)
                report["nativeInputParity"] = "passed"
            if kind == "mcp":
                queue_point = (11, 13)
                queued = session.call_tool("action_queue", {"actions": [{"action": "mouse_move",
                    "x": queue_point[0], "y": queue_point[1]}, {"action": "wait", "ms": 50}]})
                # D7: the raw VNC route labels every result, including batches.
                require(not queued.get("isError") and queued.get("structuredContent")
                        == {"completed": 2, "route": "raw", "indicator": "absent"},
                        "MCP action_queue did not acknowledge both actions with raw route labels")
                inspect_capture(session.action("screenshot"), fixture, sequence, queue_point)
                summary = "Offline fixture complete"
                completed = session.call_tool("task_complete", {"summary": summary})
                require(not completed.get("isError") and completed.get("content") == [{"type": "text", "text": summary}],
                        "MCP task_complete did not acknowledge ownership release")
                require(fixture.finished.wait(3), "task_complete acknowledged before owned native connection closed")
                # The failed-task ownership-release path is tested while active
                # in its own scenario; this also checks harmless repeat release.
                failed_task = session.call_tool("task_failed", {"reason": "Offline fixture deliberate task failure"})
                require(failed_task.get("isError") is True, "MCP task_failed lost its compatible error marker")
                report["mcpTools"] = {"vnc_command": "passed", "action_queue": "passed",
                                      "task_complete": "passed; active ownership released",
                                      "task_failed": "passed; repeated release"}
        elif mode == "silent":
            require(kind == "native", "silent scenario uses the native route")
            combo = session.action("key_combo", keys=["alt", "cmd", "n"])
            require(not combo["error"], "alt+cmd+n combo failed")
            # A local write acknowledgment need not mean the server has read
            # the key events. A later full response orders its processing.
            sequence, _, _ = inspect_capture(session.action("screenshot"), fixture, sequence)
            key_events = [(event["down"], event["key"]) for event in fixture.snapshot()["events"]
                          if event["kind"] == "key"]
            # This fixture is not Apple's server, so names keep portable keysyms:
            # Option (Alt_L) first down and last up, Command (Meta_L) inside it.
            # The connection's release-only modifier sync precedes the combo.
            require(key_events == [(0, key) for key in MODIFIER_KEYSYMS] +
                    [(1, 0xFFE9), (1, 0xFFE7), (1, 0x6E), (0, 0x6E), (0, 0xFFE7), (0, 0xFFE9)],
                    "alt+cmd+n wire order/keysyms mismatch: %r" % key_events)
            fixture.set_mode("silent")
            start = time.monotonic()
            response = session.action("screenshot")
            elapsed = time.monotonic() - start
            require(response["error"] and not response["image"],
                    "silent server returned cached pixels as a fresh capture")
            require(isinstance(response["error"], dict) and
                    "No fresh complete framebuffer update within 5 seconds" in response["error"].get("message", ""),
                    "silent capture failed for a reason other than its original deadline")
            require(5.0 <= elapsed < 10.0, "silent capture did not retain its bounded five-second deadline")
            requests = [request for request in fixture.snapshot()["requests"] if request["at"] >= start]
            full = [request for request in requests if not request["incremental"]]
            require(len(full) == 1, "silent capture must send exactly one non-incremental request")
            # This interval is wholly inside the original five-second budget.
            # Requests after waiter retirement may resume ordinary pacing.
            superseding = [request for request in requests
                           if request["incremental"] and full[0]["at"] < request["at"] < start + 4.0]
            require(not superseding, "incremental requests superseded the outstanding full request")
            blocked = session.action("key_tap", key="b")
            require(blocked["error"], "failed observation authorized subsequent input")
            require([(event["down"], event["key"]) for event in fixture.snapshot()["events"]
                     if event["kind"] == "key"] == key_events,
                    "input reached the server after the fresh observation failed")
            report["silentCaptureRefusal"] = {"error": response["error"], "elapsedMilliseconds": round(elapsed * 1000, 3),
                                              "nonIncrementalRequests": len(full), "priorCompleteFrameMarker": sequence,
                                              "imageReturned": False, "subsequentInputRefused": True}
            report["optionCommandComboKeyEvents"] = key_events
        elif mode == "task-failed":
            require(kind == "mcp", "task-failed scenario requires MCP")
            reason = "Offline fixture deliberate active task failure"
            failed_task = session.call_tool("task_failed", {"reason": reason})
            require(failed_task.get("isError") is True and
                    failed_task.get("content") == [{"type": "text", "text": reason}],
                    "MCP task_failed response mismatch")
            require(fixture.finished.wait(3), "task_failed acknowledged before owned native connection closed")
            report["taskFailedOwnershipRelease"] = "passed while active"
        else:
            fixture.set_mode(mode)
            start = time.monotonic()
            failed = session.action("screenshot")
            elapsed = time.monotonic() - start
            require(failed["error"] and not failed["image"], "incomplete framebuffer returned a successful image")
            require(elapsed < 10, "incomplete capture was not refused within bounded deadline")
            modes = [frame["mode"] for frame in fixture.snapshot()["frames"].values()]
            require(mode in modes, "fixture never transmitted the intended incomplete update")
            report["refusal"] = {"error": failed["error"], "elapsedMilliseconds": round(elapsed * 1000, 3),
                                  "imageReturned": False, "priorCompleteFrameMarker": sequence}
        require(not fixture.snapshot()["errors"], "fixture protocol errors: %r" % fixture.snapshot()["errors"])
        report["status"] = "passed"
    except Exception as error:
        report["failure"] = type(error).__name__ + ": " + str(error)
        raise
    finally:
        if session:
            report["processExitCode"] = session.close()
            if kind == "mcp" and args.mcp_route == "shared-broker":
                report["brokerExitCode"] = session.broker_exit_code
            if report["status"] == "passed" and (report["processExitCode"] != 0 or report.get("brokerExitCode", 0) != 0):
                report["status"] = "failed"
                report["failure"] = "owned process cleanup was not acknowledged with zero exit"
            (args.output_dir / (kind + "-" + mode + ".stderr.txt")).write_bytes(session.stderr)
        fixture.close()
        snapshot = fixture.snapshot()
        report["serverFrames"] = len(snapshot["frames"])
        report["inputEvents"] = snapshot["events"]
        report["fixtureErrors"] = snapshot["errors"]
        (args.output_dir / (kind + "-" + mode + ".json")).write_text(json.dumps(report, indent=2) + "\n")
    require(report["status"] == "passed", report.get("failure", "fixture failed"))
    return report


WIRE_LINE = re.compile(r"^\[RFB-WIRE\] ms=(\d+) dir=c2s type=(\d+|input) incremental=([01-]) length=(\d+|-) "
                       r"origin=(bridge|libvnc-init|libvnc-rearm|suppressed)(?: kinds=([0-7](?:,[0-7])*))?$")


def wire_ledger(stderr):
    """Parse the daemon's header-only ledger; it must never carry payloads."""
    entries = []
    for line in bytes(stderr).decode("utf-8", errors="replace").splitlines():
        if line.startswith("[RFB-WIRE]"):
            match = WIRE_LINE.match(line)
            require(match, "malformed wire ledger line")
            coalesced = match.group(2) == "input"
            # Input is coalesced: no count, length or per-message timing.
            require(coalesced == (match.group(4) == "-") == (match.group(6) is not None)
                    and (not coalesced or match.group(3) == "-"), "malformed wire ledger input line")
            entries.append({"ms": int(match.group(1)),
                            "type": "input" if coalesced else int(match.group(2)),
                            "incremental": match.group(3),
                            "length": None if coalesced else int(match.group(4)),
                            "origin": match.group(5), "kinds": match.group(6)})
    return entries


OBSERVATION_METHODS = ("screenshot", "cursor_crop", "diff_check", "set_baseline", "detect_elements")


def require_provenance(metadata, request_mode, method):
    """Each fresh observation states how its pixels were obtained."""
    provenance = metadata.get("provenance")
    require(isinstance(provenance, dict), "%s omitted capture provenance" % method)
    require(set(provenance) == {"source", "coverage", "request_mode", "requests", "prior_unanswered_requests",
                                "ordered_after_prior_input", "elapsed_ms", "elicited_input"},
            "%s provenance fields %r" % (method, sorted(provenance)))
    require(provenance["source"] == "in_session" and provenance["coverage"] == "complete_received_after_request"
            and provenance["request_mode"] == request_mode and provenance["elicited_input"] is None,
            "%s provenance %r" % (method, provenance))
    requests, prior = provenance["requests"], provenance["prior_unanswered_requests"]
    require(isinstance(requests, dict) and requests.get("full", 0) >= 1, "%s provenance requests" % method)
    require(isinstance(prior, dict) and set(prior) == {"full", "incremental"}
            and all(isinstance(value, int) and value >= 0 for value in prior.values()),
            "%s prior unanswered requests %r" % (method, prior))
    # Ordering is claimed only when nothing was outstanding at admission. On
    # demand, after an answered connect request with no leak, nothing is. In
    # stream mode a re-arm or poll usually is; a capture admitted right after
    # another, before the stream resumes, may find nothing outstanding, and
    # then claims ordering exactly as on demand (no fixture leaks a re-arm).
    if request_mode == "on-demand":
        require(requests.get("incremental") == 0, "%s on-demand capture wrote incremental requests" % method)
        require(prior == {"full": 0, "incremental": 0} and provenance["ordered_after_prior_input"] is True,
                "%s on-demand ordering %r" % (method, provenance))
    else:
        require(provenance["ordered_after_prior_input"] is (prior == {"full": 0, "incremental": 0}),
                "%s stream mode ordering disagrees with outstanding requests %r" % (method, provenance))
    return provenance


def run_observation_v2(session, request_mode, windows):
    """zoom, region diff and stability over fresh captures only (TIN-6598).

    Every fixture update carries a new marker color, so two fresh frames
    always differ everywhere. A reused or cached frame would compare equal.
    """
    def timed(method, **params):
        start = time.monotonic()
        response = session.action(method, **params)
        windows.append((start, time.monotonic()))
        return response, time.monotonic() - start

    region = {"x": 8, "y": 5, "width": 20, "height": 11}
    response, _ = timed("zoom", **region)
    require(not response["error"] and response["image"], "zoom failed: %r" % (response["error"],))
    width, height, pixels = decode_png(base64.b64decode(response["image"], validate=True))
    zoom = response["metadata"].get("zoom") or {}
    require((width, height) == (20, 11) and zoom == {"region": region, "native": region,
                                                      "image_width": 20, "image_height": 11},
            "zoom geometry %r" % (zoom,))
    require(pixels[2] == 73 and pixels == pixels[:3] * (width * height), "zoom pixels are not one fresh marker")
    require_provenance(response["metadata"], request_mode, "zoom")

    timed("set_baseline")
    left = {"x": 8, "y": 5, "width": 10, "height": 11}
    response, _ = timed("diff_check", regions=[region], ignore=[left])
    diff = response["metadata"].get("diff")
    require(not response["error"] and response["metadata"].get("detail") == "changeDetected: true",
            "diff_check failed: %r" % (response["error"],))
    require(diff == {"changed": True, "changed_ratio": 1, "changed_pixels": 110, "compared_pixels": 110,
                     "boxes": [{"x": 18, "y": 5, "width": 10, "height": 11}], "boxes_truncated": False,
                     "baseline": "matched"}, "region diff %r" % (diff,))
    require_provenance(response["metadata"], request_mode, "diff_check")

    # Ignoring the whole display compares nothing: stable from fresh captures.
    response, _ = timed("wait_for_stable", stable_ms=200, timeout_ms=3000,
                        ignore=[{"x": 0, "y": 0, "width": WIDTH, "height": HEIGHT}])
    stable = response["metadata"].get("stable") or {}
    require(not response["error"] and stable.get("stable_for_ms", 0) >= 200 and stable.get("captures", 0) >= 2,
            "wait_for_stable did not settle: %r %r" % (response["error"], stable))
    require_provenance(response["metadata"], request_mode, "wait_for_stable")

    # Unmasked, every fresh frame differs: a typed timeout, never a cached frame.
    response, elapsed = timed("wait_for_stable", stable_ms=200, timeout_ms=600)
    error = response["error"] or {}
    data = error.get("data") or {}
    require(error.get("code") == OBSERVATION_UNMET_CODE and data.get("reason") == "stable_timeout"
            and data.get("captures", 0) >= 2 and not response["image"],
            "changing screen did not time out as stable_timeout: %r" % (error,))
    require(0.6 <= elapsed < 6.0, "stable_timeout ignored its bound: %.3fs" % elapsed)

    # The failed wait revoked input authorization. Image-less checks may keep
    # one but never grant one, so input stays refused and never reaches the
    # server (this scenario must stay input-free).
    for method, params in (("expect_baseline", {}),
                           ("wait_for_stable", {"stable_ms": 50, "timeout_ms": 1000,
                                                "ignore": [{"x": 0, "y": 0, "width": WIDTH, "height": HEIGHT}]})):
        response, _ = timed(method, **params)
        require(not response["error"], "%s failed: %r" % (method, response["error"]))
        blocked = session.action("mouse_move", x=1, y=1)
        require(blocked["error"] and "Observed display changed" in blocked["error"].get("message", ""),
                "%s granted input authorization from a frame the caller never saw: %r" % (method, blocked["error"]))
    return {"zoom": zoom, "diff": diff, "stable": stable,
            "stableTimeout": {"code": error["code"], "reason": data["reason"], "captures": data["captures"],
                              "elapsedMilliseconds": round(elapsed * 1000, 3)}}


def run_model_scenario(model, request_mode, args):
    """One synthetic Apple idle-screen hypothesis against one request mode."""
    name = model + "-" + request_mode
    fixture = RfbFixture(request_model=model)
    session = None
    # latest-wins answers the newest full request; first-wins needs no
    # request outstanding before the capture's own. The other models never
    # answer an in-session request and must end in a typed failure.
    expect_fresh = model == "latest-wins" or (model == "first-wins" and request_mode == "on-demand")
    report = {"transport": "native", "scenario": name, "requestModel": model, "requestMode": request_mode,
              "expectFresh": expect_fresh, "loopbackPort": fixture.port, "status": "failed", "captures": [],
              "claimedScope": "synthetic-loopback-RFB-only; not a model of any qualified server"}
    windows = []
    try:
        flags = ["--rfb-wire-ledger"]
        if request_mode != "stream":
            flags += ["--rfb-request-mode", request_mode]
        session = NativeSession(args.daemon, fixture.port, flags)
        report["route"] = "native-PC"
        time.sleep(0.3)  # an idle desktop: connect-time exchange and stream polls settle
        sequence = 0
        for ordinal in range(3 if expect_fresh else 1):
            start = time.monotonic()
            response = session.action("screenshot")
            elapsed = time.monotonic() - start
            windows.append((start, time.monotonic()))
            if expect_fresh:
                sequence, png, metadata = inspect_capture(response, fixture, sequence)
                provenance = require_provenance(metadata, request_mode, "screenshot")
                report["captures"].append({"ordinal": ordinal + 1, "serverMarker": sequence,
                                           "pngSha256": hashlib.sha256(png).hexdigest(),
                                           "provenance": provenance,
                                           "latencyMilliseconds": round(elapsed * 1000, 3)})
                time.sleep(0.2)
                continue
            error = response["error"]
            require(error and not response["image"], "%s returned pixels without a fresh answer" % name)
            require(error.get("code") == STALE_SCREEN_CODE, "%s failure is not typed stale_screen" % name)
            require(error.get("message", "").startswith("No fresh complete framebuffer update within 5 seconds"),
                    "%s stale_screen lost its compatible message prefix" % name)
            data = error.get("data") or {}
            require(data.get("reason") == "server_silent", "%s reason %r" % (name, data.get("reason")))
            require(isinstance(data.get("diagnostics"), dict), "%s stale_screen omitted diagnostics" % name)
            require(5.0 <= elapsed < 10.0, "%s did not keep its five-second deadline" % name)
            report["staleScreen"] = {"code": error["code"], "reason": data["reason"],
                                     "unansweredFullRequests": data["diagnostics"].get("unanswered_full_requests"),
                                     "autoRearmObserved": data["diagnostics"].get("auto_rearm_observed"),
                                     "elapsedMilliseconds": round(elapsed * 1000, 3), "imageReturned": False}
        if expect_fresh:
            # Every observation method carries the same provenance contract.
            report["observationProvenance"] = {}
            for method in OBSERVATION_METHODS[1:]:
                start = time.monotonic()
                response = session.action(method)
                windows.append((start, time.monotonic()))
                require(not response["error"], "%s failed on a fresh-answering model" % method)
                report["observationProvenance"][method] = require_provenance(
                    response["metadata"], request_mode, method)
            report["observationV2"] = run_observation_v2(session, request_mode, windows)
        report["status"] = "passed"
    except Exception as error:
        report["failure"] = type(error).__name__ + ": " + str(error)
    finally:
        if session:
            report["processExitCode"] = session.close()
            (args.output_dir / ("native-" + name + ".stderr.txt")).write_bytes(session.stderr)
        fixture.finished.wait(3)  # every client byte is read before counting
        fixture.close()
        snapshot = fixture.snapshot()
        report["serverFrames"] = len(snapshot["frames"])
        report["fixtureErrors"] = snapshot["errors"]
        report["connections"] = snapshot["connections"]
        requests, events = snapshot["requests"], snapshot["events"]
        report["requests"] = {"full": sum(1 for r in requests if not r["incremental"]),
                              "incremental": sum(1 for r in requests if r["incremental"])}
        try:
            require(report["status"] == "passed", report.get("failure", "scenario failed"))
            require(not snapshot["errors"], "fixture protocol errors: %r" % snapshot["errors"])
            require(report.get("processExitCode") == 0, "owned native process did not exit with zero")
            require([record["shared"] for record in snapshot["connections"]] == [1],
                    "expected one shared ClientInit connection")
            # Observation never writes input: no Key/Pointer/Cut message at all,
            # and none inside any capture window.
            require(not events, "input reached the server during an observation-only scenario")
            require(not [t for t in snapshot["eventTimes"] if any(a <= t["at"] <= b for a, b in windows)],
                    "input message inside a capture window")
            ledger = wire_ledger(session.stderr if session else b"")
            requests_ledger = [e for e in ledger if e["type"] == 3 and e["origin"] != "suppressed"]
            report["wireLedger"] = {"lines": len(ledger),
                                    "full": sum(1 for e in requests_ledger if e["incremental"] == "0"),
                                    "incremental": sum(1 for e in requests_ledger if e["incremental"] == "1"),
                                    "inferred": sum(1 for e in ledger
                                                    if e["origin"] in ("libvnc-init", "libvnc-rearm")),
                                    "suppressed": sum(1 for e in ledger if e["origin"] == "suppressed")}
            require(all(e["length"] == 10 for e in requests_ledger), "ledger request length is not 10")
            require(not [e for e in ledger if e["type"] != 3], "ledger lists input in an observation-only scenario")
            require((report["wireLedger"]["full"], report["wireLedger"]["incremental"]) ==
                    (report["requests"]["full"], report["requests"]["incremental"]),
                    "wire ledger %r disagrees with server-received requests %r"
                    % (report["wireLedger"], report["requests"]))
            if request_mode == "on-demand":
                require(report["requests"]["incremental"] == 0, "on-demand mode wrote incremental requests")
        except Exception as error:
            report["status"] = "failed"
            report["failure"] = report.get("failure") or (type(error).__name__ + ": " + str(error))
        (args.output_dir / ("native-" + name + ".json")).write_text(json.dumps(report, indent=2) + "\n")
    require(report["status"] == "passed", report.get("failure", "fixture failed"))
    return report


def run_streaming_scenario(model, request_mode, args):
    """Captures while the screen animates and an incremental request is
    always outstanding in stream mode (TIN-5509). The capture's full request
    must stay the server's newest until it is answered: no request may be
    written behind it, so none is absorbed, and every capture is fresh and
    whole. The daemon's other input-free observation contracts still hold."""
    name = model + "-" + request_mode
    fixture = RfbFixture(request_model=model)
    session = None
    report = {"transport": "native", "scenario": name, "requestModel": model, "requestMode": request_mode,
              "expectFresh": True, "loopbackPort": fixture.port, "status": "failed", "captures": [],
              "claimedScope": "synthetic-loopback-RFB-only; not a model of any qualified server"}
    windows = []
    try:
        flags = ["--rfb-wire-ledger"]
        if request_mode != "stream":
            flags += ["--rfb-request-mode", request_mode]
        session = NativeSession(args.daemon, fixture.port, flags)
        report["route"] = "native-PC"
        time.sleep(0.3)  # connect-time exchange; in stream mode the animation is streaming
        animating = fixture.snapshot()["animationFrames"]
        if request_mode == "stream":
            # A tick answers only an outstanding re-arm, so the frame rate is
            # the client's round trip, not ANIMATION_TICK_SECONDS; a loaded
            # runner can stream fewer than three frames in a fixed settle.
            # Wait for the precondition with a bound instead of a rate.
            deadline = time.monotonic() + 5
            while animating < 3 and time.monotonic() < deadline:
                time.sleep(0.01)
                animating = fixture.snapshot()["animationFrames"]
            require(animating >= 3, "%s: the stream was not animating before the first capture (%d)"
                    % (name, animating))
        sequence = 0
        for ordinal in range(STREAMING_CAPTURES):
            start = time.monotonic()
            response = session.action("screenshot")
            elapsed = time.monotonic() - start
            windows.append((start, time.monotonic()))
            if response["error"]:
                data = response["error"].get("data") or {}
                raise AssertionError("%s capture %d failed: %s %s" % (name, ordinal + 1,
                                     response["error"].get("code"), data.get("reason")))
            sequence, png, metadata = inspect_capture(response, fixture, sequence)
            provenance = require_provenance(metadata, request_mode, "screenshot")
            require(provenance["requests"] == {"full": 1, "incremental": 0},
                    "%s wrote a request behind its capture request: %r" % (name, provenance["requests"]))
            require(elapsed < 2.0, "%s capture took %.3f s" % (name, elapsed))
            report["captures"].append({"ordinal": ordinal + 1, "serverMarker": sequence,
                                       "pngSha256": hashlib.sha256(png).hexdigest(), "provenance": provenance,
                                       "latencyMilliseconds": round(elapsed * 1000, 3)})
            # Long enough for the stream (and its in-flight updates) to resume.
            time.sleep(0.15)
        snapshot = fixture.snapshot()
        report["animationFrames"] = snapshot["animationFrames"]
        report["absorbedFullRequests"] = snapshot["absorbedFullRequests"]
        require(snapshot["absorbedFullRequests"] == 0,
                "%s: a full request was absorbed by a request written behind it" % name)
        if request_mode == "stream":
            require(snapshot["animationFrames"] > animating, "%s: the stream did not resume" % name)
        report["status"] = "passed"
    except Exception as error:
        report["failure"] = type(error).__name__ + ": " + str(error)
    finally:
        if session:
            report["processExitCode"] = session.close()
            (args.output_dir / ("native-" + name + ".stderr.txt")).write_bytes(session.stderr)
        fixture.finished.wait(3)
        fixture.close()
        snapshot = fixture.snapshot()
        report["fixtureErrors"] = snapshot["errors"]
        report["connections"] = snapshot["connections"]
        report["animationFrames"] = snapshot["animationFrames"]
        report["absorbedFullRequests"] = snapshot["absorbedFullRequests"]
        requests = snapshot["requests"]
        report["requests"] = {"full": sum(1 for r in requests if not r["incremental"]),
                              "incremental": sum(1 for r in requests if r["incremental"])}
        try:
            require(report["status"] == "passed", report.get("failure", "scenario failed"))
            require(not snapshot["errors"], "fixture protocol errors: %r" % snapshot["errors"])
            require(report.get("processExitCode") == 0, "owned native process did not exit with zero")
            require([record["shared"] for record in snapshot["connections"]] == [1],
                    "expected one shared ClientInit connection")
            require(not snapshot["events"], "input reached the server during an observation-only scenario")
            # One full request per capture. Whether anything was written
            # behind it before its answer is absorbedFullRequests, checked
            # above: the stream may resume once the capture has its pixels,
            # while the PNG is still being encoded.
            for start, end in windows:
                fulls = [r for r in requests if start <= r["at"] <= end and not r["incremental"]]
                require(len(fulls) == 1, "%s: expected one full request per capture window" % name)
            if request_mode == "on-demand":
                require(report["requests"]["incremental"] == 0, "on-demand mode wrote incremental requests")
            else:
                require(report["requests"]["incremental"] > 0, "stream mode wrote no incremental request")
        except Exception as error:
            report["status"] = "failed"
            report["failure"] = report.get("failure") or (type(error).__name__ + ": " + str(error))
        (args.output_dir / ("native-" + name + ".json")).write_text(json.dumps(report, indent=2) + "\n")
    require(report["status"] == "passed", report.get("failure", "fixture failed"))
    return report


def run_input_settle_scenario(args):
    """--input-settle-ms holds the first input until the settle time after
    ServerInit; observation is not delayed and a short deadline is typed."""
    fixture = RfbFixture()
    session = None
    settle = FIXTURE_INPUT_SETTLE_MS / 1000
    report = {"transport": "native", "scenario": "input-settle", "loopbackPort": fixture.port,
              "status": "failed", "captures": [], "inputSettleMilliseconds": FIXTURE_INPUT_SETTLE_MS,
              "claimedScope": "synthetic-loopback-RFB-only; Apple's ~2.5 s input drop is not modeled"}
    try:
        session = NativeSession(args.daemon, fixture.port, ["--input-settle-ms", str(FIXTURE_INPUT_SETTLE_MS)])
        report["route"] = "native-PC"
        health = session.action("health")
        require(not health["error"], "health failed during the settle time")
        metadata = health["metadata"]
        require(metadata.get("input_ready") is False and 0 < metadata.get("input_settle_remaining_ms", 0)
                <= FIXTURE_INPUT_SETTLE_MS and metadata.get("input_settle_ms") == FIXTURE_INPUT_SETTLE_MS,
                "health did not report the pending input settle: %r" % {k: metadata.get(k) for k in
                ("input_ready", "input_settle_remaining_ms", "input_settle_ms")})
        start = time.monotonic()
        sequence, _, _ = inspect_capture(session.action("screenshot"), fixture)
        observed = time.monotonic()
        init_at = fixture.snapshot()["serverInitTimes"][0]["at"]
        require(observed < init_at + settle, "observation was delayed by the input settle time")
        report["observationMilliseconds"] = round((observed - start) * 1000, 3)
        refused = session.action("key_tap", key="a", deadline_ms=0)
        error = refused["error"] or {}
        require(error.get("code") == INPUT_NOT_READY_CODE, "short deadline was not typed input_not_ready: %r" % error)
        data = error.get("data") or {}
        require(data.get("reason") == "input_not_ready" and isinstance(data.get("remaining_ms"), int)
                and 0 < data["remaining_ms"] <= FIXTURE_INPUT_SETTLE_MS, "input_not_ready data %r" % data)
        require(not fixture.snapshot()["events"], "a refused input reached the server")
        report["inputNotReady"] = {"code": error["code"], "reason": data["reason"], "remainingMs": data["remaining_ms"]}
        require(not session.action("key_tap", key="a")["error"], "settled key tap failed")
        inspect_capture(session.action("screenshot"), fixture, sequence)
        snapshot = fixture.snapshot()
        # The connection's first input is preceded by the modifier release
        # sync (TIN-6597), which is input too and also waits out the settle.
        require([e for e in snapshot["events"] if e["kind"] == "key"] == MODIFIER_SYNC +
                [{"kind": "key", "down": 1, "key": ord("a")}, {"kind": "key", "down": 0, "key": ord("a")}],
                "settled key press/release mismatch")
        first = snapshot["eventTimes"][0]["at"]
        require(first - init_at >= settle, "first input arrived %.3f s after ServerInit, before the %.3f s settle"
                % (first - init_at, settle))
        report["firstInputAfterServerInitMilliseconds"] = round((first - init_at) * 1000, 3)
        after = session.action("health")["metadata"]
        require(after.get("input_ready") is True and after.get("input_settle_remaining_ms") == 0,
                "health did not report input ready after the settle time")
        report["status"] = "passed"
    except Exception as error:
        report["failure"] = type(error).__name__ + ": " + str(error)
    finally:
        if session:
            report["processExitCode"] = session.close()
            (args.output_dir / "native-input-settle.stderr.txt").write_bytes(session.stderr)
        fixture.finished.wait(3)
        fixture.close()
        report["fixtureErrors"] = fixture.snapshot()["errors"]
        if report["status"] == "passed" and (report["fixtureErrors"] or report.get("processExitCode") != 0):
            report["status"] = "failed"
            report["failure"] = "fixture errors %r or nonzero exit %r" % (report["fixtureErrors"],
                                                                          report.get("processExitCode"))
        (args.output_dir / "native-input-settle.json").write_text(json.dumps(report, indent=2) + "\n")
    require(report["status"] == "passed", report.get("failure", "fixture failed"))
    return report


def run_clipboard_scenario(clipboard, args):
    """D8/D29 through the real LibVNC client: clipboard_read, paste encoding
    and a paste-routed key_type that restores the clipboard. `legacy` models
    a Latin-1-only server that pushes its clipboard; `extended` negotiates
    ExtendedClipboard and answers Requests. Neither is Apple's server."""
    fixture = RfbFixture(clipboard=clipboard)
    fixture.server_clipboard = CLIPBOARD_SCENARIO_TEXT[clipboard]
    session = None
    name = "clipboard-" + clipboard
    report = {"transport": "native", "scenario": name, "loopbackPort": fixture.port, "status": "failed",
              "captures": [],
              "claimedScope": "synthetic-loopback-RFB-only; Apple's clipboard support is not modeled"}
    extended = clipboard == "extended"
    ctrl_v = [{"kind": "key", "down": 1, "key": 0xFFE3}, {"kind": "key", "down": 1, "key": 0x76},
              {"kind": "key", "down": 0, "key": 0x76}, {"kind": "key", "down": 0, "key": 0xFFE3}]

    def clip(text):
        encoding = "utf8" if extended else "latin1"
        size = len(text.encode("utf-8" if extended else "latin-1"))
        return {"kind": "clipboard", "bytes": size, "encoding": encoding, "text": text}

    def events_since(mark, expected=None):
        # A reply can precede the fixture thread's parse of the last write.
        deadline = time.monotonic() + 3
        while expected is not None and len(fixture.snapshot()["events"]) - mark < len(expected) \
                and time.monotonic() < deadline:
            time.sleep(0.01)
        return fixture.snapshot()["events"][mark:]

    try:
        session = NativeSession(args.daemon, fixture.port, ["--clipboard-read", "--paste-unmappable"])
        report["route"] = "native-PC"
        # The screenshot authorizes input; its poll cycle also handles the
        # server's Caps (extended) or pushed cut text (legacy).
        inspect_capture(session.action("screenshot"), fixture)
        require(fixture.extended_caps_sent == (1 if extended else 0), "ExtendedClipboard negotiation mismatch")
        read = session.action("clipboard_read")
        require(not read["error"], "clipboard_read failed: %r" % read["error"])
        got = read["metadata"].get("clipboard") or {}
        require(got.get("text") == CLIPBOARD_SCENARIO_TEXT[clipboard] and
                got.get("encoding") == ("utf8" if extended else "latin1") and got.get("fresh") is extended,
                "clipboard_read returned %r" % got)
        request = [{"kind": "clipboard-request"}] if extended else []
        require(events_since(0, request) == request,
                "clipboard_read wrote more than its request")

        mark = len(events_since(0))
        require(not session.action("paste", text="naïve")["error"], "Latin-1 paste failed")
        expected = [clip("naïve")] + MODIFIER_SYNC + ctrl_v
        require(events_since(mark, expected) == expected, "paste wire sequence mismatch")

        mark = len(events_since(0))
        wide = session.action("paste", text="日本")
        if extended:
            require(not wide["error"], "UTF-8 paste failed: %r" % wide["error"])
            expected = [clip("日本")] + ctrl_v
            require(events_since(mark, expected) == expected, "UTF-8 paste wire sequence mismatch")
        else:
            error = wide["error"] or {}
            require(error.get("code") == INPUT_REFUSED_CODE and
                    (error.get("data") or {}).get("reason") == "clipboard_unicode_unsupported",
                    "non-Latin-1 legacy paste was not refused typed: %r" % error)
            require(not events_since(mark), "a refused paste reached the server")
        report["pasteRefusedWithoutUtf8"] = not extended

        # The input mapping survives image-less input; route one unmappable scalar.
        unmappable = "日" if extended else "é"
        restored = "日本" if extended else "naïve"
        mark = len(events_since(0))
        typed = session.action("key_type", text="a" + unmappable + "b", unmappable="paste")
        require(not typed["error"] and typed["metadata"].get("kind") == "paste",
                "routed key_type failed: %r" % typed)
        key = lambda down, value: {"kind": "key", "down": down, "key": value}
        expected = ([{"kind": "clipboard-request"}] if extended else []) + [
            key(1, ord("a")), key(0, ord("a")), clip(unmappable)] + ctrl_v + [
            key(1, ord("b")), key(0, ord("b")), clip(restored)]
        require(events_since(mark, expected) == expected,
                "routed key_type wire sequence mismatch: %r" % events_since(mark))
        require(fixture.server_clipboard == restored, "the server clipboard was not restored")
        report["routedKeyType"] = {"kind": "paste", "restored": True}
        report["status"] = "passed"
    except Exception as error:
        report["failure"] = type(error).__name__ + ": " + str(error)
    finally:
        if session:
            report["processExitCode"] = session.close()
            (args.output_dir / ("native-%s.stderr.txt" % name)).write_bytes(session.stderr)
        fixture.finished.wait(3)
        fixture.close()
        report["fixtureErrors"] = fixture.snapshot()["errors"]
        if report["status"] == "passed" and (report["fixtureErrors"] or report.get("processExitCode") != 0):
            report["status"] = "failed"
            report["failure"] = "fixture errors %r or nonzero exit %r" % (report["fixtureErrors"],
                                                                          report.get("processExitCode"))
        (args.output_dir / ("native-%s.json" % name)).write_text(json.dumps(report, indent=2) + "\n")
    require(report["status"] == "passed", report.get("failure", "fixture failed"))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--daemon", type=Path, required=True, help="existing compiled unsigned native daemon")
    parser.add_argument("--output-dir", type=Path, required=True, help="new durable fixture receipt directory")
    parser.add_argument("--captures", type=int, default=100)
    parser.add_argument("--node", type=Path, help="optional existing Darwin Node runtime")
    parser.add_argument("--source-dir", type=Path, help="matching staged source with node_modules for real MCP")
    parser.add_argument("--mcp-route", choices=("shared-broker", "legacy-direct"), default="shared-broker")
    parser.add_argument("--runtime-archive", type=Path, help="optional exact runtime archive to hash into the receipt")
    parser.add_argument("--request-modes", default="stream",
                        help="comma-separated daemon request modes for the request-model scenarios")
    args = parser.parse_args()
    args.request_modes = [mode for mode in args.request_modes.split(",") if mode]
    require(args.request_modes and all(mode in ("stream", "on-demand") for mode in args.request_modes),
            "request modes are stream and/or on-demand")
    require(1 <= args.captures <= 1000, "captures must be 1...1000")
    require(bool(args.node) == bool(args.source_dir), "--node and --source-dir are required together")
    args.daemon = args.daemon.resolve(strict=True)
    require(os.access(args.daemon, os.X_OK), "daemon is not executable")
    if args.node:
        args.node = args.node.resolve(strict=True)
        args.source_dir = args.source_dir.resolve(strict=True)
        require((args.source_dir / "index.js").is_file() and (args.source_dir / "node_modules").is_dir(),
                "MCP source/dependencies are not staged")
    args.output_dir = args.output_dir.resolve()
    args.output_dir.mkdir(parents=True, exist_ok=False)
    receipt = {"schemaVersion": 1, "proofKind": "offline-dynamic-RFB-fixture",
               "startedAtUnixSeconds": time.time(), "status": "failed",
               "daemonSha256": sha256_file(args.daemon), "fixtureSha256": sha256_file(__file__),
               "rfbVersion": "3.8", "authentication": "None on owned ephemeral loopback port",
               "credentialDelivery": "synthetic value via inherited native fd3",
               "frameDimensions": [WIDTH, HEIGHT], "scenarios": [],
               "excludes": ["live macOS desktop", "TCC", "overlay exclusion", "signed/notarized distribution",
                            "SSH bridge", "real VNC authentication", "live product latency/SLO"]}
    if args.node:
        receipt["nodeSha256"] = sha256_file(args.node)
        receipt["nodeVersion"] = subprocess.check_output([str(args.node), "--version"], timeout=5).decode().strip()
        receipt["mcpRoute"] = args.mcp_route
        if args.runtime_archive:
            receipt["runtimeArchiveSha256"] = sha256_file(args.runtime_archive.resolve(strict=True))
        receipt["mcpSourceSha256"] = {str(path.relative_to(args.source_dir)): sha256_file(path)
            for path in [args.source_dir / "index.js", args.source_dir / "bin/fruitctl.mjs",
                         args.source_dir / "package.json", args.source_dir / "package-lock.json",
                         *sorted((args.source_dir / "lib").rglob("*.js")),
                         *sorted((args.source_dir / "lib").rglob("*.mjs")),
                         *sorted((args.source_dir / "tools").rglob("*.js"))]}
    else:
        receipt["mcp"] = "not run; pass --node and --source-dir to include actual MCP transport"
    try:
        for kind in (["native", "mcp"] if args.node else ["native"]):
            modes = ["full", "partial", "truncated"]
            if kind == "native":
                modes.append("silent")
            if kind == "mcp":
                modes.append("task-failed")
            for mode in modes:
                print("Running %s %s fixture" % (kind, mode), flush=True)
                receipt["scenarios"].append(run_scenario(kind, mode, args.captures, args))
        print("Running native input-settle fixture", flush=True)
        receipt["scenarios"].append(run_input_settle_scenario(args))
        print("Running native capture-timeout fixture", flush=True)
        receipt["scenarios"].append(run_capture_timeout_scenario(args))
        for clipboard in CLIPBOARD_MODELS:
            print("Running native %s clipboard fixture" % clipboard, flush=True)
            receipt["scenarios"].append(run_clipboard_scenario(clipboard, args))
        for request_mode in args.request_modes:
            for model in MODEL_SCENARIOS:
                print("Running native %s request model in %s mode" % (model, request_mode), flush=True)
                receipt["scenarios"].append(run_model_scenario(model, request_mode, args))
            for model in STREAMING_SCENARIOS:
                print("Running native %s streaming model in %s mode" % (model, request_mode), flush=True)
                receipt["scenarios"].append(run_streaming_scenario(model, request_mode, args))
        receipt["status"] = "passed"
    except Exception as error:
        receipt["failure"] = type(error).__name__ + ": " + str(error)
        print("Fixture failed: " + receipt["failure"], file=sys.stderr)
    finally:
        receipt["finishedAtUnixSeconds"] = time.time()
        (args.output_dir / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"status": receipt["status"], "receipt": str(args.output_dir / "receipt.json"),
                      "scenarioCount": len(receipt["scenarios"])}), flush=True)
    return 0 if receipt["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
