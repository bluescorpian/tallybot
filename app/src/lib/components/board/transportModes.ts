// What a light does when unplugged — the one list both the light's Configure pane and the
// flasher's Settings step offer, so the two say the same thing. Each row names the transport
// and says in the small text when to pick it (Harry's call: name first, reason second).
import type { TransportMode } from "$ipc";

export const TRANSPORT_MODES: { id: TransportMode; label: string; desc: string }[] = [
	{ id: "wifi", label: "Wi-Fi", desc: "When the venue Wi-Fi is reliable" },
	{ id: "notx", label: "USB only", desc: "When the light stays plugged into this PC" },
	{
		id: "espnow",
		label: "ESP-NOW",
		desc: "No venue Wi-Fi, or it's unreliable. Needs a bridge plugged into this PC",
	},
];

export const BRIDGE_LABEL = "Use as bridge";
export const BRIDGE_DESC = "Stays plugged in here and relays tally to no-Wi-Fi lights. Replaces any current bridge.";
