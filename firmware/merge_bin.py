# Add a `mergebin` target: one flash image (bootloader + partitions + boot_app0 + app) that
# writes at offset 0x0. The browser flasher (ESP Web Tools) and `esptool write_flash 0x0`
# need a single file; the individual pieces and their offsets live in PlatformIO's build
# env, so read them from there rather than hardcoding offsets that change with the core.
#
#   pio run -e esp32-c3-release -t mergebin   ->  .pio/build/<env>/tallybot-merged.bin
Import("env")  # noqa: F821 — provided by PlatformIO's SCons build environment

APP_BIN = "$BUILD_DIR/${PROGNAME}.bin"
MERGED_BIN = "$BUILD_DIR/tallybot-merged.bin"
board = env.BoardConfig()  # noqa: F821


def merge_bin(source, target, env):
    images = env.Flatten(env.get("FLASH_EXTRA_IMAGES", [])) + ["$ESP32_APP_OFFSET", APP_BIN]
    env.Execute(
        " ".join(
            ["$PYTHONEXE", "$OBJCOPY", "--chip", board.get("build.mcu"), "merge_bin",
             "--flash_mode", "${__get_board_flash_mode(__env__)}",
             "--flash_size", board.get("upload.flash_size", "4MB"),
             "-o", MERGED_BIN]
            + images
        )
    )


env.AddCustomTarget(  # noqa: F821
    name="mergebin",
    dependencies=APP_BIN,
    actions=merge_bin,
    title="Merge binary",
    description="Single flash image at 0x0 for the web flasher",
)
