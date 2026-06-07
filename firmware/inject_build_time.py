# Inject a real build timestamp into the firmware as BUILD_TIMESTAMP.
#
# The Arduino-ESP32 toolchain pins __DATE__/__TIME__ to a fixed epoch (reproducible
# builds), so the compiler's own build macros render as "Jan 1 1980" on the diagnostics
# panel — useless for telling which build is actually flashed at the venue. Stamp the real
# wall-clock UTC time at the start of every build instead, as a proper C string literal
# (StringifyMacro does the quoting/escaping, so spaces in the value are safe).
import datetime

Import("env")  # noqa: F821 — provided by PlatformIO's SCons build environment

stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
env.Append(CPPDEFINES=[("BUILD_TIMESTAMP", env.StringifyMacro(stamp))])
