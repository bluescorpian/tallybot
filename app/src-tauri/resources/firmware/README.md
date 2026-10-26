# Firmware bundled with the app

`pnpm firmware:stage` (or the release workflow) puts the merged image and its manifest here;
see `../../scripts/stage-firmware.mjs`. Both are build output and stay untracked. The directory
is tracked so a build without a staged image still has its `firmware/` resource directory.
