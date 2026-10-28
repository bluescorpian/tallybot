#pragma once

// SCAN_WIFI (protocol v4): a cabled device lists the access points it hears on channels 1–13,
// one SCAN_RESULT per AP over USB (or the empty frame when it hears none), to suggest a quiet
// ESP-NOW channel. Any device can scan: a bridge, a WiFi device, a gated ESP-NOW light, or No-TX.
//
// Non-blocking: the WiFi driver sweeps the channels while the main loop keeps pumping USB and, on
// a bridge, draining the ESP-NOW ring. While the driver scans, nothing may retune the radio
// (radioBusy()); afterwards a bridge is re-pinned to its channel and a radio the scan had to
// switch on is switched off again. The SCAN_RESULTs are then paced to the USB TX buffer.
namespace scan {

void begin();      // register the scan-done event handler (once, at boot)
void request();    // SCAN_WIFI from the USB host; ignored while a scan is already running
bool radioBusy();  // the driver owns the radio: don't retune or reconfigure it until this clears
void abort();      // something else is taking the radio over (BOOT portal, USB release): drop the scan
void loop();       // per tick: start / poll the driver, give the radio back, send SCAN_RESULTs

}  // namespace scan
