# Stamp build identity into the firmware: FIRMWARE_VERSION and BUILD_TIMESTAMP.
#
# FIRMWARE_VERSION comes from VERSION, the firmware's own semver. It's bumped only when the
# firmware changes, so an app release that leaves the firmware alone doesn't flag every light
# as outdated. The device reports it in its FIRMWARE message; the release workflow ships the
# same string beside the image the app bundles, and the app compares the two.
#
# BUILD_TIMESTAMP: the Arduino-ESP32 toolchain pins __DATE__/__TIME__ to a fixed epoch
# (reproducible builds), so the compiler's own build macros render as "Jan 1 1980" on the
# diagnostics panel. Stamp the real wall-clock UTC time at the start of every build instead.
# StringifyMacro does the quoting/escaping, so spaces in the values are safe.
import datetime
import os

Import("env")  # noqa: F821 — provided by PlatformIO's SCons build environment

with open(os.path.join(env["PROJECT_DIR"], "VERSION")) as f:  # noqa: F821
    version = f.read().strip()

stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
env.Append(  # noqa: F821
    CPPDEFINES=[
        ("FIRMWARE_VERSION", env.StringifyMacro(version)),  # noqa: F821
        ("BUILD_TIMESTAMP", env.StringifyMacro(stamp)),  # noqa: F821
    ]
)
