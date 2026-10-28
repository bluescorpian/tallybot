/**
 * Turns a device's WiFi scan (its SCAN_RESULT access points) into per-channel congestion and a
 * suggested ESP-NOW channel. Pure: the orchestrator (`app.ts`) runs the scan and emits the result.
 *
 * The score is a stand-in for how busy a channel is, since the radio offers no measure of airtime
 * (`docs/spec/esp-now-channel-selection.md`, "Rejected"): each access point within
 * {@link OVERLAP_CHANNELS} of a channel adds its {@link accessPointWeight}. 20 MHz channels sit
 * 5 MHz apart, so an AP four channels away still overlaps; five away is clear. A nearer AP is
 * not counted as worse than a farther overlapping one: both contend for the same air, and the
 * suggestion is only ever a hint the operator can override.
 */

import type { ChannelCongestion, WifiAccessPoint } from "./ipc.ts";
import { ESPNOW_CHANNEL_MAX, ESPNOW_CHANNEL_MIN } from "./protocol.ts";

/** The channels a suggestion is picked from: the three that don't overlap, plus 13 (ZA allows it). */
export const SUGGESTED_CHANNELS: readonly number[] = [1, 6, 11, 13];

/** How many channels either side an access point's 20 MHz signal reaches. */
export const OVERLAP_CHANNELS = 4;

/** An access point this faint (dBm) or fainter adds nothing: it is at the edge of what's heard. */
export const RSSI_FLOOR_DBM = -100;
/** An access point this strong (dBm) or stronger counts in full: it is in the room. */
export const RSSI_CEILING_DBM = -30;

/**
 * How much one access point adds to the channels it overlaps: its RSSI scaled linearly from 0 at
 * {@link RSSI_FLOOR_DBM} to 1 at {@link RSSI_CEILING_DBM}, clamped. Linear in dB rather than in
 * milliwatts, so one AP in the room weighs as a few distant ones rather than as thousands of them.
 */
export function accessPointWeight(rssi: number): number {
  const scaled = (rssi - RSSI_FLOOR_DBM) / (RSSI_CEILING_DBM - RSSI_FLOOR_DBM);
  return Math.min(1, Math.max(0, scaled));
}

/** Congestion for every channel 1–13, in channel order. */
export function channelCongestion(accessPoints: readonly WifiAccessPoint[]): ChannelCongestion[] {
  const congestion: ChannelCongestion[] = [];
  for (let channel = ESPNOW_CHANNEL_MIN; channel <= ESPNOW_CHANNEL_MAX; channel++) {
    let score = 0;
    let count = 0;
    for (const ap of accessPoints) {
      if (Math.abs(ap.channel - channel) > OVERLAP_CHANNELS) continue;
      score += accessPointWeight(ap.rssi);
      count++;
    }
    congestion.push({
      channel,
      score: Math.round(score * 100) / 100,
      accessPoints: count,
      candidate: SUGGESTED_CHANNELS.includes(channel),
    });
  }
  return congestion;
}

/**
 * The lowest-scoring of {@link SUGGESTED_CHANNELS}. A tie keeps `current` when it is one of the
 * tied channels (moving a rig costs every light a hunt), and otherwise goes to the lowest channel.
 */
export function suggestChannel(congestion: readonly ChannelCongestion[], current: number): number {
  let best: ChannelCongestion | null = null;
  for (const entry of congestion) {
    if (!entry.candidate) continue;
    if (best === null || entry.score < best.score || (entry.score === best.score && entry.channel === current)) {
      best = entry;
    }
  }
  return best?.channel ?? SUGGESTED_CHANNELS[0]!;
}
